const TEST_ORGANISATION_PLACEMENT_PROFILE = JSON.stringify({
  databaseBinding: "DB",
  kind: "affinity",
  placementCellId: "test",
  locationHint: "wnam",
});
/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "../src/database-handles";
import { describe, expect, it } from "vitest";

import {
  applyAgentOperation,
  type AgentOperationCommand,
} from "../src/data/agent-operations";
import {
  claimScheduleDispatchWindow,
  listEnabledScheduleBindings,
  readScheduleDispatchReceipt,
  recordScheduleDispatchReceipt,
} from "../src/data/agent-operations/schedule-dispatch";
import {
  readAgentDefinitionRevisions,
  readSkillRevisions,
} from "../src/data/agent-operations/revisions";
import {
  resolveManualDispatchAutomation,
  resolveScheduleAutomation,
} from "../src/data/agent-operations/automation";
import type { IngressQueueMessage } from "../src/ingress-queue";
import { runScheduleDispatch } from "../src/schedules/dispatch";
import {
  createAgentOperationsDatabase,
  proposalFixtureAuthority,
  rawAgentOperationsDatabase,
} from "./agent-operations-database";
import { requireOrganisationId } from "./test-ids";

const ORGANISATION = requireOrganisationId("organisation_plan30_schedules");
// Monday 2026-08-24 12:00 JST.
const NOW = Date.UTC(2026, 7, 24, 3, 0);

describe("Schedule dispatch", () => {
  it("dispatches one queue message per due window and never twice", async () => {
    const db = createDatabase();
    await seedScheduledAgent(db, { enabled: true });
    const queue = fakeQueue();

    // The creation-time fence covers the current window, so the binding waits
    // for its next occurrence instead of firing on the tick after setup.
    const beforeNextWindow = await runScheduleDispatch({
      env: {
        DB: db,
        SATYR_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      queue,
      now: NOW,
    });
    expect(beforeNextWindow).toEqual({ dispatched: 0, skipped: 1, failed: 0 });
    expect(queue.sent).toEqual([]);

    const nextDay = NOW + 24 * 3_600_000;
    const first = await runScheduleDispatch({
      env: {
        DB: db,
        SATYR_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      queue,
      now: nextDay,
    });
    expect(first).toEqual({ dispatched: 1, skipped: 0, failed: 0 });
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toMatchObject({
      type: "agent_schedule.dispatch.v1",
      organisationId: ORGANISATION,
      bindingId: "schedule_daily_inventory",
      windowKey: "2026-08-25T07:00@Asia/Tokyo/daily",
    });

    const again = await runScheduleDispatch({
      env: {
        DB: db,
        SATYR_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      queue,
      now: nextDay + 15 * 60_000,
    });
    expect(again).toEqual({ dispatched: 0, skipped: 1, failed: 0 });
    expect(queue.sent).toHaveLength(1);
  });

  it("never lists or fires disabled bindings", async () => {
    const db = createDatabase();
    await seedScheduledAgent(db, { enabled: false });
    expect(await listEnabledScheduleBindings(db)).toEqual([]);
    const queue = fakeQueue();
    expect(
      await runScheduleDispatch({
        env: {
          DB: db,
          SATYR_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        queue,
        now: NOW,
      }),
    ).toEqual({
      dispatched: 0,
      skipped: 0,
      failed: 0,
    });
    expect(queue.sent).toEqual([]);
  });

  it("seeds the fence at creation so a new binding waits for its next window", async () => {
    const db = createDatabase();
    await seedScheduledAgent(db, { enabled: true });
    const bindings = await listEnabledScheduleBindings(db);
    // Created at NOW (12:00 JST): today's 07:00 window is already stamped.
    expect(bindings[0]?.lastDispatchedWindow).toBe(
      "2026-08-24T07:00@Asia/Tokyo/daily",
    );
  });

  it("re-seeds the fence when a binding is re-enabled", async () => {
    const db = createDatabase();
    await seedScheduledAgent(db, { enabled: true });
    const queue = fakeQueue();
    await runScheduleDispatch({
      env: {
        DB: db,
        SATYR_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      queue,
      now: NOW + 24 * 3_600_000,
    });
    expect(queue.sent).toHaveLength(1);
    await apply(db, {
      kind: "update_schedule_binding",
      bindingId: "schedule_daily_inventory",
      expectedRevision: 1,
      enabled: false,
      instructionBody: null,
      operationId: "schedule_off",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: NOW + 25 * 3_600_000,
    });
    const reEnabledAt = NOW + 4 * 24 * 3_600_000;
    await apply(db, {
      kind: "update_schedule_binding",
      bindingId: "schedule_daily_inventory",
      expectedRevision: 2,
      enabled: true,
      instructionBody: null,
      operationId: "schedule_on",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: reEnabledAt,
    });
    // Windows missed while disabled are not backfilled: the current window was
    // stamped at re-enable, so nothing fires until the next one.
    expect(
      await runScheduleDispatch({
        env: {
          DB: db,
          SATYR_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        queue,
        now: reEnabledAt,
      }),
    ).toEqual({
      dispatched: 0,
      skipped: 1,
      failed: 0,
    });
    expect(
      await runScheduleDispatch({
        env: {
          DB: db,
          SATYR_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        queue,
        now: reEnabledAt + 24 * 3_600_000,
      }),
    ).toEqual({ dispatched: 1, skipped: 0, failed: 0 });
  });

  it("claims a window atomically exactly once", async () => {
    const db = createDatabase();
    await seedScheduledAgent(db, { enabled: true });
    expect(
      await claimScheduleDispatchWindow(
        (await proposalFixtureAuthority(db, ORGANISATION)).scope,
        "schedule_daily_inventory",
        "w1",
      ),
    ).toBe(true);
    expect(
      await claimScheduleDispatchWindow(
        (await proposalFixtureAuthority(db, ORGANISATION)).scope,
        "schedule_daily_inventory",
        "w1",
      ),
    ).toBe(false);
    expect(
      await claimScheduleDispatchWindow(
        (await proposalFixtureAuthority(db, ORGANISATION)).scope,
        "schedule_daily_inventory",
        "w2",
      ),
    ).toBe(true);
  });

  it("resolves schedule automation with the same pin shape as cue automation", async () => {
    const db = createDatabase();
    await seedScheduledAgent(db, {
      enabled: true,
      instructionBody: "Prepare the morning restock list.",
    });
    const automation = await resolveScheduleAutomation(
      db,
      ORGANISATION,
      "schedule_daily_inventory",
    );
    expect(automation).toMatchObject({
      binding: {
        bindingId: "schedule_daily_inventory",
        installationId: "installation_inventory",
        spec: { cadence: "daily", timeOfDay: "07:00", timezone: "Asia/Tokyo" },
        instructionBody: "Prepare the morning restock list.",
      },
      agentDefinitionId: "agent_inventory",
      definitionRevision: 1,
      policyRevision: 1,
      skillRefs: [{ skillId: "skill_low_stock", revision: 1 }],
      grantedCapabilities: ["commerce.entity_plane.context"],
      maxSessionBudgetTokens: 25_000,
    });
    expect(
      await resolveScheduleAutomation(db, ORGANISATION, "missing_binding"),
    ).toBeNull();
  });

  it("resolves manual dispatch automation with the shared pin shape", async () => {
    const db = createDatabase();
    await seedScheduledAgent(db, { enabled: true });
    const automation = await resolveManualDispatchAutomation(
      db,
      ORGANISATION,
      "installation_inventory",
    );
    expect(automation).toEqual({
      installationId: "installation_inventory",
      agentDefinitionId: "agent_inventory",
      definitionRevision: 1,
      policyRevision: 1,
      skillRefs: [{ skillId: "skill_low_stock", revision: 1 }],
      grantedCapabilities: ["commerce.entity_plane.context"],
      maxSessionBudgetTokens: 25_000,
    });
    expect(
      await resolveManualDispatchAutomation(
        db,
        ORGANISATION,
        "missing_installation",
      ),
    ).toBeNull();
  });

  it("serves revision history newest first", async () => {
    const db = createDatabase();
    await seedScheduledAgent(db, { enabled: true });
    await apply(db, {
      kind: "publish_skill_revision",
      skillId: "skill_low_stock",
      expectedRevision: 1,
      markdownBody: "Updated: prioritize perishables.",
      operationId: "skill_low_stock_rev2",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 200,
    });
    await apply(db, {
      kind: "publish_agent_definition_revision",
      agentDefinitionId: "agent_inventory",
      expectedRevision: 1,
      instructions: "Updated instructions.",
      requestedCapabilities: ["commerce.entity_plane.context"],
      skillRefs: [{ skillId: "skill_low_stock", revision: 1 }],
      operationId: "agent_inventory_rev2",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 201,
    });
    const skillRevisions = await readSkillRevisions(
      db,
      ORGANISATION,
      "skill_low_stock",
    );
    expect(skillRevisions.map((entry) => entry.revision)).toEqual([2, 1]);
    expect(skillRevisions[0]?.markdownBody).toBe(
      "Updated: prioritize perishables.",
    );
    const definitionRevisions = await readAgentDefinitionRevisions(
      db,
      ORGANISATION,
      "agent_inventory",
    );
    expect(definitionRevisions.map((entry) => entry.revision)).toEqual([2, 1]);
    expect(definitionRevisions[0]?.instructions).toBe("Updated instructions.");
    expect(await readSkillRevisions(db, ORGANISATION, "missing_skill")).toEqual(
      [],
    );
  });

  it("records and reads dispatch receipts for consumer idempotency", async () => {
    const db = createDatabase();
    await seedScheduledAgent(db, { enabled: true });
    const receipt = {
      bindingId: "schedule_daily_inventory",
      windowKey: "2026-08-24T07:00@Asia/Tokyo/daily",
      organisationId: ORGANISATION,
      caseId: "case_schedule_1",
      dispatchedAt: NOW,
    };
    expect(
      await readScheduleDispatchReceipt(
        db,
        receipt.bindingId,
        receipt.windowKey,
      ),
    ).toBeNull();
    await recordScheduleDispatchReceipt(db, receipt);
    await recordScheduleDispatchReceipt(db, {
      ...receipt,
      caseId: "case_other",
    });
    expect(
      await readScheduleDispatchReceipt(
        db,
        receipt.bindingId,
        receipt.windowKey,
      ),
    ).toEqual(receipt);
  });

  it("rejects incoherent stored schedule shapes at the schema boundary", () => {
    const db = createDatabase();
    expect(() =>
      rawAgentOperationsDatabase(db).exec(
        `INSERT INTO schedule_binding (
         binding_id, organisation_id, area_id, installation_id, cadence,
         minute_of_hour, time_of_day, weekday, timezone, schedule_time_key,
         enabled, revision, updated_by_user_id, created_at, updated_at
       ) VALUES ('bad', '${ORGANISATION}', 'area_inventory', 'installation_inventory',
         'daily', 30, NULL, NULL, NULL, 'daily@bad', 1, 1, 'user_fbe449f6-7995-538c-a3a8-81b0623a641e', 1, 1)`,
      ),
    ).toThrow(/constraint/iu);
  });
});

function fakeQueue(): Queue<IngressQueueMessage> & {
  readonly sent: IngressQueueMessage[];
} {
  const sent: IngressQueueMessage[] = [];
  return {
    sent,
    send: async (message: IngressQueueMessage) => {
      sent.push(message);
    },
    sendBatch: async () => {
      throw new Error("unused");
    },
  } as unknown as Queue<IngressQueueMessage> & {
    readonly sent: IngressQueueMessage[];
  };
}

async function apply(db: SingleDatabase, command: AgentOperationCommand) {
  const result = await applyAgentOperation(db, ORGANISATION, command);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

async function seedScheduledAgent(
  db: SingleDatabase,
  options: { readonly enabled: boolean; readonly instructionBody?: string },
): Promise<void> {
  await apply(db, {
    kind: "create_area",
    name: "Inventory",
    purpose: "Monitor low stock and replenishment exceptions.",
    operationId: "area_inventory",
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    now: 100,
  });
  await apply(db, {
    kind: "create_skill",
    title: "Low stock response",
    sensitivity: "ordinary",
    markdownBody: "Review the low-stock item and propose replenishment.",
    operationId: "skill_low_stock",
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    now: 101,
  });
  await apply(db, {
    kind: "create_agent_definition",
    displayName: "Inventory coordinator",
    role: "coordinator",
    purpose: "Coordinate safe replenishment work.",
    instructions:
      "Inspect inventory and ask for approval before provider writes.",
    requestedCapabilities: ["commerce.entity_plane.context"],
    skillRefs: [{ skillId: "skill_low_stock", revision: 1 }],
    operationId: "agent_inventory",
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    now: 102,
  });
  await apply(db, {
    kind: "install_agent",
    agentDefinitionId: "agent_inventory",
    definitionRevision: 1,
    areaId: "area_inventory",
    responsibility: "Own inventory triage.",
    scopeIds: [],
    policyRevision: 1,
    grantedCapabilities: ["commerce.entity_plane.context"],
    operationId: "installation_inventory",
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    now: 103,
  });
  await apply(db, {
    kind: "configure_installation_governance",
    installationId: "installation_inventory",
    maxSessionBudgetTokens: 25_000,
    operationId: "governance_inventory",
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    now: 105,
  });
  await apply(db, {
    kind: "configure_schedule_binding",
    areaId: "area_inventory",
    installationId: "installation_inventory",
    scopeIds: [],
    spec: { cadence: "daily", timeOfDay: "07:00", timezone: "Asia/Tokyo" },
    enabled: options.enabled,
    instructionBody: options.instructionBody ?? null,
    operationId: "schedule_daily_inventory",
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    now: NOW,
  });
}

// One owner for the agent-operations test schema; a second copy here drifts
// out of step with the data module's reads.
const createDatabase = (): SingleDatabase =>
  createAgentOperationsDatabase(ORGANISATION);

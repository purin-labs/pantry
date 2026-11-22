import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { describe, expect, it } from "vitest";

import { readAgentOperations } from "@purin-labs/agent/data/agent-operations";
import {
  presentConfigurationCommand,
  previewCode,
} from "../src/slack/configuration-presentation";
import {
  confirmOperatorConfigurationDraft,
  createOperatorConfigurationDraft,
  readPendingOperatorDraft,
} from "@purin-labs/area-organisation/server/data/operator-configuration-draft";
import {
  createAgentOperationsDatabase,
  proposalFixtureAuthority,
} from "./agent-operations-database";
import { requireOrganisationId } from "./test-ids";

const ORGANISATION = requireOrganisationId("organisation_draft");
const CASE = "case_urk_setup";
const OWNER = "user_fbe449f6-7995-538c-a3a8-81b0623a641e";
const NOW = 1_000;
const EXPIRES = 100_000;

describe("operator configuration drafts", () => {
  it("stores the normalized command and applies it once on confirmation", async () => {
    const db = createDatabase();
    const draft = await create(db, {});
    expect(draft.state).toBe("pending");
    // The draft tags which family the command belongs to, because a price
    // allowance and an agent configuration change are different kinds of
    // state with different owners.
    expect(draft.command).toEqual({
      family: "agent_operation",
      operation: {
        kind: "create_area",
        name: "Merchant operations",
        purpose: "Answer merchant questions and stage governed changes.",
      },
    });

    const confirmed = await confirmOperatorConfigurationDraft({
      db,
      env: fixtureEnv(db),
      organisationId: ORGANISATION,
      draftId: draft.draftId,
      actorUserId: OWNER,
      actorRole: "owner",
      previewCode: previewCode(draft.commandDigest),
      now: NOW + 10,
    });
    if (!confirmed.ok)
      throw new Error(
        `confirmation failed: ${JSON.stringify(confirmed.error)}`,
      );
    expect(confirmed.value.snapshot.areas.map((area) => area.name)).toEqual([
      "Merchant operations",
    ]);
    expect(confirmed.value.draft.state).toBe("settled");
    expect(confirmed.value.draft.receiptCode).toBe("accepted");
  });

  it("does not re-run a change whose settlement was interrupted", async () => {
    const db = createDatabase();
    await seedInstallation(db);
    const draft = await create(db, {
      rawCommand: {
        kind: "configure_installation_governance",
        installationId: "installation_urk",
        maxSessionBudgetTokens: 40_000,
      },
    });
    // Stand the world up exactly as an interrupted confirmation leaves it: the
    // effect committed with its receipt, and the reply never reached the
    // operator, so the draft is claimed but unsettled.
    await confirm(db, draft.draftId, draft.commandDigest, NOW + 10);
    await db
      .prepare(
        `UPDATE operator_configuration_draft SET state = 'confirmed', receipt_code = NULL,
              decided_at = ? WHERE draft_id = ?`,
      )
      .bind(NOW + 10, draft.draftId)
      .run();
    expect(await governanceRevision(db)).toBe(1);

    const retried = await confirmOperatorConfigurationDraft({
      db,
      env: fixtureEnv(db),
      organisationId: ORGANISATION,
      draftId: draft.draftId,
      actorUserId: OWNER,
      actorRole: "owner",
      previewCode: previewCode(draft.commandDigest),
      now: NOW + 30,
    });

    expect(retried.ok).toBe(true);
    // One confirmation, one revision. Re-running the upsert would have taken
    // it to 2 and doubled a governance change the operator asked for once.
    expect(await governanceRevision(db)).toBe(1);
    const settled = await db
      .prepare(
        `SELECT state, receipt_code AS receiptCode FROM operator_configuration_draft
        WHERE draft_id = ?`,
      )
      .bind(draft.draftId)
      .first<{ state: string; receiptCode: string }>();
    expect(settled).toMatchObject({
      state: "settled",
      receiptCode: "accepted",
    });
  });

  it("commits the change and its receipt together or not at all", async () => {
    const db = createDatabase();
    const draft = await create(db, {});
    await confirm(db, draft.draftId, draft.commandDigest, NOW + 10);

    // The receipt is what a retry reads to know the change already ran. If it
    // could be written after the effect, the window between them is exactly
    // where a double-apply lives.
    const receipt = await db
      .prepare(
        `SELECT operation, idempotency_key AS idempotencyKey, request_hash AS requestHash
         FROM control_mutation_receipt WHERE organisation_scope = ?`,
      )
      .bind(ORGANISATION)
      .first<{
        operation: string;
        idempotencyKey: string;
        requestHash: string;
      }>();
    expect(receipt).toEqual({
      operation: "agent.operations.create_area",
      idempotencyKey: "mutation_first",
      requestHash: draft.commandDigest,
    });
  });

  it("writes no receipt for a change that was refused", async () => {
    const db = createDatabase();
    const draft = await create(db, {
      rawCommand: {
        kind: "configure_installation_governance",
        installationId: "installation_missing",
        maxSessionBudgetTokens: 40_000,
      },
    });

    const refused = await confirm(
      db,
      draft.draftId,
      draft.commandDigest,
      NOW + 10,
      false,
    );
    expect(refused.ok).toBe(false);
    // A refusal changed nothing, so nothing may claim it did; otherwise the
    // operator could never retry after fixing the cause.
    const receipts = await db
      .prepare(`SELECT COUNT(*) AS total FROM control_mutation_receipt`)
      .first<{ total: number }>();
    expect(receipts?.total).toBe(0);
  });

  it("stages a responsibility-scope publication that used to be Portal-only", async () => {
    const db = createDatabase();
    // Both of these were refused at draft creation, so an operator could not
    // even be shown a preview. They now go through the same runner the Portal
    // uses, so refusing them here would be a Slack-only restriction.
    const scope = await createOperatorConfigurationDraft({
      ...(await proposalFixtureAuthority(db, ORGANISATION)),
      draftId: "draft_scope",
      caseId: CASE,
      actorUserId: OWNER,
      actorPersonId: "person_owner",
      rawCommand: {
        kind: "publish_responsibility_scope",
        areaId: "area_merchant_operations",
        scope: {
          kind: "entity_type",
          entityTypeId: { origin: "system", typeId: "order" },
        },
      },
      mutationId: "mutation_scope",
      now: NOW,
      expiresAt: EXPIRES,
    });
    expect(scope.ok).toBe(true);
  });

  it("stages a manual run that used to be Portal-only", async () => {
    const db = createDatabase();
    const run = await createOperatorConfigurationDraft({
      ...(await proposalFixtureAuthority(db, ORGANISATION)),
      draftId: "draft_run",
      caseId: CASE,
      actorUserId: OWNER,
      actorPersonId: "person_owner",
      rawCommand: {
        kind: "dispatch_manual_run",
        installationId: "installation_urk",
        instructionBody:
          "Check this morning's low stock and tell me what to reorder.",
      },
      mutationId: "mutation_run",
      now: NOW,
      expiresAt: EXPIRES,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    // The preview an operator would be shown, so they can confirm in words.
    expect(
      presentConfigurationCommand(run.value.command).actionLabel.length,
    ).toBeGreaterThan(0);
  });

  it("stages a price allowance, which is not an agent configuration change", async () => {
    const db = createDatabase();
    const draft = await create(db, {
      draftId: "draft_allowance",
      mutationId: "mutation_allowance",
      rawCommand: {
        kind: "set_offer_price_allowance",
        offerId: "commerce:merchant_cafe:offer_coffee",
        expectedRevision: null,
        maxMovementBps: 500,
      },
    });

    // The allowance is commerce state with its own owner, so the draft tags
    // the family rather than forcing it into the configuration union.
    expect(draft.command).toEqual({
      family: "offer_price_allowance",
      allowance: {
        kind: "set_offer_price_allowance",
        offerId: "commerce:merchant_cafe:offer_coffee",
        expectedRevision: null,
        maxMovementBps: 500,
      },
    });
    const presented = presentConfigurationCommand(draft.command);
    expect(presented.actionLabel).toBe("Save price allowance");
    // The band is the risk-bearing value, so the preview names it.
    expect(presented.summary).toContain("5.00%");
    // Unbound at staging, so the band is measured when confirmed — and says so.
    expect(presented.consequence).toContain("at the moment this is confirmed");
  });

  it("names the withdrawal distinctly, so one reply cannot accept the other", async () => {
    const db = createDatabase();
    const withdraw = await create(db, {
      draftId: "draft_withdraw",
      mutationId: "mutation_withdraw",
      rawCommand: {
        kind: "withdraw_offer_price_allowance",
        offerId: "commerce:merchant_cafe:offer_coffee",
        expectedRevision: 2,
      },
    });
    expect(presentConfigurationCommand(withdraw.command).actionLabel).toBe(
      "Withdraw price allowance",
    );
  });

  it("refuses an allowance wider than the whole price", async () => {
    const db = createDatabase();
    const refused = await createOperatorConfigurationDraft({
      ...(await proposalFixtureAuthority(db, ORGANISATION)),
      draftId: "draft_wide",
      caseId: CASE,
      actorUserId: OWNER,
      actorPersonId: "person_owner",
      rawCommand: {
        kind: "set_offer_price_allowance",
        offerId: "commerce:merchant_cafe:offer_coffee",
        expectedRevision: null,
        maxMovementBps: 10_001,
      },
      mutationId: "mutation_wide",
      now: NOW,
      expiresAt: EXPIRES,
    });
    // Refused at staging, so an operator is never shown a preview for a change
    // that would fail at the end.
    expect(refused).toEqual({
      ok: false,
      error: { code: "operator_draft_invalid", field: "allowance" },
    });
  });

  it("returns the pending draft when the same change is staged again", async () => {
    const db = createDatabase();
    const first = await create(db, { draftId: "draft_first" });
    // Staging the identical change used to cancel the pending preview and then
    // fail to insert its twin under the same id, leaving nothing to confirm.
    const again = await create(db, { draftId: "draft_second" });
    expect(again.draftId).toBe(first.draftId);
    expect(again.state).toBe("pending");
    const pending = await readPendingOperatorDraft({
      db,
      organisationId: ORGANISATION,
      caseId: CASE,
      now: NOW,
    });
    expect(pending?.draftId).toBe("draft_first");
  });

  it("replaces the pending draft when a different change is staged", async () => {
    const db = createDatabase();
    await create(db, { draftId: "draft_first" });
    const other = await create(db, {
      draftId: "draft_other",
      mutationId: "mutation_other",
      rawCommand: {
        kind: "create_area",
        name: "Another area",
        purpose: "Something else entirely.",
      },
    });
    expect(other.draftId).toBe("draft_other");
    const pending = await readPendingOperatorDraft({
      db,
      organisationId: ORGANISATION,
      caseId: CASE,
      now: NOW,
    });
    expect(pending?.draftId).toBe("draft_other");
  });

  it("names the price an allowance is measured from, and binds it", async () => {
    const db = createDatabase();
    const draft = await create(db, {
      draftId: "draft_bound",
      mutationId: "mutation_bound",
      rawCommand: {
        kind: "set_offer_price_allowance",
        offerId: "commerce:merchant_cafe:offer_coffee",
        expectedRevision: null,
        maxMovementBps: 500,
        expectedOfferRevision: 4,
        referencePriceMinor: 1_000,
        currency: "JPY",
      },
    });
    const presented = presentConfigurationCommand(draft.command);
    // The operator confirms a band around a price they can see, not around
    // "whatever it is by then".
    expect(presented.summary).toContain("JPY");
    expect(presented.summary).toContain("1,000");
    expect(presented.consequence).toContain("refused");
  });

  it("refuses a bound allowance whose reference is not a price", async () => {
    const db = createDatabase();
    const refused = await createOperatorConfigurationDraft({
      ...(await proposalFixtureAuthority(db, ORGANISATION)),
      draftId: "draft_bad_ref",
      caseId: CASE,
      actorUserId: OWNER,
      actorPersonId: "person_owner",
      rawCommand: {
        kind: "set_offer_price_allowance",
        offerId: "commerce:merchant_cafe:offer_coffee",
        expectedRevision: null,
        maxMovementBps: 500,
        expectedOfferRevision: 0,
      },
      mutationId: "mutation_bad_ref",
      now: NOW,
      expiresAt: EXPIRES,
    });
    expect(refused).toEqual({
      ok: false,
      error: { code: "operator_draft_invalid", field: "allowance" },
    });
  });

  it("refuses a confirmation from anyone but the operator who asked", async () => {
    const db = createDatabase();
    const draft = await create(db, {});
    expect(
      await confirmOperatorConfigurationDraft({
        db,
        env: fixtureEnv(db),
        organisationId: ORGANISATION,
        draftId: draft.draftId,
        actorUserId: "user_89730408-7d9c-587a-b19e-6e40eb62ffca",
        actorRole: "owner",
        previewCode: previewCode(draft.commandDigest),
        now: NOW + 10,
      }),
    ).toEqual({ ok: false, error: { code: "operator_draft_actor_mismatch" } });
    expect((await readAgentOperations(db, ORGANISATION)).areas).toEqual([]);
  });

  it("refuses a confirmation after the draft has expired", async () => {
    const db = createDatabase();
    const draft = await create(db, {});
    expect(
      await confirmOperatorConfigurationDraft({
        db,
        env: fixtureEnv(db),
        organisationId: ORGANISATION,
        draftId: draft.draftId,
        actorUserId: OWNER,
        actorRole: "owner",
        previewCode: previewCode(draft.commandDigest),
        now: EXPIRES + 1,
      }),
    ).toEqual({ ok: false, error: { code: "operator_draft_expired" } });
    expect((await readAgentOperations(db, ORGANISATION)).areas).toEqual([]);
  });

  it("keeps only the newest draft confirmable when an operator rephrases", async () => {
    const db = createDatabase();
    const first = await create(db, {});
    const second = await create(db, {
      draftId: "draft_second",
      mutationId: "mutation_second",
      rawCommand: {
        kind: "create_area",
        name: "Bakery operations",
        purpose: "Own bakery packaging questions.",
      },
    });

    const pending = await readPendingOperatorDraft({
      db,
      organisationId: ORGANISATION,
      caseId: CASE,
      now: NOW,
    });
    expect(pending?.draftId).toBe(second.draftId);

    // The earlier reading of the request can no longer be accepted.
    expect(
      await confirmOperatorConfigurationDraft({
        db,
        env: fixtureEnv(db),
        organisationId: ORGANISATION,
        draftId: first.draftId,
        actorUserId: OWNER,
        actorRole: "owner",
        previewCode: previewCode(first.commandDigest),
        now: NOW + 10,
      }),
    ).toEqual({
      ok: false,
      error: { code: "operator_draft_not_pending", state: "cancelled" },
    });
  });

  it("refuses a request that is not a valid configuration command", async () => {
    const db = createDatabase();
    const result = await createOperatorConfigurationDraft({
      ...(await proposalFixtureAuthority(db, ORGANISATION)),
      draftId: "draft_bad",
      caseId: CASE,
      actorUserId: OWNER,
      actorPersonId: "person_owner",
      rawCommand: { kind: "delete_everything" },
      mutationId: "mutation_bad",
      now: NOW,
      expiresAt: EXPIRES,
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "agent_operation_invalid", field: "kind" },
    });
  });

  it("records the failure code when a confirmed command is refused", async () => {
    const db = createDatabase();
    const draft = await create(db, {
      rawCommand: {
        kind: "publish_agent_definition_revision",
        agentDefinitionId: "agent_missing",
        expectedRevision: 1,
        instructions: "Never applied.",
        requestedCapabilities: [],
        skillRefs: [],
      },
    });
    const confirmed = await confirmOperatorConfigurationDraft({
      db,
      env: fixtureEnv(db),
      organisationId: ORGANISATION,
      draftId: draft.draftId,
      actorUserId: OWNER,
      actorRole: "owner",
      previewCode: previewCode(draft.commandDigest),
      now: NOW + 10,
    });
    expect(confirmed).toMatchObject({ ok: false });
    // A second attempt replays the recorded failure rather than retrying it.
    expect(
      await confirmOperatorConfigurationDraft({
        db,
        env: fixtureEnv(db),
        organisationId: ORGANISATION,
        draftId: draft.draftId,
        actorUserId: OWNER,
        actorRole: "owner",
        previewCode: previewCode(draft.commandDigest),
        now: NOW + 20,
      }),
    ).toEqual({
      ok: false,
      error: { code: "agent_operation_not_found", field: "record" },
    });
  });
});

async function governanceRevision(
  db: SingleDatabase,
): Promise<number | undefined> {
  const row = await db
    .prepare(
      `SELECT revision FROM agent_installation_governance WHERE installation_id = ?`,
    )
    .bind("installation_urk")
    .first<{ revision: number }>();
  return row?.revision;
}

/** One active installation, so a governance change has something to govern. */
async function seedInstallation(db: SingleDatabase): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agent_installation (
       installation_id, organisation_id, agent_definition_id, definition_revision,
       policy_revision, granted_capabilities_json, lifecycle,
       created_by_user_id, created_at, updated_at
     ) VALUES (?, ?, 'definition_urk', 1, 1, '[]', 'active', ?, ?, ?)`,
    )
    .bind("installation_urk", ORGANISATION, OWNER, NOW, NOW)
    .run();
}

async function create(
  db: SingleDatabase,
  overrides: Readonly<{
    draftId?: string;
    mutationId?: string;
    rawCommand?: unknown;
  }>,
) {
  const result = await createOperatorConfigurationDraft({
    ...(await proposalFixtureAuthority(db, ORGANISATION)),
    draftId: overrides.draftId ?? "draft_first",
    caseId: CASE,
    actorUserId: OWNER,
    actorPersonId: "person_owner",
    rawCommand: overrides.rawCommand ?? {
      kind: "create_area",
      name: "Merchant operations",
      purpose: "Answer merchant questions and stage governed changes.",
    },
    mutationId: overrides.mutationId ?? "mutation_first",
    now: NOW,
    expiresAt: EXPIRES,
  });
  if (!result.ok)
    throw new Error(`draft creation failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function confirm(
  db: SingleDatabase,
  draftId: string,
  commandDigest: string,
  now: number,
  expectSuccess = true,
) {
  const confirmed = await confirmOperatorConfigurationDraft({
    db,
    env: fixtureEnv(db),
    organisationId: ORGANISATION,
    draftId,
    actorUserId: OWNER,
    actorRole: "owner",
    previewCode: previewCode(commandDigest),
    now,
  });
  if (expectSuccess && !confirmed.ok) {
    throw new Error(`confirmation failed: ${JSON.stringify(confirmed.error)}`);
  }
  return confirmed;
}

function createDatabase(): SingleDatabase {
  return createAgentOperationsDatabase(ORGANISATION);
}

/**
 * The env a confirmation needs to carry out its command.
 *
 * Only the database is exercised here: the two commands that reach further —
 * a manual run's Case and a responsibility scope's published evidence — have
 * their own tests.
 */
function fixtureEnv(db: SingleDatabase) {
  return {
    DB: db,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
      databaseBinding: "DB",
      kind: "affinity",
      placementCellId: "test",
      locationHint: "wnam",
    }),
  } as unknown as import("@purin-labs/kernel/env").Env;
}

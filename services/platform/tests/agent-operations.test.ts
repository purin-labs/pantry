/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "../src/database-handles";
import { describe, expect, it } from "vitest";
import {
  parseCommerceGraphQuery,
  parseEntityPlaneObservation,
  parseEntityPlanePublishedResourceMetadataResponse,
} from "@seams/commerce-client";

import {
  applyAgentOperation,
  parseAgentOperationInput,
  readAgentOperations,
  type AgentOperationCommand,
  type SavedSelectorCueResolverInput,
} from "../src/data/agent-operations";
import {
  readCaseAssignmentPin,
  recordCaseAssignmentPin,
} from "../src/data/agent-operations/case-assignment-pins";
import { resolveCueAutomation } from "../src/data/agent-operations/automation";
import { submitAgentConfigurationProposal } from "../src/data/agent-operations/proposals";
import { createCommerceEntityPlaneCueEvents } from "../src/cues/engine";
import { parseIntegrationAccountId, parseOrganisationId } from "../src/ids";
import {
  createAgentOperationsDatabase,
  proposalFixtureAuthority,
} from "./agent-operations-database";
import { requireOrganisationId } from "./test-ids";
import { parseAgentOperationForm } from "@seams/control-api/portal/agent-operations";

const ORGANISATION = requireOrganisationId("organisation_plan16_operations");

describe("Plan 16 agent operations", () => {
  it("creates an area, skill, definition, installation, and binding from typed commands", async () => {
    const db = createDatabase();
    const area = await apply(db, {
      kind: "create_area",
      name: "Inventory",
      purpose: "Monitor low stock and replenishment exceptions.",
      operationId: "area_inventory",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 100,
    });
    expect(area.areas).toHaveLength(1);

    const skill = await apply(db, {
      kind: "create_skill",
      title: "Low stock response",
      sensitivity: "ordinary",
      markdownBody: "Review the low-stock item and propose replenishment.",
      operationId: "skill_low_stock",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 101,
    });
    expect(skill.skills[0]?.currentRevision.contentDigest).toMatch(
      /^[0-9a-f]{64}$/u,
    );

    const definition = await apply(db, {
      kind: "create_agent_definition",
      displayName: "Inventory coordinator",
      role: "coordinator",
      purpose: "Coordinate safe replenishment work.",
      instructions:
        "Inspect inventory and ask for approval before provider writes.",
      requestedCapabilities: [
        "commerce.entity_plane.context",
        "commerce.action.propose",
      ],
      skillRefs: [{ skillId: "skill_low_stock", revision: 1 }],
      operationId: "agent_inventory",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 102,
    });
    expect(definition.definitions[0]?.currentRevision.revision).toBe(1);

    const installed = await apply(db, {
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
    expect(installed.installations[0]?.areaAssignments).toEqual([
      {
        areaId: "area_inventory",
        responsibility: "Own inventory triage.",
        scopeIds: [],
        assignedAt: 103,
      },
    ]);

    const bound = await apply(db, {
      kind: "bind_skill",
      targetKind: "area",
      targetId: "area_inventory",
      skillId: "skill_low_stock",
      skillRevision: 1,
      operationId: "binding_inventory_skill",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 104,
    });
    expect(bound.bindings).toEqual([
      {
        bindingId: "binding_inventory_skill",
        organisationId: ORGANISATION,
        targetKind: "area",
        targetId: "area_inventory",
        skillId: "skill_low_stock",
        skillRevision: 1,
        createdAt: 104,
      },
    ]);
  });

  it("rejects malformed boundary input and preserves organisation isolation", async () => {
    expect(parseAgentOperationInput({ kind: "create_area" })).toEqual({
      ok: false,
      error: { code: "agent_operation_invalid", field: "name" },
    });
    expect(
      parseAgentOperationInput({
        kind: "install_agent",
        agentDefinitionId: "agent_support",
        definitionRevision: 1,
        areaId: "area_support",
        responsibility: "Prepare customer replies for approval.",
        scopeIds: [],
        policyRevision: 1,
        grantedCapabilities: [],
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "install_agent",
        agentDefinitionId: "agent_support",
        definitionRevision: 1,
        areaId: "area_support",
        responsibility: "Prepare customer replies for approval.",
        scopeIds: [],
        policyRevision: 1,
        grantedCapabilities: [],
      },
    });
    const db = createDatabase();
    await apply(db, {
      kind: "create_area",
      name: "Orders",
      purpose: "Handle order exceptions.",
      operationId: "area_orders",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 100,
    });
    const otherOrganisation = parseOrganisationId(
      "organisation_other_operations",
    );
    if (!otherOrganisation.ok)
      throw new Error("other organisation id is invalid");
    expect(
      (await readAgentOperations(db, otherOrganisation.value)).areas,
    ).toEqual([]);
  });

  it("parses the closed responsibility-scope branches", () => {
    expect(
      parseAgentOperationInput({
        kind: "publish_responsibility_scope",
        areaId: "area_catalog",
        scope: {
          kind: "entity_type",
          entityTypeId: { origin: "system", typeId: "product" },
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "publish_responsibility_scope",
        areaId: "area_catalog",
        scope: {
          kind: "entity_type",
          entityTypeId: { origin: "system", typeId: "product" },
        },
      },
    });
    expect(
      parseAgentOperationInput({
        kind: "publish_responsibility_scope",
        areaId: "area_catalog",
        scope: { kind: "commerce_list", listId: "export_coordination" },
      }).ok,
    ).toBe(true);
    expect(
      parseAgentOperationInput({
        kind: "publish_responsibility_scope",
        areaId: "area_catalog",
        scope: {
          kind: "saved_selector",
          selector: {
            selectorId: "products",
            revision: 1,
            query: { kind: "invalid" },
          },
        },
      }),
    ).toEqual({
      ok: false,
      error: { code: "agent_operation_invalid", field: "scope" },
    });
  });

  it("rejects evidence for a different published resource before the D1 insert", async () => {
    const db = createDatabase();
    await apply(db, {
      kind: "create_area",
      name: "Inventory",
      purpose: "Handle inventory work.",
      operationId: "area_inventory_evidence",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 100,
    });
    const result = await applyAgentOperation(db, ORGANISATION, {
      kind: "publish_responsibility_scope",
      areaId: "area_inventory_evidence",
      scope: {
        kind: "entity_type",
        entityTypeId: { origin: "custom", typeId: "trade_partner" },
      },
      publishedResourceEvidence: publishedEntityTypeEvidence("export_document"),
      operationId: "scope_wrong_evidence",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 101,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "agent_operation_invalid",
        field: "publishedResourceEvidence",
      },
    });
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM agent_responsibility_scope WHERE organisation_id = ?",
      )
      .bind(ORGANISATION)
      .first<{ readonly count: number }>();
    expect(row?.count).toBe(0);
  });

  it("never grants a capability the definition did not request", async () => {
    const db = createDatabase();
    await apply(db, {
      kind: "create_area",
      name: "Inventory",
      purpose: "Handle inventory work.",
      operationId: "area_inventory_grants",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 100,
    });
    await apply(db, {
      kind: "create_agent_definition",
      displayName: "Inventory agent",
      role: "coordinator",
      purpose: "Review inventory.",
      instructions: "Read inventory and propose safe actions.",
      requestedCapabilities: ["commerce.entity_plane.context"],
      skillRefs: [],
      operationId: "agent_inventory_grants",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 101,
    });
    const result = await applyAgentOperation(db, ORGANISATION, {
      kind: "install_agent",
      agentDefinitionId: "agent_inventory_grants",
      definitionRevision: 1,
      areaId: "area_inventory_grants",
      responsibility: "Own inventory triage.",
      scopeIds: [],
      policyRevision: 1,
      grantedCapabilities: ["commerce.action.propose"],
      operationId: "installation_inventory_grants",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 102,
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "agent_operation_conflict", field: "grantedCapabilities" },
    });
  });

  it("changes an agent's skill set only by publishing a definition revision", async () => {
    const db = createDatabase();
    await apply(db, {
      kind: "create_skill",
      title: "Low stock triage",
      sensitivity: "ordinary",
      markdownBody: "Rank low stock by days of cover.",
      operationId: "skill_low_stock",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 100,
    });
    await apply(db, {
      kind: "create_skill",
      title: "Markdown review",
      sensitivity: "ordinary",
      markdownBody:
        "Compare sales with available stock before proposing a markdown.",
      operationId: "skill_markdown",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 101,
    });
    const created = await apply(db, {
      kind: "create_agent_definition",
      displayName: "Merchant operator",
      role: "coordinator",
      purpose: "Operate the merchant's day.",
      instructions: "Ground every claim in returned evidence.",
      requestedCapabilities: ["commerce.entity_plane.context"],
      skillRefs: [{ skillId: "skill_low_stock", revision: 1 }],
      operationId: "agent_merchant",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 102,
    });
    expect(created.definitions[0]?.currentRevision.skillRefs).toEqual([
      { skillId: "skill_low_stock", revision: 1 },
    ]);

    // Attaching a second skill and removing the first is one publication.
    const republished = await apply(db, {
      kind: "publish_agent_definition_revision",
      agentDefinitionId: "agent_merchant",
      expectedRevision: 1,
      instructions: "Ground every claim in returned evidence.",
      requestedCapabilities: ["commerce.entity_plane.context"],
      skillRefs: [{ skillId: "skill_markdown", revision: 1 }],
      operationId: "agent_merchant_revision_2",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 103,
    });
    expect(republished.definitions[0]?.currentRevision).toMatchObject({
      revision: 2,
      skillRefs: [{ skillId: "skill_markdown", revision: 1 }],
    });

    // An agent definition is no longer a skill-binding target.
    const bound = await applyAgentOperation(db, ORGANISATION, {
      kind: "bind_skill",
      // @ts-expect-error a definition is not a skill-binding target
      targetKind: "agent_definition",
      targetId: "agent_merchant",
      skillId: "skill_low_stock",
      skillRevision: 1,
      operationId: "binding_definition_skill",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 104,
    });
    expect(bound).toEqual({
      ok: false,
      error: { code: "agent_operation_not_found", field: "targetId" },
    });

    // A skill revision that was never authored cannot be attached.
    const missing = await applyAgentOperation(db, ORGANISATION, {
      kind: "publish_agent_definition_revision",
      agentDefinitionId: "agent_merchant",
      expectedRevision: 2,
      instructions: "Ground every claim in returned evidence.",
      requestedCapabilities: ["commerce.entity_plane.context"],
      skillRefs: [{ skillId: "skill_markdown", revision: 7 }],
      operationId: "agent_merchant_revision_3",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 105,
    });
    expect(missing).toEqual({
      ok: false,
      error: { code: "agent_operation_not_found", field: "skillRefs" },
    });
  });

  it("separates a published definition revision from the one an installation runs", async () => {
    const db = createDatabase();
    await seedInstalledAgent(db);

    await apply(db, {
      kind: "publish_agent_definition_revision",
      agentDefinitionId: "agent_inventory",
      expectedRevision: 1,
      instructions: "Prioritize perishables before dry goods.",
      requestedCapabilities: ["commerce.entity_plane.context"],
      skillRefs: [{ skillId: "skill_low_stock", revision: 1 }],
      operationId: "agent_inventory_revision_2",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 300,
    });

    // Publication alone never changes what the installed agent runs.
    const published = await readAgentOperations(db, ORGANISATION);
    expect(published.definitions[0]?.currentRevision.revision).toBe(2);
    expect(published.installations[0]?.definitionRevision).toBe(1);

    // A publication against the revision it replaced is refused.
    const stalePublication = await applyAgentOperation(db, ORGANISATION, {
      kind: "publish_agent_definition_revision",
      agentDefinitionId: "agent_inventory",
      expectedRevision: 1,
      instructions: "This stale revision must not publish.",
      skillRefs: [],
      requestedCapabilities: [],
      operationId: "agent_inventory_revision_stale",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 300,
    });
    expect(stalePublication).toEqual({
      ok: false,
      error: { code: "agent_operation_conflict", field: "expectedRevision" },
    });

    const activationForm = new FormData();
    activationForm.set("installationId", "installation_inventory");
    activationForm.set("expectedDefinitionRevision", "1");
    activationForm.set("definitionRevision", "2");
    activationForm.append("skillRefs", "skill_low_stock@1");
    const activation = parseAgentOperationForm(
      "activate_agent_definition_revision",
      activationForm,
    );
    if (
      !activation.ok ||
      activation.command.kind !== "activate_agent_definition_revision"
    ) {
      throw new Error("Activation form did not produce an activation command");
    }
    const activated = await apply(db, {
      ...activation.command,
      operationId: "activation_inventory",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 301,
    });
    expect(activated.installations[0]?.definitionRevision).toBe(2);

    // A concurrent activation against the value it replaced is refused.
    const stale = await applyAgentOperation(db, ORGANISATION, {
      kind: "activate_agent_definition_revision",
      installationId: "installation_inventory",
      expectedDefinitionRevision: 1,
      definitionRevision: 2,
      skillRefs: [{ skillId: "skill_low_stock", revision: 1 }],
      operationId: "activation_inventory_stale",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 302,
    });
    expect(stale).toEqual({
      ok: false,
      error: {
        code: "agent_operation_conflict",
        field: "expectedDefinitionRevision",
      },
    });
  });

  it("refuses activation whose confirmed skill set is not the published one", async () => {
    const db = createDatabase();
    await seedInstalledAgent(db);
    await apply(db, {
      kind: "publish_agent_definition_revision",
      agentDefinitionId: "agent_inventory",
      expectedRevision: 1,
      instructions: "Prioritize perishables before dry goods.",
      requestedCapabilities: ["commerce.entity_plane.context"],
      skillRefs: [{ skillId: "skill_low_stock", revision: 1 }],
      operationId: "agent_inventory_revision_2",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 300,
    });
    const mismatched = await applyAgentOperation(db, ORGANISATION, {
      kind: "activate_agent_definition_revision",
      installationId: "installation_inventory",
      expectedDefinitionRevision: 1,
      definitionRevision: 2,
      skillRefs: [],
      operationId: "activation_mismatched",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 301,
    });
    expect(mismatched).toEqual({
      ok: false,
      error: { code: "agent_operation_conflict", field: "skillRefs" },
    });
    const snapshot = await readAgentOperations(db, ORGANISATION);
    expect(snapshot.installations[0]?.definitionRevision).toBe(1);
  });

  it("refuses activation of a revision that asks for an ungranted capability", async () => {
    const db = createDatabase();
    await seedInstalledAgent(db);
    await apply(db, {
      kind: "publish_agent_definition_revision",
      agentDefinitionId: "agent_inventory",
      expectedRevision: 1,
      instructions: "Also propose commerce actions.",
      requestedCapabilities: [
        "commerce.entity_plane.context",
        "commerce.action.propose",
      ],
      skillRefs: [{ skillId: "skill_low_stock", revision: 1 }],
      operationId: "agent_inventory_revision_widened",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 300,
    });
    const widened = await applyAgentOperation(db, ORGANISATION, {
      kind: "activate_agent_definition_revision",
      installationId: "installation_inventory",
      expectedDefinitionRevision: 1,
      definitionRevision: 2,
      skillRefs: [{ skillId: "skill_low_stock", revision: 1 }],
      operationId: "activation_widened",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 301,
    });
    expect(widened).toEqual({
      ok: false,
      error: { code: "agent_operation_invalid", field: "grantedCapabilities" },
    });
    const snapshot = await readAgentOperations(db, ORGANISATION);
    expect(snapshot.installations[0]?.definitionRevision).toBe(1);
  });

  it("publishes immutable skill revisions while bindings stay pinned", async () => {
    const db = createDatabase();
    await apply(db, {
      kind: "create_area",
      name: "Order skill revisions",
      purpose: "Review order exceptions.",
      operationId: "area_order_skill_revisions",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 100,
    });
    await apply(db, {
      kind: "create_skill",
      title: "Order exception response",
      sensitivity: "ordinary",
      markdownBody: "Inspect the order before proposing an action.",
      operationId: "skill_order_revisions",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 101,
    });
    await apply(db, {
      kind: "bind_skill",
      targetKind: "area",
      targetId: "area_order_skill_revisions",
      skillId: "skill_order_revisions",
      skillRevision: 1,
      operationId: "binding_order_skill_revisions",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 102,
    });

    const revised = await apply(db, {
      kind: "publish_skill_revision",
      skillId: "skill_order_revisions",
      expectedRevision: 1,
      markdownBody:
        "Inspect the order and verify its current source revision before proposing an action.",
      operationId: "skill_order_revision_2",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 103,
    });

    expect(revised.skills[0]?.currentRevision).toMatchObject({
      revision: 2,
      markdownBody:
        "Inspect the order and verify its current source revision before proposing an action.",
    });
    expect(revised.bindings[0]?.skillRevision).toBe(1);

    const stale = await applyAgentOperation(db, ORGANISATION, {
      kind: "publish_skill_revision",
      skillId: "skill_order_revisions",
      expectedRevision: 1,
      markdownBody: "This stale revision must not publish.",
      operationId: "skill_order_revision_stale",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 104,
    });
    expect(stale).toEqual({
      ok: false,
      error: { code: "agent_operation_conflict", field: "expectedRevision" },
    });
  });

  it("configures cue bindings, schedules, budgets, and escalation through typed commands", async () => {
    const db = createDatabase();
    await seedInstalledAgent(db);

    const cueConfigured = await apply(db, {
      kind: "configure_cue_binding",
      areaId: "area_inventory",
      installationId: "installation_inventory",
      scopeIds: [],
      cueSource: "commerce",
      cueEventType: "inventory_low_stock",
      enabled: true,
      instructionBody: "Check supplier lead times before proposing quantities.",
      operationId: "cue_binding_low_stock",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 200,
    });
    expect(cueConfigured.cueBindings).toEqual([
      {
        bindingId: "cue_binding_low_stock",
        organisationId: ORGANISATION,
        areaId: "area_inventory",
        installationId: "installation_inventory",
        cueSource: "commerce",
        cueEventType: "inventory_low_stock",
        scopeIds: [],
        enabled: true,
        instructionBody:
          "Check supplier lead times before proposing quantities.",
        revision: 1,
        createdAt: 200,
        updatedAt: 200,
      },
    ]);

    const cueDisabled = await apply(db, {
      kind: "update_cue_binding",
      bindingId: "cue_binding_low_stock",
      expectedRevision: 1,
      enabled: false,
      instructionBody: "Check supplier lead times before proposing quantities.",
      operationId: "cue_binding_low_stock_update",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 201,
    });
    expect(cueDisabled.cueBindings[0]).toMatchObject({
      bindingId: "cue_binding_low_stock",
      enabled: false,
      revision: 2,
      updatedAt: 201,
    });
    const staleCueUpdate = await applyAgentOperation(db, ORGANISATION, {
      kind: "update_cue_binding",
      bindingId: "cue_binding_low_stock",
      expectedRevision: 1,
      enabled: true,
      instructionBody: null,
      operationId: "cue_binding_low_stock_stale",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 202,
    });
    expect(staleCueUpdate).toEqual({
      ok: false,
      error: { code: "agent_operation_conflict", field: "expectedRevision" },
    });

    const scheduled = await apply(db, {
      kind: "configure_schedule_binding",
      areaId: "area_inventory",
      installationId: "installation_inventory",
      scopeIds: [],
      spec: { cadence: "daily", timeOfDay: "07:00", timezone: "Asia/Tokyo" },
      enabled: true,
      instructionBody: null,
      operationId: "schedule_daily_inventory",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 202,
    });
    expect(scheduled.scheduleBindings[0]).toMatchObject({
      spec: { cadence: "daily", timeOfDay: "07:00", timezone: "Asia/Tokyo" },
      scheduleTimeKey: "daily@07:00@Asia/Tokyo",
      enabled: true,
      instructionBody: null,
      revision: 1,
    });
    expect(scheduled.scheduleBindings[0]?.lastDispatchedWindow).toMatch(
      /\/daily$/u,
    );

    const secondDaily = await apply(db, {
      kind: "configure_schedule_binding",
      areaId: "area_inventory",
      installationId: "installation_inventory",
      scopeIds: [],
      spec: { cadence: "daily", timeOfDay: "18:30", timezone: "Asia/Tokyo" },
      enabled: true,
      instructionBody: "Prepare the evening restock summary.",
      operationId: "schedule_daily_inventory_evening",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 203,
    });
    expect(secondDaily.scheduleBindings).toHaveLength(2);

    const scheduleDisabled = await apply(db, {
      kind: "update_schedule_binding",
      bindingId: "schedule_daily_inventory",
      expectedRevision: 1,
      enabled: false,
      instructionBody: null,
      operationId: "schedule_daily_inventory_off",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 204,
    });
    const disabledRow = scheduleDisabled.scheduleBindings.find(
      (binding) => binding.bindingId === "schedule_daily_inventory",
    );
    expect(disabledRow).toMatchObject({ enabled: false, revision: 2 });

    const governed = await apply(db, {
      kind: "configure_installation_governance",
      installationId: "installation_inventory",
      maxSessionBudgetTokens: 40_000,
      operationId: "governance_inventory",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 203,
    });
    expect(governed.governance).toEqual([
      {
        installationId: "installation_inventory",
        organisationId: ORGANISATION,
        maxSessionBudgetTokens: 40_000,
        revision: 1,
        updatedAt: 203,
      },
    ]);

    const escalation = await apply(db, {
      kind: "configure_escalation_policy",
      areaId: "area_inventory",
      scopeIds: [],
      approvalReminderAfterMs: 30 * 60_000,
      escalateAfterMs: 4 * 60 * 60_000,
      operationId: "escalation_inventory",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 204,
    });
    expect(escalation.escalationPolicies).toEqual([
      {
        areaId: "area_inventory",
        organisationId: ORGANISATION,
        scopeIds: [],
        approvalReminderAfterMs: 30 * 60_000,
        escalateAfterMs: 4 * 60 * 60_000,
        escalateTo: "organisation_owner",
        revision: 1,
        updatedAt: 204,
      },
    ]);

    expect(
      parseAgentOperationInput({
        kind: "configure_escalation_policy",
        areaId: "area_inventory",
        scopeIds: ["scope_inventory"],
        approvalReminderAfterMs: 60_000,
        escalateAfterMs: 30_000,
      }),
    ).toEqual({
      ok: false,
      error: { code: "agent_operation_invalid", field: "escalateAfterMs" },
    });
  });

  it("resolves cue automation and records exact assignment pins", async () => {
    const db = createDatabase();
    await seedInstalledAgent(db);
    await apply(db, {
      kind: "configure_installation_governance",
      installationId: "installation_inventory",
      maxSessionBudgetTokens: 25_000,
      operationId: "governance_inventory",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 206,
    });
    await apply(db, {
      kind: "configure_cue_binding",
      areaId: "area_inventory",
      installationId: "installation_inventory",
      scopeIds: [],
      cueSource: "commerce",
      cueEventType: "inventory_low_stock",
      enabled: true,
      instructionBody: null,
      operationId: "cue_binding_low_stock",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 207,
    });

    const automation = await resolveCueAutomation(
      db,
      ORGANISATION,
      "commerce",
      "inventory_low_stock",
    );
    expect(automation).toMatchObject({
      binding: {
        bindingId: "cue_binding_low_stock",
        installationId: "installation_inventory",
      },
      agentDefinitionId: "agent_inventory",
      definitionRevision: 1,
      policyRevision: 1,
      skillRefs: [{ skillId: "skill_low_stock", revision: 1 }],
      grantedCapabilities: ["commerce.entity_plane.context"],
      maxSessionBudgetTokens: 25_000,
    });
    expect(
      await resolveCueAutomation(
        db,
        ORGANISATION,
        "commerce",
        "inventory_shortage",
      ),
    ).toBeNull();

    await apply(db, {
      kind: "publish_responsibility_scope",
      areaId: "area_inventory",
      scope: {
        kind: "entity_type",
        entityTypeId: { origin: "custom", typeId: "trade_partner" },
      },
      publishedResourceEvidence: publishedEntityTypeEvidence("trade_partner"),
      operationId: "scope_trade_partner",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 208,
    });
    await apply(db, {
      kind: "configure_cue_binding",
      areaId: "area_inventory",
      installationId: "installation_inventory",
      scopeIds: ["scope_trade_partner"],
      cueSource: "commerce",
      cueEventType: "entity_plane_changed",
      enabled: true,
      instructionBody: null,
      operationId: "cue_binding_entity_plane",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 209,
    });
    const integrationAccountId = parseIntegrationAccountId(
      "integration_entity_plane",
    );
    if (!integrationAccountId.ok)
      throw new Error("invalid entity-plane integration fixture");
    const observation = parseEntityPlaneObservation({
      kind: "custom_entity_changed",
      observationId: "observation_trade_partner",
      entityRef: {
        origin: "custom",
        typeId: "trade_partner",
        entityId: "partner_a",
      },
      revision: 1,
      merchantRevision: 4,
    });
    const entityCue = createCommerceEntityPlaneCueEvents({
      organisationId: ORGANISATION,
      integrationAccountId: integrationAccountId.value,
      deliveryId: "delivery_entity_plane",
      merchantId: "merchant_entity_plane",
      merchantRevision: 4,
      observedAt: "2026-08-09T10:00:00Z",
      observations: [observation],
      at: 210,
    })[0];
    if (entityCue === undefined)
      throw new Error("missing entity-plane cue fixture");
    expect(
      await resolveCueAutomation(
        db,
        ORGANISATION,
        "commerce",
        "entity_plane_changed",
        entityCue.payload,
      ),
    ).not.toBeNull();
    const otherObservation = parseEntityPlaneObservation({
      kind: "custom_entity_changed",
      observationId: "observation_export_document",
      entityRef: {
        origin: "custom",
        typeId: "export_document",
        entityId: "document_a",
      },
      revision: 1,
      merchantRevision: 4,
    });
    const otherCue = createCommerceEntityPlaneCueEvents({
      organisationId: ORGANISATION,
      integrationAccountId: integrationAccountId.value,
      deliveryId: "delivery_entity_plane",
      merchantId: "merchant_entity_plane",
      merchantRevision: 4,
      observedAt: "2026-08-09T10:00:00Z",
      observations: [otherObservation],
      at: 210,
    })[0];
    if (otherCue === undefined)
      throw new Error("missing nonmatching cue fixture");
    expect(
      await resolveCueAutomation(
        db,
        ORGANISATION,
        "commerce",
        "entity_plane_changed",
        otherCue.payload,
      ),
    ).toBeNull();

    await apply(db, {
      kind: "publish_responsibility_scope",
      areaId: "area_inventory",
      scope: {
        kind: "saved_selector",
        selector: {
          selectorId: "export_board",
          revision: 3,
          query: parseCommerceGraphQuery({
            kind: "saved_commerce_view",
            viewId: "export_board",
            pagination: { limit: 20, cursor: null },
          }),
        },
      },
      publishedResourceEvidence: publishedSavedViewEvidence(),
      operationId: "scope_saved_view",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 211,
    });
    await apply(db, {
      kind: "configure_cue_binding",
      areaId: "area_inventory",
      installationId: "installation_inventory",
      scopeIds: ["scope_saved_view"],
      cueSource: "commerce",
      cueEventType: "entity_plane_changed",
      enabled: true,
      instructionBody: null,
      operationId: "cue_binding_saved_view",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 212,
    });
    const savedViewObservation = parseEntityPlaneObservation({
      kind: "custom_entity_changed",
      observationId: "observation_saved_view",
      entityRef: {
        origin: "custom",
        typeId: "trade_partner",
        entityId: "partner_a",
      },
      revision: 3,
      merchantRevision: 7,
    });
    const savedViewCue = createCommerceEntityPlaneCueEvents({
      organisationId: ORGANISATION,
      integrationAccountId: integrationAccountId.value,
      deliveryId: "delivery_saved_view",
      merchantId: "merchant_entity_plane",
      merchantRevision: 7,
      observedAt: "2026-08-09T10:00:00Z",
      observations: [savedViewObservation],
      at: 213,
    })[0];
    if (savedViewCue === undefined)
      throw new Error("missing saved-view cue fixture");
    expect(
      await resolveCueAutomation(
        db,
        ORGANISATION,
        "commerce",
        "entity_plane_changed",
        savedViewCue.payload,
      ),
    ).toBeNull();
    expect(
      await resolveCueAutomation(
        db,
        ORGANISATION,
        "commerce",
        "entity_plane_changed",
        savedViewCue.payload,
        savedViewMembershipResolver,
      ),
    ).not.toBeNull();

    if (automation === null)
      throw new Error("cue automation resolution is missing");
    await recordCaseAssignmentPin(
      (await proposalFixtureAuthority(db, ORGANISATION)).scope,
      {
        organisationId: ORGANISATION,
        assignmentId: "assignment_cue_1",
        caseId: "case_cue_1",
        installationId: automation.binding.installationId,
        agentDefinitionId: automation.agentDefinitionId,
        definitionRevision: automation.definitionRevision,
        policyRevision: automation.policyRevision,
        skillRefs: automation.skillRefs,
        grantedCapabilities: automation.grantedCapabilities,
        maxSessionBudgetTokens: automation.maxSessionBudgetTokens,
        pinnedAt: 210,
      },
    );
    const pin = await readCaseAssignmentPin(
      db,
      ORGANISATION,
      "assignment_cue_1",
    );
    expect(pin).toEqual({
      organisationId: ORGANISATION,
      assignmentId: "assignment_cue_1",
      caseId: "case_cue_1",
      installationId: "installation_inventory",
      agentDefinitionId: "agent_inventory",
      definitionRevision: 1,
      policyRevision: 1,
      skillRefs: [{ skillId: "skill_low_stock", revision: 1 }],
      grantedCapabilities: ["commerce.entity_plane.context"],
      maxSessionBudgetTokens: 25_000,
      pinnedAt: 210,
    });

    await apply(db, {
      kind: "publish_agent_definition_revision",
      agentDefinitionId: "agent_inventory",
      expectedRevision: 1,
      instructions: "Updated inventory instructions.",
      requestedCapabilities: [
        "commerce.entity_plane.context",
        "commerce.action.propose",
      ],
      skillRefs: [{ skillId: "skill_low_stock", revision: 1 }],
      operationId: "agent_inventory_revision_2",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 211,
    });
    expect(
      await readCaseAssignmentPin(db, ORGANISATION, "assignment_cue_1"),
    ).toMatchObject({
      definitionRevision: 1,
    });
  });

  it("publishes a proposal and closes it in one commit, or not at all", async () => {
    const db = createDatabase();
    await seedInstalledAgent(db);
    const submitted = await submitAgentConfigurationProposal(db, ORGANISATION, {
      proposalId: "config_proposal_1",
      installationId: "installation_inventory",
      targetKind: "agent_instructions",
      targetId: "agent_inventory",
      expectedRevision: 1,
      proposedBody: "Sharper inventory instructions proposed by the agent.",
      rationale: "The current instructions miss transfer options.",
      now: 300,
    });
    if (!submitted.ok)
      throw new Error(`proposal failed: ${submitted.error.code}`);

    // A trailing statement that cannot commit: the proposal id already exists.
    // If publishing and closing were separate commits, the revision would land
    // here while the proposal stayed open, and a retry would then report a
    // conflict for a publication that had already happened.
    const poison = db
      .prepare(
        `INSERT INTO agent_configuration_proposal (proposal_id, organisation_id) VALUES (?, ?)`,
      )
      .bind("config_proposal_1", ORGANISATION);
    const accepted = await applyAgentOperation(
      db,
      ORGANISATION,
      {
        kind: "accept_configuration_proposal",
        proposalId: "config_proposal_1",
        operationId: "accept_config_proposal_atomic",
        actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
        now: 5_050,
      },
      [poison],
    );

    expect(accepted.ok).toBe(false);
    const proposal = await db
      .prepare(
        `SELECT status FROM agent_configuration_proposal WHERE proposal_id = ?`,
      )
      .bind("config_proposal_1")
      .first<{ status: string }>();
    expect(proposal?.status).toBe("open");
    const definition = await db
      .prepare(
        `SELECT current_revision AS revision FROM agent_definition WHERE agent_definition_id = ?`,
      )
      .bind("agent_inventory")
      .first<{ revision: number }>();
    expect(definition?.revision).toBe(1);
  });

  it("keeps agent configuration proposals unpublished until a merchant accepts", async () => {
    const db = createDatabase();
    await seedInstalledAgent(db);

    const submitted = await submitAgentConfigurationProposal(db, ORGANISATION, {
      proposalId: "config_proposal_1",
      installationId: "installation_inventory",
      targetKind: "agent_instructions",
      targetId: "agent_inventory",
      expectedRevision: 1,
      proposedBody: "Sharper inventory instructions proposed by the agent.",
      rationale: "The current instructions miss transfer options.",
      now: 300,
    });
    if (!submitted.ok) throw new Error(submitted.error.code);
    expect(submitted.value.status).toBe("open");

    const beforeDecision = await readAgentOperations(db, ORGANISATION);
    expect(beforeDecision.definitions[0]?.currentRevision.revision).toBe(1);
    expect(beforeDecision.configurationProposals[0]?.status).toBe("open");

    const replay = await submitAgentConfigurationProposal(db, ORGANISATION, {
      proposalId: "config_proposal_1",
      installationId: "installation_inventory",
      targetKind: "agent_instructions",
      targetId: "agent_inventory",
      expectedRevision: 1,
      proposedBody: "Sharper inventory instructions proposed by the agent.",
      rationale: "The current instructions miss transfer options.",
      now: 301,
    });
    if (!replay.ok) throw new Error(replay.error.code);
    expect(replay.value.createdAt).toBe(300);

    const accepted = await apply(db, {
      kind: "accept_configuration_proposal",
      proposalId: "config_proposal_1",
      operationId: "accept_config_proposal_1",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 302,
    });
    expect(accepted.definitions[0]?.currentRevision).toMatchObject({
      revision: 2,
      instructions: "Sharper inventory instructions proposed by the agent.",
    });
    expect(accepted.installations[0]?.definitionRevision).toBe(1);
    expect(accepted.configurationProposals[0]).toMatchObject({
      status: "accepted",
      publishedRevision: 2,
    });

    const secondDecision = await applyAgentOperation(db, ORGANISATION, {
      kind: "dismiss_configuration_proposal",
      proposalId: "config_proposal_1",
      operationId: "dismiss_config_proposal_1",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 303,
    });
    expect(secondDecision).toEqual({
      ok: false,
      error: { code: "agent_operation_conflict", field: "proposalId" },
    });
  });

  it("rejects proposals that target foreign definitions or unbound skills", async () => {
    const db = createDatabase();
    await seedInstalledAgent(db);
    await apply(db, {
      kind: "create_agent_definition",
      displayName: "Orders assistant",
      role: "specialist",
      purpose: "Handle order exceptions.",
      instructions: "Review order exceptions.",
      requestedCapabilities: ["commerce.entity_plane.context"],
      skillRefs: [],
      operationId: "agent_orders",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      now: 400,
    });

    const foreignDefinition = await submitAgentConfigurationProposal(
      db,
      ORGANISATION,
      {
        proposalId: "config_proposal_foreign",
        installationId: "installation_inventory",
        targetKind: "agent_instructions",
        targetId: "agent_orders",
        expectedRevision: 1,
        proposedBody: "The inventory agent must not edit the orders agent.",
        rationale: "Cross-agent instruction change.",
        now: 401,
      },
    );
    expect(foreignDefinition).toEqual({
      ok: false,
      error: { code: "configuration_proposal_target_forbidden" },
    });

    const unboundSkill = await submitAgentConfigurationProposal(
      db,
      ORGANISATION,
      {
        proposalId: "config_proposal_unbound",
        installationId: "installation_inventory",
        targetKind: "skill_markdown",
        targetId: "skill_low_stock",
        expectedRevision: 1,
        proposedBody: "Better skill body.",
        rationale: "The skill is not bound to this agent or its areas.",
        now: 402,
      },
    );
    expect(unboundSkill).toEqual({
      ok: false,
      error: { code: "configuration_proposal_target_forbidden" },
    });

    const stale = await submitAgentConfigurationProposal(db, ORGANISATION, {
      proposalId: "config_proposal_stale",
      installationId: "installation_inventory",
      targetKind: "agent_instructions",
      targetId: "agent_inventory",
      expectedRevision: 5,
      proposedBody: "Stale revision proposal.",
      rationale: "The expected revision is not current.",
      now: 403,
    });
    expect(stale).toEqual({
      ok: false,
      error: { code: "configuration_proposal_target_stale" },
    });
  });
});

function savedViewMembershipResolver(input: SavedSelectorCueResolverInput) {
  return Promise.resolve({
    ok: true as const,
    value:
      input.selector.selectorId === "export_board" &&
      input.selector.revision === 3,
  });
}

async function seedInstalledAgent(db: SingleDatabase): Promise<void> {
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
    requestedCapabilities: [
      "commerce.entity_plane.context",
      "commerce.action.propose",
    ],
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
}

async function apply(db: SingleDatabase, command: AgentOperationCommand) {
  const result = await applyAgentOperation(db, ORGANISATION, command);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function publishedEntityTypeEvidence(typeId: string) {
  const result = parseEntityPlanePublishedResourceMetadataResponse({
    kind: "resolved",
    organisationId: ORGANISATION,
    merchantId: "merchant_entity_plane",
    merchantRevision: 4,
    resource: {
      kind: "entity_type",
      entityType: {
        origin: "custom",
        typeId,
        publishedRevision: 1,
      },
    },
  });
  if (result.kind !== "resolved")
    throw new Error("invalid published entity type fixture");
  return result;
}

function publishedSavedViewEvidence() {
  const result = parseEntityPlanePublishedResourceMetadataResponse({
    kind: "resolved",
    organisationId: ORGANISATION,
    merchantId: "merchant_entity_plane",
    merchantRevision: 7,
    resource: {
      kind: "saved_selector",
      selector: {
        selectorId: "export_board",
        revision: 3,
        query: {
          kind: "saved_commerce_view",
          viewId: "export_board",
          pagination: { limit: 20, cursor: null },
        },
      },
      view: {
        viewId: "export_board",
        name: "Export board",
        source: {
          kind: "entity_type",
          entityTypeId: { origin: "custom", typeId: "trade_partner" },
        },
        filter: { kind: "all" },
        sorts: [],
        visibleAttributeIds: ["status"],
        relationshipColumns: [],
        grouping: null,
        presentation: {
          kind: "table",
          configuration: { density: "comfortable", showRowNumbers: false },
        },
        revision: 3,
      },
    },
  });
  if (result.kind !== "resolved")
    throw new Error("invalid published saved view fixture");
  return result;
}

const createDatabase = (): SingleDatabase =>
  createAgentOperationsDatabase(ORGANISATION);

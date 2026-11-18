import type { SingleDatabase } from "../src/database-handles";
import { describe, expect, it } from "vitest";

import {
  applyAgentOperation,
  readAgentOperations,
} from "../src/data/agent-operations";
import {
  confirmOperatorConfigurationDraft,
  createOperatorConfigurationDraft,
} from "../src/data/operator-configuration-draft";
import { previewCode } from "../src/slack/configuration-presentation";
import {
  installMerchantAgent,
  merchantAgentAgentId,
  merchantAgentDefaultSkills,
  merchantAgentInstallationId,
} from "../src/data/merchant-agent-preset";
import {
  createAgentOperationsDatabase,
  proposalFixtureAuthority,
} from "./agent-operations-database";
import { requireOrganisationId } from "./test-ids";

const ORGANISATION = requireOrganisationId("organisation_boundary");
const OTHER_ORGANISATION = requireOrganisationId("organisation_boundary_other");
const OWNER = "user_fbe449f6-7995-538c-a3a8-81b0623a641e";
const NOW = 1_000;

describe("Urk release boundaries", () => {
  it("produces the same result whether a change arrives from the Portal or Slack", async () => {
    // The Portal applies its parsed command directly; Slack stores a draft and
    // applies it on confirmation. Both must land the same state.
    const command = {
      kind: "configure_installation_governance" as const,
      installationId: merchantAgentInstallationId(ORGANISATION),
      maxSessionBudgetTokens: 30_000,
    };

    const portalDb = await installedDatabase();
    const portal = await applyAgentOperation(portalDb, ORGANISATION, {
      ...command,
      operationId: "mutation_shared",
      actorUserId: OWNER,
      now: NOW,
    });
    if (!portal.ok) throw new Error(`portal path failed: ${portal.error.code}`);

    const slackDb = await installedDatabase();
    const draft = await createOperatorConfigurationDraft({
      ...(await proposalFixtureAuthority(slackDb, ORGANISATION)),
      draftId: "draft_shared",
      caseId: "case_shared",
      actorUserId: OWNER,
      actorPersonId: "person_owner",
      rawCommand: command,
      mutationId: "mutation_shared",
      now: NOW,
      expiresAt: NOW + 60_000,
    });
    if (!draft.ok)
      throw new Error(`slack draft failed: ${JSON.stringify(draft.error)}`);
    const confirmed = await confirmOperatorConfigurationDraft({
      db: slackDb,
      env: { DB: slackDb, SATYR_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({ databaseBinding: "DB", kind: "affinity", placementCellId: "test", locationHint: "wnam" }) } as unknown as import("../src/env").Env,
      organisationId: ORGANISATION,
      draftId: draft.value.draftId,
      actorUserId: OWNER,
      actorRole: "owner",
      previewCode: previewCode(draft.value.commandDigest),
      now: NOW,
    });
    if (!confirmed.ok)
      throw new Error(`slack path failed: ${JSON.stringify(confirmed.error)}`);

    expect(confirmed.value.snapshot.governance).toEqual(
      portal.value.governance,
    );
    expect(confirmed.value.snapshot.installations).toEqual(
      portal.value.installations,
    );
  });

  it("refuses a Slack confirmation from someone who is not the requester", async () => {
    const db = await installedDatabase();
    const draft = await createOperatorConfigurationDraft({
      ...(await proposalFixtureAuthority(db, ORGANISATION)),
      draftId: "draft_unauthorized",
      caseId: "case_unauthorized",
      actorUserId: OWNER,
      actorPersonId: "person_owner",
      rawCommand: {
        kind: "configure_installation_governance",
        installationId: merchantAgentInstallationId(ORGANISATION),
        maxSessionBudgetTokens: 90_000,
      },
      mutationId: "mutation_unauthorized",
      now: NOW,
      expiresAt: NOW + 60_000,
    });
    if (!draft.ok) throw new Error("draft creation failed");

    expect(
      await confirmOperatorConfigurationDraft({
        db,
        organisationId: ORGANISATION,
        draftId: draft.value.draftId,
        actorUserId: "user_f69e70b8-b1da-5135-80f3-5c87cbbf37b0",
        env: { DB: db, SATYR_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({ databaseBinding: "DB", kind: "affinity", placementCellId: "test", locationHint: "wnam" }) } as unknown as import("../src/env").Env,
        actorRole: "owner",
        previewCode: previewCode(draft.value.commandDigest),
        now: NOW,
      }),
    ).toEqual({ ok: false, error: { code: "operator_draft_actor_mismatch" } });

    // The refusal left nothing behind.
    expect((await readAgentOperations(db, ORGANISATION)).governance).toEqual([]);
  });

  it("keeps an installed Urk to the access it was granted", async () => {
    const db = await installedDatabase();
    const snapshot = await readAgentOperations(db, ORGANISATION);
    const installation = snapshot.installations[0];
    expect(installation?.grantedCapabilities).toEqual([
      "commerce.entity_plane.context",
    ]);

    // A version asking for more cannot be activated onto that installation.
    await applyAgentOperation(db, ORGANISATION, {
      kind: "publish_agent_definition_revision",
      agentDefinitionId: merchantAgentAgentId(ORGANISATION),
      expectedRevision: 1,
      instructions: "Also propose commerce actions.",
      requestedCapabilities: [
        "commerce.entity_plane.context",
        "commerce.action.propose",
      ],
      skillRefs: snapshot.definitions[0]?.currentRevision.skillRefs ?? [],
      operationId: "agent_urk_widened",
      actorUserId: OWNER,
      now: NOW,
    });
    const widened = await applyAgentOperation(db, ORGANISATION, {
      kind: "activate_agent_definition_revision",
      installationId: merchantAgentInstallationId(ORGANISATION),
      expectedDefinitionRevision: 1,
      definitionRevision: 2,
      skillRefs: snapshot.definitions[0]?.currentRevision.skillRefs ?? [],
      operationId: "activation_widened",
      actorUserId: OWNER,
      now: NOW,
    });
    expect(widened).toEqual({
      ok: false,
      error: { code: "agent_operation_invalid", field: "grantedCapabilities" },
    });
    expect(
      (await readAgentOperations(db, ORGANISATION)).installations[0]
        ?.definitionRevision,
    ).toBe(1);
  });
});

async function installedDatabase(): Promise<SingleDatabase> {
  const db = createAgentOperationsDatabase(ORGANISATION);
  db.prepare(
    `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Other', 'beta', 1, 'active')`,
  )
    .bind(OTHER_ORGANISATION)
    .run();
  const installed = await installMerchantAgent({
    db,
    organisationId: ORGANISATION,
    actorUserId: OWNER,
    policyRevision: 1,
    skills: merchantAgentDefaultSkills(),
    now: 100,
  });
  if (!installed.ok)
    throw new Error(`Urk install failed: ${installed.error.code}`);
  return db;
}

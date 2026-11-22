import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, vi, type TestContext } from "vitest";
import { assertNever } from "@purin-labs/std";
import { CommerceEntityPlaneClient } from "@purin-labs/commerce-client";
import {
  type OrganisationId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import { parseVaultHandle } from "../../src/credential-vault";
import {
  issueControlSession,
  type IssuedControlSession,
} from "@purin-labs/tenancy/data/control-plane";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import {
  newControlMutationIdentity,
  readControlMutationReplay,
  type ControlMutationIdentity,
} from "@purin-labs/tenancy/data/control-mutation";
import { CAPABILITY_KEYS } from "../../src/authorization/capability-catalogue";
import {
  applyVersionedAccessDefaults,
  changeVersionedCapabilityPolicy,
} from "../../src/access-control/capability-mutations";
import {
  parseSetupSelection,
  selectSetupTemplates,
} from "../../src/data/onboarding";
import { publishCommerceExportPreset } from "../../src/data/export-preset";
import {
  assignWhatsAppSupportAgent,
  ensureWhatsAppSupportContextGrant,
  registerWhatsAppPhoneNumberAccount,
} from "../../src/data/whatsapp";
import {
  parseE164PhoneNumber,
  parseMetaBusinessPortfolioId,
  parseWhatsAppBusinessAccountId,
  parseWhatsAppPhoneNumberId,
} from "../../src/whatsapp/identifiers";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import { resumeActorRelocation } from "../../src/actors/actor-relocation";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  interceptPlacementSession,
  freezePlacement,
  completeRetainedPlacement,
  type PlacementRace,
} from "./placement-race-support";
import { connectCommerceFixture } from "./commerce-support";
import {
  installSlackActorFixture,
  ORGANISATION_ID,
  CHANNEL_ID,
  WORKSPACE_ID,
} from "./slack-journey-support";

type Operation = "capability" | "defaults" | "setup" | "export" | "whatsapp";
type GrantWriterRequest = {
  operation: Operation;
  scope: OrganisationExecutionScope;
  userId: UserId;
  revision: number;
  configurationVersion: number;
  capabilityRevision: number;
  whatsappAccountId: IntegrationAccountId;
  merchantId: string;
  identity: ControlMutationIdentity;
};

it(
  "fences capability, baseline, onboarding, export and WhatsApp grants across relocation and atomic receipt failures",
  grantWritersJourney,
  100_000,
);

async function grantWritersJourney({ task }: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const userId = required(
    parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab"),
  );
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .run();
  const session = await issueControlSession({
    db: env.DB,
    userId,
    now: Date.now(),
    ttlMs: 1_800_000,
  });
  await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const merchantId = `merchant_bakery_c3_p55_grants_${crypto.randomUUID()}`;
  await connectCommerceFixture(ORGANISATION_ID, userId, merchantId);
  const whatsappAccountId = await whatsappAccount(userId);
  await seedSlackChannel(fixture.selectedIntegrationAccountId);
  const evidence = [];
  for (const operation of [
    "capability",
    "defaults",
    "setup",
    "export",
    "whatsapp",
  ] satisfies Operation[]) {
    if (operation === "defaults") {
      await fixtureDatabase().batch([
        fixtureDatabase()
          .prepare(
            "DELETE FROM access_grant WHERE organisation_id = ? AND grant_id = 'grant_baseline_owner_context_case_read'",
          )
          .bind(ORGANISATION_ID),
        fixtureDatabase()
          .prepare(
            "UPDATE access_grant SET lifecycle = 'revoked', revision = 2, reason = 'owner revoked', changed_at = ? WHERE organisation_id = ? AND grant_id = 'grant_baseline_admin_context_case_read'",
          )
          .bind(Date.now(), ORGANISATION_ID),
      ]);
    }
    const request = await writerRequest(
      operation,
      userId,
      whatsappAccountId,
      merchantId,
    );
    const before = await grantRows(ORGANISATION_ID);
    const race: PlacementRace = {
      organisationId: ORGANISATION_ID,
      phase: { kind: "waiting" },
    };
    const withSession = fixtureDatabase().withSession.bind(fixtureDatabase());
    const intercepted = vi
      .spyOn(fixtureDatabase(), "withSession")
      .mockImplementation(
        interceptPlacementSession.bind(null, race, withSession),
      );
    try {
      expect(await invokeWriter(request)).toMatchObject({
        ok: false,
        error: { code: "organisation_placement_conflict" },
      });
      expect(race.phase.kind).toBe("frozen");
      expect(await grantRows(ORGANISATION_ID)).toEqual(before);
    } finally {
      intercepted.mockRestore();
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS lifecycle_interrupt_publication",
      ).run();
    }
    if (race.phase.kind !== "frozen")
      throw new Error("Writer never reached its commit race");
    const relocationId = race.phase.relocationId;
    await completeRetainedPlacement(relocationId);
    expect(await invokeWriter(request)).toMatchObject({
      ok: false,
      error: { code: "organisation_placement_conflict" },
    });
    expect(await grantRows(ORGANISATION_ID)).toEqual(before);
    const fresh = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
    if (operation === "capability" || operation === "export") {
      await fixtureDatabase()
        .prepare(
          `CREATE TRIGGER grant_writer_fail_audit BEFORE INSERT ON onboarding_audit_event
        WHEN NEW.organisation_id = '${ORGANISATION_ID}' BEGIN SELECT RAISE(ABORT, 'grant_writer_audit_failed'); END`,
        )
        .run();
      try {
        expect(await invokeWriter({ ...request, scope: fresh })).toMatchObject({
          ok: false,
        });
        expect(await grantRows(ORGANISATION_ID)).toEqual(before);
      } finally {
        await fixtureDatabase()
          .prepare("DROP TRIGGER grant_writer_fail_audit")
          .run();
      }
    }
    if (operation === "capability" || operation === "defaults") {
      const response = await writerHttp(session, request);
      expect(response.status, await response.clone().text()).toBe(200);
      const accepted: unknown = await response.json();
      const replay = await writerHttp(session, request);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(accepted);
    } else {
      expect(await invokeWriter({ ...request, scope: fresh })).toMatchObject({
        ok: true,
      });
      if (operation !== "whatsapp") {
        const replay = await readControlMutationReplay({
          db: fixtureDatabase(),
          scope: mutationScope(request),
          boundary: versionedBoundary(request),
        });
        expect(replay).toMatchObject({
          kind: "replay",
          receipt: { responseStatus: 200 },
        });
      }
    }
    if (operation === "defaults") {
      expect(
        await fixtureDatabase()
          .prepare(
            "SELECT lifecycle FROM access_grant WHERE organisation_id = ? AND grant_id = 'grant_baseline_admin_context_case_read'",
          )
          .bind(ORGANISATION_ID)
          .first("lifecycle"),
      ).toBe("revoked");
      const complete = await writerRequest(
        "defaults",
        userId,
        whatsappAccountId,
        merchantId,
      );
      const result = await invokeWriter(complete);
      expect(result).toMatchObject({
        ok: true,
        value: { changed: false, projectionRevision: complete.revision },
      });
    }
    if (operation === "export") {
      const accepted = await grantRows(ORGANISATION_ID);
      const repeated = await writerRequest(
        "export",
        userId,
        whatsappAccountId,
        merchantId,
      );
      expect(await invokeWriter(repeated)).toMatchObject({ ok: true });
      const replay = await readControlMutationReplay({
        db: fixtureDatabase(),
        scope: mutationScope(repeated),
        boundary: versionedBoundary(repeated),
      });
      expect(replay).toMatchObject({ kind: "replay" });
      const after = await grantRows(ORGANISATION_ID);
      const { receipts: previousReceipts, ...previousRows } = accepted;
      const { receipts: currentReceipts, ...currentRows } = after;
      expect(currentRows).toEqual(previousRows);
      expect(currentReceipts).toHaveLength(previousReceipts.length + 1);
    }
    evidence.push({
      operation,
      relocationId,
      frozenCommit: "no writes or receipt",
      retiredScope: "rejected",
      freshScope: "committed",
      auditRollback: operation === "capability" || operation === "export",
    });
  }
  const repair = await writerRequest(
    "whatsapp",
    userId,
    whatsappAccountId,
    merchantId,
  );
  const binding = await fixtureDatabase()
    .prepare(
      "SELECT support_binding_id AS id, current_revision AS revision FROM whatsapp_support_binding WHERE organisation_id = ? AND integration_account_id = ?",
    )
    .bind(ORGANISATION_ID, whatsappAccountId)
    .first<{ id: string; revision: number }>();
  if (binding === null) throw new Error("Missing accepted WhatsApp binding");
  const grantId = `grant_whatsapp_support:${binding.id}:${binding.revision}_context_case_read`;
  await fixtureDatabase()
    .prepare(
      "DELETE FROM access_grant WHERE organisation_id = ? AND grant_id = ?",
    )
    .bind(ORGANISATION_ID, grantId)
    .run();
  const repairBefore = await grantRows(ORGANISATION_ID);
  const repairRace: PlacementRace = {
    organisationId: ORGANISATION_ID,
    phase: { kind: "waiting" },
  };
  const paused = vi
    .spyOn(Object.getPrototypeOf(repair.scope), "isActive")
    .mockImplementationOnce(
      freezeActiveCheck.bind(null, repair.scope, repairRace),
    );
  try {
    expect(
      await ensureWhatsAppSupportContextGrant({
        scope: repair.scope,
        integrationAccountId: whatsappAccountId,
        supportBindingId: binding.id,
        bindingRevision: binding.revision,
        now: Date.now(),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "organisation_placement_conflict" },
    });
  } finally {
    paused.mockRestore();
    await env.DB.prepare(
      "DROP TRIGGER IF EXISTS lifecycle_interrupt_publication",
    ).run();
  }
  expect(await grantRows(ORGANISATION_ID)).toEqual(repairBefore);
  if (repairRace.phase.kind !== "frozen")
    throw new Error("Repair did not freeze");
  expect(
    await resumeActorRelocation({
      env,
      relocationId: repairRace.phase.relocationId,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true });
  expect(
    await ensureWhatsAppSupportContextGrant({
      scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
      integrationAccountId: whatsappAccountId,
      supportBindingId: binding.id,
      bindingRevision: binding.revision,
      now: Date.now(),
    }),
  ).toEqual({ ok: true, value: null });
  expect(
    (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
  ).toEqual([]);
  Object.assign(task.meta, {
    grantWritersPlacement: {
      writers: evidence,
      defaults:
        "revocation preserved; complete baseline does not advance revision",
      whatsappRepair:
        "frozen insert refused; current binding repaired after relocation",
      foreignKeyViolations: 0,
    },
  });
}

async function writerRequest(
  operation: Operation,
  userId: UserId,
  whatsappAccountId: IntegrationAccountId,
  merchantId: string,
): Promise<GrantWriterRequest> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT configuration_version AS version, projection_revision AS revision FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first<{ version: number; revision: number }>();
  const policy = await fixtureDatabase()
    .prepare(
      "SELECT revision FROM organisation_capability_policy WHERE organisation_id = ? AND capability_id = ?",
    )
    .bind(ORGANISATION_ID, CAPABILITY_KEYS.fileRead)
    .first<number>("revision");
  if (row === null || policy === null)
    throw new Error("Missing mutation state");
  return {
    operation,
    scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    userId,
    revision: row.revision,
    configurationVersion: row.version,
    capabilityRevision: policy,
    whatsappAccountId,
    merchantId,
    identity: newControlMutationIdentity({
      portalSubjectHash: "grant-writer-owner",
      causationId: `p55-${operation}-${row.revision}`,
      now: Date.now(),
    }),
  };
}

function invokeWriter(request: GrantWriterRequest) {
  switch (request.operation) {
    case "capability":
      return changeVersionedCapabilityPolicy({
        scope: request.scope,
        actorUserId: request.userId,
        identity: request.identity,
        boundary: unversionedBoundary(request),
        expectedProjectionRevision: request.revision,
        expectedCapabilityRevision: request.capabilityRevision,
        capabilityId: CAPABILITY_KEYS.fileRead,
        capabilityVersion: 1,
        mode: "disabled",
      });
    case "defaults":
      return applyVersionedAccessDefaults({
        scope: request.scope,
        actorUserId: request.userId,
        identity: request.identity,
        boundary: unversionedBoundary(request),
        expectedProjectionRevision: request.revision,
      });
    case "setup":
      return selectSetupTemplates({
        scope: request.scope,
        selectedByUserId: request.userId,
        selection: setupSelection(),
        mutation: {
          scope: mutationScope(request),
          boundary: versionedBoundary(request),
          identity: request.identity,
        },
        now: request.identity.createdAt,
      });
    case "export":
      return publishCommerceExportPreset({
        scope: request.scope,
        environment: "development",
        merchantId: request.merchantId,
        request: { presetId: "export_coordination", version: 1 },
        expectedConfigurationVersion: request.configurationVersion,
        controlMutation: {
          scope: mutationScope(request),
          boundary: versionedBoundary(request),
          identity: request.identity,
        },
        client: new CommerceEntityPlaneClient({
          baseUrl: "http://commerce.test",
          serviceToken: "commerce-e2e-token",
          fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
        }),
      });
    case "whatsapp":
      return assignWhatsAppSupportAgent({
        scope: request.scope,
        integrationAccountId: request.whatsappAccountId,
        supportBindingId: "whatsapp_p55_grants",
        installationId: "installation_export_coordination_v1",
        grantsDigest: "a".repeat(64),
        policyDigest: "b".repeat(64),
        createdBy: request.userId,
        now: request.identity.createdAt,
      });
    default:
      return assertNever(request.operation);
  }
}

function unversionedBoundary(request: GrantWriterRequest) {
  return {
    kind: "unversioned" as const,
    idempotencyKey: `p55-${request.operation}-${request.revision}`,
    requestHash: "p55-grant-writer-request",
  };
}
function versionedBoundary(request: GrantWriterRequest) {
  return {
    kind: "configuration_versioned" as const,
    idempotencyKey: `p55-${request.operation}-${request.revision}`,
    requestHash: "p55-grant-writer-request",
    expectedConfigurationVersion: request.configurationVersion,
  };
}
function mutationScope(request: GrantWriterRequest) {
  const route =
    request.operation === "setup" ? "setup" : "commerce/export-preset";
  return {
    userId: request.userId,
    organisationScope: ORGANISATION_ID,
    route: `/v1/control/organisations/${ORGANISATION_ID}/${route}`,
    operation:
      request.operation === "setup"
        ? "setup.save"
        : "commerce_export_preset.publish",
  };
}
function setupSelection() {
  return required(
    parseSetupSelection({
      policyTemplateId: "commerce_operator",
      capabilityProfile: "read_and_propose",
      cuePresetId: "observe_commerce",
      cueTarget: { workspaceId: WORKSPACE_ID, channelId: CHANNEL_ID },
    }),
  );
}
function writerHttp(
  session: IssuedControlSession,
  request: GrantWriterRequest,
) {
  const body =
    request.operation === "capability"
      ? {
          expectedRevision: request.revision,
          capabilityRevision: request.capabilityRevision,
          capabilityVersion: 1,
          mode: "disabled",
        }
      : { expectedRevision: request.revision };
  const route =
    request.operation === "capability"
      ? `capabilities/${CAPABILITY_KEYS.fileRead}`
      : "defaults/apply";
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/access-control/${route}`,
    {
      method: "POST",
      headers: {
        cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
        origin: "https://localhost",
        "content-type": "application/json",
        "x-pantry-csrf": session.csrfToken,
        "idempotency-key": `p55-${request.operation}-${request.revision}`,
      },
      body: JSON.stringify(body),
    },
  );
}
async function freezeActiveCheck(
  scope: OrganisationExecutionScope,
  race: PlacementRace,
): Promise<boolean> {
  const result = await scope.database
    .prepare(
      "SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND status = 'active'",
    )
    .bind(scope.organisationId)
    .first();
  expect(result).not.toBeNull();
  await freezePlacement(race);
  return true;
}
async function grantRows(organisationId: OrganisationId) {
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const table of [
    "organisation_onboarding",
    "organisation_capability_policy",
    "access_grant",
    "onboarding_audit_event",
    "onboarding_event",
    "organisation_setup_snapshot",
    "organisation_onboarding_selection",
    "organisation_communication_destination",
    "organisation_slack_channel",
    "commerce_export_preset_publication",
    "operational_area",
    "skill",
    "skill_revision",
    "skill_binding",
    "agent_definition",
    "agent_definition_revision",
    "agent_installation",
    "agent_installation_governance",
    "cue_binding",
    "agent_responsibility_scope",
    "escalation_policy",
    "whatsapp_support_binding",
    "whatsapp_support_binding_revision",
  ]) {
    rows[table] = (
      await fixtureDatabase()
        .prepare(
          `SELECT * FROM ${table} WHERE organisation_id = ? ORDER BY rowid`,
        )
        .bind(organisationId)
        .all()
    ).results;
  }
  const receipts = (
    await fixtureDatabase()
      .prepare(
        "SELECT * FROM control_mutation_receipt WHERE organisation_scope = ? ORDER BY rowid",
      )
      .bind(organisationId)
      .all()
  ).results;
  return { tables: rows, receipts };
}
async function seedSlackChannel(accountId: string) {
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO provider_resource_snapshot (snapshot_revision, organisation_id, integration_account_id, provider, environment, query_hash, created_at) VALUES ('p55_channel', ?, ?, 'slack', 'development', 'p55_channel_query', ?)",
      )
      .bind(ORGANISATION_ID, accountId, Date.now()),
    fixtureDatabase()
      .prepare(
        "INSERT INTO provider_discovered_resource (snapshot_revision, canonical_resource_id, provider_resource_id, provider_account_id, display_label, access_state, provider_revision, resource_kind) VALUES ('p55_channel', ?, ?, ?, 'Bakery', 'accessible', 'p55_channel_revision', 'channel')",
      )
      .bind(CHANNEL_ID, CHANNEL_ID, WORKSPACE_ID),
  ]);
}
async function whatsappAccount(userId: UserId): Promise<IntegrationAccountId> {
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId: ORGANISATION_ID,
    provider: "whatsapp",
    providerSubjectId: "310000000000001",
    environment: "development",
    authMode: "shared_pantry_app",
    authority: {
      kind: "connection_credential",
      credentialRef: required(parseVaultHandle("vault:whatsapp:p55-grants")),
    },
    grantedScopes: ["whatsapp_business_messaging"],
    createdByUserId: userId,
    providerAccountId: "510000000000001",
    accountKind: "phone_number",
    displayName: "Grant bakery",
    capabilities: ["whatsapp.support.ingress"],
    audiencePolicy: { kind: "customer", consentRequired: true },
    retentionPolicy: { kind: "organisation_default" },
    now: Date.now(),
  });
  const registered = await registerWhatsAppPhoneNumberAccount({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    integrationAccountId: connected.account.integrationAccountId,
    providerConnectionId: connected.connection.providerConnectionId,
    environment: "development",
    businessPortfolioId: required(
      parseMetaBusinessPortfolioId("310000000000001"),
    ),
    wabaId: required(parseWhatsAppBusinessAccountId("410000000000001")),
    phoneNumberId: required(parseWhatsAppPhoneNumberId("510000000000001")),
    displayPhoneNumber: required(parseE164PhoneNumber("+819012345678")),
    verifiedName: "Grant bakery",
    now: Date.now(),
  });
  if (!registered.ok) throw new Error(registered.error.code);
  return connected.account.integrationAccountId;
}
function required<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

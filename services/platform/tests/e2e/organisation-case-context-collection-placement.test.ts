import type {
  OrganisationDatabase,
  OrganisationStatement,
} from "../../src/database-handles";
import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import {
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { assertNever, encodeBase64Url } from "@seams/std";
import { http, HttpResponse } from "msw";
import { network } from "./network";
import { expect, it, vi, type TestContext } from "vitest";
import {
  requireActiveOrganisationActor,
  resolveActiveConnectorActor,
} from "../../src/actors/actor-router";
import type { ConnectorDO } from "../../src/actors/connector";
import {
  activateEmailRuntime,
  recordEmailCaseContextDiscovery,
} from "../../src/actors/connector-email";
import type { OrganisationDO } from "../../src/actors/organisation";
import {
  startActorRelocation,
  resumeActorRelocation,
  type ActorRelocationId,
} from "../../src/actors/actor-relocation";
import { parseOrganisationPlacementMoveTarget } from "../../src/data/organisation-placement";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import { publishContactVerification } from "../../src/data/contact-verification";
import { registerOperationalEmailContact } from "../../src/data/email-operational";
import {
  registerEmailMailboxAccount,
  assignAgentMailbox,
  publishMailboxIngressPolicy,
  recordEmailMessageReceipt,
  bindEmailMessageReceiptContact,
  gmailConnectorId,
} from "../../src/data/email-mailbox";
import {
  applyAgentOperation,
  type AgentOperationCommand,
} from "../../src/data/agent-operations";
import {
  parseVaultHandle,
  storeVaultSecret,
  revokeVaultSecret,
} from "../../src/credential-vault";
import {
  parseUserId,
  parseCaseId,
  type IntegrationAccountId,
} from "../../src/ids";
import { GMAIL_FULL_MAILBOX_SCOPES } from "../../src/mail/gmail-authorization";
import { CAPABILITY_KEYS } from "../../src/authorization/capability-catalogue";
import type { OperationalCaseContextDiscoverySourceRequest } from "../../src/case-context-discovery/operational-evaluation";
import { readDailyTypeSafeUsage } from "../../src/integrations/typesafe/usage-store";
import { parseCaseContextDiscoveryPolicy } from "../../src/case-context-discovery/policy";
import { readTypeSafeConnection } from "../../src/integrations/typesafe/connection";
import {
  readCaseContextDiscoveryPolicy,
  publishCaseContextDiscoveryPolicy,
} from "../../src/case-context-discovery/evaluation-store";
import {
  recordCaseContextCollectionSuggestion,
  decideCaseContextCollectionRelationship,
  readCaseContextCollection,
  type CaseContextCollectionScope,
  type CaseContextCollectionSelection,
} from "../../src/case-context-discovery/relationships";
import type {
  CaseContextCollectionEffectAttempt,
  CaseContextCollectionEvidence,
  CaseContextCollectionEvidenceDependency,
} from "../../src/case-context-discovery/evidence";
import {
  installSlackActorFixture,
  ORGANISATION_ID,
} from "./slack-journey-support";
import { seedPurchasingContext } from "./mail-purchasing-support";

type ConfigurationBoundary =
  | "read"
  | "credential"
  | "probe"
  | "store"
  | "publish"
  | "source_access"
  | "disconnect";
type ConfigurationPause = {
  readonly boundary: ConfigurationBoundary;
  phase: "armed" | "paused" | "released";
  readonly digest: SubtleCrypto["digest"];
  readonly decrypt: SubtleCrypto["decrypt"];
  readonly encrypt: SubtleCrypto["encrypt"];
  probeCalls: number;
};
let configurationPause: ConfigurationPause | null = null;

it.for([
  "read",
  "credential",
  "probe",
  "store",
  "publish",
  "source_access",
  "disconnect",
] as const)(
  "drains TypeSafe configuration %s across relocation and target eviction",
  { timeout: 100_000 },
  configurationJourney,
);
it(
  "recovers TypeSafe credential cleanup after failure, eviction and blocked relocation",
  { timeout: 100_000 },
  configurationCleanupJourney,
);

async function configurationJourney(
  boundary: ConfigurationBoundary,
  { task }: TestContext,
): Promise<void> {
  const fixture = await installFixture();
  const before = await runInDurableObject(
    fixture.organisation,
    configurationState,
  );
  const pause = installConfigurationPause(boundary);
  const prepare = fixtureDatabase().prepare.bind(fixtureDatabase());
  const interception =
    boundary === "disconnect"
      ? vi
          .spyOn(fixtureDatabase(), "prepare")
          .mockImplementation(configurationStatement.bind(null, pause, prepare))
      : null;
  const work = startConfigurationWork(fixture, boundary);
  let completion: Promise<unknown> | null = null;
  try {
    await expect
      .poll(configurationPhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    const relocationId = await startMove("e2e");
    completion = resumeActorRelocation({ env, relocationId, now: Date.now() });
    await expect.poll(readBarrier.bind(null, fixture.organisation)).toBe(1);
    expect(await exportedItems(relocationId)).toBe(0);
    pause.phase = "released";
    expect(await work).toMatchObject({
      ok: false,
      error: { code: "organisation_placement_conflict" },
    });
    expect(await completion).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    interception?.mockRestore();
    const source = await runInDurableObject(
      fixture.organisation,
      configurationState,
    );
    expect(source.cleanup).toBe(0);
    if (boundary === "disconnect") {
      expect(source.connection).toEqual({ kind: "disconnected", revision: 2 });
      // Plan 88: a disconnect moves the policy to Pantry's key; it stays on.
      expect(source.policy.policy).toMatchObject({
        mode: "party_context",
        route: { funding: "satyr_platform" },
      });
    } else {
      expect(source.connection).toEqual(before.connection);
      expect(source.policy).toEqual(before.policy);
    }
    const vault = await configurationVaultState();
    expect(vault).toEqual({
      total: 1,
      active: boundary === "disconnect" ? 0 : 1,
    });
    await evictDurableObject(fixture.organisation);
    for (const result of await Promise.all([
      fixture.organisation.readTypeSafeConnectionConfiguration({
        organisationId: ORGANISATION_ID,
      }),
      fixture.organisation.readCaseContextDiscoveryConfiguration({
        organisationId: ORGANISATION_ID,
      }),
      fixture.organisation.manageTypeSafeConnection({
        organisationId: ORGANISATION_ID,
        actorId: "operator_typesafe",
        body: {
          operation: "disconnect",
          expectedRevision: source.connection.revision,
        },
      }),
      fixture.organisation.publishCaseContextDiscoveryConfiguration(
        configurationPolicyRequest(fixture),
      ),
    ]))
      expect(result).toMatchObject({
        ok: false,
        error: { code: "organisation_placement_conflict" },
      });
    const target = await requireActiveOrganisationActor({
      env,
      organisationId: ORGANISATION_ID,
      now: Date.now(),
    });
    expect(await runInDurableObject(target, configurationState)).toEqual(
      source,
    );
    await evictDurableObject(target);
    expect(
      required(
        await target.readTypeSafeConnectionConfiguration({
          organisationId: ORGANISATION_ID,
        }),
      ).connection,
    ).toEqual(source.connection);
    pause.phase = "released";
    if (boundary === "publish" || boundary === "source_access") {
      const published = required(
        await target.publishCaseContextDiscoveryConfiguration(
          configurationPolicyRequest(fixture),
        ),
      );
      await evictDurableObject(target);
      expect(
        required(
          await target.publishCaseContextDiscoveryConfiguration(
            configurationPolicyRequest(fixture),
          ),
        ),
      ).toEqual(published);
      expect(
        (await runInDurableObject(target, configurationState)).policy.revision,
      ).toBe(2);
    } else if (boundary === "disconnect") {
      expect(
        required(
          await target.readTypeSafeConnectionConfiguration({
            organisationId: ORGANISATION_ID,
          }),
        ).credentialConfigured,
      ).toBe(false);
    } else if (boundary !== "read") {
      await runInDurableObject(target, resetConfigurationProbe);
      const tested = required(
        await target.manageTypeSafeConnection({
          organisationId: ORGANISATION_ID,
          actorId: "operator_typesafe",
          body: { operation: "test", expectedRevision: 1 },
        }),
      );
      expect(tested).toMatchObject({ kind: "connected", revision: 1 });
    }
    const final = await runInDurableObject(target, configurationState);
    expect(final.cleanup).toBe(0);
    expect(JSON.stringify(final)).not.toContain(KEY);
    expect(pause.probeCalls).toBe(configurationExpectedProbes(boundary));
    Object.assign(task.meta, {
      typeSafeConfigurationPlacement: {
        boundary,
        zeroExportsWhilePaused: true,
        frozenOutput: "withheld",
        source,
        final,
        vault,
        retiredSource: "denied",
        targetEviction: true,
        probeCalls: pause.probeCalls,
      },
    });
  } finally {
    pause.phase = "released";
    interception?.mockRestore();
    restoreConfigurationPause(pause);
    await Promise.allSettled(completion === null ? [work] : [work, completion]);
  }
}

async function configurationCleanupJourney({
  task,
}: TestContext): Promise<void> {
  const fixture = await installFixture();
  const pause = installConfigurationPause("read");
  pause.phase = "released";
  await fixtureDatabase()
    .prepare(
      "CREATE TRIGGER p55_typesafe_cleanup_failure BEFORE UPDATE OF revoked_at ON vault_secret WHEN OLD.vault_handle LIKE '%:typesafe:p55' BEGIN SELECT RAISE(ABORT, 'typesafe_cleanup_failed'); END",
    )
    .run();
  try {
    await expect(
      fixture.organisation.manageTypeSafeConnection({
        organisationId: ORGANISATION_ID,
        actorId: "operator_typesafe",
        body: {
          operation: "connect",
          expectedRevision: 1,
          provider: "typesafe",
          apiKey: KEY,
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "typesafe_credential_cleanup_failed" },
    });
    const pending = await runInDurableObject(
      fixture.organisation,
      configurationState,
    );
    expect(pending.connection).toMatchObject({
      kind: "connected",
      revision: 2,
    });
    // Plan 88: a key change re-pins the policy to the new key; it stays on.
    expect(pending.policy.policy).toMatchObject({
      mode: "party_context",
      route: { funding: "organisation_byo", connectionRevision: 2 },
    });
    expect(pending.cleanup).toBe(1);
    expect(await configurationVaultState()).toEqual({ total: 2, active: 2 });
    await evictDurableObject(fixture.organisation);
    const relocationId = await startMove("e2e");
    const blocked = await resumeActorRelocation({
      env,
      relocationId,
      now: Date.now(),
    });
    expect(blocked).toMatchObject({
      ok: false,
      error: { code: "actor_cleanup_failed" },
    });
    expect(await exportedItems(relocationId)).toBe(0);
    expect(
      (await runInDurableObject(fixture.organisation, configurationState))
        .cleanup,
    ).toBe(1);
    await evictDurableObject(fixture.organisation);
    await fixtureDatabase()
      .prepare("DROP TRIGGER p55_typesafe_cleanup_failure")
      .run();
    expect(
      await resumeActorRelocation({ env, relocationId, now: Date.now() }),
    ).toMatchObject({ ok: true, value: { status: "retained" } });
    const target = await requireActiveOrganisationActor({
      env,
      organisationId: ORGANISATION_ID,
      now: Date.now(),
    });
    const final = await runInDurableObject(target, configurationState);
    expect(final.cleanup).toBe(0);
    expect(final.connection).toEqual(pending.connection);
    expect(await configurationVaultState()).toEqual({ total: 2, active: 1 });
    await evictDurableObject(target);
    expect(
      required(
        await target.readTypeSafeConnectionConfiguration({
          organisationId: ORGANISATION_ID,
        }),
      ).credentialConfigured,
    ).toBe(true);
    await runInDurableObject(target, resetConfigurationProbe);
    expect(
      required(
        await target.manageTypeSafeConnection({
          organisationId: ORGANISATION_ID,
          actorId: "operator_typesafe",
          body: { operation: "test", expectedRevision: 2 },
        }),
      ),
    ).toMatchObject({ kind: "connected", revision: 2 });
    expect(await configurationVaultState()).toEqual({ total: 2, active: 1 });
    expect(pause.probeCalls).toBe(2);
    Object.assign(task.meta, {
      typeSafeCleanupRecovery: {
        durablePendingHandles: 1,
        zeroExportsOnFailure: true,
        recoveredAfterSourceEviction: true,
        retiredCredentialRevoked: true,
        targetCredentialPreserved: true,
        probeCalls: pause.probeCalls,
        final,
      },
    });
  } finally {
    restoreConfigurationPause(pause);
    await fixtureDatabase()
      .prepare("DROP TRIGGER IF EXISTS p55_typesafe_cleanup_failure")
      .run();
  }
}

function configurationExpectedProbes(boundary: ConfigurationBoundary): number {
  switch (boundary) {
    case "read":
    case "publish":
    case "source_access":
    case "disconnect":
      return 0;
    case "credential":
      return 1;
    case "probe":
    case "store":
      return 2;
    default:
      return assertNever(boundary);
  }
}

function startConfigurationWork(
  fixture: Fixture,
  boundary: ConfigurationBoundary,
) {
  switch (boundary) {
    case "read":
      return fixture.organisation.readTypeSafeConnectionConfiguration({
        organisationId: ORGANISATION_ID,
      });
    case "credential":
      return fixture.organisation.manageTypeSafeConnection({
        organisationId: ORGANISATION_ID,
        actorId: "operator_typesafe",
        body: { operation: "test", expectedRevision: 1 },
      });
    case "probe":
    case "store":
      return fixture.organisation.manageTypeSafeConnection({
        organisationId: ORGANISATION_ID,
        actorId: "operator_typesafe",
        body: {
          operation: "connect",
          expectedRevision: 1,
          provider: "typesafe",
          apiKey: KEY,
        },
      });
    case "publish":
    case "source_access":
      return fixture.organisation.publishCaseContextDiscoveryConfiguration(
        configurationPolicyRequest(fixture),
      );
    case "disconnect":
      return fixture.organisation.manageTypeSafeConnection({
        organisationId: ORGANISATION_ID,
        actorId: "operator_typesafe",
        body: { operation: "disconnect", expectedRevision: 1 },
      });
    default:
      return assertNever(boundary);
  }
}
function configurationPolicyRequest(fixture: Fixture) {
  return {
    organisationId: ORGANISATION_ID,
    actorId: "operator_typesafe",
    body: {
      commandId: "publish_typesafe_move",
      expectedRevision: 1,
      policy: {
        mode: "party_context",
        route: {
          provider: "typesafe",
          connectionRevision: 1,
          funding: "organisation_byo",
          credentialRef: "organisation_typesafe",
        },
        sources: [
          {
            source: "gmail",
            integrationAccountId: fixture.integrationAccountId,
          },
        ],
        limits: {
          maxEvaluations: 20,
          maxConcurrentEvaluations: 1,
          maxInputBytes: 122_880,
          maxInputTokens: 327_680,
          maxWallMs: 50_000,
          maxCostMicrousd: 50_000,
          reservationMicrousd: 10_000,
          requestTimeoutMs: 10_000,
        },
      },
    },
  };
}
function configurationState(_actor: unknown, state: DurableObjectState) {
  const cleanup = state.storage.sql
    .exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM typesafe_credential_cleanup",
    )
    .one().total;
  return {
    connection: readTypeSafeConnection(state.storage.sql, ORGANISATION_ID),
    policy: readCaseContextDiscoveryPolicy(state.storage.sql, ORGANISATION_ID),
    cleanup,
  };
}
async function configurationVaultState(): Promise<{
  total: number;
  active: number;
}> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END), 0) AS active FROM vault_secret WHERE organisation_id = ? AND vault_handle LIKE '%:typesafe:%'",
    )
    .bind(ORGANISATION_ID)
    .first<{ total: number; active: number }>();
  if (row === null) throw new Error("Missing TypeSafe credential state");
  return row;
}
function resetConfigurationProbe(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec("UPDATE typesafe_connection SET probe_at = 0");
}
function installConfigurationPause(
  boundary: ConfigurationBoundary,
): ConfigurationPause {
  const pause: ConfigurationPause = {
    boundary,
    phase: "armed",
    digest: crypto.subtle.digest,
    decrypt: crypto.subtle.decrypt,
    encrypt: crypto.subtle.encrypt,
    probeCalls: 0,
  };
  configurationPause = pause;
  crypto.subtle.digest = configurationDigest;
  crypto.subtle.decrypt = configurationDecrypt;
  crypto.subtle.encrypt = configurationEncrypt;
  network.use(
    http.post(
      "https://api.typesafe.ai/v1/systemone",
      configurationProbe.bind(null, pause),
    ),
  );
  return pause;
}
function restoreConfigurationPause(pause: ConfigurationPause): void {
  pause.phase = "released";
  crypto.subtle.digest = pause.digest;
  crypto.subtle.decrypt = pause.decrypt;
  crypto.subtle.encrypt = pause.encrypt;
  configurationPause = null;
}
function configurationPhase(
  pause: ConfigurationPause,
): ConfigurationPause["phase"] {
  return pause.phase;
}
async function waitConfigurationPause(
  pause: ConfigurationPause,
): Promise<void> {
  pause.phase = "paused";
  while (pause.phase === "paused") await scheduler.wait(5);
}
async function configurationDigest(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["digest"]>[0],
  data: Parameters<SubtleCrypto["digest"]>[1],
): Promise<ArrayBuffer> {
  const pause = configurationPause;
  if (pause === null) throw new Error("Missing configuration pause");
  const result = await pause.digest.call(this, algorithm, data);
  const text = new TextDecoder().decode(data);
  if (
    pause.phase === "armed" &&
    ((pause.boundary === "publish" &&
      text.includes('"actorId":"operator_typesafe"')) ||
      (pause.boundary === "source_access" &&
        text.includes('"kind":"agent_mailbox"')))
  )
    await waitConfigurationPause(pause);
  return result;
}
async function configurationDecrypt(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["decrypt"]>[0],
  key: Parameters<SubtleCrypto["decrypt"]>[1],
  data: Parameters<SubtleCrypto["decrypt"]>[2],
): Promise<ArrayBuffer> {
  const pause = configurationPause;
  if (pause === null) throw new Error("Missing configuration pause");
  const result = await pause.decrypt.call(this, algorithm, key, data);
  if (
    pause.phase === "armed" &&
    (pause.boundary === "read" || pause.boundary === "credential") &&
    new TextDecoder().decode(result).includes(KEY)
  )
    await waitConfigurationPause(pause);
  return result;
}
async function configurationEncrypt(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["encrypt"]>[0],
  key: Parameters<SubtleCrypto["encrypt"]>[1],
  data: Parameters<SubtleCrypto["encrypt"]>[2],
): Promise<ArrayBuffer> {
  const pause = configurationPause;
  if (pause === null) throw new Error("Missing configuration pause");
  const result = await pause.encrypt.call(this, algorithm, key, data);
  if (
    pause.phase === "armed" &&
    pause.boundary === "store" &&
    new TextDecoder().decode(data).includes(KEY)
  )
    await waitConfigurationPause(pause);
  return result;
}
async function configurationProbe(
  pause: ConfigurationPause,
  { request }: { request: { json(): Promise<unknown> } },
): Promise<Response> {
  const body = await request.json();
  expect(body).toMatchObject({
    state:
      "This is a synthetic connection test. The sample parcel is in transit.",
  });
  pause.probeCalls += 1;
  if (pause.boundary === "probe" && pause.phase === "armed")
    await waitConfigurationPause(pause);
  return HttpResponse.json({
    model: "jev-1.13.0",
    answers: { in_transit: { type: "noul", noul: 0.95 } },
    usage: { input_tokens: 1000, output_tokens: 20 },
  });
}
function configurationStatement(
  pause: ConfigurationPause,
  prepare: OrganisationDatabase["prepare"],
  query: string,
): OrganisationStatement {
  const statement = prepare(query);
  if (
    query.includes("UPDATE vault_secret") &&
    query.includes("SET revoked_at")
  ) {
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation(
      configurationBoundStatement.bind(null, pause, bind),
    );
  }
  return statement;
}
function configurationBoundStatement(
  pause: ConfigurationPause,
  bind: D1PreparedStatement["bind"],
  ...values: unknown[]
): D1PreparedStatement {
  const statement = bind(...values);
  const run = statement.run.bind(statement);
  vi.spyOn(statement, "run").mockImplementation(
    configurationRevocation.bind(null, pause, run),
  );
  return statement;
}
async function configurationRevocation<T>(
  pause: ConfigurationPause,
  run: D1PreparedStatement["run"],
): Promise<D1Result<T>> {
  const result = await run<T>();
  if (pause.phase === "armed") await waitConfigurationPause(pause);
  return result;
}

type DiscoveryBoundary =
  | "credential"
  | "request_digest"
  | "preparation"
  | "preflight"
  | "response"
  | "response_error"
  | "withdrawal"
  | "policy_withdrawal"
  | "relationships"
  | "gmail_anchor"
  | "gmail_candidate";
type DiscoveryPause = {
  boundary: DiscoveryBoundary;
  readonly comparison: "operational" | "synthetic";
  phase: "armed" | "paused" | "released";
  readonly digest: SubtleCrypto["digest"];
  readonly decrypt: SubtleCrypto["decrypt"];
  readonly scopeIsActive: OrganisationExecutionScope["isActive"];
  disclosurePrepared: boolean;
  preflightChecks: number;
  modelCalls: number;
  gmailReads: string[];
};
let discoveryPause: DiscoveryPause | null = null;

it.for([
  "credential",
  "preparation",
  "preflight",
  "response",
  "response_error",
  "withdrawal",
  "relationships",
] as const)(
  "drains operational CaseContextCollection %s and recovers issued usage after target eviction",
  { timeout: 100_000 },
  discoveryJourney,
);

it.for(["gmail_anchor", "gmail_candidate", "response"] as const)(
  "retains Connector CaseContextCollection work across frozen %s hydration and target eviction",
  { timeout: 100_000 },
  connectorDiscoveryJourney,
);

async function discoveryJourney(
  boundary: DiscoveryBoundary,
  { task }: TestContext,
): Promise<void> {
  const fixture = await installFixture();
  const request = discoveryRequest(fixture);
  await runInDurableObject(fixture.organisation, clearDiscoveryRelationships);
  const pause = installDiscoveryPause(boundary, "operational");
  let target = fixture.organisation;
  let completion: Promise<unknown> | null = null;
  let work = target.evaluateCaseContextDiscovery({
    organisationId: ORGANISATION_ID,
    request,
  });
  try {
    await expect.poll(discoveryPhase.bind(null, pause)).toBe("paused");
    const relocationId = await startMove("e2e");
    completion = resumeActorRelocation({ env, relocationId, now: Date.now() });
    await expect.poll(readBarrier.bind(null, target)).toBe(1);
    expect(await exportedItems(relocationId)).toBe(0);
    pause.phase = "released";
    expect(await work).toMatchObject({
      ok: false,
      error: { code: "organisation_placement_conflict" },
    });
    expect(await completion).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    const issued =
      boundary === "response" ||
      boundary === "response_error" ||
      boundary === "withdrawal" ||
      boundary === "relationships";
    const source = await runInDurableObject(
      fixture.organisation,
      discoveryState,
    );
    expect(source.relationships).toBe(0);
    expect(source.evaluations).toHaveLength(issued ? 1 : 0);
    expect(source.usage).toMatchObject({
      evaluations: issued ? 1 : 0,
      chargedInputTokens: issued ? 65_536 : 0,
      unmeasuredEvaluations: boundary === "response_error" ? 1 : 0,
    });
    if (issued) {
      expect(source.evaluations[0]).toMatchObject({
        state: boundary === "response_error" ? "failed" : "evaluated",
        settlement_state: "settled",
        input_tokens: boundary === "response_error" ? null : 120,
        estimated_cost_microusd: boundary === "response_error" ? null : 6,
      });
      expect(source.pending).toBe(boundary === "response_error" ? 0 : 1);
      expect(source.pendingContent).not.toContain("private delivery");
      expect(source.pendingContent).not.toContain(KEY);
    }
    await evictDurableObject(fixture.organisation);
    expect(
      await fixture.organisation.evaluateCaseContextDiscovery({
        organisationId: ORGANISATION_ID,
        request,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "organisation_placement_conflict" },
    });
    target = await requireActiveOrganisationActor({
      env,
      organisationId: ORGANISATION_ID,
      now: Date.now(),
    });
    await runInDurableObject(target, discoveryState);
    await evictDurableObject(target);

    if (boundary === "withdrawal") {
      await revokeVaultSecret({
        db: fixtureDatabase(),
        organisationId: ORGANISATION_ID,
        handle: required(
          parseVaultHandle(`vault:${ORGANISATION_ID}:typesafe:p55`),
        ),
        now: Date.now(),
      });
      expect(
        await target.evaluateCaseContextDiscovery({
          organisationId: ORGANISATION_ID,
          request,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "case_context_collection_inactive" },
      });
      await evictDurableObject(target);
      expect(
        await target.evaluateCaseContextDiscovery({
          organisationId: ORGANISATION_ID,
          request,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "case_context_collection_inactive" },
      });
      const final = await runInDurableObject(target, discoveryState);
      expect(final).toEqual(source);
      expect(pause.modelCalls).toBe(1);
      Object.assign(task.meta, {
        operationalCaseContextDiscoveryPlacement: {
          boundary,
          zeroExportsWhilePaused: true,
          source,
          final,
          modelCalls: 1,
          deniedRevokedCredentialAfterEviction: true,
        },
      });
      return;
    }

    if (boundary === "response") {
      pause.boundary = "relationships";
      pause.phase = "armed";
      work = target.evaluateCaseContextDiscovery({
        organisationId: ORGANISATION_ID,
        request,
      });
      await expect.poll(discoveryPhase.bind(null, pause)).toBe("paused");
      const secondMove = await startMove("e2e-policy-snapshot");
      completion = resumeActorRelocation({
        env,
        relocationId: secondMove,
        now: Date.now(),
      });
      await expect.poll(readBarrier.bind(null, target)).toBe(1);
      expect(await exportedItems(secondMove)).toBe(0);
      pause.phase = "released";
      expect(await work).toMatchObject({
        ok: false,
        error: { code: "organisation_placement_conflict" },
      });
      expect(await completion).toMatchObject({
        ok: true,
        value: { status: "retained" },
      });
      await evictDurableObject(target);
      target = await requireActiveOrganisationActor({
        env,
        organisationId: ORGANISATION_ID,
        now: Date.now(),
      });
      await runInDurableObject(target, discoveryState);
      await evictDurableObject(target);
    }
    const recovered = required(
      await target.evaluateCaseContextDiscovery({
        organisationId: ORGANISATION_ID,
        request,
      }),
    );
    expect(recovered.receipt.kind).toBe(
      boundary === "response_error" ? "failed" : "evaluated",
    );
    expect(recovered.recorded).toHaveLength(
      boundary === "response_error" ? 0 : 1,
    );
    expect(pause.modelCalls).toBe(1);
    await evictDurableObject(target);
    const replayed = required(
      await target.evaluateCaseContextDiscovery({
        organisationId: ORGANISATION_ID,
        request,
      }),
    );
    expect(replayed.receipt).toEqual(recovered.receipt);
    expect(replayed.recorded).toEqual([]);
    expect(pause.modelCalls).toBe(1);
    const final = await runInDurableObject(target, discoveryState);
    expect(final.pending).toBe(0);
    expect(final.relationships).toBe(boundary === "response_error" ? 0 : 1);
    Object.assign(task.meta, {
      operationalCaseContextDiscoveryPlacement: {
        boundary,
        zeroExportsWhilePaused: true,
        source,
        final,
        modelCalls: pause.modelCalls,
        replayedReceipt: replayed.receipt,
        recoveredAfterEviction: true,
        secondRelocationDuringReplay: boundary === "response",
      },
    });
  } finally {
    restoreDiscoveryPause(pause);
    await Promise.allSettled([work, completion]);
  }
}

async function connectorDiscoveryJourney(
  boundary: DiscoveryBoundary,
  { task }: TestContext,
): Promise<void> {
  const fixture = await installFixture();
  await runInDurableObject(fixture.organisation, clearDiscoveryRelationships);
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'case-context-collection-e2e', activated_at = ?, updated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), Date.now(), ORGANISATION_ID)
    .run();
  const connectorId = required(gmailConnectorId(fixture.integrationAccountId));
  const connector = required(
    await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId: ORGANISATION_ID,
      connectorId,
      now: Date.now(),
    }),
  );
  const anchor = fixture.dependency.selections.find(isAnchorSelection);
  if (anchor === undefined) throw new Error("Missing anchor");
  const scope = required(
    await OrganisationExecutionScope.resolve(env, ORGANISATION_ID),
  );
  await runInDurableObject(
    connector,
    seedDiscoveryWork.bind(
      null,
      fixture.integrationAccountId,
      anchor.source.sourceRevision,
    ),
  );
  await fixtureDatabase()
    .prepare(
      "UPDATE email_message_receipt SET contact_verification_id = NULL, contact_verification_revision = NULL WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .run();
  const pause = installDiscoveryPause(boundary, "operational");
  const work = runDurableObjectAlarm(connector);
  let completion: Promise<unknown> | null = null;
  try {
    await expect.poll(discoveryPhase.bind(null, pause)).toBe("paused");
    const pausedWork = await runInDurableObject(connector, readDiscoveryWork);
    expect(pausedWork).not.toBeNull();
    const relocationId = await startMove("e2e");
    completion = resumeActorRelocation({ env, relocationId, now: Date.now() });
    if (boundary === "response")
      await expect.poll(readBarrier.bind(null, fixture.organisation)).toBe(1);
    else
      await expect
        .poll(connectorDiscoveryBarrier.bind(null, connector))
        .toBe(1);
    expect(await exportedItems(relocationId)).toBe(0);
    const frozenWork = await runInDurableObject(connector, readDiscoveryWork);
    expect(frozenWork).toEqual(pausedWork);
    pause.phase = "released";
    expect(await work).toBe(true);
    const drainedWork = await runInDurableObject(connector, readDiscoveryWork);
    expect(
      drainedWork,
      JSON.stringify({
        pausedWork,
        frozenWork,
        modelCalls: pause.modelCalls,
        reads: pause.gmailReads,
        barrier: await connectorDiscoveryBarrier(connector),
      }),
    ).toEqual(pausedWork);
    expect(await completion).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    const retained = await runInDurableObject(connector, readDiscoveryWork);
    expect(retained).toEqual(pausedWork);
    expect(pause.modelCalls).toBe(boundary === "response" ? 1 : 0);
    const bound = await fixtureDatabase()
      .prepare(
        "SELECT provider_message_id FROM email_message_receipt WHERE organisation_id = ? AND contact_verification_id IS NOT NULL",
      )
      .bind(ORGANISATION_ID)
      .all();
    expect(bound.results).toHaveLength(
      boundary === "gmail_anchor" ? 0 : boundary === "response" ? 2 : 1,
    );
    expect(
      await bindEmailMessageReceiptContact({
        scope,
        integrationAccountId: fixture.integrationAccountId,
        providerMessageId: "message_p55_related",
        caseId: required(parseCaseId("case_p55_related")),
        admittedAt: anchor.source.sourceRevision,
        verificationId: VERIFICATION_ID,
        verificationRevision: 1,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "organisation_placement_conflict" },
    });
    // The evicted retired Connector cannot consume the retained work.
    await evictDurableObject(connector);
    await runInDurableObject(connector, armDiscoveryAlarm);
    await runDurableObjectAlarm(connector);
    expect(await runInDurableObject(connector, readDiscoveryWork)).toEqual(
      retained,
    );
    const target = required(
      await resolveActiveConnectorActor({
        env,
        namespace: env.CONNECTOR,
        organisationId: ORGANISATION_ID,
        connectorId,
        now: Date.now(),
      }),
    );
    await runInDurableObject(target, readDiscoveryWork);
    await evictDurableObject(target);
    await runInDurableObject(target, advanceDiscoveryClock);
    await runInDurableObject(target, armDiscoveryAlarm);
    expect(await runDurableObjectAlarm(target)).toBe(true);
    expect(await runInDurableObject(target, readDiscoveryWork)).toBeNull();
    expect(pause.modelCalls).toBe(1);
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: ORGANISATION_ID,
      now: Date.now(),
    });
    const settled = await runInDurableObject(organisation, discoveryState);
    expect(settled.relationships).toBe(1);
    expect(settled.evaluations).toHaveLength(1);
    await evictDurableObject(target);
    await runInDurableObject(target, armDiscoveryAlarm);
    await runDurableObjectAlarm(target);
    expect(pause.modelCalls).toBe(1);
    Object.assign(task.meta, {
      connectorCaseContextCollectionPlacement: {
        boundary,
        zeroExportsWhilePaused: true,
        retained,
        boundReceiptsAfterFreeze: bound.results.length,
        recoveredAfterEviction: true,
        modelCalls: pause.modelCalls,
        settled,
      },
    });
  } finally {
    restoreDiscoveryPause(pause);
    await Promise.allSettled([work, completion]);
  }
}

function discoveryRequest(
  fixture: Fixture,
): OperationalCaseContextDiscoverySourceRequest {
  const anchor = fixture.dependency.selections.find(isAnchorSelection);
  const candidate = fixture.dependency.selections.find(isRelationshipSelection);
  if (anchor === undefined || candidate === undefined)
    throw new Error("Missing discovery sources");
  return {
    issueKind: "email_issue",
    issueInstance: anchor.source.caseId,
    anchor: { selection: anchor.source, evidence: "anchor private delivery" },
    candidates: [
      { selection: candidate.source, evidence: "related private delivery" },
    ],
  };
}
function isAnchorSelection(
  selection: CaseContextCollectionEvidence["selections"][number],
): boolean {
  return selection.relationshipId === null;
}
function isRelationshipSelection(
  selection: CaseContextCollectionEvidence["selections"][number],
): boolean {
  return selection.relationshipId !== null;
}
function clearDiscoveryRelationships(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec("DELETE FROM case_context_collection_relationship");
  state.storage.sql.exec("DELETE FROM case_context_collection_case");
  state.storage.sql.exec("DELETE FROM case_context_collection_command");
  state.storage.sql.exec("DELETE FROM case_context_collection_invalidation");
  state.storage.sql.exec("DELETE FROM case_context_collection");
}
function discoveryState(_actor: unknown, state: DurableObjectState) {
  const sql = state.storage.sql;
  const evaluations = sql
    .exec<{
      state: string;
      settlement_state: string;
      input_tokens: number | null;
      estimated_cost_microusd: number | null;
    }>(
      "SELECT state, settlement_state, input_tokens, estimated_cost_microusd FROM typesafe_evaluation WHERE purpose = 'case_context_discovery_relationship'",
    )
    .toArray();
  return {
    evaluations,
    usage: readDailyTypeSafeUsage(
      sql,
      ORGANISATION_ID,
      "case_context_discovery_relationship",
      Date.now(),
    ),
    relationships: sql
      .exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM case_context_collection_relationship",
      )
      .one().total,
    pending: sql
      .exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM case_context_discovery_pending",
      )
      .one().total,
    pendingContent: JSON.stringify(
      sql.exec("SELECT * FROM case_context_discovery_pending").toArray(),
    ),
  };
}
async function seedDiscoveryWork(
  accountId: IntegrationAccountId,
  now: number,
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  activateEmailRuntime(state.storage.sql, {
    organisationId: ORGANISATION_ID,
    integrationAccountId: accountId,
    policyVersion: 1,
    limits: {
      maxActiveCases: 5,
      maxMessagesPerHour: 20,
      dailyTokenBudget: 20_000,
      maxMessageBytes: 262_144,
      maxAttachmentBytes: 5_242_880,
      debounce: { kind: "push_triggered", coalesceSeconds: 30 },
    },
    activationFloor: "10",
    watchExpiresAt: now + 86_400_000,
    now,
  });
  recordEmailCaseContextDiscovery(state.storage.sql, {
    organisationId: ORGANISATION_ID,
    integrationAccountId: accountId,
    caseId: "case_p55_anchor",
    threadId: "thread_p55_anchor",
    messageIds: ["message_p55_anchor"],
    policyVersion: 1,
    now,
  });
  await armDiscoveryAlarm(_actor, state);
}
function readDiscoveryWork(_actor: unknown, state: DurableObjectState) {
  return (
    state.storage.sql
      .exec<{ attempts: number; available_at: number }>(
        "SELECT attempts, available_at FROM connector_email_case_context_discovery",
      )
      .toArray()[0] ?? null
  );
}
function armDiscoveryAlarm(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  return state.storage.setAlarm(Date.now() + 60_000);
}
function advanceDiscoveryClock(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    "UPDATE connector_email_case_context_discovery SET available_at = 0",
  );
}
function readConnectorDiscoveryBarrier(
  _actor: unknown,
  state: DurableObjectState,
): number {
  return state.storage.sql
    .exec("SELECT 1 FROM state_object_cleanup_export_barrier")
    .toArray().length;
}
function connectorDiscoveryBarrier(
  connector: DurableObjectStub<ConnectorDO>,
): Promise<number> {
  return runInDurableObject(connector, readConnectorDiscoveryBarrier);
}
function installDiscoveryPause(
  boundary: DiscoveryBoundary,
  comparison: DiscoveryPause["comparison"],
): DiscoveryPause {
  const pause: DiscoveryPause = {
    boundary,
    comparison,
    phase: "armed",
    digest: crypto.subtle.digest,
    decrypt: crypto.subtle.decrypt,
    scopeIsActive: OrganisationExecutionScope.prototype.isActive,
    disclosurePrepared: false,
    preflightChecks: 0,
    modelCalls: 0,
    gmailReads: [],
  };
  discoveryPause = pause;
  crypto.subtle.digest = discoveryDigest;
  crypto.subtle.decrypt = discoveryDecrypt;
  OrganisationExecutionScope.prototype.isActive = discoveryScopeActive;
  network.use(
    http.post(
      "https://api.typesafe.ai/v1/systemone",
      discoveryModel.bind(null, pause),
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/*",
      discoveryGmail.bind(null, pause),
    ),
  );
  return pause;
}
function restoreDiscoveryPause(pause: DiscoveryPause): void {
  pause.phase = "released";
  crypto.subtle.digest = pause.digest;
  crypto.subtle.decrypt = pause.decrypt;
  OrganisationExecutionScope.prototype.isActive = pause.scopeIsActive;
  discoveryPause = null;
}
function discoveryPhase(pause: DiscoveryPause): DiscoveryPause["phase"] {
  return pause.phase;
}
async function waitDiscoveryPause(pause: DiscoveryPause): Promise<void> {
  pause.phase = "paused";
  while (pause.phase === "paused") await scheduler.wait(5);
}
async function discoveryScopeActive(
  this: OrganisationExecutionScope,
): Promise<boolean> {
  const pause = discoveryPause;
  if (pause === null) throw new Error("Missing discovery pause");
  const active = await pause.scopeIsActive.call(this);
  if (
    pause.boundary === "preflight" &&
    pause.phase === "armed" &&
    pause.disclosurePrepared
  ) {
    pause.preflightChecks += 1;
    if (pause.preflightChecks === 2) await waitDiscoveryPause(pause);
  }
  return active;
}
async function discoveryDigest(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["digest"]>[0],
  data: Parameters<SubtleCrypto["digest"]>[1],
): Promise<ArrayBuffer> {
  const pause = discoveryPause;
  if (pause === null) throw new Error("Missing discovery pause");
  const result = await pause.digest.call(this, algorithm, data);
  const text = new TextDecoder().decode(data);
  if (pause.phase === "armed") {
    if (
      pause.boundary === "request_digest" &&
      text.includes('"fixtureRevision":1') &&
      text.includes('"comparison"')
    )
      await waitDiscoveryPause(pause);
    if (
      text.includes('"sink"') &&
      text.includes('"case_context_discovery_relationship"')
    ) {
      pause.disclosurePrepared = true;
      if (pause.boundary === "preparation") await waitDiscoveryPause(pause);
    }
    if (
      pause.boundary === "relationships" &&
      text.includes('"evaluationId":"discovery_') &&
      text.includes('"decision"')
    )
      await waitDiscoveryPause(pause);
  }
  return result;
}
async function discoveryDecrypt(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["decrypt"]>[0],
  key: Parameters<SubtleCrypto["decrypt"]>[1],
  data: Parameters<SubtleCrypto["decrypt"]>[2],
): Promise<ArrayBuffer> {
  const pause = discoveryPause;
  if (pause === null) throw new Error("Missing discovery pause");
  const result = await pause.decrypt.call(this, algorithm, key, data);
  if (
    pause.boundary === "credential" &&
    pause.phase === "armed" &&
    new TextDecoder().decode(result).includes(KEY)
  )
    await waitDiscoveryPause(pause);
  return result;
}
async function discoveryModel(
  pause: DiscoveryPause,
  { request }: { request: { json(): Promise<unknown> } },
): Promise<Response> {
  if (pause.comparison === "synthetic") {
    const body = await request.json();
    expect(body).toMatchObject({
      model: "jev-1.13.0",
      state: {
        incoming:
          "Synthetic supplier S-1 reports flour delivery PR-842, shipment 1, is delayed today.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("private delivery");
    expect(JSON.stringify(body)).not.toContain(KEY);
  }
  pause.modelCalls += 1;
  if (
    pause.phase === "armed" &&
    (pause.boundary === "response" ||
      pause.boundary === "response_error" ||
      pause.boundary === "withdrawal" ||
      pause.boundary === "policy_withdrawal")
  )
    await waitDiscoveryPause(pause);
  if (pause.boundary === "response_error")
    return new Response(null, { status: 503 });
  const answers =
    pause.comparison === "synthetic"
      ? {
          candidate_0: { type: "choice", choice: "same_issue", confidence: 1 },
          candidate_1: {
            type: "choice",
            choice: "different_issue",
            confidence: 1,
          },
          candidate_2: {
            type: "choice",
            choice: "different_issue",
            confidence: 1,
          },
        }
      : {
          candidate_0: { type: "choice", choice: "same_issue", confidence: 1 },
        };
  return HttpResponse.json({
    model: "jev-1.13.0",
    answers,
    usage: { input_tokens: 120, output_tokens: 0 },
  });
}
async function discoveryGmail(
  pause: DiscoveryPause,
  input: { request: { url: string } },
): Promise<Response> {
  const id = new URL(input.request.url).pathname.split("/").at(-1);
  if (id === "history")
    return HttpResponse.json({ historyId: "10", history: [] });
  if (id !== "message_p55_anchor" && id !== "message_p55_related")
    throw new Error("Unexpected discovery source");
  pause.gmailReads.push(id);
  if (
    pause.phase === "paused" ||
    (pause.phase === "armed" &&
      ((pause.boundary === "gmail_anchor" && id === "message_p55_anchor") ||
        (pause.boundary === "gmail_candidate" && id === "message_p55_related")))
  )
    await waitDiscoveryPause(pause);
  const part = id === "message_p55_anchor" ? "anchor" : "related";
  return HttpResponse.json({
    id,
    threadId: `thread_p55_${part}`,
    labelIds: ["INBOX"],
    historyId: "10",
    internalDate: "1789000000000",
    sizeEstimate: 200,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: ADDRESS },
        { name: "Subject", value: "Delivery" },
        { name: "To", value: "bakery@example.test" },
      ],
      body: {
        data: encodeBase64Url(
          new TextEncoder().encode(`${part} private delivery`),
        ),
      },
    },
  });
}

const CASE_CONTEXT_COLLECTION_ID = "case_context_collection_p55_supplier";
const ADDRESS = "supplier@example.test";
const KEY = "apikey_p55-case-context-collection-placement-fixture-1234567890";
const VERIFICATION_ID = "verification_p55_supplier";
const TARGET = {
  kind: "supplier_contact",
  supplierId: "supplier_p55_case_context_collection",
  contactId: "contact_p55_case_context_collection",
  contactRevision: 1,
} as const;

type Boundary =
  | "prepare"
  | "validate"
  | "readiness"
  | "review"
  | "fence_replay"
  | "fence_commit"
  | "receipt";
type Fixture = Readonly<{
  organisation: DurableObjectStub<OrganisationDO>;
  integrationAccountId: IntegrationAccountId;
  dependency: CaseContextCollectionEvidence;
  attempt: CaseContextCollectionEffectAttempt;
}>;
type Pause = {
  readonly boundary: Boundary;
  phase: "armed" | "paused" | "released";
  readonly digest: SubtleCrypto["digest"];
  readonly decrypt: SubtleCrypto["decrypt"];
  attemptDigests: number;
};
let activePause: Pause | null = null;

it.for([
  "prepare",
  "validate",
  "readiness",
  "review",
  "fence_replay",
  "fence_commit",
  "receipt",
] as const)(
  "drains Organisation CaseContextCollection %s across relocation and recovers exact evidence after eviction",
  { timeout: 100_000 },
  caseContextCollectionJourney,
);

it(
  "rejects an CaseContextCollection effect that expires during hashing and retains its exact rejection after eviction",
  { timeout: 100_000 },
  expiryJourney,
);

async function expiryJourney({ task }: TestContext): Promise<void> {
  const fixture = await installFixture();
  const expiresAt = Date.now() + 2_000;
  const attempt = sendAttempt(
    fixture.dependency,
    "attempt_p55_expiry",
    "a".repeat(64),
    expiresAt,
  );
  const pause: Pause = {
    boundary: "fence_commit",
    phase: "armed",
    digest: crypto.subtle.digest,
    decrypt: crypto.subtle.decrypt,
    attemptDigests: 0,
  };
  activePause = pause;
  crypto.subtle.digest = pauseDigest;
  const work = fixture.organisation.commitCaseContextCollectionEffectFence({
    organisationId: ORGANISATION_ID,
    attempt,
  });
  try {
    await expect
      .poll(pausePhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    expect(Date.now()).toBeLessThan(expiresAt);
    while (Date.now() <= expiresAt)
      await scheduler.wait(Math.max(1, expiresAt - Date.now() + 1));
    pause.phase = "released";
    const receipt = required(await work);
    expect(receipt).toMatchObject({
      kind: "rejected",
      reason: "case_context_collection_effect_expired",
    });
    await evictDurableObject(fixture.organisation);
    expect(
      required(
        await fixture.organisation.commitCaseContextCollectionEffectFence({
          organisationId: ORGANISATION_ID,
          attempt,
        }),
      ),
    ).toEqual(receipt);
    expect(await runInDurableObject(fixture.organisation, readFenceCount)).toBe(
      1,
    );
    Object.assign(task.meta, {
      organisationCaseContextCollectionExpiry: {
        expiredDuringHash: true,
        rejectedReceipt: receipt,
        exactReplayAfterEviction: true,
        finalFenceCount: 1,
      },
    });
  } finally {
    pause.phase = "released";
    crypto.subtle.digest = pause.digest;
    activePause = null;
    await Promise.allSettled([work]);
  }
}

async function caseContextCollectionJourney(
  boundary: Boundary,
  { task }: TestContext,
): Promise<void> {
  const fixture = await installFixture();
  const priorReceipt =
    boundary === "receipt"
      ? required(
          await fixture.organisation.commitCaseContextCollectionEffectFence({
            organisationId: ORGANISATION_ID,
            attempt: fixture.attempt,
          }),
        )
      : null;
  const pause: Pause = {
    boundary,
    phase: "armed",
    digest: crypto.subtle.digest,
    decrypt: crypto.subtle.decrypt,
    attemptDigests: 0,
  };
  activePause = pause;
  crypto.subtle.digest = pauseDigest;
  crypto.subtle.decrypt = pauseDecryption;
  const work = startWork(fixture, boundary);
  let completion: Promise<unknown> | null = null;
  try {
    await expect
      .poll(pausePhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    const relocationId = await startMove("e2e");
    completion = resumeActorRelocation({ env, relocationId, now: Date.now() });
    await expect
      .poll(readBarrier.bind(null, fixture.organisation), { timeout: 10_000 })
      .toBe(1);
    expect(await exportedItems(relocationId)).toBe(0);
    expect(await runInDurableObject(fixture.organisation, readFenceCount)).toBe(
      priorReceipt === null ? 0 : 1,
    );
    pause.phase = "released";
    expect(await work).toMatchObject({
      ok: false,
      error: { code: "organisation_placement_conflict" },
    });
    expect(await completion).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    expect(await runInDurableObject(fixture.organisation, readFenceCount)).toBe(
      priorReceipt === null ? 0 : 1,
    );
    await evictDurableObject(fixture.organisation);
    await assertRetiredSource(fixture);

    const target = await requireActiveOrganisationActor({
      env,
      organisationId: ORGANISATION_ID,
      now: Date.now(),
    });
    expect(await runInDurableObject(target, readFenceCount)).toBe(
      priorReceipt === null ? 0 : 1,
    );
    await evictDurableObject(target);
    const prepared = required<CaseContextCollectionEvidenceDependency>(
      await target.prepareCaseContextCollectionEvidence(
        prepareRequest(fixture),
      ),
    );
    expect(prepared).toEqual(fixture.dependency);
    expect(
      await target.validateCaseContextCollectionEvidence({
        organisationId: ORGANISATION_ID,
        dependency: prepared,
      }),
    ).toMatchObject({ ok: true });
    const receipt = required(
      await target.commitCaseContextCollectionEffectFence({
        organisationId: ORGANISATION_ID,
        attempt: fixture.attempt,
      }),
    );
    expect(receipt.kind).toBe("committed");
    if (priorReceipt !== null) expect(receipt).toEqual(priorReceipt);
    await evictDurableObject(target);
    expect(
      required(
        await target.commitCaseContextCollectionEffectFence({
          organisationId: ORGANISATION_ID,
          attempt: fixture.attempt,
        }),
      ),
    ).toEqual(receipt);
    expect(
      await target.commitCaseContextCollectionEffectFence({
        organisationId: ORGANISATION_ID,
        attempt: sendAttempt(
          fixture.dependency,
          fixture.attempt.attemptId,
          "f".repeat(64),
          fixture.attempt.expiresAt,
        ),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "case_context_collection_effect_conflict" },
    });

    const correction = required(
      await target.reviewCaseContextCollectionRelationship(reviewRequest()),
    );
    expect(correction).toMatchObject({ revision: 3 });
    expect(
      await target.validateCaseContextCollectionEvidence({
        organisationId: ORGANISATION_ID,
        dependency: fixture.dependency,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "case_context_collection_evidence_stale" },
    });
    expect(
      await target.commitCaseContextCollectionEffectFence({
        organisationId: ORGANISATION_ID,
        attempt: sendAttempt(
          fixture.dependency,
          "attempt_after_correction",
          fixture.attempt.targetDigest,
          fixture.attempt.expiresAt,
        ),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "case_context_collection_evidence_stale" },
    });
    expect(
      required(
        await target.commitCaseContextCollectionEffectFence({
          organisationId: ORGANISATION_ID,
          attempt: fixture.attempt,
        }),
      ),
    ).toEqual(receipt);
    expect(
      required(
        await target.reviewCaseContextCollectionRelationship(reviewRequest()),
      ),
    ).toEqual(correction);
    expect(
      required(
        await target.readCaseContextCollectionsForCase({
          organisationId: ORGANISATION_ID,
          caseId: fixture.attempt.caseId,
        }),
      ).caseContextCollections,
    ).toHaveLength(1);
    required(
      await target.eraseCaseContextCollectionSource({
        organisationId: ORGANISATION_ID,
        selection: fixture.dependency.selections[0]!.source,
      }),
    );
    required(
      await target.invalidateCaseContextCollectionVerification({
        organisationId: ORGANISATION_ID,
        verificationId: VERIFICATION_ID,
        revision: 2,
      }),
    );
    await evictDurableObject(target);
    expect(
      required(
        await target.readCaseContextCollection({
          organisationId: ORGANISATION_ID,
          caseContextCollectionId: CASE_CONTEXT_COLLECTION_ID,
        }),
      ),
    ).toMatchObject({ lifecycle: "resolved" });
    expect(await runInDurableObject(target, readFenceCount)).toBe(1);
    expect(
      required(
        await target.commitCaseContextCollectionEffectFence({
          organisationId: ORGANISATION_ID,
          attempt: fixture.attempt,
        }),
      ),
    ).toEqual(receipt);
    Object.assign(task.meta, {
      organisationCaseContextCollectionPlacement: {
        boundary,
        exportedItemsWhilePaused: 0,
        sourceOutput: "withheld",
        lateFenceCount: priorReceipt === null ? 0 : 1,
        retiredSource: "denied",
        targetEvidence: "same_exact_dependency",
        targetEvictions: 3,
        committedReceipt: receipt,
        changedAttempt: "conflict",
        correctionBeforeNewFence: "stale",
        correctionAfterCommittedFence: "same_receipt",
        finalFenceCount: 1,
        finalCaseContextCollection: "resolved",
      },
    });
  } finally {
    pause.phase = "released";
    crypto.subtle.digest = pause.digest;
    crypto.subtle.decrypt = pause.decrypt;
    activePause = null;
    await Promise.allSettled(completion === null ? [work] : [work, completion]);
  }
}

function startWork(fixture: Fixture, boundary: Boundary) {
  switch (boundary) {
    case "prepare":
      return fixture.organisation.prepareCaseContextCollectionEvidence(
        prepareRequest(fixture),
      );
    case "validate":
      return fixture.organisation.validateCaseContextCollectionEvidence({
        organisationId: ORGANISATION_ID,
        dependency: fixture.dependency,
      });
    case "readiness":
      return fixture.organisation.readCaseContextDiscoverySourceReadiness({
        organisationId: ORGANISATION_ID,
        source: "gmail",
        integrationAccountId: fixture.integrationAccountId,
      });
    case "review":
      return fixture.organisation.reviewCaseContextCollectionRelationship(
        reviewRequest(),
      );
    case "fence_replay":
    case "fence_commit":
    case "receipt":
      return fixture.organisation.commitCaseContextCollectionEffectFence({
        organisationId: ORGANISATION_ID,
        attempt: fixture.attempt,
      });
    default:
      return assertNever(boundary);
  }
}

async function assertRetiredSource(fixture: Fixture): Promise<void> {
  for (const result of await Promise.all([
    fixture.organisation.prepareCaseContextCollectionEvidence(
      prepareRequest(fixture),
    ),
    fixture.organisation.validateCaseContextCollectionEvidence({
      organisationId: ORGANISATION_ID,
      dependency: fixture.dependency,
    }),
    fixture.organisation.commitCaseContextCollectionEffectFence({
      organisationId: ORGANISATION_ID,
      attempt: fixture.attempt,
    }),
    fixture.organisation.readCaseContextDiscoverySourceReadiness({
      organisationId: ORGANISATION_ID,
      source: "gmail",
      integrationAccountId: fixture.integrationAccountId,
    }),
    fixture.organisation.reviewCaseContextCollectionRelationship(
      reviewRequest(),
    ),
    fixture.organisation.readCaseContextCollection({
      organisationId: ORGANISATION_ID,
      caseContextCollectionId: CASE_CONTEXT_COLLECTION_ID,
    }),
    fixture.organisation.readCaseContextCollectionsForCase({
      organisationId: ORGANISATION_ID,
      caseId: fixture.attempt.caseId,
    }),
    fixture.organisation.eraseCaseContextCollectionSource({
      organisationId: ORGANISATION_ID,
      selection: fixture.dependency.selections[0]!.source,
    }),
    fixture.organisation.invalidateCaseContextCollectionVerification({
      organisationId: ORGANISATION_ID,
      verificationId: VERIFICATION_ID,
      revision: 2,
    }),
  ]))
    expect(result).toMatchObject({
      ok: false,
      error: { code: "organisation_placement_conflict" },
    });
}

function prepareRequest(fixture: Fixture) {
  return {
    organisationId: ORGANISATION_ID,
    caseId: fixture.attempt.caseId,
    integrationAccountId: fixture.integrationAccountId,
    triggeringMessageId: "message_p55_anchor",
  };
}
function reviewRequest() {
  return {
    organisationId: ORGANISATION_ID,
    actorId: "operator_p55_case_context_collection",
    caseContextCollectionId: CASE_CONTEXT_COLLECTION_ID,
    body: {
      commandId: "detach_p55",
      expectedRevision: 2,
      decision: { kind: "detach", relationshipId: "relationship_p55" },
    },
  };
}
function sendAttempt(
  dependency: CaseContextCollectionEvidence,
  attemptId: string,
  targetDigest: string,
  expiresAt: number,
): CaseContextCollectionEffectAttempt {
  return {
    attemptId,
    caseId: "case_p55_anchor",
    proposalId: "proposal_p55_supplier",
    proposalVersion: 1,
    effect: "send",
    targetDigest,
    contentDigest: "b".repeat(64),
    flowBindingDigest: "c".repeat(64),
    dependency,
    expiresAt,
  };
}

async function pauseDigest(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["digest"]>[0],
  data: Parameters<SubtleCrypto["digest"]>[1],
): Promise<ArrayBuffer> {
  const pause = activePause;
  if (pause === null) throw new Error("Missing CaseContextCollection pause");
  const result = await pause.digest.call(this, algorithm, data);
  const text = new TextDecoder().decode(data);
  if (pause.phase === "armed") {
    if (text.includes('"attemptId"')) pause.attemptDigests += 1;
    if (
      (pause.boundary === "prepare" && text === JSON.stringify(ADDRESS)) ||
      (pause.boundary === "review" &&
        text.includes('"commandId":"detach_p55"')) ||
      ((pause.boundary === "fence_replay" || pause.boundary === "receipt") &&
        pause.attemptDigests === 1) ||
      (pause.boundary === "fence_commit" && pause.attemptDigests === 2)
    )
      await pauseWork(pause);
  }
  return result;
}
async function pauseDecryption(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["decrypt"]>[0],
  key: Parameters<SubtleCrypto["decrypt"]>[1],
  data: Parameters<SubtleCrypto["decrypt"]>[2],
): Promise<ArrayBuffer> {
  const pause = activePause;
  if (pause === null) throw new Error("Missing CaseContextCollection pause");
  const result = await pause.decrypt.call(this, algorithm, key, data);
  if (
    pause.phase === "armed" &&
    (pause.boundary === "validate" || pause.boundary === "readiness") &&
    new TextDecoder().decode(result).includes(KEY)
  )
    await pauseWork(pause);
  return result;
}
async function pauseWork(pause: Pause): Promise<void> {
  pause.phase = "paused";
  while (pause.phase === "paused") await scheduler.wait(5);
}
function pausePhase(pause: Pause): Pause["phase"] {
  return pause.phase;
}
function readFenceCount(_actor: unknown, state: DurableObjectState): number {
  return state.storage.sql
    .exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM case_context_collection_effect_fence WHERE organisation_id = ?",
      ORGANISATION_ID,
    )
    .one().total;
}
function readLocalBarrier(_actor: unknown, state: DurableObjectState): number {
  return state.storage.sql
    .exec("SELECT 1 FROM state_object_policy_export_barrier")
    .toArray().length;
}
function readBarrier(
  organisation: DurableObjectStub<OrganisationDO>,
): Promise<number> {
  return runInDurableObject(organisation, readLocalBarrier);
}
async function exportedItems(relocationId: ActorRelocationId): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
  )
    .bind(relocationId)
    .first<{ total: number }>();
  if (row === null) throw new Error("Missing relocation count");
  return row.total;
}
async function startMove(
  placementCellId: "e2e" | "e2e-policy-snapshot",
): Promise<ActorRelocationId> {
  const target = required(
    parseOrganisationPlacementMoveTarget({
      kind: "affinity",
      placementCellId,
      locationHint: "wnam",
    }),
  );
  return required(
    await startActorRelocation({
      env,
      organisationId: ORGANISATION_ID,
      target,
      now: Date.now(),
    }),
  ).relocationId;
}
function required<Value>(
  result:
    | { readonly ok: true; readonly value: Value }
    | { readonly ok: false; readonly error: { readonly code: string } },
): Value {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

async function installFixture(): Promise<Fixture> {
  await installSlackActorFixture();
  const now = Date.now();
  const userId = required(
    parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab"),
  );
  const handle = required(
    parseVaultHandle(`vault:${ORGANISATION_ID}:typesafe:p55`),
  );
  required(
    await storeVaultSecret({
      db: fixtureDatabase(),
      keys: env,
      organisationId: ORGANISATION_ID,
      handle,
      secret: { kind: "bearer", value: KEY },
      now,
    }),
  );
  const gmailHandle = required(
    parseVaultHandle(`vault:${ORGANISATION_ID}:gmail:p55`),
  );
  required(
    await storeVaultSecret({
      db: fixtureDatabase(),
      keys: env,
      organisationId: ORGANISATION_ID,
      handle: gmailHandle,
      secret: {
        kind: "oauth_tokens",
        accessToken: "fixture-p55-case-context-collection-gmail",
        refreshToken: "fixture-p55-case-context-collection-refresh",
        expiry: { kind: "expires", expiresAt: now + 3_600_000 },
      },
      now,
    }),
  );
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId: ORGANISATION_ID,
    provider: "gmail",
    authorizationProduct: "full_mailbox_pilot",
    providerSubjectId: "google_p55_case_context_collection",
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef: gmailHandle },
    grantedScopes: GMAIL_FULL_MAILBOX_SCOPES,
    createdByUserId: userId,
    providerAccountId: "gmail_p55_case_context_collection",
    accountKind: "mailbox",
    displayName: "CaseContextCollection mailbox",
    capabilities: [CAPABILITY_KEYS.emailMailboxRead],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const integrationAccountId = connected.account.integrationAccountId;
  required(
    await registerEmailMailboxAccount({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      environment: "development",
      googleSubject: "google_p55_case_context_collection",
      observedAddress: "bakery@example.test",
      now,
    }),
  );
  await installMailboxAgent(integrationAccountId, userId, now);
  const merchantId = await seedPurchasingContext(
    ORGANISATION_ID,
    userId,
    integrationAccountId,
  );
  required(
    await registerOperationalEmailContact({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      target: TARGET,
      address: ADDRESS,
      displayName: "Supplier",
      state: "active",
      relationshipState: "active",
      now,
    }),
  );
  required(
    await publishContactVerification({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      actorId: userId,
      now,
      command: {
        kind: "verify",
        commandId: "verify_p55",
        verificationId: VERIFICATION_ID,
        expectedRevision: 0,
        integrationAccountId,
        target: TARGET,
        endpoint: { channel: "gmail", address: ADDRESS },
        evidenceRef: "synthetic:p55-supplier",
      },
    }),
  );
  const policy = required(
    await publishMailboxIngressPolicy({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      environment: "development",
      publishedBy: userId,
      now,
      request: {
        kind: "enabled",
        maxActiveCases: 5,
        maxMessagesPerHour: 20,
        dailyTokenBudget: 20_000,
        maxMessageBytes: 262_144,
        maxAttachmentBytes: 5_242_880,
        debounce: { kind: "push_triggered", coalesceSeconds: 30 },
        overflow: "pause_and_notify",
      },
    }),
  );
  if (policy.kind !== "enabled")
    throw new Error("Missing mailbox ingress policy");
  const scope = required(
    await OrganisationExecutionScope.resolve(env, ORGANISATION_ID),
  );
  for (const part of ["anchor", "related"] as const) {
    const source = selection(integrationAccountId, part, now);
    required(
      await recordEmailMessageReceipt({
        scope,
        integrationAccountId,
        providerMessageId: source.reference,
        gmailThreadId: `thread_p55_${part}`,
        caseId: required(parseCaseId(source.caseId)),
        policyVersion: policy.policyVersion,
        now,
      }),
    );
    required(
      await bindEmailMessageReceiptContact({
        scope,
        integrationAccountId,
        providerMessageId: source.reference,
        caseId: required(parseCaseId(source.caseId)),
        admittedAt: now,
        verificationId: VERIFICATION_ID,
        verificationRevision: 1,
      }),
    );
  }
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now,
  });
  await runInDurableObject(
    organisation,
    seedCaseContextCollection.bind(
      null,
      integrationAccountId,
      merchantId,
      handle,
      now,
    ),
  );
  const dependency = required<CaseContextCollectionEvidenceDependency>(
    await organisation.prepareCaseContextCollectionEvidence({
      organisationId: ORGANISATION_ID,
      caseId: "case_p55_anchor",
      integrationAccountId,
      triggeringMessageId: "message_p55_anchor",
    }),
  );
  if (dependency.kind !== "case_context_collection_evidence")
    throw new Error("Missing CaseContextCollection evidence");
  const attempt = sendAttempt(
    dependency,
    "attempt_p55_supplier",
    "a".repeat(64),
    now + 3_600_000,
  );
  return { organisation, integrationAccountId, dependency, attempt };
}

async function installMailboxAgent(
  integrationAccountId: IntegrationAccountId,
  actorUserId: string,
  now: number,
): Promise<void> {
  const commands: AgentOperationCommand[] = [
    {
      kind: "create_area",
      operationId: "area_p55",
      actorUserId,
      now,
      name: "Purchasing",
      purpose: "Supplier mail",
    },
    {
      kind: "create_agent_definition",
      operationId: "agent_p55",
      actorUserId,
      now,
      displayName: "Supplier agent",
      role: "research",
      purpose: "Supplier mail",
      instructions: "Review supplier delivery updates",
      requestedCapabilities: [],
      skillRefs: [],
    },
    {
      kind: "install_agent",
      operationId: "installation_p55",
      actorUserId,
      now,
      agentDefinitionId: "agent_p55",
      definitionRevision: 1,
      areaId: "area_p55",
      responsibility: "Purchasing",
      scopeIds: [],
      policyRevision: 1,
      grantedCapabilities: [],
    },
  ];
  for (const command of commands)
    required(
      await applyAgentOperation(fixtureDatabase(), ORGANISATION_ID, command),
    );
  required(
    await assignAgentMailbox({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      mailboxBindingId: "binding_work",
      installationId: "installation_p55",
      grantsDigest: "b".repeat(64),
      policyDigest: "c".repeat(64),
      createdBy: actorUserId,
      now,
    }),
  );
}
function selection(
  accountId: IntegrationAccountId,
  part: "anchor" | "related",
  now: number,
): CaseContextCollectionSelection {
  return {
    caseId: `case_p55_${part}`,
    source: "gmail",
    integrationAccountId: accountId,
    reference: `message_p55_${part}`,
    sourceRevision: now,
    verificationId: VERIFICATION_ID,
    verificationRevision: 1,
  };
}
function seedCaseContextCollection(
  accountId: IntegrationAccountId,
  merchantId: string,
  handle: string,
  now: number,
  _actor: unknown,
  state: DurableObjectState,
): void {
  const scope: CaseContextCollectionScope = {
    organisationId: ORGANISATION_ID,
    merchantId,
    party: { kind: "supplier", id: TARGET.supplierId },
    issueKind: "email_issue",
    issueInstance: "delivery_p55",
  };
  required(
    recordCaseContextCollectionSuggestion({
      sql: state.storage.sql,
      transaction: state.storage.transactionSync.bind(state.storage),
      organisationId: ORGANISATION_ID,
      commandId: "suggest_p55",
      requestDigest: "a".repeat(64),
      caseContextCollectionId: CASE_CONTEXT_COLLECTION_ID,
      relationshipId: "relationship_p55",
      expectedRevision: 0,
      scope,
      sourceScope: scope,
      anchorSelection: selection(accountId, "anchor", now),
      selection: selection(accountId, "related", now),
      evaluationId: "evaluation_p55",
      outcome: "same_issue",
      confidence: 1,
      expiresAt: now + 3_600_000,
      now,
    }),
  );
  required(
    decideCaseContextCollectionRelationship({
      sql: state.storage.sql,
      transaction: state.storage.transactionSync.bind(state.storage),
      organisationId: ORGANISATION_ID,
      commandId: "confirm_p55",
      requestDigest: "b".repeat(64),
      caseContextCollectionId: CASE_CONTEXT_COLLECTION_ID,
      expectedRevision: 1,
      actorId: "operator_p55_case_context_collection",
      now,
      decision: {
        kind: "confirm",
        relationshipId: "relationship_p55",
        sourceScope: scope,
      },
    }),
  );
  const policy = required(
    parseCaseContextDiscoveryPolicy({
      mode: "party_context",
      route: {
        provider: "typesafe",
        connectionRevision: 1,
        funding: "organisation_byo",
        credentialRef: "organisation_typesafe",
      },
      sources: [{ source: "gmail", integrationAccountId: accountId }],
      limits: {
        maxEvaluations: 20,
        maxConcurrentEvaluations: 1,
        maxInputBytes: 122_880,
        maxInputTokens: 327_680,
        maxWallMs: 50_000,
        maxCostMicrousd: 50_000,
        reservationMicrousd: 10_000,
        requestTimeoutMs: 10_000,
      },
    }),
  );
  required(
    publishCaseContextDiscoveryPolicy({
      sql: state.storage.sql,
      transaction: state.storage.transactionSync.bind(state.storage),
      organisationId: ORGANISATION_ID,
      commandId: "publish_p55",
      requestDigest: "c".repeat(64),
      expectedRevision: 0,
      policy,
      actorId: "operator_p55_case_context_collection",
      now,
    }),
  );
  state.storage.sql.exec(
    "INSERT INTO typesafe_connection (organisation_id, revision, provider, vault_handle, tested_at, updated_by) VALUES (?, 1, 'typesafe', ?, ?, 'operator_p55_case_context_collection')",
    ORGANISATION_ID,
    handle,
    now,
  );
  expect(
    readCaseContextCollection(
      state.storage.sql,
      ORGANISATION_ID,
      CASE_CONTEXT_COLLECTION_ID,
    )?.revision,
  ).toBe(2);
}

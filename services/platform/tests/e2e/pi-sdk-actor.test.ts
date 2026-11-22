import { setTimeout as delay } from "node:timers/promises";
import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { readLatestHarnessCheckpoint } from "../../src/actors/agent-session-harness-authority";
import {
  PACKAGED_PI_CHECKPOINT_FORMAT,
  PACKAGED_PI_HARNESS_BUILD,
} from "../../src/actors/pi-embedded-adapter";
import {
  CODE_MODE_PILOT_BUDGET,
  type CodeModeOrganisationSettleInput,
} from "../../src/actors/code-mode-budget";
import { CodeModePlatformGovernorActor } from "../../src/actors/code-mode-platform-governor";
import { codeModePlatformGovernor } from "../../src/actors/code-mode-platform-governor-stub";
import {
  startActorRelocation,
  resumeActorRelocation,
} from "@purin-labs/actor-runtime/actors/actor-relocation";
import { parseOrganisationPlacementMoveTarget } from "@purin-labs/tenancy/data/organisation-placement";
import { revokeAccessGrant } from "../../src/data/access-grants";
import { network } from "./network";
import {
  ROOT_TS,
  DISCOVERY_GRANT_ID,
  ORGANISATION_ID,
  installDiscoveryActorFixture,
  inspectSlackActors,
  openRouterText,
  openRouterToolCall,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
} from "./slack-journey-support";
import { readCaseWorkOutcome } from "./durable-codemode-journey-support";

it("restores native discovery and Code Mode store across Actor eviction after delayed discovery through the durable Slack Actor path", async ({
  task,
}) => {
  const fixture = await installDiscoveryActorFixture();
  const slack = slackSimulator();
  const requests: Record<string, unknown>[] = [];
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToSdkModel.bind(null, requests),
    ),
    slack.handler,
  );

  await sendSdkSlackMessage(
    "app_mention",
    "EvPiSdkRoot",
    ROOT_TS,
    "<@U0PANTRY> Read granted integration metadata in parallel and retain a compact summary.",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 50_000 }).toBe(1);

  expect(requests).toHaveLength(3);
  expect(slack.messages.map(messageText)).toEqual(["SDK_COMPOSED"]);
  const before = await inspectSlackActors(
    `connector_slack_${fixture.selectedIntegrationAccountId}`,
  );
  const checkpoint = await latestSdkCheckpoint(before.sessionId);
  expect(checkpoint.blob.formatVersion).toBe(PACKAGED_PI_CHECKPOINT_FORMAT);
  const sealed = await env.ARCHIVE.get(checkpoint.blob.objectKey);
  if (sealed === null) throw new Error("Missing encrypted Actor checkpoint");
  expect((await sealed.text()).startsWith("PANTRYCP1")).toBe(true);
  expect(checkpoint.blob.harnessBuild).toBe(PACKAGED_PI_HARNESS_BUILD);
  await evictSdkSession();

  await sendSdkSlackMessage(
    "message",
    "EvPiSdkFollowup",
    "1787500000.000003",
    "Use the retained summary and the discovered tool without repeating composition.",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);
  expect(requests).toHaveLength(6);
  const after = await inspectSlackActors(
    `connector_slack_${fixture.selectedIntegrationAccountId}`,
  );
  expect(after.sessionId).toBe(before.sessionId);
  expect(slack.messages.map(messageText)).toEqual([
    "SDK_COMPOSED",
    "SDK_RESTORED",
  ]);
  const finalCheckpoint = await latestSdkCheckpoint(after.sessionId);
  expect(finalCheckpoint.blob.harnessBuild).toBe(PACKAGED_PI_HARNESS_BUILD);
  expect(finalCheckpoint.historyCursor.lastSequence).toBeGreaterThan(
    checkpoint.historyCursor.lastSequence,
  );
  Object.assign(task.meta, {
    piSdkEvidence: {
      scenario: "actor-store-and-loadout-after-delayed-discovery",
      checkpointBuildBeforeRestore: PACKAGED_PI_HARNESS_BUILD,
      checkpointBuildAfterRestore: finalCheckpoint.blob.harnessBuild,
      discoveryDelayMs: CODE_MODE_PILOT_BUDGET.maxDurationMs + 1_000,
      requests,
      checkpoint: finalCheckpoint,
      session: after.session,
      delivered: slack.messages,
    },
  });
}, 60_000);

it("withholds a native composition summary after its read grant is revoked", async ({
  task,
}) => {
  const fixture = await installDiscoveryActorFixture();
  const slack = slackSimulator();
  const requests: Record<string, unknown>[] = [];
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToRevokedDeliveryModel.bind(null, requests),
    ),
    slack.handler,
  );
  await sendSdkSlackMessage(
    "app_mention",
    "EvPiSdkRestrictedDelivery",
    ROOT_TS,
    "<@U0PANTRY> Read the granted metadata and return a compact summary.",
  );
  const connectorRow = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'connector' AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string }>();
  if (connectorRow === null) throw new Error("Connector Actor missing");
  const connector = env.CONNECTOR.getByName(connectorRow.name);
  await expect
    .poll(readCaseWorkOutcome.bind(null, connector), { timeout: 15_000 })
    .toMatchObject({ reason: "case_delivery_authority_partition_changed" });
  expect(requests).toHaveLength(3);
  expect(slack.messages).toEqual([]);
  const accepted = await inspectSlackActors(
    `connector_slack_${fixture.selectedIntegrationAccountId}`,
  );
  Object.assign(task.meta, {
    piSdkEvidence: {
      scenario: "native-composition-revoked-delivery",
      requests,
      caseWork: await readCaseWorkOutcome(connector),
      session: accepted.session,
      case: accepted.case,
      delivered: slack.messages,
    },
  });
});

async function respondToRevokedDeliveryModel(
  requests: Record<string, unknown>[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid delivery model request");
  requests.push(body);
  switch (requests.length) {
    case 1:
      return openRouterToolCall(
        "tool_search",
        { query: "integration_list", limit: 1 },
        "sdk_delivery_discovery",
      );
    case 2:
      return openRouterToolCall(
        "codemode",
        {
          code: "const accounts = await tools.integration_list({}); text({ observed: accounts !== null });",
        },
        "sdk_delivery_read",
      );
    case 3: {
      expect(lastSdkToolText(body)).toContain('"observed":true');
      const revoked = await revokeAccessGrant({
        db: fixtureDatabase(),
        organisationId: ORGANISATION_ID,
        grantId: DISCOVERY_GRANT_ID,
        expectedRevision: 1,
        reason: "Revoke observed data before final delivery",
        now: Date.now(),
      });
      if (!revoked.ok) throw new Error(revoked.error.code);
      return openRouterText(
        "SDK_SUMMARY_MUST_BE_WITHHELD",
        "sdk_delivery_final",
      );
    }
    default:
      throw new Error("Unexpected delivery model request");
  }
}

it("settles an exhausted native composition through the Actor budget boundary", async ({
  task,
}) => {
  const fixture = await installDiscoveryActorFixture();
  const slack = slackSimulator();
  const requests: Record<string, unknown>[] = [];
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToBudgetModel.bind(null, requests),
    ),
    slack.handler,
  );
  await sendSdkSlackMessage(
    "app_mention",
    "EvPiSdkBudget",
    ROOT_TS,
    "<@U0PANTRY> Exercise the accepted read budget.",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  expect(requests).toHaveLength(3);
  expect(slack.messages.map(messageText)).toEqual(["SDK_BUDGET_PROTECTED"]);
  const row = await sessionObjectName();
  const executions = await runInDurableObject(
    env.SESSION.getByName(row.name),
    inspectSdkExecutions,
  );
  expect(executions).toHaveLength(1);
  expect(executions[0]).toMatchObject({
    state: "settled",
    request: {
      settle: {
        capabilityCalls: CODE_MODE_PILOT_BUDGET.maxCapabilityCalls,
        outcome: "organisation_failed",
      },
    },
  });
  const accepted = await inspectSlackActors(
    `connector_slack_${fixture.selectedIntegrationAccountId}`,
  );
  Object.assign(task.meta, {
    piSdkEvidence: {
      scenario: "native-actor-budget-exhaustion",
      requests,
      executions,
      session: accepted.session,
      delivered: slack.messages,
    },
  });
});

it("recovers from SDK validation and parallel admission failures without leaking claims", async ({
  task,
}) => {
  const fixture = await installDiscoveryActorFixture();
  const slack = slackSimulator();
  const requests: Record<string, unknown>[] = [];
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToParallelFailureModel.bind(null, requests),
    ),
    slack.handler,
  );
  await sendSdkSlackMessage(
    "app_mention",
    "EvPiSdkParallelFailure",
    ROOT_TS,
    "<@U0PANTRY> Recover from an invalid discovery request and an over-budget parallel read, then use a direct read.",
  );
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  expect(requests).toHaveLength(6);
  expect(slack.messages.map(messageText)).toEqual(["SDK_PARALLEL_RECOVERED"]);
  const row = await sessionObjectName();
  const executions = await runInDurableObject(
    env.SESSION.getByName(row.name),
    inspectSdkExecutions,
  );
  expect(executions).toHaveLength(1);
  expect(executions[0]).toMatchObject({
    state: "settled",
    request: {
      settle: {
        capabilityCalls: CODE_MODE_PILOT_BUDGET.maxConcurrentCalls,
        outcome: "organisation_failed",
      },
    },
  });
  const accepted = await inspectSlackActors(
    `connector_slack_${fixture.selectedIntegrationAccountId}`,
  );
  Object.assign(task.meta, {
    piSdkEvidence: {
      scenario: "native-parallel-admission-recovery",
      requests,
      executions,
      session: accepted.session,
      delivered: slack.messages,
    },
  });
});

async function respondToParallelFailureModel(
  requests: Record<string, unknown>[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body))
    throw new Error("Invalid parallel failure model request");
  requests.push(body);
  switch (requests.length) {
    case 1:
      return openRouterToolCall(
        "tool_search",
        { query: "integration_list", limit: "one" },
        "sdk_invalid_discovery",
      );
    case 2:
      expect(lastSdkToolText(body)).toContain("Validation failed");
      return openRouterToolCall(
        "tool_search",
        { query: "integration_list", limit: 1 },
        "sdk_parallel_discovery",
      );
    case 3:
      return openRouterToolCall(
        "codemode",
        {
          code: `const reads = []; for (let i = 0; i < ${CODE_MODE_PILOT_BUDGET.maxConcurrentCalls + 2}; i += 1) reads.push(tools.integration_list({})); await Promise.all(reads); text('must-never-complete');`,
        },
        "sdk_parallel_execution",
      );
    case 4:
      expect(lastSdkToolText(body)).toContain(
        "code_mode_capability_concurrency_exceeded",
      );
      expect(lastSdkToolText(body)).toContain(
        "do not retry Code Mode admission",
      );
      expect(modelToolNames(body)).not.toContain("codemode");
      return openRouterToolCall(
        "codemode",
        { code: "text('must-never-start');" },
        "sdk_duplicate_execution",
      );
    case 5:
      expect(lastSdkToolText(body)).toContain("not available");
      expect(lastSdkToolText(body)).not.toContain("must-never-start");
      return openRouterToolCall(
        "integration_list",
        {},
        "sdk_recovery_direct_read",
      );
    case 6:
      expect(lastSdkToolText(body)).toContain("dropbox");
      return openRouterText("SDK_PARALLEL_RECOVERED", "sdk_parallel_final");
    default:
      throw new Error("Unexpected parallel failure model request");
  }
}

async function respondToBudgetModel(
  requests: Record<string, unknown>[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid budget model request");
  requests.push(body);
  switch (requests.length) {
    case 1:
      return openRouterToolCall(
        "tool_search",
        { query: "integration_list", limit: 1 },
        "sdk_budget_discovery",
      );
    case 2:
      return openRouterToolCall(
        "codemode",
        {
          code: `for (let i = 0; i <= ${CODE_MODE_PILOT_BUDGET.maxCapabilityCalls}; i += 1) await tools.integration_list({}); text('must-never-complete');`,
        },
        "sdk_budget_execution",
      );
    case 3:
      expect(lastSdkToolText(body)).toContain(
        "code_mode_capability_call_limit_exceeded",
      );
      expect(lastSdkToolText(body)).not.toContain("must-never-complete");
      return openRouterText("SDK_BUDGET_PROTECTED", "sdk_budget_final");
    default:
      throw new Error("Unexpected budget model request");
  }
}

function inspectSdkExecutions(_actor: unknown, state: DurableObjectState) {
  const rows = state.storage.sql
    .exec<{
      state_kind: string;
      request_envelope: string;
      state_projection: string;
    }>(
      "SELECT state_kind, request_envelope, state_projection FROM actor_outbox WHERE json_extract(request_envelope, '$.kind') = 'code_mode_execution_settlement.v1'",
    )
    .toArray();
  return rows.map(sdkExecutionEvidence);
}

it.for(["before_accounting", "after_accounting"] as const)(
  "reconciles a recorded Code Mode result during relocation after interruption %s without repeating execution",
  { timeout: 60_000 },
  frozenSessionSettlementJourney,
);

async function frozenSessionSettlementJourney(
  boundary: "before_accounting" | "after_accounting",
  { task }: TestContext,
): Promise<void> {
  await installDiscoveryActorFixture();
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!target.ok) throw new Error(target.error.code);
  const governor = codeModePlatformGovernor(env);
  await runInDurableObject(
    governor,
    interruptSettlementAcknowledgement.bind(null, boundary),
  );
  const slack = slackSimulator();
  const requests: Record<string, unknown>[] = [];
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToFrozenSettlementModel.bind(null, requests),
    ),
    slack.handler,
  );
  await sendSdkSlackMessage(
    "app_mention",
    "EvPiFrozenSettlement",
    ROOT_TS,
    "<@U0PANTRY> Read integration metadata once.",
  );
  await expect
    .poll(readIndeterminateSdkExecution, { timeout: 20_000 })
    .toBe(true);
  const source = await sessionObjectName();
  const session = env.SESSION.getByName(source.name);
  const before = await runInDurableObject(session, inspectSdkExecutions);
  expect(before).toHaveLength(1);
  await runInDurableObject(session, seedUnresolvedSurfaceProjection);
  const blocked = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target: target.value,
    now: Date.now(),
  });
  expect(blocked).toMatchObject({
    ok: false,
    error: {
      code: "relocation_provider_work_unresolved",
      operationId: "surface-unresolved",
    },
  });
  await runInDurableObject(session, removeUnresolvedSurfaceFixture);
  const move = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target: target.value,
    now: Date.now(),
  });
  if (!move.ok) throw new Error(move.error.code);
  expect(await runInDurableObject(session, inspectSdkLifecycle)).toBe(
    "quarantined",
  );
  const governorBefore = await runInDurableObject(
    governor,
    inspectSettlementBudget,
  );
  expect(governorBefore[0]?.state).toBe(
    boundary === "before_accounting" ? "reserved" : "settled",
  );
  const organisationBefore = await inspectActiveOrganisationSettlementBudget();
  const envelope = await runInDurableObject(session, corruptRecordedSettlement);
  const rejected = await resumeActorRelocation({
    env,
    relocationId: move.value.relocationId,
    now: Date.now(),
  });
  expect(rejected).toMatchObject({
    ok: false,
    error: { code: "relocation_provider_work_unresolved" },
  });
  const exported = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
  )
    .bind(move.value.relocationId)
    .first<{ count: number }>();
  expect(exported?.count).toBe(0);
  await runInDurableObject(
    session,
    restoreRecordedSettlement.bind(null, envelope),
  );
  await evictDurableObject(session);
  const moved = await resumeActorRelocation({
    env,
    relocationId: move.value.relocationId,
    now: Date.now(),
  });
  expect(moved).toMatchObject({ ok: true, value: { status: "retained" } });
  const targetSession = await sessionObjectName();
  expect(targetSession.name).not.toBe(source.name);
  const targetActor = env.SESSION.getByName(targetSession.name);
  await evictDurableObject(targetActor);
  const after = await runInDurableObject(targetActor, inspectSdkExecutions);
  expect(await runInDurableObject(targetActor, inspectSdkLifecycle)).toBe(
    "quarantined",
  );
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({
    state: "reconciled",
    request: before[0]?.request,
    projection: {
      kind: "settlement_reconciled",
      relocationId: move.value.relocationId,
    },
  });
  const governorAfter = await runInDurableObject(
    governor,
    inspectSettlementBudget,
  );
  expect(governorAfter).toHaveLength(1);
  expect(governorAfter[0]?.state).toBe("settled");
  if (boundary === "after_accounting")
    expect(governorAfter).toEqual(governorBefore);
  expect(await inspectActiveOrganisationSettlementBudget()).toEqual(
    organisationBefore,
  );
  const replay = await resumeActorRelocation({
    env,
    relocationId: move.value.relocationId,
    now: Date.now(),
  });
  expect(replay).toMatchObject({ ok: true, value: { status: "retained" } });
  expect(await runInDurableObject(governor, inspectSettlementBudget)).toEqual(
    governorAfter,
  );
  expect(await inspectActiveOrganisationSettlementBudget()).toEqual(
    organisationBefore,
  );
  Object.assign(task.meta, {
    frozenSessionSettlement: {
      boundary,
      relocationId: move.value.relocationId,
      before,
      after,
      governorBefore,
      governorAfter,
      organisationBefore,
      modelRequests: requests.length,
      exportedBeforeRepair: exported?.count,
    },
  });
}

function interruptSettlementAcknowledgement(
  boundary: "before_accounting" | "after_accounting",
  actor: unknown,
): void {
  if (!(actor instanceof CodeModePlatformGovernorActor))
    throw new Error("Unexpected governor Actor");
  const settle = actor.settle;
  Object.defineProperty(Object.getPrototypeOf(actor), "settle", {
    value: rejectFirstSettlementAcknowledgement.bind(
      null,
      boundary,
      actor,
      settle,
    ),
    configurable: true,
    writable: true,
  });
}

async function rejectFirstSettlementAcknowledgement(
  boundary: "before_accounting" | "after_accounting",
  actor: CodeModePlatformGovernorActor,
  settle: CodeModePlatformGovernorActor["settle"],
  input: CodeModeOrganisationSettleInput,
): ReturnType<CodeModePlatformGovernorActor["settle"]> {
  Object.defineProperty(Object.getPrototypeOf(actor), "settle", {
    value: settle,
    configurable: true,
    writable: true,
  });
  if (boundary === "after_accounting") {
    const accepted = await settle.call(actor, input);
    if (!accepted.ok) return accepted;
  }
  return { ok: false, error: { code: "code_mode_reservation_conflict" } };
}

async function respondToFrozenSettlementModel(
  requests: Record<string, unknown>[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body))
    throw new Error("Invalid frozen settlement model request");
  requests.push(body);
  if (requests.length === 1)
    return openRouterToolCall(
      "tool_search",
      { query: "integration_list", limit: 1 },
      "frozen_discovery",
    );
  if (requests.length === 2)
    return openRouterToolCall(
      "codemode",
      { code: "text(await tools.integration_list({}));" },
      "frozen_execution",
    );
  return openRouterText("SETTLEMENT_RETURNED", "frozen_final");
}

async function readIndeterminateSdkExecution(): Promise<boolean> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session' AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string }>();
  if (row === null) return false;
  const executions = await runInDurableObject(
    env.SESSION.getByName(row.name),
    inspectSdkExecutions,
  );
  return executions.some(isIndeterminateSdkExecution);
}

function isIndeterminateSdkExecution(
  execution: ReturnType<typeof sdkExecutionEvidence>,
): boolean {
  return execution.state === "indeterminate";
}

function corruptRecordedSettlement(
  _actor: unknown,
  state: DurableObjectState,
): string {
  const row = state.storage.sql
    .exec<{ request: string }>(
      "SELECT request_envelope AS request FROM actor_outbox WHERE state_kind = 'indeterminate' AND json_extract(request_envelope, '$.kind') = 'code_mode_execution_settlement.v1'",
    )
    .one();
  state.storage.sql.exec(
    "UPDATE actor_outbox SET request_envelope = json_set(request_envelope, '$.receipt.receiptDigest', 'conflicting-receipt') WHERE request_envelope = ?",
    row.request,
  );
  return row.request;
}

function restoreRecordedSettlement(
  envelope: string,
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    "UPDATE actor_outbox SET request_envelope = ? WHERE state_kind = 'indeterminate' AND json_extract(request_envelope, '$.kind') = 'code_mode_execution_settlement.v1'",
    envelope,
  );
}

function inspectSettlementBudget(_actor: unknown, state: DurableObjectState) {
  return state.storage.sql
    .exec(
      "SELECT execution_id, state, receipt_id, receipt_digest, actual_cost_micros FROM code_mode_platform_reservation ORDER BY execution_id",
    )
    .toArray();
}

function inspectSdkLifecycle(
  _actor: unknown,
  state: DurableObjectState,
): string {
  return state.storage.sql
    .exec<{ kind: string }>("SELECT lifecycle_kind AS kind FROM session_meta")
    .one().kind;
}

async function inspectActiveOrganisationSettlementBudget() {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'organisation' AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string }>();
  if (row === null) throw new Error("Missing Organisation Actor");
  return runInDurableObject(
    env.ORGANISATION.getByName(row.name),
    inspectOrganisationSettlementBudget,
  );
}

function inspectOrganisationSettlementBudget(
  _actor: unknown,
  state: DurableObjectState,
) {
  return state.storage.sql
    .exec(
      "SELECT execution_id, state, receipt_id, receipt_digest, actual_cost_micros FROM code_execution_reservation ORDER BY execution_id",
    )
    .toArray();
}

function seedUnresolvedSurfaceProjection(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    `INSERT INTO actor_outbox
      (effect_id, organisation_id, originating_event_id, request_envelope, state_kind, state_projection, updated_at)
     VALUES ('surface-unresolved', ?, 'surface-dispatched', ?, 'reconciled', ?, ?)`,
    ORGANISATION_ID,
    JSON.stringify({ kind: "bakery_surface_effect.v1" }),
    JSON.stringify({
      kind: "surface_indeterminate",
      reason: "expired_after_dispatch",
    }),
    Date.now(),
  );
}

function removeUnresolvedSurfaceFixture(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    "DELETE FROM actor_outbox WHERE effect_id = 'surface-unresolved'",
  );
}

function sdkExecutionEvidence(row: {
  state_kind: string;
  request_envelope: string;
  state_projection: string;
}) {
  return {
    state: row.state_kind,
    request: JSON.parse(row.request_envelope),
    projection: JSON.parse(row.state_projection),
  };
}

async function respondToSdkModel(
  requests: Record<string, unknown>[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  expect(request.headers.get("authorization")).toBe(
    `Bearer ${env.OPENROUTER_API_KEY}`,
  );
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  requests.push(body);
  switch (requests.length) {
    case 1:
      await delay(CODE_MODE_PILOT_BUDGET.maxDurationMs + 1_000);
      // This catalog is small, so the first request offers it whole. The
      // search that follows finds a tool that is enabled and changes nothing.
      expect(modelToolNames(body)).toEqual(
        expect.arrayContaining(["codemode", "integration_list", "tool_search"]),
      );
      return openRouterToolCall(
        "tool_search",
        { query: "integration_list", limit: 1 },
        "sdk_discover",
      );
    case 2:
      expect(modelToolNames(body)).toContain("integration_list");
      return openRouterToolCall(
        "codemode",
        {
          code: "if (typeof bridge !== 'undefined' || typeof completion !== 'undefined' || typeof api !== 'undefined' || typeof piHost !== 'undefined' || typeof models !== 'undefined' || typeof setTimeout !== 'undefined' || 'bash' in tools) throw new Error('Executor scope exposed'); const views = await Promise.all([tools.integration_list({}), tools.integration_list({})]); const summary = { copies: views.length, identical: JSON.stringify(views[0]) === JSON.stringify(views[1]) }; store('brief', summary); text(summary);",
        },
        "sdk_compose",
      );
    case 3:
      expect(lastSdkToolText(body)).toContain('"copies":2');
      expect(JSON.stringify(body)).not.toContain(
        "provider-account-dropbox-secret",
      );
      expect(JSON.stringify(body)).not.toContain("vault:");
      return openRouterText("SDK_COMPOSED", "sdk_composed_final");
    case 4:
      expect(modelToolNames(body)).toContain("integration_list");
      return openRouterToolCall(
        "codemode",
        { code: "text(load('brief'));" },
        "sdk_load",
      );
    case 5:
      expect(lastSdkToolText(body)).toContain('"copies":2');
      return openRouterToolCall(
        "integration_list",
        {},
        "sdk_direct_after_restore",
      );
    case 6:
      return openRouterText("SDK_RESTORED", "sdk_restored_final");
    default:
      throw new Error("Unexpected SDK request");
  }
}

function modelToolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return [];
  const names: string[] = [];
  for (const tool of body.tools)
    if (
      isRecord(tool) &&
      isRecord(tool.function) &&
      typeof tool.function.name === "string"
    )
      names.push(tool.function.name);
  return names.sort();
}

function lastSdkToolText(body: Record<string, unknown>): string {
  if (!Array.isArray(body.messages)) throw new Error("Missing model messages");
  for (const message of [...body.messages].reverse()) {
    if (!isRecord(message) || message.role !== "tool") continue;
    if (typeof message.content === "string") return message.content;
    throw new Error("Expected a text tool result");
  }
  throw new Error("Missing tool result");
}

async function sendSdkSlackMessage(
  eventType: "app_mention" | "message",
  eventId: string,
  messageTs: string,
  text: string,
): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({ eventType, eventId, messageTs, threadTs: ROOT_TS, text }),
    ),
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "case_accepted",
  });
}

async function latestSdkCheckpoint(sessionId: string) {
  const row = await sessionObjectName();
  return runInDurableObject(
    env.SESSION.getByName(row.name),
    readSdkCheckpoint.bind(null, sessionId),
  );
}

function readSdkCheckpoint(
  sessionId: string,
  _actor: unknown,
  state: DurableObjectState,
) {
  const record = readLatestHarnessCheckpoint(state.storage.sql, sessionId);
  if (!record.ok) throw new Error(record.error.code);
  return record.value;
}
function messageText(message: Record<string, string>): string {
  return message.text ?? "";
}

async function evictSdkSession(): Promise<void> {
  const row = await sessionObjectName();
  await evictDurableObject(env.SESSION.getByName(row.name));
}

async function sessionObjectName(): Promise<{ name: string }> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session' AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string }>();
  if (row === null) throw new Error("Session Actor missing");
  return row;
}

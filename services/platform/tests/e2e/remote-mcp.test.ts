import { decidePendingDecisionWith } from "../../src/control/pending-decision-parts";
import {
  handleCustomConnectorControlRoute,
  matchCustomConnectorControlRoute,
} from "../../src/control/routes/custom-connectors";
import { fixtureDatabase } from "./organisation-database";
import { pendingDecisionsOf } from "./access-route-support";
import { commerceHeaders } from "./commerce-support";
import { completeCommerceApprovalFixture } from "./commerce-approval-fixture";
import { googleConfig } from "@purin-labs/control/worker/google-oidc-config";
import { APPROVAL_GRANT_COOKIE } from "@purin-labs/control/worker/authorization";
import { controlActionMutationExecution } from "@purin-labs/conversation/actors/action-mutation-execution";
import { newControlMutationIdentity } from "@purin-labs/tenancy/data/control-mutation";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { setTimeout as delay } from "node:timers/promises";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, vi, type TestContext } from "vitest";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { assertNever, isRecord, encodeBase64, sha256Hex } from "@purin-labs/std";
import type {
  AuthorityPartition,
  AuthorizedHarnessToolResult,
} from "@purin-labs/contracts";
import {
  authorizeCapabilityUse,
  compileTurnAuthority,
} from "@purin-labs/authority/authorization/access-grants/index";
import {
  createAccessGrant,
  readAccessGrant,
  revokeAccessGrant,
} from "@purin-labs/authority/data/access-grants";
import { parseCaseId, parseSessionId } from "@purin-labs/kernel/ids";
import { parseUserId, newUserId } from "@purin-labs/control-api/ids";
import {
  issueControlSession,
  type IssuedControlSession,
} from "@purin-labs/tenancy/data/control-plane";
import {
  applyAgentOperation,
  type AgentOperationCommand,
} from "@purin-labs/agent/data/agent-operations";
import {
  digestApprovalAction,
  parseApprovalEvidence,
} from "@purin-labs/authority/approval-authentication";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { compilePublishAndActivateOrganisationPolicy } from "@purin-labs/authority/policy-snapshot";
import { changeVersionedCapabilityPolicy } from "@purin-labs/authority/access-control/capability-mutations";
import { readOrganisationCapabilityPolicies } from "@purin-labs/authority/data/capability-policy";
import {
  FlowBinding,
  InformationFlowContext,
} from "@purin-labs/authority/policy/information-flow/index";
import {
  prepareCustomConnectorDraftDocument,
  createCustomConnectorDraft,
  validateCustomConnectorRevision,
  approveCustomConnectorRevision,
  startCustomConnectorSetup,
  attachCustomConnectorCandidateCredential,
  testCustomConnectorCandidate,
  createCustomConnectorIdentityTestExecutor,
  authorizeCustomConnectorSetupCommit,
  commitNewCustomConnectorAccount,
  compileCustomConnectorReadCatalog,
  compileCustomConnectorWriteCatalog,
  authorizeCustomConnectorRead,
  executeAuthorizedCustomConnectorRead,
  buildCustomConnectorWriteAuthority,
  executeApprovedCustomConnectorWrite,
  CUSTOM_CONNECTOR_LIMITS,
  type CustomConnectorReadCatalogEntry,
  type CustomConnectorWriteCatalogEntry,
} from "../../src/custom-connectors";
import { executeCustomConnectorTransport } from "../../src/custom-connectors/egress";
import type { HarnessToolDefinition } from "@purin-labs/agent/actors/embedded-harness";
import {
  RecordingBoundary,
  sdkInput,
  restoredInput,
  runSdkTurn,
} from "./pi-sdk-support";
import { network } from "./network";
import {
  installSlackActorFixture,
  CHANNEL_ID,
  ORGANISATION_ID,
  openRouterToolCall,
  openRouterText,
  requireLastToolOutput,
  ROOT_TS,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
  inspectSlackActors,
  createRequiredGrant,
} from "./slack-journey-support";

const SECRET = "synthetic-mcp-vault-secret";
const EMPTY_SCHEMA = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};
const GRANT_ID = "grant_e2e_remote_mcp";
const REST_WRITE_GRANT_ID = "grant_e2e_rest_write";
const MCP_WRITE_GRANT_ID = "grant_e2e_mcp_write";
const ORIGIN = "https://mcp.example.net";
/** The class binding of the fetch container, before a fixture stands in. */
const CLASS_EGRESS = env.CUSTOM_CONNECTOR_FETCH;

type OriginBoundary = "discovery" | "response";
type OriginPause = {
  readonly boundary: OriginBoundary;
  phase: "armed" | "paused" | "released";
};

it.for(["discovery", "response"] as const)(
  "fences custom connector origin at %s and recovers after Session eviction",
  { timeout: 45_000 },
  connectorOriginJourney,
);

async function connectorOriginJourney(
  boundary: OriginBoundary,
  { task }: TestContext,
): Promise<void> {
  await installSlackActorFixture();
  const pause: OriginPause = {
    boundary,
    phase: "released",
  };
  const server = new OriginRemoteFixture(pause);
  network.use(http.get("https://cloudflare-dns.com/dns-query", dnsResponse));
  const fixture = await installRemoteConnector(server);
  const sessions = await installOriginOperator();
  const model = new OriginConnectorModel(
    fixture.entry.toolName,
    server,
    sessions.original,
  );
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
  );
  server.calls.length = 0;
  server.requests.length = 0;
  pause.phase = "armed";
  const key = `p55_custom_origin_${boundary}`;
  const work = dispatchOriginCommand(sessions.original, key);
  try {
    await expect
      .poll(originPhase.bind(null, pause), { timeout: 15_000 })
      .toBe("paused");
    const actor = await originSessionStub(sessions.original);
    const issuedCalls = server.calls.length;
    const issuedRequests = server.requests.length;
    const admittedModelCalls = model.requests;
    await env.DB.prepare(
      "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
    )
      .bind(Date.now(), sessions.original.session.controlSessionId)
      .run();
    pause.phase = "released";
    expect((await work).status).toBe(503);
    expect(server.calls).toHaveLength(issuedCalls);
    expect(server.requests).toHaveLength(issuedRequests);
    expect(model.requests).toBe(admittedModelCalls);
    expect(issuedCalls).toBe(boundary === "response" ? 1 : 0);
    const retained = await runInDurableObject(
      actor,
      connectorOriginState.bind(null, fixture.entry.integrationAccountId),
    );
    expect(retained.observations).toBe(0);
    await runInDurableObject(actor, clearActorEgress);
    await evictDurableObject(actor);
    expect(
      await runInDurableObject(
        actor,
        connectorOriginState.bind(null, fixture.entry.integrationAccountId),
      ),
    ).toEqual(retained);
    expect((await dispatchOriginCommand(sessions.fresh, key)).status).toBe(503);
    expect(server.calls).toHaveLength(issuedCalls);
    expect(server.requests).toHaveLength(issuedRequests);
    model.session = sessions.fresh;
    model.toolIssued = false;
    const allowed = await dispatchOriginCommand(sessions.fresh, `${key}_fresh`);
    expect(allowed.status).toBe(200);
    await allowed.arrayBuffer();
    expect(server.calls).toHaveLength(issuedCalls + 1);
    expect(server.calls.at(-1)).toBe("inventory_read");
    const freshActor = await originSessionStub(sessions.fresh);
    expect(
      (
        await runInDurableObject(
          freshActor,
          connectorOriginState.bind(null, fixture.entry.integrationAccountId),
        )
      ).observations,
    ).toBe(1);
    await runInDurableObject(freshActor, clearActorEgress);
    Object.assign(task.meta, {
      connectorOriginAcceptance: {
        boundary,
        issuedCalls,
        issuedRequests,
        protectedRequestsAfterRevocation: 0,
        observationsAfterRevocation: 0,
        evictedStateRetained: true,
        duplicateProviderEffects: 0,
        authorizedFreshReads: 1,
        authorizedFreshObservations: 1,
      },
    });
  } finally {
    pause.phase = "released";
    await work;
  }
}

function originPhase(pause: OriginPause) {
  return pause.phase;
}
async function waitOriginPause(pause: OriginPause): Promise<void> {
  pause.phase = "paused";
  while (pause.phase === "paused") await scheduler.wait(5);
}
function connectorOriginState(
  accountId: string,
  _actor: unknown,
  state: DurableObjectState,
) {
  return {
    history: JSON.stringify(
      state.storage.sql.exec("SELECT * FROM session_harness_history").toArray(),
    ),
    observations: state.storage.sql
      .exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM session_information_flow_observation WHERE json_extract(evidence_json, '$.source.kind') = 'integration_resource' AND json_extract(evidence_json, '$.source.integrationAccountId') = ?",
        accountId,
      )
      .one().total,
  };
}
async function originSessionStub(session: IssuedControlSession) {
  const row = await fixtureDatabase()
    .prepare(
      `SELECT registry.physical_object_name AS name FROM durable_object_registry registry
     JOIN session_turn_access access ON access.organisation_id = registry.organisation_id AND access.session_id = registry.logical_object_id
     WHERE registry.organisation_id = ? AND registry.object_kind = 'session' AND access.control_session_id = ?`,
    )
    .bind(ORGANISATION_ID, session.session.controlSessionId)
    .first<{ name: string }>();
  if (row === null) throw new Error("Missing originating connector Session");
  return env.SESSION.getByName(row.name);
}
function dispatchOriginCommand(
  session: IssuedControlSession,
  key: string,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/cases/commands`,
    {
      method: "POST",
      headers: {
        origin: "https://localhost",
        "content-type": "application/json",
        "idempotency-key": key,
        cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
        "x-pantry-csrf": session.csrfToken,
      },
      body: JSON.stringify({
        instruction: "Read the reviewed supplier inventory.",
      }),
    },
  );
}
async function installOriginOperator() {
  const user = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!user.ok) throw new Error(user.error.code);
  const now = Date.now();
  const commands: readonly AgentOperationCommand[] = [
    {
      kind: "create_area",
      operationId: "area_connector_origin",
      actorUserId: user.value,
      now,
      name: "Purchasing",
      purpose: "Supplier inventory",
    },
    {
      kind: "create_agent_definition",
      operationId: "agent_connector_origin",
      actorUserId: user.value,
      now,
      displayName: "Supplier agent",
      role: "research",
      purpose: "Supplier inventory",
      instructions: "Read supplier inventory",
      requestedCapabilities: [],
      skillRefs: [],
    },
    {
      kind: "install_agent",
      operationId: "installation_connector_origin",
      actorUserId: user.value,
      now,
      agentDefinitionId: "agent_connector_origin",
      definitionRevision: 1,
      areaId: "area_connector_origin",
      responsibility: "Purchasing",
      scopeIds: [],
      policyRevision: 1,
      grantedCapabilities: [],
    },
  ];
  for (const command of commands) {
    const result = await applyAgentOperation(
      fixtureDatabase(),
      ORGANISATION_ID,
      command,
    );
    if (!result.ok) throw new Error(result.error.code);
  }
  await createRequiredGrant({
    grantId: "grant_connector_origin_context",
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "platform_capability",
      capabilityId: "context.case.read",
      capabilityVersion: 1,
    },
    now,
  });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now,
  });
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now,
  });
  if (!published.ok) throw new Error(published.error.code);
  return {
    original: await issueControlSession({
      db: env.DB,
      userId: user.value,
      now,
      ttlMs: 1_800_000,
    }),
    fresh: await issueControlSession({
      db: env.DB,
      userId: user.value,
      now,
      ttlMs: 1_800_000,
    }),
  };
}

it("governs MCP discovery, parallel Code Mode reads, checkpoint recovery and authority changes in Workerd", async ({
  task,
}) => {
  await installSlackActorFixture();
  const server = new RemoteFixture();
  network.use(http.get("https://cloudflare-dns.com/dns-query", dnsResponse));
  // This control exercises native Workerd fetch, without a global binding shim.
  network.use(http.post(`${ORIGIN}/mcp`, nativeMcpResponse.bind(null, server)));
  const nativeClient = new McpClient({ name: "workerd-control", version: "1" });
  await nativeClient.connect(
    new StreamableHttpTransport({ url: `${ORIGIN}/mcp`, openGetStream: false }),
  );
  expect((await nativeClient.listTools()).map(toolName)).toContain(
    "inventory_read",
  );
  await nativeClient.close();
  server.calls.length = 0;

  const fixture = await installRemoteConnector(server);
  const boundary = new RemoteBoundary(fixture, server, fixture.entry);
  const provider = new RemoteModel(fixture.entry.toolName);
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
  );
  const definition: HarnessToolDefinition = {
    type: "function",
    strict: true,
    name: fixture.entry.toolName,
    description: "Read reviewed supplier inventory.",
    parameters: EMPTY_SCHEMA,
  };
  const input = sdkInput(boundary, [definition], "native");
  const first = await runSdkTurn(
    input,
    "Discover supplier inventory, read it in parallel, and store the total.",
  );
  expect(first.finalMessage).toBe("MCP_TOTAL_14");
  expect(server.calls).toEqual(["account", "inventory_read", "inventory_read"]);
  expect(boundary.settlements).toEqual(["succeeded"]);
  const restored = await runSdkTurn(
    restoredInput(input, first, boundary, "mcp_restore"),
    "Read the stored total, then refresh the discovered supplier tool.",
  );
  expect(restored.finalMessage).toBe("MCP_RESTORED_14");
  expect(server.calls).toEqual([
    "account",
    "inventory_read",
    "inventory_read",
    "inventory_read",
  ]);

  server.afterDiscovery = boundary.cancelExecution.bind(boundary);
  const cancelled = await runSdkTurn(
    restoredInput(input, restored, boundary, "mcp_cancelled"),
    "Read supplier inventory while the accepted turn is cancelled during discovery.",
  );
  expect(cancelled.finalMessage).toBe("MCP_CANCELLED");
  expect(server.calls).toHaveLength(4);
  boundary.execution = "active";
  server.afterDiscovery = revokeRemoteGrant;
  const denied = await runSdkTurn(
    restoredInput(input, cancelled, boundary, "mcp_revoked"),
    "Attempt the previously discovered supplier read.",
  );
  expect(denied.finalMessage).toBe("MCP_REVOKED");
  const writeDenied = await runSdkTurn(
    restoredInput(input, denied, boundary, "mcp_unapproved_write"),
    "Attempt the server's advertised write_record tool.",
  );
  expect(writeDenied.finalMessage).toBe("MCP_WRITE_DENIED");
  expect(server.calls).toHaveLength(4);
  expect(JSON.stringify(provider.requests)).not.toContain(SECRET);
  expect(JSON.stringify(boundary.entries)).not.toContain(SECRET);
  expect(server.calls).not.toContain("write_record");
  Object.assign(task.meta, {
    remoteMcpEvidence: {
      scenario:
        "reviewed-vault-connector-pi-discovery-composition-restore-revocation",
      nativeWorkerdFetch: "passed",
      productionAuthorization: "Vault + operation grant + information flow",
      remoteCalls: server.calls,
      requests: provider.requests,
      settlements: boundary.settlements,
      acceptedHistory: boundary.entries,
      checkpointDigest: await sha256Hex(
        new TextDecoder().decode(writeDenied.checkpoint),
      ),
      credentialsInModelOrHistory: false,
      unapprovedWrites: 0,
      boundary:
        "Real D1/Vault and Pi SDK; recorded harness admission and simulated pinned egress container",
    },
  });
});

it("executes reviewed REST reads and approved writes with bounded attempts and rejects authority lost during preparation", async ({
  task,
}) => {
  await installSlackActorFixture();
  const server = new RemoteFixture();
  network.use(http.get("https://cloudflare-dns.com/dns-query", dnsResponse));
  const fixture = await installRemoteConnector(server);
  const boundary = new RemoteBoundary(fixture, server, fixture.restRead);
  const read = await boundary.executeTool(fixture.restRead.toolName, "{}");
  expect(read).toMatchObject({ status: "succeeded" });
  expect(read.output).toMatchObject({ content: [{ text: '{"count":7}' }] });

  const confirmed = await executeConnectorWrite({
    fixture,
    server,
    entry: fixture.restWrite,
    grantId: REST_WRITE_GRANT_ID,
    suffix: "confirmed",
    grantDisposition: "retain",
    timeoutMs: fixture.restWrite.limits.invocationTimeoutMs,
  });
  expect(confirmed.state).toBe("confirmed");
  const callsBeforeRevocation = server.calls.length;
  const rejected = await executeConnectorWrite({
    fixture,
    server,
    entry: fixture.restWrite,
    grantId: REST_WRITE_GRANT_ID,
    suffix: "revoked",
    grantDisposition: "revoke",
    timeoutMs: fixture.restWrite.limits.invocationTimeoutMs,
  });
  expect(rejected.state).toBe("failed");
  if (rejected.state !== "failed")
    throw new Error("Rejected write did not settle as failed");
  expect(rejected.providerResult).toBe(
    JSON.stringify({ kind: "failed_before_send", reason: "authority_expired" }),
  );
  expect(server.calls).toHaveLength(callsBeforeRevocation);

  boundary.cancelDuringAuthorization = true;
  const cancelled = await boundary.executeTool(fixture.restRead.toolName, "{}");
  expect(cancelled).toMatchObject({ status: "failed" });
  expect(cancelled.output).toMatchObject({
    content: [
      {
        text: '{"code":"custom_connector_transport_failed","reason":"authority_expired"}',
      },
    ],
  });
  expect(server.calls).toHaveLength(callsBeforeRevocation);
  boundary.execution = "active";
  boundary.invocationTimeoutMs = -1;
  await expect(
    boundary.executeTool(fixture.restRead.toolName, "{}"),
  ).rejects.toThrow("custom_connector_read_invalid");
  expect(server.calls).toHaveLength(callsBeforeRevocation);
  expect(server.calls).toEqual(["account", "rest_inventory", "rest_create"]);
  expect(server.attemptTimeouts.every(isBoundedAttempt)).toBe(true);
  Object.assign(task.meta, {
    reviewedConnectorEvidence: {
      scenario: "rest-read-approved-write-revocation-before-dispatch",
      invocationTimeoutMs: CUSTOM_CONNECTOR_LIMITS.invocationTimeoutMs,
      attemptTimeoutMs: CUSTOM_CONNECTOR_LIMITS.attemptTimeoutMs,
      observedAttemptTimeouts: server.attemptTimeouts,
      remoteCalls: server.calls,
      confirmedAction: confirmed,
      rejectedAction: rejected,
      cancelledRead: cancelled,
      expiredReadRequests: 0,
      boundary:
        "Real D1/Vault, version review, policy, grants and Organisation Actor approval/receipts; simulated pinned egress container",
    },
  });
});

type ControlWriteBoundary = "release" | "placement" | "role";
type ControlWriteProbe = {
  boundary: ControlWriteBoundary | null;
  server: RemoteFixture;
  session: IssuedControlSession;
  armed: boolean;
};
let controlWriteProbe: ControlWriteProbe | null = null;

it.for(["release", "placement", "role"] as const)(
  "retains custom write control origin through %s and native receipt recovery",
  { timeout: 60_000 },
  controlWriteOriginJourney,
);

async function controlWriteOriginJourney(
  boundary: ControlWriteBoundary,
  { task }: TestContext,
) {
  await installSlackActorFixture();
  const server = new RemoteFixture();
  network.use(
    http.get("https://cloudflare-dns.com/dns-query", controlWriteDns),
  );
  const fixture = await installRemoteConnector(server);
  if (boundary === "role") await installRemainingControlOwner();
  const prepared = await prepareConnectorWrite({
    fixture,
    server,
    entry: fixture.restWrite,
    grantId: REST_WRITE_GRANT_ID,
    suffix: `control_${boundary}`,
    grantDisposition: "retain",
    timeoutMs: fixture.restWrite.limits.invocationTimeoutMs,
  });
  controlWriteProbe = {
    boundary,
    server,
    session: prepared.session,
    armed: true,
  };
  const callsBefore = server.calls.length;
  try {
    const response = await dispatchControlWrite(
      prepared.session,
      fixture.restWrite.connectorId,
      prepared.nonce,
      `control_${boundary}`,
    );
    const responseBody = await response.json();
    expect({ status: response.status, body: responseBody }).toMatchObject({
      status: boundary === "placement" ? 409 : 403,
      body: {
        error:
          boundary === "placement"
            ? "custom_connector_organisation_placement_conflict"
            : "custom_connector_write_forbidden",
      },
    });
    expect(server.calls.length - callsBefore).toBe(
      boundary === "release" ? 1 : 0,
    );
    if (boundary === "placement") {
      for (const database of [env.DB, fixtureDatabase()])
        await database
          .prepare(
            "UPDATE organisation_placement SET status = 'active', frozen_at = NULL WHERE organisation_id = ? AND placement_epoch = 1",
          )
          .bind(ORGANISATION_ID)
          .run();
    }
    await evictDurableObject(prepared.organisation);
    const retained = await prepared.organisation.getAction({
      organisationId: ORGANISATION_ID,
      nonce: prepared.nonce,
      now: Date.now(),
    });
    expect(retained).toMatchObject({
      ok: true,
      value: {
        state:
          boundary === "release"
            ? "confirmed"
            : boundary === "placement"
              ? "executing"
              : "failed",
      },
    });
    if (boundary === "role") {
      await fixtureDatabase()
        .prepare(
          "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ? AND user_id = ?",
        )
        .bind(ORGANISATION_ID, prepared.session.session.userId)
        .run();
    }
    const fresh = await issueControlSession({
      db: env.DB,
      userId: prepared.session.session.userId,
      now: Date.now(),
      ttlMs: 600_000,
    });
    const replay = await dispatchControlWrite(
      fresh,
      fixture.restWrite.connectorId,
      prepared.nonce,
      `fresh_${boundary}`,
    );
    if (boundary !== "placement") expect(replay.status).toBe(200);
    expect(server.calls.length - callsBefore).toBe(
      boundary === "release" ? 1 : 0,
    );
    const next = await prepareConnectorWrite({
      fixture,
      server,
      entry: fixture.restWrite,
      grantId: REST_WRITE_GRANT_ID,
      suffix: `fresh_control_${boundary}`,
      grantDisposition: "retain",
      timeoutMs: fixture.restWrite.limits.invocationTimeoutMs,
    });
    const allowed = await dispatchControlWrite(
      next.session,
      fixture.restWrite.connectorId,
      next.nonce,
      `allowed_${boundary}`,
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      ok: true,
      action: { state: "confirmed" },
    });
    await evictDurableObject(next.organisation);
    const repeated = await dispatchControlWrite(
      next.session,
      fixture.restWrite.connectorId,
      next.nonce,
      `repeat_${boundary}`,
    );
    expect(repeated.status).toBe(200);
    expect(server.calls.length - callsBefore).toBe(
      boundary === "release" ? 2 : 1,
    );
    Object.assign(task.meta, {
      controlWriteOrigin: {
        boundary,
        protectedReleaseDenied: true,
        providerRequests: server.calls.length - callsBefore,
        retainedAfterEviction: true,
        simulatedEgressContainer: true,
      },
    });
  } finally {
    controlWriteProbe = null;
  }
}

it(
  "retries an indeterminate provider-idempotent REST write once with the same key and refuses a retry of a single-attempt write",
  { timeout: 60_000 },
  idempotentWriteRetryJourney,
);

async function idempotentWriteRetryJourney({ task }: TestContext) {
  await installSlackActorFixture();
  const server = new RemoteFixture();
  network.use(http.get("https://cloudflare-dns.com/dns-query", dnsResponse));
  const fixture = await installRemoteConnector(server);
  const prepared = await prepareConnectorWrite({
    fixture,
    server,
    entry: fixture.restWrite,
    grantId: REST_WRITE_GRANT_ID,
    suffix: "idempotent_retry",
    grantDisposition: "retain",
    timeoutMs: fixture.restWrite.limits.invocationTimeoutMs,
  });
  controlWriteProbe = {
    boundary: null,
    server,
    session: prepared.session,
    armed: false,
  };
  try {
    // The service applies the write, and its answer is lost.
    server.fault = { kind: "rest_response_lost" };
    const lost = await dispatchControlWrite(
      prepared.session,
      fixture.restWrite.connectorId,
      prepared.nonce,
      "idempotent_execute",
    );
    expect({ status: lost.status, body: await lost.json() }).toMatchObject({
      status: 202,
      body: {
        action: {
          state: "indeterminate",
          retryPolicy: {
            kind: "provider_idempotent",
            header: "idempotency-key",
          },
        },
      },
    });
    // Another execute does not resend the write.
    const executedAgain = await dispatchControlWrite(
      prepared.session,
      fixture.restWrite.connectorId,
      prepared.nonce,
      "idempotent_execute_again",
    );
    expect(executedAgain.status).toBe(202);
    expect(server.calls).toEqual(["account", "rest_create"]);

    // The administrator retries; the service sees the same key once more.
    await evictDurableObject(prepared.organisation);
    const retried = await dispatchControlWrite(
      prepared.session,
      fixture.restWrite.connectorId,
      prepared.nonce,
      "idempotent_retry",
      "retry",
    );
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      ok: true,
      action: { state: "confirmed" },
    });
    expect(server.calls).toEqual([
      "account",
      "rest_create",
      "rest_create_replayed",
    ]);
    const [firstKey, retryKey] = server.writeKeys;
    expect(firstKey).toMatch(/^pantry-[0-9a-f]{64}$/u);
    expect(retryKey).toBe(firstKey);
    expect(firstKey).not.toContain(fixture.restWrite.integrationAccountId);

    // A settled write cannot be retried again.
    const settled = await dispatchControlWrite(
      prepared.session,
      fixture.restWrite.connectorId,
      prepared.nonce,
      "idempotent_retry_again",
      "retry",
    );
    expect(settled.status).toBe(200);
    expect(server.calls).toHaveLength(3);

    // A single-attempt write with an unknown outcome is never resent.
    const single = await prepareConnectorWrite({
      fixture,
      server,
      entry: fixture.mcpWrite,
      grantId: MCP_WRITE_GRANT_ID,
      suffix: "single_attempt_retry",
      grantDisposition: "retain",
      timeoutMs: fixture.mcpWrite.limits.invocationTimeoutMs,
    });
    server.fault = { kind: "response_lost" };
    const uncertain = await dispatchControlWrite(
      single.session,
      fixture.mcpWrite.connectorId,
      single.nonce,
      "single_execute",
    );
    expect(uncertain.status).toBe(202);
    server.fault = { kind: "none" };
    const callsBefore = server.calls.length;
    const refused = await dispatchControlWrite(
      single.session,
      fixture.mcpWrite.connectorId,
      single.nonce,
      "single_retry",
      "retry",
    );
    expect({
      status: refused.status,
      body: await refused.json(),
    }).toMatchObject({
      status: 409,
      body: { error: "custom_connector_retry_unsupported" },
    });
    expect(server.calls).toHaveLength(callsBefore);
    Object.assign(task.meta, {
      idempotentWriteRetry: {
        providerCalls: server.calls,
        sameKeyOnRetry: retryKey === firstKey,
        keyNamesNoAccount: true,
        singleAttemptRetryStatus: refused.status,
        simulatedEgressContainer: true,
      },
    });
  } finally {
    controlWriteProbe = null;
  }
}

async function installRemainingControlOwner(): Promise<void> {
  const userId = newUserId();
  const personId = `person_${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO app_user (user_id, issuer, subject, email, display_name, email_verified, created_at, last_authenticated_at) VALUES (?, 'https://identity.example.invalid', ?, ?, 'Remaining owner', 1, ?, ?)",
    ).bind(userId, userId, `${userId}@example.invalid`, now, now),
  ]);
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, 'Remaining owner')",
      )
      .bind(ORGANISATION_ID, personId),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'owner', 'active', ?, NULL)",
      )
      .bind(ORGANISATION_ID, userId, personId, now),
  ]);
}

function controlWriteBinding(
  target: typeof env,
  property: string | symbol,
): unknown {
  return property === "CUSTOM_CONNECTOR_FETCH"
    ? { getByName: controlWriteTransport }
    : Reflect.get(target, property);
}

function controlWriteTransport(): { fetch: typeof controlWriteEgress } {
  return { fetch: controlWriteEgress };
}

async function controlWriteEgress(
  url: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const probe = controlWriteProbe;
  if (probe === null) throw new Error("Missing control write probe");
  const response = await probe.server.fetch(url, init);
  if (probe.armed && probe.boundary === "release") {
    probe.armed = false;
    await revokeControlWriteOrigin(probe);
  }
  return response;
}

async function controlWriteDns(
  input: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const probe = controlWriteProbe;
  if (probe !== null && probe.armed && probe.boundary !== "release") {
    probe.armed = false;
    if (probe.boundary === "placement") {
      for (const database of [env.DB, fixtureDatabase()])
        await database
          .prepare(
            "UPDATE organisation_placement SET status = 'frozen', frozen_at = ? WHERE organisation_id = ? AND placement_epoch = 1",
          )
          .bind(Date.now(), ORGANISATION_ID)
          .run();
    } else if (probe.boundary === "role") {
      await fixtureDatabase()
        .prepare(
          "UPDATE service_role_grant SET role = 'operator' WHERE organisation_id = ? AND user_id = ?",
        )
        .bind(ORGANISATION_ID, probe.session.session.userId)
        .run();
    }
  }
  return dnsResponse(input);
}

async function revokeControlWriteOrigin(
  probe: ControlWriteProbe,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
  )
    .bind(Date.now(), probe.session.session.controlSessionId)
    .run();
}

it(
  "shows a waiting custom connector write only to an owner or admin, and the commerce decide routes refuse its nonce while the write keeps waiting",
  { timeout: 60_000 },
  commerceRoutesRefuseCustomWriteJourney,
);

/**
 * Refactor 17 review: a write of a custom connector waits in the same ledger
 * as a commerce action, but it has its own read and its own decide routes. A
 * viewer's list of decisions does not hold it; an admin's list does. The
 * commerce approval (with a valid step-up grant), rejection and execution
 * routes answer 404 for its nonce, and the write still waits for a decision.
 */
async function commerceRoutesRefuseCustomWriteJourney({ task }: TestContext) {
  await installSlackActorFixture();
  const server = new RemoteFixture();
  network.use(http.get("https://cloudflare-dns.com/dns-query", dnsResponse));
  const fixture = await installRemoteConnector(server);
  const prepared = await prepareConnectorWrite({
    fixture,
    server,
    entry: fixture.restWrite,
    grantId: REST_WRITE_GRANT_ID,
    suffix: "commerce_route_refusal",
    grantDisposition: "retain",
    timeoutMs: fixture.restWrite.limits.invocationTimeoutMs,
    approval: "requested",
  });
  const waiting = { kind: "governed_action", id: prepared.nonce };
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const ledgerState = async (): Promise<string> => {
    const entry = await organisation.getAction({
      organisationId: ORGANISATION_ID,
      nonce: prepared.nonce,
      now: Date.now(),
    });
    if (!entry.ok) throw new Error(entry.error.code);
    return entry.value.state;
  };
  try {
    // 1. Only a member who decides the write sees it in the list.
    await setActorRole("viewer");
    const viewerList = await pendingDecisionsOf(
      ORGANISATION_ID,
      prepared.session,
    );
    await setActorRole("admin");
    const adminList = await pendingDecisionsOf(
      ORGANISATION_ID,
      prepared.session,
    );
    expect(viewerList).not.toContainEqual(waiting);
    expect(adminList).toContainEqual(waiting);

    // 2. The commerce decide routes refuse the nonce of the write.
    const action = await organisation.getAction({
      organisationId: ORGANISATION_ID,
      nonce: prepared.nonce,
      now: Date.now(),
    });
    if (!action.ok) throw new Error(action.error.code);
    const config = googleConfig(env);
    if (config === null) throw new Error("Missing approval configuration");
    const grant = await completeCommerceApprovalFixture({
      db: env.DB,
      config,
      action: action.value.action,
      userId: prepared.session.session.userId,
      subject: "e2e-slack-actor",
      email: "e2e-slack-actor@example.invalid",
      stepUpId: "custom-write-commerce-route",
    });
    const commerceDecision = async (
      suffix: "approval" | "rejection" | "execute",
      body: Readonly<Record<string, unknown>>,
    ) => {
      const headers = commerceHeaders(prepared.session);
      headers.set("idempotency-key", `commerce-route-${suffix}`);
      headers.set(
        "cookie",
        `${headers.get("cookie") ?? ""}; ${APPROVAL_GRANT_COOKIE}=${grant}`,
      );
      const response = await exports.default.fetch(
        `https://localhost/v1/control/organisations/${ORGANISATION_ID}/commerce/actions/${prepared.nonce}/${suffix}`,
        { method: "POST", headers, body: JSON.stringify(body) },
      );
      return { status: response.status, body: await response.json() };
    };
    const refused = {
      status: 404,
      body: { ok: false, error: "commerce_action_not_found" },
    };
    const approval = await commerceDecision("approval", {});
    const rejection = await commerceDecision("rejection", {
      reason: "merchant_declined",
    });
    const execution = await commerceDecision("execute", {});
    expect({ approval, rejection, execution }).toEqual({
      approval: refused,
      rejection: refused,
      execution: refused,
    });
    const state = await ledgerState();
    expect(state).toBe("approval_requested");
    expect(server.calls).not.toContain("rest_create");
    Object.assign(task.meta, {
      commerceRoutesRefuseCustomWrite: {
        viewerSeesWrite: viewerList.some((item) => item.id === waiting.id),
        adminSeesWrite: adminList.some((item) => item.id === waiting.id),
        approvalStatus: approval.status,
        rejectionStatus: rejection.status,
        executionStatus: execution.status,
        ledgerState: state,
      },
    });
  } finally {
    await setActorRole("owner");
  }
}

it(
  "refuses a viewer's rejection of a custom connector write and a rejection with no reason, then the owner's rejection takes the write out of the decisions that wait, and the write never runs",
  { timeout: 60_000 },
  rejectedWriteJourney,
);

/**
 * Refactor 17, step A2.1: a write of a custom connector has a refusal, as a
 * commerce action has. The agent proposed the write, and it waits for an
 * owner or admin. A viewer may not reject, and a rejection carries the one
 * reason. The owner rejects: the write leaves the one read of the decisions,
 * a later run is refused, and the remote service never sees the write.
 */
async function rejectedWriteJourney({ task }: TestContext) {
  await installSlackActorFixture();
  const server = new RemoteFixture();
  network.use(http.get("https://cloudflare-dns.com/dns-query", dnsResponse));
  const fixture = await installRemoteConnector(server);
  const prepared = await prepareConnectorWrite({
    fixture,
    server,
    entry: fixture.restWrite,
    grantId: REST_WRITE_GRANT_ID,
    suffix: "rejected_write",
    grantDisposition: "retain",
    timeoutMs: fixture.restWrite.limits.invocationTimeoutMs,
    approval: "requested",
  });
  controlWriteProbe = {
    boundary: null,
    server,
    session: prepared.session,
    armed: false,
  };
  const connectorId = fixture.restWrite.connectorId;
  const waiting = { kind: "governed_action", id: prepared.nonce };
  try {
    expect(
      await pendingDecisionsOf(ORGANISATION_ID, prepared.session),
    ).toContainEqual(waiting);

    // 1. A viewer may not reject, and a rejection carries its one reason.
    await setActorRole("viewer");
    const byViewer = await dispatchControlWrite(
      prepared.session,
      connectorId,
      prepared.nonce,
      "reject_as_viewer",
      "rejection",
      { reason: "merchant_declined" },
    );
    await setActorRole("owner");
    expect({
      status: byViewer.status,
      body: await byViewer.json(),
    }).toEqual({
      status: 404,
      body: { ok: false, error: "organisation_role_insufficient" },
    });
    const noReason = await dispatchControlWrite(
      prepared.session,
      connectorId,
      prepared.nonce,
      "reject_without_reason",
      "rejection",
    );
    expect(noReason.status).toBe(422);

    // 2. The owner rejects. The write leaves the decisions that wait.
    const rejected = await dispatchControlWrite(
      prepared.session,
      connectorId,
      prepared.nonce,
      "reject_as_owner",
      "rejection",
      { reason: "merchant_declined" },
    );
    expect({
      status: rejected.status,
      body: await rejected.json(),
    }).toMatchObject({
      status: 200,
      body: { ok: true, action: { state: "rejected" } },
    });
    expect(
      await pendingDecisionsOf(ORGANISATION_ID, prepared.session),
    ).not.toContainEqual(waiting);

    // 3. A later run is refused, and the service never sees the write.
    const run = await dispatchControlWrite(
      prepared.session,
      connectorId,
      prepared.nonce,
      "run_after_rejection",
    );
    expect(run.status).toBe(409);
    expect(server.calls).not.toContain("rest_create");
    Object.assign(task.meta, {
      rejectedWrite: {
        viewerStatus: byViewer.status,
        noReasonStatus: noReason.status,
        ownerState: "rejected",
        runAfterRejectionStatus: run.status,
        providerCalls: server.calls,
      },
    });
  } finally {
    controlWriteProbe = null;
  }
}

async function setActorRole(
  role: "owner" | "admin" | "viewer",
): Promise<void> {
  await fixtureDatabase()
    .prepare(
      `UPDATE service_role_grant SET role = ?
     WHERE organisation_id = ? AND person_id = 'person_e2e-slack-actor'`,
    )
    .bind(role, ORGANISATION_ID)
    .run();
}

function dispatchControlWrite(
  session: IssuedControlSession,
  connectorId: string,
  nonce: string,
  key: string,
  action: "execute" | "retry" | "rejection" = "execute",
  body: Readonly<Record<string, unknown>> = {},
): Promise<Response> {
  const request = new Request(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/custom-connectors/${connectorId}/actions/${nonce}/${action}`,
    {
      method: "POST",
      headers: {
        origin: "https://localhost",
        "content-type": "application/json",
        "idempotency-key": key,
        cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
        "x-pantry-csrf": session.csrfToken,
      },
      body: JSON.stringify(body),
    },
  );
  const route = matchCustomConnectorControlRoute(new URL(request.url).pathname);
  if (route === null) throw new Error("Missing custom connector write route");
  return handleCustomConnectorControlRoute(
    request,
    new Proxy(env, { get: controlWriteBinding }),
    route,
    decidePendingDecisionWith(new Proxy(env, { get: controlWriteBinding })),
  );
}

type RemoteConnectorFixture = {
  readonly accountAccess: import("@purin-labs/tenancy/organisation-access/access").OrganisationAccess;
  readonly nativeSessionId: string;
  readonly entry: CustomConnectorReadCatalogEntry;
  readonly effective: Extract<
    Awaited<ReturnType<typeof compileTurnAuthority>>,
    { ok: true }
  >["value"]["effectiveGrantSet"];
  readonly authority: Parameters<
    typeof authorizeCustomConnectorRead
  >[0]["destinationAuthority"];
  readonly binding: FlowBinding;
  readonly partition: AuthorityPartition;
  readonly restRead: CustomConnectorReadCatalogEntry;
  readonly restWrite: CustomConnectorWriteCatalogEntry;
  readonly mcpWrite: CustomConnectorWriteCatalogEntry;
};

it("settles reviewed MCP writes from dispatch state and bounds stalled cleanup and reads", async ({
  task,
}) => {
  await installSlackActorFixture();
  const server = new RemoteFixture();
  network.use(http.get("https://cloudflare-dns.com/dns-query", dnsResponse));
  const fixture = await installRemoteConnector(server);
  const actions = [];
  for (const fault of [
    "missing_tool",
    "initialize_failed",
    "response_lost",
    "stalled_cleanup",
  ] as const) {
    server.fault = { kind: fault };
    const startedAt = Date.now();
    const action = await executeConnectorWrite({
      fixture,
      server,
      entry: fixture.mcpWrite,
      grantId: MCP_WRITE_GRANT_ID,
      suffix: fault,
      grantDisposition: "retain",
      timeoutMs: fixture.mcpWrite.limits.invocationTimeoutMs,
    });
    const elapsedMs = Date.now() - startedAt;
    actions.push({ fault, elapsedMs, action });
    switch (fault) {
      case "missing_tool":
      case "initialize_failed":
        expect(action.state).toBe("failed");
        expect(server.calls).toEqual(["account"]);
        break;
      case "response_lost":
        expect(action.state).toBe("indeterminate");
        expect(server.calls).toEqual(["account", "write_record"]);
        break;
      case "stalled_cleanup":
        expect(action.state).toBe("confirmed");
        expect(elapsedMs).toBeLessThan(3_000);
        expect(server.aborts).toContain("cleanup");
        expect(server.calls).toEqual([
          "account",
          "write_record",
          "write_record",
        ]);
        break;
      default:
        assertNever(fault);
    }
  }
  const boundary = new RemoteBoundary(fixture, server, fixture.entry);
  boundary.invocationTimeoutMs = 500;
  const cancellations = [];
  for (const fault of ["stalled_read", "stalled_body"] as const) {
    server.fault = { kind: fault };
    const startedAt = Date.now();
    const result = await boundary.executeTool(fixture.entry.toolName, "{}");
    const elapsedMs = Date.now() - startedAt;
    expect(result.status).toBe("failed");
    expect(elapsedMs).toBeLessThan(2_000);
    expect(server.aborts).toContain(fault);
    cancellations.push({ fault, elapsedMs, result });
  }
  const callsBeforeDns = server.calls.length;
  boundary.transport = executeWithStalledDns;
  const dnsStartedAt = Date.now();
  const dnsCancelled = await boundary.executeTool(fixture.entry.toolName, "{}");
  expect(dnsCancelled.status).toBe("failed");
  expect(Date.now() - dnsStartedAt).toBeLessThan(2_000);
  expect(server.calls).toHaveLength(callsBeforeDns);
  Object.assign(task.meta, {
    reviewedConnectorP2Evidence: {
      actions,
      cancellations,
      dnsCancelled,
      remoteCalls: server.calls,
      aborts: server.aborts,
      boundary:
        "Real D1/Vault, Pi MCP client and Organisation Actor action ledger; simulated pinned egress, failed handshakes, response loss and stalled cleanup/body",
    },
  });
});

it("reads a reviewed connector through the Slack Actor after discovery outlives the old turn-based deadline", async ({
  task,
}) => {
  const slackFixture = await installSlackActorFixture();
  const server = new RemoteFixture();
  network.use(http.get("https://cloudflare-dns.com/dns-query", dnsResponse));
  const fixture = await installRemoteConnector(server);
  const sourceGrant = await readAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: GRANT_ID,
  });
  if (!sourceGrant.ok) throw new Error(sourceGrant.error.code);
  const channelGrant = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: "grant_e2e_connector_slack_read",
    subject: {
      kind: "conversation",
      integrationAccountId: slackFixture.selectedIntegrationAccountId,
      conversationId: CHANNEL_ID,
    },
    target: sourceGrant.value.target,
    provenance: sourceGrant.value.provenance,
    now: Date.now(),
  });
  if (!channelGrant.ok) throw new Error(channelGrant.error.code);
  const slack = slackSimulator();
  const model = new DelayedConnectorModel(fixture.entry.toolName, server);
  const warnings = vi.spyOn(console, "warn");
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
    slack.handler,
  );
  Object.assign(task.meta, {
    connectorDeadlineEvidence: {
      discoveryDelayMs: 31_000,
      requests: model.requests,
      remoteCalls: server.calls,
      delivered: slack.messages,
      warnings: warnings.mock.calls,
    },
  });
  const startedAt = Date.now();
  try {
    const response = await exports.default.fetch(
      await signedSlackRequest(
        slackEnvelope({
          eventType: "app_mention",
          eventId: "EvDelayedConnectorRead",
          messageTs: ROOT_TS,
          threadTs: ROOT_TS,
          text: "<@U0PANTRY> Discover the reviewed supplier inventory and read it.",
        }),
      ),
    );
    expect(response.status).toBe(200);
    await expect.poll(slack.visibleMessageCount, { timeout: 50_000 }).toBe(1);
    expect(slack.messages[0]?.text).toBe("DELAYED_CONNECTOR_READ_7");
    expect(server.calls).toEqual(["account", "inventory_read"]);
  } finally {
    const actors = await inspectSlackActors(slackFixture.connectorId);
    Object.assign(task.meta, {
      connectorDeadlineEvidence: {
        discoveryDelayMs: 31_000,
        elapsedMs: Date.now() - startedAt,
        requests: model.requests,
        remoteCalls: server.calls,
        session: actors.session,
        connector: actors.connector,
        case: actors.case,
        delivered: slack.messages,
        warnings: warnings.mock.calls,
      },
    });
    await runInDurableObject(await connectorSessionStub(), clearActorEgress);
    warnings.mockRestore();
  }
}, 60_000);

async function executeWithStalledDns(
  input: Parameters<typeof executeCustomConnectorTransport>[0],
) {
  return executeCustomConnectorTransport({ ...input, dohFetcher: stalledDns });
}

async function stalledDns(
  _url: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  await delay(15_000, undefined, { signal: init?.signal ?? undefined });
  throw new Error("DNS fixture exceeded cancellation deadline");
}

class DelayedConnectorModel {
  readonly requests: Record<string, unknown>[] = [];
  constructor(
    readonly tool: string,
    readonly server: RemoteFixture,
  ) {}
  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const raw: unknown = await request.json();
    if (!isRecord(raw))
      throw new Error("Invalid delayed connector model request");
    this.requests.push(raw);
    switch (this.requests.length) {
      case 1:
        await runInDurableObject(
          await connectorSessionStub(),
          installActorEgress.bind(null, this.server),
        );
        await delay(31_000);
        return openRouterToolCall(
          "tool_search",
          { query: this.tool },
          "delayed_connector_search",
        );
      case 2:
        return openRouterToolCall(this.tool, {}, "delayed_connector_read");
      case 3: {
        const content: unknown = JSON.parse(requireLastToolOutput(raw));
        if (typeof content !== "string")
          throw new Error("Missing serialized connector output");
        const result: unknown = JSON.parse(content);
        expect(result).toMatchObject({
          success: true,
          code_mode_value: { count: 7 },
        });
        return openRouterText(
          "DELAYED_CONNECTOR_READ_7",
          "delayed_connector_done",
        );
      }
      default:
        throw new Error("Unexpected delayed connector model request");
    }
  }
}

async function connectorSessionStub() {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'session' AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string }>();
  if (row === null) throw new Error("Missing connector Session Actor");
  return env.SESSION.getByName(row.name);
}

function installActorEgress(server: RemoteFixture, actor: object): void {
  const bindings = Reflect.get(actor, "env");
  if (!isRecord(bindings)) throw new Error("Missing Actor environment");
  if (bindings.CUSTOM_CONNECTOR_FETCH instanceof RemoteFixture)
    throw new Error(
      "Connector fixture would replace an existing egress binding",
    );
  Object.defineProperty(bindings, "CUSTOM_CONNECTOR_FETCH", {
    configurable: true,
    value: server,
  });
  Object.defineProperty(bindings, "SESSION_TOKEN_SECRET", {
    configurable: true,
    value: "connector-e2e-cursor-signing-key-00000000",
  });
}

function clearActorEgress(actor: object): void {
  const bindings = Reflect.get(actor, "env");
  if (!isRecord(bindings)) throw new Error("Missing Actor environment");
  // The Actor and this file share one environment: give the class back.
  Object.defineProperty(bindings, "CUSTOM_CONNECTOR_FETCH", {
    configurable: true,
    value: CLASS_EGRESS,
  });
  Object.defineProperty(bindings, "SESSION_TOKEN_SECRET", {
    configurable: true,
    value: env.SESSION_TOKEN_SECRET,
  });
}

async function installRemoteConnector(
  server: RemoteFixture,
): Promise<RemoteConnectorFixture> {
  const parsedAdmin = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!parsedAdmin.ok) throw new Error(parsedAdmin.error.code);
  const admin = parsedAdmin.value;
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, admin)
    .run();
  const raw = connectorDocument();
  const document = await prepareCustomConnectorDraftDocument(raw);
  if (!document.ok) throw new Error(JSON.stringify(document.error));
  const draft = await createCustomConnectorDraft({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    createdByUserId: admin,
    document: document.value,
    now: Date.now(),
  });
  const validated = await validateCustomConnectorRevision({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    connectorId: draft.connectorId,
    revision: draft.revision,
    authoringDigest: draft.authoringDigest,
    now: Date.now(),
  });
  if (!validated.ok || validated.value.reviewState !== "validated")
    throw new Error(
      `Connector definition invalid: ${JSON.stringify(validated)}`,
    );
  const approved = await approveCustomConnectorRevision({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    connectorId: draft.connectorId,
    revision: draft.revision,
    definitionDigest: validated.value.definitionDigest,
    approvedByUserId: admin,
    review: {
      origin: ORIGIN,
      effects: [
        { operationId: "account", effect: "read" },
        { operationId: "inventory_read", effect: "read" },
        { operationId: "rest_create", effect: "external_record_create" },
        { operationId: "rest_inventory", effect: "read" },
        { operationId: "write_record", effect: "external_record_create" },
      ],
    },
    now: Date.now(),
  });
  if (!approved.ok || approved.value.reviewState !== "approved")
    throw new Error(`Connector approval failed: ${JSON.stringify(approved)}`);
  const started = await startCustomConnectorSetup({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    connectorId: draft.connectorId,
    connectorRevision: draft.revision,
    definitionDigest: approved.value.definitionDigest,
    target: { kind: "new_account", environment: "development" },
    createdByUserId: admin,
    now: Date.now(),
  });
  if (!started.ok) throw new Error(started.error.code);
  const attached = await attachCustomConnectorCandidateCredential({
    db: fixtureDatabase(),
    keys: env,
    organisationId: ORGANISATION_ID,
    attemptId: started.value.attemptId,
    expectedAttemptRevision: started.value.attemptRevision,
    credentialValue: SECRET,
    now: Date.now(),
  });
  if (!attached.ok) throw new Error(attached.error.code);
  const tested = await testCustomConnectorCandidate({
    db: fixtureDatabase(),
    keys: env,
    organisationId: ORGANISATION_ID,
    attemptId: attached.value.attemptId,
    expectedAttemptRevision: attached.value.attemptRevision,
    executor: createCustomConnectorIdentityTestExecutor(server),
    now: Date.now(),
  });
  if (!tested.ok) throw new Error(tested.error.code);
  const authorization = await authorizeCustomConnectorSetupCommit({
    db: fixtureDatabase(),
    keys: env,
    organisationId: ORGANISATION_ID,
    attemptId: tested.value.attempt.attemptId,
    expectedAttemptRevision: tested.value.attempt.attemptRevision,
    now: Date.now(),
  });
  if (!authorization.ok) throw new Error(authorization.error.code);
  const config = await fixtureDatabase()
    .prepare(
      "SELECT configuration_version AS version FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first<{ version: number }>();
  if (config === null) throw new Error("Missing onboarding version");
  const committed = await commitNewCustomConnectorAccount({
    db: fixtureDatabase(),
    authorization: authorization.value,
    committedByUserId: admin,
    expectedConfigurationVersion: config.version,
    now: Date.now(),
  });
  if (!committed.ok) throw new Error(committed.error.code);
  const target = {
    kind: "custom_connector_operation" as const,
    capabilityId: "custom_connector.read",
    capabilityVersion: 1,
    integrationAccountId: committed.value.integrationAccountId,
    connectorId: draft.connectorId,
    definitionRevision: draft.revision,
    definitionDigest: approved.value.definitionDigest,
    operationId: "inventory_read",
  };
  for (const operation of [
    {
      id: "inventory_read",
      grantId: GRANT_ID,
      capabilityId: "custom_connector.read",
    },
    {
      id: "rest_inventory",
      grantId: "grant_e2e_rest_read",
      capabilityId: "custom_connector.read",
    },
    {
      id: "rest_create",
      grantId: REST_WRITE_GRANT_ID,
      capabilityId: "custom_connector.write",
    },
    {
      id: "write_record",
      grantId: MCP_WRITE_GRANT_ID,
      capabilityId: "custom_connector.write",
    },
  ]) {
    const grant = await createAccessGrant({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      grantId: operation.grantId,
      subject: { kind: "organisation_role", role: "owner" },
      target: {
        ...target,
        operationId: operation.id,
        capabilityId: operation.capabilityId,
      },
      provenance: {
        kind: "operator",
        userId: admin,
        mutationReceiptId: `mutation_${operation.grantId}`,
      },
      now: Date.now(),
    });
    if (!grant.ok) throw new Error(grant.error.code);
  }
  for (const capabilityId of [
    "custom_connector.read",
    "custom_connector.write",
  ] as const) {
    const policies = await readOrganisationCapabilityPolicies({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
    });
    if (!policies.ok) throw new Error(policies.error.code);
    const capabilityPolicy = policies.value.find(
      matchesCapability.bind(null, capabilityId),
    );
    if (capabilityPolicy === undefined)
      throw new Error("Missing connector policy");
    const projection = await fixtureDatabase()
      .prepare(
        "SELECT projection_revision AS revision FROM organisation_onboarding WHERE organisation_id = ?",
      )
      .bind(ORGANISATION_ID)
      .first<{ revision: number }>();
    if (projection === null) throw new Error("Missing projection revision");
    const enabled = await changeVersionedCapabilityPolicy({
      scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),

      capabilityId,
      capabilityVersion: 1,
      mode:
        capabilityId === "custom_connector.write"
          ? "approval_required"
          : "enabled",
      expectedProjectionRevision: projection.revision,
      expectedCapabilityRevision: capabilityPolicy.revision,
      actorUserId: admin,
      identity: newControlMutationIdentity({
        portalSubjectHash: "fixture-capability-operator",
        causationId: `mutation_mcp_enable_${capabilityId}`,
        now: Date.now(),
      }),
      boundary: {
        kind: "unversioned",
        idempotencyKey: `mutation_mcp_enable_${capabilityId}`,
        requestHash: "fixture-capability-request",
      },
    });
    if (!enabled.ok) throw new Error(enabled.error.code);
  }
  await activateConnectorOrganisation();
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now: Date.now(),
  });
  if (!policy.ok) throw new Error(policy.error.code);
  expect(policy.value.snapshot.authz.allowedTools).toContain(
    "custom_connector.read",
  );
  const currentConfiguration = await fixtureDatabase()
    .prepare(
      "SELECT configuration_version AS revision FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first<{ revision: number }>();
  if (currentConfiguration === null)
    throw new Error("Missing current membership revision");
  const authority = {
    kind: "control" as const,
    organisationId: ORGANISATION_ID,
    requesterPersonId: "person_e2e-slack-actor",
    userId: admin,
    membershipRevision: currentConfiguration.revision,
    role: "owner",
  };
  const executionScope = await requireOrganisationExecutionScope(
    env,
    ORGANISATION_ID,
  );
  const controlSession = await issueControlSession({
    db: env.DB,
    userId: admin,
    now: Date.now(),
    ttlMs: 1_800_000,
  });
  const effective = await compileTurnAuthority({
    db: fixtureDatabase(),
    accountAccess: executionScope.accountAccess,
    userAuthority: {
      kind: "authenticated_session",
      nativeSessionId: controlSession.session.controlSessionId,
    },
    action: "execute",
    organisationId: ORGANISATION_ID,
    requestAuthority: authority,
    policy: { version: policy.value.snapshot.version },
  });
  if (!effective.ok) throw new Error(effective.error.code);
  const catalog = await compileCustomConnectorReadCatalog({
    db: fixtureDatabase(),
    effectiveGrants: effective.value.effectiveGrantSet,
  });
  if (!catalog.ok) throw new Error(catalog.error.code);
  const entry = catalog.value.find(
    matchesOperation.bind(null, "inventory_read"),
  );
  const restRead = catalog.value.find(
    matchesOperation.bind(null, "rest_inventory"),
  );
  const writes = await compileCustomConnectorWriteCatalog({
    db: fixtureDatabase(),
    effectiveGrants: effective.value.effectiveGrantSet,
  });
  if (!writes.ok) throw new Error(writes.error.code);
  const restWrite = writes.value.find(
    matchesOperation.bind(null, "rest_create"),
  );
  const mcpWrite = writes.value.find(
    matchesOperation.bind(null, "write_record"),
  );
  if (
    entry === undefined ||
    restRead === undefined ||
    restWrite === undefined ||
    mcpWrite === undefined
  )
    throw new Error("Missing reviewed connector operation");
  const context = await InformationFlowContext.create({
    organisationId: ORGANISATION_ID,
    sessionId: "session_mcp",
    authorityPartitionDigest: effective.value.authorityPartition.digest,
  });
  if (!context.ok) throw new Error(context.error.code);
  return {
    accountAccess: executionScope.accountAccess,
    nativeSessionId: controlSession.session.controlSessionId,
    entry,
    restRead,
    restWrite,
    mcpWrite,
    partition: effective.value.authorityPartition,
    effective: effective.value.effectiveGrantSet,
    authority,
    binding: FlowBinding.fromContext(context.value, "turn_mcp"),
  };
}

function connectorDocument() {
  return {
    schemaVersion: 1,
    name: "Supplier MCP",
    description: "Reviewed supplier reads.",
    origin: ORIGIN,
    authentication: { kind: "bearer" },
    documentation: [{ url: `${ORIGIN}/docs`, sha256: "3".repeat(64) }],
    operations: [
      mcpOperation("account", { id: boundedString(), name: boundedString() }),
      mcpOperation("inventory_read", {
        count: { type: "integer", minimum: 0, maximum: 100 },
      }),
      restOperation("rest_inventory", "read"),
      restOperation("rest_create", "external_record_create"),
      mcpWriteOperation(),
    ],
    identity: {
      operationId: "account",
      arguments: {},
      accountIdPointer: "/id",
      displayNamePointer: "/name",
    },
    limits: {},
  };
}

async function activateConnectorOrganisation(): Promise<void> {
  const now = Date.now();
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_activation_attempt (
        activation_attempt_id, organisation_id, readiness_version, readiness_hash,
        status, started_at, updated_at, completed_at
      ) VALUES ('activation_attempt_connector', ?, 1, 'connector-ready',
        'completed', ?, ?, ?)`,
      )
      .bind(ORGANISATION_ID, now, now, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_activation_receipt (
        activation_receipt_id, activation_attempt_id, organisation_id, readiness_hash,
        policy_snapshot_id, cue_snapshot_id, capability_profile, activated_at
      ) VALUES ('activation_receipt_connector', 'activation_attempt_connector', ?,
        'connector-ready', 'setup_policy_connector', 'setup_cue_connector',
        'approved_provider_writes', ?)`,
      )
      .bind(ORGANISATION_ID, now),
    fixtureDatabase()
      .prepare(
        `UPDATE organisation_onboarding SET lifecycle = 'active',
        capability_profile = 'approved_provider_writes',
        activation_receipt_id = 'activation_receipt_connector', activated_at = ?
        WHERE organisation_id = ?`,
      )
      .bind(now, ORGANISATION_ID),
  ]);
}

function boundedString() {
  return { type: "string", minLength: 1, maxLength: 128 };
}

function matchesCapability(
  capabilityId: string,
  policy: { capabilityId: string },
): boolean {
  return policy.capabilityId === capabilityId;
}
function matchesOperation(
  operationId: string,
  entry: { operation: { id: string } },
): boolean {
  return entry.operation.id === operationId;
}
function isBoundedAttempt(timeoutMs: number): boolean {
  return timeoutMs > 0 && timeoutMs <= CUSTOM_CONNECTOR_LIMITS.attemptTimeoutMs;
}
function restOperation(id: string, effect: "read" | "external_record_create") {
  return {
    id,
    description: `Supplier ${id}.`,
    effect:
      effect === "read"
        ? { kind: "read" }
        : {
            kind: effect,
            retryPolicy: {
              kind: "provider_idempotent",
              header: "Idempotency-Key",
            },
          },
    inputSchema: EMPTY_SCHEMA,
    transport:
      effect === "read"
        ? {
            kind: "rest",
            method: "GET",
            pathTemplate: "/inventory",
            pathBindings: {},
            queryBindings: {},
            bodyBindings: null,
          }
        : {
            kind: "rest",
            method: "POST",
            pathTemplate: "/records",
            pathBindings: {},
            queryBindings: {},
            bodyBindings: {},
          },
    response: {
      successStatuses: [200],
      resultPointer: "",
      outputSchema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 0, maximum: 100 } },
        required: ["count"],
        additionalProperties: false,
      },
      classification: "internal",
    },
    pagination: { kind: "none" },
  };
}
function mcpOperation(name: string, properties: Record<string, object>) {
  return {
    id: name,
    description: `Read ${name}.`,
    effect: { kind: "read" },
    inputSchema: EMPTY_SCHEMA,
    transport: { kind: "mcp", endpointPath: "/mcp", toolName: name },
    response: {
      successStatuses: [200],
      resultPointer: "/structuredContent",
      outputSchema: {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
      classification: "internal",
    },
    pagination: { kind: "none" },
  };
}

function mcpWriteOperation() {
  return {
    id: "write_record",
    description: "Create a reviewed supplier record.",
    effect: {
      kind: "external_record_create",
      retryPolicy: { kind: "single_attempt" },
    },
    inputSchema: EMPTY_SCHEMA,
    transport: { kind: "mcp", endpointPath: "/mcp", toolName: "write_record" },
    response: {
      successStatuses: [200],
      resultPointer: "/structuredContent",
      outputSchema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 0, maximum: 100 } },
        required: ["count"],
        additionalProperties: false,
      },
      classification: "internal",
    },
    pagination: { kind: "none" },
  };
}

type RemoteFault =
  | { readonly kind: "none" }
  | { readonly kind: "missing_tool" }
  | { readonly kind: "initialize_failed" }
  | { readonly kind: "response_lost" }
  | { readonly kind: "rest_response_lost" }
  | { readonly kind: "stalled_cleanup" }
  | { readonly kind: "stalled_read" }
  | { readonly kind: "stalled_body" };

class RemoteFixture {
  readonly calls: string[] = [];
  /** The idempotency key of each REST write, as the service received it. */
  readonly writeKeys: (string | null)[] = [];
  /** Like an idempotent service: one stored result for each key. */
  private readonly keyedWrites = new Set<string>();
  readonly attemptTimeouts: number[] = [];
  readonly sessions = new Set<string>();
  readonly aborts: string[] = [];
  fault: RemoteFault = { kind: "none" };
  afterDiscovery: () => Promise<void> = ignoreDiscovery;
  getByName(name: string) {
    expect(name).toBe(ORGANISATION_ID);
    return { fetch: this.fetch.bind(this) };
  }
  containerOf(organisationId: string) {
    return this.getByName(organisationId);
  }
  async fetch(_url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (typeof init?.body !== "string")
      throw new Error("Missing egress envelope");
    const envelope: unknown = JSON.parse(init.body);
    if (!isRecord(envelope) || !isRecord(envelope.operation))
      throw new Error("Invalid egress envelope");
    expect(envelope.authentication).toEqual({ kind: "bearer", value: SECRET });
    expect(envelope.address).toBe("93.184.216.34");
    if (typeof envelope.timeoutMs !== "number")
      throw new Error("Missing attempt timeout");
    this.attemptTimeouts.push(envelope.timeoutMs);
    const operation = envelope.operation;
    if (operation.kind === "post_json") {
      const key =
        isRecord(envelope.idempotency) &&
        envelope.idempotency.header === "idempotency-key" &&
        typeof envelope.idempotency.key === "string"
          ? envelope.idempotency.key
          : null;
      this.writeKeys.push(key);
      const replayed = key !== null && this.keyedWrites.has(key);
      if (key !== null) this.keyedWrites.add(key);
      this.calls.push(replayed ? "rest_create_replayed" : "rest_create");
      if (this.fault.kind === "rest_response_lost") {
        this.fault = { kind: "none" };
        throw new Error("Synthetic response loss after an accepted REST write");
      }
    }
    if (operation.kind === "get" || operation.kind === "post_json") {
      expect(operation.url).toBe(
        `${ORIGIN}/${operation.kind === "get" ? "inventory" : "records"}`,
      );
      if (operation.kind === "get") this.calls.push("rest_inventory");
      return Response.json({
        status: 200,
        contentType: "application/json",
        bodyBase64: encodeBase64(new TextEncoder().encode('{"count":7}')),
      });
    }
    expect(operation.url).toBe(`${ORIGIN}/mcp`);
    if (operation.kind === "mcp_delete") {
      expect(this.sessions.delete(String(operation.sessionId))).toBe(true);
      if (this.fault.kind === "stalled_cleanup") {
        try {
          await delay(15_000, undefined, { signal: init.signal ?? undefined });
        } finally {
          if (init.signal?.aborted) this.aborts.push("cleanup");
        }
      }
      return Response.json({ status: 204, contentType: null, bodyBase64: "" });
    }
    expect(operation.kind).toBe("mcp_post");
    if (typeof operation.bodyBase64 !== "string")
      throw new Error("Missing MCP body");
    const message: unknown = JSON.parse(atob(operation.bodyBase64));
    if (!isRecord(message)) throw new Error("Invalid RPC body");
    if (
      message.method === "initialize" &&
      this.fault.kind === "initialize_failed"
    )
      throw new Error("Synthetic MCP initialization failure");
    let sessionId =
      typeof operation.sessionId === "string"
        ? operation.sessionId
        : `mcp_${crypto.randomUUID()}`;
    if (message.method === "initialize") this.sessions.add(sessionId);
    else {
      expect(this.sessions.has(sessionId)).toBe(true);
      expect(operation.protocolVersion).toBe("2025-11-25");
    }
    const response = this.respond(message);
    if (message.method === "tools/call" && isRecord(message.params)) {
      if (
        message.params.name === "write_record" &&
        this.fault.kind === "response_lost"
      )
        throw new Error("Synthetic response loss after accepted write");
      if (
        message.params.name === "inventory_read" &&
        this.fault.kind === "stalled_read"
      ) {
        try {
          await delay(15_000, undefined, { signal: init.signal ?? undefined });
        } finally {
          if (init.signal?.aborted) this.aborts.push("stalled_read");
        }
      }
      if (
        message.params.name === "inventory_read" &&
        this.fault.kind === "stalled_body"
      )
        return new Response(
          new ReadableStream<Uint8Array>({
            start: startStalledEnvelope,
            cancel: this.cancelStalledBody.bind(this),
          }),
        );
    }
    if (message.method === "tools/list") {
      const afterDiscovery = this.afterDiscovery;
      this.afterDiscovery = ignoreDiscovery;
      await afterDiscovery();
    }
    const sse =
      message.method === "tools/call" &&
      isRecord(message.params) &&
      message.params.name === "inventory_read";
    return Response.json({
      status: message.id === undefined ? 202 : 200,
      contentType: sse ? "text/event-stream" : "application/json",
      bodyBase64: encodeBase64(
        new TextEncoder().encode(
          sse
            ? `data: ${JSON.stringify(response)}\n\n`
            : JSON.stringify(response),
        ),
      ),
      sessionId,
    });
  }
  cancelStalledBody(): void {
    this.aborts.push("stalled_body");
  }
  respond(message: Record<string, unknown>): object {
    let result: object;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "supplier", version: "1" },
        };
        break;
      case "tools/list":
        result = {
          tools: [
            { name: "account", inputSchema: EMPTY_SCHEMA },
            { name: "inventory_read", inputSchema: EMPTY_SCHEMA },
            ...reviewedAdvertisedWrite(this.fault),
          ],
        };
        break;
      case "tools/call": {
        if (
          !isRecord(message.params) ||
          typeof message.params.name !== "string"
        )
          throw new Error("Invalid tool call");
        this.calls.push(message.params.name);
        result = {
          content: [],
          structuredContent:
            message.params.name === "account"
              ? { id: "supplier_1", name: "Supplier" }
              : { count: 7 },
        };
        break;
      }
      default:
        result = {};
    }
    return { jsonrpc: "2.0", id: message.id, result };
  }
}

class OriginRemoteFixture extends RemoteFixture {
  readonly requests: string[] = [];
  constructor(readonly pause: OriginPause) {
    super();
  }
  override async fetch(
    url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (typeof init?.body !== "string")
      throw new Error("Missing origin egress envelope");
    const envelope: unknown = JSON.parse(init.body);
    if (!isRecord(envelope) || !isRecord(envelope.operation))
      throw new Error("Invalid origin egress envelope");
    const operation = envelope.operation;
    let method = operation.kind;
    if (
      operation.kind === "mcp_post" &&
      typeof operation.bodyBase64 === "string"
    ) {
      const message: unknown = JSON.parse(atob(operation.bodyBase64));
      if (!isRecord(message) || typeof message.method !== "string")
        throw new Error("Invalid origin MCP request");
      method = message.method;
    }
    if (typeof method !== "string")
      throw new Error("Missing origin request method");
    if (method !== "mcp_delete" && method !== "notifications/cancelled")
      this.requests.push(method);
    const response = await super.fetch(url, init);
    if (
      this.pause.phase === "armed" &&
      ((this.pause.boundary === "discovery" && method === "tools/list") ||
        (this.pause.boundary === "response" && method === "tools/call"))
    )
      await waitOriginPause(this.pause);
    return response;
  }
}

class OriginConnectorModel {
  requests = 0;
  toolIssued = false;
  constructor(
    readonly tool: string,
    readonly server: RemoteFixture,
    public session: IssuedControlSession,
  ) {}
  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    this.requests++;
    const body: unknown = await request.json();
    if (!isRecord(body) || !Array.isArray(body.tools))
      throw new Error("Missing origin connector tools");
    if (this.toolIssued) {
      expect(requireLastToolOutput(body)).toContain("count");
      return openRouterText(
        JSON.stringify({ kind: "reply", text: "Supplier inventory reviewed." }),
        "connector_origin_done",
      );
    }
    if (!body.tools.some(hasOriginTool.bind(null, this.tool))) {
      await runInDurableObject(
        await originSessionStub(this.session),
        installActorEgress.bind(null, this.server),
      );
      return openRouterToolCall(
        "tool_search",
        { query: this.tool, limit: 1 },
        "connector_origin_discover",
      );
    }
    this.toolIssued = true;
    return openRouterToolCall(this.tool, {}, "connector_origin_read");
  }
}
function hasOriginTool(name: string, tool: unknown): boolean {
  return (
    isRecord(tool) && isRecord(tool.function) && tool.function.name === name
  );
}

function reviewedAdvertisedWrite(fault: RemoteFault) {
  return fault.kind === "missing_tool"
    ? []
    : [
        {
          name: "write_record",
          inputSchema: EMPTY_SCHEMA,
          annotations: { readOnlyHint: true },
        },
      ];
}

function startStalledEnvelope(
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  controller.enqueue(new TextEncoder().encode('{"status":200,'));
}

async function nativeMcpResponse(
  server: RemoteFixture,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const message: unknown = await request.json();
  if (!isRecord(message)) throw new Error("Invalid native RPC");
  return message.id === undefined
    ? new Response(null, { status: 202 })
    : HttpResponse.json(server.respond(message));
}
function dnsResponse({
  request,
}: Parameters<HttpResponseResolver>[0]): Response {
  return HttpResponse.json({
    Answer:
      new URL(request.url).searchParams.get("type") === "A"
        ? [{ type: 1, data: "93.184.216.34" }]
        : [],
  });
}
function toolName(tool: { name: string }): string {
  return tool.name;
}

class RemoteBoundary extends RecordingBoundary {
  execution: "active" | "cancelled" = "active";
  invocationTimeoutMs: number = CUSTOM_CONNECTOR_LIMITS.invocationTimeoutMs;
  cancelDuringAuthorization = false;
  transport: typeof executeCustomConnectorTransport =
    executeCustomConnectorTransport;
  constructor(
    readonly fixture: RemoteConnectorFixture,
    readonly server: RemoteFixture,
    readonly entry: CustomConnectorReadCatalogEntry,
  ) {
    super();
  }
  override async executeTool(
    name: string,
    raw: string,
  ): Promise<AuthorizedHarnessToolResult> {
    expect(name).toBe(this.entry.toolName);
    const authorization = await authorizeCustomConnectorRead({
      db: fixtureDatabase(),
      accountAccess: this.fixture.accountAccess,
      effectiveGrants: this.fixture.effective,
      acceptedEntry: this.entry,
      rawArguments: JSON.parse(raw),
      flowBinding: this.fixture.binding,
      destinationAuthority: this.fixture.authority,
      execution: {
        executionId: `mcp_read_${crypto.randomUUID()}`,
        leaseId: "lease_mcp",
        deadlineAtUnixMs: Date.now() + this.invocationTimeoutMs,
      },
      cursorSigningKey: "mcp-e2e-cursor-signing-key-00000000",
      now: Date.now(),
    });
    if (!authorization.ok) throw new Error(authorization.error.code);
    const result = await executeAuthorizedCustomConnectorRead({
      db: fixtureDatabase(),
      keys: env,
      namespace: this.server,
      authorization: authorization.value,
      effectiveGrants: this.fixture.effective,
      cursorSigningKey: "mcp-e2e-cursor-signing-key-00000000",
      now: Date.now(),
      isExecutionActive: this.isExecutionActive.bind(this),
      transport: this.transport,
    });
    const text = JSON.stringify(result.ok ? result.value.data : result.error);
    const digest = await sha256Hex(text);
    return {
      kind: "read",
      status: result.ok ? "succeeded" : "failed",
      output: { kind: "inline", content: [{ kind: "text", text }], digest },
      authority: { kind: "read", resultDigest: digest },
    };
  }
  async cancelExecution(): Promise<void> {
    this.execution = "cancelled";
  }
  async isExecutionActive(): Promise<boolean> {
    const active = this.execution === "active";
    if (this.cancelDuringAuthorization) {
      this.cancelDuringAuthorization = false;
      queueMicrotask(this.cancelExecution.bind(this));
    }
    return active;
  }
}

async function ignoreDiscovery(): Promise<void> {}

type ConnectorWriteInput = {
  readonly fixture: RemoteConnectorFixture;
  readonly server: RemoteFixture;
  readonly entry: CustomConnectorWriteCatalogEntry;
  readonly grantId: string;
  readonly suffix: string;
  readonly grantDisposition: "retain" | "revoke";
  readonly timeoutMs: number;
  /** "requested" stops before the approval: the write waits for a person. */
  readonly approval?: "signed" | "requested";
};

async function prepareConnectorWrite(input: ConnectorWriteInput) {
  const { fixture, entry, suffix } = input;
  const authority = await buildCustomConnectorWriteAuthority({
    entry,
    rawArguments: {},
    providerEffectId: `effect_connector_${suffix}`,
  });
  if (!authority.ok) throw new Error(authority.error.code);
  const sessionId = parseSessionId("session_mcp");
  const caseId = parseCaseId(`case_connector_${suffix}`);
  if (!sessionId.ok || !caseId.ok)
    throw new Error("Invalid REST action identity");
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const actionUser = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!actionUser.ok) throw new Error(actionUser.error.code);
  const actionSession = await issueControlSession({
    db: env.DB,
    userId: actionUser.value,
    now: Date.now(),
    ttlMs: 600_000,
  });
  const actionExecution = await controlActionMutationExecution(
    env,
    ORGANISATION_ID,
    actionSession.session,
  );
  if (!actionExecution.ok) throw new Error(actionExecution.error.code);
  const proposed = await organisation.proposeAction({
    execution: actionExecution.value,
    organisationId: ORGANISATION_ID,
    integrationAccountId: entry.integrationAccountId,
    requestAuthority: fixture.authority,
    authorityPartition: fixture.partition,
    authority: authority.value,
    caseId: caseId.value,
    proposalId: `proposal_connector_${suffix}`,
    sessionId: sessionId.value,
    threadId: `slack:connector:${suffix}`,
    draft: {
      host: new URL(entry.origin).hostname,
      verb: "custom_connector.external_record_create",
      path:
        entry.operation.transport.kind === "mcp"
          ? entry.operation.transport.endpointPath
          : entry.operation.transport.pathTemplate,
      argsHash: authority.value.canonicalInputDigest,
      amount: null,
      resourceKey: `custom_connector:${entry.operation.id}:effect_connector_${suffix}`,
    },
    flowBinding: fixture.binding.toJSON(),
    exp: Date.now() + 60_000,
    now: Date.now(),
  });
  if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
  const nonce = proposed.value.action.nonce.value;
  const requested = await organisation.requestActionApproval({
    execution: actionExecution.value,
    organisationId: ORGANISATION_ID,
    nonce,
    now: Date.now(),
  });
  if (!requested.ok) throw new Error(requested.error.code);
  if (input.approval === "requested")
    return {
      organisation,
      nonce,
      authority: authority.value,
      session: actionSession,
    };
  const approval = parseApprovalEvidence({
    kind: "app_user",
    principal: {
      kind: "app_user",
      userId: "user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab",
      personId: "person_e2e-slack-actor",
      role: "owner",
    },
    authentication: {
      kind: "google_oidc_step_up",
      controlSessionId: "control_session_e2e_rest_approval",
      authenticatedAt: Date.now(),
      challenge: {
        stepUpId: `step_up_connector_${suffix}`,
        organisationId: ORGANISATION_ID,
        actionNonce: nonce,
        actionDigest: await digestApprovalAction(proposed.value.action),
        policy: { kind: "unversioned_default" },
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    },
  });
  if (!approval.ok) throw new Error(approval.error.code);
  const signed = await organisation.signAction({
    organisationId: ORGANISATION_ID,
    nonce,
    approval: approval.value,
    now: Date.now(),
  });
  if (!signed.ok || signed.value.state !== "signed")
    throw new Error("REST action approval failed");
  return {
    organisation,
    nonce,
    authority: authority.value,
    session: actionSession,
  };
}

async function executeConnectorWrite(input: ConnectorWriteInput) {
  const { server, entry } = input;
  const { organisation, nonce, authority } = await prepareConnectorWrite(input);
  const authorized = await authorizeConnectorWrite(input, "retain");
  expect(authorized).toBe(true);
  const begun = await organisation.beginActionExecution({
    organisationId: ORGANISATION_ID,
    nonce,
    now: Date.now(),
  });
  if (!begun.ok || begun.value.state !== "executing")
    throw new Error("REST action execution lease missing");
  const execution = await executeApprovedCustomConnectorWrite({
    db: fixtureDatabase(),
    keys: env,
    namespace: server,
    entry,
    authority,
    idempotencyKey: begun.value.idempotencyKey,
    deadlineAtUnixMs: Date.now() + input.timeoutMs,
    now: Date.now(),
    authorizeCall: authorizeConnectorWrite.bind(
      null,
      input,
      input.grantDisposition,
    ),
  });
  let outcome: "confirmed" | "failed" | "indeterminate";
  switch (execution.kind) {
    case "confirmed":
      outcome = "confirmed";
      break;
    case "failed_before_send":
      outcome = "failed";
      break;
    case "indeterminate":
      outcome = "indeterminate";
      break;
    default:
      assertNever(execution);
  }
  const completed = await organisation.completeActionExecution({
    organisationId: ORGANISATION_ID,
    nonce,
    executionLeaseId: begun.value.executionLease.leaseId,
    outcome,
    providerResult: JSON.stringify(
      execution.kind === "confirmed" ? execution.receipt : execution,
    ),
    now: Date.now(),
  });
  if (!completed.ok) throw new Error(completed.error.code);
  return completed.value;
}

async function authorizeConnectorWrite(
  input: ConnectorWriteInput,
  grantDisposition: "retain" | "revoke",
): Promise<boolean> {
  if (grantDisposition === "revoke") {
    const revoked = await revokeAccessGrant({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      grantId: input.grantId,
      expectedRevision: 1,
      reason: "E2E revocation after credential preparation",
      now: Date.now(),
    });
    if (!revoked.ok) throw new Error(revoked.error.code);
  }
  const { fixture, entry } = input;
  const authorized = await authorizeCapabilityUse({
    db: fixtureDatabase(),
    accountAccess: fixture.accountAccess,
    userAuthority: {
      kind: "authenticated_session",
      nativeSessionId: fixture.nativeSessionId,
    },
    action: "execute",
    organisationId: ORGANISATION_ID,
    authority: fixture.authority,
    authorityPartition: fixture.partition,
    request: {
      capabilities: [
        {
          kind: "custom_connector_operation",
          capabilityId: "custom_connector.write",
          capabilityVersion: 1,
          integrationAccountId: entry.integrationAccountId,
          connectorId: entry.connectorId,
          definitionRevision: entry.definitionRevision,
          definitionDigest: entry.definitionDigest,
          operationId: entry.operation.id,
        },
      ],
    },
  });
  return authorized.ok;
}

async function revokeRemoteGrant(): Promise<void> {
  const revoked = await revokeAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: GRANT_ID,
    expectedRevision: 1,
    reason: "E2E revocation after MCP discovery",
    now: Date.now(),
  });
  if (!revoked.ok) throw new Error(revoked.error.code);
}

class RemoteModel {
  readonly requests: Record<string, unknown>[] = [];
  constructor(readonly tool: string) {}
  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const raw: unknown = await request.json();
    if (!isRecord(raw)) throw new Error("Invalid model request");
    this.requests.push(raw);
    switch (this.requests.length) {
      case 1:
        return openRouterToolCall(
          "tool_search",
          { query: this.tool },
          "mcp_search",
        );
      case 2:
        return openRouterToolCall(
          "codemode",
          {
            code: `const reads = await Promise.all([tools.${this.tool}({}), tools.${this.tool}({})]); const total = reads.reduce((sum, value) => sum + JSON.parse(value).count, 0); store('mcp_total', total); text(total);`,
          },
          "mcp_composed",
        );
      case 3:
        expect(requireLastToolOutput(raw)).toContain("14");
        return openRouterText("MCP_TOTAL_14", "mcp_done");
      case 4:
        return openRouterToolCall(
          "codemode",
          {
            code: `text(load('mcp_total')); text(await tools.${this.tool}({}));`,
          },
          "mcp_restore",
        );
      case 5:
        expect(requireLastToolOutput(raw)).toContain("14");
        return openRouterText("MCP_RESTORED_14", "mcp_restored_done");
      case 6:
        return openRouterToolCall(this.tool, {}, "mcp_cancelled_read");
      case 7:
        expect(requireLastToolOutput(raw)).toContain("authority_expired");
        return openRouterText("MCP_CANCELLED", "mcp_cancelled_done");
      case 8:
        return openRouterToolCall(this.tool, {}, "mcp_revoked_read");
      case 9:
        expect(requireLastToolOutput(raw)).toContain("authority_expired");
        return openRouterText("MCP_REVOKED", "mcp_revoked_done");
      case 10:
        return openRouterToolCall(
          "mcp__supplier__write_record",
          {},
          "mcp_unapproved_write",
        );
      case 11:
        return openRouterText("MCP_WRITE_DENIED", "mcp_unapproved_write_done");
      default:
        throw new Error("Unexpected model turn");
    }
  }
}

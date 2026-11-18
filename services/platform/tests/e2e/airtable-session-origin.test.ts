import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";
import { network } from "./network";
import {
  installSlackActorFixture,
  createRequiredGrant,
  openRouterToolCall,
  openRouterText,
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
} from "./slack-journey-support";
import {
  parseUserId,
  parseSessionId,
  type IntegrationAccountId,
} from "../../src/ids";
import { parseVaultHandle, storeVaultSecret } from "../../src/credential-vault";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { writeOrganisationCapabilityPolicy } from "../../src/data/capability-policy";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import {
  requireActiveOrganisationActor,
  resolveActiveSessionActor,
} from "../../src/actors/actor-router";
import { CAPABILITY_KEYS } from "../../src/authorization/capability-catalogue";

const TOKEN = "airtable-session-origin-fixture-token";
const BASE_ID = "appP55OriginAcceptance";
const PROVIDER_TEXT = "P55 protected Airtable record";

type Boundary = "write_claim" | "read_response" | "write_response";
type Journey = {
  readonly boundary: Boundary;
  readonly accountId: IntegrationAccountId;
  readonly digest: SubtleCrypto["digest"];
  phase: "armed" | "paused" | "released";
  modelRequests: number;
  providerRequests: number;
  toolIssued: boolean;
  discoveryRequests: number;
};
let activeJourney: Journey | null = null;

it.for(["write_claim", "read_response", "write_response"] as const)(
  "fences Airtable %s after revocation, settles issued writes and recovers without duplicate requests",
  { timeout: 45_000 },
  airtableOriginJourney,
);

async function airtableOriginJourney(
  boundary: Boundary,
  { task }: TestContext,
): Promise<void> {
  const { accountId, session, fresh } = await fixture();
  const journey: Journey = {
    boundary,
    accountId,
    digest: crypto.subtle.digest,
    phase: "armed",
    modelRequests: 0,
    providerRequests: 0,
    toolIssued: false,
    discoveryRequests: 0,
  };
  activeJourney = journey;
  crypto.subtle.digest = pauseWriteClaim;
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToModel.bind(null, journey),
    ),
    http.all(
      `https://api.airtable.com/v0/${BASE_ID}/Orders`,
      respondToProvider.bind(null, journey),
    ),
  );
  const pending = dispatch(session, `p55_${boundary}`);
  try {
    await expect
      .poll(currentPhase.bind(null, journey), { timeout: 15_000 })
      .toBe("paused");
    const admittedRequests = journey.modelRequests;
    const origin = await fixtureDatabase()
      .prepare(
        "SELECT session_id, turn_id FROM session_turn_access WHERE organisation_id = ? AND control_session_id = ?",
      )
      .bind(ORGANISATION_ID, session.session.controlSessionId)
      .first<{ session_id: string; turn_id: string }>();
    if (origin === null) throw new Error("Missing admitted Airtable turn");
    await env.DB.prepare(
      "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
    )
      .bind(Date.now(), session.session.controlSessionId)
      .run();
    journey.phase = "released";
    const denied = await pending;
    expect(denied.status).toBe(503);
    expect(await denied.text()).not.toContain(PROVIDER_TEXT);
    expect(journey.modelRequests).toBe(admittedRequests);
    const issued =
      boundary === "read_response" || boundary === "write_response";
    expect(journey.providerRequests).toBe(issued ? 1 : 0);
    const sessionId = parseSessionId(origin.session_id);
    if (!sessionId.ok) throw new Error(sessionId.error.code);
    const actor = await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: ORGANISATION_ID,
      sessionId: sessionId.value,
      now: Date.now(),
    });
    if (!actor.ok) throw new Error(actor.error.code);
    const retained = await runInDurableObject(
      actor.value,
      retainedAirtableState.bind(null, accountId),
    );
    expect(retained.history).not.toContain(PROVIDER_TEXT);
    expect(retained.providerObservations).toBe(0);
    expect(retained.receipts).toHaveLength(
      boundary === "write_response" ? 1 : 0,
    );
    if (boundary === "write_response")
      expect(retained.receipts[0]).toMatchObject({
        kind: "completed",
        result: { records: [{ fields: { Title: PROVIDER_TEXT } }] },
      });
    await evictDurableObject(actor.value);
    expect(
      await runInDurableObject(
        actor.value,
        retainedAirtableState.bind(null, accountId),
      ),
    ).toEqual(retained);
    expect((await dispatch(fresh, `p55_${boundary}`)).status).toBe(503);
    expect(journey.providerRequests).toBe(issued ? 1 : 0);
    journey.toolIssued = false;
    const allowed = await dispatch(fresh, `p55_${boundary}_fresh`);
    expect(allowed.status).toBe(200);
    await allowed.arrayBuffer();
    expect(journey.providerRequests).toBe((issued ? 1 : 0) + 1);
    const freshOrigin = await fixtureDatabase()
      .prepare(
        "SELECT session_id FROM session_turn_access WHERE organisation_id = ? AND control_session_id = ?",
      )
      .bind(ORGANISATION_ID, fresh.session.controlSessionId)
      .first<{ session_id: string }>();
    if (freshOrigin === null) throw new Error("Missing fresh Airtable turn");
    const freshSessionId = parseSessionId(freshOrigin.session_id);
    if (!freshSessionId.ok) throw new Error(freshSessionId.error.code);
    const freshActor = await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: ORGANISATION_ID,
      sessionId: freshSessionId.value,
      now: Date.now(),
    });
    if (!freshActor.ok) throw new Error(freshActor.error.code);
    const authorizedState = await runInDurableObject(
      freshActor.value,
      retainedAirtableState.bind(null, accountId),
    );
    expect(authorizedState.providerObservations).toBe(1);
    Object.assign(task.meta, {
      airtableOriginAcceptance: {
        boundary,
        deniedProviderRequests: issued ? 1 : 0,
        credentialRevocationDispatchedRequest: false,
        protectedResultReleased: false,
        revokedProviderObservations: 0,
        authorizedProviderObservations: authorizedState.providerObservations,
        issuedWriteReceiptRetained: boundary === "write_response",
        evictedStateRetained: true,
        duplicateProviderRequests: 0,
        authorizedFreshRequestCompleted: true,
      },
    });
  } finally {
    journey.phase = "released";
    crypto.subtle.digest = journey.digest;
    activeJourney = null;
    await pending;
  }
}

function currentPhase(journey: Journey) {
  return journey.phase;
}

async function pauseWriteClaim(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["digest"]>[0],
  data: Parameters<SubtleCrypto["digest"]>[1],
): Promise<ArrayBuffer> {
  const pause = activeJourney;
  if (pause === null) throw new Error("Missing write claim pause");
  const digest = await pause.digest.call(this, algorithm, data);
  if (pause.phase !== "armed" || pause.boundary !== "write_claim")
    return digest;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return digest;
  }
  if (
    isRecord(value) &&
    typeof value.turnId === "string" &&
    isRecord(value.input) &&
    value.input.integrationAccountId === pause.accountId &&
    isRecord(value.input.request) &&
    value.input.request.method === "POST"
  )
    await waitForRelease(pause);
  return digest;
}

async function waitForRelease(journey: Journey): Promise<void> {
  journey.phase = "paused";
  while (journey.phase === "paused") await scheduler.wait(5);
}

async function respondToModel(
  journey: Journey,
  request: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  journey.modelRequests++;
  const body: unknown = await request.request.json();
  if (!isRecord(body) || !Array.isArray(body.tools))
    throw new Error("Missing model tools");
  if (journey.toolIssued)
    return openRouterText(
      JSON.stringify({ kind: "reply", text: "Airtable request completed." }),
      "p55_airtable_done",
    );
  const write =
    journey.boundary === "write_claim" || journey.boundary === "write_response";
  const name = write ? "airtable_api_write" : "airtable_api_read";
  if (!body.tools.some(toolHasName.bind(null, name))) {
    if (++journey.discoveryRequests > 8)
      throw new Error("Airtable tool discovery did not complete");
    return openRouterToolCall(
      "tool_search",
      { query: name, limit: 1 },
      `discover_airtable_${journey.discoveryRequests}`,
    );
  }
  journey.toolIssued = true;
  return openRouterToolCall(
    name,
    {
      requestJson: JSON.stringify({
        kind: "request",
        integrationAccountId: journey.accountId,
        method: write ? "POST" : "GET",
        path: `/v0/${BASE_ID}/Orders`,
        body: write
          ? { records: [{ fields: { Title: "Operator approved order" } }] }
          : null,
      }),
    },
    "p55_airtable_request",
  );
}

function toolHasName(name: string, tool: unknown): boolean {
  return (
    isRecord(tool) && isRecord(tool.function) && tool.function.name === name
  );
}

async function respondToProvider(
  journey: Journey,
  request: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  journey.providerRequests++;
  expect(request.request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  await request.request.arrayBuffer();
  if (
    journey.phase === "armed" &&
    (journey.boundary === "read_response" ||
      journey.boundary === "write_response")
  )
    await waitForRelease(journey);
  return HttpResponse.json({
    records: [{ id: "recP55Origin", fields: { Title: PROVIDER_TEXT } }],
  });
}

async function retainedAirtableState(
  accountId: IntegrationAccountId,
  _actor: unknown,
  state: DurableObjectState,
) {
  const receipts: unknown[] = [];
  for (const receipt of (
    await state.storage.list({ prefix: "airtable_write_" })
  ).values())
    receipts.push(receipt);
  return {
    receipts,
    history: JSON.stringify(
      state.storage.sql.exec("SELECT * FROM session_harness_history").toArray(),
    ),
    providerObservations: state.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM session_information_flow_observation
         WHERE json_extract(evidence_json, '$.source.kind') = 'integration_resource'
           AND json_extract(evidence_json, '$.source.integrationAccountId') = ?`,
        accountId,
      )
      .one().count,
  };
}

function dispatch(
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
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
      },
      body: JSON.stringify({
        instruction: "Read or update the operator's Airtable order.",
      }),
    },
  );
}

async function fixture() {
  await installSlackActorFixture();
  const user = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  const handle = parseVaultHandle("vault:airtable:p55-session-origin");
  if (!user.ok || !handle.ok)
    throw new Error("Invalid provider fixture identity");
  const now = Date.now();
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "UPDATE service_role_grant SET role = 'admin' WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(ORGANISATION_ID, SLACK_ACTOR_USER_ID),
    fixtureDatabase()
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_p55_airtable', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(now, ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        "UPDATE workspace_ai_budget SET max_tokens = 128000, previous_limits_json = json_set(previous_limits_json, '$.maxTokens', 128000) WHERE organisation_id = ?",
      )
      .bind(ORGANISATION_ID),
  ]);
  const stored = await storeVaultSecret({
    db: fixtureDatabase(),
    keys: env,
    organisationId: ORGANISATION_ID,
    handle: handle.value,
    secret: { kind: "bearer", value: TOKEN },
    now,
  });
  if (!stored.ok) throw new Error(stored.error.code);
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId: ORGANISATION_ID,
    provider: "airtable",
    providerSubjectId: "usrP55Origin",
    environment: "development",
    authMode: "api_key",
    authority: { kind: "connection_credential", credentialRef: handle.value },
    grantedScopes: ["data.records:read", "data.records:write"],
    createdByUserId: user.value,
    providerAccountId: "usrP55Origin",
    accountKind: "user_grant",
    displayName: "P55 order base",
    capabilities: [
      CAPABILITY_KEYS.airtableApiRead,
      CAPABILITY_KEYS.airtableApiWrite,
    ],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const accountId = connected.account.integrationAccountId;
  await createRequiredGrant({
    grantId: "grant_p55_airtable_context",
    subject: { kind: "organisation_role", role: "admin" },
    target: {
      kind: "platform_capability",
      capabilityId: CAPABILITY_KEYS.contextCaseRead,
      capabilityVersion: 1,
    },
    now,
  });
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  for (const capabilityId of [
    CAPABILITY_KEYS.airtableApiRead,
    CAPABILITY_KEYS.airtableApiWrite,
  ]) {
    await createRequiredGrant({
      grantId: `grant_p55_${capabilityId}`,
      subject: { kind: "organisation_role", role: "admin" },
      target: {
        kind: "provider_resource",
        capabilityId,
        capabilityVersion: 1,
        integrationAccountId: accountId,
        resourceScope: `base:${BASE_ID}`,
      },
      now,
    });
    const enabled = await writeOrganisationCapabilityPolicy({
      scope,
      write: {
        kind: "change",
        capabilityId,
        expectedRevision: 1,
        mode: "enabled",
        provenance: {
          kind: "operator",
          userId: user.value,
          mutationReceiptId: `receipt_p55_${capabilityId}`,
        },
        now,
      },
    });
    if (!enabled.ok) throw new Error(enabled.error.code);
  }
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
    accountId,
    session: await issueControlSession({
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

import {
  sessionTurnExecution,
  type SessionTurnExecution,
} from "../../src/chat/turn-access";
import { fixtureDatabase } from "./organisation-database";
import { parsePersistedHarnessTurnLease } from "@purin-labs/agent/actors/agent-session-harness-authority";
import { env, exports } from "cloudflare:workers";
import {
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import {
  requireActiveOrganisationActor,
  resolveActiveConnectorActor,
  resolveActiveSessionActor,
} from "@purin-labs/actor-runtime/actors/actor-router";
import type { ConnectorDO } from "../../src/actors/connector";
import {
  deferWhatsAppNotice,
  latestWhatsAppProposal,
} from "../../src/actors/connector-whatsapp";
import { resumeActorRelocation } from "@purin-labs/actor-runtime/actors/actor-relocation";
import {
  parseSessionId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  createRequiredGrant,
  openRouterToolCall,
  openRouterText,
  ORGANISATION_ID,
  SLACK_BOT_TOKEN,
} from "./slack-journey-support";
import { network } from "./network";
import {
  issueControlSession,
  type IssuedControlSession,
} from "@purin-labs/tenancy/data/control-plane";
import { writeOrganisationCapabilityPolicy } from "@purin-labs/authority/data/capability-policy";
import { compilePublishAndActivateOrganisationPolicy } from "@purin-labs/authority/policy-snapshot";
import {
  CUSTOMER_ID,
  installFixture,
  MESSAGE_ID,
  PHONE_NUMBER_ID,
  PROPOSAL_ID,
  REPLY,
  required,
  TOKEN,
  type Fixture,
} from "./whatsapp-connector-support";
import {
  exportedItemCount,
  readBarrier,
  startMove,
} from "./placement-move-support";

type SendBoundary = "credential" | "response";
type ReplyBoundary = "panel" | SendBoundary;
type NoticeBoundary = "notice_credential" | "notice_response";
type Boundary = ReplyBoundary | NoticeBoundary;
type Pause = {
  readonly boundary: Boundary;
  phase: "armed" | "paused" | "released";
  readonly decrypt: SubtleCrypto["decrypt"];
  providerAttempts: number;
};

let activePause: Pause | null = null;

it.for(["credential", "response"] as const)(
  "fences directed WhatsApp %s at revoked origin and preserves issued receipts after eviction",
  { timeout: 60_000 },
  replyOriginJourney,
);

async function replyOriginJourney(
  boundary: SendBoundary,
  { task }: TestContext,
): Promise<void> {
  const fixture = await installFixture();
  const { session, fresh } = await installSupportReadAuthority(fixture);
  const executions: SessionTurnExecution[] = [];
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      captureReplyExecution.bind(null, executions),
    ),
  );
  const accepted = await dispatchSupportRead(
    session,
    `p55_reply_origin_${boundary}`,
  );
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  await accepted.arrayBuffer();
  const freshAccepted = await dispatchSupportRead(
    fresh,
    `p55_reply_origin_${boundary}_fresh`,
  );
  expect(freshAccepted.status, await freshAccepted.clone().text()).toBe(200);
  await freshAccepted.arrayBuffer();
  const execution = executions[0];
  const freshExecution = executions[1];
  if (execution === undefined || freshExecution === undefined)
    throw new Error("Missing native reply Session execution");
  const origin = { kind: "session_turn", execution } as const;
  const freshOrigin = {
    kind: "session_turn",
    execution: freshExecution,
  } as const;
  const preview = await fixture.connector.previewWhatsAppProposal({
    identity: fixture.identity,
    proposalId: PROPOSAL_ID,
    now: fixture.now,
  });
  if (!preview.ok || preview.value.kind !== "current")
    throw new Error(JSON.stringify(preview));
  const pause: Pause = {
    boundary,
    phase: "armed",
    decrypt: crypto.subtle.decrypt,
    providerAttempts: 0,
  };
  activePause = pause;
  crypto.subtle.decrypt = pauseDecryption;
  network.use(
    http.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      graphResponse.bind(null, pause),
    ),
  );
  const request = {
    identity: fixture.identity,
    origin,
    proposalId: PROPOSAL_ID,
    approvedVersion: preview.value.preview.version,
    approvedBodyDigest: preview.value.preview.bodyDigest,
    approvedBy: session.session.userId,
    now: fixture.now,
  };
  const pending = fixture.connector.dispatchWhatsAppReply(request);
  try {
    await expect
      .poll(pausePhase.bind(null, pause), { timeout: 15_000 })
      .toBe("paused");
    await env.DB.prepare(
      "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
    )
      .bind(Date.now(), session.session.controlSessionId)
      .run();
    pause.phase = "released";
    const denied = await pending;
    expect(denied.ok).toBe(false);
    const retained = await runInDurableObject(fixture.connector, readProposal);
    expect(retained).toMatchObject({
      state: boundary === "response" ? "sent" : "awaiting_approval",
    });
    expect(pause.providerAttempts).toBe(boundary === "response" ? 1 : 0);
    await evictDurableObject(fixture.connector);
    expect(await runInDurableObject(fixture.connector, readProposal)).toEqual(
      retained,
    );
    expect((await fixture.connector.dispatchWhatsAppReply(request)).ok).toBe(
      false,
    );
    const authorized = { ...request, origin: freshOrigin };
    expect(
      await fixture.connector.dispatchWhatsAppReply(authorized),
    ).toMatchObject({
      ok: true,
      value: { kind: "sent", whatsappMessageId: MESSAGE_ID },
    });
    expect(
      await fixture.connector.dispatchWhatsAppReply(authorized),
    ).toMatchObject({
      ok: true,
      value: { kind: "sent", whatsappMessageId: MESSAGE_ID },
    });
    expect(pause.providerAttempts).toBe(1);
    Object.assign(task.meta, {
      whatsappReplyOriginAcceptance: {
        boundary,
        revokedResultWithheld: true,
        issuedReceiptRetained: boundary === "response",
        evictedDenialRetained: true,
        providerAttempts: 1,
        duplicateProviderAttempts: 0,
        liveProviderAcceptance: false,
      },
    });
  } finally {
    pause.phase = "released";
    crypto.subtle.decrypt = pause.decrypt;
    activePause = null;
    await pending;
  }
}

async function captureReplyExecution(
  executions: SessionTurnExecution[],
): Promise<Response> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT session_id FROM session_turn_access WHERE organisation_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .bind(ORGANISATION_ID)
    .first<{ session_id: string }>();
  if (row === null) throw new Error("Missing accepted reply Session");
  const actor = required(
    await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: ORGANISATION_ID,
      sessionId: required(parseSessionId(row.session_id)),
      now: Date.now(),
    }),
  );
  executions.push(await runInDurableObject(actor, acceptedReplyExecution));
  return openRouterText(
    JSON.stringify({ kind: "reply", text: "Reply authority prepared." }),
    "p55_reply_authority",
  );
}

function acceptedReplyExecution(
  _actor: unknown,
  state: DurableObjectState,
): SessionTurnExecution {
  const row = state.storage.sql
    .exec<{ lease_projection: string }>(
      "SELECT lease_projection FROM session_harness_lease LIMIT 1",
    )
    .one();
  const lease = parsePersistedHarnessTurnLease(
    JSON.parse(row.lease_projection),
  );
  if (lease === null) throw new Error("Invalid native reply lease");
  return sessionTurnExecution(lease);
}

type SupportOriginPause = {
  readonly integrationAccountId: IntegrationAccountId;
  readonly digest: SubtleCrypto["digest"];
  phase: "armed" | "paused" | "released";
  toolIssued: boolean;
  discoveries: number;
  modelRequests: number;
  observationDigest: string;
  observationSetDigest: string;
};

it(
  "withholds WhatsApp support binding_commit after origin revocation and preserves denial after eviction",
  supportOriginJourney,
  45_000,
);

async function supportOriginJourney({ task }: TestContext): Promise<void> {
  const fixture = await installFixture();
  const { session, fresh } = await installSupportReadAuthority(fixture);
  const pause: SupportOriginPause = {
    integrationAccountId: fixture.integrationAccountId,
    digest: crypto.subtle.digest,
    phase: "armed",
    toolIssued: false,
    discoveries: 0,
    modelRequests: 0,
    observationDigest: "",
    observationSetDigest: "",
  };
  crypto.subtle.digest = pauseSupportObservation.bind(null, pause);
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      supportReadModel.bind(null, pause),
    ),
  );
  const key = "p55_whatsapp_support_binding_commit";
  const pending = dispatchSupportRead(session, key);
  try {
    await expect
      .poll(supportOriginPhase.bind(null, pause), { timeout: 15_000 })
      .toBe("paused");
    const actor = await supportSessionActor(session);
    const admittedModelRequests = pause.modelRequests;
    await env.DB.prepare(
      "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
    )
      .bind(Date.now(), session.session.controlSessionId)
      .run();
    pause.phase = "released";
    const denied = await pending;
    expect(denied.status, await denied.clone().text()).toBe(503);
    expect(await denied.text()).not.toContain("Is my order ready?");
    expect(pause.modelRequests).toBe(admittedModelRequests);
    const retained = await runInDurableObject(
      actor,
      retainedSupportState.bind(null, fixture.integrationAccountId),
    );
    expect(retained.observations).toBe(0);
    expect(retained.history).not.toContain("Is my order ready?");
    await evictDurableObject(actor);
    expect(
      await runInDurableObject(
        actor,
        retainedSupportState.bind(null, fixture.integrationAccountId),
      ),
    ).toEqual(retained);
    expect((await dispatchSupportRead(fresh, key)).status).toBe(503);
    pause.toolIssued = false;
    const allowed = await dispatchSupportRead(fresh, `${key}_fresh`);
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    await allowed.arrayBuffer();
    const freshActor = await supportSessionActor(fresh);
    const accepted = await runInDurableObject(
      freshActor,
      retainedSupportState.bind(null, fixture.integrationAccountId),
    );
    expect(accepted.observations).toBe(1);
    expect(accepted.history).toContain("Is my order ready?");
    Object.assign(task.meta, {
      whatsappSupportOriginAcceptance: {
        boundary: "binding_commit",
        revokedObservations: 0,
        protectedHistoryWithheld: true,
        evictedDenialRetained: true,
        freshAuthorizedObservations: 1,
        liveProviderAcceptance: false,
      },
    });
  } finally {
    pause.phase = "released";
    crypto.subtle.digest = pause.digest;
    await pending;
  }
}

async function installSupportReadAuthority(fixture: Fixture) {
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const userId = required(
    parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab"),
  );
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'admin' WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, userId)
    .run();
  await createRequiredGrant({
    grantId: "grant_p55_whatsapp_support_context",
    subject: { kind: "organisation_role", role: "admin" },
    target: {
      kind: "platform_capability",
      capabilityId: "context.case.read",
      capabilityVersion: 1,
    },
    now: fixture.now,
  });
  await createRequiredGrant({
    grantId: "grant_p55_whatsapp_support_read",
    subject: { kind: "person", personId: "person_e2e-slack-actor" },
    target: {
      kind: "provider_resource",
      capabilityId: "whatsapp.support.read",
      capabilityVersion: 1,
      integrationAccountId: fixture.integrationAccountId,
      resourceScope: "active_cases",
    },
    now: fixture.now,
  });
  required(
    await writeOrganisationCapabilityPolicy({
      scope,
      write: {
        kind: "change",
        capabilityId: "whatsapp.support.read",
        expectedRevision: 1,
        mode: "enabled",
        provenance: {
          kind: "operator",
          userId,
          mutationReceiptId: "receipt_p55_whatsapp_support_read",
        },
        now: Date.now(),
      },
    }),
  );
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: fixture.now,
  });
  required(
    await compilePublishAndActivateOrganisationPolicy({
      bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
      organisationId: ORGANISATION_ID,
      organisation,
      now: fixture.now,
    }),
  );
  return {
    session: await issueControlSession({
      db: env.DB,
      userId,
      now: fixture.now,
      ttlMs: 1_800_000,
    }),
    fresh: await issueControlSession({
      db: env.DB,
      userId,
      now: fixture.now,
      ttlMs: 1_800_000,
    }),
  };
}

function supportOriginPhase(
  pause: SupportOriginPause,
): SupportOriginPause["phase"] {
  return pause.phase;
}

async function pauseSupportObservation(
  pause: SupportOriginPause,
  algorithm: Parameters<SubtleCrypto["digest"]>[0],
  data: Parameters<SubtleCrypto["digest"]>[1],
): Promise<ArrayBuffer> {
  const result = await pause.digest.call(crypto.subtle, algorithm, data);
  if (pause.phase !== "armed") return result;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return result;
  }
  const digest = Array.from(new Uint8Array(result), supportHexByte).join("");
  if (
    isRecord(raw) &&
    isRecord(raw.source) &&
    raw.source.kind === "integration_resource" &&
    raw.source.integrationAccountId === pause.integrationAccountId
  ) {
    pause.observationDigest = digest;
  }
  if (
    pause.observationDigest.length > 0 &&
    Array.isArray(raw) &&
    raw.includes(pause.observationDigest)
  ) {
    pause.observationSetDigest = digest;
  }
  if (
    pause.observationSetDigest.length > 0 &&
    isRecord(raw) &&
    raw.observationSetDigest === pause.observationSetDigest
  ) {
    pause.phase = "paused";
    while (pause.phase === "paused") await scheduler.wait(5);
  }
  return result;
}

function supportHexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

async function supportReadModel(
  pause: SupportOriginPause,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  pause.modelRequests += 1;
  const body: unknown = await request.json();
  if (!isRecord(body) || !Array.isArray(body.tools))
    throw new Error("Missing support tools");
  if (pause.toolIssued)
    return openRouterText(
      JSON.stringify({ kind: "reply", text: "Support read completed." }),
      "p55_support_done",
    );
  if (!body.tools.some(isSupportReadTool)) {
    if (++pause.discoveries > 8)
      throw new Error("Support discovery did not complete");
    return openRouterToolCall(
      "tool_search",
      { query: "whatsapp_support_read", limit: 1 },
      `p55_support_discovery_${pause.discoveries}`,
    );
  }
  pause.toolIssued = true;
  return openRouterToolCall(
    "whatsapp_support_read",
    { limit: 5 },
    "p55_support_read",
  );
}

function isSupportReadTool(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    isRecord(raw.function) &&
    raw.function.name === "whatsapp_support_read"
  );
}

function dispatchSupportRead(
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
        instruction: "Read the granted WhatsApp support Cases.",
      }),
    },
  );
}

async function supportSessionActor(session: IssuedControlSession) {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT session_id FROM session_turn_access WHERE organisation_id = ? AND control_session_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .bind(ORGANISATION_ID, session.session.controlSessionId)
    .first<{ session_id: string }>();
  if (row === null) throw new Error("Missing support Session");
  return required(
    await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: ORGANISATION_ID,
      sessionId: required(parseSessionId(row.session_id)),
      now: Date.now(),
    }),
  );
}

function retainedSupportState(
  accountId: IntegrationAccountId,
  _actor: unknown,
  state: DurableObjectState,
) {
  return {
    observations: state.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_information_flow_observation WHERE json_extract(evidence_json, '$.source.integrationAccountId') = ?",
        accountId,
      )
      .one().count,
    history: JSON.stringify(
      state.storage.sql.exec("SELECT * FROM session_harness_history").toArray(),
    ),
  };
}

it(
  "withholds decrypted Case messages during freeze and restores them on the evicted target",
  panelJourney,
  70_000,
);
it(
  "rejects paused WhatsApp credential preparation and sends once from the evicted target",
  credentialJourney,
  70_000,
);
it(
  "settles an already-sent WhatsApp reply before export and replays its receipt after target eviction",
  responseJourney,
  70_000,
);

it(
  "keeps an operator notice pending through frozen credential preparation and delivers on the evicted target",
  noticeCredentialJourney,
  70_000,
);
it(
  "settles an issued operator notice before export and preserves its receipt after eviction",
  noticeResponseJourney,
  70_000,
);

function noticeCredentialJourney(context: TestContext): Promise<void> {
  return noticeJourney("notice_credential", context);
}
function noticeResponseJourney(context: TestContext): Promise<void> {
  return noticeJourney("notice_response", context);
}

async function noticeJourney(
  boundary: NoticeBoundary,
  { task }: TestContext,
): Promise<void> {
  const fixture = await installFixture();
  const pause: Pause = {
    boundary,
    phase: "armed",
    decrypt: crypto.subtle.decrypt,
    providerAttempts: 0,
  };
  activePause = pause;
  crypto.subtle.decrypt = pauseDecryption;
  network.use(
    http.post(
      "https://slack.com/api/chat.postMessage",
      noticeResponse.bind(null, pause),
    ),
  );
  const event = {
    identity: fixture.identity,
    event: {
      kind: "unsupported_message",
      providerMessageId: "wamid.P55_IMAGE",
      customerWaId: CUSTOMER_ID,
      messageType: "image",
    },
    now: fixture.now,
  };
  const work = fixture.connector.acceptWhatsAppEvent(event);
  let completion: Promise<unknown> | null = null;
  try {
    await expect
      .poll(pausePhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    const relocationId = await startMove();
    completion = resumeActorRelocation({ env, relocationId, now: Date.now() });
    await expect
      .poll(readBarrier.bind(null, fixture.connector), { timeout: 10_000 })
      .toBe(1);
    expect(await exportedItemCount(relocationId)).toBe(0);
    expect(pause.providerAttempts).toBe(boundary === "notice_response" ? 1 : 0);
    pause.phase = "released";
    expect(await work).toMatchObject({
      ok: true,
      value: { kind: "unsupported" },
    });
    expect(await completion).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    await evictDurableObject(fixture.connector);
    expect(await fixture.connector.acceptWhatsAppEvent(event)).toMatchObject({
      ok: false,
      error: { code: "connector_placement_conflict" },
    });
    const target = required(
      await resolveActiveConnectorActor({
        env,
        namespace: env.CONNECTOR,
        organisationId: ORGANISATION_ID,
        connectorId: fixture.identity.connectorId,
        now: Date.now(),
      }),
    );
    expect(await runInDurableObject(target, readNoticeDelivered)).toBe(
      boundary === "notice_response",
    );
    await evictDurableObject(target);
    // Advance the persisted retry deadline without changing the runtime clock.
    await runInDurableObject(target, makeNoticeDue);
    await runDurableObjectAlarm(target);
    expect(await runInDurableObject(target, readNoticeDelivered)).toBe(true);
    await evictDurableObject(target);
    expect(await target.acceptWhatsAppEvent(event)).toMatchObject({
      ok: true,
      value: { kind: "unsupported" },
    });
    await runDurableObjectAlarm(target);
    expect(pause.providerAttempts).toBe(1);
    Object.assign(task.meta, {
      whatsappNoticePlacement: {
        boundary,
        exportedItemsWhilePaused: 0,
        providerAttempts: pause.providerAttempts,
        deliveredAfterRecovery: true,
      },
    });
  } finally {
    pause.phase = "released";
    crypto.subtle.decrypt = pause.decrypt;
    activePause = null;
    await Promise.allSettled(completion === null ? [work] : [work, completion]);
  }
}

function readNoticeDelivered(
  _actor: unknown,
  state: DurableObjectState,
): boolean {
  const rows = state.storage.sql
    .exec<{ delivered_at: number | null }>(
      "SELECT delivered_at FROM connector_whatsapp_operator_notice",
    )
    .toArray();
  expect(rows).toHaveLength(1);
  return rows[0]!.delivered_at !== null;
}
function makeNoticeDue(_actor: unknown, state: DurableObjectState): void {
  const rows = state.storage.sql
    .exec<{ notice_key: string }>(
      "SELECT notice_key FROM connector_whatsapp_operator_notice WHERE delivered_at IS NULL",
    )
    .toArray();
  for (const row of rows)
    deferWhatsAppNotice(
      state.storage.sql,
      row.notice_key,
      Date.now() - 120_000,
    );
}
async function noticeResponse(
  pause: Pause,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  expect(
    isRecord(body) &&
      typeof body.text === "string" &&
      body.text.includes("image"),
  ).toBe(true);
  expect(JSON.stringify(body)).not.toContain("Is my order ready?");
  pause.providerAttempts += 1;
  if (pause.boundary === "notice_response" && pause.phase === "armed") {
    pause.phase = "paused";
    while (pause.phase === "paused") await scheduler.wait(5);
  }
  return HttpResponse.json({
    ok: true,
    channel: "C12345678",
    ts: "1791072000.000055",
  });
}

function panelJourney(context: TestContext): Promise<void> {
  return whatsappPlacementJourney("panel", context);
}

function credentialJourney(context: TestContext): Promise<void> {
  return whatsappPlacementJourney("credential", context);
}
function responseJourney(context: TestContext): Promise<void> {
  return whatsappPlacementJourney("response", context);
}

async function whatsappPlacementJourney(
  boundary: ReplyBoundary,
  { task }: TestContext,
): Promise<void> {
  const fixture = await installFixture();
  const preview = await fixture.connector.previewWhatsAppProposal({
    identity: fixture.identity,
    proposalId: PROPOSAL_ID,
    now: fixture.now,
  });
  if (!preview.ok || preview.value.kind !== "current")
    throw new Error(JSON.stringify(preview));
  const approval = {
    origin: { kind: "operator" } as const,
    identity: fixture.identity,
    proposalId: PROPOSAL_ID,
    approvedVersion: preview.value.preview.version,
    approvedBodyDigest: preview.value.preview.bodyDigest,
    approvedBy: "operator:p55_whatsapp",
    now: fixture.now,
  };
  const pause: Pause = {
    boundary,
    phase: "armed",
    decrypt: crypto.subtle.decrypt,
    providerAttempts: 0,
  };
  activePause = pause;
  crypto.subtle.decrypt = pauseDecryption;
  network.use(
    http.post(
      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
      graphResponse.bind(null, pause),
    ),
  );
  const work = startPausedWork(boundary, fixture, approval);
  let completion: Promise<unknown> | null = null;
  try {
    await expect
      .poll(pausePhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    const relocationId = await startMove();
    const marker = { complete: false };
    completion = resumeActorRelocation({ env, relocationId, now: Date.now() });
    void completion.then(markComplete.bind(null, marker));
    await expect
      .poll(readBarrier.bind(null, fixture.connector), { timeout: 10_000 })
      .toBe(1);
    expect(marker.complete).toBe(false);
    expect(await exportedItemCount(relocationId)).toBe(0);
    expect(pause.providerAttempts).toBe(boundary === "response" ? 1 : 0);
    pause.phase = "released";
    const result = await work;
    if (boundary === "response") {
      expect(result).toMatchObject({
        ok: true,
        value: { kind: "sent", whatsappMessageId: MESSAGE_ID },
      });
    } else {
      expect(result).toMatchObject({
        ok: false,
        error: {
          code:
            boundary === "credential"
              ? "whatsapp_connection_inactive"
              : "connector_placement_conflict",
        },
      });
    }
    expect(await completion).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    await evictDurableObject(fixture.connector);
    expect(
      await fixture.connector.previewWhatsAppProposal({
        identity: fixture.identity,
        proposalId: PROPOSAL_ID,
        now: fixture.now,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "connector_placement_conflict" },
    });
    expect(
      await fixture.connector.dispatchWhatsAppReply(approval),
    ).toMatchObject({
      ok: false,
      error: { code: "connector_placement_conflict" },
    });
    expect(
      await fixture.connector.readWhatsAppCasePanel({
        identity: fixture.identity,
        caseId: fixture.caseId,
        now: fixture.now,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "connector_placement_conflict" },
    });
    const target = required(
      await resolveActiveConnectorActor({
        env,
        namespace: env.CONNECTOR,
        organisationId: ORGANISATION_ID,
        connectorId: fixture.identity.connectorId,
        now: Date.now(),
      }),
    );
    expect(await runInDurableObject(target, readProposal)).toMatchObject({
      state: boundary === "response" ? "sent" : "awaiting_approval",
    });
    await evictDurableObject(target);
    if (boundary === "panel") {
      expect(
        await target.readWhatsAppCasePanel({
          identity: fixture.identity,
          caseId: fixture.caseId,
          now: fixture.now,
        }),
      ).toMatchObject({
        ok: true,
        value: { messages: [{ text: "Is my order ready?" }] },
      });
    }
    const delivered = await target.dispatchWhatsAppReply(approval);
    expect(delivered, JSON.stringify(delivered)).toMatchObject({
      ok: true,
      value: { kind: "sent", whatsappMessageId: MESSAGE_ID },
    });
    await evictDurableObject(target);
    expect(await target.dispatchWhatsAppReply(approval)).toMatchObject({
      ok: true,
      value: { kind: "sent", whatsappMessageId: MESSAGE_ID },
    });
    expect(pause.providerAttempts).toBe(1);
    const receiptCount = await fixtureDatabase()
      .prepare(
        "SELECT COUNT(*) AS total FROM whatsapp_message_receipt WHERE organisation_id = ? AND direction = 'outbound'",
      )
      .bind(ORGANISATION_ID)
      .first<{ total: number }>();
    expect(receiptCount?.total).toBe(1);
    const projection = await fixtureDatabase()
      .prepare(
        "SELECT lifecycle_kind AS kind FROM whatsapp_reply_proposal WHERE proposal_id = ? AND organisation_id = ?",
      )
      .bind(PROPOSAL_ID, ORGANISATION_ID)
      .first<{ kind: string }>();
    expect(projection?.kind).toBe("sent");
    Object.assign(task.meta, {
      whatsappPlacement: {
        boundary,
        withheldSourceContinuation: boundary !== "response",
        exportedItemsWhilePaused: 0,
        providerAttempts: pause.providerAttempts,
        outboundReceipts: receiptCount?.total,
        recoveredProjection: projection?.kind,
      },
    });
  } finally {
    pause.phase = "released";
    crypto.subtle.decrypt = pause.decrypt;
    activePause = null;
    await Promise.allSettled(completion === null ? [work] : [work, completion]);
  }
}

function startPausedWork(
  boundary: ReplyBoundary,
  fixture: Fixture,
  approval: Parameters<ConnectorDO["dispatchWhatsAppReply"]>[0],
) {
  switch (boundary) {
    case "panel":
      return fixture.connector.readWhatsAppCasePanel({
        identity: fixture.identity,
        caseId: fixture.caseId,
        now: fixture.now,
      });
    case "credential":
    case "response":
      return fixture.connector.dispatchWhatsAppReply(approval);
  }
}

async function pauseDecryption(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["decrypt"]>[0],
  key: Parameters<SubtleCrypto["decrypt"]>[1],
  data: Parameters<SubtleCrypto["decrypt"]>[2],
): Promise<ArrayBuffer> {
  const pause = activePause;
  if (pause === null) throw new Error("Missing WhatsApp pause");
  const opened = await pause.decrypt.call(this, algorithm, key, data);
  const plaintext = new TextDecoder().decode(opened);
  if (
    pause.phase === "armed" &&
    ((pause.boundary === "panel" && plaintext === "Is my order ready?") ||
      (pause.boundary === "credential" && plaintext.includes(TOKEN)) ||
      (pause.boundary === "notice_credential" &&
        plaintext.includes(SLACK_BOT_TOKEN)))
  ) {
    pause.phase = "paused";
    while (pause.phase === "paused") await scheduler.wait(5);
  }
  return opened;
}

async function graphResponse(
  pause: Pause,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  expect(isRecord(body) && isRecord(body.text) && body.text.body).toBe(REPLY);
  pause.providerAttempts += 1;
  if (pause.boundary === "response" && pause.phase === "armed") {
    pause.phase = "paused";
    while (pause.phase === "paused") await scheduler.wait(5);
  }
  return HttpResponse.json({ messages: [{ id: MESSAGE_ID }] });
}
function pausePhase(pause: Pause): Pause["phase"] {
  return pause.phase;
}
function markComplete(marker: { complete: boolean }): void {
  marker.complete = true;
}
function readProposal(_actor: unknown, state: DurableObjectState) {
  return latestWhatsAppProposal(state.storage.sql, PROPOSAL_ID);
}

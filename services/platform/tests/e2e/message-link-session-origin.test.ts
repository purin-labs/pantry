import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { network } from "./network";
import {
  installSlackActorFixture,
  createRequiredGrant,
  openRouterToolCall,
  openRouterText,
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
} from "./slack-journey-support";
import { parseRequestId, parseSessionId } from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import {
  issueControlSession,
  readActiveOrganisationMembershipRevision,
  type IssuedControlSession,
} from "@purin-labs/tenancy/data/control-plane";
import { buildControlAuthority } from "../../src/request-authority";
import { processDirectCaseCommand } from "../../src/actors/case-direct-processing";
import { deriveDirectCaseIdentities } from "../../src/actors/case-direct-processing";
import { deriveUserMessageViews } from "../../src/messages/message-wasm";
import { writeOrganisationCapabilityPolicy } from "../../src/data/capability-policy";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import {
  requireActiveOrganisationActor,
  resolveActiveSessionActor,
} from "../../src/actors/actor-router";

const LINK = "https://supplier.example.net/schedule?private=fixture";
const FINAL_LINK = "https://docs.example.net/delivery";
const PAGE_TEXT = "P55 link content: Friday delivery at 09:00.";
type Boundary = "dns" | "receipt_hash";
type Journey = {
  readonly boundary: Boundary;
  readonly digest: SubtleCrypto["digest"];
  phase: "armed" | "paused" | "released";
  requests: number;
  modelRequests: number;
  toolIssued: boolean;
  discoveries: number;
};
let activeJourney: Journey | null = null;

it.for(["dns", "receipt_hash"] as const)(
  "fences message link %s against origin revocation and preserves accepted state after eviction",
  { timeout: 45_000 },
  linkOriginJourney,
);
async function linkOriginJourney(
  boundary: Boundary,
  { task }: TestContext,
): Promise<void> {
  const { original, fresh } = await fixture();
  const journey: Journey = {
    boundary,
    digest: crypto.subtle.digest,
    phase: "armed",
    requests: 0,
    modelRequests: 0,
    toolIssued: false,
    discoveries: 0,
  };
  const transport = new PinnedLinkFixture(journey);
  activeJourney = journey;
  crypto.subtle.digest = pauseReceiptHash;
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToModel.bind(null, journey, transport),
    ),
    http.get(
      "https://cloudflare-dns.com/dns-query",
      respondToDns.bind(null, journey),
    ),
  );
  const key = `p55_link_${boundary}`;
  const pending = dispatch(original, key, transport);
  try {
    await expect
      .poll(currentPhase.bind(null, journey), { timeout: 15_000 })
      .toBe("paused");
    const actor = await sessionActor(original);
    const modelRequests = journey.modelRequests;
    const requests = journey.requests;
    expect(requests).toBe(boundary === "dns" ? 0 : 2);
    await env.DB.prepare(
      "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
    )
      .bind(Date.now(), original.session.controlSessionId)
      .run();
    journey.phase = "released";
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(PAGE_TEXT);
    expect(journey.modelRequests).toBe(modelRequests);
    expect(journey.requests).toBe(requests);
    const retained = await runInDurableObject(actor, retainedState);
    expect(retained.history).not.toContain(PAGE_TEXT);
    await runInDurableObject(actor, clearLinkTransport);
    await evictDurableObject(actor);
    expect(await runInDurableObject(actor, retainedState)).toEqual(retained);
    expect((await dispatch(fresh, key, transport)).ok).toBe(false);
    expect(journey.requests).toBe(requests);
    journey.toolIssued = false;
    const allowed = await dispatch(fresh, `${key}_fresh`, transport);
    expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
    expect(journey.requests).toBe(requests + 2);
    const freshActor = await sessionActor(fresh);
    const accepted = await runInDurableObject(freshActor, retainedState);
    expect(accepted.history).toContain(PAGE_TEXT);
    await runInDurableObject(freshActor, clearLinkTransport);
    Object.assign(task.meta, {
      messageLinkOriginAcceptance: {
        boundary,
        requestsBeforeRevocation: requests,
        requestsAfterRevocation: 0,
        resultWithheld: true,
        historyWithheld: true,
        evictionRetained: true,
        duplicateRequests: 0,
        authorizedFreshRequests: 2,
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
async function waitForRelease(journey: Journey): Promise<void> {
  journey.phase = "paused";
  while (journey.phase === "paused") await scheduler.wait(5);
}
async function pauseReceiptHash(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["digest"]>[0],
  data: Parameters<SubtleCrypto["digest"]>[1],
): Promise<ArrayBuffer> {
  const journey = activeJourney;
  if (journey === null) throw new Error("Missing link journey");
  const result = await journey.digest.call(this, algorithm, data);
  if (
    journey.phase === "armed" &&
    journey.boundary === "receipt_hash" &&
    new TextDecoder().decode(data) === PAGE_TEXT
  )
    await waitForRelease(journey);
  return result;
}
async function respondToDns(
  journey: Journey,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const url = new URL(request.url);
  if (
    journey.phase === "armed" &&
    journey.boundary === "dns" &&
    url.searchParams.get("type") === "A"
  )
    await waitForRelease(journey);
  return HttpResponse.json({
    Status: 0,
    Answer:
      url.searchParams.get("type") === "A"
        ? [{ type: 1, data: "93.184.216.34" }]
        : [],
  });
}
class PinnedLinkFixture {
  constructor(readonly journey: Journey) {}
  getByName(name: string, options?: { readonly locationHint?: string }) {
    // The Actor of the fixture organisation's region, with its hint.
    expect([name, options?.locationHint]).toEqual([
      "public-links:wnam",
      "wnam",
    ]);
    return this;
  }
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    expect(request.url).toBe("http://container/v1/fetch");
    const raw: unknown = await request.json();
    if (!isRecord(raw) || typeof raw.url !== "string")
      throw new Error("Invalid pinned link request");
    expect(raw.address).toBe("93.184.216.34");
    expect(request.headers.get("authorization")).toBeNull();
    this.journey.requests++;
    if (raw.url === LINK) {
      return HttpResponse.json({
        status: 302,
        contentType: null,
        location: FINAL_LINK,
        bodyBase64: "",
      });
    }
    expect(raw.url).toBe(FINAL_LINK);
    return HttpResponse.json({
      status: 200,
      contentType: "text/plain",
      location: null,
      bodyBase64: btoa(PAGE_TEXT),
    });
  }
}
async function respondToModel(
  journey: Journey,
  transport: PinnedLinkFixture,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  journey.modelRequests++;
  const raw: unknown = await request.json();
  if (!isRecord(raw) || !Array.isArray(raw.tools))
    throw new Error("Missing link tools");
  const row = await fixtureDatabase()
    .prepare(
      "SELECT control_session_id FROM session_turn_access WHERE organisation_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .bind(ORGANISATION_ID)
    .first<{ control_session_id: string }>();
  if (row === null) throw new Error("Missing link origin");
  const actor = await sessionActorByOrigin(row.control_session_id);
  await runInDurableObject(actor, installLinkTransport.bind(null, transport));
  if (journey.toolIssued)
    return openRouterText(
      JSON.stringify({ kind: "reply", text: "Link request completed." }),
      "p55_link_done",
    );
  if (!raw.tools.some(isLinkTool)) {
    if (++journey.discoveries > 8)
      throw new Error("Link discovery did not complete");
    return openRouterToolCall(
      "tool_search",
      { query: "read_message_link", limit: 1 },
      `p55_link_discovery_${journey.discoveries}`,
    );
  }
  journey.toolIssued = true;
  return openRouterToolCall(
    "read_message_link",
    { url: LINK },
    "p55_link_read",
  );
}
function isLinkTool(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    isRecord(raw.function) &&
    raw.function.name === "read_message_link"
  );
}
function installLinkTransport(
  transport: PinnedLinkFixture,
  actor: object,
): void {
  const bindings = Reflect.get(actor, "env");
  if (!isRecord(bindings)) throw new Error("Missing Actor environment");
  Object.defineProperty(bindings, "MESSAGE_LINK_FETCH", {
    configurable: true,
    value: transport,
  });
}
function clearLinkTransport(actor: object): void {
  const bindings = Reflect.get(actor, "env");
  if (!isRecord(bindings)) throw new Error("Missing Actor environment");
  Reflect.deleteProperty(bindings, "MESSAGE_LINK_FETCH");
}
function retainedState(_actor: unknown, state: DurableObjectState) {
  return {
    history: JSON.stringify(
      state.storage.sql.exec("SELECT * FROM session_harness_history").toArray(),
    ),
    observations: state.storage.sql
      .exec(
        "SELECT evidence_json FROM session_information_flow_observation ORDER BY rowid",
      )
      .toArray(),
  };
}
function sessionActor(session: IssuedControlSession) {
  return sessionActorByOrigin(session.session.controlSessionId);
}
async function sessionActorByOrigin(controlSessionId: string) {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT session_id FROM session_turn_access WHERE organisation_id = ? AND control_session_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .bind(ORGANISATION_ID, controlSessionId)
    .first<{ session_id: string }>();
  if (row === null) throw new Error("Missing link Session");
  const sessionId = parseSessionId(row.session_id);
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const actor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  return actor.value;
}
async function dispatch(
  session: IssuedControlSession,
  key: string,
  transport: PinnedLinkFixture,
) {
  const revision = await readActiveOrganisationMembershipRevision({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
  });
  if (revision === null) throw new Error("Missing membership");
  const requestId = parseRequestId(`request_${key}`);
  if (!requestId.ok) throw new Error(requestId.error.code);
  const authority = buildControlAuthority({
    organisationId: ORGANISATION_ID,
    userId: session.session.userId,
    requesterPersonId: "person_e2e-slack-actor",
    membershipRevision: revision,
    role: "admin",
  }).requestAuthority;
  const message = deriveUserMessageViews({
    firstPart: { kind: "text", text: "Inspect this supplier page." },
    remainingParts: [
      {
        kind: "link",
        link: { url: LINK, presentation: { kind: "url" } },
      },
    ],
  });
  if (!message.ok) throw new Error(message.error.code);
  const stableIdentity = `${ORGANISATION_ID}:p55-link:${key}`;
  const identities = await deriveDirectCaseIdentities(stableIdentity);
  if (!identities.ok) throw new Error(identities.error.code);
  const actor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: identities.value.sessionId,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  await runInDurableObject(
    actor.value,
    installLinkTransport.bind(null, transport),
  );
  return processDirectCaseCommand(env, {
    scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    projectContext: null,
    organisationId: ORGANISATION_ID,
    requestId: requestId.value,
    stableIdentity,
    operatorOrigin: {
      kind: "control_session",
      controlSessionId: session.session.controlSessionId,
    },
    triggerSource: { kind: "api", commandId: `command_${key}` },
    content: { kind: "user_message", message: message.value.message },
    purpose: "Inspect the supplier page.",
    principal: { kind: "human", principalId: "person_e2e-slack-actor" },
    requestAuthority: authority,
    receivedAt: Date.now(),
    role: "coordinator",
    objective: "Inspect the supplier page.",
    delivery: { kind: "none" },
    browserContext: { kind: "unavailable" },
    surfaceContext: null,
  });
}
async function fixture() {
  await installSlackActorFixture();
  const user = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!user.ok) throw new Error(user.error.code);
  const now = Date.now();
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "UPDATE service_role_grant SET role = 'admin' WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(ORGANISATION_ID, SLACK_ACTOR_USER_ID),
    fixtureDatabase()
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_p55_link', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(now, ORGANISATION_ID),
  ]);
  for (const capabilityId of ["context.case.read", "message.link.read"])
    await createRequiredGrant({
      grantId: `grant_p55_link_${capabilityId}`,
      subject: { kind: "organisation_role", role: "admin" },
      target: {
        kind: "platform_capability",
        capabilityId,
        capabilityVersion: 1,
      },
      now,
    });
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const enabled = await writeOrganisationCapabilityPolicy({
    scope,
    write: {
      kind: "change",
      capabilityId: "message.link.read",
      expectedRevision: 1,
      mode: "enabled",
      provenance: {
        kind: "operator",
        userId: user.value,
        mutationReceiptId: "receipt_p55_link_read",
      },
      now,
    },
  });
  if (!enabled.ok) throw new Error(enabled.error.code);
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

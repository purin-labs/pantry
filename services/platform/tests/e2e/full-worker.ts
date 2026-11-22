import { isRecord } from "@purin-labs/std";
import { createCancellableTask } from "@purin-labs/async-control/cancellable-task";
import { runTaskBeforeDeadline } from "@purin-labs/async-control/deadline";
import { seedMerchantFixture } from "./merchant-fixture";
import { restoreSessionTurnContext } from "../../src/actors/actor-journal";
import { DurableObject } from "cloudflare:workers";
import { newConversationId } from "@purin-labs/control-api";
import gateway from "../../src/integration-gateway";
import type { Env } from "@purin-labs/kernel/env";
import { CaseDO } from "../../src/actors/case";
import { SessionDO } from "../../src/actors/agent-session";
import { OrganisationDO } from "../../src/actors/organisation";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { deriveDirectCaseIdentities } from "../../src/actors/case-direct-processing";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import { parseInitialOrganisationPlacement } from "@purin-labs/tenancy/placement";
import {
  bootstrapOrganisation,
  upsertUser,
  issueControlSession,
} from "@purin-labs/tenancy/data/control-plane";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { readConversation } from "../../src/chat/store";
import { conversationTimeline } from "../../src/chat/conversation";
import { newControlMutationIdentity } from "@purin-labs/tenancy/data/control-mutation";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { PLATFORM_DEFAULT_PI_MODEL } from "../../src/actors/pi-model-transport";

export { CodeModePlatformGovernorActor } from "../../src/actors/code-mode-platform-governor";

type Region = "wnam" | "apac";
type FixtureIdentity = {
  readonly organisationId: OrganisationId;
  readonly userId: UserId;
  readonly role: "owner";
};
type FullEnv = Env & {
  PROBE_TOKEN: string;
  SELF_ORIGIN: string;
  DATABASE_REGION: Region;
  CLIENT: DurableObjectNamespace<FullClient>;
  SESSION_PROBE: DurableObjectNamespace<FullSession>;
};

const PRIOR_FACT = "The pastry collection code is AMBER-OTTER-7391.";
const FOLLOWUP_REQUEST =
  "Recall the pastry collection code from my previous request.";

const nativeFetch = globalThis.fetch.bind(globalThis);
let networkState: "disabled" | "enabled" = "disabled";

export class FullCase extends CaseDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, fixtureEnvironment(env));
  }
}

export class FullOrganisation extends OrganisationDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, fixtureEnvironment(env));
  }
}

export class FullSession extends SessionDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, fixtureEnvironment(env));
  }

  async clock() {
    return Date.now();
  }

  override async startCanonicalEmbeddedHarnessTextTurn(
    input: Parameters<SessionDO["startCanonicalEmbeddedHarnessTextTurn"]>[0],
  ) {
    const enteredAt = Date.now();
    if (input.start.input.kind !== "case")
      throw new Error("fixture_requires_case");
    const context = await restoreSessionTurnContext(input.context);
    if (context === null) throw new Error("invalid_boundary_context");
    const quality = {
      disposition: context.bundle.disposition,
      modelDisposition: context.modelContext.disposition,
      itemCount: context.bundle.items.length,
      modelItemCount: context.modelContext.items.length,
      priorFactPresent: JSON.stringify(context.modelContext).includes(
        PRIOR_FACT,
      ),
    };
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO plan55_harness_boundary (request_id, case_id, actor_id, entered_at, prompt_bytes, instructions_bytes, context_bytes, quality_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        input.requestId,
        input.start.input.caseId,
        this.ctx.id.toString(),
        enteredAt,
        new TextEncoder().encode(input.turnPrompt).length,
        new TextEncoder().encode(input.harnessInstructions).length,
        new TextEncoder().encode(JSON.stringify(input.context)).length,
        JSON.stringify(quality),
      )
      .run();
    if (networkState === "disabled") {
      globalThis.fetch = simulatedFetch;
      networkState = "enabled";
    }
    const result = await super.startCanonicalEmbeddedHarnessTextTurn(input);
    if (!result.ok) {
      console.error("plan55_turn_failure", result.error);
      if (result.error.code === "journal_sequence_gap") {
        console.error(
          "plan55_journal_transitions",
          this.ctx.storage.sql
            .exec(
              "SELECT sequence, json_extract(envelope, '$.body.kind') AS transition FROM actor_journal ORDER BY sequence",
            )
            .toArray(),
        );
      }
    }
    return result;
  }
}

export class FullClient extends DurableObject<FullEnv> {
  async measure(actor: Region, scenario: "fresh" | "existing") {
    const started = performance.now();
    const response = await fetch(
      `${this.env.SELF_ORIGIN}/measure/${actor}/${scenario}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.env.PROBE_TOKEN}` },
      },
    );
    return {
      status: response.status,
      clientRoundTripMs: performance.now() - started,
      measurement: await response.json(),
    };
  }
}

export default { fetch: handleRequest, queue: handleQueue };

async function handleQueue(
  batch: MessageBatch<unknown>,
  env: FullEnv,
): Promise<void> {
  if (batch.queue !== `pantry-plan55-full-${env.DATABASE_REGION}`)
    throw new Error("fixture_queue_mismatch");
  await gateway.queue(
    {
      queue: "pantry-events",
      metadata: batch.metadata,
      messages: batch.messages,
      ackAll: batch.ackAll.bind(batch),
      retryAll: batch.retryAll.bind(batch),
    },
    fixtureEnvironment(env),
  );
}

async function handleRequest(
  request: Request,
  env: FullEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  if (
    !env.PROBE_TOKEN ||
    request.headers.get("authorization") !== `Bearer ${env.PROBE_TOKEN}`
  )
    return new Response(null, { status: 401 });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  try {
    if (parts[0] === "seed" && parts.length === 1) {
      await seed(env, "wnam", `plan55-split-${env.DATABASE_REGION}-wnam`);
      await seed(env, "apac", `plan55-split-${env.DATABASE_REGION}-apac`);
      return Response.json({ seeded: true });
    }
    if (parts[0] === "via" && parts.length === 4) {
      const client = region(parts[1]);
      const actor = region(parts[2]);
      const scenario = scenarioValue(parts[3]);
      return Response.json(
        await env.CLIENT.getByName(`client-${client}`, {
          locationHint: client,
        }).measure(actor, scenario),
      );
    }
    if (parts[0] === "measure" && parts.length === 3) {
      return Response.json(
        await measure(
          env,
          ctx,
          region(parts[1]),
          scenarioValue(parts[2]),
          request.cf?.colo ?? null,
        ),
      );
    }
    return new Response(null, { status: 404 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "fixture_failed" },
      { status: 500 },
    );
  }
}

function region(raw: string | undefined): Region {
  if (raw === "wnam" || raw === "apac") return raw;
  throw new Error("invalid_region");
}

function scenarioValue(raw: string | undefined): "fresh" | "existing" {
  if (raw === "fresh" || raw === "existing") return raw;
  throw new Error("invalid_scenario");
}

function fixtureDatabase(env: FullEnv): D1Database {
  const database =
    env.DATABASE_REGION === "wnam"
      ? env.ORGANISATION_DB_WNAM
      : env.ORGANISATION_DB_APAC;
  if (database === undefined)
    throw new Error("fixture_regional_database_missing");
  return database;
}

async function fixtureRoot(): Promise<string> {
  return "ERERERERERERERERERERERERERERERERERERERERERE=";
}

function fixtureEnvironment(env: Env): Env {
  return {
    ...env,
    DATA_ENCRYPTION_ROOT: { get: fixtureRoot },
    VAULT_ROOT_V1: { get: fixtureRoot },
    PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
    OPENROUTER_API_KEY: "plan55-simulated-inference-no-provider-credential",
  };
}

function simulatedResponse(text: string): Response {
  const id = `plan55_${crypto.randomUUID()}`;
  const first = {
    id,
    object: "chat.completion.chunk",
    created: 1790985600,
    model: PLATFORM_DEFAULT_PI_MODEL,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: JSON.stringify({ kind: "reply", text }),
        },
        finish_reason: null,
      },
    ],
  };
  const last = {
    id,
    object: "chat.completion.chunk",
    created: 1790985600,
    model: PLATFORM_DEFAULT_PI_MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return new Response(
    `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function simulatedFetch(
  input: Request | string | URL,
  init?: RequestInit,
): Promise<Response> {
  let address: string;
  if (typeof input === "string") address = input;
  else if (input instanceof URL) address = input.href;
  else address = input.url;
  const url = new URL(address);
  if (
    url.origin === "https://openrouter.ai" &&
    url.pathname === "/api/v1/chat/completions"
  ) {
    const request = new Request(input, init);
    const payload = await request.text();
    let merchant: Response | null;
    try {
      merchant = merchantModelStep(JSON.parse(payload));
    } catch (error) {
      console.error(
        "plan55_merchant_fixture_failed",
        error instanceof Error ? error.message : "unknown",
      );
      throw error;
    }
    if (merchant !== null) return merchant;
    const isFollowup = payload.includes(FOLLOWUP_REQUEST);
    let reply = "OK";
    if (isFollowup) {
      reply = payload.includes(PRIOR_FACT)
        ? "OK_CONTEXT_PRESENT"
        : "OK_CONTEXT_MISSING";
    }
    return simulatedResponse(reply);
  }
  return nativeFetch(input instanceof URL ? input.href : input, init);
}

function merchantModelStep(payload: unknown): Response | null {
  if (!isRecord(payload) || !Array.isArray(payload.messages))
    throw new Error("merchant_model_messages_invalid");
  let lastTool: Record<string, unknown> | null = null;
  const calls = new Map<string, string>();
  for (const message of payload.messages) {
    if (!isRecord(message)) throw new Error("merchant_model_message_invalid");
    if (message.role === "user") lastTool = null;
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (
          !isRecord(call) ||
          typeof call.id !== "string" ||
          !isRecord(call.function) ||
          typeof call.function.name !== "string"
        )
          throw new Error("merchant_model_tool_call_invalid");
        calls.set(call.id, call.function.name);
      }
    }
    if (message.role === "tool") lastTool = message;
  }
  if (lastTool === null)
    return simulatedToolResponse(
      "tool_search",
      {
        query: "commerce_entity_context",
        limit: 1,
      },
      "plan55_merchant_discovery",
    );
  if (typeof lastTool.tool_call_id !== "string")
    throw new Error("merchant_model_tool_result_invalid");
  const toolName = calls.get(lastTool.tool_call_id);
  if (toolName === "tool_search") {
    if (!JSON.stringify(lastTool.content).includes("commerce_entity_context"))
      throw new Error("merchant_tool_discovery_failed");
    return simulatedToolResponse(
      "commerce_entity_context",
      {
        request: {
          selection: {
            kind: "entity_seeds",
            seeds: [
              {
                origin: "system",
                typeId: "product",
                entityId: "product_plan55_cookies",
              },
            ],
          },
          traversal: { maxDepth: 0, resultLimit: 1 },
          allowedSensitivity: "internal",
          allowedAttributeIds: [],
          freshnessRequirement: "current_only",
        },
      },
      "plan55_merchant_read",
    );
  }
  if (toolName !== "commerce_entity_context")
    throw new Error(
      `merchant_tool_sequence_invalid: ${String(lastTool.tool_call_id)}`,
    );
  if (!JSON.stringify(lastTool.content).includes("product_plan55_cookies"))
    throw new Error(
      `merchant_product_result_missing: ${JSON.stringify(lastTool.content)}`,
    );
  return null;
}

function simulatedToolResponse(
  name: string,
  args: Readonly<Record<string, unknown>>,
  callId: string,
): Response {
  const id = `plan55_${crypto.randomUUID()}`;
  const first = {
    id,
    object: "chat.completion.chunk",
    created: 1790985600,
    model: PLATFORM_DEFAULT_PI_MODEL,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: callId,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  const last = {
    id,
    object: "chat.completion.chunk",
    created: 1790985600,
    model: PLATFORM_DEFAULT_PI_MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  };
  return new Response(
    `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function seed(rawEnv: FullEnv, actor: Region, identity: string) {
  const env = fixtureEnvironment(rawEnv);
  const now = Date.now();
  const owner = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject: identity,
      email: `${identity}@example.invalid`,
      displayName: "Plan55 fixture",
      emailVerified: true,
    },
    now,
  });
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: `plan55-full-${rawEnv.DATABASE_REGION}-${actor}`,
    locationHint: actor,
  });
  if (!placement.ok) throw new Error("fixture_placement_invalid");
  const created = await bootstrapOrganisation({
    env,
    owner,
    organisationName: identity,
    environment: "development",
    placement: placement.value,
    now,
    mutation: {
      scope: {
        userId: owner.userId,
        organisationScope: "organisation:create",
        route: "/v1/control/organisations",
        operation: "organisation.create",
      },
      boundary: {
        kind: "unversioned",
        idempotencyKey: identity,
        requestHash: identity,
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: identity,
        causationId: identity,
        now,
      }),
    },
  });
  if (!created.ok) throw new Error(created.error.code);
  await ensureCreatedOrganisationActor({
    env,
    organisationId: created.value.organisationId,
    now,
  });
  const scope = await OrganisationExecutionScope.resolve(
    env,
    created.value.organisationId,
  );
  if (!scope.ok) throw new Error(scope.error.code);
  const database = scope.value.database;
  await database.batch([
    database
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_plan55', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(now, scope.value.organisationId),
    database
      .prepare(
        "INSERT OR IGNORE INTO organisation_inference_selection (organisation_id, selection_kind, selected_by_user_id, selected_at) VALUES (?, 'pantry_platform', ?, ?)",
      )
      .bind(scope.value.organisationId, owner.userId, now),
  ]);
  await seedMerchantFixture(env, {
    organisationId: scope.value.organisationId,
    userId: owner.userId,
    role: "owner",
  });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: scope.value.organisationId,
    now,
  });
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: database, kv: env.POLICY_KV },
    organisationId: scope.value.organisationId,
    organisation,
    now,
  });
  if (!policy.ok) throw new Error(policy.error.code);
  const session = await issueControlSession({
    db: env.DB,
    userId: owner.userId,
    now,
    ttlMs: 8 * 60 * 60 * 1000,
  });
  const fixture: FixtureIdentity = {
    organisationId: scope.value.organisationId,
    userId: owner.userId,
    role: "owner",
  };
  return { scope: fixture, session };
}

async function measure(
  rawEnv: FullEnv,
  ctx: ExecutionContext,
  actor: Region,
  scenario: "fresh" | "existing",
  ingressColo: unknown,
) {
  const env = fixtureEnvironment(rawEnv);
  // Each sample owns its corpus. Queue materialization from earlier samples
  // must not change the context or payload of this measurement.
  const organisationSetupStartedAt = Date.now();
  const { scope, session } = await seed(
    rawEnv,
    actor,
    `plan55-sample-${rawEnv.DATABASE_REGION}-${actor}-${crypto.randomUUID()}`,
  );
  const organisationSetupMs = Date.now() - organisationSetupStartedAt;
  const database = fixtureDatabase(rawEnv);
  const conversationId = newConversationId();
  const identity = await deriveDirectCaseIdentities(
    `${scope.organisationId}:portal-chat:${scope.userId}:${conversationId}`,
  );
  if (!identity.ok) throw new Error(identity.error.code);
  if (scenario === "existing")
    await turn(
      env,
      database,
      ctx,
      scope,
      session,
      conversationId,
      "setup",
      PRIOR_FACT,
    );
  const result = await turn(
    env,
    database,
    ctx,
    scope,
    session,
    conversationId,
    "measured",
    scenario === "existing"
      ? FOLLOWUP_REQUEST
      : "Read the cookie product from the merchant catalog, then reply OK.",
  );
  const boundary = await env.DB.prepare(
    "SELECT request_id AS requestId, actor_id AS actorId, entered_at AS enteredAt, prompt_bytes AS promptBytes, instructions_bytes AS instructionsBytes, context_bytes AS contextBytes, quality_json AS qualityJson FROM plan55_harness_boundary WHERE case_id = ? ORDER BY entered_at DESC LIMIT 1",
  )
    .bind(identity.value.caseId)
    .first<{
      requestId: string;
      actorId: string;
      enteredAt: number;
      promptBytes: number;
      instructionsBytes: number;
      contextBytes: number;
      qualityJson: string;
    }>();
  if (boundary === null) throw new Error("harness_boundary_missing");
  const clockBefore = Date.now();
  const remoteClock = await rawEnv.SESSION_PROBE.get(
    rawEnv.SESSION_PROBE.idFromString(boundary.actorId),
  ).clock();
  const clockAfter = Date.now();
  const offsetLow = remoteClock - clockAfter;
  const offsetHigh = remoteClock - clockBefore;
  const databaseObservation = await database
    .withSession("first-primary")
    .prepare("SELECT 1")
    .all();
  const directoryObservation = await env.DB.withSession("first-primary")
    .prepare("SELECT 1")
    .all();
  return {
    kind: "full_preparation",
    organisationSetupMs,
    databaseTopology: "split_global_regional",
    contextCorpus: "isolated_organisation_per_sample",
    organisationId: scope.organisationId,
    directoryDatabaseObservation: directoryObservation.meta,
    databaseHint: rawEnv.DATABASE_REGION,
    actorHint: actor,
    actorObservedLocation: null,
    scenario,
    ingressColo,
    conversationId,
    caseId: identity.value.caseId,
    requestId: boundary.requestId,
    sessionActorId: boundary.actorId,
    preparationMs:
      boundary.enteredAt - result.eventCreatedAt - (offsetLow + offsetHigh) / 2,
    ingressToHarnessMs:
      boundary.enteredAt - result.ingressAt - (offsetLow + offsetHigh) / 2,
    clockUncertaintyMs: (offsetHigh - offsetLow) / 2,
    clockAssumption:
      "stable relative clocks during one turn; calibrated by bounded RPC after completion",
    firstOutputMs: result.firstOutputMs,
    streamCompletionMs: result.streamCompletionMs,
    streamConnections: result.streamConnections,
    fullTurnMs: result.durationMs,
    merchantRead: "verified",
    firstOutputDefinition:
      "first nonempty authorized assistant_text_delta received by the ingress Worker",
    historyEvents: result.historyEvents,
    promptBytes: boundary.promptBytes,
    instructionsBytes: boundary.instructionsBytes,
    contextBytes: boundary.contextBytes,
    contextQuality: JSON.parse(boundary.qualityJson),
    providerContextCheck: result.providerContextCheck,
    databaseObservation: databaseObservation.meta,
    inference: "simulated",
    providerUsage: "unknown",
    realInferenceCalls: 0,
  };
}

async function turn(
  env: Env,
  database: D1Database,
  ctx: ExecutionContext,
  scope: FixtureIdentity,
  session: { token: string; csrfToken: string },
  conversationId: ReturnType<typeof newConversationId>,
  label: string,
  text: string,
) {
  const requestId = `request_plan55_${label}_${crypto.randomUUID()}`;
  const started = performance.now();
  const ingressAt = Date.now();
  const response = await gateway.fetch(
    new Request(
      `${env.PANTRY_PUBLIC_ORIGIN}/v1/control/organisations/${scope.organisationId}/chat`,
      {
        method: "POST",
        headers: {
          origin: env.PANTRY_PUBLIC_ORIGIN,
          "content-type": "application/json",
          cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
          "x-pantry-csrf": session.csrfToken,
        },
        body: JSON.stringify({
          kind: "message",
          conversationId,
          requestId,
          model: PLATFORM_DEFAULT_PI_MODEL,
          text,
          browserContext: { kind: "unavailable" },
        }),
      },
    ),
    env,
    ctx,
  );
  if (!response.ok)
    throw new Error(
      `chat_admission_${response.status}_${await response.text()}`,
    );
  await response.body?.cancel();
  const query = new URLSearchParams({
    conversation: conversationId,
    request: requestId,
    after: "-1",
  });
  const streamRequest = new Request(
    `${env.PANTRY_PUBLIC_ORIGIN}/v1/control/organisations/${scope.organisationId}/chat/stream?${query}`,
    {
      headers: {
        accept: "application/x-ndjson",
        cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
      },
    },
  );
  const streamTiming = await measurePortalOutput(
    env,
    ctx,
    streamRequest,
    started,
  );
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const stored = await readConversation(database, scope, conversationId);
    if (stored === null) throw new Error("fixture_conversation_missing");
    if (stored.conversation.work.kind === "failed")
      throw new Error("fixture_turn_failed");
    if (stored.conversation.work.kind === "ready") {
      const timeline = conversationTimeline(stored.conversation);
      let completed = false;
      let providerContextCheck: "not_applicable" | "present" | "missing" =
        "not_applicable";
      for (const event of timeline) {
        if (
          event.kind === "assistant" &&
          event.requestId === requestId &&
          ["OK", "OK_CONTEXT_PRESENT", "OK_CONTEXT_MISSING"].includes(
            event.text.trim(),
          )
        ) {
          completed = true;
          if (event.text.trim() === "OK_CONTEXT_PRESENT")
            providerContextCheck = "present";
          if (event.text.trim() === "OK_CONTEXT_MISSING")
            providerContextCheck = "missing";
        }
      }
      if (!completed) throw new Error("simulated_completion_missing");
      for (const event of timeline) {
        if (event.kind === "user" && event.requestId === requestId) {
          return {
            requestId,
            eventCreatedAt: event.createdAt,
            ingressAt,
            durationMs: performance.now() - started,
            firstOutputMs: streamTiming.firstOutputMs,
            streamCompletionMs: streamTiming.streamCompletionMs,
            streamConnections: streamTiming.streamConnections,
            historyEvents: timeline.length,
            providerContextCheck,
          };
        }
      }
      throw new Error("persisted_user_event_missing");
    }
    await new Promise<void>(waitForPoll);
  }
  throw new Error("fixture_turn_timeout");
}

function waitForPoll(resolve: () => void): void {
  setTimeout(resolve, 500);
}

type PortalOutputProgress = {
  afterSequence: number;
  firstOutputMs: number | null;
  streamCompletionMs: number | null;
};

async function measurePortalOutput(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  started: number,
) {
  const progress: PortalOutputProgress = {
    afterSequence: -1,
    firstOutputMs: null,
    streamCompletionMs: null,
  };
  const deadline = Date.now() + 90_000;
  let streamConnections = 0;
  while (Date.now() < deadline && progress.streamCompletionMs === null) {
    const url = new URL(request.url);
    url.searchParams.set("after", String(progress.afterSequence));
    const response = await gateway.fetch(new Request(url, request), env, ctx);
    if (response.status === 409) {
      await response.body?.cancel();
    } else {
      if (!response.ok)
        throw new Error(`fixture_stream_admission_${response.status}`);
      streamConnections += 1;
      await readPortalOutput(response, started, progress, deadline);
    }
    if (progress.streamCompletionMs === null) await scheduler.wait(25);
  }
  if (progress.streamCompletionMs === null)
    throw new Error("fixture_stream_completion_missing");
  if (progress.firstOutputMs === null)
    throw new Error("fixture_first_output_unobserved");
  return {
    firstOutputMs: progress.firstOutputMs,
    streamCompletionMs: progress.streamCompletionMs,
    streamConnections,
  };
}

export async function readPortalOutput(
  response: Response,
  started: number,
  progress: PortalOutputProgress,
  deadline: number,
): Promise<void> {
  const outcome = await runTaskBeforeDeadline({
    timeoutMs: Math.max(1, deadline - Date.now()),
    start: startPortalOutputRead.bind(null, response, started, progress),
  });
  if (outcome.kind === "deadline_exceeded")
    throw new Error("fixture_stream_timeout");
}

function startPortalOutputRead(
  response: Response,
  started: number,
  progress: PortalOutputProgress,
) {
  if (response.body === null) throw new Error("fixture_stream_missing");
  const reader = response.body.getReader();
  return createCancellableTask({
    completion: consumePortalOutput(reader, started, progress),
    cancel: reader.cancel.bind(reader, new Error("fixture_stream_timeout")),
  });
}

async function consumePortalOutput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  started: number,
  progress: PortalOutputProgress,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.length === 0) continue;
        const record: unknown = JSON.parse(line);
        if (
          !isRecord(record) ||
          typeof record.kind !== "string" ||
          typeof record.sequence !== "number" ||
          !Number.isSafeInteger(record.sequence) ||
          record.sequence < 0
        )
          throw new Error("fixture_stream_record_invalid");
        if (record.sequence <= progress.afterSequence)
          throw new Error("fixture_stream_sequence_invalid");
        progress.afterSequence = record.sequence;
        if (record.kind === "failed" || record.kind === "paused")
          throw new Error(
            `fixture_stream_${record.kind}: ${String(record.message)}`,
          );
        if (record.kind === "assistant_text_delta") {
          if (typeof record.text !== "string")
            throw new Error("fixture_stream_text_invalid");
          if (record.text.length > 0 && progress.firstOutputMs === null)
            progress.firstOutputMs = performance.now() - started;
        }
        if (record.kind === "complete")
          progress.streamCompletionMs = performance.now() - started;
      }
      if (chunk.done) break;
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  if (buffer.trim().length > 0) throw new Error("fixture_stream_truncated");
}

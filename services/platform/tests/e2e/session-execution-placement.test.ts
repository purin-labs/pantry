import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { CONTEXT_CASE_READ_CAPABILITY } from "../../src/authorization/access-grants/turn-authority";
import { SessionDO } from "../../src/actors/agent-session";
import { SessionExecutionAdmission } from "../../src/actors/session-execution-admission";
import { listPlacementActorRegistryEntries } from "../../src/actors/actor-registry";
import {
  sessionActorStub,
  caseActorStub,
  requireActiveOrganisationActor,
} from "../../src/actors/actor-router";
import {
  resumeActorRelocation,
  startActorRelocation,
} from "../../src/actors/actor-relocation";
import {
  freezeOrganisationPlacementMove,
  freezeRegionalOrganisationPlacement,
} from "../../src/data/shared-rows/placement-row";
import {
  readOrganisationPlacementMove,
  parseOrganisationPlacementMoveTarget,
} from "../../src/data/organisation-placement";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { parseUserId } from "../../src/ids";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import { network } from "./network";
import {
  ORGANISATION_ID,
  createRequiredGrant,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  readSlackMessageText,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
  SLACK_ACTOR_USER_ID,
} from "./slack-journey-support";
import { exportedItemCount } from "./placement-move-support";

const CONVERSATION_ID = "conv_c55af3e2-19c2-446a-9f44-e00000000055";
const USER_ID = "user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab";

class PausedModel {
  phase: "pending" | "paused" | "released" | "cancelled" = "pending";
  requests = 0;
  aborted = false;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(
    private readonly reply = JSON.stringify({
      kind: "reply",
      text: "Fresh placement completed.",
    }),
  ) {}

  async respond(info: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const body: unknown = await info.request.json();
    if (!isRecord(body)) throw new Error("Invalid model request");
    this.requests += 1;
    if (this.requests === 1)
      return openRouterToolCall(
        "tool_search",
        { query: "integration_list", limit: 1 },
        "discover_before_freeze",
      );
    if (this.requests === 2) {
      this.phase = "paused";
      info.request.signal.addEventListener(
        "abort",
        this.recordAbort.bind(this),
        { once: true },
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start: this.startResponse.bind(this),
          cancel: this.cancelResponse.bind(this),
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return openRouterText(this.reply, "placement_fresh");
  }

  private startResponse(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    this.controller = controller;
    void this.finishResponse();
  }

  private cancelResponse(): void {
    this.controller = null;
    this.phase = "cancelled";
  }

  private async finishResponse(): Promise<void> {
    while (this.phase === "paused") await scheduler.wait(5);
    if (this.controller === null) return;
    const bytes = await openRouterToolCall(
      "integration_list",
      {},
      "read_after_freeze",
    ).arrayBuffer();
    if (this.controller === null) return;
    this.controller.enqueue(new Uint8Array(bytes));
    this.controller.close();
    this.controller = null;
  }

  releaseResponse(): void {
    if (this.phase === "paused") this.phase = "released";
  }

  private recordAbort(): void {
    this.aborted = true;
  }
}

it(
  "waits for admitted preparation before copying and rejects its delayed continuation after freeze",
  preparationPlacementJourney,
  70_000,
);

it(
  "rejects frozen model and tool continuations and recovers after relocation and target eviction",
  executionPlacementJourney,
  70_000,
);

it(
  "cancels paused inference and drains its Session and Case before relocation exports",
  cancelledExecutionPlacementJourney,
  70_000,
);

it(
  "rejects a frozen Slack tool continuation and delivers fresh work after relocation and eviction",
  slackExecutionPlacementJourney,
  70_000,
);

async function slackExecutionPlacementJourney({
  task,
}: TestContext): Promise<void> {
  await fixture();
  const model = new PausedModel("Fresh placement completed.");
  const slack = slackSimulator();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
    slack.handler,
  );
  try {
    await sendSlack("EvPLACEMENTFROZEN", "1787500000.000021");
    await expect
      .poll(readModelPhase.bind(null, model), { timeout: 10_000 })
      .toBe("paused");
    const entries = await listPlacementActorRegistryEntries({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      placementEpoch: 1,
    });
    if (!entries.ok) throw new Error(entries.error.code);
    const source = entries.value.find(isSessionEntry);
    const parent = entries.value.find(isCaseEntry);
    if (source === undefined || parent === undefined)
      throw new Error("Missing Slack execution Actors");
    const sourceActor = sessionActorStub(
      env.SESSION,
      source.physicalObjectName,
      source.placement,
    );
    const relocationId = await freezePlacement();
    model.releaseResponse();
    await expect
      .poll(readSourceTurnState.bind(null, sourceActor), { timeout: 10_000 })
      .toBe("failed");
    expect(model.requests).toBe(2);
    expect(await runInDurableObject(sourceActor, sourceHistory)).not.toContain(
      "integration_ref_",
    );
    expect(slack.messages.map(readSlackMessageText).join("\n")).not.toContain(
      "Fresh placement completed.",
    );
    const completed = await resumeActorRelocation({
      env,
      relocationId: relocationId,
      now: Date.now(),
    });
    expect(completed.ok).toBe(true);
    await evictDurableObject(
      caseActorStub(env.CASE, parent.physicalObjectName, parent.placement),
    );
    await evictDurableObject(sourceActor);
    expect(await runInDurableObject(sourceActor, sourceAdmission)).toBe(false);
    await sendSlack("EvPLACEMENTFRESH", "1787500000.000022");
    await expect
      .poll(readFreshSlackMessages.bind(null, slack.messages), {
        timeout: 15_000,
      })
      .toEqual(["Fresh placement completed."]);
    expect(model.requests).toBe(3);
    Object.assign(task.meta, {
      slackExecutionPlacement: {
        relocationId: relocationId,
        signedIngress: true,
        frozenToolRejected: true,
        frozenOutputRejected: true,
        providerStartsBeforeRecovery: 2,
        retiredSourceAfterEviction: true,
        freshDeliveryCount: 1,
      },
    });
  } finally {
    model.releaseResponse();
  }
}

async function sendSlack(eventId: string, timestamp: string): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId,
        messageTs: timestamp,
        threadTs: timestamp,
        text: "<@U0PANTRY> List connected integrations.",
      }),
    ),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    durableMode: "case_accepted",
  });
}

function readFreshSlackMessages(messages: Record<string, string>[]): string[] {
  return messages.filter(isFreshSlackThread).map(readSlackMessageText);
}

function isFreshSlackThread(message: Record<string, string>): boolean {
  return message.thread_ts === "1787500000.000022";
}

type PausedAdmission = {
  phase: "armed" | "paused" | "released";
  capturing: boolean;
  readonly readActive: OrganisationExecutionScope["isActive"];
  readonly readAdmission: SessionExecutionAdmission["isActive"];
};
let pausedAdmission: PausedAdmission | null = null;

async function preparationPlacementJourney({
  task,
}: TestContext): Promise<void> {
  const session = await fixture();
  const model = { requests: 0 };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      freshModel.bind(null, model),
    ),
  );
  const pause: PausedAdmission = {
    phase: "armed",
    capturing: false,
    readActive: OrganisationExecutionScope.prototype.isActive,
    readAdmission: SessionExecutionAdmission.prototype.isActive,
  };
  pausedAdmission = pause;
  OrganisationExecutionScope.prototype.isActive = pauseCapturedScopeRead;
  SessionExecutionAdmission.prototype.isActive = markSessionRead;
  let completion: ReturnType<typeof resumeActorRelocation> | null = null;
  const marker = { completed: false };
  try {
    expect(
      (await send(session, "request_preparation_placement", "message")).status,
    ).toBe(200);
    await expect
      .poll(readPreparationPhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    const entries = await listPlacementActorRegistryEntries({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      placementEpoch: 1,
    });
    if (!entries.ok) throw new Error(entries.error.code);
    const source = entries.value.find(isSessionEntry);
    if (source === undefined) throw new Error("Missing preparation Session");
    const sourceActor = sessionActorStub(
      env.SESSION,
      source.physicalObjectName,
      source.placement,
    );
    const target = parseOrganisationPlacementMoveTarget({
      kind: "affinity",
      placementCellId: "e2e",
      locationHint: "wnam",
    });
    if (!target.ok) throw new Error(target.error.code);
    const started = await startActorRelocation({
      env,
      organisationId: ORGANISATION_ID,
      target: target.value,
      now: Date.now(),
    });
    if (!started.ok) throw new Error(started.error.code);
    completion = resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    void completion.then(markCompletion.bind(null, marker));
    await expect
      .poll(readSourceBarrier.bind(null, sourceActor), { timeout: 10_000 })
      .toBe(1);
    expect(marker.completed).toBe(false);
    expect(await exportedItemCount(started.value.relocationId)).toBe(0);
    expect(model.requests).toBe(0);
    pause.phase = "released";
    expect((await completion).ok).toBe(true);
    OrganisationExecutionScope.prototype.isActive = pause.readActive;
    SessionExecutionAdmission.prototype.isActive = pause.readAdmission;
    pausedAdmission = null;
    expect(model.requests).toBe(0);
    await expect
      .poll(readConversationWorkKind.bind(null, session), { timeout: 15_000 })
      .toBe("failed");
    expect(model.requests).toBe(0);
    Object.assign(task.meta, {
      sessionPreparationPlacement: {
        phase: "awaiting_source_eviction",
        relocationId: started.value.relocationId,
        pausedAfterActiveRead: true,
        exportWaited: true,
        exportedItemsWhilePaused: 0,
        staleInferenceStarts: 0,
        interruptedRequestSettled: true,
      },
    });
    const parent = entries.value.find(isCaseEntry);
    if (parent === undefined) throw new Error("Missing source Case");
    await evictDurableObject(
      caseActorStub(env.CASE, parent.physicalObjectName, parent.placement),
    );
    await evictDurableObject(sourceActor);
    expect(await runInDurableObject(sourceActor, sourceAdmission)).toBe(false);
    expect(
      (await send(session, "request_preparation_placement", "retry")).status,
    ).toBe(200);
    await expect
      .poll(readConversationWorkKind.bind(null, session), { timeout: 15_000 })
      .toBe("ready");
    expect(model.requests).toBe(1);
    Object.assign(task.meta, {
      sessionPreparationPlacement: {
        phase: "complete",
        relocationId: started.value.relocationId,
        pausedAfterActiveRead: true,
        exportWaited: true,
        exportedItemsWhilePaused: 0,
        staleInferenceStarts: 0,
        interruptedRequestSettled: true,
        freshInferenceStarts: 1,
        retiredAfterEviction: true,
      },
    });
  } finally {
    pause.phase = "released";
    OrganisationExecutionScope.prototype.isActive = pause.readActive;
    SessionExecutionAdmission.prototype.isActive = pause.readAdmission;
    pausedAdmission = null;
    await completion;
  }
}

async function pauseCapturedScopeRead(
  this: OrganisationExecutionScope,
): Promise<boolean> {
  const pause = pausedAdmission;
  if (pause === null) throw new Error("Missing placement pause");
  const active = await pause.readActive.call(this);
  if (
    pause.phase === "armed" &&
    pause.capturing &&
    active &&
    this.organisationId === ORGANISATION_ID
  ) {
    pause.phase = "paused";
    await waitForPreparationRelease(pause);
  }
  return active;
}

async function waitForPreparationRelease(
  pause: PausedAdmission,
): Promise<void> {
  while (pause.phase === "paused") await scheduler.wait(5);
}

function readPreparationPhase(
  pause: PausedAdmission,
): PausedAdmission["phase"] {
  return pause.phase;
}

async function markSessionRead(
  this: SessionExecutionAdmission,
): Promise<boolean> {
  const pause = pausedAdmission;
  if (pause === null) throw new Error("Missing Session pause");
  pause.capturing = true;
  try {
    return await pause.readAdmission.call(this);
  } finally {
    pause.capturing = false;
  }
}

function markCompletion(marker: { completed: boolean }): void {
  marker.completed = true;
}
function freshModel(model: { requests: number }): Response {
  model.requests += 1;
  return openRouterText(
    JSON.stringify({ kind: "reply", text: "Fresh placement completed." }),
    "preparation_fresh",
  );
}

async function executionPlacementJourney({ task }: TestContext): Promise<void> {
  const session = await fixture();
  const model = new PausedModel();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
  );
  expect(
    (await send(session, "request_paused_placement", "message")).status,
  ).toBe(200);
  await expect
    .poll(readModelPhase.bind(null, model), { timeout: 10_000 })
    .toBe("paused");
  const entries = await listPlacementActorRegistryEntries({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    placementEpoch: 1,
  });
  if (!entries.ok) throw new Error(entries.error.code);
  const source = entries.value.find(isSessionEntry);
  if (source === undefined || source.identity.objectKind !== "session")
    throw new Error("Missing source Session");
  const sourceActor = sessionActorStub(
    env.SESSION,
    source.physicalObjectName,
    source.placement,
  );
  const relocationId = await freezePlacement();
  try {
    model.releaseResponse();
    await expect
      .poll(readSourceTurnState.bind(null, sourceActor), { timeout: 10_000 })
      .toBe("failed");
    expect(model.requests).toBe(2);
    expect(await runInDurableObject(sourceActor, sourceAdmission)).toBe(false);
  } finally {
    model.releaseResponse();
  }
  const completed = await resumeActorRelocation({
    env,
    relocationId: relocationId,
    now: Date.now(),
  });
  expect(completed.ok).toBe(true);
  expect(model.requests).toBe(2);
  const history = await runInDurableObject(sourceActor, sourceHistory);
  expect(history).not.toContain("integration_ref_");
  expect(await runInDurableObject(sourceActor, sourceAdmission)).toBe(false);
  await expect
    .poll(readConversationWorkKind.bind(null, session), { timeout: 15_000 })
    .toBe("failed");
  expect(
    (await send(session, "request_paused_placement", "retry")).status,
  ).toBe(200);
  await expect
    .poll(readConversationWorkKind.bind(null, session), { timeout: 15_000 })
    .toBe("ready");
  expect(model.requests).toBe(3);
  const freshEntries = await listPlacementActorRegistryEntries({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    placementEpoch: 2,
  });
  if (!freshEntries.ok) throw new Error(freshEntries.error.code);
  const fresh = freshEntries.value.find(isSessionEntry);
  if (fresh === undefined) throw new Error("Missing relocated Session");
  const freshActor = sessionActorStub(
    env.SESSION,
    fresh.physicalObjectName,
    fresh.placement,
  );
  await evictDurableObject(freshActor);
  expect(await runInDurableObject(freshActor, sourceAdmission)).toBe(true);
  Object.assign(task.meta, {
    sessionExecutionPlacement: {
      relocationId: relocationId,
      exportAfterTurnSettled: true,
      frozenToolRejected: true,
      frozenInferenceRejected: true,
      providerStartsBeforeRecovery: 2,
      retiredSourceRejected: true,
      freshAfterEviction: true,
    },
  });
}

async function freezePlacement() {
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!target.ok) throw new Error(target.error.code);
  const started = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target: target.value,
    now: Date.now(),
  });
  if (!started.ok) throw new Error(started.error.code);
  const move = await readOrganisationPlacementMove({
    db: env.DB,
    organisationId: ORGANISATION_ID,
    sourcePlacementEpoch: 1,
    targetPlacementEpoch: 2,
  });
  if (
    !move.ok ||
    move.value.source.status !== "active" ||
    move.value.target.status !== "reserved"
  )
    throw new Error("Missing reserved move");
  const frozen = await freezeOrganisationPlacementMove(
    env.DB,
    {
      organisationId: move.value.organisationId,
      source: move.value.source,
      target: move.value.target,
    },
    { kind: "relocation", operationId: started.value.relocationId },
    Date.now(),
    fixtureDatabase(),
  );
  if (!frozen.ok) throw new Error(frozen.error.code);
  // Relocation freezes the source database's copy too.
  const regional = await freezeRegionalOrganisationPlacement(
    fixtureDatabase(),
    frozen.value,
  );
  if (!regional.ok) throw new Error(regional.error.code);
  return started.value.relocationId;
}

function isSessionEntry(entry: { identity: { objectKind: string } }): boolean {
  return entry.identity.objectKind === "session";
}

function readModelPhase(model: PausedModel): PausedModel["phase"] {
  return model.phase;
}

async function cancelledExecutionPlacementJourney({
  task,
}: TestContext): Promise<void> {
  const session = await fixture();
  const model = new PausedModel();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
  );
  try {
    expect(
      (await send(session, "request_cancelled_placement", "message")).status,
    ).toBe(200);
    await expect
      .poll(readModelPhase.bind(null, model), { timeout: 10_000 })
      .toBe("paused");
    const entries = await listPlacementActorRegistryEntries({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      placementEpoch: 1,
    });
    if (!entries.ok) throw new Error(entries.error.code);
    const source = entries.value.find(isSessionEntry);
    const parent = entries.value.find(isCaseEntry);
    if (source === undefined || parent === undefined)
      throw new Error("Missing source execution Actors");
    const sourceActor = sessionActorStub(
      env.SESSION,
      source.physicalObjectName,
      source.placement,
    );
    const target = parseOrganisationPlacementMoveTarget({
      kind: "affinity",
      placementCellId: "e2e",
      locationHint: "wnam",
    });
    if (!target.ok) throw new Error(target.error.code);
    const started = await startActorRelocation({
      env,
      organisationId: ORGANISATION_ID,
      target: target.value,
      now: Date.now(),
    });
    if (!started.ok) throw new Error(started.error.code);
    const completed = await resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    });
    expect(completed.ok).toBe(true);
    expect(model.aborted).toBe(true);
    model.releaseResponse();
    expect(model.requests).toBe(2);
    expect(await readSourceTurnState(sourceActor)).toBe("failed");
    await evictDurableObject(
      caseActorStub(env.CASE, parent.physicalObjectName, parent.placement),
    );
    await evictDurableObject(sourceActor);
    expect(await runInDurableObject(sourceActor, sourceAdmission)).toBe(false);
    await expect
      .poll(readConversationWorkKind.bind(null, session), { timeout: 15_000 })
      .toBe("failed");
    expect(
      (await send(session, "request_cancelled_placement", "retry")).status,
    ).toBe(200);
    await expect
      .poll(readConversationWorkKind.bind(null, session), { timeout: 15_000 })
      .toBe("ready");
    expect(model.requests).toBe(3);
    Object.assign(task.meta, {
      sessionCancelledPlacement: {
        relocationId: started.value.relocationId,
        providerCancelled: true,
        exportAfterExecutionDrained: true,
        providerStartsBeforeRecovery: 2,
        retiredSourceAfterEviction: true,
        freshRetryCompleted: true,
      },
    });
  } finally {
    model.releaseResponse();
  }
}

function isCaseEntry(entry: { identity: { objectKind: string } }): boolean {
  return entry.identity.objectKind === "case";
}

async function sourceAdmission(
  _actor: unknown,
  ctx: DurableObjectState,
): Promise<boolean> {
  return (
    (await SessionExecutionAdmission.resolve(
      env,
      ctx.storage,
      ORGANISATION_ID,
    )) !== null
  );
}

function readBarrier(_actor: unknown, ctx: DurableObjectState): number {
  return ctx.storage.sql
    .exec("SELECT COUNT(*) AS count FROM state_object_cleanup_export_barrier")
    .toArray()[0]?.count === 1
    ? 1
    : 0;
}

function readSourceBarrier(
  actor: DurableObjectStub<SessionDO>,
): Promise<number> {
  return runInDurableObject(actor, readBarrier);
}

function sourceTurnState(_actor: unknown, ctx: DurableObjectState): string {
  const row = ctx.storage.sql
    .exec(
      "SELECT state FROM session_turn_stream ORDER BY started_at DESC LIMIT 1",
    )
    .toArray()[0];
  return typeof row?.state === "string" ? row.state : "missing";
}
function readSourceTurnState(
  actor: DurableObjectStub<SessionDO>,
): Promise<string> {
  return runInDurableObject(actor, sourceTurnState);
}

function sourceHistory(_actor: unknown, ctx: DurableObjectState): string {
  return JSON.stringify(
    ctx.storage.sql
      .exec("SELECT payload FROM session_harness_history ORDER BY sequence")
      .toArray(),
  );
}

async function fixture(): Promise<IssuedControlSession> {
  await installSlackActorFixture();
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "UPDATE service_role_grant SET role = 'admin' WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(ORGANISATION_ID, SLACK_ACTOR_USER_ID),
    fixtureDatabase()
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_execution', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(Date.now(), ORGANISATION_ID),
  ]);
  await createRequiredGrant({
    grantId: "grant_execution_case_read",
    subject: { kind: "organisation_role", role: "admin" },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    now: Date.now(),
  });
  await createRequiredGrant({
    grantId: "grant_execution_integrations",
    subject: { kind: "organisation_role", role: "admin" },
    target: {
      kind: "platform_capability",
      capabilityId: "integration.discovery.read",
      capabilityVersion: 1,
    },
    now: Date.now(),
  });
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
  const userId = parseUserId(USER_ID);
  if (!userId.ok) throw new Error(userId.error.code);
  return issueControlSession({
    db: env.DB,
    userId: userId.value,
    now: Date.now(),
    ttlMs: 1_800_000,
  });
}

async function send(
  session: IssuedControlSession,
  requestId: string,
  kind: "message" | "retry",
): Promise<Response> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat`,
    {
      method: "POST",
      headers: {
        origin: "https://localhost",
        "content-type": "application/json",
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
      },
      body: JSON.stringify(
        kind === "retry"
          ? {
              kind,
              conversationId: CONVERSATION_ID,
              requestId,
              model: "moonshotai/kimi-k3",
            }
          : {
              kind,
              conversationId: CONVERSATION_ID,
              requestId,
              model: "moonshotai/kimi-k3",
              text: "List connected integrations.",
              surfaceContext: null,
              browserContext: {
                kind: "available",
                binding: {
                  browserInstanceId: "browser_execution_placement",
                  conversationId: CONVERSATION_ID,
                },
              },
            },
      ),
    },
  );
  await response.body?.cancel();
  return response;
}

async function readConversationWorkKind(
  session: IssuedControlSession,
): Promise<string> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat?conversation=${CONVERSATION_ID}`,
    { headers: { cookie: `satyr_control_session=${session.token}` } },
  );
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    !isRecord(body.conversation) ||
    !isRecord(body.conversation.work)
  )
    return "unavailable";
  return typeof body.conversation.work.kind === "string"
    ? body.conversation.work.kind
    : "unavailable";
}

import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { fixtureDatabase } from "./organisation-database";
import {
  newConversationId,
  isConversationId,
  parseChatSignal,
  SURFACE_EFFECT_SIGNAL,
} from "@purin-labs/control-api";
import { openSocket } from "./hibernatable-socket-support";
import { parseStoredAttachment } from "../../src/messages/stored-attachment";
import {
  parseChatForkHistory,
  chatForkHistoryDigest,
} from "../../src/chat/fork-history";
import {
  parseProjectReference,
  type ProjectSnapshot,
} from "@purin-labs/control-api";
import { currentProjectSnapshot } from "../../src/chat/project-context-binding";
import { conversationCaseId } from "../../src/chat/conversation-actor-identity";
import { requireDefaultProjectId } from "../fixtures/default-project";
import { parseContinuation } from "../../src/actors/agent-session-continuation";
import { parsePersistedHarnessTurnLease } from "../../src/actors/agent-session-harness-authority";
import { readProjectDirectory } from "../../src/chat/projects";
import { bakeryRunSnapshotPrefix } from "../../src/commerce/bakery/saved-runs";
import { writeOrganisationCapabilityPolicy } from "../../src/data/capability-policy";
import { connectCommerceFixture } from "./commerce-support";
import { CommerceAdminClient } from "@purin-labs/commerce-client";
import { commerceCanonicalResourceId } from "../../src/commerce/contract/resource-ids";
import { sampleSettings } from "@purin-labs/bakery-model/bakery";
import {
  rehearsalFromRecording,
  rehearsalSettings,
} from "@purin-labs/production-simulation/simulator/rehearsal-presets";
import { isRecord, sha256Hex } from "@purin-labs/std";
import { prepareRehearsalRunWorkspace } from "../../../../apps/portal/src/features/workflow-simulator/workspace-runs-api";
import { responseJson } from "../../../../apps/portal/src/control-client";
import { timelineVisibleMessages } from "../../src/chat/conversation";
import {
  captureBakerySurface,
  prepareBakerySurfaceCommand,
  commitBakerySurfaceCommand,
  bakerySurfaceCommandSucceeded,
} from "../../../../apps/portal/src/features/workflow-simulator/bakery-surface";
import {
  initialSimulatorState,
  simulatorPlaybackSnapshot,
  applyBakeryWorkspaceAction,
  applySimulatorReplayAction,
  applySimulatorViewAction,
} from "../../../../apps/portal/src/features/workflow-simulator/simulator-state";
import { applyPlaybackAction } from "../../../../apps/portal/src/features/workflow-simulator/playback-actions";
import ovenCycle from "../../../../assets/bakery-mujoco/fr10-workcell/recordings/oven-cycle.json";
import { parsePhysicsReplay } from "@purin-labs/bakery-model/bakery-physics";
import {
  parseBakerySurfaceAttachment,
  createBakerySurfaceAttachment,
  createBakerySurfaceReceipt,
  parseBakerySurfaceEffect,
  isExecutableBakerySurfaceEffect,
  type ExecutableBakerySurfaceEffectV1,
  type BakerySurfaceAttachmentV1,
  type BakerySurfaceEffectV1,
  type BakerySurfaceReceiptV1,
} from "@purin-labs/bakery-model/bakery-surface";
import { env, exports } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { bypass, http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import {
  installSlackActorFixture,
  createRequiredGrant,
  openRouterText,
  openRouterStream,
  openRouterToolCall,
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
} from "./slack-journey-support";
import { network } from "./network";
import {
  readCanonicalRuntimes,
  readCanonicalToolResults,
  verifyResumedTurnExecution,
  verifyToolTurnExecution,
} from "./case-execution-support";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { parseSessionId } from "../../src/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import {
  readConversation,
  saveConversation,
  type ConversationScope,
} from "../../src/chat/store";
import {
  resolveActiveCaseActor,
  resolveActiveSessionActor,
  requireActiveOrganisationActor,
} from "../../src/actors/actor-router";
import { deriveDirectCaseIdentities } from "../../src/actors/case-direct-processing";
import { createAccessGrant } from "../../src/data/access-grants";
import { CONTEXT_CASE_READ_CAPABILITY } from "../../src/authorization/access-grants/turn-authority";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { SessionDO } from "../../src/actors/agent-session";
import type { CaseDO } from "../../src/actors/case";
import { readLatestHarnessCheckpoint } from "../../src/actors/agent-session-harness-authority";
import { ObservationEvidence } from "../../src/policy/information-flow/oac";
import { requireConversationId } from "../test-ids";
import {
  installMerchantAgent,
  merchantAgentDefaultSkills,
  merchantAgentInstallationId,
} from "../../src/data/merchant-agent-preset";
import { runAgentOperation } from "../../src/data/agent-operation-runner";
import { readPortalOutput } from "./full-worker";
import { PLATFORM_DEFAULT_PI_MODEL } from "../../src/actors/pi-model-transport";

const CONVERSATION_ID = "conv_cc97400f-2eb9-52d3-b35e-56a9ef3e6085";
const LONG_TEXT = 'Canonical long response: café, 焼き菓子, "quoted". '
  .repeat(1_200)
  .trim();
const FOLLOWUP_TEXT = "The same conversation continues after recovery.";
const REVOKED_TEXT = "This response must never be published.";
const AUTOMATIC_CONTEXT_DRAFT =
  "Keep this unsent draft through retry and browser recovery.";

type SessionOriginModel = {
  readonly response: "tool" | "output";
  phase: "pending" | "paused" | "released" | "fresh";
  calls: number;
  discoveries: string[];
};

it.for(["tool", "output"] as const)(
  "retains the originating control session through a paused %s response, Actor eviction and retry",
  { timeout: 45_000 },
  sessionOriginJourney,
);

async function sessionOriginJourney(
  response: SessionOriginModel["response"],
  { task }: TestContext,
): Promise<void> {
  const { session, scope } = await fixture();
  const fresh = await issueControlSession({
    db: env.DB,
    userId: scope.userId,
    now: Date.now(),
    ttlMs: 1_800_000,
  });
  const model: SessionOriginModel = {
    response,
    phase: "pending",
    calls: 0,
    discoveries: [],
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToSessionOrigin.bind(null, model),
    ),
  );
  const requestId = `request_session_origin_${response}`;
  try {
    expect(
      (await send(session, command(requestId, "Inspect my bakery workspace.")))
        .status,
    ).toBe(200);
    await expect
      .poll(originResponsePhase.bind(null, model), { timeout: 15_000 })
      .toBe("paused");
    const running = await readConversation(fixtureDatabase(), scope, CONVERSATION_ID);
    if (running?.conversation.work.kind !== "running")
      throw new Error("Expected the origin-bound turn to be running");
    const stream = running.conversation.work.stream;
    const origin = await readOriginBinding(stream.sessionId, stream.turnId);
    expect(origin).toBe(session.session.controlSessionId);
    const pendingStream = await readChatEndpoint(
      session,
      `/stream?conversation=${CONVERSATION_ID}&request=${requestId}&after=-1`,
    );
    expect(pendingStream.status).toBe(200);
    await expect(
      readPortalOutput(
        pendingStream,
        performance.now(),
        { afterSequence: -1, firstOutputMs: null, streamCompletionMs: null },
        Date.now() + 100,
      ),
    ).rejects.toThrow(/timeout|timed out/i);
    expect(model.phase).toBe("paused");
    await env.DB.prepare(
      "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
    )
      .bind(Date.now(), session.session.controlSessionId)
      .run();
    const deniedReplay = await readChatEndpoint(
      fresh,
      `/stream?conversation=${CONVERSATION_ID}&request=${requestId}&after=-1`,
    );
    const replayText = await deniedReplay.text();
    expect(replayText).not.toContain('"kind":"assistant_text_delta"');
    expect(replayText).not.toContain(REVOKED_TEXT);
    model.phase = "released";
    await expect
      .poll(readAutomaticContextCompletion.bind(null, fresh, CONVERSATION_ID), {
        timeout: 15_000,
      })
      .toBe("failed");
    const revokedModelRequests = model.discoveries.length + 1;
    expect(model.calls).toBe(revokedModelRequests);
    const frozen = await readConversation(fixtureDatabase(), scope, CONVERSATION_ID);
    expect(JSON.stringify(frozen?.conversation.timeline)).not.toContain(
      REVOKED_TEXT,
    );
    expect(
      (
        await fixtureDatabase().prepare(
          "SELECT effect_id FROM bakery_surface_effect_delivery",
        ).all()
      ).results,
    ).toEqual([]);
    const identities = await deriveDirectCaseIdentities(
      `${ORGANISATION_ID}:portal-chat:${scope.userId}:${CONVERSATION_ID}`,
    );
    if (!identities.ok) throw new Error("Missing retained turn Actors");
    const caseActor = await resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId: ORGANISATION_ID,
      caseId: identities.value.caseId,
      now: Date.now(),
    });
    if (!caseActor.ok) throw new Error(caseActor.error.code);
    await evictDurableObject(caseActor.value);
    await runDurableObjectAlarm(caseActor.value);
    expect(await readOriginBinding(stream.sessionId, stream.turnId)).toBe(
      origin,
    );
    expect(model.calls).toBe(revokedModelRequests);
    model.phase = "fresh";
    expect(
      (
        await send(fresh, {
          kind: "retry",
          conversationId: CONVERSATION_ID,
          requestId,
          model: PLATFORM_DEFAULT_PI_MODEL,
        })
      ).status,
    ).toBe(200);
    await expect
      .poll(readAutomaticContextCompletion.bind(null, fresh, CONVERSATION_ID), {
        timeout: 15_000,
      })
      .toBe("ready");
    expect(model.calls).toBe(revokedModelRequests + 1);
    expect(await readOriginBinding(stream.sessionId, stream.turnId)).toBe(
      origin,
    );
    const replacement = await fixtureDatabase().prepare(
      "SELECT control_session_id FROM session_turn_access WHERE organisation_id = ? AND session_id <> ?",
    )
      .bind(ORGANISATION_ID, stream.sessionId)
      .first<{ control_session_id: string }>();
    expect(replacement?.control_session_id).toBe(
      fresh.session.controlSessionId,
    );
    const completed = await readConversation(fixtureDatabase(), scope, CONVERSATION_ID);
    if (completed === null) throw new Error("Missing completed fresh request");
    expect(
      timelineVisibleMessages(completed.conversation)
        .filter(isAssistant)
        .map(messageText),
    ).toEqual([FOLLOWUP_TEXT]);
    const retiredSession = await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: ORGANISATION_ID,
      sessionId: stream.sessionId,
      now: Date.now(),
    });
    if (!retiredSession.ok) throw new Error(retiredSession.error.code);
    await evictDurableObject(caseActor.value);
    await evictDurableObject(retiredSession.value);
    expect(
      await retiredSession.value.inspectTurnStream({
        organisationId: ORGANISATION_ID,
        turnId: stream.turnId,
      }),
    ).toEqual({ ok: true, value: { kind: "present", state: "failed" } });
    await runDurableObjectAlarm(retiredSession.value);
    expect(model.calls).toBe(revokedModelRequests + 1);
    expect(await readOriginBinding(stream.sessionId, stream.turnId)).toBe(
      origin,
    );
    Object.assign(task.meta, {
      sessionOriginAcceptance: {
        response,
        originatingSessionRetained: true,
        revokedModelRequests,
        revokedReplayPublished: false,
        revokedToolEffects: 0,
        revokedOutputPublished: false,
        caseEvictionReboundOrigin: false,
        sessionEvictionRecoveredFailure: true,
        explicitRetryReboundOriginalTurn: false,
        explicitRetryCreatedNewTurn: true,
        authorizedRetryModelRequests: 1,
        authorizedRetryCompleted: true,
      },
    });
  } finally {
    if (model.phase === "pending" || model.phase === "paused")
      model.phase = "released";
  }
}

function originResponsePhase(model: SessionOriginModel) {
  return model.phase;
}

async function readOriginBinding(
  sessionId: string,
  turnId: string,
): Promise<string | null> {
  const row = await fixtureDatabase().prepare(
    "SELECT control_session_id FROM session_turn_access WHERE organisation_id = ? AND session_id = ? AND turn_id = ?",
  )
    .bind(ORGANISATION_ID, sessionId, turnId)
    .first<{ control_session_id: string }>();
  return row?.control_session_id ?? null;
}

async function respondToSessionOrigin(
  model: SessionOriginModel,
  request: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  model.calls++;
  if (model.phase === "fresh") {
    await request.request.arrayBuffer();
    return openRouterText(
      JSON.stringify({ kind: "reply", text: FOLLOWUP_TEXT }),
      "fresh_session_origin",
    );
  }
  let toolResponse: Response | null = null;
  if (model.response === "tool") {
    const discoveryCount = model.discoveries.length;
    toolResponse = await discoverableToolCall(
      model,
      request,
      "bakery_surface_inspect",
      {},
      "revoked_session_tool",
    );
    if (model.discoveries.length > discoveryCount) return toolResponse;
  }
  if (model.calls !== model.discoveries.length + 1)
    throw new Error("Revoked turn invoked inference again");
  if (model.response === "output") await request.request.arrayBuffer();
  model.phase = "paused";
  while (model.phase === "paused") await scheduler.wait(5);
  if (toolResponse !== null) return toolResponse;
  return openRouterText(
    JSON.stringify({ kind: "reply", text: REVOKED_TEXT }),
    "revoked_session_output",
  );
}

it.for(["case", "agent"] as const)(
  "retains the originating control session for manual %s dispatch after revocation and Actor eviction",
  { timeout: 45_000 },
  manualSessionOriginJourney,
);

async function manualSessionOriginJourney(
  surface: "case" | "agent",
  { task }: TestContext,
): Promise<void> {
  const { session, scope } = await fixture();
  const fresh = await issueControlSession({
    db: env.DB,
    userId: scope.userId,
    now: Date.now(),
    ttlMs: 1_800_000,
  });
  if (surface === "agent") {
    const installed = await installMerchantAgent({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      actorUserId: scope.userId,
      policyRevision: 1,
      skills: merchantAgentDefaultSkills(),
      now: Date.now(),
    });
    if (!installed.ok) throw new Error(installed.error.code);
  }
  const model: SessionOriginModel = {
    response: "output",
    phase: "pending",
    calls: 0,
    discoveries: [],
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToSessionOrigin.bind(null, model),
    ),
  );
  const path = `/v1/control/organisations/${ORGANISATION_ID}/${surface === "case" ? "cases/commands" : "operations"}`;
  const body = manualOriginCommand(surface, "Inspect my bakery workspace.");
  const key = `p55_origin_${surface}`;
  const pending = dispatchManualOrigin(session, path, key, body);
  try {
    await expect
      .poll(originResponsePhase.bind(null, model), { timeout: 15_000 })
      .toBe("paused");
    const origin = await fixtureDatabase().prepare(
      "SELECT session_id, turn_id FROM session_turn_access WHERE organisation_id = ? AND control_session_id = ? AND origin_kind = 'operator_session'",
    )
      .bind(ORGANISATION_ID, session.session.controlSessionId)
      .first<{ session_id: string; turn_id: string }>();
    if (origin === null) throw new Error("Missing manual origin binding");
    await env.DB.prepare(
      "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
    )
      .bind(Date.now(), session.session.controlSessionId)
      .run();
    model.phase = "released";
    const rejected = await pending;
    const failureStatus = surface === "case" ? 503 : 500;
    expect(rejected.status).toBe(failureStatus);
    expect(await rejected.text()).not.toContain(REVOKED_TEXT);
    expect(model.calls).toBe(1);
    const oldSessionId = parseSessionId(origin.session_id);
    if (!oldSessionId.ok) throw new Error(oldSessionId.error.code);
    const retired = await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: ORGANISATION_ID,
      sessionId: oldSessionId.value,
      now: Date.now(),
    });
    if (!retired.ok) throw new Error(retired.error.code);
    await evictDurableObject(retired.value);
    expect(
      await retired.value.inspectTurnStream({
        organisationId: ORGANISATION_ID,
        turnId: origin.turn_id,
      }),
    ).toEqual({ ok: true, value: { kind: "present", state: "failed" } });
    expect((await dispatchManualOrigin(fresh, path, key, body)).status).toBe(
      failureStatus,
    );
    expect(await readOriginBinding(origin.session_id, origin.turn_id)).toBe(
      session.session.controlSessionId,
    );
    expect(model.calls).toBe(1);
    model.phase = "fresh";
    const authorized = await dispatchManualOrigin(
      fresh,
      path,
      `${key}_fresh`,
      manualOriginCommand(surface, "Inspect my bakery workspace again."),
    );
    expect(authorized.status).toBe(surface === "case" ? 200 : 201);
    await authorized.arrayBuffer();
    expect(model.calls).toBe(2);
    if (surface === "agent") {
      const slack = await runAgentOperation({
        env,
        scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
        operation: {
          kind: "dispatch_manual_run",
          installationId: merchantAgentInstallationId(ORGANISATION_ID),
          instructionBody: "Run the confirmed Slack instruction.",
        },
        actor: {
          userId: scope.userId,
          personId: "person_e2e-slack-actor",
          role: "admin",
          origin: { kind: "slack" },
        },
        operationId: "p55_origin_slack",
        now: Date.now(),
      });
      expect(slack.ok).toBe(true);
      expect(model.calls).toBe(3);
      expect(
        await fixtureDatabase().prepare(
          "SELECT control_session_id FROM session_turn_access WHERE organisation_id = ? AND origin_kind = 'slack_operator'",
        )
          .bind(ORGANISATION_ID)
          .first(),
      ).toEqual({ control_session_id: null });
    }
    Object.assign(task.meta, {
      manualOriginAcceptance: {
        surface,
        revokedResponsePublished: false,
        evictedSessionRebound: false,
        duplicateInference: false,
        freshCommandCompleted: true,
        slackOrigin: surface === "agent" ? "verified" : "not_applicable",
      },
    });
  } finally {
    if (model.phase === "pending" || model.phase === "paused")
      model.phase = "released";
    await pending;
  }
}

function manualOriginCommand(surface: "case" | "agent", instruction: string) {
  return surface === "case"
    ? { instruction }
    : {
        kind: "dispatch_manual_run",
        installationId: merchantAgentInstallationId(ORGANISATION_ID),
        instructionBody: instruction,
      };
}

function dispatchManualOrigin(
  session: IssuedControlSession,
  path: string,
  key: string,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    method: "POST",
    headers: {
      origin: "https://localhost",
      "content-type": "application/json",
      "idempotency-key": key,
      cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
      "x-satyr-csrf": session.csrfToken,
    },
    body: JSON.stringify(body),
  });
}

it(
  "finalizes a >30s disconnected turn after projection failure and actor eviction, drains its queue once, and fences revoked access",
  reliableFinalization,
  100_000,
);

it(
  "loads saved context without an attachment and resumes interrupted BakeryOS preparation on pi under the same request",
  { timeout: 70_000 },
  async function automaticContext({ task }) {
    const route = "pi";
    const { session, scope } = await fixture(1_000_000);
    await seedPriorChatContext(session);
    const savedRunId = await saveLatestAutomaticContextRun();
    const model = {
      savedRunId,
      calls: 0,
      discoveries: [] as string[],
      requests: [] as unknown[],
    };
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        failAutomaticContextStart,
      ),
    );
    const conversationId = "conv_0868992b-cf6c-53d8-8ecc-1b575c0bac64";
    const requestId = "request_automatic_context";
    await prepareProjectContextJourney(
      session,
      scope,
      conversationId,
      savedRunId,
    );
    expect(
      (
        await send(session, {
          ...command(
            requestId,
            "Read the most recently saved bakery run, then show the current bakery workspace.",
          ),
          model: PLATFORM_DEFAULT_PI_MODEL,
          conversationId,
        })
      ).status,
    ).toBe(200);
    let draftUpdatedAt: number | null = null;
    {
      await expect
        .poll(
          readAutomaticContextCompletion.bind(null, session, conversationId),
          {
            timeout: 15_000,
          },
        )
        .toBe("failed");
      draftUpdatedAt = await saveAutomaticContextDraft(session, conversationId);
      network.use(
        http.post(
          "https://openrouter.ai/api/v1/chat/completions",
          respondToAutomaticContext.bind(null, model),
        ),
      );
      expect(
        (
          await send(session, {
            kind: "retry",
            conversationId,
            requestId,
            model: PLATFORM_DEFAULT_PI_MODEL,
          })
        ).status,
      ).toBe(200);
    }
    const preparation = await pendingBrowserPreparation(
      session,
      conversationId,
    );
    if (preparation.command.kind !== "prepare_context")
      throw new Error("Expected context preparation");
    expect(
      (
        await readChatEndpoint(
          session,
          `/surface-effects?browserInstanceId=another_tab&conversationId=${conversationId}`,
        )
      ).status,
    ).toBe(200);
    const wrongTab = await readChatEndpoint(
      session,
      `/surface-effects?browserInstanceId=another_tab&conversationId=${conversationId}`,
    );
    expect(await wrongTab.json()).toMatchObject({ effects: [] });
    let simulator = initialSimulatorState("closed");
    const surface = await captureBakerySurface(simulator);
    const wrongReceipt = await createBakerySurfaceReceipt(preparation, {
      kind: "prepared",
      binding: { browserInstanceId: "another_tab", conversationId },
      surface,
    });
    expect((await postSurfaceReceipt(session, wrongReceipt)).status).toBe(409);
    const futureReceipt = await createBakerySurfaceReceipt(preparation, {
      kind: "prepared",
      binding: preparation.command.binding,
      surface: await createBakerySurfaceAttachment({
        ...surface.context,
        capturedAt: Date.now() + 60_000,
      }),
    });
    expect((await postSurfaceReceipt(session, futureReceipt)).status).toBe(409);
    const observed = await readChatEndpoint(
      session,
      `?conversation=${conversationId}&observe=true`,
    );
    const projected = await observed.json();
    expect(projected).toMatchObject({
      conversation: {
        timeline: expect.arrayContaining([
          expect.objectContaining({
            kind: "context",
            contextDetails: expect.objectContaining({
              kind: "observed",
              area: "BakeryOS",
              source: expect.objectContaining({
                id: `bakery-run:${savedRunId}`,
                digest: savedRunId,
                origin: "saved",
              }),
            }),
          }),
          expect.objectContaining({
            kind: "context",
            contextDetails: expect.objectContaining({ kind: "preparing" }),
          }),
        ]),
      },
    });
    expect(projected).toMatchObject({
      conversation: {
        timeline: expect.not.arrayContaining([
          expect.objectContaining({
            kind: "context",
            contextDetails: expect.objectContaining({
              kind: "observed",
              area: "AgentCommerce",
            }),
          }),
        ]),
      },
    });
    const stored = await readConversation(fixtureDatabase(), scope, conversationId);
    if (stored?.conversation.work.kind !== "running")
      throw new Error("Expected running request");
    const stream = stored.conversation.work.stream;
    const acceptedProject = currentProjectSnapshot(stored.conversation);
    if (acceptedProject === null)
      throw new Error("Missing accepted project binding");
    expect(acceptedProject.layer).toMatchObject({
      kind: "project",
      projectId: "project_27797abb-e120-5e65-8935-80cc9f4e4149",
      brief: PROJECT_BAKERY_BRIEF,
    });
    const busyMove = await moveProjectContextChat(
      session,
      scope,
      conversationId,
      "project_00000000-0000-4000-8000-000000000042",
    );
    expect(busyMove.status).toBe(409);
    expect(await busyMove.json()).toEqual({
      kind: "rejected",
      code: "chat_running",
    });
    await editAutumnProjectDuringTurn(session, scope, savedRunId);
    const actor = await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: ORGANISATION_ID,
      sessionId: stream.sessionId,
      now: Date.now(),
    });
    if (!actor.ok) throw new Error(actor.error.code);
    const legacyRestoreEvidence = await verifyLegacyProjectRestore(actor.value);
    const disconnectedReplay = await readChatEndpoint(
      session,
      `/stream?conversation=${conversationId}&request=${requestId}&after=-1`,
    );
    if (disconnectedReplay.body === null)
      throw new Error("Missing disconnect-test response body");
    await disconnectedReplay.body.cancel();
    expect(await readConversation(fixtureDatabase(), scope, conversationId)).toMatchObject(
      {
        conversation: { work: { kind: "running", requestId } },
      },
    );
    const interruptedReplay = await readChatEndpoint(
      session,
      `/stream?conversation=${conversationId}&request=${requestId}&after=-1`,
    );
    const firstProgress = Promise.withResolvers<void>();
    const interruptedReplayBody = readObservedProgress(
      interruptedReplay,
      firstProgress,
    );
    const secondObserver = await readChatEndpoint(
      session,
      `/stream?conversation=${conversationId}&request=${requestId}&after=-1`,
    );
    const secondProgress = Promise.withResolvers<void>();
    const secondObserverBody = readObservedProgress(
      secondObserver,
      secondProgress,
    );
    await Promise.all([firstProgress.promise, secondProgress.promise]);
    await expect(
      runInDurableObject(actor.value, interruptAutomaticContextActor),
    ).rejects.toThrow();
    const interruptedRecords = await interruptedReplayBody;
    expect(interruptedRecords).not.toContain('"kind":"failed"');
    const observedProgress = interruptedRecords
      .trim()
      .split("\n")
      .map(parseRecord)
      .filter(isToolProgress);
    expect(observedProgress).toContainEqual(
      expect.objectContaining({ label: "Using bakery_saved_run_read." }),
    );
    expect(
      (await secondObserverBody)
        .trim()
        .split("\n")
        .map(parseRecord)
        .filter(isToolProgress),
    ).toEqual(observedProgress);
    const ready = await createBakerySurfaceReceipt(preparation, {
      kind: "prepared",
      binding: preparation.command.binding,
      surface: await createBakerySurfaceAttachment({
        ...surface.context,
        capturedAt: Date.now(),
      }),
    });
    expect((await postSurfaceReceipt(session, ready)).status).toBe(200);
    let resumedActor = await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: ORGANISATION_ID,
      sessionId: stream.sessionId,
      now: Date.now(),
    });
    if (!resumedActor.ok) throw new Error(resumedActor.error.code);
    let recovery = runDurableObjectAlarm(resumedActor.value).then(
      automaticAlarmSucceeded,
      automaticAlarmFailed,
    );
    reportedSurfaces.set(surface.context.surfaceSessionId, {
      surface,
      conversationId,
    });
    const effect = await waitForSurfaceEffect(
      session,
      surface.context.surfaceSessionId,
    );
    expect(effect.command.kind).toBe("inspect_surface");
    const wrongConversationEffects = await readChatEndpoint(
      session,
      `/surface-effects?browserInstanceId=browser_chat_acceptance&conversationId=conv_00000000-0000-4000-8000-000000000099`,
    );
    expect(await wrongConversationEffects.json()).toMatchObject({
      effects: [],
    });
    const wrongBrowserEffects = await readChatEndpoint(
      session,
      `/surface-effects?browserInstanceId=another_tab&conversationId=${conversationId}`,
    );
    expect(await wrongBrowserEffects.json()).toMatchObject({ effects: [] });
    const unboundEffects = await readChatEndpoint(session, `/surface-effects`);
    expect(unboundEffects.status).toBe(422);
    const inspection = await prepareBakerySurfaceCommand(
      simulator,
      effect.command,
    );
    if (inspection.kind === "rejected") throw new Error(inspection.message);
    const receipt = await createBakerySurfaceReceipt(effect, {
      kind: "completed",
      result: await bakerySurfaceCommandSucceeded(simulator, inspection),
    });
    expect((await postSurfaceReceipt(session, receipt)).status).toBe(200);
    expect((await postSurfaceReceipt(session, receipt)).status).toBe(200);
    const cameraEffect = await waitForSurfaceEffect(
      session,
      surface.context.surfaceSessionId,
    );
    expect(cameraEffect.command.kind).toBe("control_workspace_view");
    const camera = await prepareBakerySurfaceCommand(
      simulator,
      cameraEffect.command,
    );
    if (camera.kind !== "workspace_view")
      throw new Error("Expected camera command");
    const cameraTransition = commitBakerySurfaceCommand(simulator, camera, {
      kind: "agent_effect",
      effectId: cameraEffect.effectId,
    });
    if (cameraTransition.kind !== "applied")
      throw new Error(cameraTransition.message);
    simulator = cameraTransition.state;
    const cameraReceipt = await createBakerySurfaceReceipt(cameraEffect, {
      kind: "completed",
      result: await bakerySurfaceCommandSucceeded(simulator, camera),
    });
    expect((await postSurfaceReceipt(session, cameraReceipt)).status).toBe(200);
    await expect(
      runInDurableObject(resumedActor.value, interruptAutomaticContextActor),
    ).rejects.toThrow();
    await recovery;
    resumedActor = await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: ORGANISATION_ID,
      sessionId: stream.sessionId,
      now: Date.now(),
    });
    if (!resumedActor.ok) throw new Error(resumedActor.error.code);
    recovery = runDurableObjectAlarm(resumedActor.value).then(
      automaticAlarmSucceeded,
      automaticAlarmFailed,
    );
    const draftEffect = await waitForSurfaceEffect(
      session,
      surface.context.surfaceSessionId,
    );
    expect(draftEffect.command.kind).toBe("read_draft");
    const draftRead = await prepareBakerySurfaceCommand(
      simulator,
      draftEffect.command,
    );
    if (draftRead.kind !== "read") throw new Error("Expected draft read");
    const draftReceipt = await createBakerySurfaceReceipt(draftEffect, {
      kind: "completed",
      result: await bakerySurfaceCommandSucceeded(simulator, draftRead),
    });
    expect((await postSurfaceReceipt(session, draftReceipt)).status).toBe(200);
    const beforeRefresh = await preparationCount();
    expect(beforeRefresh).toBe(1);
    simulator = initialSimulatorState("closed");
    const refreshed = await captureBakerySurface(simulator);
    reportedSurfaces.set(refreshed.context.surfaceSessionId, {
      surface: refreshed,
      conversationId,
    });
    const staleEffect = await waitForSurfaceEffect(
      session,
      refreshed.context.surfaceSessionId,
    );
    const stale = await prepareBakerySurfaceCommand(
      simulator,
      staleEffect.command,
    );
    if (stale.kind !== "rejected")
      throw new Error("Expected stale target rejection");
    const staleReceipt = await createBakerySurfaceReceipt(staleEffect, {
      kind: "completed",
      result: {
        kind: "rejected",
        command: staleEffect.command.kind,
        code: stale.code,
        message: stale.message,
      },
    });
    expect((await postSurfaceReceipt(session, staleReceipt)).status).toBe(200);
    const refreshedEffect = await waitForSurfaceEffect(
      session,
      refreshed.context.surfaceSessionId,
    );
    const refreshedInspection = await prepareBakerySurfaceCommand(
      simulator,
      refreshedEffect.command,
    );
    if (refreshedInspection.kind !== "read")
      throw new Error("Expected refreshed inspection");
    const refreshedReceipt = await createBakerySurfaceReceipt(refreshedEffect, {
      kind: "completed",
      result: await bakerySurfaceCommandSucceeded(
        simulator,
        refreshedInspection,
      ),
    });
    expect((await postSurfaceReceipt(session, refreshedReceipt)).status).toBe(
      200,
    );
    const recoveryResult = await recovery;
    if (!recoveryResult.ok) throw new Error(JSON.stringify(recoveryResult));
    expect(await preparationCount()).toBe(2);
    await expect
      .poll(
        readAutomaticContextCompletion.bind(null, session, conversationId),
        { timeout: 15_000 },
      )
      .toBe("ready");
    const resumedReplay = await readChatEndpoint(
      session,
      `/stream?conversation=${conversationId}&request=${requestId}&after=-1`,
    );
    expect(await resumedReplay.text()).toContain('"kind":"complete"');
    expect(model.calls - model.discoveries.length).toBe(7);
    const counts = await runInDurableObject(
      resumedActor.value,
      countAutomaticContextHistory,
    );
    expect(counts).toMatchObject({
      users: 1,
      surfaceResults: 5,
      savedReads: 1,
    });
    expect(counts?.retrievedContextBytes).toBeLessThanOrEqual(6_250);
    expect(counts?.userInputBytes).toBeLessThanOrEqual(11_000);
    // The Case's execution shows the turn as the Session's journal records
    // it. The Pi route records each interruption as its own attempt.
    const executed = await readConversation(fixtureDatabase(), scope, conversationId);
    if (executed === null) throw new Error("Missing executed conversation");
    const resumedExecution = await verifyResumedTurnExecution({
      organisationId: ORGANISATION_ID,
      session,
      caseId: await conversationCaseId(executed.actorIdentity),
      sessionId: stream.sessionId,
      runtimes: await runInDurableObject(
        resumedActor.value,
        readCanonicalRuntimes,
      ),
      tools: await runInDurableObject(
        resumedActor.value,
        readCanonicalToolResults,
      ),
      assignments: ["failed", "completed"],
      attempts: ["interrupted", "interrupted", "ended"],
      timeline: executed.conversation.timeline.flatMap((event) =>
        event.kind === "tool_settled"
          ? [
              {
                receiptId: event.receipt?.receiptId ?? null,
                outcome: event.outcome,
              },
            ]
          : [],
      ),
      preparations: 2,
    });
    const completed = await readConversation(fixtureDatabase(), scope, conversationId);
    if (completed === null || draftUpdatedAt === null)
      throw new Error("Missing completed conversation or saved draft");
    expect(completed.conversation.draftText).toBe(AUTOMATIC_CONTEXT_DRAFT);
    expect(completed.conversation.draftUpdatedAt).toBe(draftUpdatedAt);
    expect(
      timelineVisibleMessages(completed.conversation).filter(
        isAutomaticContextUser,
      ),
    ).toHaveLength(1);
    await addAcceptedProjectReference(session, scope);
    const projectContextEvidence = await finishProjectContextJourney({
      session,
      scope,
      conversationId,
      savedRunId,
      route,
      model,
      actor: resumedActor.value,
      acceptedProject,
    });
    // Draft validation symbols stay internal; evidence crosses Vitest RPC as JSON.
    Object.assign(
      task.meta,
      JSON.parse(
        JSON.stringify({
          projectContextEvidence,
          caseExecution: {
            route,
            substituted: [
              "model provider (deterministic OpenRouter transport)",
              "browser (BakeryOS receipts made by the journey)",
            ],
            interruptions: 2,
            resumedTurn: resumedExecution,
          },
          automaticContextEvidence: {
            observedProgress,
            route,
            requestId,
            conversationId,
            stream,
            sourceRevision: savedRunId,
            savedQuery: { id: "latest", cursor: null },
            streamRecovery: {
              clientDisconnected: true,
              durableRequestAfterDisconnect: "running",
              interruptedRecords,
              resumed: "complete",
              requestResubmitted: false,
            },
            selection:
              "Newest organisation save beyond the first eight content-addressed keys; newer foreign save excluded.",
            preparation,
            ready,
            receipt,
            counts,
            preparationReuse: {
              beforeRefresh,
              afterRefresh: await preparationCount(),
              secondInterruption:
                "Camera receipt settled before history acceptance",
              cameraReceipt,
              draftReceipt,
              staleReceipt,
              refreshedReceipt,
            },
            deliveryFences: {
              wrongBrowser: true,
              wrongConversation: true,
              futureReadiness: true,
            },
            personGrantUsed: true,
            legacyRestoreEvidence,
            priorChatDoesNotSelectProductContext: true,
            draft: {
              text: completed.conversation.draftText,
              updatedAt: completed.conversation.draftUpdatedAt,
              manualRetry: true,
            },
            providerStarts: model.requests.length,
          },
        }),
      ),
    );
  },
);

function isAutomaticContextUser(message: { kind: string }): boolean {
  return message.kind === "user";
}

async function preparationCount(): Promise<number> {
  const count = await fixtureDatabase().prepare(
    "SELECT COUNT(*) AS count FROM bakery_surface_effect_delivery WHERE json_extract(effect_json, '$.command.kind') = 'prepare_context'",
  ).first<{ count: number }>();
  if (count === null) throw new Error("Missing preparation count");
  return count.count;
}

function failAutomaticContextStart(): Response {
  return Response.json(
    {
      error: {
        message: "Synthetic provider interruption before tool execution",
        code: 400,
      },
    },
    { status: 400 },
  );
}

async function saveAutomaticContextDraft(
  session: IssuedControlSession,
  conversationId: string,
): Promise<number> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat/conversations/${conversationId}/draft`,
    {
      method: "PUT",
      headers: {
        origin: "https://localhost",
        "content-type": "application/json",
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
      },
      body: JSON.stringify({
        draft: AUTOMATIC_CONTEXT_DRAFT,
        expectedUpdatedAt: null,
      }),
    },
  );
  expect(response.status).toBe(200);
  const result: unknown = await response.json();
  if (
    !isRecord(result) ||
    !isRecord(result.draft) ||
    typeof result.draft.updatedAt !== "number"
  )
    throw new Error("Missing saved acceptance draft");
  return result.draft.updatedAt;
}

async function seedPriorChatContext(
  session: IssuedControlSession,
): Promise<void> {
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToPriorChatContext,
    ),
  );
  const conversationId = "conv_6dd370a7-a96e-532a-a087-e2d7e368a95f";
  expect(
    (
      await send(session, {
        ...command(
          "request_context_setup",
          "Record that the automatic-context acceptance setup is ready.",
        ),
        conversationId,
      })
    ).status,
  ).toBe(200);
  await expect
    .poll(readAutomaticContextCompletion.bind(null, session, conversationId), {
      timeout: 15_000,
    })
    .toBe("ready");
}

function respondToPriorChatContext(): Response {
  return openRouterText(
    "Read the most recently saved bakery run, then show the current bakery workspace. " +
      JSON.stringify({
        reference: "0123456789abcdef".repeat(512),
        assumptions: "焼き菓子".repeat(512),
      }),
    "chatcmpl_context_setup",
  );
}

async function respondToAutomaticContext(
  model: {
    savedRunId: string;
    calls: number;
    discoveries: string[];
    requests: unknown[];
  },
  request: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  model.calls += 1;
  if (model.calls > 16)
    throw new Error("The requested context tool was not discoverable");
  model.requests.push(await request.request.clone().json());
  switch (model.calls - model.discoveries.length) {
    case 1:
      return discoverableToolCall(
        model,
        request,
        "bakery_saved_run_read",
        { id: "latest", cursor: null },
        "saved_latest",
      );
    case 2:
      return discoverableToolCall(
        model,
        request,
        "bakery_surface_inspect",
        {},
        "automatic_browser",
      );
    case 3:
      return discoverableToolCall(
        model,
        request,
        "bakery_surface_control_workspace_view",
        { action: { kind: "setCamera", camera: "overhead" } },
        "automatic_camera",
      );
    case 4:
      return discoverableToolCall(
        model,
        request,
        "bakery_surface_read_draft",
        {},
        "automatic_draft",
      );
    case 5:
      return discoverableToolCall(
        model,
        request,
        "bakery_surface_inspect",
        {},
        "automatic_stale",
      );
    case 6:
      return discoverableToolCall(
        model,
        request,
        "bakery_surface_inspect",
        {},
        "automatic_refreshed",
      );
    case 7:
      return openRouterText(
        JSON.stringify({
          kind: "reply",
          text: "Read the saved catalogue and confirmed the current BakeryOS view.",
        }),
        "automatic_done",
      );
    default:
      throw new Error("Unexpected extra inference");
  }
}

async function saveAutomaticContextRun(): Promise<string> {
  const prepared = await prepareAutomaticContextRun();
  await storeAutomaticContextRun(prepared);
  return prepared.id;
}

async function prepareAutomaticContextRun() {
  const replay = parsePhysicsReplay(JSON.stringify(ovenCycle));
  if (replay.kind === "rejected") throw new Error("Invalid recording fixture");
  const run = await rehearsalFromRecording(
    rehearsalSettings(sampleSettings()),
    replay.recording,
  );
  if (run.kind === "rejected") throw new Error(run.message);
  return prepareRehearsalRunWorkspace(
    "Tomorrow's cold-tray assumptions",
    run.plan,
  );
}

async function storeAutomaticContextRun(
  prepared: Awaited<ReturnType<typeof prepareAutomaticContextRun>>,
): Promise<void> {
  await env.ARCHIVE.put(
    `bakery-runs/${ORGANISATION_ID}/${prepared.id}`,
    prepared.snapshot.content,
    {
      customMetadata: {
        name: prepared.snapshot.name,
        kind: prepared.snapshot.kind,
      },
    },
  );
}

async function saveLatestAutomaticContextRun(): Promise<string> {
  const prepared = await prepareAutomaticContextRun();
  let lowerKeys = 0;
  let higherKeys = 0;
  for (
    let index = 0;
    index < 5_000 && (lowerKeys < 8 || higherKeys < 8);
    index += 1
  ) {
    const content = JSON.stringify({
      name: `Older save ${index}`,
      document: {
        schemaVersion: 1,
        kind: "bakery-orchestration-run",
        trays: [],
        operations: [],
      },
    });
    const id = await sha256Hex(content);
    if (id < prepared.id) lowerKeys += 1;
    else higherKeys += 1;
    await env.ARCHIVE.put(`bakery-runs/${ORGANISATION_ID}/${id}`, content, {
      customMetadata: { name: `Older save ${index}`, kind: "rehearsal" },
    });
  }
  expect(lowerKeys).toBeGreaterThanOrEqual(8);
  expect(higherKeys).toBeGreaterThanOrEqual(8);
  // Give the selection fixture distinct R2 upload timestamps.
  await scheduler.wait(2);
  await storeAutomaticContextRun(prepared);
  const firstPage = await env.ARCHIVE.list({
    prefix: `bakery-runs/${ORGANISATION_ID}/`,
    limit: 8,
  });
  expect(firstPage.truncated).toBe(true);
  expect(firstPage.objects.map(savedObjectKey)).not.toContain(
    `bakery-runs/${ORGANISATION_ID}/${prepared.id}`,
  );
  await scheduler.wait(2);
  const foreignContent = JSON.stringify({
    name: "Newer foreign save",
    document: JSON.parse(prepared.snapshot.file),
  });
  const foreignId = await sha256Hex(foreignContent);
  await env.ARCHIVE.put(
    `bakery-runs/foreign-workspace/${foreignId}`,
    foreignContent,
    {
      customMetadata: {
        name: "Newer foreign save",
        kind: prepared.snapshot.kind,
      },
    },
  );
  return prepared.id;
}

function savedObjectKey(object: R2Object): string {
  return object.key;
}

async function pendingBrowserPreparation(
  session: IssuedControlSession,
  conversationId: string,
): Promise<BakerySurfaceEffectV1> {
  await expect
    .poll(readBrowserPreparation.bind(null, session, conversationId), {
      timeout: 15_000,
    })
    .not.toBeNull();
  const effect = await readBrowserPreparation(session, conversationId);
  if (effect === null) throw new Error("Missing browser preparation");
  return effect;
}

async function readBrowserPreparation(
  session: IssuedControlSession,
  conversationId: string,
): Promise<BakerySurfaceEffectV1 | null> {
  const response = await readChatEndpoint(
    session,
    `/surface-effects?browserInstanceId=browser_chat_acceptance&conversationId=${conversationId}`,
  );
  const raw: unknown = await response.json();
  if (!isRecord(raw) || !Array.isArray(raw.effects))
    throw new Error("Invalid pending response");
  for (const candidate of raw.effects) {
    if (!isRecord(candidate)) continue;
    const parsed = parseBakerySurfaceEffect(candidate.effect);
    if (
      parsed.kind === "valid" &&
      parsed.value.command.kind === "prepare_context"
    )
      return parsed.value;
  }
  return null;
}

async function readAutomaticContextCompletion(
  session: IssuedControlSession,
  conversationId: string,
): Promise<string> {
  const response = await readChatEndpoint(
    session,
    `?conversation=${conversationId}`,
  );
  const raw: unknown = await response.json();
  return isRecord(raw) &&
    isRecord(raw.conversation) &&
    isRecord(raw.conversation.work) &&
    typeof raw.conversation.work.kind === "string"
    ? raw.conversation.work.kind
    : "missing";
}

function countAutomaticContextHistory(
  _actor: unknown,
  state: DurableObjectState,
) {
  const counts = state.storage.sql
    .exec<{ users: number; surfaceResults: number; savedReads: number }>(
      `SELECT
    SUM(json_extract(payload, '$.entry.kind') = 'user_input') AS users,
    SUM(json_extract(payload, '$.entry.kind') = 'tool_result' AND json_extract(payload, '$.entry.authority.kind') = 'surface_effect') AS surfaceResults,
    SUM(json_extract(payload, '$.entry.kind') = 'tool_result' AND json_extract(payload, '$.entry.tool') = 'bakery_saved_run_read') AS savedReads
    FROM session_harness_history`,
    )
    .toArray()[0];
  const firstInput = state.storage.sql
    .exec<{ text: string }>(
      `SELECT json_extract(payload, '$.entry.content[0].text') AS text
       FROM session_harness_history
       WHERE json_extract(payload, '$.entry.kind') = 'user_input'
       ORDER BY sequence LIMIT 1`,
    )
    .toArray()[0];
  if (counts === undefined || firstInput === undefined)
    throw new Error("Missing accepted automatic-context history");
  const context = firstInput.text.includes("Current request:\n")
    ? (firstInput.text.split("Current request:\n")[0] ?? "")
    : "";
  const encoder = new TextEncoder();
  return {
    users: counts.users,
    surfaceResults: counts.surfaceResults,
    savedReads: counts.savedReads,
    retrievedContextBytes: encoder.encode(context).byteLength,
    userInputBytes: encoder.encode(firstInput.text).byteLength,
  };
}

function interruptAutomaticContextActor(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.abort("Automatic context acceptance interruption");
}
function automaticAlarmSucceeded(value: boolean) {
  return { ok: true, value };
}
function automaticAlarmFailed(error: unknown) {
  return { ok: false, error };
}

it.skipIf(env.OPENROUTER_API_KEY === "openrouter-e2e-key")(
  "compares selected orders with saved assumptions and prepares browser context through the real pinned Pi route",
  liveAutomaticContext,
  200_000,
);

async function liveAutomaticContext({ task }: TestContext): Promise<void> {
  const { session, scope } = await fixture();
  const savedRunId = await saveAutomaticContextRun();
  const merchantId = "merchant_bakery_c3_order_capacity";
  await installAutomaticContextCommerce(merchantId);
  const native = new CommerceAdminClient({
    baseUrl: "http://underclerk.test",
    serviceToken: "underclerk-e2e-token",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });
  const before = await native.readSnapshot(merchantId);
  if (!before.ok) throw new Error("Missing comparison merchant snapshot");
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      forwardAutomaticContextProvider,
    ),
  );
  const conversationId = "conv_920061c1-6f5e-50c3-982e-b59958ad4951";
  const requestId = "request_context_live_pi";
  const comparisonRequestId = "request_context_live_pi_comparison";
  const comparisonText = `Read exactly the selected system orders order_capacity_upcoming, order_capacity_partial and order_capacity_cancelled with commerce_entity_context, maxDepth 0, resultLimit 3, internal sensitivity, allowedAttributeIds ["lifecycle", "ext_ordered_boxes", "ext_fulfilled_boxes", "ext_pieces_per_box", "ext_recipe_id", "ext_recipe_revision"], current_only. Read saved BakeryOS run ${savedRunId} with bakery_saved_run_read. Discover these tools as needed. This is synthetic acceptance data. For this comparison the saved rehearsal represents financier recipe revision 1; record that operator-supplied mapping as an assumption. Include only unfulfilled active demand for that recipe, exclude cancelled demand, and multiply remaining boxes by the observed pieces per box. Calculate nominal planned pieces as batchCount * traysPerBatch * piecesPerTray, required trays rounded up, and the nonnegative shortfall. Distinguish nominal planned output from actual saved tray count and physical production evidence. Do not use browser tools, navigate, change, simulate or save. Return only a JSON object using this exact flat schema and field names: { activeOrderIds: string[], cancelledOrderIds: string[], recipeId: string, recipeRevision: number, remainingDemandPieces: number, settingsAssumedPieces: number, requiredTrays: number, shortfallPieces: number, savedTrayCount: number, capacityVerified: boolean, assumptions: string[] }. Keep all calculations in those fields and explanations in assumptions. Complete this same request.`;
  const comparisonStartedAt = Date.now();
  expect(
    (
      await send(session, {
        ...command(comparisonRequestId, comparisonText),
        conversationId,
      })
    ).status,
  ).toBe(200);
  const comparing = await readConversation(fixtureDatabase(), scope, conversationId);
  if (comparing?.conversation.work.kind !== "running")
    throw new Error("Missing comparison session");
  const comparisonStream = comparing.conversation.work.stream;
  await expect
    .poll(readAutomaticContextCompletion.bind(null, session, conversationId), {
      timeout: 100_000,
    })
    .toMatch(/^(ready|failed|cancelled)$/);
  const comparison = await readConversation(fixtureDatabase(), scope, conversationId);
  if (comparison === null) throw new Error("Missing comparison conversation");
  const comparisonReplies = timelineVisibleMessages(comparison.conversation)
    .filter(isAssistant)
    .map(messageText);
  const comparisonActor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: comparisonStream.sessionId,
    now: Date.now(),
  });
  if (!comparisonActor.ok) throw new Error(comparisonActor.error.code);
  const readProof = await runInDurableObject(
    comparisonActor.value,
    readAutomaticComparisonHistory,
  );
  const beforeReveal = await fixtureDatabase().prepare(
    "SELECT COUNT(*) AS count FROM bakery_surface_effect_delivery",
  ).first<{ count: number }>();
  Object.assign(task.meta, {
    automaticComparisonEvidence: {
      route: "real_pi",
      funding: "platform",
      elapsedMs: Date.now() - comparisonStartedAt,
      conversationId,
      requestId: comparisonRequestId,
      stream: comparisonStream,
      sourceRevision: savedRunId,
      state: comparison.conversation.work.kind,
      replies: comparisonReplies,
      readProof,
      browserEffects: beforeReveal?.count,
      before: before.value,
    },
  });
  expect(comparison.conversation.work.kind).toBe("ready");
  expect(beforeReveal?.count).toBe(0);
  expect(readProof.observedOrders).toEqual([
    {
      entityId: commerceCanonicalResourceId(
        merchantId,
        "order_capacity_cancelled",
      ),
      revision: 1,
    },
    {
      entityId: commerceCanonicalResourceId(
        merchantId,
        "order_capacity_partial",
      ),
      revision: 1,
    },
    {
      entityId: commerceCanonicalResourceId(
        merchantId,
        "order_capacity_upcoming",
      ),
      revision: 1,
    },
  ]);
  expect(readProof.sourceObservations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: {
          kind: "organisation_record",
          organisationId: ORGANISATION_ID,
          recordId: `bakery-run:${savedRunId}`,
        },
        contentDigest: savedRunId,
      }),
      expect.objectContaining({
        source: expect.objectContaining({
          kind: "integration_resource",
          organisationId: ORGANISATION_ID,
        }),
      }),
    ]),
  );
  const result: unknown = JSON.parse(comparisonReplies[0] ?? "null");
  expect(result).toMatchObject({
    activeOrderIds: expect.arrayContaining([
      "order_capacity_upcoming",
      "order_capacity_partial",
    ]),
    cancelledOrderIds: ["order_capacity_cancelled"],
    recipeId: "financier",
    recipeRevision: 1,
    remainingDemandPieces: 120,
    settingsAssumedPieces: 72,
    requiredTrays: 5,
    shortfallPieces: 48,
    savedTrayCount: 1,
    capacityVerified: false,
    assumptions: expect.arrayContaining([
      expect.stringMatching(/operator|mapping/iu),
    ]),
  });
  expect(await native.readSnapshot(merchantId)).toEqual(before);
  const text =
    "Inspect the current browser workspace with bakery_surface_inspect as a direct tool call. Discover it if needed. Do not open another run, change anything, simulate or save. Explain what the current browser shows and distinguish it from the saved simulation assumptions we read. Complete this same request.";
  const browserStartedAt = Date.now();
  expect(
    (await send(session, { ...command(requestId, text), conversationId }))
      .status,
  ).toBe(200);
  const simulator = initialSimulatorState("closed");
  const receipts: BakerySurfaceReceiptV1[] = [];
  await expect
    .poll(
      drainLiveContextBrowser.bind(
        null,
        session,
        conversationId,
        simulator,
        receipts,
      ),
      { timeout: 180_000, interval: 100 },
    )
    .toMatch(/^(ready|failed|cancelled)$/);
  const stored = await readConversation(fixtureDatabase(), scope, conversationId);
  if (stored === null) throw new Error("Missing real Pi conversation");
  const replies = timelineVisibleMessages(stored.conversation)
    .filter(isAssistant)
    .map(messageText);
  Object.assign(task.meta, {
    automaticContextEvidence: {
      route: "real_pi",
      funding: "platform",
      elapsedMs: Date.now() - browserStartedAt,
      requestId,
      conversationId,
      sourceRevision: savedRunId,
      state: stored.conversation.work.kind,
      failure:
        stored.conversation.work.kind === "failed"
          ? stored.conversation.work.error
          : null,
      receipts,
      replies,
    },
  });
  expect(stored.conversation.work.kind).toBe("ready");
  expect(replies.length).toBeGreaterThan(0);
  expect(receipts.some(isPreparedContextReceipt)).toBe(true);
  expect(receipts.some(isCompletedContextReceipt)).toBe(true);
  const deliveries = await fixtureDatabase().prepare(
    "SELECT receipt_json FROM bakery_surface_effect_delivery",
  ).all<{ receipt_json: string | null }>();
  for (const delivery of deliveries.results)
    expect(JSON.parse(delivery.receipt_json ?? "null")).not.toMatchObject({
      outcome: { kind: "delivery_failed" },
    });
  expect(await native.readSnapshot(merchantId)).toEqual(before);
}

async function readAutomaticComparisonHistory(
  _actor: unknown,
  state: DurableObjectState,
) {
  const acceptedReads = state.storage.sql
    .exec<{ payload: string }>(
      "SELECT payload FROM session_harness_history WHERE json_extract(payload, '$.entry.kind') = 'tool_result' AND json_extract(payload, '$.entry.tool') IN ('commerce_entity_context', 'bakery_saved_run_read', 'codemode') ORDER BY sequence",
    )
    .toArray()
    .map(parseAutomaticComparisonEntry);
  const sourceObservations: Array<ReturnType<ObservationEvidence["toJSON"]>> =
    [];
  for (const row of state.storage.sql
    .exec<{ evidence_json: string }>(
      "SELECT evidence_json FROM session_information_flow_observation ORDER BY recorded_at",
    )
    .toArray()) {
    const parsed: unknown = JSON.parse(row.evidence_json);
    const restored = await ObservationEvidence.restore(parsed);
    if (!restored.ok) throw new Error(restored.error.code);
    sourceObservations.push(restored.value.toJSON());
  }
  const observedOrders = state.storage.sql
    .exec<{ entityId: string; revision: number }>(
      "SELECT DISTINCT entity_id AS entityId, revision FROM session_commerce_observation_entity WHERE entity_type = 'order' ORDER BY entity_id",
    )
    .toArray();
  return { acceptedReads, sourceObservations, observedOrders };
}

function parseAutomaticComparisonEntry(row: {
  payload: string;
}): Record<string, unknown> {
  const parsed: unknown = JSON.parse(row.payload);
  if (!isRecord(parsed) || !isRecord(parsed.entry))
    throw new Error("Invalid accepted comparison read");
  return parsed.entry;
}

async function installAutomaticContextCommerce(
  merchantId: string,
): Promise<void> {
  await connectCommerceFixture(
    ORGANISATION_ID,
    "user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab",
    merchantId,
  );
  const seeded = await env.UNDERCLERK.fetch(
    `http://underclerk.test/v1/admin/merchants/${merchantId}/test-fixture`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer underclerk-e2e-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "order_capacity" }),
    },
  );
  expect(seeded.status).toBe(200);
  const identity = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!identity.ok) throw new Error(identity.error.code);
  const now = Date.now();
  for (const capabilityId of [
    "commerce.entity_plane.context",
    "commerce.entity.read",
  ] as const) {
    const changed = await writeOrganisationCapabilityPolicy({
      scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
      write: {
        kind: "change",

        capabilityId,
        expectedRevision: 1,
        mode: "enabled",
        provenance: {
          kind: "operator",
          userId: identity.value,
          mutationReceiptId: `receipt_context_${capabilityId}`,
        },
        now,
      },
    });
    if (!changed.ok) throw new Error(changed.error.code);
  }
  await createRequiredGrant({
    grantId: "grant_context_commerce",
    subject: { kind: "person", personId: "person_e2e-slack-actor" },
    target: {
      kind: "platform_capability",
      capabilityId: "commerce.entity_plane.context",
      capabilityVersion: 1,
    },
    now,
  });
  await createRequiredGrant({
    grantId: "grant_context_orders",
    subject: { kind: "organisation_role", role: "admin" },
    target: {
      kind: "commerce_read",
      capabilityId: "commerce.entity.read",
      capabilityVersion: 1,
      scope: {
        kind: "entity_type",
        entityTypeId: { origin: "system", typeId: "order" },
      },
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
}

async function drainLiveContextBrowser(
  session: IssuedControlSession,
  conversationId: string,
  simulator: ReturnType<typeof initialSimulatorState>,
  receipts: BakerySurfaceReceiptV1[],
): Promise<string> {
  if (receipts.length > 12)
    throw new Error("Real Pi exceeded the bounded browser journey");
  const surface = await captureBakerySurface(simulator);
  const response = await readChatEndpoint(
    session,
    `/surface-effects?browserInstanceId=browser_chat_acceptance&conversationId=${conversationId}`,
  );
  const raw: unknown = await response.json();
  if (!isRecord(raw) || !Array.isArray(raw.effects))
    throw new Error("Invalid browser delivery projection");
  for (const pending of raw.effects) {
    if (!isRecord(pending)) throw new Error("Invalid browser effect");
    const parsed = parseBakerySurfaceEffect(pending.effect);
    if (parsed.kind === "invalid") throw new Error(parsed.message);
    const effect = parsed.value;
    let receipt: BakerySurfaceReceiptV1;
    if (effect.command.kind === "prepare_context")
      receipt = await createBakerySurfaceReceipt(effect, {
        kind: "prepared",
        binding: effect.command.binding,
        surface,
      });
    else {
      if (
        effect.command.kind !== "inspect_surface" &&
        effect.command.kind !== "read_draft" &&
        effect.command.kind !== "query_tasks"
      )
        throw new Error("Real Pi requested a write during the read journey");
      const prepared = await prepareBakerySurfaceCommand(
        simulator,
        effect.command,
      );
      if (prepared.kind === "rejected") throw new Error(prepared.message);
      receipt = await createBakerySurfaceReceipt(effect, {
        kind: "completed",
        result: await bakerySurfaceCommandSucceeded(simulator, prepared),
      });
    }
    expect((await postSurfaceReceipt(session, receipt)).status).toBe(200);
    receipts.push(receipt);
  }
  return readAutomaticContextCompletion(session, conversationId);
}
function isPreparedContextReceipt(receipt: BakerySurfaceReceiptV1): boolean {
  return receipt.outcome.kind === "prepared";
}
function isCompletedContextReceipt(receipt: BakerySurfaceReceiptV1): boolean {
  return receipt.outcome.kind === "completed";
}

async function forwardAutomaticContextProvider({
  request,
}: Parameters<HttpResponseResolver>[0]): Promise<Response> {
  return fetch(
    bypass(request.url, {
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    }),
  );
}

it.for(["excluded"] as const)(
  "bounds automatic context when the browser is %s",
  { timeout: 35_000 },
  blockedContext,
);

async function blockedContext(
  browser: "excluded" | "absent",
  { task }: TestContext,
): Promise<void> {
  const { session } = await fixture();
  const model = {
    calls: 0,
    discoveries: [] as string[],
    requests: [] as unknown[],
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToBlockedContext.bind(null, model),
    ),
  );
  const conversationId = newConversationId();
  const requestId = `request_context_${browser}`;
  const binding = {
    browserInstanceId: "browser_chat_acceptance",
    conversationId,
  };
  const browserContext = {
    kind: browser === "excluded" ? "excluded" : "available",
    binding,
  };
  // The user's chat page, whose signal socket announces each browser
  // command at once (Plan 87 phase 3).
  const page = await openSocket(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat/signals`,
    session,
  );
  const announced = surfaceEffectSignals(page);
  const sentAt = Date.now();
  expect(
    (
      await send(session, {
        ...command(requestId, "Inspect the current BakeryOS workspace."),
        conversationId,
        browserContext,
      })
    ).status,
  ).toBe(200);
  await expect
    .poll(readAutomaticContextCompletion.bind(null, session, conversationId), {
      timeout: 25_000,
    })
    .toBe("ready");
  const deliveries = await fixtureDatabase().prepare(
    "SELECT effect_json, receipt_json FROM bakery_surface_effect_delivery",
  ).all<{ effect_json: string; receipt_json: string | null }>();
  expect(deliveries.results).toHaveLength(browser === "absent" ? 1 : 0);
  page.close();
  // An excluded browser gets no command, so its page hears none.
  if (browser === "absent") expect(announced.length).toBeGreaterThan(0);
  else expect(announced).toEqual([]);
  for (const delivery of deliveries.results) {
    expect(JSON.parse(delivery.effect_json)).toMatchObject({
      command: { kind: "prepare_context" },
    });
    expect(JSON.parse(delivery.receipt_json ?? "null")).toMatchObject({
      outcome: { kind: "delivery_failed", code: "surface_unavailable" },
    });
  }
  if (browser === "absent") {
    const observed = await readChatEndpoint(
      session,
      `?conversation=${conversationId}&observe=true`,
    );
    expect(await observed.json()).toMatchObject({
      conversation: {
        timeline: expect.arrayContaining([
          expect.objectContaining({
            contextDetails: expect.objectContaining({
              kind: "failed",
              area: "BakeryOS",
            }),
          }),
        ]),
      },
    });
  }
  Object.assign(task.meta, {
    automaticContextEvidence: {
      browser,
      requestId,
      conversationId,
      preparations: deliveries.results.length,
      executableCommands: 0,
      surfaceEffectSignalsAfterMs: announced.map(
        (receivedAt) => receivedAt - sentAt,
      ),
    },
  });
}

/** When each `surface_effect` signal reached the page. */
function surfaceEffectSignals(socket: WebSocket): number[] {
  const received: number[] = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    if (parseChatSignal(event.data)?.kind === SURFACE_EFFECT_SIGNAL)
      received.push(Date.now());
  });
  return received;
}

async function respondToBlockedContext(
  model: { calls: number; discoveries: string[]; requests: unknown[] },
  request: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  model.calls += 1;
  if (model.calls > 8)
    throw new Error("Blocked browser tool was not discoverable");
  model.requests.push(await request.request.clone().json());
  if (model.calls - model.discoveries.length === 1)
    return discoverableToolCall(
      model,
      request,
      "bakery_surface_inspect",
      {},
      "blocked_browser",
    );
  return openRouterText(
    JSON.stringify({
      kind: "reply",
      text: "Browser context is unavailable for this operation; open the eligible portal chat or change its exclusion.",
    }),
    "blocked_done",
  );
}

it.for(["cancel", "revoke"] as const)(
  "fences late automatic readiness after %s",
  { timeout: 25_000 },
  async function fencePreparation(action, { task }) {
    const { session, scope } = await fixture();
    const model = {
      calls: 0,
      discoveries: [] as string[],
      requests: [] as unknown[],
    };
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        respondToBlockedContext.bind(null, model),
      ),
    );
    const conversationId = newConversationId();
    const requestId = `request_context_${action}`;
    expect(
      (
        await send(session, {
          ...command(requestId, "Show the current BakeryOS workspace."),
          conversationId,
        })
      ).status,
    ).toBe(200);
    const preparation = await pendingBrowserPreparation(
      session,
      conversationId,
    );
    if (preparation.command.kind !== "prepare_context")
      throw new Error("Expected preparation");
    const stored = await readConversation(fixtureDatabase(), scope, conversationId);
    if (stored?.conversation.work.kind !== "running")
      throw new Error("Expected running request");
    const stream = stored.conversation.work.stream;
    if (action === "cancel") {
      const response = await exports.default.fetch(
        new Request(
          `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat/cancel`,
          {
            method: "POST",
            headers: {
              origin: "https://localhost",
              "content-type": "application/json",
              cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
              "x-satyr-csrf": session.csrfToken,
            },
            body: JSON.stringify({
              conversationId,
              requestId,
              sessionId: stream.sessionId,
              turnId: stream.turnId,
              cancellationId: "cancel_context",
            }),
          },
        ),
      );
      expect(response.status).toBe(200);
    } else
      await fixtureDatabase().prepare(
        "UPDATE service_role_grant SET status = 'revoked', revoked_at = ? WHERE organisation_id = ? AND user_id = ?",
      )
        .bind(Date.now(), ORGANISATION_ID, SLACK_ACTOR_USER_ID)
        .run();
    const ready = await createBakerySurfaceReceipt(preparation, {
      kind: "prepared",
      binding: preparation.command.binding,
      surface: await captureBakerySurface(initialSimulatorState("closed")),
    });
    const late = await postSurfaceReceipt(session, ready);
    expect(late.status).toBe(action === "cancel" ? 409 : 404);
    const commands = await fixtureDatabase().prepare(
      "SELECT effect_id FROM bakery_surface_effect_delivery WHERE json_extract(effect_json, '$.command.kind') != 'prepare_context'",
    ).all();
    expect(commands.results).toEqual([]);
    Object.assign(task.meta, {
      automaticContextEvidence: {
        action,
        requestId,
        conversationId,
        stream,
        preparationId: preparation.effectId,
        lateReceiptStatus: late.status,
        executableCommands: 0,
      },
    });
  },
);

it.for(["absent"] as const)(
  "bounds automatic context when the browser is %s",
  { timeout: 35_000 },
  blockedContext,
);

async function reliableFinalization({ task }: TestContext): Promise<void> {
  const { scope, session } = await fixture();
  const model: Model = {
    calls: 0,
    discoveries: [],
    savedRunId: "",
    phase: "idle",
    releaseSecondStep: Promise.withResolvers<void>(),
    releaseRevoked: Promise.withResolvers<void>(),
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respond.bind(null, model),
    ),
  );
  const first = command("request_long_root", "Produce a long response.");
  await fixtureDatabase().prepare(
    `CREATE TRIGGER fail_session_preparation
    BEFORE INSERT ON durable_object_registry WHEN NEW.object_kind = 'session'
    BEGIN SELECT RAISE(ABORT, 'e2e_session_preparation_unavailable'); END`,
  ).run();
  const admittedAt = Date.now();
  const admitted = await send(session, first);
  expect(admitted.status).toBe(200);
  expect(await admitted.json()).toMatchObject({
    kind: "accepted",
    conversation: { work: { kind: "running" } },
  });
  const identities = await deriveDirectCaseIdentities(
    `${ORGANISATION_ID}:portal-chat:${scope.userId}:${CONVERSATION_ID}`,
  );
  if (!identities.ok) throw new Error(identities.error.code);
  const initialCase = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: ORGANISATION_ID,
    caseId: identities.value.caseId,
    now: Date.now(),
  });
  if (!initialCase.ok) throw new Error(initialCase.error.code);
  expect(await runInDurableObject(initialCase.value, readWake)).not.toBeNull();
  expect(model.calls).toBe(0);
  await evictDurableObject(initialCase.value);
  await fixtureDatabase().exec("DROP TRIGGER fail_session_preparation");
  expect((await send(session, first)).status).toBe(200);
  await verifyHistoricalSurfaceHistory(scope, session);
  await expect
    .poll(modelPhase.bind(null, model), { timeout: 20000 })
    .toBe("root");
  expect((await send(session, first)).status).toBe(200);
  // A text-only follow-up would steer the running turn (Plan 71). A changed
  // effort cannot steer, so this follow-up queues and drains after the turn.
  expect(
    (
      await send(session, {
        ...command("request_long_followup", "Continue in this conversation."),
        kind: "next",
        inputId: "input_long_followup",
        effort: "high",
      })
    ).status,
  ).toBe(200);

  // A real D1 failure after canonical Session/Case completion, before publication.
  await fixtureDatabase().prepare(
    `CREATE TRIGGER fail_chat_projection BEFORE UPDATE ON portal_conversation
    WHEN NEW.conversation_id = '${CONVERSATION_ID}' AND json_extract(NEW.state_json, '$.work.kind') = 'ready'
    BEGIN SELECT RAISE(ABORT, 'e2e_projection_unavailable'); END`,
  ).run();
  const running = await readConversation(fixtureDatabase(), scope, CONVERSATION_ID);
  if (running?.conversation.work.kind !== "running")
    throw new Error("Turn was not admitted");
  const stream = running.conversation.work.stream;
  const actorSession = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: stream.sessionId,
    now: Date.now(),
  });
  if (!actorSession.ok) throw new Error(actorSession.error.code);
  const actorCase = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: ORGANISATION_ID,
    caseId: identities.value.caseId,
    now: Date.now(),
  });
  if (!actorCase.ok) throw new Error(actorCase.error.code);
  const wakeBefore = await runInDurableObject(actorCase.value, readWake);
  for (let count = 0; count < 3; count += 1) {
    const status = await readChatEndpoint(
      session,
      `?conversation=${CONVERSATION_ID}&view=state`,
    );
    expect(await status.json()).toMatchObject({
      work: { kind: "running" },
    });
  }
  expect(await runInDurableObject(actorCase.value, readWake)).toEqual(
    wakeBefore,
  );

  // No stream consumer, HTTP polling, or manual Stop/reload keeps this turn alive.
  await expect
    .poll(inspectSessionTurn.bind(null, actorSession.value, stream.turnId), {
      timeout: 45_000,
      interval: 500,
    })
    .toMatchObject({ ok: true, value: { state: "complete" } });
  const disconnectedTurnDurationMs = Date.now() - admittedAt;
  expect(disconnectedTurnDurationMs).toBeGreaterThan(30_000);
  await expect
    .poll(inspectCase.bind(null, actorCase.value), { timeout: 5_000 })
    .toMatchObject({
      ok: true,
      value: { acceptedProposalIds: [expect.any(String)] },
    });
  expect(
    (await readConversation(fixtureDatabase(), scope, CONVERSATION_ID))?.conversation.work
      .kind,
  ).toBe("running");
  expect(model.calls).toBe(1 + model.discoveries.length);

  await evictDurableObject(actorCase.value);
  await fixtureDatabase().exec("DROP TRIGGER fail_chat_projection");
  expect(await runDurableObjectAlarm(actorCase.value)).toBe(true);
  await expect
    .poll(readConversation.bind(null, fixtureDatabase(), scope, CONVERSATION_ID), {
      timeout: 15_000,
    })
    .toMatchObject({
      conversation: {
        work: { kind: "ready" },
        pendingInputs: [],
        completedRequests: ["request_long_root", "request_long_followup"],
      },
    });
  const recovered = await readConversation(fixtureDatabase(), scope, CONVERSATION_ID);
  expect(
    (recovered ? timelineVisibleMessages(recovered.conversation) : undefined)
      ?.filter(isAssistant)
      .map(messageText),
  ).toEqual([LONG_TEXT, FOLLOWUP_TEXT]);
  expect(model.calls).toBe(2 + model.discoveries.length);
  expect((await send(session, first)).status).toBe(200);
  expect(model.calls).toBe(2 + model.discoveries.length);
  const reopened = await send(session, null);
  expect(await reopened.json()).toMatchObject({
    conversation: {
      work: { kind: "ready" },
      messages: expect.arrayContaining([
        { kind: "assistant", id: expect.any(String), text: LONG_TEXT },
      ]),
    },
  });

  const terminalReplay = await readChatEndpoint(
    session,
    `/stream?conversation=${CONVERSATION_ID}&request=request_long_root&after=1000042`,
  );
  expect(terminalReplay.status).toBe(200);
  expect(await terminalReplay.text()).toContain(
    '"kind":"complete","sequence":1999999',
  );
  const wrongRequest = await readChatEndpoint(
    session,
    `/stream?conversation=${CONVERSATION_ID}&request=request_not_this_chat&after=-1`,
  );
  expect(wrongRequest.status).toBe(409);

  if (recovered === null) throw new Error("Missing recovered conversation");
  const capacityId = requireConversationId(
    "conv_00000000-0000-4000-8000-000000000042",
  );
  expect(
    await saveConversation(
      await requireOrganisationExecutionScope(env, scope.organisationId),
      scope.userId,
      {
        ...recovered.conversation,
        id: capacityId,
        completedRequests: [],
        timeline: [
          {
            kind: "context",
            eventId: "context_capacity",
            sequence: 1,
            requestId: "request_history",
            createdAt: Date.now(),
            text: "x".repeat(920_000),
          },
        ],
        latestSequence: 1,
        lastReadSequence: 0,
      },
      0,
    ),
  ).toEqual({ kind: "saved" });
  expect(
    (
      await send(session, {
        ...command("request_capacity", "Finish the near-full conversation."),
        conversationId: capacityId,
      })
    ).status,
  ).toBe(200);
  await expect
    .poll(readConversation.bind(null, fixtureDatabase(), scope, capacityId), {
      timeout: 15_000,
    })
    .toMatchObject({
      conversation: {
        work: { kind: "failed", recovery: { kind: "projection_capacity" } },
      },
    });
  const blocked = await readConversation(fixtureDatabase(), scope, capacityId);
  if (
    blocked?.conversation.work.kind !== "failed" ||
    blocked.conversation.work.recovery === null
  )
    throw new Error("Missing accepted result reference");
  const resultReplay = await readChatEndpoint(
    session,
    `/stream?conversation=${capacityId}&request=request_capacity&after=-1&download=true`,
  );
  expect(resultReplay.status).toBe(200);
  expect(resultReplay.headers.get("content-disposition")).toContain(
    'filename="response-request_capacity.ndjson"',
  );
  const records: { kind: string; text?: string }[] = (await resultReplay.text())
    .trim()
    .split("\n")
    .map(parseRecord);
  expect(records.filter(isDelta).map(messageDelta).join("")).toBe(LONG_TEXT);
  expect(records.at(-1)?.kind).toBe("failed");
  const capacityCaseIds = await deriveDirectCaseIdentities(
    `${ORGANISATION_ID}:portal-chat:${scope.userId}:${capacityId}`,
  );
  if (!capacityCaseIds.ok) throw new Error(capacityCaseIds.error.code);
  const capacityCase = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: ORGANISATION_ID,
    caseId: capacityCaseIds.value.caseId,
    now: Date.now(),
  });
  if (!capacityCase.ok) throw new Error(capacityCase.error.code);
  for (let count = 0; count < 3; count += 1)
    await runDurableObjectAlarm(capacityCase.value);
  expect(await runInDurableObject(capacityCase.value, readWake)).toBeNull();
  expect(await runDurableObjectAlarm(capacityCase.value)).toBe(false);
  const retry = await send(session, {
    kind: "retry",
    conversationId: capacityId,
    requestId: "request_capacity",
    model: PLATFORM_DEFAULT_PI_MODEL,
  });
  expect(retry.status).toBe(409);
  expect(await retry.json()).toMatchObject({
    error: "chat_projection_capacity",
  });
  expect(model.calls).toBe(3 + model.discoveries.length);
  const storedCapacity = await fixtureDatabase().prepare(
    "SELECT state_json FROM portal_conversation WHERE conversation_id = ?",
  )
    .bind(capacityId)
    .first<{ state_json: string }>();
  expect(storedCapacity?.state_json).not.toContain('"messages":');
  console.info("chat_lifecycle_acceptance", {
    capacityConversation: capacityId,
    resultSession: blocked.conversation.work.recovery.stream.sessionId,
    resultTurn: blocked.conversation.work.recovery.stream.turnId,
    preservedBytes: new TextEncoder().encode(LONG_TEXT).byteLength,
    storedBytes: new TextEncoder().encode(storedCapacity?.state_json)
      .byteLength,
    observationWakeUnchanged: true,
    laterStepCursor: 1_999_999,
    duplicateInference: false,
  });

  const multistepId = newConversationId();
  const multistepCommand = {
    ...command("request_multistep", "Produce a corrected response."),
    conversationId: multistepId,
  };
  expect((await send(session, multistepCommand)).status).toBe(200);
  await expect
    .poll(modelPhase.bind(null, model), { timeout: 20000 })
    .toBe("second_step");
  expect(await readConversation(fixtureDatabase(), scope, multistepId)).toMatchObject({
    conversation: { work: { kind: "running", stream: { step: 1 } } },
  });
  const secondStepReplay = await readChatEndpoint(
    session,
    `/stream?conversation=${multistepId}&request=request_multistep&after=1000000`,
  );
  model.releaseSecondStep.resolve();
  const secondStepRecords = (await secondStepReplay.text())
    .trim()
    .split("\n")
    .map(parseRecord);
  expect(secondStepRecords.filter(isDelta).map(messageDelta).join("")).toBe(
    LONG_TEXT,
  );
  expect(secondStepRecords.at(-1)?.kind).toBe("complete");
  const finalCursor = secondStepRecords.at(-1)?.sequence;
  const progressCursor = secondStepRecords.at(-2)?.sequence;
  if (finalCursor === undefined || progressCursor === undefined)
    throw new Error("Missing actual second-step cursors");
  expect(progressCursor).toBeGreaterThan(1_000_000);
  const reconnected = await readChatEndpoint(
    session,
    `/stream?conversation=${multistepId}&request=request_multistep&after=${progressCursor}`,
  );
  expect(
    (await reconnected.text()).trim().split("\n").map(parseRecord),
  ).toContainEqual(
    expect.objectContaining({ kind: "complete", sequence: finalCursor }),
  );
  expect((await send(session, multistepCommand)).status).toBe(200);
  expect(model.calls).toBe(5 + model.discoveries.length);

  const simulator = initialSimulatorState("closed");
  const surface = await captureBakerySurface(simulator);
  const playbackChat = newConversationId();
  expect(
    (
      await send(session, {
        ...command("request_playback_seek", "Seek the canvas to 90 seconds."),
        conversationId: playbackChat,
        surfaceContext: surface,
      })
    ).status,
  ).toBe(200);
  const effect = await waitForSurfaceEffect(
    session,
    surface.context.surfaceSessionId,
  );
  expect(effect.command).toMatchObject({
    kind: "control_playback",
    action: { kind: "seek", seconds: 90 },
  });
  const prepared = await prepareBakerySurfaceCommand(simulator, effect.command);
  if (prepared.kind !== "playback")
    throw new Error("Playback was not prepared");
  const applied = commitBakerySurfaceCommand(simulator, prepared, {
    kind: "agent_effect",
    effectId: effect.effectId,
  });
  const clicked = applyPlaybackAction({ kind: "seek", seconds: 90 }, simulator);
  if (applied.kind !== "applied" || clicked.kind !== "applied")
    throw new Error("Playback was not applied");
  expect(simulatorPlaybackSnapshot(applied.state)).toEqual(
    simulatorPlaybackSnapshot(clicked.state),
  );
  const receipt = await createBakerySurfaceReceipt(effect, {
    kind: "completed",
    result: await bakerySurfaceCommandSucceeded(applied.state, prepared),
  });
  expect((await postSurfaceReceipt(session, receipt)).status).toBe(200);
  expect((await postSurfaceReceipt(session, receipt)).status).toBe(200);
  await expect
    .poll(readConversation.bind(null, fixtureDatabase(), scope, playbackChat))
    .toMatchObject({ conversation: { work: { kind: "ready" } } });
  expect(model.calls).toBe(7 + model.discoveries.length);

  expect(
    (
      await send(session, {
        ...command("request_playback_stale", "Play this run."),
        conversationId: playbackChat,
        surfaceContext: await captureBakerySurface(applied.state),
      })
    ).status,
  ).toBe(200);
  const staleEffect = await waitForSurfaceEffect(
    session,
    surface.context.surfaceSessionId,
  );
  const stalePrepared = await prepareBakerySurfaceCommand(
    applied.state,
    staleEffect.command,
  );
  if (stalePrepared.kind !== "playback")
    throw new Error("Playback was not prepared");
  const replacement = applyBakeryWorkspaceAction(
    { kind: "activeRunChanged" },
    applied.state,
  );
  const rejected = commitBakerySurfaceCommand(replacement, stalePrepared, {
    kind: "agent_effect",
    effectId: staleEffect.effectId,
  });
  expect(rejected.kind).toBe("rejected");
  if (rejected.kind !== "rejected")
    throw new Error("Stale playback mutated the replacement run");
  expect(simulatorPlaybackSnapshot(replacement).playback).toBe("paused");
  const staleReceipt = await createBakerySurfaceReceipt(staleEffect, {
    kind: "completed",
    result: rejected,
  });
  expect((await postSurfaceReceipt(session, staleReceipt)).status).toBe(200);
  await expect
    .poll(readConversation.bind(null, fixtureDatabase(), scope, playbackChat))
    .toMatchObject({ conversation: { work: { kind: "ready" } } });
  expect(model.calls).toBe(9 + model.discoveries.length);

  const recording = parsePhysicsReplay(JSON.stringify(ovenCycle));
  if (recording.kind !== "accepted")
    throw new Error("Invalid oven-cycle recording");
  const rehearsal = applySimulatorReplayAction(
    { kind: "recordingLoaded", recording: recording.recording },
    applySimulatorReplayAction(
      { kind: "openRecording" },
      applyBakeryWorkspaceAction(
        { kind: "openRehearsal" },
        initialSimulatorState("closed"),
      ),
    ),
  );
  let inspected = rehearsal;
  for (const degrees of [110, null]) {
    const inspectionSurface = await captureBakerySurface(inspected);
    expect(
      (
        await send(session, {
          ...command(
            `request_door_${degrees ?? "restore"}`,
            degrees === null
              ? "Restore the recorded oven door pose."
              : "Preview the oven door at 110 degrees.",
          ),
          conversationId: playbackChat,
          surfaceContext: inspectionSurface,
        })
      ).status,
    ).toBe(200);
    const inspectionEffect = await waitForSurfaceEffect(
      session,
      inspectionSurface.context.surfaceSessionId,
    );
    expect(inspectionEffect.command).toMatchObject({
      kind: "control_workspace_view",
      action: { kind: "setDoorPreview", degrees },
    });
    const inspection = await prepareBakerySurfaceCommand(
      inspected,
      inspectionEffect.command,
    );
    if (inspection.kind !== "workspace_view")
      throw new Error("Door inspection was not prepared");
    const unchangedReceipt = await createBakerySurfaceReceipt(
      inspectionEffect,
      {
        kind: "completed",
        result: await bakerySurfaceCommandSucceeded(inspected, inspection),
      },
    );
    expect((await postSurfaceReceipt(session, unchangedReceipt)).status).toBe(
      409,
    );
    const inspectedResult = commitBakerySurfaceCommand(inspected, inspection, {
      kind: "agent_effect",
      effectId: inspectionEffect.effectId,
    });
    if (inspectedResult.kind !== "applied")
      throw new Error("Door inspection was not applied");
    const clickedInspection = applySimulatorViewAction(
      { kind: "setDoorPreview", degrees },
      inspected,
    );
    expect(await captureBakerySurface(inspectedResult.state)).toMatchObject({
      context: {
        active: (await captureBakerySurface(clickedInspection)).context.active,
      },
    });
    inspected = inspectedResult.state;
    const inspectionReceipt = await createBakerySurfaceReceipt(
      inspectionEffect,
      {
        kind: "completed",
        result: await bakerySurfaceCommandSucceeded(inspected, inspection),
      },
    );
    expect((await postSurfaceReceipt(session, inspectionReceipt)).status).toBe(
      200,
    );
    expect((await postSurfaceReceipt(session, inspectionReceipt)).status).toBe(
      200,
    );
    await expect
      .poll(readConversation.bind(null, fixtureDatabase(), scope, playbackChat))
      .toMatchObject({ conversation: { work: { kind: "ready" } } });
  }
  expect(model.calls).toBe(13 + model.discoveries.length);
  const preparationSurface = await captureBakerySurface(inspected);
  expect(
    (
      await send(session, {
        ...command(
          "request_prepare_workcell",
          "Prepare the open oven cycle with dispatch at 45 seconds.",
        ),
        conversationId: playbackChat,
        surfaceContext: preparationSurface,
      })
    ).status,
  ).toBe(200);
  const preparationEffect = await waitForSurfaceEffect(
    session,
    preparationSurface.context.surfaceSessionId,
  );
  const preparation = await prepareBakerySurfaceCommand(
    rehearsal,
    preparationEffect.command,
  );
  if (preparation.kind !== "workcell_preparation")
    throw new Error(
      `Workcell was not prepared: ${JSON.stringify(preparation)}`,
    );
  const preparedWorkcell = commitBakerySurfaceCommand(rehearsal, preparation, {
    kind: "agent_effect",
    effectId: preparationEffect.effectId,
  });
  if (preparedWorkcell.kind !== "applied")
    throw new Error("Workcell was not applied");
  // Chat opens a one-tray rehearsal on the production scheduler whose first
  // step awaits a result, staged no earlier than the requested dispatch.
  const preparedWorkspace = preparedWorkcell.state.workspace;
  if (
    preparedWorkspace.kind !== "production" ||
    preparedWorkspace.production.data.kind !== "ready"
  )
    throw new Error("Rehearsal was not opened");
  expect(preparedWorkspace.production.procedure).toBe("rehearsal");
  const [preparedRoot] = preparedWorkspace.production.data.plan.operations;
  expect(preparedRoot?.attempt.kind).toBe("awaiting-evidence");
  expect(preparedRoot?.attempt.input.kind).toBe("native-cycle");
  expect(preparedRoot?.earliestStartSeconds).toBe(45);
  expect(preparedWorkspace.surfaceEpoch).toBe(
    rehearsal.workspace.surfaceEpoch + 1,
  );
  const preparationResult = await bakerySurfaceCommandSucceeded(
    preparedWorkcell.state,
    preparation,
  );
  expect(preparationResult).toMatchObject({
    kind: "succeeded",
    command: "prepare_workcell",
  });
  const preparationReceipt = await createBakerySurfaceReceipt(
    preparationEffect,
    { kind: "completed", result: preparationResult },
  );
  expect((await postSurfaceReceipt(session, preparationReceipt)).status).toBe(
    200,
  );
  expect((await postSurfaceReceipt(session, preparationReceipt)).status).toBe(
    200,
  );
  const recapture = await captureBakerySurface(preparedWorkcell.state);
  expect(recapture.context.supportedCommands).not.toContain("prepare_workcell");
  const stalePreparation = commitBakerySurfaceCommand(
    preparedWorkcell.state,
    preparation,
    { kind: "agent_effect", effectId: preparationEffect.effectId },
  );
  expect(stalePreparation.kind).toBe("rejected");
  await expect
    .poll(readConversation.bind(null, fixtureDatabase(), scope, playbackChat))
    .toMatchObject({ conversation: { work: { kind: "ready" } } });
  expect(model.calls).toBe(15 + model.discoveries.length);

  const simulationRequest = "request_simulation_cancel";
  expect(
    (
      await send(session, {
        ...command(simulationRequest, "Simulate the prepared oven cycle."),
        conversationId: playbackChat,
        surfaceContext: recapture,
      })
    ).status,
  ).toBe(200);
  const simulationEffect = await waitForSurfaceEffect(
    session,
    recapture.context.surfaceSessionId,
  );
  expect(simulationEffect.command.kind).toBe("simulate_workcell");
  const runningSimulation = await readConversation(fixtureDatabase(), scope, playbackChat);
  const simulationWork = runningSimulation?.conversation.work;
  if (simulationWork?.kind !== "running")
    throw new Error("Simulation is not running");
  const cancellationRequest = new Request(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat/cancel`,
    {
      method: "POST",
      headers: {
        origin: "https://localhost",
        "content-type": "application/json",
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
      },
      body: JSON.stringify({
        conversationId: playbackChat,
        requestId: simulationRequest,
        sessionId: simulationWork.stream.sessionId,
        turnId: simulationWork.stream.turnId,
        cancellationId: "cancel_simulation",
      }),
    },
  );
  await expect
    .poll(attemptCancellation.bind(null, cancellationRequest), {
      timeout: 10_000,
    })
    .toBe("cancelled");
  await expect
    .poll(
      readSurfaceEffect.bind(null, session, recapture.context.surfaceSessionId),
      { timeout: 10_000 },
    )
    .toBeNull();
  expect(model.calls).toBe(16 + model.discoveries.length);

  const savedRun = await prepareRehearsalRunWorkspace(
    "Governed saved rehearsal",
    preparedWorkspace.production.data.plan,
  );
  await runEndpoint(
    session,
    `/v1/control/organisations/${ORGANISATION_ID}/bakery/runs`,
    {
      expectedId: savedRun.id,
      name: savedRun.snapshot.name,
      document: JSON.parse(savedRun.snapshot.file),
    },
  );
  expect(
    (
      await send(session, {
        ...command(
          "request_open_saved_run",
          "Inspect the last save, list saved rehearsals, then review the saved copy.",
        ),
        conversationId: playbackChat,
        surfaceContext: recapture,
      })
    ).status,
  ).toBe(200);
  const saving = applyBakeryWorkspaceAction(
    {
      kind: "workspaceRunSaveStarted",
      runKind: "rehearsal",
      organisationId: ORGANISATION_ID,
      requestId: "uncertain-save",
      id: savedRun.id,
      name: savedRun.snapshot.name,
      agentEffectId: null,
    },
    preparedWorkcell.state,
  );
  const uncertain = applyBakeryWorkspaceAction(
    {
      kind: "workspaceRunSaveSettled",
      runKind: "rehearsal",
      organisationId: ORGANISATION_ID,
      requestId: "uncertain-save",
      outcome: {
        kind: "outcome-unknown",
        id: savedRun.id,
        message: "The save acknowledgement was lost.",
      },
    },
    saving,
  );
  const inspectionEffect = await waitForSurfaceEffect(
    session,
    recapture.context.surfaceSessionId,
  );
  const inspection = await prepareBakerySurfaceCommand(
    uncertain,
    inspectionEffect.command,
    sha256Hex,
    {
      organisationId: ORGANISATION_ID,
      read: readRunEndpoint.bind(null, session),
      readDefinition: unavailableDefinition,
      readScenario: unavailableDefinition,
      readAttachment: unavailableFile,
    },
  );
  if (inspection.kind !== "save_inspection")
    throw new Error("Save inspection was not prepared");
  const inspectedSave = await bakerySurfaceCommandSucceeded(
    uncertain,
    inspection,
  );
  if (inspectedSave.command !== "inspect_run_save")
    throw new Error("Missing inspection result");
  expect(inspectedSave.output.save).toMatchObject({
    kind: "outcome-unknown",
    readback: "verified",
    reference: { id: savedRun.id, origin: "operator" },
  });
  expect(uncertain.workspace.runSaves.rehearsal.kind).toBe("outcome-unknown");
  const wrongKind = await createBakerySurfaceReceipt(inspectionEffect, {
    kind: "completed",
    result: {
      ...inspectedSave,
      output: { ...inspectedSave.output, runKind: "production" },
    },
  });
  expect((await postSurfaceReceipt(session, wrongKind)).status).toBe(409);
  const inspectionReceipt = await createBakerySurfaceReceipt(inspectionEffect, {
    kind: "completed",
    result: inspectedSave,
  });
  expect((await postSurfaceReceipt(session, inspectionReceipt)).status).toBe(
    200,
  );
  expect((await postSurfaceReceipt(session, inspectionReceipt)).status).toBe(
    200,
  );
  const listingEffect = await waitForSurfaceEffect(
    session,
    recapture.context.surfaceSessionId,
  );
  expect(listingEffect.command.kind).toBe("list_saved_runs");
  const listing = await prepareBakerySurfaceCommand(
    preparedWorkcell.state,
    listingEffect.command,
    sha256Hex,
    {
      organisationId: ORGANISATION_ID,
      read: readRunEndpoint.bind(null, session),
      readDefinition: unavailableDefinition,
      readScenario: unavailableDefinition,
      readAttachment: unavailableFile,
    },
  );
  if (listing.kind !== "saved_runs")
    throw new Error("Saved runs were not listed");
  const listed = await bakerySurfaceCommandSucceeded(
    preparedWorkcell.state,
    listing,
  );
  if (listed.command !== "list_saved_runs")
    throw new Error("Missing list result");
  expect(listed.output.page.snapshots).toMatchObject([
    { id: savedRun.id, kind: "rehearsal" },
  ]);
  expect(listed.surface.context.active).toEqual(recapture.context.active);
  expect(listed.surface.context.surfaceEpoch).toBe(
    recapture.context.surfaceEpoch,
  );
  const observed = listed.output.page.snapshots[0];
  if (observed === undefined)
    throw new Error("Saved copy was absent from the catalogue");
  model.savedRunId = observed.id;
  const wrongPage = await createBakerySurfaceReceipt(listingEffect, {
    kind: "completed",
    result: {
      ...listed,
      output: { ...listed.output, cursor: "unrequested-page" },
    },
  });
  expect((await postSurfaceReceipt(session, wrongPage)).status).toBe(409);
  const listingReceipt = await createBakerySurfaceReceipt(listingEffect, {
    kind: "completed",
    result: listed,
  });
  expect((await postSurfaceReceipt(session, listingReceipt)).status).toBe(200);
  expect((await postSurfaceReceipt(session, listingReceipt)).status).toBe(200);
  const openEffect = await waitForSurfaceEffect(
    session,
    recapture.context.surfaceSessionId,
  );
  expect(openEffect.command.kind).toBe("prepare_run_open");
  const open = await prepareBakerySurfaceCommand(
    preparedWorkcell.state,
    openEffect.command,
    sha256Hex,
    {
      organisationId: ORGANISATION_ID,
      read: readRunEndpoint.bind(null, session),
      readDefinition: unavailableDefinition,
      readScenario: unavailableDefinition,
      readAttachment: unavailableFile,
    },
  );
  if (open.kind !== "run_open")
    throw new Error(`Saved run was not prepared: ${JSON.stringify(open)}`);
  const opened = commitBakerySurfaceCommand(preparedWorkcell.state, open, {
    kind: "agent_effect",
    effectId: openEffect.effectId,
  });
  if (opened.kind !== "applied")
    throw new Error("Saved-run review did not open");
  const openResult = await bakerySurfaceCommandSucceeded(opened.state, open);
  if (openResult.kind !== "succeeded")
    throw new Error("Missing saved-run review receipt");
  expect(openResult.surface.context.runOpenReview).toMatchObject({
    id: savedRun.id,
    runKind: "rehearsal",
  });
  const missingReview = await createBakerySurfaceReceipt(openEffect, {
    kind: "completed",
    result: {
      ...openResult,
      surface: await createBakerySurfaceAttachment({
        ...openResult.surface.context,
        runOpenReview: null,
      }),
    },
  });
  expect((await postSurfaceReceipt(session, missingReview)).status).toBe(409);
  const openReceipt = await createBakerySurfaceReceipt(openEffect, {
    kind: "completed",
    result: openResult,
  });
  expect((await postSurfaceReceipt(session, openReceipt)).status).toBe(200);
  expect((await postSurfaceReceipt(session, openReceipt)).status).toBe(200);
  const confirmed = applyBakeryWorkspaceAction(
    {
      kind: "workspaceRunOpenResolved",
      review: open.review,
      decision: "apply",
    },
    opened.state,
  );
  expect((await captureBakerySurface(confirmed)).context).toMatchObject({
    runOpenReview: null,
    active: { planFingerprint: open.review.plan.fingerprint },
  });
  await expect
    .poll(readConversation.bind(null, fixtureDatabase(), scope, playbackChat))
    .toMatchObject({ conversation: { work: { kind: "ready" } } });
  expect(model.calls).toBe(20 + model.discoveries.length);

  expect(
    (await send(session, command("request_long_revoked", "One more response.")))
      .status,
  ).toBe(200);
  await expect
    .poll(modelPhase.bind(null, model), { timeout: 20000 })
    .toBe("revoked");
  await env.DB.prepare(
    "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
  )
    .bind(Date.now(), session.session.controlSessionId)
    .run();
  model.releaseRevoked.resolve();
  await expect
    .poll(readConversation.bind(null, fixtureDatabase(), scope, CONVERSATION_ID), {
      timeout: 15_000,
    })
    .toMatchObject({ conversation: { work: { kind: "failed" } } });
  const revoked = await readConversation(fixtureDatabase(), scope, CONVERSATION_ID);
  expect(
    (revoked ? timelineVisibleMessages(revoked.conversation) : undefined)
      ?.filter(isAssistant)
      .map(messageText),
  ).toEqual([LONG_TEXT, FOLLOWUP_TEXT]);
  expect((await send(session, null)).status).toBe(401);
  expect(model.calls).toBe(21 + model.discoveries.length);
  Object.assign(task.meta, {
    disconnectedTurnAcceptance: {
      disconnectedTurnDurationMs,
      preservedResponseBytes: new TextEncoder().encode(LONG_TEXT).byteLength,
      recoveredAfterCaseEviction: true,
      queuedFollowupDeliveredOnce: true,
      duplicateInference: false,
      projectionCapacityDownloadRetained: true,
      terminalReplayRetained: true,
      retainedAssistantMessages: 2,
      revokedResponsePublished: false,
      revokedControlSessionStatus: 401,
    },
  });
}

const reportedSurfaces = new Map<
  string,
  Readonly<{ surface: BakerySurfaceAttachmentV1; conversationId: string }>
>();

async function waitForSurfaceEffect(
  session: IssuedControlSession,
  surfaceSessionId: string,
): Promise<ExecutableBakerySurfaceEffectV1> {
  await expect
    .poll(readSurfaceEffect.bind(null, session, surfaceSessionId), {
      timeout: 10_000,
    })
    .not.toBeNull();
  const effect = await readSurfaceEffect(session, surfaceSessionId);
  if (effect === null) throw new Error("Missing dispatched effect");
  return effect;
}

async function readSurfaceEffect(
  session: IssuedControlSession,
  surfaceSessionId: string,
): Promise<ExecutableBakerySurfaceEffectV1 | null> {
  const reported = reportedSurfaces.get(surfaceSessionId);
  if (reported === undefined)
    throw new Error("Missing reported browser surface");
  const bindingQuery = `browserInstanceId=browser_chat_acceptance&conversationId=${reported.conversationId}`;
  const response = await readChatEndpoint(
    session,
    `/surface-effects?${bindingQuery}`,
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("effects" in body) ||
    !Array.isArray(body.effects)
  )
    throw new Error("Invalid pending effects response");
  for (const raw of body.effects) {
    if (typeof raw !== "object" || raw === null || !("effect" in raw))
      throw new Error("Invalid pending effect entry");
    const parsed = parseBakerySurfaceEffect(raw.effect);
    if (parsed.kind !== "valid") continue;
    if (isExecutableBakerySurfaceEffect(parsed.value)) return parsed.value;
    if (
      reported === undefined ||
      parsed.value.command.kind !== "prepare_context"
    )
      throw new Error("Missing reported browser surface");
    const fresh = await createBakerySurfaceAttachment({
      ...reported.surface.context,
      capturedAt: Date.now(),
    });
    const receipt = await createBakerySurfaceReceipt(parsed.value, {
      kind: "prepared",
      binding: parsed.value.command.binding,
      surface: fresh,
    });
    expect((await postSurfaceReceipt(session, receipt)).status).toBe(200);
  }
  return null;
}

function postSurfaceReceipt(
  session: IssuedControlSession,
  receipt: BakerySurfaceReceiptV1,
): Promise<Response> {
  return exports.default.fetch(
    new Request(
      `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat/surface-effects/${receipt.effectId}/receipt`,
      {
        method: "POST",
        headers: {
          origin: "https://localhost",
          "content-type": "application/json",
          cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
          "x-satyr-csrf": session.csrfToken,
        },
        body: JSON.stringify({ receipt }),
      },
    ),
  );
}

async function readObservedProgress(
  response: Response,
  observed: PromiseWithResolvers<void>,
): Promise<string> {
  if (response.body === null) throw new Error("Missing observer stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      text += decoder.decode();
      return text;
    }
    text += decoder.decode(chunk.value, { stream: true });
    if (text.includes('"label":"Using bakery_surface_inspect."'))
      observed.resolve();
  }
}

function parseRecord(text: string): {
  kind: string;
  sequence: number;
  text?: string;
  label?: string;
} {
  return JSON.parse(text);
}
function isToolProgress(record: { kind: string; label?: string }): boolean {
  return (
    record.kind === "progress" && record.label?.startsWith("Using ") === true
  );
}
function isDelta(record: { kind: string }): boolean {
  return record.kind === "assistant_text_delta";
}
function messageDelta(record: { text?: string }): string {
  return record.text ?? "";
}
function readWake(_actor: unknown, state: DurableObjectState): string | null {
  return (
    state.storage.sql
      .exec<{ wake_id: string }>(
        "SELECT wake_id FROM portal_conversation_execution",
      )
      .toArray()[0]?.wake_id ?? null
  );
}
function readChatEndpoint(
  session: IssuedControlSession,
  suffix: string,
): Promise<Response> {
  return exports.default.fetch(
    new Request(
      `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat${suffix}`,
      { headers: { cookie: `satyr_control_session=${session.token}` } },
    ),
  );
}

async function verifyHistoricalSurfaceHistory(
  scope: ConversationScope,
  session: IssuedControlSession,
): Promise<void> {
  const row = await fixtureDatabase().prepare(
    "SELECT state_json FROM portal_conversation WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?",
  )
    .bind(scope.organisationId, scope.userId, CONVERSATION_ID)
    .first<{ state_json: string }>();
  if (row === null) throw new Error("Missing admitted conversation");
  const raw: unknown = JSON.parse(row.state_json);
  if (!isRecord(raw)) throw new Error("Invalid stored conversation");
  const surface = {
    kind: "bakery-surface-context",
    digest: "a".repeat(64),
    context: {
      schemaVersion: 1,
      kind: "bakery-workspace",
      surfaceSessionId: "historical-session",
      surfaceEpoch: 3,
      capturedAt: 1,
      supportedCommands: ["prepare_run_save"],
      active: {
        kind: "rehearsal",
        rehearsalKind: "standalone",
        readiness: "ready",
        runSaveProposal: null,
      },
    },
  };
  const snapshot = {
    ...raw,
    id: newConversationId(),
    title: "Historical rehearsal",
    work: { kind: "ready" },
    completedRequests: [],
    pendingInputs: [],
    messages: [
      {
        kind: "user",
        id: "historical_user",
        text: "Inspect my rehearsal.",
        surfaceContext: surface,
      },
    ],
    timeline: [
      {
        kind: "user",
        eventId: "historical_user",
        sequence: 1,
        requestId: "request_historical",
        createdAt: 1,
        text: "Inspect my rehearsal.",
        parts: [
          { kind: "text", text: "Inspect my rehearsal." },
          { kind: "surface", surface },
        ],
      },
    ],
    latestSequence: 1,
    lastReadSequence: 0,
  };
  const actorIdentity = `${scope.organisationId}:portal-chat:${scope.userId}:${snapshot.id}`;
  const caseId = await conversationCaseId(actorIdentity);
  await fixtureDatabase().batch([
    fixtureDatabase().prepare(
      "INSERT INTO case_project (organisation_id, case_id, project_id, revision, updated_at) SELECT organisation_id, ?, project_id, 1, 1 FROM organisation_default_project WHERE organisation_id = ?",
    ).bind(caseId, scope.organisationId),
    fixtureDatabase().prepare(
      "INSERT INTO portal_conversation (organisation_id, user_id, conversation_id, case_id, revision, state_json, updated_at, last_activity_at, latest_sequence) VALUES (?, ?, ?, ?, 1, json_set(?, '$.actorIdentity', ?), 1, 1, 1)",
    ).bind(
      scope.organisationId,
      scope.userId,
      snapshot.id,
      caseId,
      JSON.stringify(snapshot),
      actorIdentity,
    ),
  ]);
  const response = await readChatEndpoint(
    session,
    `?conversation=${snapshot.id}&observe=true`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    conversations: expect.arrayContaining([
      expect.objectContaining({ id: snapshot.id, title: snapshot.title }),
    ]),
    conversation: {
      timeline: [
        {
          kind: "user",
          text: "Inspect my rehearsal.",
        },
      ],
    },
  });
  const restored = await readConversation(fixtureDatabase(), scope, snapshot.id);
  expect(restored?.conversation.timeline).toMatchObject([
    {
      kind: "user",
      parts: [
        { kind: "text", text: "Inspect my rehearsal." },
        {
          kind: "text",
          text: expect.stringContaining(JSON.stringify(surface)),
        },
      ],
    },
  ]);
  expect(
    (
      await send(session, {
        ...command("request_stale_live", "Use old context."),
        surfaceContext: surface,
      })
    ).status,
  ).toBe(422);
  const retained = await fixtureDatabase().prepare(
    "SELECT state_json FROM portal_conversation WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?",
  )
    .bind(scope.organisationId, scope.userId, snapshot.id)
    .first<{ state_json: string }>();
  expect(retained?.state_json).toBe(
    JSON.stringify({
      ...snapshot,
      actorIdentity: `${scope.organisationId}:portal-chat:${scope.userId}:${snapshot.id}`,
    }),
  );
}

type Model = {
  savedRunId: string;
  calls: number;
  discoveries: string[];
  phase: "idle" | "root" | "second_step" | "revoked";
  releaseSecondStep: PromiseWithResolvers<void>;
  releaseRevoked: PromiseWithResolvers<void>;
};

function inspectSessionTurn(
  session: DurableObjectStub<SessionDO>,
  turnId: string,
) {
  return session.inspectTurnStream({ organisationId: ORGANISATION_ID, turnId });
}

function inspectCase(actor: DurableObjectStub<CaseDO>) {
  return actor.inspect();
}

function modelPhase(model: Model): Model["phase"] {
  return model.phase;
}

async function respond(
  model: Model,
  _request: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  model.calls += 1;
  switch (model.calls - model.discoveries.length) {
    case 1:
      model.phase = "root";
      await new Promise(resolveLongTurn);
      return openRouterText(
        JSON.stringify({ kind: "reply", text: LONG_TEXT }),
        "long_root",
      );
    case 2:
      return openRouterText(
        JSON.stringify({ kind: "reply", text: FOLLOWUP_TEXT }),
        "long_followup",
      );
    case 3:
      return openRouterText(
        JSON.stringify({ kind: "reply", text: LONG_TEXT }),
        "capacity_answer",
      );
    case 4:
      return openRouterText(
        JSON.stringify({ kind: "reply", text: null }),
        "invalid_first_step",
      );
    case 5:
      model.phase = "second_step";
      await model.releaseSecondStep.promise;
      return openRouterText(
        JSON.stringify({ kind: "reply", text: LONG_TEXT }),
        "corrected_second_step",
      );
    case 6:
      return discoverableToolCall(
        model,
        _request,
        "bakery_surface_control_playback",
        { action: { kind: "seek", seconds: 90 } },
        "playback_seek",
      );
    case 7:
      return openRouterText(
        JSON.stringify({
          kind: "reply",
          text: "Playback is at 90 seconds.",
        }),
        "playback_seek_done",
      );
    case 8:
      return discoverableToolCall(
        model,
        _request,
        "bakery_surface_control_playback",
        { action: { kind: "play" } },
        "playback_stale",
      );
    case 9:
      return openRouterText(
        JSON.stringify({
          kind: "reply",
          text: "The run changed; playback was not started.",
        }),
        "playback_stale_done",
      );
    case 10:
      return discoverableToolCall(
        model,
        _request,
        "bakery_surface_control_workspace_view",
        { action: { kind: "setDoorPreview", degrees: 110 } },
        "door_preview",
      );
    case 11:
      return openRouterText(
        JSON.stringify({
          kind: "reply",
          text: "Door preview is at 110 degrees.",
        }),
        "door_preview_done",
      );
    case 12:
      return discoverableToolCall(
        model,
        _request,
        "bakery_surface_control_workspace_view",
        { action: { kind: "setDoorPreview", degrees: null } },
        "door_restore",
      );
    case 13:
      return openRouterText(
        JSON.stringify({
          kind: "reply",
          text: "Recorded door pose restored.",
        }),
        "door_restore_done",
      );
    case 14:
      return discoverableToolCall(
        model,
        _request,
        "bakery_surface_prepare_workcell",
        { preparation: { source: "recording", dispatchSeconds: 45 } },
        "prepare_workcell",
      );
    case 15:
      return openRouterText(
        JSON.stringify({
          kind: "reply",
          text: "The oven-cycle workcell is prepared. It has not been simulated or saved.",
        }),
        "prepare_workcell_done",
      );
    case 16:
      return discoverableToolCall(
        model,
        _request,
        "bakery_surface_simulate_workcell",
        { mode: "oven-cycle" },
        "simulate_cancel",
      );
    case 17:
      return discoverableToolCall(
        model,
        _request,
        "bakery_surface_inspect_run_save",
        { runKind: "rehearsal" },
        "inspect_save",
      );
    case 18:
      return discoverableToolCall(
        model,
        _request,
        "bakery_surface_list_saved_runs",
        { runKind: "rehearsal", cursor: null },
        "list_saved_runs",
      );
    case 19:
      return discoverableToolCall(
        model,
        _request,
        "bakery_surface_prepare_run_open",
        { runKind: "rehearsal", id: model.savedRunId },
        "open_saved_run",
      );
    case 20:
      return openRouterText(
        JSON.stringify({
          kind: "reply",
          text: "Saved rehearsal prepared for operator review.",
        }),
        "open_saved_done",
      );
    case 21:
      model.phase = "revoked";
      await model.releaseRevoked.promise;
      return openRouterText(
        JSON.stringify({ kind: "reply", text: REVOKED_TEXT }),
        "long_revoked",
      );
    default:
      throw new Error("Model execution was duplicated");
  }
}

function resolveLongTurn(resolve: (value: void) => void): void {
  setTimeout(resolve, 34_000);
}
function isAssistant(message: { kind: string }): boolean {
  return message.kind === "assistant";
}
function messageText(message: { text: string }): string {
  return message.text;
}

function command(requestId: string, text: string) {
  return {
    kind: "message",
    conversationId: CONVERSATION_ID,
    requestId,
    model: PLATFORM_DEFAULT_PI_MODEL,
    text,
    surfaceContext: null,
  };
}

function send(
  session: IssuedControlSession,
  body: unknown | null,
): Promise<Response> {
  const query = body === null ? `?conversation=${CONVERSATION_ID}` : "";
  if (
    isRecord(body) &&
    isConversationId(body.conversationId) &&
    (body.kind === "message" || body.kind === "next" || body.kind === "steer")
  ) {
    const surface = body.surfaceContext;
    if (
      isRecord(surface) &&
      isRecord(surface.context) &&
      typeof surface.context.surfaceSessionId === "string"
    ) {
      const attachment = parseBakerySurfaceAttachment(surface);
      if (attachment.kind === "valid")
        reportedSurfaces.set(surface.context.surfaceSessionId, {
          surface: attachment.value,
          conversationId: body.conversationId,
        });
    }
    if (body.browserContext === undefined)
      body = {
        ...body,
        browserContext: {
          kind: "available",
          binding: {
            browserInstanceId: "browser_chat_acceptance",
            conversationId: body.conversationId,
          },
        },
      };
  }
  return exports.default.fetch(
    new Request(
      `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat${query}`,
      {
        method: body === null ? "GET" : "POST",
        headers: {
          origin: "https://localhost",
          "content-type": "application/json",
          cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
          "x-satyr-csrf": session.csrfToken,
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      },
    ),
  );
}

async function fixture(maxTokens = 64_000): Promise<{
  scope: ConversationScope;
  session: IssuedControlSession;
}> {
  await installSlackActorFixture();
  const identity = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!identity.ok) throw new Error(identity.error.code);
  const now = Date.now();
  await fixtureDatabase().batch([
    fixtureDatabase().prepare(
      "UPDATE workspace_ai_budget SET max_tokens = ?, previous_limits_json = json_set(previous_limits_json, '$.maxTokens', ?) WHERE organisation_id = ?",
    ).bind(maxTokens, maxTokens, ORGANISATION_ID),
    fixtureDatabase().prepare(
      "UPDATE service_role_grant SET role = 'admin' WHERE organisation_id = ? AND user_id = ?",
    ).bind(ORGANISATION_ID, SLACK_ACTOR_USER_ID),
    fixtureDatabase().prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_chat', activated_at = ? WHERE organisation_id = ?",
    ).bind(now, ORGANISATION_ID),
  ]);
  const grant = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: "grant_chat_admin",
    subject: { kind: "organisation_role", role: "admin" },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_chat",
    },
    now,
  });
  if (!grant.ok) throw new Error(grant.error.code);
  const savedReadGrant = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: "grant_chat_workspace_read",
    subject: { kind: "person", personId: "person_e2e-slack-actor" },
    target: {
      kind: "platform_capability",
      capabilityId: "workspace.query",
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_chat",
    },
    now,
  });
  if (!savedReadGrant.ok) throw new Error(savedReadGrant.error.code);
  const workspacePolicy = await writeOrganisationCapabilityPolicy({
    scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    write: {
      kind: "change",

      capabilityId: "workspace.query",
      expectedRevision: 1,
      mode: "enabled",
      provenance: {
        kind: "operator",
        userId: identity.value,
        mutationReceiptId: "receipt_chat_workspace_query",
      },
      now,
    },
  });
  if (!workspacePolicy.ok) throw new Error(workspacePolicy.error.code);
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
  const session = await issueControlSession({
    db: env.DB,
    userId: identity.value,
    now,
    ttlMs: 1_800_000,
  });
  return {
    scope: { organisationId: ORGANISATION_ID, userId: identity.value },
    session,
  };
}

async function runEndpoint(
  session: IssuedControlSession,
  path: string,
  body: unknown,
): Promise<unknown> {
  return responseJson(await requestEndpoint(session, path, body));
}

function requestEndpoint(
  session: IssuedControlSession,
  path: string,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    method: "POST",
    headers: {
      origin: "https://localhost",
      "content-type": "application/json",
      cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
      "x-satyr-csrf": session.csrfToken,
    },
    body: JSON.stringify(body),
  });
}
async function readRunEndpoint(
  session: IssuedControlSession,
  path: string,
): Promise<unknown> {
  const response = await exports.default.fetch(`https://localhost${path}`, {
    headers: { cookie: `satyr_control_session=${session.token}` },
  });
  return responseJson(response);
}
async function unavailableDefinition(): Promise<never> {
  throw new Error("Rehearsal snapshots have no production definition");
}

function unavailableFile(): never {
  throw new Error("No attached file in this journey");
}

async function discoverableToolCall(
  model: Pick<Model, "discoveries">,
  request: Parameters<HttpResponseResolver>[0],
  name: string,
  args: Readonly<Record<string, unknown>>,
  callId: string,
): Promise<Response> {
  const body: unknown = await request.request.json();
  if (!isRecord(body) || !Array.isArray(body.tools))
    throw new Error("The model request omitted its tool catalogue.");
  for (const tool of body.tools)
    if (
      isRecord(tool) &&
      isRecord(tool.function) &&
      tool.function.name === name
    )
      return openRouterToolCall(name, args, callId);
  model.discoveries.push(name);
  return openRouterToolCall(
    "tool_search",
    { query: name, limit: 1 },
    `${callId}_discover`,
  );
}

const PROJECT_BAKERY_BRIEF =
  "BAKERY_INHERITANCE: cold tray capacity is six. Do not infer physical execution.";
const PROJECT_AUTUMN_BRIEF =
  "AUTUMN_INHERITANCE: prepare the seasonal launch with a vegetarian menu.";
async function projectContextMutation(
  session: IssuedControlSession,
  commandValue: unknown,
): Promise<void> {
  const result = await runEndpoint(
    session,
    `/v1/control/organisations/${ORGANISATION_ID}/projects`,
    commandValue,
  );
  expect(result).toMatchObject({ kind: "accepted" });
}
async function prepareProjectContextJourney(
  session: IssuedControlSession,
  scope: ConversationScope,
  conversationId: string,
  savedRunId: string,
): Promise<void> {
  for (const id of [
    "project_27797abb-e120-5e65-8935-80cc9f4e4149",
    "project_00000000-0000-4000-8000-000000000042",
  ]) {
    await projectContextMutation(session, {
      kind: "create_project",
      projectId: id,
      operationId: `create_${id}`,
      content: {
        name:
          id === "project_27797abb-e120-5e65-8935-80cc9f4e4149"
            ? "Bakery capacity"
            : "Autumn menu launch",
        brief:
          id === "project_27797abb-e120-5e65-8935-80cc9f4e4149"
            ? PROJECT_BAKERY_BRIEF
            : "AUTUMN_OLD: superseded before the next admission.",
        references: [
          { kind: "bakery_run", id: savedRunId, label: "Shared saved run" },
        ],
      },
    });
  }
  await runEndpoint(
    session,
    `/v1/control/organisations/${ORGANISATION_ID}/chat/projects/chats`,
    {
      projectId: "project_27797abb-e120-5e65-8935-80cc9f4e4149",
      conversationId,
    },
  );
}
async function moveProjectContextChat(
  session: IssuedControlSession,
  scope: ConversationScope,
  conversationId: string,
  projectId: string | null,
): Promise<Response> {
  const directory = await readProjectDirectory(fixtureDatabase(), scope);
  const stored = await readConversation(fixtureDatabase(), scope, conversationId);
  if (stored === null) throw new Error("Missing project chat");
  return requestEndpoint(
    session,
    `/v1/control/organisations/${ORGANISATION_ID}/chat/projects`,
    {
      kind: "move_chat",
      conversationId,
      operationId: crypto.randomUUID(),
      expectedDirectoryRevision: directory.revision,
      expectedMembershipRevision: stored.placement.membershipRevision,
      // Null returns the chat to the Organisation's default Project.
      destination: {
        projectId:
          projectId ?? (await requireDefaultProjectId(fixtureDatabase(), ORGANISATION_ID)),
      },
      insertion: { kind: "end" },
    },
  );
}
async function editAutumnProjectDuringTurn(
  session: IssuedControlSession,
  scope: ConversationScope,
  savedRunId: string,
): Promise<void> {
  const directory = await readProjectDirectory(fixtureDatabase(), scope);
  const project = directory.projects.find(
    projectContextHasId.bind(
      null,
      "project_00000000-0000-4000-8000-000000000042",
    ),
  );
  if (project === undefined) throw new Error("Missing autumn project");
  await projectContextMutation(session, {
    kind: "edit_project",
    projectId: project.id,
    operationId: "edit_autumn",
    expectedProjectRevision: project.revision,
    content: {
      name: project.name,
      brief: PROJECT_AUTUMN_BRIEF,
      references: [
        { kind: "bakery_run", id: savedRunId, label: "Shared saved run" },
      ],
    },
  });
}
function projectContextHasId(id: string, project: { id: string }): boolean {
  return project.id === id;
}
type ProjectProviderEvidence = {
  prompts: string[];
  compactionRequests: string[];
  highUsageResponses: number;
  pause:
    | { kind: "idle" }
    | { kind: "waiting"; gate: ReturnType<typeof Promise.withResolvers<void>> };
};
async function projectPiReply(
  evidence: ProjectProviderEvidence,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid project model request");
  const prompt = JSON.stringify(body);
  if (prompt.includes("You are a context summarization assistant")) {
    evidence.compactionRequests.push(prompt);
    return openRouterText(
      projectCompactionSummary(prompt),
      "project_compaction_summary",
    );
  }
  evidence.prompts.push(prompt);
  await pauseForkSource(evidence, prompt);
  const inputTokens = evidence.highUsageResponses === 0 ? 245_000 : 10;
  if (inputTokens === 245_000) evidence.highUsageResponses += 1;
  const text =
    inputTokens === 245_000
      ? "The saved-run finding remains accepted for this chat. " +
        "Accepted batch evidence. ".repeat(5_000)
      : "The saved-run finding remains accepted for this chat.";
  const id = `project_reply_${evidence.prompts.length}`;
  return openRouterStream([
    {
      id,
      object: "chat.completion.chunk",
      created: 1_787_500_000,
      model: PLATFORM_DEFAULT_PI_MODEL,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: JSON.stringify({
              kind: "reply",
              text,
            }),
          },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 1_787_500_000,
      model: PLATFORM_DEFAULT_PI_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: 10,
        total_tokens: inputTokens + 10,
      },
    },
  ]);
}
function projectCompactionSummary(prompt: string): string {
  const facts = [
    "The accepted saved-run finding remains historical context. Source workspace actions have settled.",
  ];
  for (const marker of [
    "RETAINED_FORK_BRIEF: proofing capacity is twelve trays.",
    "bakery_saved_run_read",
    "bakery_surface_control_workspace_view",
    "fork_alternative",
  ]) {
    if (prompt.includes(marker)) facts.push(marker);
  }
  return facts.join("\n");
}
async function finishProjectContextJourney(input: {
  session: IssuedControlSession;
  scope: ConversationScope;
  conversationId: string;
  savedRunId: string;
  route: "pi";
  model: { requests: unknown[] };
  actor: DurableObjectStub<SessionDO>;
  acceptedProject: ProjectSnapshot;
}): Promise<
  Readonly<{
    bindings: readonly ProjectSnapshot[];
    transitions: readonly string[];
    recoveredAcceptedBinding: true;
    supersededInheritanceAbsent: true;
    failedCleanupRetried: true;
    forkEvidence: Readonly<{
      sourceId: string;
      cutoffId: string;
      destinationId: string;
      nestedId: string;
      digest: string;
      restoredAttachmentHistoryDigest: string;
      sourceCheckpoint: SourceCheckpointEvidence;
    }>;
  }>
> {
  expect(
    (
      await moveProjectContextChat(
        input.session,
        input.scope,
        input.conversationId,
        "project_00000000-0000-4000-8000-000000000042",
      )
    ).status,
  ).toBe(200);
  const originalPrompts = JSON.stringify(input.model.requests);
  expect(originalPrompts).toContain(PROJECT_BAKERY_BRIEF);
  expect(originalPrompts).not.toContain(PROJECT_AUTUMN_BRIEF);
  await evictDurableObject(input.actor);
  const restoredContext = await runInDurableObject(
    input.actor,
    readProjectJournal,
  );
  expect(restoredContext).toContain(input.acceptedProject.digest);
  expect(restoredContext).toContain(PROJECT_BAKERY_BRIEF);
  await env.ARCHIVE.delete(
    bakeryRunSnapshotPrefix(ORGANISATION_ID) + input.savedRunId,
  );
  const evidence: ProjectProviderEvidence = {
    prompts: [],
    compactionRequests: [],
    highUsageResponses: 0,
    pause: { kind: "idle" },
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      projectPiReply.bind(null, evidence),
    ),
  );
  expect(
    (
      await send(input.session, {
        ...command(
          "project_autumn_request",
          "Keep the saved-run finding. Use the current project brief.",
        ),
        model: PLATFORM_DEFAULT_PI_MODEL,
        conversationId: input.conversationId,
      })
    ).status,
  ).toBe(200);
  await expect
    .poll(
      readAutomaticContextCompletion.bind(
        null,
        input.session,
        input.conversationId,
      ),
      { timeout: 15_000 },
    )
    .toBe("ready");
  const autumn = await readConversation(
    fixtureDatabase(),
    input.scope,
    input.conversationId,
  );
  if (autumn === null) throw new Error("Missing autumn chat");
  const autumnBinding = currentProjectSnapshot(autumn.conversation);
  if (autumnBinding === null) throw new Error("Missing autumn binding");
  expect(autumnBinding.layer).toMatchObject({
    kind: "project",
    contentRevision: 3,
    brief: PROJECT_AUTUMN_BRIEF,
    references: [
      { kind: "unavailable" },
      { kind: "available", reference: { kind: "case_entry" } },
    ],
  });
  expect(evidence.prompts.join("\n")).toContain(PROJECT_AUTUMN_BRIEF);
  expect(evidence.prompts.join("\n")).not.toContain(PROJECT_BAKERY_BRIEF);
  expect(evidence.prompts.join("\n")).not.toContain("AUTUMN_OLD");
  const ungroupedMove = await moveProjectContextChat(
    input.session,
    input.scope,
    input.conversationId,
    null,
  );
  expect(ungroupedMove.status).toBe(200);
  evidence.prompts.length = 0;
  expect(
    (
      await send(input.session, {
        ...command(
          "project_ungrouped_request",
          "Keep the accepted saved-run finding; finish this task.",
        ),
        model: PLATFORM_DEFAULT_PI_MODEL,
        conversationId: input.conversationId,
      })
    ).status,
  ).toBe(200);
  await expect
    .poll(
      readAutomaticContextCompletion.bind(
        null,
        input.session,
        input.conversationId,
      ),
      { timeout: 15_000 },
    )
    .toBe("ready");
  expect(evidence.prompts.join("\n")).not.toContain(PROJECT_BAKERY_BRIEF);
  expect(evidence.prompts.join("\n")).not.toContain(PROJECT_AUTUMN_BRIEF);
  expect(evidence.prompts.join("\n")).toContain("saved-run finding");
  const ungrouped = await readConversation(
    fixtureDatabase(),
    input.scope,
    input.conversationId,
  );
  if (ungrouped === null) throw new Error("Missing ungrouped chat");
  const ungroupedBinding = currentProjectSnapshot(ungrouped.conversation);
  if (
    ungroupedBinding === null ||
    ungroupedBinding.layer.projectId !==
      (await requireDefaultProjectId(fixtureDatabase(), ORGANISATION_ID))
  )
    throw new Error("Missing default Project binding");
  const transitions: string[] = [];
  for (const event of ungrouped.conversation.timeline)
    if (
      event.kind === "activity" &&
      event.eventId.startsWith("project_context_")
    )
      transitions.push(event.text);
  const forkEvidence = await proveThreadForking(input, evidence);
  await verifyProjectChatDeletion(
    input.session,
    input.scope,
    input.conversationId,
    input.actor,
  );
  expect(
    await readConversation(fixtureDatabase(), input.scope, forkEvidence.destinationId),
  ).toBeNull();
  expect(
    await readConversation(fixtureDatabase(), input.scope, forkEvidence.nestedId),
  ).toBeNull();
  expect(
    await fixtureDatabase().prepare(
      "SELECT COUNT(*) AS count FROM portal_chat_fork WHERE organisation_id = ? AND history_json IS NOT NULL",
    )
      .bind(ORGANISATION_ID)
      .first("count"),
  ).toBe(0);
  return {
    bindings: [input.acceptedProject, autumnBinding, ungroupedBinding],
    transitions,
    recoveredAcceptedBinding: true,
    supersededInheritanceAbsent: true,
    failedCleanupRetried: true,
    forkEvidence,
  };
}
async function verifyLegacyProjectRestore(actor: DurableObjectStub<SessionDO>) {
  const retained = await runInDurableObject(actor, stageLegacyProjectContext);
  const denied = await actor.resolveCanonicalEmbeddedHarnessInput({
    requestingOrganisationId: ORGANISATION_ID,
    lease: retained.lease,
    turnPrompt: retained.turnPrompt,
  });
  await runInDurableObject(
    actor,
    restoreProjectJournal.bind(null, retained.turnId, retained.originalBundle),
  );
  expect(denied).toEqual({
    ok: false,
    error: { code: "project_evidence_unavailable" },
  });
  const restored = await runInDurableObject(
    actor,
    resolveOriginalProjectContext.bind(null, retained),
  );
  expect(restored).toBe(true);
  return {
    unavailableCode: denied.ok ? null : denied.error.code,
    originalJournalDigest: await sha256Hex(retained.originalBundle),
    originalEvidenceRestored: restored,
  };
}

async function resolveOriginalProjectContext(
  retained: ReturnType<typeof stageLegacyProjectContext>,
  actor: unknown,
): Promise<boolean> {
  if (!(actor instanceof SessionDO)) throw new Error("Expected SessionDO");
  const restored = await actor.resolveCanonicalEmbeddedHarnessInput({
    requestingOrganisationId: ORGANISATION_ID,
    lease: retained.lease,
    turnPrompt: retained.turnPrompt,
  });
  return restored.ok;
}

function stageLegacyProjectContext(_actor: unknown, state: DurableObjectState) {
  const leaseRow = state.storage.sql.exec<{lease_projection: string}>("SELECT lease_projection FROM session_harness_lease LIMIT 1").toArray()[0];
  const continuationRow = state.storage.sql.exec<{request_envelope: string}>("SELECT request_envelope FROM session_turn_continuation").toArray()[0];
  const lease = leaseRow === undefined ? null : parsePersistedHarnessTurnLease(JSON.parse(leaseRow.lease_projection));
  const continuation = continuationRow === undefined ? null : parseContinuation(JSON.parse(continuationRow.request_envelope));
  if (lease === null || continuation === null) throw new Error("Admitted turn missing");
  const pending = {lease, continuation};
  const row = state.storage.sql
    .exec<{ bundle_json: string }>(
      "SELECT bundle_json FROM session_turn_context WHERE turn_id = ?",
      pending.lease.turn.turnId,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("Retained project journal missing");
  // This persistence fixture represents populated history predating labelled admission.
  state.storage.sql.exec(
    "UPDATE session_turn_context SET bundle_json = json_remove(bundle_json, '$.projectContext.layer.admission') WHERE turn_id = ?",
    pending.lease.turn.turnId,
  );
  return {
    originalBundle: row.bundle_json,
    lease: pending.lease,
    turnId: pending.lease.turn.turnId,
    turnPrompt: pending.continuation.turnPrompt,
  };
}

function restoreProjectJournal(
  turnId: string,
  originalBundle: string,
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    "UPDATE session_turn_context SET bundle_json = ? WHERE turn_id = ?",
    originalBundle,
    turnId,
  );
}

function readProjectJournal(
  _actor: unknown,
  state: DurableObjectState,
): string {
  return JSON.stringify([
    ...state.storage.sql.exec("SELECT bundle_json FROM session_turn_context"),
  ]);
}

type ProjectSessionErasureFault = {
  original: PropertyDescriptor | null;
};

function denyProjectSessionErasure(
  fault: ProjectSessionErasureFault,
  actor: object,
): void {
  const archive = Reflect.get(Reflect.get(actor, "env"), "ARCHIVE");
  if (!isRecord(archive) || typeof archive.delete !== "function")
    throw new Error("Missing project archive");
  fault.original = { configurable: true, value: archive.delete };
  Object.defineProperty(archive, "delete", {
    configurable: true,
    value: failProjectSessionObjectDeletion,
  });
}

function failProjectSessionObjectDeletion(): never {
  throw new Error("P54B project object deletion interrupted");
}

function allowProjectSessionErasure(
  fault: ProjectSessionErasureFault,
  actor: object,
): void {
  if (fault.original === null) throw new Error("Missing project erasure fault");
  const archive = Reflect.get(Reflect.get(actor, "env"), "ARCHIVE");
  Object.defineProperty(archive, "delete", fault.original);
  fault.original = null;
}
async function projectChatMetadata(
  session: IssuedControlSession,
  conversationId: string,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat/conversations/${conversationId}`,
    {
      method: "PATCH",
      headers: {
        origin: "https://localhost",
        "content-type": "application/json",
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
      },
      body: JSON.stringify(body),
    },
  );
}
async function verifyProjectChatDeletion(
  session: IssuedControlSession,
  scope: ConversationScope,
  conversationId: string,
  actor: DurableObjectStub<SessionDO>,
): Promise<void> {
  const stored = await readConversation(fixtureDatabase(), scope, conversationId);
  if (stored === null) throw new Error("Missing deletable chat");
  const identities = await deriveDirectCaseIdentities(
    `${ORGANISATION_ID}:portal-chat:${scope.userId}:${conversationId}`,
  );
  if (!identities.ok) throw new Error(identities.error.code);
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: ORGANISATION_ID,
    caseId: identities.value.caseId,
    now: Date.now(),
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  const sharedEvidence = await caseActor.value.inspect();
  if (!sharedEvidence.ok) throw new Error(sharedEvidence.error.code);
  expect(sharedEvidence.value.entries.length).toBeGreaterThan(0);
  await env.ARCHIVE.put(
    "plan52-shared-business-evidence",
    "Shared record retains its own owner.",
  );
  expect(
    (
      await projectChatMetadata(session, conversationId, {
        action: "archive",
        expectedRevision: stored.revision,
      })
    ).status,
  ).toBe(200);
  const erasureFault: ProjectSessionErasureFault = { original: null };
  await runInDurableObject(
    actor,
    denyProjectSessionErasure.bind(null, erasureFault),
  );
  const deletion = {
    action: "delete",
    operationId: "delete_project_context",
    expectedRevision: stored.revision,
  };
  try {
    expect(
      (await projectChatMetadata(session, conversationId, deletion)).status,
    ).toBe(503);
    const pending = await readChatEndpoint(session, "");
    expect(await pending.json()).toMatchObject({
      pendingDeletions: expect.arrayContaining([
        expect.objectContaining({
          conversationId,
          operationId: deletion.operationId,
          kind: "failed",
        }),
      ]),
    });
    expect(
      await fixtureDatabase().prepare(
        "SELECT status FROM portal_chat_deletion WHERE conversation_id = ?",
      )
        .bind(conversationId)
        .first("status"),
    ).toBe("failed");
  } finally {
    await runInDurableObject(
      actor,
      allowProjectSessionErasure.bind(null, erasureFault),
    );
  }
  expect(
    (await projectChatMetadata(session, conversationId, deletion)).status,
  ).toBe(200);
  expect(
    (await projectChatMetadata(session, conversationId, deletion)).status,
  ).toBe(200);
  expect(await readConversation(fixtureDatabase(), scope, conversationId)).toBeNull();
  const settled = await readChatEndpoint(session, "");
  expect(await settled.json()).toMatchObject({ pendingDeletions: [] });
  const privateState = await runInDurableObject(
    actor,
    readDeletedProjectSession,
  );
  expect(privateState).toEqual({
    keys: ["portal-chat-erasure"],
    retainedRows: 0,
  });
  expect(await caseActor.value.inspect()).toMatchObject({
    ok: true,
    value: { entries: sharedEvidence.value.entries },
  });
  expect(
    await env.ARCHIVE.head("plan52-shared-business-evidence"),
  ).not.toBeNull();
  expect(
    (
      await projectChatMetadata(session, conversationId, {
        action: "restore",
        expectedRevision: stored.revision,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await saveConversation(
        await requireOrganisationExecutionScope(env, scope.organisationId),
        scope.userId,
        stored.conversation,
        0,
      )
    ).kind,
  ).toBe("conflict");
}
async function readDeletedProjectSession(
  _actor: unknown,
  state: DurableObjectState,
): Promise<{ keys: string[]; retainedRows: number }> {
  const tables = state.storage.sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'
       AND name NOT IN ('state_object_activation', 'state_object_import',
         'state_object_cleanup_export_barrier', 'do_schema_meta', 'do_schema_migration')`,
    )
    .toArray();
  let retainedRows = 0;
  for (const table of tables) {
    const row = state.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM "${table.name.replace(/"/g, '""')}"`,
      )
      .toArray()[0];
    if (row === undefined) throw new Error("Missing deletion row count");
    retainedRows += row.count;
  }
  return {
    keys: [...(await state.storage.list()).keys()],
    retainedRows,
  };
}

async function addAcceptedProjectReference(
  session: IssuedControlSession,
  scope: ConversationScope,
): Promise<void> {
  const response = await exports.default.fetch(
    new Request(
      `https://localhost/v1/control/organisations/${ORGANISATION_ID}/projects/references?search=New%20chat`,
      { headers: { cookie: `satyr_control_session=${session.token}` } },
    ),
  );
  const raw = await response.json();
  if (!isRecord(raw) || !Array.isArray(raw.references))
    throw new Error("Missing reference catalog");
  const candidate = raw.references.find(projectCaseReference);
  const reference = parseProjectReference(candidate);
  if (reference === null || reference.kind !== "case_entry")
    throw new Error("Missing owned Case reference");
  const directory = await readProjectDirectory(fixtureDatabase(), scope);
  const project = directory.projects.find(
    projectContextHasId.bind(
      null,
      "project_00000000-0000-4000-8000-000000000042",
    ),
  );
  if (project === undefined) throw new Error("Missing autumn project");
  await projectContextMutation(session, {
    kind: "edit_project",
    projectId: project.id,
    operationId: "add_accepted_case_reference",
    expectedProjectRevision: project.revision,
    content: {
      name: project.name,
      brief: project.brief,
      references: [...project.references, reference],
    },
  });
}
function projectCaseReference(raw: unknown): boolean {
  return isRecord(raw) && raw.kind === "case_entry";
}

async function pauseForkSource(
  evidence: ProjectProviderEvidence,
  prompt: string,
): Promise<void> {
  if (evidence.pause.kind === "waiting" && isPausedForkPrompt(prompt))
    await evidence.pause.gate.promise;
}

async function proveThreadForking(
  input: {
    session: IssuedControlSession;
    scope: ConversationScope;
    conversationId: string;
    route: "pi";
    actor: DurableObjectStub<SessionDO>;
  },
  evidence: ProjectProviderEvidence,
): Promise<
  Readonly<{
    sourceId: string;
    cutoffId: string;
    destinationId: string;
    nestedId: string;
    digest: string;
    restoredAttachmentHistoryDigest: string;
    sourceCheckpoint: SourceCheckpointEvidence;
  }>
> {
  const source = await readConversation(
    fixtureDatabase(),
    input.scope,
    input.conversationId,
  );
  if (source === null) throw new Error("Missing source chat");
  const cutoff = source.conversation.historyBindings.find(
    checkpointSourceBinding,
  );
  if (cutoff === undefined || cutoff.responseId === null)
    throw new Error("Missing accepted cutoff");
  const sourceCheckpoint: SourceCheckpointEvidence =
    await provePiSourceCheckpoint(input.scope, cutoff, evidence);
  await proveUnavailableForkPrefix(
    input.session,
    input.scope,
    source.conversation,
    evidence,
  );
  const model = PLATFORM_DEFAULT_PI_MODEL;
  const gate = Promise.withResolvers<void>();
  evidence.pause = { kind: "waiting", gate };
  expect(
    (
      await send(input.session, {
        ...command(
          "fork_later_running",
          "LATER_UNFINISHED_SOURCE: keep the current shared workspace.",
        ),
        browserContext: { kind: "unavailable" },
        model,
        conversationId: input.conversationId,
      })
    ).status,
  ).toBe(200);
  await expect
    .poll(providerSawPendingSource.bind(null, evidence), { timeout: 15_000 })
    .toBe(true);
  const callsBeforeFork = evidence.prompts.length;
  const summariesBeforeFork = evidence.compactionRequests.length;
  const operation = {
    action: "fork",
    operationId: "fork_first_accepted",
    messageId: cutoff.responseId,
  };
  const created = await projectChatMetadata(
    input.session,
    input.conversationId,
    operation,
  );
  expect(created.status).toBe(200);
  const fork = await created.json();
  if (
    !isRecord(fork) ||
    fork.kind !== "ready" ||
    typeof fork.conversationId !== "string" ||
    typeof fork.digest !== "string"
  )
    throw new Error(`Fork failed: ${JSON.stringify(fork)}`);
  expect(evidence.prompts).toHaveLength(callsBeforeFork);
  expect(evidence.compactionRequests).toHaveLength(summariesBeforeFork);
  const destination = await readConversation(
    fixtureDatabase(),
    input.scope,
    fork.conversationId,
  );
  if (destination === null) throw new Error("Missing fork");
  expect(destination.conversation.work).toEqual({ kind: "ready" });
  expect(destination.conversation.pendingInputs).toEqual([]);
  expect(destination.conversation.draftText).toBe("");
  expect(JSON.stringify(destination.conversation.timeline)).not.toContain(
    "project_ungrouped_request",
  );
  expect(destination.conversation.lineage).toMatchObject({
    kind: "fork",
    sourceConversationId: input.conversationId,
    sourceMessageId: cutoff.responseId,
    digest: fork.digest,
  });
  expect(
    (await readConversation(fixtureDatabase(), input.scope, input.conversationId))
      ?.conversation.work.kind,
  ).toBe("running");
  // Recreate the persisted interruption window after publication, before receipt settlement.
  await fixtureDatabase().prepare(
    "UPDATE portal_chat_fork SET status = 'prepared', conversation_json = ? WHERE destination_conversation_id = ?",
  )
    .bind(JSON.stringify(destination.conversation), fork.conversationId)
    .run();
  await evictDurableObject(input.actor);
  const recovered = await projectChatMetadata(
    input.session,
    input.conversationId,
    operation,
  );
  expect(await recovered.json()).toMatchObject({
    kind: "ready",
    conversationId: fork.conversationId,
    digest: fork.digest,
  });
  expect(
    (
      await projectChatMetadata(input.session, input.conversationId, {
        ...operation,
        messageId: "different_cutoff",
      })
    ).status,
  ).toBe(409);
  expect(
    await fixtureDatabase().prepare(
      "SELECT COUNT(*) AS count FROM portal_chat_fork WHERE operation_id = ?",
    )
      .bind(operation.operationId)
      .first("count"),
  ).toBe(1);
  const attachmentDigest = await restoreForkWithTextAttachment(
    input.scope,
    fork.conversationId,
  );
  expect(
    (
      await send(input.session, {
        ...command(
          "fork_alternative",
          "Explain an alternative oven arrangement. Keep prior actions as historical facts.",
        ),
        browserContext: { kind: "unavailable" },
        model,
        conversationId: fork.conversationId,
      })
    ).status,
  ).toBe(200);
  await expect
    .poll(
      readAutomaticContextCompletion.bind(
        null,
        input.session,
        fork.conversationId,
      ),
      { timeout: 15_000 },
    )
    .toBe("ready");
  const forkPrompt = evidence.prompts.at(-1) ?? "";
  expect(forkPrompt).toContain(
    "RETAINED_FORK_BRIEF: proofing capacity is twelve trays.",
  );
  expect(forkPrompt).toContain("data:image/png;base64,");
  expect(forkPrompt).toContain("bakery_saved_run_read");
  expect(forkPrompt).toContain("bakery_surface_control_workspace_view");
  expect(forkPrompt).not.toContain("LATER_UNFINISHED_SOURCE");
  const continued = await readConversation(
    fixtureDatabase(),
    input.scope,
    fork.conversationId,
  );
  if (continued === null) throw new Error("Missing continued fork");
  const last = continued.conversation.historyBindings.at(-1);
  if (last === undefined || last.responseId === null)
    throw new Error("Missing fork response");
  const nestedResponse = await projectChatMetadata(
    input.session,
    fork.conversationId,
    { action: "fork", operationId: "fork_nested", messageId: last.responseId },
  );
  expect(nestedResponse.status).toBe(200);
  const nested = await nestedResponse.json();
  if (!isRecord(nested) || typeof nested.conversationId !== "string")
    throw new Error("Missing nested fork");
  const nestedState = await readConversation(
    fixtureDatabase(),
    input.scope,
    nested.conversationId,
  );
  expect(nestedState?.conversation.lineage).toMatchObject({
    kind: "fork",
    sourceConversationId: fork.conversationId,
  });
  const sessionId = parseSessionId(last.sessionId);
  if (!sessionId.ok) throw new Error("Invalid branch session");
  const actor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  await evictDurableObject(actor.value);
  evidence.pause = { kind: "idle" };
  gate.resolve();
  await expect
    .poll(
      readAutomaticContextCompletion.bind(
        null,
        input.session,
        input.conversationId,
      ),
      { timeout: 15_000 },
    )
    .toBe("ready");
  const stopGate = Promise.withResolvers<void>();
  evidence.pause = { kind: "waiting", gate: stopGate };
  expect(
    (
      await send(input.session, {
        ...command(
          "fork_stop_source",
          "LATER_UNFINISHED_SOURCE_STOP: investigate another layout.",
        ),
        browserContext: { kind: "unavailable" },
        model,
        conversationId: input.conversationId,
      })
    ).status,
  ).toBe(200);
  await expect
    .poll(providerSawStopSource.bind(null, evidence), { timeout: 15_000 })
    .toBe(true);
  expect(
    (
      await send(input.session, {
        ...command(
          "nested_alternative",
          "NESTED_UNFINISHED_FORK: continue the alternative arrangement from inherited facts.",
        ),
        browserContext: { kind: "unavailable" },
        model,
        conversationId: nested.conversationId,
      })
    ).status,
  ).toBe(200);
  await expect
    .poll(providerSawPendingNested.bind(null, evidence), { timeout: 15_000 })
    .toBe(true);
  await stopForkSource(input.session, input.scope, input.conversationId);
  const pendingNested = await readConversation(
    fixtureDatabase(),
    input.scope,
    nested.conversationId,
  );
  expect(pendingNested?.conversation.work.kind).toBe("running");
  const stoppedSource = await readConversation(
    fixtureDatabase(),
    input.scope,
    input.conversationId,
  );
  expect(stoppedSource?.conversation.work.kind).toBe("ready");
  expect(stoppedSource?.conversation.timeline.some(isForkCancellation)).toBe(
    true,
  );
  evidence.pause = { kind: "idle" };
  stopGate.resolve();
  await expect
    .poll(
      readAutomaticContextCompletion.bind(
        null,
        input.session,
        nested.conversationId,
      ),
      { timeout: 15_000 },
    )
    .toBe("ready");
  expect(evidence.prompts.at(-1)).toContain("fork_alternative");
  expect(evidence.prompts.at(-1)).toContain(
    "RETAINED_FORK_BRIEF: proofing capacity is twelve trays.",
  );
  expect(evidence.prompts.at(-1)).toContain("data:image/png;base64,");

  evidence.pause = { kind: "idle" };
  stopGate.resolve();
  await expect
    .poll(
      readAutomaticContextCompletion.bind(
        null,
        input.session,
        input.conversationId,
      ),
      { timeout: 15_000 },
    )
    .toBe("ready");
  expect(evidence.prompts).toHaveLength(callsBeforeFork + 3);
  const completedSource = await readConversation(
    fixtureDatabase(),
    input.scope,
    input.conversationId,
  );
  if (completedSource === null) throw new Error("Missing completed source");
  expect(
    completedSource.conversation.historyBindings.some(isStoppedSourceBinding),
  ).toBe(false);
  expect(
    (
      await projectChatMetadata(input.session, input.conversationId, {
        action: "archive",
        expectedRevision: completedSource.revision,
      })
    ).status,
  ).toBe(200);
  const archivedSource = await readConversation(
    fixtureDatabase(),
    input.scope,
    input.conversationId,
  );
  expect(archivedSource?.metadata.lifecycle).toBe("archived");
  expect(archivedSource?.revision).toBe(completedSource.revision);
  expect(
    (
      await readChatEndpoint(
        input.session,
        `?conversation=${fork.conversationId}&observe=true`,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await projectChatMetadata(input.session, input.conversationId, {
        action: "restore",
        expectedRevision: completedSource.revision,
      })
    ).status,
  ).toBe(200);
  // Simulate grant revocation after both branches have completed.
  await fixtureDatabase().prepare(
    "UPDATE access_grant SET lifecycle = 'revoked', reason = 'fork access test', revision = revision + 1 WHERE organisation_id = ? AND lifecycle = 'active' AND json_extract(target_json, '$.capabilityId') = ?",
  )
    .bind(ORGANISATION_ID, CONTEXT_CASE_READ_CAPABILITY)
    .run();
  expect(
    (
      await readChatEndpoint(
        input.session,
        `?conversation=${fork.conversationId}&observe=true`,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await send(input.session, {
        ...command("fork_denied", "Continue after access was revoked."),
        browserContext: { kind: "unavailable" },
        model,
        conversationId: fork.conversationId,
      })
    ).status,
  ).toBe(403);
  const revokedDirectory = await readChatEndpoint(
    input.session,
    `?conversation=${input.conversationId}&observe=true`,
  );
  expect(revokedDirectory.status).toBe(403);
  expect(await revokedDirectory.json()).toMatchObject({
    code: "chat_history_forbidden",
    reason: "source_policy_denied",
  });
  expect(evidence.prompts).toHaveLength(callsBeforeFork + 3);
  await fixtureDatabase().prepare(
    "UPDATE access_grant SET lifecycle = 'active', reason = NULL, revision = revision + 1 WHERE organisation_id = ? AND reason = 'fork access test'",
  )
    .bind(ORGANISATION_ID)
    .run();
  expect(
    (
      await readChatEndpoint(
        input.session,
        `?conversation=${fork.conversationId}&observe=true`,
      )
    ).status,
  ).toBe(200);

  const publicSource = await readChatEndpoint(
    input.session,
    `?conversation=${input.conversationId}&observe=true`,
  );
  expect(await publicSource.json()).toMatchObject({
    derivedThreads: [
      { id: fork.conversationId, sourceMessageId: cutoff.responseId },
    ],
  });
  return {
    sourceId: input.conversationId,
    cutoffId: cutoff.responseId,
    destinationId: fork.conversationId,
    nestedId: nested.conversationId,
    digest: fork.digest,
    restoredAttachmentHistoryDigest: attachmentDigest,
    sourceCheckpoint,
  };
}

type SourceCheckpointEvidence =
  | Readonly<{
      kind: "checkpointed";
      sessionId: string;
      checkpointKey: string;
      checkpointDigest: string;
      historyDigest: string;
      summaries: number;
    }>
;

function checkpointSourceBinding(
  binding: import("../../src/chat/fork-history").ChatHistoryBinding,
): boolean {
  return (
    binding.requestId === "project_autumn_request" &&
    binding.responseId !== null
  );
}

async function provePiSourceCheckpoint(
  scope: ConversationScope,
  cutoff: import("../../src/chat/fork-history").ChatHistoryBinding,
  evidence: ProjectProviderEvidence,
): Promise<Extract<SourceCheckpointEvidence, { kind: "checkpointed" }>> {
  const sessionId = parseSessionId(cutoff.sessionId);
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const actor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: scope.organisationId,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  await evictDurableObject(actor.value);
  const stored = await runInDurableObject(
    actor.value,
    readForkCheckpoint.bind(null, sessionId.value),
  );
  expect(stored.cursor.turn.turnId).toBe(cutoff.turnId);
  expect(stored.historyCursor).toEqual(cutoff.cursor);
  const object = await env.ARCHIVE.get(stored.blob.objectKey);
  if (object === null) throw new Error("Missing source checkpoint");
  expect((await object.text()).startsWith("SATYRCP1")).toBe(true);
  return {
    kind: "checkpointed",
    sessionId: cutoff.sessionId,
    checkpointKey: stored.blob.objectKey,
    checkpointDigest: stored.blob.sha256,
    historyDigest: cutoff.cursor.lastEntryDigest,
    summaries: evidence.compactionRequests.length,
  };
}

function readForkCheckpoint(
  sessionId: string,
  _actor: unknown,
  state: DurableObjectState,
) {
  const checkpoint = readLatestHarnessCheckpoint(state.storage.sql, sessionId);
  if (!checkpoint.ok) throw new Error(checkpoint.error.code);
  return checkpoint.value;
}

async function proveUnavailableForkPrefix(
  session: IssuedControlSession,
  scope: ConversationScope,
  source: import("../../src/chat/conversation").Conversation,
  evidence: ProjectProviderEvidence,
): Promise<void> {
  const first = source.historyBindings[0];
  const last = source.historyBindings.at(-1);
  if (
    first?.responseId === null ||
    first === undefined ||
    last?.responseId === null ||
    last === undefined
  )
    throw new Error("Missing accepted prefix fixture");
  const original = JSON.stringify(source.historyBindings);
  const corrupted = source.historyBindings.map(corruptForkCursor);
  const callsBefore = evidence.prompts.length;
  const summariesBefore = evidence.compactionRequests.length;
  await replaceSourceHistoryBindings(
    scope,
    source.id,
    JSON.stringify(corrupted),
  );
  const digestFailure = await projectChatMetadata(session, source.id, {
    action: "fork",
    operationId: "fork_bad_cursor",
    messageId: first.responseId,
  });
  const digestResult: unknown = await digestFailure.json();
  expect(digestResult).toMatchObject({
    kind: "failed",
    code: "chat_fork_history_digest_mismatch",
  });
  await replaceSourceHistoryBindings(
    scope,
    source.id,
    JSON.stringify(source.historyBindings.slice(1)),
  );
  const prefixFailure = await projectChatMetadata(session, source.id, {
    action: "fork",
    operationId: "fork_missing_prefix",
    messageId: last.responseId,
  });
  expect(await prefixFailure.json()).toMatchObject({
    kind: "failed",
    code: "chat_fork_history_unavailable",
  });
  await replaceSourceHistoryBindings(scope, source.id, original);
  expect(evidence.prompts).toHaveLength(callsBefore);
  expect(evidence.compactionRequests).toHaveLength(summariesBefore);
  for (const operationId of ["fork_bad_cursor", "fork_missing_prefix"]) {
    const row = await fixtureDatabase().prepare(
      "SELECT destination_conversation_id FROM portal_chat_fork WHERE organisation_id = ? AND operation_id = ? AND status = 'failed'",
    )
      .bind(scope.organisationId, operationId)
      .first<{ destination_conversation_id: string }>();
    if (row === null) throw new Error("Missing failed fork receipt");
    expect(
      await readConversation(fixtureDatabase(), scope, row.destination_conversation_id),
    ).toBeNull();
  }
}

function corruptForkCursor(
  binding: import("../../src/chat/fork-history").ChatHistoryBinding,
): import("../../src/chat/fork-history").ChatHistoryBinding {
  return {
    requestId: binding.requestId,
    responseId: binding.responseId,
    throughSequence: binding.throughSequence,
    sessionId: binding.sessionId,
    turnId: binding.turnId,
    cursor: {
      lastSequence: binding.cursor.lastSequence,
      lastEntryDigest: "0".repeat(64),
    },
    modelRoute: binding.modelRoute,
  };
}

async function replaceSourceHistoryBindings(
  scope: ConversationScope,
  conversationId: string,
  bindings: string,
): Promise<void> {
  await fixtureDatabase().prepare(
    "UPDATE portal_conversation SET state_json = json_set(state_json, '$.historyBindings', json(?)) WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?",
  )
    .bind(bindings, scope.organisationId, scope.userId, conversationId)
    .run();
}
function providerSawPendingSource(evidence: ProjectProviderEvidence): boolean {
  return evidence.prompts.some(hasPendingSource);
}
function hasPendingSource(prompt: string): boolean {
  return prompt.includes("LATER_UNFINISHED_SOURCE");
}

function isPausedForkPrompt(prompt: string): boolean {
  return (
    prompt.includes("LATER_UNFINISHED_SOURCE") ||
    prompt.includes("NESTED_UNFINISHED_FORK")
  );
}
function providerSawPendingNested(evidence: ProjectProviderEvidence): boolean {
  return evidence.prompts.some(hasPendingNested);
}
function hasPendingNested(prompt: string): boolean {
  return prompt.includes("NESTED_UNFINISHED_FORK");
}
function isForkCancellation(
  event: import("../../src/chat/timeline").ChatTimelineEvent,
): boolean {
  return (
    event.kind === "run_cancelled" && event.eventId === "cancel_fork_source"
  );
}
async function stopForkSource(
  session: IssuedControlSession,
  scope: ConversationScope,
  conversationId: string,
): Promise<void> {
  const source = await readConversation(fixtureDatabase(), scope, conversationId);
  const work = source?.conversation.work;
  if (work?.kind !== "running")
    throw new Error("Fork source must be running before Stop");
  const response = await exports.default.fetch(
    new Request(
      `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat/cancel`,
      {
        method: "POST",
        headers: {
          origin: "https://localhost",
          "content-type": "application/json",
          cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
          "x-satyr-csrf": session.csrfToken,
        },
        body: JSON.stringify({
          conversationId,
          requestId: work.requestId,
          sessionId: work.stream.sessionId,
          turnId: work.stream.turnId,
          cancellationId: "cancel_fork_source",
        }),
      },
    ),
  );
  expect(response.status).toBe(200);
}

function providerSawStopSource(evidence: ProjectProviderEvidence): boolean {
  return evidence.prompts.some(hasStopSource);
}
function hasStopSource(prompt: string): boolean {
  return prompt.includes("LATER_UNFINISHED_SOURCE_STOP");
}

function isStoppedSourceBinding(
  binding: import("../../src/chat/fork-history").ChatHistoryBinding,
): boolean {
  return binding.requestId === "fork_stop_source";
}

async function restoreForkWithTextAttachment(
  scope: ConversationScope,
  conversationId: string,
): Promise<string> {
  const row = await fixtureDatabase().prepare(
    "SELECT history_json FROM portal_chat_fork WHERE organisation_id = ? AND user_id = ? AND destination_conversation_id = ? AND status = 'ready'",
  )
    .bind(scope.organisationId, scope.userId, conversationId)
    .first<{ history_json: string }>();
  if (row === null) throw new Error("Missing restored fork fixture");
  const history = await parseChatForkHistory(JSON.parse(row.history_json));
  const bytes = new TextEncoder().encode(
    "RETAINED_FORK_BRIEF: proofing capacity is twelve trays.",
  );
  const sha256 = await sha256Hex(bytes);
  const attachment = parseStoredAttachment({
    id: `att_${"c".repeat(32)}`,
    displayName: "retained-brief.txt",
    extensionHint: { kind: "none" },
    descriptor: {
      kind: "document",
      media: {
        kind: "provider_declared",
        mediaType: "text/plain",
        provider: "slack",
      },
    },
    byteLength: bytes.length,
    sha256,
    objectKey: `attachments/${scope.organisationId}/slack/${sha256}`,
    source: {
      kind: "slack",
      integrationAccountId: "account_fork_fixture",
      workspaceId: "T1",
      channelId: "C1",
      messageTs: "1700000000.000100",
      fileId: "F1",
      revision: "1",
    },
    retention: "session",
    storedAt: 1,
  });
  if (!attachment.ok) throw new Error(attachment.error.code);
  const imageBytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8f8AAAAASUVORK5CYII=",
    ),
    retainedImageByte,
  );
  const imageDigest = await sha256Hex(imageBytes);
  const image = parseStoredAttachment({
    id: `att_${"d".repeat(32)}`,
    displayName: "retained-layout.png",
    extensionHint: { kind: "none" },
    descriptor: {
      kind: "image",
      media: {
        kind: "signature_verified",
        mediaType: "image/png",
        method: "magic_bytes",
      },
    },
    byteLength: imageBytes.length,
    sha256: imageDigest,
    objectKey: `attachments/${scope.organisationId}/slack/${imageDigest}`,
    source: {
      kind: "slack",
      integrationAccountId: "account_fork_fixture",
      workspaceId: "T1",
      channelId: "C1",
      messageTs: "1700000000.000100",
      fileId: "F2",
      revision: "1",
    },
    retention: "session",
    storedAt: 1,
  });
  if (!image.ok) throw new Error(image.error.code);
  const entries = [...history.entries];
  const first = entries[0];
  if (first?.kind !== "user_input")
    throw new Error("Missing initial accepted user input");
  entries[0] = {
    kind: "user_input",
    turn: first.turn,
    input: first.input,
    content: [
      ...first.content,
      { kind: "attachment", attachment: attachment.value },
      { kind: "attachment", attachment: image.value },
    ],
    acceptedAt: first.acceptedAt,
  };
  const restored = await parseChatForkHistory({
    entries,
    bindings: history.bindings,
  });
  const digest = await chatForkHistoryDigest(restored);
  await env.ARCHIVE.put(attachment.value.objectKey, bytes);
  await env.ARCHIVE.put(image.value.objectKey, imageBytes);
  // Restore a retained-file fixture before its first destination turn; Portal has no file-upload command.
  await fixtureDatabase().batch([
    fixtureDatabase().prepare(
      "UPDATE portal_chat_fork SET history_json = ?, digest = ? WHERE organisation_id = ? AND user_id = ? AND destination_conversation_id = ?",
    ).bind(
      JSON.stringify(restored),
      digest,
      scope.organisationId,
      scope.userId,
      conversationId,
    ),
    fixtureDatabase().prepare(
      "UPDATE portal_conversation SET state_json = json_set(state_json, '$.lineage.digest', ?) WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?",
    ).bind(digest, scope.organisationId, scope.userId, conversationId),
  ]);
  return digest;
}

function retainedImageByte(character: string): number {
  return character.charCodeAt(0);
}

const INSPECTION_TEXT = "P55 attachment inspection: reserve twelve trays.";
type AttachmentOriginBoundary = "observation_commit";
type AttachmentOriginJourney = {
  readonly boundary: AttachmentOriginBoundary;
  readonly digest: SubtleCrypto["digest"];
  phase: "armed" | "paused" | "released";
  calls: number;
  discoveries: number;
  toolIssued: boolean;
  attachmentId: string;
};
let attachmentOriginJourney: AttachmentOriginJourney | null = null;

it.for(["observation_commit"] as const)(
  "fences attachment inspection at %s after origin revocation and Session eviction",
  { timeout: 45_000 },
  inspectAttachmentOriginJourney,
);

async function inspectAttachmentOriginJourney(
  boundary: AttachmentOriginBoundary,
  { task }: TestContext,
): Promise<void> {
  const { session, scope } = await fixture();
  const fresh = await issueControlSession({
    db: env.DB,
    userId: scope.userId,
    now: Date.now(),
    ttlMs: 1_800_000,
  });
  const execution = await requireOrganisationExecutionScope(
    env,
    ORGANISATION_ID,
  );
  const now = Date.now();
  await createRequiredGrant({
    grantId: "grant_p55_attachment_inspect",
    subject: { kind: "person", personId: "person_e2e-slack-actor" },
    target: {
      kind: "platform_capability",
      capabilityId: "message.attachment.inspect",
      capabilityVersion: 1,
    },
    now,
  });
  const enabled = await writeOrganisationCapabilityPolicy({
    scope: execution,
    write: {
      kind: "change",
      capabilityId: "message.attachment.inspect",
      expectedRevision: 1,
      mode: "enabled",
      provenance: {
        kind: "operator",
        userId: scope.userId,
        mutationReceiptId: "receipt_p55_inspect",
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
  const model: AttachmentOriginJourney = {
    boundary,
    digest: crypto.subtle.digest,
    phase: "armed",
    calls: 0,
    discoveries: 0,
    toolIssued: false,
    attachmentId: "",
  };
  attachmentOriginJourney = model;
  crypto.subtle.digest = pauseAttachmentOrigin;
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondAttachmentOrigin.bind(null, model),
    ),
  );
  const conversationId = newConversationId();
  const requestId = `p55_inspect_${boundary}`;
  try {
    const accepted = await uploadInspectionAttachment(
      session,
      conversationId,
      requestId,
    );
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    await accepted.arrayBuffer();
    await expect
      .poll(attachmentOriginPhase.bind(null, model), { timeout: 15_000 })
      .toBe("paused");
    const running = await readConversation(fixtureDatabase(), scope, conversationId);
    if (running?.conversation.work.kind !== "running")
      throw new Error("Missing running attachment turn");
    const stream = running.conversation.work.stream;
    const id = parseSessionId(stream.sessionId);
    if (!id.ok) throw new Error(id.error.code);
    const resolved = await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: ORGANISATION_ID,
      sessionId: id.value,
      now: Date.now(),
    });
    if (!resolved.ok) throw new Error(resolved.error.code);
    const before = await runInDurableObject(
      resolved.value,
      retainedInspectionState.bind(null, model.attachmentId),
    );
    const calls = model.calls;
    await env.DB.prepare(
      "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
    )
      .bind(Date.now(), session.session.controlSessionId)
      .run();
    model.phase = "released";
    await expect
      .poll(readAutomaticContextCompletion.bind(null, fresh, conversationId), {
        timeout: 15_000,
      })
      .toBe("failed");
    expect(model.calls).toBe(calls);
    const denied = await runInDurableObject(
      resolved.value,
      retainedInspectionState.bind(null, model.attachmentId),
    );
    expect(denied.attachmentObservations).toBe(before.attachmentObservations);
    expect(denied.preparations).toEqual(before.preparations);
    expect(denied.history).not.toContain('"outcome":"inspected"');
    const replay = await readChatEndpoint(
      fresh,
      `/stream?conversation=${conversationId}&request=${requestId}&after=-1`,
    );
    expect(await replay.text()).not.toContain('"outcome":"inspected"');
    await evictDurableObject(resolved.value);
    expect(
      await runInDurableObject(
        resolved.value,
        retainedInspectionState.bind(null, model.attachmentId),
      ),
    ).toEqual(denied);
    expect(await readOriginBinding(stream.sessionId, stream.turnId)).toBe(
      session.session.controlSessionId,
    );
    await uploadInspectionAttachment(fresh, conversationId, requestId);
    expect(await readOriginBinding(stream.sessionId, stream.turnId)).toBe(
      session.session.controlSessionId,
    );
    expect(model.calls).toBe(calls);
    model.toolIssued = false;
    const freshConversationId = newConversationId();
    const authorized = await uploadInspectionAttachment(
      fresh,
      freshConversationId,
      `${requestId}_fresh`,
    );
    expect(authorized.status, await authorized.clone().text()).toBe(200);
    await authorized.arrayBuffer();
    await expect
      .poll(
        readAutomaticContextCompletion.bind(null, fresh, freshConversationId),
        { timeout: 15_000 },
      )
      .toBe("ready");
    const origin = await fixtureDatabase().prepare(
      "SELECT session_id FROM session_turn_access WHERE organisation_id = ? AND control_session_id = ? AND conversation_id = ?",
    )
      .bind(
        ORGANISATION_ID,
        fresh.session.controlSessionId,
        freshConversationId,
      )
      .first<{ session_id: string }>();
    if (origin === null) throw new Error("Missing authorized attachment turn");
    const freshId = parseSessionId(origin.session_id);
    if (!freshId.ok) throw new Error(freshId.error.code);
    const freshActor = await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId: ORGANISATION_ID,
      sessionId: freshId.value,
      now: Date.now(),
    });
    if (!freshActor.ok) throw new Error(freshActor.error.code);
    const completed = await runInDurableObject(
      freshActor.value,
      retainedInspectionState.bind(null, model.attachmentId),
    );
    expect(completed.attachmentObservations).toBe(1);
    Object.assign(task.meta, {
      attachmentOriginAcceptance: {
        boundary,
        withheldInspection: true,
        preparationRetained: true,
        revokedObservations: denied.attachmentObservations,
        duplicateInference: false,
        evictionRetained: true,
        freshAuthorizedInspection: true,
        freshObservations: completed.attachmentObservations,
      },
    });
  } finally {
    model.phase = "released";
    crypto.subtle.digest = model.digest;
    attachmentOriginJourney = null;
  }
}
function attachmentOriginPhase(model: AttachmentOriginJourney) {
  return model.phase;
}
async function pauseAttachmentOrigin(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["digest"]>[0],
  data: Parameters<SubtleCrypto["digest"]>[1],
): Promise<ArrayBuffer> {
  const model = attachmentOriginJourney;
  if (model === null) throw new Error("Missing attachment journey");
  const result = await model.digest.call(this, algorithm, data);
  if (model.phase !== "armed" || !model.toolIssued) return result;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return result;
  }
  const observation =
    model.boundary === "observation_commit" &&
    isRecord(raw) &&
    isRecord(raw.source) &&
    raw.source.kind === "case_entry" &&
    raw.source.entryId === model.attachmentId;
  if (observation) {
    model.phase = "paused";
    while (model.phase === "paused") await scheduler.wait(5);
  }
  return result;
}
async function respondAttachmentOrigin(
  model: AttachmentOriginJourney,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  model.calls++;
  const raw: unknown = await request.json();
  if (!isRecord(raw) || !Array.isArray(raw.tools))
    throw new Error("Missing attachment model tools");
  if (model.toolIssued)
    return openRouterText(
      JSON.stringify({
        kind: "reply",
        text: "Attachment inspection completed.",
      }),
      "p55_inspect_done",
    );
  const id = JSON.stringify(raw)
    .match(/att_[a-z0-9]{32}/gu)
    ?.at(-1);
  if (id === undefined)
    throw new Error("Missing canonical attachment identity");
  model.attachmentId = id;
  if (!raw.tools.some(inspectionTool)) {
    if (++model.discoveries > 8)
      throw new Error("Attachment discovery did not complete");
    return openRouterToolCall(
      "tool_search",
      { query: "inspect_message_attachment", limit: 1 },
      `p55_inspection_discovery_${model.discoveries}`,
    );
  }
  model.toolIssued = true;
  return openRouterToolCall(
    "inspect_message_attachment",
    { attachmentId: id },
    "p55_inspect_attachment",
  );
}
function inspectionTool(tool: unknown): boolean {
  return (
    isRecord(tool) &&
    isRecord(tool.function) &&
    tool.function.name === "inspect_message_attachment"
  );
}
function uploadInspectionAttachment(
  session: IssuedControlSession,
  conversationId: string,
  requestId: string,
): Promise<Response> {
  const form = new FormData();
  form.set(
    "command",
    JSON.stringify({
      kind: "message",
      conversationId,
      requestId,
      model: PLATFORM_DEFAULT_PI_MODEL,
      text: "Inspect the attached document.",
      browserContext: { kind: "unavailable" },
      surfaceContext: null,
    }),
  );
  form.append(
    "files",
    new File([INSPECTION_TEXT], "inspection.txt", { type: "text/plain" }),
  );
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat`,
    {
      method: "POST",
      headers: {
        origin: "https://localhost",
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        "x-satyr-csrf": session.csrfToken,
      },
      body: form,
    },
  );
}
function retainedInspectionState(
  attachmentId: string,
  _actor: unknown,
  state: DurableObjectState,
) {
  return {
    history: JSON.stringify(
      state.storage.sql.exec("SELECT * FROM session_harness_history").toArray(),
    ),
    preparations: state.storage.sql
      .exec("SELECT * FROM session_message_preparation")
      .toArray(),
    observations: state.storage.sql
      .exec("SELECT evidence_json FROM session_information_flow_observation")
      .toArray(),
    attachmentObservations: state.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_information_flow_observation WHERE json_extract(evidence_json, '$.source.kind') = 'case_entry' AND json_extract(evidence_json, '$.source.entryId') = ?",
        attachmentId,
      )
      .one().count,
  };
}

type ReadOriginBoundary = "commerce_commit" | "saved_commit";
type ReadOriginJourney = {
  readonly boundary: ReadOriginBoundary;
  readonly digest: SubtleCrypto["digest"];
  readonly savedRunId: string;
  readonly integrationAccountId: string;
  phase: "armed" | "paused" | "released";
  calls: number;
  discoveries: number;
  toolIssued: boolean;
  evidenceDigest: string;
  observationSetDigest: string;
};
let readOriginJourney: ReadOriginJourney | null = null;

it.for(["commerce_commit", "saved_commit"] as const)(
  "fences captured read authority at %s through revocation, eviction and fresh retry",
  { timeout: 45_000 },
  capturedReadOriginJourney,
);

async function capturedReadOriginJourney(
  boundary: ReadOriginBoundary,
  { task }: TestContext,
): Promise<void> {
  const { session, scope } = await fixture();
  const fresh = await issueControlSession({
    db: env.DB,
    userId: scope.userId,
    now: Date.now(),
    ttlMs: 1_800_000,
  });
  await installAutomaticContextCommerce(
    `merchant_bakery_c3_origin_${boundary}`,
  );
  const connection = await fixtureDatabase().prepare(
    "SELECT integration_account_id FROM underclerk_merchant_binding WHERE organisation_id = ?",
  )
    .bind(ORGANISATION_ID)
    .first<{ integration_account_id: string }>();
  if (connection === null) throw new Error("Missing commerce origin fixture");
  const model: ReadOriginJourney = {
    boundary,
    digest: crypto.subtle.digest,
    savedRunId: await saveAutomaticContextRun(),
    integrationAccountId: connection.integration_account_id,
    phase: "armed",
    calls: 0,
    discoveries: 0,
    toolIssued: false,
    evidenceDigest: "",
    observationSetDigest: "",
  };
  readOriginJourney = model;
  crypto.subtle.digest = pauseCapturedReadOrigin;
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondCapturedReadOrigin.bind(null, model),
    ),
  );
  const conversationId = newConversationId();
  const requestId = `p55_read_${boundary}`;
  try {
    const admitted = await sendCapturedReadOrigin(
      session,
      conversationId,
      requestId,
    );
    expect(admitted.status, await admitted.clone().text()).toBe(200);
    await admitted.arrayBuffer();
    await expect
      .poll(capturedReadOriginPhase.bind(null, model), { timeout: 15_000 })
      .toBe("paused");
    const running = await readConversation(fixtureDatabase(), scope, conversationId);
    if (running?.conversation.work.kind !== "running")
      throw new Error("Missing captured read turn");
    const stream = running.conversation.work.stream;
    const revokedActor = await capturedReadSessionActor(stream.sessionId);
    const calls = model.calls;
    await env.DB.prepare(
      "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
    )
      .bind(Date.now(), session.session.controlSessionId)
      .run();
    model.phase = "released";
    await expect
      .poll(readAutomaticContextCompletion.bind(null, fresh, conversationId), {
        timeout: 15_000,
      })
      .toBe("failed");
    expect(model.calls).toBe(calls);
    const denied = await runInDurableObject(
      revokedActor,
      retainedCapturedRead.bind(null, model),
    );
    expect(denied.observations).toBe(0);
    expect(denied.proposableOrders).toBe(0);
    expect(denied.successfulResults).toBe(0);
    await evictDurableObject(revokedActor);
    expect(
      await runInDurableObject(
        revokedActor,
        retainedCapturedRead.bind(null, model),
      ),
    ).toEqual(denied);
    expect(await readOriginBinding(stream.sessionId, stream.turnId)).toBe(
      session.session.controlSessionId,
    );
    await sendCapturedReadOrigin(fresh, conversationId, requestId);
    expect(await readOriginBinding(stream.sessionId, stream.turnId)).toBe(
      session.session.controlSessionId,
    );
    expect(model.calls).toBe(calls);
    model.toolIssued = false;
    const freshConversationId = newConversationId();
    const authorized = await sendCapturedReadOrigin(
      fresh,
      freshConversationId,
      `${requestId}_fresh`,
    );
    expect(authorized.status, await authorized.clone().text()).toBe(200);
    await authorized.arrayBuffer();
    await expect
      .poll(
        readAutomaticContextCompletion.bind(null, fresh, freshConversationId),
        { timeout: 15_000 },
      )
      .toBe("ready");
    const origin = await fixtureDatabase().prepare(
      "SELECT session_id FROM session_turn_access WHERE organisation_id = ? AND control_session_id = ? AND conversation_id = ?",
    )
      .bind(
        ORGANISATION_ID,
        fresh.session.controlSessionId,
        freshConversationId,
      )
      .first<{ session_id: string }>();
    if (origin === null) throw new Error("Missing fresh captured read turn");
    const actor = await capturedReadSessionActor(origin.session_id);
    const completed = await runInDurableObject(
      actor,
      retainedCapturedRead.bind(null, model),
    );
    expect(completed.observations).toBeGreaterThan(0);
    expect(completed.successfulResults).toBe(1);
    if (boundary.startsWith("commerce"))
      expect(completed.proposableOrders).toBe(1);
    // The execution projection of both chats agrees with the Sessions'
    // accepted histories: the revoked turn failed with the tool results it
    // had, and the fresh turn completed with its own.
    const chatCase = async (conversation: string) => {
      const row = await fixtureDatabase().prepare(
        "SELECT case_id FROM portal_conversation WHERE organisation_id = ? AND conversation_id = ?",
      )
        .bind(ORGANISATION_ID, conversation)
        .first<{ case_id: string }>();
      if (row === null) throw new Error("Missing chat Case");
      return row.case_id;
    };
    Object.assign(task.meta, {
      caseExecution: {
        boundary,
        substituted: ["model provider (deterministic OpenRouter transport)"],
        revokedTurn: await verifyToolTurnExecution({
          organisationId: ORGANISATION_ID,
          session: fresh,
          caseId: await chatCase(conversationId),
          canonical: await runInDurableObject(
            revokedActor,
            readCanonicalToolResults,
          ),
          turn: "failed",
        }),
        freshTurn: await verifyToolTurnExecution({
          organisationId: ORGANISATION_ID,
          session: fresh,
          caseId: await chatCase(freshConversationId),
          canonical: await runInDurableObject(actor, readCanonicalToolResults),
          turn: "complete",
        }),
      },
    });
    Object.assign(task.meta, {
      capturedReadOriginAcceptance: {
        boundary,
        revokedObservations: denied.observations,
        revokedProposableOrders: denied.proposableOrders,
        successfulRevokedResults: denied.successfulResults,
        evictionRetained: true,
        originalBindingRetained: true,
        duplicateInference: false,
        authorizedFreshObservations: completed.observations,
        successfulFreshResults: completed.successfulResults,
      },
    });
  } finally {
    model.phase = "released";
    crypto.subtle.digest = model.digest;
    readOriginJourney = null;
  }
}
function capturedReadOriginPhase(model: ReadOriginJourney) {
  return model.phase;
}
function sendCapturedReadOrigin(
  session: IssuedControlSession,
  conversationId: string,
  requestId: string,
) {
  return send(session, {
    ...command(requestId, "Read the source granted to this request."),
    conversationId,
    browserContext: { kind: "unavailable" },
  });
}
async function capturedReadSessionActor(sessionId: string) {
  const parsed = parseSessionId(sessionId);
  if (!parsed.ok) throw new Error(parsed.error.code);
  const actor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: parsed.value,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  return actor.value;
}
async function respondCapturedReadOrigin(
  model: ReadOriginJourney,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  model.calls++;
  const raw: unknown = await request.json();
  if (!isRecord(raw) || !Array.isArray(raw.tools))
    throw new Error("Missing captured read tools");
  if (model.toolIssued)
    return openRouterText(
      JSON.stringify({ kind: "reply", text: "Granted source read completed." }),
      "p55_read_done",
    );
  const name = capturedReadTool(model);
  if (!raw.tools.some(inspectionNamedTool.bind(null, name))) {
    if (++model.discoveries > 8)
      throw new Error("Captured read discovery failed");
    return openRouterToolCall(
      "tool_search",
      { query: name, limit: 1 },
      `p55_read_discover_${model.discoveries}`,
    );
  }
  model.toolIssued = true;
  return openRouterToolCall(
    name,
    capturedReadArguments(model),
    "p55_read_source",
  );
}
function inspectionNamedTool(name: string, tool: unknown): boolean {
  return (
    isRecord(tool) && isRecord(tool.function) && tool.function.name === name
  );
}
function capturedReadTool(model: ReadOriginJourney): string {
  switch (model.boundary) {
    case "commerce_commit":
      return "commerce_entity_context";
    case "saved_commit":
      return "bakery_saved_run_read";
  }
}
function capturedReadArguments(
  model: ReadOriginJourney,
): Readonly<Record<string, unknown>> {
  switch (model.boundary) {
    case "commerce_commit":
      return {
        request: {
          selection: {
            kind: "entity_seeds",
            seeds: [
              {
                origin: "system",
                typeId: "order",
                entityId: "order_capacity_upcoming",
              },
            ],
          },
          traversal: { maxDepth: 0, resultLimit: 1 },
          allowedSensitivity: "internal",
          allowedAttributeIds: ["lifecycle", "ext_ordered_boxes"],
          freshnessRequirement: "current_only",
        },
      };
    case "saved_commit":
      return { id: model.savedRunId, cursor: null };
  }
}
async function pauseCapturedRead(model: ReadOriginJourney): Promise<void> {
  model.phase = "paused";
  while (model.phase === "paused") await scheduler.wait(5);
}
async function pauseCapturedReadOrigin(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["digest"]>[0],
  data: Parameters<SubtleCrypto["digest"]>[1],
): Promise<ArrayBuffer> {
  const model = readOriginJourney;
  if (model === null) throw new Error("Missing captured read journey");
  const result = await model.digest.call(this, algorithm, data);
  if (model.phase !== "armed" || !model.toolIssued) return result;
  const digest = Array.from(new Uint8Array(result), capturedReadHexByte).join(
    "",
  );
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return result;
  }
  if (
    isRecord(raw) &&
    isRecord(raw.source) &&
    typeof raw.contentDigest === "string"
  ) {
    const source = raw.source;
    const matched =
      model.boundary === "saved_commit"
        ? source.kind === "organisation_record" &&
          source.recordId === `bakery-run:${model.savedRunId}`
        : source.kind === "integration_resource" &&
          source.integrationAccountId === model.integrationAccountId &&
          typeof source.resourceScope === "string" &&
          source.resourceScope.startsWith("commerce");
    if (matched) model.evidenceDigest = digest;
  }
  if (
    model.evidenceDigest.length > 0 &&
    Array.isArray(raw) &&
    raw.includes(model.evidenceDigest)
  )
    model.observationSetDigest = digest;
  if (
    model.observationSetDigest.length > 0 &&
    isRecord(raw) &&
    raw.observationSetDigest === model.observationSetDigest
  )
    await pauseCapturedRead(model);
  return result;
}
function capturedReadHexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}
function retainedCapturedRead(
  model: ReadOriginJourney,
  _actor: unknown,
  state: DurableObjectState,
) {
  const observations = model.boundary.startsWith("saved")
    ? state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM session_information_flow_observation WHERE json_extract(evidence_json, '$.source.recordId') = ?",
          `bakery-run:${model.savedRunId}`,
        )
        .one().count
    : state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM session_information_flow_observation WHERE json_extract(evidence_json, '$.source.integrationAccountId') = ?",
          model.integrationAccountId,
        )
        .one().count;
  return {
    observations,
    proposableOrders: state.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_commerce_observation_entity WHERE entity_type = 'order'",
      )
      .one().count,
    successfulResults: state.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_harness_history WHERE json_extract(payload, '$.entry.kind') = 'tool_result' AND json_extract(payload, '$.entry.tool') = ? AND json_extract(payload, '$.entry.outcome.kind') = 'succeeded'",
        capturedReadTool(model),
      )
      .one().count,
    history: JSON.stringify(
      state.storage.sql.exec("SELECT * FROM session_harness_history").toArray(),
    ),
  };
}

async function attemptCancellation(
  request: Request,
): Promise<"cancelled" | "retry"> {
  const response = await exports.default.fetch(request.clone());
  if (response.status === 200) return "cancelled";
  const body = await response.text();
  if (
    response.status === 409 &&
    JSON.parse(body).error === "chat_cancel_unavailable"
  )
    return "retry";
  throw new Error(`Cancellation failed (${response.status}): ${body}`);
}

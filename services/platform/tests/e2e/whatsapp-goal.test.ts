import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import { readCaseSessionAssignment } from "../../src/actors/actor-journal/transactions";
import { parsePersistedHarnessTurnLease } from "../../src/actors/agent-session-harness-authority";
import { SessionDO } from "../../src/actors/agent-session";
import type { TransientWhatsAppTurnRequest } from "../../src/actors/session/types";
import { SessionExecutionAdmission } from "../../src/actors/session-execution-admission";
import {
  startActorRelocation,
  resumeActorRelocation,
} from "../../src/actors/actor-relocation";
import {
  readOrganisationPlacementMove,
  parseOrganisationPlacementMoveTarget,
} from "../../src/data/organisation-placement";
import {
  freezeOrganisationPlacementMove,
  freezeRegionalOrganisationPlacement,
} from "../../src/data/shared-rows/placement-row";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { network } from "./network";
import {
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  slackSimulator,
  slackEnvelope,
  signedSlackRequest,
  openRouterStream,
} from "./slack-journey-support";

it(
  "fences transient WhatsApp proposals at goal stops and timeout, preserves usage after restart, and retains no transcript",
  whatsappGoalJourney,
  60_000,
);

async function whatsappGoalJourney(context: TestContext): Promise<void> {
  await installSlackActorFixture();
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
  const slack = slackSimulator();
  const provider = new WhatsAppGoalProvider();
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
  );
  await sendBootstrap("first", ROOT_TS);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  const caseName = await actorName("case");
  const session = env.SESSION.getByName(await actorName("session"));
  const owner = env.CASE.getByName(caseName);
  const assignment = await runInDurableObject(session, readAssignment);
  const identity = {
    organisationId: ORGANISATION_ID,
    caseId: assignment.caseId,
  };
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "bootstrap_goal",
      expectedRevision: 0,
      command: {
        kind: "set",
        objective: "Prepare support",
        tokenBudget: 10000,
      },
    }),
  ).toMatchObject({ ok: true });
  await sendBootstrap("second", "1787500000.000002");
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);
  const base = await runInDurableObject(session, readTransientRequest);
  const evidence: unknown[] = [];
  for (const phase of ["complete", "limited", "timeout"] as const) {
    provider.phase = phase;
    provider.phaseCalls = 0;
    const before = await owner.readGoal(identity);
    if (!before.ok) throw new Error(before.error.code);
    expect(
      await owner.applyGoalCommand({
        ...identity,
        commandId: `wa_${phase}`,
        expectedRevision: before.value.revision,
        command: {
          kind: "set",
          objective: `Answer customer: ${phase}`,
          tokenBudget: phase === "limited" ? 10 : 1000,
        },
      }),
    ).toMatchObject({ ok: true });
    const request = requestForPhase(base, phase);
    const result = await session
      .runTransientWhatsAppTurn(request)
      .finally(provider.release.bind(provider));
    if (phase === "complete" && !result.ok)
      throw new Error(JSON.stringify(result));
    if (phase === "complete")
      expect(result).toMatchObject({
        ok: true,
        value: {
          outcome: { kind: "proposed", body: "WA_PRIVATE_REPLY" },
          modelUsage: { totalTokens: 50 },
        },
      });
    else expect(result.ok).toBe(false);
    if (phase === "limited")
      expect(result, JSON.stringify(result)).toMatchObject({
        error: {
          code: "transient_goal_stopped",
          modelUsage: { totalTokens: 25 },
        },
      });
    const goal = await owner.readGoal(identity);
    expect(goal).toMatchObject({
      ok: true,
      value: {
        goal: {
          tokensUsed: phase === "complete" ? 50 : phase === "limited" ? 25 : 0,
          unknownOperations: phase === "timeout" ? 1 : 0,
        },
      },
    });
    expect(provider.phaseCalls).toBe(phase === "complete" ? 2 : 1);
    expect(await runInDurableObject(session, storedContent)).not.toContain(
      "WA_PRIVATE_REPLY",
    );
    await evictDurableObject(session);
    await runDurableObjectAlarm(session);
    expect(await owner.readGoal(identity)).toEqual(goal);
    if (phase === "timeout") {
      if (!goal.ok) throw new Error(goal.error.code);
      expect(
        await owner.applyGoalCommand({
          ...identity,
          commandId: "resume_timeout",
          expectedRevision: goal.value.revision,
          command: { kind: "resume" },
        }),
      ).toMatchObject({ ok: false, error: { code: "goal_usage_pending" } });
    }
    evidence.push({ phase, result, goal, providerCalls: provider.phaseCalls });
  }
  Object.assign(context.task.meta, { whatsappGoalEvidence: evidence });
}

function requestForPhase(
  base: TransientWhatsAppTurnRequest,
  phase: string,
): TransientWhatsAppTurnRequest {
  return {
    ...base,
    turnId: `wa_${phase}`,
    inputId: `wa_input_${phase}`,
    maxWallMs: phase === "timeout" ? 1500 : 10000,
    manifest: { ...base.manifest, expiresAt: Date.now() + 10000 },
  };
}
function readAssignment(_actor: unknown, state: DurableObjectState) {
  const assignment = readCaseSessionAssignment(state.storage.sql);
  if (assignment === null) throw new Error("Missing assignment");
  return assignment;
}
function readTransientRequest(
  actor: unknown,
  state: DurableObjectState,
): TransientWhatsAppTurnRequest {
  const assignment = readAssignment(actor, state);
  const row = state.storage.sql
    .exec<{ lease: string }>(
      "SELECT json_extract(request_envelope, '$.lease') AS lease FROM actor_outbox WHERE effect_id LIKE 'goal_model_call:%' LIMIT 1",
    )
    .toArray()[0];
  if (row === undefined) throw new Error("Missing accepted lease");
  const lease = parsePersistedHarnessTurnLease(JSON.parse(row.lease));
  if (lease === null) throw new Error("Invalid accepted lease");
  return {
    requestingOrganisationId: ORGANISATION_ID,
    turnId: "wa_base",
    inputId: "wa_base",
    caseId: assignment.caseId,
    assignmentId: assignment.assignmentId,
    caseRevision: assignment.caseRevision,
    contentDigest: "a".repeat(64),
    workspaceRevision: assignment.context.workspaceRevision,
    contextBundleDigest: "b".repeat(64),
    requestAuthority: lease.requestAuthority,
    authorityPartitionDigest: assignment.authority.authorityPartitionDigest,
    harnessInstructions: "Read the support request and propose a reply.",
    turnPrompt: "Check the order.",
    allowanceTokens: 1000,
    maxWallMs: 10000,
    manifest: {
      caseId: assignment.caseId,
      integrationAccountId: "integration_wa_goal",
      customerWaId: "15550001111",
      businessDisplayPhoneNumber: "15550002222",
      messages: [
        {
          direction: "inbound",
          occurredAt: Date.now(),
          text: "Where is my order?",
        },
      ],
      maxReplyChars: 1000,
      expiresAt: Date.now() + 10000,
    },
  };
}
async function storedContent(
  _actor: unknown,
  state: DurableObjectState,
): Promise<string> {
  const tables = state.storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*'",
    )
    .toArray();
  const rows: unknown[] = [];
  for (const table of tables)
    rows.push({
      table: table.name,
      rows: state.storage.sql.exec(`SELECT * FROM "${table.name}"`).toArray(),
    });
  const values = await state.storage.list();
  return JSON.stringify({ tables: rows, values: [...values.entries()] });
}

class WhatsAppGoalProvider {
  phase: "bootstrap" | "complete" | "limited" | "timeout" = "bootstrap";
  phaseCalls = 0;
  private unfinishedResponse: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  respond(): Response {
    this.phaseCalls += 1;
    if (this.phase === "timeout")
      return new Response(
        new ReadableStream({
          start: this.beginUnfinishedResponse.bind(this),
          cancel: this.cancelUnfinishedResponse.bind(this),
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    const tool = this.phase !== "bootstrap" && this.phaseCalls === 1;
    return whatsappGoalResponse(tool);
  }

  private beginUnfinishedResponse(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    this.unfinishedResponse = controller;
    controller.enqueue(new TextEncoder().encode(": waiting for provider\n\n"));
  }

  private cancelUnfinishedResponse(): void {
    this.unfinishedResponse = null;
  }

  release(): void {
    this.unfinishedResponse?.close();
    this.unfinishedResponse = null;
  }
}

function whatsappGoalResponse(tool: boolean): Response {
  return openRouterStream([
    {
      id: "wa_goal",
      object: "chat.completion.chunk",
      created: 1787500000,
      model: "moonshotai/kimi-k3",
      choices: [
        {
          index: 0,
          delta: tool
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "wa_propose",
                    type: "function",
                    function: {
                      name: "whatsapp_reply_propose",
                      arguments: JSON.stringify({ body: "WA_PRIVATE_REPLY" }),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "Done" },
          finish_reason: null,
        },
      ],
    },
    {
      id: "wa_goal",
      object: "chat.completion.chunk",
      created: 1787500000,
      model: "moonshotai/kimi-k3",
      choices: [
        { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    },
  ]);
}

async function actorName(kind: string): Promise<string> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = ? AND lifecycle_status = 'active' ORDER BY reserved_at DESC",
    )
    .bind(ORGANISATION_ID, kind)
    .first<{ name: string }>();
  if (row === null) throw new Error("Missing Actor");
  return row.name;
}
async function sendBootstrap(id: string, ts: string): Promise<void> {
  const body = slackEnvelope({
    eventType: "app_mention",
    eventId: `EvWaGoal_${id}`,
    messageTs: ts,
    threadTs: ROOT_TS,
    text: "<@U0SATYR> Prepare support.",
  });
  expect(
    (await exports.default.fetch(await signedSlackRequest(body))).status,
  ).toBe(200);
}

it(
  "drains transient preparation, rejects frozen proposals, and preserves cancelled usage through repeated relocation",
  whatsappPlacementJourney,
  120_000,
);

type AdmissionPause = {
  phase: "armed" | "paused" | "released";
  readonly resolve: typeof SessionExecutionAdmission.resolve;
};
let admissionPause: AdmissionPause | null = null;

async function pauseTransientAdmission(
  ...args: Parameters<typeof SessionExecutionAdmission.resolve>
): ReturnType<typeof SessionExecutionAdmission.resolve> {
  const pause = admissionPause;
  if (pause === null) throw new Error("Missing admission pause");
  const admission = await pause.resolve(...args);
  if (admission !== null && pause.phase === "armed") {
    pause.phase = "paused";
    while (pause.phase === "paused") await scheduler.wait(5);
  }
  return admission;
}

class WhatsAppPlacementProvider {
  mode: "bootstrap" | "complete" | "paused" = "bootstrap";
  phase: "pending" | "paused" | "released" = "pending";
  calls = 0;
  aborted = false;

  respond(info: Parameters<HttpResponseResolver>[0]): Response {
    this.calls += 1;
    if (this.mode === "bootstrap") return whatsappGoalResponse(false);
    if (this.mode === "complete")
      return whatsappGoalResponse(this.calls % 2 === 1);
    this.phase = "paused";
    info.request.signal.addEventListener("abort", this.recordAbort.bind(this), {
      once: true,
    });
    return new Response(
      new ReadableStream<Uint8Array>({
        start: this.startPausedResponse.bind(this),
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }

  private async startPausedResponse(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    controller.enqueue(new TextEncoder().encode(": waiting for provider\n\n"));
    while (this.phase === "paused") await scheduler.wait(5);
    controller.enqueue(
      new Uint8Array(await whatsappGoalResponse(true).arrayBuffer()),
    );
    controller.close();
  }

  private recordAbort(): void {
    this.aborted = true;
  }

  release(): void {
    this.phase = "released";
  }
}

async function whatsappPlacementJourney({ task }: TestContext): Promise<void> {
  await installSlackActorFixture();
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
  const slack = slackSimulator();
  const provider = new WhatsAppPlacementProvider();
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
  );
  await sendBootstrap("placement_first", ROOT_TS);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  let session = env.SESSION.getByName(await actorName("session"));
  let owner = env.CASE.getByName(await actorName("case"));
  const assignment = await runInDurableObject(session, readAssignment);
  const identity = {
    organisationId: ORGANISATION_ID,
    caseId: assignment.caseId,
  };
  expect(
    await owner.applyGoalCommand({
      ...identity,
      commandId: "wa_placement_goal",
      expectedRevision: 0,
      command: {
        kind: "set",
        objective: "Answer support across relocation",
        tokenBudget: 10000,
      },
    }),
  ).toMatchObject({ ok: true });
  await sendBootstrap("placement_second", "1787500000.000002");
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);
  const base = await runInDurableObject(session, readTransientRequest);
  const evidence: unknown[] = [];
  provider.calls = 0;
  provider.mode = "complete";

  const pause: AdmissionPause = {
    phase: "armed",
    resolve: SessionExecutionAdmission.resolve,
  };
  admissionPause = pause;
  SessionExecutionAdmission.resolve = pauseTransientAdmission;
  let relocation: ReturnType<typeof resumeActorRelocation> | null = null;
  try {
    const preparation = session.runTransientWhatsAppTurn(
      requestForPhase(base, "preparation"),
    );
    await expect
      .poll(readAdmissionPhase.bind(null, pause), { timeout: 10000 })
      .toBe("paused");
    const move = await startWhatsAppRelocation("e2e-policy-snapshot");
    const marker = { completed: false };
    relocation = resumeActorRelocation({
      env,
      relocationId: move.relocationId,
      now: Date.now(),
    });
    void relocation.then(markRelocationComplete.bind(null, marker));
    await expect
      .poll(readTransientBarrier.bind(null, session), { timeout: 10000 })
      .toBe(1);
    expect(marker.completed).toBe(false);
    expect(await exportedTransientItems(move.relocationId)).toBe(0);
    expect(provider.calls).toBe(0);
    pause.phase = "released";
    expect(await preparation).toMatchObject({
      ok: false,
      error: {
        code: "session_placement_conflict",
        modelUsage: { modelCalls: 0 },
      },
    });
    expect(await relocation).toMatchObject({ ok: true });
    evidence.push({
      phase: "preparation",
      relocationId: move.relocationId,
      exportsWhilePaused: 0,
      providerStarts: provider.calls,
    });
  } finally {
    pause.phase = "released";
    await relocation;
    SessionExecutionAdmission.resolve = pause.resolve;
    admissionPause = null;
  }
  await evictDurableObject(session);
  expect(
    await session.runTransientWhatsAppTurn(
      requestForPhase(base, "retired_preparation"),
    ),
  ).toMatchObject({ ok: false, error: { code: "session_placement_conflict" } });
  session = env.SESSION.getByName(await actorName("session"));
  owner = env.CASE.getByName(await actorName("case"));
  const fresh = await session.runTransientWhatsAppTurn(
    requestForPhase(base, "fresh"),
  );
  expect(fresh, JSON.stringify(fresh)).toMatchObject({
    ok: true,
    value: { outcome: { kind: "proposed", body: "WA_PRIVATE_REPLY" } },
  });
  expect(provider.calls).toBe(2);
  expect(await runInDurableObject(session, storedContent)).not.toContain(
    "WA_PRIVATE_REPLY",
  );

  const beforeFreeze = await owner.readGoal(identity);
  if (!beforeFreeze.ok || beforeFreeze.value.kind !== "present")
    throw new Error("Missing live support goal");
  provider.calls = 0;
  provider.mode = "paused";
  provider.phase = "pending";
  const proposal = session.runTransientWhatsAppTurn(
    requestForPhase(base, "frozen_proposal"),
  );
  await expect
    .poll(readProviderPhase.bind(null, provider), { timeout: 10000 })
    .toBe("paused");
  const proposalMove = await startWhatsAppRelocation("e2e-policy-activation");
  const move = await readOrganisationPlacementMove({
    db: env.DB,
    organisationId: ORGANISATION_ID,
    sourcePlacementEpoch: 2,
    targetPlacementEpoch: 3,
  });
  if (
    !move.ok ||
    move.value.source.status !== "active" ||
    move.value.target.status !== "reserved"
  )
    throw new Error("Missing proposal relocation");
  const frozen = await freezeOrganisationPlacementMove(
    env.DB,
    {
      organisationId: ORGANISATION_ID,
      source: move.value.source,
      target: move.value.target,
    },
    { kind: "relocation", operationId: proposalMove.relocationId },
    Date.now(),
    fixtureDatabase(),
  );
  if (!frozen.ok) throw new Error(frozen.error.code);
  // Relocation freezes the source database's copy too.
  expect(
    await freezeRegionalOrganisationPlacement(fixtureDatabase(), frozen.value),
  ).toMatchObject({ ok: true });
  provider.release();
  const rejectedProposal = await proposal;
  expect(rejectedProposal, JSON.stringify(rejectedProposal)).toMatchObject({
    ok: false,
    error: {
      code: "session_placement_conflict",
    },
  });
  expect(provider.calls).toBe(1);
  const settledProposalGoal = await owner.readGoal(identity);
  expect(settledProposalGoal).toMatchObject({
    ok: true,
    value: {
      goal: {
        tokensUsed: beforeFreeze.value.goal.tokensUsed + 25,
        unknownOperations: 0,
      },
    },
  });
  expect(await runInDurableObject(session, storedContent)).not.toContain(
    "WA_PRIVATE_REPLY",
  );
  expect(
    await resumeActorRelocation({
      env,
      relocationId: proposalMove.relocationId,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true });
  await evictDurableObject(session);
  evidence.push({
    phase: "frozen_proposal",
    relocationId: proposalMove.relocationId,
    result: rejectedProposal,
    goal: settledProposalGoal,
    providerStarts: provider.calls,
  });
  session = env.SESSION.getByName(await actorName("session"));
  owner = env.CASE.getByName(await actorName("case"));

  provider.calls = 0;
  provider.phase = "pending";
  provider.aborted = false;
  const cancelled = session.runTransientWhatsAppTurn(
    requestForPhase(base, "cancelled"),
  );
  try {
    await expect
      .poll(readProviderPhase.bind(null, provider), { timeout: 10000 })
      .toBe("paused");
    const cancellationMove = await startWhatsAppRelocation("e2e-policy-kv");
    expect(
      await resumeActorRelocation({
        env,
        relocationId: cancellationMove.relocationId,
        now: Date.now(),
      }),
    ).toMatchObject({ ok: true });
    const result = await cancelled;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "session_placement_conflict" },
    });
    expect(provider.aborted).toBe(true);
    provider.release();
    const goal = await owner.readGoal(identity);
    if (!goal.ok) throw new Error(goal.error.code);
    expect(goal.value.goal).toMatchObject({ unknownOperations: 1 });
    expect(await runInDurableObject(session, storedContent)).not.toContain(
      "WA_PRIVATE_REPLY",
    );
    await evictDurableObject(owner);
    await evictDurableObject(session);
    expect(
      await session.runTransientWhatsAppTurn(
        requestForPhase(base, "retired_cancelled"),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "session_placement_conflict" },
    });
    session = env.SESSION.getByName(await actorName("session"));
    owner = env.CASE.getByName(await actorName("case"));
    await evictDurableObject(session);
    expect(await owner.readGoal(identity)).toEqual(goal);
    expect(
      await owner.applyGoalCommand({
        ...identity,
        commandId: "wa_relocated_resume",
        expectedRevision: goal.value.revision,
        command: { kind: "resume" },
      }),
    ).toMatchObject({ ok: false, error: { code: "goal_usage_pending" } });
    const unsettledRetry = await session.runTransientWhatsAppTurn(
      requestForPhase(base, "unsettled_retry"),
    );
    expect(unsettledRetry.ok).toBe(false);
    expect(provider.calls).toBe(1);
    evidence.push({
      phase: "cancelled",
      relocationId: cancellationMove.relocationId,
      result,
      goal,
      providerCancelled: true,
      sourceRetiredAfterEviction: true,
      targetRecoveryRetainedUnknownUsage: true,
      unsettledRetry,
    });
    Object.assign(task.meta, { transientPlacementEvidence: evidence });
  } finally {
    provider.release();
    await cancelled;
  }
}

function readAdmissionPhase(pause: AdmissionPause): string {
  return pause.phase;
}
function readProviderPhase(provider: WhatsAppPlacementProvider): string {
  return provider.phase;
}
function markRelocationComplete(marker: { completed: boolean }): void {
  marker.completed = true;
}

async function startWhatsAppRelocation(
  placementCellId:
    "e2e-policy-snapshot" | "e2e-policy-activation" | "e2e-policy-kv",
) {
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId,
    locationHint: "wnam",
  });
  if (!target.ok) throw new Error(target.error.code);
  const result = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target: target.value,
    now: Date.now(),
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function transientBarrier(_actor: unknown, state: DurableObjectState): number {
  return (
    state.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM state_object_cleanup_export_barrier",
      )
      .toArray()[0]?.count ?? 0
  );
}
function readTransientBarrier(
  session: DurableObjectStub<SessionDO>,
): Promise<number> {
  return runInDurableObject(session, transientBarrier);
}
async function exportedTransientItems(relocationId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
  )
    .bind(relocationId)
    .first<{ count: number }>();
  if (row === null) throw new Error("Missing relocation inventory");
  return row.count;
}

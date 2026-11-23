import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, vi, type TestContext } from "vitest";
import { isRecord, parseJsonOrNull } from "@purin-labs/std";

import {
  listPlacementActorRegistryEntries,
  type ActorRegistryEntry,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import { resumeActorRelocation } from "@purin-labs/actor-runtime/actors/actor-relocation";
import { actorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import { network } from "./network";
import { freezePlacement, type PlacementRace } from "./placement-race-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  SLACK_BOT_TOKEN,
  USER_ID,
  installSlackActorFixture,
  isStringRecord,
  slackPostFields,
  signedSlackRequest,
  slackEnvelope,
  replyingModel,
} from "./slack-journey-support";

type IngressDecision = {
  readonly eventId: string;
  readonly decidedBy: "connector" | "worker";
  readonly outcome: string;
  readonly detail: string;
};

type StatementRead = (...bindings: unknown[]) => Promise<unknown>;

type AdmissionPause = {
  phase: "armed" | "paused" | "released";
  readonly statement: { first: StatementRead };
  readonly first: StatementRead;
};

let admissionPause: AdmissionPause | null = null;

it(
  "decides reused Slack work inside the Connector and keeps every refusal the Worker made",
  connectorAdmissionJourney,
  60_000,
);
it(
  "refuses Slack work when the placement freezes during Connector admission and accepts its retry once on the target",
  frozenAdmissionJourney,
  60_000,
);

async function connectorAdmissionJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const model = replyingModel();
  const slack = recordingSlack();
  network.use(model.handler, slack.handler);
  const logs = vi.spyOn(console, "log");
  test.onTestFinished(logs.mockRestore);

  // First use: no Connector serves the placement, so the Worker decides and
  // activates one.
  const root = await sendSlack({
    eventType: "app_mention",
    eventId: "Ev55E_ROOT",
    messageTs: ROOT_TS,
    threadTs: ROOT_TS,
    text: "<@U0PANTRY> open this case",
  });
  expect(root).toEqual({ status: 200, durableMode: "case_accepted" });
  await expect.poll(slack.messageCount, { timeout: 15_000 }).toBe(1);

  // Reuse: the Connector decides beside the organisation's records.
  const followUp = await sendSlack({
    eventType: "message",
    eventId: "Ev55E_FOLLOWUP",
    messageTs: "1787500000.000002",
    threadTs: ROOT_TS,
    text: "continue in the same case",
  });
  expect(followUp).toEqual({ status: 200, durableMode: "case_accepted" });
  await expect.poll(slack.messageCount, { timeout: 15_000 }).toBe(2);
  expect(model.sessionIds[1]).toBe(model.sessionIds[0]);
  // The Worker resolves the bot credential itself after a Connector decision.
  await expect.poll(slack.statusCount, { timeout: 15_000 }).toBe(2);

  const connector = await activeConnector(fixture.connectorId, 1);
  await expect
    .poll(activeCaseWork.bind(null, connector), { timeout: 15_000 })
    .toBe(0);
  const replay = await sendSlack({
    eventType: "message",
    eventId: "Ev55E_FOLLOWUP",
    messageTs: "1787500000.000002",
    threadTs: ROOT_TS,
    text: "continue in the same case",
  });
  expect(replay).toEqual({ status: 200, durableMode: "case_accepted" });

  // A member revoked after the Case began is refused at the Connector.
  await fixtureDatabase()
    .prepare(
      `UPDATE service_role_grant SET status = 'revoked', revoked_at = ?
     WHERE organisation_id = ? AND person_id = 'person_e2e-slack-actor'`,
    )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
  const revoked = await sendSlack({
    eventType: "message",
    eventId: "Ev55E_REVOKED",
    messageTs: "1787500000.000003",
    threadTs: ROOT_TS,
    text: "one more thing",
  });
  expect(revoked).toEqual({ status: 200, durableMode: "rejected" });
  await fixtureDatabase()
    .prepare(
      `UPDATE service_role_grant SET status = 'active', revoked_at = NULL
     WHERE organisation_id = ?`,
    )
    .bind(ORGANISATION_ID)
    .run();

  // A new thread opens its Case through the same Connector decision.
  const secondThread = await sendSlack({
    eventType: "app_mention",
    eventId: "Ev55E_OTHER_ROOT",
    messageTs: "1787500100.000001",
    threadTs: "1787500100.000001",
    text: "<@U0PANTRY> open a second case",
  });
  expect(secondThread).toEqual({ status: 200, durableMode: "case_accepted" });
  await expect.poll(slack.messageCount, { timeout: 15_000 }).toBe(3);

  // An unlinked Slack identity is refused and prompted privately.
  await fixtureDatabase()
    .prepare("DELETE FROM external_identity_link WHERE organisation_id = ?")
    .bind(ORGANISATION_ID)
    .run();
  const unlinked = await sendSlack({
    eventType: "message",
    eventId: "Ev55E_UNLINKED",
    messageTs: "1787500000.000004",
    threadTs: ROOT_TS,
    text: "who am I",
  });
  expect(unlinked).toEqual({ status: 200, durableMode: "rejected" });
  await expect.poll(slack.promptCount, { timeout: 15_000 }).toBe(1);
  expect(slack.prompts[0]).toMatchObject({
    channel: CHANNEL_ID,
    user: USER_ID,
  });

  await expect
    .poll(activeCaseWork.bind(null, connector), { timeout: 15_000 })
    .toBe(0);
  const decisions = ingressDecisions(logs.mock.calls);
  expect(decisions).toEqual([
    decision("Ev55E_ROOT", "worker", "accepted", "accepted"),
    decision("Ev55E_FOLLOWUP", "connector", "accepted", "accepted"),
    decision("Ev55E_FOLLOWUP", "connector", "accepted", "duplicate"),
    decision(
      "Ev55E_REVOKED",
      "connector",
      "rejected",
      "organisation_membership_missing",
    ),
    decision("Ev55E_OTHER_ROOT", "connector", "accepted", "accepted"),
    decision(
      "Ev55E_UNLINKED",
      "connector",
      "identity_link_required",
      "identity_link_missing",
    ),
  ]);
  // Three accepted messages ran once each. Refused and replayed work ran none.
  expect(model.requests).toBe(3);
  expect(slack.messages).toHaveLength(3);
  const snapshot = await connector.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  expect(snapshot.value.caseWork).toEqual({ activeRows: 0, receiptRows: 3 });
  Object.assign(test.task.meta, {
    slackConnectorAdmission: {
      decisions,
      modelRequests: model.requests,
      deliveredMessages: slack.messages.length,
      progressStatuses: slack.statuses.length,
      identityPrompts: slack.prompts.length,
      connectorCaseWork: snapshot.value.caseWork,
    },
  });
}

async function frozenAdmissionJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const model = replyingModel();
  const slack = recordingSlack();
  network.use(model.handler, slack.handler);
  const logs = vi.spyOn(console, "log");
  test.onTestFinished(logs.mockRestore);

  const root = await sendSlack({
    eventType: "app_mention",
    eventId: "Ev55E_RACE_ROOT",
    messageTs: ROOT_TS,
    threadTs: ROOT_TS,
    text: "<@U0PANTRY> open this case",
  });
  expect(root).toEqual({ status: 200, durableMode: "case_accepted" });
  await expect.poll(slack.messageCount, { timeout: 15_000 }).toBe(1);
  const source = await activeConnector(fixture.connectorId, 1);
  await expect
    .poll(activeCaseWork.bind(null, source), { timeout: 15_000 })
    .toBe(0);

  const followUp = {
    eventType: "message",
    eventId: "Ev55E_RACE_FOLLOWUP",
    messageTs: "1787500000.000002",
    threadTs: ROOT_TS,
    text: "continue across the move",
  } as const;
  const race: PlacementRace = {
    organisationId: ORGANISATION_ID,
    phase: { kind: "waiting" },
  };
  const pause = installAdmissionPause();
  test.onTestFinished(restoreAdmission.bind(null, pause));
  let frozenReply: Promise<SlackReply> | null = null;
  try {
    // The Connector reads its records and an active fence in one statement,
    // then the placement freezes and the source exports before it writes.
    frozenReply = sendSlack(followUp);
    await expect
      .poll(admissionPhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    await freezePlacement(race);
    expect(await runInDurableObject(source, readExecutionBarrier)).toBe(1);
    pause.phase = "released";
    expect(await frozenReply).toEqual({ status: 503, durableMode: null });
  } finally {
    pause.phase = "released";
    restoreAdmission(pause);
    await frozenReply;
  }
  expect(
    await runInDurableObject(
      source,
      countCaseWork.bind(null, followUp.eventId),
    ),
  ).toBe(0);
  expect(model.requests).toBe(1);

  if (race.phase.kind !== "frozen") throw new Error("Placement did not freeze");
  await env.DB.prepare(
    "DROP TRIGGER IF EXISTS lifecycle_interrupt_publication",
  ).run();
  const completed = await resumeActorRelocation({
    env,
    relocationId: race.phase.relocationId,
    now: Date.now(),
  });
  expect(completed.ok).toBe(true);

  // Slack retries the unacknowledged event. The target Connector decides it.
  const retried = await sendSlack(followUp);
  expect(retried).toEqual({ status: 200, durableMode: "case_accepted" });
  await expect.poll(slack.messageCount, { timeout: 15_000 }).toBe(2);
  const target = await activeConnector(fixture.connectorId, 2);
  await expect
    .poll(activeCaseWork.bind(null, target), { timeout: 15_000 })
    .toBe(0);
  expect(
    await runInDurableObject(
      source,
      countCaseWork.bind(null, followUp.eventId),
    ),
  ).toBe(0);
  expect(
    await runInDurableObject(
      target,
      countCaseWork.bind(null, followUp.eventId),
    ),
  ).toBe(1);
  expect(model.requests).toBe(2);
  expect(slack.messages).toHaveLength(2);
  const decisions = ingressDecisions(logs.mock.calls);
  expect(decisions).toEqual([
    decision("Ev55E_RACE_ROOT", "worker", "accepted", "accepted"),
    decision(
      "Ev55E_RACE_FOLLOWUP",
      "worker",
      "retry",
      "organisation_placement_missing",
    ),
    decision("Ev55E_RACE_FOLLOWUP", "connector", "accepted", "accepted"),
  ]);
  Object.assign(test.task.meta, {
    slackConnectorAdmissionFreeze: {
      relocationId: race.phase.relocationId,
      decisions,
      sourceWorkForFrozenEvent: 0,
      targetWorkForFrozenEvent: 1,
      modelRequests: model.requests,
      deliveredMessages: slack.messages.length,
    },
  });
}

type SlackReply = {
  readonly status: number;
  readonly durableMode: string | null;
};

async function sendSlack(
  input: Parameters<typeof slackEnvelope>[0],
): Promise<SlackReply> {
  const response = await exports.default.fetch(
    await signedSlackRequest(slackEnvelope(input)),
  );
  const body: unknown = await response.json();
  return {
    status: response.status,
    durableMode:
      isRecord(body) && typeof body.durableMode === "string"
        ? body.durableMode
        : null,
  };
}

function decision(
  eventId: string,
  decidedBy: IngressDecision["decidedBy"],
  outcome: string,
  detail: string,
): IngressDecision {
  return { eventId, decidedBy, outcome, detail };
}

function ingressDecisions(
  calls: readonly (readonly unknown[])[],
): readonly IngressDecision[] {
  const decisions: IngressDecision[] = [];
  for (const [logged] of calls) {
    if (typeof logged !== "string") continue;
    const row = parseJsonOrNull(logged);
    if (!isRecord(row) || typeof row.event_id !== "string") continue;
    if (row.event === "integration_gateway.slack.case_accepted") {
      decisions.push({
        eventId: row.event_id,
        decidedBy: requiredDecider(row.admitted_by),
        outcome: "accepted",
        detail: String(row.disposition),
      });
    } else if (row.event === "integration_gateway.slack.case_unadmitted") {
      decisions.push({
        eventId: row.event_id,
        decidedBy: requiredDecider(row.decided_by),
        outcome: String(row.outcome),
        detail: String(row.detail),
      });
    }
  }
  return decisions;
}

function requiredDecider(value: unknown): IngressDecision["decidedBy"] {
  if (value !== "connector" && value !== "worker")
    throw new Error("Ingress trace names no deciding side");
  return value;
}

async function activeConnector(connectorId: string, placementEpoch: number) {
  const entries = await listPlacementActorRegistryEntries({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    placementEpoch,
  });
  if (!entries.ok) throw new Error(entries.error.code);
  const entry = entries.value.find(isConnector.bind(null, connectorId));
  if (entry === undefined) throw new Error("Connector registry entry missing");
  return actorStub(
    env.CONNECTOR,
    entry.physicalObjectName,
    entry.placement,
  );
}

function isConnector(connectorId: string, entry: ActorRegistryEntry): boolean {
  return (
    entry.identity.objectKind === "connector" &&
    entry.identity.logicalObjectId === connectorId
  );
}

async function activeCaseWork(
  connector: Awaited<ReturnType<typeof activeConnector>>,
): Promise<number> {
  const snapshot = await connector.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  return snapshot.value.caseWork.activeRows;
}

function countCaseWork(
  eventId: string,
  _actor: unknown,
  ctx: DurableObjectState,
): number {
  const active = ctx.storage.sql
    .exec(
      "SELECT COUNT(*) AS count FROM connector_case_work WHERE event_id = ?",
      eventId,
    )
    .toArray()[0]?.count;
  const settled = ctx.storage.sql
    .exec(
      "SELECT COUNT(*) AS count FROM connector_case_work_receipt WHERE event_id = ?",
      eventId,
    )
    .toArray()[0]?.count;
  return Number(active ?? 0) + Number(settled ?? 0);
}

function readExecutionBarrier(
  _actor: unknown,
  ctx: DurableObjectState,
): number {
  return Number(
    ctx.storage.sql
      .exec("SELECT COUNT(*) AS count FROM state_object_cleanup_export_barrier")
      .toArray()[0]?.count ?? 0,
  );
}

function installAdmissionPause(): AdmissionPause {
  // Every D1 statement in this runtime shares one class, so one patch
  // observes the Connector's read.
  const statement = Object.getPrototypeOf(env.DB.prepare("SELECT 1")) as {
    first: StatementRead;
  };
  const pause: AdmissionPause = {
    phase: "armed",
    statement,
    first: statement.first,
  };
  admissionPause = pause;
  statement.first = pauseAdmissionRead;
  return pause;
}

function restoreAdmission(pause: AdmissionPause): void {
  pause.statement.first = pause.first;
  admissionPause = null;
}

function admissionPhase(pause: AdmissionPause): AdmissionPause["phase"] {
  return pause.phase;
}

/**
 * Hold the Slack admission after the statement that read its records and the
 * regional fence returned an active placement. Every other read passes
 * through untouched.
 */
async function pauseAdmissionRead(
  this: unknown,
  ...bindings: unknown[]
): Promise<unknown> {
  const pause = admissionPause;
  if (pause === null) throw new Error("Missing admission pause");
  const fromSlackAdmission =
    new Error().stack?.includes("readSlackCaseIngressRow") === true;
  const row = await Reflect.apply(pause.first, this, bindings);
  if (row !== null && fromSlackAdmission && pause.phase === "armed") {
    pause.phase = "paused";
    while (pause.phase === "paused") await scheduler.wait(5);
  }
  return row;
}

function recordingSlack(): {
  readonly handler: ReturnType<typeof http.post>;
  readonly messages: Record<string, string>[];
  readonly statuses: Record<string, string>[];
  readonly prompts: Record<string, string>[];
  readonly messageCount: () => number;
  readonly statusCount: () => number;
  readonly promptCount: () => number;
} {
  const messages: Record<string, string>[] = [];
  const statuses: Record<string, string>[] = [];
  const prompts: Record<string, string>[] = [];
  return {
    messages,
    statuses,
    prompts,
    messageCount: countOf.bind(null, messages),
    statusCount: countOf.bind(null, statuses),
    promptCount: countOf.bind(null, prompts),
    handler: http.post(
      "https://slack.com/api/:method",
      respondToSlack.bind(null, { messages, statuses, prompts }),
    ),
  };
}

function countOf(rows: readonly unknown[]): number {
  return rows.length;
}

async function respondToSlack(
  recorded: {
    readonly messages: Record<string, string>[];
    readonly statuses: Record<string, string>[];
    readonly prompts: Record<string, string>[];
  },
  { params, request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  // Every Slack call must carry this organisation's bot credential.
  if (request.headers.get("authorization") !== `Bearer ${SLACK_BOT_TOKEN}`)
    return HttpResponse.json({ ok: false, error: "invalid_auth" });
  const body: unknown = slackPostFields(await request.json());
  if (!isStringRecord(body)) throw new Error("Slack request body is invalid");
  switch (params.method) {
    case "assistant.threads.setStatus":
      recorded.statuses.push(body);
      return HttpResponse.json({ ok: true });
    case "chat.postEphemeral":
      recorded.prompts.push(body);
      return HttpResponse.json({ ok: true });
    case "chat.postMessage":
      recorded.messages.push(body);
      return HttpResponse.json({
        ok: true,
        channel: body.channel,
        ts: `1787500001.${String(recorded.messages.length).padStart(6, "0")}`,
      });
    default:
      throw new Error(`Unexpected Slack method: ${String(params.method)}`);
  }
}

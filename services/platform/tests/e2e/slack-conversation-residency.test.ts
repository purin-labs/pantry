import { runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";

import { SessionDO } from "../../src/actors/agent-session";
import { CaseDO } from "../../src/actors/case";
import { ConnectorDO } from "../../src/actors/connector";
import {
  CONVERSATION_RESIDENCY_MS,
  CONVERSATION_RESIDENCY_TICK_MS,
  conversationResidencyStub,
  type ConversationResidencyInspection,
} from "../../src/actors/conversation-residency";
import { selectOrganisationPlacementDatabase } from "../../src/organisation-execution-scope";
import { network } from "./network";
import { freezePlacement } from "./placement-race-support";
import {
  ORGANISATION_ID,
  ROOT_TS,
  SLACK_BOT_TOKEN,
  installSlackActorFixture,
  isStringRecord,
  slackPostFields,
  openRouterText,
  requiredPlacement,
  signedSlackRequest,
  slackEnvelope,
} from "./slack-journey-support";

/**
 * After a Slack turn the Connector names its conversation's three Actors to
 * its residency Actor. That Actor calls each of them on its alarm, which keeps
 * them in memory for a reply that follows. It calls only an Actor that the
 * registry lists as active at the active placement.
 *
 * The journey runs two threads in one channel, so one Connector keeps two
 * Cases and two Sessions. It then freezes the organisation's placement for a
 * move: the next alarm must call no Actor and keep nothing.
 */
it(
  "keeps the Actors of two Slack conversations resident and stops when the placement freezes",
  residencyJourney,
  120_000,
);

type ResidentKind = "connector" | "case" | "session";

async function residencyJourney(test: TestContext): Promise<void> {
  await installSlackActorFixture();
  const delivered: Record<string, string>[] = [];
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", replyToModel),
    http.post(
      "https://slack.com/api/:method",
      respondToSlack.bind(null, delivered),
    ),
  );
  const calls: ResidentKind[] = [];
  test.onTestFinished(observeResidentCalls(calls));

  // One thread: its Connector, its Case and its Session are named.
  await sendTurn(delivered, "Ev55E_RESIDENT_ROOT", ROOT_TS, ROOT_TS);
  const firstThread = await activeActors();
  expect(kinds(firstThread)).toEqual(["case", "connector", "session"]);
  const connectorName = firstThread.find(isConnector)?.name;
  if (connectorName === undefined) throw new Error("Connector is not active");
  const residency = residencyStub(connectorName);
  const afterFirstTurn = await residentsOf(residency, 3);
  expect(names(afterFirstTurn)).toEqual(names(firstThread));
  expectResidencyWindow(afterFirstTurn);

  // A reply in the same thread names the same Actors and extends their time.
  await sendTurn(
    delivered,
    "Ev55E_RESIDENT_REPLY",
    "1787500000.000002",
    ROOT_TS,
  );
  const afterReply = await residentsOf(residency, 3);
  expect(names(afterReply)).toEqual(names(firstThread));
  for (const resident of afterReply.residents) {
    const before = afterFirstTurn.residents.find(
      (earlier) => earlier.physicalObjectName === resident.physicalObjectName,
    );
    expect(resident.residentUntil).toBeGreaterThanOrEqual(
      before?.residentUntil ?? Number.POSITIVE_INFINITY,
    );
  }

  // A second thread adds its own Case and Session under the same Connector.
  await sendTurn(
    delivered,
    "Ev55E_RESIDENT_SECOND_THREAD",
    "1787500400.000001",
    "1787500400.000001",
  );
  const bothThreads = await activeActors();
  expect(kinds(bothThreads)).toEqual([
    "case",
    "case",
    "connector",
    "session",
    "session",
  ]);
  const afterSecondThread = await residentsOf(residency, 5);
  expect(names(afterSecondThread)).toEqual(names(bothThreads));

  // The alarm calls each of the five Actors one time, and the Connector's
  // two warm slots, and arms the next call. An alarm of the journey's own
  // time can come first, so the calls of this one are counted from here.
  const callsBeforeAlarm = calls.length;
  expect(await runDurableObjectAlarm(residency)).toBe(true);
  const callsOfOneAlarm = calls.slice(callsBeforeAlarm).sort();
  expect(callsOfOneAlarm).toEqual([
    "case",
    "case",
    "case",
    "connector",
    "session",
    "session",
    "session",
  ]);
  const afterAlarm = await residency.inspect();
  expect(afterAlarm.residents).toHaveLength(5);
  expect(afterAlarm.warmSlots.map((slot) => slot.kind).sort()).toEqual([
    "case",
    "session",
  ]);
  expectResidencyWindow(afterAlarm);

  // A frozen placement ends the residency: no Actor is called or kept.
  await freezePlacement({
    organisationId: ORGANISATION_ID,
    phase: { kind: "waiting" },
  });
  const callsBeforeFreeze = calls.length;
  // The alarm of the journey's own time can run first. It decides the same.
  await runDurableObjectAlarm(residency);
  const afterFreeze = await residency.inspect();
  expect(calls).toHaveLength(callsBeforeFreeze);
  expect(afterFreeze).toEqual({ residents: [], warmSlots: [], alarmAt: null });

  Object.assign(test.task.meta, {
    conversationResidency: {
      residencyMs: CONVERSATION_RESIDENCY_MS,
      tickMs: CONVERSATION_RESIDENCY_TICK_MS,
      residentsAfterOneThread: afterFirstTurn.residents.length,
      residentsAfterTwoThreads: afterSecondThread.residents.length,
      callsOfOneAlarm,
      warmSlotsAfterAlarm: afterAlarm.warmSlots.length,
      residentsAfterFreeze: afterFreeze.residents.length,
      warmSlotsAfterFreeze: afterFreeze.warmSlots.length,
      alarmAfterFreeze: afterFreeze.alarmAt,
    },
  });
}

type ActiveActor = { readonly kind: string; readonly name: string };

function isConnector(actor: ActiveActor): boolean {
  return actor.kind === "connector";
}

function kinds(actors: readonly ActiveActor[]): string[] {
  return actors.map((actor) => actor.kind).sort();
}

function names(
  source: readonly ActiveActor[] | ConversationResidencyInspection,
): string[] {
  return "residents" in source
    ? source.residents.map((resident) => resident.physicalObjectName).sort()
    : source.map((actor) => actor.name).sort();
}

/** The Actors that the registry lists as active for the fixture organisation. */
async function activeActors(): Promise<ActiveActor[]> {
  const database = selectOrganisationPlacementDatabase(
    env,
    ORGANISATION_ID,
    requiredPlacement(),
  );
  if (!database.ok) throw new Error(database.error.code);
  const rows = await database.value
    .prepare(
      `SELECT object_kind AS kind, physical_object_name AS name
       FROM durable_object_registry
       WHERE organisation_id = ? AND lifecycle_status = 'active'
         AND object_kind IN ('connector', 'case', 'session')`,
    )
    .bind(ORGANISATION_ID)
    .all<ActiveActor>();
  return rows.results;
}

function residencyStub(connectorName: string) {
  const namespace = env.CONVERSATION_RESIDENCY;
  if (namespace === undefined) throw new Error("Residency binding is absent");
  return conversationResidencyStub(
    namespace,
    connectorName,
    requiredPlacement(),
  );
}

/** The Connector names its Actors after the Slack post, so the read waits. */
async function residentsOf(
  residency: ReturnType<typeof residencyStub>,
  count: number,
): Promise<ConversationResidencyInspection> {
  await expect
    .poll(async () => (await residency.inspect()).residents.length, {
      timeout: 10_000,
    })
    .toBe(count);
  return residency.inspect();
}

function expectResidencyWindow(inspection: ConversationResidencyInspection) {
  const now = Date.now();
  if (inspection.alarmAt === null) throw new Error("No alarm is armed");
  expect(inspection.alarmAt).toBeGreaterThan(now);
  expect(inspection.alarmAt).toBeLessThanOrEqual(
    now + CONVERSATION_RESIDENCY_TICK_MS,
  );
  for (const resident of inspection.residents) {
    expect(resident.residentUntil).toBeGreaterThan(
      now + CONVERSATION_RESIDENCY_MS - 60_000,
    );
    expect(resident.residentUntil).toBeLessThanOrEqual(
      now + CONVERSATION_RESIDENCY_MS,
    );
  }
}

async function sendTurn(
  delivered: readonly unknown[],
  eventId: string,
  messageTs: string,
  threadTs: string,
): Promise<void> {
  const expected = delivered.length + 1;
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: messageTs === threadTs ? "app_mention" : "message",
        eventId,
        messageTs,
        threadTs,
        text:
          messageTs === threadTs
            ? "<@U0SATYR> open this case"
            : "continue in the same case",
      }),
    ),
  );
  expect(response.status).toBe(200);
  await expect.poll(() => delivered.length, { timeout: 30_000 }).toBe(expected);
}

/** Record each residency call instead of the Actor's own empty method. */
function observeResidentCalls(calls: ResidentKind[]): () => void {
  const targets = [
    ["connector", ConnectorDO.prototype],
    ["case", CaseDO.prototype],
    ["session", SessionDO.prototype],
  ] as const;
  const originals = targets.map(([, prototype]) => prototype.keepResident);
  for (const [kind, prototype] of targets) {
    prototype.keepResident = function observed(): Promise<void> {
      calls.push(kind);
      return Promise.resolve();
    };
  }
  return function restore(): void {
    targets.forEach(([, prototype], index) => {
      const original = originals[index];
      if (original !== undefined) prototype.keepResident = original;
    });
  };
}

async function replyToModel({
  request,
}: Parameters<HttpResponseResolver>[0]): Promise<Response> {
  await request.json();
  return openRouterText(
    "Reply.",
    `chatcmpl_55e_resident_${crypto.randomUUID()}`,
  );
}

async function respondToSlack(
  delivered: Record<string, string>[],
  { params, request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${SLACK_BOT_TOKEN}`)
    return HttpResponse.json({ ok: false, error: "invalid_auth" });
  const body: unknown = slackPostFields(await request.json());
  if (!isStringRecord(body)) throw new Error("Slack request body is invalid");
  if (params.method === "chat.postMessage") {
    delivered.push(body);
    return HttpResponse.json({
      ok: true,
      channel: body.channel,
      ts: `1787500001.${String(delivered.length).padStart(6, "0")}`,
    });
  }
  return HttpResponse.json({ ok: true });
}

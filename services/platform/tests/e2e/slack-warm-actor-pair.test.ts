import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import { connectorActorStub } from "../../src/actors/actor-router";
import { CaseDO } from "../../src/actors/case";
import {
  conversationResidencyStub,
  type WarmSlotName,
} from "../../src/actors/conversation-residency";
import { network } from "./network";
import { registryEntries } from "./slack-follow-up-support";
import {
  ROOT_TS,
  SLACK_BOT_TOKEN,
  installSlackActorFixture,
  isStringRecord,
  slackPostFields,
  openRouterText,
  requiredPlacement,
  signedSlackRequest,
  slackEnvelope,
  shownSlackPost,
} from "./slack-journey-support";

/**
 * Plan 55F. A Connector keeps one warm Case and one warm Session in memory,
 * and a new thread runs on them instead of starting two new Durable Objects.
 *
 * The journey shows the outcomes that matter to an operator: every new
 * thread gets exactly one answer, two new threads at the same time share no
 * object, a thread whose first attempt is refused answers on its retry in the
 * same objects, and an object that older code started is never used.
 */
it(
  "runs new Slack threads on the Connector's warm Case and Session, one thread for each slot",
  warmActorPairJourney,
  180_000,
);

type Recorded = {
  modelRequests: number;
  readonly delivered: Record<string, string>[];
};

type ThreadNames = { readonly case: string; readonly session: string };

const ANSWER = "The thread is open.";
const FIRST_TS = ROOT_TS;
const PAIR_A_TS = "1787500100.000001";
const PAIR_B_TS = "1787500200.000001";
const REFUSED_TS = "1787500300.000001";
const AFTER_STALE_TS = "1787500400.000001";

async function warmActorPairJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const recorded = observeProviders();

  // The first thread finds no slot. It starts its own Case and Session, and
  // the Connector then names a slot pair to its residency Actor.
  await acceptSlack("Ev55F_FIRST", FIRST_TS, FIRST_TS);
  await deliveries(recorded, 1);
  const first = await threadNames(FIRST_TS);
  expect(isWarmName(first.case) || isWarmName(first.session)).toBe(false);
  const connector = await connectorOf(fixture.connectorId);
  const residency = residencyOf(await connectorName(fixture.connectorId));
  const firstSlots = await slotsOf(connector, residency, []);

  // Two new threads arrive together. Exactly one takes the slots. The other
  // starts its own Actors, or takes the next pair if the first thread named
  // it already. The two threads share no object, and each answers once.
  await Promise.all([
    acceptSlack("Ev55F_PAIR_A", PAIR_A_TS, PAIR_A_TS),
    acceptSlack("Ev55F_PAIR_B", PAIR_B_TS, PAIR_B_TS),
  ]);
  await deliveries(recorded, 3);
  const pairA = await threadNames(PAIR_A_TS);
  const pairB = await threadNames(PAIR_B_TS);
  const onSlots = [pairA, pairB].filter(sameNames.bind(null, firstSlots));
  const started = [pairA, pairB].filter(
    (names) => !isWarmName(names.case) && !isWarmName(names.session),
  );
  expect(onSlots).toHaveLength(1);
  expect(pairA.case).not.toBe(pairB.case);
  expect(pairA.session).not.toBe(pairB.session);
  expect(answersIn(recorded, PAIR_A_TS)).toBe(1);
  expect(answersIn(recorded, PAIR_B_TS)).toBe(1);
  const refilled = await slotsOf(connector, residency, [
    firstSlots,
    pairA,
    pairB,
  ]);

  // The Case refuses a new thread's first attempt. The retry finds the rows
  // that name the slots and answers in the same two objects.
  const refusals = refuseFirstAdmission(test);
  await acceptSlack("Ev55F_REFUSED", REFUSED_TS, REFUSED_TS);
  await expect
    .poll(caseWork.bind(null, connector), { timeout: 15_000 })
    .toEqual([{ state: "retryable", attempt: 1 }]);
  await expect
    .poll(deliveriesAfterAlarm.bind(null, connector, recorded), {
      timeout: 30_000,
      interval: 500,
    })
    .toBe(4);
  const refused = await threadNames(REFUSED_TS);
  expect(refused).toEqual(refilled);
  expect(answersIn(recorded, REFUSED_TS)).toBe(1);
  expect(refusals.count).toBe(1);
  const afterRetry = await slotsOf(connector, residency, [
    firstSlots,
    refilled,
  ]);

  // A deploy changed the schema of the code that started the current slots.
  // The next turn names new slots, and the next new thread runs on those.
  await runInDurableObject(connector, ageWarmSlots);
  await acceptSlack("Ev55F_REPLY", "1787500000.000002", FIRST_TS);
  await deliveries(recorded, 5);
  const fresh = await slotsOf(connector, residency, [
    firstSlots,
    refilled,
    afterRetry,
  ]);
  await acceptSlack("Ev55F_AFTER_STALE", AFTER_STALE_TS, AFTER_STALE_TS);
  await deliveries(recorded, 6);
  const afterStale = await threadNames(AFTER_STALE_TS);
  expect(afterStale).toEqual(fresh);
  const staleUsed = (await registryEntries()).some(
    (entry) =>
      entry.physicalObjectName === afterRetry.case ||
      entry.physicalObjectName === afterRetry.session,
  );
  expect(staleUsed).toBe(false);
  expect(recorded.modelRequests).toBe(6);

  Object.assign(test.task.meta, {
    slackWarmActorPair: {
      firstThread: first,
      firstSlots,
      concurrentThreads: { pairA, pairB },
      threadsOnSlots: onSlots.length,
      threadsStartedCold: started.length,
      refilledSlots: refilled,
      refusedThread: refused,
      refusals: refusals.count,
      staleSlots: afterRetry,
      freshSlots: fresh,
      threadAfterStale: afterStale,
      staleSlotUsed: staleUsed,
      answers: recorded.delivered.length,
      modelRequests: recorded.modelRequests,
    },
  });
}

function isWarmName(name: string): boolean {
  return name.includes(":warm:");
}

function sameNames(left: ThreadNames, right: ThreadNames): boolean {
  return left.case === right.case && left.session === right.session;
}

/** The model's answers posted in one thread. A notice is not an answer. */
function answersIn(recorded: Recorded, threadTs: string): number {
  return recorded.delivered.filter(
    (post) => post.thread_ts === threadTs && post.text === ANSWER,
  ).length;
}

/** The Case and Session names of one thread, from the registry. */
async function threadNames(threadTs: string): Promise<ThreadNames> {
  const key = threadTs.replaceAll(".", "_");
  const entries = (await registryEntries()).filter((entry) =>
    entry.identity.logicalObjectId.includes(key),
  );
  const caseEntry = entries.find(
    (entry) => entry.identity.objectKind === "case",
  );
  const sessionEntry = entries.find(
    (entry) => entry.identity.objectKind === "session",
  );
  if (caseEntry === undefined || sessionEntry === undefined)
    throw new Error(`Thread ${threadTs} has no Case and Session`);
  return {
    case: caseEntry.physicalObjectName,
    session: sessionEntry.physicalObjectName,
  };
}

/**
 * The slot pair in the Connector's store once it differs from every earlier
 * pair. The residency Actor then keeps the same pair in memory.
 */
async function slotsOf(
  connector: Awaited<ReturnType<typeof connectorOf>>,
  residency: ReturnType<typeof residencyOf>,
  earlier: readonly ThreadNames[],
): Promise<ThreadNames> {
  let current: ThreadNames | null = null;
  await expect
    .poll(
      async () => {
        current = pairOf(await runInDurableObject(connector, readStoredSlots));
        return (
          current !== null &&
          earlier.every(
            (pair) =>
              pair.case !== current?.case && pair.session !== current?.session,
          )
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  if (current === null) throw new Error("No warm slot pair");
  const stored: ThreadNames = current;
  await expect
    .poll(async () => pairOf((await residency.inspect()).warmSlots), {
      timeout: 15_000,
    })
    .toEqual(stored);
  return stored;
}

function readStoredSlots(
  _actor: unknown,
  ctx: DurableObjectState,
): WarmSlotName[] {
  return ctx.storage.sql
    .exec<{ physical_object_name: string; object_kind: string }>(
      "SELECT physical_object_name, object_kind FROM warm_actor_slot",
    )
    .toArray()
    .flatMap((row) =>
      row.object_kind === "case" || row.object_kind === "session"
        ? [
            {
              kind: row.object_kind,
              physicalObjectName: row.physical_object_name,
            },
          ]
        : [],
    );
}

function pairOf(slots: readonly WarmSlotName[]): ThreadNames | null {
  const caseSlot = slots.find((slot) => slot.kind === "case");
  const sessionSlot = slots.find((slot) => slot.kind === "session");
  return slots.length === 2 &&
    caseSlot !== undefined &&
    sessionSlot !== undefined
    ? {
        case: caseSlot.physicalObjectName,
        session: sessionSlot.physicalObjectName,
      }
    : null;
}

/** Record the slots as started by older code, as after a schema change. */
function ageWarmSlots(_actor: unknown, ctx: DurableObjectState): void {
  ctx.storage.sql.exec(
    "UPDATE warm_actor_slot SET schema_version = schema_version - 1",
  );
}

/** Make the Case refuse its first admission, as a competing trigger would. */
function refuseFirstAdmission(test: TestContext): { count: number } {
  const refusals = { count: 0 };
  const admit = CaseDO.prototype.prepareOngoingTurn;
  CaseDO.prototype.prepareOngoingTurn = async function refuseOnce(
    this: CaseDO,
    raw: unknown,
  ) {
    if (refusals.count === 0) {
      refusals.count += 1;
      return { ok: false, error: { code: "case_trigger_conflict" } };
    }
    return admit.call(this, raw);
  };
  test.onTestFinished(function restoreAdmission(): void {
    CaseDO.prototype.prepareOngoingTurn = admit;
  });
  return refusals;
}

function observeProviders(): Recorded {
  const recorded: Recorded = { modelRequests: 0, delivered: [] };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
    http.post(
      "https://slack.com/api/:method",
      respondToSlack.bind(null, recorded),
    ),
  );
  return recorded;
}

async function acceptSlack(
  eventId: string,
  messageTs: string,
  threadTs: string,
): Promise<void> {
  const root = messageTs === threadTs;
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: root ? "app_mention" : "message",
        eventId,
        messageTs,
        threadTs,
        text: root ? "<@U0PANTRY> open this thread" : "continue this thread",
      }),
    ),
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(isRecord(body) ? body.durableMode : null).toBe("case_accepted");
}

async function deliveries(recorded: Recorded, count: number): Promise<void> {
  await expect
    .poll(() => recorded.delivered.length, { timeout: 30_000 })
    .toBe(count);
}

async function connectorName(connectorId: string): Promise<string> {
  const entry = (await registryEntries()).find(
    (candidate) =>
      candidate.identity.objectKind === "connector" &&
      candidate.identity.logicalObjectId === connectorId,
  );
  if (entry === undefined) throw new Error("Connector registry entry missing");
  return entry.physicalObjectName;
}

async function connectorOf(connectorId: string) {
  return connectorActorStub(
    env.CONNECTOR,
    await connectorName(connectorId),
    requiredPlacement(),
  );
}

function residencyOf(connectorPhysicalObjectName: string) {
  const namespace = env.CONVERSATION_RESIDENCY;
  if (namespace === undefined) throw new Error("Residency binding is absent");
  return conversationResidencyStub(
    namespace,
    connectorPhysicalObjectName,
    requiredPlacement(),
  );
}

/** The Connector's unsettled Slack work, as its state and attempt. */
function caseWork(
  connector: Awaited<ReturnType<typeof connectorOf>>,
): Promise<readonly { readonly state: string; readonly attempt: number }[]> {
  return runInDurableObject(connector, readCaseWork);
}

function readCaseWork(
  _actor: unknown,
  ctx: DurableObjectState,
): readonly { readonly state: string; readonly attempt: number }[] {
  return ctx.storage.sql
    .exec<{ state_kind: string; attempt: number }>(
      "SELECT state_kind, attempt FROM connector_case_work ORDER BY created_at",
    )
    .toArray()
    .map((row) => ({ state: row.state_kind, attempt: row.attempt }));
}

/** Run the Connector's alarm, which claims the retry once it is due. */
async function deliveriesAfterAlarm(
  connector: Awaited<ReturnType<typeof connectorOf>>,
  recorded: Recorded,
): Promise<number> {
  await runDurableObjectAlarm(connector);
  return recorded.delivered.length;
}

async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  recorded.modelRequests += 1;
  await request.json();
  return openRouterText(ANSWER, `chatcmpl_55f_${crypto.randomUUID()}`);
}

async function respondToSlack(
  recorded: Recorded,
  { params, request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${SLACK_BOT_TOKEN}`)
    return HttpResponse.json({ ok: false, error: "invalid_auth" });
  const raw: unknown = slackPostFields(await request.json());
  if (!isStringRecord(raw)) throw new Error("Slack request body is invalid");
  const body = shownSlackPost(raw);
  if (params.method === "chat.postMessage") {
    recorded.delivered.push(body);
    return HttpResponse.json({
      ok: true,
      channel: body.channel,
      ts: `1787500001.${String(recorded.delivered.length).padStart(6, "0")}`,
    });
  }
  return HttpResponse.json({ ok: true });
}

import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import {
  listPlacementActorRegistryEntries,
  type ActorRegistryEntry,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import { actorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import {
  resumeActorRelocation,
  startActorRelocation,
} from "@purin-labs/actor-runtime/actors/actor-relocation";
import { SessionDO } from "../../src/actors/agent-session";
import { listHarnessCheckpointObjectKeys } from "@purin-labs/agent/actors/agent-session-harness-authority";
import { freezeOrganisationPlacementMove } from "@purin-labs/tenancy/data/shared-rows/placement-row";
import {
  parseOrganisationPlacementMoveTarget,
  readOrganisationPlacementMove,
} from "@purin-labs/tenancy/data/organisation-placement";
import { network } from "./network";
import {
  ORGANISATION_ID,
  ROOT_TS,
  SLACK_BOT_TOKEN,
  installSlackActorFixture,
  isStringRecord,
  slackPostFields,
  openRouterText,
  requiredSessionId,
  shownSlackPost,
  acceptSlack,
} from "./slack-journey-support";

/**
 * A turn completes when its checkpoint is in the Session's own storage. The
 * archive write follows the answer, and the next turn restores from the
 * Session's copy. These journeys stop and fail the archive write, refuse the
 * archive read, and remove or damage the Session's copy, and show what the
 * user and the next turn see.
 */
const ROOT_PROMPT = "open the delivery thread";
const REPLY_TS = "1787500100.000002";
const REPLY_PROMPT = "what did I ask first";
const SECOND_REPLY_TS = "1787500200.000003";
const SECOND_REPLY_PROMPT = "and what did you answer";
const ANSWERS = [
  "The thread is open.",
  "You asked to open the thread.",
  "I answered that you asked to open the thread.",
];

type Recorded = {
  /** Turn starts, model requests, Slack posts and archive writes, in order. */
  readonly timeline: string[];
  readonly modelBodies: string[];
  readonly delivered: Record<string, string>[];
};

type Publication = {
  readonly lifecycle: string;
  readonly stream: string;
  readonly publication: string;
  /** The turn of the latest checkpoint. */
  readonly latestTurn: string;
  /** The turns whose checkpoint payload the Session keeps. */
  readonly retainedTurns: readonly string[];
  readonly retainedBytes: number;
  readonly objectKeys: readonly string[];
};

type ArchiveWrite = (
  write: () => Promise<unknown>,
  state: DurableObjectState,
) => Promise<unknown>;

type ArchiveRead = (read: () => Promise<unknown>) => Promise<unknown>;

type Archive = {
  /** What a checkpoint write to the archive does. */
  write: ArchiveWrite;
  /** What a read of a checkpoint's archive object does. */
  read: ArchiveRead;
  started: number;
  finished: number;
  /** The checkpoint objects that a Session asked the archive for. */
  readonly reads: string[];
  /** The Session's state when a stopping write stopped it. */
  stoppedAt: Publication | null;
};

it(
  "posts one answer when the Session stops during the archive write, and publishes the checkpoint before the next turn",
  stoppedSessionJourney,
  90_000,
);

it(
  "posts the answer when the archive write fails, and publishes the checkpoint when the archive returns",
  failedArchiveWriteJourney,
  90_000,
);

it(
  "answers each reply from the Session's own checkpoint copy while the archive refuses every checkpoint read",
  localRestoreJourney,
  90_000,
);

it(
  "restores from the archive when a move leaves the Session no checkpoint copy and when the copy is damaged",
  relocatedSessionJourney,
  90_000,
);

async function stoppedSessionJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const recorded = observeProviders();
  const archive = interceptCheckpointArchive(test, recorded);
  archive.write = stopAfterPost.bind(null, archive, recorded);

  await acceptRoot();
  await expect
    .poll(countOf.bind(null, recorded.delivered), { timeout: 30_000 })
    .toBe(1);
  await expect
    .poll(stoppedState.bind(null, archive), { timeout: 15_000 })
    .toMatchObject({
      lifecycle: "sleeping",
      stream: "complete",
      publication: "upload_pending",
    });
  archive.write = passThrough;

  // The answer was posted before the Session stopped. Nothing posts it
  // again, and no model call repeats.
  const connector = await connectorOf(fixture.connectorId);
  await expect
    .poll(caseWorkAfterAlarm.bind(null, connector), {
      timeout: 30_000,
      interval: 500,
    })
    .toBe(0);
  expect(recorded.delivered).toHaveLength(1);
  expect(recorded.modelBodies).toHaveLength(1);
  const session = await threadSession();
  const stopped = await runInDurableObject(session.stub, readPublication);
  expect(stopped.publication).toBe("upload_pending");
  expect(await archivedKeys(stopped.objectKeys)).toEqual([]);

  // The stopped Session lost its alarm, so the next turn publishes the
  // checkpoint itself before it restores it.
  await acceptReply("Ev55E_ARCHIVE_STOP_REPLY");
  await expect
    .poll(countOf.bind(null, recorded.delivered), { timeout: 30_000 })
    .toBe(2);
  expect(recorded.delivered[1]).toMatchObject({
    thread_ts: ROOT_TS,
    text: ANSWERS[1],
  });
  expect(recorded.modelBodies[1]).toContain(ROOT_PROMPT);
  expect(recorded.modelBodies[1]).toContain(ANSWERS[0]);
  await expect
    .poll(caseWorkCount.bind(null, connector), { timeout: 15_000 })
    .toBe(0);
  const after = await runInDurableObject(session.stub, readPublication);
  expect(after.publication).toBe("published");
  expect(after.retainedTurns).toEqual([after.latestTurn]);
  expect(await archivedKeys(after.objectKeys)).toEqual(after.objectKeys);

  Object.assign(test.task.meta, {
    slackSessionStoppedDuringArchiveWrite: {
      stoppedAt: archive.stoppedAt,
      afterStop: stopped,
      after,
      deliveries: recorded.delivered.length,
      modelRequests: recorded.modelBodies.length,
      timeline: recorded.timeline,
    },
  });
}

async function failedArchiveWriteJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const recorded = observeProviders();
  const archive = interceptCheckpointArchive(test, recorded);
  archive.write = failWrite;

  await acceptRoot();
  await expect
    .poll(countOf.bind(null, recorded.delivered), { timeout: 30_000 })
    .toBe(1);
  expect(recorded.delivered[0]).toMatchObject({
    thread_ts: ROOT_TS,
    text: ANSWERS[0],
  });
  // The turn settles as a completed turn, with its checkpoint unpublished.
  const connector = await connectorOf(fixture.connectorId);
  await expect
    .poll(caseWorkCount.bind(null, connector), { timeout: 15_000 })
    .toBe(0);
  expect(recorded.delivered).toHaveLength(1);
  const session = await threadSession();
  const failed = await runInDurableObject(session.stub, readPublication);
  expect(failed).toMatchObject({
    lifecycle: "sleeping",
    stream: "complete",
    publication: "upload_pending",
  });
  expect(archive.started).toBeGreaterThan(0);
  expect(archive.finished).toBe(0);

  // The archive returns. The Session's alarm publishes the checkpoint.
  archive.write = passThrough;
  await expect
    .poll(publicationAfterAlarm.bind(null, session.stub), {
      timeout: 30_000,
      interval: 500,
    })
    .toBe("published");
  const published = await runInDurableObject(session.stub, readPublication);
  expect(published.retainedTurns).toEqual([published.latestTurn]);
  expect(await archivedKeys(published.objectKeys)).toEqual(
    published.objectKeys,
  );

  await acceptReply("Ev55E_ARCHIVE_FAIL_REPLY");
  await expect
    .poll(countOf.bind(null, recorded.delivered), { timeout: 30_000 })
    .toBe(2);
  expect(recorded.modelBodies[1]).toContain(ROOT_PROMPT);
  expect(recorded.modelBodies[1]).toContain(ANSWERS[0]);

  Object.assign(test.task.meta, {
    slackArchiveWriteFailed: {
      failed,
      failedWrites: archive.started - archive.finished,
      published,
      deliveries: recorded.delivered.length,
      timeline: recorded.timeline,
    },
  });
}

/**
 * Three turns in one thread. The archive takes each checkpoint write and
 * refuses each checkpoint read, so a reply is answered only if its turn
 * restores from the Session's own copy.
 */
async function localRestoreJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const recorded = observeProviders();
  const archive = interceptCheckpointArchive(test, recorded);
  archive.read = refuseRead;

  await acceptRoot();
  const connector = await connectorOf(fixture.connectorId);
  const first = await settledTurn(recorded, connector, 1);
  expect(first.retainedTurns).toEqual([first.latestTurn]);

  await acceptReply("Ev55E_LOCAL_RESTORE_REPLY_1");
  const second = await settledTurn(recorded, connector, 2);
  expect(recorded.delivered[1]).toMatchObject({
    thread_ts: ROOT_TS,
    text: ANSWERS[1],
  });
  expect(recorded.modelBodies[1]).toContain(ROOT_PROMPT);
  expect(recorded.modelBodies[1]).toContain(ANSWERS[0]);
  expect(second.latestTurn).not.toBe(first.latestTurn);
  expect(second.retainedTurns).toEqual([second.latestTurn]);

  await acceptReply(
    "Ev55E_LOCAL_RESTORE_REPLY_2",
    SECOND_REPLY_TS,
    SECOND_REPLY_PROMPT,
  );
  const third = await settledTurn(recorded, connector, 3);
  expect(recorded.delivered[2]).toMatchObject({
    thread_ts: ROOT_TS,
    text: ANSWERS[2],
  });
  expect(recorded.modelBodies[2]).toContain(ROOT_PROMPT);
  expect(recorded.modelBodies[2]).toContain(REPLY_PROMPT);
  expect(recorded.modelBodies[2]).toContain(ANSWERS[1]);
  expect(third.retainedTurns).toEqual([third.latestTurn]);

  // No turn asked the archive for a checkpoint. The archive still holds each
  // one: it is the long-term copy.
  expect(archive.reads).toEqual([]);
  expect(archive.finished).toBe(3);
  expect(third.objectKeys).toHaveLength(3);
  expect(await archivedKeys(third.objectKeys)).toEqual(third.objectKeys);

  Object.assign(test.task.meta, {
    slackRestoreFromSessionCopy: {
      first,
      second,
      third,
      archiveReads: archive.reads.length,
      archiveWrites: archive.finished,
      timeline: recorded.timeline,
    },
  });
}

/**
 * A relocation exports the Session's tables and copies its archive objects.
 * The payload copy is neither: the target Session starts without one, reads
 * the archive for its first restore, and keeps a copy from then on. A Session
 * with a damaged copy must not use it, and reads the archive again.
 */
async function relocatedSessionJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const recorded = observeProviders();
  const archive = interceptCheckpointArchive(test, recorded);

  await acceptRoot();
  const first = await settledTurn(
    recorded,
    await connectorOf(fixture.connectorId),
    1,
  );
  expect(first.retainedTurns).toEqual([first.latestTurn]);

  const relocationId = await freezePlacement();
  const moved = await resumeActorRelocation({
    env,
    relocationId,
    now: Date.now(),
  });
  if (!moved.ok) throw new Error(JSON.stringify(moved.error));
  const target = await threadSession(2);
  const imported = await runInDurableObject(target.stub, readPublication);
  expect(imported).toMatchObject({
    lifecycle: "sleeping",
    publication: "published",
    latestTurn: first.latestTurn,
    retainedTurns: [],
    retainedBytes: 0,
  });
  expect(await archivedKeys(imported.objectKeys)).toEqual(first.objectKeys);
  const readsBeforeReply = archive.reads.length;

  await acceptReply("Ev55E_RELOCATED_REPLY");
  const second = await settledTurn(
    recorded,
    await connectorOf(fixture.connectorId, 2),
    2,
    2,
  );
  expect(recorded.delivered[1]).toMatchObject({
    thread_ts: ROOT_TS,
    text: ANSWERS[1],
  });
  expect(recorded.modelBodies[1]).toContain(ROOT_PROMPT);
  expect(recorded.modelBodies[1]).toContain(ANSWERS[0]);
  expect(archive.reads.slice(readsBeforeReply)).toEqual(first.objectKeys);
  expect(second.retainedTurns).toEqual([second.latestTurn]);

  await runInDurableObject(target.stub, damageRetainedPayload);
  const readsBeforeDamagedReply = archive.reads.length;
  await acceptReply(
    "Ev55E_DAMAGED_COPY_REPLY",
    SECOND_REPLY_TS,
    SECOND_REPLY_PROMPT,
  );
  const third = await settledTurn(
    recorded,
    await connectorOf(fixture.connectorId, 2),
    3,
    2,
  );
  expect(recorded.delivered[2]).toMatchObject({
    thread_ts: ROOT_TS,
    text: ANSWERS[2],
  });
  expect(recorded.modelBodies[2]).toContain(REPLY_PROMPT);
  expect(recorded.modelBodies[2]).toContain(ANSWERS[1]);
  // The restore read the second turn's checkpoint from the archive.
  const damagedCopyReads = archive.reads.slice(readsBeforeDamagedReply);
  expect([...first.objectKeys, ...damagedCopyReads].toSorted()).toEqual(
    second.objectKeys.toSorted(),
  );
  expect(third.retainedTurns).toEqual([third.latestTurn]);

  Object.assign(test.task.meta, {
    slackRestoreFromArchive: {
      relocationId,
      first,
      imported,
      second,
      third,
      archiveReadsAfterMove: readsBeforeDamagedReply - readsBeforeReply,
      archiveReadsForDamagedCopy: damagedCopyReads.length,
      timeline: recorded.timeline,
    },
  });
}

/** Start a move of the organisation to another placement, and freeze it. */
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
  return started.value.relocationId;
}

/**
 * Wait until the thread has this many answers, the Connector has settled the
 * turn and the Session has published its checkpoint.
 */
async function settledTurn(
  recorded: Recorded,
  connector: Awaited<ReturnType<typeof connectorOf>>,
  answers: number,
  placementEpoch = 1,
): Promise<Publication> {
  await expect
    .poll(countOf.bind(null, recorded.delivered), { timeout: 30_000 })
    .toBe(answers);
  await expect
    .poll(caseWorkCount.bind(null, connector), { timeout: 15_000 })
    .toBe(0);
  const session = await threadSession(placementEpoch);
  await expect
    .poll(publicationOf.bind(null, session.stub), { timeout: 15_000 })
    .toBe("published");
  return runInDurableObject(session.stub, readPublication);
}

async function publicationOf(
  session: Awaited<ReturnType<typeof threadSession>>["stub"],
): Promise<string> {
  return (await runInDurableObject(session, readPublication)).publication;
}

/** Replace the kept payload with bytes of the same length. */
function damageRetainedPayload(_actor: unknown, state: DurableObjectState) {
  state.storage.sql.exec(
    "UPDATE session_harness_checkpoint_payload SET payload = zeroblob(length(payload))",
  );
}

/**
 * Route every checkpoint write of a Session through `archive.write`, and
 * every checkpoint read through `archive.read`. The Session's archive binding
 * is wrapped when a turn starts and when the Session accepts a checkpoint,
 * which is before it reads or writes one.
 */
function interceptCheckpointArchive(
  test: TestContext,
  recorded: Recorded,
): Archive {
  const archive: Archive = {
    write: passThrough,
    read: passThrough,
    started: 0,
    finished: 0,
    reads: [],
    stoppedAt: null,
  };
  const wrapped = new WeakSet<object>();
  function wrapOnce(session: SessionDO): void {
    if (wrapped.has(session)) return;
    wrapped.add(session);
    wrapArchive(session, archive, recorded);
  }
  const start = SessionDO.prototype.startCanonicalEmbeddedHarnessTextTurn;
  SessionDO.prototype.startCanonicalEmbeddedHarnessTextTurn =
    function recordStart(this: SessionDO, ...args: Parameters<typeof start>) {
      wrapOnce(this);
      recorded.timeline.push(`turn start ${turnStarts(recorded) + 1}`);
      return start.apply(this, args);
    };
  // A Session that wakes with no new turn reads its tools in its
  // constructor, before it reads the archive. The wrap is on the Actor, so
  // the modules of the Session see the same archive.
  const prototype = SessionDO.prototype as unknown as {
    sessionTools: (this: SessionDO) => unknown;
  };
  const tools = prototype.sessionTools;
  prototype.sessionTools = function toolsAndWrap(this: SessionDO) {
    wrapOnce(this);
    return tools.call(this);
  };
  test.onTestFinished(function restoreSession(): void {
    SessionDO.prototype.startCanonicalEmbeddedHarnessTextTurn = start;
    prototype.sessionTools = tools;
  });
  return archive;
}

function wrapArchive(actor: object, archive: Archive, recorded: Recorded) {
  const actorEnv: unknown = Reflect.get(actor, "env");
  const state: unknown = Reflect.get(actor, "ctx");
  if (!isRecord(actorEnv) || !isRecord(state))
    throw new Error("Session has no environment");
  const observed = Object.create(actorEnv);
  Object.defineProperty(observed, "ARCHIVE", {
    value: new Proxy(env.ARCHIVE, {
      get: archiveProperty.bind(
        null,
        archive,
        recorded,
        state as unknown as DurableObjectState,
      ),
    }),
  });
  Object.defineProperty(actor, "env", { value: observed, configurable: true });
}

function archiveProperty(
  archive: Archive,
  recorded: Recorded,
  state: DurableObjectState,
  target: R2Bucket,
  key: string | symbol,
): unknown {
  const value = Reflect.get(target, key, target);
  if (typeof value !== "function") return value;
  if (key === "put")
    return writeCheckpoint.bind(null, archive, recorded, state, target, value);
  if (key === "get")
    return readCheckpoint.bind(null, archive, recorded, target, value);
  return value.bind(target);
}

async function readCheckpoint(
  archive: Archive,
  recorded: Recorded,
  bucket: R2Bucket,
  get: Function,
  ...args: unknown[]
): Promise<unknown> {
  const key = args[0];
  if (typeof key !== "string" || !key.startsWith("harness-checkpoints/"))
    return Reflect.apply(get, bucket, args);
  archive.reads.push(key);
  recorded.timeline.push(`archive read ${archive.reads.length}`);
  return archive.read(Reflect.apply.bind(null, get, bucket, args));
}

async function writeCheckpoint(
  archive: Archive,
  recorded: Recorded,
  state: DurableObjectState,
  bucket: R2Bucket,
  put: Function,
  ...args: unknown[]
): Promise<unknown> {
  const key = args[0];
  if (typeof key !== "string" || !key.startsWith("harness-checkpoints/"))
    return Reflect.apply(put, bucket, args);
  archive.started += 1;
  const write = archive.started;
  recorded.timeline.push(`archive write ${write} started`);
  try {
    const result = await archive.write(
      Reflect.apply.bind(null, put, bucket, args),
      state,
    );
    archive.finished += 1;
    recorded.timeline.push(`archive write ${write} done`);
    return result;
  } catch (error) {
    recorded.timeline.push(`archive write ${write} failed`);
    throw error;
  }
}

function passThrough(write: () => Promise<unknown>): Promise<unknown> {
  return write();
}

async function failWrite(): Promise<unknown> {
  throw new Error("The archive is unavailable");
}

async function refuseRead(): Promise<unknown> {
  throw new Error("The archive refuses the read");
}

/**
 * Stop the Session when its answer is in Slack and the archive holds no
 * checkpoint. The alarm is removed first, so only the next message wakes the
 * Session.
 */
async function stopAfterPost(
  archive: Archive,
  recorded: Recorded,
  _write: () => Promise<unknown>,
  state: DurableObjectState,
): Promise<unknown> {
  while (recorded.delivered.length === 0) await scheduler.wait(20);
  await state.storage.deleteAlarm();
  await state.storage.sync();
  archive.stoppedAt = readPublication(null, state);
  return state.abort("The Session stopped during the archive write");
}

function stoppedState(archive: Archive): Publication | null {
  return archive.stoppedAt;
}

function turnStarts(recorded: Recorded): number {
  return recorded.timeline.filter(isTurnStart).length;
}

function isTurnStart(entry: string): boolean {
  return entry.startsWith("turn start ");
}

function readPublication(
  _actor: unknown,
  state: DurableObjectState,
): Publication {
  const sql = state.storage.sql;
  return {
    lifecycle: sql
      .exec<{ lifecycle_kind: string }>(
        "SELECT lifecycle_kind FROM session_meta",
      )
      .one().lifecycle_kind,
    stream: sql
      .exec<{ state: string }>(
        "SELECT state FROM session_turn_stream ORDER BY started_at DESC LIMIT 1",
      )
      .one().state,
    publication: sql
      .exec<{ upload_state: string }>(
        "SELECT upload_state FROM session_harness_checkpoint ORDER BY committed_at DESC, last_sequence DESC LIMIT 1",
      )
      .one().upload_state,
    latestTurn: sql
      .exec<{ turn_id: string }>(
        "SELECT turn_id FROM session_harness_checkpoint ORDER BY committed_at DESC, last_sequence DESC LIMIT 1",
      )
      .one().turn_id,
    retainedTurns: sql
      .exec<{ turn_id: string }>(
        "SELECT DISTINCT turn_id FROM session_harness_checkpoint_payload ORDER BY turn_id",
      )
      .toArray()
      .map(turnIdOf),
    retainedBytes: sql
      .exec<{ bytes: number }>(
        "SELECT coalesce(sum(length(payload)), 0) AS bytes FROM session_harness_checkpoint_payload",
      )
      .one().bytes,
    objectKeys: listHarnessCheckpointObjectKeys(sql),
  };
}

function turnIdOf(row: { turn_id: string }): string {
  return row.turn_id;
}

/** Run the Session's alarm, then read whether its checkpoint is published. */
async function publicationAfterAlarm(
  session: Awaited<ReturnType<typeof threadSession>>["stub"],
): Promise<string> {
  await runDurableObjectAlarm(session);
  return (await runInDurableObject(session, readPublication)).publication;
}

/** The keys of this list that the archive holds. */
async function archivedKeys(keys: readonly string[]): Promise<string[]> {
  const archived: string[] = [];
  for (const key of keys) {
    if ((await env.ARCHIVE.head(key)) !== null) archived.push(key);
  }
  return archived;
}

function observeProviders(): Recorded {
  const recorded: Recorded = { timeline: [], modelBodies: [], delivered: [] };
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

function acceptRoot(): Promise<void> {
  return acceptSlack({
    eventType: "app_mention",
    eventId: "Ev55E_ARCHIVE_ROOT",
    messageTs: ROOT_TS,
    threadTs: ROOT_TS,
    text: `<@U0PANTRY> ${ROOT_PROMPT}`,
  });
}

function acceptReply(
  eventId: string,
  messageTs = REPLY_TS,
  text = REPLY_PROMPT,
): Promise<void> {
  return acceptSlack({
    eventType: "message",
    eventId,
    messageTs,
    threadTs: ROOT_TS,
    text,
  });
}

async function registryEntries(
  placementEpoch: number,
): Promise<readonly ActorRegistryEntry[]> {
  const entries = await listPlacementActorRegistryEntries({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    placementEpoch,
  });
  if (!entries.ok) throw new Error(entries.error.code);
  return entries.value;
}

async function connectorOf(connectorId: string, placementEpoch = 1) {
  const entry = (await registryEntries(placementEpoch)).find(
    function isConnector(candidate) {
      return (
        candidate.identity.objectKind === "connector" &&
        candidate.identity.logicalObjectId === connectorId
      );
    },
  );
  if (entry === undefined) throw new Error("Connector registry entry missing");
  return actorStub(env.CONNECTOR, entry.physicalObjectName, entry.placement);
}

/** The thread's one Session. */
async function threadSession(placementEpoch = 1) {
  const entry = (await registryEntries(placementEpoch)).find(
    function isSession(candidate) {
      return candidate.identity.objectKind === "session";
    },
  );
  if (entry === undefined) throw new Error("Session registry entry missing");
  return {
    sessionId: requiredSessionId(entry.identity.logicalObjectId),
    stub: actorStub(env.SESSION, entry.physicalObjectName, entry.placement),
  };
}

/** The number of Slack messages the Connector has not settled. */
function caseWorkCount(
  connector: Awaited<ReturnType<typeof connectorOf>>,
): Promise<number> {
  return runInDurableObject(connector, countCaseWork);
}

function countCaseWork(_actor: unknown, ctx: DurableObjectState): number {
  return ctx.storage.sql
    .exec<{ n: number }>("SELECT count(*) AS n FROM connector_case_work")
    .one().n;
}

/** Run the Connector's alarm, which claims a retry once it is due. */
async function caseWorkAfterAlarm(
  connector: Awaited<ReturnType<typeof connectorOf>>,
): Promise<number> {
  await runDurableObjectAlarm(connector);
  return caseWorkCount(connector);
}

function countOf(rows: readonly unknown[]): number {
  return rows.length;
}

async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  recorded.modelBodies.push(JSON.stringify(await request.json()));
  const turn = recorded.modelBodies.length;
  recorded.timeline.push(`model request ${turn}`);
  return openRouterText(
    ANSWERS[turn - 1] ?? "No further answer.",
    `chatcmpl_55e_archive_${turn}`,
  );
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
    recorded.timeline.push(`slack post ${recorded.delivered.length}`);
    return HttpResponse.json({
      ok: true,
      channel: body.channel,
      ts: `1787500950.${String(recorded.delivered.length).padStart(6, "0")}`,
    });
  }
  return HttpResponse.json({ ok: true });
}

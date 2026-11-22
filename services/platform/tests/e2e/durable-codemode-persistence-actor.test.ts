import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { readImportedCanonicalSession } from "../../src/actors/agent-session-canonical";
import { readLatestHarnessCheckpoint } from "../../src/actors/agent-session-harness-authority";
import {
  resumeActorRelocation,
  startActorRelocation,
} from "../../src/actors/actor-relocation";
import { parseOrganisationId, parseSessionId } from "@purin-labs/kernel/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  DISCOVER_INTEGRATION_LIST,
  READ_DATA,
  TURN_FAILED_NOTICE,
  connectorActor,
  lastToolText,
  makeCaseWorkDue,
  messageText,
  organisationActor,
  readAcceptedText,
  readAdmitted,
  readExecutionRecord,
  readGovernorLedger,
  readLifecycleKind,
  readOrganisationLedger,
  readTurnStreams,
  scriptReply,
  sendThreadMessage,
  sessionObjectName,
  startScriptTurn,
} from "./durable-codemode-journey-support";
import { ORGANISATION_ID } from "./slack-journey-support";
import { moveTarget } from "./placement-move-support";

// Plan 50A, Phase D. These journeys run through the Slack Actor path with
// the real Session, Organisation, and governor Actors, the Pi harness, and
// the sandbox Worker. They prove what a Session keeps of its scripts across
// a relocation, and what its deletion removes. The model replies are
// controlled.

const FOLLOW_UP_TS = "1787500000.000003";
/** A script that keeps a name from a read in the store. */
const KEEP_NAMES_SCRIPT =
  "const list = JSON.parse(await tools.integration_list({})); store('names', list.accounts.map((account) => account.displayName)); text({ kept: list.accounts.length });";
const READ_NAMES_SCRIPT = "text({ names: load('names') });";

it("relocates a Session with the values, the receipt, and the accounting of its script", async (test) => {
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeRelocated",
    replies: [
      DISCOVER_INTEGRATION_LIST,
      scriptReply(KEEP_NAMES_SCRIPT),
      { text: "FIRST_DONE" },
      scriptReply(READ_NAMES_SCRIPT),
      { text: "SECOND_DONE" },
    ],
  });
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 20_000 })
    .toBe(1);
  const source = await runInDurableObject(journey.session, readCheckpoint);
  const sourceLedger = await readOrganisationLedger(journey.organisation);
  const governorLedger = await runInDurableObject(
    journey.governor,
    readGovernorLedger,
  );
  expect(sourceLedger.reservations).toMatchObject([{ state: "settled" }]);

  const relocation = await relocateOrganisation();
  expect(relocation).toMatchObject({ ok: true, value: { status: "retained" } });
  const targetName = (await sessionObjectName()).name;
  expect(targetName).not.toBe(journey.sessionName);
  const target = env.SESSION.getByName(targetName);
  // The Session of the target holds the same contract and the receipt of
  // the script. The ledger of the target holds the same accounting.
  const moved = await runInDurableObject(target, readCheckpoint);
  expect(moved.sessionId).toBe(source.sessionId);
  expect(moved.modelRoute).toEqual(source.modelRoute);
  expect(moved.checkpoint.blob).toEqual(source.checkpoint.blob);
  expect(await runInDurableObject(target, readAcceptedText)).toContain(
    READ_DATA,
  );
  expect(await readOrganisationLedger(await organisationActor())).toEqual(
    sourceLedger,
  );
  expect(
    await runInDurableObject(journey.governor, readGovernorLedger),
  ).toEqual(governorLedger);

  // A script of the next turn reads the stored values at the target.
  await sendThreadMessage(
    "message",
    "EvDurableCodemodeRelocatedNext",
    FOLLOW_UP_TS,
    "Report the names that the earlier script kept.",
  );
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 20_000 })
    .toBe(2);
  expect(journey.slack.messages.map(messageText)).toEqual([
    "FIRST_DONE",
    "SECOND_DONE",
  ]);
  expect(journey.requests).toHaveLength(5);
  const names = lastToolText(journey.requests[4]);
  expect(names).toContain(READ_DATA);
  const targetLedger = await readOrganisationLedger(await organisationActor());
  expect(targetLedger.reservations).toMatchObject([
    { state: "settled" },
    { state: "settled" },
  ]);

  Object.assign(test.task.meta, {
    evidence: {
      relocation: relocation.ok ? relocation.value : relocation.error,
      sessionActors: { source: journey.sessionName, target: targetName },
      checkpoint: moved.checkpoint.blob.objectKey,
      modelRoute: moved.modelRoute,
      ledgerUnchangedByRelocation: true,
      scriptResult: names,
      delivered: journey.slack.messages.map(messageText),
    },
  });
}, 60_000);

it("releases a script that the freeze of a relocation ended, and completes the relocation", async (test) => {
  // The script waits on its first read when the relocation starts.
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeFrozenScript",
    completions: ["held"],
    replies: [
      DISCOVER_INTEGRATION_LIST,
      scriptReply(
        "await tools.integration_list({}); await tools.integration_list({}); text('done');",
      ),
      { text: "FIRST_DONE" },
    ],
  });
  const admitted = await readAdmitted(journey);
  const executionId = admitted.session.record.executionId;
  const started = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target: moveTarget(),
    now: Date.now(),
  });
  if (!started.ok) throw new Error(started.error.code);
  // The freeze waits for the read that the Tool Host still runs.
  const resuming = resumeActorRelocation({
    env,
    relocationId: started.value.relocationId,
    now: Date.now(),
  });
  await expect
    .poll(readPlacementStatuses, { timeout: 20_000 })
    .toContain("frozen");
  journey.releaseHeld();
  const relocation = await resuming;
  expect(relocation).toMatchObject({ ok: true, value: { status: "retained" } });

  // The freeze ended the turn. The frozen Session released the execution at
  // both owners, so the relocation had no open work to wait for.
  const targetName = (await sessionObjectName()).name;
  expect(targetName).not.toBe(journey.sessionName);
  const target = env.SESSION.getByName(targetName);
  expect(await readLifecycleKind(target)).toBe("sleeping");
  const closed = await runInDurableObject(target, readExecutionRecord);
  expect(closed).toMatchObject({
    state: "reconciled",
    projection: {
      kind: "execution_released",
      organisation: "cancelled",
      platform: "cancelled",
      relocationId: started.value.relocationId,
    },
  });
  const targetLedger = await readOrganisationLedger(await organisationActor());
  expect(targetLedger).toMatchObject({
    reservations: [{ execution_id: executionId, state: "cancelled" }],
    counters: [{ capability_calls: 1, in_flight_calls: 0 }],
  });
  expect(
    (await runInDurableObject(journey.governor, readGovernorLedger))
      .reservations,
  ).toMatchObject([{ execution_id: executionId, state: "cancelled" }]);
  // The script made no second read, and the model was not asked again.
  expect(journey.completed).toHaveLength(1);
  expect(journey.requests).toHaveLength(2);
  const ended = await runInDurableObject(target, readTurnStreams);
  expect(ended).toMatchObject([{ state: "failed" }]);
  // The Connector of the target reads the ended turn at its next attempt,
  // and tells the operator.
  const connector = await connectorActor();
  await runInDurableObject(connector, makeCaseWorkDue);
  await runDurableObjectAlarm(connector);
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 20_000 })
    .toBe(1);
  expect(journey.slack.messages.map(messageText)).toEqual([TURN_FAILED_NOTICE]);

  Object.assign(test.task.meta, {
    evidence: {
      executionId,
      relocation: relocation.ok ? relocation.value : relocation.error,
      sessionActors: { source: journey.sessionName, target: targetName },
      executionRecord: closed,
      ledger: JSON.parse(JSON.stringify(targetLedger)),
      turnStreams: ended,
      modelRequests: journey.requests.length,
      delivered: journey.slack.messages.map(messageText),
    },
  });
}, 60_000);

it("erases the reads and the stored values of scripts with their Session", async (test) => {
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeErasure",
    replies: [
      DISCOVER_INTEGRATION_LIST,
      scriptReply(KEEP_NAMES_SCRIPT),
      { text: "FIRST_DONE" },
    ],
  });
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 20_000 })
    .toBe(1);
  const session = journey.session;
  // The Session holds the stored names in Pi's store document, and the
  // reads in the receipt of the script: in Pi's entries and in the accepted
  // history. Its sealed checkpoint holds the same tables of Pi.
  const before = await runInDurableObject(session, readStoredContent);
  expect(before.tablesWithReadData).toEqual(
    expect.arrayContaining([
      "document_revisions",
      "entries",
      "session_harness_history",
    ]),
  );
  const { checkpoint, sessionId } = await runInDurableObject(
    session,
    readCheckpoint,
  );
  expect(await env.ARCHIVE.head(checkpoint.blob.objectKey)).not.toBeNull();

  const scope = await requireOrganisationExecutionScope(
    env,
    requiredOrganisationId(),
  );
  const erased = await session.erasePortalChatSession({
    requestingOrganisationId: requiredOrganisationId(),
    sessionId,
    placement: scope.placement,
    placementFenceToken: scope.fenceToken,
    objectKeys: [],
  });
  expect(erased).toEqual({ ok: true, value: undefined });

  const after = await runInDurableObject(session, readStoredContent);
  expect(after.tablesWithReadData).toEqual([]);
  expect(after.rows).toBe(0);
  expect(await env.ARCHIVE.head(checkpoint.blob.objectKey)).toBeNull();
  // The budget owners keep their counters. A counter holds no read.
  const ledger = await readOrganisationLedger(journey.organisation);
  expect(ledger.reservations).toMatchObject([{ state: "settled" }]);
  expect(JSON.stringify(ledger)).not.toContain(READ_DATA);

  Object.assign(test.task.meta, {
    evidence: {
      before: {
        tablesWithReadData: before.tablesWithReadData,
        rows: before.rows,
        checkpointObject: checkpoint.blob.objectKey,
      },
      after: {
        tablesWithReadData: after.tablesWithReadData,
        rows: after.rows,
        checkpointObject: null,
      },
      ledgerState: "settled",
    },
  });
}, 60_000);

/** Moves the Organisation and its Actors to another placement. */
async function relocateOrganisation() {
  const started = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target: moveTarget(),
    now: Date.now(),
  });
  if (!started.ok) return started;
  return resumeActorRelocation({
    env,
    relocationId: started.value.relocationId,
    now: Date.now(),
  });
}

async function readPlacementStatuses(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT status FROM organisation_placement WHERE organisation_id = ? ORDER BY placement_epoch",
  )
    .bind(ORGANISATION_ID)
    .all<{ status: string }>();
  return rows.results.map(placementStatus);
}

function placementStatus(row: { status: string }): string {
  return row.status;
}

function requiredOrganisationId() {
  const organisationId = parseOrganisationId(ORGANISATION_ID);
  if (!organisationId.ok) throw new Error(organisationId.error.code);
  return organisationId.value;
}

/** The latest accepted checkpoint of the Session, and its pinned contract. */
function readCheckpoint(_actor: unknown, state: DurableObjectState) {
  const session = readImportedCanonicalSession(
    state.storage.sql,
    ORGANISATION_ID,
  );
  if (!session.ok) throw new Error(session.error.code);
  const sessionId = parseSessionId(
    session.value.lifecycle.state.identity.sessionId,
  );
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const checkpoint = readLatestHarnessCheckpoint(
    state.storage.sql,
    sessionId.value,
  );
  if (!checkpoint.ok) throw new Error(checkpoint.error.code);
  return {
    sessionId: sessionId.value,
    checkpoint: checkpoint.value,
    runtimeRevision: session.value.lifecycle.state.contract.runtimeRevision,
    modelRoute: session.value.lifecycle.state.contract.modelRoute,
  };
}

/** Every content row of the Session, and the tables whose rows hold a read. */
function readStoredContent(_actor: unknown, state: DurableObjectState) {
  const sql = state.storage.sql;
  const tables = sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'
       AND name NOT IN ('state_object_activation', 'state_object_import',
         'state_object_cleanup_export_barrier', 'do_schema_meta', 'do_schema_migration')
       ORDER BY name`,
    )
    .toArray();
  const tablesWithReadData: string[] = [];
  let rows = 0;
  for (const table of tables) {
    const content = sql.exec(`SELECT * FROM "${table.name}"`).toArray();
    rows += content.length;
    if (JSON.stringify(content).includes(READ_DATA))
      tablesWithReadData.push(table.name);
  }
  return { tablesWithReadData, rows };
}

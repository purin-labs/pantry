import { runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";
import {
  DISCOVER_INTEGRATION_LIST,
  controlSandbox,
  countCalls,
  countExecutions,
  deliverAfterConnectorLease,
  lastToolText,
  ledgerEvidence,
  loseSession,
  messageText,
  organisationActor,
  readAcceptedText,
  readGovernorLedger,
  readLifecycleKind,
  readOrganisationLedger,
  readSettlement,
  readSettlementOrNull,
  scriptReply,
  startScriptTurn,
  type ModelReply,
  type SandboxControl,
  type ScriptTurn,
} from "./durable-codemode-journey-support";
import { installDiscoveryActorFixture } from "./slack-journey-support";

// Plan 50A, Phase E. Each journey sends a Slack message whose turn runs a
// Code Mode script, and injects one fault: a loss of the Session Actor
// around the settlement, a recovery that dispatches the settlement beside
// the turn, a lost connection to the sandbox Worker, a missing
// sandbox binding, a script that calls Code Mode, or a restart into a build
// or a sandbox that differs from the one that admitted the script. The
// Session, Organisation, and governor Actors, the Pi harness, and the sandbox
// Worker are the real ones. The model responses are controlled.

const SCRIPT =
  "const first = JSON.parse(await tools.integration_list({})); const second = JSON.parse(await tools.integration_list({})); text({ reads: 2, accounts: [first.accounts.length, second.accounts.length] });";
const SCRIPT_REPORT = /\{"reads":2,"accounts":\[([1-9]\d*),\1\]\}/;
const FINAL_ANSWER = "SCRIPT_REPORTED";
const FINAL: ModelReply = { text: FINAL_ANSWER };
const REPLIES = [DISCOVER_INTEGRATION_LIST, scriptReply(SCRIPT), FINAL];

type Sandbox = { control: SandboxControl | null };

it.for([
  { passage: "never", point: "before the Organisation settles it" },
  { passage: "lost", point: "after the Organisation settled it" },
] as const)(
  "settles a finished script one time, when the Session Actor is lost $point",
  { timeout: 90_000 },
  async ({ passage, point }, test) => {
    // The script has finished, and the Session holds its result. The
    // settlement is in flight at the Organisation when the process is lost.
    const sandbox: Sandbox = { control: null };
    const journey = await startScriptTurn(test, {
      eventId: `EvDurableCodemodeSettlement_${passage}`,
      install: installWithSandbox.bind(null, test, "watched", sandbox),
      settlements: [passage],
      replies: REPLIES,
    });
    const pending = await runInDurableObject(journey.session, readSettlement);
    expect(pending.state).toBe("pending");
    expect(
      (await readOrganisationLedger(journey.organisation)).reservations,
    ).toMatchObject([{ state: passage === "lost" ? "settled" : "reserved" }]);
    expect(journey.requests).toHaveLength(2);

    // The next process settles from the saved result. No VM starts, and no
    // read runs again. The Organisation answers a repeated settlement with
    // the first one.
    const session = await loseSession(journey);
    await deliverAfterConnectorLease(journey, session);
    const settled = await runInDurableObject(session, readSettlement);
    expect(settled).toEqual({ state: "settled", settle: pending.settle });
    const organisation = await readOrganisationLedger(journey.organisation);
    const governor = await runInDurableObject(
      journey.governor,
      readGovernorLedger,
    );
    expect(organisation).toMatchObject({
      reservations: [{ state: "settled", runtime_generation: 1 }],
      counters: [{ capability_calls: 2, in_flight_calls: 0 }],
    });
    expect(governor.reservations).toMatchObject([{ state: "settled" }]);
    expect(journey.settling).toEqual([
      pending.settle.executionId,
      pending.settle.executionId,
    ]);
    expect(journey.completed).toHaveLength(2);
    expect(sandbox.control?.started).toHaveLength(1);
    expect(journey.requests).toHaveLength(3);
    expect(lastToolText(journey.requests[2])).toMatch(SCRIPT_REPORT);
    expect(journey.slack.messages.map(messageText)).toEqual([FINAL_ANSWER]);

    Object.assign(test.task.meta, {
      evidence: {
        faultPoint: `Session Actor lost ${point}`,
        executionId: pending.settle.executionId,
        settlement: settled,
        settlementsAtOrganisation: journey.settling.length,
        vmStarts: sandbox.control?.started.length,
        ledgers: ledgerEvidence(organisation, governor),
        modelRequests: journey.requests.length,
      },
    });
  },
);

it("settles a finished script one time, when the Session's alarm runs while the turn's settlement waits", async (test) => {
  // The turn dispatches the settlement of its finished script, and the
  // Organisation holds it past the Session's recovery alarm. The live turn
  // holds its settlement, so the alarm leaves it to the turn and neither
  // dispatches it a second time nor marks it indeterminate (Refactor 15).
  // When the Organisation answers, the turn commits the settlement.
  const sandbox: Sandbox = { control: null };
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeSettlementAlarm",
    install: installWithSandbox.bind(null, test, "watched", sandbox),
    settlements: ["held", "held"],
    replies: REPLIES,
  });
  const pending = await runInDurableObject(journey.session, readSettlement);
  expect(pending.state).toBe("pending");
  await expect
    .poll(countCalls.bind(null, journey.settling), { timeout: 20_000 })
    .toBe(1);
  // The recovery alarm is due one second after the workspace commit. Wait
  // past it and a retry: the alarm left the held settlement alone.
  await new Promise((resolve) => setTimeout(resolve, 7_000));
  expect(journey.settling).toHaveLength(1);
  expect(
    (await runInDurableObject(journey.session, readSettlement)).state,
  ).not.toBe("indeterminate");
  expect(await readLifecycleKind(journey.session)).toBe("processing");
  journey.releaseHeld();

  // The model receives the report of the script, not a settlement failure.
  // The settlement stays settled, and each owner settled it one time.
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 30_000 })
    .toBe(1);
  await expect
    .poll(readLifecycleKind.bind(null, journey.session), { timeout: 20_000 })
    .toBe("sleeping");
  expect(lastToolText(journey.requests[2])).toMatch(SCRIPT_REPORT);
  expect(journey.slack.messages.map(messageText)).toEqual([FINAL_ANSWER]);
  const settled = await runInDurableObject(journey.session, readSettlement);
  expect(settled).toEqual({ state: "settled", settle: pending.settle });
  const organisation = await readOrganisationLedger(journey.organisation);
  const governor = await runInDurableObject(
    journey.governor,
    readGovernorLedger,
  );
  expect(organisation).toMatchObject({
    reservations: [{ state: "settled", runtime_generation: 1 }],
    counters: [{ capability_calls: 2, in_flight_calls: 0 }],
  });
  expect(governor.reservations).toMatchObject([{ state: "settled" }]);
  expect(journey.settling).toEqual([pending.settle.executionId]);
  expect(sandbox.control?.started).toHaveLength(1);
  expect(journey.requests).toHaveLength(3);

  Object.assign(test.task.meta, {
    evidence: {
      faultPoint:
        "Session alarm runs while the turn's settlement waits at the Organisation",
      executionId: pending.settle.executionId,
      settlement: settled,
      settlementsAtOrganisation: journey.settling.length,
      ledgers: ledgerEvidence(organisation, governor),
      modelRequests: journey.requests.length,
    },
  });
}, 90_000);

it("ends a script with a sandbox failure, when the connection to the sandbox Worker is lost", async (test) => {
  // The first read is recorded. The Tool Host runs the second read when
  // the call to the sandbox Worker fails. The Session Actor stays alive.
  const sandbox: Sandbox = { control: null };
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeTransport",
    install: installWithSandbox.bind(null, test, "watched", sandbox),
    completions: ["pass", "held"],
    replies: REPLIES,
  });
  sandbox.control?.loseTransport();
  journey.releaseHeld();

  // The model receives the failure, and the turn completes. Both reads keep
  // their one claim. No other VM starts.
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 30_000 })
    .toBe(1);
  expect(lastToolText(journey.requests[2])).toContain(
    "Script sandbox failed: Remote sandbox failed: Network connection lost.",
  );
  const settlement = await runInDurableObject(journey.session, readSettlement);
  expect(settlement).toMatchObject({
    state: "settled",
    settle: { capabilityCalls: 2, outcome: "platform_failed" },
  });
  const organisation = await readOrganisationLedger(journey.organisation);
  const governor = await runInDurableObject(
    journey.governor,
    readGovernorLedger,
  );
  expect(organisation).toMatchObject({
    reservations: [{ state: "settled", runtime_generation: 1 }],
    counters: [{ capability_calls: 2, in_flight_calls: 0 }],
    calls: [{ state: "completed" }, { state: "completed" }],
  });
  expect(governor.reservations).toMatchObject([{ state: "settled" }]);
  expect(journey.completed).toHaveLength(2);
  expect(sandbox.control?.started).toHaveLength(1);
  expect(journey.requests).toHaveLength(3);
  expect(journey.slack.messages.map(messageText)).toEqual([FINAL_ANSWER]);

  Object.assign(test.task.meta, {
    evidence: {
      faultPoint: "call to the sandbox Worker rejected during the second read",
      settlement,
      vmStarts: sandbox.control?.started.length,
      ledgers: ledgerEvidence(organisation, governor),
      modelRequests: journey.requests.length,
    },
  });
}, 60_000);

it("ends a read over the output budget, and the turn still answers, when a script reads too much", async (test) => {
  // The first read answers more than the output budget of the script holds.
  // The Organisation refuses its completion, so the script gets no result
  // from it and stops. The production fault of 2026-11-06 (Plan 87 journey)
  // ended this turn with "could not finish" and quarantined the Session.
  const sandbox: Sandbox = { control: null };
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeOutputLimit",
    install: installWithSandbox.bind(null, test, "watched", sandbox),
    completions: ["oversized"],
    replies: REPLIES,
  });

  // The model receives the refusal and answers. The execution settles, and
  // the Session sleeps instead of a quarantine.
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 30_000 })
    .toBe(1);
  await expect
    .poll(readLifecycleKind.bind(null, journey.session), { timeout: 20_000 })
    .toBe("sleeping");
  expect(journey.slack.messages.map(messageText)).toEqual([FINAL_ANSWER]);
  expect(lastToolText(journey.requests[2])).toContain(
    "code_mode_capability_output_limit_exceeded",
  );
  const settlement = await runInDurableObject(journey.session, readSettlement);
  expect(settlement).toMatchObject({
    state: "settled",
    settle: {
      capabilityCalls: 1,
      outputBytes: 0,
      outcome: "organisation_failed",
    },
  });
  const organisation = await readOrganisationLedger(journey.organisation);
  const governor = await runInDurableObject(
    journey.governor,
    readGovernorLedger,
  );
  expect(organisation).toMatchObject({
    reservations: [{ state: "settled" }],
    counters: [{ capability_calls: 1, in_flight_calls: 0, output_bytes: 0 }],
    calls: [{ state: "completed" }],
  });
  expect(governor.reservations).toMatchObject([{ state: "settled" }]);
  expect(journey.requests).toHaveLength(3);

  Object.assign(test.task.meta, {
    evidence: {
      faultPoint:
        "completion of the first read is over the output budget of the script",
      settlement,
      ledgers: ledgerEvidence(organisation, governor),
      modelRequests: journey.requests.length,
      answer: journey.slack.messages.map(messageText),
    },
  });
}, 60_000);

it("settles a script and the turn answers, when the answer to a completion is lost on its way back", async (test) => {
  // The Organisation completes the first read, and its answer fails on the
  // way back. The Session never learns the output bytes that the
  // Organisation counted, and the script gets no result from the read.
  const sandbox: Sandbox = { control: null };
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeCompletionDropped",
    install: installWithSandbox.bind(null, test, "watched", sandbox),
    completions: ["dropped"],
    replies: REPLIES,
  });

  // The model receives the failure and answers. The settlement carries the
  // counts that the Organisation holds, and the Session sleeps instead of a
  // quarantine.
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 30_000 })
    .toBe(1);
  await expect
    .poll(readLifecycleKind.bind(null, journey.session), { timeout: 20_000 })
    .toBe("sleeping");
  expect(journey.slack.messages.map(messageText)).toEqual([FINAL_ANSWER]);
  expect(lastToolText(journey.requests[2])).toContain(
    "Network connection lost",
  );
  const settlement = await runInDurableObject(journey.session, readSettlement);
  const organisation = await readOrganisationLedger(journey.organisation);
  const governor = await runInDurableObject(
    journey.governor,
    readGovernorLedger,
  );
  expect(organisation).toMatchObject({
    reservations: [{ state: "settled" }],
    counters: [{ capability_calls: 1, in_flight_calls: 0 }],
    calls: [{ state: "completed" }],
  });
  const counted = Number(organisation.counters[0]?.output_bytes);
  expect(counted).toBeGreaterThan(0);
  expect(settlement).toMatchObject({
    state: "settled",
    settle: {
      capabilityCalls: 1,
      outputBytes: counted,
      outcome: "organisation_failed",
    },
  });
  expect(governor.reservations).toMatchObject([{ state: "settled" }]);
  expect(journey.requests).toHaveLength(3);

  Object.assign(test.task.meta, {
    evidence: {
      faultPoint:
        "answer of the first completion fails after the Organisation ran it",
      settlement,
      ledgers: ledgerEvidence(organisation, governor),
      modelRequests: journey.requests.length,
      answer: journey.slack.messages.map(messageText),
    },
  });
}, 60_000);

it("refuses a script before admission, when the deployment holds no sandbox binding", async (test) => {
  const sandbox: Sandbox = { control: null };
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeNoBinding",
    install: installWithSandbox.bind(null, test, "missing", sandbox),
    replies: REPLIES,
  });
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 30_000 })
    .toBe(1);

  // The model receives the refusal, and the turn completes. No owner holds
  // a reservation, no call ran, and no other engine ran the script.
  const refusal = "Code Mode sandbox is unavailable";
  expect(lastToolText(journey.requests[2])).toContain(refusal);
  expect(await runInDurableObject(journey.session, readAcceptedText)).toContain(
    refusal,
  );
  expect(await readOrganisationLedger(journey.organisation)).toEqual({
    reservations: [],
    counters: [],
    calls: [],
  });
  expect(
    await runInDurableObject(journey.governor, readGovernorLedger),
  ).toEqual({ reservations: [] });
  expect(await runInDurableObject(journey.session, countExecutions)).toBe(0);
  expect(await runInDurableObject(journey.session, readSettlementOrNull)).toBe(
    null,
  );
  expect(journey.completed).toEqual([]);
  expect(sandbox.control?.started).toEqual([]);
  expect(journey.requests).toHaveLength(3);
  expect(journey.slack.messages.map(messageText)).toEqual([FINAL_ANSWER]);

  Object.assign(test.task.meta, {
    evidence: {
      fault: "no CODE_MODE_SANDBOX binding",
      refusal,
      reservations: 0,
      capabilityCalls: 0,
      modelRequests: journey.requests.length,
    },
  });
}, 60_000);

it("gives a script no Code Mode tool, so a script cannot start a script", async (test) => {
  const sandbox: Sandbox = { control: null };
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeRecursive",
    install: installWithSandbox.bind(null, test, "watched", sandbox),
    replies: [
      DISCOVER_INTEGRATION_LIST,
      scriptReply(
        "let outcome = 'ran'; try { await tools.codemode({ code: \"text('inner')\" }); } catch (error) { outcome = String(error); } text({ outcome });",
      ),
      FINAL,
    ],
  });
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 30_000 })
    .toBe(1);

  // One execution, one VM, one reservation, and no capability call.
  expect(lastToolText(journey.requests[2])).toContain(
    "tools.codemode does not exist",
  );
  const organisation = await readOrganisationLedger(journey.organisation);
  expect(organisation).toMatchObject({
    reservations: [{ state: "settled" }],
    counters: [{ capability_calls: 0, in_flight_calls: 0 }],
    calls: [],
  });
  expect(organisation.reservations).toHaveLength(1);
  expect(await runInDurableObject(journey.session, countExecutions)).toBe(1);
  expect(sandbox.control?.started).toHaveLength(1);
  expect(journey.slack.messages.map(messageText)).toEqual([FINAL_ANSWER]);

  Object.assign(test.task.meta, {
    evidence: {
      reservations: organisation.reservations.length,
      vmStarts: sandbox.control?.started.length,
      capabilityCalls: 0,
    },
  });
}, 60_000);

it("ends a script that another build admitted, and starts no VM for it", async (test) => {
  // The owners hold the admission of a build whose tool contract, runtime
  // revision, or price book differs from this build. Such a build computes
  // another admission digest for the same script.
  const sandbox: Sandbox = { control: null };
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeOtherBuild",
    install: installWithSandbox.bind(null, test, "watched", sandbox),
    completions: ["pass", "never"],
    replies: REPLIES,
  });
  await admitAsAnotherBuild(journey);

  // The reservation moves to the lease of the next generation. The script
  // does not start again, and the read that was in flight does not run
  // again. The model receives the reason, and the turn completes.
  const session = await loseSession(journey);
  await deliverAfterConnectorLease(journey, session);
  expect(lastToolText(journey.requests[2])).toContain(
    "The script cannot resume: the tools of this runtime differ from the tools that it started with.",
  );
  const settlement = await runInDurableObject(session, readSettlement);
  expect(settlement).toMatchObject({
    state: "settled",
    settle: { capabilityCalls: 2, outcome: "platform_failed" },
  });
  const organisation = await readOrganisationLedger(journey.organisation);
  const governor = await runInDurableObject(
    journey.governor,
    readGovernorLedger,
  );
  expect(organisation).toMatchObject({
    reservations: [{ state: "settled", runtime_generation: 2 }],
    counters: [{ capability_calls: 2, in_flight_calls: 0 }],
  });
  expect(governor.reservations).toMatchObject([
    { state: "settled", runtime_generation: 2 },
  ]);
  expect(journey.completed).toHaveLength(2);
  expect(sandbox.control?.started).toHaveLength(1);
  expect(journey.requests).toHaveLength(3);
  expect(journey.slack.messages.map(messageText)).toEqual([FINAL_ANSWER]);

  Object.assign(test.task.meta, {
    evidence: {
      fault: "the admission digest of the owners differs from this build",
      settlement,
      vmStarts: sandbox.control?.started.length,
      toolHostCompletions: journey.completed.length,
      ledgers: ledgerEvidence(organisation, governor),
      modelRequests: journey.requests.length,
    },
  });
}, 60_000);

it("ends a script whose sandbox changed while it was stopped, and admits no new call", async (test) => {
  // Pi records the QuickJS build that started the script. The sandbox
  // Worker of the next process reports another build.
  const sandbox: Sandbox = { control: null };
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeSandboxChanged",
    install: installWithSandbox.bind(null, test, "watched", sandbox),
    completions: ["pass", "never"],
    replies: REPLIES,
  });
  const interrupted = journey.completed[1];
  await runInDurableObject(journey.session, recordAnotherSandboxBuild);

  // Pi refuses to replay. The read that the first process admitted ends
  // under its first call ID. The script makes no other call.
  const session = await loseSession(journey);
  await deliverAfterConnectorLease(journey, session);
  expect(lastToolText(journey.requests[2])).toContain(
    "The script cannot resume: the sandbox changed since it started",
  );
  const settlement = await runInDurableObject(session, readSettlement);
  expect(settlement).toMatchObject({
    state: "settled",
    settle: { capabilityCalls: 2, outcome: "platform_failed" },
  });
  const organisation = await readOrganisationLedger(journey.organisation);
  const governor = await runInDurableObject(
    journey.governor,
    readGovernorLedger,
  );
  expect(organisation).toMatchObject({
    reservations: [{ state: "settled", runtime_generation: 2 }],
    counters: [{ capability_calls: 2, in_flight_calls: 0 }],
    calls: [{ state: "completed" }, { state: "completed" }],
  });
  expect(journey.completed.slice(2)).toEqual([interrupted]);
  expect(journey.requests).toHaveLength(3);
  expect(journey.slack.messages.map(messageText)).toEqual([FINAL_ANSWER]);

  Object.assign(test.task.meta, {
    evidence: {
      fault: "the recorded sandbox fingerprint differs from the sandbox",
      settlement,
      toolHostCompletions: journey.completed.length,
      ledgers: ledgerEvidence(organisation, governor),
      modelRequests: journey.requests.length,
    },
  });
}, 60_000);

/** The discovery Organisation, with the journey at its sandbox binding. */
async function installWithSandbox(
  test: TestContext,
  binding: "watched" | "missing",
  sandbox: Sandbox,
): Promise<void> {
  await installDiscoveryActorFixture();
  sandbox.control = await runInDurableObject(
    await organisationActor(),
    controlSandbox.bind(null, test, binding),
  );
}

const OTHER_BUILD_DIGEST = "b".repeat(64);

/** Makes every owner hold the admission digest of another build. */
async function admitAsAnotherBuild(journey: ScriptTurn): Promise<void> {
  await runInDurableObject(journey.session, writeSessionAdmissionDigest);
  await runInDurableObject(
    journey.organisation,
    writeLedgerAdmissionDigest.bind(null, "code_execution_reservation"),
  );
  await runInDurableObject(
    journey.governor,
    writeLedgerAdmissionDigest.bind(null, "code_mode_platform_reservation"),
  );
}

async function writeSessionAdmissionDigest(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  const row = state.storage.sql
    .exec<{ effect_id: string; request_envelope: string }>(
      "SELECT effect_id, request_envelope FROM actor_outbox WHERE effect_id LIKE 'execution-cmx-%'",
    )
    .one();
  const envelope: unknown = JSON.parse(row.request_envelope);
  if (!isRecord(envelope) || typeof envelope.admissionDigest !== "string")
    throw new Error("Invalid execution record");
  state.storage.sql.exec(
    "UPDATE actor_outbox SET request_envelope = ? WHERE effect_id = ?",
    JSON.stringify({ ...envelope, admissionDigest: OTHER_BUILD_DIGEST }),
    row.effect_id,
  );
  await state.storage.sync();
}

function writeLedgerAdmissionDigest(
  table: "code_execution_reservation" | "code_mode_platform_reservation",
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.storage.sql.exec(
    `UPDATE ${table} SET admission_digest = ?`,
    OTHER_BUILD_DIGEST,
  );
}

/** Rewrites the sandbox build that Pi recorded at the start of the script. */
async function recordAnotherSandboxBuild(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  const revision = state.storage.sql
    .exec<{ document_id: number; seq: number; content: string }>(
      `SELECT r.document_id, r.seq, r.content FROM documents d
       JOIN document_revisions r ON r.document_id = d.id
       WHERE d.kind = ? AND r.content LIKE '%"fingerprint"%'`,
      JSON.stringify("pi.codemode.run"),
    )
    .one();
  const changed = revision.content.replace(
    /quickjs-wasi [0-9.]+/u,
    "quickjs-wasi 0.0.1",
  );
  if (changed === revision.content)
    throw new Error("Expected the recorded sandbox build");
  state.storage.sql.exec(
    "UPDATE document_revisions SET content = ? WHERE document_id = ? AND seq = ?",
    changed,
    revision.document_id,
    revision.seq,
  );
  await state.storage.sync();
}

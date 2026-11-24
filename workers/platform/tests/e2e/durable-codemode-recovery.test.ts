import { runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { deriveCodeModeLeaseBinding } from "@purin-labs/agent/actors/code-mode-execution-record";
import { ActorSqliteDatabase } from "@purin-labs/agent/actors/pi-durable-database";
import {
  newRequestId,
  parseOrganisationId,
  parseSessionId,
} from "@purin-labs/kernel/ids";
import {
  DISCOVER_INTEGRATION_LIST,
  READ_DATA,
  TURN_FAILED_NOTICE,
  boundAuthority,
  completeUncontrolled,
  connectorActor,
  controlAdmission,
  countCalls,
  countExecutions,
  deliverAfterConnectorLease,
  endCaseWorkLease,
  failFirstRebind,
  installListingAuthority,
  lastToolText,
  ledgerEvidence,
  loseSession,
  messageText,
  readAcceptedText,
  readAdmitted,
  readCaseWorkOutcome,
  readExecutionRecord,
  readGovernorLedger,
  readLifecycleKind,
  readOrganisationLedger,
  readSessionSettlement,
  readSessionState,
  readSettlement,
  readSettlementOrNull,
  readTurnStreams,
  revokeDiscoveryGrant,
  scriptReply,
  serialized,
  startScriptTurn,
  type ModelReply,
  type Passage,
} from "./durable-codemode-journey-support";
import { ORGANISATION_ID } from "./slack-journey-support";
import { runAlarmHandler, runArmedAlarm } from "./durable-object-alarm-support";

// Plan 50A, Phases B and C. Each journey sends a Slack message whose turn
// runs a Code Mode script of two reads, and stops the script at a chosen
// completion of a read. The journey then loses the Session Actor, revokes a
// grant, cancels the turn, or freezes admission. The Session, Organisation,
// and governor Actors, the Pi harness, and the sandbox Worker are the real
// ones. The model responses are controlled.

// A tool resolves in a script with text. Each read carries its own time, so
// the script compares the accounts of the two reads.
const SCRIPT =
  "const first = JSON.parse(await tools.integration_list({})); const second = JSON.parse(await tools.integration_list({})); text({ reads: 2, accounts: [first.accounts.length, second.accounts.length], sameAccounts: JSON.stringify(first.accounts) === JSON.stringify(second.accounts) });";
const SCRIPT_REPORT =
  /\{"reads":2,"accounts":\[([1-9]\d*),\1\],"sameAccounts":true\}/;
const FINAL_ANSWER = "SCRIPT_REPORTED";

it("refuses the lease of a lost Session Actor process, and keeps the first deadline after the recovery", async (test) => {
  // The first read completes. The second read is in flight when the process
  // is lost, and the next process holds its completion, so the execution
  // still runs under the lease of the new process.
  const journey = await stopScriptAtCompletion(
    test,
    "EvDurableCodemodeResume",
    ["pass", "never", "held"],
  );
  const { organisation, governor, admitted } = journey;
  const record = admitted.session.record;
  const first = boundAuthority(record);
  const second = await deriveCodeModeLeaseBinding(record.executionId, 2);
  const interrupted = admitted.organisation.calls.find(
    (call) => call.state === "claimed",
  );
  if (interrupted === undefined) throw new Error("Missing claimed call");

  // The next instance recovers by itself, and the interrupted read runs again.
  const session = await loseSession(journey);
  await expect
    .poll(countCalls.bind(null, journey.completed), { timeout: 20_000 })
    .toBe(3);

  // The lease of the lost process has no authority at either owner.
  const identity = {
    organisationId: ORGANISATION_ID,
    executionId: record.executionId,
  };
  const stale = [
    await organisation.claimCodeModeCapability({
      ...identity,
      requestId: newRequestId(),
      leaseId: first.binding.leaseId,
      callId: "call_of_lost_process",
      inputBytes: 2,
      now: Date.now(),
    }),
    await runInDurableObject(
      organisation,
      completeUncontrolled.bind(null, journey, {
        ...identity,
        requestId: newRequestId(),
        leaseId: first.binding.leaseId,
        callId: interrupted.call_id,
        outputBytes: 2,
        now: Date.now(),
      }),
    ),
    await governor.cancel({
      ...identity,
      requestId: newRequestId(),
      leaseId: first.binding.leaseId,
      reason: "turn_cancelled",
      now: Date.now(),
    }),
  ];
  expect(stale).toEqual([
    { ok: false, error: { code: "code_mode_reservation_lease_conflict" } },
    { ok: false, error: { code: "code_mode_reservation_lease_conflict" } },
    { ok: false, error: { code: "code_mode_reservation_lease_conflict" } },
  ]);
  // The new lease did not move the deadline of the first admission.
  const atDeadline = await organisation.claimCodeModeCapability({
    ...identity,
    requestId: newRequestId(),
    leaseId: second.leaseId,
    callId: "call_at_deadline",
    inputBytes: 2,
    now: first.executionDeadlineAt,
  });
  expect(atDeadline).toEqual({
    ok: false,
    error: { code: "code_mode_execution_deadline_elapsed" },
  });

  // The script finishes, and the answer is delivered.
  journey.releaseHeld();
  await deliverAfterConnectorLease(journey, session);
  expect(journey.slack.messages.map(messageText)).toEqual([FINAL_ANSWER]);

  Object.assign(test.task.meta, {
    evidence: {
      executionId: record.executionId,
      leases: { first: first.binding, second },
      executionDeadlineAt: first.executionDeadlineAt,
      stale,
      atDeadline,
    },
  });
}, 60_000);

it("resumes a script only after every owner holds the lease of the new runtime generation, and runs one script in the turn", async (test) => {
  // The first read is in flight when the process is lost. After the script
  // has reported, the model asks for a second script in the same turn.
  const journey = await stopScriptAtCompletion(
    test,
    "EvDurableCodemodeHandoff",
    ["never", "pass", "pass"],
    [SECOND_SCRIPT, FINAL],
  );
  const { organisation, governor, admitted } = journey;
  const record = admitted.session.record;
  const first = boundAuthority(record);
  const second = await deriveCodeModeLeaseBinding(record.executionId, 2);
  const interrupted = admitted.organisation.calls[0];
  if (interrupted === undefined) throw new Error("Missing claimed call");

  // The Session Actor is lost while admission is frozen.
  await controlAdmission(governor, "freeze_admission");
  const session = await loseSession(journey);
  const frozen = await runInDurableObject(session, readSessionState);
  expect(frozen.recovery).toMatchObject({
    kind: "resumable_script",
    execution: {
      executionId: record.executionId,
      binding: first.binding,
      executionDeadlineAt: first.executionDeadlineAt,
    },
  });
  // The recovery wants to resume, and it has not: no owner confirmed.
  expect(frozen.lifecycle).toMatchObject({
    kind: "recovering",
    state: {
      fencedRuntime: { generation: 1 },
      action: { kind: "resume_task" },
    },
  });
  // The intended lease is stored, and neither lease runs the execution.
  expect(frozen.record.authority).toEqual({
    kind: "rebinding",
    binding: first.binding,
    intended: second,
    executionDeadlineAt: first.executionDeadlineAt,
  });
  expect(await readOrganisationLedger(organisation)).toEqual(
    admitted.organisation,
  );
  expect(await runInDurableObject(governor, readGovernorLedger)).toEqual(
    admitted.governor,
  );

  // Admission opens, and the Organisation Actor fails once: a partial handoff.
  await controlAdmission(governor, "open_admission");
  await runInDurableObject(organisation, failFirstRebind);
  await runArmedAlarm(session);
  const partial = await runInDurableObject(session, readSessionState);
  const partialGovernor = await runInDurableObject(
    governor,
    readGovernorLedger,
  );
  expect(partial.lifecycle).toMatchObject({
    kind: "recovering",
    state: {
      fencedRuntime: { generation: 1 },
      action: { kind: "resume_task" },
    },
  });
  expect(partial.record.authority.kind).toBe("rebinding");
  expect(partialGovernor.reservations[0]).toMatchObject({
    lease_id: second.leaseId,
    runtime_generation: 2,
  });
  expect(await readOrganisationLedger(organisation)).toEqual(
    admitted.organisation,
  );
  // No model request and no capability call followed either deferral.
  expect(journey.requests).toHaveLength(2);
  expect(journey.completed).toEqual([interrupted.call_id]);

  // The same rebind again completes the handoff, and the script continues.
  await runArmedAlarm(session);
  await deliverAfterConnectorLease(journey, session);
  expect(journey.slack.messages.map(messageText)).toEqual([FINAL_ANSWER]);
  // The interrupted read ran again under its first call ID.
  expect(journey.completed[1]).toBe(interrupted.call_id);
  expect(journey.completed).toHaveLength(3);
  // The script reported, the second script was refused, and the model
  // answered: four requests, and one execution at every owner.
  expect(journey.requests).toHaveLength(4);
  expect(lastToolText(journey.requests[2])).toMatch(SCRIPT_REPORT);
  const refused = lastToolText(journey.requests[3]);
  expect(refused).not.toContain("Script completed");
  expect(refused).not.toContain("second attempt");
  const settledOrganisation = await readOrganisationLedger(organisation);
  const settledGovernor = await runInDurableObject(
    governor,
    readGovernorLedger,
  );
  expect(settledOrganisation).toMatchObject({
    reservations: [
      { state: "settled", lease_id: second.leaseId, runtime_generation: 2 },
    ],
    counters: [{ capability_calls: 2, in_flight_calls: 0 }],
  });
  expect(settledOrganisation.reservations).toHaveLength(1);
  expect(settledGovernor.reservations).toMatchObject([
    { state: "settled", lease_id: second.leaseId, runtime_generation: 2 },
  ]);
  expect(settledGovernor.reservations).toHaveLength(1);
  expect(await runInDurableObject(session, countExecutions)).toBe(1);

  Object.assign(test.task.meta, {
    evidence: {
      executionId: record.executionId,
      leases: { first: first.binding, second },
      frozen: {
        recovery: frozen.recovery,
        action: frozen.lifecycle.state,
        authority: frozen.record.authority,
      },
      partial: {
        authority: partial.record.authority,
        governor: JSON.parse(JSON.stringify(partialGovernor)),
        organisation: "unchanged",
      },
      settled: ledgerEvidence(settledOrganisation, settledGovernor),
      modelRequests: journey.requests.length,
      secondScriptRefusal: refused,
      executions: 1,
      delivered: journey.slack.messages.map(messageText),
    },
  });
}, 60_000);

it("returns the receipt of a finished script whose call Pi had not ended when the Session Actor was lost", async (test) => {
  // The script finishes and its receipt is completed, which also removes the
  // Code Mode tool from the agent. The process is lost before Pi commits the
  // call's result, so Pi must run the call again to end it.
  const held = holdCodeModeResultCommit(test);
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeReceiptWindow",
    replies: [DISCOVER_INTEGRATION_LIST, scriptReply(SCRIPT), FINAL],
  });
  await expect.poll(isHeld.bind(null, held), { timeout: 20_000 }).toBe(true);
  const { organisation, governor } = journey;
  const lost = await runInDurableObject(journey.session, readCodeModeWindow);
  expect(lost).toEqual({ receipt: "completed", callOpen: true });
  expect(journey.settling).toHaveLength(1);
  expect(journey.completed).toHaveLength(2);

  const session = await loseSession(journey);
  await deliverAfterConnectorLease(journey, session);
  expect(journey.slack.messages.map(messageText)).toEqual([FINAL_ANSWER]);
  // The rerun returned the saved receipt: the reads ran once, the execution
  // settled once, and the model read the script's report once.
  expect(journey.completed).toHaveLength(2);
  expect(journey.settling).toHaveLength(1);
  expect(journey.requests).toHaveLength(3);
  const result = lastToolText(journey.requests[2]);
  expect(result).toContain("Script completed");
  expect(result).toMatch(SCRIPT_REPORT);
  // The turn offers no second script.
  expect(offeredTools(journey.requests[2])).not.toContain("codemode");
  expect(await runInDurableObject(session, countExecutions)).toBe(1);
  const settledOrganisation = await readOrganisationLedger(organisation);
  const settledGovernor = await runInDurableObject(
    governor,
    readGovernorLedger,
  );
  expect(settledOrganisation).toMatchObject({
    reservations: [{ state: "settled" }],
    counters: [{ capability_calls: 2, in_flight_calls: 0 }],
  });
  expect(settledGovernor.reservations).toMatchObject([{ state: "settled" }]);

  Object.assign(test.task.meta, {
    evidence: {
      atLoss: lost,
      modelRequests: journey.requests.length,
      completions: journey.completed.length,
      settlements: journey.settling.length,
      scriptResult: result,
      delivered: journey.slack.messages.map(messageText),
      settled: ledgerEvidence(settledOrganisation, settledGovernor),
    },
  });
}, 60_000);

it("ends the turn when the reservation expired while the Session Actor was lost", async (test) => {
  const journey = await stopScriptAtCompletion(
    test,
    "EvDurableCodemodeExpired",
    ["never"],
  );
  const { organisation, governor, admitted } = journey;
  const record = admitted.session.record;
  const first = boundAuthority(record);
  const second = await deriveCodeModeLeaseBinding(record.executionId, 2);
  const third = await deriveCodeModeLeaseBinding(record.executionId, 3);
  const expiresAt = admitted.governor.reservations[0]?.lease_expires_at;
  if (typeof expiresAt !== "number") throw new Error("Missing expiry");

  await controlAdmission(governor, "freeze_admission");
  const session = await loseSession(journey);
  expect(
    (await runInDurableObject(session, readSessionState)).lifecycle.kind,
  ).toBe("recovering");
  await controlAdmission(governor, "open_admission");
  // The downtime outlasts the reservation. Each owner expires it at its own
  // clock; these requests carry the time of the expiry.
  const request = {
    organisationId: ORGANISATION_ID,
    executionId: record.executionId,
    admissionDigest: record.admissionDigest,
    previous: second,
    next: third,
    now: expiresAt,
  };
  const expired = [
    await governor.rebindLease({ ...request, requestId: newRequestId() }),
    await organisation.rebindCodeModeLease({
      ...request,
      requestId: newRequestId(),
    }),
  ];
  expect(expired).toMatchObject([
    { ok: false, error: { code: "code_mode_reservation_lease_conflict" } },
    { ok: false, error: { code: "code_mode_reservation_lease_conflict" } },
  ]);
  expect(
    (await runInDurableObject(governor, readGovernorLedger)).reservations,
  ).toMatchObject([{ state: "expired" }]);
  expect(
    (await readOrganisationLedger(organisation)).reservations,
  ).toMatchObject([{ state: "expired", lease_id: first.binding.leaseId }]);

  // The recovery finds no owner that will hold the reservation. The turn ends.
  await runArmedAlarm(session);
  await expect
    .poll(readLifecycleKind.bind(null, session), { timeout: 15_000 })
    .toBe("sleeping");
  const ended = await runInDurableObject(session, readTurnStreams);
  expect(ended).toMatchObject([
    { state: "failed", error_detail: "code_mode_execution_unresumable" },
  ]);
  // The execution is closed: each owner had ended its reservation.
  const closed = await runInDurableObject(session, readExecutionRecord);
  expect(closed).toMatchObject({
    state: "reconciled",
    projection: {
      kind: "execution_released",
      organisation: "expired",
      platform: "expired",
    },
  });
  // The script did not run again. The Connector reads the ended turn when
  // its lease ends, and finds the cause.
  const connector = await connectorActor();
  await runInDurableObject(connector, endCaseWorkLease);
  await runAlarmHandler(connector);
  await expect
    .poll(readCaseWorkOutcome.bind(null, connector), { timeout: 20_000 })
    .toEqual({
      outcome: "retryable",
      reason: "session_stream:code_mode_execution_unresumable",
    });
  const caseWork = await readCaseWorkOutcome(connector);
  expect(journey.requests).toHaveLength(2);
  expect(journey.completed).toEqual([admitted.organisation.calls[0]?.call_id]);
  // The operator is told that the request did not complete.
  expect(journey.slack.messages.map(messageText)).toEqual([TURN_FAILED_NOTICE]);

  Object.assign(test.task.meta, {
    evidence: {
      executionId: record.executionId,
      expired,
      lifecycle: "sleeping",
      turnStreams: ended,
      executionRecord: closed,
      caseWork,
      delivered: journey.slack.messages.map(messageText),
      modelRequests: journey.requests.length,
    },
  });
}, 60_000);

it("keeps a script stopped, when a call whose repeat is not proven safe was in flight at the loss", async (test) => {
  // The script drafts a campaign brief. No owner answers a repeated draft
  // from the first one. The Tool Host has run that call, and its completion
  // is in flight when the process is lost.
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeEffect",
    install: installListingAuthority,
    completions: ["never"],
    replies: [
      {
        tool: "tool_search",
        args: { query: "commerce_propose_campaign_brief", limit: 1 },
      },
      scriptReply(
        `await tools.commerce_propose_campaign_brief({ request: ${JSON.stringify(CAMPAIGN_BRIEF)} }); text('drafted');`,
      ),
      FINAL,
    ],
  });
  const admitted = await readAdmitted(journey);
  const record = admitted.session.record;
  expect(admitted.organisation).toMatchObject({
    counters: [{ capability_calls: 1, in_flight_calls: 1 }],
  });

  // Nothing runs that call again. Pi would tell the script that the call
  // failed, and the script cannot know that. The recovery stays blocked for
  // an operator, as it does for a direct call of the same tool.
  const session = await loseSession(journey);
  const held = await runInDurableObject(session, readSessionState);
  expect(held.lifecycle).toMatchObject({
    kind: "recovering",
    state: {
      fencedRuntime: { generation: 1 },
      action: { kind: "blocked", reason: "implementation" },
      activeTurn: {
        kind: "awaiting_execution",
        state: { executionId: record.executionId },
      },
    },
  });
  // A later recovery changes nothing: no lease, no second call, and no
  // model request.
  await runArmedAlarm(session);
  expect(
    (await runInDurableObject(session, readSessionState)).lifecycle,
  ).toEqual(held.lifecycle);
  expect(held.record.authority.kind).toBe("bound");
  expect(await readOrganisationLedger(journey.organisation)).toEqual(
    admitted.organisation,
  );
  expect(
    await runInDurableObject(journey.governor, readGovernorLedger),
  ).toEqual(admitted.governor);
  expect(journey.completed).toHaveLength(1);
  expect(journey.requests).toHaveLength(2);

  Object.assign(test.task.meta, {
    evidence: {
      executionId: record.executionId,
      tool: "commerce_propose_campaign_brief",
      action: { kind: "blocked", reason: "implementation" },
      capabilityCompletions: journey.completed.length,
      modelRequests: journey.requests.length,
    },
  });
}, 60_000);

it("stops a script before a read reaches it, when the grant of that read is revoked", async (test) => {
  // The Tool Host has produced the first read. Its result waits for the
  // completion, and has not reached the script.
  const journey = await stopScriptAtCompletion(
    test,
    "EvDurableCodemodeRevokedResult",
    ["held"],
  );
  const { organisation, admitted } = journey;
  const record = admitted.session.record;
  await revokeDiscoveryGrant();
  journey.releaseHeld();

  // The exchange stops the script in place of the result. The execution
  // settles with the one call that ran.
  await expect
    .poll(readSessionSettlement.bind(null, journey.session), {
      timeout: 20_000,
    })
    .toMatchObject({
      state: "settled",
      settle: {
        executionId: record.executionId,
        capabilityCalls: 1,
        outcome: "organisation_failed",
      },
    });
  const settledOrganisation = await readOrganisationLedger(organisation);
  expect(settledOrganisation).toMatchObject({
    reservations: [{ state: "settled" }],
    counters: [{ capability_calls: 1, in_flight_calls: 0 }],
    calls: [{ state: "completed" }],
  });
  expect(journey.completed).toHaveLength(1);
  // What the model reads names the stop, and holds nothing of the read.
  // The Connector refuses the answer of the turn: its authority changed.
  const connector = await connectorActor();
  await expect
    .poll(readCaseWorkOutcome.bind(null, connector), { timeout: 20_000 })
    .toEqual({
      outcome: "retryable",
      reason: "case_delivery_authority_partition_changed",
    });
  const caseWork = await readCaseWorkOutcome(connector);
  expect(journey.requests).toHaveLength(3);
  const result = lastToolText(journey.requests[2]);
  expect(result).toContain("Code Mode stopped the script");
  expect(result).toContain("integration_list are not readable");
  expect(serialized(journey.requests[2] ?? {})).not.toContain(READ_DATA);
  expect(
    await runInDurableObject(journey.session, readAcceptedText),
  ).not.toContain(READ_DATA);
  expect(journey.slack.messages).toEqual([]);

  Object.assign(test.task.meta, {
    evidence: {
      executionId: record.executionId,
      settlement: await runInDurableObject(journey.session, readSettlement),
      settled: JSON.parse(JSON.stringify(settledOrganisation)),
      modelRequests: journey.requests.length,
      scriptResult: result,
      caseWork,
      delivered: journey.slack.messages.map(messageText),
    },
  });
}, 60_000);

it("ends the turn before the script resumes, when a grant was revoked during the downtime", async (test) => {
  // Pi recorded the first read. The second read is in flight at the loss.
  const journey = await stopScriptAtCompletion(
    test,
    "EvDurableCodemodeRevokedDowntime",
    ["pass", "never"],
  );
  const { organisation, governor, admitted } = journey;
  const record = admitted.session.record;
  await controlAdmission(governor, "freeze_admission");
  const session = await loseSession(journey);
  expect(
    (await runInDurableObject(session, readSessionState)).recovery.kind,
  ).toBe("resumable_script");
  await revokeDiscoveryGrant();
  await controlAdmission(governor, "open_admission");
  await runArmedAlarm(session);

  // The resumed turn checks its authority before the harness opens. The
  // turn ends there: no VM starts, and Pi replays nothing.
  await expect
    .poll(runInDurableObject.bind(null, session, readTurnStreams), {
      timeout: 20_000,
    })
    .toMatchObject([{ state: "failed" }]);
  expect(await readLifecycleKind(session)).toBe("sleeping");
  const ended = await runInDurableObject(session, readTurnStreams);
  expect(await runInDurableObject(session, readSettlementOrNull)).toBe(null);
  expect(journey.completed).toHaveLength(2);
  expect(journey.requests).toHaveLength(2);
  const endedOrganisation = await readOrganisationLedger(organisation);
  // The calls are as the lost process left them. The ended turn released
  // the reservation at both owners, and closed the execution.
  expect(endedOrganisation).toMatchObject({
    reservations: [{ state: "cancelled" }],
    counters: admitted.organisation.counters,
    calls: admitted.organisation.calls,
  });
  expect(
    (await runInDurableObject(governor, readGovernorLedger)).reservations,
  ).toMatchObject([{ state: "cancelled" }]);
  const closed = await runInDurableObject(session, readExecutionRecord);
  expect(closed).toMatchObject({
    state: "reconciled",
    projection: {
      kind: "execution_released",
      organisation: "cancelled",
      platform: "cancelled",
    },
  });
  // The Connector reads the turn again at the end of its lease. Its next
  // attempt runs under the new authority, and holds nothing of the reads.
  const connector = await connectorActor();
  await runInDurableObject(connector, endCaseWorkLease);
  await runAlarmHandler(connector);
  await expect
    .poll(readCaseWorkOutcome.bind(null, connector), { timeout: 20_000 })
    .toMatchObject({ outcome: "retryable" });
  const caseWork = await readCaseWorkOutcome(connector);
  for (const request of journey.requests.slice(2))
    expect(serialized(request)).not.toContain(READ_DATA);
  for (const message of journey.slack.messages)
    expect(messageText(message)).not.toContain(READ_DATA);
  expect(journey.completed).toHaveLength(2);

  Object.assign(test.task.meta, {
    evidence: {
      executionId: record.executionId,
      lifecycle: "sleeping",
      turnStreams: ended,
      ledger: JSON.parse(JSON.stringify(endedOrganisation)),
      executionRecord: closed,
      completions: journey.completed.length,
      modelRequests: journey.requests.length,
      caseWork,
      delivered: journey.slack.messages.map(messageText),
    },
  });
}, 60_000);

it("stops a script and admits no later call, when the turn is cancelled during a read", async (test) => {
  const journey = await stopScriptAtCompletion(
    test,
    "EvDurableCodemodeCancelled",
    ["held"],
  );
  const { organisation, governor, admitted } = journey;
  const record = admitted.session.record;
  const running = await runInDurableObject(journey.session, readSessionState);
  const organisationId = parseOrganisationId(
    running.lifecycle.state.identity.organisationId,
  );
  const sessionId = parseSessionId(running.lifecycle.state.identity.sessionId);
  if (!organisationId.ok || !sessionId.ok) throw new Error("Invalid identity");
  // The cancellation waits for the read that the Tool Host still runs.
  const interruption = journey.session.interruptCanonicalEmbeddedHarnessTurn({
    requestId: newRequestId(),
    organisationId: organisationId.value,
    sessionId: sessionId.value,
    interruptedAt: Date.now(),
  });
  await expect
    .poll(readLifecycleKind.bind(null, journey.session), { timeout: 10_000 })
    .toBe("cancelling");
  journey.releaseHeld();
  const interrupted = await interruption;
  expect(interrupted).toMatchObject({
    ok: true,
    value: { kind: "interrupted" },
  });
  expect(await readLifecycleKind(journey.session)).toBe("sleeping");

  // The read that was in flight ended, and released its claim. The script
  // made no second read, and the model was not asked again.
  await expect
    .poll(journey.slack.visibleMessageCount, { timeout: 20_000 })
    .toBe(1);
  const cancelledOrganisation = await readOrganisationLedger(organisation);
  const cancelledGovernor = await runInDurableObject(
    governor,
    readGovernorLedger,
  );
  // The cancelled turn settles no script. It released the reservation at
  // both owners, with the one call that ran, and closed the execution.
  expect(cancelledOrganisation).toMatchObject({
    reservations: [{ state: "cancelled", runtime_generation: 1 }],
    counters: [{ capability_calls: 1, in_flight_calls: 0 }],
    calls: [{ state: "completed" }],
  });
  expect(cancelledGovernor.reservations).toMatchObject([
    { state: "cancelled" },
  ]);
  expect(await runInDurableObject(journey.session, readSettlementOrNull)).toBe(
    null,
  );
  const closed = await runInDurableObject(journey.session, readExecutionRecord);
  expect(closed).toMatchObject({
    state: "reconciled",
    projection: {
      kind: "execution_released",
      organisation: "cancelled",
      platform: "cancelled",
    },
  });
  expect(journey.completed).toHaveLength(1);
  expect(journey.requests).toHaveLength(2);
  expect(journey.slack.messages.map(messageText)).toEqual([TURN_FAILED_NOTICE]);
  const ended = await runInDurableObject(journey.session, readTurnStreams);
  expect(ended).toMatchObject([{ state: "failed" }]);
  expect(await readLifecycleKind(journey.session)).toBe("sleeping");

  Object.assign(test.task.meta, {
    evidence: {
      executionId: record.executionId,
      interrupted,
      turnStreams: ended,
      executionRecord: closed,
      ledger: ledgerEvidence(cancelledOrganisation, cancelledGovernor),
      modelRequests: journey.requests.length,
      delivered: journey.slack.messages.map(messageText),
    },
  });
}, 60_000);

const FINAL: ModelReply = { text: FINAL_ANSWER };

const CAMPAIGN_BRIEF = {
  objective: "Sell the cookie box before the holiday.",
  targets: [],
  channel: "Shop newsletter",
  audienceDescription: "Customers who bought a gift box last year.",
  messageVariants: [
    { variantId: "a", headline: "Cookie box", body: "Six assorted cookies." },
  ],
  requestedBudgetMinor: 0,
  currency: "JPY",
  windowStart: "2026-12-01",
  windowEnd: "2026-12-24",
  disclosures: [],
  supportingEvidence: "The cookie box is prepared for the online channel.",
};
const SECOND_SCRIPT = scriptReply("text('second attempt');");

/**
 * Holds, for good, the first Pi commit that writes the result of a Code Mode
 * call: the state that a process lost after the receipt commit leaves.
 */
function holdCodeModeResultCommit(test: TestContext): { reached: boolean } {
  // The Actor sets a flag that the journey polls. A promise that the Actor
  // resolves would continue the journey in the Actor's I/O context.
  const held = { reached: false };
  const prototype = ActorSqliteDatabase.prototype;
  const original = prototype.transaction;
  prototype.transaction = function heldTransaction<T>(
    this: ActorSqliteDatabase & { writes?: unknown },
    callback: Parameters<ActorSqliteDatabase["transaction"]>[0],
  ): Promise<T> {
    if (!held.reached && writesCodeModeResult(this.writes)) {
      held.reached = true;
      return new Promise<T>(neverSettles);
    }
    return original.call(this, callback) as Promise<T>;
  } as ActorSqliteDatabase["transaction"];
  test.onTestFinished(restoreTransaction.bind(null, original));
  return held;
}

function isHeld(held: { reached: boolean }): boolean {
  return held.reached;
}

function restoreTransaction(
  original: ActorSqliteDatabase["transaction"],
): void {
  ActorSqliteDatabase.prototype.transaction = original;
}

function writesCodeModeResult(writes: unknown): boolean {
  if (!Array.isArray(writes)) return false;
  for (const write of writes) {
    if (!isRecord(write) || write.type !== "entry" || !isRecord(write.value))
      continue;
    const model = write.value.model;
    if (
      write.value.kind === "pi.tool-result" &&
      Array.isArray(model) &&
      isRecord(model[0]) &&
      model[0].toolName === "codemode"
    )
      return true;
  }
  return false;
}

function neverSettles(): void {}

/** The Code Mode receipt of the turn, and whether Pi has ended its call. */
function readCodeModeWindow(_actor: unknown, state: DurableObjectState) {
  const sql = state.storage.sql;
  const receipt = sql
    .exec<{ content: string }>(
      `SELECT r.content FROM documents d
       JOIN document_revisions r ON r.document_id = d.id
       WHERE d.kind = ? AND r.seq = (SELECT MAX(seq) FROM document_revisions WHERE document_id = d.id)`,
      JSON.stringify("pantry.codemode.result"),
    )
    .toArray()[0];
  const saved: unknown =
    receipt === undefined ? null : JSON.parse(receipt.content);
  const open = sql
    .exec(
      "SELECT 1 FROM tasks WHERE kind = ? AND status <> 'terminal' AND json_extract(record, '$.input.kind') = 'model'",
      JSON.stringify("pi.tool"),
    )
    .toArray().length;
  return {
    receipt: isRecord(saved) && isRecord(saved.state) ? saved.state.kind : null,
    callOpen: open === 1,
  };
}

function offeredTools(body: Record<string, unknown> | undefined): string[] {
  if (body === undefined || !Array.isArray(body.tools)) return [];
  const names: string[] = [];
  for (const tool of body.tools)
    if (
      isRecord(tool) &&
      isRecord(tool.function) &&
      typeof tool.function.name === "string"
    )
      names.push(tool.function.name);
  return names;
}

/**
 * Sends one Slack message whose turn runs the script, and returns when the
 * script waits at the first completion that is not `pass`.
 */
async function stopScriptAtCompletion(
  test: TestContext,
  eventId: string,
  completions: readonly Passage[],
  afterScript: readonly ModelReply[] = [FINAL],
) {
  const journey = await startScriptTurn(test, {
    eventId,
    completions,
    replies: [DISCOVER_INTEGRATION_LIST, scriptReply(SCRIPT), ...afterScript],
  });
  const admitted = await readAdmitted(journey);
  expect(admitted.organisation).toMatchObject({
    reservations: [{ state: "reserved", runtime_generation: 1 }],
    counters: [{ in_flight_calls: 1 }],
  });
  return { ...journey, admitted };
}

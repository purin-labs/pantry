import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { resolveActiveCaseActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { parseCaseId } from "@purin-labs/kernel/ids";
import {
  countCalls,
  countRecordedScriptCalls,
  deliverAfterConnectorLease,
  installListingAuthority,
  lastToolText,
  ledgerEvidence,
  loseSession,
  messageText,
  readAcceptedText,
  readAdmitted,
  readDeliveredToolCalls,
  readGovernorLedger,
  readOrganisationLedger,
  readProposedActions,
  readSessionState,
  readSettlement,
  scriptReply,
  startScriptTurn,
  type ModelReply,
} from "./durable-codemode-journey-support";
import {
  effectEvidence,
  listingProposalRequest,
  listingReadRequests,
} from "./pi-sdk-effect-support";
import { ORGANISATION_ID } from "./slack-journey-support";

// Plan 50A, Phase E. The main acceptance journey, and the rule that it rests
// on: a script may repeat an interrupted proposal, because the owners of a
// proposal answer a repeated one from the first. The Session, Case,
// Organisation, and governor Actors, the Pi harness, and the sandbox Worker
// are the real ones. The model responses are controlled.

const FINAL_ANSWER = "LISTING_PROPOSED";
const FINAL: ModelReply = { text: FINAL_ANSWER };
const DISCOVER_READ: ModelReply = {
  tool: "tool_search",
  args: { query: "commerce_entity_context", limit: 1 },
};
const DISCOVER_PROPOSAL: ModelReply = {
  tool: "tool_search",
  args: { query: "commerce_propose_action", limit: 1 },
};

// The budget of a script admits two calls at a time. The script reads the
// four records of the listing as two pairs, counts what it read, and
// proposes the publication of the listing.
const LISTING_SCRIPT = `const requests = ${JSON.stringify(listingReadRequests())};
let entities = 0;
for (const pair of [requests.slice(0, 2), requests.slice(2)]) {
  const graphs = await Promise.all(pair.map((request) => tools.commerce_entity_context({ request })));
  for (const graph of graphs) {
    if (!graph.ok) throw new Error(graph.error.message);
    entities += graph.result.entities.length;
  }
}
const proposed = JSON.parse(await tools.commerce_propose_action({ request: ${JSON.stringify(listingProposalRequest())} }));
text({ entities, proposal: proposed.proposalId, nonce: proposed.nonce });`;

it("finishes a script of parallel reads and one proposal across two losses of its Session Actor, with one proposal", async (test) => {
  // The first pair of reads completes. One read of the second pair
  // completes, and the other is in flight at the first loss. After that
  // recovery, the completion of the proposal is in flight at the second loss.
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeAcceptance",
    install: installListingAuthority,
    text: "<@U0PANTRY> Read the prepared cookie listing and propose its publication.",
    completions: ["pass", "pass", "pass", "never", "pass", "never"],
    replies: [
      DISCOVER_READ,
      DISCOVER_PROPOSAL,
      scriptReply(LISTING_SCRIPT),
      FINAL,
    ],
  });
  const { organisation, governor } = journey;
  await expect
    .poll(
      runInDurableObject.bind(null, journey.session, countRecordedScriptCalls),
      {
        timeout: 20_000,
      },
    )
    .toBe(3);
  const admitted = await readAdmitted(journey);
  const record = admitted.session.record;
  expect(admitted.organisation).toMatchObject({
    counters: [{ capability_calls: 4, in_flight_calls: 1 }],
  });
  const reads = admitted.organisation.calls.map(callId);
  expect(new Set(reads).size).toBe(4);
  const interruptedRead = admitted.organisation.calls.find(isClaimed);
  if (interruptedRead === undefined) throw new Error("Missing read in flight");
  expect(await runInDurableObject(organisation, readProposedActions)).toEqual(
    [],
  );

  // First loss. Pi gives the three recorded reads to the script again, and
  // only the interrupted read reaches the Tool Host again. The script goes
  // on to its proposal.
  let session = await loseSession(journey);
  await expect
    .poll(countCalls.bind(null, journey.completed), { timeout: 30_000 })
    .toBe(6);
  expect([...journey.completed.slice(0, 4)].sort()).toEqual([...reads].sort());
  expect(journey.completed[4]).toBe(interruptedRead.call_id);
  const proposalCall = journey.completed[5];
  if (proposalCall === undefined) throw new Error("Missing proposal call");
  expect(reads).not.toContain(proposalCall);
  // The proposal exists at its owners before the script has its answer.
  const [proposed, ...otherActions] = await runInDurableObject(
    organisation,
    readProposedActions,
  );
  if (proposed === undefined) throw new Error("Missing proposed action");
  expect(otherActions).toEqual([]);
  expect(
    (await runInDurableObject(session, readSessionState)).lifecycle,
  ).toMatchObject({
    kind: "processing",
    state: { runtimeLease: { generation: 2 } },
  });

  // Second loss, with the answer of the proposal in flight. The call runs
  // again under its first call ID. Its owners answer with the first
  // proposal, and the script finishes.
  session = await loseSession({ session, sessionName: journey.sessionName });
  await deliverAfterConnectorLease(journey, session);
  expect(journey.completed).toHaveLength(7);
  expect(journey.completed[6]).toBe(proposalCall);
  expect(journey.requests).toHaveLength(4);
  // The script has the proposal, and no failure in its place.
  expect(lastToolText(journey.requests[3])).toContain(
    JSON.stringify({
      entities: 4,
      proposal: proposed.proposal_id,
      nonce: proposed.nonce,
    }),
  );
  expect(journey.slack.messages.map(messageText).join("\n")).toContain(
    FINAL_ANSWER,
  );

  // One proposal at the Organisation and at the Case. No provider change:
  // the proposal waits for a person.
  expect(await runInDurableObject(organisation, readProposedActions)).toEqual([
    proposed,
  ]);
  const action = await organisation.getAction({
    organisationId: ORGANISATION_ID,
    nonce: proposed.nonce,
    now: Date.now(),
  });
  if (!action.ok) throw new Error(action.error.code);
  const caseId = parseCaseId(action.value.caseId);
  if (!caseId.ok) throw new Error("Invalid Case of the proposal");
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: ORGANISATION_ID,
    caseId: caseId.value,
    now: Date.now(),
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  expect(await runInDurableObject(caseActor.value, readCaseProposals)).toEqual({
    proposals: [proposed.proposal_id],
    approvals: [
      { action_nonce: proposed.nonce, proposal_id: proposed.proposal_id },
    ],
  });
  expect(await effectEvidence()).toMatchObject({ mutations: 0 });

  // Five calls, each counted once, and one settlement of one execution.
  const settledOrganisation = await readOrganisationLedger(organisation);
  const settledGovernor = await runInDurableObject(
    governor,
    readGovernorLedger,
  );
  expect(settledOrganisation.counters).toMatchObject([
    { capability_calls: 5, in_flight_calls: 0 },
  ]);
  expect(settledOrganisation.calls.map(callId).sort()).toEqual(
    [...reads, proposalCall].sort(),
  );
  expect(settledOrganisation.calls.every(isCompleted)).toBe(true);
  expect(settledOrganisation.reservations).toMatchObject([
    {
      execution_id: record.executionId,
      state: "settled",
      runtime_generation: 3,
    },
  ]);
  expect(settledGovernor.reservations).toMatchObject([
    {
      execution_id: record.executionId,
      state: "settled",
      runtime_generation: 3,
    },
  ]);
  const settlement = await runInDurableObject(session, readSettlement);
  expect(settlement).toMatchObject({
    state: "settled",
    settle: {
      executionId: record.executionId,
      capabilityCalls: 5,
      outcome: "succeeded",
    },
  });
  // The reservation names the engine that ran the script.
  const engine = await runInDurableObject(organisation, readReservedEngine);
  expect(engine.placement).toBe("cloudflare_sandbox_worker");
  expect(engine.runtime_revision).toMatch(/^pi-codemode-sandbox-/);
  // What the Session accepted holds the report of the script, and no read.
  // The two restarts delivered the call of the script one time, and no call
  // that the script made.
  const accepted = await runInDurableObject(session, readAcceptedText);
  expect(accepted).toContain(proposed.nonce);
  expect(accepted).not.toContain('"entities":[');
  expect(await runInDurableObject(session, readDeliveredToolCalls)).toEqual([
    "tool_search",
    "tool_search",
    "codemode",
  ]);

  Object.assign(test.task.meta, {
    evidence: {
      executionId: record.executionId,
      faultPoints: [
        "Session Actor lost with one read of a pair in flight",
        "Session Actor lost with the answer of the proposal in flight",
      ],
      toolHostCompletions: {
        reads: 5,
        proposal: 2,
        interruptedRead: interruptedRead.call_id,
        proposalCall,
      },
      proposal: proposed,
      providerMutations: 0,
      ledgers: ledgerEvidence(settledOrganisation, settledGovernor),
      engine,
      settlement,
      modelRequests: journey.requests.length,
      delivered: journey.slack.messages.length,
    },
  });
}, 120_000);

function callId(call: { readonly call_id: string }): string {
  return call.call_id;
}

function isClaimed(call: { readonly state: string }): boolean {
  return call.state === "claimed";
}

function isCompleted(call: { readonly state: string }): boolean {
  return call.state === "completed";
}

function readReservedEngine(_actor: unknown, state: DurableObjectState) {
  return state.storage.sql
    .exec<{ runtime_revision: string; placement: string }>(
      "SELECT runtime_revision, json_extract(placement_json, '$.kind') AS placement FROM code_execution_reservation",
    )
    .one();
}

function readCaseProposals(_actor: unknown, state: DurableObjectState) {
  const sql = state.storage.sql;
  return {
    proposals: sql
      .exec<{ proposal_id: string }>(
        "SELECT proposal_id FROM case_commerce_proposal ORDER BY proposal_id",
      )
      .toArray()
      .map(proposalId),
    approvals: sql
      .exec<{ action_nonce: string; proposal_id: string }>(
        "SELECT action_nonce, proposal_id FROM case_commerce_approval ORDER BY action_nonce",
      )
      .toArray(),
  };
}

function proposalId(row: { readonly proposal_id: string }): string {
  return row.proposal_id;
}

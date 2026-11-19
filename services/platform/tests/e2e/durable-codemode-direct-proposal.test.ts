import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";
import { OrganisationDO } from "../../src/actors/organisation";
import {
  countCalls,
  installListingAuthority,
  loseSession,
  organisationActor,
  readLifecycle,
  readProposedActions,
  scriptReply,
  startScriptTurn,
} from "./durable-codemode-journey-support";
import {
  listingProposalRequest,
  listingReadCode,
} from "./pi-sdk-effect-support";

// Plan 50A, Phase E. A script may repeat an interrupted proposal. A direct
// call of the model keeps the rule that it had: an operator resolves it. Pi
// holds one replay rule for each tool, so the recovery guard keeps this rule.
// The listing fixture seeds its provider one time, so this journey has its
// own file.

it("keeps a turn stopped, when a direct proposal of the model was in flight at the loss", async (test) => {
  // The model reads the listing with a script, then proposes with a direct
  // call. The Case holds the proposal, and the call waits for the ledger of
  // the Organisation when the process is lost.
  const ledgerCalls: string[] = [];
  const journey = await startScriptTurn(test, {
    eventId: "EvDurableCodemodeDirectProposal",
    install: installListingWithOpenLedgerCalls.bind(null, test, ledgerCalls),
    text: "<@U0PANTRY> Read the prepared cookie listing and propose its publication.",
    replies: [
      {
        tool: "tool_search",
        args: { query: "commerce_entity_context", limit: 1 },
      },
      {
        tool: "tool_search",
        args: { query: "commerce_propose_action", limit: 1 },
      },
      scriptReply(listingReadCode()),
      {
        tool: "commerce_propose_action",
        args: { request: listingProposalRequest() },
      },
      { text: "LISTING_PROPOSED" },
    ],
  });
  await expect
    .poll(countCalls.bind(null, ledgerCalls), { timeout: 30_000 })
    .toBe(1);

  // A script may repeat this call. A direct call keeps its rule: the
  // recovery stays blocked for an operator, and nothing runs again.
  const session = await loseSession(journey);
  const held = await runInDurableObject(session, readLifecycle);
  expect(held).toMatchObject({
    kind: "recovering",
    state: {
      fencedRuntime: { generation: 1 },
      action: { kind: "blocked", reason: "implementation" },
    },
  });
  expect(await runDurableObjectAlarm(session)).toBe(true);
  expect(await runInDurableObject(session, readLifecycle)).toEqual(held);
  expect(ledgerCalls).toHaveLength(1);
  expect(journey.requests).toHaveLength(4);
  expect(
    await runInDurableObject(journey.organisation, readProposedActions),
  ).toEqual([]);

  Object.assign(test.task.meta, {
    evidence: {
      tool: "commerce_propose_action",
      caller: "model",
      action: { kind: "blocked", reason: "implementation" },
      ledgerCalls: ledgerCalls.length,
      modelRequests: journey.requests.length,
    },
  });
}, 60_000);

/**
 * The listing Organisation, whose ledger keeps each proposal that reaches it
 * open for good and does not record it.
 */
async function installListingWithOpenLedgerCalls(
  test: TestContext,
  calls: string[],
): Promise<void> {
  await installListingAuthority();
  await runInDurableObject(
    await organisationActor(),
    keepLedgerCallsOpen.bind(null, test, calls),
  );
}

function keepLedgerCallsOpen(
  test: TestContext,
  calls: string[],
  actor: unknown,
): void {
  if (!(actor instanceof OrganisationDO))
    throw new Error("Unexpected Organisation Actor");
  const prototype: unknown = Object.getPrototypeOf(actor);
  if (!isRecord(prototype)) throw new Error("Unexpected Organisation Actor");
  const original = actor.proposeAction;
  Object.defineProperty(prototype, "proposeAction", {
    value: function open(input: { readonly proposalId: string }) {
      calls.push(input.proposalId);
      return new Promise(neverSettles);
    },
    configurable: true,
    writable: true,
  });
  test.onTestFinished(restoreLedger.bind(null, prototype, original));
}

function restoreLedger(prototype: object, original: unknown): void {
  Object.defineProperty(prototype, "proposeAction", {
    value: original,
    configurable: true,
    writable: true,
  });
}

function neverSettles(): void {}

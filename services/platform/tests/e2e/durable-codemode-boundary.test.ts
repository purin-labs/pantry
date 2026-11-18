import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { CODE_MODE_EXCHANGE_LIMITS } from "../../src/actors/code-mode-governed-remote";
import {
  createWorld,
  dispatchCount,
  finish,
  hold,
  release,
  scriptTurn,
  startProcess,
  submitScript,
  type ProbeOptions,
  type ProbeProcess,
} from "./durable-codemode-support";

// Plan 50A, Phase A. These journeys run Pi's durable Code Mode tool in
// Workerd, with the VM in a second Worker, through the two Pantry boundaries
// that Pi cannot own: the governed exchange and the journal bound. The tools
// stand in for the Tool Host, and the gate for the live authority.

const HOUR = 60 * 60 * 1000;

function actorStorage(name: string) {
  const actor = env.SESSION.get(
    env.SESSION.idFromName(`durable-codemode-${name}`),
  );
  return <T>(journey: (storage: DurableObjectStorage) => Promise<T>) =>
    runInDurableObject(actor, (_actor, state) => journey(state.storage));
}

const WAITING_SCRIPT = `
const c = await tools.orders_read({ shop: "c" });
text("LATE " + JSON.stringify(c));
`;

it("ends a script without a timeout at the admitted deadline, and refuses to start it after the deadline", async ({
  task,
}) => {
  const evidence = await actorStorage("deadline")(async (storage) => {
    const world = createWorld();
    const live = scriptTurn(WAITING_SCRIPT);
    void hold(world, "orders_read:c");
    const startedAt = Date.now();
    const process = await startProcess(storage, {
      world,
      faux: live.faux,
      executionName: "execution-deadline-live",
      deadlineAt: startedAt + 600,
    });
    await submitScript(process);
    await finish(process);
    const liveElapsedMs = Date.now() - startedAt;
    return {
      live: live.outcome(),
      liveDenials: process.gate.denials,
      liveElapsedMs,
      liveDispatches: dispatchCount(world, "orders_read:c"),
    };
  });
  const restarted = await actorStorage("deadline-restart")(async (storage) => {
    const world = createWorld();
    const turn = scriptTurn(WAITING_SCRIPT);
    const options: ProbeOptions = {
      world,
      faux: turn.faux,
      executionName: "execution-deadline-restart",
      deadlineAt: Date.now() + 500,
    };
    const read = hold(world, "orders_read:c");
    const first = await startProcess(storage, options);
    await submitScript(first);
    await read;
    first.kill();
    release(world, "orders_read:c");
    await scheduler.wait(700);
    const second = await startProcess(storage, options);
    await finish(second);
    return {
      outcome: turn.outcome(),
      denials: second.gate.denials,
      delivered: second.gate.delivered,
    };
  });
  Object.assign(task.meta, { evidence: { ...evidence, restarted } });

  expect(evidence.liveDenials).toEqual([
    expect.objectContaining({ code: "code_mode_deadline_expired" }),
  ]);
  expect(evidence.live.isError).toBe(true);
  expect(evidence.live.text).not.toContain("LATE");
  expect(evidence.liveElapsedMs).toBeLessThan(5_000);
  expect(evidence.liveDispatches).toBe(1);

  // After the restart, the turn ends. No VM starts and no result is delivered.
  expect(restarted.denials).toEqual([
    expect.objectContaining({ code: "code_mode_deadline_expired" }),
  ]);
  expect(restarted.delivered).toEqual([]);
  expect(restarted.outcome.isError).toBe(true);
  expect(restarted.outcome.text).not.toContain("LATE");
  expect(restarted.outcome.modelCalls).toBe(2);
});

async function runOnce(
  name: string,
  code: string,
  options: Partial<ProbeOptions> = {},
) {
  return actorStorage(name)(async (storage) => {
    const world = createWorld();
    const turn = scriptTurn(code);
    const startedAt = Date.now();
    const process: ProbeProcess = await startProcess(storage, {
      world,
      faux: turn.faux,
      executionName: `execution-${name}`,
      deadlineAt: Date.now() + HOUR,
      ...options,
    });
    await submitScript(process);
    await finish(process);
    return {
      outcome: turn.outcome(),
      denials: process.gate.denials,
      delivered: process.gate.delivered.length,
      journal: await process.gate.journalAtDenial,
      elapsedMs: Date.now() - startedAt,
    };
  });
}

function record(task: TestContext["task"], evidence: object) {
  Object.assign(task.meta, { evidence });
}

it("bounds the journal, discovery calls, arguments, computation, and output", async ({
  task,
}) => {
  const discovery = `
let count = 0;
for (let index = 0; index < 60; index += 1) {
  await searchTools("orders");
  count += 1;
}
text("COUNT " + count);
`;
  // Pi has no journal limit. The exchange admits a bounded number of calls,
  // and Pi records one entry for each result that it delivers.
  const journal = await runOnce("journal-entries", discovery, {
    exchangeLimits: { ...CODE_MODE_EXCHANGE_LIMITS, maxJournalEntries: 3 },
  });
  const journalBytes = await runOnce("journal-bytes", discovery, {
    exchangeLimits: { ...CODE_MODE_EXCHANGE_LIMITS, maxJournalBytes: 2048 },
  });
  // Each discovery call adds one journal entry. Its own limit comes first.
  const discoveryLimit = await runOnce("discovery-limit", discovery);
  const argument = await runOnce(
    "argument-limit",
    `await tools.orders_read({ shop: "x".repeat(70000) }); text("SENT");`,
  );
  const compute = await runOnce(
    "compute",
    `let n = 0; for (;;) n += 1; text("NEVER");`,
  );
  const output = await runOnce(
    "output",
    `text("HEAD " + "x".repeat(400000) + " TAIL");`,
  );
  const evidence = {
    journal,
    journalBytes,
    discoveryLimit,
    argument,
    compute,
    output: { ...output, outcome: { ...output.outcome, text: undefined } },
    outputBytes: new TextEncoder().encode(output.outcome.text).byteLength,
    outputHead: output.outcome.text.slice(0, 160),
    outputTail: output.outcome.text.slice(-260),
  };
  record(task, evidence);

  expect(journal.denials).toEqual([
    expect.objectContaining({ code: "code_mode_journal_limit" }),
  ]);
  expect(journal.outcome.isError).toBe(true);
  expect(journal.outcome.text).not.toContain("COUNT");
  // The fourth call did not reach Pi, so the journal holds three entries.
  expect(journal.delivered).toBe(3);
  expect(journal.journal?.entries).toBe(3);

  // The entry that crosses the byte limit is recorded, and it is the last.
  expect(journalBytes.denials).toEqual([
    expect.objectContaining({ code: "code_mode_journal_limit" }),
  ]);
  expect(journalBytes.outcome.isError).toBe(true);
  expect(journalBytes.journal?.bytes).toBeLessThan(2048 + 2048);

  expect(discoveryLimit.denials).toEqual([
    expect.objectContaining({ code: "code_mode_discovery_limit" }),
  ]);
  expect(discoveryLimit.delivered).toBe(32);
  expect(discoveryLimit.outcome.isError).toBe(true);
  expect(discoveryLimit.outcome.text).not.toContain("COUNT");

  expect(argument.denials).toEqual([
    expect.objectContaining({ code: "code_mode_argument_limit" }),
  ]);
  expect(argument.outcome.text).not.toContain("SENT");

  // A script that only computes ends by the sandbox's interrupt budget.
  expect(compute.outcome.isError).toBe(true);
  expect(compute.outcome.text).not.toContain("NEVER");
  expect(compute.elapsedMs).toBeLessThan(20_000);

  // No execution environment exists. Pi cuts the output to its budget and
  // names no file.
  expect(output.outcome.isError).toBe(false);
  expect(evidence.outputBytes).toBeLessThan(100_000);
  expect(output.outcome.text).toContain("HEAD");
  expect(output.outcome.text).not.toMatch(/pi-codemode-|\/tmp\//u);
});

// The engine's persistent host, through the native `serve` command or the
// Wasm module of a runtime bundle, for the Node journeys. Each host answers
// one command per call (`send`). The native host also runs the engine's
// command line (`cli`), so a journey can compare the two; the Wasm module has
// no command line (Refactor 16, step 11).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export class NativeHost {
  /** `output` holds the command line's input and output files. */
  constructor(root, binary, output) {
    this.root = root;
    this.binary = binary;
    this.output = output;
    this.child = spawn(
      binary,
      ["--root", root, "--output", join(output, "serve-closed.json"), "serve"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    this.lines = createInterface({ input: this.child.stdout })[
      Symbol.asyncIterator
    ]();
  }
  async send(command) {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    return JSON.parse((await this.lines.next()).value);
  }
  /** The command line of the same runner, writing to a new file. */
  cli(command, files) {
    const paths = files.map((text, index) => {
      const path = join(
        this.output,
        `native-input-${Date.now()}-${index}.json`,
      );
      writeFileSync(path, text);
      return path;
    });
    const out = join(this.output, `native-output-${Date.now()}.json`);
    const result = spawnSync(
      this.binary,
      ["--root", this.root, "--output", out, ...command(paths)],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(out, "utf8");
    for (const path of [...paths, out]) rmSync(path);
    return text;
  }
  async close() {
    const done = once(this.child, "exit");
    this.child.stdin.end();
    await done;
  }
}

export class WasmHost {
  constructor(module) {
    this.module = module;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
  }
  async send(command) {
    const module = this.module;
    const bytes = this.encoder.encode(JSON.stringify(command));
    const pointer = module._bakery_alloc(bytes.length);
    module.HEAPU8.set(bytes, pointer);
    const code = module._bakery_cell_command(pointer, bytes.length);
    module._bakery_free(pointer, bytes.length);
    const start = module._bakery_response_pointer();
    const text = this.decoder.decode(
      module.HEAPU8.subarray(start, start + module._bakery_response_length()),
    );
    assert.equal(code, 0, text);
    return JSON.parse(text);
  }
  async close() {}
}

/** One command of the host's program namespace; its reply. */
export async function program(host, command) {
  const reply = await host.send({ op: "program", command });
  assert.equal(reply.kind, "program", JSON.stringify(reply).slice(0, 400));
  return reply.reply;
}

/** Runs one program to its end in calls of `steps`. */
export async function runProgram(host, job, value, steps) {
  let reply = await program(host, { op: "open", job, program: value });
  let calls = 0;
  let lastStep = -1;
  while (reply.kind === "running") {
    assert.ok(reply.planned > 0, "A running job names its expected length");
    lastStep = reply.step;
    reply = await program(host, { op: "advance", job, steps });
    calls += 1;
  }
  assert.equal(reply.kind, "finished", JSON.stringify(reply).slice(0, 400));
  return { output: reply.output, calls, lastStep };
}

/**
 * A stored cell checkpoint ({ content, digest }, as `export` and the native
 * command line's `cell` output give it) as the checkpoint's fields: the
 * payload of its envelope with its digest.
 */
export function checkpointFields(stored) {
  return { ...JSON.parse(stored.content).payload, digest: stored.digest };
}

async function expectReply(host, command, kind) {
  const reply = await host.send(command);
  if (reply.kind !== kind)
    throw new Error(`${command.op}: ${JSON.stringify(reply).slice(0, 400)}`);
  return reply;
}

/**
 * One request of the command line's `cell` mode ({ initial, actions }),
 * through the host commands: the cell opens new or restored, takes its
 * actions, and is exported. The reply has the fields of the command line's
 * output that a journey reads: `results` (admitted, removed, started,
 * refused, advanced, terminal), `checkpoint` (its fields, see
 * `checkpointFields`), `stored`, `sequence`, `observation`, and `hold`, the
 * hold that the last advance offered. A refused change or start throws, as
 * the command line fails the whole request.
 */
export async function cellRequest(host, { initial, actions }) {
  const opened =
    initial.kind === "create"
      ? { cell: initial.definition.cellId, opening: initial }
      : {
          cell: checkpointFields(initial).definition.cellId,
          opening: {
            kind: "restore",
            content: initial.content,
            digest: initial.digest,
            sequence: initial.sequence,
          },
        };
  const { cell } = opened;
  const open = await expectReply(
    host,
    { op: "open", cell, opening: opened.opening },
    "opened",
  );
  let running = open.operation ?? null;
  let hold = null;
  const results = [];
  const boundary = async (change, kind) => {
    const name = `${change.kind}-${results.length}`;
    const prepared = await expectReply(
      host,
      { op: "prepare", cell, boundary: name, change },
      "prepared",
    );
    await expectReply(
      host,
      { op: "commit", cell, boundary: name },
      "committed",
    );
    results.push({ kind, observation: prepared.observation });
  };
  // Advances the running operation, or the idle cell, by at most `steps`;
  // true when the operation ended.
  const advance = async (steps) => {
    let left = steps;
    while (left > 0) {
      const call = running === null ? Math.min(left, 32) : left;
      const reply = await expectReply(
        host,
        { op: "advance", cell, steps: call },
        "advanced",
      );
      hold = reply.hold ?? null;
      if (reply.stop === "terminal") {
        const { observation } = await expectReply(
          host,
          { op: "observe", cell },
          "observed",
        );
        results.push({
          kind: "terminal",
          attemptId: running.attemptId,
          outcome: reply.outcome,
          steps: reply.outcome.step,
          observation,
        });
        running = null;
        return true;
      }
      left -=
        running === null
          ? call
          : reply.segment.endStep - reply.segment.startStep;
    }
    return false;
  };
  for (const action of actions) {
    switch (action.kind) {
      case "admit":
        await boundary(
          { kind: "admission", carrier: action.carrier },
          "admitted",
        );
        break;
      case "remove":
        await boundary({ kind: "removal", carrier: action.carrier }, "removed");
        break;
      case "start": {
        const reply = await host.send({
          op: "start",
          cell,
          attemptId: action.attemptId,
          task: action.task,
        });
        if (reply.kind === "started") {
          running = { attemptId: reply.attemptId };
          results.push({
            kind: "started",
            attemptId: reply.attemptId,
            plan: reply.plan,
          });
        } else if (reply.kind === "refused")
          results.push({
            kind: "refused",
            attemptId: reply.attemptId,
            outcome: reply.outcome,
          });
        else throw new Error(`start: ${JSON.stringify(reply).slice(0, 400)}`);
        break;
      }
      case "advance":
        if (!(await advance(action.steps)))
          results.push({ kind: "advanced", steps: action.steps });
        break;
      case "finish":
        if (running === null) throw new Error("No operation is running");
        while (!(await advance(1_000_000)));
        break;
      default:
        throw new Error(`Unknown cell action ${action.kind}`);
    }
  }
  const exported = await expectReply(host, { op: "export", cell }, "exported");
  const { observation } = await expectReply(
    host,
    { op: "observe", cell },
    "observed",
  );
  await expectReply(host, { op: "dispose", cell }, "disposed");
  const stored = {
    content: exported.content,
    digest: exported.checkpoint.digest,
  };
  return {
    results,
    stored,
    checkpoint: checkpointFields(stored),
    sequence: exported.sequence,
    observation,
    hold,
  };
}

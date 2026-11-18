// Refactor 16 step 5: the one-shot commands as host programs.
//
//   node scripts/production-simulation/verify-host-programs.mjs NEW_OUTPUT_DIRECTORY
//     [--runtime BUNDLE_DIRECTORY]
//
// The Portal runs each one-shot job (a transfer, an oven loading, a cycle, a
// retrieval and a rack continuation) as a program of the persistent host, in
// bounded calls. This journey runs each program through the native `serve`
// host and through the Wasm module, in calls of 1,000 and 4,096 steps, and
// checks that its output has the same bytes as its reference: on the native
// runner the command line's file, in the Wasm module (which has no command
// line since Refactor 16 step 11) the same program in one call. It
// also closes a job in the middle of an operation and runs the next job in
// the same host, which must give the same bytes again. This replaces the
// bounded stepping journeys of Plan 70E E1: `Session` and the `step`
// command are gone, and the host programs are their one bounded path.
//
// Refactor 16 step 7: each operation of each output reports its margins
// against the robot's rated limits. An accepted operation stays below each
// rated speed with no warning, except the UR5e's retrieval in the rack
// cycle, which warns of a deep contact; the rack cycle's slip case fails
// with the slip warning.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BAKERY_BROWSER_BUNDLE } from "../../packages/production-simulation/src/simulator/browser-physics-asset.ts";
import { runtimeModule } from "./build-execution-bundle.mjs";
import { NativeHost, WasmHost, program, runProgram } from "./engine-hosts.mjs";
import {
  assertAcceptedMargins,
  assertMargins,
  assertNotMeasured,
  outcomesIn,
} from "./operation-margins.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const binary = join(root, "crates/bakery-native/target/release/bakery-native");
const args = process.argv.slice(2);
let runtime = join(
  root,
  "apps/portal/public/bakery-physics/bundles",
  BAKERY_BROWSER_BUNDLE.id,
);
let output = null;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--runtime") runtime = resolve(args[++index]);
  else if (output === null) output = resolve(args[index]);
  else throw new Error(`Unknown argument ${args[index]}`);
}
assert.ok(
  output !== null && !existsSync(output),
  "Name a new output directory",
);
mkdirSync(output, { recursive: true });

// Enough steps for any one-shot program in one call; a Wasm usize has 32 bits.
const ONE_CALL = 1_000_000_000;
let jobs = 0;
function runJob(host, value, steps) {
  return runProgram(host, `job-${++jobs}`, value, steps);
}

const report = { runtime: BAKERY_BROWSER_BUNDLE.id, hosts: {} };
for (const [name, open] of [
  ["native", () => new NativeHost(root, binary, output)],
  ["wasm", async () => new WasmHost(await runtimeModule(runtime))],
]) {
  const host = await open();
  const { request: rack } = await program(host, {
    op: "prepare",
    preparation: { robot: "fairino-fr10", task: "table-to-rack" },
  });
  const { request: oven } = await program(host, {
    op: "prepare",
    preparation: { task: "table-to-oven" },
  });
  const { request: combined } = await program(host, {
    op: "prepare",
    preparation: {
      robot: "universal-robots-ur5e",
      task: "table-to-oven",
      cell: "combined",
    },
  });
  const rackText = JSON.stringify(rack);
  const ovenText = JSON.stringify(oven);
  const combinedText = JSON.stringify(combined);
  // The command line's file, or the program in one call where the runner
  // has no command line.
  const reference = async (value, command, files) =>
    host.cli === undefined
      ? (await runJob(host, value, ONE_CALL)).output
      : host.cli(command, files);
  const loading = await reference(
    { kind: "load", request: oven },
    (paths) => ["load", paths[0]],
    [ovenText],
  );
  const combinedLoading = await reference(
    { kind: "load", request: combined },
    (files) => ["load", files[0]],
    [combinedText],
  );
  const retrieval = await reference(
    { kind: "unload", file: combinedLoading, forRack: true },
    (paths) => ["unload", paths[0], "--for-rack"],
    [combinedLoading],
  );
  const cases = [
    [
      "transfer",
      { kind: "run", request: rack },
      (p) => ["run", p[0]],
      [rackText],
    ],
    [
      "loading",
      { kind: "load", request: oven },
      (p) => ["load", p[0]],
      [ovenText],
    ],
    [
      "cycle",
      { kind: "cycle", request: oven, toRack: false },
      (p) => ["cycle", p[0]],
      [ovenText],
    ],
    [
      "rack cycle",
      { kind: "cycle", request: combined, toRack: true, rackCase: "slip" },
      (p) => ["cycle", "--to-rack", "--rack-case", "slip", p[0]],
      [combinedText],
    ],
    [
      "retrieval",
      { kind: "unload", file: loading, forRack: false },
      (p) => ["unload", p[0]],
      [loading],
    ],
    [
      "oven handoff",
      { kind: "oven-handoff", request: oven },
      (p) => ["unload", p[0]],
      [loading],
    ],
    [
      "rack continuation",
      { kind: "rack", file: retrieval, case: "nominal" },
      (p) => ["rack", p[0], "--case", "nominal"],
      [retrieval],
    ],
  ];
  const rows = [];
  const limits = {};
  for (const [label, value, command, files] of cases) {
    const expected = await reference(value, command, files);
    limits[label] = outcomesIn(JSON.parse(expected)).map((outcome, index) => {
      const name = `${label} operation ${index + 1}`;
      // The UR5e's right pad presses 1.1 mm into the tray's side wall as it
      // takes the tray out of the oven (Refactor 16 step 7 evidence). The
      // rack cycle and the rack continuation both hold that retrieval.
      const retrieval =
        (label === "rack cycle" || label === "rack continuation") &&
        index === 1;
      if (outcome.kind === "completed")
        return assertAcceptedMargins(
          outcome,
          retrieval ? ["penetration"] : [],
          name,
        );
      if (outcome.step === 0) return assertNotMeasured(outcome, name) ?? null;
      assert.equal(outcome.reason, "lost-grasp", `${name}: ${outcome.reason}`);
      return assertMargins(outcome, ["slip"], name);
    });
    for (const steps of [1000, 4096]) {
      const run = await runJob(host, value, steps);
      assert.equal(
        run.output,
        expected,
        `${name} ${label} in calls of ${steps} steps differs from its command line`,
      );
      rows.push({ label, steps, calls: run.calls, bytes: expected.length });
    }
  }
  // Close a job inside an operation; the host runs the next job unchanged.
  const job = "closed-inside";
  await program(host, {
    op: "open",
    job,
    program: { kind: "run", request: rack },
  });
  const inside = await program(host, { op: "advance", job, steps: 3000 });
  assert.equal(inside.kind, "running");
  assert.equal((await program(host, { op: "close", job })).kind, "closed");
  const after = await runJob(host, { kind: "run", request: rack }, 2000);
  assert.equal(
    after.output,
    await reference({ kind: "run", request: rack }, (p) => ["run", p[0]], [
      rackText,
    ]),
    `${name}: the job after a close differs`,
  );
  report.hosts[name] = { rows, limits, closedAtStep: inside.step };
  await host.close();
  console.log(
    `pass: ${name} programs equal their references (${rows.length} runs)`,
  );
}
writeFileSync(
  join(output, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

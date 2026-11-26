import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePhysicsReplay } from "../../packages/bakery-model/src/bakery-physics.ts";
import { runtimeModule } from "../production-simulation/build-execution-bundle.mjs";
import {
  WasmHost,
  program,
  runProgram,
} from "../production-simulation/engine-hosts.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const browserPackage = resolve(process.argv[2] ?? "");
const output = resolve(process.argv[3] ?? "");
const binary = join(root, "crates/bakery-native/target/release/bakery-native");
const fixtures = [
  ...[
    [-200, 0],
    [200, 0],
    [600, 600],
  ].map(([rackX, rackY]) => ({
    task: "table-to-rack",
    scenario: "nominal",
    timestep: 0.002,
    cell: "separate",
    rackX,
    rackY,
  })),
  ...["table-to-rack", "table-to-oven"].flatMap((task) =>
    ["nominal", "blocked", "unreachable", "slip"].map((scenario) => ({
      task,
      scenario,
      timestep: 0.002,
      cell: "separate",
    })),
  ),
  {
    task: "table-to-oven",
    scenario: "closed-door",
    timestep: 0.002,
    cell: "separate",
  },
  ...["table-to-rack", "table-to-oven"].map((task) => ({
    task,
    scenario: "nominal",
    timestep: 0.001,
    cell: "separate",
  })),
  {
    task: "table-to-oven",
    scenario: "nominal",
    timestep: 0.002,
    cell: "combined",
  },
  {
    task: "table-to-oven",
    scenario: "nominal",
    timestep: 0.001,
    cell: "combined",
  },
  {
    task: "table-to-oven",
    scenario: "slip",
    timestep: 0.002,
    cell: "combined",
  },
  {
    task: "table-to-oven",
    scenario: "nominal",
    timestep: 0.002,
    cell: "blocked-rack",
  },
  {
    task: "table-to-oven",
    scenario: "nominal",
    timestep: 0.002,
    cell: "unreachable-rack",
  },
  ...["fairino-fr10", "universal-robots-ur5e", "fanuc-crx10ial"].flatMap(
    (robot) => [
      {
        robot,
        task: "table-to-oven",
        scenario: "nominal",
        timestep: 0.002,
        cell: "spanner-oven",
      },
      {
        robot,
        task: "table-to-oven",
        scenario: "nominal",
        timestep: 0.002,
        cell: "spanner-oven-combined",
      },
    ],
  ),
  {
    robot: "fairino-fr10",
    task: "table-to-oven",
    scenario: "nominal",
    timestep: 0.002,
    cell: "spanner-blocked-rack",
  },
  {
    robot: "fairino-fr10",
    task: "table-to-oven",
    scenario: "nominal",
    timestep: 0.002,
    cell: "spanner-unreachable-rack",
  },
];

if (
  process.argv.length !== 4 ||
  existsSync(output) ||
  !process.env.MUJOCO_DIR
) {
  throw new Error(
    "Run with MUJOCO_DIR: node verify-browser-linkage.mjs BROWSER_PACKAGE NEW_OUTPUT_DIRECTORY",
  );
}

function parseRecording(text) {
  const parsed = parsePhysicsReplay(text);
  if (parsed.kind === "rejected") throw new Error(parsed.message);
  return parsed.recording;
}

function legs(recording) {
  switch (recording.kind) {
    case "bakery-physics-recording":
      return [recording];
    case "bakery-physics-sequence":
      return [recording.loading, recording.unloading];
    case "bakery-physics-rack-sequence":
      return [recording.loading, recording.unloading, recording.racking];
    default:
      throw new Error(`Unsupported browser recording: ${recording.kind}`);
  }
}

function compareLeg(native, browser) {
  assert.equal(native.request.modelHash, browser.request.modelHash);
  assert.deepEqual(native.request.layout, browser.request.layout);
  assert.deepEqual(native.geometry, browser.geometry);
  assert.equal(native.outcome.kind, browser.outcome.kind);
  assert.equal(native.outcome.step, browser.outcome.step);
  if (native.outcome.kind === "failed" && browser.outcome.kind === "failed") {
    assert.equal(native.outcome.reason, browser.outcome.reason);
    assert.equal(
      native.outcome.trayDisposition,
      browser.outcome.trayDisposition,
    );
  }
  assert.equal(native.samples.length, browser.samples.length);
  assert.deepEqual(native.events, browser.events);
  const maximum = { joints: 0, tray: 0, tool: 0, jaw: 0 };
  for (let index = 0; index < native.samples.length; index++) {
    const left = native.samples[index];
    const right = browser.samples[index];
    assert.equal(left.step, right.step);
    for (const field of Object.keys(maximum)) {
      assert.equal(left[field].length, right[field].length);
      for (let component = 0; component < left[field].length; component++) {
        maximum[field] = Math.max(
          maximum[field],
          Math.abs(left[field][component] - right[field][component]),
        );
      }
    }
  }
  for (const field of Object.keys(maximum)) {
    const tolerance = field === "joints" ? 0.002 : 0.001;
    assert.ok(maximum[field] < tolerance, `${field} exceeds parity tolerance`);
  }
  return {
    outcome: browser.outcome.kind,
    outcomeStep: browser.outcome.step,
    samples: browser.samples.length,
    events: browser.events.length,
    maximumSampleComponentDifference: maximum,
  };
}

function compare(native, browser) {
  assert.equal(native.kind, browser.kind);
  const nativeLegs = legs(native);
  const browserLegs = legs(browser);
  assert.equal(nativeLegs.length, browserLegs.length);
  return nativeLegs.map((leg, index) => compareLeg(leg, browserLegs[index]));
}

function isSingleSkill(fixture) {
  return fixture.cell === "separate" || fixture.cell === "spanner-oven";
}

function commandFor(fixture, requestPath) {
  if (isSingleSkill(fixture)) return ["run", requestPath];
  return [
    "cycle",
    "--to-rack",
    "--rack-case",
    fixture.scenario === "slip" ? "slip" : "nominal",
    requestPath,
  ];
}

function prepareArgs(fixture) {
  return [
    "prepare",
    "--robot",
    fixture.robot ?? "fairino-fr10",
    "--task",
    fixture.task,
    "--cell",
    fixture.cell,
    "--case",
    isSingleSkill(fixture) ? fixture.scenario : "nominal",
    "--timestep",
    String(fixture.timestep),
    "--rack-x-mm",
    String(fixture.rackX ?? 0),
    "--rack-y-mm",
    String(fixture.rackY ?? 0),
  ];
}

function runNative(directory, fixture) {
  const requestPath = join(directory, "native-request.json");
  const recordingPath = join(directory, "native-recording.json");
  execFileSync(
    binary,
    ["--root", root, "--output", requestPath, ...prepareArgs(fixture)],
    {
      cwd: root,
      stdio: "pipe",
    },
  );
  execFileSync(
    binary,
    [
      "--root",
      root,
      "--output",
      recordingPath,
      ...commandFor(fixture, requestPath),
    ],
    {
      cwd: root,
      stdio: "pipe",
    },
  );
  return parseRecording(readFileSync(recordingPath, "utf8"));
}

/** The fixture on the Wasm module, through the host's one-shot programs. */
function preparationFor(fixture) {
  return {
    robot: fixture.robot ?? "fairino-fr10",
    task: fixture.task,
    cell: fixture.cell,
    case: isSingleSkill(fixture) ? fixture.scenario : "nominal",
    timestep: fixture.timestep,
    rackXMm: fixture.rackX ?? 0,
    rackYMm: fixture.rackY ?? 0,
  };
}

async function runBrowser(fixture) {
  const host = new WasmHost(await runtimeModule(browserPackage));
  const { request } = await program(host, {
    op: "prepare",
    preparation: preparationFor(fixture),
  });
  const { output: recordingText } = await runProgram(
    host,
    "parity",
    isSingleSkill(fixture)
      ? { kind: "run", request }
      : {
          kind: "cycle",
          request,
          toRack: true,
          rackCase: fixture.scenario === "slip" ? "slip" : "nominal",
        },
    100_000,
  );
  return {
    recording: parseRecording(recordingText),
    digest: createHash("sha256").update(recordingText).digest("hex"),
    bytes: Buffer.byteLength(recordingText),
  };
}

execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    "crates/bakery-native/Cargo.toml",
  ],
  { cwd: root, stdio: "inherit" },
);
mkdirSync(output);
const reports = [];
for (const [index, fixture] of fixtures.entries()) {
  const directory = join(
    output,
    `${index}-${fixture.task}-${fixture.scenario}-${fixture.timestep}`,
  );
  mkdirSync(directory);
  const nativeStarted = performance.now();
  const native = runNative(directory, fixture);
  const nativeElapsedMs = Math.round(performance.now() - nativeStarted);
  const browserStarted = performance.now();
  const browser = await runBrowser(fixture);
  const browserElapsedMs = Math.round(performance.now() - browserStarted);
  const nativeLegs = legs(native);
  const browserLegs = legs(browser.recording);
  assert.equal(nativeLegs[0].request.execution.backend, "native");
  assert.equal(browserLegs[0].request.execution.backend, "browser");
  assert.equal(
    nativeLegs[0].request.execution.controllerSourceHash,
    browserLegs[0].request.execution.controllerSourceHash,
  );
  assert.notEqual(
    nativeLegs[0].request.execution.controllerHash,
    browserLegs[0].request.execution.controllerHash,
  );
  const report = {
    fixture,
    nativeElapsedMs,
    browserElapsedMs,
    legs: compare(native, browser.recording),
    controllerSourceHash: nativeLegs[0].request.execution.controllerSourceHash,
    nativeControllerHash: nativeLegs[0].request.execution.controllerHash,
    browserControllerHash: browserLegs[0].request.execution.controllerHash,
    browserRuntimeHash: browserLegs[0].request.execution.runtimeHash,
    browserRecordingSha256: browser.digest,
    browserRecordingBytes: browser.bytes,
  };
  reports.push(report);
  console.log(
    `${index + 1}/${fixtures.length} ${fixture.task} ${fixture.scenario} ${fixture.timestep}: ${report.legs.map((leg) => leg.outcome).join("/")}`,
  );
}
writeFileSync(
  join(output, "parity-report.json"),
  JSON.stringify(reports, null, 2),
);
console.log(`Verified ${reports.length} native/browser fixtures.`);

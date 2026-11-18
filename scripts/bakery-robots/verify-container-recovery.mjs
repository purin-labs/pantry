import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsePhysicsRackSequence } from "../../packages/bakery-model/src/bakery-physics.ts";

if (process.argv.length !== 4)
  throw new Error(
    "Usage: node --experimental-strip-types verify-container-recovery.mjs IMAGE NEW_OUTPUT_DIRECTORY",
  );
const image = process.argv[2];
const output = resolve(process.argv[3]);
if (existsSync(output)) throw new Error("Choose a new output directory.");
mkdirSync(output, { recursive: true });
const startedAt = new Date().toISOString();
const started = performance.now();
const imageInfo = JSON.parse(docker(["image", "inspect", image]))[0];
const mount = `type=bind,source=${output},target=/work`;
const interruptions = [];
run("request.json", [
  "prepare",
  "--task",
  "table-to-oven",
  "--cell",
  "combined",
]);
run("completed.json", ["cycle", "--to-rack", "/work/request.json"]);
run("loading.json", ["load", "/work/request.json"]);
run("unloading.json", ["unload", "--for-rack", "/work/loading.json"]);
const parsed = parsePhysicsRackSequence(
  readFileSync(join(output, "completed.json"), "utf8"),
);
assert.equal(parsed.kind, "accepted", parsed.message);
assert.equal(parsed.sequence.racking.outcome.kind, "completed");

for (const phase of ["loading", "unloading", "racking"]) {
  const source = {
    loading: ["load", "/work/request.json"],
    unloading: ["unload", "--for-rack", "/work/loading.json"],
    racking: ["rack", "/work/unloading.json"],
  }[phase];
  const checkpoint = `${phase}-checkpoint.json`;
  run(checkpoint, ["--pause-after", "lift", ...source]);
  const checkpointDigest = digest(checkpoint);
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    const result = `${phase}-${signal}.json`;
    const container = docker([
      "create",
      "--init",
      "--network",
      "none",
      "--mount",
      mount,
      image,
      "--output",
      `/work/${result}`,
      "resume",
      `/work/${checkpoint}`,
    ]).trim();
    try {
      docker(["start", container]);
      // Kill the container itself; terminating a docker client leaves its job alive.
      docker(["kill", "--signal", signal, container]);
      const exitCode = Number(docker(["wait", container]).trim());
      assert.equal(exitCode, signal === "SIGTERM" ? 143 : 137);
      assert.equal(existsSync(join(output, result)), false);
      assert.equal(digest(checkpoint), checkpointDigest);
      interruptions.push({
        phase,
        signal,
        exitCode,
        outputCreated: false,
        checkpointDigest,
      });
    } finally {
      docker(["rm", "--force", container]);
    }
  }
  const recovered = `${phase}-recovered.json`;
  run(recovered, ["resume", `/work/${checkpoint}`]);
  const reference = {
    loading: "loading.json",
    unloading: "unloading.json",
    racking: "completed.json",
  }[phase];
  assert.deepEqual(
    JSON.parse(readFileSync(join(output, recovered), "utf8")),
    JSON.parse(readFileSync(join(output, reference), "utf8")),
  );
}
const report = {
  kind: "bakery-container-recovery-e2e",
  startedAt,
  elapsedMs: performance.now() - started,
  image: {
    id: imageInfo.Id,
    os: imageInfo.Os,
    architecture: imageInfo.Architecture,
  },
  network: "none",
  interruptions,
  resumedResultsMatchContinuous: true,
  requestSha256: digest("request.json"),
  completedSha256: digest("completed.json"),
};
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
  { flag: "wx" },
);
console.log(JSON.stringify(report, null, 2));

function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 150_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function run(filename, args) {
  docker([
    "run",
    "--rm",
    "--init",
    "--network",
    "none",
    "--mount",
    mount,
    image,
    "--output",
    `/work/${filename}`,
    ...args,
  ]);
  assert.equal(existsSync(join(output, filename)), true);
}

function digest(filename) {
  return createHash("sha256")
    .update(readFileSync(join(output, filename)))
    .digest("hex");
}

#!/usr/bin/env node
// Plan 76 phase 1 exit journey: Commerce builds and its journeys pass with
// no Pantry package in its dependency graph.
//
// 1. The pnpm graph of the Worker and the storefront holds no workspace
//    package outside Commerce and the neutral std and type-utils packages.
// 2. Wrangler builds the Worker; every file in its bundle comes from
//    Commerce, the neutral packages or npm.
// 3. The runtime boundary check passes, and it refuses a deliberate crossing.
// 4. The Commerce suite passes.
//
// It writes the evidence to the path in argv[2] (default
// docs/evidence/plan-76-phase-1/standalone-commerce.json).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const worker = join(root, "services/commerce");
const output = resolve(root, process.argv[2] ?? "docs/evidence/plan-76-phase-1/standalone-underclerk.json");
const COMMERCE_ENGINE = ["services/commerce/", "apps/storefront/", "packages/commerce-contracts/", "packages/commerce-client/", "packages/commerce-query-sqlite/"];
const NEUTRAL = ["packages/std/", "packages/type-utils/"];
const ALLOWED_WORKSPACE = /^@underclerk\/|^@lowerarchy\/(std|type-utils)$/;

const startedAt = new Date().toISOString();
const evidence = {
  journey: "plan-76-phase-1-standalone-underclerk",
  startedAt,
  commit: git(["rev-parse", "HEAD"]),
  workingTreeClean: git(["status", "--porcelain"]).length === 0,
};

// 1. Dependency graph.
const graph = JSON.parse(
  execFileSync("pnpm", ["list", "--filter", "@seams/commerce-worker", "--filter", "@seams/storefront", "--depth", "Infinity", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const workspaceNames = new Set(workspacePackageNames());
const names = new Set();
const walk = (dependencies) => {
  for (const [name, info] of Object.entries(dependencies ?? {})) {
    if (names.has(name)) continue;
    names.add(name);
    walk(info.dependencies);
  }
};
for (const project of graph) {
  walk(project.dependencies);
  walk(project.devDependencies);
}
const workspaceInGraph = [...names].filter((name) => workspaceNames.has(name)).sort();
const forbidden = workspaceInGraph.filter((name) => !ALLOWED_WORKSPACE.test(name));
evidence.dependencyGraph = {
  roots: graph.map((project) => project.name),
  packages: names.size,
  workspacePackages: workspaceInGraph,
  satyrPackages: [...names].filter((name) => name.startsWith("@satyr/")),
  forbidden,
  passed: forbidden.length === 0 && ![...names].some((name) => name.startsWith("@satyr/")),
};

// 2. Build the Worker. The storefront assets are not part of the bundle.
const scratch = mkdtempSync(join(tmpdir(), "underclerk-standalone-"));
try {
  const wrangler = readFileSync(join(worker, "wrangler.jsonc"), "utf8");
  const compatibilityDate = /"compatibility_date":\s*"([^"]+)"/.exec(wrangler)?.[1];
  const config = join(scratch, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "underclerk-standalone-check",
      main: join(worker, "src/worker.ts"),
      compatibility_date: compatibilityDate,
      compatibility_flags: ["nodejs_compat"],
    }),
  );
  const outdir = join(scratch, "dist");
  const metafile = join(scratch, "meta.json");
  run(join(worker, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--config", config, "--outdir", outdir, "--metafile", metafile], worker);
  const meta = JSON.parse(readFileSync(metafile, "utf8"));
  const inputs = Object.keys(meta.inputs).map((input) => relative(root, resolve(dirname(metafile), input)));
  const byArea = {};
  const outside = [];
  for (const input of inputs) {
    const area = areaOf(input);
    byArea[area] = (byArea[area] ?? 0) + 1;
    if (area === "outside") outside.push(input);
  }
  const bundle = readFileSync(join(outdir, "worker.js"));
  evidence.workerBuild = {
    inputs: inputs.length,
    inputsByArea: byArea,
    outside,
    bundleBytes: bundle.byteLength,
    bundleSha256: createHash("sha256").update(bundle).digest("hex"),
    passed: outside.length === 0,
  };
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// 3. Boundary check, then one deliberate crossing.
const check = spawnSync(process.execPath, ["scripts/check-runtime-boundary.mjs"], { cwd: root, encoding: "utf8" });
const probe = join(worker, "src/boundary-probe.ts");
let refusal;
try {
  writeFileSync(probe, 'import { isRecord } from "@seams/std";\n\nexport const boundaryProbe = isRecord;\n');
  refusal = spawnSync(process.execPath, ["scripts/check-runtime-boundary.mjs"], { cwd: root, encoding: "utf8" });
} finally {
  rmSync(probe, { force: true });
}
evidence.boundaryCheck = {
  status: check.status,
  summary: check.stdout.trim(),
  deliberateCrossing: {
    file: "services/commerce/src/boundary-probe.ts",
    import: "@seams/std",
    status: refusal.status,
    refusal: refusal.stderr.trim(),
  },
  passed:
    check.status === 0 &&
    refusal.status === 1 &&
    refusal.stderr.includes("services/commerce/src/boundary-probe.ts:1 imports @seams/std"),
};

// 4. The Commerce suite.
const report = join(tmpdir(), `underclerk-suite-${process.pid}.json`);
const suite = spawnSync(join(worker, "node_modules/.bin/vitest"), ["run", "--reporter=json", `--outputFile=${report}`], {
  cwd: worker,
  encoding: "utf8",
});
const results = JSON.parse(readFileSync(report, "utf8"));
rmSync(report, { force: true });
evidence.underclerkSuite = {
  status: suite.status,
  files: results.testResults.length,
  tests: results.numTotalTests,
  passedTests: results.numPassedTests,
  failedTests: results.numFailedTests,
  passed: suite.status === 0 && results.numFailedTests === 0 && results.numPassedTests > 0,
};

evidence.finishedAt = new Date().toISOString();
evidence.passed = evidence.dependencyGraph.passed && evidence.workerBuild.passed && evidence.boundaryCheck.passed && evidence.underclerkSuite.passed;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(
  `${evidence.passed ? "PASSED" : "FAILED"}: graph ${names.size} packages (${workspaceInGraph.join(", ")}); bundle ${evidence.workerBuild.inputs} inputs, ${evidence.workerBuild.outside.length} outside; boundary refusal ${evidence.boundaryCheck.deliberateCrossing.status}; suite ${evidence.underclerkSuite.passedTests}/${evidence.underclerkSuite.tests}`,
);
console.log(`evidence: ${relative(root, output)}`);
process.exit(evidence.passed ? 0 : 1);

function areaOf(input) {
  if (input.startsWith("node_modules/") || input.includes("/node_modules/")) {
    // A workspace package reached through node_modules would be a symlink; pnpm
    // resolves it to its real directory, so this is an npm package.
    return "npm";
  }
  if (COMMERCE_ENGINE.some((prefix) => input.startsWith(prefix))) return "underclerk";
  if (NEUTRAL.some((prefix) => input.startsWith(prefix))) return "neutral";
  if (!input.includes("/") || input.startsWith("../") || input.startsWith("(")) return "build-runtime";
  return "outside";
}

function workspacePackageNames() {
  const projects = JSON.parse(
    execFileSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }),
  );
  return projects.map((project) => project.name);
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

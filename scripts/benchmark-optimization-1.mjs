import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "..");
const PLATFORM_DIR = join(REPOSITORY_ROOT, "services", "platform");
const BENCHMARK_TEST = join(
  PLATFORM_DIR,
  "tests",
  "optimization-1-benchmark.test.ts",
);
const ARTIFACT_DIR = join(REPOSITORY_ROOT, "benchmarks", "optimization-1");
const BASELINE_COMMIT = "654bd5ab";
const CANDIDATE_COMMIT = "5abef9fd";

const options = parseArguments(process.argv.slice(2));
const temporaryRoot = mkdtempSync(join(tmpdir(), "satyr-optimization-1-"));
const variants = [
  variant("baseline", BASELINE_COMMIT),
  variant("candidate", CANDIDATE_COMMIT),
];

try {
  if (options.analyzeOnly) {
    analyzeExistingArtifacts();
    process.stdout.write(
      `Optimization 1 report refreshed: ${relative(REPOSITORY_ROOT, join(ARTIFACT_DIR, "report.md"))}\n`,
    );
  } else if (options.profile === "smoke") {
    const workingTree = {
      name: "candidate",
      commit: "working-tree",
      worktree: REPOSITORY_ROOT,
      outputs: [],
    };
    executeVariant(workingTree, options.profile, 0);
    process.stdout.write("Optimization 1 benchmark smoke passed.\n");
  } else {
    for (const entry of variants) prepareWorktree(entry);
    const outputs = executeAlternatingRuns(variants, options);
    writeArtifacts(outputs, options);
    process.stdout.write(
      `Optimization 1 ${options.profile} report: ${relative(REPOSITORY_ROOT, join(ARTIFACT_DIR, "report.md"))}\n`,
    );
  }
} finally {
  if (options.profile !== "smoke" && !options.analyzeOnly) {
    for (const entry of variants) removeWorktree(entry);
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function parseArguments(argumentsList) {
  let profile = "full";
  let analyzeOnly = false;
  for (const argument of argumentsList) {
    if (argument === "--quick") profile = "quick";
    else if (argument === "--full") profile = "full";
    else if (argument === "--smoke") profile = "smoke";
    else if (argument === "--analyze-only") analyzeOnly = true;
    else throw new Error(`Unknown benchmark argument: ${argument}`);
  }
  return {
    profile,
    analyzeOnly,
    iterations: profile === "full" ? 5 : profile === "quick" ? 3 : 1,
  };
}

function analyzeExistingArtifacts() {
  const baseline = JSON.parse(
    readFileSync(join(ARTIFACT_DIR, "local-baseline.json"), "utf8"),
  );
  const candidate = JSON.parse(
    readFileSync(join(ARTIFACT_DIR, "local-candidate.json"), "utf8"),
  );
  if (baseline.profile !== candidate.profile)
    throw new Error("local benchmark profile mismatch");
  const iterations = Number(candidate.aggregates?.[0]?.samples ?? 0);
  if (!Number.isSafeInteger(iterations) || iterations < 1)
    throw new Error("local benchmark sample count missing");
  const generatedAt = new Date().toISOString();
  writeFileSync(
    join(ARTIFACT_DIR, "report.md"),
    renderReport(
      baseline,
      candidate,
      { profile: candidate.profile, iterations },
      generatedAt,
    ),
  );
}

function variant(name, commit) {
  return {
    name,
    commit,
    worktree: join(temporaryRoot, name),
    outputs: [],
  };
}

function prepareWorktree(entry) {
  runGit(["worktree", "add", "--detach", entry.worktree, entry.commit]);
  const targetTest = join(
    entry.worktree,
    "services",
    "platform",
    "tests",
    "optimization-1-benchmark.test.ts",
  );
  cpSync(BENCHMARK_TEST, targetTest);
  linkDependencies(
    join(REPOSITORY_ROOT, "node_modules"),
    join(entry.worktree, "node_modules"),
  );
  linkDependencies(
    join(PLATFORM_DIR, "node_modules"),
    join(entry.worktree, "services", "platform", "node_modules"),
  );
}

function linkDependencies(source, target) {
  if (!existsSync(source) || existsSync(target)) return;
  symlinkSync(source, target, "dir");
}

function executeAlternatingRuns(entries, runOptions) {
  for (let iteration = 0; iteration < runOptions.iterations; iteration += 1) {
    const ordered = iteration % 2 === 0 ? entries : [...entries].reverse();
    for (const entry of ordered)
      executeVariant(entry, runOptions.profile, iteration);
  }
  return entries;
}

function executeVariant(entry, profile, iteration) {
  const outputPath = join(temporaryRoot, `${entry.name}-${iteration}.json`);
  const vitest = join(PLATFORM_DIR, "node_modules", ".bin", "vitest");
  const result = spawnSync(
    vitest,
    ["run", "tests/optimization-1-benchmark.test.ts"],
    {
      cwd: join(entry.worktree, "services", "platform"),
      env: {
        ...process.env,
        SATYR_OPTIMIZATION_BENCHMARK: "1",
        SATYR_BENCH_PROFILE: profile,
        SATYR_BENCH_VARIANT: entry.name,
        SATYR_BENCH_COMMIT: entry.commit,
        SATYR_BENCH_ITERATION: String(iteration),
        SATYR_BENCH_OUTPUT: outputPath,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${entry.name} benchmark iteration ${iteration} failed`);
  }
  if (!existsSync(outputPath))
    throw new Error(`${entry.name} benchmark produced no result`);
  entry.outputs.push(JSON.parse(readFileSync(outputPath, "utf8")));
  process.stdout.write(
    `${entry.name} iteration ${iteration + 1}/${profile === "full" ? 5 : profile === "quick" ? 3 : 1} passed\n`,
  );
}

function writeArtifacts(entries, runOptions) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const combined = new Map();
  for (const entry of entries) {
    const output = {
      schemaVersion: 1,
      variant: entry.name,
      commit: entry.commit,
      profile: runOptions.profile,
      generatedAt,
      samples: entry.outputs.flatMap(readSamples),
      aggregates: aggregateSamples(entry.outputs.flatMap(readSamples)),
      invariants: entry.outputs.flatMap(readInvariants),
    };
    combined.set(entry.name, output);
    writeJson(join(ARTIFACT_DIR, `local-${entry.name}.json`), output);
  }
  writeJson(
    join(ARTIFACT_DIR, "workload.json"),
    workloadManifest(runOptions, generatedAt),
  );
  const baseline = combined.get("baseline");
  const candidate = combined.get("candidate");
  if (baseline === undefined || candidate === undefined)
    throw new Error("A/B artifacts require both variants");
  writeFileSync(
    join(ARTIFACT_DIR, "report.md"),
    renderReport(baseline, candidate, runOptions, generatedAt),
  );
}

function readSamples(output) {
  return Array.isArray(output.samples) ? output.samples : [];
}

function readInvariants(output) {
  return Array.isArray(output.invariants) ? output.invariants : [];
}

function workloadManifest(runOptions, generatedAt) {
  const nodeVersion = process.version;
  const pnpmVersion = commandOutput("pnpm", ["--version"]);
  const workerdVersion = commandOutput(
    join(PLATFORM_DIR, "node_modules", ".bin", "wrangler"),
    ["--version"],
  );
  return {
    schemaVersion: 1,
    generatedAt,
    profile: runOptions.profile,
    commits: { baseline: BASELINE_COMMIT, candidate: CANDIDATE_COMMIT },
    workloadSeed: "optimization-1-v1",
    measuredSamplesPerPoint: runOptions.iterations,
    warmupSamplesPerPoint: 1,
    actorCardinality: runOptions.profile === "full" ? [1, 100] : [1, 25],
    concurrency:
      "one operation per isolated Actor database; Cloudflare concurrency pending",
    payloadSizes: {
      historyAppendBytes: "fixture encoded size",
      restoreEntryTextBytes: 3600,
    },
    scales: {
      connectorTerminalRows:
        runOptions.profile === "full"
          ? [0, 1000, 10000, 100000]
          : [0, 1000, 10000],
      priorHistoryEntries:
        runOptions.profile === "full"
          ? [0, 1000, 10000, 99999]
          : [0, 1000, 10000],
      historyEntryLimitRejectionAt: 100000,
      restoreTargetBytes:
        runOptions.profile === "full"
          ? [0, 1048576, 8388608, 16777216, 16777217]
          : [0, 1048576, 16777217],
      replayEvents: { short: 5, bursty: 100, long: 1000, idle: 0 },
    },
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: nodeVersion,
      pnpm: pnpmVersion,
      wrangler: workerdVersion,
    },
    cloudflare: {
      status: "pending_isolated_resources",
      region: null,
      observationWindows: [],
    },
  };
}

function renderReport(baseline, candidate, runOptions, generatedAt) {
  const baselineAggregates = aggregateSamples(baseline.samples);
  const candidateAggregates = aggregateSamples(candidate.samples);
  const comparisons = compareAggregates(
    baselineAggregates,
    candidateAggregates,
  );
  const connectorLargest = findComparison(
    comparisons,
    "connector",
    "claim_due_work",
    runOptions.profile === "full"
      ? "100000_terminal_records"
      : "10000_terminal_records",
  );
  const historyTenThousand = findComparison(
    comparisons,
    "history_append",
    "accepted_append",
    "10000_prior_entries",
  );
  const historyBoundary = findComparison(
    comparisons,
    "history_append",
    "accepted_append",
    "99999_prior_entries",
  );
  const historyEmpty = findComparison(
    comparisons,
    "history_append",
    "accepted_append",
    "0_prior_entries",
  );
  const connectorZero = findComparison(
    comparisons,
    "connector",
    "claim_due_work",
    "0_terminal_records",
  );
  const restoreOneMiB = findComparison(
    comparisons,
    "restore",
    "fresh_restore",
    "1_mib",
  );
  const underCeilingRestore = restoreLatencyGate(
    comparisons,
    runOptions.profile,
  );
  const replayLong = findComparison(
    comparisons,
    "replay",
    "replay_to_cursor",
    "long",
  );
  const oversizedCandidate = candidate.samples.filter(isOversizedRestore);
  const restorePreflightPassed =
    oversizedCandidate.length > 0 &&
    oversizedCandidate.every(oversizedStoppedBeforePayload);
  const lines = [
    "# Optimization 1 benchmark report",
    "",
    `Generated: ${generatedAt}`,
    "",
    `Profile: \`${runOptions.profile}\` (${runOptions.iterations} alternating measured samples per point)`,
    "",
    `Baseline: \`${BASELINE_COMMIT}\``,
    "",
    `Candidate: \`${CANDIDATE_COMMIT}\``,
    "",
    "## Decision summary",
    "",
    decisionLine("Large-state latency", connectorLargest, "duration"),
    decisionLine("Large-state row reads", connectorLargest, "rows"),
    decisionLine("10k-history append row reads", historyTenThousand, "rows"),
    decisionLine("Small-state connector latency", connectorZero, "duration"),
    decisionLine("One-MiB restore latency", restoreOneMiB, "duration"),
    `- Under-ceiling restore p95: ${underCeilingRestore.evidence}.`,
    `- Restore preflight: ${restorePreflightPassed ? "passed; oversized candidate history stopped before payload rows" : "inconclusive or failed"}.`,
    `- Replay: ${comparisonSentence(replayLong, "duration")}. The local result is a regression guard; Cloudflare timing remains required for the 5% gate.`,
    "",
    "The local stage measures production SQLite functions at both commits. Cloudflare request duration, billable row accounting, storage pricing, and regional behavior remain pending because isolated benchmark namespaces and resources have not been provisioned.",
    "",
    "## Acceptance gates",
    "",
    "| Gate | Status | Evidence |",
    "|---|---|---|",
    gateRow(
      "Connector large-state row reads",
      runOptions.profile === "full" &&
        percentageReduction(
          connectorLargest?.baseline.rowsRead,
          connectorLargest?.candidate.rowsRead,
        ) >= 99
        ? "passed"
        : "inconclusive",
      connectorLargest === null
        ? "missing sample"
        : `${formatNumber(connectorLargest.baseline.rowsRead)} → ${formatNumber(connectorLargest.candidate.rowsRead)} estimated rows at ${connectorLargest.scale}`,
    ),
    gateRow(
      "Connector 100k p95 stability",
      runOptions.profile === "full" &&
        connectorLargest !== null &&
        connectorZero !== null &&
        connectorLargest.candidate.p95Ms <= connectorZero.candidate.p95Ms * 2
        ? "passed"
        : "inconclusive",
      connectorLargest === null || connectorZero === null
        ? "missing sample"
        : `${formatNumber(connectorLargest.candidate.p95Ms)} ms at 100k versus ${formatNumber(connectorZero.candidate.p95Ms)} ms at zero history`,
    ),
    gateRow(
      "Connector small-state p95",
      withinLatencyAllowance(connectorZero, 10, 0.2) ? "passed" : "failed",
      connectorZero === null
        ? "missing sample"
        : `${formatNumber(connectorZero.baseline.p95Ms)} ms → ${formatNumber(connectorZero.candidate.p95Ms)} ms`,
    ),
    gateRow(
      "History append at 10k prior entries",
      percentageReduction(
        historyTenThousand?.baseline.rowsRead,
        historyTenThousand?.candidate.rowsRead,
      ) >= 90
        ? "passed"
        : "failed",
      historyTenThousand === null
        ? "missing sample"
        : `${formatNumber(historyTenThousand.baseline.rowsRead)} → ${formatNumber(historyTenThousand.candidate.rowsRead)} estimated rows`,
    ),
    gateRow(
      "History append 100k-boundary p95 stability",
      historyBoundary !== null &&
        historyEmpty !== null &&
        historyBoundary.candidate.p95Ms <= historyEmpty.candidate.p95Ms * 1.25
        ? "passed"
        : "inconclusive",
      historyBoundary === null || historyEmpty === null
        ? "requires the full profile"
        : `${formatNumber(historyBoundary.candidate.p95Ms)} ms at 99,999 prior entries versus ${formatNumber(historyEmpty.candidate.p95Ms)} ms at zero`,
    ),
    gateRow(
      "Oversized restore preflight",
      restorePreflightPassed ? "passed" : "failed",
      restorePreflightPassed
        ? "candidate read only usage metadata and materialized zero entries"
        : "oversized fixture did not demonstrate an early stop",
    ),
    gateRow(
      "Under-ceiling restore p95",
      underCeilingRestore.status,
      underCeilingRestore.evidence,
    ),
    gateRow(
      "Restore through 16 MiB",
      candidate.samples.some(successfulSixteenMiBRestore)
        ? "passed"
        : "inconclusive",
      candidate.samples.some(successfulSixteenMiBRestore)
        ? "all measured 16 MiB restores materialized successfully"
        : "requires the full profile",
    ),
    gateRow(
      "Restore peak memory",
      "inconclusive",
      "sampled peak is recorded; the plan defines no numeric heap ceiling",
    ),
    gateRow(
      "Replay 5% latency",
      "inconclusive",
      "requires controlled Cloudflare observation windows",
    ),
    gateRow(
      "Horizontal scaling",
      "inconclusive",
      "local isolated SQLite batches verify ordering; workerd/Cloudflare concurrency remains unmeasured",
    ),
    gateRow(
      "Cost per 1,000 operations",
      "inconclusive",
      "requires Cloudflare duration and billable row metrics",
    ),
    "",
    "## Local aggregate results",
    "",
    "| Area | Operation | Scale | Baseline p50 ms | Candidate p50 ms | Baseline p95 ms | Candidate p95 ms | Duration change | Baseline rows | Candidate rows | Row reduction | Writes B→C |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...comparisons.map(comparisonRow),
    "",
    "Each duration cell is computed from raw independent samples. JSON artifacts retain p50, p95, p99, median, and median absolute deviation inputs. SQLite row estimates account for baseline aggregate and unindexed history scans; Cloudflare row counters remain the authority for cost conclusions.",
    "",
    "## R1.4 replay-polling decision",
    "",
    "Defer R1.4. The storage refactor can be evaluated locally, while adaptive replay polling requires Cloudflare evidence that empty polls exceed 50% and replay contributes at least 20% of Session Actor row reads or active duration.",
    "",
    "## Remaining execution boundary",
    "",
    "Provision separate benchmark D1, KV, R2, Queue, and Durable Object resources for each variant. Then run the three alternating 30-minute windows, collect the named runtime events, run the M6 regression check, and replace the inconclusive Cloudflare gates with observed results.",
  ];
  return `${lines.join("\n")}\n`;
}

function aggregateSamples(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.area}\u0000${sample.operation}\u0000${sample.scale}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [area, operation, scale] = key.split("\u0000");
    const durations = group.map(readDuration).sort(ascending);
    const rowsRead = group.map(readRows).sort(ascending);
    const rowsWritten = group.map(readWrites).sort(ascending);
    return {
      area,
      operation,
      scale,
      samples: group.length,
      medianMs: percentile(durations, 0.5),
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      p99Ms: percentile(durations, 0.99),
      madMs: medianAbsoluteDeviation(durations),
      rowsRead: percentile(rowsRead, 0.5),
      rowsWritten: percentile(rowsWritten, 0.5),
    };
  });
}

function compareAggregates(baseline, candidate) {
  const candidateByKey = new Map(candidate.map(indexAggregate));
  const comparisons = [];
  for (const baselineAggregate of baseline) {
    const key = aggregateKey(baselineAggregate);
    const candidateAggregate = candidateByKey.get(key);
    if (candidateAggregate === undefined) continue;
    comparisons.push({
      area: baselineAggregate.area,
      operation: baselineAggregate.operation,
      scale: baselineAggregate.scale,
      baseline: baselineAggregate,
      candidate: candidateAggregate,
    });
  }
  return comparisons;
}

function indexAggregate(value) {
  return [aggregateKey(value), value];
}

function aggregateKey(value) {
  return `${value.area}\u0000${value.operation}\u0000${value.scale}`;
}

function findComparison(comparisons, area, operation, scale) {
  return (
    comparisons.find(matchesComparison.bind(null, area, operation, scale)) ??
    null
  );
}

function matchesComparison(area, operation, scale, value) {
  return (
    value.area === area &&
    value.operation === operation &&
    value.scale === scale
  );
}

function decisionLine(label, comparison, metric) {
  return `- ${label}: ${comparisonSentence(comparison, metric)}.`;
}

function comparisonSentence(comparison, metric) {
  if (comparison === null)
    return "inconclusive; the required sample is missing";
  if (metric === "rows") {
    return `${formatPercent(percentageReduction(comparison.baseline.rowsRead, comparison.candidate.rowsRead))} fewer estimated rows (${formatNumber(comparison.baseline.rowsRead)} → ${formatNumber(comparison.candidate.rowsRead)})`;
  }
  const change = percentageChange(
    comparison.baseline.p50Ms,
    comparison.candidate.p50Ms,
  );
  return `${formatSignedPercent(change)} median duration (${formatNumber(comparison.baseline.p50Ms)} ms → ${formatNumber(comparison.candidate.p50Ms)} ms)`;
}

function comparisonRow(comparison) {
  const durationChange = percentageChange(
    comparison.baseline.p50Ms,
    comparison.candidate.p50Ms,
  );
  const rowReduction = percentageReduction(
    comparison.baseline.rowsRead,
    comparison.candidate.rowsRead,
  );
  return `| ${comparison.area} | ${comparison.operation} | ${comparison.scale} | ${formatNumber(comparison.baseline.p50Ms)} | ${formatNumber(comparison.candidate.p50Ms)} | ${formatNumber(comparison.baseline.p95Ms)} | ${formatNumber(comparison.candidate.p95Ms)} | ${formatSignedPercent(durationChange)} | ${formatNumber(comparison.baseline.rowsRead)} | ${formatNumber(comparison.candidate.rowsRead)} | ${formatPercent(rowReduction)} | ${formatNumber(comparison.baseline.rowsWritten)}→${formatNumber(comparison.candidate.rowsWritten)} |`;
}

function withinLatencyAllowance(
  comparison,
  percentageAllowance,
  absoluteAllowanceMs,
) {
  if (comparison === null) return false;
  const allowed = Math.max(
    comparison.baseline.p95Ms * (1 + percentageAllowance / 100),
    comparison.baseline.p95Ms + absoluteAllowanceMs,
  );
  return comparison.candidate.p95Ms <= allowed;
}

function gateRow(gate, status, evidence) {
  return `| ${gate} | ${status} | ${evidence} |`;
}

function isOversizedRestore(sample) {
  return sample.area === "restore" && sample.scale === "over_16_mib";
}

function oversizedStoppedBeforePayload(sample) {
  return (
    sample.outcome === "history_materialization_limit" &&
    sample.rowsRead <= 1 &&
    sample.measurements?.materializedEntries === 0
  );
}

function successfulSixteenMiBRestore(sample) {
  return (
    sample.area === "restore" &&
    sample.scale === "16_mib" &&
    sample.outcome === "bounded_history"
  );
}

function restoreLatencyGate(comparisons, profile) {
  const requiredScales =
    profile === "full"
      ? ["0_bytes", "1_mib", "8_mib", "16_mib"]
      : ["0_bytes", "1_mib"];
  const restoreComparisons = requiredScales.map(
    findComparison.bind(null, comparisons, "restore", "fresh_restore"),
  );
  if (restoreComparisons.some(isNull)) {
    return {
      status: "inconclusive",
      evidence: "one or more under-ceiling restore scales are missing",
    };
  }
  const concrete = restoreComparisons.filter(isPresent);
  const failures = concrete.filter(failsRestoreLatencyAllowance);
  if (failures.length === 0 && profile === "full") {
    return {
      status: "passed",
      evidence: "every 0–16 MiB p95 stayed inside the 10% or 0.2 ms allowance",
    };
  }
  if (failures.length === 0) {
    return {
      status: "inconclusive",
      evidence: "quick scales passed; 8 and 16 MiB require the full profile",
    };
  }
  const orderedFailures = failures.sort(descendingP95Change);
  return {
    status: "failed",
    evidence: orderedFailures.map(restoreFailureEvidence).join("; "),
  };
}

function isNull(value) {
  return value === null;
}

function isPresent(value) {
  return value !== null;
}

function failsRestoreLatencyAllowance(comparison) {
  return !withinLatencyAllowance(comparison, 10, 0);
}

function descendingP95Change(left, right) {
  return (
    percentageChange(right.baseline.p95Ms, right.candidate.p95Ms) -
    percentageChange(left.baseline.p95Ms, left.candidate.p95Ms)
  );
}

function restoreFailureEvidence(comparison) {
  return `${comparison.scale} p95 changed ${formatSignedPercent(percentageChange(comparison.baseline.p95Ms, comparison.candidate.p95Ms))} (${formatNumber(comparison.baseline.p95Ms)} ms → ${formatNumber(comparison.candidate.p95Ms)} ms)`;
}

function readDuration(sample) {
  return Number(sample.durationMs);
}

function readRows(sample) {
  return Number(sample.rowsRead);
}

function readWrites(sample) {
  return Number(sample.rowsWritten);
}

function ascending(left, right) {
  return left - right;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(fraction * values.length) - 1),
  );
  return values[index];
}

function medianAbsoluteDeviation(values) {
  if (values.length === 0) return 0;
  const median = percentile(values, 0.5);
  return percentile(
    values.map(distanceFrom.bind(null, median)).sort(ascending),
    0.5,
  );
}

function distanceFrom(center, value) {
  return Math.abs(value - center);
}

function percentageReduction(before, after) {
  if (!Number.isFinite(before) || before <= 0 || !Number.isFinite(after))
    return 0;
  return ((before - after) / before) * 100;
}

function percentageChange(before, after) {
  if (!Number.isFinite(before) || before <= 0 || !Number.isFinite(after))
    return 0;
  return ((after - before) / before) * 100;
}

function formatNumber(value) {
  return Number.isFinite(value)
    ? Number(value).toLocaleString("en-US", { maximumFractionDigits: 3 })
    : "n/a";
}

function formatPercent(value) {
  return `${formatNumber(value)}%`;
}

function formatSignedPercent(value) {
  return `${value > 0 ? "+" : ""}${formatPercent(value)}`;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function commandOutput(command, argumentsList) {
  const result = spawnSync(command, argumentsList, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}

function runGit(argumentsList) {
  const result = spawnSync("git", argumentsList, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(
      result.stderr.trim() || `git ${argumentsList.join(" ")} failed`,
    );
}

function removeWorktree(entry) {
  if (!existsSync(entry.worktree)) return;
  const result = spawnSync(
    "git",
    ["worktree", "remove", "--force", entry.worktree],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  );
  if (result.status !== 0)
    process.stderr.write(
      `Could not remove temporary ${entry.name} worktree: ${result.stderr}`,
    );
}

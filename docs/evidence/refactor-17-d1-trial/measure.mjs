#!/usr/bin/env node
// node measure.mjs <worktree> <out.jsonl> <rounds> <label=sha>...
// Checks out each variant in turn, for each round, and times the checks.
import { execSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const [tree, outFile, roundsText, ...variants] = process.argv.slice(2);
const rounds = Number(roundsText);
const platform = join(tree, "services/platform");
const scratch = join(tree, "..", "out");

const load = () =>
  execSync("uptime")
    .toString()
    .trim()
    .replace(/^.*load averages?: /u, "");

/** Runs a command; returns wall ms, exit code, and the ms of the first line that matches `mark`. */
function run(command, args, cwd, mark) {
  return new Promise((resolve) => {
    const started = Date.now();
    const before = load();
    let markMs = null;
    let text = "";
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    });
    const onData = (chunk) => {
      const part = chunk.toString();
      text += part;
      if (mark && markMs === null && mark.test(text))
        markMs = Date.now() - started;
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) =>
      resolve({ ms: Date.now() - started, code, markMs, text, load: before }),
    );
  });
}

function record(row) {
  appendFileSync(outFile, JSON.stringify(row) + "\n");
  console.log(JSON.stringify(row));
}

for (let round = 1; round <= rounds; round += 1) {
  for (const variant of variants) {
    const [label, sha] = variant.split("=");
    execSync(`git checkout -q --detach ${sha}`, { cwd: tree });
    // No leftover links of another variant.
    for (const folder of [
      "areas/devices/server/node_modules",
      "foundation/kernel/node_modules",
    ]) {
      rmSync(join(tree, folder), { recursive: true, force: true });
    }
    if (label === "0") {
      rmSync(join(tree, "areas"), { recursive: true, force: true });
      rmSync(join(tree, "foundation"), { recursive: true, force: true });
    }
    const install = await run("pnpm", ["install", "--offline"], tree);
    const base = { variant: label, round };
    record({
      ...base,
      step: "install",
      ms: install.ms,
      code: install.code,
      load: install.load,
    });

    const cold = await run(
      "pnpm",
      ["--filter", "@purin-labs/platform", "check:types"],
      tree,
    );
    record({
      ...base,
      step: "check:types cold",
      ms: cold.ms,
      code: cold.code,
      load: cold.load,
    });
    const warm = await run(
      "pnpm",
      ["--filter", "@purin-labs/platform", "check:types"],
      tree,
    );
    record({
      ...base,
      step: "check:types warm",
      ms: warm.ms,
      code: warm.code,
      load: warm.load,
    });
    const raw = await run("pnpm", ["exec", "tsrs", "--noEmit"], platform);
    record({
      ...base,
      step: "tsrs --noEmit (Worker only)",
      ms: raw.ms,
      code: raw.code,
      load: raw.load,
    });
    const tests = await run(
      "pnpm",
      ["--filter", "@purin-labs/platform", "check:test-types"],
      tree,
    );
    record({
      ...base,
      step: "check:test-types",
      ms: tests.ms,
      code: tests.code,
      load: tests.load,
    });
    if (label === "P") {
      for (const [name, folder] of [
        ["kernel", "foundation/kernel"],
        ["devices-server", "areas/devices/server"],
      ]) {
        const own = await run(
          "pnpm",
          ["exec", "tsrs", "--noEmit"],
          join(tree, folder),
        );
        record({
          ...base,
          step: `package check ${name}`,
          ms: own.ms,
          code: own.code,
          errors: (own.text.match(/error TS/gu) ?? []).length,
          load: own.load,
        });
      }
    }

    const portal = await run("pnpm", ["portal:build"], tree);
    const built = portal.text.match(/built in ([\d.]+)(ms|s)/u);
    record({
      ...base,
      step: "portal:build",
      ms: portal.ms,
      code: portal.code,
      viteMs: built ? Number(built[1]) * (built[2] === "s" ? 1000 : 1) : null,
      load: portal.load,
    });

    const bundleDir = join(scratch, `m-bundle-${label}`);
    rmSync(bundleDir, { recursive: true, force: true });
    const bundle = await run(
      "pnpm",
      [
        "exec",
        "wrangler",
        "deploy",
        "--dry-run",
        "--env",
        "production",
        "--outdir",
        bundleDir,
      ],
      platform,
      /Total Upload/u,
    );
    const size = bundle.text.match(
      /Total Upload: ([\d.]+) KiB \/ gzip: ([\d.]+) KiB/u,
    );
    const file = join(bundleDir, "integration-gateway.js");
    record({
      ...base,
      step: "wrangler dry-run",
      ms: bundle.ms,
      code: bundle.code,
      bundleMs: bundle.markMs,
      uploadKiB: size ? Number(size[1]) : null,
      gzipKiB: size ? Number(size[2]) : null,
      bytes: existsSync(file) ? statSync(file).size : null,
      load: bundle.load,
    });

    const journey = await run(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.e2e.config.ts",
        "tests/e2e/devices-page.test.ts",
      ],
      platform,
    );
    const duration = journey.text.match(
      /Duration\s+([\d.]+)s \(transform ([\d.]+)(ms|s), setup ([\d.]+)(ms|s), import ([\d.]+)(ms|s), tests ([\d.]+)(ms|s)/u,
    );
    const unit = (value, u) =>
      Math.round(Number(value) * (u === "s" ? 1000 : 1));
    record({
      ...base,
      step: "e2e devices-page",
      ms: journey.ms,
      code: journey.code,
      passed: /1 passed/u.test(journey.text),
      durationMs: duration ? unit(duration[1], "s") : null,
      transformMs: duration ? unit(duration[2], duration[3]) : null,
      setupMs: duration ? unit(duration[4], duration[5]) : null,
      testsMs: duration ? unit(duration[8], duration[9]) : null,
      toFirstTestMs: duration
        ? journey.ms - unit(duration[8], duration[9])
        : null,
      load: journey.load,
    });

    const lint = await run("pnpm", ["lint:static"], tree);
    record({
      ...base,
      step: "lint:static",
      ms: lint.ms,
      code: lint.code,
      load: lint.load,
    });
  }
}

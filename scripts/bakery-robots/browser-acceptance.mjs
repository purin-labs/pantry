#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { runBrowserCli } from "../browser-cli.mjs";

const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const { values } = parseArgs({
  options: {
    url: {
      type: "string",
      default: "http://127.0.0.1:3103/workflow-preview.html",
    },
    session: { type: "string", default: `bakery-acceptance-${process.pid}` },
    output: { type: "string", default: "output/playwright/refactor-6" },
    journey: {
      type: "string",
      default: "scripts/bakery-robots/verify-tray-layout-drag-browser.js",
    },
    mode: { type: "string", default: "webgl" },
    prerequisite: { type: "string", multiple: true, default: [] },
    timeout: { type: "string", default: "240000" },
  },
});
const artifactDir = resolve(root, values.output);
mkdirSync(artifactDir, { recursive: true });
const options = {
  root,
  session: values.session,
  artifactDir,
  timeoutMs: Number(values.timeout),
  env: {
    ...process.env,
    PWTEST_DAEMON_SESSION_DIR: join(artifactDir, "daemon"),
    PLAYWRIGHT_MCP_OUTPUT_DIR: artifactDir,
    PLAYWRIGHT_BROWSERS_PATH:
      process.env.PLAYWRIGHT_BROWSERS_PATH ??
      join(homedir(), "Library/Caches/ms-playwright"),
  },
};

function run(command, args = [], timeoutMs = options.timeoutMs) {
  process.stdout.write(`Browser acceptance: ${command}\n`);
  return runBrowserCli({ ...options, timeoutMs }, command, args);
}

async function main() {
  const startedAt = Date.now();
  try {
    if (values.mode !== "webgl" && values.mode !== "fallback")
      throw new Error("Mode must be webgl or fallback.");
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
      throw new Error("Timeout must be positive.");
    const journey = resolve(root, values.journey);
    const prerequisites = [
      journey,
      ...values.prerequisite.map(resolvePrerequisite),
    ];
    if (journey.endsWith("/verify-spatial-events.js"))
      prerequisites.push(
        resolve(root, "output/playwright/plan42d-blocked-recording.json"),
      );
    for (const path of prerequisites) {
      if (!existsSync(path)) throw new Error(`Missing prerequisite: ${path}`);
    }
    const response = await fetch(values.url, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error(`Target returned HTTP ${response.status}`);
    mkdirSync(options.env.PWTEST_DAEMON_SESSION_DIR, { recursive: true });
    mkdirSync(resolve(root, "output/playwright/plan42f-tray-layout-drag"), {
      recursive: true,
    });
    run("open", ["about:blank"]);
    if (values.mode === "fallback")
      run("run-code", [
        "--filename",
        resolve(root, "scripts/bakery-robots/disable-webgl.js"),
      ]);
    run("goto", [values.url]);
    run("tracing-start");
    const hasWebGL = run("eval", [
      'Boolean(document.createElement("canvas").getContext("webgl2"))',
    ]);
    const expected = values.mode === "webgl";
    if (hasWebGL !== expected)
      throw new Error(
        `Wrong WebGL mode: expected ${expected}, received ${JSON.stringify(hasWebGL)}`,
      );
    const result = run("run-code", ["--filename", scopedJourney(journey)]);
    if (
      result === null ||
      typeof result !== "object" ||
      (result.result !== "passed" && result.status !== "passed")
    )
      throw new Error(
        `Journey has no passing result: ${JSON.stringify(result)}`,
      );
    if ("hasWebGL" in result && result.hasWebGL !== expected)
      throw new Error("Journey ran in the wrong WebGL mode.");
    writeFileSync(
      join(artifactDir, "report.json"),
      JSON.stringify(
        {
          result: "passed",
          journey: values.journey,
          mode: values.mode,
          hasWebGL,
          elapsedMs: Date.now() - startedAt,
          checks: result,
        },
        null,
        2,
      ) + "\n",
    );
    process.stdout.write(`Passed ${values.journey} (${values.mode})\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(
      join(artifactDir, "report.json"),
      JSON.stringify(
        {
          result: "failed",
          journey: values.journey,
          mode: values.mode,
          message,
          elapsedMs: Date.now() - startedAt,
        },
        null,
        2,
      ) + "\n",
    );
    try {
      run("console", ["error"], 10000);
      run("snapshot", [], 10000);
    } catch {
      /* Keep the original failure when the browser is unavailable. */
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    try {
      run("tracing-stop", [], 10000);
    } catch {
      // Keep acceptance or browser-start failure as the primary result.
    }
    try {
      run("close", [], 10000);
    } catch {
      /* Failure diagnostics were retained above. */
    }
    printJourneyProgress();
  }
}

function printJourneyProgress() {
  // Keep command progress in the CI log even when artifact upload fails.
  for (const name of readdirSync(artifactDir)) {
    if (!name.startsWith("console-") || !name.endsWith(".log")) continue;
    const lines = readFileSync(join(artifactDir, name), "utf8").split("\n");
    for (const line of lines)
      if (line.includes("[bakery-acceptance]"))
        process.stdout.write(`${line}\n`);
  }
}

function resolvePrerequisite(path) {
  return resolve(root, path);
}

await main();

// A journey file may declare helpers beside its `async function verify…(page)`.
function journeyEntry(source) {
  const entries = [
    ...source.matchAll(/^async function (verify\w*)\(page\) \{$/gmu),
  ];
  if (entries.length !== 1)
    throw new Error("A journey declares one async function verify…(page).");
  return entries[0][1];
}

function scopedJourney(journey) {
  const navigation = readFileSync(
    resolve(root, "scripts/bakery-robots/simulator-navigation.js"),
    "utf8",
  ).trim();
  const source = readFileSync(journey, "utf8").trim();
  const entry = journeyEntry(source);
  const path = join(artifactDir, "journey.js");
  writeFileSync(
    path,
    `async function scopedAcceptance(page) {
    const pageCapture = page.screenshot;
    const locatorPrototype = Object.getPrototypeOf(page.locator("body"));
    const locatorCapture = locatorPrototype.screenshot;
    const screenshots = [];
    async function capture(target, method, options) {
      const scoped = options?.path === undefined ? options : {
        ...options,
        path: ${JSON.stringify(artifactDir)} + "/" + options.path.split("/").pop(),
      };
      const image = await method.call(target, scoped);
      if (scoped?.path !== undefined) screenshots.push(scoped.path);
      return image;
    }
    function pageScreenshot(options) { return capture(this, pageCapture, options); }
    function locatorScreenshot(options) { return capture(this, locatorCapture, options); }
    page.screenshot = pageScreenshot;
    locatorPrototype.screenshot = locatorScreenshot;
    globalThis.bakeryEvidence = ${JSON.stringify(artifactDir)};
    globalThis.bakeryBase = ${JSON.stringify(new URL(values.url).origin)};
    const result = await (() => {
${navigation}
${source}
return ${entry};
})()(page);
    if (result !== null && typeof result === "object")
      return { ...result, screenshots };
    return result;
  }`,
  );
  return path;
}

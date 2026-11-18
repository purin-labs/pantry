#!/usr/bin/env node

/**
 * A tab that stays open across a release asks for code files that the release
 * removed. This journey serves the built Portal as release A, swaps the server
 * to release B while the tab is open, and opens a lazily loaded page.
 *
 * Release B is release A with every code file renamed, as a real release does.
 * The server answers a missing path with the Portal's HTML page, as the
 * Worker's single-page-application asset handling does.
 *
 * Checks: the tab reloads once into release B and opens the page; a page whose
 * code is missing from the current release itself shows the error page after
 * one reload, and does not reload again.
 *
 * Usage: pnpm portal:build && node scripts/portal-stale-release/journey.mjs
 */

import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import process from "node:process";
import { runBrowserCli } from "../browser-cli.mjs";

const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const dist = join(root, "apps/portal/dist");
const artifactDir = join(root, "output/playwright/portal-stale-release");
const releases = join(artifactDir, "releases");
const portalFixture = join(
  root,
  "scripts/plan21/browser-acceptance-fixture.js",
);
const session = `portal-stale-release-${process.pid}`;

if (!existsSync(join(dist, "index.html")))
  throw new Error("Build the Portal first: pnpm portal:build");
rmSync(artifactDir, { recursive: true, force: true });
mkdirSync(join(artifactDir, "daemon"), { recursive: true });
const releaseA = join(releases, "a");
const releaseB = join(releases, "b");
cpSync(dist, releaseA, { recursive: true });
const renamed = makeNextRelease(releaseA, releaseB);

const server = spawn(
  process.execPath,
  [join(root, "scripts/portal-stale-release/server.mjs"), releaseA, releaseB],
  { stdio: ["ignore", "pipe", "inherit"] },
);
const port = await new Promise((done, fail) => {
  server.stdout.once("data", (chunk) => done(String(chunk).trim()));
  server.once("exit", (code) =>
    fail(new Error(`Release server exited ${code}`)),
  );
});
const base = `http://127.0.0.1:${port}`;

const cliEnv = {
  ...process.env,
  PWTEST_DAEMON_SESSION_DIR: join(artifactDir, "daemon"),
  PLAYWRIGHT_BROWSERS_PATH:
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(homedir(), "Library/Caches/ms-playwright"),
};

try {
  runCli("open", ["data:text/html,<title>Portal stale release</title>"]);
  runCli("run-code", ["--filename", portalFixture]);
  const result = runCli("run-code", [journeyCommand()]);
  const report = {
    result: "passed",
    releaseA: entryOf(releaseA),
    releaseB: entryOf(releaseB),
    renamedCodeFiles: renamed,
    ...result,
    checks: [
      "A tab of release A opens the Brain page after the swap to release B",
      "The tab reloads exactly once and runs release B",
      "Code missing from the current release itself shows the error page after one reload",
      "The error page does not reload again",
    ],
  };
  assertJourney(report);
  writeFileSync(
    join(artifactDir, "report.json"),
    JSON.stringify(report, null, 2),
  );
  process.stdout.write("Portal stale release journey passed.\n");
} catch (error) {
  writeFileSync(
    join(artifactDir, "report.json"),
    JSON.stringify(
      {
        result: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  try {
    runCli("close");
  } catch {
    // The original failure matters more than a browser that did not start.
  }
  server.kill();
}

function entryOf(directory) {
  return readFileSync(join(directory, "index.html"), "utf8").match(
    /<script type="module"[^>]*src="([^"]+)"/u,
  )[1];
}

function assertJourney(report) {
  const swap = report.swap;
  if (swap.documentLoads !== 1)
    throw new Error(`Swap: expected one reload, saw ${swap.documentLoads}`);
  if (!swap.pageOpened) throw new Error("Swap: the Brain page did not open");
  if (swap.entry !== report.releaseB)
    throw new Error(`Swap: the tab runs ${swap.entry}, not release B`);
  const guard = report.guard;
  if (guard.documentLoads !== 1)
    throw new Error(`Guard: expected one reload, saw ${guard.documentLoads}`);
  if (!guard.errorPageShown)
    throw new Error("Guard: the error page did not show");
}

/** Copies a release and renames each code file, so no old code path exists in it. */
function makeNextRelease(from, to) {
  cpSync(from, to, { recursive: true });
  const assets = join(to, "assets");
  const names = readdirSync(assets).filter((name) => name.endsWith(".js"));
  const next = new Map(
    names.map((name) => [name, name.replace(/\.js$/u, "-next.js")]),
  );
  for (const file of textFiles(to)) {
    let text = readFileSync(file, "utf8");
    for (const [name, nextName] of next)
      text = text.replace(
        new RegExp(`(?<![A-Za-z0-9_-])${escape(name)}`, "gu"),
        nextName,
      );
    writeFileSync(file, text);
  }
  for (const [name, nextName] of next)
    renameSync(join(assets, name), join(assets, nextName));
  return next.size;
}

function textFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...textFiles(path));
    else if ([".js", ".html", ".css"].includes(extname(name))) files.push(path);
  }
  return files;
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The browser CLI runs this function with the page; it cannot import modules. */
function journeyCommand() {
  return `async function portalStaleRelease(page) {
    const base = ${JSON.stringify(base)};
    const artifactDir = ${JSON.stringify(artifactDir)};
    const control = async (path) => (await page.request.get(base + path)).json();
    const pageLink = (name) => page.locator(
      'nav[aria-label="Workspace pages"]:visible a[href="/portal/cafe-browser-lab/main/' + name + '"]',
    ).first();
    const entry = () => page.evaluate(() =>
      document.querySelector('script[type="module"][src*="/assets/"]').getAttribute("src"));

    // Release A is open; release B replaces it before the Brain page's code loads.
    await page.goto(base + "/portal/cafe-browser-lab/main?p21_auth=1");
    await pageLink("brain").waitFor({ state: "visible", timeout: 20000 });
    const before = await control("/__journey/release?name=b");
    await pageLink("brain").click();
    await page.waitForFunction(
      () => sessionStorage.getItem("satyr:stale-release-reload") !== null,
      undefined,
      { timeout: 20000 },
    );
    await page.waitForLoadState("load");
    await page.getByRole("heading", { name: "Brain" }).first()
      .waitFor({ state: "visible", timeout: 20000 });
    await page.waitForTimeout(2000);
    const afterSwap = await control("/__journey/state");
    await page.screenshot({ path: artifactDir + "/after-release.png" });
    const swap = {
      documentLoads: afterSwap.documentLoads - before.documentLoads,
      pageOpened:
        page.url().endsWith("/portal/cafe-browser-lab/main/brain") &&
        !(await page.getByRole("heading", { name: "Something went wrong" }).isVisible()),
      entry: await entry(),
      reloadedRelease: await page.evaluate(() =>
        sessionStorage.getItem("satyr:stale-release-reload")),
    };

    // Release B itself lacks the Agents page's code: one reload, then the error page.
    await page.goto(base + "/portal/cafe-browser-lab/main?p21_auth=1");
    await pageLink("agents").waitFor({ state: "visible", timeout: 20000 });
    const loaded = await page.evaluate(() => performance.getEntriesByType("resource")
      .map((item) => new URL(item.name).pathname).filter((path) => path.endsWith(".js")));
    const keep = new URLSearchParams(loaded.map((path) => ["path", path])).toString();
    const guarded = await control("/__journey/keep-only?" + keep);
    await pageLink("agents").click();
    await page.getByRole("heading", { name: "Something went wrong" })
      .waitFor({ state: "visible", timeout: 20000 });
    await page.waitForTimeout(3000);
    const afterGuard = await control("/__journey/state");
    await page.screenshot({ path: artifactDir + "/missing-code.png" });
    return {
      swap,
      guard: {
        documentLoads: afterGuard.documentLoads - guarded.documentLoads,
        errorPageShown: await page.getByRole("heading", { name: "Something went wrong" }).isVisible(),
        url: new URL(page.url()).pathname,
        reloadedRelease: await page.evaluate(() =>
          sessionStorage.getItem("satyr:stale-release-reload")),
      },
    };
  }`;
}

function runCli(command, args = []) {
  return runBrowserCli(
    { root, session, env: cliEnv, artifactDir, timeoutMs: 180000 },
    command,
    args,
  );
}

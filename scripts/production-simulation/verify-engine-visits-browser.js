// Refactor 16 step 11: the bytes and the start times of a first and a
// second visit. Run through scripts/bakery-robots/browser-acceptance.mjs on
// the built Portal, served by scripts/production-simulation/serve-portal-assets.mjs:
//
//   node scripts/production-simulation/serve-portal-assets.mjs apps/portal/dist 5296
//   node scripts/bakery-robots/browser-acceptance.mjs \
//     --url http://127.0.0.1:5296/linea-rehearsal.html \
//     --journey scripts/production-simulation/verify-engine-visits-browser.js \
//     --output OUT --timeout 900000
//
// Each visit opens the Linea page and runs two appliance jobs: "Warm both
// boilers" (the first job starts the engine worker) and "Advance 20
// seconds". A job's start time runs from the click to the first "Simulating
// job" status, when the engine has its module and its models; its result
// time runs to "Completed job". The server counts the bytes that it sends
// for each visit. The second visit is a new navigation in the same browser,
// so its HTTP cache holds what the first visit fetched.
//
// With `?savedRun=PATH` (a Linea rehearsal file that an older bundle saved),
// the journey then opens that file and advances it: the job runs on the
// bundle that saved it (Plan 70B), through retained-appliance-worker.ts.
//
// With `?expect=immutable` on the page address, the journey also checks the
// cache rule: the second visit sends no request for a file under
// /bakery-physics/ to the server. Without it, the journey only reports.
async function served(page, reset) {
  return page.evaluate(
    async (method) => (await fetch("/__served", { method })).json(),
    reset ? "POST" : "GET",
  );
}

/** One job: the times from its click to each change of the status line. */
async function timedJob(page, label) {
  const status = page.locator("#status");
  const before = await status.innerText();
  await status.evaluate((node) => {
    const changes = [];
    globalThis.visitChanges = changes;
    globalThis.visitObserver?.disconnect();
    globalThis.visitObserver = new MutationObserver(() =>
      changes.push([performance.now(), node.textContent ?? ""]),
    );
    globalThis.visitObserver.observe(node, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  const button = page.getByRole("button", { name: label, exact: true });
  await button.evaluate((node) =>
    node.addEventListener(
      "click",
      () => {
        globalThis.visitClick = performance.now();
      },
      { once: true },
    ),
  );
  await button.click();
  // One button can send several engine requests; the page shows
  // "Completed job N." after the last one.
  await page.waitForFunction(
    (previous) => {
      const text = document.getElementById("status")?.textContent ?? "";
      return /^Completed job \d+\.$/u.test(text) && text !== previous;
    },
    before,
    { timeout: 125000 },
  );
  const { click, changes } = await page.evaluate(() => ({
    click: globalThis.visitClick,
    changes: globalThis.visitChanges,
  }));
  const simulating = changes.find(([, text]) =>
    text.startsWith("Simulating job"),
  );
  const completed = changes.findLast(([, text]) =>
    /^Completed job \d+\.$/u.test(text),
  );
  return {
    label,
    startMs: Math.round(simulating[0] - click),
    resultMs: Math.round(completed[0] - click),
  };
}

async function visit(page, url) {
  await served(page, true);
  const opened = Date.now();
  await page.goto(url);
  await page.locator("#status").waitFor();
  const readyMs = Date.now() - opened;
  const jobs = [
    await timedJob(page, "Warm both boilers"),
    await timedJob(page, "Advance 20 seconds"),
  ];
  return { readyMs, jobs, served: await served(page, false) };
}

/** Opens a saved rehearsal and advances it on the bundle that saved it. */
async function continueSavedRun(page, path) {
  await served(page, true);
  const opened = Date.now();
  await page.locator("#open-run").setInputFiles(path);
  await page
    .locator("#status")
    .filter({ hasText: "Saved rehearsal restored." })
    .waitFor({ timeout: 125000 });
  const restoredMs = Date.now() - opened;
  const job = await timedJob(page, "Advance 20 seconds");
  const { physicsFiles } = await served(page, false);
  // The worker requests run outside the page, so the server names them.
  const bundles = [
    ...new Set(
      Object.keys(physicsFiles)
        .map((path) => /\/bundles\/([0-9a-f]{64})\//u.exec(path)?.[1])
        .filter(Boolean),
    ),
  ];
  return { restoredMs, job, bundles };
}

async function verifyEngineVisitsBrowser(page) {
  const url = page.url();
  const first = await visit(page, url);
  const second = await visit(page, url);
  if (first.served.physicsBytes === 0)
    throw new Error("The first visit fetched no engine file.");
  if (
    new URL(url).searchParams.get("expect") === "immutable" &&
    second.served.physicsRequests !== 0
  )
    throw new Error(
      `The second visit sent ${second.served.physicsRequests} engine requests.`,
    );
  const saved = new URL(url).searchParams.get("savedRun");
  const retained = saved === null ? null : await continueSavedRun(page, saved);
  if (retained !== null && retained.bundles.length === 0)
    throw new Error("The saved run fetched no bundle of its own.");
  await page.screenshot({ path: "engine-visits.png" });
  return {
    result: "passed",
    hasWebGL: Boolean(
      await page.evaluate(() =>
        document.createElement("canvas").getContext("webgl2"),
      ),
    ),
    first,
    second,
    retained,
  };
}

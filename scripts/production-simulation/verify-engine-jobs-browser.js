// Refactor 16 step 5: one engine worker for the jobs of a page. Run through
// scripts/bakery-robots/browser-acceptance.mjs on workflow-preview.html.
//
// The journey records every request of the page and checks, in the robot
// comparison and on the Linea and Eagle pages:
//  - the first job fetches the Wasm module and the model data, and a second
//    job fetches neither;
//  - a running job shows its step ("step 4,000 of about 14,750");
//  - Stop ends a job, and a new job then runs with no reload and no fetch.
// It returns the start-time table: from the click to the first step that the
// page shows, and to the result.
//
// Refactor 16 step 7: the comparison shows each run's margins against the
// robot's rated limits in its "Robot limits" column. The journey checks a
// run within the limits, the UR5e with 2 kg (a motor stays at its torque
// limit: a warning), the CR10 (no rated torque), and a blocked destination
// (no motion: not measured).
//
// Refactor 16 step 11: the engine files are the Wasm, the model index and
// the model packs. A job fetches only the packs of its models: the FANUC
// comparison fetches the core pack and the FANUC pack, an espresso page only
// the core pack. The page fetches none of them; the worker does, one time.
const enginePattern =
  /\/bakery-physics\/bundles\/[0-9a-f]{64}\/(bakery_native\.(wasm|data)|models\.json|models-[a-z0-9-]+\.pack)$/u;

function engineFiles(log) {
  return log
    .filter((url) => enginePattern.test(new URL(url).pathname))
    .map((url) => new URL(url).pathname.split("/").at(-1))
    .sort();
}

function engineRequests(log) {
  return engineFiles(log).length;
}

/** The bytes of the engine files that the page received. */
function engineBytes(responses) {
  let bytes = 0;
  for (const [url, length] of responses)
    if (enginePattern.test(new URL(url).pathname)) bytes += length;
  return bytes;
}

async function openComparison(page) {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page
    .getByRole("button", { name: "More simulator tools", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Robot rehearsal", exact: true })
    .click();
  await page.getByRole("tab", { name: "Compare & files", exact: true }).click();
  const comparison = page.getByRole("region", {
    name: "Robot selection and comparison",
  });
  await comparison
    .getByRole("button", { name: "Run selected robot", exact: true })
    .waitFor();
  return comparison;
}

/**
 * One comparison job. The page records each change of the status line with
 * its time, so the table gives the time from the click to the first step
 * that the page showed and to the result.
 */
async function timedJob(page, comparison) {
  const status = comparison.getByRole("status");
  await status.evaluate((node) => {
    const changes = [];
    globalThis.engineJobChanges = changes;
    globalThis.engineJobObserver?.disconnect();
    globalThis.engineJobObserver = new MutationObserver(() =>
      changes.push([performance.now(), node.textContent ?? ""]),
    );
    globalThis.engineJobObserver.observe(node, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  const button = comparison.getByRole("button", {
    name: "Run selected robot",
    exact: true,
  });
  await button.evaluate((node) =>
    node.addEventListener(
      "click",
      () => {
        globalThis.engineJobClick = performance.now();
      },
      { once: true },
    ),
  );
  await button.click();
  await status
    .filter({ hasText: "Run complete." })
    .waitFor({ timeout: 125000 });
  const { click, changes } = await page.evaluate(() => ({
    click: globalThis.engineJobClick,
    changes: globalThis.engineJobChanges,
  }));
  const stepPattern = /step [\d,]+ of about [\d,]+/u;
  const shown = changes.filter(([, text]) => stepPattern.test(text));
  const done = changes.find(([, text]) => text.startsWith("Run complete."));
  if (shown.length === 0 || done === undefined)
    throw new Error(`The job showed no step: ${JSON.stringify(changes)}`);
  const row = await comparison.locator("tbody tr").first().innerText();
  if (!row.includes("completed"))
    throw new Error(`The comparison job did not complete: ${row}`);
  return {
    firstStepMs: Math.round(shown[0][0] - click),
    resultMs: Math.round(done[0] - click),
    stepsShown: shown.length,
    firstProgress: shown[0][1],
  };
}

async function choose(page, comparison, index, label) {
  await comparison.getByRole("combobox").nth(index).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

/**
 * The "Robot limits" cell of the newest comparison row; a `screenshot` names
 * a picture of the cell.
 */
async function limitsRun(page, comparison, screenshot = null) {
  await comparison
    .getByRole("button", { name: "Run selected robot", exact: true })
    .click();
  await comparison
    .getByRole("status")
    .filter({ hasText: "Run complete." })
    .waitFor({ timeout: 125000 });
  const headers = await comparison.locator("thead th").allInnerTexts();
  const column = headers.indexOf("Robot limits");
  if (column < 0) throw new Error(`No limits column: ${headers.join(" | ")}`);
  const cell = comparison.locator("tbody tr").first().locator("td").nth(column);
  if (screenshot !== null) {
    await cell.scrollIntoViewIfNeeded();
    await cell.screenshot({ path: screenshot });
  }
  return cell.innerText();
}

function expectLimits(label, text, patterns) {
  for (const pattern of patterns)
    if (!pattern.test(text))
      throw new Error(`${label}: "${text}" does not match ${pattern}`);
  return text;
}

async function verifyLimits(page, comparison) {
  const within = expectLimits("FANUC", await limitsRun(page, comparison), [
    /Least speed margin: J\d at \d+ % of its rated speed \([\d.]+ of [\d.]+ rad\/s\)/u,
    /At a torque limit: never/u,
    /Deepest contact: 0\.\d mm \(clamp_pad_\w+ on mbco_tray_\w+\)/u,
    /Grip slip: \d\.\d mm/u,
    /Within the robot's limits\./u,
  ]);
  await choose(page, comparison, 0, "Universal Robots UR5e");
  await comparison.getByLabel("Ingredient mass (kg)").fill("2");
  const clamp = expectLimits(
    "UR5e 2 kg",
    await limitsRun(page, comparison, "robot-limits-warning.png"),
    [
      /At a torque limit: wrist_1_joint, \d+ ms at 28 N·m/u,
      /wrist_1_joint stayed at its torque limit for \d+ ms\. The bound is 50 ms\./u,
    ],
  );
  await comparison.getByLabel("Ingredient mass (kg)").fill("1");
  await choose(page, comparison, 0, "DOBOT CR10 \u2014 provisional dynamics");
  const unrated = expectLimits(
    "CR10",
    await limitsRun(page, comparison, "robot-limits-unrated.png"),
    [
      /no rated torque; the 300 N·m limit is a simulation value/u,
      /Within the robot's limits\./u,
    ],
  );
  await choose(page, comparison, 2, "Blocked destination");
  const blocked = expectLimits("blocked", await limitsRun(page, comparison), [
    /^Not measured$/u,
  ]);
  await choose(page, comparison, 2, "Nominal");
  return { within, clamp, unrated, blocked };
}

/** Two appliance jobs on an espresso page: the second fetches nothing. */
async function espressoPage(page, file, log) {
  const before = log.length;
  await page.goto(`${globalThis.bakeryBase}/${file}`);
  const status = page.locator("#status");
  await status.waitFor();
  const jobs = [];
  for (const label of ["Warm both boilers", "Advance 20 seconds"]) {
    const started = Date.now();
    await page.getByRole("button", { name: label, exact: true }).click();
    await status
      .filter({ hasText: /^Completed job \d+\.$/u })
      .waitFor({ timeout: 125000 });
    jobs.push({
      label,
      resultMs: Date.now() - started,
      engineRequests: engineRequests(log.slice(before)),
    });
  }
  const files = engineFiles(log.slice(before));
  if (
    files.join(" ") !== "bakery_native.wasm models-core.pack models.json" ||
    jobs[1].engineRequests !== jobs[0].engineRequests
  )
    throw new Error(`${file}: ${JSON.stringify({ jobs, files })}`);
  return { jobs, files };
}

async function verifyEngineJobsBrowser(page) {
  const log = [];
  const responses = [];
  page.on("request", (request) => log.push(request.url()));
  page.on("response", (response) =>
    responses.push([
      response.url(),
      Number(response.headers()["content-length"] ?? 0),
    ]),
  );
  const comparison = await openComparison(page);

  const first = await timedJob(page, comparison);
  const afterFirst = engineRequests(log);
  const bytesFirst = engineBytes(responses);
  const second = await timedJob(page, comparison);
  const afterSecond = engineRequests(log);
  const bytesSecond = engineBytes(responses) - bytesFirst;
  // The worker fetches and checks the Wasm, the index and the two packs of
  // this job, each one time.
  const firstFiles = engineFiles(log);
  if (
    firstFiles.join(" ") !==
    "bakery_native.wasm models-core.pack models-fanuc-crx10ial.pack models.json"
  )
    throw new Error(`The first job fetched ${JSON.stringify(firstFiles)}`);
  if (afterSecond !== afterFirst)
    throw new Error("The second job fetched the engine again");

  // Stop at a step boundary, then a new job with no reload.
  await comparison
    .getByRole("button", { name: "Compare existing arms", exact: true })
    .click();
  const status = comparison.getByRole("status");
  await status
    .filter({ hasText: /step [\d,]+ of about [\d,]+/u })
    .waitFor({ timeout: 125000 });
  const stoppedAt = await status.innerText();
  await comparison
    .getByRole("button", { name: "Stop comparison", exact: true })
    .click();
  await status
    .filter({ hasText: "Comparison stopped." })
    .waitFor({ timeout: 10000 });
  // "Compare existing arms" fetched the packs of the other arms, one time.
  const beforeAfterStop = engineRequests(log);
  const afterStop = await timedJob(page, comparison);
  const afterStopRequests = engineRequests(log);
  const afterStopFiles = engineFiles(log);
  if (
    afterStopRequests !== beforeAfterStop ||
    engineFiles(log).filter((file) => file === "bakery_native.wasm").length !==
      1 ||
    new Set(engineFiles(log)).size !== engineFiles(log).length
  )
    throw new Error(
      `A job after Stop fetched the engine again: ${JSON.stringify(engineFiles(log))}`,
    );
  await page.screenshot({ path: "engine-jobs-comparison.png" });
  const limits = await verifyLimits(page, comparison);

  const linea = await espressoPage(page, "linea-rehearsal.html", log);
  const eagle = await espressoPage(page, "eagle-rehearsal.html", log);

  return {
    result: "passed",
    hasWebGL: Boolean(
      await page.evaluate(() =>
        document.createElement("canvas").getContext("webgl2"),
      ),
    ),
    startTimes: { first, second, afterStop },
    engineRequests: { afterFirst, afterSecond, afterStop: afterStopRequests },
    engineFiles: { firstJob: firstFiles, afterStop: afterStopFiles },
    engineBytes: { firstJob: bytesFirst, secondJob: bytesSecond },
    stoppedAt,
    limits,
    linea,
    eagle,
  };
}

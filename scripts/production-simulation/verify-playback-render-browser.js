// Playback render budget (Refactor 16, step 13). For one recipe production
// (Caffe Latte) and for the workflow simulator's shift replay, the journey
// counts React commits and WebGL frames while the run plays, and WebGL frames
// while it is paused. A paused, unchanged scene draws no frame, and playback
// time does not pass through React state on each frame.
//
// React commits: a minimal __REACT_DEVTOOLS_GLOBAL_HOOK__ that the page sees
// before React loads. Frames: wrappers of the draw and clear calls of the
// WebGL contexts. One frame is one task of those calls, so a shadow pass or a
// post-processing chain counts one time. (three.js defines render on each
// WebGLRenderer instance, so a wrapper on its prototype sees no call.)
//
// node scripts/bakery-robots/browser-acceptance.mjs \
//   --url http://127.0.0.1:5194/factory-acceptance.html \
//   --journey scripts/production-simulation/verify-playback-render-browser.js \
//   --output <directory> --timeout 900000
async function verifyPlaybackRenderBrowser(page) {
  const origin = new URL(page.url()).origin;
  // Under SwiftShader a scene load blocks the page for about 50 seconds.
  page.setDefaultTimeout(240000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(installRenderCounters);
  const recipe = await measureLatte(page, `${origin}/factory-acceptance.html`);
  const simulator = await measureShiftReplay(
    page,
    `${origin}/workflow-preview.html`,
  );
  const report = { recipe, simulator };
  // The browser console keeps the numbers in the CI log, also on a failure.
  await page.evaluate(function logReport(text) {
    console.log(`[bakery-acceptance] playback render ${text}`);
  }, JSON.stringify(report));
  const failures = [];
  for (const [name, row] of Object.entries(report)) {
    if (row.playing.framesPerSecond <= 0)
      failures.push(`${name}: no frame while playing`);
    if (row.playing.advancedSeconds <= 0)
      failures.push(`${name}: the clock did not advance`);
    if (row.paused.frames !== 0)
      failures.push(`${name}: ${row.paused.frames} frames while paused`);
    // Without a GPU a frame takes about one second, so one commit for each
    // frame is also about one commit each second. The gate compares the
    // commits with the frames: a commit at a run event or a stage change is
    // a coarse change, one commit for each frame is not.
    const allowed = Math.max(2, row.playing.frames / 2);
    if (row.playing.commits > allowed)
      failures.push(
        `${name}: ${row.playing.commits} React commits for ${row.playing.frames} frames of playback`,
      );
  }
  await page.screenshot({ path: "playback-render-simulator.png" });
  if (failures.length > 0)
    throw new Error(`${failures.join("; ")} ${JSON.stringify(report)}`);
  return { result: "passed", ...report, failures };
}

// Runs in the page before any page script.
function installRenderCounters() {
  // Vite serves each module as one request; the default buffer keeps 250.
  performance.setResourceTimingBufferSize(100000);
  const counters = { commits: 0, renders: 0, frames: 0, wrapped: false };
  window.__renderCounters = counters;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(renderer) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, renderer);
      return id;
    },
    onScheduleFiberRoot() {},
    onCommitFiberRoot() {
      counters.commits += 1;
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
  // three.js defines render on each renderer instance, so the journey counts
  // at the WebGL context: one frame is one task of draw calls and clears.
  let burst = false;
  function endBurst() {
    burst = false;
  }
  function count(method) {
    return function countedCall(...args) {
      counters.renders += 1;
      if (!burst) {
        burst = true;
        counters.frames += 1;
        queueMicrotask(endBurst);
      }
      return method.apply(this, args);
    };
  }
  for (const context of [WebGLRenderingContext, WebGL2RenderingContext]) {
    for (const name of [
      "clear",
      "drawArrays",
      "drawElements",
      "drawArraysInstanced",
      "drawElementsInstanced",
    ]) {
      const method = context.prototype[name];
      if (typeof method === "function") context.prototype[name] = count(method);
    }
  }
  counters.wrapped = true;
}

async function progress(page, step) {
  await page.evaluate(function logStep(text) {
    console.log(
      `[bakery-acceptance] playback render: ${text} ${JSON.stringify(window.__renderCounters)}`,
    );
  }, step);
}

function readCounters() {
  return { ...window.__renderCounters, now: performance.now() };
}

async function sampleWindow(page, milliseconds, clock) {
  const startTime = await clock();
  const start = await page.evaluate(readCounters);
  await page.waitForTimeout(milliseconds);
  const end = await page.evaluate(readCounters);
  const endTime = await clock();
  const seconds = (end.now - start.now) / 1000;
  return {
    seconds: Number(seconds.toFixed(2)),
    commits: end.commits - start.commits,
    frames: end.frames - start.frames,
    glCalls: end.renders - start.renders,
    commitsPerSecond: Number(
      ((end.commits - start.commits) / seconds).toFixed(2),
    ),
    framesPerSecond: Number(((end.frames - start.frames) / seconds).toFixed(2)),
    advancedSeconds: Number((endTime - startTime).toFixed(2)),
  };
}

async function measureLatte(page, url) {
  await page.goto(url);
  await waitForBakeryScene(page);
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page
    .getByRole("button", { name: "← Back", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: /^Caffe Latte/ }).click();
  const form = page.getByRole("form", {
    name: "Caffe latte recipe",
    exact: true,
  });
  await form.waitFor({ timeout: 30000 });
  await form
    .getByRole("button", { name: "Prepare caffe latte", exact: true })
    .click();
  const workspace = page.getByRole("region", { name: "Persistent production" });
  await workspace.waitFor({ timeout: 30000 });
  await progress(page, "latte prepared");
  // The station draws once its models load; a person waits for the scene.
  await page.waitForFunction(
    function stationDrawn() {
      return window.__renderCounters.frames > 0;
    },
    null,
    { timeout: 240000, polling: 250 },
  );
  await progress(page, "station drawn");
  await page.waitForTimeout(1500);
  const clockText = workspace.getByLabel("Simulation seconds", { exact: true });
  async function clock() {
    return Number(await clockText.textContent());
  }
  // The latte run ends after about 56 simulated seconds, about 10 s of
  // playback, so the window is short.
  await workspace
    .getByRole("button", { name: "Start production", exact: true })
    .click();
  await page.waitForTimeout(500);
  const playing = await sampleWindow(page, 3000, clock);
  const status = await workspace
    .getByLabel("Execution status", { exact: true })
    .textContent();
  if (status !== "running")
    throw new Error(`The latte run stopped during the measurement: ${status}`);
  await workspace
    .getByRole("button", { name: "Pause production run", exact: true })
    .click();
  await page.waitForTimeout(1000);
  const paused = await sampleWindow(page, 10000, clock);
  await page.screenshot({ path: "playback-render-latte.png" });
  return { name: "Caffe Latte recipe production", playing, paused };
}

async function measureShiftReplay(page, url) {
  await page.goto(url);
  await waitForBakeryScene(page);
  await page.waitForTimeout(1500);
  const clockText = page.getByLabel("Simulated time", { exact: true });
  async function clock() {
    const [hours, minutes, seconds] = (await clockText.textContent())
      .trim()
      .split(":")
      .map(Number);
    return hours * 3600 + minutes * 60 + seconds;
  }
  const controls = page.getByRole("group", {
    name: "Playback controls",
    exact: true,
  });
  await controls
    .getByRole("button", { name: "Play shift", exact: true })
    .click();
  await page.waitForTimeout(500);
  const playing = await sampleWindow(page, 5000, clock);
  await controls.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForTimeout(1000);
  const paused = await sampleWindow(page, 10000, clock);
  return { name: "Workflow simulator shift replay", playing, paused };
}

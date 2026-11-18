// Visual evidence capture. Run against the local Portal preview server.
// This records states for inspection; it does not certify them automatically.
async function capturePortalStates(page) {
  const origin = new URL(page.url()).origin;
  const directory = "output/playwright/ui-state-closure";
  const states = [];
  for (const view of [
    "overview",
    "learning",
    "knowledge",
    "evals",
    "activity",
    "context",
  ]) {
    for (const scenario of ["empty", "failed", "viewer"]) {
      states.push({
        name: `brain-${view}-${scenario}`,
        path: `/brain-preview.html?view=${view}&scenario=${scenario}`,
      });
    }
  }
  for (const scenario of [
    "empty",
    "mixed",
    "multiple-account",
    "incomplete-setup",
    "attention",
    "loading",
    "stale-refresh",
    "search-empty",
    "viewer",
  ]) {
    const mode =
      scenario === "loading" || scenario === "stale-refresh" ? "route" : "page";
    const integration = scenario === "loading" ? "&integration=dropbox" : "";
    states.push({
      name: `integrations-${scenario}`,
      path: `/integrations-preview.html?mode=${mode}&scenario=${scenario}${integration}`,
    });
  }
  for (const provider of ["dropbox", "gmail", "whatsapp"]) {
    for (const scenario of [
      "opening",
      "waiting",
      "failed",
      "attempt_failed",
      "reconnect",
      "unconfigured",
      "viewer",
    ]) {
      states.push({
        name: `${provider}-${scenario}`,
        path: `/integrations-preview.html?integration=${provider}&provider=${provider}&scenario=${scenario}`,
      });
    }
  }
  for (const scenario of ["disconnected", "authorizing", "connected"]) {
    states.push({
      name: `claude-${scenario}`,
      path: `/integrations-preview.html?integration=codex&codex=disconnected&claude=${scenario}`,
    });
  }
  for (const setup of ["new", "nuki", "model", "failed"]) {
    states.push({
      name: `mailbox-setup-${setup}`,
      path: `/integrations-preview.html?integration=gmail&scenario=connected&account=intacc_gmail_events&setup=${setup}`,
    });
  }
  for (const view of ["access", "capabilities", "data_flow"]) {
    for (const scenario of ["empty", "fresh", "viewer"]) {
      states.push({
        name: `access-${view}-${scenario}`,
        path: `/access-preview.html?view=${view}&scenario=${scenario}`,
      });
    }
  }
  for (const page of [
    "checkout",
    "products",
    "orders",
    "suppliers",
    "commerce",
  ]) {
    states.push({
      name: `${page}-empty`,
      path: `/commerce-preview.html?page=${page}&scenario=empty`,
    });
  }
  for (const scenario of ["single", "empty", "many"]) {
    states.push({
      name: `organisations-${scenario}`,
      path: `/organisations-preview.html?scenario=${scenario}`,
    });
  }
  const results = [];
  for (const state of states) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${origin}${state.path}`);
    await page.locator("#root").waitFor();
    await page.waitForTimeout(450);
    await page.screenshot({
      path: `${directory}/${state.name}-wide.png`,
      fullPage: true,
    });
    const text = await page.locator("body").innerText();
    await page.setViewportSize({ width: 320, height: 800 });
    await page.waitForTimeout(450);
    const overflow = await page.evaluate(
      "document.documentElement.scrollWidth > innerWidth",
    );
    await page.screenshot({
      path: `${directory}/${state.name}-narrow.png`,
      fullPage: true,
    });
    results.push({ name: state.name, path: state.path, overflow, text });
  }
  return { status: "captured", states: results };
}

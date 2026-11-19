async function verifySharedArtifactsBrowser(page) {
  const setup = await page.request.get(`${ARCHIVE_ORIGIN}/fixture/setup`);
  if (!setup.ok())
    throw new Error("Start the isolated archive acceptance runtime.");
  const fixture = await setup.json();
  globalThis.archiveFault = "upload";
  globalThis.archiveRequests = [];
  // Every control request goes to the archive runtime, not to the dev
  // server's /v1 proxy.
  await page.route(isControlRequest, forwardArchiveRequest);
  await page.route("**/src/dev/workflow-preview.tsx", previewStyles);
  await page.reload();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openArchive(page, fixture, 0);
  const source = `/@fs${checkoutRoot()}/services/platform/tests/fixtures/bakery-persistent-failure.json`;
  const file = await page.request.get(new URL(source, page.url()).href);
  await page
    .getByLabel(/^Open recipe, oven route or saved production run/)
    .setInputFiles({
      name: "failed-native-factory.json",
      mimeType: "application/json",
      buffer: await file.body(),
    });
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  await openRecovery(page);
  await page
    .getByRole("group", { name: "Detail panels", exact: true })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  const shared = page.getByRole("region", {
    name: "Workspace saved runs",
    exact: true,
  });
  await shared
    .getByLabel("Run name (required)")
    .fill("Native archive with interrupted upload");
  await shared
    .getByRole("button", { name: "Review save", exact: true })
    .click();
  await shared
    .getByRole("button", { name: "Confirm save", exact: true })
    .click();
  await shared
    .getByRole("status")
    .filter({ hasText: "save response is uncertain" })
    .waitFor();
  await shared.getByRole("button", { name: /^Check saved run / }).click();
  await shared
    .getByRole("status")
    .filter({ hasText: "was not found" })
    .waitFor();
  await page.screenshot({ path: "private-partial-upload.png", fullPage: true });
  globalThis.archiveFault = "publication";
  await shared
    .getByRole("button", { name: "Review save", exact: true })
    .click();
  await shared
    .getByRole("button", { name: "Confirm save", exact: true })
    .click();
  await shared
    .getByRole("status")
    .filter({ hasText: "save response is uncertain" })
    .waitFor();
  await shared.getByRole("button", { name: /^Check saved run / }).click();
  await shared
    .getByRole("status")
    .filter({ hasText: "verified by exact readback" })
    .waitFor();
  await page.screenshot({
    path: "published-after-lost-reply.png",
    fullPage: true,
  });
  const publications = globalThis.archiveRequests.filter(isPublication);
  if (publications.length !== 1)
    throw new Error(
      "A partial upload published or the retry duplicated publication.",
    );
  const repeatedUploads = globalThis.archiveRequests.filter(isArtifactUpload);
  const uploadedDigests = new Set(repeatedUploads.map(archiveRequestPath));
  if (uploadedDigests.size !== repeatedUploads.length)
    throw new Error("Retry uploaded an already retained artifact.");
  await page.reload();
  await openArchive(page, fixture, 1);
  await page
    .locator(".production-panel")
    .getByRole("button", { name: /^Shared production runs/u })
    .click();
  await page
    .getByRole("button", {
      name: "Open Native archive with interrupted upload",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  const recovery = await openRecovery(page);
  await recovery
    .getByText("Review recovery for tray-orders#0/transfer", { exact: true })
    .waitFor();
  await page.screenshot({
    path: "second-local-user-restored.png",
    fullPage: true,
  });
  return {
    result: "passed",
    environment: "local Chromium and Workerd with D1/R2",
    realUserHandoff: false,
    secondLocalPrincipal: true,
    incompletePublicationRefused: true,
    missingOnlyRetry: true,
    lostPublicationReadback: true,
    retainedWasmRestore: true,
    artifactUploads: uploadedDigests.size,
    requests: globalThis.archiveRequests,
  };
}

/** A blocked run shows a Review button, which opens the recovery controls. */
async function openRecovery(page) {
  await page.getByRole("button", { name: /· Review$/u }).click();
  const controls = page.getByRole("region", {
    name: "Physical recovery controls",
    exact: true,
  });
  await controls.waitFor();
  return controls;
}
function isPublication(request) {
  return request.method === "POST" && request.path.endsWith("/bakery/runs");
}
function isArtifactUpload(request) {
  return request.method === "POST" && request.path.includes("/artifacts/");
}
function archiveRequestPath(request) {
  return request.path;
}

async function forwardArchiveRequest(route) {
  const request = route.request();
  const url = new URL(request.url());
  globalThis.archiveRequests.push({
    method: request.method(),
    path: url.pathname,
  });
  const response = await route.fetch({
    url: `${ARCHIVE_ORIGIN}${url.pathname}${url.search}`,
  });
  const upload =
    request.method() === "POST" && url.pathname.includes("/artifacts/");
  const publication =
    request.method() === "POST" && url.pathname.endsWith("/bakery/runs");
  if (
    (globalThis.archiveFault === "upload" && upload) ||
    (globalThis.archiveFault === "publication" && publication)
  ) {
    if (!response.ok())
      throw new Error(
        `Injected fault reached a rejected write: ${await response.text()}`,
      );
    globalThis.archiveFault = "none";
    await route.abort("failed");
  } else await route.fulfill({ response });
}

/**
 * Signs in person `user` of the fixture, mounts the workspace simulator of
 * its Organisation and shows the production catalog.
 */
async function openArchive(page, fixture, user) {
  await installRecipeMutation(page, archiveMutation);
  await page.evaluate(signInToArchive, fixture.sessions[user]);
  await page.evaluate(mountWorkflowSimulator, {
    kind: "workspace",
    organisationId: fixture.organisationId,
    canManage: true,
  });
  await openMultiBatchProduction(page);
  await showProductionCatalog(page);
}

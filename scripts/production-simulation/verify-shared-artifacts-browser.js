async function verifySharedArtifactsBrowser(page) {
  const setup = await page.request.get("http://127.0.0.1:8840/fixture/setup");
  if (!setup.ok())
    throw new Error("Start the isolated archive acceptance runtime.");
  const fixture = await setup.json();
  globalThis.archiveFault = "upload";
  globalThis.archiveRequests = [];
  await page.route(
    "**/v1/control/organisations/**/bakery/runs**",
    forwardArchiveRequest,
  );
  await page.route("**/src/dev/workflow-preview.tsx", archiveStyles);
  await page.reload();
  await mountArchive(page, fixture, 0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  const source =
    "/@fs/Users/pta/Dev/lowerarchy/satyr/services/platform/tests/fixtures/bakery-persistent-failure.json";
  const file = await page.request.get(new URL(source, page.url()).href);
  await page
    .getByLabel("Open recipe, oven route or saved production run", {
      exact: true,
    })
    .setInputFiles({
      name: "failed-native-factory.json",
      mimeType: "application/json",
      buffer: await file.body(),
    });
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Physical recovery controls", exact: true })
    .waitFor();
  await page.getByText("Shared production runs", { exact: true }).click();
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
  await mountArchive(page, fixture, 1);
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await page.getByText("Shared production runs", { exact: true }).click();
  await page
    .getByRole("button", {
      name: "Open Native archive with interrupted upload",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Continue saved run", exact: true })
    .click();
  const recovery = page.getByRole("region", {
    name: "Physical recovery controls",
    exact: true,
  });
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
    url: `http://127.0.0.1:8840${url.pathname}${url.search}`,
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

async function archiveStyles(route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'import "/src/styles.css";',
  });
}
async function mountArchive(page, fixture, user) {
  await page.addScriptTag({
    content: `${archiveMutation.toString()}\nwindow.archiveMutation = archiveMutation;`,
  });
  await page.evaluate(mountArchiveWorkspace, {
    organisationId: fixture.organisationId,
    session: fixture.sessions[user],
  });
}
async function archiveMutation(path, body) {
  const { responseJson } = await import("/src/control-client.ts");
  return responseJson(
    await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-satyr-csrf": window.archiveCsrf,
      },
      body: JSON.stringify(body),
    }),
  );
}
async function mountArchiveWorkspace(fixture) {
  document.cookie = `satyr_control_session=${fixture.session.token}; Path=/; SameSite=Lax`;
  document.cookie = `satyr_control_csrf=${fixture.session.csrfToken}; Path=/; SameSite=Lax`;
  window.archiveCsrf = fixture.session.csrfToken;
  const { default: React } = await import("/@id/react");
  const { default: ReactDOM } = await import("/@id/react-dom/client");
  const { MemoryRouter } = await import("/@id/react-router");
  const { default: Route } =
    await import("/src/features/workflow-simulator/route.tsx");
  ReactDOM.createRoot(document.getElementById("root")).render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(Route, {
        connection: {
          kind: "workspace",
          organisationId: fixture.organisationId,
          canManage: true,
          mutate: window.archiveMutation,
        },
      }),
    ),
  );
}

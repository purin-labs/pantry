import {
  applyPreferenceEdit,
  defaultPreferenceDocument,
} from "@purin-labs/control-api";

/** Uses the existing browser fixture for session, membership, and workspace data. */
export async function runAccountSetupJourney(page, options) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${options.portalUrl}/portal?p21_auth=1`);
  await page
    .getByRole("heading", { name: "Organisations", exact: true })
    .waitFor();
  await page
    .locator('a.organisation-row-link[href="/portal/cafe-browser-lab"]')
    .waitFor();
  const session = await page.evaluate(readFixtureSession);
  assertEqual(typeof session.identity.userId, "string");
  assertCheck(session.memberships.length > 0);
  await page.evaluate(clearRememberedOrganisations);

  const fixture = new AccountSetupFixture(page, session);
  await page.route("**/v1/control/**", fixture.handle.bind(fixture));
  page.on("request", fixture.recordDocument.bind(fixture));
  const storageKey = `satyr:account-onboarding:${session.identity.userId}`;

  await page.goto(`${options.portalUrl}/portal?p21_auth=1`);
  await page.evaluate(setFixtureCsrf);
  await page.getByText("No organisations yet", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Set up Seams Pantry", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Set up Seams Pantry" });
  await dialog
    .getByRole("heading", { name: "Choose an organisation", exact: true })
    .waitFor();
  assertEqual(
    await dialog.getByRole("radio", { name: /Browser account/u }).isChecked(),
    true,
    "The first account organisation starts selected",
  );
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog
    .getByRole("heading", { name: "Choose a project", exact: true })
    .waitFor();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog
    .getByRole("heading", { name: "Confirm billing", exact: true })
    .waitFor();
  await dialog.getByText("Portal setup", { exact: true }).waitFor();
  await page.screenshot({ path: `${options.artifactDir}/setup-billing.png` });
  await dialog
    .getByRole("button", { name: "Start setup", exact: true })
    .click();
  await dialog
    .getByRole("heading", { name: "The setup stopped", exact: true })
    .waitFor();
  await dialog.getByText("Error code: authority_unavailable").waitFor();
  await dialog
    .getByRole("button", { name: "Try again", exact: true })
    .waitFor();
  await page.screenshot({ path: `${options.artifactDir}/setup-stopped.png` });
  const saved = await page.evaluate(readSavedSetup, storageKey);
  assertCheck(
    saved,
    "An uncertain accepted request remains available for recovery",
  );

  await page.reload();
  // The optional Jev step: one choice turns on the three switches. Without a
  // Gmail mailbox two of them stay off, the step says why, and setup goes on.
  await dialog.getByRole("heading", { name: JEV_STEP, exact: true }).waitFor();
  await dialog.getByText("TypeSafe runs it", { exact: false }).waitFor();
  assertEqual(
    await dialog
      .getByRole("link", { name: "Settings › Jev", exact: true })
      .getAttribute("href"),
    "/portal/cafe-browser-lab/main/jev",
  );
  await dialog
    .getByRole("button", { name: "Turn on Jev", exact: true })
    .click();
  await dialog
    .getByText("Some switches are not on.", { exact: false })
    .waitFor();
  assertEqual(
    await dialog
      .getByText("Not on. Connect a Gmail mailbox first.", { exact: true })
      .count(),
    2,
  );
  assertEqual(await dialog.getByText("On", { exact: true }).count(), 1);
  assertEqual(fixture.jevChanges.join(","), JEV_FEATURES.join(","));
  await page.screenshot({ path: `${options.artifactDir}/setup-jev.png` });
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog
    .getByRole("heading", { name: "Seams Pantry is ready", exact: true })
    .waitFor();
  await page.waitForFunction(setupRequestCleared, storageKey);
  const organisation = page.locator(
    'a.organisation-row-link[href="/portal/cafe-browser-lab"]',
  );
  await organisation.waitFor();
  assertEqual(fixture.acceptedSetups, 1);
  assertEqual(
    fixture.operationIds.size,
    1,
    "Recovery reuses the accepted operation",
  );
  assertEqual(
    fixture.documents,
    2,
    "Setup completion does not reload the document",
  );
  assertEqual(
    fixture.sessionReads,
    3,
    "A new membership reads the session again",
  );
  const created = fixture.snapshot();
  await page.screenshot({
    path: `${options.artifactDir}/setup-recovered.png`,
  });

  await page.evaluate(storeSavedSetup, {
    key: storageKey,
    request: fixture.request,
  });
  const beforeReplay = fixture.snapshot();
  await page.reload();
  await skipJevStep(dialog);
  await page.waitForFunction(setupRequestCleared, storageKey);
  await organisation.waitFor();
  assertEqual(fixture.documents - beforeReplay.documents, 1);
  assertEqual(fixture.sessionReads - beforeReplay.sessionReads, 1);
  assertEqual(fixture.organisationReads - beforeReplay.organisationReads, 1);
  assertEqual(fixture.acceptedSetups, 1);
  const replayed = fixture.snapshot();

  await dialog
    .getByRole("link", { name: "Open organisation", exact: true })
    .click();
  await page.waitForURL("**/portal/cafe-browser-lab/main");
  await page.getByRole("navigation", { name: "Workspace pages" }).waitFor();
  await page.screenshot({
    path: `${options.artifactDir}/setup-workspace.png`,
  });
  const unlisted = await verifyUnlistedOrganisation(
    page,
    fixture,
    storageKey,
    options,
  );
  const appearance = await verifySavedAppearance(page, fixture, options);
  const startup = await verifyOrganisationStartup(page, fixture, options);
  return {
    result: "passed",
    created,
    replayed,
    unlisted,
    appearance,
    startup,
    checks: [
      "Setup walks organisation, project and billing steps in one dialog",
      "A stopped setup shows its reason and the server error code",
      "Uncertain acceptance preserves the saved request",
      "Manual reload resumes the same operation",
      "Pending setup polls until ready",
      "New membership appears without a document reload",
      "Restored completed setup skips duplicate session and organisation reads",
      "Workspace navigation remains available",
      "A ready setup that the session does not list shows a failure, not an empty page",
      "Create a new project leaves the old setup and starts a new operation",
      "Check again finds the late membership and opens the new organisation",
      "Saved dark appearance applies before the Portal paints",
      "System appearance follows the browser color scheme on reload",
      "Session and remembered organisation reads overlap on return visits",
      "One loading layout preserves the organisation heading and navigation",
      "A revoked organisation never appears from an early read",
    ],
  };
}

/**
 * The production failure of 2026-10-19: setup reports ready, but the new
 * session does not list the organisation. The dialog must say so and keep
 * the setup until a later session read lists it.
 */
async function verifyUnlistedOrganisation(page, fixture, storageKey, options) {
  fixture.setupTarget = fixture.lateMembership;
  await page.goto(`${options.portalUrl}/portal?p21_auth=1`);
  await page.evaluate(setFixtureCsrf);
  await page
    .locator('a.organisation-row-link[href="/portal/cafe-browser-lab"]')
    .waitFor();
  await page
    .getByRole("button", { name: "Set up Seams Pantry", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Set up Seams Pantry" });
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Start setup", exact: true })
    .click();
  const unavailable = dialog.getByRole("heading", {
    name: "Your organisation is not available",
    exact: true,
  });
  await unavailable.waitFor();
  await dialog
    .getByText(`Organisation ID: ${fixture.lateMembership.organisationId}`)
    .waitFor();
  await page.screenshot({ path: `${options.artifactDir}/setup-unlisted.png` });
  assertEqual(fixture.request.selection.kind, "existing_project");
  const firstOperation = fixture.request.operationId;
  const kept = (await page.evaluate(readSavedSetup, storageKey)) !== null;
  assertCheck(
    kept,
    "An unlisted organisation keeps the setup for a later check",
  );

  // A project bound to a deleted organisation needs a new project.
  await dialog
    .getByRole("button", { name: "Create a new project", exact: true })
    .click();
  await dialog
    .getByRole("heading", { name: "Choose a project", exact: true })
    .waitFor();
  assertEqual(
    await dialog.getByRole("radio", { name: /Create a project/u }).isChecked(),
    true,
  );
  await page.waitForFunction(setupRequestCleared, storageKey);
  await dialog.getByLabel("Project name").fill("Second shop");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByText("Second shop", { exact: true }).waitFor();
  await dialog
    .getByRole("button", { name: "Start setup", exact: true })
    .click();
  await unavailable.waitFor();
  const selection = fixture.request.selection.kind;
  assertEqual(selection, "new_project");
  assertCheck(
    fixture.request.operationId !== firstOperation,
    "A new project starts a new setup operation",
  );

  fixture.lateListed = true;
  await dialog
    .getByRole("button", { name: "Check again", exact: true })
    .click();
  await skipJevStep(dialog);
  await page.waitForFunction(setupRequestCleared, storageKey);
  const open = dialog.getByRole("link", {
    name: "Open organisation",
    exact: true,
  });
  assertEqual(
    await open.getAttribute("href"),
    `/portal/${fixture.lateMembership.organisationHandle}`,
  );
  await page.screenshot({
    path: `${options.artifactDir}/setup-late-ready.png`,
  });
  await open.click();
  await page.waitForURL(
    `**/portal/${fixture.lateMembership.organisationHandle}/main`,
  );
  fixture.setupTarget = fixture.membership;
  fixture.lateListed = false;
  return {
    selection,
    kept,
    newOperation: true,
    opened: fixture.lateMembership.organisationHandle,
  };
}

const JEV_STEP =
  "Use Jev for mail sorting, related Cases and screen suggestions";
const JEV_FEATURES = [
  "mail_classification",
  "related_cases",
  "screen_relevance",
];

const JEV_VIEW = {
  funding: "satyr_platform",
  keyAvailable: true,
  mailClassification: { enabled: false, mailboxes: [] },
  relatedCases: { enabled: false, mode: null, sourceCount: 0 },
  screenRelevance: { enabled: true },
};

/** Skip leaves every Jev switch off and sends no change. */
async function skipJevStep(dialog) {
  await dialog.getByRole("heading", { name: JEV_STEP, exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Skip", exact: true }).click();
  await dialog
    .getByRole("heading", { name: "Seams Pantry is ready", exact: true })
    .waitFor();
}

function clearRememberedOrganisations() {
  for (const key of Object.keys(localStorage))
    if (key.startsWith("satyr:organisation-id:")) localStorage.removeItem(key);
}

async function verifyOrganisationStartup(page, fixture, options) {
  const startup = new OrganisationStartupFixture(fixture);
  await page.route("**/v1/control/**", startup.handle.bind(startup));
  await page.addInitScript(
    `${recordStartupView.toString()}\n(${installStartupObserver.toString()})();`,
  );
  await page.goto(`${options.portalUrl}/portal?p21_auth=1`);
  await page.getByRole("navigation", { name: "Global", exact: true }).waitFor();
  await page.screenshot({ path: `${options.artifactDir}/startup-loading.png` });
  await page
    .locator('a.organisation-row-link[href="/portal/cafe-browser-lab"]')
    .waitFor();
  await page.waitForFunction(hasSeenStartupOrganisation);
  const readyHeading = await page
    .getByRole("heading", { name: "Organisations", exact: true })
    .boundingBox();
  const allowed = {
    requests: startup.requests,
    views: await page.evaluate(readStartupViews),
    organisationSeen: await page.evaluate(hasSeenStartupOrganisation),
    readyHeading,
  };
  await page.screenshot({ path: `${options.artifactDir}/startup-ready.png` });

  const session = allowed.requests.find(isSessionRequest);
  const organisation = allowed.requests.find(isOrganisationRequest);
  assertCheck(session !== undefined && organisation !== undefined);
  assertCheck(
    organisation.startedAt < session.completedAt,
    `Organisation read must overlap the session: ${JSON.stringify(allowed)}`,
  );
  assertCheck(allowed.views.length > 0, "The observer must see a loading view");
  for (const view of allowed.views) {
    assertEqual(view.title, "Organisations");
    assertEqual(view.navigation, true);
    assertEqual(view.left, allowed.views[0].left);
    assertEqual(view.top, allowed.views[0].top);
  }
  assertCheck(readyHeading !== null);
  assertEqual(Math.round(readyHeading.x), allowed.views[0].left);
  assertEqual(Math.round(readyHeading.y), allowed.views[0].top);

  startup.revoked = true;
  startup.requests = [];
  const denied = page.waitForResponse(isDeniedOrganisationResponse);
  await page.reload();
  await page.getByText("No organisations yet", { exact: true }).waitFor();
  await denied;
  assertEqual(await page.locator(".organisation-card").count(), 0);
  const revoked = {
    requests: startup.requests,
    views: await page.evaluate(readStartupViews),
    organisationSeen: await page.evaluate(hasSeenStartupOrganisation),
  };
  assertEqual(revoked.organisationSeen, false);
  await page.screenshot({ path: `${options.artifactDir}/startup-revoked.png` });
  startup.revoked = false;
  startup.availability = "incomplete";
  await page.reload();
  await page
    .getByText("Some organisations are unavailable.", { exact: false })
    .waitFor();
  await page
    .locator('a.organisation-row-link[href="/portal/cafe-browser-lab"]')
    .waitFor();
  await page.screenshot({
    path: `${options.artifactDir}/organisations-partial.png`,
  });
  startup.revoked = true;
  await page.reload();
  await page
    .getByText("Your organisations are temporarily unavailable.", {
      exact: false,
    })
    .waitFor();
  assertEqual(
    await page.getByText("No organisations yet", { exact: true }).count(),
    0,
  );
  await page.screenshot({
    path: `${options.artifactDir}/organisations-unavailable.png`,
  });
  startup.revoked = false;
  startup.availability = "complete";
  await page
    .getByRole("button", { name: "Refresh organisations", exact: true })
    .click();
  await page
    .locator('a.organisation-row-link[href="/portal/cafe-browser-lab"]')
    .waitFor();
  assertEqual(
    await page
      .getByText("Some organisations are unavailable.", { exact: false })
      .count(),
    0,
  );
  await page.goto(
    `${options.portalUrl}/portal?accountInvitationOrganisation=organisation_browser&accountInvitationId=invitation_browser&accountInvitationLink=failed#accountInvitationToken=isolated-browser-invitation`,
  );
  await page
    .getByRole("heading", { name: "Seams Pantry invitation", exact: true })
    .waitFor();
  await page
    .getByRole("link", { name: "Sign in to retry", exact: true })
    .waitFor();
  assertEqual(
    await page
      .getByRole("button", { name: "Accept invitation", exact: true })
      .count(),
    0,
  );
  await page.screenshot({
    path: `${options.artifactDir}/invitation-link-failed.png`,
  });
  return {
    allowed,
    revoked,
    partialOutage: "verified list stays usable",
    totalOutage: "explicit unavailable view",
    recovery: "fresh session read",
    invitationFailure: "scoped sign-in retry",
  };
}

class OrganisationStartupFixture {
  constructor(fixture) {
    this.fixture = fixture;
    this.requests = [];
    this.revoked = false;
    this.availability = "complete";
  }

  async handle(route) {
    const path = new URL(route.request().url()).pathname;
    const session = path === "/v1/control/session";
    const organisation =
      path ===
      `/v1/control/organisations/${this.fixture.membership.organisationId}`;
    if (!session && !organisation) return route.fallback();
    const observed = { path, startedAt: Date.now(), completedAt: null };
    this.requests.push(observed);
    await new Promise(deferResponse.bind(null, session ? 900 : 1200));
    observed.completedAt = Date.now();
    if (session)
      return json(
        route,
        sessionWithMemberships(
          this.fixture.session,
          this.revoked ? [] : [this.fixture.membership],
          this.availability,
        ),
      );
    if (this.revoked)
      return json(route, { ok: false, error: "scope_forbidden" }, 403);
    return route.fallback();
  }
}

function deferResponse(milliseconds, resolve) {
  setTimeout(resolve, milliseconds);
}

function isSessionRequest(request) {
  return request.path === "/v1/control/session";
}

function isOrganisationRequest(request) {
  return request.path.startsWith("/v1/control/organisations/");
}

function isDeniedOrganisationResponse(response) {
  return (
    new URL(response.url()).pathname.startsWith("/v1/control/organisations/") &&
    response.status() === 403
  );
}

function installStartupObserver() {
  window.portalStartupViews = [];
  window.portalStartupOrganisationSeen = false;
  requestAnimationFrame(recordStartupView);
}

function recordStartupView() {
  if (document.querySelector(".organisation-card") !== null)
    window.portalStartupOrganisationSeen = true;
  const skeleton = document.querySelector(".route-page-skeleton");
  const title = document.querySelector("h1");
  if (skeleton !== null || title?.textContent === "Loading workspace") {
    const bounds = title?.getBoundingClientRect();
    const view = {
      title: title?.textContent ?? null,
      navigation: document.querySelector('nav[aria-label="Global"]') !== null,
      left: bounds === undefined ? null : Math.round(bounds.left),
      top: bounds === undefined ? null : Math.round(bounds.top),
    };
    if (
      JSON.stringify(window.portalStartupViews.at(-1)) !== JSON.stringify(view)
    )
      window.portalStartupViews.push(view);
  }
  requestAnimationFrame(recordStartupView);
}

function readStartupViews() {
  return window.portalStartupViews;
}

function hasSeenStartupOrganisation() {
  return window.portalStartupOrganisationSeen;
}

class AccountSetupFixture {
  phase = "empty";
  request = null;
  acceptedSetups = 0;
  documents = 0;
  sessionReads = 0;
  organisationReads = 0;
  operationIds = new Set();
  jevChanges = [];

  constructor(page, session) {
    this.page = page;
    this.session = session;
    this.membership = session.memberships[0];
    this.lateMembership = session.memberships[1];
    this.setupTarget = this.membership;
    this.lateListed = false;
    this.appearance = defaultPreferenceDocument(
      session.identity.userId,
      "appearance",
      0,
    );
  }

  recordDocument(request) {
    if (
      request.resourceType() === "document" &&
      request.frame() === this.page.mainFrame()
    ) {
      this.documents += 1;
    }
  }

  snapshot() {
    return {
      documents: this.documents,
      sessionReads: this.sessionReads,
      organisationReads: this.organisationReads,
      acceptedSetups: this.acceptedSetups,
      operationCount: this.operationIds.size,
    };
  }

  async handle(route) {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/control/user/preferences/appearance") {
      return json(route, this.appearance);
    }
    if (path === "/v1/control/session") {
      this.sessionReads += 1;
      const listed = this.phase === "ready" ? [this.membership] : [];
      if (this.lateListed) listed.push(this.lateMembership);
      return json(route, sessionWithMemberships(this.session, listed));
    }
    if (
      path === `/v1/control/organisations/${this.membership.organisationId}`
    ) {
      this.organisationReads += 1;
    }
    if (path.endsWith("/jev-features") && request.method() === "POST") {
      // A new organisation has no Gmail mailbox, as the Platform answers.
      const { feature } = request.postDataJSON();
      this.jevChanges.push(feature);
      if (feature !== "screen_relevance")
        return json(
          route,
          { ok: false, error: "jev_feature_source_unavailable" },
          409,
        );
      return json(route, { ok: true, value: JEV_VIEW });
    }
    if (path !== "/v1/control/account-onboarding") return route.fallback();
    if (request.method() === "GET") {
      return json(route, {
        ok: true,
        value: {
          organizations: [
            {
              id: "org_browser_account",
              name: "Browser account",
              projects: [{ id: "proj_browser_setup", name: "Portal setup" }],
            },
          ],
        },
      });
    }
    assertEqual(request.method(), "POST");
    const body = request.postDataJSON();
    assertEqual(body.version, 1);
    assertCheck(
      ["existing_project", "new_project"].includes(body.selection.kind),
      `Unexpected setup selection ${body.selection.kind}`,
    );
    this.operationIds.add(body.operationId);
    this.request = body;
    switch (this.phase) {
      case "empty":
        this.phase = "accepted";
        this.acceptedSetups += 1;
        return json(route, { ok: false, error: "authority_unavailable" }, 503);
      case "accepted":
        this.phase = "pending";
        return json(route, {
          ok: true,
          value: {
            kind: "pending",
            operationId: body.operationId,
            instanceId: "instance_satyr_browser",
          },
        });
      case "pending":
        this.phase = "ready";
        return this.ready(route);
      case "ready":
        return this.ready(route);
      default:
        throw new Error("Unknown browser setup fixture phase");
    }
  }

  ready(route) {
    return json(route, {
      ok: true,
      value: {
        kind: "ready",
        nativeOrganizationId: this.setupTarget.organisationId,
      },
    });
  }
}

async function verifySavedAppearance(page, fixture, options) {
  fixture.appearance = applyPreferenceEdit(fixture.appearance, {
    area: "appearance",
    command: {
      kind: "set_appearance",
      value: { mode: "dark", palette: "sage" },
    },
  });
  await page.emulateMedia({ colorScheme: "light" });
  const initialize = `${recordAppearance.toString()}\n${seedSavedAppearance.toString()}\nseedSavedAppearance(${JSON.stringify(fixture.appearance)});`;
  await page.addInitScript(initialize);
  await page.goto(`${options.portalUrl}/portal?p21_auth=1`);
  await page
    .locator('a.organisation-row-link[href="/portal/cafe-browser-lab"]')
    .waitFor();
  const savedDark = await page.evaluate(readAppearance);
  assertEqual(savedDark.theme, "dark");
  assertEqual(savedDark.firstPaint.colorScheme, "dark");
  assertEqual(
    savedDark.frames.at(0),
    "dark",
    "Saved appearance applies on the first visible frame",
  );
  assertEqual(
    savedDark.frames.includes("light"),
    false,
    "A saved dark appearance never paints light",
  );
  assertCheck(savedDark.frames.includes("dark"));
  await page.screenshot({
    path: `${options.artifactDir}/setup-dark-first-paint.png`,
  });

  fixture.appearance = defaultPreferenceDocument(
    fixture.session.identity.userId,
    "appearance",
    0,
  );
  await page.evaluate(storeAppearance, fixture.appearance);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await page
    .locator('a.organisation-row-link[href="/portal/cafe-browser-lab"]')
    .waitFor();
  const systemDark = await page.evaluate(readAppearance);
  assertEqual(systemDark.theme, "dark");
  assertEqual(systemDark.frames.includes("light"), false);
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(hasLightAppearance);
  const systemLight = await page.evaluate(readAppearance);
  return { savedDark, systemDark, systemLight };
}

function seedSavedAppearance(preferences) {
  if (sessionStorage.getItem("browser-appearance-seeded") !== "1") {
    localStorage.removeItem("satyr:portal-appearance");
    localStorage.setItem(
      `satyr:preferences:${preferences.userId}:appearance`,
      JSON.stringify(preferences),
    );
    sessionStorage.setItem("browser-appearance-seeded", "1");
  }
  window.portalAppearanceFrames = [];
  window.portalFirstAppearancePaint = null;
  requestAnimationFrame(recordAppearance);
}

function recordAppearance() {
  const theme = document.documentElement?.dataset.portalTheme ?? "unset";
  if (window.portalFirstAppearancePaint === null) {
    window.portalFirstAppearancePaint = {
      theme,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
    };
  }
  if (window.portalAppearanceFrames.at(-1) !== theme)
    window.portalAppearanceFrames.push(theme);
  requestAnimationFrame(recordAppearance);
}

function hasLightAppearance() {
  return document.documentElement.dataset.portalTheme === "light";
}

function storeAppearance(preferences) {
  localStorage.setItem("satyr:portal-appearance", preferences.values.mode);
  localStorage.setItem(
    `satyr:preferences:${preferences.userId}:appearance`,
    JSON.stringify(preferences),
  );
}

function readAppearance() {
  return {
    theme: document.documentElement.dataset.portalTheme,
    mode: document.documentElement.dataset.portalMode,
    frames: window.portalAppearanceFrames,
    firstPaint: window.portalFirstAppearancePaint,
  };
}

function sessionWithMemberships(
  session,
  memberships,
  availability = "complete",
) {
  const result = structuredClone(session);
  result.memberships = memberships;
  result.membershipAvailability = availability;
  return result;
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function readFixtureSession() {
  const response = await fetch("/v1/control/session");
  return response.json();
}

function setFixtureCsrf() {
  document.cookie =
    "satyr_control_csrf=browser_setup_fixture; path=/; SameSite=Lax";
}

function readSavedSetup(key) {
  return sessionStorage.getItem(key);
}

function setupRequestCleared(key) {
  return sessionStorage.getItem(key) === null;
}

function storeSavedSetup(value) {
  sessionStorage.setItem(value.key, JSON.stringify(value.request));
}

function assertEqual(
  actual,
  expected,
  message = "Unexpected browser journey result",
) {
  if (actual !== expected)
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
}

function assertCheck(
  condition,
  message = "Browser journey requirement failed",
) {
  if (!condition) throw new Error(message);
}

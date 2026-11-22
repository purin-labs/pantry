import {
  applyPreferenceEdit,
  defaultPreferenceDocument,
} from "@purin-labs/control-api";

const SETUP_NAME = "Cafe browser lab";

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
  assertCheck(session.memberships.length > 1);
  await page.evaluate(clearRememberedOrganisations);

  const fixture = new AccountSetupFixture(page, session);
  await page.route("**/v1/control/**", fixture.handle.bind(fixture));
  page.on("request", fixture.recordDocument.bind(fixture));
  const storageKey = `pantry:account-onboarding:${session.identity.userId}`;

  await page.goto(`${options.portalUrl}/portal?p21_auth=1`);
  await page.evaluate(setFixtureCsrf);
  await page.getByText("No organisations yet", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Set up Purin Pantry", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Set up Purin Pantry" });
  await dialog
    .getByRole("heading", { name: "Name your organisation", exact: true })
    .waitFor();
  await dialog.getByText("Step 1 of 4", { exact: true }).waitFor();
  await dialog
    .getByRole("button", { name: "Create organisation", exact: true })
    .click();
  await dialog
    .getByText("Enter a name for the organisation.", { exact: true })
    .waitFor();
  assertEqual(fixture.posts, 0, "An empty name sends no request");
  await dialog.getByLabel("Organisation name").fill(SETUP_NAME);
  await page.screenshot({ path: `${options.artifactDir}/setup-name.png` });
  const beforeCreate = fixture.snapshot();

  // Pantry makes the organisation, but its answer is lost on the way back.
  fixture.loseNextAnswer = true;
  await dialog
    .getByRole("button", { name: "Create organisation", exact: true })
    .click();
  await dialog
    .getByRole("heading", { name: "The setup stopped", exact: true })
    .waitFor();
  await dialog.getByText("Error code: authority_unavailable").waitFor();
  await page.screenshot({ path: `${options.artifactDir}/setup-stopped.png` });
  const saved = JSON.parse(await page.evaluate(readSavedSetup, storageKey));
  assertEqual(saved.name, SETUP_NAME, "The tab keeps the setup with its name");
  assertEqual(saved.operationId, fixture.request.operationId);

  // Try again sends the same operation id, and Pantry answers the same
  // organisation. The optional Jev step: one choice turns on the three
  // switches. Without a Gmail mailbox two of them stay off, the step says
  // why, and the setup goes on.
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
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
  await waitForDone(dialog, SETUP_NAME);
  await page.waitForFunction(setupRequestCleared, storageKey);
  const organisation = page.locator(
    'a.organisation-row-link[href="/portal/cafe-browser-lab"]',
  );
  await organisation.waitFor();
  const created = fixture.snapshot();
  assertEqual(created.made, 1, "One setup makes one organisation");
  assertEqual(created.posts - beforeCreate.posts, 2);
  assertEqual(created.operationCount, 1, "Try again reuses the operation");
  assertEqual(
    created.documents,
    beforeCreate.documents,
    "Setup completion does not reload the document",
  );
  assertCheck(
    created.sessionReads > beforeCreate.sessionReads,
    "A new membership reads the session again",
  );
  await page.screenshot({ path: `${options.artifactDir}/setup-done.png` });

  // A repeat with the same stored operation id: a reload continues it, and
  // Pantry answers the same organisation.
  await page.evaluate(storeSavedSetup, { key: storageKey, request: saved });
  await page.reload();
  await skipJevStep(dialog, SETUP_NAME);
  await page.waitForFunction(setupRequestCleared, storageKey);
  await organisation.waitFor();
  const open = dialog.getByRole("link", {
    name: "Open organisation",
    exact: true,
  });
  assertEqual(await open.getAttribute("href"), "/portal/cafe-browser-lab");
  const replayed = fixture.snapshot();
  assertEqual(replayed.made, 1, "A repeat makes no second organisation");
  assertEqual(replayed.posts - created.posts, 1);
  assertEqual(replayed.operationCount, 1);
  assertEqual(replayed.documents - created.documents, 1);
  assertEqual(replayed.sessionReads - created.sessionReads, 1);
  assertEqual(replayed.organisationReads - created.organisationReads, 1);
  await page.screenshot({ path: `${options.artifactDir}/setup-repeat.png` });

  await open.click();
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
  const refusals = await verifyCreateRefusals(
    page,
    fixture,
    storageKey,
    options,
  );
  const appearance = await verifySavedAppearance(page, fixture, options);
  const startup = await verifyOrganisationStartup(page, fixture, options);
  const invitation = await verifyInvitationPage(page, options);
  return {
    result: "passed",
    organisation: {
      name: SETUP_NAME,
      operationId: saved.operationId,
      handle: "cafe-browser-lab",
    },
    created,
    replayed,
    unlisted,
    refusals,
    appearance,
    startup,
    invitation,
    checks: [
      "Setup names the organisation in one step, then prepares it",
      "An empty name sends no request",
      "A lost answer shows the reason and the server error code",
      "The tab keeps the operation id and the name of the setup",
      "Try again sends the same operation id and makes no second organisation",
      "New membership appears without a document reload",
      "A reload with the stored operation id answers the same organisation",
      "Restored completed setup skips duplicate session and organisation reads",
      "Workspace navigation remains available",
      "An organisation that the session does not list shows a failure, not an empty page",
      "Check again finds the late membership and opens the new organisation",
      "The organisation limit and an unverified email show their messages and end the setup",
      "Saved dark appearance applies before the Portal paints",
      "System appearance follows the browser color scheme on reload",
      "Session and remembered organisation reads overlap on return visits",
      "One loading layout preserves the organisation heading and navigation",
      "A revoked organisation never appears from an early read",
      "The invitation page shows Accept, then the message of each refusal",
      "An accepted invitation clears the link and confirms the role",
    ],
  };
}

async function waitForDone(dialog, name) {
  await dialog
    .getByRole("heading", { name: "Purin Pantry is ready", exact: true })
    .waitFor();
  await dialog
    .getByText(`${name} is in your organisation list.`, { exact: false })
    .waitFor();
}

/**
 * The production failure of 2026-10-19: Pantry made the organisation, but the
 * new session does not list it. The dialog must say so and keep the setup
 * until a later session read lists it.
 */
async function verifyUnlistedOrganisation(page, fixture, storageKey, options) {
  fixture.nextTarget = fixture.lateMembership;
  await page.goto(`${options.portalUrl}/portal?p21_auth=1`);
  await page.evaluate(setFixtureCsrf);
  await page
    .locator('a.organisation-row-link[href="/portal/cafe-browser-lab"]')
    .waitFor();
  await page
    .getByRole("button", { name: "Set up Purin Pantry", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Set up Purin Pantry" });
  await dialog.getByLabel("Organisation name").fill("Riverside cafe");
  await dialog
    .getByRole("button", { name: "Create organisation", exact: true })
    .click();
  await dialog
    .getByRole("heading", {
      name: "Your organisation is not in your list",
      exact: true,
    })
    .waitFor();
  await dialog
    .getByText(`Organisation ID: ${fixture.lateMembership.organisationId}`)
    .waitFor();
  await page.screenshot({ path: `${options.artifactDir}/setup-unlisted.png` });
  const kept = (await page.evaluate(readSavedSetup, storageKey)) !== null;
  assertCheck(
    kept,
    "An unlisted organisation keeps the setup for a later check",
  );

  fixture.lateListed = true;
  await dialog
    .getByRole("button", { name: "Check again", exact: true })
    .click();
  await skipJevStep(dialog, "Riverside cafe");
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
  fixture.nextTarget = fixture.membership;
  fixture.lateListed = false;
  return {
    kept,
    made: fixture.made,
    opened: fixture.lateMembership.organisationHandle,
  };
}

const CREATE_REFUSALS = [
  {
    error: "organisation_limit_reached",
    status: 409,
    title: "You cannot own more organisations",
    message:
      "You own 5 organisations. A person can own at most 5. Delete one of your organisations, then try again.",
    action: { role: "button", name: "Close" },
  },
  {
    error: "organisation_owner_unverified",
    status: 403,
    title: "Pantry needs a verified email",
    message:
      "Your Google account has no verified email. Sign in with a Google account that has a verified email.",
    action: { role: "link", name: "Sign in with another account" },
  },
];

/** A refusal that no retry can change shows its message and ends the setup. */
async function verifyCreateRefusals(page, fixture, storageKey, options) {
  await page.goto(`${options.portalUrl}/portal?p21_auth=1`);
  await page.evaluate(setFixtureCsrf);
  await page
    .locator('a.organisation-row-link[href="/portal/cafe-browser-lab"]')
    .waitFor();
  const dialog = page.getByRole("dialog", { name: "Set up Purin Pantry" });
  const footer = dialog.locator(".agent-modal-footer");
  const made = fixture.made;
  const outcomes = [];
  for (const refusal of CREATE_REFUSALS) {
    fixture.refusal = refusal;
    await page
      .getByRole("button", { name: "Set up Purin Pantry", exact: true })
      .click();
    await dialog.getByLabel("Organisation name").fill("Sixth shop");
    await dialog
      .getByRole("button", { name: "Create organisation", exact: true })
      .click();
    await dialog
      .getByRole("heading", { name: refusal.title, exact: true })
      .waitFor();
    await dialog.getByText(refusal.message, { exact: true }).waitFor();
    await dialog.getByText(`Error code: ${refusal.error}`).waitFor();
    await footer
      .getByRole(refusal.action.role, {
        name: refusal.action.name,
        exact: true,
      })
      .waitFor();
    await page.screenshot({
      path: `${options.artifactDir}/setup-${refusal.error}.png`,
    });
    assertEqual(
      await page.evaluate(readSavedSetup, storageKey),
      null,
      "A refusal that no retry changes ends the setup",
    );
    outcomes.push({
      error: refusal.error,
      title: refusal.title,
      message: refusal.message,
      action: refusal.action.name,
    });
    await footer.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  }
  fixture.refusal = null;
  assertEqual(fixture.made, made, "A refused setup makes no organisation");
  return outcomes;
}

const INVITATION_LINK =
  "/portal?p21_auth=1&accountInvitationOrganisation=organisation_browser&accountInvitationId=invitation_browser#accountInvitationToken=isolated-browser-invitation";

const INVITATION_REFUSALS = [
  {
    error: "authority_unavailable",
    status: 503,
    message: "Pantry could not complete this request. Try again.",
    retry: true,
    signIn: null,
  },
  {
    error: "organisation_invitation_not_found",
    status: 404,
    message:
      "Pantry cannot find this invitation. Ask the sender for a new link.",
    retry: false,
    signIn: null,
  },
  {
    error: "organisation_invitation_email_mismatch",
    status: 403,
    message:
      "This invitation is for a different email. Sign in with the Google account that received the invitation.",
    retry: false,
    signIn: "Sign in with another account",
  },
  {
    error: "organisation_invitation_closed",
    status: 409,
    message:
      "This invitation is closed. The sender revoked or replaced it, or another person accepted it. Ask the sender for a new link.",
    retry: false,
    signIn: null,
  },
  {
    error: "organisation_invitation_expired",
    status: 409,
    message: "This invitation expired. Ask the sender for a new link.",
    retry: false,
    signIn: null,
  },
];

/**
 * The invitation link opens the invitation page. Accept sends the token of
 * the link. Each refusal shows its message; only a refusal that a second
 * press can change keeps the Accept button.
 */
async function verifyInvitationPage(page, options) {
  const invitation = { answer: null, accepts: [] };
  await page.route(
    "**/v1/control/organisations/*/invitations/*/accept",
    answerInvitation.bind(null, invitation),
  );
  const heading = page.getByRole("heading", {
    name: "Purin Pantry invitation",
    exact: true,
  });
  const accept = page.getByRole("button", {
    name: "Accept invitation",
    exact: true,
  });
  const refusals = [];
  for (const refusal of INVITATION_REFUSALS) {
    invitation.answer = refusal;
    await openInvitationLink(page, options);
    await heading.waitFor();
    await accept.click();
    await page
      .getByRole("alert")
      .filter({ hasText: refusal.message })
      .waitFor();
    assertEqual(
      await accept.count(),
      refusal.retry ? 1 : 0,
      `Accept stays only for a refusal that a retry can change: ${refusal.error}`,
    );
    let signIn = null;
    if (refusal.signIn !== null) {
      signIn = await page
        .getByRole("link", { name: refusal.signIn, exact: true })
        .getAttribute("href");
      assertCheck(
        signIn.startsWith("/v1/control/auth/google/start?") &&
          new URL(signIn, options.portalUrl).searchParams
            .get("returnTo")
            .includes("accountInvitationId=invitation_browser"),
        "The sign-in link comes back to the invitation",
      );
    }
    await page.screenshot({
      path: `${options.artifactDir}/invitation-${refusal.error}.png`,
    });
    refusals.push({ error: refusal.error, message: refusal.message, signIn });
  }
  invitation.answer = {
    status: 200,
    body: {
      ok: true,
      member: { userId: "user_invited", role: "operator" },
    },
  };
  await openInvitationLink(page, options);
  await heading.waitFor();
  await accept.click();
  await page
    .getByText("Invitation accepted. Your Pantry role is ready.", {
      exact: true,
    })
    .waitFor();
  assertEqual(new URL(page.url()).pathname, "/portal");
  assertEqual(new URL(page.url()).hash, "", "The link leaves the address bar");
  await page.screenshot({
    path: `${options.artifactDir}/invitation-accepted.png`,
  });
  assertEqual(invitation.accepts.length, INVITATION_REFUSALS.length + 1);
  for (const body of invitation.accepts)
    assertEqual(body.token, "isolated-browser-invitation");
  return { refusals, accepted: true, accepts: invitation.accepts.length };
}

/** A new document each time: the same link with its fragment would not load. */
async function openInvitationLink(page, options) {
  await page.goto("about:blank");
  await page.goto(`${options.portalUrl}${INVITATION_LINK}`);
}

function answerInvitation(invitation, route) {
  if (route.request().method() !== "POST") return route.fallback();
  invitation.accepts.push(route.request().postDataJSON());
  const answer = invitation.answer;
  return json(
    route,
    answer.body ?? { ok: false, error: answer.error },
    answer.status,
  );
}

const JEV_STEP =
  "Use Jev for mail sorting, related Cases and screen suggestions";
const JEV_FEATURES = [
  "mail_classification",
  "related_cases",
  "screen_relevance",
];

const JEV_VIEW = {
  funding: "pantry_platform",
  keyAvailable: true,
  mailClassification: { enabled: false, mailboxes: [] },
  relatedCases: { enabled: false, mode: null, sourceCount: 0 },
  screenRelevance: { enabled: true },
  allowance: null,
  paidUse: {
    enabled: false,
    spendingLimitMinor: 0,
    spentMinor: 0,
    priced: false,
  },
};

/** Skip leaves every Jev switch off and sends no change. */
async function skipJevStep(dialog, name) {
  await dialog.getByRole("heading", { name: JEV_STEP, exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Skip", exact: true }).click();
  await waitForDone(dialog, name);
}

function clearRememberedOrganisations() {
  for (const key of Object.keys(localStorage))
    if (key.startsWith("pantry:organisation-id:")) localStorage.removeItem(key);
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
  return {
    allowed,
    revoked,
    partialOutage: "verified list stays usable",
    totalOutage: "explicit unavailable view",
    recovery: "fresh session read",
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

/**
 * Pantry's create route as the browser sees it: it records each request and
 * answers it. A repeat of an operation id answers the organisation that the
 * first request made, and the session lists an organisation once it exists.
 */
class AccountSetupFixture {
  posts = 0;
  made = 0;
  request = null;
  documents = 0;
  sessionReads = 0;
  organisationReads = 0;
  operationIds = new Set();
  jevChanges = [];
  /** The next answer is lost after Pantry made the organisation. */
  loseNextAnswer = false;
  /** A refusal for each request, or null. */
  refusal = null;

  constructor(page, session) {
    this.page = page;
    this.session = session;
    this.membership = session.memberships[0];
    this.lateMembership = session.memberships[1];
    this.nextTarget = this.membership;
    this.lateListed = false;
    /** operation id -> the name and the organisation that it made */
    this.created = new Map();
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
      posts: this.posts,
      made: this.made,
      operationCount: this.operationIds.size,
    };
  }

  madeOrganisation(organisationId) {
    for (const entry of this.created.values())
      if (entry.target.organisationId === organisationId) return true;
    return false;
  }

  async handle(route) {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/control/user/preferences/appearance") {
      return json(route, this.appearance);
    }
    if (path === "/v1/control/session") {
      this.sessionReads += 1;
      const listed = this.madeOrganisation(this.membership.organisationId)
        ? [this.membership]
        : [];
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
    if (path !== "/v1/control/organisations" || request.method() !== "POST")
      return route.fallback();
    return this.create(route, request.postDataJSON());
  }

  create(route, body) {
    this.posts += 1;
    assertEqual(
      Object.keys(body).sort().join(","),
      "name,operationId",
      "The dialog sends only the operation id and the name",
    );
    assertCheck(/^[A-Za-z0-9_-]{8,128}$/u.test(body.operationId));
    this.request = body;
    this.operationIds.add(body.operationId);
    if (this.refusal !== null)
      return json(
        route,
        { ok: false, error: this.refusal.error },
        this.refusal.status,
      );
    const earlier = this.created.get(body.operationId);
    if (earlier !== undefined && earlier.name !== body.name)
      return json(route, { ok: false, error: "idempotency_key_conflict" }, 409);
    const target = earlier?.target ?? this.nextTarget;
    if (earlier === undefined) {
      this.created.set(body.operationId, { name: body.name, target });
      this.made += 1;
    }
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false;
      return json(route, { ok: false, error: "authority_unavailable" }, 503);
    }
    return json(route, {
      ok: true,
      organisation: {
        organisationId: target.organisationId,
        organisationHandle: target.organisationHandle,
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
    localStorage.removeItem("pantry:portal-appearance");
    localStorage.setItem(
      `pantry:preferences:${preferences.userId}:appearance`,
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
  localStorage.setItem("pantry:portal-appearance", preferences.values.mode);
  localStorage.setItem(
    `pantry:preferences:${preferences.userId}:appearance`,
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
    "pantry_csrf=browser_setup_fixture; path=/; SameSite=Lax";
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

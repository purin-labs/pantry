import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { OrganisationCreationRequest } from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import "../styles.css";
import { PortalFrame } from "../shell";
import {
  OrganisationsRoute,
  type OrganisationActions,
  type OrganisationListItem,
} from "@purin-labs/area-organisation/ui/pages/workspaces";
import {
  AccountSetupDialog,
  type AccountSetupActions,
  type AccountSetupListing,
  type OpenAccountSetupView,
} from "@purin-labs/area-organisation/ui/pages/account-onboarding";
import {
  AccountInvitationPage,
  readAccountInvitationRoute,
} from "@purin-labs/area-organisation/ui/pages/account-invitation";

const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV) {
  throw new Error("Organisations preview is development-only.");
}

const NUKI: OrganisationListItem = {
  organisationId: "organisation_preview_nuki",
  organisationHandle: "nuki-inc",
  name: "Nuki Inc.",
  role: "owner",
  plan: "beta",
  lifecycle: "active",
  configurationVersion: 7,
  workspaces: [
    {
      workspaceId: "workspace_preview_cafe",
      workspaceHandle: "cafe-operations",
      name: "Cafe operations",
      createdAt: 1791473900000,
    },
  ],
};

const NINI: OrganisationListItem = {
  organisationId: "organisation_preview_nini",
  organisationHandle: "nini-corp",
  name: "Nini Corp",
  role: "owner",
  plan: "beta",
  lifecycle: "active",
  configurationVersion: 1,
  workspaces: [
    {
      workspaceId: "workspace_preview_nini",
      workspaceHandle: "main",
      name: "Main",
      createdAt: 1791473900000,
    },
  ],
};

const SCENARIOS: Record<string, readonly OrganisationListItem[]> = {
  single: [NUKI],
  empty: [],
  many: [
    NUKI,
    {
      organisationId: "organisation_preview_noix",
      organisationHandle: "noix-de-beurre",
      name: "Noix de Beurre",
      role: "admin",
      plan: "beta",
      lifecycle: "configuring",
      configurationVersion: 3,
      workspaces: [
        {
          workspaceId: "workspace_preview_atelier",
          workspaceHandle: "atelier",
          name: "Atelier",
          createdAt: 1791473900000,
        },
        {
          workspaceId: "workspace_preview_boutique",
          workspaceHandle: "boutique",
          name: "Boutique Saint-Honoré",
          createdAt: 1791473950000,
        },
      ],
    },
    {
      organisationId: "organisation_preview_lab",
      organisationHandle: "financier-factory",
      name: "Financier Factory",
      role: "viewer",
      plan: "beta",
      lifecycle: "active",
      configurationVersion: 12,
      workspaces: [],
    },
    {
      organisationId: "organisation_preview_old",
      organisationHandle: "nuki-inc-old",
      name: "Nuki Inc. (old)",
      role: "owner",
      plan: "beta",
      lifecycle: "archived",
      configurationVersion: 111,
      workspaces: [
        {
          workspaceId: "workspace_preview_old",
          workspaceHandle: "cafe-operations",
          name: "Cafe operations",
          createdAt: 1788969067137,
        },
      ],
    },
  ],
};

const REQUEST: OrganisationCreationRequest = {
  operationId: "operation_preview",
  name: NINI.name,
};

/** Every state of the setup dialog, by the name used in `?setup=`. */
const SETUP_VIEWS: Record<string, OpenAccountSetupView> = {
  organisation: { kind: "organisation", name: "", problem: null },
  "organisation-named": {
    kind: "organisation",
    name: "Nini Pâtisserie",
    problem: null,
  },
  "organisation-problem": {
    kind: "organisation",
    name: "",
    problem: "Enter a name for the organisation.",
  },
  preparing: { kind: "preparing", request: REQUEST },
  finishing: {
    kind: "finishing",
    organisationId: NINI.organisationId,
    request: REQUEST,
  },
  jev: {
    kind: "jev",
    organisationId: NINI.organisationId,
    organisationHandle: NINI.organisationHandle,
    workspaceHandle: null,
    name: NINI.name,
    jev: { kind: "choose" },
  },
  "jev-result": {
    kind: "jev",
    organisationId: NINI.organisationId,
    organisationHandle: NINI.organisationHandle,
    workspaceHandle: null,
    name: NINI.name,
    jev: {
      kind: "result",
      result: [
        {
          feature: "mail_classification",
          label: "Mail sorting",
          problem: "Connect a Gmail mailbox first.",
        },
        {
          feature: "related_cases",
          label: "Related Cases",
          problem: "Connect a Gmail mailbox first.",
        },
        {
          feature: "screen_relevance",
          label: "Screen suggestions",
          problem: null,
        },
      ],
    },
  },
  done: {
    kind: "done",
    organisationHandle: NINI.organisationHandle,
    name: NINI.name,
  },
  "failed-session": {
    kind: "failed",
    failure: {
      step: "prepare",
      title: "Your session has ended",
      reason: "Sign in again to continue the setup.",
      next: "Pantry keeps this setup and continues it after you sign in.",
      detail: null,
      action: "Sign in again",
      signIn: true,
      recovery: { kind: "sign_in" },
    },
  },
  "failed-stopped": {
    kind: "failed",
    failure: {
      step: "prepare",
      title: "The setup stopped",
      reason: "Pantry could not complete this request. Try again.",
      next: "Try again to continue the same setup. Pantry does not make a second organisation.",
      detail: "Error code: authority_unavailable",
      action: "Try again",
      signIn: true,
      recovery: { kind: "request", request: REQUEST },
    },
  },
  "failed-missing": {
    kind: "failed",
    failure: {
      step: "prepare",
      title: "Your organisation is not in your list",
      reason:
        "Pantry made the organisation, but your organisation list does not show it.",
      next: "Check again in a moment.",
      detail: `Organisation ID: ${NINI.organisationId}`,
      action: "Check again",
      signIn: false,
      recovery: {
        kind: "listing",
        organisationId: NINI.organisationId,
        request: REQUEST,
      },
    },
  },
};

const params = new URL(window.location.href).searchParams;
const setup = params.get("setup");
const invitation = params.get("invitation");
const theme = params.get("theme");
if (theme === "dark" || theme === "light") {
  document.documentElement.dataset.portalMode = theme;
}

function previewSettled(): Promise<void> {
  return Promise.resolve();
}

function previewOpen(): void {}

const ACTIONS: OrganisationActions = {
  rename: previewSettled,
  archive: previewSettled,
  restore: previewSettled,
  delete: previewSettled,
};

const SETUP_ACTIONS: AccountSetupActions = {
  close: previewOpen,
  nameOrganisation: previewOpen,
  next: previewOpen,
  recover: previewOpen,
  turnOnJev: previewOpen,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolveAfter.bind(null, milliseconds));
}

function resolveAfter(milliseconds: number, resolve: () => void): void {
  window.setTimeout(resolve, milliseconds);
}

/**
 * The fake server's records. They stay in this tab, so a reload meets the
 * same server, as a reload of the Portal meets the same Pantry.
 */
type PreviewServer = {
  posts: number;
  created: Record<string, OrganisationListItem>;
};

const SERVER_KEY = "organisations-preview:server";

function readServer(): PreviewServer {
  const raw = window.sessionStorage.getItem(SERVER_KEY);
  const value: unknown = raw === null ? null : JSON.parse(raw);
  return isRecord(value) && isRecord(value.created)
    ? (value as PreviewServer)
    : { posts: 0, created: {} };
}

function createdOrganisations(): readonly OrganisationListItem[] {
  return Object.values(readServer().created);
}

function previewHandle(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

/**
 * `POST /v1/control/organisations` as Pantry answers it: a repeat of an
 * operation id answers the same organisation, and the same id with another
 * name is a conflict. `?setup=live-limit`: the person owns 5 organisations;
 * `?setup=live-unverified`: the Google email is not verified.
 */
function answerCreate(body: OrganisationCreationRequest): Response {
  const server = readServer();
  server.posts += 1;
  const earlier = server.created[body.operationId];
  let answer: Response;
  if (setup === "live-unverified") {
    answer = json({ ok: false, error: "organisation_owner_unverified" }, 403);
  } else if (earlier !== undefined) {
    answer =
      earlier.name === body.name.trim()
        ? json({ ok: true, organisation: earlier })
        : json({ ok: false, error: "idempotency_key_conflict" }, 409);
  } else if (setup === "live-limit") {
    answer = json({ ok: false, error: "organisation_limit_reached" }, 409);
  } else {
    const count = Object.keys(server.created).length + 1;
    const organisation: OrganisationListItem = {
      ...NINI,
      organisationId: `organisation_preview_created_${count}`,
      organisationHandle: previewHandle(body.name),
      name: body.name.trim(),
    };
    server.created[body.operationId] = organisation;
    answer = json({
      ok: true,
      organisation: {
        organisationId: organisation.organisationId,
        organisationHandle: organisation.organisationHandle,
      },
    });
  }
  window.sessionStorage.setItem(SERVER_KEY, JSON.stringify(server));
  return answer;
}

const INVITATION_STATUS: Record<string, number> = {
  organisation_invitation_not_found: 404,
  organisation_invitation_email_mismatch: 403,
  organisation_invitation_closed: 409,
  organisation_invitation_expired: 409,
};

/** `?invitation=accepted` accepts; any other value is the refusal code. */
function answerAccept(): Response {
  if (invitation === "accepted") {
    return json({
      ok: true,
      member: { userId: "user_preview", role: "operator" },
    });
  }
  return json(
    { ok: false, error: invitation },
    INVITATION_STATUS[invitation ?? ""] ?? 503,
  );
}

const ACCEPT_PATH =
  /^\/v1\/control\/organisations\/[^/]+\/invitations\/[^/]+\/accept$/u;

/**
 * The create and accept routes answer from this fake, so the preview never
 * sends a setup to a real backend. `?setup=live` runs the real dialog; with
 * `?setup=live-missing` the session never lists the organisation.
 */
function installPreviewServer(): void {
  document.cookie = "pantry_csrf=organisations-preview; path=/";
  const fetchControl = window.fetch.bind(window);
  window.fetch = async function previewFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      window.location.href,
    );
    const post = (init?.method ?? "GET") === "POST";
    if (post && url.pathname === "/v1/control/organisations") {
      await wait(700);
      return answerCreate(JSON.parse(String(init?.body)));
    }
    if (post && ACCEPT_PATH.test(url.pathname)) {
      await wait(500);
      return answerAccept();
    }
    return fetchControl(input, init);
  };
}

function previewOrganisations(
  organisations: readonly OrganisationListItem[],
): Promise<readonly OrganisationListItem[]> {
  return Promise.resolve(organisations);
}

function PreviewRoute(): React.ReactNode {
  const scenario = params.get("scenario") ?? "single";
  const [organisations, setOrganisations] = React.useState<
    readonly OrganisationListItem[]
  >([
    ...(SCENARIOS[scenario] ?? SCENARIOS.single ?? []),
    ...createdOrganisations(),
  ]);
  const load = React.useCallback(
    previewOrganisations.bind(null, organisations),
    [organisations],
  );
  const finish = React.useCallback(
    finishPreviewSetup.bind(null, scenario, setOrganisations),
    [scenario],
  );
  const view = setup === null ? undefined : SETUP_VIEWS[setup];
  return (
    <>
      <OrganisationsRoute
        Frame={PortalFrame}
        displayName="Pta"
        membershipAvailability="complete"
        retryMemberships={previewOpen}
        logout={previewSettled}
        loadOrganisations={load}
        userId="organisations-preview"
        onSetupComplete={finish}
        organisationActions={ACTIONS}
        openWorkspace={previewOpen}
        supportTools={null}
      />
      {view === undefined ? null : (
        <AccountSetupDialog view={view} actions={SETUP_ACTIONS} />
      )}
    </>
  );
}

/** The session read after the setup: it lists what the fake server made. */
async function finishPreviewSetup(
  scenario: string,
  setOrganisations: React.Dispatch<
    React.SetStateAction<readonly OrganisationListItem[]>
  >,
  organisationId: string,
): Promise<AccountSetupListing> {
  await wait(900);
  const created = createdOrganisations();
  const listed = created.find(
    (organisation) => organisation.organisationId === organisationId,
  );
  if (setup === "live-missing" || listed === undefined) {
    return { kind: "missing" };
  }
  setOrganisations([...(SCENARIOS[scenario] ?? []), ...created]);
  return {
    kind: "listed",
    organisationHandle: listed.organisationHandle,
    workspaceHandle: listed.workspaces[0]?.workspaceHandle ?? null,
  };
}

function PreviewInvitation(): React.ReactNode {
  const route = readAccountInvitationRoute(
    new URL(window.location.href),
    window.sessionStorage,
  );
  return route.kind === "none" ? (
    <p>Open the preview with an invitation link.</p>
  ) : (
    <AccountInvitationPage
      Frame={PortalFrame}
      route={route}
      displayName="Pta"
      logout={previewSettled}
    />
  );
}

installPreviewServer();
if (setup === null || !setup.startsWith("live")) {
  // A fixed state must not resume a setup left by an earlier live run.
  window.sessionStorage.removeItem(
    "pantry:account-onboarding:organisations-preview",
  );
}

createRoot(root).render(
  <MemoryRouter initialEntries={["/portal"]}>
    {invitation === null ? <PreviewRoute /> : <PreviewInvitation />}
  </MemoryRouter>,
);

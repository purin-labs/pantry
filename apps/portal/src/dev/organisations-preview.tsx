import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type {
  AccountOnboardingOptions,
  AccountOnboardingRequest,
} from "@seams/control-api";
import "../styles.css";
import {
  OrganisationsRoute,
  type OrganisationActions,
  type OrganisationListItem,
} from "../pages/workspaces";
import {
  ACCOUNT_SETUP_CREATE,
  AccountSetupDialog,
  type AccountSetupActions,
  type AccountSetupDraft,
  type AccountSetupListing,
  type OpenAccountSetupView,
} from "../pages/account-onboarding";

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

/** The account the setup dialog reads: two organisations, three projects. */
const ACCOUNT: AccountOnboardingOptions = {
  organizations: [
    {
      id: "org_preview_nini",
      name: "Nini Corp",
      projects: [
        { id: "proj_preview_satyr", name: "Seams Pantry" },
        { id: "proj_preview_gifts", name: "Gift boxes" },
      ],
    },
    {
      id: "org_preview_atelier",
      name: "Atelier Lowerarchy",
      projects: [{ id: "proj_preview_kitchen", name: "Kitchen" }],
    },
  ],
};

const EXISTING: AccountSetupDraft = {
  options: ACCOUNT,
  organization: "org_preview_nini",
  organizationName: "",
  project: "proj_preview_satyr",
  projectName: "Seams Pantry",
};

const CREATED: AccountSetupDraft = {
  options: ACCOUNT,
  organization: ACCOUNT_SETUP_CREATE,
  organizationName: "Nini Pâtisserie",
  project: ACCOUNT_SETUP_CREATE,
  projectName: "Seams Pantry",
};

const REQUEST: AccountOnboardingRequest = {
  version: 1,
  operationId: "operation_preview",
  selection: {
    kind: "existing_project",
    organizationId: "org_preview_nini",
    projectId: "proj_preview_satyr",
  },
};

const PREPARED_AT = Date.now() - 65_000;

/** Every state of the setup dialog, by the name used in `?setup=`. */
const SETUP_VIEWS: Record<string, OpenAccountSetupView> = {
  loading: { kind: "loading" },
  organisation: { kind: "organisation", draft: EXISTING, problem: null },
  "organisation-create": {
    kind: "organisation",
    draft: { ...CREATED, organizationName: "" },
    problem: "Enter a name for the organisation.",
  },
  "organisation-none": {
    kind: "organisation",
    draft: {
      ...CREATED,
      options: { organizations: [] },
      organizationName: "Nini Corp",
    },
    problem: null,
  },
  project: { kind: "project", draft: EXISTING, problem: null },
  "project-new": { kind: "project", draft: CREATED, problem: null },
  billing: { kind: "billing", draft: EXISTING },
  "billing-new": { kind: "billing", draft: CREATED },
  preparing: {
    kind: "preparing",
    request: REQUEST,
    draft: EXISTING,
    startedAt: PREPARED_AT,
  },
  "preparing-resumed": {
    kind: "preparing",
    request: REQUEST,
    draft: null,
    startedAt: Date.now() - 4_000,
  },
  finishing: {
    kind: "finishing",
    nativeOrganizationId: NINI.organisationId,
    request: REQUEST,
    draft: EXISTING,
    startedAt: PREPARED_AT,
  },
  jev: {
    kind: "jev",
    nativeOrganizationId: NINI.organisationId,
    organisationHandle: NINI.organisationHandle,
    workspaceHandle: null,
    draft: EXISTING,
    jev: { kind: "choose" },
  },
  "jev-result": {
    kind: "jev",
    nativeOrganizationId: NINI.organisationId,
    organisationHandle: NINI.organisationHandle,
    workspaceHandle: null,
    draft: EXISTING,
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
    nativeOrganizationId: NINI.organisationId,
    organisationHandle: NINI.organisationHandle,
    draft: EXISTING,
  },
  "failed-account": {
    kind: "failed",
    failure: {
      step: "organisation",
      tone: "danger",
      title: "Pantry cannot read your account",
      reason: "Pantry could not complete this request. Try again.",
      next: "Try again. If the problem continues, sign in again.",
      detail: "Error code: authority_unavailable",
      action: "Try again",
      signIn: true,
      recovery: { kind: "options" },
    },
  },
  "failed-session": {
    kind: "failed",
    failure: {
      step: "prepare",
      tone: "danger",
      title: "Your session has ended",
      reason: "Sign in again to continue the setup.",
      next: "Pantry keeps this setup and continues it after you sign in.",
      detail: null,
      action: "Sign in again",
      signIn: true,
      recovery: { kind: "sign_in" },
    },
  },
  "failed-blocked": {
    kind: "failed",
    failure: {
      step: "billing",
      tone: "danger",
      title: "This project cannot start Seams Pantry",
      reason:
        "This project cannot start the Seams Pantry setup. Choose another project or ask its owner to check access.",
      next: null,
      detail: "Error code: account_setup_blocked",
      action: "Choose another project",
      signIn: false,
      recovery: { kind: "choose_project", draft: EXISTING },
    },
  },
  "failed-stopped": {
    kind: "failed",
    failure: {
      step: "prepare",
      tone: "danger",
      title: "The setup stopped",
      reason: "Pantry could not complete this request. Try again.",
      next: "Try again to continue the same setup. Pantry does not create a second organisation.",
      detail: "Error code: authority_unavailable",
      action: "Try again",
      signIn: true,
      recovery: { kind: "request", request: REQUEST, draft: EXISTING },
    },
  },
  "failed-slow": {
    kind: "failed",
    failure: {
      step: "prepare",
      tone: "warning",
      title: "The setup takes longer than usual",
      reason: "The setup is not finished after 1:04.",
      next: "Check again to continue the same setup.",
      detail: null,
      action: "Check again",
      signIn: false,
      recovery: { kind: "request", request: REQUEST, draft: EXISTING },
    },
  },
  "failed-missing": {
    kind: "failed",
    failure: {
      step: "done",
      tone: "danger",
      title: "Your organisation is not available",
      reason:
        "Pantry finished the setup, but your organisation list does not show the organisation.",
      next: "The project can still point to a deleted organisation. Create a new project for Seams Pantry, or check again.",
      detail: "Organisation ID: organisation_preview_nini",
      action: "Create a new project",
      signIn: false,
      recovery: { kind: "new_project", draft: EXISTING },
      alternative: {
        action: "Check again",
        recovery: {
          kind: "listing",
          nativeOrganizationId: NINI.organisationId,
          request: REQUEST,
          draft: EXISTING,
        },
      },
    },
  },
};

const params = new URL(window.location.href).searchParams;
const setup = params.get("setup");
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
  chooseOrganisation: previewOpen,
  nameOrganisation: previewOpen,
  chooseProject: previewOpen,
  nameProject: previewOpen,
  back: previewOpen,
  next: previewOpen,
  recover: previewOpen,
  alternative: previewOpen,
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
 * The setup route always answers from this mock, so the preview never sends
 * a setup to a real backend. `?setup=live` runs the real dialog: the account
 * read, three pending status reads, then ready. With `?setup=live-missing`
 * the session never lists the organisation.
 */
function installPreviewAccount(): void {
  document.cookie = "satyr_control_csrf=organisations-preview; path=/";
  const fetchControl = window.fetch.bind(window);
  let reads = 0;
  window.fetch = async function previewFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      window.location.href,
    );
    if (url.pathname !== "/v1/control/account-onboarding") {
      return fetchControl(input, init);
    }
    await wait(700);
    if ((init?.method ?? "GET") === "GET") {
      return json({ ok: true, value: ACCOUNT });
    }
    reads += 1;
    if (reads <= 3) {
      return json({
        ok: true,
        value: {
          kind: "pending",
          operationId: "operation_preview",
          instanceId: "instance_preview",
        },
      });
    }
    return json({
      ok: true,
      value: { kind: "ready", nativeOrganizationId: NINI.organisationId },
    });
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
  >(SCENARIOS[scenario] ?? SCENARIOS.single ?? []);
  const load = React.useCallback(
    previewOrganisations.bind(null, organisations),
    [organisations],
  );
  const finish = React.useCallback(
    finishPreviewSetup.bind(null, setOrganisations),
    [],
  );
  const view = setup === null ? undefined : SETUP_VIEWS[setup];
  return (
    <>
      <OrganisationsRoute
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
        <AccountSetupDialog
          view={view}
          actions={SETUP_ACTIONS}
          organisationName={view.kind === "done" ? NINI.name : null}
        />
      )}
    </>
  );
}

async function finishPreviewSetup(
  setOrganisations: React.Dispatch<
    React.SetStateAction<readonly OrganisationListItem[]>
  >,
): Promise<AccountSetupListing> {
  await wait(900);
  if (setup === "live-missing") {
    return { kind: "missing" };
  }
  setOrganisations([NINI]);
  return {
    kind: "listed",
    organisationHandle: NINI.organisationHandle,
    workspaceHandle: null,
  };
}

installPreviewAccount();
if (setup !== "live" && setup !== "live-missing") {
  // A fixed state must not resume a setup left by an earlier live run.
  window.sessionStorage.removeItem(
    "satyr:account-onboarding:organisations-preview",
  );
}

createRoot(root).render(
  <MemoryRouter initialEntries={["/portal"]}>
    <PreviewRoute />
  </MemoryRouter>,
);

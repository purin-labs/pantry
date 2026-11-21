import type { OnboardingStepProjection } from "@purin-labs/contracts";
import React from "react";
import {
  Link,
  useRouteError,
} from "react-router";
import {
  isModuleLoadError,
  reloadForNewRelease,
} from "./stale-release";
import {
  organisationPath,
  workspacePageDescriptor,
  workspacePageHeader,
  workspacePagePath,
  type PortalRoute,
} from "./route";
import { PortalFrame } from "./shell";
import {
  PageHeader,
  PageSkeleton,
} from "./page-components";
import {
  OrganisationListLoading,
  type OrganisationListItem,
  type WorkspaceSupportTools,
} from "./pages/workspaces";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import { formatLifecycle } from "./portal-projection";
import {
  loadPortalOrganisations,
  toOrganisationChoice,
  toWorkspaceChoice,
} from "./portal-reads";
import { workspaceRouteSelection } from "./portal-routing";
import type { Membership } from "@purin-labs/control-api/portal/portal-types";
import type { PortalOrganisation, PortalState } from "./portal-types";
import "./portal-brand.css";

function reloadPortalPage(): void {
  window.location.reload();
}

function onboardingStepLabel(step: OnboardingStepProjection["step"]): string {
  switch (step) {
    case "workspace":
      return "Workspace";
    case "inference":
      return "AI account";
    case "commerce":
      return "Commerce";
    case "conversations":
      return "Communication";
    case "operating_profile":
      return "Slack updates";
    case "review_activation":
      return "Review and activate";
    default:
      return assertNever(step, "Unexpected portal state");
  }
}

function onboardingStepHref(
  organisationHandle: string,
  workspaceHandle: string,
  step: OnboardingStepProjection["step"],
): string {
  switch (step) {
    case "workspace":
      return `${workspacePagePath(organisationHandle, workspaceHandle, "settings")}#team-title`;
    case "inference":
    case "commerce":
    case "conversations":
      return `${workspacePagePath(organisationHandle, workspaceHandle, "integrations")}#connections-title`;
    case "operating_profile":
      return `${workspacePagePath(organisationHandle, workspaceHandle, "integrations")}#setup-title`;
    case "review_activation":
      return `${workspacePagePath(organisationHandle, workspaceHandle, "integrations")}#activation-title`;
    default:
      return assertNever(step, "Unexpected portal state");
  }
}

function googleSignInHref(): string {
  const returnTo = window.location.pathname + window.location.search;
  return (
    "/v1/control/auth/google/start?" +
    new URLSearchParams({ returnTo }).toString()
  );
}

export function SignIn(): React.ReactNode {
  return (
    <main id="portal-content" className="signin-shell" tabIndex={-1}>
      <section className="signin-access" aria-labelledby="signin-title">
        <div className="signin-brand" aria-label="Seams Pantry">
          <img
            className="signin-brand-mark"
            src="/brand/satyr-mark-dark-32.png"
            alt=""
            width={28}
            height={28}
          />
          <div className="signin-brand-copy">
            <strong>Seams Pantry</strong>
            <span className="portal-brand-subtitle">
              Bakery operating system
            </span>
          </div>
        </div>
        <div className="signin-access-body">
          <h1 id="signin-title" tabIndex={-1}>
            Sign in to Seams Pantry
          </h1>
          <p className="signin-intro">
            Open your workspace and continue operating.
          </p>
          <a className="signin-button" href={googleSignInHref()}>
            <GoogleMark />
            <span>Continue with Google</span>
          </a>
        </div>
        <p className="signin-access-note">
          Sign in to select a Platform project or create one. If you have an
          invitation, use the invited Google account.
        </p>
      </section>
      <section className="signin-story" aria-labelledby="signin-story-title">
        <div className="signin-story-body">
          <h2 id="signin-story-title">One place to run your café</h2>
          <p>
            Commerce, inventory, daily operations, and approval requests stay
            connected.
          </p>
        </div>
      </section>
    </main>
  );
}

function GoogleMark(): React.ReactNode {
  return (
    <svg className="google-mark" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285f4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"
      />
      <path
        fill="#34a853"
        d="M9 18c2.43 0 4.47-.8 5.95-2.18l-2.91-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.33-1.58-5.04-3.71H.95v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#fbbc05"
        d="M3.96 10.71A5.42 5.42 0 0 1 3.68 9c0-.59.1-1.16.28-1.71V4.96H.95A9 9 0 0 0 0 9c0 1.45.35 2.82.95 4.04l3.01-2.33Z"
      />
      <path
        fill="#ea4335"
        d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A8.64 8.64 0 0 0 9 0 9 9 0 0 0 .95 4.96l3.01 2.33C4.67 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

export function PortalLoading(props: {
  readonly route: PortalRoute;
}): React.ReactNode {
  if (props.route.kind === "workspace") {
    const selection = workspaceRouteSelection(props.route, "loading");
    const descriptor = workspacePageDescriptor(selection.page);
    const header = workspacePageHeader(descriptor, selection.resourceId);
    return (
      <PortalFrame
        identity={{ kind: "loading" }}
        organisation={{
          organisationHandle: props.route.organisationHandle,
          name: "Loading organisation",
          choices: [],
        }}
        workspace={{
          organisationHandle: props.route.organisationHandle,
          workspaceHandle: props.route.workspaceHandle,
          name: "Loading workspace",
          choices: [],
        }}
        sidebar={{
          activePage: selection.page === "chat" ? "overview" : selection.page,
          chatOpen: selection.page === "chat",
          footer: <p role="status">Loading workspace…</p>,
        }}
      >
        <PageHeader title={header.title} description={header.description} />
        <section
          className="portal-band"
          aria-label={`${header.title} loading`}
          aria-busy="true"
        >
          <PageSkeleton label={`Loading ${header.title}`} />
        </section>
      </PortalFrame>
    );
  }
  return (
    <PortalFrame identity={{ kind: "loading" }}>
      <OrganisationListLoading />
    </PortalFrame>
  );
}

/** A page whose code is gone after a release reloads once into the new release. */
export function PortalRouteFailure(): React.ReactNode {
  const error = useRouteError();
  React.useEffect(() => {
    if (isModuleLoadError(error)) reloadForNewRelease();
  }, [error]);
  return (
    <PortalLoadFailure
      message="This page could not load. Try again to reload it. Unsaved changes may be lost."
      retry={reloadPortalPage}
    />
  );
}

export function PortalLoadFailure(props: {
  readonly message: string;
  readonly retry: () => void;
}): React.ReactNode {
  return (
    <main className="auth-status-shell">
      <section className="auth-status-panel">
        <p className="brand">Seams Pantry</p>
        <h1>Something went wrong</h1>
        <p>{props.message}</p>
        <div className="load-failure-actions">
          <button type="button" className="signin-button" onClick={props.retry}>
            Try again
          </button>
          <Link to="/portal">All organisations</Link>
        </div>
      </section>
    </main>
  );
}

export function renderRouteNotFound(
  state: Variant<PortalState, "route_not_found">,
  logout: () => Promise<void>,
): React.ReactNode {
  const organisation = state.organisation;
  const workspace =
    state.workspace ??
    (state.reason === "page"
      ? (organisation?.membership.workspaces[0] ?? null)
      : null);
  const destination =
    organisation === null
      ? "/portal"
      : state.reason === "workspace" || workspace === null
        ? organisationPath(organisation.membership.organisationHandle)
        : workspacePagePath(
            organisation.membership.organisationHandle,
            workspace.workspaceHandle,
            "overview",
          );
  const destinationLabel =
    organisation === null
      ? "Return to organisations"
      : state.reason === "workspace"
        ? "Open available workspace"
        : "Return to workspace home";
  const title =
    state.reason === "organisation"
      ? "Organisation unavailable"
      : state.reason === "workspace"
        ? "Workspace unavailable"
        : "Page not found";
  const description =
    state.reason === "organisation"
      ? "This organisation does not exist or your account no longer has access to it."
      : state.reason === "workspace"
        ? "This workspace does not exist or your account no longer has access to it."
        : "This address does not match a page in Seams Pantry.";
  const content = (
    <>
      <PageHeader title={title} description={description} />
      <section className="portal-band compact-band">
        <Link className="primary-button" to={destination}>
          {destinationLabel}
        </Link>
      </section>
    </>
  );
  if (organisation === null || workspace === null) {
    return (
      <PortalFrame
        identity={{
          kind: "ready",
          displayName: state.identity.displayName,
          logout,
        }}
      >
        {content}
      </PortalFrame>
    );
  }
  return (
    <PortalFrame
      identity={{
        kind: "ready",
        displayName: state.identity.displayName,
        logout,
      }}
      organisation={{
        organisationHandle: organisation.membership.organisationHandle,
        name: organisation.organisation.name,
        choices: [toOrganisationChoice(organisation)],
      }}
      workspace={{
        organisationHandle: organisation.membership.organisationHandle,
        workspaceHandle: workspace.workspaceHandle,
        name: workspace.name,
        choices: organisation.membership.workspaces.map(
          toWorkspaceChoice.bind(
            null,
            organisation.membership.organisationHandle,
          ),
        ),
      }}
      sidebar={{
        activePage: null,
        chatOpen: false,
        footer: renderNotFoundOrganisationSidebarFooter(organisation),
      }}
    >
      {content}
    </PortalFrame>
  );
}

function renderNotFoundOrganisationSidebarFooter(
  organisation: PortalOrganisation,
): React.ReactNode {
  return (
    <>
      <Link className="rail-back" to="/portal">
        All organisations
      </Link>
      <div className="rail-organisation">
        <span className="rail-organisation-name">
          {organisation.organisation.name}
        </span>
        <span
          className={`lifecycle lifecycle-${organisation.organisation.lifecycle}`}
        >
          {formatLifecycle(organisation.organisation.lifecycle)}
        </span>
      </div>
    </>
  );
}

export function renderWorkspaceSidebarFooter(
  state: Variant<PortalState, "workspace_detail">,
): React.ReactNode {
  const organisation = state.organisation.organisation;
  return (
    <>
      {state.page === "overview" &&
      organisation.lifecycle !== "active" &&
      organisation.lifecycle !== "archived" ? (
        <div className="rail-onboarding">
          <p className="rail-label">Onboarding</p>
          <nav className="rail-nav" aria-label="Onboarding">
            <ol>
              {state.steps.map(
                renderRailStep.bind(
                  null,
                  state.organisation.membership.organisationHandle,
                  state.workspace.workspaceHandle,
                ),
              )}
            </ol>
            {state.organisation.membership.role === "owner" ? (
              <Link
                className="rail-link rail-plain"
                to={workspacePagePath(
                  state.organisation.membership.organisationHandle,
                  state.workspace.workspaceHandle,
                  "settings",
                )}
              >
                Workspace settings
              </Link>
            ) : null}
          </nav>
        </div>
      ) : null}
    </>
  );
}

function renderRailStep(
  organisationHandle: string,
  workspaceHandle: string,
  step: OnboardingStepProjection,
): React.ReactNode {
  const complete = step.kind === "complete";
  return (
    <li key={step.step}>
      <Link
        className={complete ? "rail-link done" : "rail-link"}
        to={onboardingStepHref(organisationHandle, workspaceHandle, step.step)}
      >
        <span className="step-mark" aria-hidden="true">
          {complete ? "✓" : ""}
        </span>
        {onboardingStepLabel(step.step)}
      </Link>
    </li>
  );
}

export async function loadOrganisationListItems(
  memberships: readonly Membership[],
): Promise<readonly OrganisationListItem[]> {
  const organisations = await loadPortalOrganisations(memberships);
  return organisations.map(toOrganisationListItem);
}

function toOrganisationListItem(
  item: PortalOrganisation,
): OrganisationListItem {
  return {
    organisationId: item.organisation.organisationId,
    organisationHandle: item.membership.organisationHandle,
    name: item.organisation.name,
    role: item.membership.role,
    plan: item.organisation.plan,
    lifecycle: item.organisation.lifecycle,
    configurationVersion: item.configurationVersion,
    workspaces: item.membership.workspaces,
  };
}

export function organisationSupportTools(
  state: Variant<PortalState, "organisation_list">,
  inspect: (event: React.FormEvent<HTMLFormElement>) => Promise<void>,
  archive: () => Promise<void>,
): WorkspaceSupportTools | null {
  return state.supportRole === "support_admin"
    ? {
        busy: state.busy,
        error: state.error,
        operatorCase: state.operatorCase,
        inspect,
        archive,
      }
    : null;
}

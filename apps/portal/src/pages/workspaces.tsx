import type { ControlMembershipAvailability } from "@purin-labs/control-api";
import React from "react";
import {
  Archive,
  ArrowRight,
  MoreHorizontal,
  PencilLine,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Link } from "react-router";

import type {
  OnboardingControlRole,
  OnboardingEnvironment,
  OrganisationOnboardingLifecycle,
} from "@purin-labs/contracts";
import { ControlApiError } from "../control-client";
import { ArchiveConfirm } from "../features/integrations/archive-confirm";
import {
  EmptyState,
  Notice,
  PageHeader,
  PageSkeleton,
  RecoverableError,
} from "../page-components";
import type { PageContent } from "../page-content";
import { organisationPath, workspacePagePath } from "../route";
import { PortalFrame } from "../shell";
import { AgentModal } from "./agent-modal";
import { AccountSetup, type AccountSetupListing } from "./account-onboarding";
import { assertNever } from "@purin-labs/std";

type OrganisationWorkspaceListItem = {
  readonly workspaceId: string;
  readonly workspaceHandle: string;
  readonly name: string;
  readonly createdAt: number;
};

export type OrganisationListItem = {
  readonly organisationId: string;
  readonly organisationHandle: string;
  readonly name: string;
  readonly role: OnboardingControlRole;
  readonly plan: string;
  readonly lifecycle: OrganisationOnboardingLifecycle["kind"];
  readonly configurationVersion: number;
  readonly workspaces: readonly OrganisationWorkspaceListItem[];
};

export type OrganisationActions = {
  readonly rename: (
    organisation: OrganisationListItem,
    name: string,
  ) => Promise<void>;
  readonly archive: (organisation: OrganisationListItem) => Promise<void>;
  readonly restore: (organisation: OrganisationListItem) => Promise<void>;
  readonly delete: (organisation: OrganisationListItem) => Promise<void>;
};

export type WorkspaceRouteTarget = {
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
};

type WorkspaceSupportCase = {
  readonly organisationId: string;
  readonly environment: OnboardingEnvironment;
  readonly lifecycle: string;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
};

export type WorkspaceSupportTools = {
  readonly busy: boolean;
  readonly error: string | null;
  readonly operatorCase: WorkspaceSupportCase | null;
  readonly inspect: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  readonly archive: () => Promise<void>;
};

type OrganisationsRouteProps = {
  readonly displayName: string;
  readonly membershipAvailability: ControlMembershipAvailability;
  readonly retryMemberships: () => void;
  readonly logout: () => Promise<void>;
  readonly loadOrganisations: () => Promise<readonly OrganisationListItem[]>;
  readonly userId: string;
  /** Reads the session again and reports if it lists the new organisation. */
  readonly onSetupComplete: (
    nativeOrganizationId: string,
  ) => Promise<AccountSetupListing>;
  readonly organisationActions: OrganisationActions;
  readonly openWorkspace: (target: WorkspaceRouteTarget) => void;
  readonly supportTools: WorkspaceSupportTools | null;
};

type OrganisationsPageContent = PageContent<readonly OrganisationListItem[]>;
type OrganisationsContentSetter = React.Dispatch<
  React.SetStateAction<OrganisationsPageContent>
>;

export function OrganisationsRoute(
  props: OrganisationsRouteProps,
): React.ReactNode {
  const [content, setContent] = React.useState<OrganisationsPageContent>({
    kind: "loading",
  });
  const requestRevision = React.useRef(0);
  const setup = React.useRef<AccountSetup>(null);
  React.useEffect(
    beginOrganisationsLoad.bind(
      null,
      props.loadOrganisations,
      setContent,
      requestRevision,
    ),
    [props.loadOrganisations],
  );
  return (
    <PortalFrame
      identity={{
        kind: "ready",
        displayName: props.displayName,
        logout: props.logout,
      }}
    >
      <OrganisationsRouteContent
        content={content}
        membershipAvailability={props.membershipAvailability}
        retryMemberships={props.retryMemberships}
        retry={retryOrganisations.bind(
          null,
          props.loadOrganisations,
          setContent,
          requestRevision,
        )}
        openSetup={openAccountSetup.bind(null, setup)}
        organisationActions={props.organisationActions}
        openWorkspace={props.openWorkspace}
        supportTools={props.supportTools}
      />
      <AccountSetup
        ref={setup}
        userId={props.userId}
        finish={props.onSetupComplete}
        organisationName={findOrganisationName.bind(null, content)}
        resume={content.kind !== "loading"}
      />
    </PortalFrame>
  );
}

/**
 * The page owns the setup dialog, not the list: the list shows a skeleton
 * while it reads again, and the dialog must stay open through that read.
 */
function openAccountSetup(setup: React.RefObject<AccountSetup | null>): void {
  setup.current?.open();
}

function findOrganisationName(
  content: OrganisationsPageContent,
  organisationId: string,
): string | null {
  if (content.kind !== "ready") {
    return null;
  }
  for (const item of content.data) {
    if (item.organisationId === organisationId) {
      return item.name;
    }
  }
  return null;
}

function beginOrganisationsLoad(
  read: OrganisationsRouteProps["loadOrganisations"],
  setContent: OrganisationsContentSetter,
  requestRevision: React.MutableRefObject<number>,
): () => void {
  void loadOrganisations(read, setContent, requestRevision, "initial");
  return invalidateOrganisationsRequest.bind(null, requestRevision);
}

function retryOrganisations(
  read: OrganisationsRouteProps["loadOrganisations"],
  setContent: OrganisationsContentSetter,
  requestRevision: React.MutableRefObject<number>,
): void {
  void loadOrganisations(read, setContent, requestRevision, "refresh");
}

async function loadOrganisations(
  read: OrganisationsRouteProps["loadOrganisations"],
  setContent: OrganisationsContentSetter,
  requestRevision: React.MutableRefObject<number>,
  mode: "initial" | "refresh",
): Promise<void> {
  const revision = requestRevision.current + 1;
  requestRevision.current = revision;
  setContent(
    mode === "initial" ? { kind: "loading" } : refreshingOrganisationsContent,
  );
  try {
    const organisations = await read();
    if (requestRevision.current !== revision) return;
    setContent({
      kind: "ready",
      data: organisations,
      freshness: { kind: "current" },
      updating: false,
    });
  } catch (error) {
    if (requestRevision.current !== revision) return;
    setContent({
      kind: "failed",
      problem:
        error instanceof ControlApiError
          ? `Pantry could not load your organisations: ${error.message}`
          : "Pantry could not load your organisations.",
      recovery: { label: "Try again" },
    });
  }
}

function invalidateOrganisationsRequest(
  requestRevision: React.MutableRefObject<number>,
): void {
  requestRevision.current += 1;
}

function refreshingOrganisationsContent(
  content: OrganisationsPageContent,
): OrganisationsPageContent {
  return content.kind === "ready"
    ? { ...content, updating: true }
    : { kind: "loading" };
}

function OrganisationsRouteContent(props: {
  readonly membershipAvailability: ControlMembershipAvailability;
  readonly retryMemberships: () => void;
  readonly content: OrganisationsPageContent;
  readonly retry: () => void;
  readonly openSetup: () => void;
  readonly organisationActions: OrganisationActions;
  readonly openWorkspace: OrganisationsRouteProps["openWorkspace"];
  readonly supportTools: WorkspaceSupportTools | null;
}): React.ReactNode {
  const membershipRecovery = (
    <div className="connection-actions">
      <button type="button" onClick={props.retryMemberships}>
        Refresh organisations
      </button>
      <a
        className="button-link"
        href="/v1/control/auth/google/start?returnTo=/portal"
      >
        Sign in again
      </a>
    </div>
  );
  switch (props.content.kind) {
    case "loading":
      return <OrganisationListLoading />;
    case "ready":
      if (
        props.membershipAvailability === "incomplete" &&
        props.content.data.length === 0
      ) {
        return (
          <OrganisationPage>
            <RecoverableError
              message="Your organisations are temporarily unavailable. Refresh the list or sign in again."
              action={membershipRecovery}
            />
          </OrganisationPage>
        );
      }
      return (
        <OrganisationListPage
          notice={
            <>
              {props.membershipAvailability === "incomplete" ? (
                <>
                  <Notice tone="neutral" announcement="polite">
                    Some organisations are unavailable. Refresh the list or sign
                    in again.
                  </Notice>
                  {membershipRecovery}
                </>
              ) : null}
              {props.content.updating ? (
                <Notice tone="neutral" announcement="polite">
                  Refreshing organisations…
                </Notice>
              ) : null}
            </>
          }
          organisations={props.content.data}
          openSetup={props.openSetup}
          organisationActions={props.organisationActions}
          refresh={props.retry}
          openWorkspace={props.openWorkspace}
          supportTools={props.supportTools}
        />
      );

    case "failed":
      return (
        <RecoverableError
          message={props.content.problem}
          action={
            <button type="button" onClick={props.retry}>
              {props.content.recovery.label}
            </button>
          }
        />
      );
    case "empty":
      return (
        <EmptyState
          title="No organisations yet"
          detail={props.content.reason}
        />
      );
    case "unauthorized":
      return (
        <EmptyState
          title="Organisations are unavailable"
          detail={props.content.reason}
        />
      );
    default:
      return assertNever(props.content, "Unhandled organisation value");
  }
}

export function OrganisationsLoading(): React.ReactNode {
  return (
    <PortalFrame identity={{ kind: "loading" }}>
      <OrganisationListLoading />
    </PortalFrame>
  );
}

function OrganisationListLoading(): React.ReactNode {
  return (
    <OrganisationPage>
      <PageSkeleton label="Loading organisations" />
    </OrganisationPage>
  );
}

function OrganisationPage(props: {
  readonly children: React.ReactNode;
}): React.ReactNode {
  return (
    <div className="organisation-page">
      <PageHeader
        title="Organisations"
        description="Open a workspace, or manage the organisations you belong to."
      />
      {props.children}
    </div>
  );
}

export function OrganisationListPage(props: {
  readonly notice?: React.ReactNode;
  readonly organisations: readonly OrganisationListItem[];
  readonly openSetup: () => void;
  readonly organisationActions: OrganisationActions;
  readonly refresh: () => void;
  readonly openWorkspace: OrganisationsRouteProps["openWorkspace"];
  readonly supportTools: WorkspaceSupportTools | null;
}): React.ReactNode {
  const createButton = (
    <button
      type="button"
      className="organisation-create-button"
      onClick={props.openSetup}
    >
      Set up Seams Pantry
    </button>
  );
  return (
    <OrganisationPage>
      {props.notice}
      <section
        className="portal-band"
        aria-labelledby="organisation-list-title"
      >
        <div className="organisation-list-heading">
          <h2 id="organisation-list-title">Your organisations</h2>
          {props.organisations.length === 0 ? null : createButton}
        </div>
        <div className="organisation-list">
          {renderOrganisationList(
            props.organisationActions,
            props.refresh,
            props.organisations,
            createButton,
          )}
        </div>
      </section>
      {props.supportTools === null ? null : (
        <WorkspaceSupportToolsPanel tools={props.supportTools} />
      )}
    </OrganisationPage>
  );
}

/**
 * Opening the modal moves focus to its close button. A dialog that asks for
 * one value starts in its field, with any current value selected. This effect
 * runs after the modal's own, which opens it.
 */
function useDialogFieldFocus(): React.RefObject<HTMLInputElement | null> {
  const field = React.useRef<HTMLInputElement>(null);
  React.useEffect(focusDialogField.bind(null, field), []);
  return field;
}

function focusDialogField(
  field: React.RefObject<HTMLInputElement | null>,
): void {
  field.current?.focus();
  field.current?.select();
}

function renderOrganisationList(
  actions: OrganisationActions,
  refresh: () => void,
  organisations: readonly OrganisationListItem[],
  createButton: React.ReactNode,
): React.ReactNode {
  if (organisations.length === 0) {
    return (
      <div className="empty-state organisation-setup-invitation">
        <strong>No organisations yet</strong>
        <span>
          Seams Pantry runs in a project of your account. Set it up in three
          steps:
        </span>
        <ol className="organisation-setup-preview">
          <li>Choose an organisation</li>
          <li>Choose or create a project</li>
          <li>Confirm billing</li>
        </ol>
        {createButton}
      </div>
    );
  }
  return [...organisations]
    .sort(compareArchivedLast)
    .map(renderOrganisationListItem.bind(null, actions, refresh));
}

/** Archived organisations sink below the ones still in use; the order the
 * control plane returned is otherwise kept. */
function compareArchivedLast(
  left: OrganisationListItem,
  right: OrganisationListItem,
): number {
  return (
    Number(left.lifecycle === "archived") -
    Number(right.lifecycle === "archived")
  );
}

function renderOrganisationListItem(
  actions: OrganisationActions,
  refresh: () => void,
  item: OrganisationListItem,
): React.ReactNode {
  return (
    <OrganisationListRow
      key={item.organisationHandle}
      item={item}
      actions={actions}
      refresh={refresh}
    />
  );
}

type OrganisationRowState =
  | { readonly kind: "idle" }
  | { readonly kind: "renaming"; readonly request: OrganisationDialogRequest }
  | {
      readonly kind: "confirming_delete";
      readonly request: OrganisationDialogRequest;
    }
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly message: string };

type OrganisationDialogRequest =
  | { readonly kind: "ready" }
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly message: string };

function OrganisationListRow(props: {
  readonly item: OrganisationListItem;
  readonly actions: OrganisationActions;
  readonly refresh: () => void;
}): React.ReactNode {
  const [state, setState] = React.useState<OrganisationRowState>({
    kind: "idle",
  });
  const canManage = props.item.role === "owner";
  const note = organisationLifecycleNote(props.item.lifecycle, canManage);
  return (
    <article
      className="organisation-card"
      data-lifecycle={props.item.lifecycle}
    >
      <div className="organisation-card-head">
        <Link
          className="organisation-row-link"
          to={organisationPath(props.item.organisationHandle)}
        >
          <span
            className="console-switcher-avatar console-switcher-organisation-avatar organisation-card-avatar"
            aria-hidden="true"
          />
          <span className="organisation-card-copy">
            <strong>{props.item.name}</strong>
            <small>
              {organisationRoleLabel(props.item.role)} ·{" "}
              {organisationPlanLabel(props.item.plan)}
            </small>
          </span>
        </Link>
        <span className={`lifecycle lifecycle-${props.item.lifecycle}`}>
          {organisationLifecycleLabel(props.item.lifecycle)}
        </span>
        {canManage ? (
          <details
            className="organisation-menu"
            onKeyDown={closeOrganisationMenuOnEscape}
          >
            <summary aria-label={`Manage ${props.item.name}`}>
              <MoreHorizontal size={18} strokeWidth={1.5} aria-hidden="true" />
            </summary>
            <div className="organisation-menu-popover">
              <button
                type="button"
                onClick={showOrganisationRename.bind(null, setState)}
              >
                <PencilLine size={16} strokeWidth={1.5} aria-hidden="true" />
                Rename
              </button>
              <button
                type="button"
                onClick={runOrganisationLifecycleAction.bind(
                  null,
                  props.item.lifecycle === "archived"
                    ? props.actions.restore
                    : props.actions.archive,
                  props.item,
                  props.refresh,
                  setState,
                )}
              >
                {props.item.lifecycle === "archived" ? (
                  <>
                    <RotateCcw size={16} strokeWidth={1.5} aria-hidden="true" />
                    Unarchive
                  </>
                ) : (
                  <>
                    <Archive size={16} strokeWidth={1.5} aria-hidden="true" />
                    Archive
                  </>
                )}
              </button>
              <button
                type="button"
                className="danger-text"
                onClick={showOrganisationDelete.bind(null, setState)}
              >
                <Trash2 size={16} strokeWidth={1.5} aria-hidden="true" />
                Delete
              </button>
            </div>
          </details>
        ) : null}
      </div>
      {note === null ? null : <p className="organisation-card-note">{note}</p>}
      {renderOrganisationWorkspaces(props.item)}
      {renderOrganisationActionDialog(props, state, setState)}
      {state.kind === "busy" ? (
        <p className="organisation-row-status" role="status">
          Saving…
        </p>
      ) : null}
      {state.kind === "failed" ? (
        <p className="error-text organisation-row-status" role="alert">
          {state.message}
        </p>
      ) : null}
    </article>
  );
}

function renderOrganisationActionDialog(
  props: {
    readonly item: OrganisationListItem;
    readonly actions: OrganisationActions;
    readonly refresh: () => void;
  },
  state: OrganisationRowState,
  setState: React.Dispatch<React.SetStateAction<OrganisationRowState>>,
): React.ReactNode {
  switch (state.kind) {
    case "renaming":
      return (
        <RenameOrganisationDialog
          item={props.item}
          actions={props.actions}
          refresh={props.refresh}
          request={state.request}
          setState={setState}
        />
      );
    case "confirming_delete":
      return (
        <DeleteOrganisationDialog
          item={props.item}
          actions={props.actions}
          request={state.request}
          setState={setState}
        />
      );
    case "idle":
    case "busy":
    case "failed":
      return null;
    default:
      return assertNever(state, "Unhandled organisation value");
  }
}

function RenameOrganisationDialog(props: {
  readonly item: OrganisationListItem;
  readonly actions: OrganisationActions;
  readonly refresh: () => void;
  readonly request: OrganisationDialogRequest;
  readonly setState: React.Dispatch<React.SetStateAction<OrganisationRowState>>;
}): React.ReactNode {
  const formId = `rename-${props.item.organisationId}`;
  const nameField = useDialogFieldFocus();
  const busy = props.request.kind === "busy";
  return (
    <AgentModal
      title="Rename organisation"
      description="Update the name shown across Seams Pantry. Workspace URLs stay the same."
      close={resetOrganisationRow.bind(null, props.setState)}
      footer={
        <>
          <button
            type="button"
            className="modal-secondary-button"
            onClick={resetOrganisationRow.bind(null, props.setState)}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="modal-primary-button"
            disabled={busy}
          >
            {busy ? "Saving…" : "Save name"}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="organisation-modal-form"
        onSubmit={submitOrganisationRename.bind(
          null,
          props.actions,
          props.item,
          props.refresh,
          props.setState,
        )}
      >
        <label>
          <span>Organisation name</span>
          <input
            ref={nameField}
            name="organisationName"
            defaultValue={props.item.name}
            minLength={2}
            maxLength={80}
            required
            aria-invalid={props.request.kind === "failed"}
            aria-describedby={
              props.request.kind === "failed" ? `${formId}-error` : undefined
            }
          />
        </label>
        {props.request.kind === "failed" ? (
          <p id={`${formId}-error`} className="error-text" role="alert">
            {props.request.message}
          </p>
        ) : null}
      </form>
    </AgentModal>
  );
}

function DeleteOrganisationDialog(props: {
  readonly item: OrganisationListItem;
  readonly actions: OrganisationActions;
  readonly request: OrganisationDialogRequest;
  readonly setState: React.Dispatch<React.SetStateAction<OrganisationRowState>>;
}): React.ReactNode {
  const busy = props.request.kind === "busy";
  return (
    <AgentModal
      title={`Delete ${props.item.name}?`}
      description="This action cannot be undone."
      close={resetOrganisationRow.bind(null, props.setState)}
      footer={
        <>
          <button
            type="button"
            className="modal-secondary-button"
            onClick={resetOrganisationRow.bind(null, props.setState)}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="modal-danger-button"
            onClick={runOrganisationDelete.bind(
              null,
              props.actions,
              props.item,
              props.setState,
            )}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete organisation"}
          </button>
        </>
      }
    >
      <div className="organisation-delete-warning">
        <Trash2 size={18} strokeWidth={1.5} aria-hidden="true" />
        <p>
          Connected services will be disabled and cleanup will begin
          immediately.
        </p>
      </div>
      {props.request.kind === "failed" ? (
        <p className="error-text" role="alert">
          {props.request.message}
        </p>
      ) : null}
    </AgentModal>
  );
}

function showOrganisationRename(
  setState: React.Dispatch<React.SetStateAction<OrganisationRowState>>,
  event: React.MouseEvent<HTMLButtonElement>,
): void {
  closeOrganisationMenu(event);
  setState({ kind: "renaming", request: { kind: "ready" } });
}

function showOrganisationDelete(
  setState: React.Dispatch<React.SetStateAction<OrganisationRowState>>,
  event: React.MouseEvent<HTMLButtonElement>,
): void {
  closeOrganisationMenu(event);
  setState({ kind: "confirming_delete", request: { kind: "ready" } });
}

function closeOrganisationMenu(
  event: React.MouseEvent<HTMLButtonElement>,
): void {
  event.currentTarget.closest("details")?.removeAttribute("open");
}

function closeOrganisationMenuOnEscape(
  event: React.KeyboardEvent<HTMLDetailsElement>,
): void {
  if (event.key !== "Escape") return;
  event.currentTarget.removeAttribute("open");
  event.currentTarget.querySelector("summary")?.focus();
}

function resetOrganisationRow(
  setState: React.Dispatch<React.SetStateAction<OrganisationRowState>>,
): void {
  setState({ kind: "idle" });
}

async function submitOrganisationRename(
  actions: OrganisationActions,
  item: OrganisationListItem,
  refresh: () => void,
  setState: React.Dispatch<React.SetStateAction<OrganisationRowState>>,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const name = new FormData(event.currentTarget).get("organisationName");
  if (typeof name !== "string" || name.trim().length < 2) {
    setState({
      kind: "renaming",
      request: { kind: "failed", message: "Enter an organisation name." },
    });
    return;
  }
  setState({ kind: "renaming", request: { kind: "busy" } });
  try {
    await actions.rename(item, name.trim());
    setState({ kind: "idle" });
    refresh();
  } catch {
    setState({
      kind: "renaming",
      request: {
        kind: "failed",
        message: "Pantry could not rename this organisation. Try again.",
      },
    });
  }
}

async function runOrganisationLifecycleAction(
  action: OrganisationActions["archive"] | OrganisationActions["restore"],
  item: OrganisationListItem,
  refresh: () => void,
  setState: React.Dispatch<React.SetStateAction<OrganisationRowState>>,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  closeOrganisationMenu(event);
  await runOrganisationAction(action.bind(null, item), refresh, setState);
}

async function runOrganisationDelete(
  actions: OrganisationActions,
  item: OrganisationListItem,
  setState: React.Dispatch<React.SetStateAction<OrganisationRowState>>,
): Promise<void> {
  setState({ kind: "confirming_delete", request: { kind: "busy" } });
  try {
    await actions.delete(item);
    window.location.reload();
  } catch {
    setState({
      kind: "confirming_delete",
      request: {
        kind: "failed",
        message: "Pantry could not delete this organisation. Try again.",
      },
    });
  }
}

async function runOrganisationAction(
  action: () => Promise<void>,
  refresh: () => void,
  setState: React.Dispatch<React.SetStateAction<OrganisationRowState>>,
): Promise<void> {
  setState({ kind: "busy" });
  try {
    await action();
    setState({ kind: "idle" });
    refresh();
  } catch {
    setState({
      kind: "failed",
      message: "Pantry could not update this organisation. Try again.",
    });
  }
}

function renderOrganisationWorkspaces(
  item: OrganisationListItem,
): React.ReactNode {
  if (item.lifecycle === "archived") return null;
  if (item.workspaces.length === 0) {
    return (
      <p className="organisation-card-note">
        {item.role === "owner" || item.role === "admin"
          ? "No workspaces yet. Open the organisation to create one."
          : "No workspaces yet."}
      </p>
    );
  }
  const labelId = `organisation-workspaces-${item.organisationId}`;
  return (
    <div className="organisation-card-workspaces">
      <p className="eyebrow" id={labelId}>
        Workspaces
      </p>
      <ul aria-labelledby={labelId}>
        {item.workspaces.map(
          renderOrganisationWorkspace.bind(null, item.organisationHandle),
        )}
      </ul>
    </div>
  );
}

function renderOrganisationWorkspace(
  organisationHandle: string,
  workspace: OrganisationWorkspaceListItem,
): React.ReactNode {
  return (
    <li key={workspace.workspaceId}>
      <Link
        to={workspacePagePath(
          organisationHandle,
          workspace.workspaceHandle,
          "overview",
        )}
      >
        <span
          className="console-switcher-avatar console-switcher-workspace-avatar"
          aria-hidden="true"
        />
        <span>{workspace.name}</span>
        <ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" />
      </Link>
    </li>
  );
}

function organisationLifecycleNote(
  lifecycle: OrganisationOnboardingLifecycle["kind"],
  canManage: boolean,
): string | null {
  switch (lifecycle) {
    case "configuring":
      return "Not activated yet. Open the organisation to finish setup.";
    case "activating":
      return "Activation is in progress.";
    case "archived":
      return canManage
        ? "Archived. Unarchive it from the menu to use it again."
        : "Archived. Its owner can unarchive it.";
    case "active":
      return null;
    default:
      return assertNever(lifecycle, "Unhandled organisation value");
  }
}

function organisationRoleLabel(role: OnboardingControlRole): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    case "operator":
      return "Operator";
    case "viewer":
      return "Viewer";
    default:
      return assertNever(role, "Unhandled organisation value");
  }
}

function organisationPlanLabel(plan: string): string {
  return plan === "beta" ? "Beta" : "Organisation plan";
}

function organisationLifecycleLabel(
  lifecycle: OrganisationOnboardingLifecycle["kind"],
): string {
  switch (lifecycle) {
    case "configuring":
      return "Configuring";
    case "activating":
      return "Activating";
    case "active":
      return "Active";
    case "archived":
      return "Archived";
    default:
      return assertNever(lifecycle, "Unhandled organisation value");
  }
}

function WorkspaceSupportToolsPanel(props: {
  readonly tools: WorkspaceSupportTools;
}): React.ReactNode {
  const supportCase = props.tools.operatorCase;
  const errorId = "workspace-support-error";
  return (
    <section
      className="portal-band danger-band"
      aria-labelledby="workspace-maintenance-title"
    >
      <div>
        <h2 id="workspace-maintenance-title">Workspace maintenance</h2>
        <p>
          Enter a workspace ID to review an older workspace with no owner before
          archiving it.
        </p>
      </div>
      <form className="inline-form" onSubmit={props.tools.inspect}>
        <label>
          <span>Organisation ID</span>
          <input
            name="operatorOrganisationId"
            required
            placeholder="organisation_..."
            aria-invalid={props.tools.error !== null}
            aria-describedby={props.tools.error === null ? undefined : errorId}
          />
        </label>
        <button type="submit" disabled={props.tools.busy}>
          Inspect
        </button>
      </form>
      {props.tools.error === null ? null : (
        <p id={errorId} className="error-text" role="alert">
          {props.tools.error}
        </p>
      )}
      {supportCase === null ? null : (
        <div className="archive-confirm">
          <dl>
            <div>
              <dt>Organisation ID</dt>
              <dd>{supportCase.organisationId}</dd>
            </div>
            <div>
              <dt>Environment</dt>
              <dd>{supportEnvironmentLabel(supportCase.environment)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{supportCaseLifecycleLabel(supportCase.lifecycle)}</dd>
            </div>
            <div>
              <dt>Setup version</dt>
              <dd>#{supportCase.configurationVersion}</dd>
            </div>
          </dl>
          {supportCase.lifecycle === "active" ? (
            <ArchiveConfirm
              organisationName={supportCase.organisationId}
              busy={props.tools.busy}
              onArchive={props.tools.archive}
              confirmLabel="Archive workspace"
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

function supportEnvironmentLabel(environment: OnboardingEnvironment): string {
  return environment === "development" ? "Development" : "Production";
}

function supportCaseLifecycleLabel(lifecycle: string): string {
  switch (lifecycle) {
    case "active":
      return "Active";
    case "archived":
      return "Archived";
    case "draft":
      return "Draft";
    case "configuring":
      return "Configuring";
    case "activating":
      return "Activating";
    case "suspended":
      return "Suspended";
    default:
      return "Unknown status";
  }
}

import React from "react";
import { Check, CircleAlert, Plus } from "lucide-react";
import { Link } from "react-router";
import {
  readAccountOnboardingOptions,
  readAccountOnboardingRequest,
  readAccountOnboardingResult,
  type AccountOnboardingOptions,
  type AccountOnboardingOrganization,
  type AccountOnboardingRequest,
} from "@purin-labs/control-api";
import { assertNever, errorMessage, isRecord } from "@purin-labs/std";
import {
  ControlApiError,
  controlMutation,
  controlRead,
} from "../control-client";
import { organisationPath } from "../route";
import { AgentModal } from "./agent-modal";
import {
  JevSetupBody,
  jevSettingsPath,
  turnOnJevFeatures,
  type JevSetupState,
} from "./account-onboarding-jev";

/** What the Organisations page found after Pantry reported the setup ready. */
export type AccountSetupListing =
  | Readonly<{
      kind: "listed";
      organisationHandle: string;
      /** The first workspace, for the link to Settings › Jev. */
      workspaceHandle: string | null;
    }>
  | Readonly<{ kind: "missing" }>;

type AccountSetupStep =
  "organisation" | "project" | "billing" | "prepare" | "jev" | "done";

/** The choices of steps 1 to 3. Back keeps every choice and typed name. */
export type AccountSetupDraft = Readonly<{
  options: AccountOnboardingOptions;
  organization: string;
  organizationName: string;
  project: string;
  projectName: string;
}>;

type AccountSetupRecovery =
  | Readonly<{ kind: "options" }>
  | Readonly<{ kind: "sign_in" }>
  | Readonly<{ kind: "choose_project"; draft: AccountSetupDraft | null }>
  | Readonly<{ kind: "billing"; draft: AccountSetupDraft }>
  | Readonly<{
      kind: "request";
      request: AccountOnboardingRequest;
      draft: AccountSetupDraft | null;
    }>
  | Readonly<{
      kind: "listing";
      nativeOrganizationId: string;
      request: AccountOnboardingRequest;
      draft: AccountSetupDraft | null;
    }>
  | Readonly<{ kind: "new_project"; draft: AccountSetupDraft | null }>;

type AccountSetupFailure = Readonly<{
  step: AccountSetupStep;
  tone: "danger" | "warning";
  title: string;
  reason: string;
  next: string | null;
  detail: string | null;
  /** The label of the primary action. */
  action: string;
  signIn: boolean;
  recovery: AccountSetupRecovery;
  /** A second way forward, shown as a text action beside the primary one. */
  alternative?: Readonly<{ action: string; recovery: AccountSetupRecovery }>;
}>;

/**
 * A setup that Pantry accepted keeps its draft only in this tab. After a
 * reload the request is known but the names are not.
 */
export type AccountSetupView =
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "organisation";
      draft: AccountSetupDraft;
      problem: string | null;
    }>
  | Readonly<{
      kind: "project";
      draft: AccountSetupDraft;
      problem: string | null;
    }>
  | Readonly<{ kind: "billing"; draft: AccountSetupDraft }>
  | Readonly<{
      kind: "preparing";
      request: AccountOnboardingRequest;
      draft: AccountSetupDraft | null;
      startedAt: number;
    }>
  | Readonly<{
      kind: "finishing";
      nativeOrganizationId: string;
      request: AccountOnboardingRequest;
      draft: AccountSetupDraft | null;
      startedAt: number;
    }>
  | Readonly<{
      /** The optional Jev step (Plan 88). The organisation exists already. */
      kind: "jev";
      nativeOrganizationId: string;
      organisationHandle: string;
      workspaceHandle: string | null;
      draft: AccountSetupDraft | null;
      jev: JevSetupState;
    }>
  | Readonly<{
      kind: "done";
      nativeOrganizationId: string;
      organisationHandle: string;
      draft: AccountSetupDraft | null;
    }>
  | Readonly<{ kind: "failed"; failure: AccountSetupFailure }>;

export type OpenAccountSetupView = Exclude<
  AccountSetupView,
  { kind: "closed" }
>;

export type AccountSetupActions = Readonly<{
  close: () => void;
  chooseOrganisation: (id: string) => void;
  nameOrganisation: (name: string) => void;
  chooseProject: (id: string) => void;
  nameProject: (name: string) => void;
  back: () => void;
  next: () => void;
  recover: () => void;
  alternative: () => void;
  /** Turns on the three Jev switches of the new organisation. */
  turnOnJev: () => void;
}>;

type AccountSetupChoice = Readonly<{
  organisation: string;
  project: string;
  newOrganisation: boolean;
  newProject: boolean;
}>;

type StepState = "done" | "current" | "next" | "failed" | "attention";

export const ACCOUNT_SETUP_CREATE = "__create__";

const PATH = "/v1/control/account-onboarding";
const CREATE = ACCOUNT_SETUP_CREATE;
const FORM_ID = "satyr-account-setup";
const PROBLEM_ID = "satyr-account-setup-problem";
const SIGN_IN_PATH = "/v1/control/auth/google/start?returnTo=/portal";
const POLL_LIMIT = 60;
const STEPS: readonly Readonly<{ step: AccountSetupStep; label: string }>[] = [
  { step: "organisation", label: "Organisation" },
  { step: "project", label: "Project" },
  { step: "billing", label: "Billing" },
  { step: "prepare", label: "Prepare" },
  { step: "jev", label: "Jev" },
  { step: "done", label: "Done" },
];

function responseValue(raw: unknown): unknown {
  if (!isRecord(raw) || raw.ok !== true) {
    throw new Error("Account setup is unavailable. Retry or sign in again.");
  }
  return raw.value;
}

const SETUP_UNAVAILABLE = "Account setup is unavailable. Retry to continue.";

/** The server's own code, so that a person can report the exact failure. */
function errorCode(error: unknown): string | null {
  if (!(error instanceof ControlApiError) || !isRecord(error.details)) {
    return null;
  }
  const code = error.details.error ?? error.details.reason_code;
  return typeof code === "string" ? `Error code: ${code}` : null;
}

function sessionEnded(error: unknown): boolean {
  return error instanceof ControlApiError && error.kind === "session_ended";
}

function storedRequest(key: string): AccountOnboardingRequest | null {
  const raw = window.sessionStorage.getItem(key);
  if (raw === null) {
    return null;
  }
  try {
    return readAccountOnboardingRequest(JSON.parse(raw));
  } catch {
    window.sessionStorage.removeItem(key);
    return null;
  }
}

function forgetRequest(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Without browser storage there is no record to remove.
  }
}

function matchesId(id: string, value: Readonly<{ id: string }>): boolean {
  return value.id === id;
}

function draftOrganization(
  draft: AccountSetupDraft,
): AccountOnboardingOrganization | null {
  return (
    draft.options.organizations.find(
      matchesId.bind(null, draft.organization),
    ) ?? null
  );
}

function startDraft(options: AccountOnboardingOptions): AccountSetupDraft {
  const organization = options.organizations[0];
  return {
    options,
    organization: organization?.id ?? CREATE,
    organizationName: "",
    project: organization?.projects[0]?.id ?? CREATE,
    projectName: "Seams Pantry",
  };
}

function draftChoice(draft: AccountSetupDraft): AccountSetupChoice {
  const organization = draftOrganization(draft);
  const project =
    organization?.projects.find(matchesId.bind(null, draft.project)) ?? null;
  return {
    organisation: organization?.name ?? draft.organizationName.trim(),
    project: project?.name ?? draft.projectName.trim(),
    newOrganisation: organization === null,
    newProject: project === null,
  };
}

function draftSelection(draft: AccountSetupDraft): unknown {
  if (draft.organization === CREATE) {
    return {
      kind: "new_organization",
      organizationName: draft.organizationName,
      projectName: draft.projectName,
    };
  }
  if (draft.project === CREATE) {
    return {
      kind: "new_project",
      organizationId: draft.organization,
      projectName: draft.projectName,
    };
  }
  return {
    kind: "existing_project",
    organizationId: draft.organization,
    projectId: draft.project,
  };
}

function projectCount(organization: AccountOnboardingOrganization): string {
  const count = organization.projects.length;
  if (count === 0) {
    return "No projects";
  }
  return count === 1 ? "1 project" : `${count} projects`;
}

function formatSetupTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const rest = seconds % 60;
  return `${Math.floor(seconds / 60)}:${rest < 10 ? "0" : ""}${rest}`;
}

function sessionFailure(step: AccountSetupStep): AccountSetupFailure {
  return {
    step,
    tone: "danger",
    title: "Your session has ended",
    reason: "Sign in again to continue the setup.",
    next:
      step === "prepare" || step === "done"
        ? "Pantry keeps this setup and continues it after you sign in."
        : null,
    detail: null,
    action: "Sign in again",
    signIn: true,
    recovery: { kind: "sign_in" },
  };
}

function optionsFailure(error: unknown): AccountSetupFailure {
  if (sessionEnded(error)) {
    return sessionFailure("organisation");
  }
  return {
    step: "organisation",
    tone: "danger",
    title: "Pantry cannot read your account",
    reason: errorMessage(error, SETUP_UNAVAILABLE),
    next: "Try again. If the problem continues, sign in again.",
    detail: errorCode(error),
    action: "Try again",
    signIn: true,
    recovery: { kind: "options" },
  };
}

function startFailure(
  error: unknown,
  draft: AccountSetupDraft,
  storage: boolean,
): AccountSetupFailure {
  return {
    step: "billing",
    tone: "danger",
    title: "Pantry cannot start the setup",
    reason: errorMessage(error, SETUP_UNAVAILABLE),
    next: storage
      ? "Allow site data for this page, then try again."
      : "Check the names, then try again.",
    detail: null,
    action: "Try again",
    signIn: false,
    recovery: { kind: "billing", draft },
  };
}

function blockedFailure(
  error: ControlApiError,
  draft: AccountSetupDraft | null,
): AccountSetupFailure {
  return {
    step: "billing",
    tone: "danger",
    title: "This project cannot start Seams Pantry",
    reason: error.message,
    next: null,
    detail: errorCode(error),
    action: "Choose another project",
    signIn: false,
    recovery: { kind: "choose_project", draft },
  };
}

function stoppedFailure(
  error: unknown,
  request: AccountOnboardingRequest,
  draft: AccountSetupDraft | null,
): AccountSetupFailure {
  if (sessionEnded(error)) {
    return sessionFailure("prepare");
  }
  return {
    step: "prepare",
    tone: "danger",
    title: "The setup stopped",
    reason: errorMessage(error, SETUP_UNAVAILABLE),
    next: "Try again to continue the same setup. Pantry does not create a second organisation.",
    detail: errorCode(error),
    action: "Try again",
    signIn: true,
    recovery: { kind: "request", request, draft },
  };
}

function slowFailure(
  request: AccountOnboardingRequest,
  draft: AccountSetupDraft | null,
  startedAt: number,
): AccountSetupFailure {
  return {
    step: "prepare",
    tone: "warning",
    title: "The setup takes longer than usual",
    reason: `The setup is not finished after ${formatSetupTime(Date.now() - startedAt)}.`,
    next: "Check again to continue the same setup.",
    detail: null,
    action: "Check again",
    signIn: false,
    recovery: { kind: "request", request, draft },
  };
}

function listingFailure(
  nativeOrganizationId: string,
  request: AccountOnboardingRequest,
  draft: AccountSetupDraft | null,
  error: unknown,
): AccountSetupFailure {
  const listing: AccountSetupRecovery = {
    kind: "listing",
    nativeOrganizationId,
    request,
    draft,
  };
  if (error === null) {
    // The account platform can answer ready for a project whose old Pantry
    // organisation was deleted; a new project gets a new organisation.
    return {
      step: "done",
      tone: "danger",
      title: "Your organisation is not available",
      reason:
        "Pantry finished the setup, but your organisation list does not show the organisation.",
      next: "The project can still point to a deleted organisation. Create a new project for Seams Pantry, or check again.",
      detail: `Organisation ID: ${nativeOrganizationId}`,
      action: "Create a new project",
      signIn: false,
      recovery: { kind: "new_project", draft },
      alternative: { action: "Check again", recovery: listing },
    };
  }
  if (sessionEnded(error)) {
    return sessionFailure("done");
  }
  return {
    step: "done",
    tone: "danger",
    title: "Pantry cannot read your organisation list",
    reason: errorMessage(error, SETUP_UNAVAILABLE),
    next: "Your session can be out of date. Sign in again, then open this page.",
    detail: `Organisation ID: ${nativeOrganizationId}`,
    action: "Check again",
    signIn: true,
    recovery: listing,
  };
}

/** A new project for the same organisation; a typed new name stays. */
function newProjectDraft(draft: AccountSetupDraft): AccountSetupDraft {
  return {
    ...draft,
    project: CREATE,
    projectName: draft.project === CREATE ? draft.projectName : "",
  };
}

type AccountSetupProps = Readonly<{
  userId: string;
  /** Reads the session again and reports if it lists the organisation. */
  finish: (nativeOrganizationId: string) => Promise<AccountSetupListing>;
  organisationName: (nativeOrganizationId: string) => string | null;
  /**
   * True once the organisation list has loaded. A saved setup resumes only
   * then: its request would discard the list's early organisation reads.
   */
  resume: boolean;
}>;

/**
 * The setup dialog of the Organisations page. The page owns it, so it stays
 * open while the Portal reads the session again after Pantry is ready.
 * Selecting or creating a project is the setup action; there is no enable
 * step.
 */
export class AccountSetup extends React.Component<
  AccountSetupProps,
  { readonly view: AccountSetupView }
> {
  state: { readonly view: AccountSetupView } = { view: { kind: "closed" } };
  private timer: number | null = null;
  private disposed = false;
  private polls = 0;
  /**
   * Each read or poll belongs to one attempt. A result is used only while its
   * attempt is current: `this.state` can still hold the view before the last
   * `setState`, so it cannot tell if a result is stale.
   */
  private attempt = 0;
  private resumed = false;
  private readonly actions: AccountSetupActions = {
    close: this.close.bind(this),
    chooseOrganisation: this.chooseOrganisation.bind(this),
    nameOrganisation: this.nameOrganisation.bind(this),
    chooseProject: this.chooseProject.bind(this),
    nameProject: this.nameProject.bind(this),
    back: this.back.bind(this),
    next: this.next.bind(this),
    recover: this.recover.bind(this),
    alternative: this.alternative.bind(this),
    turnOnJev: this.turnOnJev.bind(this),
  };

  private get storageKey(): string {
    return `satyr:account-onboarding:${this.props.userId}`;
  }

  componentDidMount(): void {
    this.disposed = false;
    this.resumeSavedSetup();
  }

  componentDidUpdate(): void {
    this.resumeSavedSetup();
  }

  /** A reload or a new sign-in continues the setup that this tab started. */
  private resumeSavedSetup(): void {
    if (this.resumed || !this.props.resume) {
      return;
    }
    this.resumed = true;
    try {
      if (storedRequest(this.storageKey)) {
        this.open();
      }
    } catch {
      // Setup still renders; submission reports unavailable browser storage.
    }
  }

  componentWillUnmount(): void {
    this.disposed = true;
    this.stopTimer();
  }

  open(): void {
    void this.load();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    this.timer = null;
  }

  /** Ends the current attempt; its pending results are ignored. */
  private nextAttempt(): number {
    this.stopTimer();
    this.polls = 0;
    this.attempt += 1;
    return this.attempt;
  }

  private current(attempt: number): boolean {
    return !this.disposed && attempt === this.attempt;
  }

  private close(): void {
    this.nextAttempt();
    this.setState({ view: { kind: "closed" } });
  }

  private fail(failure: AccountSetupFailure): void {
    this.nextAttempt();
    this.setState({ view: { kind: "failed", failure } });
  }

  private async load(): Promise<void> {
    const attempt = this.nextAttempt();
    this.setState({ view: { kind: "loading" } });
    try {
      const saved = storedRequest(this.storageKey);
      if (saved) {
        await this.submit(attempt, saved, null, Date.now());
        return;
      }
      const options = readAccountOnboardingOptions(
        responseValue(await controlRead(PATH)),
      );
      if (this.current(attempt)) {
        this.setState({
          view: {
            kind: "organisation",
            draft: startDraft(options),
            problem: null,
          },
        });
      }
    } catch (error) {
      if (this.current(attempt)) {
        this.fail(optionsFailure(error));
      }
    }
  }

  private chooseOrganisation(id: string): void {
    const view = this.state.view;
    if (view.kind !== "organisation") {
      return;
    }
    const organization = view.draft.options.organizations.find(
      matchesId.bind(null, id),
    );
    this.setState({
      view: {
        kind: "organisation",
        draft: {
          ...view.draft,
          organization: organization?.id ?? CREATE,
          project: organization?.projects[0]?.id ?? CREATE,
        },
        problem: null,
      },
    });
  }

  private nameOrganisation(name: string): void {
    const view = this.state.view;
    if (view.kind !== "organisation") {
      return;
    }
    this.setState({
      view: {
        kind: "organisation",
        draft: { ...view.draft, organizationName: name },
        problem: null,
      },
    });
  }

  private chooseProject(id: string): void {
    const view = this.state.view;
    if (view.kind !== "project") {
      return;
    }
    this.setState({
      view: {
        kind: "project",
        draft: { ...view.draft, project: id },
        problem: null,
      },
    });
  }

  private nameProject(name: string): void {
    const view = this.state.view;
    if (view.kind !== "project") {
      return;
    }
    this.setState({
      view: {
        kind: "project",
        draft: { ...view.draft, projectName: name },
        problem: null,
      },
    });
  }

  private back(): void {
    const view = this.state.view;
    if (view.kind === "project") {
      this.setState({
        view: { kind: "organisation", draft: view.draft, problem: null },
      });
    } else if (view.kind === "billing") {
      this.setState({
        view: { kind: "project", draft: view.draft, problem: null },
      });
    }
  }

  private next(): void {
    const view = this.state.view;
    switch (view.kind) {
      case "organisation":
        if (
          view.draft.organization === CREATE &&
          view.draft.organizationName.trim() === ""
        ) {
          this.setState({
            view: { ...view, problem: "Enter a name for the organisation." },
          });
          return;
        }
        this.setState({
          view: { kind: "project", draft: view.draft, problem: null },
        });
        return;
      case "project":
        if (
          (view.draft.organization === CREATE ||
            view.draft.project === CREATE) &&
          view.draft.projectName.trim() === ""
        ) {
          this.setState({
            view: { ...view, problem: "Enter a name for the project." },
          });
          return;
        }
        this.setState({ view: { kind: "billing", draft: view.draft } });
        return;
      case "billing":
        this.start(view.draft);
        return;
      case "jev":
        // Skip and Continue: the switches stay as the step left them.
        if (view.jev.kind === "busy") return;
        this.setState({
          view: {
            kind: "done",
            nativeOrganizationId: view.nativeOrganizationId,
            organisationHandle: view.organisationHandle,
            draft: view.draft,
          },
        });
        return;
      default:
        return;
    }
  }

  /**
   * One choice turns on the three Jev switches. A switch that cannot turn on
   * shows its reason, and the person continues; it never blocks the setup.
   */
  private async turnOnJev(): Promise<void> {
    const view = this.state.view;
    if (view.kind !== "jev" || view.jev.kind !== "choose") return;
    const attempt = this.attempt;
    this.setState({ view: { ...view, jev: { kind: "busy" } } });
    const result = await turnOnJevFeatures(view.nativeOrganizationId);
    if (!this.current(attempt)) return;
    this.setState({ view: { ...view, jev: { kind: "result", result } } });
  }

  private start(draft: AccountSetupDraft): void {
    let request: AccountOnboardingRequest;
    try {
      request = readAccountOnboardingRequest({
        version: 1,
        operationId: crypto.randomUUID(),
        selection: draftSelection(draft),
      });
    } catch (error) {
      this.fail(startFailure(error, draft, false));
      return;
    }
    try {
      window.sessionStorage.setItem(this.storageKey, JSON.stringify(request));
    } catch (error) {
      this.fail(startFailure(error, draft, true));
      return;
    }
    void this.submit(this.nextAttempt(), request, draft, Date.now());
  }

  private async submit(
    attempt: number,
    request: AccountOnboardingRequest,
    draft: AccountSetupDraft | null,
    startedAt: number,
  ): Promise<void> {
    this.timer = null;
    if (!this.current(attempt)) {
      return;
    }
    this.setState({ view: { kind: "preparing", request, draft, startedAt } });
    try {
      const result = readAccountOnboardingResult(
        responseValue(await controlMutation(PATH, "POST", request)),
      );
      if (!this.current(attempt)) {
        return;
      }
      if (result.kind === "ready") {
        await this.finish(
          attempt,
          result.nativeOrganizationId,
          request,
          draft,
          startedAt,
        );
        return;
      }
      this.polls += 1;
      if (this.polls >= POLL_LIMIT) {
        this.fail(slowFailure(request, draft, startedAt));
        return;
      }
      this.timer = window.setTimeout(
        this.submit.bind(this, attempt, request, draft, startedAt),
        1000,
      );
    } catch (error) {
      if (!this.current(attempt)) {
        return;
      }
      if (
        error instanceof ControlApiError &&
        error.kind === "account_setup_blocked"
      ) {
        forgetRequest(this.storageKey);
        this.fail(blockedFailure(error, draft));
        return;
      }
      this.fail(stoppedFailure(error, request, draft));
    }
  }

  /**
   * Pantry is ready only for the person who can see the organisation. The
   * setup record stays until the session lists it, so a reload or a new sign
   * in checks the same setup again.
   */
  private async finish(
    attempt: number,
    nativeOrganizationId: string,
    request: AccountOnboardingRequest,
    draft: AccountSetupDraft | null,
    startedAt: number,
  ): Promise<void> {
    this.setState({
      view: {
        kind: "finishing",
        nativeOrganizationId,
        request,
        draft,
        startedAt,
      },
    });
    let listing: AccountSetupListing;
    try {
      listing = await this.props.finish(nativeOrganizationId);
    } catch (error) {
      if (this.current(attempt)) {
        this.fail(listingFailure(nativeOrganizationId, request, draft, error));
      }
      return;
    }
    if (listing.kind === "listed") {
      forgetRequest(this.storageKey);
    }
    if (!this.current(attempt)) {
      return;
    }
    if (listing.kind === "missing") {
      this.fail(listingFailure(nativeOrganizationId, request, draft, null));
      return;
    }
    this.setState({
      view: {
        kind: "jev",
        nativeOrganizationId,
        organisationHandle: listing.organisationHandle,
        workspaceHandle: listing.workspaceHandle,
        draft,
        jev: { kind: "choose" },
      },
    });
  }

  private recover(): void {
    const view = this.state.view;
    if (view.kind === "failed") {
      this.runRecovery(view.failure.recovery);
    }
  }

  private alternative(): void {
    const view = this.state.view;
    if (view.kind === "failed" && view.failure.alternative !== undefined) {
      this.runRecovery(view.failure.alternative.recovery);
    }
  }

  private runRecovery(recovery: AccountSetupRecovery): void {
    switch (recovery.kind) {
      case "options":
        void this.load();
        return;
      case "sign_in":
        window.location.assign(SIGN_IN_PATH);
        return;
      case "choose_project":
        if (recovery.draft === null) {
          void this.load();
        } else {
          this.setState({
            view: { kind: "project", draft: recovery.draft, problem: null },
          });
        }
        return;
      case "billing":
        this.setState({ view: { kind: "billing", draft: recovery.draft } });
        return;
      case "request":
        void this.submit(
          this.nextAttempt(),
          recovery.request,
          recovery.draft,
          Date.now(),
        );
        return;
      case "listing":
        void this.finish(
          this.nextAttempt(),
          recovery.nativeOrganizationId,
          recovery.request,
          recovery.draft,
          Date.now(),
        );
        return;
      case "new_project":
        // The old setup ends here; the new project starts a new operation.
        forgetRequest(this.storageKey);
        if (recovery.draft === null) {
          void this.load();
          return;
        }
        this.nextAttempt();
        this.setState({
          view: {
            kind: "project",
            draft: newProjectDraft(recovery.draft),
            problem: null,
          },
        });
        return;
      default:
        assertNever(recovery, "Unknown account setup recovery");
    }
  }

  render(): React.ReactNode {
    const view = this.state.view;
    if (view.kind === "closed") {
      return null;
    }
    return (
      <AccountSetupDialog
        view={view}
        actions={this.actions}
        organisationName={
          view.kind === "done"
            ? this.props.organisationName(view.nativeOrganizationId)
            : null
        }
      />
    );
  }
}

/** The step a view belongs to; a failure stays on the step that failed. */
function viewStep(view: OpenAccountSetupView): AccountSetupStep {
  switch (view.kind) {
    case "loading":
    case "organisation":
      return "organisation";
    case "project":
      return "project";
    case "billing":
      return "billing";
    case "preparing":
    case "finishing":
      return "prepare";
    case "jev":
      return "jev";
    case "done":
      return "done";
    case "failed":
      return view.failure.step;
    default:
      return assertNever(view, "Unknown account setup view");
  }
}

function stepState(
  view: OpenAccountSetupView,
  current: number,
  index: number,
): StepState {
  if (index < current) {
    return "done";
  }
  if (index > current) {
    return "next";
  }
  if (view.kind === "failed") {
    return view.failure.tone === "warning" ? "attention" : "failed";
  }
  return view.kind === "done" ? "done" : "current";
}

const STEP_STATE_TEXT: Record<StepState, string> = {
  done: ", done",
  current: ", current step",
  next: "",
  failed: ", failed",
  attention: ", needs attention",
};

function stepIndex(step: AccountSetupStep): number {
  return STEPS.findIndex(matchesStep.bind(null, step));
}

function matchesStep(
  step: AccountSetupStep,
  candidate: (typeof STEPS)[number],
): boolean {
  return candidate.step === step;
}

function AccountSetupSteps(props: {
  readonly view: OpenAccountSetupView;
}): React.ReactNode {
  const current = stepIndex(viewStep(props.view));
  return (
    <ol className="account-setup-steps" aria-label="Setup steps">
      {STEPS.map(renderSetupStep.bind(null, props.view, current))}
    </ol>
  );
}

function renderSetupStep(
  view: OpenAccountSetupView,
  current: number,
  step: (typeof STEPS)[number],
  index: number,
): React.ReactNode {
  const state = stepState(view, current, index);
  return (
    <li
      key={step.step}
      className="account-setup-step"
      data-state={state}
      aria-current={index === current ? "step" : undefined}
    >
      <span className="account-setup-step-bar" aria-hidden="true" />
      <span className="account-setup-step-label">
        {step.label}
        <span className="visually-hidden">{STEP_STATE_TEXT[state]}</span>
      </span>
    </li>
  );
}

/**
 * Moves focus to the heading of each new step, so a screen reader reads it.
 * The modal is this dialog's child: its effect opens the dialog first, so
 * the heading also takes the focus on open, in place of the close button.
 */
function useStepFocus(
  heading: React.RefObject<HTMLHeadingElement | null>,
  key: string,
): void {
  React.useEffect(focusStepHeading.bind(null, heading), [key]);
}

function focusStepHeading(
  heading: React.RefObject<HTMLHeadingElement | null>,
): void {
  heading.current?.focus();
}

function focusKey(view: OpenAccountSetupView): string {
  if (view.kind === "failed") {
    return `failed:${view.failure.step}:${view.failure.title}`;
  }
  return view.kind === "loading" ? "loading" : viewStep(view);
}

export function AccountSetupDialog(props: {
  readonly view: OpenAccountSetupView;
  readonly actions: AccountSetupActions;
  readonly organisationName: string | null;
}): React.ReactNode {
  const heading = React.useRef<HTMLHeadingElement>(null);
  useStepFocus(heading, focusKey(props.view));
  return (
    <AgentModal
      className="account-setup-modal"
      title="Set up Seams Pantry"
      description={`Step ${stepIndex(viewStep(props.view)) + 1} of ${STEPS.length}`}
      close={props.actions.close}
      footer={setupFooter(props.view, props.actions)}
    >
      <AccountSetupSteps view={props.view} />
      <div className="account-setup-body">
        {setupBody(props.view, props.actions, props.organisationName, heading)}
      </div>
    </AgentModal>
  );
}

function SetupIntro(props: {
  readonly heading: React.RefObject<HTMLHeadingElement | null>;
  readonly title: string;
  readonly lead: string;
  readonly live?: boolean;
}): React.ReactNode {
  return (
    <div className="account-setup-intro">
      <h4 ref={props.heading} tabIndex={-1} className="account-setup-heading">
        {props.title}
      </h4>
      <p
        className="account-setup-lead"
        role={props.live === true ? "status" : undefined}
      >
        {props.lead}
      </p>
    </div>
  );
}

function setupBody(
  view: OpenAccountSetupView,
  actions: AccountSetupActions,
  organisationName: string | null,
  heading: React.RefObject<HTMLHeadingElement | null>,
): React.ReactNode {
  switch (view.kind) {
    case "loading":
      return (
        <>
          <SetupIntro
            heading={heading}
            title="Choose an organisation"
            lead="Pantry gets the organisations from your account."
            live
          />
          <div className="account-setup-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </>
      );
    case "organisation":
      return (
        <OrganisationChoices
          draft={view.draft}
          problem={view.problem}
          actions={actions}
          heading={heading}
        />
      );
    case "project":
      return (
        <ProjectChoices
          draft={view.draft}
          problem={view.problem}
          actions={actions}
          heading={heading}
        />
      );
    case "billing":
      return (
        <BillingSummary
          draft={view.draft}
          actions={actions}
          heading={heading}
        />
      );
    case "preparing":
    case "finishing":
      return (
        <SetupProgress
          draft={view.draft}
          startedAt={view.startedAt}
          finishing={view.kind === "finishing"}
          heading={heading}
        />
      );
    case "jev":
      return (
        <JevSetupBody
          heading={heading}
          state={view.jev}
          settingsPath={jevSettingsPath(
            view.organisationHandle,
            view.workspaceHandle,
          )}
        />
      );
    case "done":
      return (
        <div className="account-setup-result">
          <span className="account-setup-result-mark" aria-hidden="true">
            <Check size={22} strokeWidth={2.25} />
          </span>
          <SetupIntro
            heading={heading}
            title="Seams Pantry is ready"
            lead={
              organisationName === null
                ? "The new organisation is in your organisation list. Open it to start."
                : `${organisationName} is in your organisation list. Open it to start.`
            }
          />
        </div>
      );
    case "failed":
      return <SetupProblem failure={view.failure} heading={heading} />;
    default:
      return assertNever(view, "Unknown account setup view");
  }
}

function submitSetupStep(
  actions: AccountSetupActions,
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  actions.next();
}

function chooseSetupValue(
  choose: (value: string) => void,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  choose(event.currentTarget.value);
}

function SetupChoice(props: {
  readonly group: string;
  readonly value: string;
  readonly checked: boolean;
  readonly title: string;
  readonly detail: string;
  readonly create: boolean;
  readonly choose: (value: string) => void;
  readonly children?: React.ReactNode;
}): React.ReactNode {
  return (
    <div
      className="account-setup-choice"
      data-selected={props.checked ? "true" : "false"}
    >
      <label className="account-setup-choice-head">
        <input
          type="radio"
          name={props.group}
          value={props.value}
          checked={props.checked}
          onChange={chooseSetupValue.bind(null, props.choose)}
        />
        <span className="account-setup-choice-tile" aria-hidden="true">
          {props.create ? (
            <Plus size={16} strokeWidth={1.75} />
          ) : (
            props.title.trim().charAt(0).toUpperCase()
          )}
        </span>
        <span className="account-setup-choice-text">
          <strong>{props.title}</strong>
          <small>{props.detail}</small>
        </span>
        <span className="account-setup-choice-check" aria-hidden="true">
          <Check size={13} strokeWidth={2.25} />
        </span>
      </label>
      {props.checked ? props.children : null}
    </div>
  );
}

function changeSetupName(
  name: (value: string) => void,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  name(event.currentTarget.value);
}

/** A missing name sends the person back to the field that needs it. */
function focusInvalidName(
  input: React.RefObject<HTMLInputElement | null>,
  problem: string | null,
): void {
  if (problem !== null) {
    input.current?.focus();
  }
}

function SetupNameField(props: {
  readonly label: string;
  readonly field: string;
  readonly value: string;
  readonly problem: string | null;
  readonly change: (value: string) => void;
}): React.ReactNode {
  const input = React.useRef<HTMLInputElement>(null);
  React.useEffect(focusInvalidName.bind(null, input, props.problem), [
    props.problem,
  ]);
  return (
    <div className="account-setup-name">
      <label>
        <span>{props.label}</span>
        <input
          ref={input}
          name={props.field}
          value={props.value}
          maxLength={200}
          autoComplete="off"
          aria-invalid={props.problem !== null}
          aria-describedby={props.problem === null ? undefined : PROBLEM_ID}
          onChange={changeSetupName.bind(null, props.change)}
        />
      </label>
      {props.problem === null ? null : (
        <p id={PROBLEM_ID} className="error-text" role="alert">
          {props.problem}
        </p>
      )}
    </div>
  );
}

function renderOrganisationChoice(
  draft: AccountSetupDraft,
  actions: AccountSetupActions,
  organization: AccountOnboardingOrganization,
): React.ReactNode {
  return (
    <SetupChoice
      key={organization.id}
      group="organisation"
      value={organization.id}
      checked={draft.organization === organization.id}
      title={organization.name}
      detail={projectCount(organization)}
      create={false}
      choose={actions.chooseOrganisation}
    />
  );
}

function OrganisationChoices(props: {
  readonly draft: AccountSetupDraft;
  readonly problem: string | null;
  readonly actions: AccountSetupActions;
  readonly heading: React.RefObject<HTMLHeadingElement | null>;
}): React.ReactNode {
  const organizations = props.draft.options.organizations;
  return (
    <form
      id={FORM_ID}
      className="account-setup-form"
      noValidate
      onSubmit={submitSetupStep.bind(null, props.actions)}
    >
      <SetupIntro
        heading={props.heading}
        title="Choose an organisation"
        lead={
          organizations.length === 0
            ? "Your account has no organisations. Create one for Seams Pantry."
            : "Seams Pantry runs in an organisation of your account. Choose one, or create a new one."
        }
      />
      <fieldset className="account-setup-choices">
        <legend className="visually-hidden">
          Organisations in your account
        </legend>
        {organizations.map(
          renderOrganisationChoice.bind(null, props.draft, props.actions),
        )}
        <SetupChoice
          group="organisation"
          value={CREATE}
          checked={props.draft.organization === CREATE}
          title="Create an organisation"
          detail="Pantry creates it in your account."
          create
          choose={props.actions.chooseOrganisation}
        >
          <SetupNameField
            label="Organisation name"
            field="organizationName"
            value={props.draft.organizationName}
            problem={props.problem}
            change={props.actions.nameOrganisation}
          />
        </SetupChoice>
      </fieldset>
    </form>
  );
}

function renderProjectChoice(
  draft: AccountSetupDraft,
  actions: AccountSetupActions,
  project: Readonly<{ id: string; name: string }>,
): React.ReactNode {
  return (
    <SetupChoice
      key={project.id}
      group="project"
      value={project.id}
      checked={draft.project === project.id}
      title={project.name}
      detail="Existing project"
      create={false}
      choose={actions.chooseProject}
    />
  );
}

function ProjectChoices(props: {
  readonly draft: AccountSetupDraft;
  readonly problem: string | null;
  readonly actions: AccountSetupActions;
  readonly heading: React.RefObject<HTMLHeadingElement | null>;
}): React.ReactNode {
  const organization = draftOrganization(props.draft);
  const name = organization?.name ?? props.draft.organizationName.trim();
  return (
    <form
      id={FORM_ID}
      className="account-setup-form"
      noValidate
      onSubmit={submitSetupStep.bind(null, props.actions)}
    >
      <SetupIntro
        heading={props.heading}
        title="Choose a project"
        lead={
          organization === null
            ? `${name} is a new organisation. Pantry creates a project in it.`
            : `Seams Pantry uses one project in ${name}. The project holds the account and billing for Pantry.`
        }
      />
      <fieldset className="account-setup-choices">
        <legend className="visually-hidden">Projects in {name}</legend>
        {(organization?.projects ?? []).map(
          renderProjectChoice.bind(null, props.draft, props.actions),
        )}
        <SetupChoice
          group="project"
          value={CREATE}
          checked={props.draft.project === CREATE}
          title="Create a project"
          detail={`Pantry creates it in ${name}.`}
          create
          choose={props.actions.chooseProject}
        >
          <SetupNameField
            label="Project name"
            field="projectName"
            value={props.draft.projectName}
            problem={props.problem}
            change={props.actions.nameProject}
          />
        </SetupChoice>
      </fieldset>
    </form>
  );
}

function SetupSummary(props: {
  readonly choice: AccountSetupChoice;
  readonly billing: boolean;
}): React.ReactNode {
  return (
    <dl className="account-setup-summary">
      <div>
        <dt>Organisation</dt>
        <dd>
          <span>{props.choice.organisation}</span>
          {props.choice.newOrganisation ? (
            <span className="account-setup-tag">New</span>
          ) : null}
        </dd>
      </div>
      <div>
        <dt>Project</dt>
        <dd>
          <span>{props.choice.project}</span>
          {props.choice.newProject ? (
            <span className="account-setup-tag">New</span>
          ) : null}
        </dd>
      </div>
      {props.billing ? (
        <div>
          <dt>Billing</dt>
          <dd>Pantry uses the billing of this project.</dd>
        </div>
      ) : null}
    </dl>
  );
}

function BillingSummary(props: {
  readonly draft: AccountSetupDraft;
  readonly actions: AccountSetupActions;
  readonly heading: React.RefObject<HTMLHeadingElement | null>;
}): React.ReactNode {
  const choice = draftChoice(props.draft);
  return (
    <form
      id={FORM_ID}
      className="account-setup-form"
      noValidate
      onSubmit={submitSetupStep.bind(null, props.actions)}
    >
      <SetupIntro
        heading={props.heading}
        title="Confirm billing"
        lead="Seams Pantry uses the account and billing of this project. Check the details before you start."
      />
      <SetupSummary choice={choice} billing />
      {choice.newOrganisation || choice.newProject ? (
        <p className="account-setup-note">
          Pantry creates the new items in your account when you select Start
          setup.
        </p>
      ) : null}
    </form>
  );
}

function SetupClock(props: { readonly startedAt: number }): React.ReactNode {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(startSetupClock.bind(null, setNow), []);
  return (
    <span className="account-setup-clock">
      Time: {formatSetupTime(now - props.startedAt)}
    </span>
  );
}

function startSetupClock(
  setNow: React.Dispatch<React.SetStateAction<number>>,
): () => void {
  const timer = window.setInterval(tickSetupClock.bind(null, setNow), 1000);
  return window.clearInterval.bind(window, timer);
}

function tickSetupClock(
  setNow: React.Dispatch<React.SetStateAction<number>>,
): void {
  setNow(Date.now());
}

function SetupProgress(props: {
  readonly draft: AccountSetupDraft | null;
  readonly startedAt: number;
  readonly finishing: boolean;
  readonly heading: React.RefObject<HTMLHeadingElement | null>;
}): React.ReactNode {
  return (
    <>
      <SetupIntro
        heading={props.heading}
        title="Seams Pantry prepares your organisation"
        lead="This can take a few minutes. Keep this window open to see the result."
      />
      {props.draft === null ? null : (
        <SetupSummary choice={draftChoice(props.draft)} billing={false} />
      )}
      <div className="account-setup-progress-block">
        <div
          className="account-setup-progress"
          role="progressbar"
          aria-label="Setup progress"
        >
          <span />
        </div>
        <div className="account-setup-status">
          <span role="status">
            {props.finishing
              ? "Pantry adds the organisation to your list."
              : "The setup is in progress."}
          </span>
          <SetupClock startedAt={props.startedAt} />
        </div>
      </div>
      <p className="account-setup-note">
        If you close this window, Pantry continues the setup when you open this
        page again.
      </p>
    </>
  );
}

function SetupProblem(props: {
  readonly failure: AccountSetupFailure;
  readonly heading: React.RefObject<HTMLHeadingElement | null>;
}): React.ReactNode {
  return (
    <div
      className="account-setup-problem"
      data-tone={props.failure.tone}
      role="alert"
    >
      <span className="account-setup-problem-mark" aria-hidden="true">
        <CircleAlert size={20} strokeWidth={1.75} />
      </span>
      <div className="account-setup-problem-copy">
        <h4 ref={props.heading} tabIndex={-1} className="account-setup-heading">
          {props.failure.title}
        </h4>
        <p>{props.failure.reason}</p>
        {props.failure.next === null ? null : <p>{props.failure.next}</p>}
        {props.failure.detail === null ? null : (
          <p className="account-setup-detail">{props.failure.detail}</p>
        )}
      </div>
    </div>
  );
}

function SecondaryButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly back?: boolean;
  readonly disabled?: boolean;
}): React.ReactNode {
  return (
    <button
      type="button"
      disabled={props.disabled}
      className={
        props.back === true
          ? "modal-secondary-button account-setup-back"
          : "modal-secondary-button"
      }
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function SubmitButton(props: { readonly label: string }): React.ReactNode {
  return (
    <button type="submit" form={FORM_ID} className="modal-primary-button">
      {props.label}
    </button>
  );
}

function setupFooter(
  view: OpenAccountSetupView,
  actions: AccountSetupActions,
): React.ReactNode {
  switch (view.kind) {
    case "loading":
      return <SecondaryButton label="Cancel" onClick={actions.close} />;
    case "organisation":
      return (
        <>
          <SecondaryButton label="Cancel" onClick={actions.close} />
          <SubmitButton label="Continue" />
        </>
      );
    case "project":
      return (
        <>
          <SecondaryButton label="Back" onClick={actions.back} back />
          <SubmitButton label="Continue" />
        </>
      );
    case "billing":
      return (
        <>
          <SecondaryButton label="Back" onClick={actions.back} back />
          <SubmitButton label="Start setup" />
        </>
      );
    case "preparing":
    case "finishing":
      return <SecondaryButton label="Close" onClick={actions.close} />;
    case "jev":
      return view.jev.kind === "result" ? (
        <button
          type="button"
          className="modal-primary-button"
          onClick={actions.next}
        >
          Continue
        </button>
      ) : (
        <>
          <SecondaryButton
            label="Skip"
            onClick={actions.next}
            disabled={view.jev.kind === "busy"}
          />
          <button
            type="button"
            className="modal-primary-button"
            onClick={actions.turnOnJev}
            disabled={view.jev.kind === "busy"}
          >
            {view.jev.kind === "busy" ? "Turning on Jev…" : "Turn on Jev"}
          </button>
        </>
      );
    case "done":
      return (
        <>
          <SecondaryButton label="Close" onClick={actions.close} />
          <Link
            className="modal-primary-button account-setup-link"
            to={organisationPath(view.organisationHandle)}
          >
            Open organisation
          </Link>
        </>
      );
    case "failed":
      return failureFooter(view.failure, actions);
    default:
      return assertNever(view, "Unknown account setup view");
  }
}

function failureFooter(
  failure: AccountSetupFailure,
  actions: AccountSetupActions,
): React.ReactNode {
  if (failure.recovery.kind === "sign_in") {
    return (
      <>
        <SecondaryButton label="Close" onClick={actions.close} />
        <a
          className="modal-primary-button account-setup-link"
          href={SIGN_IN_PATH}
        >
          {failure.action}
        </a>
      </>
    );
  }
  return (
    <>
      {failure.alternative !== undefined ? (
        <SecondaryButton
          label={failure.alternative.action}
          onClick={actions.alternative}
          back
        />
      ) : failure.signIn ? (
        <a
          className="modal-secondary-button account-setup-link"
          href={SIGN_IN_PATH}
        >
          Sign in again
        </a>
      ) : (
        <SecondaryButton label="Close" onClick={actions.close} />
      )}
      <button
        type="button"
        className="modal-primary-button"
        onClick={actions.recover}
      >
        {failure.action}
      </button>
    </>
  );
}

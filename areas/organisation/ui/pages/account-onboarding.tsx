import React from "react";
import { Check, CircleAlert } from "lucide-react";
import { Link } from "react-router";
import {
  ORGANISATION_NAME_MAX,
  readOrganisationCreationRequest,
  type CreatedOrganisation,
  type OrganisationCreationRequest,
} from "@purin-labs/control-api";
import { assertNever, errorMessage, isRecord } from "@purin-labs/std";
import { ControlApiError } from "@purin-labs/control/portal/control-client";
import { signInPath } from "@purin-labs/control/portal/control-paths";
import { createOrganisation } from "../features/access/organisation-requests";
import { organisationPath } from "@purin-labs/ui/route";
import { AgentModal } from "./agent-modal";
import {
  JevSetupBody,
  jevSettingsPath,
  turnOnJevFeatures,
  type JevSetupState,
} from "./account-onboarding-jev";
import "./account-onboarding.css";

/** What the Organisations page found after Pantry made the organisation. */
export type AccountSetupListing =
  | Readonly<{
      kind: "listed";
      organisationHandle: string;
      /** The first workspace, for the link to Settings › Jev. */
      workspaceHandle: string | null;
    }>
  | Readonly<{ kind: "missing" }>;

type AccountSetupStep = "organisation" | "prepare" | "jev" | "done";

type AccountSetupRecovery =
  | Readonly<{ kind: "sign_in" }>
  | Readonly<{ kind: "close" }>
  /** Back to the name step. The next Create starts a new setup. */
  | Readonly<{ kind: "name"; name: string }>
  /** The same setup again: Pantry answers the same organisation. */
  | Readonly<{ kind: "request"; request: OrganisationCreationRequest }>
  | Readonly<{
      kind: "listing";
      organisationId: string;
      request: OrganisationCreationRequest;
    }>;

type AccountSetupFailure = Readonly<{
  step: AccountSetupStep;
  title: string;
  reason: string;
  next: string | null;
  detail: string | null;
  /** The label of the primary action. */
  action: string;
  /** A sign-in link beside the primary action. */
  signIn: boolean;
  recovery: AccountSetupRecovery;
}>;

/**
 * A view after the name step knows the request, so a reload, a retry or a
 * new sign-in sends the same operation id and makes no second organisation.
 */
type AccountSetupView =
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "organisation"; name: string; problem: string | null }>
  | Readonly<{ kind: "preparing"; request: OrganisationCreationRequest }>
  | Readonly<{
      kind: "finishing";
      organisationId: string;
      request: OrganisationCreationRequest;
    }>
  | Readonly<{
      /** The optional Jev step (Plan 88). The organisation exists already. */
      kind: "jev";
      organisationId: string;
      organisationHandle: string;
      workspaceHandle: string | null;
      name: string;
      jev: JevSetupState;
    }>
  | Readonly<{ kind: "done"; organisationHandle: string; name: string }>
  | Readonly<{ kind: "failed"; failure: AccountSetupFailure }>;

export type OpenAccountSetupView = Exclude<
  AccountSetupView,
  { kind: "closed" }
>;

export type AccountSetupActions = Readonly<{
  close: () => void;
  nameOrganisation: (name: string) => void;
  next: () => void;
  recover: () => void;
  /** Turns on the three Jev switches of the new organisation. */
  turnOnJev: () => void;
}>;

type StepState = "done" | "current" | "next" | "failed";

const FORM_ID = "pantry-account-setup";
const PROBLEM_ID = "pantry-account-setup-problem";
const SIGN_IN_PATH = signInPath("/portal");
const SETUP_UNAVAILABLE = "Pantry could not make the organisation. Try again.";
const STEPS: readonly Readonly<{ step: AccountSetupStep; label: string }>[] = [
  { step: "organisation", label: "Organisation" },
  { step: "prepare", label: "Prepare" },
  { step: "jev", label: "Jev" },
  { step: "done", label: "Done" },
];

/** The server's own code, so that a person can report the exact failure. */
function errorCode(error: unknown): string | null {
  if (!(error instanceof ControlApiError) || !isRecord(error.details)) {
    return null;
  }
  const code = error.details.error ?? error.details.reason_code;
  return typeof code === "string" ? `Error code: ${code}` : null;
}

/** The setup that this tab started, or null. A damaged value is removed. */
function storedRequest(key: string): OrganisationCreationRequest | null {
  const raw = window.sessionStorage.getItem(key);
  if (raw === null) {
    return null;
  }
  let request: OrganisationCreationRequest | null;
  try {
    request = readOrganisationCreationRequest(JSON.parse(raw));
  } catch {
    request = null;
  }
  if (request === null) {
    window.sessionStorage.removeItem(key);
  }
  return request;
}

function forgetRequest(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Without browser storage there is no record to remove.
  }
}

/** A refusal that the same request cannot change ends the saved setup. */
function endsSetup(error: unknown): boolean {
  if (!(error instanceof ControlApiError)) {
    return false;
  }
  switch (error.kind) {
    case "organisation_create_invalid":
    case "organisation_owner_unverified":
    case "organisation_limit_reached":
    case "idempotency_key_conflict":
      return true;
    default:
      return false;
  }
}

function sessionFailure(step: AccountSetupStep): AccountSetupFailure {
  return {
    step,
    title: "Your session has ended",
    reason: "Sign in again to continue the setup.",
    next: "Pantry keeps this setup and continues it after you sign in.",
    detail: null,
    action: "Sign in again",
    signIn: true,
    recovery: { kind: "sign_in" },
  };
}

function storageFailure(name: string): AccountSetupFailure {
  return {
    step: "organisation",
    title: "Pantry cannot keep this setup",
    reason: "This browser does not let Pantry keep the setup in this tab.",
    next: "Allow site data for this page, then try again.",
    detail: null,
    action: "Try again",
    signIn: false,
    recovery: { kind: "name", name },
  };
}

/** The failure view of a refused or lost create request. */
function createFailure(
  error: unknown,
  request: OrganisationCreationRequest,
): AccountSetupFailure {
  const reason = errorMessage(error, SETUP_UNAVAILABLE);
  const detail = errorCode(error);
  switch (error instanceof ControlApiError ? error.kind : "unknown") {
    case "session_ended":
      return sessionFailure("prepare");
    case "organisation_owner_unverified":
      return {
        step: "organisation",
        title: "Pantry needs a verified email",
        reason,
        next: null,
        detail,
        action: "Sign in with another account",
        signIn: true,
        recovery: { kind: "sign_in" },
      };
    case "organisation_limit_reached":
      return {
        step: "organisation",
        title: "You cannot own more organisations",
        reason,
        next: null,
        detail,
        action: "Close",
        signIn: false,
        recovery: { kind: "close" },
      };
    case "idempotency_key_conflict":
      return {
        step: "prepare",
        title: "This setup changed",
        reason: "Pantry used this setup for a different name.",
        next: "Start again to make a new setup.",
        detail,
        action: "Start again",
        signIn: false,
        recovery: { kind: "name", name: request.name },
      };
    default:
      return {
        step: "prepare",
        title: "The setup stopped",
        reason,
        next: "Try again to continue the same setup. Pantry does not make a second organisation.",
        detail,
        action: "Try again",
        signIn: true,
        recovery: { kind: "request", request },
      };
  }
}

function listingFailure(
  organisationId: string,
  request: OrganisationCreationRequest,
  error: unknown,
): AccountSetupFailure {
  if (error instanceof ControlApiError && error.kind === "session_ended") {
    return sessionFailure("prepare");
  }
  const listing = { kind: "listing", organisationId, request } as const;
  return error === null
    ? {
        step: "prepare",
        title: "Your organisation is not in your list",
        reason:
          "Pantry made the organisation, but your organisation list does not show it.",
        next: "Check again in a moment.",
        detail: `Organisation ID: ${organisationId}`,
        action: "Check again",
        signIn: false,
        recovery: listing,
      }
    : {
        step: "prepare",
        title: "Pantry cannot read your organisation list",
        reason: errorMessage(error, SETUP_UNAVAILABLE),
        next: "Your session can be out of date. Sign in again, then open this page.",
        detail: `Organisation ID: ${organisationId}`,
        action: "Check again",
        signIn: true,
        recovery: listing,
      };
}

type AccountSetupProps = Readonly<{
  userId: string;
  /** Reads the session again and reports if it lists the organisation. */
  finish: (organisationId: string) => Promise<AccountSetupListing>;
  /**
   * True once the organisation list has loaded. A saved setup resumes only
   * then: its request would discard the list's early organisation reads.
   */
  resume: boolean;
}>;

/**
 * The setup dialog of the Organisations page. The page owns it, so it stays
 * open while the Portal reads the session again after Pantry made the
 * organisation. The create request answers when the organisation exists.
 */
export class AccountSetup extends React.Component<
  AccountSetupProps,
  { readonly view: AccountSetupView }
> {
  state: { readonly view: AccountSetupView } = { view: { kind: "closed" } };
  private disposed = false;
  /**
   * Each request belongs to one attempt. A result is used only while its
   * attempt is current: `this.state` can still hold the view before the last
   * `setState`, so it cannot tell if a result is stale.
   */
  private attempt = 0;
  private resumed = false;
  private readonly actions: AccountSetupActions = {
    close: this.close.bind(this),
    nameOrganisation: this.nameOrganisation.bind(this),
    next: this.next.bind(this),
    recover: this.recover.bind(this),
    turnOnJev: this.turnOnJev.bind(this),
  };

  private get storageKey(): string {
    return `pantry:account-onboarding:${this.props.userId}`;
  }

  componentDidMount(): void {
    this.disposed = false;
    this.resumeSavedSetup();
  }

  componentDidUpdate(): void {
    this.resumeSavedSetup();
  }

  componentWillUnmount(): void {
    this.disposed = true;
  }

  /** A reload or a new sign-in continues the setup that this tab started. */
  private resumeSavedSetup(): void {
    if (this.resumed || !this.props.resume) {
      return;
    }
    this.resumed = true;
    if (this.savedRequest() !== null) {
      this.open();
    }
  }

  private savedRequest(): OrganisationCreationRequest | null {
    try {
      return storedRequest(this.storageKey);
    } catch {
      // Without browser storage the setup starts again; Create reports it.
      return null;
    }
  }

  /** Opens the dialog. A setup that this tab started continues. */
  open(): void {
    const saved = this.savedRequest();
    if (saved !== null) {
      void this.submit(this.nextAttempt(), saved);
      return;
    }
    this.nextAttempt();
    this.setState({ view: { kind: "organisation", name: "", problem: null } });
  }

  /** Ends the current attempt; its pending results are ignored. */
  private nextAttempt(): number {
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

  private showName(name: string, problem: string | null): void {
    this.nextAttempt();
    this.setState({ view: { kind: "organisation", name, problem } });
  }

  private nameOrganisation(name: string): void {
    if (this.state.view.kind === "organisation") {
      this.setState({ view: { kind: "organisation", name, problem: null } });
    }
  }

  private next(): void {
    const view = this.state.view;
    if (view.kind === "organisation") {
      this.start(view.name);
    } else if (view.kind === "jev" && view.jev.kind !== "busy") {
      // Skip and Continue: the switches stay as the step left them.
      this.setState({
        view: {
          kind: "done",
          organisationHandle: view.organisationHandle,
          name: view.name,
        },
      });
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
    const result = await turnOnJevFeatures(view.organisationId);
    if (!this.current(attempt)) return;
    this.setState({ view: { ...view, jev: { kind: "result", result } } });
  }

  /** A new setup: a new operation id, kept in this tab before the request. */
  private start(name: string): void {
    const request = readOrganisationCreationRequest({
      operationId: crypto.randomUUID(),
      name,
    });
    if (request === null) {
      this.showName(name, "Enter a name for the organisation.");
      return;
    }
    try {
      window.sessionStorage.setItem(this.storageKey, JSON.stringify(request));
    } catch {
      this.fail(storageFailure(name));
      return;
    }
    void this.submit(this.nextAttempt(), request);
  }

  private async submit(
    attempt: number,
    request: OrganisationCreationRequest,
  ): Promise<void> {
    if (!this.current(attempt)) {
      return;
    }
    this.setState({ view: { kind: "preparing", request } });
    let created: CreatedOrganisation;
    try {
      created = await createOrganisation(request);
    } catch (error) {
      if (!this.current(attempt)) {
        return;
      }
      if (endsSetup(error)) {
        forgetRequest(this.storageKey);
      }
      if (
        error instanceof ControlApiError &&
        error.kind === "organisation_create_invalid"
      ) {
        this.showName(request.name, error.message);
      } else {
        this.fail(createFailure(error, request));
      }
      return;
    }
    if (this.current(attempt)) {
      await this.finish(attempt, created.organisationId, request);
    }
  }

  /**
   * The setup record stays until the session lists the organisation, so a
   * reload or a new sign-in checks the same setup again.
   */
  private async finish(
    attempt: number,
    organisationId: string,
    request: OrganisationCreationRequest,
  ): Promise<void> {
    this.setState({ view: { kind: "finishing", organisationId, request } });
    let listing: AccountSetupListing;
    try {
      listing = await this.props.finish(organisationId);
    } catch (error) {
      if (this.current(attempt)) {
        this.fail(listingFailure(organisationId, request, error));
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
      this.fail(listingFailure(organisationId, request, null));
      return;
    }
    this.setState({
      view: {
        kind: "jev",
        organisationId,
        organisationHandle: listing.organisationHandle,
        workspaceHandle: listing.workspaceHandle,
        name: request.name,
        jev: { kind: "choose" },
      },
    });
  }

  private recover(): void {
    const view = this.state.view;
    if (view.kind !== "failed") {
      return;
    }
    const recovery = view.failure.recovery;
    switch (recovery.kind) {
      case "sign_in":
        window.location.assign(SIGN_IN_PATH);
        return;
      case "close":
        this.close();
        return;
      case "name":
        this.showName(recovery.name, null);
        return;
      case "request":
        void this.submit(this.nextAttempt(), recovery.request);
        return;
      case "listing":
        void this.finish(
          this.nextAttempt(),
          recovery.organisationId,
          recovery.request,
        );
        return;
      default:
        assertNever(recovery, "Unknown account setup recovery");
    }
  }

  render(): React.ReactNode {
    const view = this.state.view;
    return view.kind === "closed" ? null : (
      <AccountSetupDialog view={view} actions={this.actions} />
    );
  }
}

/** The step a view belongs to; a failure stays on the step that failed. */
function viewStep(view: OpenAccountSetupView): AccountSetupStep {
  switch (view.kind) {
    case "organisation":
      return "organisation";
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
    return "failed";
  }
  return view.kind === "done" ? "done" : "current";
}

const STEP_STATE_TEXT: Record<StepState, string> = {
  done: ", done",
  current: ", current step",
  next: "",
  failed: ", failed",
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
  return view.kind === "failed"
    ? `failed:${view.failure.step}:${view.failure.title}`
    : viewStep(view);
}

export function AccountSetupDialog(props: {
  readonly view: OpenAccountSetupView;
  readonly actions: AccountSetupActions;
}): React.ReactNode {
  const heading = React.useRef<HTMLHeadingElement>(null);
  useStepFocus(heading, focusKey(props.view));
  return (
    <AgentModal
      className="account-setup-modal"
      title="Set up Purin Pantry"
      description={`Step ${stepIndex(viewStep(props.view)) + 1} of ${STEPS.length}`}
      close={props.actions.close}
      footer={setupFooter(props.view, props.actions)}
    >
      <AccountSetupSteps view={props.view} />
      <div className="account-setup-body">
        {setupBody(props.view, props.actions, heading)}
      </div>
    </AgentModal>
  );
}

function SetupIntro(props: {
  readonly heading: React.RefObject<HTMLHeadingElement | null>;
  readonly title: string;
  readonly lead: string;
}): React.ReactNode {
  return (
    <div className="account-setup-intro">
      <h4 ref={props.heading} tabIndex={-1} className="account-setup-heading">
        {props.title}
      </h4>
      <p className="account-setup-lead">{props.lead}</p>
    </div>
  );
}

function setupBody(
  view: OpenAccountSetupView,
  actions: AccountSetupActions,
  heading: React.RefObject<HTMLHeadingElement | null>,
): React.ReactNode {
  switch (view.kind) {
    case "organisation":
      return (
        <OrganisationName
          name={view.name}
          problem={view.problem}
          actions={actions}
          heading={heading}
        />
      );
    case "preparing":
    case "finishing":
      return (
        <SetupProgress
          name={view.request.name}
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
            title="Purin Pantry is ready"
            lead={`${view.name} is in your organisation list. Open it to start.`}
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

function changeSetupName(
  name: (value: string) => void,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  name(event.currentTarget.value);
}

/** A refused name sends the person back to the field that needs it. */
function focusInvalidName(
  input: React.RefObject<HTMLInputElement | null>,
  problem: string | null,
): void {
  if (problem !== null) {
    input.current?.focus();
  }
}

function OrganisationName(props: {
  readonly name: string;
  readonly problem: string | null;
  readonly actions: AccountSetupActions;
  readonly heading: React.RefObject<HTMLHeadingElement | null>;
}): React.ReactNode {
  const input = React.useRef<HTMLInputElement>(null);
  React.useEffect(focusInvalidName.bind(null, input, props.problem), [
    props.problem,
  ]);
  return (
    <form
      id={FORM_ID}
      className="account-setup-form"
      noValidate
      onSubmit={submitSetupStep.bind(null, props.actions)}
    >
      <SetupIntro
        heading={props.heading}
        title="Name your organisation"
        lead="Purin Pantry makes a new organisation for your shop. You become its owner."
      />
      <div className="account-setup-name">
        <label>
          <span>Organisation name</span>
          <input
            ref={input}
            name="organisationName"
            value={props.name}
            maxLength={ORGANISATION_NAME_MAX}
            autoComplete="organization"
            aria-invalid={props.problem !== null}
            aria-describedby={props.problem === null ? undefined : PROBLEM_ID}
            onChange={changeSetupName.bind(
              null,
              props.actions.nameOrganisation,
            )}
          />
        </label>
        {props.problem === null ? null : (
          <p id={PROBLEM_ID} className="error-text" role="alert">
            {props.problem}
          </p>
        )}
      </div>
    </form>
  );
}

function SetupProgress(props: {
  readonly name: string;
  readonly finishing: boolean;
  readonly heading: React.RefObject<HTMLHeadingElement | null>;
}): React.ReactNode {
  return (
    <>
      <SetupIntro
        heading={props.heading}
        title="Purin Pantry prepares your organisation"
        lead="This takes a few seconds. Keep this window open to see the result."
      />
      <dl className="account-setup-summary">
        <div>
          <dt>Organisation</dt>
          <dd>{props.name}</dd>
        </div>
      </dl>
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
              : "Pantry makes the organisation."}
          </span>
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
    <div className="account-setup-problem" role="alert">
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
  readonly disabled?: boolean;
}): React.ReactNode {
  return (
    <button
      type="button"
      disabled={props.disabled}
      className="modal-secondary-button"
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function PrimaryButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}): React.ReactNode {
  return (
    <button
      type="button"
      disabled={props.disabled}
      className="modal-primary-button"
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function SignInLink(props: {
  readonly label: string;
  readonly primary: boolean;
}): React.ReactNode {
  return (
    <a
      className={`${props.primary ? "modal-primary-button" : "modal-secondary-button"} account-setup-link`}
      href={SIGN_IN_PATH}
    >
      {props.label}
    </a>
  );
}

function setupFooter(
  view: OpenAccountSetupView,
  actions: AccountSetupActions,
): React.ReactNode {
  switch (view.kind) {
    case "organisation":
      return (
        <>
          <SecondaryButton label="Cancel" onClick={actions.close} />
          <button type="submit" form={FORM_ID} className="modal-primary-button">
            Create organisation
          </button>
        </>
      );
    case "preparing":
    case "finishing":
      return <SecondaryButton label="Close" onClick={actions.close} />;
    case "jev":
      return view.jev.kind === "result" ? (
        <PrimaryButton label="Continue" onClick={actions.next} />
      ) : (
        <>
          <SecondaryButton
            label="Skip"
            onClick={actions.next}
            disabled={view.jev.kind === "busy"}
          />
          <PrimaryButton
            label={view.jev.kind === "busy" ? "Turning on Jev…" : "Turn on Jev"}
            onClick={actions.turnOnJev}
            disabled={view.jev.kind === "busy"}
          />
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
  switch (failure.recovery.kind) {
    case "sign_in":
      return (
        <>
          <SecondaryButton label="Close" onClick={actions.close} />
          <SignInLink label={failure.action} primary />
        </>
      );
    case "close":
      return <PrimaryButton label={failure.action} onClick={actions.close} />;
    default:
      return (
        <>
          {failure.signIn ? (
            <SignInLink label="Sign in again" primary={false} />
          ) : (
            <SecondaryButton label="Close" onClick={actions.close} />
          )}
          <PrimaryButton label={failure.action} onClick={actions.recover} />
        </>
      );
  }
}

import React from "react";
import { isRecord } from "@purin-labs/std";
import {
  ControlApiError,
  controlMutation,
  controlRead,
  controlSecretMutation,
} from "@purin-labs/control/portal/control-client";
import { Button, ConfirmInPlace } from "@purin-labs/ui/index";
import { StatusChip } from "@purin-labs/ui/page-components";
import type { StatusChipStatus } from "@purin-labs/ui/status-chip";
import { openAuthorizationPopup } from "./authorization-popup";
import {
  parseClaudeAuthorization,
  parseClaudeConnectionView,
  type ClaudeConnection,
  type ClaudeAuthorization,
  type ClaudeConnectionView,
} from "@purin-labs/control-api";
import { parseConnection } from "@purin-labs/control-api/portal/claude-connection";

export type ClaudeConnectionState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; view: ClaudeConnectionView }>;

type State = ClaudeConnectionState;

type SetState = React.Dispatch<React.SetStateAction<State>>;

/** The Claude sign-in window that this page opened, until the code arrives. */
type SignInWindow = React.RefObject<Window | null>;

/** The request in flight, so that only its control says so. */
type Busy = "start" | "connect" | "disconnect" | null;

/**
 * What the last request left for the operator to know.
 * `invalid_code`: the pasted text is not the complete code; the sign-in
 * stays open. `ended`: the sign-in can no longer finish, because it expired
 * or because Claude did not confirm the code, which uses it up.
 */
type Notice =
  | Readonly<{ kind: "invalid_code" }>
  | Readonly<{ kind: "ended"; reason: "expired" | "not_confirmed" }>
  | Readonly<{ kind: "failed"; message: string }>;

/** The one stage of the sign-in that the panel shows. */
type Stage =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unreadable"; message: string }>
  | Readonly<{ kind: "start"; again: boolean }>
  | Readonly<{ kind: "paste"; authorization: ClaudeAuthorization }>
  | Readonly<{ kind: "restart"; reason: "expired" | "not_confirmed" }>
  | Readonly<{ kind: "connected" }>;

type Controls = Readonly<{
  organisationId: string;
  setState: SetState;
  setBusy: React.Dispatch<React.SetStateAction<Busy>>;
  setNotice: React.Dispatch<React.SetStateAction<Notice | null>>;
  setCode: React.Dispatch<React.SetStateAction<string>>;
  setWindowBlocked: React.Dispatch<React.SetStateAction<boolean>>;
  signInWindow: SignInWindow;
}>;

export function useClaudeConnection(
  organisationId: string,
): readonly [State, SetState] {
  const [state, setState] = React.useState<State>({ kind: "loading" });
  React.useEffect(loadConnection.bind(null, organisationId, setState), [
    organisationId,
  ]);
  return [state, setState];
}

/**
 * The Claude account as one sequence: sign in to Claude in a window, paste
 * the code that Claude shows, then connected. Each stage shows only its own
 * controls.
 */
export function ClaudeConnectionPanel(
  props: Readonly<{
    organisationId: string;
    canManage: boolean;
    /** The saved source is Claude, so new conversations use this account. */
    inUse: boolean;
    /** False while a source change waits to be saved above this panel. */
    primary: boolean;
    state: State;
    setState: SetState;
  }>,
): React.ReactNode {
  const [busy, setBusy] = React.useState<Busy>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [code, setCode] = React.useState("");
  const [windowBlocked, setWindowBlocked] = React.useState(false);
  const signInWindow = React.useRef<Window | null>(null);
  const waiting =
    props.state.kind === "ready" &&
    props.state.view.authorization.kind === "authorizing";
  const now = useNow(waiting);
  const stage = signInStage(props.state, notice, now);
  const status = stageStatus(stage);
  const controls: Controls = {
    organisationId: props.organisationId,
    setState: props.setState,
    setBusy,
    setNotice,
    setCode,
    setWindowBlocked,
    signInWindow,
  };
  const failure = notice?.kind === "failed" ? notice.message : null;
  return (
    <div className="integration-setup codex-connection-state claude-sign-in">
      <div className="setup-heading">
        <h4>Claude account</h4>
        {status === null ? null : <StatusChip status={status} />}
      </div>
      {props.canManage ? <SignInSteps stage={stage} notice={notice} /> : null}
      <div key={stage.kind} className="claude-sign-in-stage">
        {renderStage(stage, {
          props,
          controls,
          busy,
          notice,
          code,
          windowBlocked,
          now,
        })}
        {failure === null ? null : (
          <p className="error-text claude-sign-in-error" role="alert">
            {failure}
          </p>
        )}
      </div>
    </div>
  );
}

type StageContext = Readonly<{
  props: Parameters<typeof ClaudeConnectionPanel>[0];
  controls: Controls;
  busy: Busy;
  notice: Notice | null;
  code: string;
  windowBlocked: boolean;
  now: number;
}>;

function signInStage(state: State, notice: Notice | null, now: number): Stage {
  if (state.kind === "loading") return { kind: "loading" };
  if (state.kind === "failed")
    return { kind: "unreadable", message: state.message };
  const { connection, authorization } = state.view;
  if (authorization.kind === "authorizing")
    return authorization.authorization.expiresAt <= now
      ? { kind: "restart", reason: "expired" }
      : { kind: "paste", authorization: authorization.authorization };
  if (notice?.kind === "ended")
    return { kind: "restart", reason: notice.reason };
  switch (connection.kind) {
    case "connected":
      return { kind: "connected" };
    case "action_required":
      return { kind: "start", again: true };
    case "disconnected":
      return { kind: "start", again: false };
  }
}

function stageStatus(stage: Stage): StatusChipStatus | null {
  switch (stage.kind) {
    case "loading":
      return null;
    case "unreadable":
      return { kind: "danger", label: "Unavailable" };
    case "start":
      return stage.again
        ? { kind: "warning", label: "Sign in again" }
        : { kind: "neutral", label: "Not connected" };
    case "paste":
      return { kind: "info", label: "Waiting for code" };
    case "restart":
      return stage.reason === "expired"
        ? { kind: "warning", label: "Expired" }
        : { kind: "danger", label: "Not connected" };
    case "connected":
      return { kind: "success", label: "Connected" };
  }
}

/**
 * Two segments, sign in and paste the code, in the style of the Portal's
 * other stepped dialogs. A connected account needs no steps.
 */
function SignInSteps(
  props: Readonly<{ stage: Stage; notice: Notice | null }>,
): React.ReactNode {
  const states = signInStepStates(props.stage, props.notice);
  if (states === null) return null;
  return (
    <ol className="claude-sign-in-steps" aria-label="Claude sign-in">
      {renderSignInStep("Sign in", states[0])}
      {renderSignInStep("Paste code", states[1])}
    </ol>
  );
}

type StepState = "done" | "current" | "next" | "failed" | "attention";

function signInStepStates(
  stage: Stage,
  notice: Notice | null,
): readonly [StepState, StepState] | null {
  switch (stage.kind) {
    case "start":
      return ["current", "next"];
    case "paste":
      return ["done", notice?.kind === "invalid_code" ? "failed" : "current"];
    case "restart":
      return ["done", stage.reason === "expired" ? "attention" : "failed"];
    case "loading":
    case "unreadable":
    case "connected":
      return null;
  }
}

function renderSignInStep(label: string, state: StepState): React.ReactNode {
  return (
    <li
      key={label}
      data-state={state}
      aria-current={
        state === "current" || state === "failed" || state === "attention"
          ? "step"
          : undefined
      }
    >
      <span className="claude-sign-in-step-bar" aria-hidden="true" />
      <span className="claude-sign-in-step-label">{label}</span>
    </li>
  );
}

function renderStage(stage: Stage, context: StageContext): React.ReactNode {
  switch (stage.kind) {
    case "loading":
      return (
        <p className="claude-sign-in-lead" role="status">
          Loading the Claude account…
        </p>
      );
    case "unreadable":
      return (
        <>
          <p className="claude-sign-in-lead">{stage.message}</p>
          <div className="claude-sign-in-actions">
            <Button
              variant="link"
              onClick={retryRead.bind(null, context.controls)}
            >
              Try again
            </Button>
          </div>
        </>
      );
    case "start":
      return renderStart(stage.again, context);
    case "paste":
      return renderPaste(stage.authorization, context);
    case "restart":
      return renderRestart(stage.reason, context);
    case "connected":
      return renderConnected(context);
  }
}

function renderIntro(title: string, lead: React.ReactNode): React.ReactNode {
  return (
    <div className="claude-sign-in-intro" aria-live="polite">
      <h5 className="claude-sign-in-title">{title}</h5>
      <p className="claude-sign-in-lead">{lead}</p>
    </div>
  );
}

function renderStart(again: boolean, context: StageContext): React.ReactNode {
  return (
    <>
      {renderIntro(
        again ? "Sign in to Claude again" : "Connect your Claude account",
        again
          ? "Claude ended the access for this workspace. Sign in again so that agents can use your Claude account."
          : "Claude opens in a new window. After you approve the access, Claude shows a code that you paste here. Anthropic can charge this use to paid usage credits.",
      )}
      {context.props.canManage ? (
        <div className="claude-sign-in-actions">
          {renderStartButton(context, "Sign in to Claude")}
          {again ? renderDisconnectButton(context) : null}
        </div>
      ) : (
        <p className="field-hint">An administrator can connect Claude.</p>
      )}
    </>
  );
}

function renderStartButton(
  context: StageContext,
  label: string,
): React.ReactNode {
  return (
    <Button
      variant={context.props.primary ? "primary" : "secondary"}
      disabled={context.busy !== null}
      onClick={startAuthorization.bind(null, context.controls)}
    >
      {context.busy === "start" ? "Opening Claude…" : label}
    </Button>
  );
}

function renderDisconnectButton(context: StageContext): React.ReactNode {
  return (
    <ConfirmInPlace
      label="Disconnect"
      question="Disconnect Claude?"
      consequence={
        context.props.inUse
          ? "Agents stop until you sign in again."
          : "You can sign in again later."
      }
      confirmLabel={
        context.busy === "disconnect" ? "Disconnecting…" : "Disconnect"
      }
      busy={context.busy !== null}
      onConfirm={disconnect.bind(null, context.controls)}
    />
  );
}

function renderPaste(
  authorization: ClaudeAuthorization,
  context: StageContext,
): React.ReactNode {
  const invalid = context.notice?.kind === "invalid_code";
  const lead = context.windowBlocked
    ? "Your browser did not open the Claude window. Select Open Claude, approve the access, then paste the code that Claude shows."
    : "Approve the access in the Claude window. Then copy the code that Claude shows and paste it here.";
  if (!context.props.canManage)
    return (
      <>
        {renderIntro("Waiting for the code from Claude", lead)}
        <p className="field-hint">An administrator can finish this sign-in.</p>
      </>
    );
  return (
    <>
      {renderIntro("Paste the code from Claude", lead)}
      <ClaudeCodeForm
        authorization={authorization}
        context={context}
        invalid={invalid}
      />
    </>
  );
}

/**
 * Claude shows the authorization code on its own page, which the Portal
 * cannot read, so the operator copies it from the sign-in window and pastes
 * it here.
 */
function ClaudeCodeForm(
  props: Readonly<{
    authorization: ClaudeAuthorization;
    context: StageContext;
    invalid: boolean;
  }>,
): React.ReactNode {
  const { authorization, context, invalid } = props;
  const codeInput = React.useRef<HTMLInputElement>(null);
  React.useEffect(focusCodeOnReturn.bind(null, codeInput), []);
  return (
    <form
      className="claude-sign-in-form"
      onSubmit={completeAuthorization.bind(
        null,
        context.controls,
        authorization.attemptId,
        context.code,
      )}
    >
      <div className="claude-sign-in-field">
        <label htmlFor="claude-sign-in-code">Code from Claude</label>
        <input
          ref={codeInput}
          id="claude-sign-in-code"
          name="claudeCode"
          type="password"
          placeholder="Paste the code"
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          value={context.code}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={
            invalid
              ? "claude-sign-in-code-error claude-sign-in-code-hint"
              : "claude-sign-in-code-hint"
          }
          disabled={context.busy === "connect"}
          onChange={updateCode.bind(null, context.controls)}
        />
        {invalid ? (
          <p
            id="claude-sign-in-code-error"
            className="claude-sign-in-hint claude-sign-in-hint-error"
            role="alert"
          >
            This is not the complete code. Copy all of it from Claude and paste
            it again.
          </p>
        ) : null}
        <p id="claude-sign-in-code-hint" className="claude-sign-in-hint">
          {expiryText(authorization.expiresAt, context.now)}
        </p>
      </div>
      <div className="claude-sign-in-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={context.busy !== null || context.code.trim() === ""}
        >
          {context.busy === "connect" ? "Connecting…" : "Connect Claude"}
        </Button>
        <a
          href={authorization.authorizationUrl}
          target="_blank"
          rel="noreferrer"
          onClick={openSignInWindow.bind(
            null,
            authorization.authorizationUrl,
            context.controls,
          )}
        >
          {context.windowBlocked ? "Open Claude" : "Open Claude again"}
        </a>
      </div>
    </form>
  );
}

function renderRestart(
  reason: "expired" | "not_confirmed",
  context: StageContext,
): React.ReactNode {
  return (
    <>
      {renderIntro(
        reason === "expired"
          ? "This sign-in expired"
          : "The sign-in did not finish",
        reason === "expired"
          ? "Start again to get a new code from Claude."
          : "Claude did not confirm the code. Start again to get a new code.",
      )}
      {context.props.canManage ? (
        <div className="claude-sign-in-actions">
          {renderStartButton(context, "Start again")}
        </div>
      ) : (
        <p className="field-hint">An administrator can start again.</p>
      )}
    </>
  );
}

function renderConnected(context: StageContext): React.ReactNode {
  return (
    <>
      {context.props.inUse ? (
        <p className="claude-sign-in-lead">
          New agent conversations use this Claude account.
        </p>
      ) : null}
      {context.props.canManage ? (
        <div className="claude-sign-in-actions">
          <Button
            disabled={context.busy !== null}
            onClick={startAuthorization.bind(null, context.controls)}
          >
            {context.busy === "start" ? "Opening Claude…" : "Reconnect"}
          </Button>
          {renderDisconnectButton(context)}
        </div>
      ) : null}
    </>
  );
}

/** "Expires in 9 minutes.", rounded up, so the count never reads late. */
function expiryText(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left < 60_000) return "Expires in less than a minute.";
  const minutes = Math.ceil(left / 60_000);
  return `Expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/** The clock, read again every ten seconds while a sign-in waits. */
function useNow(active: boolean): number {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(tickWhile.bind(null, active, setNow), [active]);
  return now;
}

function tickWhile(
  active: boolean,
  setNow: React.Dispatch<React.SetStateAction<number>>,
): () => void {
  if (!active) return noCleanup;
  readClock(setNow);
  const timer = window.setInterval(readClock.bind(null, setNow), 10_000);
  return window.clearInterval.bind(window, timer);
}

function readClock(setNow: React.Dispatch<React.SetStateAction<number>>): void {
  setNow(Date.now());
}

function noCleanup(): void {}

function updateCode(
  controls: Controls,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  controls.setCode(event.currentTarget.value);
  controls.setNotice(clearInvalidCode);
}

function clearInvalidCode(notice: Notice | null): Notice | null {
  return notice?.kind === "invalid_code" ? null : notice;
}

/**
 * Opens the sign-in again in the same window. If the browser blocks the
 * window, the link opens Claude in a new tab instead.
 */
function openSignInWindow(
  authorizationUrl: string,
  controls: Controls,
  event: React.MouseEvent<HTMLAnchorElement>,
): void {
  const opened = openAuthorizationPopup(authorizationUrl);
  if (opened === null) return;
  event.preventDefault();
  controls.signInWindow.current = opened;
  controls.setWindowBlocked(false);
}

/**
 * The operator copies the code in the sign-in window. When the Portal comes
 * back to the front, the empty code field takes the focus, so a paste fills
 * it.
 */
function focusCodeOnReturn(
  codeInput: React.RefObject<HTMLInputElement | null>,
): () => void {
  const focus = focusEmptyCode.bind(null, codeInput);
  window.addEventListener("focus", focus);
  return window.removeEventListener.bind(window, "focus", focus);
}

function focusEmptyCode(
  codeInput: React.RefObject<HTMLInputElement | null>,
): void {
  const input = codeInput.current;
  if (input !== null && !input.disabled && input.value === "") input.focus();
}

function closeSignInWindow(signInWindow: SignInWindow): void {
  const opened = signInWindow.current;
  signInWindow.current = null;
  if (opened !== null && !opened.closed) opened.close();
}

function connectionPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/inference/claude`;
}

/** The control error code that the platform returned, if any. */
function controlErrorCode(error: unknown): unknown {
  return error instanceof ControlApiError && isRecord(error.details)
    ? error.details.error
    : null;
}

function loadConnection(
  organisationId: string,
  setState: SetState,
): () => void {
  const lifetime = { active: true };
  void readConnection(organisationId, setState, lifetime);
  return endLoad.bind(null, lifetime);
}

function endLoad(lifetime: { active: boolean }): void {
  lifetime.active = false;
}

function retryRead(controls: Controls): void {
  controls.setState({ kind: "loading" });
  void readConnection(controls.organisationId, controls.setState, {
    active: true,
  });
}

async function readConnection(
  organisationId: string,
  setState: SetState,
  lifetime: { active: boolean },
): Promise<void> {
  try {
    const raw = await controlRead(connectionPath(organisationId));
    const view =
      isRecord(raw) && raw.ok === true ? parseClaudeConnectionView(raw) : null;
    if (view === null) throw new Error("Invalid Claude connection");
    if (lifetime.active) setState({ kind: "ready", view });
  } catch {
    if (lifetime.active)
      setState({
        kind: "failed",
        message: "Could not read the Claude account.",
      });
  }
}

/**
 * Runs from the start click. The sign-in window opens before the first
 * await, or the browser blocks it as a popup that the user did not ask for.
 * While a sign-in is open, Pantry returns that same sign-in.
 */
async function startAuthorization(controls: Controls): Promise<void> {
  closeSignInWindow(controls.signInWindow);
  const opened = openAuthorizationPopup();
  controls.signInWindow.current = opened;
  controls.setWindowBlocked(opened === null);
  controls.setBusy("start");
  controls.setNotice(null);
  controls.setCode("");
  try {
    const raw = await controlMutation(
      connectionPath(controls.organisationId),
      "POST",
      { kind: "start" },
    );
    const authorization =
      isRecord(raw) && raw.ok === true
        ? parseClaudeAuthorization(raw.authorization)
        : null;
    if (authorization === null) throw new Error("Invalid authorization");
    if (opened !== null && !opened.closed)
      opened.location.replace(authorization.authorizationUrl);
    controls.setState(showAuthorization.bind(null, authorization));
  } catch {
    closeSignInWindow(controls.signInWindow);
    controls.setNotice({
      kind: "failed",
      message: "Could not start the Claude sign-in. Try again.",
    });
  } finally {
    controls.setBusy(null);
  }
}

async function completeAuthorization(
  controls: Controls,
  attemptId: string,
  code: string,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  if (!code.trim()) return;
  controls.setBusy("connect");
  controls.setNotice(null);
  try {
    const raw = await controlSecretMutation(
      connectionPath(controls.organisationId),
      "POST",
      { kind: "complete", attemptId, code: code.trim() },
    );
    const connection = parseConnection(raw);
    closeSignInWindow(controls.signInWindow);
    controls.setCode("");
    controls.setState(connectionView(connection));
  } catch (error) {
    const code = controlErrorCode(error);
    controls.setNotice(completionNotice(code));
    if (endsAttempt(code)) {
      controls.setCode("");
      controls.setState(endAuthorization);
    }
  } finally {
    controls.setBusy(null);
  }
}

function completionNotice(code: unknown): Notice {
  switch (code) {
    case "claude_oauth_code_invalid":
      return { kind: "invalid_code" };
    case "claude_authorization_expired":
      return { kind: "ended", reason: "expired" };
    case "claude_oauth_provider_unavailable":
      return { kind: "ended", reason: "not_confirmed" };
    default:
      return {
        kind: "failed",
        message: "Could not connect Claude. Try again.",
      };
  }
}

/** Pantry ends the sign-in when it expired or when Claude refused the code. */
function endsAttempt(code: unknown): boolean {
  return (
    code === "claude_authorization_expired" ||
    code === "claude_oauth_provider_unavailable"
  );
}

async function disconnect(controls: Controls): Promise<void> {
  controls.setBusy("disconnect");
  controls.setNotice(null);
  try {
    const connection = parseConnection(
      await controlMutation(
        connectionPath(controls.organisationId),
        "DELETE",
        {},
      ),
    );
    controls.setState(connectionView(connection));
  } catch {
    controls.setNotice({
      kind: "failed",
      message: "Could not disconnect Claude. Try again.",
    });
  } finally {
    controls.setBusy(null);
  }
}

function showAuthorization(
  authorization: ClaudeAuthorization,
  state: State,
): State {
  return state.kind === "ready"
    ? {
        kind: "ready",
        view: {
          connection: state.view.connection,
          authorization: { kind: "authorizing", authorization },
        },
      }
    : state;
}

function connectionView(connection: ClaudeConnection): State {
  return {
    kind: "ready",
    view: { connection, authorization: { kind: "idle" } },
  };
}

function endAuthorization(state: State): State {
  return state.kind === "ready"
    ? {
        kind: "ready",
        view: {
          connection: state.view.connection,
          authorization: { kind: "idle" },
        },
      }
    : state;
}

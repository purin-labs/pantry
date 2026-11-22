import React from "react";
import { formatRelativeTime } from "../../page-components";
import { formatAbsoluteTime } from "../../formatting";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import type { CodexAllowance } from "@purin-labs/control-api";
import {
  InferenceIntegrationPanel,
  codexPanelHeading,
} from "./inference";
import { emptySettingsCleanup } from "./provider-authorization";
import type { IntegrationsPageActions } from "./settings-types";
import type { OrganisationCodexConnection, OrganisationInferenceSelection } from "@purin-labs/control-api/portal/settings";

export function renderCodexConnection(
  props: Parameters<typeof InferenceIntegrationPanel>[0],
  draft: OrganisationInferenceSelection["kind"],
  primary: boolean,
  copyStatus: string,
  setCopyStatus: React.Dispatch<React.SetStateAction<string>>,
): React.ReactNode {
  const actionClass = primary ? "connection-primary-action" : undefined;
  const inUse = props.selection.kind === "codex_subscription";
  switch (props.connection.kind) {
    case "disconnected":
      return (
        <div className="integration-setup codex-connection-state">
          {codexPanelHeading(
            "ChatGPT",
            { kind: "neutral", label: "Not connected" },
            { provider: "codex", label: "ChatGPT" },
          )}
          <p>
            {inUse
              ? "Sign in with the ChatGPT account that pays for Purin Pantry. Agents can start after OpenAI confirms the sign-in."
              : "Sign in with the ChatGPT account that pays for Purin Pantry, then use this source."}
          </p>
          {props.canConnect ? (
            <div className="connection-actions">
              <button
                type="button"
                className={actionClass}
                onClick={props.actions.connectCodex}
                disabled={props.busy}
              >
                Connect ChatGPT
              </button>
            </div>
          ) : (
            <p className="field-hint">A workspace owner can connect ChatGPT.</p>
          )}
        </div>
      );
    case "authorizing":
      return props.connection.attempt.method === "pasted_callback" ? (
        <ChatGptPastedSignIn
          attempt={props.connection.attempt}
          canConnect={props.canConnect}
          busy={props.busy}
          actions={props.actions}
        />
      ) : (
        <CodexSignIn
          attempt={props.connection.attempt}
          canConnect={props.canConnect}
          busy={props.busy}
          actions={props.actions}
          copyStatus={copyStatus}
          setCopyStatus={setCopyStatus}
        />
      );
    case "connected":
      return (
        <div className="integration-setup codex-connection-state">
          {codexPanelHeading(
            "ChatGPT",
            { kind: "success", label: "Connected" },
            { provider: "codex", label: "ChatGPT" },
          )}
          <dl className="codex-connection-details">
            <div>
              <dt>ChatGPT plan</dt>
              <dd>{formatCodexPlan(props.connection.planType)}</dd>
            </div>
            <div>
              <dt>Last verified</dt>
              <dd>{formatRelativeTime(props.connection.verifiedAt)}</dd>
            </div>
          </dl>
          {renderCodexAllowance(props.connection.allowance)}
          {props.connection.signIn === "codex_device" ? (
            <p className="field-hint">
              This connection uses the old ChatGPT sign-in, which OpenAI now
              refuses for Purin Pantry. Select Reconnect to sign in with
              ChatGPT again.
            </p>
          ) : null}
          {props.canConnect ? (
            renderCodexConnectedActions(props)
          ) : (
            <p className="field-hint">
              A workspace owner can change this connection.
            </p>
          )}
        </div>
      );
    case "action_required":
      return (
        <div className="integration-setup codex-connection-state">
          {codexPanelHeading(
            "ChatGPT",
            { kind: "warning", label: "Action required" },
            { provider: "codex", label: "ChatGPT" },
          )}
          <p>
            {draft === "codex_subscription"
              ? codexActionRequiredMessage(props.connection)
              : "Repair this ChatGPT connection before you use it again."}
          </p>
          {renderCodexAllowance(props.connection.allowance)}
          {props.canConnect ? (
            <div className="connection-actions">
              <button
                type="button"
                className={actionClass}
                onClick={props.actions.reconnectCodex}
                disabled={props.busy}
              >
                Reconnect ChatGPT
              </button>
            </div>
          ) : null}
        </div>
      );
    default:
      return assertNever(props.connection, "Unexpected settings state");
  }
}

type CodexAuthorizationAttempt = Variant<
  OrganisationCodexConnection,
  "authorizing"
>["attempt"];

/**
 * The device sign-in as three numbered steps. One action copies the code and
 * opens OpenAI together, so the usual path is one press and one paste.
 */
function CodexSignIn(props: {
  readonly attempt: CodexAuthorizationAttempt;
  readonly canConnect: boolean;
  readonly busy: boolean;
  readonly actions: IntegrationsPageActions;
  readonly copyStatus: string;
  readonly setCopyStatus: React.Dispatch<React.SetStateAction<string>>;
}): React.ReactNode {
  const code = props.attempt.userCode;
  const copied = props.copyStatus === CODEX_CODE_COPIED;
  const ref = React.useRef<HTMLDivElement>(null);
  // The sign-in starts below the list of sources; it is the task now.
  React.useEffect(revealCodexSignIn.bind(null, ref), []);
  React.useEffect(
    clearCodexCopyStatus.bind(null, copied, props.setCopyStatus),
    [copied],
  );
  return (
    <div ref={ref} className="integration-setup codex-connection-state">
      {codexPanelHeading(
        "ChatGPT",
        { kind: "info", label: "Finish sign-in" },
        { provider: "codex", label: "ChatGPT" },
      )}
      <ol className="codex-sign-in-steps">
        {code === null ? null : (
          <li>
            <span className="codex-sign-in-step-title">Copy this code</span>
            <div
              className="codex-device-code"
              aria-label={`One-time code ${code}`}
            >
              <code>{code}</code>
              <button
                type="button"
                onClick={copyCodexCode.bind(null, code, props.setCopyStatus)}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </li>
        )}
        <li>
          <span className="codex-sign-in-step-title">
            {code === null ? "Open OpenAI" : "Open OpenAI and enter the code"}
          </span>
          <small>
            Sign in with the ChatGPT account that pays for Purin Pantry
            {code === null ? ", then approve the access." : "."}
          </small>
        </li>
        <li>
          <span className="codex-sign-in-step-title">
            Come back to this page
          </span>
          <small>
            It updates by itself after the sign-in. The code expires at{" "}
            {formatClockTime(props.attempt.expiresAt)}.
          </small>
        </li>
      </ol>
      <div className="connection-actions">
        <a
          className="button-link connection-primary-action"
          href={props.attempt.verificationUrl}
          target="_blank"
          rel="noreferrer"
          onClick={
            code === null
              ? undefined
              : copyCodexCodeOnOpen.bind(null, code, props.setCopyStatus)
          }
        >
          {code === null ? "Open OpenAI" : "Copy code and open OpenAI"}
        </a>
        {props.canConnect ? (
          <button
            type="button"
            onClick={cancelCodexFromPanel.bind(
              null,
              props.actions,
              props.attempt.attemptId,
            )}
            disabled={props.busy}
          >
            Cancel sign-in
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Sign in with ChatGPT" (Plan 74B). OpenAI sends the browser to a loopback
 * address where nothing listens, so the person copies that address from the
 * address bar and pastes it here. Connect already opened OpenAI in a new
 * tab; the link opens it again.
 */
function ChatGptPastedSignIn(props: {
  readonly attempt: CodexAuthorizationAttempt;
  readonly canConnect: boolean;
  readonly busy: boolean;
  readonly actions: IntegrationsPageActions;
}): React.ReactNode {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(revealCodexSignIn.bind(null, ref), []);
  return (
    <div ref={ref} className="integration-setup codex-connection-state">
      {codexPanelHeading(
        "ChatGPT",
        { kind: "info", label: "Finish sign-in" },
        { provider: "codex", label: "ChatGPT" },
      )}
      <ol className="codex-sign-in-steps">
        <li>
          <span className="codex-sign-in-step-title">
            Allow Purin Pantry in ChatGPT
          </span>
          <small>
            Sign in with the ChatGPT account that pays for Purin Pantry, then
            allow the access.
          </small>
        </li>
        <li>
          <span className="codex-sign-in-step-title">
            Copy the address of the next page
          </span>
          <small>
            Your browser then shows a page at 127.0.0.1 that does not load. This
            is expected. Copy the full address from the address bar.
          </small>
        </li>
        <li>
          <span className="codex-sign-in-step-title">Paste it here</span>
          {props.canConnect ? (
            <form
              className="codex-callback-form"
              onSubmit={submitChatGptCallback.bind(
                null,
                props.actions,
                props.attempt.attemptId,
              )}
            >
              <label>
                <span className="visually-hidden">Address of the page</span>
                <input
                  name="chatgptCallback"
                  type="text"
                  inputMode="url"
                  placeholder="http://127.0.0.1:1455/auth/callback?code=…"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={8192}
                  disabled={props.busy}
                />
              </label>
              <small>
                The sign-in expires at{" "}
                {formatClockTime(props.attempt.expiresAt)}.
              </small>
              <div className="connection-actions">
                <button
                  type="submit"
                  className="connection-primary-action"
                  disabled={props.busy}
                >
                  {props.busy ? "Connecting…" : "Connect ChatGPT"}
                </button>
              </div>
            </form>
          ) : (
            <small>A workspace owner can finish this sign-in.</small>
          )}
        </li>
      </ol>
      <div className="connection-actions">
        <a
          className="button-link"
          href={props.attempt.verificationUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open ChatGPT
        </a>
        {props.canConnect ? (
          <button
            type="button"
            onClick={cancelCodexFromPanel.bind(
              null,
              props.actions,
              props.attempt.attemptId,
            )}
            disabled={props.busy}
          >
            Cancel sign-in
          </button>
        ) : null}
      </div>
    </div>
  );
}

async function submitChatGptCallback(
  actions: IntegrationsPageActions,
  attemptId: string,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget;
  const address = new FormData(form).get("chatgptCallback");
  if (typeof address !== "string" || address.trim().length === 0) return;
  await actions.completeCodexAuthorization(attemptId, address.trim());
}

const CODEX_CODE_COPIED = "One-time code copied.";

function revealCodexSignIn(ref: React.RefObject<HTMLDivElement | null>): void {
  ref.current?.scrollIntoView({ block: "nearest" });
}

/** "Copied" goes back to "Copy" after a moment, so a second copy reads true. */
function clearCodexCopyStatus(
  copied: boolean,
  setCopyStatus: React.Dispatch<React.SetStateAction<string>>,
): () => void {
  if (!copied) return emptySettingsCleanup;
  const timer = window.setTimeout(setCopyStatus.bind(null, ""), 2_000);
  return window.clearTimeout.bind(window, timer);
}

/** The link opens OpenAI by itself; the copy runs beside it. */
function copyCodexCodeOnOpen(
  code: string,
  setCopyStatus: React.Dispatch<React.SetStateAction<string>>,
): void {
  void copyCodexCode(code, setCopyStatus);
}

function formatClockTime(value: number): string {
  return new Date(value).toLocaleTimeString(undefined, { timeStyle: "short" });
}

function renderCodexConnectedActions(
  props: Parameters<typeof InferenceIntegrationPanel>[0],
): React.ReactNode {
  const confirming = props.pendingConfirm === "codex_disconnect";
  return (
    <div className="connection-actions">
      <button
        type="button"
        onClick={props.actions.reconnectCodex}
        disabled={props.busy}
      >
        Reconnect
      </button>
      <button
        type="button"
        onClick={
          confirming
            ? props.actions.disconnectCodex
            : props.requestConfirm.bind(null, "codex_disconnect")
        }
        disabled={props.busy}
      >
        {confirming ? "Confirm disconnect" : "Disconnect"}
      </button>
    </div>
  );
}

function renderCodexAllowance(allowance: CodexAllowance): React.ReactNode {
  if (allowance.kind === "not_reported") {
    return (
      <p className="field-hint">
        OpenAI does not report the remaining allowance to apps.{" "}
        <a
          href="https://chatgpt.com/settings/usage"
          target="_blank"
          rel="noreferrer"
        >
          See your usage in ChatGPT
        </a>
        .
      </p>
    );
  }
  const remaining = Math.max(0, 100 - allowance.usedPercent);
  const percent = Math.round(remaining);
  return (
    <div className={`codex-allowance ${codexAllowanceLevel(percent)}`}>
      <div>
        <span>Included allowance</span>
        <strong>{percent}% remaining</strong>
      </div>
      <progress
        max={100}
        value={remaining}
        aria-label={`${percent} percent of the included OpenAI allowance remains`}
      />
      {allowance.resetsAt === null ? null : (
        <p>
          Resets{" "}
          {formatAbsoluteTime(normalizeProviderTimestamp(allowance.resetsAt))}
        </p>
      )}
      {allowance.credits === "available" ? (
        <p>Credits are available for usage beyond the included allowance.</p>
      ) : null}
    </div>
  );
}

/** The meter changes colour before the allowance runs out, not after. */
function codexAllowanceLevel(percent: number): string {
  if (percent <= 10) return "is-critical";
  if (percent <= 25) return "is-low";
  return "is-healthy";
}

function codexActionRequiredMessage(
  connection: Variant<OrganisationCodexConnection, "action_required">,
): string {
  switch (connection.reason) {
    case "authorization_expired":
      return "The ChatGPT authorization expired. Reconnect to resume agent turns.";
    case "workspace_access_revoked":
      return "This account no longer has access to its OpenAI workspace. Reconnect an eligible account.";
    case "device_authorization_unavailable":
      return "OpenAI device authorization is unavailable for this account or workspace.";
    case "account_unavailable":
      return "OpenAI could not verify this account. Reconnect to resume agent turns.";
    default:
      return assertNever(connection.reason, "Unexpected settings state");
  }
}

async function copyCodexCode(
  code: string,
  setCopyStatus: React.Dispatch<React.SetStateAction<string>>,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    setCopyStatus(CODEX_CODE_COPIED);
  } catch {
    setCopyStatus("Select and copy the one-time code manually.");
  }
}

async function cancelCodexFromPanel(
  actions: IntegrationsPageActions,
  attemptId: string,
): Promise<void> {
  await actions.cancelCodexAuthorization(attemptId);
}

function formatCodexPlan(planType: string): string {
  return planType.replaceAll("_", " ").replace(/\b\w/gu, uppercaseCharacter);
}

function uppercaseCharacter(character: string): string {
  return character.toUpperCase();
}

function normalizeProviderTimestamp(value: number): number {
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

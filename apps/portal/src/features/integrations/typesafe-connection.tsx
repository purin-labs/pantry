import React from "react";
import { isRecord } from "@purin-labs/std";
import {
  controlRead,
  controlSecretMutation,
  refusedBody,
} from "../../control-client";
import {
  type Configuration,
  parseConfiguration,
} from "@purin-labs/control-api/portal/typesafe-connection";

export type TypeSafeConnectionState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; configuration: Configuration }>;

type SetState = React.Dispatch<React.SetStateAction<TypeSafeConnectionState>>;

export function useTypeSafeConnection(
  organisationId: string,
  canManage: boolean,
): readonly [TypeSafeConnectionState, SetState] {
  const [state, setState] = React.useState<TypeSafeConnectionState>({
    kind: "loading",
  });
  React.useEffect(
    loadConnection.bind(null, organisationId, canManage, setState),
    [organisationId, canManage],
  );
  return [state, setState];
}

export function TypeSafeConnectionPanel(props: {
  organisationId: string;
  canManage: boolean;
  state: TypeSafeConnectionState;
  setState: SetState;
}): React.ReactNode {
  const { state, setState } = props;
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const configuration = state.kind === "ready" ? state.configuration : null;
  const connection = configuration?.connection;
  return (
    <section
      className="typesafe-connection"
      aria-labelledby="typesafe-connection-title"
    >
      <h2 id="typesafe-connection-title" className="visually-hidden">
        TypeSafe AI connection
      </h2>
      <p className="field-hint">TypeSafe bills your organisation for usage.</p>
      {!props.canManage ? (
        <p>An organisation administrator can manage this connection.</p>
      ) : (
        <>
          {state.kind === "loading" && <p role="status">Loading connection…</p>}
          {state.kind === "failed" && (
            <p role="alert">
              {state.message}{" "}
              <button
                type="button"
                onClick={retryConnection.bind(
                  null,
                  props.organisationId,
                  setState,
                )}
              >
                Retry
              </button>
            </p>
          )}
          {configuration !== null && connection !== undefined && (
            <>
              <p role="status">
                {connection.kind === "connected"
                  ? configuration.credentialConfigured
                    ? "Connected"
                    : "Needs attention"
                  : null}
              </p>
              {connection.kind === "connected" && (
                <p>
                  Last successful test:{" "}
                  {new Date(connection.testedAt).toLocaleString()}
                </p>
              )}
              <form
                key={connection.revision}
                onSubmit={submitConnection.bind(
                  null,
                  props.organisationId,
                  connection.revision,
                  setState,
                  setBusy,
                  setMessage,
                )}
              >
                <fieldset className="setup-form" disabled={busy}>
                  <legend className="visually-hidden">
                    {connection.kind === "connected"
                      ? "Replace your key"
                      : "Your TypeSafe key"}
                  </legend>
                  <label htmlFor="typesafe-api-key">TypeSafe API key</label>
                  <input
                    id="typesafe-api-key"
                    name="apiKey"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    minLength={20}
                    maxLength={4096}
                    aria-describedby="typesafe-key-help"
                  />
                  <p id="typesafe-key-help" className="field-hint">
                    Purin Pantry encrypts your key and never shows it again.
                    Saving runs a small test that TypeSafe bills to you. After
                    you replace a key, turn on each feature again.
                  </p>
                  <button type="submit" className="connection-primary-action">
                    {busy ? "Working…" : "Test and save key"}
                  </button>
                </fieldset>
              </form>
              <p className="field-hint">
                <a
                  className="typesafe-key-link"
                  href="https://console.typesafe.ai/keys"
                  target="_blank"
                  rel="noreferrer"
                >
                  Get a TypeSafe key
                </a>
              </p>
              {connection.kind === "connected" && (
                <div className="connection-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={runMutation.bind(
                      null,
                      props.organisationId,
                      {
                        operation: "test",
                        expectedRevision: connection.revision,
                      },
                      setState,
                      setBusy,
                      setMessage,
                    )}
                  >
                    Test connection
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={runMutation.bind(
                      null,
                      props.organisationId,
                      {
                        operation: "disconnect",
                        expectedRevision: connection.revision,
                      },
                      setState,
                      setBusy,
                      setMessage,
                    )}
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </>
          )}
          <p role="status" aria-live="polite">
            {message}
          </p>
        </>
      )}
    </section>
  );
}

function path(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/integrations/typesafe`;
}

function retryConnection(organisationId: string, setState: SetState): void {
  void reloadConnection(organisationId, setState);
}

function loadConnection(
  organisationId: string,
  canManage: boolean,
  setState: SetState,
): () => void {
  const controller = new AbortController();
  if (canManage)
    void reloadConnection(organisationId, setState, controller.signal);
  return controller.abort.bind(controller);
}

async function reloadConnection(
  organisationId: string,
  setState: SetState,
  signal?: AbortSignal,
): Promise<void> {
  setState({ kind: "loading" });
  try {
    const raw = readResponse(
      await controlRead(path(organisationId)).catch(refusedBody),
    );
    const configuration = parseConfiguration(raw);
    if (!signal?.aborted) setState({ kind: "ready", configuration });
  } catch (error) {
    if (!signal?.aborted) setState({ kind: "failed", message: problem(error) });
  }
}

function submitConnection(
  organisationId: string,
  revision: number,
  setState: SetState,
  setBusy: React.Dispatch<React.SetStateAction<boolean>>,
  setMessage: React.Dispatch<React.SetStateAction<string>>,
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const body = {
    operation: "connect",
    expectedRevision: revision,
    provider: "typesafe",
    apiKey: data.get("apiKey"),
  };
  form.reset();
  void runMutation(organisationId, body, setState, setBusy, setMessage);
}

async function runMutation(
  organisationId: string,
  body: Readonly<Record<string, unknown>>,
  setState: SetState,
  setBusy: React.Dispatch<React.SetStateAction<boolean>>,
  setMessage: React.Dispatch<React.SetStateAction<string>>,
): Promise<void> {
  setBusy(true);
  setMessage("");
  try {
    const csrf = csrfCookie();
    if (csrf === null)
      throw new Error("Sign in again to manage this connection.");
    // The body carries the API key: the secret transport keeps no copy of it.
    readResponse(
      await controlSecretMutation(path(organisationId), "POST", body).catch(
        refusedBody,
      ),
    );
    setMessage(
      body.operation === "disconnect"
        ? "Disconnected. The features that use TypeSafe are off."
        : "Connection works.",
    );
  } catch (error) {
    setMessage(problem(error));
  } finally {
    await reloadConnection(organisationId, setState);
    setBusy(false);
  }
}

function csrfCookie(): string | null {
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (value.startsWith("pantry_csrf="))
      return decodeURIComponent(value.slice("pantry_csrf=".length));
  }
  return null;
}

/** An answer, or the body of a refusal: its error code names the problem. */
function readResponse(raw: unknown): unknown {
  if (!isRecord(raw) || raw.ok !== true) {
    const code =
      isRecord(raw) && typeof raw.error === "string" ? raw.error : "";
    switch (code) {
      case "jev_connection_invalid":
        throw new Error("Enter a valid API key for the selected provider.");
      case "jev_credential_rejected":
        throw new Error(
          "TypeSafe rejected this key. Check the key and its permissions.",
        );
      case "jev_budget_exhausted":
        throw new Error(
          "Your TypeSafe account needs credits or a higher spending limit.",
        );
      case "jev_unavailable":
        throw new Error(
          "TypeSafe could not be reached. Check its availability and try again.",
        );
      case "jev_response_invalid":
        throw new Error(
          "TypeSafe returned an invalid response. Try again or check its service status.",
        );
      case "jev_cancelled":
        throw new Error("The provider test timed out. Try again.");
      case "jev_test_rate_limited":
        throw new Error("Please wait 30 seconds between connection tests.");
      case "typesafe_revision_conflict":
        throw new Error(
          "The connection changed. Review its current state and try again.",
        );
      default:
        throw new Error(
          "The connection could not be verified. Check provider availability and try again.",
        );
    }
  }
  return raw.value;
}

function problem(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The connection could not be updated.";
}

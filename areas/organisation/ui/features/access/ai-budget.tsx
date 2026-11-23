import React from "react";
import type { AccessRouteTransport } from "@purin-labs/control-api/portal/access-models";
import type { AiBudgetView } from "@purin-labs/control-api/portal/ai-budget";

type Props = Readonly<{
  organisationId: string;
  transport: AccessRouteTransport;
}>;
type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; view: AiBudgetView };
type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "failed"; message: string };

export function AiBudgetSection(props: Props): React.ReactNode {
  const [state, setState] = React.useState<State>({ kind: "loading" });
  React.useEffect(loadBudget.bind(null, props, setState), [
    props.organisationId,
    props.transport,
  ]);
  return (
    <section
      className="portal-band access35-budget-section"
      id="ai-budgets"
      aria-labelledby="ai-budgets-title"
    >
      <h2 id="ai-budgets-title">AI budgets</h2>
      <p>Limits for each new AI session. Provider quotas still apply.</p>
      {state.kind === "loading" && <p role="status">Loading AI budgets…</p>}
      {state.kind === "failed" && (
        <>
          <p role="alert">{state.message}</p>
          <button
            type="button"
            onClick={reloadBudget.bind(null, props, setState)}
          >
            Reload AI budgets
          </button>
        </>
      )}
      {state.kind === "ready" && (
        <AiBudgetForm
          key={`${props.organisationId}:${state.view.revision}:${state.view.activation}`}
          {...props}
          view={state.view}
          onReload={reloadBudget.bind(null, props, setState)}
        />
      )}
    </section>
  );
}

function AiBudgetForm(
  props: Props & { view: AiBudgetView; onReload: () => void },
): React.ReactNode {
  const [view, setView] = React.useState(props.view);
  const [save, setSave] = React.useState<SaveState>({ kind: "idle" });
  const busy = save.kind === "saving";
  return (
    <form
      className="stacked-form"
      onSubmit={submitBudget.bind(
        null,
        {
          organisationId: props.organisationId,
          transport: props.transport,
          view,
        },
        setSave,
        setView,
      )}
    >
      {view.activation === "pending" && (
        <p role="alert">
          These settings are awaiting policy activation. Save again to retry
          activation. They are not confirmed as applied.
        </p>
      )}
      <fieldset
        className="access35-budget-fields"
        disabled={busy || !props.view.canManage}
      >
        <legend className="visually-hidden">Session limits</legend>
        <div className="access35-budget-field">
          <label htmlFor="ai-budget-tokens">Tokens</label>
          <input
            id="ai-budget-tokens"
            name="tokens"
            type="number"
            required
            min="1"
            max={props.view.maximum.maxTokens}
            step="1"
            defaultValue={view.limits.maxTokens}
            aria-describedby="ai-budget-token-help"
          />
          <p id="ai-budget-token-help">
            Maximum {props.view.maximum.maxTokens.toLocaleString()}
          </p>
        </div>
        <div className="access35-budget-field">
          <label htmlFor="ai-budget-runtime">Seconds for each request</label>
          <input
            id="ai-budget-runtime"
            name="seconds"
            type="number"
            required
            min="1"
            max={props.view.maximum.maxWallMs / 1000}
            step="1"
            defaultValue={view.limits.maxWallMs / 1000}
          />
        </div>
        <div className="access35-budget-field">
          <label htmlFor="ai-budget-calls">Tool calls</label>
          <input
            id="ai-budget-calls"
            name="calls"
            type="number"
            required
            min="1"
            max={props.view.maximum.maxToolCalls}
            step="1"
            defaultValue={view.limits.maxToolCalls}
            aria-describedby="ai-budget-calls-help"
          />
          <p id="ai-budget-calls-help">
            Maximum {props.view.maximum.maxToolCalls.toLocaleString()}
          </p>
        </div>
      </fieldset>
      <p role="status">{saveStatus(save)}</p>
      {save.kind === "failed" && (
        <p role="alert">
          {save.message} Your input is preserved. Reload the settings before you
          retry a revision conflict.{" "}
          <button type="button" onClick={props.onReload}>
            Reload settings
          </button>
        </p>
      )}
      {props.view.canManage ? (
        <div className="access35-dialog-actions">
          <button
            type="submit"
            className="connection-primary-action"
            disabled={busy}
          >
            Save
          </button>
          <button
            type="reset"
            disabled={busy}
            onClick={clearSaveState.bind(null, setSave)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <p>An owner or admin can change these settings.</p>
      )}
    </form>
  );
}

function saveStatus(save: SaveState): string {
  switch (save.kind) {
    case "saving":
      return "Saving AI budgets…";
    case "saved":
      return "AI budgets saved and verified for new sessions.";
    case "idle":
    case "failed":
      return "";
  }
}

function clearSaveState(
  setSave: React.Dispatch<React.SetStateAction<SaveState>>,
): void {
  setSave({ kind: "idle" });
}

function loadBudget(
  props: Props,
  setState: React.Dispatch<React.SetStateAction<State>>,
): () => void {
  const request = { active: true };
  void readBudget(props, setState, request);
  return cancelRead.bind(null, request);
}

function cancelRead(request: { active: boolean }): void {
  request.active = false;
}

function reloadBudget(
  props: Props,
  setState: React.Dispatch<React.SetStateAction<State>>,
): void {
  setState({ kind: "loading" });
  void readBudget(props, setState, { active: true });
}

async function readBudget(
  props: Props,
  setState: React.Dispatch<React.SetStateAction<State>>,
  request: { active: boolean },
): Promise<void> {
  try {
    const view = await props.transport.readBudget(props.organisationId);
    if (request.active) setState({ kind: "ready", view });
  } catch (error) {
    if (request.active)
      setState({ kind: "failed", message: budgetError(error) });
  }
}

async function submitBudget(
  props: Props & { view: AiBudgetView },
  setSave: React.Dispatch<React.SetStateAction<SaveState>>,
  setView: React.Dispatch<React.SetStateAction<AiBudgetView>>,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  if (!props.view.canManage) return;
  const fields = new FormData(event.currentTarget);
  const limits = {
    maxTokens: Number(fields.get("tokens")),
    maxWallMs: Number(fields.get("seconds")) * 1000,
    maxToolCalls: Number(fields.get("calls")),
  };
  setSave({ kind: "saving" });
  try {
    await props.transport.saveBudget(
      props.organisationId,
      props.view.revision,
      limits,
    );
    const verified = await props.transport.readBudget(props.organisationId);
    if (
      verified.activation !== "active" ||
      verified.limits.maxTokens !== limits.maxTokens ||
      verified.limits.maxWallMs !== limits.maxWallMs ||
      verified.limits.maxToolCalls !== limits.maxToolCalls
    )
      throw new Error(
        "The saved settings could not be verified. Reload settings.",
      );
    setView(verified);
    setSave({ kind: "saved" });
  } catch (error) {
    setSave({ kind: "failed", message: budgetError(error) });
  }
}

function budgetError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "AI budgets could not be updated. Reload settings and try again.";
}

import React from "react";
import { isRecord } from "@purin-labs/std";
import {
  isChatEffort,
  parseSlackReasoningEffortView,
  type ChatEffort,
} from "@purin-labs/control-api";

import { controlMutation, controlRead } from "../../control-client";
import { inferencePath } from "../../control-paths";
import { StatusChip } from "../../page-components";
import { effortDescription, effortLabel } from "../chat/effort-labels";
import type { OrganisationInferenceSelection } from "@purin-labs/control-api/portal/settings";

/** The inference sources, as the settings page names them. */
type InferenceSourceKind = OrganisationInferenceSelection["kind"];

type State =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; effort: ChatEffort | null }>
  | Readonly<{ kind: "failed" }>;

type Notice = Readonly<{ kind: "saved" | "failed"; message: string }>;

/** A choice in the form. "standard" is no choice: the source's own level. */
type Draft = ChatEffort | "standard";

const EFFORTS: readonly ChatEffort[] = ["low", "medium", "high"];

/**
 * The reasoning effort of Slack answers. Portal chat keeps its own choice in
 * each chat; Slack has one choice for the organisation. The panel reads and
 * saves its own record, so a save does not change the configuration version
 * that the other settings on the page hold.
 */
export function SlackReasoningEffortPanel(props: {
  readonly organisationId: string;
  readonly source: InferenceSourceKind;
  readonly canManage: boolean;
}): React.ReactNode {
  const [state, setState] = React.useState<State>({ kind: "loading" });
  const [draft, setDraft] = React.useState<Draft>("standard");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  React.useEffect(
    startLoad.bind(null, props.organisationId, setState, setDraft),
    [props.organisationId],
  );

  // ChatGPT answers always use one level, so there is nothing to choose.
  if (props.source === "codex_subscription") return null;
  if (state.kind === "loading") return null;
  if (state.kind === "failed")
    return (
      <div className="integration-setup">
        <h4>Thinking level for Slack answers</h4>
        <p className="error-text">Unable to read the thinking level. Close this window and open it again.</p>
      </div>
    );
  const saved: Draft = state.effort ?? "standard";
  if (!props.canManage)
    return (
      <div className="integration-setup">
        <h4>Thinking level for Slack answers</h4>
        <p>
          Slack answers use {draftLabel(saved, props.source)}. An owner or admin
          can change it.
        </p>
      </div>
    );
  return (
    <div className="integration-setup">
      <form
        className="stacked-form"
        onSubmit={saveEffort.bind(null, {
          organisationId: props.organisationId,
          source: props.source,
          draft,
          setState,
          setBusy,
          setNotice,
        })}
      >
        <fieldset
          className="inference-choices"
          disabled={busy}
          aria-describedby="slack-reasoning-effort-help"
        >
          <legend>Thinking level for Slack answers</legend>
          {renderChoice(saved, draft, setDraft, {
            value: "standard",
            label: "Standard",
            detail: standardDetail(props.source),
          })}
          {EFFORTS.map(renderEffortChoice.bind(null, saved, draft, setDraft))}
        </fieldset>
        <p id="slack-reasoning-effort-help" className="field-hint">
          A change applies to the next Slack answer. Each Portal chat keeps its
          own choice.
        </p>
        {notice?.kind === "failed" ? (
          <p className="error-text" role="alert">
            {notice.message}
          </p>
        ) : null}
        {draft !== saved ? (
          <div className="connection-actions">
            <button
              type="submit"
              className="connection-primary-action"
              disabled={busy}
            >
              {busy
                ? "Saving…"
                : `Use ${draftLabel(draft, props.source)} in Slack`}
            </button>
          </div>
        ) : null}
        <p className="visually-hidden" aria-live="polite">
          {notice?.kind === "saved" ? notice.message : ""}
        </p>
      </form>
    </div>
  );
}

function renderChoice(
  saved: Draft,
  draft: Draft,
  setDraft: React.Dispatch<React.SetStateAction<Draft>>,
  choice: Readonly<{ value: Draft; label: string; detail: string }>,
): React.ReactNode {
  return (
    <label key={choice.value}>
      <input
        type="radio"
        name="slackReasoningEffort"
        value={choice.value}
        checked={draft === choice.value}
        onChange={updateDraft.bind(null, setDraft)}
      />
      <span>
        <span className="inference-choice-title">
          <strong>{choice.label}</strong>
          {saved === choice.value ? (
            <StatusChip status={{ kind: "success", label: "In use" }} />
          ) : null}
        </span>
        <small>{choice.detail}</small>
      </span>
    </label>
  );
}

function renderEffortChoice(
  saved: Draft,
  draft: Draft,
  setDraft: React.Dispatch<React.SetStateAction<Draft>>,
  effort: ChatEffort,
): React.ReactNode {
  return renderChoice(saved, draft, setDraft, {
    value: effort,
    label: effortLabel(effort),
    detail: effortDescription(effort),
  });
}

function updateDraft(
  setDraft: React.Dispatch<React.SetStateAction<Draft>>,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  const value = event.currentTarget.value;
  if (value === "standard" || isChatEffort(value)) setDraft(value);
}

/** What "Standard" means for the source, as the platform applies it. */
function standardDetail(source: InferenceSourceKind): string {
  switch (source) {
    case "claude_oauth":
    case "organisation_anthropic_api_key":
    case "organisation_openai_api_key":
    case "organisation_google_api_key":
    case "codex_subscription":
      return "Deep reasoning.";
    case "pantry_platform":
      return "The lowest level.";
  }
}

function draftLabel(draft: Draft, source: InferenceSourceKind): string {
  if (draft !== "standard") return effortLabel(draft);
  return source === "pantry_platform"
    ? "the standard level"
    : "Deep reasoning (standard)";
}

function slackReasoningEffortPath(organisationId: string): string {
  return `${inferencePath(organisationId)}/slack-reasoning-effort`;
}

function startLoad(
  organisationId: string,
  setState: React.Dispatch<React.SetStateAction<State>>,
  setDraft: React.Dispatch<React.SetStateAction<Draft>>,
): () => void {
  const lifetime = { active: true };
  void loadEffort(organisationId, lifetime, setState, setDraft);
  return endLoad.bind(null, lifetime);
}

function endLoad(lifetime: { active: boolean }): void {
  lifetime.active = false;
}

async function loadEffort(
  organisationId: string,
  lifetime: { readonly active: boolean },
  setState: React.Dispatch<React.SetStateAction<State>>,
  setDraft: React.Dispatch<React.SetStateAction<Draft>>,
): Promise<void> {
  try {
    const raw = await controlRead(slackReasoningEffortPath(organisationId));
    const view =
      isRecord(raw) && raw.ok === true
        ? parseSlackReasoningEffortView(raw)
        : null;
    if (view === null) throw new Error("Invalid Slack reasoning effort");
    if (!lifetime.active) return;
    setState({ kind: "ready", effort: view.effort });
    setDraft(view.effort ?? "standard");
  } catch {
    if (lifetime.active) setState({ kind: "failed" });
  }
}

async function saveEffort(
  controls: Readonly<{
    organisationId: string;
    source: InferenceSourceKind;
    draft: Draft;
    setState: React.Dispatch<React.SetStateAction<State>>;
    setBusy: React.Dispatch<React.SetStateAction<boolean>>;
    setNotice: React.Dispatch<React.SetStateAction<Notice | null>>;
  }>,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const effort = controls.draft === "standard" ? null : controls.draft;
  controls.setBusy(true);
  controls.setNotice(null);
  try {
    const raw = await controlMutation(
      slackReasoningEffortPath(controls.organisationId),
      "PUT",
      { effort },
    );
    const view =
      isRecord(raw) && raw.ok === true
        ? parseSlackReasoningEffortView(raw)
        : null;
    if (view === null) throw new Error("Invalid Slack reasoning effort");
    controls.setState({ kind: "ready", effort: view.effort });
    controls.setNotice({
      kind: "saved",
      message: `Slack answers now use ${draftLabel(view.effort ?? "standard", controls.source)}.`,
    });
  } catch {
    controls.setNotice({
      kind: "failed",
      message: "Could not save the reasoning effort. Try again.",
    });
  } finally {
    controls.setBusy(false);
  }
}

import { SlackReasoningEffortPanel } from "./slack-reasoning-effort";
import {
  ClaudeConnectionPanel,
  type ClaudeConnectionState,
} from "./claude-connection";
import React from "react";
import {
  ProviderTile,
  StatusChip,
  type ProviderTileName,
  type StatusChipStatus,
} from "../../page-components";
import { assertNever } from "@purin-labs/std";
import { renderCodexConnection } from "./codex";
import { parseInferenceSelection } from "@purin-labs/control-api/portal/inference";
import {
  mutationFeedbackMessage,
  renderMutationFeedback,
} from "./settings-support";
import type { IntegrationsPageActions, SettingsMutationFeedback } from "./settings-types";
import type { OrganisationCodexConnection, OrganisationInferenceSelection } from "@purin-labs/control-api/portal/settings";

export function InferenceIntegrationPanel(props: {
  readonly claudeState: ClaudeConnectionState;
  readonly setClaudeState: React.Dispatch<
    React.SetStateAction<ClaudeConnectionState>
  >;
  readonly organisationId: string;
  readonly connection: OrganisationCodexConnection;
  readonly selection: OrganisationInferenceSelection;
  readonly canManage: boolean;
  readonly canConnect: boolean;
  readonly busy: boolean;
  readonly selectionBusy: boolean;
  readonly pendingConfirm: string | null;
  readonly requestConfirm: (key: string) => void;
  readonly actions: IntegrationsPageActions;
  readonly feedback: SettingsMutationFeedback;
}): React.ReactNode {
  const [copyStatus, setCopyStatus] = React.useState("");
  const [draft, setDraft] = React.useState<
    OrganisationInferenceSelection["kind"]
  >(props.selection.kind);
  // A source change that waits to be saved is the one filled action; the
  // connection below it then offers its action as a quiet one.
  const sourceChange = props.canManage && draft !== props.selection.kind;
  return (
    <div className="codex-integration">
      <InferenceSourceChoice
        selection={props.selection}
        draft={draft}
        setDraft={setDraft}
        canManage={props.canManage}
        busy={props.selectionBusy}
        actions={props.actions}
        feedback={props.feedback}
      />
      {draft === "claude_oauth" ? (
        <ClaudeConnectionPanel
          organisationId={props.organisationId}
          canManage={props.canManage}
          inUse={props.selection.kind === "claude_oauth"}
          primary={!sourceChange}
          state={props.claudeState}
          setState={props.setClaudeState}
        />
      ) : null}
      {draft === "codex_subscription" ||
      props.connection.kind !== "disconnected"
        ? renderCodexConnection(
            props,
            draft,
            !sourceChange,
            copyStatus,
            setCopyStatus,
          )
        : null}
      <SlackReasoningEffortPanel
        organisationId={props.organisationId}
        source={props.selection.kind}
        canManage={props.canManage}
      />
      <p className="visually-hidden" aria-live="polite">
        {copyStatus}
      </p>
      {renderMutationFeedback(props.feedback, { kind: "codex_connection" })}
    </div>
  );
}

/**
 * Title and state read as one line, so the chip sits beside the heading rather
 * than stretching across the card as its own grid row. The provider tile gives
 * the card the same identity mark every other connection card carries.
 */
export function codexPanelHeading(
  title: string,
  status: StatusChipStatus,
  tile: { readonly provider: ProviderTileName; readonly label: string },
): React.ReactNode {
  return (
    <div className="setup-heading">
      <div className="setup-heading-identity">
        <ProviderTile provider={tile.provider} label={tile.label} />
        <h4>{title}</h4>
      </div>
      <StatusChip status={status} />
    </div>
  );
}

type InferenceSource = Readonly<{
  kind: OrganisationInferenceSelection["kind"];
  label: string;
  detail: string;
  /** The save button, which names the change it makes. */
  use: string;
}>;

const INFERENCE_SOURCES: readonly InferenceSource[] = [
  {
    kind: "codex_subscription",
    label: "ChatGPT",
    detail: "Use your ChatGPT plan.",
    use: "Use ChatGPT",
  },
  {
    kind: "claude_oauth",
    label: "Claude",
    detail: "Use your Claude plan.",
    use: "Use Claude",
  },
  {
    kind: "satyr_platform",
    label: "Seams AI",
    detail: "Seams provides the AI. You need no other account.",
    use: "Use Seams AI",
  },
  {
    kind: "organisation_openai_api_key",
    label: "OpenAI API key",
    detail: "Paste your own key. OpenAI bills you.",
    use: "Use this OpenAI key",
  },
  {
    kind: "organisation_anthropic_api_key",
    label: "Anthropic API key",
    detail: "Paste your own key. Anthropic bills you.",
    use: "Use this Anthropic key",
  },
];

type InferenceApiKeyField = Readonly<{
  name: "openAiApiKey" | "anthropicApiKey";
  label: string;
  provider: string;
}>;

function inferenceApiKeyField(
  kind: OrganisationInferenceSelection["kind"],
): InferenceApiKeyField | null {
  switch (kind) {
    case "organisation_openai_api_key":
      return {
        name: "openAiApiKey",
        label: "OpenAI API key",
        provider: "OpenAI",
      };
    case "organisation_anthropic_api_key":
      return {
        name: "anthropicApiKey",
        label: "Anthropic API key",
        provider: "Anthropic",
      };
    case "claude_oauth":
    case "codex_subscription":
    case "satyr_platform":
      return null;
    default:
      return assertNever(kind, "Unexpected settings state");
  }
}

/**
 * The sources as a list that shows every choice and what it costs, in place
 * of a menu that hides them. The save button shows only when it would change
 * something, so the connection below stays the one action of a saved source.
 */
function InferenceSourceChoice(props: {
  readonly selection: OrganisationInferenceSelection;
  readonly draft: OrganisationInferenceSelection["kind"];
  readonly setDraft: React.Dispatch<
    React.SetStateAction<OrganisationInferenceSelection["kind"]>
  >;
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly actions: IntegrationsPageActions;
  readonly feedback: SettingsMutationFeedback;
}): React.ReactNode {
  if (!props.canManage)
    return (
      <div className="integration-setup">
        <h4>AI account</h4>
        <p>{inferenceSelectionSummary(props.selection)}</p>
      </div>
    );
  const error = mutationFeedbackMessage(props.feedback, {
    kind: "inference_selection",
  });
  const apiKey = inferenceApiKeyField(props.draft);
  const changed = props.draft !== props.selection.kind;
  const source = INFERENCE_SOURCES.find(
    matchesInferenceSource.bind(null, props.draft),
  );
  return (
    <div className="integration-setup">
      <form
        className="stacked-form"
        onSubmit={props.actions.saveInferenceSelection}
      >
        <fieldset
          className="inference-choices"
          disabled={props.busy}
          aria-describedby={
            error === null
              ? "inference-source-help"
              : "inference-source-help inference-source-error"
          }
        >
          <legend className="visually-hidden">AI account</legend>
          {INFERENCE_SOURCES.map(
            renderInferenceChoice.bind(
              null,
              props.selection.kind,
              props.draft,
              props.setDraft,
            ),
          )}
        </fieldset>
        <p id="inference-source-help" className="field-hint">
          A change applies to new conversations only.
        </p>
        {apiKey === null ? null : (
          <>
            <label>
              {apiKey.label}
              <input
                key={apiKey.name}
                type="password"
                name={apiKey.name}
                required
                pattern=".*\S.*"
                title={`Enter an ${apiKey.label}.`}
                autoComplete="off"
                spellCheck={false}
                disabled={props.busy}
                aria-invalid={error === null ? undefined : true}
                aria-describedby={
                  error === null
                    ? "inference-api-key-help"
                    : "inference-api-key-help inference-source-error"
                }
              />
            </label>
            <p id="inference-api-key-help" className="field-hint">
              {changed
                ? `Seams Pantry does not show the key again after you save it. ${apiKey.provider} bills usage to your account.`
                : `A key is saved. Enter a new key only to replace it. ${apiKey.provider} bills usage to your account.`}
            </p>
          </>
        )}
        {error === null ? null : (
          <p id="inference-source-error" className="error-text" role="alert">
            {error}
          </p>
        )}
        {changed || apiKey !== null ? (
          <div className="connection-actions">
            <button
              type="submit"
              className="connection-primary-action"
              disabled={props.busy}
            >
              {props.busy
                ? "Saving…"
                : changed
                  ? (source?.use ?? "Use this source")
                  : "Replace key"}
            </button>
          </div>
        ) : null}
      </form>
    </div>
  );
}

function matchesInferenceSource(
  kind: OrganisationInferenceSelection["kind"],
  source: InferenceSource,
): boolean {
  return source.kind === kind;
}

function renderInferenceChoice(
  saved: OrganisationInferenceSelection["kind"],
  draft: OrganisationInferenceSelection["kind"],
  setDraft: React.Dispatch<
    React.SetStateAction<OrganisationInferenceSelection["kind"]>
  >,
  source: InferenceSource,
): React.ReactNode {
  return (
    <label key={source.kind}>
      <input
        type="radio"
        name="inferenceSelection"
        value={source.kind}
        checked={draft === source.kind}
        onChange={updateInferenceSelectionDraft.bind(null, setDraft)}
      />
      <span>
        <span className="inference-choice-title">
          <strong>{source.label}</strong>
          {saved === source.kind ? (
            <StatusChip status={{ kind: "success", label: "In use" }} />
          ) : null}
        </span>
        <small>{source.detail}</small>
      </span>
    </label>
  );
}

function updateInferenceSelectionDraft(
  setDraftSelectionKind: React.Dispatch<
    React.SetStateAction<OrganisationInferenceSelection["kind"]>
  >,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  const selection = parseInferenceSelection(event.currentTarget.value);
  if (selection !== null) setDraftSelectionKind(selection.kind);
}

function inferenceSelectionSummary(
  selection: OrganisationInferenceSelection,
): string {
  switch (selection.kind) {
    case "claude_oauth":
      return "This workspace uses its Claude plan.";
    case "codex_subscription":
      return "This workspace uses its ChatGPT plan.";
    case "satyr_platform":
      return "This workspace uses Seams AI.";
    case "organisation_openai_api_key":
      return "This workspace runs Pi with its OpenAI API key. OpenAI bills usage to the workspace account.";
    case "organisation_anthropic_api_key":
      return "This workspace runs Pi with its Anthropic API key. Anthropic bills usage to the workspace account.";
    default:
      return assertNever(selection, "Unexpected settings state");
  }
}

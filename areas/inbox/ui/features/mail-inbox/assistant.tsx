import React from "react";
import {
  parseMailAssistantStatus,
  parseMailAssistantResult,
  type MailAssistantStatus,
  type MailAssistantResult,
  type MailAssistantCommand,
  type MailRule,
  type MailDecision,
} from "@purin-labs/control-api";
import { mailAssistantRequest } from "./api";
import { mailRuleLabel } from "./rule-label";
import type { Variant } from "@purin-labs/type-utils";

type Props = Readonly<{
  organisationId: string;
  accountId: string;
  decision: MailDecision | null;
  revision: number;
  canManage: boolean;
  onRule: (rule: MailRule) => void;
}>;
const RULE_SUGGESTIONS = [
  {
    label: "Supplier delays",
    instruction: "Prioritize emails from suppliers reporting delivery delays.",
  },
  {
    label: "Receipts",
    instruction:
      "Create a Receipts category for receipts and order confirmations.",
  },
  {
    label: "Wholesale",
    instruction: "Create a Wholesale category for wholesale inquiries.",
  },
] as const;
type Work =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "working"; command: MailAssistantCommand }>;
type State = Readonly<{
  status: MailAssistantStatus | null;
  work: Work;
  prompt: string;
  consent: boolean;
  result: MailAssistantResult | null;
  error: string | null;
}>;
export class MailAssistantPanel extends React.Component<Props, State> {
  state: State = {
    status: null,
    work: { kind: "idle" },
    prompt: "",
    consent: false,
    result: null,
    error: null,
  };
  private request: AbortController | null = null;
  private resultHeading = React.createRef<HTMLHeadingElement>();
  componentDidMount(): void {
    void this.load();
  }
  componentWillUnmount(): void {
    this.request?.abort();
  }
  componentDidUpdate(previous: Props): void {
    if (previous.decision !== this.props.decision) {
      if (this.state.work.kind === "working") this.request?.abort();
      this.setState({ result: null, work: { kind: "idle" }, error: null });
    }
  }
  private load = async (): Promise<void> => {
    const request = new AbortController();
    this.request = request;
    try {
      const status = parseMailAssistantStatus(
        await mailAssistantRequest(
          this.props.organisationId,
          this.props.accountId,
          null,
          request.signal,
        ),
      );
      if (status === null)
        throw new Error("Inbox assistance returned an unexpected response.");
      if (!request.signal.aborted) this.setState({ status });
    } catch (error) {
      if (!request.signal.aborted) this.setState({ error: errorText(error) });
    }
  };
  private edit = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    this.setState({ prompt: event.target.value });
  };
  private consent = (event: React.ChangeEvent<HTMLInputElement>): void => {
    this.setState({ consent: event.target.checked });
  };
  private chooseSuggestion = (
    event: React.MouseEvent<HTMLButtonElement>,
  ): void => {
    const instruction = event.currentTarget.dataset.instruction;
    if (instruction !== undefined) this.setState({ prompt: instruction });
  };
  private renderSuggestion = (
    suggestion: (typeof RULE_SUGGESTIONS)[number],
  ): React.ReactNode => {
    return (
      <button
        key={suggestion.label}
        type="button"
        data-instruction={suggestion.instruction}
        onClick={this.chooseSuggestion}
        disabled={this.state.work.kind === "working"}
      >
        {suggestion.label}
      </button>
    );
  };
  private submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (
      this.state.prompt.trim().length > 0 &&
      this.state.status?.kind === "ready"
    )
      void this.run({
        kind: "proposeRule",
        prompt: this.state.prompt,
        modelRouteDigest: this.state.status.modelRouteDigest,
        consent: true,
      });
  };
  private explain = (): void => {
    const decision = this.props.decision;
    if (decision !== null && this.state.status?.kind === "ready")
      void this.run({
        kind: "explainDecision",
        messageId: decision.classification.messageId,
        ruleId: decision.rule.ruleId,
        expectedRevision: this.props.revision,
        modelRouteDigest: this.state.status.modelRouteDigest,
        consent: true,
      });
  };
  private run = async (command: MailAssistantCommand): Promise<void> => {
    if (
      !this.state.consent ||
      this.state.status?.kind !== "ready" ||
      this.state.work.kind === "working"
    )
      return;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.setState({
      work: { kind: "working", command },
      result: null,
      error: null,
    });
    try {
      const result = parseMailAssistantResult(
        await mailAssistantRequest(
          this.props.organisationId,
          this.props.accountId,
          command,
          request.signal,
        ),
      );
      if (result === null)
        throw new Error("Inbox assistance returned an unexpected response.");
      if (!request.signal.aborted)
        this.setState({ work: { kind: "idle" }, result }, this.focusResult);
    } catch (error) {
      if (!request.signal.aborted)
        this.setState({ work: { kind: "idle" }, error: errorText(error) });
    }
  };
  private focusResult = (): void => {
    this.resultHeading.current?.focus();
  };
  private reviewRule = (): void => {
    const result = this.state.result;
    if (result?.kind === "ruleProposal") {
      this.props.onRule(result.rule);
      this.setState({ result: null, prompt: "" });
    }
  };
  render(): React.ReactNode {
    const { status, work, result } = this.state;
    const disabled =
      status?.kind !== "ready" ||
      !this.state.consent ||
      work.kind === "working";
    return (
      <section className="mail-assistant" aria-label="Inbox assistant">
        <h3>What matters to you?</h3>
        <p>
          Tell JEV what to prioritize or group. Review sample matches before
          publishing. You can also explain a selected classification.
        </p>
        <div
          className="mail-assistant-suggestions"
          aria-label="Suggested instructions"
        >
          {RULE_SUGGESTIONS.map(this.renderSuggestion)}
        </div>
        {status?.kind === "blocked" ? (
          <p role="status">
            {status.reason === "eligibility_required"
              ? "Processing approval is required for this mailbox and the workspace model."
              : "Configure a workspace model to use Inbox assistance."}
          </p>
        ) : null}
        {status?.kind === "ready" ? (
          <label className="mail-assistant-consent">
            <input
              type="checkbox"
              checked={this.state.consent}
              onChange={this.consent}
            />
            Allow this request and selected email evidence to be processed by{" "}
            {recipientName(status.recipient)} using {status.model}.
          </label>
        ) : null}
        <form onSubmit={this.submit}>
          <label htmlFor="mail-assistant-prompt">Your instruction</label>
          <textarea
            id="mail-assistant-prompt"
            maxLength={2000}
            value={this.state.prompt}
            onChange={this.edit}
            placeholder="Prioritize supplier delivery delays. Group receipts into their own tab."
            disabled={work.kind === "working"}
          />
          <button
            type="submit"
            disabled={disabled || this.state.prompt.trim().length === 0}
          >
            Suggest a rule
          </button>
        </form>
        {this.props.decision !== null ? (
          <button type="button" disabled={disabled} onClick={this.explain}>
            Explain selected decision
          </button>
        ) : null}
        {work.kind === "working" ? (
          <p role="status">Preparing a transient response…</p>
        ) : null}
        {this.state.error !== null ? (
          <p role="alert">{this.state.error}</p>
        ) : null}
        {result !== null ? (
          <div className="mail-assistant-result">
            <h3 ref={this.resultHeading} tabIndex={-1}>
              {result.kind === "ruleProposal"
                ? "Suggested criteria"
                : "Decision explanation"}
            </h3>
            {result.kind === "ruleProposal" ? (
              <>
                <p>{mailRuleLabel(result.rule)}</p>
                <p>{result.rule.instruction}</p>
                {this.props.canManage ? (
                  <button type="button" onClick={this.reviewRule}>
                    Review in rule editor
                  </button>
                ) : (
                  <p>Ask a mailbox administrator to publish this rule.</p>
                )}
              </>
            ) : (
              <>
                <p className="mail-assistant-text">{result.text}</p>
                <p>
                  {result.evidence === "changed"
                    ? "The email has changed since classification. This explanation uses current evidence."
                    : "This explanation was reconstructed from the criteria and current email."}{" "}
                  JEV's original reasoning was not recorded.
                </p>
              </>
            )}
          </div>
        ) : null}
        <p className="mail-inbox-note">
          Responses clear when you close JEV or leave this conversation. JEV
          supports rule suggestions and classification explanations here.
        </p>
      </section>
    );
  }
}
function recipientName(
  recipient: Variant<MailAssistantStatus, "ready">["recipient"],
): string {
  switch (recipient) {
    case "openrouter":
      return "OpenRouter and the selected model provider";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
  }
}
function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Inbox assistance is unavailable.";
}

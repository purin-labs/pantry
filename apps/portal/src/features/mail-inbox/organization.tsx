import React from "react";
import { isRecord } from "@seams/std";
import {
  parseMailOrganizationView,
  parseMailClassifications,
  parseMailRules,
  type MailClassification,
  type MailRule,
  type MailInboxMessage,
} from "@seams/control-api";
import { mailOrganizationRequest } from "./api";
import { mailRuleLabel } from "./rule-label";

import {
  mailProcessingView,
  processingNotice,
  type MailProcessingState,
} from "./processing-state";

type Props = Readonly<{
  organisationId: string;
  accountId: string;
  canManage: boolean;
  messages: readonly MailInboxMessage[];
  classificationMessageIds: readonly string[];
  onChange: (state: MailProcessingState) => void;
}>;
type State = Readonly<{
  processing: MailProcessingState;
  rules: readonly MailRule[];
  error: string | null;
  consent: boolean;
  preview: readonly MailClassification[];
}>;
const RULE_COPY: Record<
  MailRule["kind"],
  Readonly<{ title: string; question: string; remove: string }>
> = {
  categorize: {
    title: "Category",
    question: "Which emails belong here?",
    remove: "Remove category",
  },
  prioritize: {
    title: "Priority",
    question: "Which emails are important?",
    remove: "Remove priority rule",
  },
  investigate_supplier_delay: {
    title: "Supplier delay reply",
    question: "Which supplier delay emails need a reply?",
    remove: "Remove supplier delay rule",
  },
};
export class MailOrganizationPanel extends React.Component<Props, State> {
  state: State = {
    processing: { kind: "loading" },
    rules: [],
    error: null,
    consent: false,
    preview: [],
  };
  private readRequest: AbortController | null = null;
  private commandRequest: AbortController | null = null;
  private rulesInitialized = false;
  private poll: number | null = null;
  private editor = React.createRef<HTMLElement>();
  componentDidMount(): void {
    void this.load();
  }
  componentWillUnmount(): void {
    this.readRequest?.abort();
    this.commandRequest?.abort();
    if (this.poll !== null) window.clearTimeout(this.poll);
  }
  componentDidUpdate(previous: Props): void {
    if (
      previous.messages.map(messageId).join(",") !==
      this.props.messages.map(messageId).join(",")
    ) {
      this.setState({ preview: [] });
      this.setNotice("");
    }
    if (
      previous.classificationMessageIds.join(",") !==
      this.props.classificationMessageIds.join(",")
    )
      void this.load();
  }
  reviewSuggestedRule(rule: MailRule): void {
    if (this.state.rules.length >= 8) {
      this.setState({
        error:
          "Remove a rule before adding another. Eight rules are supported.",
      });
      return;
    }
    const rules = parseMailRules([...this.state.rules, rule]);
    if (rules === null) {
      this.setState({
        error: "Finish your current criteria before adding the suggested rule.",
      });
      return;
    }
    this.setState(
      {
        rules,
        preview: [],
        consent: false,
      },
      this.focusSuggestedRule,
    );
    this.setNotice(
      "Suggested criteria added for review. Check them before publishing.",
    );
  }
  private setNotice = (notice: string): void => {
    const processing = this.state.processing;
    if (processing.kind === "ready")
      this.changeProcessing({ kind: "ready", view: processing.view, notice });
  };
  private focusSuggestedRule = (): void => {
    const editor = this.editor.current;
    if (editor === null) return;
    const criteria = editor.querySelectorAll<HTMLTextAreaElement>("textarea");
    criteria.item(criteria.length - 1)?.focus();
  };
  private changeProcessing = (processing: MailProcessingState): void => {
    this.setState({ processing });
    this.props.onChange(processing);
  };
  private load = async (notice = ""): Promise<void> => {
    // Navigation reads wait for the command, which reconciles the latest page.
    if (this.commandRequest !== null) return;
    this.readRequest?.abort();
    if (this.poll !== null) window.clearTimeout(this.poll);
    const request = new AbortController();
    this.readRequest = request;
    // A read of a view the page already shows stays silent: the poll while
    // mail waits for classification runs every few seconds.
    if (mailProcessingView(this.state.processing) === null)
      this.changeProcessing({ kind: "loading" });
    try {
      const raw = await mailOrganizationRequest(
        this.props.organisationId,
        this.props.accountId,
        { kind: "read", messageIds: this.props.classificationMessageIds },
        request.signal,
      );
      if (request.signal.aborted) return;
      const view = parseMailOrganizationView(raw);
      if (view === null)
        throw new Error("Email rules returned an unexpected response.");
      const rules = this.rulesInitialized ? this.state.rules : view.rules.rules;
      this.rulesInitialized = true;
      this.setState({ rules, error: null });
      this.changeProcessing({ kind: "ready", view, notice });
      if (view.pending > 0)
        this.poll = window.setTimeout(this.refreshView, 3000);
    } catch (error) {
      if (!request.signal.aborted) {
        const message = errorText(error);
        this.changeProcessing({ kind: "unavailable", message });
        this.setState({ error: message });
      }
    } finally {
      if (this.readRequest === request) this.readRequest = null;
    }
  };
  private editRule = (
    event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): void => {
    const ruleId = event.target.dataset.ruleId;
    const field = event.target.dataset.field;
    const rules: MailRule[] = [];
    for (const rule of this.state.rules) {
      if (rule.ruleId !== ruleId) {
        rules.push(rule);
        continue;
      }
      const instruction =
        field === "instruction" ? event.target.value : rule.instruction;
      if (rule.kind === "categorize")
        rules.push({
          kind: "categorize",
          ruleId: rule.ruleId,
          instruction,
          category: field === "category" ? event.target.value : rule.category,
        });
      else rules.push({ kind: rule.kind, ruleId: rule.ruleId, instruction });
    }
    this.setState({ rules, preview: [], consent: false });
    this.setNotice("");
  };
  private addRule = (kind: MailRule["kind"]): void => {
    const ruleId = `rule_${crypto.randomUUID().replaceAll("-", "")}`;
    const rule: MailRule =
      kind === "categorize"
        ? { kind, ruleId, instruction: "", category: "" }
        : { kind, ruleId, instruction: "" };
    this.setState({
      rules: [...this.state.rules, rule],
      preview: [],
      consent: false,
    });
  };
  private addCategory = (): void => this.addRule("categorize");
  private addPriority = (): void => this.addRule("prioritize");
  private addInvestigation = (): void =>
    this.addRule("investigate_supplier_delay");
  private removeRule = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const rules: MailRule[] = [];
    for (const rule of this.state.rules)
      if (rule.ruleId !== event.currentTarget.dataset.ruleId) rules.push(rule);
    this.setState({ rules, preview: [], consent: false });
  };
  private consent = (event: React.ChangeEvent<HTMLInputElement>): void =>
    this.setState({ consent: event.target.checked });
  private act = async (
    command: import("@seams/control-api").MailOrganizationCommand,
    notice: string,
  ): Promise<void> => {
    if (this.state.processing.kind !== "ready" || this.commandRequest !== null)
      return;
    this.readRequest?.abort();
    if (this.poll !== null) window.clearTimeout(this.poll);
    const request = new AbortController();
    this.commandRequest = request;
    const messageIds = this.props.messages.map(messageId).join(",");
    this.setState({ error: null });
    this.changeProcessing({
      kind: "updating",
      view: this.state.processing.view,
    });
    let reconciliationNotice = notice;
    try {
      const raw = await mailOrganizationRequest(
        this.props.organisationId,
        this.props.accountId,
        command,
        request.signal,
      );
      if (request.signal.aborted) return;
      if (command.kind === "preview") {
        const preview =
          isRecord(raw) && raw.kind === "preview"
            ? parseMailClassifications(raw.classifications)
            : null;
        if (preview === null)
          throw new Error("Preview returned an unexpected response.");
        if (messageIds === this.props.messages.map(messageId).join(","))
          this.setState({ preview });
        else reconciliationNotice = "Preview finished for the previous page.";
      }
    } catch (error) {
      if (!request.signal.aborted)
        reconciliationNotice = `${errorText(error)} Saved processing settings have been reloaded.`;
    } finally {
      if (this.commandRequest === request) this.commandRequest = null;
    }
    // A failed response can still follow a committed command. Read; never resend.
    if (!request.signal.aborted) await this.load(reconciliationNotice);
  };
  private reviewedRules = (): readonly MailRule[] | null => {
    const rules = parseMailRules(this.state.rules);
    if (rules === null) {
      this.setState({
        error:
          "Add at least one rule with its matching criteria. Categories also need a name.",
      });
      return null;
    }
    if (!this.state.consent) {
      this.setState({
        error:
          "Confirm TypeSafe processing before previewing or publishing rules.",
      });
      return null;
    }
    return rules;
  };
  private preview = (): void => {
    const rules = this.reviewedRules();
    if (rules !== null)
      void this.act(
        {
          kind: "preview",
          rules,
          messageIds: this.props.messages.slice(0, 5).map(messageId),
          consent: true,
        },
        "Preview complete. Publishing applies these criteria to future messages.",
      );
  };
  private publish = (): void => {
    const rules = this.reviewedRules();
    const view = mailProcessingView(this.state.processing);
    if (rules !== null && view !== null)
      void this.act(
        {
          kind: "publish",
          expectedRevision: view.rules.revision,
          rules,
          consent: true,
        },
        "Rules published for future messages.",
      );
  };
  setAutomaticProcessing(enabled: boolean): void {
    const view = mailProcessingView(this.state.processing);
    if (
      !this.props.canManage ||
      this.state.processing.kind !== "ready" ||
      view === null ||
      (enabled ? view.rules.kind !== "paused" : view.rules.kind !== "published")
    )
      return;
    void this.act(
      {
        kind: enabled ? "resume" : "pause",
        expectedRevision: view.rules.revision,
      },
      enabled
        ? "Automatic JEV processing resumed for future arrivals."
        : "Automatic JEV processing paused.",
    );
  }
  private classify = (): void => {
    const view = mailProcessingView(this.state.processing);
    if (view !== null)
      void this.act(
        {
          kind: "classify",
          expectedRevision: view.rules.revision,
          messageIds: this.props.messages.map(messageId),
        },
        "These messages are queued for classification.",
      );
  };
  refreshView = (): void => {
    void this.load();
  };
  private renderPreview = (result: MailClassification): React.ReactNode => {
    let subject = "Selected message";
    for (const message of this.props.messages)
      if (message.messageId === result.messageId)
        subject = message.subject || "No subject";
    let label = "Priority";
    for (const rule of this.state.rules)
      if (rule.ruleId === result.ruleId) label = mailRuleLabel(rule);
    return (
      <li key={`${result.messageId}:${result.ruleId}`}>
        <strong>{subject}</strong> · {label}:{" "}
        {result.outcome.replaceAll("_", " ")}
      </li>
    );
  };
  private renderRule = (rule: MailRule, index: number): React.ReactNode => {
    const copy = RULE_COPY[rule.kind];
    return (
      <fieldset key={rule.ruleId} className="mail-rule">
        <legend>
          {copy.title} {index + 1}
        </legend>
        {rule.kind === "categorize" ? (
          <label>
            Category name
            <input
              value={rule.category}
              maxLength={60}
              data-rule-id={rule.ruleId}
              data-field="category"
              onChange={this.editRule}
            />
          </label>
        ) : null}
        <label>
          {copy.question}
          <textarea
            value={rule.instruction}
            maxLength={1000}
            data-rule-id={rule.ruleId}
            data-field="instruction"
            onChange={this.editRule}
            placeholder="Describe the emails in your own words"
          />
        </label>
        <button
          type="button"
          data-rule-id={rule.ruleId}
          onClick={this.removeRule}
        >
          {copy.remove}
        </button>
      </fieldset>
    );
  };
  render(): React.ReactNode {
    const view = mailProcessingView(this.state.processing);
    const busy = this.state.processing.kind !== "ready";
    const hasInvestigation = this.state.rules.some(isInvestigationRule);
    if (!this.props.canManage)
      return (
        <section className="mail-organization" aria-label="Inbox rules">
          <h3>Inbox rules</h3>
          <p className="mail-inbox-note">
            A mailbox administrator manages these rules.
          </p>
          <ul>{view?.rules.rules.map(renderReadonlyRule)}</ul>
          {this.state.error !== null ? (
            <p role="alert">{this.state.error}</p>
          ) : null}
        </section>
      );
    return (
      <section
        ref={this.editor}
        className="mail-organization"
        aria-label="Inbox rules"
      >
        <h3>
          Inbox rules
          {view?.rules.kind === "published"
            ? " · Active"
            : view?.rules.kind === "paused"
              ? " · Paused"
              : ""}
        </h3>
        <p className="mail-inbox-note">
          Describe categories and priorities in your own words. Preview up to
          five messages from this page, then publish for future arrivals.
        </p>
        {view?.readiness === "typesafe_unavailable" ? (
          <p>Connect TypeSafe in Integrations to classify emails.</p>
        ) : null}
        {view?.readiness === "eligibility_required" ? (
          <p>
            This mailbox needs current approval for TypeSafe email processing.
          </p>
        ) : null}
        {view?.readiness === "history_expired" ? (
          <p role="alert">
            Gmail history expired. Pause and resume automatic processing to
            start with future arrivals, then classify missed messages
            explicitly.
          </p>
        ) : null}
        {this.state.rules.length === 0 ? (
          <p className="mail-inbox-note">
            Start with a suggestion above, or add a category or priority rule.
          </p>
        ) : null}
        <div>{this.state.rules.map(this.renderRule)}</div>
        <div className="mail-rule-actions">
          <button
            type="button"
            onClick={this.addCategory}
            disabled={busy || this.state.rules.length >= 8}
          >
            Add category
          </button>
          <button
            type="button"
            onClick={this.addInvestigation}
            disabled={busy || this.state.rules.length >= 8 || hasInvestigation}
          >
            Add supplier delay reply rule
          </button>
          <button
            type="button"
            onClick={this.addPriority}
            disabled={busy || this.state.rules.length >= 8}
          >
            Add priority rule
          </button>
        </div>
        {hasInvestigation ? (
          <p className="mail-inbox-note">
            For matching future arrivals, the mailbox’s assigned agent prepares
            a reply for your review. No email or acknowledgement is sent. Enable
            the mailbox’s agent and email processing in Integrations before
            publishing. While this rule is active, JEV routes new arrivals and
            Cue automatic replies are suspended. Nonmatching emails remain for
            you to handle. Preview and Classify this page only classify
            messages.
          </p>
        ) : null}
        <label className="mail-rule-consent">
          <input
            type="checkbox"
            checked={this.state.consent}
            onChange={this.consent}
          />
          Allow TypeSafe to process email evidence from this mailbox for these
          rules.
          {hasInvestigation
            ? " Allow the assigned agent to prepare review drafts for matching future arrivals."
            : ""}
        </label>
        <div className="mail-rule-actions">
          <button
            type="button"
            onClick={this.preview}
            disabled={busy || this.props.messages.length === 0}
          >
            Preview this page
          </button>
          <button
            className="connection-primary-action"
            type="button"
            onClick={this.publish}
            disabled={busy}
          >
            Publish rules
          </button>
          <button
            type="button"
            onClick={this.classify}
            disabled={
              busy ||
              view?.rules.kind !== "published" ||
              this.props.messages.length === 0
            }
          >
            Classify this page
          </button>
          <button
            type="button"
            onClick={this.refreshView}
            disabled={this.commandRequest !== null}
          >
            Refresh rules
          </button>
        </div>
        <p role="status">
          {this.state.processing.kind === "unavailable"
            ? ""
            : processingNotice(this.state.processing)}
        </p>
        {this.state.error !== null ? (
          <p role="alert">{this.state.error}</p>
        ) : null}
        {view !== null ? (
          <p className="mail-inbox-note">
            {view.pending} messages pending · {view.failed} unavailable ·{" "}
            {view.budgetPaused} waiting for the daily budget. Unclassified mail
            remains in All. Rule changes require a new explicit historical
            classification. Results are loaded for the displayed messages.
          </p>
        ) : null}
        {this.state.preview.length > 0 ? (
          <div className="mail-preview">
            <h4>Sample matches</h4>
            <ul className="mail-preview-results">
              {this.state.preview.map(this.renderPreview)}
            </ul>
          </div>
        ) : null}
      </section>
    );
  }
}
function messageId(message: MailInboxMessage): string {
  return message.messageId;
}
function renderReadonlyRule(rule: MailRule): React.ReactNode {
  return (
    <li key={rule.ruleId}>
      <strong>{mailRuleLabel(rule)}</strong>
      <p>{rule.instruction}</p>
    </li>
  );
}
function isInvestigationRule(rule: MailRule): boolean {
  return rule.kind === "investigate_supplier_delay";
}
function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Email organization is unavailable.";
}

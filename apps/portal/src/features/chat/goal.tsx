import React from "react";
import { Maximize2, Pause, Play, Target, Trash2, X } from "lucide-react";
import {
  parseChatGoalView,
  type ChatGoalView,
  type ChatGoalCommand,
  type ConversationId,
} from "@seams/control-api";
import { errorMessage } from "@seams/std";
import { controlRead, controlWrite, readCookie } from "../../control-client";
import { syncDialog, cancelDialog } from "../../dialog";
import "./goal.css";

/** Token budget that `/goal <objective>` uses when the chat has no goal yet. */
export const DEFAULT_GOAL_TOKEN_BUDGET = 1_000_000;

type Props = {
  organisationId: string;
  conversationId: ConversationId;
  observationVersion: number;
  /** A request of this chat runs or starts. */
  busy: boolean;
};
type State = {
  view: ChatGoalView | null;
  error: string | null;
  saving: boolean;
  open: boolean;
  completing: boolean;
};

const GOAL_READ_RETRY_MS = 5_000;
const GOAL_BUSY_MESSAGE =
  "Wait for the current turn to finish before setting a goal.";

export class ChatGoalControl extends React.Component<Props, State> {
  state: State = {
    view: null,
    error: null,
    saving: false,
    open: false,
    completing: false,
  };
  private readonly dialog = React.createRef<HTMLDialogElement>();
  private readonly errorNotice = React.createRef<HTMLParagraphElement>();
  private readonly heading = `chat-goal-${crypto.randomUUID()}`;
  private version = 0;
  private reads = 0;
  private retryTimer: number | null = null;
  private observing = false;
  private editingRevision: number | null = null;

  componentDidMount(): void {
    void this.load("background");
  }
  componentDidUpdate(previous: Props, previousState: State): void {
    syncDialog(this.dialog, this.state.open);
    if (
      this.state.open &&
      this.state.error !== null &&
      previousState.error !== this.state.error
    )
      this.errorNotice.current?.focus();
    if (previous.observationVersion !== this.props.observationVersion)
      void this.observe();
    if (previous.busy && !this.props.busy && this.state.view === null)
      void this.load("background");
  }
  componentWillUnmount(): void {
    this.version += 1;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    syncDialog(this.dialog, false);
  }
  /** Opens the drawer for the current goal. */
  openEditor(): void {
    this.setState({ open: true });
    if (this.state.view === null) void this.load();
  }
  /**
   * Sets the goal from `/goal <objective>`. Keeps the budget of an existing
   * goal. Returns false, with the reason shown, when the goal was not set.
   */
  async startGoal(objective: string): Promise<boolean> {
    const view = this.state.view ?? (await this.load());
    if (view === null) return false;
    const reason = this.startBlocker(view);
    if (reason !== null) {
      this.setState({ error: reason });
      return false;
    }
    const goal = view.goal.kind === "present" ? view.goal.goal : null;
    this.editingRevision = null;
    return this.send({
      kind: "set",
      objective,
      tokenBudget: goal?.tokenBudget ?? DEFAULT_GOAL_TOKEN_BUDGET,
    });
  }
  private startBlocker(view: ChatGoalView): string | null {
    if (!view.canEdit) return "You cannot set a goal in this chat.";
    if (view.support.kind !== "supported")
      return "Inference is unavailable. Restore the connection before setting a goal.";
    if (view.execution === "busy")
      return "Wait for the current turn to finish before setting a goal.";
    return null;
  }
  private path(): string {
    return `/v1/control/organisations/${encodeURIComponent(this.props.organisationId)}/chat/conversations/${this.props.conversationId}/goal`;
  }
  private async read(): Promise<ChatGoalView> {
    const view = parseChatGoalView(await controlRead(this.path()));
    if (view === null)
      throw new Error("Could not read the goal. Refresh and try again.");
    return view;
  }
  /**
   * The server can refuse this read while a request runs, starts or waits for a
   * person. That is not a failure of the person's request, so a background read
   * then says nothing and reads again. With no request running, every failure
   * shows.
   */
  private async load(
    source: "person" | "background" = "person",
  ): Promise<ChatGoalView | null> {
    const version = ++this.version;
    this.reads += 1;
    if (source === "person") this.setState({ error: null });
    try {
      const view = await this.read();
      if (version !== this.version) return null;
      this.setState({ view, error: null });
      return view;
    } catch (error) {
      if (version !== this.version) return null;
      if (!this.props.busy) this.setState({ error: errorMessage(error) });
      else {
        this.retryRead();
        if (source === "person") this.setState({ error: GOAL_BUSY_MESSAGE });
      }
      return null;
    } finally {
      this.reads -= 1;
    }
  }
  private retryRead(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.state.view === null && this.reads === 0)
        void this.load("background");
    }, GOAL_READ_RETRY_MS);
  }
  private async observe(): Promise<void> {
    if (this.observing) return;
    if (this.state.view === null) {
      if (this.reads === 0) void this.load("background");
      return;
    }
    this.observing = true;
    const version = this.version;
    try {
      const view = await this.read();
      const current = this.state.view;
      if (
        version === this.version &&
        current !== null &&
        view.goal.revision >= current.goal.revision
      )
        this.setState({ view });
    } catch {
      // The bar keeps the goal that it has, and the next observation reads
      // again.
    } finally {
      this.observing = false;
    }
  }
  private close(): void {
    this.editingRevision = null;
    this.setState({ open: false, completing: false });
  }
  private edit(): void {
    if (this.state.view !== null && this.editingRevision === null)
      this.editingRevision = this.state.view.goal.revision;
  }
  private async send(command: ChatGoalCommand["command"]): Promise<boolean> {
    const view = this.state.view;
    if (view === null) return false;
    const expectedRevision = this.editingRevision ?? view.goal.revision;
    this.editingRevision = expectedRevision;
    const version = ++this.version;
    this.setState({ saving: true, error: null });
    try {
      const csrf = readCookie("satyr_control_csrf");
      if (csrf === null) throw new Error("Sign in again to change the goal.");
      const raw = await controlWrite(this.path(), "POST", {
        commandId: crypto.randomUUID(),
        expectedRevision,
        command,
      });
      const saved = parseChatGoalView(raw);
      if (saved === null)
        throw new Error(
          "Could not read the saved goal. Refresh to check its state.",
        );
      if (version === this.version) {
        this.editingRevision = null;
        this.setState({ view: saved, saving: false });
      }
      return true;
    } catch (error) {
      let latest = view;
      try {
        latest = await this.read();
      } catch {
        // Keep the last known view; the error below explains the failure.
      }
      if (version === this.version)
        this.setState({
          view: latest,
          saving: false,
          error:
            latest.goal.revision !== view.goal.revision
              ? "The saved goal changed. Your edits are preserved. Close and reopen this panel to discard your edits and review the latest goal."
              : errorMessage(error),
        });
      return false;
    }
  }
  private save(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void this.send({
      kind: "set",
      objective: String(data.get("objective") ?? ""),
      tokenBudget: Number(data.get("budget")),
    }).then(this.closeAfterSave.bind(this));
  }
  private closeAfterSave(saved: boolean): void {
    if (saved) this.setState({ open: false });
  }
  private complete(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void this.send({
      kind: "complete",
      evidence: String(data.get("evidence") ?? ""),
    }).then(this.stopCompletingAfterSave.bind(this));
  }
  private stopCompletingAfterSave(saved: boolean): void {
    if (saved) this.setState({ completing: false });
  }
  private toggleCompleting(): void {
    this.setState({ completing: !this.state.completing });
  }
  private pause(): void {
    void this.send({ kind: "pause" });
  }
  private resume(): void {
    void this.send({ kind: "resume" });
  }
  private clear(): void {
    void this.send({ kind: "clear" });
  }
  private renderBar(
    view: ChatGoalView,
    goal: NonNullable<ReturnType<typeof presentGoal>>,
  ): React.ReactNode {
    const { saving } = this.state;
    const kind = goal.state.kind;
    const canResume = this.canResume(view, goal);
    return (
      <section className="chat-goal-bar" aria-label="Goal" data-state={kind}>
        <Target size={16} aria-hidden="true" />
        <p className="chat-goal-bar-text" title={goal.objective}>
          <strong>{stateLabel(kind)}</strong> <span>{goal.objective}</span>
        </p>
        <span className="chat-goal-bar-usage" role="status">
          {compactTokens(goal.tokensUsed)} / {compactTokens(goal.tokenBudget)}
        </span>
        <button
          type="button"
          aria-label="Clear goal"
          title="Clear goal"
          disabled={saving || !view.canEdit}
          onClick={this.clear.bind(this)}
        >
          <Trash2 size={16} aria-hidden="true" />
        </button>
        {kind === "paused" || kind === "budget_limited" ? (
          <button
            type="button"
            aria-label="Resume goal"
            title="Resume goal"
            disabled={saving || !canResume}
            onClick={this.resume.bind(this)}
          >
            <Play size={16} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Pause goal"
            title="Pause goal"
            disabled={saving || !view.canEdit || kind !== "active"}
            onClick={this.pause.bind(this)}
          >
            <Pause size={16} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          aria-label="Edit goal"
          title="Edit goal"
          aria-haspopup="dialog"
          onClick={this.openEditor.bind(this)}
        >
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      </section>
    );
  }
  private canResume(
    view: ChatGoalView,
    goal: NonNullable<ReturnType<typeof presentGoal>>,
  ): boolean {
    return (
      this.startBlocker(view) === null &&
      goal.unknownOperations === 0 &&
      goal.tokensUsed < goal.tokenBudget
    );
  }
  private renderDrawer(view: ChatGoalView | null): React.ReactNode {
    if (view === null)
      return this.state.error !== null ? (
        <div className="chat-goal-panel">
          <p
            className="chat-goal-notice"
            data-tone="error"
            role="alert"
            ref={this.errorNotice}
            tabIndex={-1}
          >
            {this.state.error}
          </p>
          <button
            type="button"
            className="secondary"
            onClick={this.load.bind(this, "person")}
          >
            Try again
          </button>
        </div>
      ) : (
        <p className="chat-goal-loading" role="status">
          Loading goal…
        </p>
      );
    const { saving, error } = this.state;
    const goal = presentGoal(view);
    const canStart = this.startBlocker(view) === null;
    const kind = goal?.state.kind ?? null;
    return (
      <div className="chat-goal-panel" aria-busy={saving}>
        {error !== null ? (
          <p
            className="chat-goal-notice"
            data-tone="error"
            role="alert"
            ref={this.errorNotice}
            tabIndex={-1}
          >
            {error}
          </p>
        ) : null}
        {!view.canEdit ? (
          <p className="chat-goal-notice">
            You can view this goal. You need edit access to change it.
          </p>
        ) : null}
        {view.support.kind !== "supported" ? (
          <p className="chat-goal-notice">
            Inference is unavailable. Restore the connection before starting or
            resuming a goal.
          </p>
        ) : null}
        {view.execution === "busy" ? (
          <p className="chat-goal-notice">
            Wait for the current turn to finish before setting or resuming a
            goal.
          </p>
        ) : null}
        {goal !== null ? (
          <section className="chat-goal-summary" aria-label="Goal progress">
            <div className="chat-goal-summary-row">
              <span className="chat-goal-state" data-state={goal.state.kind}>
                {stateLabel(goal.state.kind)}
              </span>
              <span role="status">
                {goal.tokensUsed.toLocaleString()} of{" "}
                {goal.tokenBudget.toLocaleString()} tokens
              </span>
            </div>
            <div
              className="chat-goal-meter"
              data-state={goal.state.kind}
              aria-hidden="true"
            >
              <span style={meterStyle(goal.tokensUsed, goal.tokenBudget)} />
            </div>
            <p className="chat-goal-hint">
              {Math.round(goal.activeTimeMs / 1000)} s of model time
              {goal.unknownOperations > 0
                ? ` · usage is unknown for ${goal.unknownOperations} operation${goal.unknownOperations === 1 ? "" : "s"}, so resume is blocked`
                : ""}
            </p>
          </section>
        ) : null}
        <form
          key={this.editingRevision ?? view.goal.revision}
          className="chat-goal-form"
          onChange={this.edit.bind(this)}
          onSubmit={this.save.bind(this)}
        >
          <fieldset disabled={saving || !canStart}>
            <label>
              <span id={`${this.heading}-objective`}>Objective</span>
              <textarea
                aria-labelledby={`${this.heading}-objective`}
                name="objective"
                required
                maxLength={4000}
                placeholder="Describe what you want done"
                defaultValue={goal?.objective ?? ""}
              />
            </label>
            <label>
              <span>Token budget</span>
              <input
                name="budget"
                type="number"
                inputMode="numeric"
                min={1}
                max={4294967295}
                step={1}
                required
                defaultValue={goal?.tokenBudget ?? DEFAULT_GOAL_TOKEN_BUDGET}
              />
            </label>
            <p className="chat-goal-hint">{GOAL_BUDGET_HINT}</p>
            <div className="chat-goal-actions">
              {kind === "paused" || kind === "budget_limited" ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={goal === null || !this.canResume(view, goal)}
                  onClick={this.resume.bind(this)}
                >
                  Resume
                </button>
              ) : kind === "active" ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={this.pause.bind(this)}
                >
                  Pause
                </button>
              ) : null}
              <button type="submit" className="chat-goal-primary">
                Save
              </button>
            </div>
          </fieldset>
        </form>
        {goal !== null ? (
          <div className="chat-goal-more">
            <div className="chat-goal-more-actions">
              <button
                type="button"
                className="secondary"
                aria-expanded={this.state.completing}
                aria-controls={`${this.heading}-complete`}
                disabled={
                  saving || !view.canEdit || goal.state.kind === "completed"
                }
                onClick={this.toggleCompleting.bind(this)}
              >
                Complete goal
              </button>
              <button
                type="button"
                className="danger"
                disabled={saving || !view.canEdit}
                onClick={this.clear.bind(this)}
              >
                Clear goal
              </button>
            </div>
            {this.state.completing && goal.state.kind !== "completed" ? (
              <form
                id={`${this.heading}-complete`}
                className="chat-goal-form"
                onSubmit={this.complete.bind(this)}
              >
                <fieldset disabled={saving || !view.canEdit}>
                  <label>
                    <span id={`${this.heading}-evidence`}>
                      Completion evidence
                    </span>
                    <textarea
                      aria-labelledby={`${this.heading}-evidence`}
                      name="evidence"
                      required
                      maxLength={4000}
                      placeholder="What shows that the goal is done?"
                    />
                  </label>
                  <div className="chat-goal-actions">
                    <button type="submit" className="chat-goal-primary">
                      Confirm completion
                    </button>
                  </div>
                </fieldset>
              </form>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }
  private closeFromBackdrop(event: React.MouseEvent<HTMLDialogElement>): void {
    if (event.target === event.currentTarget) this.close();
  }
  render(): React.ReactNode {
    const { view, error, open } = this.state;
    const goal = view === null ? null : presentGoal(view);
    return (
      <>
        {view !== null && goal !== null ? this.renderBar(view, goal) : null}
        {!open && error !== null ? (
          <p className="chat-goal-error" role="alert">
            {error}
            {view === null ? (
              <button type="button" onClick={this.load.bind(this, "person")}>
                Try again
              </button>
            ) : null}
          </p>
        ) : null}
        <dialog
          ref={this.dialog}
          className="chat-goal-drawer"
          aria-labelledby={this.heading}
          onClick={this.closeFromBackdrop.bind(this)}
          onCancel={cancelDialog.bind(null, this.close.bind(this))}
        >
          <header className="chat-goal-drawer-header">
            <h2 id={this.heading}>
              {goal === null ? "Set goal" : "Edit goal"}
            </h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close edit goal"
              onClick={this.close.bind(this)}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          {open ? this.renderDrawer(view) : null}
        </dialog>
      </>
    );
  }
}

function meterStyle(used: number, budget: number): React.CSSProperties {
  const share = budget <= 0 ? 1 : Math.min(1, used / budget);
  return { inlineSize: `${Math.max(share * 100, used > 0 ? 2 : 0)}%` };
}

const GOAL_BUDGET_HINT =
  "The goal pauses when it reaches the budget. A higher budget keeps a paused goal paused.";

function presentGoal(view: ChatGoalView) {
  if (view.goal.kind !== "present") return null;
  return view.goal.goal.state.kind === "cleared" ? null : view.goal.goal;
}

function stateLabel(kind: string): string {
  switch (kind) {
    case "active":
      return "Pursuing goal";
    case "paused":
      return "Goal paused";
    case "budget_limited":
      return "Goal budget reached";
    case "completed":
      return "Goal completed";
    default:
      return "Goal";
  }
}

function compactTokens(tokens: number): string {
  return new Intl.NumberFormat("en", { notation: "compact" }).format(tokens);
}

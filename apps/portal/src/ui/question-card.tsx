import React from "react";
import { Check, Command, CornerDownLeft, LoaderCircle } from "lucide-react";
import "./agent-components.css";
import { assertNever } from "@purin-labs/std";

type QuestionOption = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
};

export type QuestionAnswer =
  | {
      readonly kind: "choice";
      readonly choice: QuestionOption;
      readonly text?: never;
    }
  | { readonly kind: "text"; readonly text: string; readonly choice?: never }
  | {
      readonly kind: "skipped";
      readonly text?: never;
      readonly choice?: never;
    };

export type QuestionSubmitResult =
  | { readonly kind: "accepted"; readonly message?: never }
  | { readonly kind: "failed"; readonly message: string };

export type QuestionAvailability =
  | { readonly kind: "closed"; readonly message: string }
  | { readonly kind: "paused"; readonly message: string };

export type QuestionCardProps = {
  readonly availability?: QuestionAvailability;
  readonly question: {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly options: readonly QuestionOption[];
    readonly allowCustom: boolean;
  };
  readonly onSubmit: (answer: QuestionAnswer) => Promise<QuestionSubmitResult>;
  readonly position?: { readonly current: number; readonly total: number };
};

type Selection =
  | { readonly kind: "empty"; readonly choice?: never; readonly text?: never }
  | Exclude<QuestionAnswer, { kind: "skipped" }>;

type State =
  | {
      readonly kind: "editing";
      readonly selection: Selection;
      readonly error: string | null;
      readonly answer?: never;
    }
  | {
      readonly kind: "submitting" | "answered";
      readonly answer: QuestionAnswer;
      readonly selection?: never;
      readonly error?: never;
    };

export function QuestionCard(props: QuestionCardProps): React.ReactNode {
  const errorId = React.useId();
  return (
    <QuestionForm
      errorId={errorId}
      key={props.question.id}
      question={props.question}
      onSubmit={props.onSubmit}
      availability={props.availability}
      position={props.position}
    />
  );
}

class QuestionForm extends React.Component<
  QuestionCardProps & { readonly errorId: string },
  State
> {
  state: State = {
    kind: "editing",
    selection:
      this.props.question.options.length === 0
        ? { kind: "text", text: "" }
        : { kind: "empty" },
    error: null,
  };
  private readonly form = React.createRef<HTMLFormElement>();
  private readonly error = React.createRef<HTMLParagraphElement>();
  private readonly heading = React.createRef<HTMLHeadingElement>();
  private readonly customAnswer = React.createRef<HTMLTextAreaElement>();
  private mounted = false;
  private submitting = false;

  componentDidMount(): void {
    this.mounted = true;
  }
  componentWillUnmount(): void {
    this.mounted = false;
  }

  private select(choice: QuestionOption): void {
    if (this.state.kind !== "editing") return;
    this.setState({
      kind: "editing",
      selection: { kind: "choice", choice },
      error: null,
    });
  }
  private write(event: React.ChangeEvent<HTMLTextAreaElement>): void {
    if (this.state.kind !== "editing") return;
    this.setState({
      kind: "editing",
      selection: { kind: "text", text: event.currentTarget.value },
      error: null,
    });
  }
  private selectCustom(): void {
    if (this.state.kind !== "editing" || this.state.selection.kind === "text")
      return;
    this.setState(
      {
        kind: "editing",
        selection: { kind: "text", text: "" },
        error: null,
      },
      this.focusCustomAnswer,
    );
  }
  private focusCustomAnswer = (): void => {
    this.customAnswer.current?.focus();
  };
  private shortcut(event: React.KeyboardEvent<HTMLFormElement>): void {
    if (
      event.nativeEvent.isComposing ||
      event.key !== "Enter" ||
      (!event.metaKey && !event.ctrlKey)
    )
      return;
    event.preventDefault();
    if (this.state.kind === "editing" && hasAnswer(this.state.selection))
      this.form.current?.requestSubmit();
  }
  private submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (this.state.kind !== "editing") return;
    const selection = this.state.selection;
    if (
      selection.kind === "empty" ||
      (selection.kind === "text" && !selection.text.trim())
    )
      return;
    const answer: QuestionAnswer =
      selection.kind === "text"
        ? { kind: "text", text: selection.text.trim() }
        : { kind: "choice", choice: selection.choice };
    void this.deliver(answer);
  }
  private skip(): void {
    void this.deliver({ kind: "skipped" });
  }

  private async deliver(answer: QuestionAnswer): Promise<void> {
    if (
      this.state.kind !== "editing" ||
      this.submitting ||
      this.props.availability !== undefined
    )
      return;
    const selection = this.state.selection;
    this.submitting = true;
    this.setState({ kind: "submitting", answer });
    try {
      const result = await this.props.onSubmit(answer);
      if (!this.mounted) return;
      switch (result.kind) {
        case "accepted":
          this.setState({ kind: "answered", answer }, this.focusHeading);
          break;
        case "failed":
          this.setState(
            { kind: "editing", selection, error: result.message },
            this.focusError,
          );
          break;
        default:
          assertNever(result, "Unknown question state");
      }
    } catch {
      if (this.mounted)
        this.setState(
          {
            kind: "editing",
            selection,
            error: "Your response could not be sent. Try again.",
          },
          this.focusError,
        );
    } finally {
      this.submitting = false;
    }
  }
  private focusError = (): void => {
    this.error.current?.focus();
  };
  private focusHeading = (): void => {
    this.heading.current?.focus();
  };

  private renderOption(
    selection: Selection,
    option: QuestionOption,
    index: number,
  ): React.ReactNode {
    return (
      <label className="question-option" key={option.id}>
        <input
          type="radio"
          name="answer"
          checked={
            selection.kind === "choice" && selection.choice.id === option.id
          }
          onChange={this.select.bind(this, option)}
        />
        <span className="question-option-key" aria-hidden="true">
          {optionLetter(index)}
        </span>
        <span className="question-option-copy">
          <span>{option.label}</span>
          {option.description && <small>{option.description}</small>}
        </span>
      </label>
    );
  }
  render(): React.ReactNode {
    const { question, position, availability } = this.props;
    const state = this.state;
    const selection = currentSelection(state);
    const closed = availability?.kind === "closed" || state.kind === "answered";
    const busy = state.kind === "submitting";
    const skipping = busy && state.answer.kind === "skipped";
    const disabled = busy || availability !== undefined;
    const custom = selection.kind === "text";
    return (
      <form
        ref={this.form}
        className="question-card"
        aria-label={question.title}
        onSubmit={this.submit.bind(this)}
        onKeyDown={this.shortcut.bind(this)}
      >
        <h3 ref={this.heading} tabIndex={-1}>
          <span className="question-icon-tile">
            <QuestionIcon />
          </span>
          Questions
        </h3>
        <p className="question-title">{question.title}</p>
        {question.description && (
          <p className="question-description">{question.description}</p>
        )}
        <div
          className="question-expander"
          data-open={closed}
          aria-hidden={!closed}
        >
          <div className="question-expander-content">
            <p className="question-answer">
              <Check size={16} aria-hidden="true" />
              {availability?.kind === "closed"
                ? availability.message
                : state.kind === "answered"
                  ? questionAnswerText(state.answer)
                  : ""}
            </p>
          </div>
        </div>
        <div
          className="question-expander question-editor"
          data-open={!closed}
          inert={closed}
          aria-hidden={closed}
        >
          <div className="question-expander-content">
            <fieldset
              disabled={disabled}
              aria-describedby={
                state.kind === "editing" && state.error
                  ? this.props.errorId
                  : undefined
              }
            >
              <legend className="agent-ui-sr-only">Your answer</legend>
              {question.options.map(this.renderOption.bind(this, selection))}
              {question.allowCustom && (
                <div className="question-custom">
                  {question.options.length > 0 ? (
                    <label className="question-option">
                      <input
                        type="radio"
                        name="answer"
                        checked={custom}
                        onChange={this.selectCustom.bind(this)}
                      />
                      <span className="question-option-key" aria-hidden="true">
                        {optionLetter(question.options.length)}
                      </span>
                      <span className="question-option-copy">
                        Something else…
                      </span>
                    </label>
                  ) : null}
                  <div
                    className="question-expander question-custom-expander"
                    data-open={custom}
                    inert={!custom}
                    aria-hidden={!custom}
                  >
                    <div className="question-expander-content">
                      <label className="question-text">
                        <span className="agent-ui-sr-only">Your answer</span>
                        <textarea
                          ref={this.customAnswer}
                          value={custom ? selection.text : ""}
                          onChange={this.write.bind(this)}
                          rows={2}
                          maxLength={4000}
                          placeholder="Write your answer…"
                        />
                      </label>
                    </div>
                  </div>
                </div>
              )}
            </fieldset>
            {state.kind === "editing" && state.error && (
              <p
                id={this.props.errorId}
                className="question-error"
                ref={this.error}
                tabIndex={-1}
                role="alert"
              >
                {state.error}
              </p>
            )}
            <div className="question-footer">
              <span
                aria-label={`Question ${position?.current ?? 1} of ${position?.total ?? 1}`}
              >
                {position?.current ?? 1}/{position?.total ?? 1}
              </span>
              <div className="question-actions">
                <button
                  className="question-skip"
                  type="button"
                  disabled={disabled}
                  aria-busy={skipping}
                  onClick={this.skip.bind(this)}
                >
                  {skipping && (
                    <LoaderCircle
                      className="agent-ui-spin"
                      size={16}
                      aria-hidden="true"
                    />
                  )}
                  Skip
                </button>
                <button
                  type="submit"
                  className="primary-button question-next"
                  disabled={disabled || !hasAnswer(selection)}
                  aria-busy={busy && !skipping}
                  aria-keyshortcuts="Meta+Enter Control+Enter"
                >
                  {busy && !skipping && (
                    <LoaderCircle
                      className="agent-ui-spin"
                      size={16}
                      aria-hidden="true"
                    />
                  )}{" "}
                  {position !== undefined && position.current < position.total
                    ? "Next"
                    : "Send answer"}
                  <span className="question-shortcut" aria-hidden="true">
                    <kbd>
                      <Command size={12} />
                    </kbd>
                    <kbd>
                      <CornerDownLeft size={12} />
                    </kbd>
                  </span>
                </button>
              </div>
            </div>
            {availability?.kind === "paused" && (
              <p className="question-availability">{availability.message}</p>
            )}
          </div>
        </div>
      </form>
    );
  }
}

function QuestionIcon(): React.ReactNode {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 18H9l-5 3v-5a3 3 0 0 1-2-3V6a3 3 0 0 1 3-3h13a3 3 0 0 1 3 3v5M6 8h11M6 12h6" />
      <path d="M17 15a2 2 0 0 1 4 0c0 1.5-2 1.5-2 3M19 21h.01" />
    </svg>
  );
}
function optionLetter(index: number): string {
  return String.fromCharCode(65 + index);
}
function hasAnswer(selection: Selection): boolean {
  return (
    selection.kind === "choice" ||
    (selection.kind === "text" && selection.text.trim().length > 0)
  );
}
function currentSelection(state: State): Selection {
  if (state.kind === "editing") return state.selection;
  return state.answer.kind === "skipped" ? { kind: "empty" } : state.answer;
}
export function questionAnswerText(answer: QuestionAnswer): string {
  switch (answer.kind) {
    case "choice":
      return answer.choice.label;
    case "text":
      return answer.text;
    case "skipped":
      return "Skipped this question.";
    default:
      return assertNever(answer, "Unknown question state");
  }
}

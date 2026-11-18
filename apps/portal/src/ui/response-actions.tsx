import React from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  Copy,
  LoaderCircle,
  RotateCw,
  Split,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import "./agent-components.css";
import "./action-menu.css";
import { GlideHighlight } from "./glide-highlight";
import { assertNever } from "@seams/std";

export type ResponseRating = "good" | "bad" | null;
export type ResponseActionResult =
  | { readonly kind: "accepted"; readonly message?: never }
  | { readonly kind: "failed"; readonly message: string };

export type ResponseActionsProps = {
  readonly text: string;
  readonly subject?: "message" | "response";
  readonly rating?: ResponseRating;
  readonly ratingDisabled?: boolean;
  readonly onRate?: (rating: ResponseRating) => Promise<ResponseActionResult>;
  readonly onRegenerate?: () => Promise<ResponseActionResult>;
  readonly regenerateDisabled?: boolean;
  readonly onFork?: () => void;
  readonly forkDisabled?: boolean;
  readonly forking?: boolean;
};
type Action = "copy" | "rate" | "regenerate";
type Operation =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly action: Action }
  | {
      readonly kind: "accepted";
      readonly action: Action;
      readonly message: string;
    }
  | {
      readonly kind: "failed";
      readonly action: Action;
      readonly message: string;
    };
type State = {
  readonly rating: ResponseRating;
  readonly operation: Operation;
};

/** Remount with the response identity when replacing a response. */
export class ResponseActions extends React.Component<
  ResponseActionsProps,
  State
> {
  state: State = { rating: null, operation: { kind: "idle" } };
  private mounted = false;
  private pending = false;

  componentDidMount(): void {
    this.mounted = true;
  }
  componentWillUnmount(): void {
    this.mounted = false;
  }

  private async perform(
    action: Action,
    rating: ResponseRating = null,
  ): Promise<void> {
    if (
      this.pending ||
      (action === "rate" && this.props.ratingDisabled) ||
      (action === "regenerate" && this.props.regenerateDisabled)
    )
      return;
    this.pending = true;
    this.setState({ operation: { kind: "pending", action } });
    try {
      let result: ResponseActionResult;
      switch (action) {
        case "copy":
          await navigator.clipboard.writeText(this.props.text);
          result = { kind: "accepted" };
          break;
        case "rate":
          if (!this.props.onRate) return;
          result = await this.props.onRate(rating);
          break;
        case "regenerate":
          if (!this.props.onRegenerate) return;
          result = await this.props.onRegenerate();
          break;
        default:
          return assertNever(action, "Unknown response action");
      }
      if (!this.mounted) return;
      switch (result.kind) {
        case "accepted":
          this.setState({
            rating: action === "rate" ? rating : this.state.rating,
            operation: {
              kind: "accepted",
              action,
              message: actionConfirmation(
                action,
                rating,
                this.props.subject ?? "response",
              ),
            },
          });
          break;
        case "failed":
          this.setState({
            operation: { kind: "failed", action, message: result.message },
          });
          break;
        default:
          assertNever(result, "Unknown response action");
      }
    } catch {
      if (this.mounted)
        this.setState({
          operation: {
            kind: "failed",
            action,
            message: actionFailure(action, this.props.subject ?? "response"),
          },
        });
    } finally {
      this.pending = false;
    }
  }

  private copy(): void {
    void this.perform("copy");
  }
  private rate(rating: Exclude<ResponseRating, null>): void {
    const current =
      this.props.rating === undefined ? this.state.rating : this.props.rating;
    void this.perform("rate", current === rating ? null : rating);
  }
  private regenerate(): void {
    void this.perform("regenerate");
  }
  private fork(): void {
    if (this.pending || this.props.forkDisabled || this.props.forking) return;
    this.props.onFork?.();
  }

  render(): React.ReactNode {
    const { operation } = this.state;
    const rating =
      this.props.rating === undefined ? this.state.rating : this.props.rating;
    const busy = operation.kind === "pending";
    const copied = operation.kind === "accepted" && operation.action === "copy";
    const regenerating = busy && operation.action === "regenerate";
    const subject = this.props.subject ?? "response";
    return (
      <div className="response-actions">
        <Tooltip.Provider delay={350}>
          <div
            className="response-actions-row"
            role="group"
            aria-label={
              subject === "message" ? "Message actions" : "Response actions"
            }
            aria-busy={busy}
          >
            <ActionTip label={copied ? "Copied" : `Copy ${subject}`}>
              <button
                type="button"
                aria-label={copied ? `Copied ${subject}` : `Copy ${subject}`}
                aria-disabled={busy}
                onClick={this.copy.bind(this)}
              >
                <span className="response-copy-icons" data-copied={copied}>
                  <Copy size={18} aria-hidden="true" />
                  <Check size={18} aria-hidden="true" />
                </span>
              </button>
            </ActionTip>
            {this.props.onRate && (
              <Menu.Root>
                <Tooltip.Root>
                  <Menu.Trigger
                    asChild
                    disabled={busy || this.props.ratingDisabled}
                  >
                    <Tooltip.Trigger
                      render={
                        <button
                          type="button"
                          aria-label="Rate response"
                          aria-description={
                            rating === null
                              ? undefined
                              : `Rated ${rating} response`
                          }
                          data-rated={rating !== null}
                          disabled={busy || this.props.ratingDisabled}
                        >
                          <span
                            className="response-rating-icons"
                            data-rating={rating}
                          >
                            <ThumbsUp size={13} aria-hidden="true" />
                            <ThumbsDown size={13} aria-hidden="true" />
                          </span>
                        </button>
                      }
                    />
                  </Menu.Trigger>
                  <ActionTipPopup label="Rate response" />
                </Tooltip.Root>
                <Menu.Portal>
                  <Menu.Content
                    className="action-menu response-rating-menu"
                    aria-label="Rate response"
                    side="top"
                    align="start"
                    sideOffset={6}
                    collisionPadding={12}
                  >
                    <GlideHighlight target="[data-highlighted]" />
                    <Menu.CheckboxItem
                      className="action-menu-item"
                      checked={rating === "good"}
                      disabled={busy || this.props.ratingDisabled}
                      onSelect={this.rate.bind(this, "good")}
                    >
                      <ThumbsUp size={18} aria-hidden="true" />
                      <span className="action-menu-copy">Good response</span>
                      <Menu.ItemIndicator>
                        <Check size={16} aria-hidden="true" />
                      </Menu.ItemIndicator>
                    </Menu.CheckboxItem>
                    <Menu.CheckboxItem
                      className="action-menu-item"
                      checked={rating === "bad"}
                      disabled={busy || this.props.ratingDisabled}
                      onSelect={this.rate.bind(this, "bad")}
                    >
                      <ThumbsDown size={18} aria-hidden="true" />
                      <span className="action-menu-copy">Bad response</span>
                      <Menu.ItemIndicator>
                        <Check size={16} aria-hidden="true" />
                      </Menu.ItemIndicator>
                    </Menu.CheckboxItem>
                  </Menu.Content>
                </Menu.Portal>
              </Menu.Root>
            )}
            {this.props.onRegenerate && (
              <ActionTip
                label={regenerating ? "Regenerating…" : "Regenerate response"}
              >
                <button
                  type="button"
                  aria-label="Regenerate response"
                  aria-disabled={busy || this.props.regenerateDisabled}
                  aria-busy={regenerating}
                  onClick={this.regenerate.bind(this)}
                >
                  <RotateCw
                    size={18}
                    className={regenerating ? "agent-ui-spin" : undefined}
                    aria-hidden="true"
                  />
                </button>
              </ActionTip>
            )}
            {this.props.onFork && (
              <ActionTip
                label={
                  this.props.forking
                    ? "Preparing fork…"
                    : this.props.forkDisabled
                      ? "Accepted history is unavailable for this response"
                      : "Branch in new chat"
                }
              >
                <button
                  type="button"
                  aria-label="Branch in new chat"
                  aria-haspopup="dialog"
                  aria-disabled={
                    busy || this.props.forkDisabled || this.props.forking
                  }
                  aria-busy={this.props.forking}
                  onClick={this.fork.bind(this)}
                >
                  {this.props.forking ? (
                    <LoaderCircle
                      size={18}
                      className="agent-ui-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Split
                      size={18}
                      className="response-fork-icon"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </ActionTip>
            )}
          </div>
        </Tooltip.Provider>
        <span className="agent-ui-sr-only" role="status">
          {operation.kind === "accepted" ? operation.message : ""}
        </span>
        {operation.kind === "failed" && (
          <p className="response-actions-error" role="alert">
            {operation.message}
          </p>
        )}
      </div>
    );
  }
}

function ActionTip(props: {
  readonly label: string;
  readonly children: React.ReactElement;
}): React.ReactNode {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={props.children} />
      <ActionTipPopup label={props.label} />
    </Tooltip.Root>
  );
}

function ActionTipPopup(props: { readonly label: string }): React.ReactNode {
  return (
    <Tooltip.Portal>
      <Tooltip.Positioner
        side="top"
        sideOffset={6}
        collisionPadding={8}
        className="response-action-tip-positioner"
      >
        <Tooltip.Popup className="response-action-tip">
          {props.label}
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  );
}

function actionConfirmation(
  action: Action,
  rating: ResponseRating,
  subject: "message" | "response",
): string {
  switch (action) {
    case "copy":
      return subject === "message" ? "Message copied." : "Response copied.";
    case "rate":
      return rating === null
        ? "Rating removed."
        : rating === "good"
          ? "Response marked helpful."
          : "Response marked unhelpful.";
    case "regenerate":
      return "Regeneration requested.";
    default:
      return assertNever(action, "Unknown response action");
  }
}
function actionFailure(
  action: Action,
  subject: "message" | "response",
): string {
  switch (action) {
    case "copy":
      return `Could not copy this ${subject}. Try again.`;
    case "rate":
      return "Could not save your rating. Try again.";
    case "regenerate":
      return "Could not regenerate this response. Try again.";
    default:
      return assertNever(action, "Unknown response action");
  }
}

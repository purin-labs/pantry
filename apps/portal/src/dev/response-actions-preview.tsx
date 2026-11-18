import React from "react";
import {
  ResponseActions,
  type ResponseActionResult,
  type ResponseRating,
} from "../ui";

type Request =
  | { readonly kind: "idle" }
  | { readonly kind: "rating"; readonly rating: ResponseRating }
  | { readonly kind: "regenerate" };
type State = {
  readonly request: Request;
  readonly generation: number;
  readonly receipt: string;
};

export class ResponseActionsPreview extends React.Component<object, State> {
  state: State = {
    request: { kind: "idle" },
    generation: 1,
    receipt: "No action sent.",
  };
  private settle: ((result: ResponseActionResult) => void) | null = null;

  componentWillUnmount(): void {
    this.settle?.({ kind: "failed", message: "Preview closed." });
  }
  private rate(rating: ResponseRating): Promise<ResponseActionResult> {
    this.setState({ request: { kind: "rating", rating } });
    return new Promise(this.capture.bind(this));
  }
  private regenerate(): Promise<ResponseActionResult> {
    this.setState({ request: { kind: "regenerate" } });
    return new Promise(this.capture.bind(this));
  }
  private capture(resolve: (result: ResponseActionResult) => void): void {
    this.settle = resolve;
  }
  private accept(): void {
    const request = this.state.request;
    if (request.kind === "idle") return;
    this.settle?.({ kind: "accepted" });
    this.settle = null;
    this.setState({
      request: { kind: "idle" },
      generation:
        request.kind === "regenerate"
          ? this.state.generation + 1
          : this.state.generation,
      receipt:
        request.kind === "regenerate"
          ? "Replacement response received."
          : `Rating accepted: ${request.rating ?? "removed"}.`,
    });
  }
  private fail(): void {
    this.settle?.({
      kind: "failed",
      message: "Preview delivery failed. Try the action again.",
    });
    this.settle = null;
    this.setState({
      request: { kind: "idle" },
      receipt: "Action failed; previous rating preserved.",
    });
  }
  render(): React.ReactNode {
    const text =
      this.state.generation === 1
        ? "The production sheet includes 24 plain financiers and 14 chocolate financiers."
        : `Production summary ${this.state.generation}: Prepare 38 financiers for tomorrow’s pickups — 24 plain and 14 chocolate.`;
    return (
      <section
        className="agent-preview-actions"
        aria-label="Response actions preview"
      >
        <h2>Response actions</h2>
        <p>{text}</p>
        <ResponseActions
          key={this.state.generation}
          text={text}
          onRate={this.rate.bind(this)}
          onRegenerate={this.regenerate.bind(this)}
        />
        <div className="agent-preview-controls">
          <button
            type="button"
            disabled={this.state.request.kind === "idle"}
            onClick={this.fail.bind(this)}
          >
            Fail action
          </button>
          <button
            type="button"
            disabled={this.state.request.kind === "idle"}
            onClick={this.accept.bind(this)}
          >
            Accept action
          </button>
        </div>
        <p role="status">
          {this.state.request.kind === "idle"
            ? this.state.receipt
            : `Pending: ${this.state.request.kind}.`}
        </p>
      </section>
    );
  }
}

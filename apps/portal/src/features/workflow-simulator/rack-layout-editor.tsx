import React from "react";
import type { ActiveAttempt } from "@seams/production-simulation/recipes/bakery/workcell-attempt";
import {
  rackOffset,
  supportsRackLayout,
  type RackLayoutProposal,
  type RackLayoutReview,
} from "./rack-layout";
import { TrayLayoutPreview } from "./tray-layout-preview";

export type RackLayoutActions = Readonly<{
  previewRackLayout(xMm: number, yMm: number): void;
  prepareRackLayout(xMm: number, yMm: number): Promise<void>;
  applyRackLayout(proposal: RackLayoutProposal): void;
  discardRackLayout(): void;
}>;
// A rack translation of one rehearsal tray's first request. The rack drags in
// the tray's layout preview or takes numeric offsets.
type Props = Readonly<{
  attempt: ActiveAttempt;
  review: RackLayoutReview;
  actions: RackLayoutActions;
  tray: string;
}>;
type Values = Readonly<{ xMm: string; yMm: string; preparing: boolean }>;
type State = Values & Readonly<{ expanded: boolean }>;

export class RackLayoutEditor extends React.Component<Props, State> {
  state: State = {
    ...this.values(),
    expanded: this.props.review.kind === "prepared",
  };
  private values(): Values {
    const review = this.props.review;
    if (review.kind === "invalid")
      return {
        xMm: String(review.xMm),
        yMm: String(review.yMm),
        preparing: false,
      };
    const proposal =
      review.kind === "prepared"
        ? review.proposal
        : review.kind === "draft"
          ? review
          : null;
    const layout =
      proposal !== null
        ? proposal.layout
        : this.props.attempt.input.request.layout;
    const [x, y] = rackOffset(layout);
    return { xMm: String(x), yMm: String(y), preparing: false };
  }
  componentDidUpdate(previous: Props): void {
    if (previous.attempt !== this.props.attempt) this.setState(this.values());
    else if (
      previous.review !== this.props.review &&
      this.props.review.kind !== "none"
    ) {
      const review = this.props.review;
      if (review.kind === "invalid") {
        this.setState({ xMm: String(review.xMm), yMm: String(review.yMm) });
        return;
      }
      const [x, y] = rackOffset(
        review.kind === "prepared" ? review.proposal.layout : review.layout,
      );
      this.setState({ xMm: String(x), yMm: String(y) });
    }
  }
  private change(
    axis: "xMm" | "yMm",
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    const x = axis === "xMm" ? event.currentTarget.value : this.state.xMm;
    const y = axis === "yMm" ? event.currentTarget.value : this.state.yMm;
    this.setState({ xMm: x, yMm: y });
    if (x.trim() === "" || y.trim() === "")
      this.props.actions.discardRackLayout();
    else this.props.actions.previewRackLayout(Number(x), Number(y));
  }
  private async prepare(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    this.setState({ preparing: true });
    await this.props.actions.prepareRackLayout(
      Number(this.state.xMm),
      Number(this.state.yMm),
    );
    this.setState({ preparing: false });
  }
  // The preview mounts only while the experiment is open.
  private toggled(event: React.SyntheticEvent<HTMLDetailsElement>): void {
    this.setState({ expanded: event.currentTarget.open });
  }
  private discard(): void {
    this.props.actions.discardRackLayout();
    const [x, y] = rackOffset(this.props.attempt.input.request.layout);
    this.setState({ xMm: String(x), yMm: String(y), preparing: false });
  }
  render(): React.ReactNode {
    if (!supportsRackLayout(this.props.attempt)) return null;
    const { review, attempt, actions } = this.props;
    const proposal = review.kind === "prepared" ? review.proposal : null;
    const [oldX, oldY] = rackOffset(attempt.input.request.layout);
    const [x, y] =
      proposal === null
        ? [Number(this.state.xMm), Number(this.state.yMm)]
        : rackOffset(proposal.layout);
    const incomplete =
      this.state.xMm.trim() === "" || this.state.yMm.trim() === "";
    const invalid = incomplete || review.kind === "invalid";
    const message = incomplete
      ? "Enter both rack offsets in millimetres."
      : review.kind === "invalid"
        ? review.message
        : review.kind === "draft"
          ? review.fit.message
          : "Review rack offsets before applying a placement.";
    return (
      <details
        className="rack-layout-editor"
        open={proposal !== null ? true : undefined}
        onToggle={this.toggled.bind(this)}
      >
        <summary>Rack placement experiment · {this.props.tray}</summary>
        <p>
          Translate the rack horizontally. Height, orientation, robot and table
          remain fixed. Offsets use the original model’s X/Y axes in
          millimetres.
        </p>
        <p>
          Drag the rack in the floor plan or set the offsets for{" "}
          {this.props.tray}&apos;s first request, then review them. The dashed
          outline marks its applied position. Simulation is required after
          Apply.
        </p>
        {this.state.expanded && (
          <TrayLayoutPreview
            applied={attempt.input.request.layout}
            review={review}
            preview={actions.previewRackLayout}
          />
        )}
        {proposal === null && <p role="status">{message}</p>}
        <form onSubmit={this.prepare.bind(this)}>
          <label>
            X offset (mm)
            <input
              type="number"
              required
              min={-600}
              max={600}
              step={1}
              value={this.state.xMm}
              disabled={this.state.preparing}
              onChange={this.change.bind(this, "xMm")}
            />
          </label>
          <label>
            Y offset (mm)
            <input
              type="number"
              required
              min={-600}
              max={600}
              step={1}
              value={this.state.yMm}
              disabled={this.state.preparing}
              onChange={this.change.bind(this, "yMm")}
            />
          </label>
          <button type="submit" disabled={this.state.preparing || invalid}>
            {this.state.preparing
              ? "Checking placement…"
              : "Review rack placement"}
          </button>
        </form>
        {proposal === null &&
          (this.state.xMm !== String(oldX) ||
            this.state.yMm !== String(oldY)) && (
            <button type="button" onClick={this.discard.bind(this)}>
              Discard rack placement
            </button>
          )}
        {proposal !== null && (
          <section aria-label="Rack placement review">
            <p>
              Applied: X {oldX}, Y {oldY} mm → proposed: X {x}, Y {y} mm.
            </p>
            <p role="status">{proposal.message}</p>
            <p>
              Applying clears {this.props.tray}&apos;s results. Run it in the
              browser to simulate the new placement.
            </p>
            <button
              disabled={proposal.kind === "blocked"}
              onClick={actions.applyRackLayout.bind(null, proposal)}
            >
              Apply rack placement
            </button>
            <button onClick={this.discard.bind(this)}>
              Discard rack placement
            </button>
          </section>
        )}
      </details>
    );
  }
}

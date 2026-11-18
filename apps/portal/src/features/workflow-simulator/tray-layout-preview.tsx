import React from "react";
import {
  parsePhysicsReplay,
  type PhysicsLayout,
  type PhysicsReplay,
} from "@seams/bakery-model/bakery-physics";
import { PhysicsSceneHost } from "./spatial/physics-scene-host";
import type { FitFinding } from "./spatial/floor-plan-geometry";
import type { RackLayoutPresentation } from "./spatial/physics-inspection";
import { rackOffset, type RackLayoutReview } from "./rack-layout";
import { readExample } from "./rehearsal-examples";
import { COLD_CELL } from "@seams/production-simulation/recipes/bakery/workcell-instances";

const RACK = COLD_CELL.skills["table-to-rack"];

type Props = Readonly<{
  applied: PhysicsLayout;
  review: RackLayoutReview;
  preview(xMm: number, yMm: number): void;
}>;

// The floor plan of a rehearsal tray's first request. Dragging the rack
// previews a translation; the scene is the model's rack setup, not a result.
export class TrayLayoutPreview extends React.Component<
  Props,
  { unavailable: boolean }
> {
  state = { unavailable: false };
  private readonly host = React.createRef<HTMLDivElement>();
  private readonly sceneHost = new PhysicsSceneHost({
    fallback: "floor-plan",
    camera: "cell",
    select: ignoreSelection,
    changed: this.sceneChanged.bind(this),
    inspectEvent: null,
    pause: null,
  });
  private mounted = false;
  componentDidMount(): void {
    this.mounted = true;
    if (this.host.current !== null)
      void this.sceneHost.load(this.host.current, rackSetup());
  }
  componentDidUpdate(): void {
    this.updateScene();
  }
  componentWillUnmount(): void {
    this.mounted = false;
    this.sceneHost.dispose();
  }
  private sceneChanged(
    status: "empty" | "loading" | "ready" | "unavailable",
  ): void {
    if (!this.mounted) return;
    // Without WebGL the plan remains as a CPU floor plan.
    this.setState({
      unavailable: status === "unavailable" && this.sceneHost.fallback === null,
    });
    this.updateScene();
    if (status === "ready") this.sceneHost.webgl?.openPlan();
    // The plan opens on the rack and the equipment it must clear.
    if (status === "ready" || this.sceneHost.fallback !== null)
      this.sceneHost.framePlan([RACK.destination, RACK.source, RACK.arm]);
  }
  private updateScene(): void {
    const frame = {
      seconds: 0,
      workcell: { kind: "empty" } as const,
      layout: this.layout(),
      trays: null,
    };
    this.sceneHost.webgl?.update(frame);
    this.sceneHost.fallback?.update(frame);
  }
  private layout(): RackLayoutPresentation {
    const { applied, review } = this.props;
    const { draft, checks } = reviewed(review);
    const [x, y] = rackOffset(draft ?? applied);
    return {
      applied,
      draft,
      // The plan reports the drag from where it started.
      move: this.drag.bind(this, x, y),
      setup: true,
      checks,
    };
  }
  private drag(x: number, y: number, dx: number, dy: number): void {
    this.props.preview(x + dx, y + dy);
  }
  render(): React.ReactNode {
    return (
      <section
        aria-label="Tray layout preview"
        className="production-layout-preview"
      >
        <div ref={this.host} />
        {this.state.unavailable && (
          <p role="status">Floor plan unavailable. Use the offsets below.</p>
        )}
      </section>
    );
  }
}

function reviewed(review: RackLayoutReview): Readonly<{
  draft: PhysicsLayout | null;
  checks: readonly FitFinding[];
}> {
  switch (review.kind) {
    case "draft":
      return { draft: review.layout, checks: review.fit.checks };
    case "prepared":
      return { draft: review.proposal.layout, checks: review.proposal.checks };
    case "none":
    case "invalid":
      return { draft: null, checks: [] };
  }
}
async function rackSetup(): Promise<PhysicsReplay> {
  const parsed = parsePhysicsReplay(await readExample("table-to-rack"));
  if (parsed.kind === "rejected") throw new Error(parsed.message);
  return parsed.recording;
}
// Selecting equipment only highlights it; the editor owns the layout.
function ignoreSelection(): void {}

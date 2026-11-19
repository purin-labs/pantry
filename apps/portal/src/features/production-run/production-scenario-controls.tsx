import { Select } from "../../ui/select";
import React from "react";
import type { HostRequest, HostView } from "@purin-labs/production-simulation";
import type { StrictUnion, Variant } from "@purin-labs/type-utils";
import { seconds } from "./oven-logistics";

export type ReviewedScenarioControl = Variant<
  HostRequest,
  "extend-horizon" | "withhold-resource"
>;
/**
 * The latest time that a cell has computed. A withheld interval must start
 * after it, because a command takes effect only where no cell has computed.
 */
function computedThrough(view: HostView): number {
  let time = view.time;
  for (const cell of view.cells) if (cell.boundary > time) time = cell.boundary;
  return time;
}

type Props = Readonly<{
  view: HostView;
  enabled: boolean;
  apply(command: ReviewedScenarioControl): void;
}>;
type Review = StrictUnion<
  | Readonly<{ kind: "editing"; message: string }>
  | Readonly<{ kind: "reviewing"; command: ReviewedScenarioControl }>
>;

/** Review pins the control revision. Later changes require a new review. */
export class ProductionScenarioControls extends React.Component<
  Props,
  Readonly<{ review: Review }>
> {
  state: Readonly<{ review: Review }> = {
    review: { kind: "editing", message: "" },
  };

  private setReview(review: Review): void {
    this.setState({ review });
  }

  private review(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    try {
      const commandId = crypto.randomUUID();
      const expectedControlRevision = this.props.view.controlRevision;
      if (fields.get("kind") === "extend-horizon") {
        const horizon = formTime(fields, "horizon");
        if (horizon <= this.props.view.horizon)
          throw new Error("Choose a horizon later than the current horizon.");
        this.setReview({
          kind: "reviewing",
          command: {
            kind: "extend-horizon",
            commandId,
            expectedControlRevision,
            horizon,
          },
        });
      } else {
        const start = formTime(fields, "start");
        const end = formTime(fields, "end");
        const resource = fields.get("resource");
        if (typeof resource !== "string" || resource.length === 0)
          throw new Error("Choose a resource.");
        if (start <= computedThrough(this.props.view) || end <= start)
          throw new Error("Choose a future start and a later end.");
        this.setReview({
          kind: "reviewing",
          command: {
            kind: "withhold-resource",
            commandId,
            expectedControlRevision,
            resource,
            interval: { start, end },
          },
        });
      }
    } catch (error) {
      this.setReview({
        kind: "editing",
        message:
          error instanceof Error ? error.message : "Invalid control values.",
      });
    }
  }

  private edit(): void {
    this.setReview({ kind: "editing", message: "" });
  }

  private confirm(): void {
    if (
      this.state.review.kind !== "reviewing" ||
      !this.props.enabled ||
      this.state.review.command.expectedControlRevision !==
        this.props.view.controlRevision
    )
      return;
    this.props.apply(this.state.review.command);
    this.edit();
  }

  render(): React.ReactNode {
    const { view, enabled } = this.props;
    if (view.production.kind === "unavailable") return null;
    const resources =
      view.logistics.kind === "available" ? view.logistics.resources : [];
    return (
      <section aria-label="Scenario controls">
        <h3>Scenario controls</h3>
        {this.state.review.kind === "reviewing" ? (
          <div>
            <p>{controlDescription(this.state.review.command)}</p>
            <p>
              Existing work keeps its accepted history. This change applies to
              this execution.
            </p>
            {this.state.review.command.expectedControlRevision !==
              view.controlRevision && (
              <p role="status">
                The run changed after review. Review the values again.
              </p>
            )}
            <button
              disabled={
                !enabled ||
                this.state.review.command.expectedControlRevision !==
                  view.controlRevision
              }
              onClick={this.confirm.bind(this)}
            >
              Confirm scenario change
            </button>
            <button onClick={this.edit.bind(this)}>Edit scenario change</button>
          </div>
        ) : (
          <>
            {this.state.review.message && (
              <p role="status">{this.state.review.message}</p>
            )}
            <h4>Extend the run horizon</h4>
            <form onSubmit={this.review.bind(this)}>
              <input type="hidden" name="kind" value="extend-horizon" />
              <label>
                New horizon (seconds)
                <input
                  name="horizon"
                  type="number"
                  required
                  step="0.002"
                  min={(view.horizon + 2000) / 1e6}
                  defaultValue={view.horizon / 1e6 + 3600}
                />
              </label>
              <button disabled={!enabled}>Review horizon extension</button>
            </form>
            <details>
              <summary>Schedule resource unavailability</summary>
              <p>
                Active work continues. The resource cannot admit new work during
                the selected interval.
              </p>
              <form onSubmit={this.review.bind(this)}>
                <input type="hidden" name="kind" value="withhold-resource" />
                <label>
                  Resource to withhold
                  <Select.Root
                    name="resource"
                    required
                    items={resources.map(resourceItem)}
                    defaultValue={resources[0]?.id ?? null}
                  >
                    <Select.Trigger>
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Popup>{resources.map(resourceOption)}</Select.Popup>
                  </Select.Root>
                </label>
                <label>
                  Unavailable from (seconds)
                  <input
                    name="start"
                    type="number"
                    required
                    step="0.002"
                    min={(computedThrough(view) + 2000) / 1e6}
                  />
                </label>
                <label>
                  Available again (seconds)
                  <input
                    name="end"
                    type="number"
                    required
                    step="0.002"
                    min={(computedThrough(view) + 4000) / 1e6}
                  />
                </label>
                <button
                  disabled={!enabled || view.status.kind === "stopped-at-limit"}
                >
                  Review resource interval
                </button>
              </form>
            </details>
          </>
        )}
      </section>
    );
  }
}
function formTime(fields: FormData, field: string): number {
  const raw = fields.get(field);
  const value =
    typeof raw === "string" && raw.trim() !== "" ? Number(raw) * 1e6 : NaN;
  if (!Number.isSafeInteger(value) || value < 0 || value % 2000 !== 0)
    throw new Error("Use non-negative seconds on the 2 ms clock.");
  return value;
}
function resourceItem(
  resource: Readonly<{ id: string }>,
): Readonly<{ value: string; label: string }> {
  return { value: resource.id, label: resource.id };
}
function resourceOption(resource: Readonly<{ id: string }>): React.ReactNode {
  return (
    <Select.Item key={resource.id} value={resource.id}>
      {resource.id}
    </Select.Item>
  );
}
function controlDescription(command: ReviewedScenarioControl): string {
  if (command.kind === "extend-horizon")
    return `Extend the horizon to ${seconds(command.horizon)} seconds. If the old horizon stopped execution, this resumes it.`;
  return `Withhold ${command.resource} from ${seconds(command.interval.start)} to ${seconds(command.interval.end)} seconds.`;
}

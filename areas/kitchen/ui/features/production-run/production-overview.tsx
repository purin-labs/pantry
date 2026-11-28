import type React from "react";
import { assertNever } from "@purin-labs/std";
import type { HostView } from "@purin-labs/production-simulation/execution-entry";
import type { ApplianceTaskRisk } from "@purin-labs/production-simulation/recipes/bakery/appliance-execution";
import { ProductionActivityTrace } from "./production-activity-trace";

type Props = Readonly<{
  view: HostView;
  select(task: string): void;
  reviewRecovery(): void;
  atRisk?: ReadonlyMap<string, ApplianceTaskRisk>;
}>;

/** These are projections of the accepted run. They never decide dispatch. */
export function ProductionOverview({
  view,
  select,
  reviewRecovery,
  atRisk,
}: Props): React.ReactNode {
  return (
    <section aria-label="Production overview">
      <h3>Production overview</h3>
      <p role="status">{nextAction(view)}</p>
      <ProductionActivityTrace
        view={view}
        select={select}
        reviewRecovery={reviewRecovery}
        {...(atRisk !== undefined ? { atRisk } : {})}
      />
      <p>
        Select a task to see its prerequisites, resource claims and accepted
        timeline.
      </p>
    </section>
  );
}
function nextAction(view: HostView): string {
  if (view.recoveries.length > 0)
    return "A transfer failed. Save this run to preserve its equipment state. Physical recovery is required before the affected equipment can be reused.";
  switch (view.status.kind) {
    case "awaiting-inspection":
      return "Action needed: record the inspection below. Rejected product follows the disposal and cleanup steps. Later batches keep their own material and equipment records.";
    case "paused":
      return "Production is paused. Save a shared copy to continue from another browser, or resume this run.";
    case "completed":
      return "Production is complete. Review the output quantities and save the completed run to the workspace.";
    case "blocked":
      return "Production cannot advance. Select a waiting task to inspect the missing material, occupied position or unavailable equipment. Save before closing.";
    case "stopped-at-limit":
      return "The run reached its execution limit. Save the run and review unfinished tasks before preparing another shift.";
    case "ready":
      return "The bakery shift is ready.";
    case "pause-requested":
      return "Production is stopping at a safe simulation boundary. Wait for the pause before saving.";
    case "advancing":
    case "awaiting-execution":
      return "Production is advancing. Shared equipment queues are expected. Pause before saving or leaving this run.";
    default:
      return assertNever(view.status.kind);
  }
}

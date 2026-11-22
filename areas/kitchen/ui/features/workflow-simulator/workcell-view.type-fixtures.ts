import type { WorkcellSelection } from "@purin-labs/production-simulation/simulator/selection";
import type { WorkcellCursor } from "@purin-labs/production-simulation/simulator/workcell-view";

const invalidResource: WorkcellSelection = {
  kind: "resource",
  // @ts-expect-error Resource identity cannot be an arbitrary display label.
  id: "The mixer",
};
// @ts-expect-error Task selections require a task-instance identity.
const skillAsTask: WorkcellSelection = { kind: "task", id: "table-to-rack" };
// @ts-expect-error Waiting for evidence has no known duration.
const assumedDuration: WorkcellCursor = { kind: "awaiting", time: 0, end: 30 };
void [invalidResource, skillAsTask, assumedDuration];

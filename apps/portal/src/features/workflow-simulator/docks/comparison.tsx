import React from "react";

import { RunComparison } from "../results";
import type { Run } from "@seams/production-simulation/recipes/bakery/schedule";
import type { WorkflowSimulatorActions } from "../simulator-actions";
import type { ComparisonView } from "../simulator-state";
import { DockHeader, SegmentedControl } from "./shared";

type Props = Readonly<{
  run: Run;
  open: boolean;
  state: ComparisonView;
  actions: Pick<
    WorkflowSimulatorActions,
    | "closeDock"
    | "compareOutage"
    | "chooseVariant"
    | "pinBaseline"
    | "inspectInterval"
  >;
}>;

export function ComparisonDock(props: Props): React.ReactNode {
  return (
    <section
      id="workflow-dock-comparison"
      className="workflow-dock workflow-dock-right workflow-comparison"
      hidden={!props.open}
      aria-label="Comparison"
    >
      <DockHeader label="Compare shifts" onClose={props.actions.closeDock} />
      <SegmentedControl
        ariaLabel="Shift mode"
        role="group"
        value={props.run.variant}
        options={[
          {
            value: "normal",
            label: "Replay normal shift",
            onSelect: props.actions.chooseVariant.bind(null, "normal"),
          },
          {
            value: "outage",
            label: "Compare oven outage",
            onSelect: props.actions.compareOutage,
          },
        ]}
      />
      <RunComparison
        run={props.run}
        baseline={props.state.baseline}
        hasDraft={props.state.assumptionDraft.size > 0}
        onPinBaseline={props.actions.pinBaseline}
        onInspect={props.actions.inspectInterval}
      />
    </section>
  );
}

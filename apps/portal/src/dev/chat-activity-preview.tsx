import { Select } from "@purin-labs/ui/select";
import React from "react";
import { assertNever } from "@purin-labs/std";
import {
  ReasoningSteps,
  type ReasoningStep,
} from "@purin-labs/ui/reasoning-steps";
import "./chat-activity-preview.css";

type Scenario = "working" | "queued" | "completed" | "failed" | "waiting";
const SCENARIOS: ReadonlyArray<{ value: Scenario; label: string }> = [
  { value: "working", label: "Working" },
  { value: "queued", label: "Next step queued" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "waiting", label: "Waiting for approval" },
];
type ActivityPreviewState = {
  readonly scenario: Scenario;
  readonly revision: number;
};

export class ChatActivityPreview extends React.Component<
  object,
  ActivityPreviewState
> {
  state: ActivityPreviewState = { scenario: "working", revision: 0 };

  private changeScenario(scenario: string | null): void {
    switch (scenario) {
      case "working":
      case "queued":
      case "completed":
      case "failed":
      case "waiting":
        this.setState({ scenario });
    }
  }

  private addStep(): void {
    this.setState({ scenario: "queued" });
  }
  private reset(): void {
    this.setState(resetActivityPreview);
  }

  render(): React.ReactNode {
    const steps = activitySteps(this.state.scenario);
    const summary = activitySummary(this.state.scenario);
    return (
      <section
        className="chat-activity-preview"
        id="chat-activity"
        aria-labelledby="chat-activity-title"
      >
        <div className="chat-activity-preview-heading">
          <div>
            <h2 id="chat-activity-title">Chat activity</h2>
            <p>
              Expandable Trace steps, smooth entrances, and the original chat
              shimmer.
            </p>
          </div>
          <div className="trace-preview-controls">
            <label>
              Scenario{" "}
              <Select.Root
                items={SCENARIOS}
                value={this.state.scenario}
                onValueChange={this.changeScenario.bind(this)}
              >
                <Select.Trigger>
                  <Select.Value />
                </Select.Trigger>
                <Select.Popup>
                  {SCENARIOS.map((item) => (
                    <Select.Item key={item.value} value={item.value}>
                      {item.label}
                    </Select.Item>
                  ))}
                </Select.Popup>
              </Select.Root>
            </label>
            <button
              type="button"
              onClick={this.addStep.bind(this)}
              disabled={this.state.scenario !== "working"}
            >
              Add next step
            </button>
            <button type="button" onClick={this.reset.bind(this)}>
              Reset activity
            </button>
          </div>
        </div>
        <div className="chat-activity-preview-sample">
          <ReasoningSteps
            key={this.state.revision}
            summary={summary}
            steps={steps}
            defaultOpen
          />
        </div>
      </section>
    );
  }
}

function resetActivityPreview(
  state: ActivityPreviewState,
): ActivityPreviewState {
  return { scenario: "working", revision: state.revision + 1 };
}

function activitySummary(scenario: Scenario): string {
  switch (scenario) {
    case "working":
    case "queued":
      return "Preparing the production sheet";
    case "completed":
      return "Production sheet prepared";
    case "failed":
      return "Production sheet needs attention";
    case "waiting":
      return "Waiting for kitchen approval";
    default:
      return assertNever(scenario, "Unknown activity preview scenario");
  }
}

function activitySteps(scenario: Scenario): readonly ReasoningStep[] {
  const steps: ReasoningStep[] = [
    {
      id: "orders",
      label: "Read tomorrow’s pickup orders",
      detail: "38 confirmed orders from the accepted snapshot.",
      state: "completed",
    },
    {
      id: "menu",
      label: "Check the bakery menu",
      detail: "Matched product names and allergens.",
      state: "completed",
    },
  ];
  switch (scenario) {
    case "working":
    case "queued":
      steps.push({
        id: "export",
        label: "Prepare the production sheet",
        detail: "Waiting for the export tool to return.",
        state: "running",
      });
      break;
    case "completed":
    case "waiting":
      steps.push({
        id: "export",
        label: "Prepare the production sheet",
        detail: "Export receipt received.",
        state: "completed",
      });
      break;
    case "failed":
      steps.push({
        id: "export",
        label: "Prepare the production sheet",
        detail: "The export failed. The accepted order snapshot is preserved.",
        state: "failed",
      });
      break;
    default:
      return assertNever(scenario, "Unknown activity preview scenario");
  }
  switch (scenario) {
    case "working":
      break;
    case "queued":
      steps.push({
        id: "handoff",
        label: "Confirm the kitchen handoff",
        detail: "The production sheet must be ready before the handoff.",
        state: "pending",
      });
      break;
    case "completed":
      steps.push({
        id: "handoff",
        label: "Confirm the kitchen handoff",
        detail: "The kitchen accepted the production sheet.",
        state: "completed",
      });
      break;
    case "failed":
    case "waiting":
      steps.push({
        id: "handoff",
        label: "Confirm the kitchen handoff",
        detail: "Waiting for the operator to approve the production sheet.",
        state: "waiting",
      });
      break;
    default:
      return assertNever(scenario, "Unknown activity preview scenario");
  }
  return steps;
}

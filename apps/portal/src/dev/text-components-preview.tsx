import { Select } from "../ui/select";
import React from "react";
import { MessageSquareText, Play, RotateCcw } from "lucide-react";
import { EmptyState, StreamingText, TaskList, type TaskState } from "../ui";

const sample =
  "## Tomorrow’s production\n\nPrepare **38 orders** using the accepted snapshot. The kitchen can review the quantities as they arrive, while the rest of the production sheet continues to take shape.\n\n- Start with the morning pickups, then group the remaining orders by product so the team can plan each batch at a glance.\n- Keep the customer notes beside the quantities, ready for the final review before handoff.\n\n- [x] Read the orders\n- [ ] Prepare the production sheet\n\n### Quantities\n\n| Product | Quantity |\n| --- | --- |\n| Plain financier | 24 |\n| Chocolate financier | 14 |\n\n```csv\nproduct,quantity\nplain,24\nchocolate,14\n```\n\nReference: https://example.com/orders\n\nThe sheet is ready for review.";

const TASK_STATES = [
  { value: "running", label: "Working" },
  { value: "blocked", label: "Blocked" },
  { value: "failed", label: "Needs attention" },
  { value: "completed", label: "Completed" },
];

type State = {
  readonly length: number;
  readonly status: "idle" | "streaming" | "paused" | "complete";
  readonly task: TaskState;
};

export class TextComponentsPreview extends React.Component<object, State> {
  state: State = {
    length: 0,
    status: "idle",
    task: { kind: "running", progress: 67 },
  };
  private timer: number | null = null;
  private replayButton = React.createRef<HTMLButtonElement>();

  componentWillUnmount(): void {
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private start(): void {
    this.stopTimer();
    if (this.state.status === "complete") this.setState({ length: 0 });
    this.setState({ status: "streaming" });
    this.timer = window.setInterval(this.tick.bind(this), 80);
  }

  private startFromEmpty(): void {
    this.replayButton.current?.focus({ preventScroll: true });
    this.start();
  }

  private tick(): void {
    const length = Math.min(sample.length, this.state.length + 9);
    if (length === sample.length) this.stopTimer();
    this.setState({
      length,
      status: length === sample.length ? "complete" : "streaming",
    });
  }

  private replay(): void {
    this.stopTimer();
    this.setState({ length: 0, status: "streaming" });
    this.timer = window.setInterval(this.tick.bind(this), 80);
  }

  private pause(): void {
    this.stopTimer();
    this.setState({ status: "paused" });
  }
  private finish(): void {
    this.stopTimer();
    this.setState({ length: sample.length, status: "complete" });
  }
  private reset(): void {
    this.stopTimer();
    this.setState({ length: 0, status: "idle" });
  }
  private changeTask(value: string | null): void {
    switch (value) {
      case "running":
        this.setState({ task: { kind: "running", progress: 67 } });
        break;
      case "blocked":
        this.setState({ task: { kind: "blocked" } });
        break;
      case "failed":
        this.setState({ task: { kind: "failed" } });
        break;
      case "completed":
        this.setState({ task: { kind: "completed" } });
        break;
    }
  }
  private advanceTask(): void {
    if (this.state.task.kind !== "running") return;
    const progress = (this.state.task.progress ?? 0) + 11;
    this.setState({
      task:
        progress >= 100 ? { kind: "completed" } : { kind: "running", progress },
    });
  }

  render(): React.ReactNode {
    return (
      <section
        className="agent-preview-text-components"
        aria-label="Streaming text and tasks preview"
      >
        <h2>Streaming text, empty state, and tasks</h2>
        <div className="agent-preview-controls">
          <button
            type="button"
            onClick={this.start.bind(this)}
            disabled={this.state.status === "streaming"}
          >
            Stream sample
          </button>
          <button
            type="button"
            onClick={this.pause.bind(this)}
            disabled={this.state.status !== "streaming"}
          >
            Pause stream
          </button>
          <button type="button" onClick={this.finish.bind(this)}>
            Finish stream
          </button>
          <button type="button" onClick={this.reset.bind(this)}>
            Clear sample
          </button>
          <label>
            Task state{" "}
            <Select.Root
              items={TASK_STATES}
              value={this.state.task.kind}
              onValueChange={this.changeTask.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {TASK_STATES.map((item) => (
                  <Select.Item key={item.value} value={item.value}>
                    {item.label}
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Root>
          </label>
          <button
            type="button"
            onClick={this.advanceTask.bind(this)}
            disabled={this.state.task.kind !== "running"}
          >
            Advance task
          </button>
        </div>
        <div className="agent-preview-grid">
          <section
            className="agent-preview-stream-sample"
            aria-label="Streaming sample"
            aria-live="off"
          >
            <div className="agent-preview-stream-heading">
              <h2>StreamingText</h2>
              <button
                ref={this.replayButton}
                type="button"
                onClick={this.replay.bind(this)}
              >
                <RotateCcw size={14} aria-hidden="true" />
                Replay
              </button>
            </div>
            <div
              className="agent-preview-stream-body"
              data-empty={this.state.status === "idle"}
            >
              <div
                className="agent-preview-stream-empty"
                aria-hidden={this.state.status !== "idle"}
                inert={this.state.status !== "idle"}
              >
                <EmptyState
                  title="No response yet"
                  description="Start the sample to see a response take shape."
                  icon={<MessageSquareText size={24} />}
                  actions={
                    <button
                      type="button"
                      onClick={this.startFromEmpty.bind(this)}
                    >
                      <Play size={14} aria-hidden="true" />
                      Start sample
                    </button>
                  }
                />
              </div>
              {this.state.status !== "idle" && (
                <StreamingText
                  key="sample"
                  text={sample.slice(0, this.state.length)}
                  streaming={this.state.status !== "complete"}
                />
              )}
            </div>
          </section>
          <section
            className="agent-preview-task-sample"
            aria-label="TaskList preview"
          >
            <h2>TaskList</h2>
            <TaskList
              title="Tasks"
              items={[
                {
                  id: "read",
                  label: "Read accepted orders",
                  state: { kind: "completed" },
                },
                {
                  id: "validate",
                  label: "Check product quantities",
                  state: { kind: "completed" },
                },
                {
                  id: "export",
                  label: "Prepare export",
                  state: this.state.task,
                },
                {
                  id: "review",
                  label: "Review and share",
                  state: { kind: "pending" },
                },
                {
                  id: "confirm",
                  label: "Confirm the kitchen handoff",
                  state: { kind: "pending" },
                },
              ]}
            />
          </section>
        </div>
      </section>
    );
  }
}

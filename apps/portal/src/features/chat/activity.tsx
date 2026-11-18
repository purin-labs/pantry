import React from "react";
import {
  ReasoningSteps,
  ResponseIndicator,
  type ReasoningStep,
} from "../../ui";
import type { ChatTimelineView, ChatWork } from "@seams/control-api/portal/chat";
import type { ChatStreamState } from "./delivery";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";

type ToolEvent = Variant<ChatTimelineView, "tool_started" | "tool_settled">;

type ChatResponseIndicatorProps = {
  readonly work: ChatWork | null;
  readonly stream: ChatStreamState;
  readonly sending: boolean;
};

export class ChatResponseIndicator extends React.Component<
  ChatResponseIndicatorProps,
  { readonly elapsed: number }
> {
  state = { elapsed: 0 };
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  componentDidMount(): void {
    if (this.props.work?.kind === "running")
      this.timer = setInterval(this.tick.bind(this), 1000);
  }

  componentWillUnmount(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  private tick(): void {
    this.setState({
      elapsed: Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)),
    });
  }

  render(): React.ReactNode {
    const indicator = renderResponseIndicator(this.props);
    if (indicator === null) return null;
    return (
      <div className="chat-response-progress">
        {indicator}
        {this.props.work?.kind === "running" ? (
          <span
            className="chat-working-time"
            aria-live="off"
            title="Elapsed time in this view"
          >
            Working for {formatWorkingDuration(this.state.elapsed)}
          </span>
        ) : null}
      </div>
    );
  }
}

function formatWorkingDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function renderResponseIndicator(
  props: ChatResponseIndicatorProps,
): React.ReactNode {
  const { work, stream, sending } = props;
  if (work === null || work.kind === "ready" || work.kind === "failed") {
    return sending ? (
      <ResponseIndicator state="running" label="Sending message…" />
    ) : null;
  }
  switch (work.kind) {
    case "awaiting_permission":
      return (
        <ResponseIndicator state="waiting" label="Waiting for permission" />
      );
    case "cancelling":
      if (work.expiresAt <= Date.now())
        return (
          <ResponseIndicator
            state="waiting"
            label="Waiting for stop confirmation"
          />
        );
      return <ResponseIndicator state="running" label="Stopping response…" />;
    case "running":
      if (work.expiresAt <= Date.now()) return null;
      if (stream.kind !== "idle" && stream.requestId === work.requestId) {
        switch (stream.kind) {
          case "failed":
            return null;
          case "reconnecting":
            return <ResponseIndicator state="running" label="Reconnecting…" />;
          case "paused":
            return (
              <ResponseIndicator state="waiting" label="Response paused" />
            );
          case "active":
            if (stream.text.length > 0)
              return <ResponseIndicator state="running" label="Responding…" />;
            if (stream.progress !== null)
              return <ResponseIndicator state="running" label={stream.progress} />;
            break;
          default:
            return assertNever(stream, "Unknown response stream state");
        }
      }
      return <ResponseIndicator state="running" label="Working…" />;
    default:
      return assertNever(work, "Unknown chat work state");
  }
}

/**
 * Renders the timeline. Each insert, such as a drafted message card, goes in
 * before the first event that came after it, so it shows where the agent made
 * it. Inserts newer than every event follow the timeline.
 */
export function renderChatTimeline(
  events: readonly ChatTimelineView[],
  work: ChatWork,
  renderEvent: (event: ChatTimelineView) => React.ReactNode,
  inserts: readonly ChatTimelineInsert[] = [],
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const waiting = [...inserts].sort(byInsertTime);
  const placeBefore = (createdAt: number): void => {
    while (waiting.length > 0 && (waiting[0]?.createdAt ?? 0) < createdAt) {
      const insert = waiting.shift();
      if (insert !== undefined)
        nodes.push(
          <React.Fragment key={insert.key}>{insert.node}</React.Fragment>,
        );
    }
  };
  const settled = new Set<string>();
  const latestFailure = new Map<string, string>();
  const recoveredRequests = new Set<string>();
  for (const event of events) {
    if (event.kind === "tool_settled") settled.add(toolEventKey(event));
    if (event.kind === "run_failed") {
      latestFailure.set(event.requestId, event.eventId);
      recoveredRequests.delete(event.requestId);
    }
    if (event.kind === "assistant" || event.kind === "connector")
      recoveredRequests.add(event.requestId);
  }
  let tools: ToolEvent[] = [];
  for (const event of events) {
    if (
      event.kind === "run_failed" &&
      (recoveredRequests.has(event.requestId) ||
        (work.kind === "failed" && work.requestId === event.requestId) ||
        latestFailure.get(event.requestId) !== event.eventId)
    )
      continue;
    if (event.kind === "tool_started" && settled.has(toolEventKey(event)))
      continue;
    const [firstTool] = tools;
    if (firstTool !== undefined && firstTool.requestId !== event.requestId) {
      nodes.push(renderToolSteps(tools, work));
      tools = [];
    }
    if (event.kind === "tool_started" || event.kind === "tool_settled") {
      tools.push(event);
    } else {
      if (tools.length > 0) {
        nodes.push(renderToolSteps(tools, work));
        tools = [];
      }
      placeBefore(event.createdAt);
      nodes.push(renderEvent(event));
    }
  }
  if (tools.length > 0) nodes.push(renderToolSteps(tools, work));
  placeBefore(Number.POSITIVE_INFINITY);
  return nodes;
}

export type ChatTimelineInsert = {
  readonly key: string;
  readonly createdAt: number;
  readonly node: React.ReactNode;
};

function byInsertTime(
  left: ChatTimelineInsert,
  right: ChatTimelineInsert,
): number {
  return left.createdAt - right.createdAt;
}

function toolEventKey(event: ToolEvent): string {
  return JSON.stringify([event.requestId, event.tool.toolCallId]);
}

function renderToolSteps(
  events: readonly ToolEvent[],
  work: ChatWork,
): React.ReactNode {
  const steps = new Map<string, ReasoningStep>();
  for (const event of events) {
    steps.set(event.tool.toolCallId, {
      id: event.tool.toolCallId,
      label: event.tool.action,
      detail:
        event.kind === "tool_settled"
          ? [event.summary, event.receipt?.summary].filter(Boolean).join(" · ")
          : `${event.tool.object} · ${event.tool.destination}`,
      state: toolStepState(event, work),
    });
  }
  return (
    <ReasoningSteps
      key={events[0] ? toolEventKey(events[0]) : undefined}
      summary={toolContextTrail(events)}
      steps={Array.from(steps.values())}
    />
  );
}

function toolContextTrail(events: readonly ToolEvent[]): string {
  const destinations: string[] = [];
  for (const event of events) {
    const destination = event.tool.destination;
    if (destination && destinations[destinations.length - 1] !== destination)
      destinations.push(destination);
  }
  if (destinations.length === 0) return "Activity";
  return `Activity · ${destinations.join(" → ")}`;
}

function toolStepState(
  event: ToolEvent,
  work: ChatWork,
): ReasoningStep["state"] {
  if (event.kind === "tool_started") {
    return work.kind === "running" && work.requestId === event.requestId
      ? "running"
      : "waiting";
  }
  switch (event.outcome) {
    case "succeeded":
      return "completed";
    case "failed":
    case "denied":
      return "failed";
    case "indeterminate":
      return "waiting";
    default:
      return assertNever(event.outcome, "Unknown tool outcome");
  }
}

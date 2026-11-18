import React from "react";
import { Crosshair, Sparkles, Square } from "lucide-react";
import type { CollaborationAgentActivity } from "@seams/collaboration";
import type { MenuBoardRect } from "@seams/menu-board-crdt/board";
import type { MenuBoardPresenceView } from "./board-client";
import type { CanvasAgentMark } from "./canvas-agents";
import "./canvas-presence-bar.css";

/**
 * The presence bar under the canvas (Plan 40B phase 7, slice 6): the people
 * and the agents on the board, the number of agents that act now, and the
 * number of changes in each agent's current request. Follow keeps the view
 * on the agent's real target; it is off until the person turns it on, and
 * any input of the person turns it off. The person who asked the agent
 * also sees the agent's latest line of text, which streams to that
 * person's chat, and Stop, which cancels the request through the chat's
 * own Cancel. Other people see only the agent's action labels.
 */

/** What the person who asked an agent has of its request. */
export type CanvasAgentRequest = Readonly<{
  /** The agent's Session, as the room names it. */
  agentSessionId: string;
  /** The agent's latest line of text in the person's chat, or null. */
  latestLine: string | null;
  stopping: boolean;
  stop: () => void;
}>;

export function CanvasPresenceBar(props: Readonly<{
  participants: readonly MenuBoardPresenceView[];
  marks: readonly CanvasAgentMark[];
  changes: ReadonlyMap<string, number>;
  follow: boolean;
  onFollow: (follow: boolean) => void;
  request: CanvasAgentRequest | null;
  color: (userId: string) => string;
}>): React.ReactNode {
  const agents = agentsOf(props.marks);
  const others = props.participants.filter((participant) => !participant.isSelf);
  if (others.length === 0 && agents.length === 0) return null;
  const mine = props.request === null
    ? undefined
    : agents.find((agent) => agent.sessionId === props.request?.agentSessionId);
  const active = agents.length;
  return <div className="menu-board-float menu-presence-bar" role="group" aria-label="People and agents on this board">
    <ul className="menu-presence-avatars" aria-label="On this board">
      {props.participants.map((participant) => <li
        key={participant.sessionId}
        className="menu-presence-person"
        title={participant.isSelf ? `${participant.displayName} (you)` : participant.displayName}
        style={{ "--participant": props.color(participant.userId) } as React.CSSProperties}
      >
        <span aria-hidden="true">{initials(participant.displayName)}</span>
        <span className="visually-hidden">{participant.isSelf ? `${participant.displayName} (you)` : participant.displayName}</span>
      </li>)}
      {agents.map((agent) => <li
        key={agent.sessionId}
        className="menu-presence-agent"
        data-agent-color={agent.color}
        data-agent={agent.name}
        title={`${agent.name}, an AI agent, is ${agent.label}`}
      >
        <Sparkles size={12} aria-hidden="true" />
        <span>AI · {agent.name}</span>
      </li>)}
    </ul>
    {active === 0 ? null : <span className="menu-presence-count" data-count="agents">
      {active === 1 ? "1 agent active" : `${active} agents active`}
    </span>}
    {agents.map((agent) => {
      const changes = props.changes.get(agent.sessionId) ?? 0;
      return changes === 0 ? null : <span key={agent.sessionId} className="menu-presence-count" data-count="changes" data-agent={agent.name}>
        {agent.name}: {changes === 1 ? "1 change" : `${changes} changes`}
      </span>;
    })}
    {active === 0 ? null : <button
      type="button"
      className="menu-board-text-button menu-presence-follow"
      aria-pressed={props.follow}
      title={props.follow ? "Stop following the agent" : "Keep the agent's target in view"}
      onClick={() => props.onFollow(!props.follow)}
    >
      <Crosshair size={14} aria-hidden="true" />
      Follow
    </button>}
    {props.request === null || mine === undefined ? null : <>
      {props.request.latestLine === null ? null : <p className="menu-presence-words" data-agent-color={mine.color} aria-live="polite">
        <Sparkles size={12} aria-hidden="true" />
        <span>{props.request.latestLine}</span>
      </p>}
      <button
        type="button"
        className="menu-board-text-button menu-presence-stop"
        disabled={props.request.stopping}
        onClick={props.request.stop}
      >
        <Square size={12} aria-hidden="true" />
        {props.request.stopping ? "Stopping…" : "Stop"}
      </button>
    </>}
  </div>;
}

type BarAgent = Readonly<{
  sessionId: string;
  name: string;
  color: CanvasAgentMark["color"];
  label: string;
}>;

/** One entry for each agent, from its newest mark. */
function agentsOf(marks: readonly CanvasAgentMark[]): BarAgent[] {
  const agents = new Map<string, BarAgent>();
  for (const mark of marks)
    agents.set(mark.sessionId, { sessionId: mark.sessionId, name: mark.name, color: mark.color, label: mark.label });
  return [...agents.values()];
}

/**
 * The number of board changes in each agent's current request: the edits
 * that this page saw land. An agent's Session is one request of a person,
 * so the count belongs to that request. A draft preview is no change.
 */
export function useAgentChanges(activities: readonly CollaborationAgentActivity[]): ReadonlyMap<string, number> {
  const seen = React.useRef(new Map<string, Set<string>>());
  const counts = new Map<string, number>();
  for (const activity of activities) {
    if (activity.action?.state !== "applied") continue;
    const operations = seen.current.get(activity.agent.sessionId) ?? new Set<string>();
    operations.add(activity.operationId);
    seen.current.set(activity.agent.sessionId, operations);
  }
  for (const [sessionId, operations] of seen.current) counts.set(sessionId, operations.size);
  return counts;
}

/**
 * The rect that Follow keeps in view: the newest agent's ghost box or
 * target. Only real targets: an action with no rect keeps the view still.
 */
export function followTarget(marks: readonly CanvasAgentMark[]): MenuBoardRect | null {
  for (const mark of [...marks].reverse()) {
    const rect = mark.action.state === "pending" && mark.action.rect !== null ? mark.action.rect : mark.target;
    if (rect !== null) return rect;
  }
  return null;
}

function initials(name: string): string {
  return name.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

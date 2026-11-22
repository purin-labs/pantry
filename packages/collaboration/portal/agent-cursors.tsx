import React from "react";
import { MousePointer2 } from "lucide-react";
import type { CollaborationAgentActivity } from "@purin-labs/collaboration";
import "./agent-cursors.css";

type Props = Readonly<{
  activities: readonly CollaborationAgentActivity[];
  target: string;
  action: string;
  labelLeft: boolean;
}>;

export function AgentCursors(props: Props): React.ReactNode {
  return props.activities
    .filter(targetMatches.bind(null, props.target))
    .map(renderCursor.bind(null, props));
}

function targetMatches(
  target: string,
  activity: CollaborationAgentActivity,
): boolean {
  return activity.target === target;
}

function renderCursor(
  props: Props,
  activity: CollaborationAgentActivity,
  index: number,
): React.ReactNode {
  return (
    <span
      key={JSON.stringify([activity.agent.sessionId, activity.operationId])}
      className="collaboration-agent-cursor"
      data-label-left={props.labelLeft}
      style={cursorStyle(index, activity.agent.sessionId)}
      aria-hidden="true"
    >
      <MousePointer2
        size={22}
        fill="currentColor"
        stroke="white"
        strokeWidth={1.5}
      />
      <span
        className="collaboration-agent-name"
        title={activity.agent.displayName}
      >
        {activity.agent.displayName}
      </span>
      <span className="collaboration-agent-action">{props.action}</span>
    </span>
  );
}

function cursorStyle(
  index: number,
  sessionId: string,
): React.CSSProperties & Readonly<{ "--agent-color": string }> {
  let hash = 2166136261;
  for (const character of sessionId)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return {
    top: 12 + index * 58,
    "--agent-color": `hsl(${Math.abs(hash) % 360} 60% 28%)`,
  };
}

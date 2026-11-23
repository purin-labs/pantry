import React from "react";
import type { ChatOrigin } from "@purin-labs/control-api";
import { navigationGroupTitle } from "@purin-labs/ui/route";
import "./origin-chips.css";

function originParts(origin: ChatOrigin): readonly string[] {
  return [
    navigationGroupTitle(origin.area),
    origin.title,
    ...(origin.record === null ? [] : [origin.record.label]),
  ];
}

/** "Kitchen › Costs & margins", with the record when there is one. */
function chatOriginLabel(origin: ChatOrigin): string {
  return originParts(origin).join(" › ");
}

/** Where the chat started, as one muted line in a chat list row (Plan 87). */
export function ChatOriginLine({
  origin,
}: {
  readonly origin: ChatOrigin | null;
}): React.ReactNode {
  if (origin === null) return null;
  const label = chatOriginLabel(origin);
  return (
    <span className="chat-origin-line" title={`Started on ${label}`}>
      {label}
    </span>
  );
}

import React from "react";
import type { ChatOrigin } from "@seams/control-api";
import { navigationGroupTitle } from "../../route";
import "./origin-chips.css";

function originParts(origin: ChatOrigin): readonly string[] {
  return [
    navigationGroupTitle(origin.area),
    origin.title,
    ...(origin.record === null ? [] : [origin.record.label]),
  ];
}

/** "Kitchen › Costs & margins", with the record when there is one. */
export function chatOriginLabel(origin: ChatOrigin): string {
  return originParts(origin).join(" › ");
}

/** Where the chat started, as chips under the thread title (Plan 87). */
export function ChatOriginChips({
  origin,
}: {
  readonly origin: ChatOrigin | null;
}): React.ReactNode {
  if (origin === null) return null;
  const parts = originParts(origin);
  return (
    <p
      className="chat-origin"
      aria-label={`Started on ${chatOriginLabel(origin)}`}
    >
      {parts.map(function originChip(part, index) {
        return (
          <React.Fragment key={index}>
            {index === 0 ? null : (
              <span className="chat-origin-divider" aria-hidden="true">
                ›
              </span>
            )}
            <span className="chat-origin-chip" aria-hidden="true">
              {part}
            </span>
          </React.Fragment>
        );
      })}
    </p>
  );
}

/** The same label as one muted line in a chat list row. */
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

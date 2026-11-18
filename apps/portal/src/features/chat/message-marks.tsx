import React from "react";
import type { ChatTimelineView } from "@seams/control-api/portal/chat";
import { VoiceMessageMark } from "../voice/control";
import "./screen-chip.css";

type UserEvent = Extract<ChatTimelineView, { readonly kind: "user" }>;

/** The marks on a sent message: spoken, and the page that went with it. */
export function UserMessageMarks({
  event,
}: {
  readonly event: UserEvent;
}): React.ReactNode {
  return (
    <>
      {event.spoken === undefined ? null : (
        <VoiceMessageMark spoken={event.spoken} />
      )}
      {event.sentFrom === undefined ? null : (
        <small className="chat-sent-from">
          Sent from{" "}
          {event.sentFrom.record === null
            ? event.sentFrom.title
            : `${event.sentFrom.title} › ${event.sentFrom.record}`}
        </small>
      )}
    </>
  );
}

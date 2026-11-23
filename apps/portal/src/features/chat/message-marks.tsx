import React from "react";
import type { ChatTimelineView } from "@purin-labs/control-api/portal/chat";
import { VoiceMessageMark } from "@purin-labs/surface-voice/ui/features/voice/control";
import "./screen-chip.css";
import type { Variant } from "@purin-labs/type-utils";

type UserEvent = Variant<ChatTimelineView, "user">;

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

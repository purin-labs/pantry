import {
  REGISTER_SURFACE,
  sharedChatMayCarry,
  type SurfaceObservationV2,
} from "@purin-labs/control-api";
import {
  timelineVisibleMessages,
  type ChatCommand,
  type Conversation,
} from "@purin-labs/conversation/chat/conversation";
import type { StoredConversation } from "@purin-labs/conversation/chat/store";

/**
 * Who reads the answer of a chat turn, for the page that its message carries
 * (Plan 87). A private chat passes, because only the sender reads it and the
 * sender saw the page. A shared chat passes only for a page that every member
 * of the Organisation may open (`sharedChatMayCarry`).
 */
type ScreenAudience =
  | Readonly<{ kind: "private" }>
  | Readonly<{ kind: "shared" }>
  | Readonly<{ kind: "workspace_canvas" }>;

type ScreenAdmission =
  | Readonly<{ kind: "admitted" }>
  | Readonly<{ kind: "withheld"; reason: "page_not_shared" | "canvas" }>;

export function admitScreenObservation(
  audience: ScreenAudience,
  observation: SurfaceObservationV2,
): ScreenAdmission {
  switch (audience.kind) {
    case "private":
      return { kind: "admitted" };
    case "workspace_canvas":
      return { kind: "withheld", reason: "canvas" };
    case "shared":
      return sharedChatMayCarry(observation.surface)
        ? { kind: "admitted" }
        : { kind: "withheld", reason: "page_not_shared" };
  }
}

/** The audience of a stored chat; a new chat is private to its sender. */
function storedScreenAudience(
  stored: StoredConversation | null,
): ScreenAudience {
  return stored === null || stored.sharing.visibility === "private"
    ? { kind: "private" }
    : { kind: "shared" };
}

/**
 * The command as it is stored: a page that the chat's readers may not
 * receive leaves the message, so the message keeps only its text.
 */
export function withAdmittedScreenObservation<Command extends ChatCommand>(
  stored: StoredConversation | null,
  command: Command,
): Command {
  if (
    (command.kind !== "message" &&
      command.kind !== "steer" &&
      command.kind !== "next") ||
    command.surfaceObservation === undefined
  )
    return command;
  const admission = admitScreenObservation(
    storedScreenAudience(stored),
    command.surfaceObservation,
  );
  if (admission.kind === "admitted") return command;
  // The Kitchen view is the observation's state (phase 2), so it goes
  // with the observation.
  const { surfaceObservation: _withheld, ...rest } = command;
  return { ...rest, surfaceContext: null } as Command;
}

/**
 * Whether the page that the current request carries reaches the model. The
 * check runs again at turn time, because a chat can be shared after a
 * message was sent.
 */
export function screenObservationReachesModel(
  audience: ScreenAudience,
  conversation: Conversation,
): boolean {
  const observation = latestUserObservation(conversation);
  return (
    observation !== undefined &&
    admitScreenObservation(audience, observation).kind === "admitted"
  );
}

/**
 * Whether an operator may send this page to a private chat and run its turn
 * (Plan 90 D9): Café › Register, whose four commands are the only page
 * commands of an operator's turn.
 */
export function operatorChatPage(
  observation: SurfaceObservationV2 | undefined,
): boolean {
  return observation?.surface === REGISTER_SURFACE;
}

/** Whether the person's latest message carries the page of an operator. */
export function latestRequestCarriesOperatorPage(
  conversation: Conversation,
): boolean {
  return operatorChatPage(latestUserObservation(conversation));
}

function latestUserObservation(
  conversation: Conversation,
): SurfaceObservationV2 | undefined {
  const messages = timelineVisibleMessages(conversation);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === "user") return message.surfaceObservation;
  }
  return undefined;
}

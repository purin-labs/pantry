import { controlJson } from "@purin-labs/control/worker/http";
import { saveConversation } from "../../../chat/store";

export function chatError(
  code: string,
  message: string,
  status: number,
): Response {
  return controlJson({ ok: false, error: code, message }, status);
}

export function chatSaveError(
  outcome: Exclude<
    Awaited<ReturnType<typeof saveConversation>>,
    { kind: "saved" }
  >,
): Response {
  switch (outcome.kind) {
    case "capacity":
      return chatError(
        "chat_capacity_reached",
        "This chat has reached its storage limit. Start a new chat to continue.",
        413,
      );
    case "conflict":
      return chatError(
        "chat_turn_conflict",
        "This conversation changed. Refresh it and retry.",
        409,
      );
  }
}

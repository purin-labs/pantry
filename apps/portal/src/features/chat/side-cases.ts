import {
  isConversationId,
  parseChatSideCaseView,
  type ChatSideCaseView,
  type ConversationId,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import {
  ControlApiError,
  controlRefusal,
  controlWrite,
  readCookie,
} from "../../control-client";

/** What a person does with a side Case card (Plan 74). */
export type SideCaseActions = Readonly<{
  start: (
    card: ChatSideCaseView,
  ) => Promise<
    Readonly<{ card: ChatSideCaseView; conversationId: ConversationId }>
  >;
  dismiss: (card: ChatSideCaseView) => Promise<ChatSideCaseView>;
}>;

export function createSideCaseActions(
  organisationId: string,
  conversationId: ConversationId,
): SideCaseActions {
  const base = `/v1/control/organisations/${encodeURIComponent(organisationId)}/chat/conversations/${encodeURIComponent(conversationId)}/side-cases`;
  return {
    start: async (card) => {
      const raw = await sideCaseMutation(
        `${base}/${encodeURIComponent(card.proposalId)}/start`,
      );
      if (!isConversationId(raw.conversationId))
        throw new Error("The server returned an invalid side Case.");
      return {
        card: requireCard(raw.sideCase),
        conversationId: raw.conversationId,
      };
    },
    dismiss: async (card) =>
      requireCard(
        (
          await sideCaseMutation(
            `${base}/${encodeURIComponent(card.proposalId)}/dismiss`,
          )
        ).sideCase,
      ),
  };
}

function requireCard(raw: unknown): ChatSideCaseView {
  const card = parseChatSideCaseView(raw);
  if (card === null)
    throw new Error("The server returned an invalid side Case.");
  return card;
}

async function sideCaseMutation(
  path: string,
): Promise<Record<string, unknown>> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) throw new Error("Sign in again to act on this side Case.");
  let raw: unknown;
  try {
    raw = await controlWrite(path, "POST", {});
  } catch (error) {
    if (!(error instanceof ControlApiError)) throw error;
    raw = controlRefusal(error)?.body ?? null;
  }
  if (isRecord(raw) && raw.ok === true) return raw;
  throw new Error(
    sideCaseErrorMessage(
      isRecord(raw) && typeof raw.error === "string" ? raw.error : null,
    ),
  );
}

function sideCaseErrorMessage(code: string | null): string {
  switch (code) {
    case "side_case_closed":
      return "Someone already started or dismissed this side Case. Refresh the chat.";
    case "side_case_expired":
      return "This proposal expired. Ask the agent again if the work still matters.";
    case "side_case_not_found":
      return "This side Case is not available to you.";
    case "side_case_read_only":
      return "Your project role lets you view this chat only.";
    case "side_case_model_unavailable":
      return "Connect the workspace's AI in Integrations, then start the chat again.";
    case "side_case_capacity":
      return "The new chat could not hold this brief. Start a chat and paste the brief.";
    default:
      return "The side Case did not start. Try again.";
  }
}

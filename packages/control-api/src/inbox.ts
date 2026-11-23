import { Type, type Static } from "typebox";
import { NonNegativeInteger } from "@purin-labs/contract-schema";
import { Value } from "typebox/value";

/**
 * The one Inbox (Plan 83): email and WhatsApp conversations in one list. Each
 * source is read under its own authority, and a source that cannot be read
 * says so without hiding the other. Nothing of a WhatsApp message is stored
 * for this list: the preview is read from the open Case for each request.
 */

const strict = { additionalProperties: false } as const;
const timestamp = NonNegativeInteger;

export const INBOX_PREVIEW_MAX = 200;

export const whatsappConversationStateSchema = Type.Union([
  /** A reply waits for a person's approval. */
  Type.Literal("reply_waiting"),
  /** The agent asked for a person. */
  Type.Literal("handoff_requested"),
  /**
   * The customer wrote last, and no agent reply comes: a person owns the
   * reply, the agent only drafts, or its turns stopped.
   */
  Type.Literal("no_reply_yet"),
  /** Meta did not confirm a send, and a person must check it. */
  Type.Literal("send_uncertain"),
  /** The agent owns the conversation and answered, or a turn of it is due. */
  Type.Literal("agent_handled"),
  /** A person answered last. */
  Type.Literal("person_replied"),
  /** The Case closed. Pantry deleted its text. */
  Type.Literal("closed"),
]);
export type WhatsAppConversationState = Static<
  typeof whatsappConversationStateSchema
>;

export type InboxTab = "needs" | "agent" | "handled";

/** The tab that a WhatsApp conversation shows in. */
export function whatsappConversationTab(
  state: WhatsAppConversationState,
): InboxTab {
  switch (state) {
    case "reply_waiting":
    case "handoff_requested":
    case "no_reply_yet":
    case "send_uncertain":
      return "needs";
    case "agent_handled":
      return "agent";
    case "person_replied":
    case "closed":
      return "handled";
  }
}

/** What one open or closed Case says about who must act. */
export function whatsappConversationState(
  input: Readonly<{
    closed: boolean;
    ownership: "agent_active" | "human_owned";
    handoffRequested: boolean;
    proposalLifecycle: string | null;
    lastDirection: "inbound" | "outbound" | null;
    /** An agent turn runs or is due for the Case (no pause, attempts left). */
    agentWorks: boolean;
    agentMode: WhatsAppAgentMode;
  }>,
): WhatsAppConversationState {
  if (input.closed) return "closed";
  if (input.proposalLifecycle === "send_indeterminate") return "send_uncertain";
  if (
    input.proposalLifecycle === "awaiting_approval" ||
    input.proposalLifecycle === "approved"
  )
    return "reply_waiting";
  if (input.handoffRequested) return "handoff_requested";
  if (input.ownership === "human_owned")
    return input.lastDirection === "outbound"
      ? "person_replied"
      : "no_reply_yet";
  if (
    input.lastDirection === "inbound" &&
    (input.agentMode !== "answer" || !input.agentWorks)
  )
    return "no_reply_yet";
  return "agent_handled";
}

export const inboxWhatsAppConversationSchema = Type.Object(
  {
    integrationAccountId: Type.String({ minLength: 1 }),
    caseId: Type.String({ minLength: 1 }),
    customerWaId: Type.String({ minLength: 1 }),
    proposalId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** Null when the Case closed, or the text could not be read. */
    preview: Type.Union([
      Type.String({ maxLength: INBOX_PREVIEW_MAX }),
      Type.Null(),
    ]),
    ownership: Type.Union([
      Type.Literal("agent_active"),
      Type.Literal("human_owned"),
    ]),
    state: whatsappConversationStateSchema,
    waitingSince: timestamp,
    serviceWindowExpiresAt: timestamp,
  },
  strict,
);
export type InboxWhatsAppConversation = Static<
  typeof inboxWhatsAppConversationSchema
>;

const NO_REPLY =
  /(?:^|[._+-])(?:no[._-]?reply|do[._-]?not[._-]?reply|mailer[._-]?daemon)(?:[._+-]|$)/iu;

/**
 * An address that takes no replies: noreply@, payments-no-reply@ and others.
 * Its mail waits for nobody, and the Inbox offers no reply to it.
 */
export function takesNoReplies(address: string): boolean {
  const local = address.split("@")[0] ?? "";
  return NO_REPLY.test(local);
}

/**
 * Mail of a mailbox with no agent, whose thread has no reply from it yet and
 * whose sender takes replies.
 */
export const inboxUnansweredThreadSchema = Type.Object(
  {
    integrationAccountId: Type.String({ minLength: 1 }),
    threadId: Type.String({ minLength: 1 }),
    senderName: Type.String(),
    subject: Type.String(),
    receivedAt: timestamp,
  },
  strict,
);
export type InboxUnansweredThread = Static<typeof inboxUnansweredThreadSchema>;

export const inboxConversationsSchema = Type.Object(
  {
    ok: Type.Literal(true),
    /** The wire items of `GET …/email-reviews`, of readable mailboxes only. */
    email: Type.Union([
      Type.Object(
        {
          kind: Type.Literal("read"),
          reviews: Type.Array(Type.Unknown()),
          unanswered: Type.Array(inboxUnansweredThreadSchema),
        },
        strict,
      ),
      Type.Object({ kind: Type.Literal("failed") }, strict),
    ]),
    whatsapp: Type.Union([
      /** No number is connected. The page is email only. */
      Type.Object({ kind: Type.Literal("none") }, strict),
      Type.Object(
        {
          kind: Type.Literal("read"),
          conversations: Type.Array(inboxWhatsAppConversationSchema),
          truncated: Type.Boolean(),
          /** The first number that the person may not read, for the prompt. */
          refused: Type.Unknown(),
        },
        strict,
      ),
      Type.Object({ kind: Type.Literal("failed") }, strict),
    ]),
  },
  strict,
);
export type InboxConversations = Static<typeof inboxConversationsSchema>;

/** Null when the value is not a list of the one Inbox. */
export function parseInboxConversations(
  raw: unknown,
): InboxConversations | null {
  return Value.Check(inboxConversationsSchema, raw) ? raw : null;
}

/** How the agent helps on one WhatsApp number. */
export type WhatsAppAgentMode = "off" | "draft" | "answer";

/** The topics that always wait for a person, until the operator changes them. */
export const WHATSAPP_DEFAULT_ALWAYS_WAIT_TOPICS =
  "allergy, allergies, allergic, allergen, nut, nuts, gluten";

import {
  parseInboxConversations,
  parseMailInboxResult,
  parseMailSenderLinkResponse,
  parsePermissionRequiredProblem,
  type InboxUnansweredThread,
  type MailReplyAttachment,
  type MailReplyDocument,
  type InboxWhatsAppConversation,
  type PermissionRequired,
  type MailInboxCommand,
  type MailInboxResult,
  type MailSenderLink,
  type MailSenderLinkRequest,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import {
  SUPPLIER_DIRECTORY_LIST_ID,
  SUPPLIER_ENTITY_TYPE_ID,
} from "@purin-labs/commerce-client";
import {
  ControlApiError,
  controlMutation,
  controlRead,
  controlSignal,
  controlWrite,
} from "../../control-client";
import { parseEmailReviewQueue } from "@purin-labs/control-api/portal/email-review";
import type { EmailReplyQueueItem } from "@purin-labs/control-api/portal/agent-mailbox";
import {
  commerceCollectionQuery,
  readCommerceGraph,
} from "../commerce/entity-plane/api";
import {
  type MailAgentState,
  parseMailAgentState,
} from "@purin-labs/control-api/portal/mail-agent";

export async function readMailAgent(
  organisationId: string,
  accountId: string,
): Promise<MailAgentState> {
  const state = parseMailAgentState(
    await controlRead(mailAgentPath(organisationId, accountId)),
  );
  if (state === null)
    throw new Error("The mailbox agent returned an unexpected response.");
  return state;
}

export async function resumeMailAgent(
  organisationId: string,
  accountId: string,
): Promise<void> {
  await controlMutation(
    `${mailAgentPath(organisationId, accountId)}/resume`,
    "POST",
    {},
  );
}

/**
 * When the agent reads the mailbox's new mail next. A check asks Gmail now,
 * for a push that is late or that never comes, as on a local backend.
 */
export type MailboxCheck =
  Readonly<{ kind: "scheduled"; at: number }> | Readonly<{ kind: "observed" }>;

export async function checkMailAgent(
  organisationId: string,
  accountId: string,
): Promise<MailboxCheck> {
  const raw = await controlMutation(
    `${mailAgentPath(organisationId, accountId)}/check`,
    "POST",
    {},
  );
  if (
    isRecord(raw) &&
    raw.kind === "scheduled" &&
    typeof raw.at === "number" &&
    Number.isFinite(raw.at)
  )
    return { kind: "scheduled", at: raw.at };
  if (isRecord(raw) && raw.kind === "observed") return { kind: "observed" };
  throw new Error("The mailbox check returned an unexpected response.");
}

/** The supplier that one sender address of the mailbox is linked to. */
export async function readMailSenderLink(
  organisationId: string,
  accountId: string,
  address: string,
  signal: AbortSignal,
): Promise<MailSenderLink> {
  const csrf = document.cookie
    .split("; ")
    .find(isCsrfCookie)
    ?.slice("satyr_control_csrf=".length);
  if (csrf === undefined)
    throw new Error("Your session expired. Sign in again.");
  // The address goes in the body, so that no URL log keeps it.
  return parseMailSenderLinkResponse(
    await controlSignal(
      `${mailAgentPath(organisationId, accountId)}/sender-links/read`,
      { address },
      signal,
    ),
  );
}

/** Links the sender address to a supplier. New mail from it uses the link. */
export async function linkMailSender(
  organisationId: string,
  accountId: string,
  request: MailSenderLinkRequest,
): Promise<MailSenderLink> {
  return parseMailSenderLinkResponse(
    await controlMutation(
      `${mailAgentPath(organisationId, accountId)}/sender-links`,
      "POST",
      request,
    ),
  );
}

export type MailSupplierOption = Readonly<{ supplierId: string; name: string }>;

/**
 * The suppliers of the Organisation, as the Suppliers page lists them. Null
 * when purchasing is not set up: the workspace then has no supplier directory.
 */
export async function readMailSupplierOptions(
  organisationId: string,
): Promise<readonly MailSupplierOption[] | null> {
  let result: Awaited<ReturnType<typeof readCommerceGraph>>;
  try {
    result = await readCommerceGraph(
      organisationId,
      commerceCollectionQuery({
        kind: "commerce_list",
        listId: SUPPLIER_DIRECTORY_LIST_ID,
      }),
    );
  } catch (error) {
    if (
      error instanceof ControlApiError &&
      isRecord(error.details) &&
      error.details.error === "commerce_query_surface_unsupported"
    )
      return null;
    throw error;
  }
  const names = new Map<string, string>();
  for (const entity of result.entities)
    if (
      entity.reference.origin === "custom" &&
      entity.reference.typeId === SUPPLIER_ENTITY_TYPE_ID
    )
      names.set(entity.reference.entityId, entity.displayName);
  const options: MailSupplierOption[] = [];
  for (const entry of result.listEntries)
    if (
      entry.entityRef.origin === "custom" &&
      entry.entityRef.typeId === SUPPLIER_ENTITY_TYPE_ID
    )
      options.push({
        supplierId: entry.entityRef.entityId,
        name: names.get(entry.entityRef.entityId) ?? entry.entityRef.entityId,
      });
  return options;
}

export type InboxWhatsAppSource =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{
      kind: "read";
      conversations: readonly InboxWhatsAppConversation[];
      truncated: boolean;
      refused: PermissionRequired | null;
    }>;

type InboxRead = Readonly<{
  /** Null when the email source could not be read. */
  replies: readonly EmailReplyQueueItem[] | null;
  unanswered: readonly InboxUnansweredThread[];
  whatsapp: InboxWhatsAppSource;
}>;

/** One read of both sources (Plan 83). One can fail without the other. */
export async function readInbox(
  organisationId: string,
  signal: AbortSignal,
): Promise<InboxRead> {
  const read = parseInboxConversations(
    await controlRead(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/inbox-conversations`,
      signal,
    ),
  );
  if (read === null)
    throw new Error("The server returned an invalid Inbox list.");
  let whatsapp: InboxWhatsAppSource;
  if (read.whatsapp.kind === "read")
    whatsapp = {
      kind: "read",
      conversations: read.whatsapp.conversations,
      truncated: read.whatsapp.truncated,
      refused: parsePermissionRequiredProblem({
        error: "whatsapp_read_permission_required",
        permission: read.whatsapp.refused,
      }),
    };
  else whatsapp = read.whatsapp;
  return {
    replies:
      read.email.kind === "read"
        ? parseEmailReviewQueue(read.email.reviews).replies
        : null,
    unanswered: read.email.kind === "read" ? read.email.unanswered : [],
    whatsapp,
  };
}

/** The result of a reply that a person wrote. Gmail may not confirm it. */
type MailPersonReplyResult = "sent" | "send_indeterminate";

/**
 * Sends a person's reply. The caller keeps one idempotency key for the
 * reply until a send is answered, so that the route replays a retry. The
 * body and the attachments stay only in the request, not in sessionStorage.
 */
export async function sendMailPersonReply(
  organisationId: string,
  accountId: string,
  threadId: string,
  idempotencyKey: string,
  body: string,
  document?: MailReplyDocument,
  attachments: readonly MailReplyAttachment[] = [],
): Promise<MailPersonReplyResult> {
  const raw = await controlMutation(
    `${mailAgentPath(organisationId, accountId)}/person-reply`,
    "POST",
    {
      threadId,
      body,
      ...(document === undefined ? {} : { document }),
      ...(attachments.length === 0 ? {} : { attachments }),
    },
    undefined,
    { kind: "prepared", idempotencyKey },
  );
  return isRecord(raw) && isRecord(raw.result) && raw.result.kind === "sent"
    ? "sent"
    : "send_indeterminate";
}

export async function disableMailAgent(
  organisationId: string,
  accountId: string,
): Promise<void> {
  await controlMutation(
    `${mailAgentPath(organisationId, accountId)}/disable`,
    "POST",
    {},
  );
}

function mailAgentPath(organisationId: string, accountId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/agent-mailboxes/${encodeURIComponent(accountId)}`;
}

/**
 * Google refused the mailbox's sign-in. No read of it can succeed until a
 * person reconnects the mailbox, so the Inbox asks for that.
 */
export class MailReconnectRequired extends Error {
  constructor() {
    super(
      "Google refused the Gmail sign-in. Reconnect Gmail to read this mail.",
    );
    this.name = "MailReconnectRequired";
  }
}

export async function readMailInbox(
  organisationId: string,
  command: MailInboxCommand | null,
  signal: AbortSignal,
): Promise<MailInboxResult> {
  if (command !== null) requireSession();
  const path = `/v1/control/organisations/${encodeURIComponent(organisationId)}/mail-inbox`;
  const response = await mailAnswer(
    command === null
      ? controlRead(path, signal)
      : controlWrite(path, "POST", command, signal),
  );
  const raw = response.raw;
  if (!response.ok) {
    if (isRecord(raw) && raw.error === "mail_authorization_expired")
      throw new MailReconnectRequired();
    if (isRecord(raw) && raw.error === "mail_inbox_cursor_invalid")
      throw new Error("This page has expired. Refresh the inbox to continue.");
    if (isRecord(raw) && raw.error === "mail_rule_revision_conflict")
      throw new Error("These rules changed. Refresh the inbox to continue.");
    if (isRecord(raw) && raw.error === "mail_reply_changed")
      throw new Error(
        "This reply changed or became unavailable. Refresh conversation work before previewing again.",
      );
    if (response.status === 404)
      throw new Error(
        "This mailbox or conversation is no longer available to you.",
      );
    throw new Error(
      "Mail could not be loaded. Check your connection and try again.",
    );
  }
  const result = parseMailInboxResult(raw);
  if (result === null) throw new Error("Mail returned an unexpected response.");
  return result;
}

function isCsrfCookie(cookie: string): boolean {
  return cookie.startsWith("satyr_control_csrf=");
}

/** A write needs the session's CSRF cookie: without one the person signs in again. */
function requireSession(): void {
  if (!document.cookie.split("; ").some(isCsrfCookie))
    throw new Error("Your session expired. Sign in again.");
}

/**
 * A mail request's answer: accepted or refused, the status of a refusal and
 * the JSON body. A lost connection, a cancel and an answer that is not JSON stay
 * failures, as they were before this used the control client.
 */
export async function mailAnswer(
  request: Promise<unknown>,
): Promise<Readonly<{ ok: boolean; status: number; raw: unknown }>> {
  try {
    return { ok: true, status: 200, raw: await request };
  } catch (error) {
    if (error instanceof ControlApiError && error.status !== null)
      return { ok: false, status: error.status, raw: error.details };
    throw error;
  }
}

export async function mailOrganizationRequest(
  organisationId: string,
  accountId: string,
  command:
    | import("@purin-labs/control-api").MailOrganizationCommand
    | Readonly<{ kind: "read"; messageIds: readonly string[] }>,
  signal: AbortSignal,
): Promise<unknown> {
  if (command.kind !== "read") requireSession();
  const query = new URLSearchParams();
  if (command.kind === "read")
    for (const id of command.messageIds) query.append("messageId", id);
  const path = `/v1/control/organisations/${encodeURIComponent(organisationId)}/mail-inbox/${encodeURIComponent(accountId)}/organization?${query}`;
  const response = await mailAnswer(
    command.kind === "read"
      ? controlRead(path, signal)
      : controlWrite(path, "POST", command, signal),
  );
  const raw = response.raw;
  if (!response.ok) {
    if (isRecord(raw) && raw.error === "mail_rule_revision_conflict")
      throw new Error("These rules changed. Refresh them before publishing.");
    if (isRecord(raw) && raw.error === "mail_rules_republish_required")
      throw new Error(
        "This mailbox or JEV connection changed. Review and publish your rules again.",
      );
    if (isRecord(raw) && raw.error === "mail_classification_ineligible")
      throw new Error(
        "This mailbox needs current approval for TypeSafe email processing.",
      );
    if (isRecord(raw) && raw.error === "mail_typesafe_unavailable")
      throw new Error(
        "Connect TypeSafe in Integrations to use JEV classification.",
      );
    if (isRecord(raw) && raw.error === "mail_action_mailbox_inactive")
      throw new Error(
        "Enable this mailbox’s assigned agent and email processing in Integrations before publishing a reply rule.",
      );
    throw new Error(
      "Email organization is unavailable. Refresh and try again.",
    );
  }
  return raw;
}

export async function mailAssistantRequest(
  organisationId: string,
  accountId: string,
  command: import("@purin-labs/control-api").MailAssistantCommand | null,
  signal: AbortSignal,
): Promise<unknown> {
  if (command !== null) requireSession();
  const path = `/v1/control/organisations/${encodeURIComponent(organisationId)}/mail-inbox/${encodeURIComponent(accountId)}/assistant`;
  const response = await mailAnswer(
    command === null
      ? controlRead(path, signal)
      : controlWrite(path, "POST", command, signal),
  );
  const raw = response.raw;
  if (!response.ok) {
    if (isRecord(raw) && raw.error === "mail_assistant_budget_exhausted")
      throw new Error(
        "The mailbox's daily agent budget has been used. Try again tomorrow.",
      );
    if (isRecord(raw) && raw.error === "mail_assistant_evidence_changed")
      throw new Error(
        "This email or decision changed during processing. Refresh and try again.",
      );
    if (isRecord(raw) && raw.error === "mail_assistant_eligibility_required")
      throw new Error(
        "Inbox assistance needs current processing approval for this mailbox and model.",
      );
    throw new Error(
      "Inbox assistance is unavailable. Refresh the inbox and try again.",
    );
  }
  return raw;
}

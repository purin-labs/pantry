import {
  takesNoReplies,
  whatsappConversationState,
  type InboxConversations,
  type InboxUnansweredThread,
  type InboxWhatsAppConversation,
} from "@purin-labs/control-api";
import { resolveConnectorGmailAccess } from "../../actors/connector-email-evaluation";
import {
  readEmailMailboxAccount,
  readMailboxIngressPolicy,
} from "../../data/email-mailbox";
import { listEmailReviewProjections } from "../../data/email-review";
import { listIntegrationAccounts } from "../../data/integration-account";
import { extractMailbox } from "../../mail/gmail-adapter";
import { GMAIL_MAILBOX } from "../../mail/gmail-mail-adapter";
import { runtimeFetch } from "../../runtime-fetch";
import {
  listWhatsAppCaseConversationWindows,
  listWhatsAppPhoneNumberAccounts,
  listWhatsAppReplyProposalProjections,
  readWhatsAppIngressPolicy,
  type WhatsAppCaseConversationWindow,
  type WhatsAppPhoneNumber,
  type WhatsAppReplyProposalProjection,
} from "../../data/whatsapp";
import { whatsappConnector } from "../../mail-inbox/agent-mailbox-connector";
import type { Env } from "../../env";
import { newRequestId, parseIntegrationAccountId } from "../../ids";
import { authorizeMailSource } from "../../mail-inbox/contract/mail-source-authorization";
import { traceWarn } from "../../observability";
import {
  authorizeWhatsAppSupportRead,
  whatsappSupportReadPermission,
} from "../../whatsapp/read-authorization";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { readEmailReplyHeadlines } from "../email-review-headlines";
import { emailReviewQueueItemWire } from "../email-review";
import { controlError, noStoreJson } from "../http";
import { mailControlAuthority } from "../../mail-inbox/contract/control-authority";

export type InboxConversationsRoute = Readonly<{
  kind: "inboxConversations";
  organisationIdRaw: string;
}>;

const EMAIL_REVIEW_LIMIT = 100;
const UNANSWERED_THREAD_LIMIT = 10;
/** The most conversations of one number, open ones first. */
const WHATSAPP_WINDOW_LIMIT = 50;
const WHATSAPP_PROPOSAL_LIMIT = 100;
const OPEN_LIFECYCLES: ReadonlySet<string> = new Set([
  "awaiting_approval",
  "approved",
  "send_indeterminate",
]);

export function matchInboxConversationsRoute(
  pathname: string,
): InboxConversationsRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/inbox-conversations$/u.exec(
      pathname,
    );
  return match === null
    ? null
    : {
        kind: "inboxConversations",
        organisationIdRaw: decodeURIComponent(match[1] ?? ""),
      };
}

/**
 * One list of the Inbox (Plan 83). Each source is read under its own authority,
 * a source that fails does not hide the other, and the response is not stored.
 */
export async function handleInboxConversationsRoute(
  request: Request,
  env: Env,
  route: InboxConversationsRoute,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const [email, whatsapp] = await Promise.all([
    readEmailSource(request, env, authorized).catch(
      failedSource.bind(null, "email"),
    ),
    readWhatsAppSource(env, authorized).catch(
      failedSource.bind(null, "whatsapp"),
    ),
  ]);
  return noStoreJson({
    ok: true,
    email,
    whatsapp,
  } satisfies InboxConversations);
}

function failedSource(
  source: string,
  error: unknown,
): Readonly<{ kind: "failed" }> {
  traceWarn("inbox_conversations.source_failed", {
    requestId: newRequestId(),
    code: source,
    reason: error instanceof Error ? error.message : "unknown",
  });
  return { kind: "failed" };
}

/** Replies of the mailboxes that the person may read. Others do not list. */
async function readEmailSource(
  request: Request,
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<InboxConversations["email"]> {
  const reviews = await listEmailReviewProjections({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    limit: EMAIL_REVIEW_LIMIT,
  });
  const authority = await mailControlAuthority(authorized);
  if (authority === null) return { kind: "read", reviews: [], unanswered: [] };
  const readable = new Map<string, boolean>();
  for (const review of reviews) {
    if (review.kind !== "gmail_reply") continue;
    const raw = review.integrationAccountId;
    if (readable.has(raw)) continue;
    const accountId = parseIntegrationAccountId(raw);
    readable.set(
      raw,
      accountId.ok &&
        (await authorizeMailSource(env, authority, accountId.value)) !== null,
    );
  }
  const shown = reviews.filter(
    (review) =>
      review.kind === "gmail_reply" &&
      readable.get(review.integrationAccountId) === true,
  );
  const headlines = await readEmailReplyHeadlines(
    request,
    env,
    authorized,
    shown,
  );
  return {
    kind: "read",
    reviews: shown.map(emailReviewQueueItemWire.bind(null, headlines)),
    unanswered: await readUnansweredThreads(env, authorized, authority),
  };
}

/**
 * Mailboxes with no agent have no drafts, so their new mail lists itself. Gmail
 * holds the mail, and each read asks it again. The thread read costs one Gmail
 * call for each thread, so one read names only the newest threads. Mail from a
 * sender that takes no replies waits for nobody, so it does not list.
 */
async function readUnansweredThreads(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  authority: NonNullable<Awaited<ReturnType<typeof mailControlAuthority>>>,
): Promise<InboxUnansweredThread[]> {
  const accounts = await listIntegrationAccounts({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  const unanswered: InboxUnansweredThread[] = [];
  const mail = GMAIL_MAILBOX;
  for (const account of accounts) {
    if (account.provider !== "gmail") continue;
    const policy = await readMailboxIngressPolicy({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: account.integrationAccountId,
      connectedAt: Date.now(),
    });
    if (policy.kind === "enabled") continue;
    if (
      (await authorizeMailSource(
        env,
        authority,
        account.integrationAccountId,
      )) === null
    )
      continue;
    const mailbox = await readEmailMailboxAccount({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: account.integrationAccountId,
    });
    if (!mailbox.ok) continue;
    const address = mailbox.value.observedAddress.toLowerCase();
    const access = await resolveConnectorGmailAccess({
      env,
      organisationId: authorized.organisationId,
      integrationAccountId: account.integrationAccountId,
      now: Date.now(),
      fetcher: runtimeFetch,
    });
    if (!access.ok) continue;
    const page = await mail.reads.browseInbox({
      accessToken: access.value,
      label: "INBOX",
      query: "",
      pageToken: null,
      fetcher: runtimeFetch,
    });
    if (!page.ok) continue;
    const threads = new Set<string>();
    for (const message of page.value.messages)
      if (threads.size < UNANSWERED_THREAD_LIMIT) threads.add(message.threadId);
    const read = await Promise.all(
      [...threads].map((threadId) =>
        mail.reads.readConversation({
          accessToken: access.value,
          threadId,
          fetcher: runtimeFetch,
        }),
      ),
    );
    for (const thread of read) {
      if (!thread.ok) continue;
      const newest = thread.value.at(-1);
      const sender = extractMailbox(newest?.from ?? "")?.toLowerCase() ?? "";
      if (newest === undefined || sender === address || takesNoReplies(sender))
        continue;
      unanswered.push({
        integrationAccountId: account.integrationAccountId,
        threadId: newest.threadId,
        senderName:
          newest.from.replace(/\s*<[^<>]*>\s*$/u, "").trim() || newest.from,
        subject: newest.subject,
        receivedAt: newest.receivedAt,
      });
    }
  }
  return unanswered;
}

async function readWhatsAppSource(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<InboxConversations["whatsapp"]> {
  const accounts = (
    await listWhatsAppPhoneNumberAccounts({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
    })
  ).filter(isSelected);
  if (accounts.length === 0) return { kind: "none" };
  const authority = await mailControlAuthority(authorized);
  if (authority === null) return { kind: "failed" };
  const proposals = await listWhatsAppReplyProposalProjections({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    limit: WHATSAPP_PROPOSAL_LIMIT,
  });
  const conversations: InboxWhatsAppConversation[] = [];
  let refused: unknown = null;
  let truncated = false;
  for (const account of accounts) {
    const allowed = await authorizeWhatsAppSupportRead(
      authorized.executionScope,
      authority,
      account.integrationAccountId,
    );
    if (!allowed) {
      refused ??= await whatsappSupportReadPermission(
        authorized.executionScope,
        authorized.membership.personId,
        account.integrationAccountId,
      );
      continue;
    }
    const windows = await listWhatsAppCaseConversationWindows({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId: account.integrationAccountId,
      limit: WHATSAPP_WINDOW_LIMIT + 1,
    });
    truncated ||= windows.length > WHATSAPP_WINDOW_LIMIT;
    conversations.push(
      ...(await readAccountConversations(
        env,
        authorized,
        account,
        windows.slice(0, WHATSAPP_WINDOW_LIMIT),
        proposals,
      )),
    );
  }
  return { kind: "read", conversations, truncated, refused };
}

async function readAccountConversations(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  account: WhatsAppPhoneNumber,
  windows: readonly WhatsAppCaseConversationWindow[],
  proposals: readonly WhatsAppReplyProposalProjection[],
): Promise<readonly InboxWhatsAppConversation[]> {
  if (windows.length === 0) return [];
  const now = Date.now();
  const policy = await readWhatsAppIngressPolicy({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: account.integrationAccountId,
    connectedAt: account.selectedAt ?? now,
  });
  const agentMode = policy.kind === "enabled" ? policy.agentMode : "off";
  const isOpen = (window: WhatsAppCaseConversationWindow): boolean =>
    window.closedAt === null && window.serviceWindowExpiresAt > now;
  const openIds = windows.filter(isOpen).map((window) => window.caseId);
  const heads = new Map<
    string,
    Readonly<{
      preview: string | null;
      lastDirection: "inbound" | "outbound" | null;
      lastInboundAt: number | null;
    }>
  >();
  if (openIds.length > 0) {
    const connector = await whatsappConnector(
      env,
      authorized.organisationId,
      account.integrationAccountId,
    );
    if (!connector.ok) throw new Error(connector.error.code);
    const read = await connector.value.stub.readWhatsAppConversationHeads({
      identity: connector.value.identity,
      caseIds: openIds,
      now,
    });
    if (!read.ok) throw new Error(read.error.code);
    for (const head of read.value) heads.set(head.caseId, head);
  }
  return windows.map((window) => {
    const open = isOpen(window);
    const head = open ? heads.get(window.caseId) : undefined;
    const proposal = proposals.find(
      (candidate) =>
        candidate.caseId === window.caseId &&
        OPEN_LIFECYCLES.has(candidate.lifecycleKind),
    );
    return {
      integrationAccountId: window.integrationAccountId,
      caseId: window.caseId,
      customerWaId: window.customerWaId,
      proposalId: open && proposal !== undefined ? proposal.proposalId : null,
      preview: head?.preview ?? null,
      ownership: window.ownership.kind,
      state: whatsappConversationState({
        closed: !open,
        ownership: window.ownership.kind,
        handoffRequested: window.handoffRequestedAt !== null,
        proposalLifecycle: proposal?.lifecycleKind ?? null,
        lastDirection: head?.lastDirection ?? null,
        agentMode,
      }),
      waitingSince: head?.lastInboundAt ?? window.closedAt ?? window.openedAt,
      serviceWindowExpiresAt: window.serviceWindowExpiresAt,
    };
  });
}

function isSelected(account: WhatsAppPhoneNumber): boolean {
  return account.selectedAt !== null;
}

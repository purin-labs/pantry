import {
  MAIL_REPLY_ATTACHMENT_BYTES,
  mailReplyAttachmentBlocked,
  parseMailReplyAttachments,
  parseMailReplyDocument,
  renderMailReplyHtml,
  renderMailReplyText,
} from "@seams/control-api";
import { BODY_LIMIT } from "@seams/mail-reply-crdt";
import { decodeCanonicalBase64, isNonBlankString } from "@seams/std";
import { resolveConnectorGmailAccess } from "../../actors/connector-email-evaluation";
import {
  parseControlMutationBoundary,
  readControlMutationReplay,
  type ControlMutationReceiptScope,
} from "../../data/control-mutation";
import { resolveUser } from "../../data/control-plane";
import { readEmailMailboxAccount } from "../../data/email-mailbox";
import { listEmailReviewProjections } from "../../data/email-review";
import {
  buildGmailReplyRaw,
  type GmailReplyAttachment,
  deriveGmailReplyTarget,
  dispatchRfcMessageId,
} from "../../mail/reply-target";
import { extractMailbox } from "../../mail/gmail-adapter";
import type { Env } from "../../env";
import { parseIntegrationAccountId } from "../../ids";
import { authorizeMailSource } from "../../mail-inbox/authorization";
import { PROVIDER_ADAPTERS } from "../../provider-adapters/catalogue";
import { runtimeFetch } from "../../runtime-fetch";
import { authorizeOrganisationRequest } from "../authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "../http";
import { recordCommerceMutationReceipt } from "../mutation-receipt";
import { mailControlAuthority } from "./mail-inbox";

export type MailPersonReplyRoute = Readonly<{
  kind: "mailPersonReply";
  organisationIdRaw: string;
  integrationAccountIdRaw: string;
}>;

const REVIEW_LIMIT = 100;

export function matchMailPersonReplyRoute(
  pathname: string,
): MailPersonReplyRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/agent-mailboxes\/([^/]+)\/person-reply$/u.exec(
      pathname,
    );
  return match === null
    ? null
    : {
        kind: "mailPersonReply",
        organisationIdRaw: decodeURIComponent(match[1] ?? ""),
        integrationAccountIdRaw: decodeURIComponent(match[2] ?? ""),
      };
}

/**
 * One email reply that a person writes in the Inbox (Plan 83). The person is
 * the author and the sender, so no agent and no second approval take part. The
 * recipient comes from the thread, not from the client. A send that Gmail does
 * not confirm is looked up by its Message-ID and is never sent again.
 */
export async function handleMailPersonReplyRoute(
  request: Request,
  env: Env,
  route: MailPersonReplyRoute,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const accountId = parseIntegrationAccountId(route.integrationAccountIdRaw);
  if (!accountId.ok) return controlError("mail_person_reply_invalid", 422);
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("mail_person_reply_invalid", 422);
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: false,
  });
  if (!boundary.ok || boundary.value.kind !== "unversioned")
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  const { threadId, document: documentRaw } = body.value;
  // A formatted reply sends its document. The server renders both parts from
  // it, so the text part always says what the HTML part says.
  const document =
    documentRaw === undefined ? null : parseMailReplyDocument(documentRaw);
  if (documentRaw !== undefined && document === null)
    return controlError("mail_person_reply_invalid", 422);
  const text =
    document === null ? body.value.body : renderMailReplyText(document);
  if (
    !isNonBlankString(threadId) ||
    !isNonBlankString(text) ||
    text.length > BODY_LIMIT
  )
    return controlError("mail_person_reply_invalid", 422);
  const html = document === null ? undefined : renderMailReplyHtml(document);
  const attachments = readAttachments(body.value.attachments);
  if (attachments.kind === "blocked")
    return controlError("mail_person_reply_attachment_blocked", 422);
  if (attachments.kind === "invalid")
    return controlError("mail_person_reply_invalid", 422);
  const scope: ControlMutationReceiptScope = {
    userId: authorized.authenticated.session.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/agent-mailboxes/${accountId.value}/person-reply`,
    operation: "mail_person_reply.send",
  };
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict")
    return controlError("idempotency_key_conflict", 409);
  if (replay.kind === "replay")
    return controlJson(
      replay.receipt.responseBody,
      replay.receipt.responseStatus,
    );
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const authority = await mailControlAuthority(authorized);
  if (
    authority === null ||
    (await authorizeMailSource(env, authority, accountId.value)) === null
  )
    return controlError("mail_read_refused", 403);
  // A draft that waits answers this thread. Its review decides the reply.
  const reviews = await listEmailReviewProjections({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    limit: REVIEW_LIMIT,
  });
  for (const review of reviews)
    if (
      review.kind === "gmail_reply" &&
      review.integrationAccountId === accountId.value &&
      review.backing.gmailThreadId === threadId &&
      review.lifecycleKind === "awaiting_approval"
    )
      return controlError("mail_reply_draft_waits", 409);
  const mailbox = await readEmailMailboxAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: accountId.value,
  });
  if (!mailbox.ok) return controlError("mail_mailbox_missing", 404);
  const access = await resolveConnectorGmailAccess({
    env,
    organisationId: authorized.organisationId,
    integrationAccountId: accountId.value,
    now: Date.now(),
    fetcher: runtimeFetch,
  });
  if (!access.ok) return controlError("mail_access_unavailable", 502);
  const mail = PROVIDER_ADAPTERS.gmail.mail.products.full_mailbox_pilot;
  const thread = await mail.reads.readConversation({
    accessToken: access.value,
    threadId,
    fetcher: runtimeFetch,
  });
  if (!thread.ok) return controlError("mail_thread_unavailable", 502);
  const address = mailbox.value.observedAddress.toLowerCase();
  let source: string | null = null;
  for (const message of thread.value)
    if (extractMailbox(message.from)?.toLowerCase() !== address)
      source = message.messageId;
  if (source === null) return controlError("mail_thread_has_no_sender", 409);
  const headers = await mail.reads.readMessage({
    accessToken: access.value,
    messageId: source,
    fetcher: runtimeFetch,
  });
  if (!headers.ok) return controlError("mail_thread_unavailable", 502);
  const now = Date.now();
  const target = deriveGmailReplyTarget({
    accountAddress: mailbox.value.observedAddress,
    sourceMessageId: source,
    threadId,
    headers: headers.value.headers,
    policyVersion: 1,
    expiresAt: now,
  });
  if (!target.ok) return controlError(target.error.code, 409);
  const rfcMessageId = dispatchRfcMessageId(
    `person_${crypto.randomUUID()}`,
    1,
    mailbox.value.observedAddress,
  );
  const sent = await mail.submission.sendReply({
    accessToken: access.value,
    raw: buildGmailReplyRaw({
      target: target.value,
      body: text,
      ...(html === undefined ? {} : { html }),
      attachments: attachments.files,
      rfcMessageId,
    }),
    threadId,
    fetcher: runtimeFetch,
  });
  let responseBody: JsonRecord;
  if (sent.ok) {
    responseBody = {
      ok: true,
      result: { kind: "sent", providerMessageId: sent.value.messageId },
    };
  } else {
    const found = await mail.reads.findSubmissionEvidence({
      accessToken: access.value,
      rfcMessageId,
      fetcher: runtimeFetch,
    });
    responseBody =
      found.ok && found.value !== null
        ? {
            ok: true,
            result: { kind: "sent", providerMessageId: found.value.messageId },
          }
        : { ok: true, result: { kind: "send_indeterminate", rfcMessageId } };
  }
  const recorded = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary: boundary.value,
    request,
    responseBody,
    now,
  });
  if (!recorded.ok) return controlError(recorded.error.code, 409);
  return controlJson(responseBody);
}

type ReadAttachments =
  | Readonly<{ kind: "ready"; files: readonly GmailReplyAttachment[] }>
  | Readonly<{ kind: "blocked" }>
  | Readonly<{ kind: "invalid" }>;

/**
 * The reply's files, at most MAIL_REPLY_ATTACHMENT_BYTES together. A file
 * type that Gmail refuses is refused here, before anything is sent.
 */
function readAttachments(value: unknown): ReadAttachments {
  if (value === undefined) return { kind: "ready", files: [] };
  const parsed = parseMailReplyAttachments(value);
  if (parsed === null) return { kind: "invalid" };
  const files: GmailReplyAttachment[] = [];
  let remaining = MAIL_REPLY_ATTACHMENT_BYTES;
  for (const file of parsed) {
    if (mailReplyAttachmentBlocked(file.name)) return { kind: "blocked" };
    const bytes = decodeCanonicalBase64(file.data, remaining);
    if (bytes === null || bytes.byteLength === 0) return { kind: "invalid" };
    remaining -= bytes.byteLength;
    files.push({ name: file.name, type: file.type.toLowerCase(), bytes });
  }
  return { kind: "ready", files };
}

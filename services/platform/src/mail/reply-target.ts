import type { GmailMessageHeaders } from "./gmail-adapter";
import { extractMailbox } from "./gmail-adapter";
import type { Result } from "../result";
import { encodeBase64, encodeBase64Url, sha256Hex } from "@seams/std";

/**
 * The trusted, frozen reply target. The mailbox Connector derives it from
 * the exact triggering Gmail message: one recipient selected by trusted
 * reply semantics, a normalized subject, and the In-Reply-To/References
 * chain. The model supplies only the plain-text body; recipients, subjects,
 * threads, and headers offered by any other source are rejected at this
 * boundary, and a later inbound message can never mutate an existing
 * proposal's target.
 */

export type GmailReplyTarget = {
  readonly accountAddress: string;
  readonly sourceMessageId: string;
  readonly threadId: string;
  readonly to: string;
  readonly subject: string;
  readonly inReplyTo: string | null;
  readonly references: string | null;
  readonly policyVersion: number;
  readonly expiresAt: number;
};

export type GmailReplyTargetError =
  | { readonly code: "email_reply_recipient_unresolvable" }
  | { readonly code: "email_reply_target_invalid" };

export function deriveGmailReplyTarget(
  input: Readonly<{
    accountAddress: string;
    sourceMessageId: string;
    threadId: string;
    headers: GmailMessageHeaders;
    policyVersion: number;
    expiresAt: number;
  }>,
): Result<GmailReplyTarget, GmailReplyTargetError> {
  const replyTo =
    input.headers.replyTo === null
      ? null
      : extractMailbox(input.headers.replyTo);
  const from =
    input.headers.from === null ? null : extractMailbox(input.headers.from);
  const to = replyTo ?? from;
  if (to === null || to === input.accountAddress.toLowerCase()) {
    return { ok: false, error: { code: "email_reply_recipient_unresolvable" } };
  }
  if (input.sourceMessageId.length === 0 || input.threadId.length === 0) {
    return { ok: false, error: { code: "email_reply_target_invalid" } };
  }
  const sourceRfcId = normalizeRfcId(input.headers.messageIdHeader);
  return {
    ok: true,
    value: {
      accountAddress: input.accountAddress.toLowerCase(),
      sourceMessageId: input.sourceMessageId,
      threadId: input.threadId,
      to,
      subject: replySubject(input.headers.subject),
      inReplyTo: sourceRfcId,
      references: buildReferences(input.headers.references, sourceRfcId),
      policyVersion: input.policyVersion,
      expiresAt: input.expiresAt,
    },
  };
}

export async function digestGmailReplyTarget(
  target: GmailReplyTarget,
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      kind: "satyr_email_reply_target_v1",
      accountAddress: target.accountAddress,
      sourceMessageId: target.sourceMessageId,
      threadId: target.threadId,
      to: target.to,
      subject: target.subject,
      inReplyTo: target.inReplyTo,
      references: target.references,
      policyVersion: target.policyVersion,
      expiresAt: target.expiresAt,
    }),
  );
}

export async function digestEmailBody(body: string): Promise<string> {
  return sha256Hex(JSON.stringify({ kind: "satyr_email_body_v1", body }));
}

export async function digestEmailSnapshot(
  input: Readonly<{
    targetDigest: string;
    bodyDigest: string;
    proposalId: string;
    version: number;
  }>,
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      kind: "satyr_email_snapshot_v1",
      targetDigest: input.targetDigest,
      bodyDigest: input.bodyDigest,
      proposalId: input.proposalId,
      version: input.version,
    }),
  );
}

export function proposalRfcMessageId(
  proposalId: string,
  version: number,
  accountAddress: string,
): string {
  return `<satyr-proposal-${sanitizeIdSegment(proposalId)}-v${version}@${rfcIdDomain(accountAddress)}>`;
}

export function dispatchRfcMessageId(
  proposalId: string,
  version: number,
  accountAddress: string,
): string {
  return `<satyr-dispatch-${sanitizeIdSegment(proposalId)}-v${version}@${rfcIdDomain(accountAddress)}>`;
}

/**
 * Builds the immutable RFC 5322 reply from the frozen target and the exact
 * body snapshot. Every header value is trusted-derived; the body is encoded
 * as base64 so model-supplied text can never introduce header lines. The
 * returned string is the base64url raw message for drafts.create or
 * messages.send.
 */
/** A file of a reply, as its bytes. */
export type GmailReplyAttachment = Readonly<{
  name: string;
  type: string;
  bytes: Uint8Array;
}>;

export function buildGmailReplyRaw(
  input: Readonly<{
    target: GmailReplyTarget;
    body: string;
    /** A formatted reply also carries an HTML part beside the text. */
    html?: string;
    /** Files go after the text, in one multipart/mixed message. */
    attachments?: readonly GmailReplyAttachment[];
    rfcMessageId: string;
  }>,
): string {
  const headers = [
    `To: ${assertHeaderSafe(input.target.to)}`,
    `Subject: ${encodeHeaderText(input.target.subject)}`,
    `Message-ID: ${assertHeaderSafe(input.rfcMessageId)}`,
    ...(input.target.inReplyTo === null
      ? []
      : [`In-Reply-To: ${assertHeaderSafe(input.target.inReplyTo)}`]),
    ...(input.target.references === null
      ? []
      : [`References: ${assertHeaderSafe(input.target.references)}`]),
    "MIME-Version: 1.0",
  ];
  // Each boundary is base64url, which never appears in a base64 part.
  const tag = encodeBase64Url(
    new TextEncoder().encode(input.rfcMessageId),
  ).slice(0, 40);
  const text = mimePart("text/plain", input.body);
  const content =
    input.html === undefined
      ? text
      : multipart("alternative", `satyr_${tag}`, [
          text,
          mimePart("text/html", input.html),
        ]);
  const attachments = input.attachments ?? [];
  const message =
    attachments.length === 0
      ? [...headers, ...content]
      : [
          ...headers,
          ...multipart("mixed", `satyr_mixed_${tag}`, [
            content,
            ...attachments.map(attachmentPart),
          ]),
        ];
  return encodeBase64Url(new TextEncoder().encode(message.join("\r\n")));
}

function multipart(
  kind: "alternative" | "mixed",
  boundary: string,
  parts: readonly (readonly string[])[],
): readonly string[] {
  return [
    `Content-Type: multipart/${kind}; boundary="${boundary}"`,
    "",
    ...parts.flatMap((part) => [`--${boundary}`, ...part]),
    `--${boundary}--`,
    "",
  ];
}

/** The file name travels in RFC 2231 form, so no name can break a header. */
function attachmentPart(file: GmailReplyAttachment): readonly string[] {
  const name = file.name.replaceAll(/[\u0000-\u001f\u007f"\\]/gu, "_");
  const fallback = name.replaceAll(/[^\x20-\x7e]/gu, "_");
  const encoded = encodeURIComponent(name).replaceAll(
    /['()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return [
    `Content-Type: ${assertHeaderSafe(file.type)}; name="${fallback}"`,
    `Content-Disposition: attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(encodeBase64(file.bytes)),
  ];
}

function mimePart(type: string, content: string): readonly string[] {
  return [
    `Content-Type: ${type}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(encodeBase64(new TextEncoder().encode(content))),
  ];
}

function replySubject(subject: string): string {
  const flattened = subject.replaceAll(/[\r\n]+/gu, " ").trim();
  return /^re:/iu.test(flattened) ? flattened : `Re: ${flattened}`;
}

function buildReferences(
  existing: string | null,
  sourceRfcId: string | null,
): string | null {
  const chain = [
    ...(existing === null
      ? []
      : existing.split(/\s+/u).filter((id) => /^<[^<>]+>$/u.test(id))),
    ...(sourceRfcId === null ? [] : [sourceRfcId]),
  ];
  const deduped = [...new Set(chain)];
  return deduped.length === 0 ? null : deduped.join(" ");
}

function normalizeRfcId(raw: string | null): string | null {
  if (raw === null) return null;
  const match = /<[^<>]+>/u.exec(raw.trim());
  return match?.[0] ?? null;
}

function sanitizeIdSegment(raw: string): string {
  return raw.replaceAll(/[^A-Za-z0-9_-]/gu, "-");
}

function rfcIdDomain(accountAddress: string): string {
  const at = accountAddress.lastIndexOf("@");
  const domain = at >= 0 ? accountAddress.slice(at + 1) : "";
  return /^[A-Za-z0-9.-]+$/u.test(domain) && domain.length > 0
    ? domain
    : "satyr.invalid";
}

function assertHeaderSafe(value: string): string {
  if (/[\r\n]/u.test(value)) throw new Error("email header invariant failed");
  return value;
}

function encodeHeaderText(value: string): string {
  if (/^[\t -~]*$/u.test(value)) return assertHeaderSafe(value);
  return `=?UTF-8?B?${encodeBase64(new TextEncoder().encode(value))}?=`;
}

function wrapBase64(encoded: string): string {
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join("\r\n");
}

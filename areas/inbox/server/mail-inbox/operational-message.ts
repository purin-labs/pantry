/** Builds the one-recipient, plain-text message used by the send-only path. */

import { encodeBase64, encodeBase64Url } from "@purin-labs/std";
import { wrapBase64 } from "./reply-target";

export function buildOperationalEmailRaw(
  input: Readonly<{
    readonly from: string;
    readonly to: string;
    readonly subject: string;
    readonly body: string;
    readonly rfcMessageId: string;
  }>,
): string {
  assertSafeAddress(input.from);
  assertSafeAddress(input.to);
  assertSafeHeader(input.rfcMessageId);
  const subject = normalizeSubject(input.subject);
  const body = normalizeBody(input.body);
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderText(subject)}`,
    `Message-ID: ${input.rfcMessageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const encodedBody = wrapBase64(encodeBase64(new TextEncoder().encode(body)));
  return encodeBase64Url(
    new TextEncoder().encode(`${headers.join("\r\n")}\r\n\r\n${encodedBody}`),
  );
}

export function normalizeOperationalSubject(value: string): string | null {
  const normalized = value.replaceAll(/[\r\n]+/gu, " ").trim();
  return normalized.length > 0 && normalized.length <= 998 ? normalized : null;
}

export function normalizeOperationalBody(value: string): string | null {
  const normalized = value.replaceAll(/\r\n/gu, "\n").replaceAll(/\r/gu, "\n");
  return normalized.trim().length > 0 && normalized.length <= 20_000
    ? normalized
    : null;
}

function normalizeSubject(value: string): string {
  const normalized = normalizeOperationalSubject(value);
  if (normalized === null) throw new Error("operational_email_subject_invalid");
  return normalized;
}

function normalizeBody(value: string): string {
  const normalized = normalizeOperationalBody(value);
  if (normalized === null) throw new Error("operational_email_body_invalid");
  return normalized;
}

function assertSafeAddress(value: string): void {
  if (
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value) ||
    /[\r\n]/u.test(value)
  ) {
    throw new Error("operational_email_address_invalid");
  }
}

function assertSafeHeader(value: string): void {
  if (/[\r\n]/u.test(value)) throw new Error("operational_email_header_invalid");
}

function encodeHeaderText(value: string): string {
  if (/^[\t -~]*$/u.test(value)) return value;
  return `=?UTF-8?B?${encodeBase64(new TextEncoder().encode(value))}?=`;
}

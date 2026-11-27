import type { GmailMessageContent } from "../mail/gmail-adapter";

export function mailClassificationEvidence(
  content: GmailMessageContent,
): string {
  return `From: ${content.headers.from ?? ""}\nSubject: ${content.headers.subject}\nBody:\n${content.bodyText}`;
}

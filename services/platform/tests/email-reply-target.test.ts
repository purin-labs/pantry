import { describe, expect, it } from "vitest";

import {
  buildGmailReplyRaw,
  deriveGmailReplyTarget,
  digestEmailBody,
  digestEmailSnapshot,
  digestGmailReplyTarget,
  dispatchRfcMessageId,
  proposalRfcMessageId,
  type GmailReplyTarget,
} from "../src/mail/reply-target";
import type { GmailMessageHeaders } from "../src/mail/gmail-adapter";

const NOW = 1_784_016_325_277;

describe("frozen email reply target", emailReplyTargetSuite);

function emailReplyTargetSuite(): void {
  it(
    "selects the trusted recipient and freezes the thread headers",
    derivationTest,
  );
  it("rejects self-addressed and unresolvable recipients", rejectionTest);
  it(
    "derives deterministic, distinct proposal and dispatch identities",
    messageIdTest,
  );
  it(
    "builds an immutable raw reply that resists header injection",
    rawBuildTest,
  );
  it("binds digests to every trusted target field", digestTest);
}

function headers(
  overrides: Partial<GmailMessageHeaders> = {},
): GmailMessageHeaders {
  return {
    messageIdHeader: "<origin-123@sender.example>",
    from: "Customer <customer@sender.example>",
    replyTo: null,
    subject: "Order status?",
    references: "<thread-root@sender.example>",
    date: "Mon, 24 Aug 2026 10:00:00 +0000",
    ...overrides,
  };
}

function derivationTest(): void {
  const fromOnly = deriveGmailReplyTarget({
    accountAddress: "Shop@Example.com",
    sourceMessageId: "m1",
    threadId: "t1",
    headers: headers(),
    policyVersion: 3,
    expiresAt: NOW + 86_400_000,
  });
  expect(fromOnly.ok).toBe(true);
  if (fromOnly.ok) {
    expect(fromOnly.value).toEqual({
      accountAddress: "shop@example.com",
      sourceMessageId: "m1",
      threadId: "t1",
      to: "customer@sender.example",
      subject: "Re: Order status?",
      inReplyTo: "<origin-123@sender.example>",
      references: "<thread-root@sender.example> <origin-123@sender.example>",
      policyVersion: 3,
      expiresAt: NOW + 86_400_000,
    });
  }

  const replyToPreferred = deriveGmailReplyTarget({
    accountAddress: "shop@example.com",
    sourceMessageId: "m1",
    threadId: "t1",
    headers: headers({ replyTo: "Support Desk <desk@sender.example>" }),
    policyVersion: 3,
    expiresAt: NOW,
  });
  expect(
    replyToPreferred.ok && replyToPreferred.value.to === "desk@sender.example",
  ).toBe(true);

  const alreadyRe = deriveGmailReplyTarget({
    accountAddress: "shop@example.com",
    sourceMessageId: "m1",
    threadId: "t1",
    headers: headers({ subject: "RE: Order status?", references: null }),
    policyVersion: 3,
    expiresAt: NOW,
  });
  expect(alreadyRe.ok && alreadyRe.value.subject === "RE: Order status?").toBe(
    true,
  );
  expect(
    alreadyRe.ok &&
      alreadyRe.value.references === "<origin-123@sender.example>",
  ).toBe(true);
}

function rejectionTest(): void {
  const self = deriveGmailReplyTarget({
    accountAddress: "shop@example.com",
    sourceMessageId: "m1",
    threadId: "t1",
    headers: headers({ from: "Shop <shop@example.com>" }),
    policyVersion: 1,
    expiresAt: NOW,
  });
  expect(self).toEqual({
    ok: false,
    error: { code: "email_reply_recipient_unresolvable" },
  });

  const unresolvable = deriveGmailReplyTarget({
    accountAddress: "shop@example.com",
    sourceMessageId: "m1",
    threadId: "t1",
    headers: headers({ from: "no address here" }),
    policyVersion: 1,
    expiresAt: NOW,
  });
  expect(unresolvable).toEqual({
    ok: false,
    error: { code: "email_reply_recipient_unresolvable" },
  });

  const missingThread = deriveGmailReplyTarget({
    accountAddress: "shop@example.com",
    sourceMessageId: "m1",
    threadId: "",
    headers: headers(),
    policyVersion: 1,
    expiresAt: NOW,
  });
  expect(missingThread).toEqual({
    ok: false,
    error: { code: "email_reply_target_invalid" },
  });
}

function messageIdTest(): void {
  const proposal = proposalRfcMessageId(
    "proposal:abc/1",
    2,
    "shop@example.com",
  );
  const dispatch = dispatchRfcMessageId(
    "proposal:abc/1",
    2,
    "shop@example.com",
  );
  expect(proposal).toBe("<pantry-proposal-proposal-abc-1-v2@example.com>");
  expect(dispatch).toBe("<pantry-dispatch-proposal-abc-1-v2@example.com>");
  expect(proposal).not.toBe(dispatch);
  expect(proposalRfcMessageId("p", 1, "not-an-address")).toBe(
    "<pantry-proposal-p-v1@pantry.invalid>",
  );
}

function rawBuildTest(): void {
  const target: GmailReplyTarget = {
    accountAddress: "shop@example.com",
    sourceMessageId: "m1",
    threadId: "t1",
    to: "customer@sender.example",
    subject: "Re: Order status?",
    inReplyTo: "<origin-123@sender.example>",
    references: "<thread-root@sender.example> <origin-123@sender.example>",
    policyVersion: 3,
    expiresAt: NOW,
  };
  const body = "Hello,\r\n\r\nYour order ships Monday.\r\nX-Injected: nope";
  const raw = buildGmailReplyRaw({
    target,
    body,
    rfcMessageId: proposalRfcMessageId("p1", 1, "shop@example.com"),
  });
  const decoded = decodeBase64UrlText(raw);
  const [headerBlock, bodyBlock] = splitOnce(decoded, "\r\n\r\n");
  expect(headerBlock).toContain("To: customer@sender.example");
  expect(headerBlock).toContain("Subject: Re: Order status?");
  expect(headerBlock).toContain("In-Reply-To: <origin-123@sender.example>");
  expect(headerBlock).toContain(
    "References: <thread-root@sender.example> <origin-123@sender.example>",
  );
  expect(headerBlock).toContain(
    "Message-ID: <pantry-proposal-p1-v1@example.com>",
  );
  expect(headerBlock).toContain("Content-Transfer-Encoding: base64");
  expect(headerBlock).not.toContain("X-Injected");
  const decodedBody = atob(bodyBlock.replaceAll("\r\n", ""));
  expect(decodedBody).toBe(body);

  const unicode = buildGmailReplyRaw({
    target: { ...target, subject: "Re: Bestellung – Rückfrage" },
    body: "Grüße",
    rfcMessageId: proposalRfcMessageId("p2", 1, "shop@example.com"),
  });
  const unicodeHeaders = splitOnce(decodeBase64UrlText(unicode), "\r\n\r\n")[0];
  expect(unicodeHeaders).toContain("Subject: =?UTF-8?B?");
}

async function digestTest(): Promise<void> {
  const target: GmailReplyTarget = {
    accountAddress: "shop@example.com",
    sourceMessageId: "m1",
    threadId: "t1",
    to: "customer@sender.example",
    subject: "Re: Order status?",
    inReplyTo: null,
    references: null,
    policyVersion: 3,
    expiresAt: NOW,
  };
  const base = await digestGmailReplyTarget(target);
  expect(base).toMatch(/^[0-9a-f]{64}$/u);
  expect(await digestGmailReplyTarget(target)).toBe(base);
  expect(
    await digestGmailReplyTarget({ ...target, to: "other@sender.example" }),
  ).not.toBe(base);
  expect(
    await digestGmailReplyTarget({ ...target, subject: "Re: Other" }),
  ).not.toBe(base);
  expect(await digestGmailReplyTarget({ ...target, threadId: "t2" })).not.toBe(
    base,
  );

  const body = await digestEmailBody("Hello");
  expect(await digestEmailBody("Hello")).toBe(body);
  expect(await digestEmailBody("Hello!")).not.toBe(body);

  const snapshot = await digestEmailSnapshot({
    targetDigest: base,
    bodyDigest: body,
    proposalId: "p1",
    version: 1,
  });
  const editedSnapshot = await digestEmailSnapshot({
    targetDigest: base,
    bodyDigest: await digestEmailBody("Hello!"),
    proposalId: "p1",
    version: 2,
  });
  expect(snapshot).not.toBe(editedSnapshot);
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  return index < 0
    ? [value, ""]
    : [value.slice(0, index), value.slice(index + separator.length)];
}

function decodeBase64UrlText(segment: string): string {
  const normalized = segment.replaceAll("-", "+").replaceAll("_", "/");
  return atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
}

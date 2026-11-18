import { describe, expect, it } from "vitest";

import {
  GMAIL_FULL_MAILBOX_SCOPES,
  GMAIL_SEND_ONLY_SCOPES,
  gmailProductFromScopes,
  parseGmailAuthorizationProduct,
} from "../src/mail/gmail-authorization";

describe("Gmail authorization products", () => {
  it("rejects additional, missing, or mixed Gmail scopes", () => {
    expect(
      gmailProductFromScopes([
        ...GMAIL_SEND_ONLY_SCOPES,
        "https://www.googleapis.com/auth/gmail.readonly",
      ]),
    ).toBeNull();
    expect(
      gmailProductFromScopes(GMAIL_SEND_ONLY_SCOPES.slice(0, -1)),
    ).toBeNull();
    expect(
      gmailProductFromScopes([
        ...GMAIL_FULL_MAILBOX_SCOPES,
        "https://www.googleapis.com/auth/gmail.send",
      ]),
    ).toBeNull();
  });

  it("parses only named products", () => {
    expect(parseGmailAuthorizationProduct("send_only")).toBe("send_only");
    expect(parseGmailAuthorizationProduct("full_mailbox_pilot")).toBe(
      "full_mailbox_pilot",
    );
    expect(parseGmailAuthorizationProduct("standard")).toBeNull();
    expect(parseGmailAuthorizationProduct({ product: "send_only" })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  buildOperationalEmailRaw,
  normalizeOperationalBody,
  normalizeOperationalSubject,
} from "@purin-labs/area-inbox/server/mail-inbox/operational-message";

describe("operational email message", () => {
  it("builds a deterministic single-recipient plain-text MIME message", () => {
    const input = {
      from: "ops@example.com",
      to: "supplier@example.com",
      subject: "Delivery update",
      body: "The order is ready.\nThanks!",
      rfcMessageId: "<proposal-1@example.invalid>",
    } as const;
    const first = buildOperationalEmailRaw(input);
    expect(buildOperationalEmailRaw(input)).toBe(first);
    const decoded = decodeBase64UrlText(first);
    expect(decoded).toContain("From: ops@example.com\r\n");
    expect(decoded).toContain("To: supplier@example.com\r\n");
    expect(decoded).toContain("Subject: Delivery update\r\n");
    expect(decoded).toContain("Message-ID: <proposal-1@example.invalid>\r\n");
    expect(decoded.match(/^To:/gmu)).toHaveLength(1);
  });

  it("normalizes subject line breaks and rejects unsafe addresses", () => {
    expect(normalizeOperationalSubject("  Status\r\nupdate  ")).toBe(
      "Status update",
    );
    expect(normalizeOperationalBody("  body\n")).toBe("  body\n");
    expect(() =>
      buildOperationalEmailRaw({
        from: "ops@example.com\r\nBcc: attacker@example.com",
        to: "supplier@example.com",
        subject: "Status",
        body: "Body",
        rfcMessageId: "<proposal-2@example.invalid>",
      }),
    ).toThrow("operational_email_address_invalid");
  });
});

function decodeBase64UrlText(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

import { describe, expect, it } from "vitest";

import { normalizeUntrustedCommerceText } from "@purin-labs/agent-tools/context/untrusted-commerce-text";

const BIDI_OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH = String.fromCodePoint(0x200b);
const ISOLATE = String.fromCodePoint(0x2066);
const NUL = String.fromCodePoint(0x00);

describe("untrusted commerce text", () => {
  it("removes characters that make displayed text differ from stored text", () => {
    const value = `Matcha${ZERO_WIDTH} latte${BIDI_OVERRIDE}${ISOLATE}${NUL}`;
    const normalized = normalizeUntrustedCommerceText(value, "display_name");
    expect(normalized.text).toBe("Matcha latte");
    expect(normalized.sanitized).toBe(true);
    expect(normalized.truncated).toBe(false);
  });

  it("keeps the newlines a description needs and collapses runs of them", () => {
    const normalized = normalizeUntrustedCommerceText(
      "First paragraph.\n\n\n\nSecond paragraph.",
      "description",
    );
    expect(normalized.text).toBe("First paragraph.\n\nSecond paragraph.");
    expect(normalized.sanitized).toBe(false);
  });

  it("says when it truncated rather than silently shortening", () => {
    const long = "a".repeat(500);
    const normalized = normalizeUntrustedCommerceText(long, "display_name");
    expect(normalized.text).toHaveLength(200);
    expect(normalized.truncated).toBe(true);
  });

  it("counts characters, not code units, when truncating", () => {
    // Emoji are surrogate pairs; slicing by code unit would split one in half.
    const normalized = normalizeUntrustedCommerceText(
      "🍵".repeat(300),
      "display_name",
    );
    expect([...normalized.text]).toHaveLength(200);
    expect(normalized.text.endsWith("🍵")).toBe(true);
  });

  it("normalizes compatibility forms so one name has one representation", () => {
    const normalized = normalizeUntrustedCommerceText(
      "Ｍａｔｃｈａ",
      "display_name",
    );
    expect(normalized.text).toBe("Matcha");
  });

  it("returns empty text for a value that was nothing but hidden characters", () => {
    const normalized = normalizeUntrustedCommerceText(
      `${ZERO_WIDTH}${BIDI_OVERRIDE}${ISOLATE}`,
      "display_name",
    );
    expect(normalized.text).toBe("");
    expect(normalized.sanitized).toBe(true);
  });
});

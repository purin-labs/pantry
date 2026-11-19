import { describe, expect, it } from "vitest";
import {
  decodeProtocolBytes,
  encodeProtocolBytes,
  encodeProtocolFrame,
  hasExactMessageFields,
  isCollaborationPointerPosition,
  isTextPresenceSelection,
  parseProtocolFrame,
} from "../src/index.ts";

describe("collaboration wire boundary", () => {
  it("round-trips canonical binary and rejects malformed base64url", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect(decodeProtocolBytes(encodeProtocolBytes(bytes))).toEqual(bytes);
    for (const malformed of ["", "=", "AA=", "AA+", "AA/", "AA ", "AA\n"]) {
      expect(decodeProtocolBytes(malformed)).toBeNull();
    }
  });

  it("requires the exact protocol, byte limit, and payload fields", () => {
    const frame = encodeProtocolFrame("collaboration.test.v1", { kind: "ping", value: 1 });
    const parsed = parseProtocolFrame(frame, "collaboration.test.v1", frame.length);
    expect(parsed).not.toBeNull();
    expect(parsed === null ? false : hasExactMessageFields(parsed, "value")).toBe(true);
    expect(parseProtocolFrame(frame, "collaboration.other.v1", frame.length)).toBeNull();
    expect(parseProtocolFrame(`${frame} `, "collaboration.test.v1", frame.length)).toBeNull();
  });

  it("validates pointers and transmitted relative selections", () => {
    expect(isCollaborationPointerPosition({ x: 0.25, y: 0.75 })).toBe(true);
    expect(isCollaborationPointerPosition({ x: -1, y: 0 })).toBe(false);
    expect(isTextPresenceSelection({ start: [1], end: [2], direction: "forward" })).toBe(true);
    expect(isTextPresenceSelection({ start: [], end: [2], direction: "forward" })).toBe(false);
  });
});

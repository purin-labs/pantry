import { describe, expect, it } from "vitest";
import {
  assertNever,
  bytesToHex,
  canonicalJson,
  decodeBase64,
  decodeCanonicalBase64,
  encodeBase64,
  encodeBase64Url,
  exhaustiveList,
  hasExactKeys,
  hasOnlyKeys,
  isNonNegativeInteger,
  isNormalizedText,
  isPositiveInteger,
  isRecord,
  sameJson,
  sha256Hex,
} from "../src/index.ts";

describe("value guards", () => {
  it("treats only non-null, non-array objects as records", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("{}")).toBe(false);
  });

  it("accepts only safe integers", () => {
    expect(isPositiveInteger(1)).toBe(true);
    expect(isPositiveInteger(0)).toBe(false);
    expect(isNonNegativeInteger(0)).toBe(true);
    expect(isNonNegativeInteger(1.5)).toBe(false);
    expect(isPositiveInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isPositiveInteger("1")).toBe(false);
  });
});

describe("parsing helpers", () => {
  it("checks exact and permitted keys", () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ["b", "a"])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({ a: 1, c: 3 }, ["a"])).toBe(false);
    expect(hasOnlyKeys({ a: 1 }, ["a", "b"])).toBe(true);
    expect(hasOnlyKeys({ c: 1 }, ["a", "b"])).toBe(false);
  });

  it("accepts only text with nothing to trim", () => {
    expect(isNormalizedText("cafe")).toBe(true);
    expect(isNormalizedText(" cafe")).toBe(false);
    expect(isNormalizedText("")).toBe(false);
    expect(isNormalizedText("cafe", 3)).toBe(false);
    expect(isNormalizedText(7)).toBe(false);
  });

  it("decodes only canonical base64 within its bound", () => {
    expect(decodeCanonicalBase64("AA8Q+vv/")).toEqual(
      new Uint8Array([0, 15, 16, 250, 251, 255]),
    );
    expect(decodeCanonicalBase64("YR==")).toBeNull();
    expect(decodeCanonicalBase64("AA8Q +vv/")).toBeNull();
    expect(decodeCanonicalBase64("AAA")).toBeNull();
    expect(decodeCanonicalBase64("AA8Q+vv/", 5)).toBeNull();
    expect(decodeCanonicalBase64("AA8Q+vv/", 6)).not.toBeNull();
  });
});

describe("exhaustiveList", () => {
  type Tender = "card" | "cash" | "voucher";

  it("rejects lists that drift from the union at compile time", () => {
    // @ts-expect-error "voucher" is missing
    exhaustiveList<Tender>()(["card", "cash"]);
    // @ts-expect-error "cheque" is not a Tender
    exhaustiveList<Tender>()(["card", "cash", "voucher", "cheque"]);
  });
});

describe("assertNever", () => {
  it("names the unexpected value", () => {
    expect(() => assertNever("drift" as never, "Unhandled lifecycle")).toThrow(
      "Unhandled lifecycle: drift",
    );
    expect(() => assertNever({ kind: "drift" } as never)).toThrow(
      'Unhandled value: {"kind":"drift"}',
    );
  });
});

describe("encoding", () => {
  const bytes = new Uint8Array([0, 15, 16, 250, 251, 255]);

  it("writes two lowercase hex digits per byte", () => {
    expect(bytesToHex(bytes)).toBe("000f10fafbff");
  });

  it("round-trips base64 and writes unpadded URL-safe base64", () => {
    expect(encodeBase64(bytes)).toBe("AA8Q+vv/");
    expect(decodeBase64("AA8Q+vv/")).toEqual(bytes);
    expect(encodeBase64Url(new Uint8Array([251, 255]))).toBe("-_8");
    expect(decodeBase64("not base64!")).toBeNull();
  });

  it("encodes inputs larger than one chunk", () => {
    const large = new Uint8Array(100_000).map((_, index) => index % 256);
    expect(decodeBase64(encodeBase64(large))).toEqual(large);
  });
});

describe("sha256Hex", () => {
  it("digests UTF-8 strings and bytes alike", async () => {
    const expected =
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(await sha256Hex("abc")).toBe(expected);
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(expected);
    expect(await sha256Hex(new TextEncoder().encode("abc").buffer)).toBe(
      expected,
    );
  });
});

describe("canonicalJson", () => {
  it("sorts object keys at every depth", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: null } }),
    ).toBe('{"a":{"c":null,"d":[3,{"e":2,"f":1}]},"b":1}');
  });

  it("sorts keys as strings, not in property order", () => {
    expect(canonicalJson({ 9: "nine", 10: "ten" })).toBe(
      '{"10":"ten","9":"nine"}',
    );
  });

  it("omits what JSON.stringify omits", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined])).toBe("[null]");
  });

  it("writes safe bigints as numbers and rejects what a digest cannot mean", () => {
    expect(canonicalJson({ amount: 12n })).toBe('{"amount":12}');
    expect(() => canonicalJson(2n ** 60n)).toThrow(TypeError);
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });

  it("compares values regardless of key order", () => {
    expect(sameJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
  });
});

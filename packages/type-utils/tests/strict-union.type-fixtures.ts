import type { StrictUnion, UnionKeys } from "../src/index.ts";

type Tender =
  | { readonly kind: "card"; readonly last4: string }
  | { readonly kind: "cash"; readonly tenderedMinor: number };

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const assert = <T extends true>(): T => true as T;

assert<Equal<UnionKeys<Tender>, "kind" | "last4" | "tenderedMinor">>();
assert<Equal<UnionKeys<Tender | "none">, UnionKeys<Tender>>>();

export const card: StrictUnion<Tender> = { kind: "card", last4: "4242" };
export const none: StrictUnion<Tender | "none"> = "none";

// @ts-expect-error a member cannot carry another member's keys
export const mixed: StrictUnion<Tender> = {
  kind: "card",
  last4: "4242",
  tenderedMinor: 500,
};

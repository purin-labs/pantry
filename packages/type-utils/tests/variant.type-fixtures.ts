import type { Variant, VariantBy } from "../src/index.ts";

type Shape =
  | { readonly kind: "circle"; readonly state: "drawn"; readonly r: number }
  | { readonly kind: "square"; readonly state: "drawn"; readonly side: number }
  | { readonly kind: "line"; readonly state: "pending" };

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const assert = <T extends true>(): T => true as T;

assert<Equal<Variant<Shape, "circle">["r"], number>>();
assert<
  Equal<
    Variant<Shape, "circle" | "square">,
    Exclude<Shape, { readonly kind: "line" }>
  >
>();
assert<Equal<VariantBy<Shape, "state", "pending">, Variant<Shape, "line">>>();

// @ts-expect-error an unknown tag does not silently become never
export type UnknownKind = Variant<Shape, "triangle">;
// @ts-expect-error an unknown tag does not silently become never
export type UnknownState = VariantBy<Shape, "state", "erased">;
// @ts-expect-error the discriminant must exist on every member
export type UnknownField = VariantBy<Shape, "r", number>;

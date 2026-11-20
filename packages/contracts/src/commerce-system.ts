// The commerce system that an Organisation selects: the built-in commerce
// engine (`satyr_commerce`) or Shopify. This file is the one definition of the
// kind union and of the record source that each kind gives (Refactor 17, step
// A2.5). It is a closed union of wire values, so it is in `contracts`; the
// behavior of each kind is in its `CommerceProvider`.
import { Type, type Static } from "typebox";

export const commerceSystemKindSchema = Type.Union([
  Type.Literal("satyr_commerce"),
  Type.Literal("shopify"),
]);
export type CommerceSystemKind = Static<typeof commerceSystemKindSchema>;

const COMMERCE_SYSTEM_SOURCES = {
  satyr_commerce: "underclerk",
  shopify: "shopify",
} as const satisfies Record<CommerceSystemKind, string>;

/** The provenance source of the commerce records that a system gives. */
export type CommerceSystemSource =
  (typeof COMMERCE_SYSTEM_SOURCES)[CommerceSystemKind];

const COMMERCE_SYSTEM_KINDS = Object.keys(
  COMMERCE_SYSTEM_SOURCES,
) as readonly CommerceSystemKind[];

export function isCommerceSystemKind(
  value: unknown,
): value is CommerceSystemKind {
  return COMMERCE_SYSTEM_KINDS.some((kind) => kind === value);
}

export function commerceSystemSource(
  kind: CommerceSystemKind,
): CommerceSystemSource {
  return COMMERCE_SYSTEM_SOURCES[kind];
}

/** The system whose records have this source, or null (for example `lab`). */
export function commerceSystemKindOfSource(
  source: string,
): CommerceSystemKind | null {
  return (
    COMMERCE_SYSTEM_KINDS.find(
      (kind) => COMMERCE_SYSTEM_SOURCES[kind] === source,
    ) ?? null
  );
}

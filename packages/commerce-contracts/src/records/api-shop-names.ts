// Shop names (Plan 40B phase 2). A storefront may hold one short name, such
// as `nuki`, and a shop site serves it at `nuki.menu.<domain>`. A name
// belongs to one storefront for good: a storefront that takes a new name
// keeps its earlier ones, so a printed QR code never opens another shop.
import { textLimit } from "@purin-labs/contract-schema";
import { Type, type Static } from "typebox";
import { normalizedTextSchema } from "./fields.ts";
import {
  ImmutableArray,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;

/** The most names one storefront may ever hold, its current one included. */
export const COMMERCE_SHOP_NAME_LIMIT = 5;

/**
 * Names that a shop may not take: the hosts of the services themselves and
 * the names that a person would take for one of them.
 */
export const COMMERCE_RESERVED_SHOP_NAMES: ReadonlySet<string> = new Set([
  "about",
  "abuse",
  "account",
  "accounts",
  "admin",
  "api",
  "app",
  "apps",
  "assets",
  "auth",
  "billing",
  "blog",
  "cafe",
  "cdn",
  "checkout",
  "dashboard",
  "demo",
  "dev",
  "docs",
  "email",
  "example",
  "help",
  "home",
  "hostmaster",
  "login",
  "mail",
  "menu",
  "menus",
  "order",
  "orders",
  "pay",
  "payments",
  "portal",
  "postmaster",
  "root",
  "pantry",
  "seams",
  "security",
  "shop",
  "shops",
  "signin",
  "signup",
  "staging",
  "static",
  "status",
  "store",
  "support",
  "test",
  "tv",
  "commerce",
  "webmaster",
  "www",
]);

/**
 * Why a name is refused, or undefined for a name that a shop may take: 3 to
 * 30 lowercase letters, digits and single hyphens, starting with a letter
 * and ending with a letter or digit. "xn--" names cannot occur, because two
 * hyphens in a row are refused.
 */
export function commerceShopNameProblem(
  name: string,
): "format" | "reserved" | undefined {
  if (!/^[a-z](?:[a-z0-9]|-(?!-)){1,28}[a-z0-9]$/u.test(name)) return "format";
  return COMMERCE_RESERVED_SHOP_NAMES.has(name) ? "reserved" : undefined;
}

export function isCommerceShopName(value: string): boolean {
  return commerceShopNameProblem(value) === undefined;
}

function shopNameError(): string {
  return "is not a shop name";
}

/**
 * A name in a record. The reserved list may grow, so a record accepts a
 * name of the right form that a later list reserves.
 */
export const commerceShopNameSchema = Type.Refine(
  Type.String(),
  isShopNameForm,
  shopNameError,
);

function isShopNameForm(value: string): boolean {
  return commerceShopNameProblem(value) !== "format";
}

/** A storefront's shop names, for its merchant. */
export const commerceStorefrontShopNameV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.storefront-shop-name.v1"),
  merchantId: text,
  storefrontId: text,
  name: Type.Union([commerceShopNameSchema, Type.Null()]),
  /** The names that the storefront held before, oldest first. */
  previousNames: ImmutableArray(commerceShopNameSchema),
});
export type CommerceStorefrontShopNameV1 = Static<
  typeof commerceStorefrontShopNameV1Schema
>;

/** The body of `PUT .../storefronts/:storefrontId/shop-name`. */
export const setCommerceStorefrontShopNameV1Schema = ReadonlyStrictObject({
  name: textLimit(Type.String({ maxLength: 64 })),
});
export type SetCommerceStorefrontShopNameV1 = Static<
  typeof setCommerceStorefrontShopNameV1Schema
>;

/**
 * What a change answers. A refusal is an answer, not an error: the name is
 * of the wrong form, reserved, another shop's, or one more than the
 * storefront may hold.
 */
export const commerceStorefrontShopNameChangeV1Schema = Type.Union([
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("commerce.storefront-shop-name-change.v1"),
    outcome: Type.Literal("set"),
    shopName: commerceStorefrontShopNameV1Schema,
  }),
  ReadonlyStrictObject({
    schemaVersion: Type.Literal("commerce.storefront-shop-name-change.v1"),
    outcome: Type.Literal("refused"),
    reason: Type.Union([
      Type.Literal("invalid"),
      Type.Literal("reserved"),
      Type.Literal("taken"),
      Type.Literal("limit"),
    ]),
  }),
]);
export type CommerceStorefrontShopNameChangeV1 = Static<
  typeof commerceStorefrontShopNameChangeV1Schema
>;

/** The public answer for one name: the storefront that a shop site opens. */
export const commerceShopNameV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.shop-name.v1"),
  name: commerceShopNameSchema,
  merchantId: text,
  storefrontId: text,
  /** False for an earlier name; a shop site then moves to `currentName`. */
  current: Type.Boolean(),
  currentName: commerceShopNameSchema,
});
export type CommerceShopNameV1 = Static<typeof commerceShopNameV1Schema>;

export const parseCommerceStorefrontShopNameV1 = wireRecordParser(
  commerceStorefrontShopNameV1Schema,
);
export const parseCommerceStorefrontShopNameChangeV1 = wireRecordParser(
  commerceStorefrontShopNameChangeV1Schema,
);
export const parseSetCommerceStorefrontShopNameV1 = wireRecordParser(
  setCommerceStorefrontShopNameV1Schema,
);
export const parseCommerceShopNameV1 = wireRecordParser(
  commerceShopNameV1Schema,
);

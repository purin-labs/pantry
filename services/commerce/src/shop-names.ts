// Shop names (Plan 40B phase 2). One `UnderclerkShopNameDO` holds each name
// and the storefront that owns it, so two merchants cannot take one name.
// The merchant's object keeps each storefront's current and earlier names
// and claims a name before it records it. A name never leaves its
// storefront: an earlier name keeps opening the same shop and points to the
// current one.
import {
  COMMERCE_SHOP_NAME_LIMIT,
  commerceShopNameProblem,
  type CommerceShopNameV1,
  type CommerceStorefrontShopNameChangeV1,
  type CommerceStorefrontShopNameV1,
} from "@purin-labs/commerce-contracts/records/api-shop-names";
import { isRecord } from "@purin-labs/std";

/** What one name object keeps. */
export type ShopNameOwner = Readonly<{
  merchantId: string;
  storefrontId: string;
  currentName: string;
}>;

export function parseShopNameOwner(value: unknown): ShopNameOwner | undefined {
  return isRecord(value) &&
    typeof value.merchantId === "string" &&
    typeof value.storefrontId === "string" &&
    typeof value.currentName === "string"
    ? {
        merchantId: value.merchantId,
        storefrontId: value.storefrontId,
        currentName: value.currentName,
      }
    : undefined;
}

type ShopNameNamespace = Readonly<{
  getByName(name: string): Readonly<{
    claim(owner: ShopNameOwner): Promise<"claimed" | "taken">;
    owner(): Promise<ShopNameOwner | null>;
  }>;
}>;

/** The public answer for a name, or undefined when no shop holds it. */
export async function lookUpShopName(
  names: ShopNameNamespace,
  name: string,
): Promise<CommerceShopNameV1 | undefined> {
  if (commerceShopNameProblem(name) === "format") return undefined;
  const owner = await names.getByName(name).owner();
  if (owner === null) return undefined;
  return {
    schemaVersion: "underclerk.shop-name.v1",
    name,
    merchantId: owner.merchantId,
    storefrontId: owner.storefrontId,
    current: owner.currentName === name,
    currentName: owner.currentName,
  };
}

/** A merchant object's shop names, which the HTTP API reads and sets. */
export type ShopNameRegistry = Readonly<{
  read(
    merchantId: string,
    storefrontId: string,
  ): Promise<CommerceStorefrontShopNameV1>;
  set(
    merchantId: string,
    storefrontId: string,
    name: string,
  ): Promise<CommerceStorefrontShopNameChangeV1>;
}>;

type KeyValueStorage = Readonly<{
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}>;

type StoredNames = Readonly<{
  name: string | null;
  previousNames: readonly string[];
}>;

/**
 * The registry of one merchant object. It keeps the names in the object's
 * key-value storage and runs one change at a time, so two changes for one
 * storefront cannot both count against the limit.
 */
export function merchantShopNameRegistry(
  storage: KeyValueStorage,
  names: ShopNameNamespace,
  log: (event: string, detail: string) => void,
): ShopNameRegistry {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (
    merchantId: string,
    storefrontId: string,
  ): Promise<CommerceStorefrontShopNameV1> => {
    const stored = parseStoredNames(
      await storage.get(storageKey(merchantId, storefrontId)),
    );
    return {
      schemaVersion: "underclerk.storefront-shop-name.v1",
      merchantId,
      storefrontId,
      name: stored.name,
      previousNames: stored.previousNames,
    };
  };
  const change = async (
    merchantId: string,
    storefrontId: string,
    name: string,
  ): Promise<CommerceStorefrontShopNameChangeV1> => {
    const problem = commerceShopNameProblem(name);
    if (problem !== undefined)
      return refused(problem === "format" ? "invalid" : "reserved");
    const key = storageKey(merchantId, storefrontId);
    const stored = parseStoredNames(await storage.get(key));
    if (stored.name === name) return set(await read(merchantId, storefrontId));
    const held = stored.previousNames.length + (stored.name === null ? 0 : 1);
    if (
      !stored.previousNames.includes(name) &&
      held >= COMMERCE_SHOP_NAME_LIMIT
    )
      return refused("limit");
    const owner = { merchantId, storefrontId, currentName: name };
    if ((await names.getByName(name).claim(owner)) === "taken")
      return refused("taken");
    const previousNames = [
      ...stored.previousNames.filter((previous) => previous !== name),
      ...(stored.name === null ? [] : [stored.name]),
    ];
    await storage.put(key, { name, previousNames });
    // An earlier name that still points to an older one opens the same shop,
    // so a failure here costs one more redirect, never another shop.
    for (const previous of previousNames) {
      try {
        await names.getByName(previous).claim(owner);
      } catch (error) {
        log(
          "underclerk.shop_name_pointer_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return set(await read(merchantId, storefrontId));
  };
  return {
    read,
    set: (merchantId, storefrontId, name) => {
      const next = queue.then(() => change(merchantId, storefrontId, name));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

function set(
  shopName: CommerceStorefrontShopNameV1,
): CommerceStorefrontShopNameChangeV1 {
  return {
    schemaVersion: "underclerk.storefront-shop-name-change.v1",
    outcome: "set",
    shopName,
  };
}

function refused(
  reason: Extract<
    CommerceStorefrontShopNameChangeV1,
    { outcome: "refused" }
  >["reason"],
): CommerceStorefrontShopNameChangeV1 {
  return {
    schemaVersion: "underclerk.storefront-shop-name-change.v1",
    outcome: "refused",
    reason,
  };
}

function storageKey(merchantId: string, storefrontId: string): string {
  return `shop_name:${merchantId}:${storefrontId}`;
}

function parseStoredNames(value: unknown): StoredNames {
  if (
    !isRecord(value) ||
    !(value.name === null || typeof value.name === "string") ||
    !Array.isArray(value.previousNames)
  )
    return { name: null, previousNames: [] };
  return {
    name: value.name,
    previousNames: value.previousNames.filter(
      (previous: unknown): previous is string => typeof previous === "string",
    ),
  };
}

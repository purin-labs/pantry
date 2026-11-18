import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/**
 * Vault items (Plan 79): website logins and contact profiles that agents use
 * on the Organisation's behalf. A login's password never leaves its store,
 * so no view below carries it. An Organisation keeps its items in Pantry
 * Vault or in one 1Password vault that it connects.
 */

/** An Organisation holds at most this many active items. */
export const VAULT_ITEM_LIMIT = 200;
/** A login is filled only on one of at most this many exact origins. */
export const VAULT_ORIGIN_LIMIT = 5;

function text(maxLength: number) {
  return Type.String({ minLength: 1, maxLength });
}

function optionalText(maxLength: number) {
  return Type.Union([Type.Null(), text(maxLength)]);
}

const strict = { additionalProperties: false } as const;
const timestamp = Type.Integer({ minimum: 0 });
const revision = Type.Integer({ minimum: 1 });

/** A Pantry item ID (32 hex) or a 1Password item ID (26 base32 characters). */
export const vaultItemIdSchema = Type.String({
  pattern: "^([0-9a-f]{32}|[0-9a-z]{26})$",
});
export const vaultStoreKindSchema = Type.Union([
  Type.Literal("satyr"),
  Type.Literal("onepassword"),
]);
/** A 1Password vault ID. */
export const onePasswordVaultIdSchema = Type.String({
  pattern: "^[0-9a-z]{26}$",
});
/** An exact `https` origin, as `normalizeVaultOrigin` writes it. */
export const vaultOriginSchema = Type.String({
  pattern: "^https://[a-z0-9.-]+(:[0-9]{1,5})?$",
  maxLength: 262,
});
const originsSchema = Type.Array(vaultOriginSchema, {
  minItems: 1,
  maxItems: VAULT_ORIGIN_LIMIT,
  uniqueItems: true,
});
/** A 1Password login can name more websites than Pantry writes. */
const viewOriginsSchema = Type.Array(vaultOriginSchema, {
  maxItems: 20,
  uniqueItems: true,
});
const labelSchema = text(80);
const usernameSchema = text(254);
const passwordSchema = text(1024);

export const vaultAddressSchema = Type.Object(
  {
    line1: text(200),
    line2: optionalText(200),
    city: text(120),
    region: optionalText(120),
    postalCode: optionalText(20),
    /** ISO 3166-1 alpha-2. */
    country: Type.String({ pattern: "^[A-Z]{2}$" }),
  },
  strict,
);

export const vaultContactSchema = Type.Object(
  {
    fullName: text(120),
    company: optionalText(120),
    email: optionalText(254),
    phone: optionalText(40),
    address: Type.Union([Type.Null(), vaultAddressSchema]),
    /** A tax or invoice registration number, such as a Japanese T number. */
    taxRegistrationNumber: optionalText(40),
  },
  strict,
);

export const vaultItemViewSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("website_login"),
      itemId: vaultItemIdSchema,
      store: vaultStoreKindSchema,
      label: labelSchema,
      origins: viewOriginsSchema,
      username: usernameSchema,
      revision,
      createdAt: timestamp,
      updatedAt: timestamp,
      passwordUpdatedAt: timestamp,
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("contact_profile"),
      itemId: vaultItemIdSchema,
      store: vaultStoreKindSchema,
      label: labelSchema,
      contact: vaultContactSchema,
      revision,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    strict,
  ),
]);

/** Where the Organisation's new items go, and whether 1Password answered. */
export const vaultStoreViewSchema = Type.Union([
  Type.Object({ kind: Type.Literal("satyr") }, strict),
  Type.Object(
    {
      kind: Type.Literal("onepassword"),
      vaultTitle: text(200),
      connectedAt: timestamp,
      reachable: Type.Boolean(),
    },
    strict,
  ),
]);

/**
 * Where the items live, read from Pantry alone: a status read never calls
 * 1Password, so it says nothing about whether 1Password answers.
 */
export const vaultStoreSummarySchema = Type.Object(
  {
    ok: Type.Literal(true),
    store: Type.Union([
      Type.Object({ kind: Type.Literal("satyr") }, strict),
      Type.Object(
        {
          kind: Type.Literal("onepassword"),
          vaultTitle: text(200),
          connectedAt: timestamp,
        },
        strict,
      ),
    ]),
  },
  strict,
);

export const vaultItemListSchema = Type.Object(
  {
    ok: Type.Literal(true),
    store: vaultStoreViewSchema,
    items: Type.Array(vaultItemViewSchema),
  },
  strict,
);

export const vaultStoreCommandSchema = Type.Union([
  /**
   * Connect a 1Password service account. With no vault ID, a token that
   * reaches one vault uses it; a token that reaches several asks to choose.
   */
  Type.Object(
    {
      kind: Type.Literal("connect_onepassword"),
      token: text(8192),
      vaultId: Type.Union([Type.Null(), onePasswordVaultIdSchema]),
    },
    strict,
  ),
  /** The items stay in 1Password; Pantry stops using them. */
  Type.Object({ kind: Type.Literal("disconnect_onepassword") }, strict),
  /** Moves a batch of items into the named store from the other one. */
  Type.Object(
    { kind: Type.Literal("move_items"), to: vaultStoreKindSchema },
    strict,
  ),
]);

export const vaultStoreResultSchema = Type.Union([
  Type.Object(
    {
      ok: Type.Literal(true),
      kind: Type.Literal("store"),
      store: vaultStoreViewSchema,
    },
    strict,
  ),
  Type.Object(
    {
      ok: Type.Literal(true),
      kind: Type.Literal("choose_vault"),
      vaults: Type.Array(
        Type.Object(
          {
            vaultId: onePasswordVaultIdSchema,
            title: text(200),
            itemCount: Type.Integer({ minimum: 0 }),
          },
          strict,
        ),
      ),
    },
    strict,
  ),
  Type.Object(
    {
      ok: Type.Literal(true),
      kind: Type.Literal("moved"),
      store: vaultStoreViewSchema,
      moved: Type.Integer({ minimum: 0 }),
      remaining: Type.Integer({ minimum: 0 }),
    },
    strict,
  ),
]);

export const vaultEventKindSchema = Type.Union([
  Type.Literal("item_added"),
  Type.Literal("item_edited"),
  Type.Literal("sign_in_replaced"),
  Type.Literal("item_removed"),
  Type.Literal("item_moved"),
  Type.Literal("store_connected"),
  Type.Literal("store_disconnected"),
]);

export const vaultEventListSchema = Type.Object(
  {
    ok: Type.Literal(true),
    events: Type.Array(
      Type.Object(
        {
          eventId: Type.String({ pattern: "^[0-9a-f]{32}$" }),
          kind: vaultEventKindSchema,
          itemId: Type.Union([Type.Null(), vaultItemIdSchema]),
          itemLabel: Type.Union([Type.Null(), labelSchema]),
          store: vaultStoreKindSchema,
          at: timestamp,
        },
        strict,
      ),
    ),
  },
  strict,
);

export const vaultItemCreateSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("website_login"),
      label: labelSchema,
      origins: originsSchema,
      username: usernameSchema,
      password: passwordSchema,
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("contact_profile"),
      label: labelSchema,
      contact: vaultContactSchema,
    },
    strict,
  ),
]);

export const vaultItemCommandSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("edit_login"),
      expectedRevision: revision,
      label: labelSchema,
      origins: originsSchema,
    },
    strict,
  ),
  /** A new sign-in gets a new Vault generation; the old one is revoked. */
  Type.Object(
    {
      kind: Type.Literal("replace_sign_in"),
      expectedRevision: revision,
      username: usernameSchema,
      password: passwordSchema,
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("edit_contact"),
      expectedRevision: revision,
      label: labelSchema,
      contact: vaultContactSchema,
    },
    strict,
  ),
  Type.Object(
    { kind: Type.Literal("remove"), expectedRevision: revision },
    strict,
  ),
]);

export const vaultItemResultSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), item: vaultItemViewSchema }, strict),
  Type.Object({ ok: Type.Literal(true), removed: vaultItemIdSchema }, strict),
]);

export type VaultAddress = Static<typeof vaultAddressSchema>;
export type VaultContact = Static<typeof vaultContactSchema>;
export type VaultItemView = Static<typeof vaultItemViewSchema>;
export type VaultItemKind = VaultItemView["kind"];
export type VaultItemCreate = Static<typeof vaultItemCreateSchema>;
export type VaultItemCommand = Static<typeof vaultItemCommandSchema>;
export type VaultItemResult = Static<typeof vaultItemResultSchema>;
export type VaultStoreKind = Static<typeof vaultStoreKindSchema>;
export type VaultStoreView = Static<typeof vaultStoreViewSchema>;
export type VaultItemList = Static<typeof vaultItemListSchema>;
export type VaultStoreSummary = Static<typeof vaultStoreSummarySchema>["store"];
export type VaultStoreCommand = Static<typeof vaultStoreCommandSchema>;
export type VaultStoreResult = Static<typeof vaultStoreResultSchema>;
export type VaultEventKind = Static<typeof vaultEventKindSchema>;
export type VaultEvent = Static<typeof vaultEventListSchema>["events"][number];

function checked<T extends TSchema>(schema: T, raw: unknown): Static<T> | null {
  return Value.Check(schema, raw) ? raw : null;
}

/** A list read, with every origin in its written form. */
export function parseVaultItemList(raw: unknown): VaultItemList | null {
  const list = checked(vaultItemListSchema, raw);
  return list !== null && list.items.every(hasWrittenOrigins) ? list : null;
}

export function parseVaultStoreSummary(raw: unknown): VaultStoreSummary | null {
  return checked(vaultStoreSummarySchema, raw)?.store ?? null;
}

export function parseVaultStoreCommand(raw: unknown): VaultStoreCommand | null {
  return checked(vaultStoreCommandSchema, raw);
}

export function parseVaultStoreResult(raw: unknown): VaultStoreResult | null {
  return checked(vaultStoreResultSchema, raw);
}

export function parseVaultEventList(
  raw: unknown,
): readonly VaultEvent[] | null {
  return checked(vaultEventListSchema, raw)?.events ?? null;
}

export function parseVaultItemResult(raw: unknown): VaultItemResult | null {
  const result = checked(vaultItemResultSchema, raw);
  if (result === null) return null;
  return "item" in result && !hasWrittenOrigins(result.item) ? null : result;
}

export function parseVaultItemCreate(raw: unknown): VaultItemCreate | null {
  const create = checked(vaultItemCreateSchema, raw);
  return create !== null && hasWrittenOrigins(create) ? create : null;
}

export function parseVaultItemCommand(raw: unknown): VaultItemCommand | null {
  const command = checked(vaultItemCommandSchema, raw);
  return command !== null && hasWrittenOrigins(command) ? command : null;
}

/** One item view, as a store answers it. */
export function isVaultItemView(raw: unknown): raw is VaultItemView {
  return Value.Check(vaultItemViewSchema, raw) && hasWrittenOrigins(raw);
}

/** A stored contact profile, read back from its JSON column. */
export function isVaultContact(raw: unknown): raw is VaultContact {
  return Value.Check(vaultContactSchema, raw);
}

/** A stored origin list, read back from its JSON column. */
export function isVaultOriginList(raw: unknown): raw is string[] {
  return (
    Array.isArray(raw) &&
    raw.every(
      (origin) => typeof origin === "string" && isWrittenVaultOrigin(origin),
    )
  );
}

function hasWrittenOrigins(value: object): boolean {
  return !("origins" in value) || isVaultOriginList(value.origins);
}

/** True when the origin is exactly what `normalizeVaultOrigin` makes of it. */
export function isWrittenVaultOrigin(origin: string): boolean {
  return normalizeVaultOrigin(origin) === origin;
}

/**
 * The exact origin of what a person types: `shop.example.com`,
 * `https://shop.example.com/login` and `HTTPS://Shop.Example.com` all give
 * `https://shop.example.com`. Only `https` sites with a dotted host qualify,
 * because a fill must never reach an unencrypted page or a local name.
 */
export function normalizeVaultOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    !url.hostname.includes(".") ||
    url.hostname.startsWith(".") ||
    url.hostname.endsWith(".") ||
    /^[0-9.]+$/.test(url.hostname)
  )
    return null;
  return Value.Check(vaultOriginSchema, url.origin) ? url.origin : null;
}

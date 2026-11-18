import {
  isVaultContact,
  normalizeVaultOrigin,
  parseVaultItemCreate,
  type VaultContact,
  type VaultItemCreate,
  type VaultItemView,
} from "@seams/control-api";
import { assertNever, isRecord } from "@seams/std";

import type {
  OnePasswordErrorCode,
  OnePasswordItemChange,
  OnePasswordOperation,
  OnePasswordResponse,
} from "./protocol";

/**
 * The 1Password store (Plan 79): one operation of the Platform against the
 * 1Password SDK. The production Worker passes the real SDK client; the E2E
 * runtime passes an in-memory client of the same shape, so this mapping is
 * the code under test in both.
 *
 * A Pantry login is a 1Password Login with the built-in `username` and
 * `password` fields and one exact-domain website for each origin. A contact
 * profile is an Identity whose values live in a "Pantry contact" section, so
 * it reads back exactly. Other categories are not listed yet.
 */

/** The part of the 1Password SDK client that the store uses. */
export type OnePasswordClient = Readonly<{
  vaults: Readonly<{
    list(): Promise<readonly OnePasswordVaultRecord[]>;
  }>;
  items: Readonly<{
    list(vaultId: string): Promise<readonly OnePasswordItemOverview[]>;
    get(vaultId: string, itemId: string): Promise<OnePasswordItem>;
    create(params: OnePasswordItemCreate): Promise<OnePasswordItem>;
    put(item: OnePasswordItem): Promise<OnePasswordItem>;
    archive(vaultId: string, itemId: string): Promise<void>;
  }>;
}>;

export type OnePasswordVaultRecord = Readonly<{
  id: string;
  title: string;
  activeItemCount: number;
}>;

export type OnePasswordItemOverview = Readonly<{
  id: string;
  title: string;
  category: string;
  vaultId: string;
  state?: string;
}>;

export type OnePasswordField = Readonly<{
  id: string;
  title: string;
  sectionId?: string;
  fieldType: string;
  value: string;
}>;

export type OnePasswordWebsite = Readonly<{
  url: string;
  label: string;
  autofillBehavior: string;
}>;

export type OnePasswordItem = Readonly<{
  id: string;
  title: string;
  category: string;
  vaultId: string;
  fields: readonly OnePasswordField[];
  sections: readonly Readonly<{ id: string; title: string }>[];
  notes: string;
  tags: readonly string[];
  websites: readonly OnePasswordWebsite[];
  version: number;
  files: readonly unknown[];
  createdAt: Date;
  updatedAt: Date;
}>;

export type OnePasswordItemCreate = Readonly<{
  category: string;
  vaultId: string;
  title: string;
  fields: readonly OnePasswordField[];
  sections: readonly Readonly<{ id: string; title: string }>[];
  websites: readonly OnePasswordWebsite[];
  tags: readonly string[];
}>;

const LOGIN = "Login";
const IDENTITY = "Identity";
const CONTACT_SECTION = { id: "satyr_contact", title: "Seams Pantry contact" };
/** Items that Pantry writes carry this tag, so people see where they came from. */
const SATYR_TAG = "Seams Pantry";

export async function handleOnePasswordOperation(
  operation: OnePasswordOperation,
  client: OnePasswordClient,
): Promise<OnePasswordResponse> {
  try {
    switch (operation.op) {
      case "list_vaults":
        return {
          ok: true,
          vaults: (await client.vaults.list()).map((vault) => ({
            vaultId: vault.id,
            title: vault.title,
            itemCount: vault.activeItemCount,
          })),
        };
      case "list_items":
        return { ok: true, items: await listItems(client, operation.vaultId) };
      case "create_item": {
        const created = await client.items.create(
          createParams(operation.vaultId, operation.item),
        );
        return itemResponse(created);
      }
      case "update_item": {
        const current = await client.items.get(
          operation.vaultId,
          operation.itemId,
        );
        if (current.version !== operation.expectedVersion)
          return failure("onepassword_version_conflict");
        const changed = changeItem(current, operation.change);
        if (changed === null) return failure("onepassword_request_invalid");
        return itemResponse(await client.items.put(changed));
      }
      case "archive_item":
        await client.items.archive(operation.vaultId, operation.itemId);
        return { ok: true, archived: true };
      case "read_secret": {
        const item = await client.items.get(
          operation.vaultId,
          operation.itemId,
        );
        return { ok: true, secret: loginSecret(item) };
      }
      default:
        return assertNever(operation);
    }
  } catch (error) {
    return failure(errorCode(error));
  }
}

async function listItems(
  client: OnePasswordClient,
  vaultId: string,
): Promise<readonly VaultItemView[]> {
  const overviews = (await client.items.list(vaultId)).filter(
    (item) =>
      (item.category === LOGIN || item.category === IDENTITY) &&
      (item.state === undefined || item.state === "active"),
  );
  const items = await Promise.all(
    overviews.map((overview) => client.items.get(vaultId, overview.id)),
  );
  return items
    .map(itemView)
    .filter((view): view is VaultItemView => view !== null);
}

function itemResponse(item: OnePasswordItem): OnePasswordResponse {
  const view = itemView(item);
  return view === null
    ? failure("onepassword_request_invalid")
    : { ok: true, item: view };
}

/** The item as the Vault page shows it: never a password. */
export function itemView(item: OnePasswordItem): VaultItemView | null {
  const common = {
    itemId: item.id,
    store: "onepassword" as const,
    label: item.title.trim().slice(0, 80) || "Untitled",
    revision: Math.max(1, item.version),
    createdAt: item.createdAt.getTime(),
    updatedAt: item.updatedAt.getTime(),
  };
  if (item.category === LOGIN) {
    const username = fieldValue(item, "username");
    if (username === null) return null;
    return {
      kind: "website_login",
      ...common,
      origins: websiteOrigins(item.websites),
      username: username.slice(0, 254),
      passwordUpdatedAt: common.updatedAt,
    };
  }
  if (item.category === IDENTITY) {
    const contact = identityContact(item);
    return contact === null
      ? null
      : { kind: "contact_profile", ...common, contact };
  }
  return null;
}

function websiteOrigins(websites: readonly OnePasswordWebsite[]): string[] {
  const origins: string[] = [];
  for (const website of websites) {
    const origin = normalizeVaultOrigin(website.url);
    if (origin !== null && !origins.includes(origin)) origins.push(origin);
  }
  return origins.slice(0, 20);
}

function loginSecret(item: OnePasswordItem) {
  if (item.category !== LOGIN) return null;
  const username = fieldValue(item, "username");
  const password = fieldValue(item, "password");
  return username === null || password === null
    ? null
    : { kind: "website_login" as const, username, password };
}

function fieldValue(item: OnePasswordItem, id: string): string | null {
  const field = item.fields.find(
    (candidate) => candidate.id === id && candidate.value !== "",
  );
  return field?.value ?? null;
}

function createParams(
  vaultId: string,
  item: VaultItemCreate,
): OnePasswordItemCreate {
  switch (item.kind) {
    case "website_login":
      return {
        category: LOGIN,
        vaultId,
        title: item.label,
        fields: loginFields(item.username, item.password),
        sections: [],
        websites: websites(item.origins),
        tags: [SATYR_TAG],
      };
    case "contact_profile":
      return {
        category: IDENTITY,
        vaultId,
        title: item.label,
        fields: contactFields(item.contact),
        sections: [CONTACT_SECTION],
        websites: [],
        tags: [SATYR_TAG],
      };
    default:
      return assertNever(item);
  }
}

function changeItem(
  item: OnePasswordItem,
  change: OnePasswordItemChange,
): OnePasswordItem | null {
  switch (change.kind) {
    case "edit_login":
      return item.category === LOGIN
        ? { ...item, title: change.label, websites: websites(change.origins) }
        : null;
    case "replace_sign_in":
      return item.category === LOGIN
        ? {
            ...item,
            fields: [
              ...item.fields.filter(
                (field) => field.id !== "username" && field.id !== "password",
              ),
              ...loginFields(change.username, change.password),
            ],
          }
        : null;
    case "edit_contact":
      return item.category === IDENTITY
        ? {
            ...item,
            title: change.label,
            fields: [
              ...item.fields.filter(
                (field) => field.sectionId !== CONTACT_SECTION.id,
              ),
              ...contactFields(change.contact),
            ],
            sections: item.sections.some(
              (section) => section.id === CONTACT_SECTION.id,
            )
              ? item.sections
              : [...item.sections, CONTACT_SECTION],
          }
        : null;
    default:
      return assertNever(change);
  }
}

function loginFields(username: string, password: string): OnePasswordField[] {
  return [
    { id: "username", title: "username", fieldType: "Text", value: username },
    {
      id: "password",
      title: "password",
      fieldType: "Concealed",
      value: password,
    },
  ];
}

function websites(origins: readonly string[]): OnePasswordWebsite[] {
  // Exact domain matches the Vault's rule: fill only on these origins.
  return origins.map((origin) => ({
    url: origin,
    label: "website",
    autofillBehavior: "ExactDomain",
  }));
}

const CONTACT_FIELDS = [
  ["full_name", "Full name"],
  ["company", "Company"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["address_line1", "Street address"],
  ["address_line2", "Address line 2"],
  ["city", "City"],
  ["region", "State or prefecture"],
  ["postal_code", "Postal code"],
  ["country", "Country"],
  ["tax_registration_number", "Tax or invoice registration number"],
] as const;

type ContactFieldId = (typeof CONTACT_FIELDS)[number][0];

function contactValues(
  contact: VaultContact,
): Record<ContactFieldId, string | null> {
  return {
    full_name: contact.fullName,
    company: contact.company,
    email: contact.email,
    phone: contact.phone,
    address_line1: contact.address?.line1 ?? null,
    address_line2: contact.address?.line2 ?? null,
    city: contact.address?.city ?? null,
    region: contact.address?.region ?? null,
    postal_code: contact.address?.postalCode ?? null,
    country: contact.address?.country ?? null,
    tax_registration_number: contact.taxRegistrationNumber,
  };
}

function contactFields(contact: VaultContact): OnePasswordField[] {
  const values = contactValues(contact);
  return CONTACT_FIELDS.flatMap(([id, title]) => {
    const value = values[id];
    return value === null
      ? []
      : [
          {
            id: `satyr_${id}`,
            title,
            sectionId: CONTACT_SECTION.id,
            fieldType: "Text",
            value,
          },
        ];
  });
}

function identityContact(item: OnePasswordItem): VaultContact | null {
  const read = (id: ContactFieldId): string | null => {
    const field = item.fields.find(
      (candidate) =>
        candidate.id === `satyr_${id}` &&
        candidate.sectionId === CONTACT_SECTION.id,
    );
    const value = field?.value.trim() ?? "";
    return value === "" ? null : value;
  };
  const line1 = read("address_line1");
  const city = read("city");
  const country = read("country");
  const contact = {
    fullName: read("full_name"),
    company: read("company"),
    email: read("email"),
    phone: read("phone"),
    address:
      line1 === null || city === null || country === null
        ? null
        : {
            line1,
            line2: read("address_line2"),
            city,
            region: read("region"),
            postalCode: read("postal_code"),
            country,
          },
    taxRegistrationNumber: read("tax_registration_number"),
  };
  return isVaultContact(contact) ? contact : null;
}

function failure(code: OnePasswordErrorCode): OnePasswordResponse {
  return { ok: false, code };
}

/** The SDK reports failures as errors with a name or a message. */
function errorCode(error: unknown): OnePasswordErrorCode {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (name === "RateLimitExceededError" || message.includes("rate limit"))
    return "onepassword_rate_limited";
  if (
    name === "AuthExpiredError" ||
    message.includes("service account token") ||
    message.includes("unauthorized") ||
    message.includes("authentication")
  )
    return "onepassword_auth_failed";
  if (message.includes("not found") || message.includes("itemnotfound"))
    return "onepassword_item_missing";
  return "onepassword_unavailable";
}

/** The request body, checked on the Worker side of the binding. */
export function parseOnePasswordRequest(
  raw: unknown,
): (OnePasswordOperation & Readonly<{ token: string }>) | null {
  if (!isRecord(raw) || typeof raw.token !== "string" || raw.token === "")
    return null;
  const token = raw.token;
  const id = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9a-z]{26}$/.test(value);
  switch (raw.op) {
    case "list_vaults":
      return { op: "list_vaults", token };
    case "list_items":
      return id(raw.vaultId)
        ? { op: "list_items", vaultId: raw.vaultId, token }
        : null;
    case "create_item": {
      const item = parseVaultItemCreate(raw.item);
      return id(raw.vaultId) && item !== null
        ? { op: "create_item", vaultId: raw.vaultId, item, token }
        : null;
    }
    case "update_item": {
      const change = parseChange(raw.change);
      return id(raw.vaultId) &&
        id(raw.itemId) &&
        typeof raw.expectedVersion === "number" &&
        change !== null
        ? {
            op: "update_item",
            vaultId: raw.vaultId,
            itemId: raw.itemId,
            expectedVersion: raw.expectedVersion,
            change,
            token,
          }
        : null;
    }
    case "archive_item":
    case "read_secret":
      return id(raw.vaultId) && id(raw.itemId)
        ? { op: raw.op, vaultId: raw.vaultId, itemId: raw.itemId, token }
        : null;
    default:
      return null;
  }
}

function parseChange(raw: unknown): OnePasswordItemChange | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "edit_login": {
      const draft = parseVaultItemCreate({
        kind: "website_login",
        label: raw.label,
        origins: raw.origins,
        username: "unused",
        password: "unused",
      });
      return draft?.kind === "website_login"
        ? { kind: "edit_login", label: draft.label, origins: draft.origins }
        : null;
    }
    case "replace_sign_in":
      return typeof raw.username === "string" &&
        raw.username !== "" &&
        typeof raw.password === "string" &&
        raw.password !== ""
        ? {
            kind: "replace_sign_in",
            username: raw.username,
            password: raw.password,
          }
        : null;
    case "edit_contact":
      return typeof raw.label === "string" &&
        raw.label !== "" &&
        isVaultContact(raw.contact)
        ? { kind: "edit_contact", label: raw.label, contact: raw.contact }
        : null;
    default:
      return null;
  }
}

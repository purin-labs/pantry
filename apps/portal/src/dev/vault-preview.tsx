import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "../styles.css";
import type {
  VaultEvent,
  VaultItemCommand,
  VaultItemCreate,
  VaultItemResult,
  VaultItemView,
  VaultStoreView,
} from "@purin-labs/control-api";

import { ControlApiError } from "../control-client";
import type { VaultTransport } from "../features/vault/api";
import type { VaultKeyView } from "../features/vault/keys";
import { VaultRoute } from "../features/vault/route";
import { PageHeader } from "../page-components";
import { workspacePageDescriptor } from "../route";
import { PortalFrame } from "../shell";

const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Vault preview is development-only.");

// ?scenario=populated|empty|viewer|failing|onepassword, ?theme=dark
// The token "ops_preview" connects; "ops_two" reaches two vaults.
const params = new URL(window.location.href).searchParams;
const scenario = params.get("scenario") ?? "populated";
if (params.get("theme") === "dark") {
  document.documentElement.dataset.portalMode = "dark";
  document.documentElement.dataset.portalTheme = "dark";
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 24, 9);

const SAMPLE: readonly VaultItemView[] = [
  {
    kind: "website_login",
    itemId: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
    store: "pantry",
    label: "Cotta wholesale",
    origins: ["https://business.cotta.jp"],
    username: "orders@nini.example",
    revision: 2,
    createdAt: NOW - 40 * DAY,
    updatedAt: NOW - 3 * DAY,
    passwordUpdatedAt: NOW - 3 * DAY,
  },
  {
    kind: "website_login",
    itemId: "1b2c3d4e5f60718293a4b5c6d7e8f90a",
    store: "pantry",
    label: "merchant.ubereats.com",
    origins: ["https://merchant.ubereats.com", "https://restaurant.uber.com"],
    username: "cafe@nini.example",
    revision: 1,
    createdAt: NOW - 12 * DAY,
    updatedAt: NOW - 12 * DAY,
    passwordUpdatedAt: NOW - 12 * DAY,
  },
  {
    kind: "contact_profile",
    itemId: "2c3d4e5f60718293a4b5c6d7e8f90a1b",
    store: "pantry",
    label: "Shop",
    contact: {
      fullName: "Alex Example",
      company: "Nini Pâtisserie",
      email: "shop@nini.example",
      phone: "+81 3-1234-5678",
      address: {
        line1: "1-2-3 Jingumae",
        line2: null,
        city: "Shibuya-ku",
        region: "Tokyo",
        postalCode: "150-0001",
        country: "JP",
      },
      taxRegistrationNumber: "T1234567890123",
    },
    revision: 1,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 30 * DAY,
  },
];

const SAMPLE_KEYS: readonly VaultKeyView[] = [
  {
    keyId: "inference:organisation_openai_api_key",
    name: "OpenAI API key",
    service: "AI account",
    kindLabel: "API key",
    status: "stored",
    changedAt: null,
    integrationId: "codex",
    accountId: null,
  },
  {
    keyId: "account:integration_account_stripe",
    name: "Nini Pâtisserie",
    service: "Stripe",
    kindLabel: "API key",
    status: "stored",
    changedAt: NOW - 9 * DAY,
    integrationId: "stripe",
    accountId: "integration_account_stripe",
  },
  {
    keyId: "account:integration_account_airtable",
    name: "Production base",
    service: "Airtable",
    kindLabel: "API key",
    status: "attention",
    changedAt: NOW - 60 * DAY,
    integrationId: "airtable",
    accountId: "integration_account_airtable",
  },
];

/** An in-memory Platform: revisions, generations and removal behave as the routes do. */
function previewTransport(): VaultTransport {
  let items: VaultItemView[] =
    scenario === "populated" ||
    scenario === "viewer" ||
    scenario === "onepassword"
      ? [...SAMPLE]
      : [];
  let store: VaultStoreView =
    scenario === "onepassword"
      ? {
          kind: "onepassword",
          vaultTitle: "Purin",
          connectedAt: NOW - 2 * DAY,
          reachable: true,
        }
      : { kind: "pantry" };
  const events: VaultEvent[] = [];
  const record = (
    kind: VaultEvent["kind"],
    item: VaultItemView | null,
    eventStore: VaultEvent["store"],
  ): void => {
    events.unshift({
      eventId: crypto.randomUUID().replaceAll("-", ""),
      kind,
      itemId: item?.itemId ?? null,
      itemLabel: item?.label ?? null,
      store: eventStore,
      at: Date.now(),
    });
  };
  const onePasswordId = (): string =>
    Array.from(crypto.getRandomValues(new Uint8Array(26)), (byte) =>
      "abcdefghijklmnopqrstuvwxyz234567".charAt(byte % 32),
    ).join("");
  const wait = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 350));
  const refuse = (code: string): never => {
    throw new ControlApiError("Refused", "unknown", { error: code });
  };
  return {
    async listKeys() {
      await wait();
      return scenario === "populated" ? SAMPLE_KEYS : [];
    },
    async list() {
      await wait();
      if (scenario === "failing") refuse("vault_unavailable");
      return { ok: true, store, items };
    },
    async store(_organisationId, command) {
      await wait();
      switch (command.kind) {
        case "connect_onepassword": {
          if (command.token !== "ops_preview" && command.token !== "ops_two")
            return refuse("vault_store_auth_failed");
          if (command.token === "ops_two" && command.vaultId === null)
            return {
              ok: true,
              kind: "choose_vault",
              vaults: [
                {
                  vaultId: "previewvaultpantry00000000",
                  title: "Purin",
                  itemCount: 0,
                },
                {
                  vaultId: "previewvaultprivate0000000",
                  title: "Private",
                  itemCount: 12,
                },
              ],
            };
          store = {
            kind: "onepassword",
            vaultTitle:
              command.vaultId === "previewvaultprivate0000000"
                ? "Private"
                : "Purin",
            connectedAt: Date.now(),
            reachable: true,
          };
          record("store_connected", null, "onepassword");
          return { ok: true, kind: "store", store };
        }
        case "disconnect_onepassword":
          items = items.filter((item) => item.store === "pantry");
          store = { kind: "pantry" };
          record("store_disconnected", null, "onepassword");
          return { ok: true, kind: "store", store };
        case "move_items": {
          const to = command.to;
          const from = to === "onepassword" ? "pantry" : "onepassword";
          let moved = 0;
          items = items.map((item) => {
            if (item.store !== from || moved >= 10) return item;
            moved += 1;
            const next = {
              ...item,
              store: to,
              itemId:
                to === "onepassword"
                  ? onePasswordId()
                  : crypto.randomUUID().replaceAll("-", ""),
            };
            record("item_moved", next, to);
            return next;
          });
          return {
            ok: true,
            kind: "moved",
            store,
            moved,
            remaining: items.filter((item) => item.store === from).length,
          };
        }
      }
    },
    async events(_organisationId, itemId) {
      await wait();
      return itemId === null
        ? events
        : events.filter((event) => event.itemId === itemId);
    },
    async create(_organisationId, create: VaultItemCreate) {
      await wait();
      const now = Date.now();
      const common = {
        itemId:
          store.kind === "onepassword"
            ? onePasswordId()
            : crypto.randomUUID().replaceAll("-", ""),
        store: store.kind,
        label: create.label,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const item: VaultItemView =
        create.kind === "website_login"
          ? {
              kind: "website_login",
              ...common,
              origins: create.origins,
              username: create.username,
              passwordUpdatedAt: now,
            }
          : { kind: "contact_profile", ...common, contact: create.contact };
      items = [...items, item];
      record("item_added", item, item.store);
      return { ok: true, item };
    },
    async command(_organisationId, itemId, command: VaultItemCommand) {
      await wait();
      const current = items.find((item) => item.itemId === itemId);
      if (current === undefined) return refuse("vault_item_not_found");
      if (current.revision !== command.expectedRevision)
        return refuse("vault_item_revision_conflict");
      if (command.kind === "remove") {
        items = items.filter((item) => item.itemId !== itemId);
        record("item_removed", current, current.store);
        return { ok: true, removed: itemId } satisfies VaultItemResult;
      }
      const now = Date.now();
      const next: VaultItemView =
        command.kind === "edit_contact" && current.kind === "contact_profile"
          ? { ...current, label: command.label, contact: command.contact }
          : command.kind === "edit_login" && current.kind === "website_login"
            ? { ...current, label: command.label, origins: command.origins }
            : command.kind === "replace_sign_in" &&
                current.kind === "website_login"
              ? {
                  ...current,
                  username: command.username,
                  passwordUpdatedAt: now,
                }
              : refuse("vault_item_invalid");
      const updated = {
        ...next,
        revision: current.revision + 1,
        updatedAt: now,
      };
      items = items.map((item) => (item.itemId === itemId ? updated : item));
      record(
        command.kind === "replace_sign_in" ? "sign_in_replaced" : "item_edited",
        updated,
        updated.store,
      );
      return { ok: true, item: updated };
    },
  };
}

const TRANSPORT = previewTransport();
const descriptor = workspacePageDescriptor("vault");

createRoot(root).render(
  <BrowserRouter>
    <PortalFrame
      identity={{
        kind: "ready",
        displayName: "Preview",
        logout: async () => {},
      }}
      organisation={{
        organisationHandle: "preview",
        name: "Preview organisation",
        choices: [],
      }}
      workspace={{
        organisationHandle: "preview",
        workspaceHandle: "cafe",
        name: "Cafe operations",
        choices: [],
      }}
      chat={null}
      sidebar={{
        activePage: "vault",
        chatOpen: false,
        footer: null,
        attention: {},
      }}
    >
      <PageHeader
        title={descriptor.title}
        description={descriptor.description}
      />
      <VaultRoute
        organisationId="organisation_preview"
        canManage={scenario !== "viewer"}
        integrationsHref="/integrations-preview.html"
        transport={TRANSPORT}
      />
    </PortalFrame>
  </BrowserRouter>,
);

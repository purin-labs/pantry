import { WorkerEntrypoint } from "cloudflare:workers";
import {
  handleOnePasswordOperation,
  parseOnePasswordRequest,
  type OnePasswordClient,
  type OnePasswordItem,
  type OnePasswordItemCreate,
} from "../../src/vault-onepassword/handler";

/**
 * 1Password as the store Worker reaches it in the E2E runtime (Plan 79).
 * The E2E runtime cannot run the SDK against 1Password, so this entrypoint
 * runs the store Worker's own handler with an in-memory client: the fake
 * only keeps items and answers calls, and the handler's mapping is the code
 * under test. `/__e2e/*` paths let a journey add an item as a person would
 * in the 1Password app, and read what 1Password holds.
 */
export const E2E_ONEPASSWORD_TOKEN = "ops_e2e_service_account_token";
export const E2E_ONEPASSWORD_VAULTS = [
  { id: "e2evaultsatyr0000000000000", title: "Satyr" },
  { id: "e2evaultprivate00000000000", title: "Private" },
] as const;

type StoredItem = { item: OnePasswordItem; archived: boolean };
const items = new Map<string, StoredItem>();
const tokens: string[] = [];
/** A list call that waits until the journey releases it. */
let listHold: {
  started: boolean;
  gate: Promise<void>;
  release: () => void;
} | null = null;

export class OnePasswordNetwork extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__e2e/reset") {
      items.clear();
      tokens.length = 0;
      listHold?.release();
      listHold = null;
      return Response.json({ ok: true });
    }
    if (path === "/__e2e/state")
      return Response.json({
        items: [...items.values()],
        tokens,
        listHeld: listHold?.started ?? false,
      });
    if (path === "/__e2e/hold-list") {
      const { promise, resolve } = Promise.withResolvers<void>();
      listHold = { started: false, gate: promise, release: resolve };
      return Response.json({ ok: true });
    }
    if (path === "/__e2e/release-list") {
      listHold?.release();
      return Response.json({ ok: true });
    }
    if (path === "/__e2e/add") {
      const created = createItem(
        (await request.json()) as OnePasswordItemCreate,
      );
      return Response.json(created);
    }
    const operation = parseOnePasswordRequest(await request.json());
    if (operation === null)
      return Response.json({ ok: false, code: "onepassword_request_invalid" });
    tokens.push(operation.token);
    if (operation.token !== E2E_ONEPASSWORD_TOKEN)
      return Response.json({ ok: false, code: "onepassword_auth_failed" });
    return Response.json(await handleOnePasswordOperation(operation, CLIENT));
  }
}

const CLIENT: OnePasswordClient = {
  vaults: {
    list: async () =>
      E2E_ONEPASSWORD_VAULTS.map((vault) => ({
        ...vault,
        activeItemCount: [...items.values()].filter(
          (stored) => stored.item.vaultId === vault.id && !stored.archived,
        ).length,
      })),
  },
  items: {
    list: async (vaultId) => {
      const hold = listHold;
      if (hold !== null) {
        hold.started = true;
        await hold.gate;
        listHold = null;
      }
      return [...items.values()]
        .filter((stored) => stored.item.vaultId === vaultId && !stored.archived)
        .map((stored) => ({
          id: stored.item.id,
          title: stored.item.title,
          category: stored.item.category,
          vaultId: stored.item.vaultId,
          state: "active",
        }));
    },
    get: async (vaultId, itemId) => {
      const stored = items.get(itemId);
      if (stored === undefined || stored.item.vaultId !== vaultId)
        throw new Error("item not found");
      return stored.item;
    },
    create: async (params) => createItem(params),
    put: async (item) => {
      const stored = items.get(item.id);
      if (stored === undefined) throw new Error("item not found");
      if (stored.item.version !== item.version)
        throw new Error("item version conflict");
      const updated = {
        ...item,
        version: item.version + 1,
        updatedAt: new Date(),
      };
      items.set(item.id, { item: updated, archived: stored.archived });
      return updated;
    },
    archive: async (_vaultId, itemId) => {
      const stored = items.get(itemId);
      if (stored === undefined) throw new Error("item not found");
      stored.archived = true;
    },
  },
};

function createItem(params: OnePasswordItemCreate): OnePasswordItem {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(26)), (byte) =>
    "abcdefghijklmnopqrstuvwxyz234567".charAt(byte % 32),
  ).join("");
  const now = new Date();
  const item: OnePasswordItem = {
    id,
    title: params.title,
    category: params.category,
    vaultId: params.vaultId,
    fields: params.fields,
    sections: params.sections,
    notes: "",
    tags: params.tags,
    websites: params.websites,
    version: 1,
    files: [],
    createdAt: now,
    updatedAt: now,
  };
  items.set(id, { item, archived: false });
  return item;
}

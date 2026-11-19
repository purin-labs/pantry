// The Worker cannot compile Wasm from bytes, so it imports the SDK core as a
// module and hands it to the loader that `vault-onepassword:prepare` writes
// (scripts/vault-onepassword-worker.mjs). Keep this import first: the loader
// reads the module when the SDK is first imported.
import sdkCore from "../../.generated/vault-onepassword/core_bg.wasm";

import type * as sdkTypes from "@1password/sdk";
import { sha256Hex } from "@seams/std";
import {
  handleOnePasswordOperation,
  parseOnePasswordRequest,
  type OnePasswordClient,
} from "./handler";

/**
 * The 1Password store Worker (Plan 79). The Platform posts one operation
 * with the Organisation's service account token; this Worker runs it with
 * the 1Password SDK and answers with item views. It keeps no state except
 * signed-in SDK clients in memory, keyed by a hash of the token, and it never
 * logs a request, a token or an item.
 *
 * Placement applies to the fetch handler only, so the Platform calls this
 * handler through its service binding VAULT_ONEPASSWORD.
 */
export default {
  fetch: handleRequest,
} satisfies ExportedHandler<VaultOnePasswordEnv>;

type VaultOnePasswordEnv = { readonly PANTRY_DEPLOYMENT_PROFILE: string };

Reflect.set(globalThis, "__opSdkWasm", sdkCore);

/** A sign-in costs several 1Password requests; reuse it while it is fresh. */
const CLIENT_LIFETIME_MS = 10 * 60_000;
const clients = new Map<
  string,
  Readonly<{ client: Promise<OnePasswordClient>; expiresAt: number }>
>();

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== "POST")
    return Response.json(
      { ok: false, code: "onepassword_request_invalid" },
      { status: 405 },
    );
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const operation = parseOnePasswordRequest(body);
  if (operation === null)
    return Response.json({ ok: false, code: "onepassword_request_invalid" });
  let client: OnePasswordClient;
  try {
    client = await signedInClient(operation.token);
  } catch {
    return Response.json({ ok: false, code: "onepassword_auth_failed" });
  }
  return Response.json(await handleOnePasswordOperation(operation, client));
}

async function signedInClient(token: string): Promise<OnePasswordClient> {
  const key = await sha256Hex(token);
  const now = Date.now();
  const cached = clients.get(key);
  if (cached !== undefined && cached.expiresAt > now) return cached.client;
  const client = createClient(token);
  clients.set(key, { client, expiresAt: now + CLIENT_LIFETIME_MS });
  client.catch(() => clients.delete(key));
  return client;
}

async function createClient(token: string): Promise<OnePasswordClient> {
  const sdk = await import("@1password/sdk");
  const client = await sdk.createClient({
    auth: token,
    integrationName: "Seams Vault",
    integrationVersion: "1",
  });
  // The SDK's enums are strings with the same values as the store's.
  return {
    vaults: { list: () => client.vaults.list() },
    items: {
      list: (vaultId) =>
        client.items.list(vaultId, {
          type: "ByState",
          content: { active: true, archived: false },
        }),
      get: (vaultId, itemId) => client.items.get(vaultId, itemId),
      create: (params) =>
        client.items.create(params as unknown as sdkTypes.ItemCreateParams),
      put: (item) => client.items.put(item as unknown as sdkTypes.Item),
      archive: (vaultId, itemId) => client.items.archive(vaultId, itemId),
    },
  };
}

import { env } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import {
  parseVaultEventList,
  parseVaultItemList,
  parseVaultItemResult,
  parseVaultStoreResult,
  type VaultItemView,
} from "@seams/control-api";

import { parseVaultHandle } from "../../src/credential-vault/domain";
import { resolveVaultHandle } from "../../src/credential-vault/service";
import type { OrganisationId } from "../../src/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { installMemoryFixture, post, type Member } from "./memory-support";
import {
  E2E_ONEPASSWORD_TOKEN,
  E2E_ONEPASSWORD_VAULTS,
} from "./onepassword-network";

const SATYR_PASSWORD = "satyr-held-pass-4K";
const APP_PASSWORD = "added-in-1password-8M";
const NEW_PASSWORD = "created-through-satyr-2P";
const [SATYR_VAULT, PRIVATE_VAULT] = E2E_ONEPASSWORD_VAULTS;

it(
  "keeps the Vault interchangeable with a connected 1Password vault, through a move there, edits, a move back and a disconnect",
  { timeout: 120_000 },
  vaultOnePasswordJourney,
);

async function vaultOnePasswordJourney({ task }: TestContext): Promise<void> {
  const {
    organisationId,
    author: owner,
    viewer,
  } = await installMemoryFixture();
  await onePassword("/__e2e/reset");
  const base = `/v1/control/organisations/${organisationId}/vault`;
  const seen: string[] = [];
  const send = async (
    user: Member,
    path: string,
    body: unknown,
  ): Promise<Readonly<{ status: number; body: unknown }>> => {
    const response = await post(user, path, body);
    const text = await response.text();
    seen.push(text);
    return { status: response.status, body: JSON.parse(text) };
  };
  const list = async () => {
    const listed = parseVaultItemList(
      (await send(owner, `${base}/items`, null)).body,
    );
    if (listed === null) throw new Error("Vault list invalid");
    return listed;
  };

  // Before 1Password, the owner keeps a supplier login and the shop's
  // contact details in Pantry.
  const pantryLogin = item(
    (
      await send(owner, `${base}/items`, {
        kind: "website_login",
        label: "Supplier portal",
        origins: ["https://supplier.example.jp"],
        username: "buyer@nini.example",
        password: SATYR_PASSWORD,
      })
    ).body,
  );
  const contact = {
    fullName: "Alex Example",
    company: "Nini Pâtisserie",
    email: "shop@nini.example",
    phone: null,
    address: {
      line1: "1-2-3 Jingumae",
      line2: null,
      city: "Shibuya-ku",
      region: "Tokyo",
      postalCode: "150-0001",
      country: "JP",
    },
    taxRegistrationNumber: "T1234567890123",
  };
  item(
    (
      await send(owner, `${base}/items`, {
        kind: "contact_profile",
        label: "Shop",
        contact,
      })
    ).body,
  );

  // Only an owner or admin connects 1Password, and a token that 1Password
  // refuses stores nothing.
  expect(
    (
      await send(viewer, `${base}/store`, {
        kind: "connect_onepassword",
        token: E2E_ONEPASSWORD_TOKEN,
        vaultId: null,
      })
    ).status,
  ).toBe(404);
  expect(
    await send(owner, `${base}/store`, {
      kind: "connect_onepassword",
      token: "ops_wrong_token",
      vaultId: null,
    }),
  ).toMatchObject({ status: 409, body: { error: "vault_store_auth_failed" } });
  expect((await list()).store).toEqual({ kind: "satyr" });

  // The token reaches two vaults, so the owner chooses one; only then does
  // Pantry keep the token, encrypted.
  const choose = parseVaultStoreResult(
    (
      await send(owner, `${base}/store`, {
        kind: "connect_onepassword",
        token: E2E_ONEPASSWORD_TOKEN,
        vaultId: null,
      })
    ).body,
  );
  expect(choose).toMatchObject({
    kind: "choose_vault",
    vaults: [
      { vaultId: SATYR_VAULT.id, title: "Satyr" },
      { vaultId: PRIVATE_VAULT.id, title: "Private" },
    ],
  });
  expect(await storeRow(organisationId)).toBeNull();
  const connected = await send(owner, `${base}/store`, {
    kind: "connect_onepassword",
    token: E2E_ONEPASSWORD_TOKEN,
    vaultId: SATYR_VAULT.id,
  });
  expect(connected).toMatchObject({
    status: 200,
    body: {
      kind: "store",
      store: { kind: "onepassword", vaultTitle: "Satyr", reachable: true },
    },
  });
  const tokenHandle = (await storeRow(organisationId))?.token_handle ?? "";

  // A member's status read, as the Integrations card makes on each visit,
  // answers from Pantry alone: it makes no 1Password call.
  const callsBefore = (await onePasswordState()).tokens.length;
  expect(await send(viewer, `${base}/store`, null)).toEqual({
    status: 200,
    body: {
      ok: true,
      store: {
        kind: "onepassword",
        vaultTitle: "Satyr",
        connectedAt: expect.any(Number),
      },
    },
  });
  expect((await onePasswordState()).tokens.length).toBe(callsBefore);
  expect(await resolved(organisationId, tokenHandle)).toEqual({
    kind: "bearer",
    value: E2E_ONEPASSWORD_TOKEN,
  });

  // Someone adds a login in the 1Password app; the Vault lists it with the
  // Pantry items.
  await onePassword("/__e2e/add", {
    category: "Login",
    vaultId: SATYR_VAULT.id,
    title: "Wholesale flour",
    fields: [
      {
        id: "username",
        title: "username",
        fieldType: "Text",
        value: "orders@nini.example",
      },
      {
        id: "password",
        title: "password",
        fieldType: "Concealed",
        value: APP_PASSWORD,
      },
    ],
    sections: [],
    websites: [
      {
        url: "https://flour.example.jp/login",
        label: "website",
        autofillBehavior: "AnywhereOnWebsite",
      },
    ],
    tags: [],
  });
  const mixed = await list();
  expect(mixed.items.map((entry) => [entry.label, entry.store])).toEqual([
    ["Wholesale flour", "onepassword"],
    ["Supplier portal", "satyr"],
    ["Shop", "satyr"],
  ]);
  expect(mixed.items[0]).toMatchObject({
    origins: ["https://flour.example.jp"],
    username: "orders@nini.example",
  });

  // A new login now goes to 1Password, not to Pantry.
  const created = item(
    (
      await send(owner, `${base}/items`, {
        kind: "website_login",
        label: "Packaging supplier",
        origins: ["https://boxes.example.jp"],
        username: "boxes@nini.example",
        password: NEW_PASSWORD,
      })
    ).body,
  );
  expect(created.store).toBe("onepassword");
  expect(await onePasswordLogin(created.itemId)).toEqual({
    username: "boxes@nini.example",
    password: NEW_PASSWORD,
    websites: ["https://boxes.example.jp"],
    archived: false,
  });
  expect(await pantryItemCount(organisationId)).toBe(2);

  // The owner moves the Pantry items to 1Password. Each copy lands there, and
  // the Pantry sign-in stops working.
  const pantryHandle = await loginHandle(organisationId, pantryLogin.itemId);
  const moved = parseVaultStoreResult(
    (
      await send(owner, `${base}/store`, {
        kind: "move_items",
        to: "onepassword",
      })
    ).body,
  );
  expect(moved).toMatchObject({ kind: "moved", moved: 2, remaining: 0 });
  expect(await resolved(organisationId, pantryHandle)).toEqual({
    error: "vault_secret_revoked",
  });
  const afterMove = await list();
  expect(afterMove.items.every((entry) => entry.store === "onepassword")).toBe(
    true,
  );
  const movedLogin = afterMove.items.find(
    (entry) => entry.label === "Supplier portal",
  );
  const movedContact = afterMove.items.find((entry) => entry.label === "Shop");
  expect(await onePasswordLogin(movedLogin?.itemId ?? "")).toMatchObject({
    username: "buyer@nini.example",
    password: SATYR_PASSWORD,
    websites: ["https://supplier.example.jp"],
  });
  expect(movedContact).toMatchObject({ kind: "contact_profile", contact });

  // An edit on an old version is refused; one on the current version lands
  // in 1Password.
  const flour = afterMove.items.find(
    (entry) => entry.label === "Wholesale flour",
  );
  if (flour === undefined) throw new Error("1Password login missing");
  const commands = `${base}/items/${flour.itemId}/commands`;
  expect(
    await send(owner, commands, {
      kind: "edit_login",
      expectedRevision: flour.revision + 1,
      label: "Old name",
      origins: ["https://flour.example.jp"],
    }),
  ).toMatchObject({
    status: 409,
    body: { error: "vault_item_revision_conflict" },
  });
  expect(
    item(
      (
        await send(owner, commands, {
          kind: "edit_login",
          expectedRevision: flour.revision,
          label: "Flour mill",
          origins: ["https://flour.example.jp"],
        })
      ).body,
    ),
  ).toMatchObject({ label: "Flour mill", store: "onepassword" });

  // Removing a 1Password item archives it there, where people can restore it.
  expect(
    await send(owner, `${base}/items/${created.itemId}/commands`, {
      kind: "remove",
      expectedRevision: created.revision,
    }),
  ).toMatchObject({ status: 200, body: { removed: created.itemId } });
  expect(await onePasswordLogin(created.itemId)).toMatchObject({
    archived: true,
  });

  // The owner moves everything back. The sign-ins resolve in Pantry again, and
  // the 1Password copies are archived, not deleted.
  expect(
    parseVaultStoreResult(
      (await send(owner, `${base}/store`, { kind: "move_items", to: "satyr" }))
        .body,
    ),
  ).toMatchObject({ kind: "moved", moved: 3, remaining: 0 });
  const back = await list();
  expect(back.items.map((entry) => [entry.label, entry.store])).toEqual([
    ["Flour mill", "satyr"],
    ["Supplier portal", "satyr"],
    ["Shop", "satyr"],
  ]);
  const flourBack = back.items.find((entry) => entry.label === "Flour mill");
  expect(
    await resolved(
      organisationId,
      await loginHandle(organisationId, flourBack?.itemId ?? ""),
    ),
  ).toEqual({
    kind: "website_login",
    username: "orders@nini.example",
    password: APP_PASSWORD,
  });
  expect(back.items.find((entry) => entry.label === "Shop")).toMatchObject({
    contact,
  });
  expect(
    (await onePasswordState()).items.every((stored) => stored.archived),
  ).toBe(true);

  // Disconnecting keeps the 1Password items in 1Password and stops the token.
  expect(
    await send(owner, `${base}/store`, { kind: "disconnect_onepassword" }),
  ).toMatchObject({ status: 200, body: { store: { kind: "satyr" } } });
  expect(await resolved(organisationId, tokenHandle)).toEqual({
    error: "vault_secret_revoked",
  });
  expect((await onePasswordState()).items).toHaveLength(4);
  expect((await list()).store).toEqual({ kind: "satyr" });

  // The audit log tells the story, and a member can read it.
  const events = parseVaultEventList(
    (await send(viewer, `${base}/events`, null)).body,
  );
  expect(events?.map((event) => event.kind).reverse()).toEqual([
    "item_added",
    "item_added",
    "store_connected",
    "item_added",
    "item_moved",
    "item_moved",
    "item_edited",
    "item_removed",
    "item_moved",
    "item_moved",
    "item_moved",
    "store_disconnected",
  ]);

  // No response of the journey carried a password or the token.
  const everything = seen.join("\n");
  for (const secret of [
    SATYR_PASSWORD,
    APP_PASSWORD,
    NEW_PASSWORD,
    E2E_ONEPASSWORD_TOKEN,
  ])
    expect(everything).not.toContain(secret);

  Object.assign(task.meta, {
    vaultOnePassword: {
      accountWorkerSha256: env.TEST_ACCOUNT_PLATFORM_WORKER_SHA256,
      responses: seen.length,
      onePasswordCalls: (await onePasswordState()).tokens.length,
      checks: [
        "member cannot connect; refused token stores nothing",
        "token reaching two vaults asks to choose; token stored encrypted",
        "status read makes no 1Password call",
        "item added in the 1Password app is listed",
        "new items go to the connected store",
        "move to 1Password copies items and revokes Satyr sign-ins",
        "stale 1Password edit refused; current edit lands",
        "removal archives in 1Password",
        "move back restores sign-ins in Satyr and archives copies",
        "disconnect keeps 1Password items and revokes the token",
        "audit log records every step",
        "no response carried a password or the token",
      ],
    },
  });
}

function item(body: unknown): VaultItemView {
  const result = parseVaultItemResult(body);
  if (result === null || !("item" in result))
    throw new Error(`not a Vault item: ${JSON.stringify(body)}`);
  return result.item;
}

async function onePassword(path: string, body?: unknown): Promise<unknown> {
  const response = await env.VAULT_ONEPASSWORD.fetch(
    `https://vault-onepassword.internal${path}`,
    { method: "POST", body: JSON.stringify(body ?? {}) },
  );
  return response.json();
}

type FakeState = {
  items: {
    item: {
      id: string;
      fields: { id: string; value: string }[];
      websites: { url: string }[];
    };
    archived: boolean;
  }[];
  tokens: string[];
};

async function onePasswordState(): Promise<FakeState> {
  return (await onePassword("/__e2e/state")) as FakeState;
}

async function onePasswordLogin(itemId: string) {
  const stored = (await onePasswordState()).items.find(
    (entry) => entry.item.id === itemId,
  );
  if (stored === undefined) return null;
  const field = (id: string) =>
    stored.item.fields.find((candidate) => candidate.id === id)?.value;
  return {
    username: field("username"),
    password: field("password"),
    websites: stored.item.websites.map((website) => website.url),
    archived: stored.archived,
  };
}

async function storeRow(organisationId: OrganisationId) {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  return scope.database
    .prepare("SELECT token_handle FROM vault_store WHERE organisation_id = ?")
    .bind(organisationId)
    .first<{ token_handle: string }>();
}

async function pantryItemCount(organisationId: OrganisationId): Promise<number> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const row = await scope.database
    .prepare(
      "SELECT COUNT(*) AS count FROM vault_item WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function loginHandle(
  organisationId: OrganisationId,
  itemId: string,
): Promise<string> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const row = await scope.database
    .prepare(
      "SELECT vault_handle FROM vault_item WHERE organisation_id = ? AND vault_item_id = ?",
    )
    .bind(organisationId, itemId)
    .first<{ vault_handle: string }>();
  if (row === null) throw new Error("Satyr login missing");
  return row.vault_handle;
}

async function resolved(
  organisationId: OrganisationId,
  rawHandle: string,
): Promise<unknown> {
  const handle = parseVaultHandle(rawHandle);
  if (!handle.ok) throw new Error("handle invalid");
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const secret = await resolveVaultHandle({
    db: scope.database,
    keys: env,
    organisationId,
    handle: handle.value,
  });
  return secret.ok ? secret.value : { error: secret.error.code };
}

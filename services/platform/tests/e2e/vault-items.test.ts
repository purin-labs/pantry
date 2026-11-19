import { env } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { parseVaultItemList } from "@purin-labs/control-api";

import type { OrganisationId } from "../../src/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { installMemoryFixture, post, type Member } from "./memory-support";
import { item, loginHandle, resolvedSecret } from "./vault-support";

const FIRST_PASSWORD = "first-supplier-pass-7Q";
const SECOND_PASSWORD = "second-supplier-pass-9Z";

it(
  "keeps a saved login usable only through the vault, across a concurrent edit, a new sign-in and removal",
  { timeout: 120_000 },
  vaultItemJourney,
);

async function vaultItemJourney({ task }: TestContext): Promise<void> {
  // The owner and a second administrator manage the Vault. A member without a
  // management role reads it. An administrator whom the account authority
  // does not admit gets nothing.
  const {
    organisationId,
    author: owner,
    reviewer: admin,
    viewer,
    outsider,
  } = await installMemoryFixture();
  const items = `/v1/control/organisations/${organisationId}/vault/items`;
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

  // A site that is not https is refused before anything is stored.
  expect(
    await send(owner, items, {
      kind: "website_login",
      label: "Supplier",
      origins: ["http://supplier.example.jp"],
      username: "buyer@nini.example",
      password: FIRST_PASSWORD,
    }),
  ).toMatchObject({ status: 422, body: { error: "vault_item_invalid" } });

  // The owner saves the supplier login and the shop's contact details.
  const created = await send(owner, items, {
    kind: "website_login",
    label: "Supplier portal",
    origins: ["https://supplier.example.jp"],
    username: "buyer@nini.example",
    password: FIRST_PASSWORD,
  });
  expect(created.status).toBe(200);
  const login = item(created.body);
  expect(login).toMatchObject({
    kind: "website_login",
    origins: ["https://supplier.example.jp"],
    username: "buyer@nini.example",
    revision: 1,
  });
  const contact = await send(owner, items, {
    kind: "contact_profile",
    label: "Shop",
    contact: {
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
    },
  });
  expect(contact.status).toBe(200);

  // The vault holds the sign-in encrypted, ready for a fill.
  const firstHandle = await loginHandle(organisationId, login.itemId);
  expect(await storedCiphertextContains(organisationId, FIRST_PASSWORD)).toBe(
    false,
  );
  expect(await resolvedSecret(organisationId, firstHandle)).toEqual({
    kind: "website_login",
    username: "buyer@nini.example",
    password: FIRST_PASSWORD,
  });

  // A member reads both items, logins first. A member cannot add one (the
  // refusal does not reveal the Organisation), and a person outside the
  // account authority cannot read the Vault.
  const listed = await send(viewer, items, null);
  expect(listed.status).toBe(200);
  expect(
    parseVaultItemList(listed.body)?.items.map((entry) => entry.label),
  ).toEqual(["Supplier portal", "Shop"]);
  expect(
    (
      await send(viewer, items, {
        kind: "contact_profile",
        label: "Mine",
        contact: {
          fullName: "Viewer",
          company: null,
          email: null,
          phone: null,
          address: null,
          taxRegistrationNumber: null,
        },
      })
    ).status,
  ).toBe(404);
  expect((await send(outsider, items, null)).status).toBe(404);
  expect(
    parseVaultItemList((await send(owner, items, null)).body)?.items,
  ).toHaveLength(2);

  // The owner and the admin edit the same login at the same time. The second
  // change, made against the old revision, is refused and changes nothing.
  const commands = `${items}/${login.itemId}/commands`;
  const ownerEdit = await send(owner, commands, {
    kind: "edit_login",
    expectedRevision: 1,
    label: "Supplier portal",
    origins: [
      "https://supplier.example.jp",
      "https://order.supplier.example.jp",
    ],
  });
  expect(ownerEdit.status).toBe(200);
  expect(
    await send(admin, commands, {
      kind: "edit_login",
      expectedRevision: 1,
      label: "Old supplier",
      origins: ["https://old.example.jp"],
    }),
  ).toMatchObject({
    status: 409,
    body: { error: "vault_item_revision_conflict" },
  });

  // The admin then replaces the sign-in on the current revision. The new
  // generation resolves, and the first one stops working.
  const replaced = await send(admin, commands, {
    kind: "replace_sign_in",
    expectedRevision: 2,
    username: "orders@nini.example",
    password: SECOND_PASSWORD,
  });
  expect(replaced.status).toBe(200);
  expect(item(replaced.body)).toMatchObject({
    label: "Supplier portal",
    origins: [
      "https://supplier.example.jp",
      "https://order.supplier.example.jp",
    ],
    username: "orders@nini.example",
    revision: 3,
  });
  const secondHandle = await loginHandle(organisationId, login.itemId);
  expect(secondHandle).not.toBe(firstHandle);
  expect(await resolvedSecret(organisationId, secondHandle)).toEqual({
    kind: "website_login",
    username: "orders@nini.example",
    password: SECOND_PASSWORD,
  });
  expect(await resolvedSecret(organisationId, firstHandle)).toEqual({
    error: "vault_secret_revoked",
  });

  // Removal on a stale revision is refused; on the current one, the login
  // leaves the Vault and its sign-in stops working.
  expect(
    (await send(owner, commands, { kind: "remove", expectedRevision: 2 }))
      .status,
  ).toBe(409);
  expect(
    await send(owner, commands, { kind: "remove", expectedRevision: 3 }),
  ).toMatchObject({ status: 200, body: { ok: true, removed: login.itemId } });
  expect(await resolvedSecret(organisationId, secondHandle)).toEqual({
    error: "vault_secret_revoked",
  });
  const after = parseVaultItemList((await send(owner, items, null)).body);
  expect(after?.items.map((entry) => entry.kind)).toEqual(["contact_profile"]);
  expect(
    (await send(owner, commands, { kind: "remove", expectedRevision: 3 }))
      .status,
  ).toBe(404);

  // No response of the whole journey carried a password.
  const everything = seen.join("\n");
  expect(everything).not.toContain(FIRST_PASSWORD);
  expect(everything).not.toContain(SECOND_PASSWORD);

  Object.assign(task.meta, {
    vaultItems: {
      accountWorkerSha256: env.TEST_ACCOUNT_PLATFORM_WORKER_SHA256,
      responses: seen.length,
      checks: [
        "http origin refused before storage",
        "login stored encrypted and resolves for a fill",
        "member reads, cannot add; outsider refused",
        "stale concurrent edit refused",
        "new sign-in revokes the old generation",
        "removal revokes the sign-in and deletes the item",
        "no response carried a password",
      ],
    },
  });
}

async function storedCiphertextContains(
  organisationId: OrganisationId,
  text: string,
): Promise<boolean> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const rows = await scope.database
    .prepare(
      "SELECT nonce_b64, ciphertext_b64 FROM vault_secret WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .all<{ nonce_b64: string; ciphertext_b64: string }>();
  const encoded = btoa(text);
  return rows.results.some(
    (row) =>
      row.ciphertext_b64.includes(encoded) ||
      atob(row.ciphertext_b64).includes(text),
  );
}

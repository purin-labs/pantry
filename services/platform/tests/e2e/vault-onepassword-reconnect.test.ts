import { expect, it } from "vitest";
import { parseVaultItemList } from "@seams/control-api";

import { installMemoryFixture, post } from "./memory-support";
import {
  E2E_ONEPASSWORD_TOKEN,
  E2E_ONEPASSWORD_VAULTS,
} from "./onepassword-network";
import { onePassword } from "./vault-support";

const [SATYR_VAULT, PRIVATE_VAULT] = E2E_ONEPASSWORD_VAULTS;

it(
  "lists the items of the vault that the owner connects, when a list of the old vault ends after the connect",
  { timeout: 60_000 },
  vaultReconnectJourney,
);

/**
 * Refactor 11 part 2. The 1Password item list is kept for 30 seconds for each
 * Organisation. A list that was in flight when the owner connected another
 * vault ended after the connect had cleared the kept list, so it kept the old
 * vault's items, and the next list showed them under the new vault's title.
 */
async function vaultReconnectJourney(): Promise<void> {
  const { organisationId, author: owner } = await installMemoryFixture();
  await onePassword("/__e2e/reset");
  const base = `/v1/control/organisations/${organisationId}/vault`;
  const list = async () => {
    const response = await post(owner, `${base}/items`, null);
    const listed = parseVaultItemList(await response.json());
    if (listed === null) throw new Error("Vault list invalid");
    return listed;
  };
  const connect = async (vaultId: string) => {
    const response = await post(owner, `${base}/store`, {
      kind: "connect_onepassword",
      token: E2E_ONEPASSWORD_TOKEN,
      vaultId,
    });
    expect(response.status).toBe(200);
  };
  await addLogin(SATYR_VAULT.id, "Shared flour order");
  await addLogin(PRIVATE_VAULT.id, "Owner's own bank");

  await connect(SATYR_VAULT.id);
  // The owner opens the Vault page, and 1Password is slow to answer.
  await onePassword("/__e2e/hold-list");
  const slowList = list();
  await expect
    .poll(async () => (await onePasswordState()).listHeld, { timeout: 10_000 })
    .toBe(true);
  // In another tab, the owner connects the private vault instead.
  await connect(PRIVATE_VAULT.id);
  await onePassword("/__e2e/release-list");
  const old = await slowList;
  expect(old.items.map((item) => item.label)).toContain("Shared flour order");

  const current = await list();
  expect(current.store).toMatchObject({
    kind: "onepassword",
    vaultTitle: "Private",
  });
  const labels = current.items.map((item) => item.label);
  expect(labels).toContain("Owner's own bank");
  expect(labels).not.toContain("Shared flour order");
}

async function addLogin(vaultId: string, title: string): Promise<void> {
  await onePassword("/__e2e/add", {
    category: "Login",
    vaultId,
    title,
    fields: [
      {
        id: "username",
        title: "username",
        fieldType: "Text",
        value: "owner@nini.example",
      },
    ],
    sections: [],
    websites: [],
    tags: [],
  });
}

async function onePasswordState(): Promise<{ listHeld: boolean }> {
  return (await onePassword("/__e2e/state")) as { listHeld: boolean };
}

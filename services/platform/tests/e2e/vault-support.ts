// Reads that the Vault journeys share: an item of a Vault answer, the fake
// 1Password service, and a login's handle and the secret it resolves to.
import { env } from "cloudflare:workers";
import { parseVaultItemResult, type VaultItemView } from "@purin-labs/control-api";
import { parseVaultHandle } from "../../src/credential-vault/domain";
import { resolveVaultHandle } from "../../src/credential-vault/service";
import type { OrganisationId } from "../../src/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";

/** The item of a Vault answer. Any other answer fails the read. */
export function item(body: unknown): VaultItemView {
  const result = parseVaultItemResult(body);
  if (result === null || !("item" in result))
    throw new Error(`not a Vault item: ${JSON.stringify(body)}`);
  return result.item;
}

/** One call of the fake 1Password service. */
export async function onePassword(
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await env.VAULT_ONEPASSWORD.fetch(
    `https://vault-onepassword.internal${path}`,
    { method: "POST", body: JSON.stringify(body ?? {}) },
  );
  return response.json();
}

/** The Vault handle of one login item. */
export async function loginHandle(
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
  if (row === null) throw new Error("login missing");
  return row.vault_handle;
}

/** The secret that a Vault handle resolves to, or the code of the refusal. */
export async function resolvedSecret(
  organisationId: OrganisationId,
  rawHandle: string,
): Promise<unknown> {
  const handle = parseVaultHandle(rawHandle);
  if (!handle.ok) throw new Error("handle invalid");
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const resolved = await resolveVaultHandle({
    db: scope.database,
    keys: env,
    organisationId,
    handle: handle.value,
  });
  return resolved.ok ? resolved.value : { error: resolved.error.code };
}

import type { AccountPlatformBindings } from "./config";
import {
  createAccountPlatformClient,
  type AccountPlatformClient,
} from "./client";
import {
  accountObject,
  accountText,
  accountUnavailable,
  parseAccountScope,
  sameAccountScope,
  type AccountPlatformError,
  type PantryAccountBinding,
} from "./types";
import type { Result } from "../result";

/** The immutable native binding, as this deployment stored it. */
type NativePantryAccountBinding = Omit<PantryAccountBinding, "feePolicy">;

/** Resolve the immutable native binding, then obtain the current explicit fee policy. */
export async function resolvePantryAccountBinding(
  env: AccountPlatformBindings,
  organisationId: string,
): Promise<Result<PantryAccountBinding, AccountPlatformError>> {
  const client = createAccountPlatformClient(env);
  if (!client.ok) return client;
  const native = await readNativePantryAccountBinding(env, organisationId);
  if (!native.ok) return native;
  return confirmPantryAccountBinding(client.value, native.value);
}

/** The native binding alone. It names the instance and scope of an account request. */
export async function readNativePantryAccountBinding(
  env: AccountPlatformBindings,
  organisationId: string,
): Promise<Result<NativePantryAccountBinding, AccountPlatformError>> {
  try {
    const row = await env.DB.prepare(
      `SELECT instance_id AS instanceId, native_organisation_id AS nativeOrganisationId, deployment_id AS deploymentId, scope_json AS scopeJson FROM account_service_binding WHERE native_organisation_id = ?`,
    )
      .bind(organisationId)
      .first<unknown>();
    if (row === null)
      return { ok: false, error: { code: "instance_ineligible" } };
    const r = accountObject(row, [
      "instanceId",
      "nativeOrganisationId",
      "deploymentId",
      "scopeJson",
    ]);
    const instanceId = accountText(r.instanceId);
    const nativeOrganisationId = accountText(r.nativeOrganisationId);
    const deploymentId = accountText(r.deploymentId);
    const scope = parseAccountScope(JSON.parse(accountText(r.scopeJson)));
    if (
      nativeOrganisationId !== organisationId ||
      deploymentId !== env.ACCOUNT_PLATFORM_DEPLOYMENT_ID
    )
      return { ok: false, error: { code: "scope_forbidden" } };
    return {
      ok: true,
      value: {
        version: 1,
        instanceId,
        scope,
        nativeOrganisationId,
        deploymentId,
      },
    };
  } catch {
    return accountUnavailable();
  }
}

/** The account's current fee policy for the binding, which must name the same scope. */
async function confirmPantryAccountBinding(
  client: AccountPlatformClient,
  native: NativePantryAccountBinding,
): Promise<Result<PantryAccountBinding, AccountPlatformError>> {
  try {
    const fee = await client.getFeePolicy(native.instanceId);
    if (!fee.ok) return fee;
    if (
      fee.value.instanceId !== native.instanceId ||
      !sameAccountScope(fee.value.scope, native.scope)
    )
      return { ok: false, error: { code: "scope_forbidden" } };
    return { ok: true, value: { ...native, feePolicy: fee.value.policy } };
  } catch {
    return accountUnavailable();
  }
}

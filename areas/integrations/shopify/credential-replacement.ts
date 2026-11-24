// The check of a replacement credential of a Shopify connection: the new
// token must belong to the same shop and the same environment.
import type {
  BegunCredentialRotation,
  CredentialRotationFailureCode,
} from "@purin-labs/area-integrations-contract/server/credential-lifecycle";
import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { discoverShopifyIdentity } from "./provider-adapter";

export async function validateShopifyReplacementCredential(
  rotation: BegunCredentialRotation,
  replacementSecret: string,
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly failureCode: CredentialRotationFailureCode }
> {
  const discovered = await discoverShopifyIdentity({
    fetcher: runtimeFetch,
    shopDomain: rotation.connection.providerSubjectId,
    accessToken: replacementSecret,
  });
  if (!discovered.ok)
    return { ok: false, failureCode: "replacement_validation_failed" };
  if (discovered.value.environment !== rotation.connection.environment) {
    return { ok: false, failureCode: "replacement_environment_mismatch" };
  }
  return discovered.value.myshopifyDomain ===
    rotation.connection.providerSubjectId ||
    discovered.value.shopId === rotation.connection.providerSubjectId
    ? { ok: true }
    : { ok: false, failureCode: "replacement_identity_mismatch" };
}

import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import type { Env } from "@purin-labs/kernel/env";
import type {
  BegunCredentialRotation,
  CredentialRotationFailureCode,
} from "../contract/credential-lifecycle";
import { validateExternalProviderToken } from "@purin-labs/connections/external-records/records";
import { providerModules } from "../contract/provider-modules";
import {
  discoverStripeAccount,
  stripeCredentialEnvironment,
} from "../provider-adapters/stripe";

export async function validateReplacementCredential(
  env: Env,
  rotation: BegunCredentialRotation,
  replacementSecret: string,
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly failureCode: CredentialRotationFailureCode }
> {
  switch (rotation.connection.provider) {
    case "stripe": {
      // The platform key decides the Stripe mode, as at connection.
      const stripeMode =
        env.STRIPE_CONNECT_CLIENT_SECRET === undefined
          ? null
          : stripeCredentialEnvironment(env.STRIPE_CONNECT_CLIENT_SECRET);
      if (
        stripeMode === null ||
        stripeCredentialEnvironment(replacementSecret) !== stripeMode
      ) {
        return { ok: false, failureCode: "replacement_environment_mismatch" };
      }
      const discovered = await discoverStripeAccount({
        fetcher: runtimeFetch,
        accountId: rotation.account.providerAccountId,
        accessToken: replacementSecret,
        environment: stripeMode,
      });
      return discovered.ok
        ? { ok: true }
        : { ok: false, failureCode: "replacement_validation_failed" };
    }
    case "shopify":
      return providerModules
        .use()
        .shopify.validateReplacementCredential(rotation, replacementSecret);
    case "airtable":
    case "notion": {
      const discovered = await validateExternalProviderToken({
        provider: rotation.connection.provider,
        token: replacementSecret,
        fetcher: runtimeFetch,
      });
      if (!discovered.ok)
        return { ok: false, failureCode: "replacement_validation_failed" };
      return discovered.value.providerAccountId ===
        rotation.account.providerAccountId
        ? { ok: true }
        : { ok: false, failureCode: "replacement_identity_mismatch" };
    }
    default:
      return { ok: false, failureCode: "replacement_validation_failed" };
  }
}

export function credentialRotationSlug(idempotencyKey: string): string {
  return idempotencyKey.toLowerCase().replace(/[^a-z0-9_-]/gu, "-");
}

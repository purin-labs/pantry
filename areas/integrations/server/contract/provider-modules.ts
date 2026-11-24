import { definePort } from "@purin-labs/kernel/port";
import type {
  BegunCredentialRotation,
  CredentialRotationFailureCode,
} from "@purin-labs/area-integrations-contract/server/credential-lifecycle";
import type { ProviderAdapterByProvider } from "@purin-labs/area-integrations-contract/server/provider-adapter";

/**
 * A provider whose code is a module of its own, so that a removal deletes
 * the module and its registration (Refactor 17, step A2.5). The module gives
 * its entry of the provider catalogue and the check of a replacement
 * credential.
 */
export type ProviderModule<P extends keyof ProviderAdapterByProvider> =
  Readonly<{
    adapter: ProviderAdapterByProvider[P];
    validateReplacementCredential(
      rotation: BegunCredentialRotation,
      replacementSecret: string,
    ): Promise<
      | { readonly ok: true }
      | {
          readonly ok: false;
          readonly failureCode: CredentialRotationFailureCode;
        }
    >;
  }>;

/** The provider modules, which the Worker registers (`worker-ports.ts`). */
export type ProviderModules = Readonly<{
  shopify: ProviderModule<"shopify">;
}>;

export const providerModules = definePort<ProviderModules>("provider_modules");

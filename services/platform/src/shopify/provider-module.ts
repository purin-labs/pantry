// The Shopify provider module (Refactor 17, step A2.5): its entry of the
// provider catalogue and its check of a replacement credential. The Worker
// registers it (`worker-ports.ts`).
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { PROVIDER_DATA_CLASSES } from "@purin-labs/connections/data/integration-provider-directory";
import type { ProviderModule } from "@purin-labs/area-integrations/server/contract/provider-modules";
import { observeShopifyConnection } from "./connection-observation";
import { connectShopify } from "./connection-workflow";
import { validateShopifyReplacementCredential } from "./credential-replacement";
import {
  shopifyCleanupAdapter,
  shopifyOnboardingAdapter,
} from "./provider-adapter";

export const SHOPIFY_PROVIDER_MODULE: ProviderModule<"shopify"> = {
  adapter: {
    provider: "shopify",
    dataClasses: PROVIDER_DATA_CLASSES.shopify,
    capabilityIds: [
      CAPABILITY_KEYS.commerceEntityPlaneContext,
      CAPABILITY_KEYS.commerceEntityRead,
      CAPABILITY_KEYS.commerceActionPropose,
      CAPABILITY_KEYS.commerceCatalogPublish,
      CAPABILITY_KEYS.commerceOrderCancel,
      CAPABILITY_KEYS.commerceFulfillmentAttachTracking,
      CAPABILITY_KEYS.commerceEntityPatch,
      CAPABILITY_KEYS.commerceRelationshipCreate,
      CAPABILITY_KEYS.commerceRelationshipDelete,
      CAPABILITY_KEYS.commerceListEntryAdd,
      CAPABILITY_KEYS.commerceListEntryPatch,
      CAPABILITY_KEYS.commerceListEntryRemove,
      CAPABILITY_KEYS.commerceSavedViewPublish,
      CAPABILITY_KEYS.shopifyOrderCancel,
    ],
    connectionFamily: { kind: "oauth_connection", pkce: "none" },
    onboarding: shopifyOnboardingAdapter,
    completeConnection: connectShopify,
    observe: observeShopifyConnection,
    remove: shopifyCleanupAdapter.remove,
    manualActionInstruction: shopifyCleanupAdapter.manualActionInstruction,
  },
  validateReplacementCredential: validateShopifyReplacementCredential,
};

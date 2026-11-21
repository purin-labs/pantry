import type {
  ProviderAdapterByProvider,
  ProviderCleanupByProvider,
} from "../src/integrations/contract/provider-adapter";
import { PROVIDER_ADAPTERS } from "../src/provider-adapters/catalogue";

// @ts-expect-error A compiled catalogue must contain every active provider.
const incompleteCatalogue: ProviderAdapterByProvider = {
  airtable: PROVIDER_ADAPTERS.airtable,
  gmail: PROVIDER_ADAPTERS.gmail,
  notion: PROVIDER_ADAPTERS.notion,
  shopify: PROVIDER_ADAPTERS.shopify,
  slack: PROVIDER_ADAPTERS.slack,
  stripe: PROVIDER_ADAPTERS.stripe,
};

const invalidWhatsAppFamily: ProviderAdapterByProvider["whatsapp"] = {
  provider: "whatsapp",
  capabilityIds: PROVIDER_ADAPTERS.whatsapp.capabilityIds,
  // @ts-expect-error WhatsApp cannot use an OAuth credential connection family.
  connectionFamily: { kind: "oauth_connection", pkce: "none" },
  onboarding: PROVIDER_ADAPTERS.whatsapp.onboarding,
  completeConnection: PROVIDER_ADAPTERS.whatsapp.completeConnection,
  observe: PROVIDER_ADAPTERS.whatsapp.observe,
  remove: PROVIDER_ADAPTERS.whatsapp.remove,
  manualActionInstruction: PROVIDER_ADAPTERS.whatsapp.manualActionInstruction,
};

declare const cleanupBase: Omit<
  ProviderCleanupByProvider["whatsapp"],
  "provider" | "wabaId" | "removeApplicationSubscription"
>;

// @ts-expect-error WhatsApp cleanup must state whether the app subscription is removed.
const invalidWhatsAppCleanup: ProviderCleanupByProvider["whatsapp"] = {
  cleanupId: cleanupBase.cleanupId,
  organisationId: cleanupBase.organisationId,
  integrationAccountId: cleanupBase.integrationAccountId,
  provider: "whatsapp",
  environment: cleanupBase.environment,
  providerAccountId: cleanupBase.providerAccountId,
  providerConnectionId: cleanupBase.providerConnectionId,
  credentialHandles: cleanupBase.credentialHandles,
  wabaId: "waba-1",
};

void incompleteCatalogue;
void invalidWhatsAppFamily;
void invalidWhatsAppCleanup;

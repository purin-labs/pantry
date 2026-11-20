import { parseGmailAuthorizationProduct } from "../mail/gmail-authorization";
import type { OnboardingProvider } from "./domain";
import type { ProviderStartContext } from "../provider-adapters/domain";
import { parseActiveIntegrationProvider } from "../data/integration-provider-directory";

export function providerContextForExistingAccount(
  provider: string,
  providerAccountId: string,
  authorizationProduct: string | null = null,
): ProviderStartContext | null {
  const active = parseActiveIntegrationProvider(provider);
  return active === null
    ? null
    : existingAccountContext(active, providerAccountId, authorizationProduct);
}

function existingAccountContext(
  provider: OnboardingProvider,
  providerAccountId: string,
  authorizationProduct: string | null = null,
): ProviderStartContext | null {
  switch (provider) {
    case "airtable":
      return { provider: "airtable" };
    case "square":
      return { provider: "square" };
    case "dropbox":
      return { provider: "dropbox" };
    case "notion":
      return { provider: "notion" };
    case "slack":
      return { provider: "slack" };
    case "stripe":
      return { provider: "stripe" };
    case "gmail": {
      const product = parseGmailAuthorizationProduct(authorizationProduct);
      return product === null
        ? null
        : { provider: "gmail", authorizationProduct: product };
    }
    case "google_drive":
      return { provider: "google_drive" };
    case "whatsapp":
      return { provider: "whatsapp" };
    case "shopify":
      return { provider: "shopify", shopDomain: providerAccountId };
  }
}

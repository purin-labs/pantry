// The health check of a Shopify connection: the webhooks of the shop are
// registered, and the shop answers with the stored credential.
import type { ProviderManifestEvidence } from "../data/provider-attempt";
import type { ProviderObservationRequest } from "../provider-adapters/domain";
import { providerIngressOrigin } from "../provider-lifecycle/authorization";
import {
  blockedEvidence,
  resolveStoredObservationBearer,
} from "../provider-workflows/observation";
import { isShopifyAdminDomain } from "./auth";
import { registerShopifyWebhooks } from "./connector/webhook-registration";

export async function observeShopifyConnection(
  input: ProviderObservationRequest,
): Promise<ProviderManifestEvidence> {
  const bearer = await resolveStoredObservationBearer(input, "shopify");
  if (bearer === null || !isShopifyAdminDomain(input.providerAccountId)) {
    return blockedEvidence("provider_credential_unavailable", [
      "reconnect_provider",
    ]);
  }
  const registration = await registerShopifyWebhooks({
    shopDomain: input.providerAccountId,
    accessToken: bearer,
    endpointUrl: `${providerIngressOrigin(input.env)}/hook/shopify/${input.organisationId}`,
    fetcher: input.fetcher,
  });
  if (!registration.ok) {
    return blockedEvidence("provider_webhook_unhealthy", [
      "repair_provider_webhook",
    ]);
  }
  return registration.value.ordersCreate.kind === "unavailable"
    ? {
        kind: "degraded",
        missingOptionalCapabilities: ["orders/create"],
        repairActions: ["repair_provider_webhook"],
      }
    : { kind: "healthy", evidenceCode: "provider_webhook_verified" };
}

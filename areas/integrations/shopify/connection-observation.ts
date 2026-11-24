// The health check of a Shopify connection: the webhooks of the shop are
// registered, and the shop answers with the stored credential.
import type { ProviderManifestEvidence } from "@purin-labs/connections/data/provider-attempt";
import type { ProviderObservationRequest } from "@purin-labs/area-integrations-contract/server/provider-adapter";
import { providerIngressOrigin } from "@purin-labs/area-integrations/server/contract/provider-ingress";
import {
  blockedEvidence,
  resolveStoredObservationBearer,
} from "@purin-labs/area-integrations/server/contract/observation-evidence";
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
  // Shopify refuses an order topic when the shop does not share protected
  // customer data. Either refusal stops those order changes by webhook.
  const missing = [
    ...(registration.value.ordersCreate.kind === "unavailable"
      ? ["orders/create"]
      : []),
    ...(registration.value.ordersUpdated.kind === "unavailable"
      ? ["orders/updated"]
      : []),
  ];
  return missing.length > 0
    ? {
        kind: "degraded",
        missingOptionalCapabilities: missing,
        repairActions: ["repair_provider_webhook"],
      }
    : { kind: "healthy", evidenceCode: "provider_webhook_verified" };
}

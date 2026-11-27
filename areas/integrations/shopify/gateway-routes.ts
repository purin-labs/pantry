// The Shopify routes of the Worker gateway (Refactor 17, step A2.5): the
// admin routes of the test shop and the webhook of a shop. The Worker
// registers them (`worker-ports.ts`), and the gateway calls them by the
// route kind of the gateway routing.
import type { ProviderGatewayRoutes } from "@purin-labs/area-integrations/server/contract/provider-modules";
import {
  handleConfigureShopifyConnector,
  handleConfigureShopifyCredential,
  handleConfigureShopifyCues,
  handleTriggerShopifyTestOrder,
} from "./admin";
import { handleShopifyWebhook } from "./webhooks";

export const SHOPIFY_GATEWAY_ROUTES: ProviderGatewayRoutes<
  | "configureShopifyCredential"
  | "configureShopifyConnector"
  | "configureShopifyCues"
  | "triggerShopifyTestOrder",
  "shopifyWebhook"
> = {
  admin: {
    configureShopifyCredential: handleConfigureShopifyCredential,
    configureShopifyConnector: handleConfigureShopifyConnector,
    configureShopifyCues: handleConfigureShopifyCues,
    triggerShopifyTestOrder: handleTriggerShopifyTestOrder,
  },
  webhooks: { shopifyWebhook: handleShopifyWebhook },
};

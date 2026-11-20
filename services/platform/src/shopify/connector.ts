import type {
  ShopifyFulfillmentStatusV202607,
  ShopifyResourceEnvelopeV202607,
} from "@purin-labs/commerce-contracts";
import type { IntegrationAccountId, OrganisationId } from "../ids";
import type { VaultResolveError } from "../credential-vault";
import type { ShopifyRegistrationOperation } from "./connector/webhook-registration";

export type ShopifyWebhookError =
  | { code: "shopify_connector_missing" }
  | { code: "shopify_connector_inactive" }
  | { code: "shopify_connector_ambiguous" }
  | { code: "shopify_webhook_secret_invalid" }
  | { code: "shopify_signature_missing" }
  | { code: "shopify_signature_invalid" }
  | { code: "shopify_event_invalid" }
  | { code: "shopify_event_unsupported" }
  | VaultResolveError;

export type ShopifyWebhookTopic =
  | "ORDERS_CREATE"
  | "ORDERS_UPDATED"
  | "INVENTORY_LEVELS_UPDATE"
  | "PRODUCTS_CREATE"
  | "PRODUCTS_DELETE"
  | "PRODUCTS_UPDATE";

export type ShopifyWebhookSubscriptionResult<
  TTopic extends ShopifyWebhookTopic,
> =
  | {
      kind: "existing";
      topic: TTopic;
      subscriptionId: string;
      uri: string;
    }
  | {
      kind: "created";
      topic: TTopic;
      subscriptionId: string;
      uri: string;
    }
  | {
      kind: "updated";
      topic: TTopic;
      subscriptionId: string;
      uri: string;
    };

export type ShopifyWebhookRegistration = {
  kind: "configured";
  ordersCreate:
    | {
        kind: "live";
        subscription: ShopifyWebhookSubscriptionResult<"ORDERS_CREATE">;
      }
    | {
        kind: "unavailable";
        reasonCode: "provider_rejected";
      };
  ordersUpdated:
    | {
        kind: "live";
        subscription: ShopifyWebhookSubscriptionResult<"ORDERS_UPDATED">;
      }
    | {
        kind: "unavailable";
        reasonCode: "provider_rejected";
      };
  inventoryLevelsUpdate: ShopifyWebhookSubscriptionResult<"INVENTORY_LEVELS_UPDATE">;
  productsCreate: ShopifyWebhookSubscriptionResult<"PRODUCTS_CREATE">;
  productsDelete: ShopifyWebhookSubscriptionResult<"PRODUCTS_DELETE">;
  productsUpdate: ShopifyWebhookSubscriptionResult<"PRODUCTS_UPDATE">;
};

export type ShopifyWebhookRegistrationError =
  | {
      code: "shopify_registration_failed";
      operation: ShopifyRegistrationOperation;
      status: number;
    }
  | {
      code: "shopify_registration_transport_failed";
      operation: ShopifyRegistrationOperation;
    }
  | {
      code: "shopify_registration_invalid";
      operation: ShopifyRegistrationOperation;
    }
  | {
      code: "shopify_registration_graphql_error";
      operation: ShopifyRegistrationOperation;
    }
  | {
      code: "shopify_registration_rejected";
      operation: "create" | "update";
      topic: ShopifyWebhookTopic;
      messages: readonly string[];
    };

export type ShopifyWebhookSecret = {
  readonly integrationAccountId: IntegrationAccountId;
  readonly signingSecret: string;
};

export type ShopifyWebhookHeaders = {
  topic: string | null;
  webhookId: string | null;
  shopDomain: string | null;
  triggeredAt: string | null;
};

export type ShopifyCommerceOrderEnvelope = {
  readonly apiVersion: "2026-07";
  readonly context: {
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: IntegrationAccountId;
    readonly revision: number;
    readonly occurredAt: string;
    readonly observedAt: string;
    readonly eventId: string;
    readonly customerReference: string;
  };
  readonly order: {
    readonly id: string;
    readonly checkoutId: string;
    readonly currency: string;
    readonly totalPrice: string;
    readonly fulfillmentStatus: ShopifyFulfillmentStatusV202607;
    readonly cancelledAt:
      | { readonly kind: "active" }
      | {
          readonly kind: "cancelled";
          readonly cancelledAt: string;
          readonly reason: string;
        };
    readonly lineItems: readonly {
      readonly id: string;
      readonly variantId: string | null;
      readonly sku: string;
      readonly title: string;
      readonly quantity: number;
      readonly fulfilledQuantity: number;
      readonly price: string;
    }[];
  };
};

export type ShopifyCommerceCatalogEnvelope = {
  readonly apiVersion: "2026-07";
  readonly context: {
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: IntegrationAccountId;
    readonly revision: number;
    readonly occurredAt: string;
    readonly observedAt: string;
    readonly eventId: string;
    readonly customerReference: string;
  };
  readonly product: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly variants: readonly {
      readonly id: string;
      readonly inventoryItemId: string;
      readonly sku: string;
      readonly title: string;
    }[];
  };
};

export type ShopifyCommerceInventoryLevelEnvelope = {
  readonly apiVersion: "2026-07";
  readonly context: {
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: IntegrationAccountId;
    readonly revision: number;
    readonly occurredAt: string;
    readonly observedAt: string;
    readonly eventId: string;
    readonly customerReference: string;
  };
  readonly inventoryItemId: string;
  readonly locationId: string;
  readonly available: number;
  readonly updatedAt: string;
};

export type ShopifyCommerceRefreshTarget = {
  readonly kind: "order";
  readonly orderGid: string;
};

export type ShopifyInitialCommerceSnapshot = {
  readonly catalog: readonly ShopifyCommerceCatalogEnvelope[];
  readonly inventory: readonly ShopifyCommerceInventoryLevelEnvelope[];
  readonly locations: readonly ShopifyResourceEnvelopeV202607[];
  readonly locationQuery: "queried" | "skipped_scope";
  readonly orders: readonly ShopifyCommerceOrderEnvelope[];
  readonly publicationQuery: "queried" | "skipped_scope";
  readonly resources: readonly ShopifyResourceEnvelopeV202607[];
};

export type ShopifyLocationSnapshotAccess =
  | { readonly kind: "read_locations"; readonly scope: "read_locations" }
  | { readonly kind: "read_markets_home"; readonly scope: "read_markets_home" }
  | { readonly kind: "inventory_only"; readonly scope: "read_inventory" };

export type ShopifyPublicationSnapshotAccess =
  | { readonly kind: "read_publications"; readonly scope: "read_publications" }
  | {
      readonly kind: "scope_missing";
      readonly requiredScope: "read_publications";
    };

export type ShopifyInitialOrdersSnapshot = {
  readonly orders: readonly ShopifyCommerceOrderEnvelope[];
  readonly resources: readonly ShopifyResourceEnvelopeV202607[];
};

export type ShopifyInitialSyncError =
  | {
      readonly code: "shopify_initial_sync_transport_failed";
      readonly resource:
        "catalog" | "inventory" | "locations" | "orders" | "publications";
    }
  | {
      readonly code: "shopify_initial_sync_http_failed";
      readonly resource:
        "catalog" | "inventory" | "locations" | "orders" | "publications";
      readonly status: number;
    }
  | {
      readonly code: "shopify_initial_sync_response_invalid";
      readonly resource:
        "catalog" | "inventory" | "locations" | "orders" | "publications";
    };

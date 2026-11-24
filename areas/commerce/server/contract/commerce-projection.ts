// The types of the commerce projection of the Organisation actor: the kinds of
// a projection, the delivery that the projection applies and what it gives
// back. The projection code of commerce (`actors/commerce-projection.ts`)
// implements them; another area names them through the contract.
import type { CommerceSystemKind } from "@purin-labs/contracts";
import type {
  CanonicalCommerceDelivery,
  CommerceCueFact,
} from "@purin-labs/commerce-contracts";
import type { CommerceCueEvent } from "@purin-labs/agent/cues/engine";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { CommerceObservationDisposition } from "@purin-labs/commerce-control-api";

export type CommerceProjectionKind =
  | "product"
  | "sellable_variant"
  | "inventory_item"
  | "location"
  | "sales_channel"
  | "offer"
  | "inventory_position"
  | "inventory_movement"
  | "inventory_lot"
  | "commerce_order"
  | "payment"
  | "fulfillment"
  | "shipment"
  | "menu"
  | "modifier_group_revision"
  | "recipe_revision"
  | "preparation_station"
  | "preparation_ticket"
  | "production_batch"
  | "stock_policy";

export type CommerceProjectionError =
  | { readonly code: "commerce_event_invalid"; readonly field: string }
  | { readonly code: "commerce_event_organisation_mismatch" }
  | { readonly code: "commerce_event_integration_account_mismatch" }
  | { readonly code: "commerce_delivery_conflict" }
  | {
      readonly code: "commerce_revision_conflict";
      readonly projectionKind: CommerceProjectionKind;
      readonly canonicalId: string;
      readonly currentIntegrationAccountId: string;
      readonly receivedIntegrationAccountId: string;
      readonly currentRevision: number;
      readonly receivedRevision: number;
    }
  | {
      readonly code: "commerce_terminal_state_regression";
      readonly currentLifecycle: "delivered" | "returned";
    }
  | { readonly code: "commerce_projection_corrupt" }
  | { readonly code: "commerce_read_limit_invalid" }
  | { readonly code: "commerce_read_query_invalid" }
  | { readonly code: "commerce_lab_state_missing" }
  | { readonly code: "commerce_lab_namespace_mismatch" }
  | { readonly code: "commerce_system_authority_mismatch" };

export type CommerceSystemStorageAuthority =
  | Readonly<{ kind: "lab"; revision: null }>
  | Readonly<{ kind: CommerceSystemKind; revision: number }>;

export type ApplyCommerceDeliveryInput = {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly delivery: CanonicalCommerceDelivery;
  readonly cueFacts: readonly CommerceCueFact[];
  readonly labRunId: string | null;
  readonly processedAt: number;
};

export type PendingCommerceCue = {
  readonly organisationId: OrganisationId;
  readonly nativeId: string;
  readonly eventId: string;
  readonly integrationAccountId: IntegrationAccountId;
  readonly event: CommerceCueEvent;
  readonly state: "pending" | "enqueued";
  readonly createdAt: number;
  readonly enqueuedAt: number | null;
  readonly labRunId: string | null;
};

export type AppliedCommerceObservationResult = {
  readonly disposition: CommerceObservationDisposition;
  readonly observationId: string;
  readonly projectionKind: CommerceProjectionKind;
  readonly canonicalId: string;
  readonly revision: number;
};

export type AppliedCommerceDeliveryResult = {
  readonly disposition: "accepted" | "duplicate";
  readonly providerDeliveryId: string;
  readonly observations: readonly AppliedCommerceObservationResult[];
  readonly pendingCues: readonly PendingCommerceCue[];
};

export type InventoryQuantity = Readonly<{
  amount: number;
  scale: number;
  unit: string;
}>;

/**
 * The available stock of an inventory position before and after one applied
 * change (Plan 24 S1). A café sale lowers `available` when its checkout is
 * made, in a delivery of positions only; a sale's hand-over later changes
 * `onHand` and leaves `available` as it is. So a reader of the counter stock
 * compares the position's `available` before and after the delivery.
 */
export type InventoryStockChange = Readonly<{
  inventoryItemId: string;
  locationId: string;
  /** Null when the delivery opened the position. */
  before: InventoryQuantity | null;
  after: InventoryQuantity;
}>;

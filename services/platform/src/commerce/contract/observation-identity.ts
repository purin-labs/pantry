import type {
  CanonicalCommerceDelivery,
  CommerceResourceType,
} from "@purin-labs/commerce-contracts";
import { assertNever } from "@purin-labs/std";
import type { CommerceProjectionKind } from "../../actors/commerce-projection";

/**
 * The projection kind, the canonical id and the revision of one observation
 * of a commerce delivery. A Shopify webhook and the delivery queue read it.
 */
export function commerceObservationIdentity(
  observation: CanonicalCommerceDelivery["observations"][number],
): {
  readonly kind: CommerceProjectionKind;
  readonly canonicalId: string;
  readonly revision: number;
} {
  if (observation.kind === "delete") {
    return {
      kind: commerceProjectionKindForResourceType(
        observation.provenance.resourceType,
      ),
      canonicalId: observation.provenance.resourceId,
      revision: observation.provenance.revision,
    };
  }
  const projection = observation.projection;
  switch (projection.kind) {
    case "product":
    case "sellable_variant":
    case "inventory_item":
    case "location":
    case "sales_channel":
    case "offer":
    case "inventory_position":
    case "inventory_movement":
    case "inventory_lot":
    case "commerce_order":
    case "payment":
    case "fulfillment":
    case "shipment":
    case "menu":
    case "modifier_group_revision":
    case "recipe_revision":
    case "preparation_station":
    case "preparation_ticket":
    case "production_batch":
    case "stock_policy":
      return {
        kind: projection.kind,
        canonicalId: projection.projection.provenance.resourceId,
        revision: projection.projection.provenance.revision,
      };
    default:
      return assertNever(projection);
  }
}

function commerceProjectionKindForResourceType(
  resourceType: CommerceResourceType,
): CommerceProjectionKind {
  switch (resourceType) {
    case "inventory_consumption_plan":
    case "inventory_consumption_requirement":
      throw new Error("commerce_delivery_resource_unsupported");
    case "product":
    case "sellable_variant":
    case "inventory_item":
    case "location":
    case "sales_channel":
    case "offer":
    case "inventory_position":
    case "inventory_movement":
    case "inventory_lot":
    case "commerce_order":
    case "payment":
    case "fulfillment":
    case "shipment":
    case "menu":
    case "modifier_group_revision":
    case "recipe_revision":
    case "preparation_station":
    case "preparation_ticket":
    case "production_batch":
    case "stock_policy":
      return resourceType;
  }
}

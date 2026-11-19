import {
  applyProductChanges,
  applyVariantChanges,
  type CommerceResourcesV1,
  type CommerceMutationErrorV1,
  type CommerceOfferV1,
  type CommerceProductV1,
  type CommerceVariantV1,
  type UpdateCommerceOfferV1,
  type UpdateCommerceProductV1,
  type UpdateCommerceStorefrontTaxV1,
  type UpdateCommerceVariantV1,
} from "@purin-labs/commerce-client";
import type { Storefront } from "@purin-labs/commerce-contracts";

import { findResource } from "./checkout-shared.ts";

export type CatalogEditPlan =
  | Readonly<{
      kind: "product";
      command: UpdateCommerceProductV1;
      product: CommerceProductV1;
    }>
  | Readonly<{
      kind: "variant";
      command: UpdateCommerceVariantV1;
      variant: CommerceVariantV1;
      /** The revision whose shipping specification the new revision keeps. */
      previousRevision: number;
    }>
  | Readonly<{
      kind: "offer";
      command: UpdateCommerceOfferV1;
      offer: CommerceOfferV1;
    }>
  | Readonly<{
      kind: "storefront";
      command: UpdateCommerceStorefrontTaxV1;
      storefront: Storefront;
    }>;

export type CatalogEditPlanResult =
  | Readonly<{ kind: "planned"; value: CatalogEditPlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export function planProductUpdate(
  command: UpdateCommerceProductV1,
  resources: CommerceResourcesV1,
): CatalogEditPlanResult {
  const current = findResource(resources.products, command.productId);
  if (current === undefined)
    return notFound("product", command.productId);
  if (current.revision !== command.expectedProductRevision)
    return stale(
      "product",
      current.id,
      command.expectedProductRevision,
      current.revision,
    );
  const handle = command.changes.handle;
  if (
    handle !== undefined &&
    handle !== null &&
    resources.products.some(
      (product) => product.id !== current.id && product.handle === handle,
    )
  ) {
    return rejected({
      code: "resource_already_exists",
      kind: "product_handle",
      id: handle,
    });
  }
  return {
    kind: "planned",
    value: {
      kind: "product",
      command,
      product: applyProductChanges(current, command.changes, command.requestedAt),
    },
  };
}

export function planVariantUpdate(
  command: UpdateCommerceVariantV1,
  resources: CommerceResourcesV1,
): CatalogEditPlanResult {
  const current = findResource(resources.variants, command.variantId);
  if (current === undefined)
    return notFound("sellable_variant", command.variantId);
  if (current.revision !== command.expectedVariantRevision)
    return stale(
      "sellable_variant",
      current.id,
      command.expectedVariantRevision,
      current.revision,
    );
  const sku = command.changes.sku;
  if (
    sku !== undefined &&
    resources.variants.some(
      (variant) => variant.id !== current.id && variant.sku === sku,
    )
  ) {
    return rejected({ code: "resource_already_exists", kind: "sku", id: sku });
  }
  return {
    kind: "planned",
    value: {
      kind: "variant",
      command,
      variant: applyVariantChanges(current, command.changes, command.requestedAt),
      previousRevision: current.revision,
    },
  };
}

export function planOfferUpdate(
  command: UpdateCommerceOfferV1,
  resources: CommerceResourcesV1,
): CatalogEditPlanResult {
  const current = findResource(resources.offers, command.offerId);
  if (current === undefined) return notFound("offer", command.offerId);
  if (current.revision !== command.expectedOfferRevision)
    return stale(
      "offer",
      current.id,
      command.expectedOfferRevision,
      current.revision,
    );
  const { price, compareAtPrice, listing } = command.changes;
  // An offer keeps one currency; another currency is a market (step 4A).
  if (
    (price !== undefined && price.currency !== current.price.currency) ||
    (compareAtPrice !== undefined &&
      compareAtPrice !== null &&
      compareAtPrice.currency !== current.price.currency)
  ) {
    return rejected({
      code: "resource_relationship_invalid",
      field: "offer.currency",
    });
  }
  let lifecycle = current.lifecycle;
  if (listing !== undefined && listing !== current.lifecycle.state) {
    // A prepared offer goes on sale only through the governed publish command.
    if (current.lifecycle.state === "prepared") {
      return rejected({
        code: "resource_relationship_invalid",
        field: "offer.lifecycle",
      });
    }
    lifecycle =
      listing === "listed"
        ? { state: "listed", listedAt: command.requestedAt }
        : { state: "archived", archivedAt: command.requestedAt };
  }
  return {
    kind: "planned",
    value: {
      kind: "offer",
      command,
      offer: {
        ...current,
        revision: current.revision + 1,
        price: price ?? current.price,
        compareAtPrice:
          compareAtPrice === undefined ? current.compareAtPrice : compareAtPrice,
        lifecycle,
        occurredAt: command.requestedAt,
      },
    },
  };
}

/**
 * A new tax rule for a storefront. A pickup storefront takes a percentage,
 * added or included; a shipping storefront's carrier quote adds its tax, so
 * an included percentage is refused there.
 */
export function planStorefrontTaxUpdate(
  command: UpdateCommerceStorefrontTaxV1,
  current: Storefront | undefined,
): CatalogEditPlanResult {
  if (current === undefined)
    return notFound("storefront", command.storefrontId);
  if (current.revision !== command.expectedStorefrontRevision)
    return stale(
      "storefront",
      current.storefrontId,
      command.expectedStorefrontRevision,
      current.revision,
    );
  const { tax } = command;
  const allowed =
    current.fulfillment.kind === "pickup"
      ? tax.kind === "percentage"
      : tax.kind === "provider_quoted" || tax.inclusion !== "included";
  if (!allowed) {
    return rejected({
      code: "resource_relationship_invalid",
      field: "storefront.checkout.tax",
    });
  }
  return {
    kind: "planned",
    value: {
      kind: "storefront",
      command,
      storefront: {
        ...current,
        revision: current.revision + 1,
        checkout: { ...current.checkout, tax },
      },
    },
  };
}

function notFound(kind: string, id: string): CatalogEditPlanResult {
  return rejected({ code: "resource_not_found", kind, id });
}

function stale(
  kind: string,
  id: string,
  expected: number,
  actual: number,
): CatalogEditPlanResult {
  return rejected({
    code: "stale_resource_revision",
    kind,
    id,
    expected,
    actual,
  });
}

function rejected(error: CommerceMutationErrorV1): CatalogEditPlanResult {
  return { kind: "rejected", error };
}

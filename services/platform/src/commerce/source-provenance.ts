import type { SourceProvenance } from "@purin-labs/commerce-contracts";
import { parseOrganisationId, parseIntegrationAccountId } from "../ids";
import { isRecord } from "@purin-labs/std";

export function parseSourceProvenance(value: unknown): SourceProvenance | null {
  if (
    !isRecord(value) ||
    typeof value.resourceId !== "string" ||
    value.resourceId.trim().length === 0 ||
    typeof value.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(value.occurredAt)) ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !isCommerceSource(value.source) ||
    !isCommerceResourceType(value.resourceType)
  )
    return null;
  const organisationId =
    typeof value.organisationId === "string"
      ? parseOrganisationId(value.organisationId)
      : null;
  const integrationAccountId =
    typeof value.integrationAccountId === "string"
      ? parseIntegrationAccountId(value.integrationAccountId)
      : null;
  return organisationId?.ok && integrationAccountId?.ok
    ? {
        organisationId: organisationId.value,
        integrationAccountId: integrationAccountId.value,
        source: value.source,
        resourceType: value.resourceType,
        resourceId: value.resourceId.trim(),
        revision: value.revision,
        occurredAt: value.occurredAt,
        observedAt: value.observedAt,
      }
    : null;
}

function isCommerceSource(value: unknown): value is SourceProvenance["source"] {
  return (
    value === "shopify" ||
    value === "stripe" ||
    value === "lab" ||
    value === "underclerk"
  );
}

function isCommerceResourceType(
  value: unknown,
): value is SourceProvenance["resourceType"] {
  return (
    value === "product" ||
    value === "sellable_variant" ||
    value === "inventory_item" ||
    value === "location" ||
    value === "sales_channel" ||
    value === "offer" ||
    value === "inventory_position" ||
    value === "inventory_movement" ||
    value === "inventory_lot" ||
    value === "commerce_order" ||
    value === "payment" ||
    value === "fulfillment" ||
    value === "shipment" ||
    value === "menu" ||
    value === "modifier_group_revision" ||
    value === "recipe_revision" ||
    value === "preparation_station" ||
    value === "preparation_ticket" ||
    value === "production_batch" ||
    value === "stock_policy"
  );
}

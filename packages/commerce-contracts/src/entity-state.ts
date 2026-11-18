import {
  OpenObject,
  PositiveInteger,
  parseContract,
  type ContractDecodeResult,
} from "./schema.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { assertNever } from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";

import {
  nonBlankTextSchema,
  trimmedIdentityTextSchema,
} from "./identity-text.ts";
import { timestampNanoseconds, validTimestamp } from "./commerce-timestamp.ts";
import { invalidShape } from "./query-parts.ts";
import { cursorRefusal } from "./cursor-values.ts";

export const customCommerceEntityStateSchema = Type.Union([
  OpenObject({ state: Type.Literal("active") }),
  OpenObject({ state: Type.Literal("archived"), archivedAt: Type.String() }),
]);
export type CustomCommerceEntityState = StrictUnion<
  Static<typeof customCommerceEntityStateSchema>
>;
export const commerceFreshnessSchema = Type.Union([
  OpenObject({ state: Type.Literal("current"), observedAt: Type.String() }),
  OpenObject({
    state: Type.Literal("stale"),
    observedAt: Type.String(),
    staleSince: Type.String(),
  }),
  OpenObject({ state: Type.Literal("unavailable"), reason: Type.String() }),
]);
export type CommerceFreshness = StrictUnion<
  Static<typeof commerceFreshnessSchema>
>;
export const sourceProvenanceSchema = OpenObject({
  organisationId: trimmedIdentityTextSchema,
  integrationAccountId: trimmedIdentityTextSchema,
  source: Type.Enum(["shopify", "stripe", "lab", "underclerk"]),
  resourceType: Type.Enum([
    "product",
    "sellable_variant",
    "inventory_item",
    "location",
    "sales_channel",
    "offer",
    "inventory_position",
    "inventory_movement",
    "inventory_lot",
    "inventory_consumption_plan",
    "inventory_consumption_requirement",
    "commerce_order",
    "payment",
    "fulfillment",
    "shipment",
    "menu",
    "modifier_group_revision",
    "recipe_revision",
    "preparation_station",
    "preparation_ticket",
    "production_batch",
    "stock_policy",
  ]),
  resourceId: trimmedIdentityTextSchema,
  revision: PositiveInteger,
  occurredAt: Type.String(),
  observedAt: Type.String(),
});
type SourceProvenance = Static<typeof sourceProvenanceSchema>;

export function parseCustomCommerceEntityState(
  input: unknown,
): ContractDecodeResult<CustomCommerceEntityState> {
  const parsed = parseContract(
    customCommerceEntityStateSchema,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  switch (parsed.value.state) {
    case "active":
      return { ok: true, value: { state: "active" } };
    case "archived":
      if (!validTimestamp(parsed.value.archivedAt))
        return cursorRefusal("parse");
      return {
        ok: true,
        value: { state: "archived", archivedAt: parsed.value.archivedAt },
      };
    default:
      return assertNever(parsed.value);
  }
}
export function parseCommerceFreshness(
  input: unknown,
): ContractDecodeResult<CommerceFreshness> {
  const parsed = parseContract(commerceFreshnessSchema, input, invalidShape);
  if (!parsed.ok) return parsed;
  const freshness = parsed.value;
  switch (freshness.state) {
    case "current":
      if (!validTimestamp(freshness.observedAt)) return cursorRefusal("parse");
      return {
        ok: true,
        value: { state: "current", observedAt: freshness.observedAt },
      };
    case "stale": {
      const observed = timestampNanoseconds(freshness.observedAt);
      const stale = timestampNanoseconds(freshness.staleSince);
      if (observed === null || stale === null) return cursorRefusal("parse");
      if (stale < observed) return cursorRefusal("invalid_date");
      return {
        ok: true,
        value: {
          state: "stale",
          observedAt: freshness.observedAt,
          staleSince: freshness.staleSince,
        },
      };
    }
    case "unavailable":
      if (!Value.Check(nonBlankTextSchema, freshness.reason))
        return cursorRefusal("invalid_text", { field: "freshness.reason" });
      return {
        ok: true,
        value: { state: "unavailable", reason: freshness.reason },
      };
    default:
      return assertNever(freshness);
  }
}
/** Entity-plane provenance failures use the entity-plane parse error. */
export function parseEntityProvenance(
  input: unknown,
): ContractDecodeResult<SourceProvenance> {
  const parsed = parseContract(sourceProvenanceSchema, input, invalidShape);
  if (!parsed.ok) return parsed;
  const source = parsed.value;
  const occurred = timestampNanoseconds(source.occurredAt);
  const observed = timestampNanoseconds(source.observedAt);
  if (occurred === null || observed === null || observed < occurred)
    return cursorRefusal("parse");
  return {
    ok: true,
    value: {
      organisationId: source.organisationId,
      integrationAccountId: source.integrationAccountId,
      source: source.source,
      resourceType: source.resourceType,
      resourceId: source.resourceId,
      revision: source.revision,
      occurredAt: source.occurredAt,
      observedAt: source.observedAt,
    },
  };
}

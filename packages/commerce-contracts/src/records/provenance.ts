// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import {
  OpenObject,
  SafeInteger,
  recordParser,
} from "@purin-labs/contract-schema";
import {
  integrationAccountIdSchema,
  organisationIdSchema,
  resourceIdSchema,
} from "./identifiers.ts";

export const commerceResourceTypeSchema = Type.Union([
  Type.Literal("product"),
  Type.Literal("sellable_variant"),
  Type.Literal("inventory_item"),
  Type.Literal("location"),
  Type.Literal("sales_channel"),
  Type.Literal("offer"),
  Type.Literal("inventory_position"),
  Type.Literal("inventory_movement"),
  Type.Literal("inventory_lot"),
  Type.Literal("inventory_consumption_plan"),
  Type.Literal("inventory_consumption_requirement"),
  Type.Literal("commerce_order"),
  Type.Literal("payment"),
  Type.Literal("fulfillment"),
  Type.Literal("shipment"),
  Type.Literal("menu"),
  Type.Literal("modifier_group_revision"),
  Type.Literal("recipe_revision"),
  Type.Literal("preparation_station"),
  Type.Literal("preparation_ticket"),
  Type.Literal("production_batch"),
  Type.Literal("stock_policy"),
]);
export type CommerceResourceType = Static<typeof commerceResourceTypeSchema>;

export const commerceSourceSchema = Type.Union([
  Type.Literal("shopify"),
  Type.Literal("stripe"),
  Type.Literal("lab"),
  Type.Literal("underclerk"),
]);
export type CommerceSource = Static<typeof commerceSourceSchema>;

export const commerceTimestampSchema = Type.String();
export type CommerceTimestamp = Static<typeof commerceTimestampSchema>;

export const sourceProvenanceSchema = OpenObject({
  organisationId: organisationIdSchema,
  integrationAccountId: integrationAccountIdSchema,
  source: commerceSourceSchema,
  resourceType: commerceResourceTypeSchema,
  resourceId: resourceIdSchema,
  revision: SafeInteger,
  occurredAt: commerceTimestampSchema,
  observedAt: commerceTimestampSchema,
});
export type SourceProvenance = Static<typeof sourceProvenanceSchema>;

// Parsers of the records above (Plan 78 step 2).
export const parseCommerceResourceType = recordParser(
  commerceResourceTypeSchema,
);
export const parseCommerceSource = recordParser(commerceSourceSchema);
export const parseSourceProvenance = recordParser(sourceProvenanceSchema);

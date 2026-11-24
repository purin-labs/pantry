import { exhaustiveList } from "@purin-labs/std";
import type { CommerceProjectionKind } from "../../contract/commerce-projection";

export const PROJECTION_KINDS = exhaustiveList<CommerceProjectionKind>()([
  "product",
  "sellable_variant",
  "inventory_item",
  "location",
  "sales_channel",
  "offer",
  "inventory_position",
  "inventory_movement",
  "inventory_lot",
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
]);

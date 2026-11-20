import type {
  AttributeDefinitionId,
  AttributeDefinitionRevision,
  AttributeOptionId,
  CommerceCommandId,
  CommerceEntityRef,
  CommerceEntityRevision,
  CommerceEntityTypeId,
  CommerceMerchantId,
  CommercePrincipalId,
  CommerceRelationshipRef,
  CommerceSnapshotRevision,
  CommerceTimestamp,
  CustomCommerceEntityId,
  CustomCommerceEntityTypeId,
  CustomCommerceRelationshipRef,
  ListEntryAttributeValue,
  PublishedCommerceSelectorId,
  PublishedCommerceSelectorRevision,
  RelationshipDefinitionId,
  RelationshipDefinitionRef,
  SystemCommerceRelationshipRef,
  RelationshipDefinitionRevision,
  RelationshipId,
  RelationshipRevision,
  SavedCommerceViewId,
  SavedCommerceViewRevision,
  SystemCommerceEntityKind,
  SystemCommerceEntityRef,
  SystemSchemaRevision,
} from "@purin-labs/commerce-contracts";
import type { VariantBy } from "@purin-labs/type-utils";
import { exhaustiveList, isNormalizedText, isRecord } from "@purin-labs/std";
import {
  parseWireCustomCommerceRelationshipRef as parseCustomCommerceRelationshipRefRecord,
  parseListEntryAttributeValue as parseListEntryAttributeValueRecord,
} from "@purin-labs/commerce-contracts/records/entity-plane";
import { decodeRecord } from "./record-decoding.ts";

export const SYSTEM_KINDS = exhaustiveList<SystemCommerceEntityKind>()([
  "location",
  "product",
  "sellable_variant",
  "offer",
  "inventory_item",
  "stock_policy",
  "menu",
  "recipe_revision",
  "preparation_ticket",
  "production_batch",
  "order",
  "payment",
  "fulfillment",
  "shipment",
  "sales_channel",
  "inventory_position",
  "inventory_movement",
  "inventory_lot",
  "inventory_consumption_plan",
  "inventory_consumption_requirement",
  "modifier_group_revision",
  "preparation_station",
]);

export function parseCommerceSnapshotRevision(
  value: unknown,
  field = "commerceSnapshotRevision",
): CommerceSnapshotRevision {
  return brandNonNegativeRevision<CommerceSnapshotRevision>(value, field);
}

export function parseCommerceEntityRevision(
  value: unknown,
  field = "commerceEntityRevision",
): CommerceEntityRevision {
  return brandRevision<CommerceEntityRevision>(value, field);
}

export function parseSavedCommerceViewRevision(
  value: unknown,
  field = "savedCommerceViewRevision",
): SavedCommerceViewRevision {
  return brandRevision<SavedCommerceViewRevision>(value, field);
}

export function parseSavedCommerceViewId(
  value: unknown,
  field = "savedCommerceViewId",
): SavedCommerceViewId {
  return brandText<SavedCommerceViewId>(value, field);
}

export function parseCommerceMerchantId(
  value: unknown,
  field = "merchantId",
): CommerceMerchantId {
  return brandText<CommerceMerchantId>(value, field);
}

export function parseCommercePrincipalId(
  value: unknown,
  field = "principalId",
): CommercePrincipalId {
  return brandText<CommercePrincipalId>(value, field);
}

export function parseCommerceCommandId(
  value: unknown,
  field = "commandId",
): CommerceCommandId {
  return brandText<CommerceCommandId>(value, field);
}

export function parseCommerceTimestamp(
  value: unknown,
  field = "timestamp",
): CommerceTimestamp {
  return parseRfc3339Timestamp(value, field);
}

export function parsePublishedCommerceSelectorId(
  value: unknown,
  field = "selectorId",
): PublishedCommerceSelectorId {
  return brandText<PublishedCommerceSelectorId>(value, field);
}

export function parsePublishedCommerceSelectorRevision(
  value: unknown,
  field = "selectorRevision",
): PublishedCommerceSelectorRevision {
  return brandRevision<PublishedCommerceSelectorRevision>(value, field);
}

export function parseAttributeDefinitionRevision(
  value: unknown,
  field = "attributeDefinitionRevision",
): AttributeDefinitionRevision {
  return brandRevision<AttributeDefinitionRevision>(value, field);
}

export function parseAttributeDefinitionId(
  value: unknown,
  field = "attributeDefinitionId",
): AttributeDefinitionId {
  return brandText<AttributeDefinitionId>(value, field);
}

export function parseAttributeOptionId(
  value: unknown,
  field = "attributeOptionId",
): AttributeOptionId {
  return brandText<AttributeOptionId>(value, field);
}

export function parseRelationshipDefinitionRevision(
  value: unknown,
  field = "relationshipDefinitionRevision",
): RelationshipDefinitionRevision {
  return brandRevision<RelationshipDefinitionRevision>(value, field);
}

export function parseRelationshipRevision(
  value: unknown,
  field = "relationshipRevision",
): RelationshipRevision {
  return brandRevision<RelationshipRevision>(value, field);
}

export function parseSystemSchemaRevision(
  value: unknown,
  field = "systemSchemaRevision",
): SystemSchemaRevision {
  return brandRevision<SystemSchemaRevision>(value, field);
}

export function parseRelationshipId(
  value: unknown,
  field = "relationshipId",
): RelationshipId {
  return brandText<RelationshipId>(value, field);
}

export function parseEntityRef(value: unknown): CommerceEntityRef {
  const object = strictObjectValue(value, "entityRef", [
    "origin",
    "typeId",
    "entityId",
  ]);
  const origin = enumValue(object.origin, "entityRef.origin", [
    "system",
    "custom",
  ] as const);
  return origin === "custom"
    ? {
        origin,
        typeId: brandText<CustomCommerceEntityTypeId>(
          object.typeId,
          "entityRef.typeId",
        ),
        entityId: brandText<CustomCommerceEntityId>(
          object.entityId,
          "entityRef.entityId",
        ),
      }
    : parseSystemEntityRef(
        enumValue(object.typeId, "entityRef.typeId", SYSTEM_KINDS),
        object.entityId,
      );
}

export function parseSystemEntityRef(
  typeId: SystemCommerceEntityKind,
  entityId: unknown,
): SystemCommerceEntityRef {
  const value = normalizedText(entityId, "systemEntityRef.entityId");
  switch (typeId) {
    case "location":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<SystemCommerceEntityRef, "typeId", "location">["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "product":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<SystemCommerceEntityRef, "typeId", "product">["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "sellable_variant":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "sellable_variant"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "offer":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<SystemCommerceEntityRef, "typeId", "offer">["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "inventory_item":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "inventory_item"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "stock_policy":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "stock_policy"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "menu":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<SystemCommerceEntityRef, "typeId", "menu">["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "recipe_revision":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "recipe_revision"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "preparation_ticket":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "preparation_ticket"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "production_batch":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "production_batch"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "order":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<SystemCommerceEntityRef, "typeId", "order">["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "payment":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<SystemCommerceEntityRef, "typeId", "payment">["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "fulfillment":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "fulfillment"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "shipment":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<SystemCommerceEntityRef, "typeId", "shipment">["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "sales_channel":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "sales_channel"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "inventory_position":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "inventory_position"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "inventory_movement":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "inventory_movement"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "inventory_lot":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "inventory_lot"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "inventory_consumption_plan":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "inventory_consumption_plan"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "inventory_consumption_requirement":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "inventory_consumption_requirement"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "modifier_group_revision":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "modifier_group_revision"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
    case "preparation_station":
      return {
        origin: "system",
        typeId,
        entityId: brandText<
          VariantBy<
            SystemCommerceEntityRef,
            "typeId",
            "preparation_station"
          >["entityId"]
        >(value, "systemEntityRef.entityId"),
      };
  }
}

export function parseEntityTypeId(value: unknown): CommerceEntityTypeId {
  const object = objectValue(value, "entityTypeId");
  const origin = enumValue(object.origin, "entityTypeId.origin", [
    "system",
    "custom",
  ] as const);
  return origin === "system"
    ? {
        origin,
        typeId: enumValue(object.typeId, "entityTypeId.typeId", SYSTEM_KINDS),
      }
    : {
        origin,
        typeId: brandText<CustomCommerceEntityTypeId>(
          object.typeId,
          "entityTypeId.typeId",
        ),
      };
}

function parseRelationshipDefinitionRef(
  value: unknown,
): RelationshipDefinitionRef {
  const object = strictObjectValue(value, "relationshipDefinition", [
    "origin",
    "definitionId",
    "revision",
  ]);
  const origin = enumValue(object.origin, "relationshipDefinition.origin", [
    "system",
    "custom",
  ] as const);
  return origin === "system"
    ? {
        origin,
        definitionId: enumValue(
          object.definitionId,
          "relationshipDefinition.definitionId",
          [
            "order_shipment",
            "order_fulfillment",
            "fulfillment_shipment",
            "recipe_revision_production_batch",
            "production_batch_recipe_revision",
            "shipment_production_batch",
          ] as const,
        ),
        revision: brandRevision<RelationshipDefinitionRevision>(
          object.revision,
          "relationshipDefinition.revision",
        ),
      }
    : {
        origin,
        definitionId: brandText<RelationshipDefinitionId>(
          object.definitionId,
          "relationshipDefinition.definitionId",
        ),
        revision: brandRevision<RelationshipDefinitionRevision>(
          object.revision,
          "relationshipDefinition.revision",
        ),
      };
}

export function parseCommerceRelationshipRef(
  value: unknown,
): CommerceRelationshipRef {
  const object = strictObjectValue(value, "relationshipRef", [
    "origin",
    "relationshipId",
    "definition",
    "revision",
  ]);
  const relationshipId = brandText<RelationshipId>(
    object.relationshipId,
    "relationshipRef.relationshipId",
  );
  const definition = parseRelationshipDefinitionRef(object.definition);
  const revision = brandRevision<RelationshipRevision>(
    object.revision,
    "relationshipRef.revision",
  );
  if (definition.origin === "custom")
    return {
      origin: "custom",
      relationshipId,
      definition,
      revision,
    } satisfies CustomCommerceRelationshipRef;
  return {
    origin: "system",
    relationshipId,
    definition,
    revision,
  } satisfies SystemCommerceRelationshipRef;
}

export function parseCustomCommerceRelationshipRef(
  value: unknown,
): CustomCommerceRelationshipRef {
  return decodeRecord(parseCustomCommerceRelationshipRefRecord, value);
}

export function parseListEntryAttributeValue(
  value: unknown,
): ListEntryAttributeValue {
  return decodeRecord(parseListEntryAttributeValueRecord, value);
}

function parseRfc3339Timestamp(
  value: unknown,
  field: string,
): CommerceTimestamp {
  const timestamp = brandText<CommerceTimestamp>(value, field);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(
      timestamp,
    );
  if (match === null) throw new Error(`${field} must be an RFC3339 timestamp`);
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    // Fractional seconds are checked by the pattern and otherwise ignored.
    offsetText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offset = offsetText ?? "";
  const offsetHours = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinutes = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  const daysInMonth =
    month === 2
      ? (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  ) {
    throw new Error(`${field} must be a valid RFC3339 timestamp`);
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds))
    throw new Error(`${field} must be a valid RFC3339 timestamp`);
  return timestamp;
}

export function requireUniqueValues(
  values: readonly (string | number)[],
  field: string,
): void {
  if (new Set(values.map(String)).size !== values.length)
    throw new Error(`${field} contains duplicate values`);
}

export function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

export function objectValue(
  value: unknown,
  field: string,
): Readonly<{ [key: string]: unknown }> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

export function strictObjectValue(
  value: unknown,
  field: string,
  fields: readonly string[],
): Readonly<{ [key: string]: unknown }> {
  const object = objectValue(value, field);
  if (Object.keys(object).some((key) => !fields.includes(key)))
    throw new Error(`${field} has unsupported fields`);
  return object;
}

export function arrayValue(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

export function normalizedText(value: unknown, field: string): string {
  if (!isNormalizedText(value))
    throw new Error(`${field} must be normalized text`);
  return value;
}

export function brandText<T extends string>(value: unknown, field: string): T {
  const text = normalizedText(value, field);
  if (!isTextBrand<T>(text))
    throw new Error(`${field} has an invalid identity`);
  return text;
}

function isTextBrand<T extends string>(value: string): value is T {
  return value.length > 0 && value === value.trim();
}

function safeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`${field} must be a safe integer`);
  return value;
}

function boundedPositive(
  value: unknown,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const result = safeInteger(value, field);
  if (result < 1 || result > maximum)
    throw new Error(`${field} is out of bounds`);
  return result;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const result = safeInteger(value, field);
  if (result < 0) throw new Error(`${field} must be non-negative`);
  return result;
}

export function brandRevision<T extends number>(
  value: unknown,
  field: string,
): T {
  const revision = boundedPositive(value, field);
  if (!isRevisionBrand<T>(revision))
    throw new Error(`${field} has an invalid revision`);
  return revision;
}

function isRevisionBrand<T extends number>(value: number): value is T {
  return Number.isSafeInteger(value) && value > 0;
}

function brandNonNegativeRevision<T extends number>(
  value: unknown,
  field: string,
): T {
  const revision = nonNegativeInteger(value, field);
  if (!isNonNegativeRevision<T>(revision))
    throw new Error(`${field} has an invalid revision`);
  return revision;
}

function isNonNegativeRevision<T extends number>(value: number): value is T {
  return Number.isSafeInteger(value) && value >= 0;
}

export function enumValue<const T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
): T {
  const text = normalizedText(value, field);
  if (!contains(values, text)) throw new Error(`${field} is unsupported`);
  return text;
}

function contains<T extends string>(
  values: readonly T[],
  value: string,
): value is T {
  return values.some((entry) => entry === value);
}

import type {
  AttributeDefinition,
  AttributeDefinitionId,
  AttributeDefinitionKind,
  AttributeDefinitionScope,
  AttributeDefinitionRevision,
  AttributeOption,
  AttributeOptionId,
  AttributeValue,
  AttributeValueAssignment,
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
  CustomCommerceEntityRef,
  CustomCommerceEntityTypeId,
  CustomCommerceRelationshipRef,
  CustomEntityTypeRevision,
  DecimalValue,
  ExternalResourceReference,
  ListEntryAttributeDefinition,
  ListEntryAttributeValue,
  MerchantOperatorReference,
  MerchantExtensionSchemaRevision,
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
  SourceProvenance,
  SystemCommerceEntityKind,
  SystemCommerceEntityRef,
  SystemSchemaRevision,
} from "@seams/commerce-contracts";
import type { Variant, VariantBy } from "@seams/type-utils";
import { exhaustiveList, isNormalizedText, isRecord } from "@seams/std";
import {
  parseAttributeOption as parseAttributeOptionRecord,
  parseAttributeValue as parseAttributeValueRecord,
  parseAttributeValueAssignment as parseAttributeValueAssignmentRecord,
  parseWireCustomCommerceRelationshipRef as parseCustomCommerceRelationshipRefRecord,
  parseExternalResourceReference as parseExternalResourceReferenceRecord,
  parseListEntryAttributeValue as parseListEntryAttributeValueRecord,
  parseMerchantOperatorReference as parseMerchantOperatorReferenceRecord,
} from "@seams/commerce-contracts/records/entity-plane";
import { parseSourceProvenance as parseSourceProvenanceRecord } from "@seams/commerce-contracts/records/provenance";
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

export function parseCustomEntityRef(value: unknown): CustomCommerceEntityRef {
  const reference = parseEntityRef(value);
  if (reference.origin !== "custom")
    throw new Error("custom entity reference is required");
  return reference;
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

export function parseAttributeScope(
  value: unknown,
  field: string,
): AttributeDefinitionScope {
  const object = objectValue(value, field);
  const kind = enumValue(object.kind, `${field}.kind`, [
    "system",
    "merchant_extension",
    "custom",
  ] as const);
  switch (kind) {
    case "system":
      return {
        kind,
        entityTypeId: enumValue(
          object.entityTypeId,
          `${field}.entityTypeId`,
          SYSTEM_KINDS,
        ),
        schemaRevision: brandRevision<SystemSchemaRevision>(
          object.schemaRevision,
          `${field}.schemaRevision`,
        ),
      };
    case "merchant_extension":
      return {
        kind,
        entityTypeId: enumValue(
          object.entityTypeId,
          `${field}.entityTypeId`,
          SYSTEM_KINDS,
        ),
        schemaRevision: brandRevision<MerchantExtensionSchemaRevision>(
          object.schemaRevision,
          `${field}.schemaRevision`,
        ),
      };
    case "custom":
      return {
        kind,
        entityTypeId: brandText<CustomCommerceEntityTypeId>(
          object.entityTypeId,
          `${field}.entityTypeId`,
        ),
        typeRevision: brandRevision<CustomEntityTypeRevision>(
          object.typeRevision,
          `${field}.typeRevision`,
        ),
      };
  }
}

export function sameEntityTypeId(
  left: CommerceEntityTypeId,
  right: CommerceEntityTypeId,
): boolean {
  return left.origin === right.origin && left.typeId === right.typeId;
}

export function parseRelationshipDefinitionRef(
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

export function parseAttributeAssignment(
  value: unknown,
): AttributeValueAssignment {
  return decodeRecord(parseAttributeValueAssignmentRecord, value);
}

export function parseListEntryAttributeDefinition(
  value: unknown,
): ListEntryAttributeDefinition {
  const object = objectValue(value, "listEntryAttributeDefinition");
  return {
    attributeId: brandText<AttributeDefinitionId>(
      object.attributeId,
      "listEntryAttributeDefinition.attributeId",
    ),
    definition: parseAttributeDefinition(object.definition),
  };
}

export function parseListEntryAttributeValue(
  value: unknown,
): ListEntryAttributeValue {
  return decodeRecord(parseListEntryAttributeValueRecord, value);
}

export function parseAttributeDefinition(value: unknown): AttributeDefinition {
  const object = objectValue(value, "attributeDefinition");
  return {
    id: brandText<AttributeDefinitionId>(object.id, "attributeDefinition.id"),
    scope: parseAttributeScope(object.scope, "attributeDefinition.scope"),
    label: normalizedText(object.label, "attributeDefinition.label"),
    helpText: nullable(object.helpText, (entry) =>
      normalizedText(entry, "attributeDefinition.helpText"),
    ),
    required: booleanValue(object.required, "attributeDefinition.required"),
    sensitivity: parseSensitivity(
      object.sensitivity,
      "attributeDefinition.sensitivity",
    ),
    kind: parseAttributeDefinitionKind(object.kind),
    revision: brandRevision<AttributeDefinitionRevision>(
      object.revision,
      "attributeDefinition.revision",
    ),
  };
}

export function parseAttributeDefinitionKind(
  value: unknown,
): AttributeDefinitionKind {
  const object = objectValue(value, "attributeDefinition.kind");
  const kind = enumValue(object.kind, "attributeDefinition.kind.kind", [
    "short_text",
    "long_text",
    "integer",
    "decimal",
    "boolean",
    "date",
    "timestamp",
    "status",
    "choice",
    "money",
    "merchant_operator_reference",
    "external_resource_reference",
  ] as const);
  switch (kind) {
    case "short_text":
      return {
        kind,
        maxLength: boundedPositive(
          object.maxLength,
          "attributeDefinition.kind.maxLength",
        ),
      };
    case "long_text":
      return {
        kind,
        maxLength: boundedPositive(
          object.maxLength,
          "attributeDefinition.kind.maxLength",
        ),
      };
    case "integer":
      return {
        kind,
        minimum: nullable(object.minimum, (entry) =>
          safeInteger(entry, "attributeDefinition.kind.minimum"),
        ),
        maximum: nullable(object.maximum, (entry) =>
          safeInteger(entry, "attributeDefinition.kind.maximum"),
        ),
      };
    case "decimal":
      return {
        kind,
        scale: boundedPositive(object.scale, "attributeDefinition.kind.scale"),
        minimum: nullable(object.minimum, (entry) =>
          parseDecimal(entry, "attributeDefinition.kind.minimum"),
        ),
        maximum: nullable(object.maximum, (entry) =>
          parseDecimal(entry, "attributeDefinition.kind.maximum"),
        ),
      };
    case "boolean":
    case "date":
    case "timestamp":
    case "merchant_operator_reference":
    case "external_resource_reference":
      return { kind };
    case "status":
      return {
        kind,
        options: arrayValue(
          object.options,
          "attributeDefinition.kind.options",
        ).map(parseAttributeOption),
      };
    case "choice":
      return {
        kind,
        options: arrayValue(
          object.options,
          "attributeDefinition.kind.options",
        ).map(parseAttributeOption),
        allowsMultiple: booleanValue(
          object.allowsMultiple,
          "attributeDefinition.kind.allowsMultiple",
        ),
      };
    case "money":
      return {
        kind,
        allowedCurrencies: arrayValue(
          object.allowedCurrencies,
          "attributeDefinition.kind.allowedCurrencies",
        ).map((entry) =>
          brandText<
            Variant<
              AttributeDefinitionKind,
              "money"
            >["allowedCurrencies"][number]
          >(entry, "attributeDefinition.kind.allowedCurrencies[]"),
        ),
      };
  }
}

export function parseAttributeOption(value: unknown): AttributeOption {
  return decodeRecord(parseAttributeOptionRecord, value);
}

export function parseAttributeValue(value: unknown): AttributeValue {
  return decodeRecord(parseAttributeValueRecord, value);
}

function parseDecimal(value: unknown, field: string): DecimalValue {
  const object = objectValue(value, field);
  return {
    unscaled: safeInteger(object.unscaled, `${field}.unscaled`),
    scale: safeInteger(object.scale, `${field}.scale`),
  };
}

export function parseMoney(value: unknown) {
  const object = objectValue(value, "money");
  return {
    amountMinor: safeInteger(object.amountMinor, "money.amountMinor"),
    currency: parseCurrencyCode(object.currency),
  };
}

export function parseCurrencyCode(
  value: unknown,
  field = "money.currency",
): import("@seams/commerce-contracts").CurrencyCode {
  const currency = normalizedText(value, field);
  if (
    currency.length !== 3 ||
    !currency
      .split("")
      .every((character) => character >= "A" && character <= "Z")
  ) {
    throw new Error(`${field} must be an uppercase ISO currency code`);
  }
  return currency;
}

export function parseMerchantOperatorReference(
  value: unknown,
): MerchantOperatorReference {
  return decodeRecord(parseMerchantOperatorReferenceRecord, value);
}

export function parseExternalResourceReference(
  value: unknown,
): ExternalResourceReference {
  return decodeRecord(parseExternalResourceReferenceRecord, value);
}

export function parseProvenance(value: unknown): SourceProvenance {
  return decodeRecord(parseSourceProvenanceRecord, value);
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

export function parseSensitivity(value: unknown, field: string) {
  return enumValue(value, field, [
    "public",
    "internal",
    "confidential",
    "restricted",
  ] as const);
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

export function sha256Digest(value: unknown, field: string): string {
  const digest = normalizedText(value, field);
  if (!/^[a-f0-9]{64}$/u.test(digest))
    throw new Error(`${field} must be a lowercase SHA-256 digest`);
  return digest;
}

export function boundedText(
  value: unknown,
  field: string,
  maximum: number,
): string {
  const text = normalizedText(value, field);
  if (text.length > maximum) throw new Error(`${field} is too long`);
  return text;
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

export function safeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`${field} must be a safe integer`);
  return value;
}

export function boundedPositive(
  value: unknown,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const result = safeInteger(value, field);
  if (result < 1 || result > maximum)
    throw new Error(`${field} is out of bounds`);
  return result;
}

export function boundedNonNegative(
  value: unknown,
  field: string,
  maximum: number,
): number {
  const result = safeInteger(value, field);
  if (result < 0 || result > maximum)
    throw new Error(`${field} is out of bounds`);
  return result;
}

export function positiveInteger(value: unknown, field: string): number {
  return boundedPositive(value, field);
}

export function nonNegativeInteger(value: unknown, field: string): number {
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

export function brandNonNegativeRevision<T extends number>(
  value: unknown,
  field: string,
): T {
  const revision = nonNegativeInteger(value, field);
  if (!isNonNegativeRevision<T>(revision))
    throw new Error(`${field} has an invalid revision`);
  return revision;
}

export function isNonNegativeRevision<T extends number>(
  value: number,
): value is T {
  return Number.isSafeInteger(value) && value >= 0;
}

export function nullable<T>(
  value: unknown,
  parser: (value: unknown) => T,
): T | null {
  return value === null || value === undefined ? null : parser(value);
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

export function contains<T extends string>(
  values: readonly T[],
  value: string,
): value is T {
  return values.some((entry) => entry === value);
}

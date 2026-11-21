import type {
  AttributeDefinition,
  AttributeDefinitionId,
  AttributeDefinitionKind,
  AttributeDefinitionScope,
  AttributeDefinitionRevision,
  AttributeOptionId,
  AttributeValue,
  AttributeValueAssignment,
  CommerceCommandId,
  CommerceEntityPlaneCommand,
  CommerceEntityRef,
  CommerceGraphQuery,
  CommerceList,
  CommerceSensitivity,
  CustomCommerceEntityId,
  CustomCommerceEntityRef,
  CustomCommerceEntityTypeId,
  CustomEntityTypeRevision,
  RelationshipDefinitionId,
  RelationshipDefinition,
  RelationshipId,
  SavedCommerceView,
  MerchantExtensionSchemaRevision,
  SystemSchemaRevision,
  SystemCommerceEntityRef,
  LocationEntityId,
  ProductEntityId,
  SellableVariantEntityId,
  OfferEntityId,
  InventoryItemEntityId,
  StockPolicyEntityId,
  RecipeRevisionEntityId,
  PreparationTicketEntityId,
  ProductionBatchEntityId,
  OrderEntityId,
  PaymentEntityId,
  FulfillmentEntityId,
  ShipmentEntityId,
  SalesChannelEntityId,
  InventoryPositionEntityId,
  InventoryMovementEntityId,
  InventoryLotEntityId,
  InventoryConsumptionPlanEntityId,
  InventoryConsumptionRequirementEntityId,
  ModifierGroupRevisionEntityId,
  PreparationStationEntityId,
} from "@purin-labs/commerce-contracts";
import type {
  CommercePrincipalId,
  CommerceSource,
  CommerceTimestamp,
  CurrencyCode,
  Money,
  CommerceSnapshotRevision,
  SourceProvenance,
} from "@purin-labs/commerce-contracts";
import type {
  EntityPlaneChangeRequest,
  EntityPlaneCommandRequest,
  EntityPlaneQueryRequest,
} from "./entity-types.ts";
import {
  validateCommerceEntityAuthorityWithLexicon,
  validateCommerceEntityPlaneCommandWithLexicon,
  validateCommerceListWithLexicon,
  validateCommerceGraphQueryWithLexicon,
  validateRelationshipDefinitionWithLexicon,
  validateSavedCommerceViewWithLexicon,
} from "./lexicon.ts";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import { exhaustiveList, isNormalizedText, isRecord } from "@purin-labs/std";
import { SYSTEM_KINDS } from "@purin-labs/commerce-client";

type BoundaryRecord = { readonly [key: string]: unknown };
type SystemCommerceEntityKind = SystemCommerceEntityRef["typeId"];
type DecimalValue = Variant<AttributeValue, "decimal">["value"];
type MerchantOperatorReference = Variant<
  AttributeValue,
  "merchant_operator_reference"
>["value"];
type SharedExternalResourceReference = Variant<
  AttributeValue,
  "external_resource_reference"
>["value"];
type AttributeValueKind = AttributeValue["kind"];
type MenuEntityId = VariantBy<
  SystemCommerceEntityRef,
  "typeId",
  "menu"
>["entityId"];

const ATTRIBUTE_KINDS = exhaustiveList<AttributeValueKind>()([
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
]);

export function parseEntityPlaneQueryRequest(
  value: unknown,
): EntityPlaneQueryRequest {
  const object = objectValue(value, "queryRequest");
  return {
    merchantId: normalizedText(object.merchantId, "queryRequest.merchantId"),
    query: parseCommerceGraphQuery(object.query),
  };
}

function parseCommerceGraphQuery(value: unknown): CommerceGraphQuery {
  validateCommerceGraphQueryWithLexicon(value);
  return value;
}

export function parseEntityPlaneCommandRequest(
  value: unknown,
  now: CommerceTimestamp,
): EntityPlaneCommandRequest {
  const object = objectValue(value, "commandRequest");
  const authority = object.authority;
  validateCommerceEntityAuthorityWithLexicon(authority, now);
  return {
    organisationId: normalizedText(
      object.organisationId,
      "commandRequest.organisationId",
    ),
    merchantId: normalizedText(object.merchantId, "commandRequest.merchantId"),
    commandId: brandedText<CommerceCommandId>(
      object.commandId,
      "commandRequest.commandId",
    ),
    expectedMerchantRevision:
      brandedNonNegativeRevision<CommerceSnapshotRevision>(
        object.expectedMerchantRevision,
        "commandRequest.expectedMerchantRevision",
      ),
    authority,
    command: parseCommerceEntityPlaneCommand(object.command),
  };
}

export function parseSnapshotRevision<T extends CommerceSnapshotRevision>(
  value: unknown,
  field: string,
): T {
  return brandedNonNegativeRevision<T>(value, field);
}

export function parseSourceProvenance(
  value: unknown,
  field = "provenance",
): SourceProvenance {
  const object = objectValue(value, field);
  const occurredAt = parseCommerceTimestamp(
    object.occurredAt,
    `${field}.occurredAt`,
  );
  const observedAt = parseCommerceTimestamp(
    object.observedAt,
    `${field}.observedAt`,
  );
  if (Date.parse(observedAt) < Date.parse(occurredAt))
    throw new Error(`${field}.observedAt must not precede occurredAt`);
  return {
    organisationId: brandedText(
      object.organisationId,
      `${field}.organisationId`,
    ),
    integrationAccountId: brandedText(
      object.integrationAccountId,
      `${field}.integrationAccountId`,
    ),
    source: enumValue(object.source, `${field}.source`, [
      "shopify",
      "stripe",
      "lab",
      "underclerk",
    ] as const),
    resourceType: enumValue(object.resourceType, `${field}.resourceType`, [
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
    ] as const),
    resourceId: brandedText(object.resourceId, `${field}.resourceId`),
    revision: parsePositiveRevision(object.revision, `${field}.revision`),
    occurredAt,
    observedAt,
  };
}

export function parseCommerceTimestamp(
  value: unknown,
  field: string,
): CommerceTimestamp {
  const timestamp = normalizedText(value, field);
  if (
    Number.isNaN(Date.parse(timestamp)) ||
    !/^\d{4}-\d{2}-\d{2}T[^\s]+(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)
  ) {
    throw new Error(`${field} must be an RFC3339 timestamp`);
  }
  return brandedText<CommerceTimestamp>(
    new Date(timestamp).toISOString(),
    field,
  );
}

export function parseCommerceEntityPlaneCommand(
  value: unknown,
): CommerceEntityPlaneCommand {
  validateCommerceEntityPlaneCommandWithLexicon(value);
  return value;
}

export function parseEntityPlaneChangeRequest(
  value: unknown,
): EntityPlaneChangeRequest {
  const object = objectValue(value, "changeRequest");
  return {
    merchantId: normalizedText(object.merchantId, "changeRequest.merchantId"),
    afterMerchantRevision: parseSnapshotRevision(
      object.afterMerchantRevision,
      "changeRequest.afterMerchantRevision",
    ),
    limit: boundedLimit(object.limit, "changeRequest.limit"),
  };
}

export function parseEntityRef(value: unknown): CommerceEntityRef {
  const object = objectValue(value, "entityRef");
  const origin = enumValue(object.origin, "entityRef.origin", [
    "system",
    "custom",
  ] as const);
  if (origin === "custom") {
    return {
      origin,
      typeId: brandedText<CustomCommerceEntityTypeId>(
        object.typeId,
        "entityRef.typeId",
      ),
      entityId: brandedText<CustomCommerceEntityId>(
        object.entityId,
        "entityRef.entityId",
      ),
    } satisfies CustomCommerceEntityRef;
  }
  const typeId = enumValue(object.typeId, "entityRef.typeId", SYSTEM_KINDS);
  return parseSystemEntityRef(typeId, object.entityId);
}

function parseAttributeScope(
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
        schemaRevision: brandedRevision<SystemSchemaRevision>(
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
        schemaRevision: brandedRevision<MerchantExtensionSchemaRevision>(
          object.schemaRevision,
          `${field}.schemaRevision`,
        ),
      };
    case "custom":
      return {
        kind,
        entityTypeId: brandedText<CustomCommerceEntityTypeId>(
          object.entityTypeId,
          `${field}.entityTypeId`,
        ),
        typeRevision: brandedRevision<CustomEntityTypeRevision>(
          object.typeRevision,
          `${field}.typeRevision`,
        ),
      };
  }
}

export function parseAttributeDefinition(value: unknown): AttributeDefinition {
  const object = objectValue(value, "attributeDefinition");
  return {
    id: brandedText<AttributeDefinitionId>(object.id, "attributeDefinition.id"),
    scope: parseAttributeScope(object.scope, "attributeDefinition.scope"),
    label: boundedText(object.label, "attributeDefinition.label", 120),
    helpText: nullableValue(object.helpText, (entry) =>
      boundedText(entry, "attributeDefinition.helpText", 500),
    ),
    required: booleanValue(object.required, "attributeDefinition.required"),
    sensitivity: parseSensitivity(
      object.sensitivity,
      "attributeDefinition.sensitivity",
    ),
    kind: parseAttributeDefinitionKind(object.kind),
    revision: brandedRevision<AttributeDefinitionRevision>(
      object.revision,
      "attributeDefinition.revision",
    ),
  };
}

export function parseRelationshipId(
  value: unknown,
  field = "relationshipId",
): RelationshipId {
  return brandedText<RelationshipId>(value, field);
}

export function parseRelationshipDefinitionId(
  value: unknown,
  field = "relationshipDefinitionId",
): RelationshipDefinitionId {
  return brandedText<RelationshipDefinitionId>(value, field);
}

export function parseRelationshipDefinition(
  value: unknown,
): RelationshipDefinition {
  validateRelationshipDefinitionWithLexicon(value);
  return value;
}

export function parseCustomEntityTypeDraft(value: unknown) {
  const object = objectValue(value, "customEntityType");
  const typeId = brandedText<CustomCommerceEntityTypeId>(
    object.typeId,
    "customEntityType.typeId",
  );
  const attributes = arrayValue(
    object.attributes,
    "customEntityType.attributes",
  ).map(parseAttributeDefinition);
  requireUniqueAttributeIds(attributes);
  for (const attribute of attributes) {
    if (
      attribute.scope.kind !== "custom" ||
      attribute.scope.entityTypeId !== typeId
    )
      throw new Error(
        `customEntityType attribute scope is invalid: ${attribute.id}`,
      );
  }
  return {
    typeId,
    label: boundedText(object.label, "customEntityType.label", 120),
    description: boundedText(
      object.description,
      "customEntityType.description",
      1000,
    ),
    attributes,
  };
}

function parseAttributeDefinitionKind(value: unknown): AttributeDefinitionKind {
  const object = objectValue(value, "attributeDefinition.kind");
  const kind = enumValue(
    object.kind,
    "attributeDefinition.kind.kind",
    ATTRIBUTE_KINDS,
  );
  switch (kind) {
    case "short_text":
      return {
        kind,
        maxLength: boundedPositive(
          object.maxLength,
          "attributeDefinition.kind.maxLength",
          10_000,
        ),
      };
    case "long_text":
      return {
        kind,
        maxLength: boundedPositive(
          object.maxLength,
          "attributeDefinition.kind.maxLength",
          100_000,
        ),
      };
    case "integer":
      return {
        kind,
        minimum: nullableSafeInteger(
          object.minimum,
          "attributeDefinition.kind.minimum",
        ),
        maximum: nullableSafeInteger(
          object.maximum,
          "attributeDefinition.kind.maximum",
        ),
      };
    case "decimal":
      return {
        kind,
        scale: boundedPositive(
          object.scale,
          "attributeDefinition.kind.scale",
          6,
        ),
        minimum: nullableDecimalValue(
          object.minimum,
          "attributeDefinition.kind.minimum",
        ),
        maximum: nullableDecimalValue(
          object.maximum,
          "attributeDefinition.kind.maximum",
        ),
      };
    case "boolean":
      return { kind };
    case "date":
      return { kind };
    case "timestamp":
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
        ).map(parseCurrencyCode),
      };
    case "merchant_operator_reference":
      return { kind };
    case "external_resource_reference":
      return { kind };
  }
}

export function parseAttributeValue(value: unknown): AttributeValue {
  const object = objectValue(value, "attributeValue");
  const kind = enumValue(object.kind, "attributeValue.kind", ATTRIBUTE_KINDS);
  switch (kind) {
    case "short_text":
      return {
        kind,
        value: boundedText(object.value, "attributeValue.value", 10_000),
      };
    case "long_text":
      return {
        kind,
        value: boundedText(object.value, "attributeValue.value", 100_000),
      };
    case "integer":
      return {
        kind,
        value: BigInt(safeInteger(object.value, "attributeValue.value")),
      };
    case "decimal":
      return {
        kind,
        value: parseDecimalValue(object.value, "attributeValue.value"),
      };
    case "boolean":
      return {
        kind,
        value: booleanValue(object.value, "attributeValue.value"),
      };
    case "date":
      return {
        kind,
        value: normalizedText(object.value, "attributeValue.value"),
      };
    case "timestamp":
      return {
        kind,
        value: normalizedText(object.value, "attributeValue.value"),
      };
    case "status":
      return {
        kind,
        value: brandedText<AttributeOptionId>(
          object.value,
          "attributeValue.value",
        ),
      };
    case "choice":
      return {
        kind,
        values: arrayValue(object.values, "attributeValue.values").map(
          (entry) =>
            brandedText<AttributeOptionId>(entry, "attributeValue.values[]"),
        ),
      };
    case "money":
      return { kind, value: parseMoney(object.value) };
    case "merchant_operator_reference":
      return { kind, value: parseMerchantOperatorReference(object.value) };
    case "external_resource_reference":
      return { kind, value: parseExternalResourceReference(object.value) };
  }
}

export function parseAttributeAssignment(
  value: unknown,
): AttributeValueAssignment {
  const object = objectValue(value, "attributeAssignment");
  return {
    attributeId: brandedText<AttributeDefinitionId>(
      object.attributeId,
      "attributeAssignment.attributeId",
    ),
    scope: parseAttributeScope(object.scope, "attributeAssignment.scope"),
    definitionRevision: brandedRevision<AttributeDefinitionRevision>(
      object.definitionRevision,
      "attributeAssignment.definitionRevision",
    ),
    sensitivity: parseSensitivity(
      object.sensitivity,
      "attributeAssignment.sensitivity",
    ),
    value: parseAttributeValue(object.value),
  };
}

export function parseSavedCommerceView(value: unknown): SavedCommerceView {
  validateSavedCommerceViewWithLexicon(value);
  return value;
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
        entityId: brandedText<LocationEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "product":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<ProductEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "sellable_variant":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<SellableVariantEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "offer":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<OfferEntityId>(value, "systemEntityRef.entityId"),
      };
    case "inventory_item":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<InventoryItemEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "stock_policy":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<StockPolicyEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "menu":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<MenuEntityId>(value, "systemEntityRef.entityId"),
      };
    case "recipe_revision":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<RecipeRevisionEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "preparation_ticket":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<PreparationTicketEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "production_batch":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<ProductionBatchEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "order":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<OrderEntityId>(value, "systemEntityRef.entityId"),
      };
    case "payment":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<PaymentEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "fulfillment":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<FulfillmentEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "shipment":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<ShipmentEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "sales_channel":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<SalesChannelEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "inventory_position":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<InventoryPositionEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "inventory_movement":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<InventoryMovementEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "inventory_lot":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<InventoryLotEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "inventory_consumption_plan":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<InventoryConsumptionPlanEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "inventory_consumption_requirement":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<InventoryConsumptionRequirementEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "modifier_group_revision":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<ModifierGroupRevisionEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
    case "preparation_station":
      return {
        origin: "system",
        typeId,
        entityId: brandedText<PreparationStationEntityId>(
          value,
          "systemEntityRef.entityId",
        ),
      };
  }
}

export function parseCommerceList(value: unknown): CommerceList {
  validateCommerceListWithLexicon(value);
  return value;
}

function requireUniqueAttributeIds(
  values: readonly AttributeDefinition[],
): void {
  const ids = values.map((value) => value.id);
  if (new Set(ids).size !== ids.length)
    throw new Error("customEntityType.attributes contains duplicate ids");
}

function parseAttributeOption(value: unknown) {
  const object = objectValue(value, "attributeOption");
  return {
    id: brandedText<AttributeOptionId>(object.id, "attributeOption.id"),
    label: boundedText(object.label, "attributeOption.label", 120),
  };
}

function parseDecimalValue(value: unknown, field: string): DecimalValue {
  const object = objectValue(value, field);
  return {
    unscaled: safeInteger(object.unscaled, `${field}.unscaled`),
    scale: boundedNonNegative(object.scale, `${field}.scale`, 6),
  };
}

function nullableDecimalValue(
  value: unknown,
  field: string,
): DecimalValue | null {
  return nullableValue(value, (entry) => parseDecimalValue(entry, field));
}

function nullableSafeInteger(value: unknown, field: string): number | null {
  return nullableValue(value, (entry) => safeInteger(entry, field));
}

function parseMoney(value: unknown): Money {
  const object = objectValue(value, "money");
  return {
    amountMinor: safeInteger(object.amountMinor, "money.amountMinor"),
    currency: parseCurrencyCode(object.currency),
  };
}

function parseCurrencyCode(value: unknown): CurrencyCode {
  const currency = normalizedText(value, "money.currency");
  if (
    currency.length !== 3 ||
    !currency
      .split("")
      .every((character) => character >= "A" && character <= "Z")
  ) {
    throw new Error("money.currency must be an uppercase ISO currency code");
  }
  return currency;
}

function parseMerchantOperatorReference(
  value: unknown,
): MerchantOperatorReference {
  const object = objectValue(value, "merchantOperatorReference");
  return {
    principalId: brandedText<CommercePrincipalId>(
      object.principalId,
      "merchantOperatorReference.principalId",
    ),
    displayName: boundedText(
      object.displayName,
      "merchantOperatorReference.displayName",
      200,
    ),
  };
}

function parseExternalResourceReference(
  value: unknown,
): SharedExternalResourceReference {
  const object = objectValue(value, "externalResourceReference");
  return {
    source: enumValue(object.source, "externalResourceReference.source", [
      "shopify",
      "stripe",
      "lab",
      "underclerk",
    ] as readonly CommerceSource[]),
    resourceId: normalizedText(
      object.resourceId,
      "externalResourceReference.resourceId",
    ),
    label: nullableValue(object.label, (entry) =>
      boundedText(entry, "externalResourceReference.label", 200),
    ),
  };
}

export function parseSensitivity(
  value: unknown,
  field: string,
): CommerceSensitivity {
  return enumValue(value, field, [
    "public",
    "internal",
    "confidential",
    "restricted",
  ] as const);
}

function objectValue(value: unknown, field: string): BoundaryRecord {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function arrayValue(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function normalizedText(value: unknown, field: string): string {
  if (!isNormalizedText(value))
    throw new Error(`${field} must be normalized text`);
  return value;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  const result = normalizedText(value, field);
  if (result.length > maximum) throw new Error(`${field} is too long`);
  return result;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function safeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`${field} must be a safe integer`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const result = safeInteger(value, field);
  if (result < 0) throw new Error(`${field} must be non-negative`);
  return result;
}

function brandedNonNegativeRevision<T extends number>(
  value: unknown,
  field: string,
): T {
  const revision = nonNegativeInteger(value, field);
  if (!isNonNegativeRevision<T>(revision))
    throw new Error(`${field} must be a non-negative revision`);
  return revision;
}

function boundedPositive(
  value: unknown,
  field: string,
  maximum: number,
): number {
  const result = safeInteger(value, field);
  if (result < 1 || result > maximum)
    throw new Error(`${field} is out of bounds`);
  return result;
}

function boundedNonNegative(
  value: unknown,
  field: string,
  maximum: number,
): number {
  const result = safeInteger(value, field);
  if (result < 0 || result > maximum)
    throw new Error(`${field} is out of bounds`);
  return result;
}

function boundedLimit(value: unknown, field: string): number {
  return boundedPositive(value, field, 500);
}

function brandedText<T extends string>(value: unknown, field: string): T {
  const text = normalizedText(value, field);
  if (!isBrand<T>(text)) throw new Error(`${field} must be normalized text`);
  return text;
}

function isBrand<T extends string>(value: string): value is T {
  return value.length > 0 && value === value.trim();
}

function brandedRevision<T extends number>(value: unknown, field: string): T {
  const revision = safeInteger(value, field);
  if (revision < 1) throw new Error(`${field} must be positive`);
  if (!isRevision<T>(revision)) throw new Error(`${field} must be positive`);
  return revision;
}

export function parsePositiveRevision<T extends number>(
  value: unknown,
  field: string,
): T {
  return brandedRevision<T>(value, field);
}

export function parsePositiveText<T extends string>(
  value: unknown,
  field: string,
): T {
  return brandedText<T>(value, field);
}

function isRevision<T extends number>(value: number): value is T {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeRevision<T extends number>(value: number): value is T {
  return Number.isSafeInteger(value) && value >= 0;
}

function nullableValue<T>(
  value: unknown,
  parser: (value: unknown) => T,
): T | null {
  return value === null || value === undefined ? null : parser(value);
}

function enumValue<const T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  const text = normalizedText(value, field);
  const match = allowed.find((entry) => entry === text);
  if (match === undefined) throw new Error(`${field} is unsupported`);
  return match;
}

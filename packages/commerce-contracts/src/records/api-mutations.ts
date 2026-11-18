// Plan 78 step 2: the mutation, receipt and delivery records that
// packages/commerce-client reads in src/mutations.ts. Each schema
// follows its hand-written reader; these readers keep the fields they know and
// drop the rest.
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { isRecord } from "@seams/std";
import { boundedTextSchema } from "./fields.ts";
import {
  wireLocationSchema,
  wireOfferSchema,
  wireSalesChannelSchema,
} from "./api-common.ts";
import {
  commerceFulfillmentV1Schema,
  commerceInventoryItemV1Schema,
  commerceInventoryLotV1Schema,
  commerceInventoryMovementV1Schema,
  commerceInventoryPositionV1Schema,
  commerceOrderV1Schema,
  commercePaymentV1Schema,
  commerceProductV1Schema,
  commerceShipmentV1Schema,
  commerceVariantV1Schema,
} from "./api-resources.ts";
import {
  NonNegativeInteger,
  OpenObject,
  type ContractDecodeResult,
  PositiveInteger,
  SafeInteger,
} from "../schema.ts";
import { type CommerceEntityPlaneObservationV1 } from "../commerce-entity-plane.ts";
import { parseCommerceEntityPlaneObservation } from "../entity-plane-observations.ts";
import {
  readCommerceInvalidTransition,
  type CommerceInvalidTransition,
} from "../state-machine.ts";
import { normalizedTextSchema, utcTimestampSchema } from "./fields.ts";
import { BUILT_IN_PLUGIN_RECEIPT_KINDS } from "../commerce-plugins.ts";
import { Nullable } from "./client-wire-fields.ts";
import { commerceFoodServiceObservationV1Schema } from "./api-food-service.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;

// The commerce resources of an aggregate observation, each with the rules of
// its resource reader in commerce-resources.ts.
export const commerceAggregateObservationV1Schema = Type.Union([
  aggregateObservation("location", wireLocationSchema),
  aggregateObservation("sales_channel", wireSalesChannelSchema),
  aggregateObservation("product", commerceProductV1Schema),
  aggregateObservation("sellable_variant", commerceVariantV1Schema),
  aggregateObservation("inventory_item", commerceInventoryItemV1Schema),
  aggregateObservation("offer", wireOfferSchema),
  aggregateObservation(
    "inventory_position",
    commerceInventoryPositionV1Schema,
  ),
  aggregateObservation(
    "inventory_movement",
    commerceInventoryMovementV1Schema,
  ),
  aggregateObservation("inventory_lot", commerceInventoryLotV1Schema),
  aggregateObservation("commerce_order", commerceOrderV1Schema),
  aggregateObservation("payment", commercePaymentV1Schema),
  aggregateObservation("fulfillment", commerceFulfillmentV1Schema),
  aggregateObservation("shipment", commerceShipmentV1Schema),
  commerceFoodServiceObservationV1Schema,
]);

function aggregateObservation<Kind extends string, Resource extends TSchema>(
  kind: Kind,
  resource: Resource,
) {
  return OpenObject({
    kind: Type.Readonly(Type.Literal(kind)),
    resource: Type.Readonly(resource),
  });
}
export type CommerceAggregateObservationV1 = Static<
  typeof commerceAggregateObservationV1Schema
>;

/** `parseQuantity` of a count shortage: `each` has scale 0, others up to 6. */
function hasQuantityScale(error: {
  readonly scale: number;
  readonly unit: string;
}): boolean {
  return error.unit === "each" ? error.scale === 0 : error.scale <= 6;
}

function quantityScaleError(): string {
  return "the scale is invalid for the unit";
}

/** `readCommerceInvalidTransition`: a transition that Commerce has. */
const invalidTransitionSchema = Type.Unsafe<CommerceInvalidTransition>(
  Type.Codec(
    Type.Refine(
      ReadonlyOpenObject({
        code: Type.Literal("invalid_transition"),
        machine: text,
        state: text,
        event: text,
      }),
      isKnownTransition,
      unknownTransitionError,
    ),
  )
    .Decode(toInvalidTransition)
    .Encode(fromInvalidTransition),
);

type TransitionFields = Readonly<{
  code: "invalid_transition";
  machine: string;
  state: string;
  event: string;
}>;

function isKnownTransition(value: TransitionFields): boolean {
  return (
    readCommerceInvalidTransition(value.machine, value.state, value.event) !==
    undefined
  );
}

function unknownTransitionError(): string {
  return "names a transition that Underclerk does not have";
}

function toInvalidTransition(
  value: TransitionFields,
): CommerceInvalidTransition {
  return readCommerceInvalidTransition(
    value.machine,
    value.state,
    value.event,
  )!;
}

function fromInvalidTransition(
  value: CommerceInvalidTransition,
): TransitionFields {
  return value;
}

/** Why a product stays: its history or an open record still needs it. */
const productDeleteRefusalSchema = Type.Union([
  Type.Literal("sold"),
  Type.Literal("on_menu"),
  Type.Literal("open_checkout"),
  Type.Literal("reserved_stock"),
  Type.Literal("draft_order"),
  Type.Literal("price_list"),
  Type.Literal("discount"),
  Type.Literal("linked_record"),
]);
export const commerceMutationErrorV1Schema = Type.Union([
  ReadonlyOpenObject({
    code: Type.Literal("unsupported_version"),
    received: Type.String(),
  }),
  ReadonlyOpenObject({ code: Type.Literal("invalid_command"), field: text }),
  ReadonlyOpenObject({
    code: Type.Literal("merchant_not_found"),
    merchantId: text,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("merchant_mismatch"),
    merchantId: text,
    organisationId: text,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("stale_merchant_revision"),
    expected: NonNegativeInteger,
    actual: NonNegativeInteger,
  }),
  // Revision 0 names a list that does not exist yet, such as a product's media.
  ReadonlyOpenObject({
    code: Type.Literal("stale_resource_revision"),
    kind: text,
    id: text,
    expected: NonNegativeInteger,
    actual: NonNegativeInteger,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("resource_revision_not_advanced"),
    kind: text,
    id: text,
    current: PositiveInteger,
    received: PositiveInteger,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("resource_not_found"),
    kind: text,
    id: text,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("resource_relationship_invalid"),
    field: text,
  }),
  Type.Refine(
    ReadonlyOpenObject({
      code: Type.Literal("inventory_count_shortage"),
      inventoryPositionId: text,
      observedAmount: NonNegativeInteger,
      reservedAmount: PositiveInteger,
      scale: NonNegativeInteger,
      unit: Type.Union([
        Type.Literal("each"),
        Type.Literal("gram"),
        Type.Literal("kilogram"),
        Type.Literal("milliliter"),
        Type.Literal("liter"),
      ]),
    }),
    hasQuantityScale,
    quantityScaleError,
  ),
  ReadonlyOpenObject({
    code: Type.Literal("resource_already_exists"),
    kind: text,
    id: text,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("offer_not_prepared"),
    offerId: text,
    state: text,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("inventory_receipt_already_applied"),
    receiptId: text,
    receiptLineId: text,
    movementId: text,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("insufficient_inventory"),
    inventoryItemId: text,
    locationId: text,
    requestedAmount: PositiveInteger,
    availableAmount: NonNegativeInteger,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("checkout_quote_mismatch"),
    checkoutId: text,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("checkout_refresh_required"),
    checkoutId: text,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("checkout_refused"),
    pluginId: text,
    message: text,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("action_refused"),
    pluginId: text,
    actionId: text,
    message: text,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("product_delete_refused"),
    productId: text,
    reason: productDeleteRefusalSchema,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("transition_refused"),
    pluginId: text,
    machine: text,
    event: text,
    message: text,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("checkout_quote_expired"),
    checkoutId: text,
    expiresAt: utcTimestampSchema,
  }),
  ReadonlyOpenObject({
    code: Type.Literal("idempotency_conflict"),
    idempotencyKey: text,
  }),
  invalidTransitionSchema,
]);
export type CommerceMutationErrorV1 = Static<
  typeof commerceMutationErrorV1Schema
>;

export const commerceClientErrorSchema = Type.Union([
  OpenObject({
    kind: Type.Readonly(Type.Literal("network")),
    message: Type.Readonly(Type.String()),
  }),
  OpenObject({
    kind: Type.Readonly(Type.Literal("rejected")),
    status: Type.Readonly(Type.Literal(409)),
    error: Type.Readonly(commerceMutationErrorV1Schema),
    message: Type.Readonly(Type.String()),
  }),
  OpenObject({
    kind: Type.Readonly(Type.Literal("http")),
    status: Type.Readonly(SafeInteger),
    message: Type.Readonly(Type.String()),
  }),
  OpenObject({
    kind: Type.Readonly(Type.Literal("invalid_response")),
    message: Type.Readonly(Type.String()),
  }),
]);
export type CommerceClientError = Static<typeof commerceClientErrorSchema>;

/** `parseEntityPlaneObservation`: the contracts parser decides and rewrites. */
const entityPlaneObservationSchema =
  Type.Unsafe<CommerceEntityPlaneObservationV1>(
    Type.Codec(
      Type.Refine(
        Type.Unknown(),
        isEntityPlaneObservation,
        invalidEntityPlaneObservation,
      ),
    )
      .Decode(toEntityPlaneObservation)
      .Encode(fromEntityPlaneObservation),
  );

function isEntityPlaneObservation(value: unknown): boolean {
  return parseCommerceEntityPlaneObservation(value).ok;
}

function invalidEntityPlaneObservation(): string {
  return "is not an entity plane observation";
}

function toEntityPlaneObservation(
  value: unknown,
): CommerceEntityPlaneObservationV1 {
  const parsed = parseCommerceEntityPlaneObservation(value);
  if (!parsed.ok) throw new TypeError(invalidEntityPlaneObservation());
  return parsed.value;
}

function fromEntityPlaneObservation(
  value: CommerceEntityPlaneObservationV1,
): unknown {
  return value;
}

export const commerceObservationV1Schema = Type.Union([
  commerceAggregateObservationV1Schema,
  entityPlaneObservationSchema,
]);
export type CommerceObservationV1 = Static<
  typeof commerceObservationV1Schema
>;

const signerSchema = ReadonlyOpenObject({
  keyId: text,
  algorithm: Type.Literal("ed25519"),
  signature: text,
});

const deliveryFields = {
  deliveryId: text,
  merchantId: text,
  merchantRevision: PositiveInteger,
  observedAt: utcTimestampSchema,
  observations: ImmutableArray(commerceObservationV1Schema),
  signer: signerSchema,
};

/**
 * A signed delivery. Version 2 (Plan 80 step 2) names the merchant only;
 * version 1, which also named its owner as `organisationId`, stays readable
 * as it was signed.
 */
export const commerceDeliveryV1Schema = Type.Union([
  ReadonlyOpenObject({
    schemaVersion: Type.Literal("underclerk.commerce-delivery.v2"),
    ...deliveryFields,
  }),
  ReadonlyOpenObject({
    schemaVersion: Type.Literal("underclerk.commerce-delivery.v1"),
    organisationId: text,
    ...deliveryFields,
  }),
]);
export type CommerceDeliveryV1 = Static<
  typeof commerceDeliveryV1Schema
>;

export type CommerceReceivedDeliveryV1 = CommerceDeliveryV1 &
  Readonly<{ signedObservations: readonly unknown[] }>;

/**
 * `parseReceivedDelivery`: the parsed delivery and its observations exactly as
 * Commerce signed them, since parsed observations can hold defaults.
 */
export const commerceReceivedDeliveryV1Schema =
  Type.Unsafe<CommerceReceivedDeliveryV1>(
    Type.Codec(
      Type.Refine(Type.Unknown(), isCommerceDelivery, invalidCommerceDelivery),
    )
      .Decode(toReceivedDelivery)
      .Encode(fromReceivedDelivery),
  );

const parseCommerceDelivery = wireRecordParser(
  commerceDeliveryV1Schema,
);

function isCommerceDelivery(value: unknown): boolean {
  return parseCommerceDelivery(value).ok;
}

function invalidCommerceDelivery(): string {
  return "is not a commerce delivery";
}

function toReceivedDelivery(value: unknown): CommerceReceivedDeliveryV1 {
  const parsed = parseCommerceDelivery(value);
  if (!parsed.ok) throw new TypeError(invalidCommerceDelivery());
  const signed = value as Readonly<{ observations: readonly unknown[] }>;
  return { ...parsed.value, signedObservations: signed.observations };
}

function fromReceivedDelivery(value: CommerceReceivedDeliveryV1): unknown {
  const { signedObservations, ...delivery } = value;
  return { ...delivery, observations: signedObservations };
}

export const acknowledgeCommerceDeliveryV1Schema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.acknowledge-commerce-delivery.v2"),
  merchantId: text,
  deliveryId: text,
  acknowledgedAt: utcTimestampSchema,
  rejection: Type.Optional(ReadonlyOpenObject({ reason: text })),
});
export type AcknowledgeCommerceDeliveryV1 = Static<
  typeof acknowledgeCommerceDeliveryV1Schema
>;

export const commerceDeliveryAcknowledgementV1Schema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.delivery-acknowledgement.v2"),
  outcome: Type.Union([
    Type.Literal("acknowledged"),
    Type.Literal("already_acknowledged"),
    Type.Literal("rejected"),
    Type.Literal("already_rejected"),
  ]),
  merchantId: text,
  deliveryId: text,
  acknowledgedAt: utcTimestampSchema,
});
export type CommerceDeliveryAcknowledgementV1 = Static<
  typeof commerceDeliveryAcknowledgementV1Schema
>;

export const commerceMigrationInventoryV2Schema = OpenObject({
  schemaVersion: Type.Readonly(
    Type.Literal("underclerk.migration-inventory.v2"),
  ),
  organisationId: Type.Readonly(Type.String()),
  merchantId: Type.Readonly(Type.String()),
  merchantRevision: Type.Readonly(SafeInteger),
  storageSchemaVersion: Type.Readonly(SafeInteger),
  contractRevisions: Type.Readonly(
    OpenObject({
      source: Type.Readonly(Type.String()),
      target: Type.Readonly(Type.Literal("satyr.commerce.inventory.v1")),
    }),
  ),
  migrationDigest: Type.Readonly(Type.String()),
  candidateClassification: Type.Readonly(
    Type.Union([Type.Literal("migrate"), Type.Literal("reject")]),
  ),
  classificationCounts: Type.Readonly(
    OpenObject({
      migrate: Type.Readonly(SafeInteger),
      reset: Type.Readonly(SafeInteger),
      reject: Type.Readonly(SafeInteger),
    }),
  ),
  resources: Type.Readonly(
    OpenObject({
      locations: Type.Readonly(SafeInteger),
      salesChannels: Type.Readonly(SafeInteger),
      products: Type.Readonly(SafeInteger),
      variants: Type.Readonly(SafeInteger),
      inventoryItems: Type.Readonly(SafeInteger),
      offers: Type.Readonly(SafeInteger),
      inventoryPositions: Type.Readonly(SafeInteger),
      orders: Type.Readonly(SafeInteger),
      payments: Type.Readonly(SafeInteger),
      fulfillments: Type.Readonly(SafeInteger),
      shipments: Type.Readonly(SafeInteger),
    }),
  ),
  foodService: Type.Readonly(
    OpenObject({ resourceSnapshots: Type.Readonly(SafeInteger) }),
  ),
  inventoryLedger: Type.Readonly(
    OpenObject({
      lots: Type.Readonly(SafeInteger),
      movements: Type.Readonly(SafeInteger),
      receiptIdentities: Type.Readonly(SafeInteger),
      receiptIdentityDigest: Type.Readonly(Type.String()),
    }),
  ),
  unresolvedMappings: Type.Readonly(
    OpenObject({
      inventoryItemCategories: Type.Readonly(SafeInteger),
      inventoryItemTrackingPolicies: Type.Readonly(SafeInteger),
      inventoryItemBaseUnits: Type.Readonly(SafeInteger),
      inventoryPositionBalances: Type.Readonly(SafeInteger),
      receiptIds: Type.Readonly(SafeInteger),
    }),
  ),
  invariantFailures: Type.Readonly(
    Type.Immutable(
      Type.Array(
        OpenObject({
          code: Type.Readonly(Type.String()),
          count: Type.Readonly(SafeInteger),
        }),
      ),
    ),
  ),
  operations: Type.Readonly(
    OpenObject({
      commandReceipts: Type.Readonly(SafeInteger),
      pendingCommands: Type.Readonly(SafeInteger),
      mutationLeases: Type.Readonly(SafeInteger),
      pendingReceipts: Type.Readonly(SafeInteger),
      pendingCommerceDeliveries: Type.Readonly(SafeInteger),
      deliveredCommerceDeliveries: Type.Readonly(SafeInteger),
    }),
  ),
});
export type CommerceMigrationInventoryV2 = Static<
  typeof commerceMigrationInventoryV2Schema
>;

export const commerceMutationPrincipalV1Schema = ReadonlyOpenObject({
  kind: Type.Literal("plugin"),
  pluginId: text,
  version: PositiveInteger,
  source: Type.Union([Type.Literal("handler"), Type.Literal("action")]),
  sourceId: text,
});
export type CommerceMutationPrincipalV1 = Static<
  typeof commerceMutationPrincipalV1Schema
>;

/**
 * Who sent the request that committed a command (Plan 80 step 3): the
 * operator, one of the merchant's API keys, or an installed app. An app may
 * name the person it acts for with an opaque reference of its own.
 */
export const commerceMutationActorV1Schema = Type.Union([
  ReadonlyOpenObject({ kind: Type.Literal("operator") }),
  ReadonlyOpenObject({ kind: Type.Literal("api_key"), credentialId: text }),
  ReadonlyOpenObject({
    kind: Type.Literal("app"),
    appId: text,
    person: Type.Optional(boundedTextSchema(200)),
  }),
]);
export type CommerceMutationActorV1 = Static<
  typeof commerceMutationActorV1Schema
>;

/** The core's command kinds; each built-in plugin adds its own. */
const CORE_COMMAND_KINDS = [
  "create_location",
  "prepare_catalog_listing",
  "update_product_description",
  "update_product",
  "delete_product",
  "update_variant",
  "update_offer",
  "update_storefront_tax",
  "record_order_manual_payment",
  "pause_plugin",
  "resume_plugin",
  "configure_plugin",
  "install_merchant_plugin",
  "remove_plugin",
  "report_plugin_function_failure",
  "pause_failing_plugin",
  "set_plugin_field_values",
  "run_plugin_action",
  "edit_order",
  "open_order_balance",
  "create_webhook_subscription",
  "restart_webhook_subscription",
  "rotate_webhook_secret",
  "delete_webhook_subscription",
  "place_channel_listing",
  "publish_catalog_listing",
  "adjust_offer_price",
  "configure_pickup_storefront",
  "configure_shipping_storefront",
  "create_in_person_checkout",
  "create_pickup_checkout",
  "create_shipping_checkout",
  "begin_checkout_payment",
  "collect_in_person_checkout_payment",
  "record_checkout_payment_capture",
  "observe_payment_dispute",
  "place_paid_checkout",
  "place_stored_value_checkout",
  "cancel_order",
  "refund_order",
  "mark_pickup_ready",
  "complete_pickup",
  "resolve_checkout_payment",
  "expire_checkout",
  "create_inventory_item",
  "open_inventory_position",
  "receive_inventory",
  "reconcile_inventory",
  "purchase_shipping_label",
  "attach_fulfillment_tracking",
  "record_shipping_tracking",
] as const;

type PluginReceiptKinds =
  (typeof BUILT_IN_PLUGIN_RECEIPT_KINDS)[keyof typeof BUILT_IN_PLUGIN_RECEIPT_KINDS];

type CommandKind =
  (typeof CORE_COMMAND_KINDS)[number] | PluginReceiptKinds["commands"][number];

const COMMAND_KINDS: readonly CommandKind[] = [
  ...CORE_COMMAND_KINDS,
  ...Object.values(BUILT_IN_PLUGIN_RECEIPT_KINDS).flatMap(
    (plugin) => plugin.commands,
  ),
];

/** One of the command kinds; a set check, since a long literal union is slow to clean. */
function isOneOf(values: ReadonlySet<string>, value: string): boolean {
  return values.has(value);
}

function unsupportedError(): string {
  return "is unsupported";
}

const commandKindSchema = Type.Unsafe<CommandKind>(
  Type.Refine(
    Type.String(),
    isOneOf.bind(null, new Set<string>(COMMAND_KINDS)),
    unsupportedError,
  ),
);

/** The core's receipt resource kinds; each built-in plugin adds its own. */
const CORE_RECEIPT_RESOURCE_KINDS = [
  "merchant",
  "location",
  "product",
  "sellable_variant",
  "webhook_subscription",
  "plugin",
  "plugin_field_values",
  "offer",
  "storefront",
  "checkout",
  "checkout_payment_attempt",
  "payment_dispute",
  "commerce_order",
  "refund_attempt",
  "fulfillment",
  "inventory_item",
  "inventory_position",
  "inventory_movement",
  "shipment",
] as const;

type ReceiptResourceKind =
  | (typeof CORE_RECEIPT_RESOURCE_KINDS)[number]
  | PluginReceiptKinds["resources"][number];

const RECEIPT_RESOURCE_KINDS: readonly ReceiptResourceKind[] = [
  ...CORE_RECEIPT_RESOURCE_KINDS,
  ...Object.values(BUILT_IN_PLUGIN_RECEIPT_KINDS).flatMap(
    (plugin) => plugin.resources,
  ),
];

/** One of the receipt resource kinds; a set check, since a long literal union is slow to clean. */
const receiptResourceKindSchema = Type.Unsafe<ReceiptResourceKind>(
  Type.Refine(
    Type.String(),
    isOneOf.bind(null, new Set<string>(RECEIPT_RESOURCE_KINDS)),
    unsupportedError,
  ),
);

const receiptFields = {
  receiptId: text,
  effectId: text,
  commandKind: commandKindSchema,
  merchantId: text,
  idempotencyKey: text,
  previousMerchantRevision: NonNegativeInteger,
  merchantRevision: PositiveInteger,
  deliveryId: text,
  resource: ReadonlyOpenObject({
    kind: receiptResourceKindSchema,
    id: text,
    revision: PositiveInteger,
  }),
  committedAt: utcTimestampSchema,
  principal: Type.Optional(commerceMutationPrincipalV1Schema),
  signer: signerSchema,
};

/**
 * A signed receipt. Version 2 (Plan 80 step 2) names the merchant and the
 * idempotency key only; version 1, which also named the owner as
 * `organisationId` and an `actionNonce`, stays readable as it was signed.
 */
export const commerceMutationReceiptV1Schema = Type.Union([
  ReadonlyOpenObject({
    schemaVersion: Type.Literal("underclerk.mutation-receipt.v2"),
    ...receiptFields,
    actor: Type.Optional(commerceMutationActorV1Schema),
  }),
  ReadonlyOpenObject({
    schemaVersion: Type.Literal("underclerk.mutation-receipt.v1"),
    organisationId: text,
    actionNonce: Nullable(text),
    ...receiptFields,
  }),
]);
export type CommerceMutationReceiptV1 = Static<
  typeof commerceMutationReceiptV1Schema
>;

export const commerceMutationResultV1Schema = Type.Union([
  ReadonlyOpenObject({
    outcome: Type.Literal("applied"),
    receipt: commerceMutationReceiptV1Schema,
  }),
  ReadonlyOpenObject({
    outcome: Type.Literal("replayed"),
    receipt: commerceMutationReceiptV1Schema,
  }),
  ReadonlyOpenObject({
    outcome: Type.Literal("rejected"),
    error: commerceMutationErrorV1Schema,
  }),
]);
export type CommerceMutationResultV1 = Static<
  typeof commerceMutationResultV1Schema
>;

// Parsers of the client API types (Plan 78 step 2).
export const parseAcknowledgeCommerceDeliveryV1 = wireRecordParser(
  acknowledgeCommerceDeliveryV1Schema,
);
export const parseCommerceDeliveryV1 = deliveryParser(
  wireRecordParser(commerceDeliveryV1Schema),
);
export const parseCommerceDeliveryAcknowledgementV1 = wireRecordParser(
  commerceDeliveryAcknowledgementV1Schema,
);
export const parseCommerceMutationErrorV1 = wireRecordParser(
  commerceMutationErrorV1Schema,
);
export const parseCommerceMutationReceiptV1 = wireRecordParser(
  commerceMutationReceiptV1Schema,
);
export const parseCommerceMutationResultV1 = wireRecordParser(
  commerceMutationResultV1Schema,
);
export const parseCommerceReceivedDeliveryV1 = deliveryParser(
  wireRecordParser(commerceReceivedDeliveryV1Schema),
);

const ENTITY_PLANE_OBSERVATION_KINDS: ReadonlySet<unknown> = new Set([
  "system_entity_changed",
  "custom_entity_changed",
  "relationship_changed",
  "commerce_list_entry_changed",
]);

/**
 * The delivery readers read the observations in order, and the first entity
 * plane observation that fails refuses the delivery with its own error.
 */
function deliveryParser<T>(
  parse: (input: unknown) => ContractDecodeResult<T>,
): (input: unknown) => ContractDecodeResult<T> {
  const parseWith: typeof parseDelivery<T> = parseDelivery;
  return parseWith.bind(null, parse);
}

function parseDelivery<T>(
  parse: (input: unknown) => ContractDecodeResult<T>,
  input: unknown,
): ContractDecodeResult<T> {
  const parsed = parse(input);
  if (parsed.ok || !isRecord(input) || !Array.isArray(input.observations))
    return parsed;
  for (const observation of input.observations) {
    if (Value.Check(commerceObservationV1Schema, observation))
      continue;
    if (
      !isRecord(observation) ||
      !ENTITY_PLANE_OBSERVATION_KINDS.has(observation.kind)
    )
      return parsed;
    const entity = parseCommerceEntityPlaneObservation(observation);
    return entity.ok ? parsed : entity;
  }
  return parsed;
}

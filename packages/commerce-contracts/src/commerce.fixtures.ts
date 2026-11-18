import type { CommerceCommandAuthorityContext } from "./relationship-authority.ts";
import type {
  Cart,
  CartLifecycle,
  Checkout,
  CheckoutBuyerPolicy,
  CheckoutFulfillmentQuoteSnapshot,
  CheckoutLifecycle,
  CheckoutPaymentAttemptLifecycle,
  CheckoutProfile,
  CheckoutProfileConfiguration,
  CheckoutProfileLifecycle,
  CheckoutQuoteSnapshot,
  ProtectedBuyerContact,
  RefundAttemptLifecycle,
  OnlineOrderConfiguration,
  InventoryAllocation,
  InventoryAllocationLifecycle,
  InventoryBalance,
  InventoryPosition,
  StorefrontFulfillmentConfiguration,
} from "./commerce-domain";
import type {
  Fulfillment,
  CheckoutLineSource,
  CheckoutSource,
  FoodServicePreparation,
  ProductionBatch,
  ShippingQuoteSnapshot,
  ShipmentLabelAttempt,
  Shipment,
  OrderEntityId,
  ShipmentEntityId,
  CommerceEntityRevision,
  CommerceCommandId,
  AttributeDefinitionId,
  RelationshipDefinitionId,
  RelationshipDefinitionRevision,
  RelationshipId,
  RelationshipRevision,
  CommerceListRevision,
  CustomEntityTypeRevision,
  AttributeDefinitionRevision,
  SourceProvenance,
  SystemCommerceRelationship,
  CommerceListId,
  MerchantRevision,
  SavedCommerceViewId,
  SavedCommerceViewRevision,
} from "./index.ts";
import type {
  CommerceEntityRef,
  CommerceEntityTypeId,
  CommerceFilter,
  CommerceGraphQuery,
  CommerceEntityPlaneCommand,
  AttributeDefinition,
  AttributeValueAssignment,
  CommerceRelationship,
  CommerceRelationshipRef,
  CustomCommerceRelationshipCreateTarget,
  RelationshipDefinition,
  CommerceFreshnessRequirement,
  CommerceContextRequest,
  SavedCommerceViewSource,
  CommerceAuthorityContext,
  CommerceEntityAuthority,
  CommerceEffectiveOrdering,
  CommerceEntityIdTieBreaker,
  CommerceOrderingLeadingKey,
  CommerceQueryCapabilityProfile,
  CommerceSavedViewCapabilitySource,
  CommerceQueryPlanOperation,
  CommerceQueryPlan,
  CommerceReadWatermark,
  CommerceSnapshotRevision,
  CustomCommerceEntityTypeDraft,
  CustomCommerceEntityTypeCommandTarget,
  CustomCommerceRelationshipDefinitionDraft,
  CustomCommerceRelationshipDefinitionCommandTarget,
  SystemEntityExtensionSchemaDraft,
  SystemEntityExtensionSchemaCommandTarget,
} from "./commerce-entity-plane";
import type { Variant } from "@seams/type-utils";

const stockedFoodServicePreparation: FoodServicePreparation = {
  kind: "stocked_inventory",
};

const immediateFoodServicePreparation: FoodServicePreparation = {
  kind: "immediate_recipe",
  recipeId: "recipe_latte",
  recipeRevision: 1,
};

const invalidStockedPreparation: FoodServicePreparation = {
  kind: "stocked_inventory",
  // @ts-expect-error Stocked food-service lines cannot carry a recipe identity.
  recipeId: "recipe_cookie",
};

const foodServiceLine: CheckoutLineSource = {
  kind: "food_service",
  variantId: "variant_cookie",
  variantRevision: 1,
  merchantCode: "COOKIE-CAFE",
  optionValues: [],
  menuId: "menu_cafe",
  menuRevision: 1,
  menuEntryId: "menu_entry_cookie",
  menuEntryRevision: 1,
  offerId: "offer_cookie",
  offerRevision: 1,
  consumptionPlanId: "plan_cookie",
  consumptionPlanRevision: 1,
  preparation: stockedFoodServicePreparation,
  modifiers: [],
  inventory: { kind: "untracked" },
};

const each = { amount: 1, scale: 0, unit: "each" } as const;
const at = "2026-08-12T00:00:00Z";
declare const checkoutQuote: CheckoutQuoteSnapshot;
declare const fulfillmentProvenance: Fulfillment["provenance"];
declare const fulfillmentLines: Fulfillment["lineItems"];

const activeCart: CartLifecycle = { state: "active", updatedAt: at };

const profileConfiguration: CheckoutProfileConfiguration = {
  currencyPolicy: { kind: "fixed", currency: "JPY" },
  buyerPolicy: {
    kind: "guest_or_account",
    requiredContact: "email_required_phone_optional",
    savedAddressPolicy: "enabled",
  },
  cartPolicy: {
    kind: "single_fulfillment",
    minimumLines: 1,
    maximumLines: 50,
    maximumTotalQuantity: 100,
  },
  pricingPolicy: {
    kind: "published_offers",
    salesChannelId: "sales_channel_cafe",
  },
  fulfillmentPolicy: {
    kind: "buyer_choice",
    pickupPolicyId: "pickup_policy_cafe",
    shippingPolicyId: "shipping_policy_domestic",
  },
  taxPolicy: {
    kind: "merchant_inclusive",
    jurisdictionPolicyId: "tax_policy_jp",
  },
  paymentPolicy: {
    kind: "external_provider",
    paymentProviderBindingId: "payment_binding_stripe",
  },
  afterSalePolicy: {
    cancellationPolicyId: "cancellation_policy_standard",
    refundPolicyId: "refund_policy_standard",
    refundGovernance: { kind: "approval_required" },
  },
  presentationPolicy: {
    locale: "ja-JP",
    merchantDisplayName: "Cafe",
    termsPolicyId: "terms_policy_cafe",
    privacyPolicyId: "privacy_policy_cafe",
    supportContact: "support@example.com",
  },
};

const invalidGuestBuyerPolicy: CheckoutBuyerPolicy = {
  kind: "guest",
  requiredContact: "email_required",
  // @ts-expect-error Guest checkout cannot carry account-only saved-address state.
  savedAddressPolicy: "enabled",
};

const draftProfileLifecycle: CheckoutProfileLifecycle = {
  state: "draft",
  createdAt: at,
  updatedAt: at,
};

// @ts-expect-error Published profiles cannot retain mutable draft timestamps.
const invalidPublishedProfileLifecycle: CheckoutProfileLifecycle = {
  ...draftProfileLifecycle,
  state: "published",
  publishedAt: at,
  publishedBy: "operator_merchant_owner",
};

const checkoutProfile: CheckoutProfile = {
  checkoutProfileId: "checkout_profile_cafe",
  merchantId: "merchant_cafe",
  revision: 1,
  name: "Cafe checkout",
  configuration: profileConfiguration,
  lifecycle: draftProfileLifecycle,
};

declare const cartWithoutCheckoutProfile: Omit<Cart, "checkoutProfile">;

// @ts-expect-error Cart construction requires an immutable checkout-profile reference.
const invalidUnpinnedCart: Cart = cartWithoutCheckoutProfile;

declare const onlineCheckoutWithoutCheckoutProfile: Omit<Checkout, "source"> & {
  source: Omit<Variant<CheckoutSource, "online">, "checkoutProfile">;
};

// @ts-expect-error Online checkouts require an immutable checkout-profile reference.
const invalidUnpinnedCheckout: Checkout = onlineCheckoutWithoutCheckoutProfile;

// @ts-expect-error Email-only evidence cannot carry a phone digest.
const invalidEmailContactBranch: ProtectedBuyerContact = {
  kind: "email",
  emailDigest: "a".repeat(64),
  phoneDigest: "b".repeat(64),
};

// @ts-expect-error Email-and-phone evidence requires both digests.
const invalidEmailAndPhoneContactBranch: ProtectedBuyerContact = {
  kind: "email_and_phone",
  emailDigest: "a".repeat(64),
};

const checkoutOrderConfiguration: OnlineOrderConfiguration = {
  kind: "checkout_profile",
  checkoutProfile: {
    checkoutProfileId: "checkout_profile_cafe",
    revision: 1,
  },
};

// @ts-expect-error External authority cannot retain a Pantry checkout-profile reference.
const invalidExternalOrderConfiguration: OnlineOrderConfiguration = {
  ...checkoutOrderConfiguration,
  kind: "external_authority",
};

const pickupStorefront: StorefrontFulfillmentConfiguration = {
  kind: "pickup",
  locationId: "location_cafe",
  readyLeadTimeSeconds: 900,
};

// @ts-expect-error Pickup storefront cannot carry shipping configuration.
const invalidPickupStorefront: StorefrontFulfillmentConfiguration = {
  ...pickupStorefront,
  shippingProfileId: "shipping_profile_1",
};

const pickupQuote: CheckoutFulfillmentQuoteSnapshot = {
  kind: "pickup",
  promise: { locationId: "location_cafe", readyAt: at },
};

const invalidPickupQuote: CheckoutFulfillmentQuoteSnapshot = {
  ...pickupQuote,
  // @ts-expect-error Pickup quote cannot carry a shipping quote identity.
  shippingQuoteId: "shipping_quote_1",
};

declare const shippingQuote: ShippingQuoteSnapshot;

const shippingFulfillmentQuote: CheckoutFulfillmentQuoteSnapshot = {
  kind: "shipping",
  quote: shippingQuote,
};

// @ts-expect-error Shipping checkout quotes cannot carry pickup promises.
const invalidShippingPickupPromise: CheckoutFulfillmentQuoteSnapshot = {
  kind: "shipping",
  quote: shippingQuote,
  promise: { locationId: "location_cafe", readyAt: at },
};

// @ts-expect-error Active carts cannot carry submitted checkout identity.
const invalidActiveCart: CartLifecycle = {
  ...activeCart,
  checkoutId: "checkout_1",
};

const quotedCheckout: CheckoutLifecycle = {
  state: "quoted",
  quote: checkoutQuote,
};

// @ts-expect-error Quoted checkout cannot carry an accepted Order identity.
const invalidQuotedCheckout: CheckoutLifecycle = {
  ...quotedCheckout,
  orderId: "order_1",
};

const pendingPayment: CheckoutPaymentAttemptLifecycle = {
  state: "pending",
  createdAt: at,
};

// @ts-expect-error Pending payment cannot carry provider authorization identity.
const invalidPendingPayment: CheckoutPaymentAttemptLifecycle = {
  ...pendingPayment,
  providerPaymentReference: "pi_1",
};

const requestedRefund: RefundAttemptLifecycle = {
  state: "requested",
  requestedAt: at,
};

// @ts-expect-error Requested refunds cannot carry provider success identity.
const invalidRequestedRefund: RefundAttemptLifecycle = {
  ...requestedRefund,
  providerRefundReference: "refund_1",
};

const accountedBalance: InventoryBalance = {
  kind: "accounted",
  onHand: each,
  allocated: { ...each, amount: 0 },
  available: each,
};

// @ts-expect-error Provider-only availability cannot carry accounted stock facts.
const invalidProviderBalance: InventoryBalance = {
  ...accountedBalance,
  kind: "available_only",
};

const heldLifecycle: InventoryAllocationLifecycle = {
  state: "held",
  demand: {
    kind: "checkout",
    checkoutId: "checkout_1",
    checkoutLineId: "checkout_line_1",
    consumeOn: "fulfillment_completed",
  },
  expiresAt: at,
};

// @ts-expect-error Held allocations cannot carry order-owned lifecycle fields.
const invalidHeldSpread: InventoryAllocationLifecycle = {
  ...heldLifecycle,
  orderId: "order_1",
};

// @ts-expect-error Order-owned allocations require an exact consumption point.
const invalidOrderAllocation: InventoryAllocationLifecycle = {
  state: "allocated_to_order",
  orderId: "order_1",
  orderLineId: "order_line_1",
  allocatedAt: at,
};

const invalidOrderPlacementAllocation: InventoryAllocationLifecycle = {
  state: "allocated_to_order",
  orderId: "order_1",
  orderLineId: "order_line_1",
  // @ts-expect-error Order-owned allocations cannot commit at order placement.
  consumeOn: "order_placed",
  allocatedAt: at,
};

const allocation: InventoryAllocation = {
  allocationId: "allocation_1",
  inventoryItemId: "inventory_1",
  locationId: "location_1",
  quantity: each,
  revision: 1,
  lifecycle: heldLifecycle,
};

export const invalidProductionAllocation: InventoryAllocation = {
  ...allocation,
  lifecycle: {
    state: "held",
    // @ts-expect-error Production allocations are not part of the completed-only path.
    demand: { kind: "production_batch", productionBatchId: "batch_1" },
    expiresAt: at,
  },
};

// @ts-expect-error Allocation identity and lifecycle are required.
const invalidAllocation: InventoryAllocation = {
  inventoryItemId: allocation.inventoryItemId,
  locationId: allocation.locationId,
  quantity: allocation.quantity,
  revision: allocation.revision,
};

// @ts-expect-error Shipping fulfillment cannot enter a pickup-only lifecycle.
const invalidShippingFulfillment: Fulfillment = {
  kind: "shipping",
  binding: {
    kind: "external",
    sourceReference: "fixture.fulfillment",
  },
  provenance: fulfillmentProvenance,
  orderId: "order_1",
  lineItems: fulfillmentLines,
  locationId: "location_1",
  expectedBy: at,
  lifecycle: { state: "ready_for_pickup", readyAt: at },
};

// @ts-expect-error Pickup fulfillment cannot be handed to a carrier.
const invalidPickupFulfillment: Fulfillment = {
  kind: "pickup",
  provenance: fulfillmentProvenance,
  orderId: "order_1",
  lineItems: fulfillmentLines,
  locationId: "location_1",
  expectedBy: at,
  lifecycle: {
    state: "handed_to_carrier",
    handedOverAt: at,
    shipmentId: "shipment_1",
  },
};

const pickupFulfillment: Fulfillment = {
  kind: "pickup",
  provenance: fulfillmentProvenance,
  orderId: "order_1",
  lineItems: fulfillmentLines,
  locationId: "location_1",
  expectedBy: at,
  lifecycle: { state: "ready_for_pickup", readyAt: at },
};

// @ts-expect-error Changing only the kind cannot retain a pickup lifecycle.
const invalidFulfillmentSpread: Fulfillment = {
  ...pickupFulfillment,
  kind: "shipping",
};

const position: InventoryPosition = {
  provenance: {
    organisationId: "organisation_1",
    integrationAccountId: "integration_1",
    source: "underclerk",
    resourceType: "inventory_position",
    resourceId: "position_1",
    revision: 1,
    occurredAt: at,
    observedAt: at,
  },
  inventoryItemId: "inventory_1",
  locationId: "location_1",
  balance: accountedBalance,
};

const productionBatch: ProductionBatch = {
  provenance: {
    organisationId: "organisation_1",
    integrationAccountId: "integration_1",
    source: "underclerk",
    resourceType: "production_batch",
    resourceId: "batch_1",
    revision: 1,
    occurredAt: at,
    observedAt: at,
  },
  productionBatchId: "batch_1",
  demand: { kind: "stock" },
  recipeId: "recipe_cookie",
  recipeRevision: 4,
  locationId: "location_1",
  stationId: "oven",
  revision: 1,
  plannedYield: { amount: 240, scale: 2, unit: "gram" },
  actualYield: { amount: 200, scale: 2, unit: "gram" },
  completedAt: at,
  inputMovementIds: ["movement_flour"],
  outputMovementId: "movement_cookie_output",
  outputLotId: "lot_cookie",
};

const invalidProductionBatchIdentity: ProductionBatch = {
  ...productionBatch,
  // @ts-expect-error Production batches require an explicit identity.
  productionBatchId: undefined,
};

const invalidProductionBatchOutputLot: ProductionBatch = {
  ...productionBatch,
  // @ts-expect-error Completed batches require an output lot identity.
  outputLotId: undefined,
};

const invalidShippingQuoteWithoutCustoms: ShippingQuoteSnapshot = {
  ...shippingQuote,
  packagePlan: {
    ...shippingQuote.packagePlan,
    package: {
      ...shippingQuote.packagePlan.package,
      // @ts-expect-error International package snapshots require customs lines.
      customsLines: undefined,
    },
  },
};

const requestedLabelAttempt: ShipmentLabelAttempt = {
  labelAttemptId: "label_attempt_1",
  shipmentId: "shipment_1",
  shipmentRevision: 1,
  labelRateId: "label_rate_1",
  rateReference: "rate_1",
  packagePlanDigest: "ab".repeat(32),
  idempotencyKey: "shipping:label:1",
  revision: 1,
  lifecycle: { state: "requested", requestedAt: at },
};

const invalidRequestedLabelAttempt: ShipmentLabelAttempt = {
  ...requestedLabelAttempt,
  lifecycle: {
    state: "requested",
    requestedAt: at,
    // @ts-expect-error Requested attempts cannot assert a tracking number.
    trackingNumber: "TRACK-1",
  },
};

const shipmentPackage = {
  packageId: "package_cookie_box",
  weight: { grams: 120 },
  dimensions: {
    lengthMillimeters: 200,
    widthMillimeters: 150,
    heightMillimeters: 80,
  },
  lineQuantities: [{ orderLineId: "order_line_cookie", quantity: each }],
  customsLines: [
    {
      orderLineId: "order_line_cookie",
      description: "Cookie box",
      quantity: each,
      weight: { grams: 120 },
      declaredValue: { amountMinor: 1000, currency: "JPY" },
      countryOfOrigin: "JP",
      hsCode: "190531",
    },
  ],
};

const firstPartyReadyShipment: Shipment = {
  kind: "first_party",
  provenance: {
    organisationId: "organisation_1",
    integrationAccountId: "integration_1",
    source: "underclerk",
    resourceType: "shipment",
    resourceId: "shipment_1",
    revision: 1,
    occurredAt: at,
    observedAt: at,
  },
  orderId: "order_1",
  fulfillmentId: "fulfillment_1",
  package: shipmentPackage,
  lifecycle: { state: "ready", readyAt: at },
  events: [],
};

const invalidFirstPartyReadyShipment: Shipment = {
  ...firstPartyReadyShipment,
  lifecycle: {
    state: "ready",
    readyAt: at,
    // @ts-expect-error Ready shipments cannot carry a label identity.
    labelAttemptId: "label_attempt_1",
  },
};

const invalidExternalShipment: Shipment = {
  kind: "external",
  provenance: firstPartyReadyShipment.provenance,
  orderId: "order_1",
  fulfillmentId: "fulfillment_1",
  carrier: "Example Carrier",
  trackingNumber: "TRACK-1",
  estimatedDeliveryAt: at,
  lifecycle: { state: "label_created", createdAt: at },
  events: [],
  // @ts-expect-error External shipments do not assert first-party package facts.
  package: shipmentPackage,
};

void invalidProviderBalance;
void checkoutProfile;
void invalidGuestBuyerPolicy;
void invalidPublishedProfileLifecycle;
void invalidEmailContactBranch;
void invalidEmailAndPhoneContactBranch;
void invalidActiveCart;
void invalidPickupStorefront;
void invalidPickupQuote;
void shippingFulfillmentQuote;
void invalidShippingPickupPromise;
void invalidFulfillmentSpread;
void invalidPickupFulfillment;
void invalidShippingFulfillment;
void pickupFulfillment;
void invalidQuotedCheckout;
void firstPartyReadyShipment;
void invalidFirstPartyReadyShipment;
void invalidExternalShipment;
void invalidPendingPayment;
void invalidHeldSpread;
void invalidOrderAllocation;
void invalidOrderPlacementAllocation;
void invalidAllocation;
void position;
void stockedFoodServicePreparation;
void immediateFoodServicePreparation;
void invalidStockedPreparation;
void foodServiceLine;
void productionBatch;
void invalidProductionBatchIdentity;
void invalidProductionBatchOutputLot;
void invalidShippingQuoteWithoutCustoms;
void requestedLabelAttempt;
void invalidRequestedLabelAttempt;

declare const orderEntityId: OrderEntityId;
declare const shipmentEntityId: ShipmentEntityId;
declare const customTypeId: import("./index.ts").CustomCommerceEntityTypeId;
declare const customEntityId: import("./index.ts").CustomCommerceEntityId;
declare const commerceEntityRevision: CommerceEntityRevision;
declare const commerceCommandId: CommerceCommandId;
declare const attributeDefinitionId: AttributeDefinitionId;
declare const tradePartnerTypeId: import("./index.ts").CustomCommerceEntityTypeId;
declare const exportDocumentTypeId: import("./index.ts").CustomCommerceEntityTypeId;
declare const tradePartnerEntityId: import("./index.ts").CustomCommerceEntityId;
declare const exportDocumentEntityId: import("./index.ts").CustomCommerceEntityId;
declare const productionBatchEntityId: import("./index.ts").ProductionBatchEntityId;
declare const relationshipDefinitionId: RelationshipDefinitionId;
declare const exportDocumentRelationshipDefinitionId: RelationshipDefinitionId;
declare const relationshipDefinitionRevision: RelationshipDefinitionRevision;
declare const relationshipId: RelationshipId;
declare const orderShipmentRelationshipId: RelationshipId;
declare const tradePartnerOrderRelationshipId: RelationshipId;
declare const shipmentExportDocumentRelationshipId: RelationshipId;
declare const productionBatchRelationshipId: RelationshipId;
declare const relationshipRevision: RelationshipRevision;
declare const attributeDefinitionRevision: AttributeDefinitionRevision;
declare const systemSchemaRevision: import("./index.ts").SystemSchemaRevision;
declare const merchantExtensionSchemaRevision: import("./index.ts").MerchantExtensionSchemaRevision;
declare const commerceListId: CommerceListId;
declare const commerceListRevision: CommerceListRevision;
declare const customEntityTypeRevision: CustomEntityTypeRevision;
declare const zeroSnapshotRevision: CommerceSnapshotRevision;
declare const savedCommerceViewId: SavedCommerceViewId;
declare const savedCommerceViewRevision: SavedCommerceViewRevision;
declare const commerceAuthorityContext: CommerceCommandAuthorityContext;

const exportOrderReference: CommerceEntityRef = {
  origin: "system",
  typeId: "order",
  entityId: orderEntityId,
};

const exportShipmentReference: CommerceEntityRef = {
  origin: "system",
  typeId: "shipment",
  entityId: shipmentEntityId,
};

const tradePartnerReference: CommerceEntityRef = {
  origin: "custom",
  typeId: tradePartnerTypeId,
  entityId: tradePartnerEntityId,
};

const exportDocumentReference: CommerceEntityRef = {
  origin: "custom",
  typeId: exportDocumentTypeId,
  entityId: exportDocumentEntityId,
};

const productionBatchReference: CommerceEntityRef = {
  origin: "system",
  typeId: "production_batch",
  entityId: productionBatchEntityId,
};

const tradePartnerOrderDefinition: RelationshipDefinition = {
  origin: "custom",
  definitionId: relationshipDefinitionId,
  sourceType: { origin: "custom", typeId: tradePartnerTypeId },
  targetType: { origin: "system", typeId: "order" },
  sourceLabel: "Orders",
  inverseLabel: "Trade partner",
  cardinality: "one_to_many",
  deletionBehavior: "detach",
  sensitivity: "internal",
  revision: relationshipDefinitionRevision,
};

const shipmentExportDocumentDefinition: RelationshipDefinition = {
  origin: "custom",
  definitionId: exportDocumentRelationshipDefinitionId,
  sourceType: { origin: "system", typeId: "shipment" },
  targetType: { origin: "custom", typeId: exportDocumentTypeId },
  sourceLabel: "Export documents",
  inverseLabel: "Shipment",
  cardinality: "one_to_many",
  deletionBehavior: "detach",
  sensitivity: "internal",
  revision: relationshipDefinitionRevision,
};

const tradePartnerOrderRelationship: CommerceRelationship = {
  origin: "custom",
  relationshipId: tradePartnerOrderRelationshipId,
  definition: {
    origin: "custom",
    definitionId: relationshipDefinitionId,
    revision: relationshipDefinitionRevision,
  },
  sensitivity: "internal",
  source: tradePartnerReference,
  target: exportOrderReference,
  revision: relationshipRevision,
};

const shipmentExportDocumentRelationship: CommerceRelationship = {
  origin: "custom",
  relationshipId: shipmentExportDocumentRelationshipId,
  definition: {
    origin: "custom",
    definitionId: exportDocumentRelationshipDefinitionId,
    revision: relationshipDefinitionRevision,
  },
  sensitivity: "internal",
  source: exportShipmentReference,
  target: exportDocumentReference,
  revision: relationshipRevision,
};

const shipmentProductionBatchProvenance: SourceProvenance = {
  organisationId: "organisation_cafe",
  integrationAccountId: "integration_cafe",
  source: "underclerk",
  resourceType: "shipment",
  resourceId: shipmentEntityId,
  revision: 1,
  occurredAt: "2026-08-12T00:00:00Z",
  observedAt: "2026-08-12T00:00:01Z",
};

const orderShipmentProvenance: SourceProvenance = {
  organisationId: "organisation_cafe",
  integrationAccountId: "integration_cafe",
  source: "underclerk",
  resourceType: "commerce_order",
  resourceId: orderEntityId,
  revision: 1,
  occurredAt: "2026-08-12T00:00:00Z",
  observedAt: "2026-08-12T00:00:01Z",
};

const orderShipmentRelationship: SystemCommerceRelationship = {
  origin: "system",
  relationshipId: orderShipmentRelationshipId,
  definition: {
    origin: "system",
    definitionId: "order_shipment",
    revision: relationshipDefinitionRevision,
  },
  sensitivity: "internal",
  source: exportOrderReference,
  target: exportShipmentReference,
  revision: relationshipRevision,
  provenance: orderShipmentProvenance,
};

const shipmentProductionBatchRelationship: SystemCommerceRelationship = {
  origin: "system",
  relationshipId: productionBatchRelationshipId,
  definition: {
    origin: "system",
    definitionId: "shipment_production_batch",
    revision: relationshipDefinitionRevision,
  },
  sensitivity: "internal",
  source: exportShipmentReference,
  target: productionBatchReference,
  revision: relationshipRevision,
  provenance: shipmentProductionBatchProvenance,
};

const exportCoordinationWalkingSlice = {
  entities: [
    exportOrderReference,
    exportShipmentReference,
    productionBatchReference,
    tradePartnerReference,
    exportDocumentReference,
  ] as const,
  relationships: [
    orderShipmentRelationship,
    tradePartnerOrderRelationship,
    shipmentExportDocumentRelationship,
    shipmentProductionBatchRelationship,
  ] as const,
};

// @ts-expect-error A system order reference cannot carry a ShipmentEntityId.
const invalidOrderReference: CommerceEntityRef = {
  origin: "system",
  typeId: "order",
  entityId: shipmentEntityId,
};

const exportEntityType: CommerceEntityTypeId = {
  origin: "system",
  typeId: "shipment",
};

const systemCapabilityProfile: CommerceQueryCapabilityProfile = {
  kind: "system_mapped",
  systemEntityKind: "order",
  systemSchemaRevision,
  capability: {
    filterableAttributeIds: [],
    sortableAttributeIds: [],
    aggregation: { kind: "count_only" },
  },
};

const customCapabilityProfile: CommerceQueryCapabilityProfile = {
  kind: "underclerk_custom",
  entityTypeId: tradePartnerTypeId,
  publishedRevision: customEntityTypeRevision,
  capability: {
    filterableAttributeIds: [attributeDefinitionId],
    sortableAttributeIds: [attributeDefinitionId],
    aggregation: { kind: "count_only" },
  },
};

const listCapabilityProfile: CommerceQueryCapabilityProfile = {
  kind: "commerce_list",
  listId: commerceListId,
  listRevision: commerceListRevision,
  capability: {
    filterableAttributeIds: [],
    sortableAttributeIds: [],
    aggregation: { kind: "count_only" },
  },
};

const invalidCustomCapabilityProfile: CommerceQueryCapabilityProfile = {
  kind: "underclerk_custom",
  // @ts-expect-error Commerce custom capability profiles require a custom type identity.
  entityTypeId: "shipment",
  capability: {
    filterableAttributeIds: [],
    sortableAttributeIds: [],
    aggregation: { kind: "count_only" },
  },
};

const invalidSystemCapabilityProfile: CommerceQueryCapabilityProfile = {
  kind: "system_mapped",
  // @ts-expect-error System mapping capabilities require a system entity kind.
  systemEntityKind: tradePartnerTypeId,
  systemSchemaRevision,
  capability: {
    filterableAttributeIds: [],
    sortableAttributeIds: [],
    aggregation: { kind: "count_only" },
  },
};

const savedViewCapabilitySource: CommerceSavedViewCapabilitySource = {
  kind: "system_mapped",
  systemEntityKind: "order",
  systemSchemaRevision,
  capability: {
    filterableAttributeIds: [],
    sortableAttributeIds: [],
    aggregation: { kind: "count_only" },
  },
};

const savedViewCapabilityProfile: CommerceQueryCapabilityProfile = {
  kind: "saved_commerce_view",
  viewId: savedCommerceViewId,
  viewRevision: savedCommerceViewRevision,
  source: savedViewCapabilitySource,
  filter: { kind: "all" },
  sorts: [],
};

const validTotalOrdering: CommerceEffectiveOrdering = {
  leadingKeys: [],
  tieBreaker: { kind: "entity_id_ascending" },
};

// @ts-expect-error Effective order always carries its structural entity-id tie-breaker.
const invalidTotalOrdering: CommerceEffectiveOrdering = { leadingKeys: [] };

const invalidLeadingEntityId: CommerceOrderingLeadingKey = {
  field: {
    // @ts-expect-error Entity ID is reserved for the structural tie-breaker.
    kind: "entity_id",
  },
  direction: "ascending",
  nulls: "last",
};

const invalidTieBreaker: CommerceEntityIdTieBreaker = {
  // @ts-expect-error The only tie-breaker is entity ID ascending.
  kind: "entity_id_descending",
};

const validListPlanOperation: CommerceQueryPlanOperation = {
  kind: "commerce_list_page",
  listId: commerceListId,
};

const validAggregationPlanOperation: CommerceQueryPlanOperation = {
  kind: "aggregation",
  source: { kind: "entity_type", entityTypeId: exportEntityType },
  aggregation: { kind: "count" },
};

const validSearchPlanOperation: CommerceQueryPlanOperation = {
  kind: "search",
  entityTypeId: exportEntityType,
  traversal: { maxDepth: 0, resultLimit: 10 },
};

const invalidAllTypesSearchPlanOperation: CommerceQueryPlanOperation = {
  kind: "search",
  // @ts-expect-error A planned search is always bound to one exact entity type.
  domain: { kind: "all_entity_types" },
  traversal: { maxDepth: 0, resultLimit: 10 },
};

// @ts-expect-error Aggregation operations own their aggregation payload.
const invalidAggregationPlanOperation: CommerceQueryPlanOperation = {
  kind: "aggregation",
  source: { kind: "entity_type", entityTypeId: exportEntityType },
};

// @ts-expect-error Entity-type page subjects cannot cross into list operations.
const invalidListPlanOperation: CommerceQueryPlanOperation = {
  kind: "commerce_list_page",
  listId: commerceListId,
  entityTypeId: exportEntityType,
};

// @ts-expect-error Traversal operations require seeds, subject, and traversal bounds.
const invalidTraversalPlanOperation: CommerceQueryPlanOperation = {
  kind: "relationship_traversal",
  entityTypeId: exportEntityType,
};

declare const validQueryPlan: CommerceQueryPlan;

const invalidPlanAggregationField: CommerceQueryPlan = {
  ...validQueryPlan,
  // @ts-expect-error A plan cannot carry an independent aggregation beside its operation.
  aggregation: { kind: "count" },
};

declare const validCursorPayload: import("./commerce-entity-plane").CommerceCursorPayload;

const invalidCursorPageOwner: import("./commerce-entity-plane").CommerceCursorPayload =
  {
    ...validCursorPayload,
    // @ts-expect-error Cursor authority is derived from its discriminated watermark.
    pageOwner: { kind: "underclerk_native" },
  };

const invalidNormalizedSearch: import("./commerce-entity-plane").CommerceNormalizedPredicate =
  {
    kind: "search",
    // @ts-expect-error Planned search carries only the authoritative folded text.
    text: "Straße",
  };

const zeroSnapshotWatermark: CommerceReadWatermark = {
  kind: "underclerk_native",
  merchantRevision: zeroSnapshotRevision,
};

// @ts-expect-error Snapshot high-watermarks and committed merchant revisions are distinct brands.
const invalidCommittedRevision: MerchantRevision = zeroSnapshotRevision;

// @ts-expect-error A committed merchant revision cannot be zero.
const invalidZeroCommittedRevision: MerchantRevision = 0;

const shipmentAttributeDefinition: AttributeDefinition = {
  id: attributeDefinitionId,
  scope: {
    kind: "merchant_extension",
    entityTypeId: "shipment",
    schemaRevision: merchantExtensionSchemaRevision,
  },
  label: "Stage",
  helpText: null,
  required: false,
  sensitivity: "internal",
  kind: { kind: "short_text", maxLength: 32 },
  revision: attributeDefinitionRevision,
};

const shipmentAttributeValue: AttributeValueAssignment = {
  attributeId: attributeDefinitionId,
  scope: {
    kind: "merchant_extension",
    entityTypeId: "shipment",
    schemaRevision: merchantExtensionSchemaRevision,
  },
  definitionRevision: attributeDefinitionRevision,
  sensitivity: "internal",
  value: { kind: "short_text", value: "ready" },
};

const exportFilter: CommerceFilter = { kind: "all" };
const exportQuery: CommerceGraphQuery = {
  kind: "entity_by_ref",
  reference: exportShipmentReference,
  traversal: { maxDepth: 2, resultLimit: 40 },
  filter: exportFilter,
};

const invalidFilter: CommerceFilter = {
  kind: "attribute",
  // @ts-expect-error Comparison filters require a typed value.
  filter: {
    attributeId: attributeDefinitionId,
    operator: "equals",
  },
};

const exportContextRequest: CommerceContextRequest = {
  selection: { kind: "entity_seeds", seeds: [exportShipmentReference] },
  traversal: { maxDepth: 2, resultLimit: 40 },
  allowedSensitivity: "internal",
  allowedAttributeIds: [],
  freshnessRequirement: "current_only",
};

const anyFreshnessRequirement: CommerceFreshnessRequirement = "any";
const observedFreshnessRequirement: CommerceFreshnessRequirement = {
  observed_within_seconds: { seconds: 30 },
};

const invalidObservedFreshnessRequirement: CommerceFreshnessRequirement = {
  observed_within_seconds: { seconds: 30 },
  // @ts-expect-error Freshness requirements cannot combine object and literal branches.
  kind: "current_only",
};

const customEntityReference: CommerceEntityRef = {
  origin: "custom",
  typeId: customTypeId,
  entityId: customEntityId,
};

const customEntityTypeDraft: CustomCommerceEntityTypeDraft = {
  typeId: customTypeId,
  revision: customEntityTypeRevision,
  label: "Trade partner",
  description: "Organizations involved in export coordination.",
  attributes: [],
};

const customRelationshipDefinitionDraft: CustomCommerceRelationshipDefinitionDraft =
  {
    origin: "custom",
    definitionId: relationshipDefinitionId,
    sourceType:
      tradePartnerReference.origin === "custom"
        ? { origin: "custom", typeId: tradePartnerReference.typeId }
        : exportEntityType,
    targetType:
      exportOrderReference.origin === "system"
        ? { origin: "system", typeId: exportOrderReference.typeId }
        : exportEntityType,
    sourceLabel: "Orders",
    inverseLabel: "Trade partner",
    cardinality: "one_to_many",
    deletionBehavior: "detach",
    sensitivity: "internal",
    revision: relationshipDefinitionRevision,
  };

const systemEntityExtensionSchemaDraft: SystemEntityExtensionSchemaDraft = {
  entityTypeId: "shipment",
  schemaRevision: merchantExtensionSchemaRevision,
  attributes: [],
};

const createCustomEntityTypeCommand: CommerceEntityPlaneCommand = {
  kind: "create_custom_entity_type",
  command: { draft: customEntityTypeDraft },
};

const publishCustomEntityTypeCommand: CommerceEntityPlaneCommand = {
  kind: "publish_custom_entity_type",
  command: {
    target: {
      typeId: customTypeId,
      revision: customEntityTypeRevision,
    } satisfies CustomCommerceEntityTypeCommandTarget,
  },
};

const createCustomRelationshipDefinitionCommand: CommerceEntityPlaneCommand = {
  kind: "create_custom_relationship_definition",
  command: { draft: customRelationshipDefinitionDraft },
};

const publishCustomRelationshipDefinitionCommand: CommerceEntityPlaneCommand = {
  kind: "publish_custom_relationship_definition",
  command: {
    target: {
      definitionId: relationshipDefinitionId,
      revision: relationshipDefinitionRevision,
    } satisfies CustomCommerceRelationshipDefinitionCommandTarget,
  },
};

const createSystemEntityExtensionSchemaCommand: CommerceEntityPlaneCommand = {
  kind: "create_system_entity_extension_schema",
  command: { draft: systemEntityExtensionSchemaDraft },
};

const publishSystemEntityExtensionSchemaCommand: CommerceEntityPlaneCommand = {
  kind: "publish_system_entity_extension_schema",
  command: {
    target: {
      entityTypeId: "shipment",
      revision: merchantExtensionSchemaRevision,
    } satisfies SystemEntityExtensionSchemaCommandTarget,
  },
};

const customEntityTypeCreateAuthority: CommerceEntityAuthority = {
  kind: "custom_entity_type_create",
  context: commerceAuthorityContext,
  scope: {
    kind: "entity_type",
    entityTypeId: { origin: "custom", typeId: customTypeId },
  },
  target: { typeId: customTypeId },
};

const customEntityTypePublishAuthority: CommerceEntityAuthority = {
  kind: "custom_entity_type_publish",
  context: commerceAuthorityContext,
  scope: {
    kind: "entity_type",
    entityTypeId: { origin: "custom", typeId: customTypeId },
  },
  target: { typeId: customTypeId, revision: customEntityTypeRevision },
};

const customRelationshipDefinitionCreateAuthority: CommerceEntityAuthority = {
  kind: "custom_relationship_definition_create",
  context: commerceAuthorityContext,
  scope: {
    kind: "relationship_definition",
    relationshipDefinition: {
      origin: "custom",
      definitionId: relationshipDefinitionId,
      revision: relationshipDefinitionRevision,
    },
  },
  target: { definitionId: relationshipDefinitionId },
};

const customRelationshipDefinitionPublishAuthority: CommerceEntityAuthority = {
  kind: "custom_relationship_definition_publish",
  context: commerceAuthorityContext,
  scope: {
    kind: "relationship_definition",
    relationshipDefinition: {
      origin: "custom",
      definitionId: relationshipDefinitionId,
      revision: relationshipDefinitionRevision,
    },
  },
  target: {
    definitionId: relationshipDefinitionId,
    revision: relationshipDefinitionRevision,
  },
};

const systemEntityExtensionSchemaCreateAuthority: CommerceEntityAuthority = {
  kind: "system_entity_extension_schema_create",
  context: commerceAuthorityContext,
  scope: {
    kind: "entity_type",
    entityTypeId: { origin: "system", typeId: "shipment" },
  },
  target: { entityTypeId: "shipment" },
};

const systemEntityExtensionSchemaPublishAuthority: CommerceEntityAuthority = {
  kind: "system_entity_extension_schema_publish",
  context: commerceAuthorityContext,
  scope: {
    kind: "entity_type",
    entityTypeId: { origin: "system", typeId: "shipment" },
  },
  target: {
    entityTypeId: "shipment",
    revision: merchantExtensionSchemaRevision,
  },
};

const invalidCustomEntityTypeAuthority: CommerceEntityAuthority = {
  kind: "custom_entity_type_create",
  context: commerceAuthorityContext,
  scope: {
    kind: "entity_type",
    entityTypeId: { origin: "custom", typeId: customTypeId },
  },
  // @ts-expect-error A custom entity-type authority cannot carry a relationship-definition target.
  target: { definitionId: relationshipDefinitionId },
};

const invalidCustomRelationshipDefinitionAuthority: CommerceEntityAuthority = {
  kind: "custom_relationship_definition_publish",
  context: commerceAuthorityContext,
  scope: {
    kind: "relationship_definition",
    relationshipDefinition: {
      origin: "custom",
      definitionId: relationshipDefinitionId,
      revision: relationshipDefinitionRevision,
    },
  },
  // @ts-expect-error A relationship-definition authority cannot carry an entity-type target.
  target: { typeId: customTypeId, revision: customEntityTypeRevision },
};

const invalidSystemEntityExtensionAuthority: CommerceEntityAuthority = {
  kind: "system_entity_extension_schema_publish",
  context: commerceAuthorityContext,
  scope: {
    kind: "entity_type",
    entityTypeId: { origin: "system", typeId: "shipment" },
  },
  target: {
    // @ts-expect-error A system extension authority cannot carry a custom relationship target.
    definitionId: relationshipDefinitionId,
    revision: relationshipDefinitionRevision,
  },
};

const invalidCustomRelationshipDefinitionDraft: CustomCommerceRelationshipDefinitionDraft =
  {
    // @ts-expect-error Custom relationship drafts cannot use the system origin.
    origin: "system",
    definitionId: relationshipDefinitionId,
    sourceType: exportEntityType,
    targetType: exportEntityType,
    sourceLabel: "Orders",
    inverseLabel: "Trade partner",
    cardinality: "one_to_many",
    deletionBehavior: "detach",
    sensitivity: "internal",
    revision: relationshipDefinitionRevision,
  };

const invalidPublishCustomEntityTypeCommand: CommerceEntityPlaneCommand = {
  kind: "publish_custom_entity_type",
  command: {
    // @ts-expect-error Publish commands require an exact resource target, never a draft snapshot.
    draft: customEntityTypeDraft,
  },
};

const invalidCreateCustomEntityTypeCommand: CommerceEntityPlaneCommand = {
  kind: "create_custom_entity_type",
  command: {
    // @ts-expect-error Create commands require a draft and cannot accept a publish target.
    target: {
      typeId: customTypeId,
      revision: customEntityTypeRevision,
    },
  },
};

const archiveCustomEntityCommand: CommerceEntityPlaneCommand = {
  kind: "archive_custom_entity",
  command: {
    entityRef: customEntityReference,
    expectedRevision: commerceEntityRevision,
    archivedAt: at,
  },
};

const invalidCommand: CommerceEntityPlaneCommand = {
  kind: "archive_custom_entity",
  // @ts-expect-error Entity-plane commands require the expected revision.
  command: {
    entityRef: customEntityReference,
    archivedAt: at,
  },
};

const invalidSystemRelationshipMutation: CommerceEntityPlaneCommand = {
  kind: "delete_custom_relationship",
  command: {
    // @ts-expect-error System relationship mutation lacks the required custom definition identity.
    target: { relationshipId, expectedRevision: relationshipRevision },
  },
};

const replaceCustomRelationshipCommand: CommerceEntityPlaneCommand = {
  kind: "replace_custom_relationship",
  command: {
    target: {
      relationship: {
        origin: "custom",
        relationshipId,
        definition: {
          origin: "custom",
          definitionId: relationshipDefinitionId,
          revision: relationshipDefinitionRevision,
        },
        revision: relationshipRevision,
      },
      replacementTarget: exportOrderReference,
    },
  },
};

// @ts-expect-error Replacement commands require the exact replacement endpoint.
const invalidRelationshipReplacement: CommerceEntityPlaneCommand = {
  kind: "replace_custom_relationship",
  command: {
    target: {
      relationship: {
        origin: "custom",
        relationshipId,
        definition: {
          origin: "custom",
          definitionId: relationshipDefinitionId,
          revision: relationshipDefinitionRevision,
        },
        revision: relationshipRevision,
      },
    },
  },
};

// @ts-expect-error A system relationship reference cannot carry a custom definition.
const invalidSystemRelationshipReference: CommerceRelationshipRef = {
  origin: "system",
  relationshipId,
  definition: {
    origin: "custom",
    definitionId: relationshipDefinitionId,
    revision: relationshipDefinitionRevision,
  },
  revision: relationshipRevision,
};

const invalidCustomRelationshipCreateTarget: CustomCommerceRelationshipCreateTarget =
  {
    relationshipId,
    definition: {
      // @ts-expect-error Custom relationship creation cannot use a system definition origin.
      origin: "system",
      // @ts-expect-error Custom relationship creation requires a branded custom definition ID.
      definitionId: "order_shipment",
      revision: relationshipDefinitionRevision,
    },
    source: tradePartnerReference,
    target: exportOrderReference,
  };

const invalidAttributeScope: AttributeDefinition = {
  id: attributeDefinitionId,
  scope: {
    kind: "system",
    entityTypeId: "shipment",
    // @ts-expect-error System scopes require a SystemSchemaRevision, not an extension revision.
    schemaRevision: merchantExtensionSchemaRevision,
  },
  label: "Stage",
  helpText: null,
  required: false,
  sensitivity: "internal",
  kind: { kind: "short_text", maxLength: 32 },
  revision: attributeDefinitionRevision,
};

// @ts-expect-error Attribute definitions must carry one complete owning scope.
const invalidAttributeDefinition: AttributeDefinition = {
  id: attributeDefinitionId,
  label: "Stage",
  helpText: null,
  required: false,
  sensitivity: "internal",
  kind: { kind: "short_text", maxLength: 32 },
  revision: attributeDefinitionRevision,
};

// @ts-expect-error Authority contexts must carry an expiry.
const incompleteAuthorityContext: CommerceAuthorityContext = {};

const invalidListSource: SavedCommerceViewSource = {
  // @ts-expect-error List view sources use the closed source union.
  kind: "list",
  listId: commerceListId,
};

const invalidViewSource: SavedCommerceViewSource = {
  // @ts-expect-error View sources use the closed entity-type or commerce-list union.
  kind: "saved_selector",
  selectorId: "selector_1",
};

void invalidOrderReference;
void exportOrderReference;
void exportEntityType;
void exportQuery;
void invalidFilter;
void exportContextRequest;
void anyFreshnessRequirement;
void observedFreshnessRequirement;
void invalidObservedFreshnessRequirement;
void archiveCustomEntityCommand;
void commerceCommandId;
void invalidCommand;
void exportShipmentReference;
void tradePartnerOrderDefinition;
void shipmentExportDocumentDefinition;
void exportCoordinationWalkingSlice;
void invalidSystemRelationshipMutation;
void invalidSystemRelationshipReference;
void customEntityTypeDraft;
void customRelationshipDefinitionDraft;
void systemEntityExtensionSchemaDraft;
void createCustomEntityTypeCommand;
void publishCustomEntityTypeCommand;
void createCustomRelationshipDefinitionCommand;
void publishCustomRelationshipDefinitionCommand;
void createSystemEntityExtensionSchemaCommand;
void publishSystemEntityExtensionSchemaCommand;
void customEntityTypeCreateAuthority;
void customEntityTypePublishAuthority;
void customRelationshipDefinitionCreateAuthority;
void customRelationshipDefinitionPublishAuthority;
void systemEntityExtensionSchemaCreateAuthority;
void systemEntityExtensionSchemaPublishAuthority;
void invalidCustomEntityTypeAuthority;
void invalidCustomRelationshipDefinitionAuthority;
void invalidSystemEntityExtensionAuthority;
void invalidCustomRelationshipDefinitionDraft;
void invalidPublishCustomEntityTypeCommand;
void invalidCreateCustomEntityTypeCommand;
void replaceCustomRelationshipCommand;
void invalidRelationshipReplacement;
void invalidCustomRelationshipCreateTarget;
void invalidAttributeScope;
void shipmentAttributeDefinition;
void shipmentAttributeValue;
void invalidAttributeDefinition;
void incompleteAuthorityContext;
void invalidListSource;
void invalidViewSource;
void systemCapabilityProfile;
void customCapabilityProfile;
void listCapabilityProfile;
void invalidCustomCapabilityProfile;
void invalidSystemCapabilityProfile;
void savedViewCapabilitySource;
void savedViewCapabilityProfile;
void validTotalOrdering;
void invalidTotalOrdering;
void invalidLeadingEntityId;
void invalidTieBreaker;
void validListPlanOperation;
void validAggregationPlanOperation;
void validSearchPlanOperation;
void invalidAllTypesSearchPlanOperation;
void invalidAggregationPlanOperation;
void invalidPlanAggregationField;
void invalidCursorPageOwner;
void invalidNormalizedSearch;
void invalidListPlanOperation;
void invalidTraversalPlanOperation;
void zeroSnapshotWatermark;
void invalidCommittedRevision;
void invalidZeroCommittedRevision;

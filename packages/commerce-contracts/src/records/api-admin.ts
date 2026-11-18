// The Commerce admin API records that packages/commerce-client
// reads in admin-client.ts (Plan 78 step 2). Each schema follows its
// hand-written reader: exact keys where the reader checks them, the reader's
// own fields elsewhere, and the reader's cross-field rules as refinements.
import { Type, type Static } from "typebox";
import type {
  Checkout,
  CheckoutPaymentAttempt,
  Storefront,
} from "../commerce-domain.ts";
import { NonNegativeInteger, PositiveInteger } from "../schema.ts";
import {
  currencyCodeTextSchema,
  normalizedTextSchema,
  sha256HexSchema,
  utcTimestampSchema,
} from "./fields.ts";
import {
  checkoutPaymentAttemptSchema,
  checkoutSchema,
  inventoryConsumptionPlanSchema,
  quantityUnitSchema,
  shippingProfileSchema,
  storefrontSchema,
  variantShippingSpecificationSchema,
} from "./commerce-records.ts";
import {
  wireBuyerSchema,
  wireInPersonPaymentBindingSchema,
  wireInventoryItemCategorySchema,
  wireInventoryLotExpirySchema,
  wireInventoryReceiptPurchaseSchema,
  wireInventoryTrackingSchema,
  wireLocationSchema,
  wireMoneySchema,
  wireOfferSchema,
  wireOnlinePaymentBindingSchema,
  wirePointOfSaleBuyerSchema,
  wireProtectedBuyerContactSchema,
  wireQuantitySchema,
  wireSalesChannelSchema,
} from "./api-common.ts";
import {
  commerceProductV1Schema,
  commerceVariantV1Schema,
} from "./api-resources.ts";
import {
  Absent,
  ImmutableArray,
  ReadonlyOpenObject,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;
const timestamp = utcTimestampSchema;

/** The fields of `parseInventoryCommandContext`, shared by most commands. */
const commandContext = {
  merchantId: text,
  expectedMerchantRevision: NonNegativeInteger,
  idempotencyKey: text,
  requestedAt: timestamp,
};

/** `parseCheckoutProfileReference`: exactly two fields. */
export const wireCheckoutProfileReferenceSchema = Type.Object(
  { checkoutProfileId: text, revision: PositiveInteger },
  { additionalProperties: false },
);

export const adjustOfferPriceCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.adjust-offer-price.v1"),
  merchantId: Type.String(),
  idempotencyKey: Type.String(),
  requestedAt: Type.String(),
  offerId: Type.String(),
  expectedOfferRevision: PositiveInteger,
  expectedPolicyRevision: PositiveInteger,
  proposedPriceMinor: PositiveInteger,
  currency: currencyCodeTextSchema,
});

// The contracts derive these record types from their schemas; the static
// type here is that derived type.
const domainCheckoutSchema = Type.Unsafe<Checkout>(checkoutSchema);
const domainPaymentAttemptSchema = Type.Unsafe<CheckoutPaymentAttempt>(
  checkoutPaymentAttemptSchema,
);
const domainStorefrontSchema = Type.Unsafe<Storefront>(storefrontSchema);

export const counterSaleSchema = ReadonlyStrictObject({
  checkout: domainCheckoutSchema,
  paymentAttempt: Type.Union([domainPaymentAttemptSchema, Type.Null()]),
});

const paymentCaptureVersion = Type.Literal(
  "underclerk.payment-capture-result.v1",
);
export const paymentCaptureResultSchema = Type.Union([
  ReadonlyOpenObject({
    schemaVersion: paymentCaptureVersion,
    kind: Type.Literal("captured"),
    providerPaymentReference: text,
    capturedAt: timestamp,
  }),
  ReadonlyOpenObject({
    schemaVersion: paymentCaptureVersion,
    kind: Type.Literal("declined"),
    reason: text,
  }),
  ReadonlyOpenObject({
    schemaVersion: paymentCaptureVersion,
    kind: Type.Literal("processing"),
    reason: text,
    reconcileAfter: timestamp,
  }),
  ReadonlyOpenObject({
    schemaVersion: paymentCaptureVersion,
    kind: Type.Literal("indeterminate"),
    reason: text,
    reconcileAfter: timestamp,
  }),
]);

/**
 * A new merchant (Plan 80 step 2). `externalReference` is the operator's
 * name for the merchant's owner, kept once; Commerce names the merchant
 * only by `merchantId` everywhere else.
 */
export const provisionMerchantCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.provision-merchant.v2"),
  externalReference: text,
  merchantId: text,
  createdAt: timestamp,
});

export const demoProfileSchema = Type.Union([
  Type.Literal("cafe_patisserie"),
  Type.Literal("satyr_ecommerce"),
]);

export const provisionDemoCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.provision-demo.v2"),
  externalReference: text,
  merchantId: text,
  profile: demoProfileSchema,
  createdAt: timestamp,
});

export const merchantProvisioningResultSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.merchant-provisioning-result.v2"),
  outcome: Type.Union([
    Type.Literal("provisioned"),
    Type.Literal("already_provisioned"),
  ]),
  externalReference: text,
  merchantId: text,
});

export const createLocationCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.create-location.v1"),
  ...commandContext,
  location: wireLocationSchema,
});

export const prepareCatalogListingCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.prepare-catalog-listing.v1"),
  ...commandContext,
  salesChannel: wireSalesChannelSchema,
  product: commerceProductV1Schema,
  variant: commerceVariantV1Schema,
  offer: wireOfferSchema,
  consumptionPlan: inventoryConsumptionPlanSchema,
});

export const updateProductDescriptionCommandSchema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.update-product-description.v1"),
  merchantId: text,
  expectedMerchantRevision: NonNegativeInteger,
  productId: text,
  expectedProductRevision: PositiveInteger,
  description: Type.String(),
  idempotencyKey: text,
  requestedAt: timestamp,
});

const storefrontCommandFields = {
  ...commandContext,
  location: wireLocationSchema,
  salesChannel: wireSalesChannelSchema,
  product: commerceProductV1Schema,
  variant: commerceVariantV1Schema,
  offer: wireOfferSchema,
  storefront: domainStorefrontSchema,
  consumptionPlan: inventoryConsumptionPlanSchema,
};

export const configurePickupStorefrontCommandSchema = Type.Refine(
  ReadonlyOpenObject({
    schemaVersion: Type.Literal("underclerk.configure-pickup-storefront.v1"),
    ...storefrontCommandFields,
  }),
  isPickupStorefront,
  pickupStorefrontError,
);

export const configureShippingStorefrontCommandSchema = Type.Refine(
  ReadonlyOpenObject({
    schemaVersion: Type.Literal("underclerk.configure-shipping-storefront.v1"),
    ...storefrontCommandFields,
    shippingProfile: shippingProfileSchema,
    shippingSpecification: variantShippingSpecificationSchema,
  }),
  isShippingStorefront,
  shippingStorefrontError,
);

function isPickupStorefront(command: {
  readonly storefront: { readonly fulfillment: { readonly kind: string } };
}): boolean {
  return command.storefront.fulfillment.kind === "pickup";
}

function pickupStorefrontError(): string {
  return "storefront.fulfillment.kind must be pickup";
}

function isShippingStorefront(command: {
  readonly storefront: { readonly fulfillment: { readonly kind: string } };
}): boolean {
  return command.storefront.fulfillment.kind === "shipping";
}

function shippingStorefrontError(): string {
  return "storefront.fulfillment.kind must be shipping";
}

export const channelListingCatalogSchema = Type.Union([
  ReadonlyOpenObject({
    kind: Type.Literal("new_product"),
    product: commerceProductV1Schema,
    variant: commerceVariantV1Schema,
    consumptionPlan: inventoryConsumptionPlanSchema,
  }),
  ReadonlyOpenObject({
    kind: Type.Literal("existing_variant"),
    variantId: text,
    variantRevision: PositiveInteger,
  }),
  ReadonlyOpenObject({
    kind: Type.Literal("new_variant"),
    productId: text,
    productRevision: PositiveInteger,
    variant: commerceVariantV1Schema,
    consumptionPlan: inventoryConsumptionPlanSchema,
  }),
]);

export const placeChannelListingCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.place-channel-listing.v1"),
  ...commandContext,
  salesChannelId: text,
  catalog: channelListingCatalogSchema,
  offer: wireOfferSchema,
  shippingSpecification: Type.Optional(variantShippingSpecificationSchema),
});

/** `parsePickupCheckoutSelection`: modifier options are distinct. */
export const pickupCheckoutSelectionSchema = Type.Union([
  ReadonlyOpenObject({ kind: Type.Literal("catalog"), variantId: text }),
  ReadonlyOpenObject({
    kind: Type.Literal("menu"),
    menuId: text,
    menuEntryId: text,
    modifierOptionIds: ImmutableArray(text, { uniqueItems: true }),
  }),
]);

/** `parsePickupCheckoutLine`: a positive whole quantity of `each`. */
export const pickupCheckoutLineSchema = ReadonlyOpenObject({
  cartLineId: text,
  checkoutLineId: text,
  source: pickupCheckoutSelectionSchema,
  quantity: Type.Refine(wireQuantitySchema, isPositiveEach, positiveEachError),
});

function isPositiveEach(quantity: {
  readonly amount: number;
  readonly scale: number;
  readonly unit: string;
}): boolean {
  return (
    quantity.amount > 0 && quantity.scale === 0 && quantity.unit === "each"
  );
}

function positiveEachError(): string {
  return "line.quantity must be a positive each quantity";
}

export const buyerContactAuthoritySchema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("provided"),
    contact: wireProtectedBuyerContactSchema,
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("retained_checkout"),
    checkoutId: text,
    checkoutRevision: PositiveInteger,
    quoteDigest: sha256HexSchema,
  }),
]);

export const checkoutBuyerAuthoritySchema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("guest"),
    contactAuthority: buyerContactAuthoritySchema,
    customerReference: Absent,
    contact: Absent,
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("identified_customer"),
    customerReference: text,
    contact: wireProtectedBuyerContactSchema,
    contactAuthority: Absent,
  }),
]);

const checkoutLines = ImmutableArray(pickupCheckoutLineSchema, { minItems: 1 });

export const createPickupCheckoutCommandSchema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.create-pickup-checkout.v1"),
  ...commandContext,
  storefrontId: text,
  storefrontRevision: PositiveInteger,
  checkoutProfile: wireCheckoutProfileReferenceSchema,
  buyerSessionDigest: sha256HexSchema,
  buyerAuthority: checkoutBuyerAuthoritySchema,
  cartId: text,
  checkoutId: text,
  lines: checkoutLines,
});

export const publishPointOfSaleConfigurationCommandSchema =
  ReadonlyStrictObject({
    schemaVersion: Type.Literal(
      "underclerk.publish-point-of-sale-configuration.v1",
    ),
    merchantId: text,
    expectedRevision: Type.Union([PositiveInteger, Type.Null()]),
    publishedAt: timestamp,
    publishedBy: text,
    configuration: Type.Unsafe<Readonly<Record<string, unknown>>>(
      Type.Record(Type.String(), Type.Unknown()),
    ),
  });

/** `normalizeDiscountCode`: trimmed, in upper case, 3 to 40 characters. */
export const discountCodeSchema = Type.Codec(
  Type.Refine(Type.String(), isDiscountCode, discountCodeError),
)
  .Decode(normalizeDiscountCode)
  .Encode(sameText);

function normalizeDiscountCode(value: string): string {
  return value.trim().toUpperCase();
}

function sameText(value: string): string {
  return value;
}

function isDiscountCode(value: string): boolean {
  return /^[A-Z0-9_-]{3,40}$/u.test(normalizeDiscountCode(value));
}

function discountCodeError(): string {
  return "a discount code must be 3 to 40 letters, digits, - or _";
}

export const createInPersonCheckoutCommandSchema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.create-in-person-checkout.v1"),
  ...commandContext,
  satyrLocationId: text,
  posConfigurationRevision: PositiveInteger,
  operatorIdentity: text,
  terminalAssignmentRevision: PositiveInteger,
  buyer: wirePointOfSaleBuyerSchema,
  checkoutId: text,
  lines: checkoutLines,
  discountCodes: Type.Optional(
    ImmutableArray(discountCodeSchema, { maxItems: 5 }),
  ),
});

const checkoutPaymentFields = {
  ...commandContext,
  checkoutId: text,
  checkoutRevision: PositiveInteger,
  quoteDigest: text,
  paymentAttemptId: text,
  providerRequestId: text,
  amount: wireMoneySchema,
};

export const beginCheckoutPaymentCommandSchema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.begin-checkout-payment.v1"),
  ...checkoutPaymentFields,
  paymentBinding: wireOnlinePaymentBindingSchema,
});

export const collectInPersonCheckoutPaymentCommandSchema = ReadonlyStrictObject(
  {
    schemaVersion: Type.Literal(
      "underclerk.collect-in-person-checkout-payment.v1",
    ),
    ...checkoutPaymentFields,
    paymentBinding: wireInPersonPaymentBindingSchema,
  },
);

const paymentAttemptFields = {
  ...commandContext,
  checkoutId: text,
  checkoutRevision: PositiveInteger,
  quoteDigest: text,
  paymentAttemptId: text,
  paymentAttemptRevision: PositiveInteger,
};

export const recordCheckoutPaymentCaptureCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.record-checkout-payment-capture.v1"),
  ...paymentAttemptFields,
  providerPaymentReference: text,
  capturedAt: timestamp,
});

export const placePaidCheckoutCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.place-paid-checkout.v1"),
  ...paymentAttemptFields,
  orderId: text,
  paymentId: text,
  fulfillmentId: text,
  buyer: wireBuyerSchema,
  placement: Type.Union([
    ReadonlyOpenObject({ kind: Type.Literal("pickup") }),
    ReadonlyOpenObject({ kind: Type.Literal("shipping"), shipmentId: text }),
  ]),
});

export const markPickupReadyCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.mark-pickup-ready.v1"),
  ...commandContext,
  orderId: text,
  orderRevision: PositiveInteger,
  fulfillmentId: text,
  fulfillmentRevision: PositiveInteger,
});

export const completePickupCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.complete-pickup.v1"),
  ...commandContext,
  orderId: text,
  orderRevision: PositiveInteger,
  paymentId: text,
  paymentRevision: PositiveInteger,
  fulfillmentId: text,
  fulfillmentRevision: PositiveInteger,
});

export const resolveCheckoutPaymentCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.resolve-checkout-payment.v1"),
  ...paymentAttemptFields,
  outcome: Type.Union([
    ReadonlyOpenObject({
      kind: Type.Literal("processing"),
      reasonCode: text,
      reconcileAfter: timestamp,
    }),
    ReadonlyOpenObject({
      kind: Type.Literal("indeterminate"),
      reasonCode: text,
      reconcileAfter: timestamp,
    }),
    ReadonlyOpenObject({ kind: Type.Literal("declined"), reasonCode: text }),
  ]),
});

export const expireCheckoutCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.expire-checkout.v1"),
  ...commandContext,
  checkoutId: text,
  checkoutRevision: PositiveInteger,
  quoteDigest: text,
});

export const publishCatalogListingCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.publish-catalog-listing.v1"),
  merchantId: text,
  idempotencyKey: text,
  requestedAt: timestamp,
  productId: text,
  productRevision: PositiveInteger,
  variantId: text,
  variantRevision: PositiveInteger,
  offerId: text,
  offerRevision: PositiveInteger,
  salesChannelId: text,
  salesChannelRevision: PositiveInteger,
});

export const createInventoryItemCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.create-inventory-item.v1"),
  ...commandContext,
  inventoryItemId: text,
  merchantCode: text,
  name: text,
  baseUnit: quantityUnitSchema,
  category: wireInventoryItemCategorySchema,
  tracking: wireInventoryTrackingSchema,
});

export const openInventoryPositionCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.open-inventory-position.v1"),
  ...commandContext,
  inventoryPositionId: text,
  inventoryItemId: text,
  inventoryItemRevision: PositiveInteger,
  locationId: text,
  locationRevision: PositiveInteger,
});

const positiveQuantity = Type.Refine(
  wireQuantitySchema,
  isPositiveQuantity,
  positiveQuantityError,
);

function isPositiveQuantity(quantity: { readonly amount: number }): boolean {
  return quantity.amount > 0;
}

function positiveQuantityError(): string {
  return "the quantity amount must be positive";
}

export const inventoryLotInputSchema = Type.Union([
  ReadonlyStrictObject({ kind: Type.Literal("not_tracked") }),
  ReadonlyOpenObject({
    kind: Type.Literal("tracked"),
    lotId: text,
    lotCode: text,
    expiry: wireInventoryLotExpirySchema,
  }),
]);

export const receiveInventoryCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.receive-inventory.v3"),
  ...commandContext,
  purchase: wireInventoryReceiptPurchaseSchema,
  receiptId: text,
  receiptLineId: text,
  inventoryItemId: text,
  inventoryItemRevision: PositiveInteger,
  inventoryPositionId: text,
  inventoryPositionRevision: PositiveInteger,
  locationId: text,
  receivedQuantity: positiveQuantity,
  lot: inventoryLotInputSchema,
  receivedAt: timestamp,
});

export const inventoryReconciliationTargetSchema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("aggregate"),
    lotId: Absent,
    lotRevision: Absent,
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("lot"),
    lotId: text,
    lotRevision: PositiveInteger,
  }),
]);

const explanation = Type.String({ ...normalizedTextSchema, maxLength: 1000 });

export const inventoryReconciliationChangeSchema = Type.Union([
  ReadonlyStrictObject({
    kind: Type.Literal("count"),
    observedQuantity: wireQuantitySchema,
    explanation,
    quantity: Absent,
    direction: Absent,
    reason: Absent,
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("adjustment"),
    direction: Type.Literal("increase"),
    quantity: positiveQuantity,
    reason: Type.Literal("correction"),
    explanation,
    observedQuantity: Absent,
  }),
  ReadonlyStrictObject({
    kind: Type.Literal("adjustment"),
    direction: Type.Literal("decrease"),
    quantity: positiveQuantity,
    reason: Type.Union([
      Type.Literal("correction"),
      Type.Literal("waste"),
      Type.Literal("damage"),
    ]),
    explanation,
    observedQuantity: Absent,
  }),
]);

export const reconcileInventoryCommandSchema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.reconcile-inventory.v1"),
  ...commandContext,
  inventoryPositionId: text,
  inventoryPositionRevision: PositiveInteger,
  target: inventoryReconciliationTargetSchema,
  change: inventoryReconciliationChangeSchema,
});

const count = NonNegativeInteger;

/** `parseMigrationInventory`: exactly one classification counts as 1. */
export const migrationInventorySchema = Type.Refine(
  ReadonlyOpenObject({
    schemaVersion: Type.Literal("underclerk.migration-inventory.v2"),
    organisationId: text,
    merchantId: text,
    merchantRevision: NonNegativeInteger,
    storageSchemaVersion: PositiveInteger,
    contractRevisions: ReadonlyOpenObject({
      source: text,
      target: Type.Literal("satyr.commerce.inventory.v1"),
    }),
    migrationDigest: sha256HexSchema,
    candidateClassification: Type.Union([
      Type.Literal("migrate"),
      Type.Literal("reject"),
    ]),
    classificationCounts: ReadonlyOpenObject({
      migrate: count,
      reset: count,
      reject: count,
    }),
    resources: ReadonlyOpenObject({
      locations: count,
      salesChannels: count,
      products: count,
      variants: count,
      inventoryItems: count,
      offers: count,
      inventoryPositions: count,
      orders: count,
      payments: count,
      fulfillments: count,
      shipments: count,
    }),
    foodService: ReadonlyOpenObject({ resourceSnapshots: count }),
    inventoryLedger: ReadonlyOpenObject({
      lots: count,
      movements: count,
      receiptIdentities: count,
      receiptIdentityDigest: sha256HexSchema,
    }),
    unresolvedMappings: ReadonlyOpenObject({
      inventoryItemCategories: count,
      inventoryItemTrackingPolicies: count,
      inventoryItemBaseUnits: count,
      inventoryPositionBalances: count,
      receiptIds: count,
    }),
    invariantFailures: ImmutableArray(
      ReadonlyOpenObject({ code: text, count: PositiveInteger }),
    ),
    operations: ReadonlyOpenObject({
      commandReceipts: count,
      pendingCommands: count,
      mutationLeases: count,
      pendingReceipts: count,
      pendingCommerceDeliveries: count,
      deliveredCommerceDeliveries: count,
    }),
  }),
  hasOneClassification,
  classificationError,
);

function hasOneClassification(inventory: {
  readonly candidateClassification: "migrate" | "reject";
  readonly classificationCounts: {
    readonly migrate: number;
    readonly reset: number;
    readonly reject: number;
  };
}): boolean {
  const counts = inventory.classificationCounts;
  return (
    counts.migrate + counts.reset + counts.reject === 1 &&
    counts.reset === 0 &&
    counts[inventory.candidateClassification] === 1
  );
}

function classificationError(): string {
  return "classificationCounts do not match candidateClassification";
}

export const offerPriceResultSchema = Type.Union([
  ReadonlyOpenObject({
    outcome: Type.Literal("accepted"),
    value: Type.Unknown(),
  }),
  ReadonlyOpenObject({
    outcome: Type.Literal("rejected"),
    refusal: ReadonlyOpenObject({
      code: Type.String(),
      field: Type.Optional(Type.String()),
    }),
  }),
]);

/** `parseSquarePaymentAccount`: the Square location linked to a merchant. */
export const commerceSquarePaymentAccountV1Schema = ReadonlyStrictObject({
  provider: Type.Literal("square"),
  paymentProviderBindingId: text,
  providerAccountId: text,
  locationId: text,
  environment: Type.Union([
    Type.Literal("development"),
    Type.Literal("production"),
  ]),
  country: text,
  currency: text,
  state: Type.Literal("active"),
  updatedAt: timestamp,
});
export type CommerceSquarePaymentAccountV1 = Static<
  typeof commerceSquarePaymentAccountV1Schema
>;

const squareEnvironment = Type.Union([
  Type.Literal("development"),
  Type.Literal("production"),
]);
const nullableText = Type.Union([text, Type.Null()]);

/** A merchant's Square connection (Plan 80 step 4); the tokens stay inside. */
export const commerceSquareConnectionV1Schema = ReadonlyStrictObject({
  provider: Type.Literal("square"),
  environment: squareEnvironment,
  applicationId: text,
  providerAccountId: text,
  businessName: nullableText,
  country: nullableText,
  currency: nullableText,
  /**
   * Why the connection works or stopped (Refactor 15): `connected`, a scope
   * that Commerce uses is missing, Square refused to refresh the token, or
   * the seller removed the application in Square.
   */
  state: Type.Union([
    Type.Literal("connected"),
    Type.Literal("scope_missing"),
    Type.Literal("refresh_failed"),
    Type.Literal("revoked"),
  ]),
  /**
   * The scopes that Square granted, or null when Square did not show them.
   * Optional so that a reader accepts an Commerce that has not sent it yet.
   */
  scopes: Type.Optional(Type.Union([ImmutableArray(text), Type.Null()])),
  connectedAt: timestamp,
  updatedAt: timestamp,
});
export type CommerceSquareConnectionV1 = Static<
  typeof commerceSquareConnectionV1Schema
>;

/** The locations of the connected Square account. */
export const commerceSquareLocationsV1Schema = ReadonlyStrictObject({
  locations: ImmutableArray(
    ReadonlyStrictObject({
      locationId: text,
      name: text,
      country: text,
      currency: text,
      status: text,
      cardPayments: Type.Boolean(),
    }),
  ),
});
export type CommerceSquareLocationsV1 = Static<
  typeof commerceSquareLocationsV1Schema
>;

/** The devices of the connected Square account. */
export const commerceSquareDevicesV1Schema = ReadonlyStrictObject({
  devices: ImmutableArray(
    ReadonlyStrictObject({
      deviceId: text,
      name: text,
      locationId: nullableText,
      status: text,
    }),
  ),
});
export type CommerceSquareDevicesV1 = Static<
  typeof commerceSquareDevicesV1Schema
>;

/** A code that pairs a Square Terminal for Terminal API checkouts. */
export const commerceSquareDeviceCodeV1Schema = ReadonlyStrictObject({
  deviceCodeId: text,
  code: text,
  name: Type.String({ maxLength: 128 }),
  locationId: text,
  status: text,
  pairBy: nullableText,
  deviceId: nullableText,
});
export type CommerceSquareDeviceCodeV1 = Static<
  typeof commerceSquareDeviceCodeV1Schema
>;

/** A Stripe account connected to a merchant (Plan 76 phase 3). */
export const commerceStripePaymentAccountV1Schema = ReadonlyStrictObject({
  provider: Type.Literal("stripe"),
  paymentProviderBindingId: text,
  providerAccountId: text,
  environment: squareEnvironment,
  country: text,
  currency: text,
  state: Type.Union([
    Type.Literal("onboarding"),
    Type.Literal("active"),
    Type.Literal("restricted"),
  ]),
  updatedAt: timestamp,
});
export type CommerceStripePaymentAccountV1 = Static<
  typeof commerceStripePaymentAccountV1Schema
>;

/** Stripe's hosted onboarding for a new account of the merchant. */
export const commerceStripeOnboardingV1Schema = ReadonlyStrictObject({
  account: commerceStripePaymentAccountV1Schema,
  url: text,
  expiresAt: timestamp,
});
export type CommerceStripeOnboardingV1 = Static<
  typeof commerceStripeOnboardingV1Schema
>;

/** The merchant's payment accounts at every provider. */
export const commercePaymentAccountsV1Schema = ReadonlyStrictObject({
  accounts: ImmutableArray(
    Type.Union([
      commerceStripePaymentAccountV1Schema,
      commerceSquarePaymentAccountV1Schema,
    ]),
  ),
});
export type CommercePaymentAccountsV1 = Static<
  typeof commercePaymentAccountsV1Schema
>;

// Parsers of the records above.
export const parseCommerceStripePaymentAccountV1Record = wireRecordParser(
  commerceStripePaymentAccountV1Schema,
);
export const parseCommerceStripeOnboardingV1Record = wireRecordParser(
  commerceStripeOnboardingV1Schema,
);
export const parseCommercePaymentAccountsV1Record = wireRecordParser(
  commercePaymentAccountsV1Schema,
);
export const parseCommerceSquarePaymentAccountV1Record = wireRecordParser(
  commerceSquarePaymentAccountV1Schema,
);
export const parseCommerceSquareConnectionV1Record = wireRecordParser(
  commerceSquareConnectionV1Schema,
);
export const parseCommerceSquareLocationsV1Record = wireRecordParser(
  commerceSquareLocationsV1Schema,
);
export const parseCommerceSquareDevicesV1Record = wireRecordParser(
  commerceSquareDevicesV1Schema,
);
export const parseCommerceSquareDeviceCodeV1Record = wireRecordParser(
  commerceSquareDeviceCodeV1Schema,
);
export const parseAdjustOfferPriceCommandRecord = wireRecordParser(
  adjustOfferPriceCommandSchema,
);
export const parseCounterSaleRecord = wireRecordParser(counterSaleSchema);
export const parsePaymentCaptureResultRecord = wireRecordParser(
  paymentCaptureResultSchema,
);
export const parseProvisionMerchantCommandRecord = wireRecordParser(
  provisionMerchantCommandSchema,
);
export const parseProvisionDemoCommandRecord = wireRecordParser(
  provisionDemoCommandSchema,
);
export const parseDemoProfileRecord = wireRecordParser(demoProfileSchema);
export const parseMerchantProvisioningResultRecord = wireRecordParser(
  merchantProvisioningResultSchema,
);
export const parseCreateLocationCommandRecord = wireRecordParser(
  createLocationCommandSchema,
);
export const parsePrepareCatalogListingCommandRecord = wireRecordParser(
  prepareCatalogListingCommandSchema,
);
export const parseUpdateProductDescriptionCommandRecord = wireRecordParser(
  updateProductDescriptionCommandSchema,
);
export const parseConfigurePickupStorefrontCommandRecord = wireRecordParser(
  configurePickupStorefrontCommandSchema,
);
export const parseConfigureShippingStorefrontCommandRecord = wireRecordParser(
  configureShippingStorefrontCommandSchema,
);
export const parsePlaceChannelListingCommandRecord = wireRecordParser(
  placeChannelListingCommandSchema,
);
export const parseCreatePickupCheckoutCommandRecord = wireRecordParser(
  createPickupCheckoutCommandSchema,
);
export const parsePublishPointOfSaleConfigurationCommandRecord =
  wireRecordParser(publishPointOfSaleConfigurationCommandSchema);
export const parseCreateInPersonCheckoutCommandRecord = wireRecordParser(
  createInPersonCheckoutCommandSchema,
);
export const parseBeginCheckoutPaymentCommandRecord = wireRecordParser(
  beginCheckoutPaymentCommandSchema,
);
export const parseCollectInPersonCheckoutPaymentCommandRecord =
  wireRecordParser(collectInPersonCheckoutPaymentCommandSchema);
export const parseRecordCheckoutPaymentCaptureCommandRecord = wireRecordParser(
  recordCheckoutPaymentCaptureCommandSchema,
);
export const parsePlacePaidCheckoutCommandRecord = wireRecordParser(
  placePaidCheckoutCommandSchema,
);
export const parseMarkPickupReadyCommandRecord = wireRecordParser(
  markPickupReadyCommandSchema,
);
export const parseCompletePickupCommandRecord = wireRecordParser(
  completePickupCommandSchema,
);
export const parseResolveCheckoutPaymentCommandRecord = wireRecordParser(
  resolveCheckoutPaymentCommandSchema,
);
export const parseExpireCheckoutCommandRecord = wireRecordParser(
  expireCheckoutCommandSchema,
);
export const parsePublishCatalogListingCommandRecord = wireRecordParser(
  publishCatalogListingCommandSchema,
);
export const parseCreateInventoryItemCommandRecord = wireRecordParser(
  createInventoryItemCommandSchema,
);
export const parseOpenInventoryPositionCommandRecord = wireRecordParser(
  openInventoryPositionCommandSchema,
);
export const parseReceiveInventoryCommandRecord = wireRecordParser(
  receiveInventoryCommandSchema,
);
export const parseReconcileInventoryCommandRecord = wireRecordParser(
  reconcileInventoryCommandSchema,
);
export const parseInventoryReconciliationTargetRecord = wireRecordParser(
  inventoryReconciliationTargetSchema,
);
export const parseInventoryReconciliationChangeRecord = wireRecordParser(
  inventoryReconciliationChangeSchema,
);
export const parseMigrationInventoryRecord = wireRecordParser(
  migrationInventorySchema,
);
export const parseOfferPriceResultRecord = wireRecordParser(
  offerPriceResultSchema,
);

// The client types of the records above.
export type AdjustCommerceOfferPriceV1 = Static<
  typeof adjustOfferPriceCommandSchema
>;
export type CommerceCounterSaleV1 = Static<typeof counterSaleSchema>;
export type CommercePaymentCaptureResultV1 = Static<
  typeof paymentCaptureResultSchema
>;
export type ProvisionCommerceMerchantV1 = Static<
  typeof provisionMerchantCommandSchema
>;
export type ProvisionCommerceDemoV1 = Static<
  typeof provisionDemoCommandSchema
>;
export type CommerceDemoProfile = Static<typeof demoProfileSchema>;
export type CommerceMerchantProvisioningResultV1 = Static<
  typeof merchantProvisioningResultSchema
>;
export type CreateCommerceLocationV1 = Static<
  typeof createLocationCommandSchema
>;
export type PrepareCommerceCatalogListingV1 = Static<
  typeof prepareCatalogListingCommandSchema
>;
export type UpdateCommerceProductDescriptionV1 = Static<
  typeof updateProductDescriptionCommandSchema
>;
export type ConfigureCommercePickupStorefrontV1 = Static<
  typeof configurePickupStorefrontCommandSchema
>;
export type ConfigureCommerceShippingStorefrontV1 = Static<
  typeof configureShippingStorefrontCommandSchema
>;
export type CommerceChannelListingCatalogV1 = Static<
  typeof channelListingCatalogSchema
>;
export type PlaceCommerceChannelListingV1 = Static<
  typeof placeChannelListingCommandSchema
>;
export type CommercePickupCheckoutSelectionV1 = Static<
  typeof pickupCheckoutSelectionSchema
>;
export type CommercePickupCheckoutLineV1 = Static<
  typeof pickupCheckoutLineSchema
>;
export type CommerceBuyerContactAuthorityV1 = Static<
  typeof buyerContactAuthoritySchema
>;
export type CommerceCheckoutBuyerAuthorityV1 = Static<
  typeof checkoutBuyerAuthoritySchema
>;
export type CreateCommercePickupCheckoutV1 = Static<
  typeof createPickupCheckoutCommandSchema
>;
export type PublishCommercePointOfSaleConfigurationV1 = Static<
  typeof publishPointOfSaleConfigurationCommandSchema
>;
export type CreateCommerceInPersonCheckoutV1 = Static<
  typeof createInPersonCheckoutCommandSchema
>;
export type BeginCommerceCheckoutPaymentV1 = Static<
  typeof beginCheckoutPaymentCommandSchema
>;
export type CollectCommerceInPersonCheckoutPaymentV1 = Static<
  typeof collectInPersonCheckoutPaymentCommandSchema
>;
export type RecordCommerceCheckoutPaymentCaptureV1 = Static<
  typeof recordCheckoutPaymentCaptureCommandSchema
>;
export type PlaceCommercePaidCheckoutV1 = Static<
  typeof placePaidCheckoutCommandSchema
>;
export type MarkCommercePickupReadyV1 = Static<
  typeof markPickupReadyCommandSchema
>;
export type CompleteCommercePickupV1 = Static<
  typeof completePickupCommandSchema
>;
export type ResolveCommerceCheckoutPaymentV1 = Static<
  typeof resolveCheckoutPaymentCommandSchema
>;
export type ExpireCommerceCheckoutV1 = Static<
  typeof expireCheckoutCommandSchema
>;
export type PublishCommerceCatalogListingV1 = Static<
  typeof publishCatalogListingCommandSchema
>;
export type CreateCommerceInventoryItemV1 = Static<
  typeof createInventoryItemCommandSchema
>;
export type OpenCommerceInventoryPositionV1 = Static<
  typeof openInventoryPositionCommandSchema
>;
export type CommerceInventoryLotInputV1 = Static<
  typeof inventoryLotInputSchema
>;
export type ReceiveCommerceInventoryV3 = Static<
  typeof receiveInventoryCommandSchema
>;
export type ReconcileCommerceInventoryV1 = Static<
  typeof reconcileInventoryCommandSchema
>;
export type CommerceMigrationInventoryV2 = Static<
  typeof migrationInventorySchema
>;
export type CommerceOfferPriceResultV1 = Static<
  typeof offerPriceResultSchema
>;

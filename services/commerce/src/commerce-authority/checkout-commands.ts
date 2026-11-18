import {
  readOfferRevision,
  readOrderRevision,
} from "../commerce-persistence.ts";
import { readPublishedPointOfSaleConfiguration } from "../point-of-sale-configuration-persistence.ts";
import {
  parseCreateInPersonCheckoutCommand,
  parseBeginCheckoutPaymentCommand,
  parseCreatePickupCheckoutCommand,
  parseExpireCheckoutCommand,
  parsePlacePaidCheckoutCommand,
  parseRecordCheckoutPaymentCaptureCommand,
  parseResolveCheckoutPaymentCommand,
  type BeginCommerceCheckoutPaymentV1,
  type CollectCommerceInPersonCheckoutPaymentV1,
  type CreateCommerceInPersonCheckoutV1,
  type CreateCommercePickupCheckoutV1,
  type ExpireCommerceCheckoutV1,
  type MarkCommerceDraftOrderPaidV1,
  type PlaceCommerceDraftOrderOnTermsV1,
  type PlaceCommercePaidCheckoutV1,
  type RecordCommerceCheckoutPaymentCaptureV1,
  type ResolveCommerceCheckoutPaymentV1,
  type CommerceFoodServiceSnapshotV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";
import type { CommerceDatabase } from "../database.ts";
import type { FoodServiceExtension } from "../plugins/built-in-ports.ts";
import type { RegionalShipping } from "../regional-shipping.ts";
import {
  readCart,
  readCheckout,
  readCheckoutPaymentAttempt,
  readStorefront,
} from "../checkout-persistence.ts";
import {
  planInPersonCheckout,
  planPickupCheckout,
  planShippingCheckout,
  cartSubmissionCheckoutPlanContext,
  initialCheckoutPlanContext,
  type BuyerPickupCheckoutCommand,
  type BuyerShippingCheckoutCommand,
  type InPersonCheckoutPlan,
  type PickupCheckoutPlan,
} from "./checkout-planning.ts";
import type { Cart } from "@seams/commerce-contracts";
import { balanceCheckoutOrder } from "./order-changes.ts";
import {
  existingPlacementResource,
  planCheckoutPaymentCapture,
  planCheckoutPaymentResolution,
  planCheckoutPaymentStart,
  planCheckoutExpiration,
  planManualCheckoutPlacement,
  planPaidCheckoutPlacement,
  type OfflinePlacementCommand,
  type PlacementTerms,
  planStoredValueCheckoutPlacement,
  type CheckoutExpirationPlan,
  type CheckoutPaymentCapturePlan,
  type CheckoutPaymentResolutionPlan,
  type CheckoutPaymentStartPlan,
  type CheckoutPlacementPlan,
  type PaidPlacementCommand,
  type PlaceCommerceStoredValueCheckoutV1,
} from "./checkout-payment-planning.ts";

export type CheckoutMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

export type CheckoutCommand =
  | CreateCommercePickupCheckoutV1
  | BuyerPickupCheckoutCommand
  | CreateCommerceInPersonCheckoutV1
  | BuyerShippingCheckoutCommand
  | BeginCommerceCheckoutPaymentV1
  | CollectCommerceInPersonCheckoutPaymentV1
  | RecordCommerceCheckoutPaymentCaptureV1
  | PlaceCommercePaidCheckoutV1
  | PlaceCommerceStoredValueCheckoutV1
  | MarkCommerceDraftOrderPaidV1
  | PlaceCommerceDraftOrderOnTermsV1
  | ResolveCommerceCheckoutPaymentV1
  | ExpireCommerceCheckoutV1;

export type CheckoutCommitRequest =
  | Readonly<{
      kind: "in_person_checkout";
      command: CreateCommerceInPersonCheckoutV1;
      merchant: CheckoutMerchantRow;
      plan: InPersonCheckoutPlan;
    }>
  | Readonly<{
      kind: "pickup_checkout";
      command: CreateCommercePickupCheckoutV1 | BuyerPickupCheckoutCommand;
      merchant: CheckoutMerchantRow;
      plan: PickupCheckoutPlan;
    }>
  | Readonly<{
      kind: "shipping_checkout";
      command: BuyerShippingCheckoutCommand;
      merchant: CheckoutMerchantRow;
      plan: PickupCheckoutPlan;
    }>
  | Readonly<{
      kind: "checkout_payment_start";
      command:
        | BeginCommerceCheckoutPaymentV1
        | CollectCommerceInPersonCheckoutPaymentV1;
      merchant: CheckoutMerchantRow;
      plan: CheckoutPaymentStartPlan;
    }>
  | Readonly<{
      kind: "checkout_payment_capture";
      command: RecordCommerceCheckoutPaymentCaptureV1;
      merchant: CheckoutMerchantRow;
      plan: CheckoutPaymentCapturePlan;
    }>
  | Readonly<{
      kind: "paid_checkout_placement";
      command: PaidPlacementCommand;
      merchant: CheckoutMerchantRow;
      plan: CheckoutPlacementPlan;
    }>
  | Readonly<{
      kind: "checkout_payment_resolution";
      command: ResolveCommerceCheckoutPaymentV1;
      merchant: CheckoutMerchantRow;
      plan: CheckoutPaymentResolutionPlan;
    }>
  | Readonly<{
      kind: "checkout_expiration";
      command: ExpireCommerceCheckoutV1;
      merchant: CheckoutMerchantRow;
      plan: CheckoutExpirationPlan;
    }>;

export type CheckoutCommandAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  /** The merchant's regional shipping, or undefined when it has none. */
  shipping: (merchantId: string) => RegionalShipping | undefined;
  foodService: FoodServiceExtension | undefined;
  now: () => string;
  readMerchant: (merchantId: string) => CheckoutMerchantRow | undefined;
  readSnapshot: (
    merchantId: string,
  ) => CommerceMerchantSnapshotV1 | undefined;
  readFoodServiceSnapshot: (
    merchantId: string,
  ) => CommerceFoodServiceSnapshotV1 | undefined;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command: CheckoutCommand,
  ) => CommerceMutationResultV1 | undefined;
  commit: (request: CheckoutCommitRequest) => CommerceMutationResultV1;
  validateMerchant: (
    merchantId: string,
    merchant: CheckoutMerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
}>;

export class CheckoutCommandAuthority {
  readonly #options: CheckoutCommandAuthorityOptions;

  constructor(options: CheckoutCommandAuthorityOptions) {
    this.#options = options;
  }

  createPickupCheckout(rawCommand: unknown): CommerceMutationResultV1 {
    let command: CreateCommercePickupCheckoutV1;
    try {
      command = parseCreatePickupCheckoutCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const storefront = readStorefront(
      this.#options.database,
      command.merchantId,
      command.storefrontId,
    );
    if (storefront === undefined) {
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "storefront",
        id: command.storefrontId,
      });
    }
    if (storefront.revision !== command.storefrontRevision) {
      return this.#options.rejected({
        code: "stale_resource_revision",
        kind: "storefront",
        id: command.storefrontId,
        expected: command.storefrontRevision,
        actual: storefront.revision,
      });
    }
    if (
      storefront.lifecycle.state !== "active" ||
      storefront.fulfillment.kind !== "pickup"
    ) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "storefront.lifecycle",
      });
    }
    if (
      new Set(command.lines.map((line) => line.cartLineId)).size !==
        command.lines.length ||
      new Set(command.lines.map((line) => line.checkoutLineId)).size !==
        command.lines.length
    ) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "checkout.lines",
      });
    }
    if (
      readCart(this.#options.database, command.merchantId, command.cartId) !==
      undefined
    ) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "cart",
        id: command.cartId,
      });
    }
    if (
      readCheckout(
        this.#options.database,
        command.merchantId,
        command.checkoutId,
      ) !== undefined
    ) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "checkout",
        id: command.checkoutId,
      });
    }
    const snapshot = this.#options.readSnapshot(command.merchantId);
    const foodService = this.#options.readFoodServiceSnapshot(
      command.merchantId,
    );
    if (snapshot === undefined || foodService === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const plan = planPickupCheckout(
      this.#options.database,
      command,
      storefront,
      snapshot.resources,
      foodService.resources,
      this.#options.foodService?.menus,
      initialCheckoutPlanContext(),
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "pickup_checkout",
      command,
      merchant,
      plan: plan.value,
    });
  }

  /**
   * Ring up a Checkout at a terminal.
   *
   * The storefront is resolved from the Pantry location rather than supplied by
   * the operator: a counter belongs to a location, and that location's
   * storefront carries the tax and lead-time policy the sale is priced under.
   */
  createInPersonCheckout(rawCommand: unknown): CommerceMutationResultV1 {
    let command: CreateCommerceInPersonCheckoutV1;
    try {
      command = parseCreateInPersonCheckoutCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    if (
      new Set(command.lines.map((line) => line.checkoutLineId)).size !==
      command.lines.length
    ) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "checkout.lines",
      });
    }
    if (
      readCheckout(
        this.#options.database,
        command.merchantId,
        command.checkoutId,
      ) !== undefined
    ) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "checkout",
        id: command.checkoutId,
      });
    }
    // The counter sells under its own published policy. No online storefront,
    // payment binding, contact, or buyer session is a prerequisite.
    const configuration = readPublishedPointOfSaleConfiguration(
      this.#options.database,
      command.merchantId,
      command.satyrLocationId,
    );
    if (configuration === undefined) {
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "point_of_sale_configuration",
        id: command.satyrLocationId,
      });
    }
    const snapshot = this.#options.readSnapshot(command.merchantId);
    const foodService = this.#options.readFoodServiceSnapshot(
      command.merchantId,
    );
    if (snapshot === undefined || foodService === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const plan = planInPersonCheckout(
      this.#options.database,
      command,
      configuration,
      snapshot.resources,
      foodService.resources,
      this.#options.foodService?.menus,
      initialCheckoutPlanContext(),
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "in_person_checkout",
      command,
      merchant,
      plan: plan.value,
    });
  }

  submitBuyerPickupCheckout(
    command: BuyerPickupCheckoutCommand,
  ): CommerceMutationResultV1 {
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const storefront = readStorefront(
      this.#options.database,
      command.merchantId,
      command.storefrontId,
    );
    if (storefront === undefined) {
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "storefront",
        id: command.storefrontId,
      });
    }
    if (storefront.revision !== command.storefrontRevision) {
      return this.#options.rejected({
        code: "stale_resource_revision",
        kind: "storefront",
        id: command.storefrontId,
        expected: command.storefrontRevision,
        actual: storefront.revision,
      });
    }
    if (
      storefront.lifecycle.state !== "active" ||
      storefront.fulfillment.kind !== "pickup"
    ) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "storefront.lifecycle",
      });
    }
    const cart = readCart(
      this.#options.database,
      command.merchantId,
      command.cartId,
    );
    const cartError = pickupCartSubmissionError(cart, command);
    if (cartError !== undefined) return this.#options.rejected(cartError);
    if (
      readCheckout(
        this.#options.database,
        command.merchantId,
        command.checkoutId,
      ) !== undefined
    ) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "checkout",
        id: command.checkoutId,
      });
    }
    const snapshot = this.#options.readSnapshot(command.merchantId);
    const foodService = this.#options.readFoodServiceSnapshot(
      command.merchantId,
    );
    if (
      snapshot === undefined ||
      foodService === undefined ||
      cart === undefined
    ) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const plan = planPickupCheckout(
      this.#options.database,
      command,
      storefront,
      snapshot.resources,
      foodService.resources,
      this.#options.foodService?.menus,
      cartSubmissionCheckoutPlanContext(cart.revision),
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "pickup_checkout",
      command,
      merchant,
      plan: plan.value,
    });
  }

  submitBuyerShippingCheckout(
    command: BuyerShippingCheckoutCommand,
  ): CommerceMutationResultV1 {
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const storefront = readStorefront(
      this.#options.database,
      command.merchantId,
      command.storefrontId,
    );
    if (storefront === undefined) {
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "storefront",
        id: command.storefrontId,
      });
    }
    if (storefront.revision !== command.storefrontRevision) {
      return this.#options.rejected({
        code: "stale_resource_revision",
        kind: "storefront",
        id: command.storefrontId,
        expected: command.storefrontRevision,
        actual: storefront.revision,
      });
    }
    if (
      storefront.lifecycle.state !== "active" ||
      storefront.fulfillment.kind !== "shipping"
    ) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "storefront.lifecycle",
      });
    }
    if (
      command.lines.length === 0 ||
      new Set(command.lines.map((line) => line.cartLineId)).size !==
        command.lines.length ||
      new Set(command.lines.map((line) => line.checkoutLineId)).size !==
        command.lines.length ||
      new Set(command.lines.map((line) => line.variantId)).size !==
        command.lines.length
    ) {
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "checkout.lines",
      });
    }
    const cart = readCart(
      this.#options.database,
      command.merchantId,
      command.cartId,
    );
    const cartError = shippingCartSubmissionError(cart, command);
    if (cartError !== undefined) return this.#options.rejected(cartError);
    if (
      readCheckout(
        this.#options.database,
        command.merchantId,
        command.checkoutId,
      ) !== undefined
    ) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "checkout",
        id: command.checkoutId,
      });
    }
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (snapshot === undefined || cart === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const plan = planShippingCheckout(
      this.#options.database,
      this.#options.shipping(command.merchantId),
      command,
      storefront,
      snapshot.resources,
      cartSubmissionCheckoutPlanContext(cart.revision),
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "shipping_checkout",
      command,
      merchant,
      plan: plan.value,
    });
  }

  beginCheckoutPayment(rawCommand: unknown): CommerceMutationResultV1 {
    let command: BeginCommerceCheckoutPaymentV1;
    try {
      command = parseBeginCheckoutPaymentCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    return this.#startCheckoutPayment(command);
  }

  startInPersonCheckoutPayment(
    command: CollectCommerceInPersonCheckoutPaymentV1,
  ): CommerceMutationResultV1 {
    return this.#startCheckoutPayment(command);
  }

  #startCheckoutPayment(
    command:
      | BeginCommerceCheckoutPaymentV1
      | CollectCommerceInPersonCheckoutPaymentV1,
  ): CommerceMutationResultV1 {
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    if (
      readCheckoutPaymentAttempt(
        this.#options.database,
        command.merchantId,
        command.paymentAttemptId,
      ) !== undefined
    ) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "checkout_payment_attempt",
        id: command.paymentAttemptId,
      });
    }
    const plan = planCheckoutPaymentStart(
      command,
      readCheckout(
        this.#options.database,
        command.merchantId,
        command.checkoutId,
      ),
      (offerId) =>
        readOfferRevision(this.#options.database, command.merchantId, offerId),
      (orderId) =>
        readOrderRevision(this.#options.database, command.merchantId, orderId),
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "checkout_payment_start",
      command,
      merchant,
      plan: plan.value,
    });
  }

  recordCheckoutPaymentCapture(
    rawCommand: unknown,
  ): CommerceMutationResultV1 {
    let command: RecordCommerceCheckoutPaymentCaptureV1;
    try {
      command = parseRecordCheckoutPaymentCaptureCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const plan = planCheckoutPaymentCapture(
      command,
      readCheckout(
        this.#options.database,
        command.merchantId,
        command.checkoutId,
      ),
      readCheckoutPaymentAttempt(
        this.#options.database,
        command.merchantId,
        command.paymentAttemptId,
      ),
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "checkout_payment_capture",
      command,
      merchant,
      plan: plan.value,
    });
  }

  placePaidCheckout(rawCommand: unknown): CommerceMutationResultV1 {
    let command: PlaceCommercePaidCheckoutV1;
    try {
      command = parsePlacePaidCheckoutCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (snapshot === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    const checkout = readCheckout(
      this.#options.database,
      command.merchantId,
      command.checkoutId,
    );
    const existing = existingPlacementResource(
      command,
      snapshot.resources,
      checkout !== undefined && balanceCheckoutOrder(checkout) !== undefined,
    );
    if (existing !== undefined) return this.#options.rejected(existing);
    const plan = planPaidCheckoutPlacement(
      this.#options.database,
      command,
      checkout,
      readCheckoutPaymentAttempt(
        this.#options.database,
        command.merchantId,
        command.paymentAttemptId,
      ),
      snapshot.resources,
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "paid_checkout_placement",
      command,
      merchant,
      plan: plan.value,
    });
  }

  /**
   * Places a checkout that gift cards and store credit pay in full. The
   * buyer's route builds the command from a verified session.
   */
  placeStoredValueCheckout(
    command: PlaceCommerceStoredValueCheckoutV1,
  ): CommerceMutationResultV1 {
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    if (merchant.revision !== command.expectedMerchantRevision)
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (snapshot === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    const existing = existingPlacementResource(
      command,
      snapshot.resources,
      false,
    );
    if (existing !== undefined) return this.#options.rejected(existing);
    const plan = planStoredValueCheckoutPlacement(
      this.#options.database,
      command,
      readCheckout(
        this.#options.database,
        command.merchantId,
        command.checkoutId,
      ),
      (offerId) =>
        readOfferRevision(this.#options.database, command.merchantId, offerId),
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "paid_checkout_placement",
      command,
      merchant,
      plan: plan.value,
    });
  }

  /**
   * Places a draft's quoted checkout that staff were paid for in cash or by
   * bank transfer. The draft authority checks the draft and its replay, and
   * the receipt is the staff command's own.
   */
  placeManuallyPaidCheckout(
    command: OfflinePlacementCommand,
    checkoutId: string,
    terms?: PlacementTerms,
  ): CommerceMutationResultV1 {
    const merchant = this.#options.readMerchant(command.merchantId);
    const snapshot = this.#options.readSnapshot(command.merchantId);
    if (merchant === undefined || snapshot === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    const existing = existingPlacementResource(
      {
        ...command,
        checkoutId,
        buyer: { kind: "guest" },
        placement: { kind: "pickup" },
      },
      snapshot.resources,
      false,
    );
    if (existing !== undefined) return this.#options.rejected(existing);
    const plan = planManualCheckoutPlacement(
      this.#options.database,
      command,
      terms,
      readCheckout(this.#options.database, command.merchantId, checkoutId),
      (offerId) =>
        readOfferRevision(this.#options.database, command.merchantId, offerId),
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "paid_checkout_placement",
      command,
      merchant,
      plan: plan.value,
    });
  }

  resolveCheckoutPayment(rawCommand: unknown): CommerceMutationResultV1 {
    let command: ResolveCommerceCheckoutPaymentV1;
    try {
      command = parseResolveCheckoutPaymentCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const plan = planCheckoutPaymentResolution(
      this.#options.database,
      command,
      readCheckout(
        this.#options.database,
        command.merchantId,
        command.checkoutId,
      ),
      readCheckoutPaymentAttempt(
        this.#options.database,
        command.merchantId,
        command.paymentAttemptId,
      ),
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "checkout_payment_resolution",
      command,
      merchant,
      plan: plan.value,
    });
  }

  /**
   * Expires each online checkout whose quote lapsed while it still holds
   * stock, through the same command that staff send; a checkout with a
   * payment under way is not touched. Returns when the next quote lapses, or
   * null when no checkout holds stock.
   */
  expireLapsedCheckouts(): string | null {
    const now = this.#options.now();
    for (const lapsed of this.#heldCheckouts(20)) {
      if (lapsed.expiresAt > now) break;
      const merchant = this.#options.readMerchant(lapsed.merchantId);
      if (merchant === undefined) continue;
      const key = `checkout_expiry_${lapsed.checkoutId}_${lapsed.revision}`;
      this.expireCheckout({
        schemaVersion: "underclerk.expire-checkout.v1",
        merchantId: lapsed.merchantId,
        expectedMerchantRevision: merchant.revision,
        idempotencyKey: key,
        requestedAt: now,
        checkoutId: lapsed.checkoutId,
        checkoutRevision: lapsed.revision,
        quoteDigest: lapsed.quoteDigest,
      });
    }
    return this.#heldCheckouts(1)[0]?.expiresAt ?? null;
  }

  // Online checkouts that hold stock and await payment, earliest lapse first.
  #heldCheckouts(limit: number): readonly Readonly<{
    merchantId: string;
    checkoutId: string;
    revision: number;
    quoteDigest: string;
    expiresAt: string;
  }>[] {
    return this.#options.database
      .prepare(
        `SELECT checkout.merchant_id AS merchantId,
                checkout.checkout_id AS checkoutId,
                checkout.revision AS revision,
                checkout.quote_digest AS quoteDigest,
                json_extract(checkout.checkout_json, '$.lifecycle.quote.expiresAt')
                  AS expiresAt
         FROM buyer_checkout AS checkout
         WHERE checkout.source_kind = 'online'
           AND checkout.lifecycle_state = 'quoted'
           AND EXISTS (
             SELECT 1 FROM inventory_allocation AS allocation
             WHERE allocation.merchant_id = checkout.merchant_id
               AND allocation.owner_kind = 'checkout'
               AND allocation.owner_id = checkout.checkout_id
               AND allocation.lifecycle_state = 'held'
           )
         ORDER BY expiresAt, checkout.checkout_id
         LIMIT ?`,
      )
      .all<
        Readonly<{
          merchantId: string;
          checkoutId: string;
          revision: number;
          quoteDigest: string;
          expiresAt: string;
        }>
      >(limit);
  }

  expireCheckout(rawCommand: unknown): CommerceMutationResultV1 {
    let command: ExpireCommerceCheckoutV1;
    try {
      command = parseExpireCheckoutCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const plan = planCheckoutExpiration(
      this.#options.database,
      command,
      readCheckout(
        this.#options.database,
        command.merchantId,
        command.checkoutId,
      ),
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "checkout_expiration",
      command,
      merchant,
      plan: plan.value,
    });
  }
}

function pickupCartSubmissionError(
  cart: Cart | undefined,
  command: BuyerPickupCheckoutCommand,
): CommerceMutationErrorV1 | undefined {
  const commonError = buyerCartSubmissionError(cart, command);
  if (commonError !== undefined || cart === undefined) return commonError;
  return samePickupCartLines(cart, command) ? undefined : invalidCartLines();
}

function shippingCartSubmissionError(
  cart: Cart | undefined,
  command: BuyerShippingCheckoutCommand,
): CommerceMutationErrorV1 | undefined {
  const commonError = buyerCartSubmissionError(cart, command);
  if (commonError !== undefined || cart === undefined) return commonError;
  return sameShippingCartLines(cart, command) ? undefined : invalidCartLines();
}

function buyerCartSubmissionError(
  cart: Cart | undefined,
  command: BuyerPickupCheckoutCommand | BuyerShippingCheckoutCommand,
): CommerceMutationErrorV1 | undefined {
  if (cart === undefined) {
    return { code: "resource_not_found", kind: "cart", id: command.cartId };
  }
  if (cart.revision !== command.cartRevision) {
    return {
      code: "stale_resource_revision",
      kind: "cart",
      id: cart.cartId,
      expected: command.cartRevision,
      actual: cart.revision,
    };
  }
  if (
    cart.lifecycle.state !== "active" ||
    cart.storefrontId !== command.storefrontId ||
    cart.checkoutProfile.checkoutProfileId !==
      command.checkoutProfile.checkoutProfileId ||
    cart.checkoutProfile.revision !== command.checkoutProfile.revision ||
    cart.buyerSessionDigest !== command.buyerSessionDigest
  ) {
    return { code: "resource_relationship_invalid", field: "checkout.cart" };
  }
  return undefined;
}

function samePickupCartLines(
  cart: Cart,
  command: BuyerPickupCheckoutCommand,
): boolean {
  if (cart.lines.length !== command.lines.length) return false;
  for (const [index, cartLine] of cart.lines.entries()) {
    const commandLine = command.lines[index];
    if (
      commandLine === undefined ||
      commandLine.cartLineId !== cartLine.cartLineId ||
      commandLine.quantity.amount !== cartLine.quantity.amount ||
      commandLine.quantity.scale !== cartLine.quantity.scale ||
      commandLine.quantity.unit !== cartLine.quantity.unit
    ) {
      return false;
    }
    if (cartLine.source.kind === "catalog") {
      if (
        commandLine.source.kind !== "catalog" ||
        commandLine.source.variantId !== cartLine.source.variantId
      )
        return false;
      continue;
    }
    if (
      commandLine.source.kind !== "menu" ||
      commandLine.source.menuId !== cartLine.source.menuId ||
      commandLine.source.menuEntryId !== cartLine.source.menuEntryId ||
      !sameIdentifiers(
        commandLine.source.modifierOptionIds,
        cartLine.source.modifierOptionIds,
      )
    ) {
      return false;
    }
  }
  return true;
}

function sameShippingCartLines(
  cart: Cart,
  command: BuyerShippingCheckoutCommand,
): boolean {
  if (cart.lines.length !== command.lines.length) return false;
  for (const [index, cartLine] of cart.lines.entries()) {
    const commandLine = command.lines[index];
    if (
      commandLine === undefined ||
      cartLine.source.kind !== "catalog" ||
      commandLine.cartLineId !== cartLine.cartLineId ||
      commandLine.variantId !== cartLine.source.variantId ||
      commandLine.quantity !== cartLine.quantity.amount ||
      cartLine.quantity.scale !== 0 ||
      cartLine.quantity.unit !== "each"
    ) {
      return false;
    }
  }
  return true;
}

function sameIdentifiers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every(identifierAtIndex.bind(undefined, right))
  );
}

function identifierAtIndex(
  right: readonly string[],
  identifier: string,
  index: number,
): boolean {
  return right[index] === identifier;
}

function invalidCartLines(): CommerceMutationErrorV1 {
  return {
    code: "resource_relationship_invalid",
    field: "checkout.cart.lines",
  };
}

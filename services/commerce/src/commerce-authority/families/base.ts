import {
  type PublishCommerceCatalogListingV1,
  type ConfigureCommercePickupStorefrontV1,
  type ConfigureCommerceShippingStorefrontV1,
  type CreateCommerceInPersonCheckoutV1,
  type CreateCommercePickupCheckoutV1,
  type BeginCommerceCheckoutPaymentV1,
  type CollectCommerceInPersonCheckoutPaymentV1,
  type RecordCommerceCheckoutPaymentCaptureV1,
  type MarkCommercePickupReadyV1,
  type CompleteCommercePickupV1,
  type ResolveCommerceCheckoutPaymentV1,
  type ExpireCommerceCheckoutV1,
  type CreateCommerceInventoryItemV1,
  type OpenCommerceInventoryPositionV1,
  type ReceiveCommerceInventoryV3,
  type ReconcileCommerceInventoryV1,
  type CommerceProductV1,
  type CommerceMutationResultV1,
  type ObserveCommercePaymentDisputeV1,
  type CommerceOfferV1,
  type CommerceInventoryItemV1,
  type CommerceInventoryPositionV1,
  type CreateCommerceLocationV1,
  type PrepareCommerceCatalogListingV1,
  type UpdateCommerceProductDescriptionV1,
  type PlaceCommerceChannelListingV1,
  type CommerceFulfillmentV1,
  type CommerceFirstPartyShipmentV1,
  type PurchaseShippingLabelCommand,
  type AttachFulfillmentTrackingCommand,
  type RecordShippingTrackingCommand,
  type CancelCommerceOrderV1,
  type RefundCommerceOrderV1,
} from "@seams/commerce-client";
import type {
  Checkout,
  CheckoutPaymentAttempt,
  InventoryAllocation,
  PaymentDispute,
  ShipmentLabelRateSnapshot,
} from "@seams/commerce-contracts";
import type { CommerceDatabase } from "../../database.ts";
import { CheckoutProfileService } from "../../checkout-profile-service.ts";
import { PointOfSaleConfigurationService } from "../../point-of-sale-configuration-service.ts";
import {
  catalogEditMutation,
  catalogListingPreparationMutation,
  channelListingPlacementMutation,
  locationMutation,
  pickupStorefrontConfigurationMutation,
  productDescriptionMutation,
  publishMutation,
  shippingStorefrontConfigurationMutation,
} from "../catalog-mutations.ts";
import {
  inventoryItemMutation,
  inventoryMovementMutation,
  inventoryPositionMutation,
} from "../inventory-mutations.ts";
import {
  balanceCheckoutMutation,
  checkoutPaymentCaptureMutation,
  checkoutPaymentStartMutation,
  checkoutReleaseMutation,
  inPersonCheckoutMutation,
  paidCheckoutPlacementMutation,
  paymentDisputeObservationMutation,
  pickupCheckoutMutation,
  shippingCheckoutMutation,
} from "../checkout-mutations.ts";
import {
  fulfillmentTrackingAttachmentMutation,
  pickupCompletionMutation,
  pickupReadyMutation,
  shippingLabelMutation,
  shippingTrackingMutation,
} from "../fulfillment-mutations.ts";
import {
  draftOrderMutation,
  orderEditMutation,
  orderExchangeMutation,
  returnMutation,
} from "../order-mutations.ts";
import {
  collectionMutation,
  customerMutation,
  discountMutation,
  marketMutation,
  storedValueMutation,
  mediaMutation,
  pluginMutation,
  webhookSubscriptionMutation,
} from "../merchant-mutations.ts";
import {
  cancellationReservation,
  cancellationResolutionMutation,
  refundReservation,
  refundResolutionMutation,
} from "../after-sale-mutations.ts";
import { CommerceLedger, type MerchantRow } from "../ledger.ts";
import type { CommerceSigner } from "../contracts.ts";
import type {
  InPersonCollectionGateway,
  PaymentProvider,
} from "../../payments/provider.ts";
import type {
  ShippingGateway,
  ShippingLabelPurchaseResult,
} from "../../shipping-gateway.ts";
import { CommerceSnapshotReader } from "../commerce-snapshot.ts";
import { ProvisioningAuthority } from "../provisioning.ts";
import {
  CatalogCommandAuthority,
  type CatalogCommitRequest,
} from "../catalog-commands.ts";
import {
  InventoryCommandAuthority,
  type InventoryCommitRequest,
} from "../inventory-commands.ts";
import {
  CheckoutCommandAuthority,
  type CheckoutCommitRequest,
} from "../checkout-commands.ts";
import type {
  BuyerPickupCheckoutCommand,
  BuyerShippingCheckoutCommand,
  InPersonCheckoutPlan,
  PickupCheckoutPlan,
} from "../checkout-planning.ts";
import type {
  CheckoutExpirationPlan,
  CheckoutPaymentCapturePlan,
  CheckoutPaymentResolutionPlan,
  CheckoutPaymentStartPlan,
  CheckoutPlacementPlan,
  PaidPlacementCommand,
} from "../checkout-payment-planning.ts";
import { BuyerCheckoutAuthority } from "../buyer-checkout.ts";
import { FulfillmentCommandAuthority } from "../fulfillment-commands.ts";
import type {
  FulfillmentTrackingAttachmentPlan,
  PickupCompletionPlan,
  ShippingTrackingPlan,
} from "../fulfillment-planning.ts";
import type { CatalogEditPlan } from "../catalog-edits.ts";
import {
  DraftOrderCommandAuthority,
  type DraftOrderCommitRequest,
} from "../../plugins/draft-orders/index.ts";
import {
  ReturnCommandAuthority,
  type ReturnCommitRequest,
} from "../../plugins/returns/index.ts";
import {
  OrderEditCommandAuthority,
  type OrderBalanceCheckoutRequest,
  type OrderEditCommitRequest,
  type OrderExchangeCommitRequest,
} from "../order-edits.ts";
import {
  CustomerAuthority,
  type CustomerCommitRequest,
} from "../../plugins/customers/index.ts";
import {
  MediaAuthority,
  type MediaCommitRequest,
} from "../../plugins/media/index.ts";
import {
  MarketAuthority,
  type MarketCommitRequest,
} from "../../plugins/markets/index.ts";
import {
  CompanyAuthority,
  InvoiceAuthority,
} from "../../plugins/companies/index.ts";
import {
  DiscountAuthority,
  type DiscountCommitRequest,
} from "../../plugins/discounts/index.ts";
import {
  StoredValueAuthority,
  type StoredValueCommitRequest,
} from "../../plugins/stored-value/index.ts";
import {
  PluginAuthority,
  type PluginCommitRequest,
} from "../../plugins/plugin-authority.ts";
import type { QuickJsFunctionRuntime } from "../../plugins/function-runtime.ts";
import {
  CollectionAuthority,
  type CollectionCommitRequest,
} from "../../plugins/collections/index.ts";
import { productDeletionMutation } from "../product-deletion.ts";
import { ArchiveAuthority } from "../../archive.ts";
import { WebhookAuthority, type WebhookCommitRequest } from "../../webhooks.ts";
import type { InventoryMovementPlan } from "../inventory.ts";
import type {
  ExtensionMutation,
  FoodServiceCommands,
  FoodServiceMutationCommand,
} from "../../plugins/built-in-ports.ts";
import {
  AfterSaleCommandAuthority,
  type CancellationReservationPlan,
  type CancellationResolutionPlan,
  type RefundReservationPlan,
  type RefundResolutionPlan,
} from "../after-sale-cancellation.ts";
import { assertNever } from "@seams/std";

/**
 * The commerce authority's state, which the class assigns, and the commits of every command family (Refactor 14).
 */
export abstract class CommerceAuthorityBase {
  protected abstract readonly database: CommerceDatabase;

  protected abstract readonly signer: CommerceSigner;

  protected abstract readonly paymentGateway: PaymentProvider;

  protected abstract readonly functionRuntime:
    QuickJsFunctionRuntime | undefined;

  protected abstract readonly inPersonCollectionGateway:
    InPersonCollectionGateway | undefined;

  protected abstract readonly now: () => string;

  protected abstract readonly shippingGateway: ShippingGateway;

  protected abstract readonly catalogCommands: CatalogCommandAuthority;

  protected abstract readonly draftOrders: DraftOrderCommandAuthority;

  protected abstract readonly returns: ReturnCommandAuthority;

  protected abstract readonly orderEdits: OrderEditCommandAuthority;

  protected abstract readonly customers: CustomerAuthority;

  protected abstract readonly webhooks: WebhookAuthority;

  protected abstract readonly archive: ArchiveAuthority;

  protected abstract readonly collections: CollectionAuthority;

  protected abstract readonly discounts: DiscountAuthority;

  protected abstract readonly storedValue: StoredValueAuthority;

  protected abstract readonly plugins: PluginAuthority;

  protected abstract readonly markets: MarketAuthority;

  protected abstract readonly companies: CompanyAuthority;

  protected abstract readonly invoices: InvoiceAuthority;

  protected abstract readonly media: MediaAuthority;

  protected abstract readonly inventoryCommands: InventoryCommandAuthority;

  protected abstract readonly checkoutCommands: CheckoutCommandAuthority;

  protected abstract readonly buyerCheckout: BuyerCheckoutAuthority;

  protected abstract readonly fulfillmentCommands: FulfillmentCommandAuthority;

  protected abstract readonly foodService: FoodServiceCommands | undefined;

  protected abstract readonly commerceSnapshots: CommerceSnapshotReader;

  protected abstract readonly provisioning: ProvisioningAuthority;

  protected abstract readonly checkoutProfiles: CheckoutProfileService;

  protected abstract readonly pointOfSaleConfigurations: PointOfSaleConfigurationService;

  protected abstract readonly afterSaleCommands: AfterSaleCommandAuthority;

  protected abstract readonly ledger: CommerceLedger;

  protected quoteShippingLabelRateThroughGateway(
    input: Parameters<ShippingGateway["quoteLabelRate"]>[0],
  ) {
    return this.shippingGateway.quoteLabelRate(input);
  }

  protected purchaseShippingLabelThroughGateway(
    input: Parameters<ShippingGateway["purchaseLabel"]>[0],
  ) {
    return this.shippingGateway.purchaseLabel(input);
  }

  protected verifyShippingTracking(
    input: Parameters<ShippingGateway["verifyTrackingEvent"]>[0],
  ): boolean {
    return this.shippingGateway.verifyTrackingEvent(input);
  }

  close(): void {
    this.database.close();
  }

  /** The authority's clock, for HTTP commands built from a buyer request. */
  currentTime(): string {
    return this.now();
  }

  hasMerchant(merchantId: string): boolean {
    return this.ledger.readMerchant(merchantId) !== undefined;
  }

  /**
   * What the server adds to a write body (Plan 80 step 1): the time of the
   * request on this merchant's clock.
   */
  commandContext(): Readonly<{ requestedAt: string }> {
    return { requestedAt: this.now() };
  }

  protected commitChannelListingPlacement(
    command: PlaceCommerceChannelListingV1,
    merchant: MerchantRow,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      channelListingPlacementMutation(
        command,
        merchant,
        this.now(),
        this.collections,
      ),
    );
  }

  protected kitchen(): FoodServiceCommands {
    if (this.foodService === undefined)
      throw new Error("The food service extension is not installed");
    return this.foodService;
  }

  protected commitCatalogMutation(
    request: CatalogCommitRequest,
  ): CommerceMutationResultV1 {
    switch (request.kind) {
      case "location":
        return this.commitLocation(request.command, request.merchant);
      case "catalog_listing_preparation":
        return this.commitCatalogListingPreparation(
          request.command,
          request.merchant,
        );
      case "product_description":
        return this.commitProductDescription(
          request.command,
          request.merchant,
          request.product,
        );
      case "pickup_storefront":
        return this.commitPickupStorefrontConfiguration(
          request.command,
          request.merchant,
          request.createLocation,
        );
      case "shipping_storefront":
        return this.commitShippingStorefrontConfiguration(
          request.command,
          request.merchant,
          request.createLocation,
        );
      case "channel_listing":
        return this.commitChannelListingPlacement(
          request.command,
          request.merchant,
        );
      case "publish_catalog_listing":
        return this.commitPublish(
          request.command,
          request.merchant,
          request.offer,
        );
      case "catalog_edit":
        return this.commitCatalogEdit(request.merchant, request.plan);
      case "product_deletion":
        return this.ledger.commit(
          productDeletionMutation(
            request.merchant,
            request.plan,
            this.now(),
            this.collections,
          ),
        );
      default:
        return assertNever(request, "Unexpected commerce authority request");
    }
  }

  protected commitInventoryMutation(
    request: InventoryCommitRequest,
  ): CommerceMutationResultV1 {
    switch (request.kind) {
      case "inventory_item":
        return this.commitInventoryItem(
          request.command,
          request.merchant,
          request.item,
        );
      case "inventory_position":
        return this.commitInventoryPosition(
          request.command,
          request.merchant,
          request.position,
        );
      case "inventory_receipt":
      case "inventory_reconciliation":
        return this.commitInventoryMovement(
          request.command,
          request.merchant,
          request.plan,
        );
      default:
        return assertNever(request, "Unexpected commerce authority request");
    }
  }

  protected commitCheckoutMutation(
    request: CheckoutCommitRequest,
  ): CommerceMutationResultV1 {
    switch (request.kind) {
      case "in_person_checkout":
        return this.commitInPersonCheckout(
          request.command,
          request.merchant,
          request.plan,
        );
      case "pickup_checkout":
        return this.commitPickupCheckout(
          request.command,
          request.merchant,
          request.plan,
        );
      case "shipping_checkout":
        return this.commitShippingCheckout(
          request.command,
          request.merchant,
          request.plan,
        );
      case "checkout_payment_start":
        return this.commitCheckoutPaymentStart(
          request.command,
          request.merchant,
          request.plan,
        );
      case "checkout_payment_capture":
        return this.commitCheckoutPaymentCapture(
          request.command,
          request.merchant,
          request.plan,
        );
      case "paid_checkout_placement":
        return this.commitPaidCheckoutPlacement(
          request.command,
          request.merchant,
          request.plan,
        );
      case "checkout_payment_resolution":
        return this.commitCheckoutPaymentResolution(
          request.command,
          request.merchant,
          request.plan,
        );
      case "checkout_expiration":
        return this.commitCheckoutExpiration(
          request.command,
          request.merchant,
          request.plan,
        );
      default:
        return assertNever(request, "Unexpected commerce authority request");
    }
  }

  protected commitExtensionMutation(
    mutation: ExtensionMutation<FoodServiceMutationCommand>,
  ): CommerceMutationResultV1 {
    return this.ledger.commit({ ...mutation, committedAt: this.now() });
  }

  protected commitLocation(
    command: CreateCommerceLocationV1,
    merchant: MerchantRow,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(locationMutation(command, merchant, this.now()));
  }

  protected commitCatalogListingPreparation(
    command: PrepareCommerceCatalogListingV1,
    merchant: MerchantRow,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      catalogListingPreparationMutation(
        command,
        merchant,
        this.now(),
        this.collections,
      ),
    );
  }

  protected commitProductDescription(
    command: UpdateCommerceProductDescriptionV1,
    merchant: MerchantRow,
    product: CommerceProductV1,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      productDescriptionMutation(
        command,
        merchant,
        product,
        this.now(),
        this.collections,
      ),
    );
  }

  // Draft orders carry no aggregate observation yet: Pantry's projection has no
  // draft kind. The delivery keeps the merchant revision sequence whole.
  protected commitDraftOrder(
    request: DraftOrderCommitRequest,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      draftOrderMutation(request, this.now(), (merchantId, email, at) =>
        this.customers.sealBuyerEmail(merchantId, email, at),
      ),
    );
  }

  protected commitReturn(
    request: ReturnCommitRequest,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(returnMutation(request, this.now()));
  }

  protected commitMedia(
    request: MediaCommitRequest,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(mediaMutation(request, this.now()));
  }

  protected commitMarket(
    request: MarketCommitRequest,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(marketMutation(request, this.now()));
  }

  protected commitDiscount(
    request: DiscountCommitRequest,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(discountMutation(request, this.now()));
  }

  protected commitStoredValue(
    request: StoredValueCommitRequest,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(storedValueMutation(request, this.now()));
  }

  protected commitPlugin(
    request: PluginCommitRequest,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(pluginMutation(request, this.now()));
  }

  protected commitCollection(
    request: CollectionCommitRequest,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(collectionMutation(request, this.now()));
  }

  protected commitWebhookSubscription(
    request: WebhookCommitRequest,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(webhookSubscriptionMutation(request, this.now()));
  }

  protected commitCustomer(
    request: CustomerCommitRequest,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(customerMutation(request, this.now()));
  }

  protected commitOrderEdit(
    request: OrderEditCommitRequest,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(orderEditMutation(request, this.now()));
  }

  protected commitOrderExchange(
    request: OrderExchangeCommitRequest,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(orderExchangeMutation(request, this.now()));
  }

  protected commitBalanceCheckout(request: OrderBalanceCheckoutRequest): void {
    this.ledger.commit(balanceCheckoutMutation(request, this.now()));
  }

  protected commitCatalogEdit(
    merchant: MerchantRow,
    plan: CatalogEditPlan,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      catalogEditMutation(merchant, plan, this.now(), this.collections),
    );
  }

  protected commitPickupStorefrontConfiguration(
    command: ConfigureCommercePickupStorefrontV1,
    merchant: MerchantRow,
    createLocation: boolean,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      pickupStorefrontConfigurationMutation(
        command,
        merchant,
        createLocation,
        this.now(),
        this.collections,
        this.checkoutProfiles,
      ),
    );
  }

  protected commitShippingStorefrontConfiguration(
    command: ConfigureCommerceShippingStorefrontV1,
    merchant: MerchantRow,
    createLocation: boolean,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      shippingStorefrontConfigurationMutation(
        command,
        merchant,
        createLocation,
        this.now(),
        this.collections,
        this.checkoutProfiles,
      ),
    );
  }

  protected commitInPersonCheckout(
    command: CreateCommerceInPersonCheckoutV1,
    merchant: MerchantRow,
    plan: InPersonCheckoutPlan,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      inPersonCheckoutMutation(command, merchant, plan, this.now()),
    );
  }

  protected commitPickupCheckout(
    command: CreateCommercePickupCheckoutV1 | BuyerPickupCheckoutCommand,
    merchant: MerchantRow,
    plan: PickupCheckoutPlan,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      pickupCheckoutMutation(command, merchant, plan, this.now()),
    );
  }

  protected commitShippingCheckout(
    command: BuyerShippingCheckoutCommand,
    merchant: MerchantRow,
    plan: PickupCheckoutPlan,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      shippingCheckoutMutation(command, merchant, plan, this.now()),
    );
  }

  protected commitCheckoutPaymentStart(
    command:
      | BeginCommerceCheckoutPaymentV1
      | CollectCommerceInPersonCheckoutPaymentV1,
    merchant: MerchantRow,
    plan: CheckoutPaymentStartPlan,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      checkoutPaymentStartMutation(command, merchant, plan, this.now()),
    );
  }

  protected commitCheckoutPaymentCapture(
    command: RecordCommerceCheckoutPaymentCaptureV1,
    merchant: MerchantRow,
    plan: CheckoutPaymentCapturePlan,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      checkoutPaymentCaptureMutation(command, merchant, plan, this.now()),
    );
  }

  protected commitPaymentDisputeObservation(
    command: ObserveCommercePaymentDisputeV1,
    merchant: MerchantRow,
    dispute: PaymentDispute,
    existing: PaymentDispute | undefined,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      paymentDisputeObservationMutation(
        command,
        merchant,
        dispute,
        existing,
        this.now(),
      ),
    );
  }

  protected commitPaidCheckoutPlacement(
    command: PaidPlacementCommand,
    merchant: MerchantRow,
    plan: CheckoutPlacementPlan,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      paidCheckoutPlacementMutation(
        command,
        merchant,
        plan,
        this.now(),
        this.customers,
      ),
    );
  }

  protected commitPickupReady(
    command: MarkCommercePickupReadyV1,
    merchant: MerchantRow,
    fulfillment: CommerceFulfillmentV1,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      pickupReadyMutation(
        command,
        merchant,
        fulfillment,
        this.now(),
        this.customers,
      ),
    );
  }

  protected commitPickupCompletion(
    command: CompleteCommercePickupV1,
    merchant: MerchantRow,
    plan: PickupCompletionPlan,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      pickupCompletionMutation(command, merchant, plan, this.now()),
    );
  }

  protected commitShippingLabel(
    command: PurchaseShippingLabelCommand,
    merchant: MerchantRow,
    shipment: CommerceFirstPartyShipmentV1,
    rate: ShipmentLabelRateSnapshot,
    purchase: ShippingLabelPurchaseResult,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      shippingLabelMutation(command, merchant, shipment, rate, purchase),
    );
  }

  protected commitShippingTracking(
    command: RecordShippingTrackingCommand,
    merchant: MerchantRow,
    plan: ShippingTrackingPlan,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      shippingTrackingMutation(command, merchant, plan, this.customers),
    );
  }

  protected commitFulfillmentTrackingAttachment(
    command: AttachFulfillmentTrackingCommand,
    merchant: MerchantRow,
    plan: FulfillmentTrackingAttachmentPlan,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      fulfillmentTrackingAttachmentMutation(
        command,
        merchant,
        plan,
        this.customers,
      ),
    );
  }

  protected commitCheckoutPaymentResolution(
    command: ResolveCommerceCheckoutPaymentV1,
    merchant: MerchantRow,
    plan: CheckoutPaymentResolutionPlan,
  ): CommerceMutationResultV1 {
    return this.commitCheckoutReleaseMutation(
      command,
      merchant,
      plan.checkout,
      plan.paymentAttempt,
      plan.kind === "declined" ? plan.allocations : [],
      plan.kind === "declined" ? plan.positions : [],
      "resolve_checkout_payment",
      "checkout_payment_attempt",
      plan.paymentAttempt.paymentAttemptId,
      plan.paymentAttempt.revision,
    );
  }

  protected commitCheckoutExpiration(
    command: ExpireCommerceCheckoutV1,
    merchant: MerchantRow,
    plan: CheckoutExpirationPlan,
  ): CommerceMutationResultV1 {
    return this.commitCheckoutReleaseMutation(
      command,
      merchant,
      plan.checkout,
      undefined,
      plan.allocations,
      plan.positions,
      "expire_checkout",
      "checkout",
      plan.checkout.checkoutId,
      plan.checkout.revision,
    );
  }

  protected commitCheckoutReleaseMutation(
    command: ResolveCommerceCheckoutPaymentV1 | ExpireCommerceCheckoutV1,
    merchant: MerchantRow,
    checkout: Checkout,
    paymentAttempt: CheckoutPaymentAttempt | undefined,
    allocations: readonly InventoryAllocation[],
    positions: readonly CommerceInventoryPositionV1[],
    commandKind: "resolve_checkout_payment" | "expire_checkout",
    resourceKind: "checkout_payment_attempt" | "checkout",
    resourceId: string,
    resourceRevision: number,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      checkoutReleaseMutation(
        command,
        merchant,
        checkout,
        paymentAttempt,
        allocations,
        positions,
        commandKind,
        resourceKind,
        resourceId,
        resourceRevision,
        this.now(),
      ),
    );
  }

  protected commitPublish(
    command: PublishCommerceCatalogListingV1,
    merchant: MerchantRow,
    offer: CommerceOfferV1,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      publishMutation(command, merchant, offer, this.now(), this.collections),
    );
  }

  protected commitInventoryItem(
    command: CreateCommerceInventoryItemV1,
    merchant: MerchantRow,
    item: CommerceInventoryItemV1,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      inventoryItemMutation(command, merchant, item, this.now()),
    );
  }

  protected commitInventoryPosition(
    command: OpenCommerceInventoryPositionV1,
    merchant: MerchantRow,
    position: CommerceInventoryPositionV1,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      inventoryPositionMutation(command, merchant, position, this.now()),
    );
  }

  protected commitInventoryMovement(
    command: ReceiveCommerceInventoryV3 | ReconcileCommerceInventoryV1,
    merchant: MerchantRow,
    plan: InventoryMovementPlan,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      inventoryMovementMutation(command, merchant, plan),
    );
  }

  protected reserveCancellation(
    command: CancelCommerceOrderV1,
    merchant: MerchantRow,
    plan: CancellationReservationPlan,
    digest: string,
  ): void {
    this.ledger.reserve(
      cancellationReservation(command, merchant, plan, digest),
    );
  }

  protected resolveCancellation(
    command: CancelCommerceOrderV1,
    merchant: MerchantRow,
    plan: CancellationResolutionPlan,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      cancellationResolutionMutation(
        command,
        merchant,
        plan,
        this.now(),
        this.customers,
      ),
    );
  }

  protected reserveRefund(
    command: RefundCommerceOrderV1,
    merchant: MerchantRow,
    plan: RefundReservationPlan,
    digest: string,
  ): void {
    this.ledger.reserve(refundReservation(command, merchant, plan, digest));
  }

  protected resolveRefund(
    command: RefundCommerceOrderV1,
    merchant: MerchantRow,
    plan: RefundResolutionPlan,
  ): CommerceMutationResultV1 {
    return this.ledger.commit(
      refundResolutionMutation(
        command,
        merchant,
        plan,
        this.now(),
        this.customers,
      ),
    );
  }
}

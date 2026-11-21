import type { CommerceDatabase } from "./database.ts";
import { CheckoutProfileService } from "./checkout-profile-service.ts";
import { PointOfSaleConfigurationService } from "./point-of-sale-configuration-service.ts";
import {
  companyMutation,
  invoiceMutation,
} from "./commerce-authority/merchant-mutations.ts";
import {
  CommerceLedger,
  commandDigest,
  rejected,
} from "./commerce-authority/ledger.ts";
import type { CommerceSigner } from "./commerce-authority/contracts.ts";
import { assertCommerceSchemaReady } from "./schema.ts";
import type {
  InPersonCollectionGateway,
  PaymentProvider,
} from "./payments/provider.ts";
import type { ShippingGateway } from "./shipping-gateway.ts";
import { ReadyCheckoutProviderCapabilityHealthProvider } from "./regional-shipping.ts";
import { CommerceSnapshotReader } from "./commerce-authority/commerce-snapshot.ts";
import { ProvisioningAuthority } from "./commerce-authority/provisioning.ts";
import { CatalogCommandAuthority } from "./commerce-authority/catalog-commands.ts";
import { InventoryCommandAuthority } from "./commerce-authority/inventory-commands.ts";
import { CheckoutCommandAuthority } from "./commerce-authority/checkout-commands.ts";
import { BuyerCheckoutAuthority } from "./commerce-authority/buyer-checkout.ts";
import { FulfillmentCommandAuthority } from "./commerce-authority/fulfillment-commands.ts";
import { DraftOrderCommandAuthority } from "./plugins/draft-orders/index.ts";
import { ReturnCommandAuthority } from "./plugins/returns/index.ts";
import { OrderEditCommandAuthority } from "./commerce-authority/order-edits.ts";
import { CustomerAuthority, CustomerVault } from "./plugins/customers/index.ts";
import { MediaAuthority } from "./plugins/media/index.ts";
import { MarketAuthority } from "./plugins/markets/index.ts";
import {
  CompanyAuthority,
  InvoiceAuthority,
  termsOfCustomer,
  type CompanyCommitRequest,
  type InvoiceCommitRequest,
} from "./plugins/companies/index.ts";
import {
  DiscountAuthority,
  discountActivity,
} from "./plugins/discounts/index.ts";
import {
  StoredValueAuthority,
  storedValueHeldCheckouts,
} from "./plugins/stored-value/index.ts";
import { PluginAuthority } from "./plugins/plugin-authority.ts";
import { builtInPluginSettings } from "./plugins/registry.ts";
import type { QuickJsFunctionRuntime } from "./plugins/function-runtime.ts";
import { orderSubject } from "./plugins/machine-guards.ts";
import { pluginActive, readPluginState } from "./plugins/plugin-state.ts";
import { deletePluginFieldValuesOf } from "./plugins/merchant-plugins.ts";
import { buyerOrderCount } from "./plugins/plugin-commands.ts";
import { CollectionAuthority } from "./plugins/collections/index.ts";
import { ArchiveAuthority } from "./archive.ts";
import { WebhookAuthority } from "./webhooks.ts";
import type { FoodServiceCommands } from "./plugins/built-in-ports.ts";
import { foodServiceExtension } from "./plugins/food-service/index.ts";
import { purchasingExtension } from "./plugins/purchasing/index.ts";
import { AfterSaleCommandAuthority } from "./commerce-authority/after-sale-cancellation.ts";
import { isRecord } from "@purin-labs/std";
import type { CommerceAuthorityOptions } from "./commerce-authority/authority-options.ts";
import { invalidCommand } from "./commerce-authority/command-guards.ts";
import { BuyerFamily } from "./commerce-authority/families/buyer.ts";

export type { CommerceSigner } from "./commerce-authority/contracts.ts";

export type {
  BuyerPaymentResult,
  BuyerStorefrontContext,
} from "./commerce-authority/buyer-checkout/types.ts";

/**
 * The commerce authority of one merchant database. This class holds the state and wires the command authorities; each layer in commerce-authority/families/ holds one command family (Refactor 14).
 */
export class CommerceAuthority extends BuyerFamily {
  protected readonly database: CommerceDatabase;
  protected readonly signer: CommerceSigner;
  protected readonly paymentGateway: PaymentProvider;
  protected readonly functionRuntime: QuickJsFunctionRuntime | undefined;
  protected readonly inPersonCollectionGateway:
    InPersonCollectionGateway | undefined;
  protected readonly now: () => string;
  protected readonly shippingGateway: ShippingGateway;
  protected readonly catalogCommands: CatalogCommandAuthority;
  protected readonly draftOrders: DraftOrderCommandAuthority;
  protected readonly returns: ReturnCommandAuthority;
  protected readonly orderEdits: OrderEditCommandAuthority;
  protected readonly customers: CustomerAuthority;
  protected readonly webhooks: WebhookAuthority;
  protected readonly archive: ArchiveAuthority;
  protected readonly collections: CollectionAuthority;
  protected readonly discounts: DiscountAuthority;
  protected readonly storedValue: StoredValueAuthority;
  protected readonly plugins: PluginAuthority;
  protected readonly markets: MarketAuthority;
  protected readonly companies: CompanyAuthority;
  protected readonly invoices: InvoiceAuthority;
  protected readonly media: MediaAuthority;
  protected readonly inventoryCommands: InventoryCommandAuthority;
  protected readonly checkoutCommands: CheckoutCommandAuthority;
  protected readonly buyerCheckout: BuyerCheckoutAuthority;
  protected readonly fulfillmentCommands: FulfillmentCommandAuthority;
  protected readonly foodService: FoodServiceCommands | undefined;
  protected readonly commerceSnapshots: CommerceSnapshotReader;
  protected readonly provisioning: ProvisioningAuthority;
  protected readonly checkoutProfiles: CheckoutProfileService;
  protected readonly pointOfSaleConfigurations: PointOfSaleConfigurationService;
  protected readonly afterSaleCommands: AfterSaleCommandAuthority;
  protected readonly ledger: CommerceLedger;

  constructor(options: CommerceAuthorityOptions) {
    super();
    this.database = options.database;
    this.signer = options.signer;
    this.paymentGateway = options.paymentGateway;
    this.functionRuntime = options.functionRuntime;
    this.inPersonCollectionGateway = options.inPersonCollectionGateway;
    this.now = options.now;
    this.shippingGateway = options.shippingGateway;
    assertCommerceSchemaReady(this.database);
    this.ledger = new CommerceLedger(this.database, this.signer);
    this.customers = new CustomerAuthority({
      database: this.database,
      vault:
        options.customerDataRoot === undefined
          ? undefined
          : new CustomerVault(options.customerDataRoot),
      now: this.now,
      ...this.ledger.commandPorts,
      commit: this.commitCustomer.bind(this),
      onErase: (merchantId, customerId) =>
        deletePluginFieldValuesOf(
          this.database,
          merchantId,
          "customer",
          customerId,
        ),
    });
    this.archive = new ArchiveAuthority(this.database, this.now);
    this.markets = new MarketAuthority({
      database: this.database,
      ...this.ledger.commandPorts,
      commit: this.commitMarket.bind(this),
    });
    this.companies = new CompanyAuthority({
      database: this.database,
      ...this.ledger.commandPorts,
      commit: (request: CompanyCommitRequest) =>
        this.ledger.commit(companyMutation(request, this.now())),
    });
    this.invoices = new InvoiceAuthority({
      database: this.database,
      now: this.now,
      ...this.ledger.commandPorts,
      commit: (request: InvoiceCommitRequest) =>
        this.ledger.commit(invoiceMutation(request, this.now())),
    });
    this.media = new MediaAuthority({
      database: this.database,
      ...this.ledger.commandPorts,
      commit: this.commitMedia.bind(this),
    });
    this.discounts = new DiscountAuthority({
      database: this.database,
      ...this.ledger.commandPorts,
      commit: this.commitDiscount.bind(this),
    });
    this.storedValue = new StoredValueAuthority({
      database: this.database,
      ...this.ledger.commandPorts,
      commit: this.commitStoredValue.bind(this),
    });
    this.collections = new CollectionAuthority({
      database: this.database,
      ...this.ledger.commandPorts,
      commit: this.commitCollection.bind(this),
    });
    this.plugins = new PluginAuthority({
      database: this.database,
      now: this.now,
      ...this.ledger.commandPorts,
      commit: this.commitPlugin.bind(this),
      dataEffects: (merchantId, pluginId) => {
        if (pluginId === "stored_value") {
          const liability = this.storedValue.liability(merchantId, this.now());
          return [
            {
              kind: "open_balances",
              accounts: liability.currencies.reduce(
                (sum, currency) => sum + currency.accounts,
                0,
              ),
              balances: liability.currencies.map((currency) => ({
                amountMinor:
                  currency.giftCards.amountMinor +
                  currency.storeCredit.amountMinor,
                currency: currency.currency,
              })),
            },
            {
              kind: "held_checkouts",
              checkouts: storedValueHeldCheckouts(this.database, merchantId),
            },
          ];
        }
        if (pluginId === "discounts") {
          const activity = discountActivity(this.database, merchantId);
          return [
            { kind: "active_discounts", discounts: activity.discounts },
            { kind: "held_checkouts", checkouts: activity.heldCheckouts },
          ];
        }
        return [];
      },
      prepareVms: (count) => this.functionRuntime?.prepare(count),
      readVariants: (merchantId) =>
        this.readSnapshot(merchantId)?.resources.variants ?? [],
      customerExists: (merchantId, customerId) =>
        this.customers.readCustomer(merchantId, customerId) !== undefined,
      readProductIds: (merchantId) =>
        this.readSnapshot(merchantId)?.resources.products.map(
          (product) => product.id,
        ) ?? [],
      readReceipt: this.ledger.readReceiptOfKey.bind(this.ledger),
      applyCommand: (command) =>
        isRecord(command) &&
        command.schemaVersion === "commerce.create-discount.v1"
          ? this.discounts.createDiscount(command)
          : isRecord(command) &&
              command.schemaVersion === "commerce.credit-store-credit.v1"
            ? this.storedValue.creditStoreCredit(command)
            : rejected(invalidCommand(new Error("Unknown plugin command"))),
      readOrderBuyer: (merchantId, orderId) => {
        const order = this.readSnapshot(merchantId)?.resources.orders.find(
          (item) => item.id === orderId,
        );
        const customerId = this.customers.customerIdFor(
          merchantId,
          "order",
          orderId,
        );
        return order === undefined || customerId === null
          ? undefined
          : { customerId, currency: order.totals.total.currency };
      },
      readOrder: (merchantId, id) => {
        const resources = this.readSnapshot(merchantId)?.resources;
        const orderId =
          resources?.fulfillments.find((item) => item.id === id)?.orderId ?? id;
        const order = resources?.orders.find((item) => item.id === orderId);
        if (resources === undefined || order === undefined) return undefined;
        const placed = buyerOrderCount(this.database, merchantId, orderId);
        return {
          ...orderSubject(
            order,
            resources.fulfillments.find((item) => item.orderId === orderId),
            resources.variants,
          ),
          buyer:
            order.buyer.kind === "identified" && placed !== null
              ? {
                  kind: "identified",
                  customerReference: order.buyer.customerReference,
                  placedOrders: placed,
                }
              : { kind: "guest" },
        };
      },
    });
    this.webhooks = new WebhookAuthority({
      database: this.database,
      now: this.now,
      ...this.ledger.commandPorts,
      commit: this.commitWebhookSubscription.bind(this),
      ...(options.webhookAddressAllowed === undefined
        ? {}
        : { addressAllowed: options.webhookAddressAllowed }),
    });
    this.checkoutProfiles = new CheckoutProfileService(this.database);
    this.pointOfSaleConfigurations = new PointOfSaleConfigurationService(
      this.database,
    );
    this.commerceSnapshots = new CommerceSnapshotReader({
      database: this.database,
      signer: this.signer,
      readMerchant: this.ledger.readMerchant.bind(this.ledger),
    });
    this.catalogCommands = new CatalogCommandAuthority({
      database: this.database,
      ...this.ledger.commandPorts,
      now: this.now,
      readMenus: (merchantId) =>
        this.commerceSnapshots.readFoodServiceResources(merchantId).menus,
      readSnapshot: this.readSnapshot.bind(this),
      commit: this.commitCatalogMutation.bind(this),
    });
    this.inventoryCommands = new InventoryCommandAuthority({
      database: this.database,
      ...this.ledger.commandPorts,
      now: this.now,
      readSnapshot: this.readSnapshot.bind(this),
      commit: this.commitInventoryMutation.bind(this),
      checkReceiptPurchase: purchasingExtension.checkReceiptPurchase,
    });
    // A merchant who paused Japan export shipping ships nothing.
    const regionalShipping = (merchantId: string) =>
      options.shipping !== undefined &&
      pluginActive(this.database, merchantId, "japan_export")
        ? options.shipping
        : undefined;
    this.checkoutCommands = new CheckoutCommandAuthority({
      database: this.database,
      ...this.ledger.commandPorts,
      now: this.now,
      readSnapshot: this.readSnapshot.bind(this),
      readFoodServiceSnapshot: this.readFoodServiceSnapshot.bind(this),
      commit: this.commitCheckoutMutation.bind(this),
      shipping: regionalShipping,
      foodService: foodServiceExtension,
    });
    this.buyerCheckout = new BuyerCheckoutAuthority({
      database: this.database,
      now: this.now,
      readMerchant: this.ledger.readMerchant.bind(this.ledger),
      readSnapshot: this.readSnapshot.bind(this),
      readFoodServiceResources:
        this.commerceSnapshots.readFoodServiceResources.bind(
          this.commerceSnapshots,
        ),
      checkoutCommands: this.checkoutCommands,
      paymentGateway: this.paymentGateway,
      shipping: regionalShipping,
      foodService: foodServiceExtension,
      checkoutCapabilityHealthProvider:
        options.checkoutCapabilityHealthProvider ??
        new ReadyCheckoutProviderCapabilityHealthProvider(),
      commitPickupCheckout: this.commitPickupCheckout.bind(this),
      commitShippingCheckout: this.commitShippingCheckout.bind(this),
      recordCheckoutBuyer: this.customers.recordCheckoutBuyer.bind(
        this.customers,
      ),
      findCustomerId: this.customers.findCustomerId.bind(this.customers),
    });
    const buyerCheckout = this.buyerCheckout;
    this.draftOrders = new DraftOrderCommandAuthority({
      database: this.database,
      ...this.ledger.commandPorts,
      now: this.now,
      readSnapshot: this.readSnapshot.bind(this),
      commit: this.commitDraftOrder.bind(this),
      buyers: {
        sealsBuyers: this.customers.sealsBuyers,
        customerEmail: (merchantId, customerId) =>
          this.customers.customerEmail(merchantId, customerId),
      },
      createDraftCheckout:
        buyerCheckout.createDraftPickupCheckout.bind(buyerCheckout),
      readBuyerQuotedCheckout:
        buyerCheckout.readBuyerQuotedCheckout.bind(buyerCheckout),
      draftCheckoutClaims: (merchantId, storefrontId, sessionId) => {
        const context = this.readBuyerStorefrontContext(
          merchantId,
          storefrontId,
        );
        const active = this.readActiveCheckoutProfile(merchantId, storefrontId);
        return context === undefined || active === undefined
          ? undefined
          : {
              sessionId,
              organisationId: context.organisationId,
              merchantId,
              storefrontId,
              storefrontRevision: context.storefront.revision,
              checkoutProfile: {
                checkoutProfileId: active.profile.checkoutProfileId,
                revision: active.profile.revision,
              },
              buyer: { kind: "guest" },
            };
      },
      placeManually: this.checkoutCommands.placeManuallyPaidCheckout.bind(
        this.checkoutCommands,
      ),
      termsOf: (merchantId, customerId) =>
        pluginActive(this.database, merchantId, "companies")
          ? termsOfCustomer(this.database, merchantId, customerId)
          : undefined,
    });
    this.orderEdits = new OrderEditCommandAuthority({
      database: this.database,
      ...this.ledger.commandPorts,
      now: this.now,
      readSnapshot: this.readSnapshot.bind(this),
      readFoodServiceResources:
        this.commerceSnapshots.readFoodServiceResources.bind(
          this.commerceSnapshots,
        ),
      commit: this.commitOrderEdit.bind(this),
      commitExchange: this.commitOrderExchange.bind(this),
      commitBalanceCheckout: this.commitBalanceCheckout.bind(this),
      readBuyerQuotedCheckout:
        buyerCheckout.readBuyerQuotedCheckout.bind(buyerCheckout),
    });
    this.returns = new ReturnCommandAuthority({
      database: this.database,
      ...this.ledger.commandPorts,
      now: this.now,
      readSnapshot: this.readSnapshot.bind(this),
      commit: this.commitReturn.bind(this),
      readSettings: (merchantId) =>
        builtInPluginSettings(
          "returns",
          readPluginState(this.database, merchantId, "returns").settings,
        ),
    });
    this.afterSaleCommands = new AfterSaleCommandAuthority({
      database: this.database,
      ...this.ledger.commandPorts,
      paymentGateway: this.paymentGateway,
      now: this.now,
      readSnapshot: this.readSnapshot.bind(this),
      commandDigest,
      reserveCancellation: this.reserveCancellation.bind(this),
      resolveCancellation: this.resolveCancellation.bind(this),
      reserveRefund: this.reserveRefund.bind(this),
      resolveRefund: this.resolveRefund.bind(this),
      customerIdForOrder: (merchantId, orderId) =>
        this.customers.customerIdFor(merchantId, "order", orderId),
    });
    this.fulfillmentCommands = new FulfillmentCommandAuthority({
      database: this.database,
      ...this.ledger.commandPorts,
      readSnapshot: this.readSnapshot.bind(this),
      readFoodServiceResources:
        this.commerceSnapshots.readFoodServiceResources.bind(
          this.commerceSnapshots,
        ),
      commitPickupReady: this.commitPickupReady.bind(this),
      commitPickupCompletion: this.commitPickupCompletion.bind(this),
      commitShippingLabel: this.commitShippingLabel.bind(this),
      commitFulfillmentTrackingAttachment:
        this.commitFulfillmentTrackingAttachment.bind(this),
      commitShippingTracking: this.commitShippingTracking.bind(this),
      quoteLabelRate: this.quoteShippingLabelRateThroughGateway.bind(this),
      purchaseLabel: this.purchaseShippingLabelThroughGateway.bind(this),
      verifyTrackingEvent: this.verifyShippingTracking.bind(this),
    });
    this.foodService = foodServiceExtension.commands({
      database: this.database,
      ...this.ledger.commandPorts,
      now: this.now,
      readSnapshot: this.readSnapshot.bind(this),
      readFoodServiceSnapshot: this.readFoodServiceSnapshot.bind(this),
      commit: this.commitExtensionMutation.bind(this),
    });
    this.provisioning = new ProvisioningAuthority({
      database: this.database,
      readMerchant: this.ledger.readMerchant.bind(this.ledger),
      readSnapshot: this.readSnapshot.bind(this),
      readFoodServiceSnapshot: this.readFoodServiceSnapshot.bind(this),
      readFoodServiceResources:
        this.commerceSnapshots.readFoodServiceResources.bind(
          this.commerceSnapshots,
        ),
      listInventoryLots: this.inventoryCommands.listInventoryLots.bind(
        this.inventoryCommands,
      ),
      listInventoryMovements:
        this.inventoryCommands.listInventoryMovements.bind(
          this.inventoryCommands,
        ),
      createLocation: this.createLocation.bind(this),
      prepareCatalogListing: this.prepareCatalogListing.bind(this),
      configurePickupStorefront: this.configurePickupStorefront.bind(this),
      publishCatalogListing: this.publishCatalogListing.bind(this),
      createInventoryItem: this.createInventoryItem.bind(this),
      openInventoryPosition: this.openInventoryPosition.bind(this),
      receiveInventory: this.receiveInventory.bind(this),
      createPreparationStation: this.createPreparationStation.bind(this),
      createModifierGroupRevision: this.createModifierGroupRevision.bind(this),
      createRecipeRevision: this.createRecipeRevision.bind(this),
      configureStockPolicy: this.configureStockPolicy.bind(this),
      foodService: foodServiceExtension,
    });
  }
}

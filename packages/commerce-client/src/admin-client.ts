// Plan 78 step 2: parseInPersonCheckoutPaymentCollection is compared here.
import { decodeRecord } from "./entity-plane/record-decoding.ts";
import type { CommerceCommandInput } from "./command-input.ts";
import {
  parseCommerceApiCredentialV1Record,
  parseCommerceApiCredentialsV1Record,
  parseCommerceAppInstallationV1Record,
  parseCommerceIssuedApiKeyV1Record,
  parseCommerceMerchantClosureV1Record,
  type CommerceApiCredentialsV1,
  type CommerceIssuedApiKeyV1,
  type CommerceMerchantClosureV1,
} from "@purin-labs/commerce-contracts/records/api-access";
import {
  parseCommerceInPersonCheckoutPaymentCollectionV1 as parseCommerceInPersonCheckoutPaymentCollectionV1Record,
} from "@purin-labs/commerce-contracts/records/api-payment-session";
import {
  commerceBearerToken,
  type CommerceApiScope,
  type CommerceCredential,
} from "./app-access.ts";
import {
  type CheckoutProfile,
  type PointOfSaleConfiguration,
} from "@purin-labs/commerce-contracts";
import { errorMessage } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";
import {
  parseTenderRefund,
  type CancelCommerceOrderV1,
  type RefundCommerceOrderTendersV1,
  type RecordCommerceCounterManualCashRefundV1,
  type RefundCommerceOrderV1,
  type CommerceTenderRefundV1,
} from "./after-sale.ts";
import {
  parseActiveCheckoutProfile,
  parseCheckoutProfile,
  parseCheckoutProfileActivations,
  parseCheckoutProfiles,
  parseStorefrontIds,
  type ActivateCommerceCheckoutProfileV1,
  type CreateCommerceCheckoutProfileDraftV1,
  type PublishCommerceCheckoutProfileV1,
  type ReplaceCommerceCheckoutProfileDraftV1,
  type RetireCommerceCheckoutProfileV1,
  type CommerceActiveCheckoutProfileV1,
  type CommerceCheckoutProfileActivationV1,
} from "./checkout-profile.ts";
import {
  parseCommerceStorefrontShopNameChangeV1,
  parseCommerceStorefrontShopNameV1,
  type CommerceStorefrontShopNameChangeV1,
  type CommerceStorefrontShopNameV1,
} from "@purin-labs/commerce-contracts/records/api-shop-names";
import {
  parseCommerceFailedPaymentsV1,
  type CommerceFailedPaymentsV1,
} from "@purin-labs/commerce-contracts/records/api-failed-payments";
import {
  parseCommercePaymentsV1,
  type CommercePaymentsV1,
} from "@purin-labs/commerce-contracts/records/api-payments";
import {
  parseCommerceOrderTimesV1,
  type CommerceOrderTimesV1,
} from "@purin-labs/commerce-contracts/records/api-order-times";
import {
  parseCommerceBankPayoutsV1,
  type CommerceBankPayoutsV1,
} from "@purin-labs/commerce-contracts/records/api-bank-payouts";
import {
  parseCommercePickupQueueV1,
  type CommercePickupQueueV1,
} from "@purin-labs/commerce-contracts/records/api-pickup-queue";
import {
  parseMerchantSnapshot,
  parsePointOfSaleConfiguration,
  parseStockSnapshot,
  parseStorefront,
  type CommerceMerchantSnapshotV1,
  type CommercePreparationTicketV1,
  type CommerceStockSnapshot,
  type CommerceEngineTimestamp,
} from "./commerce-resources.ts";
import {
  parseFoodServiceSnapshot as parseCanonicalFoodServiceSnapshot,
  parsePreparationTicket as parseCanonicalPreparationTicket,
  type CompleteProductionBatchCommand,
  type ConfigureStockPolicyCommand,
  type CreateModifierGroupRevisionCommand,
  type CreatePreparationStationCommand,
  type CreateRecipeRevisionCommand,
  type ManagePreparationTicketCommand,
  type PublishMenuCommand,
  parseSoldOutMarks,
  type MarkSoldOutCommand,
  type CommerceSoldOutMarksV1,
  type CommerceFoodServiceSnapshotV1,
} from "./food-service.ts";
import {
  parseDeliveryAcknowledgement,
  parseMutationResult,
  parseOptionalReceipt,
  parseRejectedMutation,
  type AcknowledgeCommerceDeliveryV1,
  type CommerceClientResult,
  type CommerceDeliveryAcknowledgementV1,
  type CommerceFetch,
  type CommerceMigrationInventoryV2,
  type CommerceMutationErrorV1,
  type CommerceMutationReceiptV1,
  type CommerceMutationResultV1,
} from "./mutations.ts";
import type { ObserveCommercePaymentDisputeV1 } from "./payment-dispute.ts";
import type {
  UpdateCommerceOfferV1,
  UpdateCommerceStorefrontTaxV1,
  UpdateCommerceProductV1,
  DeleteCommerceProductV1,
  UpdateCommerceVariantV1,
} from "./catalog-edits.ts";
import {
  parseDraftInvoice,
  parseDraftOrderView,
  type CancelCommerceDraftOrderV1,
  type CreateCommerceDraftOrderV1,
  type MarkCommerceDraftOrderPaidV1,
  type SendCommerceDraftInvoiceV1,
  type CommerceDraftInvoiceV1,
  type CommerceDraftOrderViewV1,
  type UpdateCommerceDraftOrderV1,
} from "./draft-orders.ts";
import {
  parseMerchantPluginPreview,
  parsePluginFieldValueList,
  parsePluginFunctionRun,
  parsePluginList,
  parsePluginPreview,
  type InstallCommerceMerchantPluginV1,
  type PauseCommercePluginV1,
  type ConfigureCommercePluginV1,
  type PreviewCommerceMerchantPluginV1,
  type RemoveCommercePluginV1,
  type RunCommercePluginActionV1,
  type SetCommercePluginFieldValuesV1,
  type CommercePluginFieldValueListV1,
  type ResumeCommercePluginV1,
  type RunCommercePluginFunctionV1,
  type CommerceMerchantPluginPreviewV1,
  type CommercePluginFunctionRunV1,
  type CommercePluginChangeV1,
  type CommercePluginListV1,
  type CommercePluginPreviewV1,
} from "./plugins.ts";
import {
  parseReturns,
  type AuthorizeCommerceReturnV1,
  type CloseCommerceReturnV1,
  type ReceiveCommerceReturnV1,
  type RequestCommerceReturnV1,
  type CommerceReturnV1,
} from "./returns.ts";
import {
  MEDIA_CONTENT_TYPES,
  parseMediaLibrary,
  parseMediaUpload,
  type CreateCommerceMediaV1,
  type CommerceMediaContent,
  type CommerceMediaContentType,
  type DeleteCommerceMediaV1,
  type SetCommerceProductMediaV1,
  type CommerceMediaLibraryV1,
  type CommerceMediaUploadV1,
  type UpdateCommerceMediaV1,
} from "./media.ts";
import {
  parseMarkets,
  type CreateCommerceMarketV1,
  type CommerceMarketV1,
  type UpdateCommerceMarketV1,
} from "./markets.ts";
import {
  parseCompanies,
  parseCompanyInvoices,
  type CreateCommerceCompanyV1,
  type PlaceCommerceDraftOrderOnTermsV1,
  type RecordCommerceInvoicePaymentV1,
  type CommerceCompanyInvoiceV1,
  type CommerceCompanyV1,
  type UpdateCommerceCompanyV1,
} from "./companies.ts";
import {
  parseDiscounts,
  type CreateCommerceDiscountV1,
  type DeactivateCommerceDiscountV1,
  type CommerceDiscountV1,
} from "./discounts.ts";
import {
  parseStoredValueAccounts,
  parseStoredValueLiability,
  type CreditCommerceStoreCreditV1,
  type DisableCommerceStoredValueAccountV1,
  type IssueCommerceGiftCardV1,
  type CommerceStoredValueAccountV1,
  type CommerceStoredValueLiabilityV1,
} from "./stored-value.ts";
import {
  parseCollections,
  type CreateCommerceCollectionV1,
  type DeleteCommerceCollectionV1,
  type CommerceCollectionV1,
  type UpdateCommerceCollectionV1,
} from "./collections.ts";
import {
  parseArchiveRun,
  parseOrderRecord,
  type CommerceArchiveRunV1,
  type CommerceOrderRecordV1,
} from "./archive.ts";
import {
  parseEventPage,
  parseFeedConsumer,
  parseWebhookSecretRotated,
  parseWebhookSubscriptionCreated,
  parseWebhookSubscriptions,
  type CreateCommerceWebhookSubscriptionV1,
  type DeleteCommerceWebhookSubscriptionV1,
  type RestartCommerceWebhookSubscriptionV1,
  type RotateCommerceWebhookSecretV1,
  type CommerceFeedConsumerV1,
  type CommerceReceivedEventPageV1,
  type CommerceWebhookSecretRotatedV1,
  type CommerceWebhookSubscriptionCreatedV1,
  type CommerceWebhookSubscriptionV1,
} from "./events.ts";
import {
  parseCustomer,
  parseCustomerExport,
  parseNotifications,
  type CreateCommerceCustomerV1,
  type EraseCommerceCustomerV1,
  type CommerceCustomerExportV1,
  type CommerceCustomerV1,
  type CommerceNotificationV1,
  type UpdateCommerceCustomerV1,
} from "./customers.ts";
import {
  parseOrderChanges,
  type EditCommerceOrderV1,
  type RecordCommerceOrderManualPaymentV1,
  type ExchangeCommerceOrderLinesV1,
  type CommerceOrderChangesV1,
} from "./order-edits.ts";
import {
  type CommerceInPersonCollectionResultV1,
} from "./payment-session.ts";
import {
  parseProductSalesReport,
  type ProductSalesReport,
  type ProductSalesWindow,
} from "./product-sales.ts";
import {
  parseShipmentLabelRateResult,
  type AttachFulfillmentTrackingCommand,
  type PurchaseShippingLabelCommand,
  type QuoteShipmentLabelRateCommand,
  type RecordShippingTrackingCommand,
  type ShipmentLabelRateResult,
} from "./shipping-operations.ts";
import {
  readJsonResponse,
  requireArray,
  requireBaseUrl,
  requirePositiveInteger,
  requireText,
  responseMessage,
} from "./wire-readers.ts";
import {
  parseAdjustOfferPriceCommandRecord,
  parseBeginCheckoutPaymentCommandRecord,
  parseCollectInPersonCheckoutPaymentCommandRecord,
  parseCompletePickupCommandRecord,
  parseConfigurePickupStorefrontCommandRecord,
  parseConfigureShippingStorefrontCommandRecord,
  parseCounterSaleRecord,
  parseCreateInPersonCheckoutCommandRecord,
  parseCreateInventoryItemCommandRecord,
  parseCreateLocationCommandRecord,
  parseCreatePickupCheckoutCommandRecord,
  parseDemoProfileRecord,
  parseExpireCheckoutCommandRecord,
  parseInventoryReconciliationChangeRecord,
  parseInventoryReconciliationTargetRecord,
  parseMarkPickupReadyCommandRecord,
  parseMerchantProvisioningResultRecord,
  parseMigrationInventoryRecord,
  parseOfferPriceResultRecord,
  parseOpenInventoryPositionCommandRecord,
  parsePaymentCaptureResultRecord,
  parsePlaceChannelListingCommandRecord,
  parsePlacePaidCheckoutCommandRecord,
  parsePrepareCatalogListingCommandRecord,
  parseProvisionDemoCommandRecord,
  parseProvisionMerchantCommandRecord,
  parsePublishCatalogListingCommandRecord,
  parsePublishPointOfSaleConfigurationCommandRecord,
  parseReceiveInventoryCommandRecord,
  parseReconcileInventoryCommandRecord,
  parseRecordCheckoutPaymentCaptureCommandRecord,
  parseRecordCounterCashPaymentCommandRecord,
  parseResolveCheckoutPaymentCommandRecord,
  parseCommerceSquarePaymentAccountV1Record,
  parseCommerceStripePaymentAccountV1Record,
  parseCommerceStripeOnboardingV1Record,
  parseCommercePaymentAccountsV1Record,
  parseCommerceSquareConnectionV1Record,
  parseCommerceSquareLocationsV1Record,
  parseCommerceSquareDevicesV1Record,
  parseCommerceSquareDeviceCodeV1Record,
  parseUpdateProductDescriptionCommandRecord,
} from "@purin-labs/commerce-contracts/records/api-admin";
import type * as WireAdmin from "@purin-labs/commerce-contracts/records/api-admin";

/**
 * Lets a location of the merchant's connected Square account take payments
 * under a payment binding id. Commerce reads the location first.
 */
export type LinkCommerceSquareAccountV1 = Readonly<{
  paymentProviderBindingId: string;
  locationId: string;
}>;

/**
 * Connects a merchant's Square account (Plan 80 step 4): Commerce exchanges
 * an authorization code of its Square application, or keeps tokens that the
 * same application issued.
 */
export type ConnectCommerceSquareV1 = Readonly<{
  environment: "development" | "production";
  grant:
    | Readonly<{
        kind: "authorization_code";
        code: string;
        redirectUri?: string;
      }>
    | Readonly<{
        kind: "tokens";
        accessToken: string;
        refreshToken?: string | null;
        expiresAt?: CommerceEngineTimestamp | null;
      }>;
}>;

export type CommerceStripePaymentAccountV1 =
  WireAdmin.CommerceStripePaymentAccountV1;
export type CommerceStripeOnboardingV1 =
  WireAdmin.CommerceStripeOnboardingV1;
export type CommercePaymentAccountsV1 = WireAdmin.CommercePaymentAccountsV1;
export type CommerceSquareConnectionV1 = WireAdmin.CommerceSquareConnectionV1;
export type CommerceSquareLocationsV1 = WireAdmin.CommerceSquareLocationsV1;
export type CommerceSquareDevicesV1 = WireAdmin.CommerceSquareDevicesV1;
export type CommerceSquareDeviceCodeV1 = WireAdmin.CommerceSquareDeviceCodeV1;

export type CommerceSquarePaymentAccountV1 = Readonly<{
  provider: "square";
  paymentProviderBindingId: string;
  providerAccountId: string;
  locationId: string;
  environment: "development" | "production";
  country: string;
  currency: string;
  state: "active";
  updatedAt: CommerceEngineTimestamp;
}>;

export function parseSquarePaymentAccount(
  value: unknown,
): CommerceSquarePaymentAccountV1 {
  return decodeRecord(parseCommerceSquarePaymentAccountV1Record, value);
}

export type CommercePaymentCaptureResultV1 = WireAdmin.CommercePaymentCaptureResultV1;

export type ProvisionCommerceMerchantV1 = WireAdmin.ProvisionCommerceMerchantV1;

export type CommerceDemoProfile = WireAdmin.CommerceDemoProfile;

export type ProvisionCommerceDemoV1 = WireAdmin.ProvisionCommerceDemoV1;

export type CommerceMerchantProvisioningResultV1 = WireAdmin.CommerceMerchantProvisioningResultV1;

export type CreateCommerceLocationV1 = WireAdmin.CreateCommerceLocationV1;

export type PrepareCommerceCatalogListingV1 = WireAdmin.PrepareCommerceCatalogListingV1;

export type UpdateCommerceProductDescriptionV1 = WireAdmin.UpdateCommerceProductDescriptionV1;

export type ConfigureCommercePickupStorefrontV1 = WireAdmin.ConfigureCommercePickupStorefrontV1;

export type ConfigureCommerceShippingStorefrontV1 = WireAdmin.ConfigureCommerceShippingStorefrontV1;

export type CommerceChannelListingCatalogV1 = WireAdmin.CommerceChannelListingCatalogV1;

export type AdjustCommerceOfferPriceV1 = WireAdmin.AdjustCommerceOfferPriceV1;

/**
 * Parses one approved price change.
 *
 * The same shape the governed action path mints, so a command that reaches
 * Commerce carries the revisions the approval was bound to rather than
 * whatever is current.
 */
export function parseAdjustOfferPriceCommand(value: unknown): AdjustCommerceOfferPriceV1 {
  return decodeRecord(parseAdjustOfferPriceCommandRecord, value);
}

export type SetCommerceOfferPricePolicyV1 = Readonly<{
  merchantId: string;
  offerId: string;
  /** Null when no policy exists yet. */
  expectedRevision: number | null;
  maxMovementBps: number;
  occurredAt: string;
}>;

export type DisableCommerceOfferPricePolicyV1 = Readonly<{
  merchantId: string;
  offerId: string;
  expectedRevision: number;
  occurredAt: string;
}>;

/**
 * What an Offer price call returns.
 *
 * A refusal names the reason rather than a generic failure, so a stale
 * approval and a change beyond the merchant's allowance are distinguishable
 * to whoever has to act on it.
 */
export type CommerceOfferPriceResultV1 = WireAdmin.CommerceOfferPriceResultV1;

export type PlaceCommerceChannelListingV1 = WireAdmin.PlaceCommerceChannelListingV1;

export type CommercePickupCheckoutLineV1 = WireAdmin.CommercePickupCheckoutLineV1;

export type CommercePickupCheckoutSelectionV1 = WireAdmin.CommercePickupCheckoutSelectionV1;

export type CreateCommercePickupCheckoutV1 = WireAdmin.CreateCommercePickupCheckoutV1;

/**
 * Create a Checkout at a terminal.
 *
 * There is no storefront, cart, or buyer session here: an operator submits the
 * basket in one command. The terminal assignment revision is pinned so the
 * Checkout is bound to the exact assignment that was active when it was rung
 * up, and the buyer may be anonymous.
 */
export type CreateCommerceInPersonCheckoutV1 = WireAdmin.CreateCommerceInPersonCheckoutV1;

/**
 * One counter sale, read as the operator who rang it up.
 *
 * The payment attempt is present only once collection has begun, and its
 * absence is meaningful: a sale that was rung up but never presented on the
 * terminal has nothing to reconcile.
 */
export type CommerceCounterSaleV1 = WireAdmin.CommerceCounterSaleV1;

export function parseCounterSale(value: unknown): CommerceCounterSaleV1 {
  return decodeRecord(parseCounterSaleRecord, value);
}

/**
 * Publish the policy a counter sells under.
 *
 * The revision and lifecycle are deliberately absent: Commerce assigns them,
 * so a caller cannot publish underneath a sale that has already pinned one.
 * `expectedRevision` is null when a counter has no published policy yet.
 */
export type PublishCommercePointOfSaleConfigurationV1 = WireAdmin.PublishCommercePointOfSaleConfigurationV1;

export type BeginCommerceCheckoutPaymentV1 = WireAdmin.BeginCommerceCheckoutPaymentV1;

export type CollectCommerceInPersonCheckoutPaymentV1 = WireAdmin.CollectCommerceInPersonCheckoutPaymentV1;

export type RecordCommerceCounterCashPaymentV1 = WireAdmin.RecordCommerceCounterCashPaymentV1;

export type CommerceCounterCashTenderV1 = WireAdmin.CommerceCounterCashTenderV1;

export type CommerceInPersonCheckoutPaymentCollectionV1 =
  | Readonly<{
      schemaVersion: "commerce.in-person-checkout-payment-collection.v1";
      outcome: "ready";
      mutationOutcome: "applied" | "replayed";
      receipt: CommerceMutationReceiptV1;
      paymentAttemptId: string;
      session: Variant<
        CommerceInPersonCollectionResultV1,
        "ready"
      >["session"];
    }>
  | Readonly<{
      schemaVersion: "commerce.in-person-checkout-payment-collection.v1";
      outcome: "unavailable";
      mutationOutcome: "applied" | "replayed";
      receipt: CommerceMutationReceiptV1;
      retryAfter: string;
    }>
  | Readonly<{
      schemaVersion: "commerce.in-person-checkout-payment-collection.v1";
      outcome: "rejected";
      error: CommerceMutationErrorV1;
    }>;

export type RecordCommerceCheckoutPaymentCaptureV1 = WireAdmin.RecordCommerceCheckoutPaymentCaptureV1;

export type PlaceCommercePaidCheckoutV1 = WireAdmin.PlaceCommercePaidCheckoutV1;

export type MarkCommercePickupReadyV1 = WireAdmin.MarkCommercePickupReadyV1;

export type CompleteCommercePickupV1 = WireAdmin.CompleteCommercePickupV1;

export type ResolveCommerceCheckoutPaymentV1 = WireAdmin.ResolveCommerceCheckoutPaymentV1;

export type ExpireCommerceCheckoutV1 = WireAdmin.ExpireCommerceCheckoutV1;

export type PublishCommerceCatalogListingV1 = WireAdmin.PublishCommerceCatalogListingV1;

export type CreateCommerceInventoryItemV1 = WireAdmin.CreateCommerceInventoryItemV1;

export type OpenCommerceInventoryPositionV1 = WireAdmin.OpenCommerceInventoryPositionV1;

export type ReceiveCommerceInventoryV3 = WireAdmin.ReceiveCommerceInventoryV3;

export type CommerceInventoryLotInputV1 = WireAdmin.CommerceInventoryLotInputV1;

export type ReconcileCommerceInventoryV1 = WireAdmin.ReconcileCommerceInventoryV1;

export type CommerceBuyerContactAuthorityV1 = WireAdmin.CommerceBuyerContactAuthorityV1;

export type CommerceCheckoutBuyerAuthorityV1 = WireAdmin.CommerceCheckoutBuyerAuthorityV1;

export function parseCommercePaymentCaptureResultV1(value: unknown): CommercePaymentCaptureResultV1 {
  return decodeRecord(parsePaymentCaptureResultRecord, value);
}

export type {
  CommerceApiCredentialsV1,
  CommerceIssuedApiKeyV1,
  CommerceMerchantClosureV1,
};

export type CommerceAdminClientConfig = Readonly<{
  baseUrl: string;
  /** The operator token, an API key, or a token for each merchant. */
  serviceToken: CommerceCredential;
  fetch?: CommerceFetch;
  /**
   * The person an app acts for, as the app names them (Plan 80 step 3).
   * Sent as `Commerce-Actor`; each receipt keeps it. Only an app
   * installation token may send it.
   */
  actor?: string;
}>;

export class CommerceAdminClient {
  readonly #baseUrl: string;
  readonly #serviceToken: CommerceCredential;
  readonly #fetch: CommerceFetch;
  readonly #actor: string | undefined;

  constructor(config: CommerceAdminClientConfig) {
    this.#baseUrl = requireBaseUrl(config.baseUrl);
    this.#serviceToken =
      typeof config.serviceToken === "string"
        ? requireText(config.serviceToken, "serviceToken")
        : config.serviceToken;
    this.#fetch = (config.fetch ?? globalThis.fetch).bind(globalThis);
    this.#actor = config.actor;
  }

  /**
   * Issues an API key of this merchant (Plan 80 step 3). The caller needs
   * `credentials:write`, and the key gets only scopes that the caller holds.
   */
  async issueApiKey(
    merchantId: string,
    key: Readonly<{ label: string; scopes: readonly CommerceApiScope[] }>,
  ): Promise<CommerceClientResult<CommerceIssuedApiKeyV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/api-keys`,
      { method: "POST", body: JSON.stringify(key) },
      (value) => decodeRecord(parseCommerceIssuedApiKeyV1Record, value),
    );
  }

  async listApiCredentials(
    merchantId: string,
  ): Promise<CommerceClientResult<CommerceApiCredentialsV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/api-credentials`,
      (value) => decodeRecord(parseCommerceApiCredentialsV1Record, value),
    );
  }

  async revokeApiKey(
    merchantId: string,
    credentialId: string,
  ): Promise<CommerceClientResult<CommerceApiCredentialsV1["credentials"][number]>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/api-keys/${encodeURIComponent(credentialId)}/revocation`,
      { method: "POST" },
      (value) => decodeRecord(parseCommerceApiCredentialV1Record, value),
    );
  }

  async provisionMerchant(
    command: ProvisionCommerceMerchantV1,
  ): Promise<CommerceClientResult<CommerceMerchantProvisioningResultV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}`,
      { method: "PUT", body: JSON.stringify(command) },
      parseMerchantProvisioningResult,
    );
  }

  /**
   * Installs an app on a merchant, or changes its scopes (operator token
   * only). The token is the one `commerceAppInstallationToken` derives.
   */
  async installApp(
    merchantId: string,
    appId: string,
    installation: Readonly<{
      scopes: readonly CommerceApiScope[];
      externalReference: string;
      label?: string;
    }>,
  ): Promise<CommerceClientResult<CommerceAppInstallationV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/app-installations/${encodeURIComponent(appId)}`,
      { method: "PUT", body: JSON.stringify(installation) },
      parseAppInstallation,
    );
  }

  /**
   * Closes a merchant whose Organisation ended (operator token only): every
   * credential is revoked, every outbound webhook subscription is removed and
   * the provider links end. A repeated call answers the first closure.
   */
  async closeMerchant(
    merchantId: string,
  ): Promise<CommerceClientResult<CommerceMerchantClosureV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/closure`,
      { method: "POST", body: "{}" },
      parseMerchantClosure,
    );
  }

  async provisionDemo(
    command: ProvisionCommerceDemoV1,
  ): Promise<CommerceClientResult<CommerceMerchantSnapshotV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/demo-profiles/${encodeURIComponent(command.profile)}`,
      { method: "PUT", body: JSON.stringify(command) },
      parseMerchantSnapshot,
    );
  }

  async observePaymentDispute(
    command: ObserveCommercePaymentDisputeV1,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/payment-dispute-observations`,
      { method: "POST", body: JSON.stringify(command) },
      parseMutationResult,
    );
  }

  async createCheckoutProfileDraft(
    command: CreateCommerceCheckoutProfileDraftV1,
  ): Promise<CommerceClientResult<CheckoutProfile>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/checkout-profiles`,
      { method: "POST", body: JSON.stringify(command) },
      parseCheckoutProfile,
    );
  }

  async replaceCheckoutProfileDraft(
    command: ReplaceCommerceCheckoutProfileDraftV1,
  ): Promise<CommerceClientResult<CheckoutProfile>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/checkout-profiles/${encodeURIComponent(command.checkoutProfileId)}/draft`,
      { method: "PUT", body: JSON.stringify(command) },
      parseCheckoutProfile,
    );
  }

  async publishCheckoutProfile(
    command: PublishCommerceCheckoutProfileV1,
  ): Promise<CommerceClientResult<CheckoutProfile>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/checkout-profiles/${encodeURIComponent(command.checkoutProfileId)}/publication`,
      { method: "POST", body: JSON.stringify(command) },
      parseCheckoutProfile,
    );
  }

  async retireCheckoutProfile(
    command: RetireCommerceCheckoutProfileV1,
  ): Promise<CommerceClientResult<CheckoutProfile>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/checkout-profiles/${encodeURIComponent(command.checkoutProfileId)}/retirement`,
      { method: "POST", body: JSON.stringify(command) },
      parseCheckoutProfile,
    );
  }

  async activateCheckoutProfile(
    command: ActivateCommerceCheckoutProfileV1,
  ): Promise<CommerceClientResult<CommerceActiveCheckoutProfileV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/storefronts/${encodeURIComponent(command.storefrontId)}/checkout-profile-activation`,
      { method: "PUT", body: JSON.stringify(command) },
      parseActiveCheckoutProfile,
    );
  }

  async listCheckoutProfiles(
    merchantId: string,
  ): Promise<CommerceClientResult<readonly CheckoutProfile[]>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/checkout-profiles`,
      parseCheckoutProfiles,
    );
  }

  async listCheckoutProfileActivations(
    merchantId: string,
  ): Promise<
    CommerceClientResult<readonly CommerceCheckoutProfileActivationV1[]>
  > {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/checkout-profile-activations`,
      parseCheckoutProfileActivations,
    );
  }

  async listStorefrontIds(
    merchantId: string,
  ): Promise<CommerceClientResult<readonly string[]>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/storefronts`,
      parseStorefrontIds,
    );
  }

  /** One storefront: its sales channel, fulfillment and checkout. */
  async readStorefront(
    merchantId: string,
    storefrontId: string,
  ): Promise<CommerceClientResult<ReturnType<typeof parseStorefront>>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/storefronts/${encodeURIComponent(requireText(storefrontId, "storefrontId"))}`,
      parseStorefront,
    );
  }

  /** A storefront's shop name and its earlier names (Plan 40B phase 2). */
  async readStorefrontShopName(
    merchantId: string,
    storefrontId: string,
  ): Promise<CommerceClientResult<CommerceStorefrontShopNameV1>> {
    return this.#read(
      storefrontShopNamePath(merchantId, storefrontId),
      parseStorefrontShopName,
    );
  }

  /**
   * Takes a shop name for a storefront. A name of the wrong form, a reserved
   * name, another shop's name or one name too many is refused in the answer.
   */
  async setStorefrontShopName(
    merchantId: string,
    storefrontId: string,
    name: string,
  ): Promise<CommerceClientResult<CommerceStorefrontShopNameChangeV1>> {
    return this.#request(
      storefrontShopNamePath(merchantId, storefrontId),
      { method: "PUT", body: JSON.stringify({ name }) },
      parseStorefrontShopNameChange,
    );
  }

  async readCheckoutProfile(
    merchantId: string,
    checkoutProfileId: string,
    revision: number,
  ): Promise<CommerceClientResult<CheckoutProfile>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/checkout-profiles/${encodeURIComponent(requireText(checkoutProfileId, "checkoutProfileId"))}/revisions/${requirePositiveInteger(revision, "revision")}`,
      parseCheckoutProfile,
    );
  }

  async readActiveCheckoutProfile(
    merchantId: string,
    storefrontId: string,
  ): Promise<CommerceClientResult<CommerceActiveCheckoutProfileV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/storefronts/${encodeURIComponent(requireText(storefrontId, "storefrontId"))}/checkout-profile-activation`,
      parseActiveCheckoutProfile,
    );
  }

  async createLocation(
    command: CommerceCommandInput<CreateCommerceLocationV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/locations`,
      "POST",
      command,
      [],
    );
  }

  async prepareCatalogListing(
    command: CommerceCommandInput<PrepareCommerceCatalogListingV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/catalog/listings`,
      "POST",
      command,
      [],
    );
  }

  async updateProductDescription(
    command: CommerceCommandInput<UpdateCommerceProductDescriptionV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/products/${encodeURIComponent(command.productId)}/description`,
      "PUT",
      command,
      ["productId"],
    );
  }

  async updateProduct(
    command: CommerceCommandInput<UpdateCommerceProductV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/products/${encodeURIComponent(command.productId)}`,
      "PUT",
      command,
      ["productId"],
    );
  }

  async deleteProduct(
    command: CommerceCommandInput<DeleteCommerceProductV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/products/${encodeURIComponent(command.productId)}`,
      "DELETE",
      command,
      ["productId"],
    );
  }

  async updateVariant(
    command: CommerceCommandInput<UpdateCommerceVariantV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/variants/${encodeURIComponent(command.variantId)}`,
      "PUT",
      command,
      ["variantId"],
    );
  }

  async updateOffer(
    command: CommerceCommandInput<UpdateCommerceOfferV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/offers/${encodeURIComponent(command.offerId)}`,
      "PUT",
      command,
      ["offerId"],
    );
  }

  async updateStorefrontTax(
    command: CommerceCommandInput<UpdateCommerceStorefrontTaxV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/storefronts/${encodeURIComponent(command.storefrontId)}/tax`,
      "PUT",
      command,
      ["storefrontId"],
    );
  }

  async createDraftOrder(
    command: CommerceCommandInput<CreateCommerceDraftOrderV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/draft-orders`,
      "POST",
      command,
      [],
    );
  }

  async updateDraftOrder(
    command: CommerceCommandInput<UpdateCommerceDraftOrderV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/draft-orders/${encodeURIComponent(command.draftOrderId)}`,
      "PUT",
      command,
      ["draftOrderId"],
    );
  }

  async cancelDraftOrder(
    command: CommerceCommandInput<CancelCommerceDraftOrderV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/draft-orders/${encodeURIComponent(command.draftOrderId)}/cancellation`,
      "POST",
      command,
      ["draftOrderId"],
    );
  }

  /** Records cash or a bank transfer for a draft; the draft becomes an order. */
  async markDraftOrderPaid(
    command: CommerceCommandInput<MarkCommerceDraftOrderPaidV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/draft-orders/${encodeURIComponent(command.draftOrderId)}/manual-payment`,
      "POST",
      command,
      ["draftOrderId"],
    );
  }

  /** Sends the invoice; once applied, the result carries the buyer's link token. */
  async sendDraftInvoice(
    command: CommerceCommandInput<SendCommerceDraftInvoiceV1>,
  ): Promise<CommerceClientResult<CommerceDraftInvoiceV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/draft-orders/${encodeURIComponent(command.draftOrderId)}/invoice`,
      "POST",
      command,
      ["draftOrderId"],
      parseDraftInvoice,
    );
  }

  async readDraftOrder(
    merchantId: string,
    draftOrderId: string,
  ): Promise<CommerceClientResult<CommerceDraftOrderViewV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/draft-orders/${encodeURIComponent(draftOrderId)}`,
      parseDraftOrderView,
    );
  }

  async requestReturn(
    command: CommerceCommandInput<RequestCommerceReturnV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/orders/${encodeURIComponent(command.orderId)}/returns`,
      "POST",
      command,
      ["orderId"],
    );
  }

  async authorizeReturn(
    command: CommerceCommandInput<AuthorizeCommerceReturnV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/returns/${encodeURIComponent(command.returnId)}/authorization`,
      "POST",
      command,
      ["returnId"],
    );
  }

  async receiveReturn(
    command: CommerceCommandInput<ReceiveCommerceReturnV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/returns/${encodeURIComponent(command.returnId)}/receipt`,
      "POST",
      command,
      ["returnId"],
    );
  }

  async closeReturn(
    command: CommerceCommandInput<CloseCommerceReturnV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/returns/${encodeURIComponent(command.returnId)}/closure`,
      "POST",
      command,
      ["returnId"],
    );
  }

  async listOrderReturns(
    merchantId: string,
    orderId: string,
  ): Promise<CommerceClientResult<readonly CommerceReturnV1[]>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/orders/${encodeURIComponent(orderId)}/returns`,
      parseReturns,
    );
  }

  async editOrder(
    command: CommerceCommandInput<EditCommerceOrderV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/orders/${encodeURIComponent(command.orderId)}/edits`,
      "POST",
      command,
      ["orderId"],
    );
  }

  /** Records what an order still owes as paid in cash or by bank transfer. */
  async recordOrderManualPayment(
    command: CommerceCommandInput<RecordCommerceOrderManualPaymentV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/orders/${encodeURIComponent(command.orderId)}/manual-payment`,
      "POST",
      command,
      ["orderId"],
    );
  }

  async exchangeOrderLines(
    command: CommerceCommandInput<ExchangeCommerceOrderLinesV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/orders/${encodeURIComponent(command.orderId)}/exchanges`,
      "POST",
      command,
      ["orderId"],
    );
  }

  /** The order's edits and later payments, and what it owes now. */
  async readOrderChanges(
    merchantId: string,
    orderId: string,
  ): Promise<CommerceClientResult<CommerceOrderChangesV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/orders/${encodeURIComponent(orderId)}/changes`,
      parseOrderChanges,
    );
  }

  async createCustomer(
    command: CommerceCommandInput<CreateCommerceCustomerV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/customers`,
      "POST",
      command,
      [],
    );
  }

  async updateCustomer(
    command: CommerceCommandInput<UpdateCommerceCustomerV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/customers/${encodeURIComponent(command.customerId)}`,
      "PUT",
      command,
      ["customerId"],
    );
  }

  /** Erases a customer: their key is deleted, so no copy can be read. */
  async eraseCustomer(
    command: CommerceCommandInput<EraseCommerceCustomerV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/customers/${encodeURIComponent(command.customerId)}/erasure`,
      "POST",
      command,
      ["customerId"],
    );
  }

  async readCustomer(
    merchantId: string,
    customerId: string,
  ): Promise<CommerceClientResult<CommerceCustomerV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/customers/${encodeURIComponent(customerId)}`,
      parseCustomer,
    );
  }

  async exportCustomer(
    merchantId: string,
    customerId: string,
  ): Promise<CommerceClientResult<CommerceCustomerExportV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/customers/${encodeURIComponent(customerId)}/export`,
      parseCustomerExport,
    );
  }

  /** Sent and waiting notifications, without their content. */
  async listNotifications(
    merchantId: string,
  ): Promise<CommerceClientResult<readonly CommerceNotificationV1[]>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/notifications`,
      parseNotifications,
    );
  }

  async createMarket(
    command: CommerceCommandInput<CreateCommerceMarketV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/markets`,
      "POST",
      command,
      [],
    );
  }

  async updateMarket(
    command: CommerceCommandInput<UpdateCommerceMarketV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/markets/${encodeURIComponent(command.marketId)}`,
      "PUT",
      command,
      ["marketId"],
    );
  }

  async listMarkets(
    merchantId: string,
  ): Promise<CommerceClientResult<readonly CommerceMarketV1[]>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/markets`,
      parseMarkets,
    );
  }

  async createCompany(
    command: CommerceCommandInput<CreateCommerceCompanyV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/companies`,
      "POST",
      command,
      [],
    );
  }

  async updateCompany(
    command: CommerceCommandInput<UpdateCommerceCompanyV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/companies/${encodeURIComponent(command.companyId)}`,
      "PUT",
      command,
      ["companyId"],
    );
  }

  /** Places a draft order on its buyer's company invoice terms. */
  async placeDraftOrderOnTerms(
    command: CommerceCommandInput<PlaceCommerceDraftOrderOnTermsV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/draft-orders/${encodeURIComponent(command.draftOrderId)}/terms-placement`,
      "POST",
      command,
      ["draftOrderId"],
    );
  }

  async recordInvoicePayment(
    command: CommerceCommandInput<RecordCommerceInvoicePaymentV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/invoices/${encodeURIComponent(command.invoiceId)}/payments`,
      "POST",
      command,
      ["invoiceId"],
    );
  }

  async listInvoices(
    merchantId: string,
  ): Promise<CommerceClientResult<readonly CommerceCompanyInvoiceV1[]>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/invoices`,
      parseCompanyInvoices,
    );
  }

  async listCompanies(
    merchantId: string,
  ): Promise<CommerceClientResult<readonly CommerceCompanyV1[]>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/companies`,
      parseCompanies,
    );
  }

  /** Stores image bytes in R2 under their SHA-256; the same bytes give the same answer. */
  async uploadMedia(
    merchantId: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<CommerceClientResult<CommerceMediaUploadV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/media-uploads`,
      { method: "POST", body: bytes, contentType },
      parseMediaUpload,
    );
  }

  async createMedia(
    command: CommerceCommandInput<CreateCommerceMediaV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/media`,
      "POST",
      command,
      [],
    );
  }

  async updateMedia(
    command: CommerceCommandInput<UpdateCommerceMediaV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/media/${encodeURIComponent(command.mediaId)}`,
      "PUT",
      command,
      ["mediaId"],
    );
  }

  async deleteMedia(
    command: CommerceCommandInput<DeleteCommerceMediaV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/media/${encodeURIComponent(command.mediaId)}/deletion`,
      "POST",
      command,
      ["mediaId"],
    );
  }

  async setProductMedia(
    command: CommerceCommandInput<SetCommerceProductMediaV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/products/${encodeURIComponent(command.productId)}/media`,
      "PUT",
      command,
      ["productId"],
    );
  }

  async listMedia(
    merchantId: string,
  ): Promise<CommerceClientResult<CommerceMediaLibraryV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/media`,
      parseMediaLibrary,
    );
  }

  /**
   * The bytes of one library image, for the merchant's own app. The answer
   * is never cached; the app decides who else may see the image.
   */
  async readMediaContent(
    merchantId: string,
    mediaId: string,
  ): Promise<CommerceClientResult<CommerceMediaContent>> {
    const path = `/v1/admin/merchants/${encodeURIComponent(merchantId)}/media/${encodeURIComponent(mediaId)}/content`;
    let response: Response;
    try {
      const token = await commerceBearerToken(this.#serviceToken, path);
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(this.#actor === undefined ? {} : { "commerce-actor": this.#actor }),
        },
      });
    } catch (error) {
      return { ok: false, error: { kind: "network", message: errorMessage(error) } };
    }
    if (!response.ok) {
      const body = await readJsonResponse(response);
      return { ok: false, error: { kind: "http", status: response.status, message: responseMessage(body) } };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!(MEDIA_CONTENT_TYPES as readonly string[]).includes(contentType))
      return { ok: false, error: { kind: "invalid_response", message: "The image has no image type" } };
    return {
      ok: true,
      value: {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: contentType as CommerceMediaContentType,
        etag: response.headers.get("etag"),
      },
    };
  }

  async createDiscount(
    command: CommerceCommandInput<CreateCommerceDiscountV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/discounts`,
      "POST",
      command,
      [],
    );
  }

  async deactivateDiscount(
    command: CommerceCommandInput<DeactivateCommerceDiscountV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/discounts/${encodeURIComponent(command.discountId)}/deactivation`,
      "POST",
      command,
      ["discountId"],
    );
  }

  async listDiscounts(
    merchantId: string,
  ): Promise<CommerceClientResult<readonly CommerceDiscountV1[]>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/discounts`,
      parseDiscounts,
    );
  }

  async issueGiftCard(
    command: CommerceCommandInput<IssueCommerceGiftCardV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/gift-cards`,
      "POST",
      command,
      [],
    );
  }

  async creditStoreCredit(
    command: CommerceCommandInput<CreditCommerceStoreCreditV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/store-credit`,
      "POST",
      command,
      [],
    );
  }

  async disableStoredValueAccount(
    command: CommerceCommandInput<DisableCommerceStoredValueAccountV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/stored-value-accounts/${encodeURIComponent(command.accountId)}/disable`,
      "POST",
      command,
      ["accountId"],
    );
  }

  async listStoredValueAccounts(
    merchantId: string,
  ): Promise<
    CommerceClientResult<readonly CommerceStoredValueAccountV1[]>
  > {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/stored-value-accounts`,
      parseStoredValueAccounts,
    );
  }

  /** Unused gift card and store credit balances at one moment. */
  async readStoredValueLiability(
    merchantId: string,
    at: string,
  ): Promise<CommerceClientResult<CommerceStoredValueLiabilityV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/stored-value-liability?at=${encodeURIComponent(at)}`,
      parseStoredValueLiability,
    );
  }

  async createCollection(
    command: CommerceCommandInput<CreateCommerceCollectionV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/collections`,
      "POST",
      command,
      [],
    );
  }

  async updateCollection(
    command: CommerceCommandInput<UpdateCommerceCollectionV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/collections/${encodeURIComponent(command.collectionId)}`,
      "PUT",
      command,
      ["collectionId"],
    );
  }

  async deleteCollection(
    command: CommerceCommandInput<DeleteCommerceCollectionV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/collections/${encodeURIComponent(command.collectionId)}/deletion`,
      "POST",
      command,
      ["collectionId"],
    );
  }

  async listCollections(
    merchantId: string,
  ): Promise<CommerceClientResult<readonly CommerceCollectionV1[]>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/collections`,
      parseCollections,
    );
  }

  /** One order with its payments and fulfilments, live or archived. */
  async readOrderRecord(
    merchantId: string,
    orderId: string,
  ): Promise<CommerceClientResult<CommerceOrderRecordV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/orders/${encodeURIComponent(orderId)}`,
      parseOrderRecord,
    );
  }

  /** Runs the archive now; the Worker alarm also runs it each day. */
  async runArchive(
    merchantId: string,
  ): Promise<CommerceClientResult<CommerceArchiveRunV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/archive-runs`,
      { method: "POST", body: "{}" },
      parseArchiveRun,
    );
  }

  /** Events after the cursor, in merchant revision order. */
  async readEvents(
    merchantId: string,
    page: Readonly<{ after?: string; limit?: number }> = {},
  ): Promise<CommerceClientResult<CommerceReceivedEventPageV1>> {
    const query = new URLSearchParams();
    if (page.after !== undefined) query.set("after", page.after);
    if (page.limit !== undefined) query.set("limit", String(page.limit));
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/events${suffix}`,
      parseEventPage,
    );
  }

  async createWebhookSubscription(
    command: CommerceCommandInput<CreateCommerceWebhookSubscriptionV1>,
  ): Promise<CommerceClientResult<CommerceWebhookSubscriptionCreatedV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/webhook-subscriptions`,
      "POST",
      command,
      [],
      parseWebhookSubscriptionCreated,
    );
  }

  async restartWebhookSubscription(
    command: CommerceCommandInput<RestartCommerceWebhookSubscriptionV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `${webhookSubscriptionPath(command)}/restart`,
      "POST",
      command,
      ["subscriptionId"],
      parseMutationResult,
    );
  }

  /** The new secret is in the answer once; a replay answers null. */
  async rotateWebhookSecret(
    command: CommerceCommandInput<RotateCommerceWebhookSecretV1>,
  ): Promise<CommerceClientResult<CommerceWebhookSecretRotatedV1>> {
    return this.#command(
      `${webhookSubscriptionPath(command)}/secret-rotations`,
      "POST",
      command,
      ["subscriptionId"],
      parseWebhookSecretRotated,
    );
  }

  async deleteWebhookSubscription(
    command: CommerceCommandInput<DeleteCommerceWebhookSubscriptionV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      webhookSubscriptionPath(command),
      "DELETE",
      command,
      ["subscriptionId"],
      parseMutationResult,
    );
  }

  async linkSquareAccount(
    merchantId: string,
    command: LinkCommerceSquareAccountV1,
  ): Promise<CommerceClientResult<CommerceSquarePaymentAccountV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/payment-accounts/square`,
      { method: "PUT", body: JSON.stringify(command) },
      parseSquarePaymentAccount,
    );
  }

  async listPaymentAccounts(
    merchantId: string,
  ): Promise<CommerceClientResult<CommercePaymentAccountsV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/payment-accounts`,
      (value) => decodeRecord(parseCommercePaymentAccountsV1Record, value),
    );
  }

  /** Connects a Stripe account that is connected to the platform. */
  async linkStripeAccount(
    merchantId: string,
    input: Readonly<{ paymentProviderBindingId: string; accountId: string }>,
  ): Promise<CommerceClientResult<CommerceStripePaymentAccountV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/payment-accounts/stripe`,
      { method: "PUT", body: JSON.stringify(input) },
      (value) => decodeRecord(parseCommerceStripePaymentAccountV1Record, value),
    );
  }

  /** Opens Stripe's hosted onboarding for a new account of the merchant. */
  async startStripeOnboarding(
    merchantId: string,
    input: Readonly<{
      paymentProviderBindingId: string;
      country: string;
      returnUrl: string;
      refreshUrl: string;
    }>,
  ): Promise<CommerceClientResult<CommerceStripeOnboardingV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/payment-accounts/stripe/onboarding`,
      { method: "POST", body: JSON.stringify(input) },
      (value) => decodeRecord(parseCommerceStripeOnboardingV1Record, value),
    );
  }

  async connectSquare(
    merchantId: string,
    command: ConnectCommerceSquareV1,
  ): Promise<CommerceClientResult<CommerceSquareConnectionV1>> {
    return this.#request(
      `${squarePath(merchantId)}/connection`,
      { method: "PUT", body: JSON.stringify(command) },
      (value) => decodeRecord(parseCommerceSquareConnectionV1Record, value),
    );
  }

  /** The merchant's Square connection, or null when none exists. */
  async readSquareConnection(
    merchantId: string,
  ): Promise<CommerceClientResult<CommerceSquareConnectionV1 | null>> {
    const read = await this.#read(`${squarePath(merchantId)}/connection`, (value) =>
      decodeRecord(parseCommerceSquareConnectionV1Record, value),
    );
    return !read.ok && read.error.kind === "http" && read.error.status === 404
      ? { ok: true, value: null }
      : read;
  }

  async disconnectSquare(
    merchantId: string,
  ): Promise<CommerceClientResult<Readonly<{ disconnected: true }>>> {
    return this.#request(
      `${squarePath(merchantId)}/connection/revocation`,
      { method: "POST", body: "{}" },
      () => ({ disconnected: true }) as const,
    );
  }

  async listSquareLocations(
    merchantId: string,
  ): Promise<CommerceClientResult<CommerceSquareLocationsV1>> {
    return this.#read(`${squarePath(merchantId)}/locations`, (value) =>
      decodeRecord(parseCommerceSquareLocationsV1Record, value),
    );
  }

  async listSquareDevices(
    merchantId: string,
    locationId?: string,
  ): Promise<CommerceClientResult<CommerceSquareDevicesV1>> {
    const query =
      locationId === undefined
        ? ""
        : `?locationId=${encodeURIComponent(locationId)}`;
    return this.#read(`${squarePath(merchantId)}/devices${query}`, (value) =>
      decodeRecord(parseCommerceSquareDevicesV1Record, value),
    );
  }

  async createSquareDeviceCode(
    merchantId: string,
    input: Readonly<{ locationId: string; name: string; idempotencyKey: string }>,
  ): Promise<CommerceClientResult<CommerceSquareDeviceCodeV1>> {
    return this.#request(
      `${squarePath(merchantId)}/device-codes`,
      {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: JSON.stringify({ locationId: input.locationId, name: input.name }),
      },
      (value) => decodeRecord(parseCommerceSquareDeviceCodeV1Record, value),
    );
  }

  async readSquareDeviceCode(
    merchantId: string,
    deviceCodeId: string,
  ): Promise<CommerceClientResult<CommerceSquareDeviceCodeV1>> {
    return this.#read(
      `${squarePath(merchantId)}/device-codes/${encodeURIComponent(deviceCodeId)}`,
      (value) => decodeRecord(parseCommerceSquareDeviceCodeV1Record, value),
    );
  }

  async listWebhookSubscriptions(
    merchantId: string,
  ): Promise<CommerceClientResult<readonly CommerceWebhookSubscriptionV1[]>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/webhook-subscriptions`,
      parseWebhookSubscriptions,
    );
  }

  async placeChannelListing(
    command: CommerceCommandInput<PlaceCommerceChannelListingV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/channel-listings`,
      "POST",
      command,
      [],
    );
  }

  async configurePickupStorefront(
    command: CommerceCommandInput<ConfigureCommercePickupStorefrontV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/pickup-storefronts`,
      "POST",
      command,
      [],
    );
  }

  async configureShippingStorefront(
    command: CommerceCommandInput<ConfigureCommerceShippingStorefrontV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/shipping-storefronts`,
      "POST",
      command,
      [],
    );
  }

  async createPickupCheckout(
    command: CommerceCommandInput<CreateCommercePickupCheckoutV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/pickup-checkouts`,
      "POST",
      command,
      [],
    );
  }

  /**
   * Read back one counter sale.
   *
   * A counter sale has no storefront and no buyer session, so the buyer-facing
   * order read cannot reach it. This is how the till shows what it just sold,
   * and what the payment is actually doing when it is not yet settled.
   */
  async readCounterSale(
    merchantId: string,
    checkoutId: string,
  ): Promise<CommerceClientResult<CommerceCounterSaleV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/counter-sales/${encodeURIComponent(checkoutId)}`,
      { method: "GET" },
      parseCounterSale,
    );
  }

  async reconcileCounterSalePayment(
    merchantId: string,
    checkoutId: string,
  ): Promise<CommerceClientResult<CommerceCounterSaleV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/counter-sales/${encodeURIComponent(checkoutId)}/reconciliation`,
      { method: "POST" },
      parseCounterSale,
    );
  }

  /**
   * Hand the Square Point of Sale app's answer for a counter payment to
   * Commerce, which reads the payment from Square (Plan 90 Phase 3B).
   */
  async recordCounterSaleHandoffResult(
    merchantId: string,
    checkoutId: string,
    result: WireAdmin.CommerceCounterSaleHandoffResultV1,
  ): Promise<CommerceClientResult<CommerceCounterSaleV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/counter-sales/${encodeURIComponent(checkoutId)}/handoff-result`,
      { method: "POST", body: JSON.stringify(result) },
      parseCounterSale,
    );
  }

  async reconcileCounterSaleRefund(
    merchantId: string,
    checkoutId: string,
  ): Promise<CommerceClientResult<CommerceCounterSaleV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/counter-sales/${encodeURIComponent(checkoutId)}/refund-reconciliation`,
      { method: "POST" },
      parseCounterSale,
    );
  }

  /**
   * Publish the policy a counter sells under.
   *
   * Publishing retires the location's previous revision in the same step, so a
   * counter never has two policies in force and never has none.
   */
  async publishPointOfSaleConfiguration(
    command: PublishCommercePointOfSaleConfigurationV1,
  ): Promise<CommerceClientResult<PointOfSaleConfiguration>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/point-of-sale-configurations`,
      { method: "POST", body: JSON.stringify(command) },
      parsePointOfSaleConfiguration,
    );
  }

  async listPointOfSaleConfigurations(
    merchantId: string,
  ): Promise<CommerceClientResult<readonly PointOfSaleConfiguration[]>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/point-of-sale-configurations`,
      { method: "GET" },
      (raw) =>
        requireArray(raw, "pointOfSaleConfigurations").map(
          parsePointOfSaleConfiguration,
        ),
    );
  }

  async readPointOfSaleConfiguration(
    merchantId: string,
    pantryLocationId: string,
  ): Promise<CommerceClientResult<PointOfSaleConfiguration>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/point-of-sale-configurations/${encodeURIComponent(pantryLocationId)}`,
      { method: "GET" },
      parsePointOfSaleConfiguration,
    );
  }

  /**
   * Open a Checkout at the counter.
   *
   * Distinct from a pickup Checkout: the counter sells under its own published
   * point-of-sale configuration, so no storefront, buyer session, or contact is
   * a prerequisite.
   */
  async createInPersonCheckout(
    command: CommerceCommandInput<CreateCommerceInPersonCheckoutV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/in-person-checkouts`,
      "POST",
      command,
      [],
    );
  }

  async beginCheckoutPayment(
    command: CommerceCommandInput<BeginCommerceCheckoutPaymentV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/pickup-checkouts/${encodeURIComponent(command.checkoutId)}/payment-attempts`,
      "POST",
      command,
      ["checkoutId"],
    );
  }

  async collectInPersonCheckoutPayment(
    command: CommerceCommandInput<CollectCommerceInPersonCheckoutPaymentV1>,
  ): Promise<
    CommerceClientResult<CommerceInPersonCheckoutPaymentCollectionV1>
  > {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/pickup-checkouts/${encodeURIComponent(command.checkoutId)}/payment-attempts/in-person-collections`,
      "POST",
      command,
      ["checkoutId"],
      parseInPersonCheckoutPaymentCollection,
    );
  }

  async recordCounterCashPayment(
    command: CommerceCommandInput<RecordCommerceCounterCashPaymentV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/counter-sales/${encodeURIComponent(command.checkoutId)}/cash-payment`,
      "POST",
      command,
      ["checkoutId"],
    );
  }

  async recordCheckoutPaymentCapture(
    command: CommerceCommandInput<RecordCommerceCheckoutPaymentCaptureV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/pickup-checkouts/${encodeURIComponent(command.checkoutId)}/payment-attempts/${encodeURIComponent(command.paymentAttemptId)}/captures`,
      "POST",
      command,
      ["checkoutId", "paymentAttemptId"],
    );
  }

  async placePaidCheckout(
    command: CommerceCommandInput<PlaceCommercePaidCheckoutV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/pickup-checkouts/${encodeURIComponent(command.checkoutId)}/payment-attempts/${encodeURIComponent(command.paymentAttemptId)}/placements`,
      "POST",
      command,
      ["checkoutId", "paymentAttemptId"],
    );
  }

  async markPickupReady(
    command: CommerceCommandInput<MarkCommercePickupReadyV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/orders/${encodeURIComponent(command.orderId)}/pickup-fulfillments/${encodeURIComponent(command.fulfillmentId)}/ready`,
      "POST",
      command,
      ["orderId", "fulfillmentId"],
    );
  }

  async completePickup(
    command: CommerceCommandInput<CompleteCommercePickupV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/orders/${encodeURIComponent(command.orderId)}/pickup-fulfillments/${encodeURIComponent(command.fulfillmentId)}/complete`,
      "POST",
      command,
      ["orderId", "fulfillmentId"],
    );
  }

  async cancelOrder(
    command: CommerceCommandInput<CancelCommerceOrderV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/orders/${encodeURIComponent(command.orderId)}/cancellations`,
      "POST",
      command,
      ["orderId"],
    );
  }

  /** The merchant's plugins with their states (Plan 77 step 3). */
  async listPlugins(
    merchantId: string,
  ): Promise<CommerceClientResult<CommercePluginListV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/plugins`,
      parsePluginList,
    );
  }

  /** What a pause or a resume would do; it changes nothing. */
  async previewPluginChange(
    merchantId: string,
    pluginId: string,
    change: CommercePluginChangeV1,
  ): Promise<CommerceClientResult<CommercePluginPreviewV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/plugins/${encodeURIComponent(pluginId)}/previews`,
      {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: "commerce.preview-plugin-change.v1",
          change,
        }),
      },
      parsePluginPreview,
    );
  }

  async pausePlugin(
    command: CommerceCommandInput<PauseCommercePluginV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/plugins/${encodeURIComponent(command.pluginId)}/pause`,
      "POST",
      command,
      ["pluginId"],
    );
  }

  /** Sets all of a built-in plugin's settings (`settings:write`). */
  async configurePlugin(
    command: CommerceCommandInput<ConfigureCommercePluginV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/plugins/${encodeURIComponent(command.pluginId)}/settings`,
      "PUT",
      command,
      ["pluginId"],
    );
  }

  async resumePlugin(
    command: CommerceCommandInput<ResumeCommercePluginV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/plugins/${encodeURIComponent(command.pluginId)}/resume`,
      "POST",
      command,
      ["pluginId"],
    );
  }

  /** Installs a merchant plugin, or a new version of it (Plan 77 step 4). */
  async installMerchantPlugin(
    command: CommerceCommandInput<InstallCommerceMerchantPluginV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/merchant-plugins`,
      "POST",
      command,
      [],
    );
  }

  /** Sets a merchant plugin's field values on one product or variant. */
  async setPluginFieldValues(
    command: CommerceCommandInput<SetCommercePluginFieldValuesV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/plugins/${encodeURIComponent(command.pluginId)}/fields/${encodeURIComponent(command.entityType)}/${encodeURIComponent(command.entityId)}`,
      "PUT",
      command,
      ["pluginId", "entityType", "entityId"],
      parseMutationResult,
    );
  }

  /** Runs a merchant plugin's action; a refusal names its reason. */
  async runPluginAction(
    command: CommerceCommandInput<RunCommercePluginActionV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/plugins/${encodeURIComponent(command.pluginId)}/actions/${encodeURIComponent(command.actionId)}/runs`,
      "POST",
      command,
      ["pluginId", "actionId"],
      parseMutationResult,
    );
  }

  async listPluginFieldValues(
    merchantId: string,
    pluginId: string,
  ): Promise<CommerceClientResult<CommercePluginFieldValueListV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/plugins/${encodeURIComponent(pluginId)}/fields`,
      parsePluginFieldValueList,
    );
  }

  async removePlugin(
    command: CommerceCommandInput<RemoveCommercePluginV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/plugins/${encodeURIComponent(command.pluginId)}/remove`,
      "POST",
      command,
      ["pluginId"],
    );
  }

  /** Runs one function of a draft definition; it changes nothing. */
  async runPluginFunction(
    merchantId: string,
    command: RunCommercePluginFunctionV1,
  ): Promise<CommerceClientResult<CommercePluginFunctionRunV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/merchant-plugins/runs`,
      { method: "POST", body: JSON.stringify(command) },
      parsePluginFunctionRun,
    );
  }

  /** Runs a draft definition over the merchant's recent checkouts. */
  async previewMerchantPlugin(
    merchantId: string,
    command: PreviewCommerceMerchantPluginV1,
  ): Promise<CommerceClientResult<CommerceMerchantPluginPreviewV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/merchant-plugins/previews`,
      { method: "POST", body: JSON.stringify(command) },
      parseMerchantPluginPreview,
    );
  }

  /** Splits one refund over the order's payments; see the command type. */
  async refundOrderTenders(
    command: CommerceCommandInput<RefundCommerceOrderTendersV1>,
  ): Promise<CommerceClientResult<CommerceTenderRefundV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/orders/${encodeURIComponent(command.orderId)}/tender-refunds`,
      "POST",
      command,
      ["orderId"],
      parseTenderRefund,
    );
  }

  async refundOrder(
    command: CommerceCommandInput<RefundCommerceOrderV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/orders/${encodeURIComponent(command.orderId)}/refunds`,
      "POST",
      command,
      ["orderId"],
    );
  }

  async recordCounterManualCashRefund(
    command: CommerceCommandInput<RecordCommerceCounterManualCashRefundV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/orders/${encodeURIComponent(command.orderId)}/manual-cash-refunds`,
      "POST",
      command,
      ["orderId"],
    );
  }

  async resolveCheckoutPayment(
    command: CommerceCommandInput<ResolveCommerceCheckoutPaymentV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/pickup-checkouts/${encodeURIComponent(command.checkoutId)}/payment-attempts/${encodeURIComponent(command.paymentAttemptId)}/resolution`,
      "POST",
      command,
      ["checkoutId", "paymentAttemptId"],
    );
  }

  async expireCheckout(
    command: CommerceCommandInput<ExpireCommerceCheckoutV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/pickup-checkouts/${encodeURIComponent(command.checkoutId)}/expiration`,
      "POST",
      command,
      ["checkoutId"],
    );
  }

  async readSnapshot(
    merchantId: string,
  ): Promise<CommerceClientResult<CommerceMerchantSnapshotV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/snapshot`,
      parseMerchantSnapshot,
    );
  }

  async readProductSales(
    merchantId: string,
    window: ProductSalesWindow,
  ): Promise<CommerceClientResult<ProductSalesReport>> {
    const params = new URLSearchParams({
      start: window.start,
      end: window.end,
    });
    const result = await this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/reports/product-sales?${params}`,
      parseProductSalesReport,
    );
    if (
      result.ok &&
      (result.value.merchantId !== merchantId ||
        result.value.window.start !== window.start ||
        result.value.window.end !== window.end)
    ) {
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "product sales response scope mismatch",
        },
      };
    }
    return result;
  }

  async readMigrationInventory(
    merchantId: string,
  ): Promise<CommerceClientResult<CommerceMigrationInventoryV2>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/migration-inventory`,
      parseMigrationInventory,
    );
  }

  async readFoodServiceSnapshot(
    merchantId: string,
  ): Promise<CommerceClientResult<CommerceFoodServiceSnapshotV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/food-service/snapshot`,
      parseCanonicalFoodServiceSnapshot,
    );
  }

  async createPreparationStation(
    command: CommerceCommandInput<CreatePreparationStationCommand>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/food-service/preparation-stations`,
      "POST",
      command,
      [],
    );
  }

  async createModifierGroupRevision(
    command: CommerceCommandInput<CreateModifierGroupRevisionCommand>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/food-service/modifier-groups`,
      "POST",
      command,
      [],
    );
  }

  async createRecipeRevision(
    command: CommerceCommandInput<CreateRecipeRevisionCommand>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/food-service/recipes`,
      "POST",
      command,
      [],
    );
  }

  async configureStockPolicy(
    command: CommerceCommandInput<ConfigureStockPolicyCommand>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/food-service/stock-policies`,
      "POST",
      command,
      [],
    );
  }

  async publishMenu(
    command: CommerceCommandInput<PublishMenuCommand>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/food-service/menus`,
      "POST",
      command,
      [],
    );
  }

  async markSoldOut(
    command: CommerceCommandInput<MarkSoldOutCommand>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/food-service/sold-out-marks`,
      "POST",
      command,
      [],
    );
  }

  async readSoldOutMarks(
    merchantId: string,
  ): Promise<CommerceClientResult<CommerceSoldOutMarksV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/food-service/sold-out-marks`,
      parseSoldOutMarks,
    );
  }

  async readPreparationTicket(
    merchantId: string,
    ticketId: string,
  ): Promise<CommerceClientResult<CommercePreparationTicketV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/food-service/preparation-tickets/${encodeURIComponent(requireText(ticketId, "ticketId"))}`,
      parseCanonicalPreparationTicket,
    );
  }

  async quoteShipmentLabelRate(
    command: CommerceCommandInput<QuoteShipmentLabelRateCommand>,
  ): Promise<CommerceClientResult<ShipmentLabelRateResult>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/shipments/${encodeURIComponent(command.shipmentId)}/label-rates`,
      "POST",
      command,
      ["shipmentId"],
      parseShipmentLabelRateResult,
    );
  }

  async purchaseShippingLabel(
    command: CommerceCommandInput<PurchaseShippingLabelCommand>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/shipments/${encodeURIComponent(command.shipmentId)}/labels`,
      "POST",
      command,
      ["shipmentId"],
    );
  }

  async recordShippingTracking(
    command: CommerceCommandInput<RecordShippingTrackingCommand>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/shipments/${encodeURIComponent(command.shipmentId)}/tracking`,
      "POST",
      command,
      ["shipmentId"],
    );
  }

  async attachFulfillmentTracking(
    command: CommerceCommandInput<AttachFulfillmentTrackingCommand>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/shipments/${encodeURIComponent(command.shipmentId)}/tracking-attachment`,
      "POST",
      command,
      ["shipmentId"],
    );
  }

  /**
   * Applies one approved Offer price change.
   *
   * Commerce re-checks the policy, both revisions, the currency, the listing
   * state, and the allowance against state read at execution, so an approval
   * that has gone stale is refused here rather than applied.
   */
  async adjustOfferPrice(
    command: CommerceCommandInput<AdjustCommerceOfferPriceV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/offers/${encodeURIComponent(command.offerId)}/price`,
      "POST",
      command,
      ["offerId"],
    );
  }

  /** Reads the price allowance an Offer currently carries. */
  async readOfferPricePolicy(
    merchantId: string,
    offerId: string,
  ): Promise<CommerceClientResult<CommerceOfferPriceResultV1>> {
    return this.#offerPriceRequest(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/offers/${encodeURIComponent(offerId)}/price-policy`,
      "GET",
      null,
    );
  }

  /** Enables a price allowance, or resets an enabled one to today's price. */
  async setOfferPricePolicy(
    command: SetCommerceOfferPricePolicyV1,
  ): Promise<CommerceClientResult<CommerceOfferPriceResultV1>> {
    return this.#offerPriceRequest(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/offers/${encodeURIComponent(command.offerId)}/price-policy`,
      "PUT",
      command,
    );
  }

  /** Withdraws all pricing authority for one Offer. */
  async disableOfferPricePolicy(
    command: DisableCommerceOfferPricePolicyV1,
  ): Promise<CommerceClientResult<CommerceOfferPriceResultV1>> {
    return this.#offerPriceRequest(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/offers/${encodeURIComponent(command.offerId)}/price-policy`,
      "DELETE",
      command,
    );
  }

  /** The open pickups, oldest first: small enough to read on each signal. */
  async readFailedPayments(
    merchantId: string,
    window: Readonly<{ start: string; end: string }>,
  ): Promise<CommerceClientResult<CommerceFailedPaymentsV1>> {
    const params = new URLSearchParams({
      start: window.start,
      end: window.end,
    });
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/reports/failed-payments?${params.toString()}`,
      parseFailedPayments,
    );
  }

  /** Every payment that the provider answered in a window, paid or declined. */
  async readPayments(
    merchantId: string,
    window: Readonly<{ start: string; end: string }>,
  ): Promise<CommerceClientResult<CommercePaymentsV1>> {
    const params = new URLSearchParams({
      start: window.start,
      end: window.end,
    });
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/reports/payments?${params.toString()}`,
      parsePayments,
    );
  }

  async readOrderTimes(
    merchantId: string,
    window: Readonly<{ start: string; end: string }>,
  ): Promise<CommerceClientResult<CommerceOrderTimesV1>> {
    const params = new URLSearchParams({
      start: window.start,
      end: window.end,
    });
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/reports/order-times?${params.toString()}`,
      parseOrderTimes,
    );
  }

  /** `start` and `end` are calendar days; `end` is not part of the window. */
  async readBankPayouts(
    merchantId: string,
    window: Readonly<{ start: string; end: string }>,
  ): Promise<CommerceClientResult<CommerceBankPayoutsV1>> {
    const params = new URLSearchParams({
      start: window.start,
      end: window.end,
    });
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/reports/bank-payouts?${params.toString()}`,
      parseBankPayouts,
    );
  }

  async readPickupQueue(
    merchantId: string,
  ): Promise<CommerceClientResult<CommercePickupQueueV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/food-service/pickup-queue`,
      parsePickupQueue,
    );
  }

  async managePreparationTicket(
    command: CommerceCommandInput<ManagePreparationTicketCommand>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/food-service/preparation-tickets`,
      "POST",
      command,
      [],
    );
  }

  async completeProductionBatch(
    command: CommerceCommandInput<CompleteProductionBatchCommand>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/food-service/production-batches`,
      "POST",
      command,
      [],
    );
  }

  async publishCatalogListing(
    command: CommerceCommandInput<PublishCommerceCatalogListingV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/actions/publish-catalog-listing`,
      "POST",
      command,
      [],
    );
  }

  async createInventoryItem(
    command: CommerceCommandInput<CreateCommerceInventoryItemV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/inventory/items`,
      "POST",
      command,
      [],
    );
  }

  async openInventoryPosition(
    command: CommerceCommandInput<OpenCommerceInventoryPositionV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/inventory/positions`,
      "POST",
      command,
      [],
    );
  }

  async receiveInventory(
    command: CommerceCommandInput<ReceiveCommerceInventoryV3>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/inventory/receipts`,
      "POST",
      command,
      [],
    );
  }

  async reconcileInventory(
    command: CommerceCommandInput<ReconcileCommerceInventoryV1>,
  ): Promise<CommerceClientResult<CommerceMutationResultV1>> {
    return this.#command(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/inventory/reconciliations`,
      "POST",
      command,
      [],
    );
  }

  async readStockSnapshot(
    merchantId: string,
  ): Promise<CommerceClientResult<CommerceStockSnapshot>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/inventory/snapshot`,
      parseStockSnapshot,
    );
  }

  /** A feed reader's cursor; a new reader starts at the first unacknowledged delivery. */
  async readFeedConsumer(
    merchantId: string,
    consumerId: string,
  ): Promise<CommerceClientResult<CommerceFeedConsumerV1>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/feed-consumers/${encodeURIComponent(consumerId)}`,
      parseFeedConsumer,
    );
  }

  /** Moves a feed reader's cursor to the last event it applied. */
  async advanceFeedConsumer(
    merchantId: string,
    consumerId: string,
    cursor: string,
  ): Promise<CommerceClientResult<CommerceFeedConsumerV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(merchantId)}/feed-consumers/${encodeURIComponent(consumerId)}`,
      { method: "PUT", body: JSON.stringify({ cursor }) },
      parseFeedConsumer,
    );
  }

  async readMutationReceipt(
    merchantId: string,
    idempotencyKey: string,
  ): Promise<CommerceClientResult<CommerceMutationReceiptV1 | null>> {
    return this.#read(
      `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/command-receipts/${encodeURIComponent(requireText(idempotencyKey, "idempotencyKey"))}`,
      parseOptionalReceipt,
    );
  }

  async acknowledgeDelivery(
    command: AcknowledgeCommerceDeliveryV1,
  ): Promise<CommerceClientResult<CommerceDeliveryAcknowledgementV1>> {
    return this.#request(
      `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/deliveries/${encodeURIComponent(command.deliveryId)}/acknowledgements`,
      { method: "POST", body: JSON.stringify(command) },
      parseDeliveryAcknowledgement,
    );
  }

  /**
   * The Offer price boundary.
   *
   * Separate from #write because a price call returns an accepted/rejected
   * result rather than a mutation receipt: a refusal here names why the change
   * was not made, which the mutation shape has nowhere to carry.
   */
  async #offerPriceRequest(
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    command:
      | AdjustCommerceOfferPriceV1
      | SetCommerceOfferPricePolicyV1
      | DisableCommerceOfferPricePolicyV1
      | null,
  ): Promise<CommerceClientResult<CommerceOfferPriceResultV1>> {
    return this.#request(
      path,
      command === null ? { method } : { method, body: JSON.stringify(command) },
      parseOfferPriceResult,
    );
  }

  /**
   * Sends a command to a route that takes one (Plan 80 step 1): the path
   * names the merchant and the other resources, the idempotency key goes in
   * the `Idempotency-Key` header, and the body carries the rest.
   */
  async #command<T = CommerceMutationResultV1>(
    path: string,
    method: "POST" | "PUT" | "DELETE",
    input: Readonly<{ merchantId: string; idempotencyKey: string }>,
    pathFields: readonly string[],
    parse: (value: unknown) => T = parseMutationResult as (value: unknown) => T,
  ): Promise<CommerceClientResult<T>> {
    const body: Record<string, unknown> = { ...input };
    for (const field of ["merchantId", "idempotencyKey", ...pathFields])
      delete body[field];
    return this.#request(
      path,
      {
        method,
        body: JSON.stringify(body),
        idempotencyKey: input.idempotencyKey,
      },
      parse,
    );
  }

  async #read<T>(
    path: string,
    parse: (value: unknown) => T,
  ): Promise<CommerceClientResult<T>> {
    return this.#request(path, { method: "GET" }, parse);
  }

  async #request<T>(
    path: string,
    init: Readonly<{
      method: "GET" | "POST" | "PUT" | "DELETE";
      body?: string | Uint8Array;
      /** Raw bodies name their type; a string body is JSON. */
      contentType?: string;
      idempotencyKey?: string;
    }>,
    parse: (value: unknown) => T,
  ): Promise<CommerceClientResult<T>> {
    let response: Response;
    try {
      const token = await commerceBearerToken(this.#serviceToken, path);
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(this.#actor === undefined
            ? {}
            : { "commerce-actor": this.#actor }),
          ...(init.idempotencyKey === undefined
            ? {}
            : { "idempotency-key": init.idempotencyKey }),
          ...(init.body === undefined
            ? {}
            : { "content-type": init.contentType ?? "application/json" }),
        },
        // A copy gives fetch an ArrayBuffer-backed body.
        ...(init.body === undefined
          ? {}
          : { body: typeof init.body === "string" ? init.body : init.body.slice() }),
      });
    } catch (error) {
      return {
        ok: false,
        error: { kind: "network", message: errorMessage(error) },
      };
    }
    const body = await readJsonResponse(response);
    if (!response.ok) {
      const rejection = parseRejectedMutation(response.status, body);
      if (rejection !== undefined) return { ok: false, error: rejection };
      return {
        ok: false,
        error: {
          kind: "http",
          status: response.status,
          message: responseMessage(body),
        },
      };
    }
    try {
      return { ok: true, value: parse(body) };
    } catch (error) {
      return {
        ok: false,
        error: { kind: "invalid_response", message: errorMessage(error) },
      };
    }
  }
}

function storefrontShopNamePath(
  merchantId: string,
  storefrontId: string,
): string {
  return `/v1/admin/merchants/${encodeURIComponent(requireText(merchantId, "merchantId"))}/storefronts/${encodeURIComponent(requireText(storefrontId, "storefrontId"))}/shop-name`;
}

function parseOrderTimes(value: unknown): CommerceOrderTimesV1 {
  return decodeRecord(parseCommerceOrderTimesV1, value);
}

function parseBankPayouts(value: unknown): CommerceBankPayoutsV1 {
  return decodeRecord(parseCommerceBankPayoutsV1, value);
}

function parseFailedPayments(value: unknown): CommerceFailedPaymentsV1 {
  return decodeRecord(parseCommerceFailedPaymentsV1, value);
}

function parsePayments(value: unknown): CommercePaymentsV1 {
  return decodeRecord(parseCommercePaymentsV1, value);
}

function parsePickupQueue(value: unknown): CommercePickupQueueV1 {
  return decodeRecord(parseCommercePickupQueueV1, value);
}

function parseStorefrontShopName(
  value: unknown,
): CommerceStorefrontShopNameV1 {
  return decodeRecord(parseCommerceStorefrontShopNameV1, value);
}

function parseStorefrontShopNameChange(
  value: unknown,
): CommerceStorefrontShopNameChangeV1 {
  return decodeRecord(parseCommerceStorefrontShopNameChangeV1, value);
}

export function parseProvisionMerchantCommand(value: unknown): ProvisionCommerceMerchantV1 {
  return decodeRecord(parseProvisionMerchantCommandRecord, value);
}

export function parseProvisionDemoCommand(value: unknown): ProvisionCommerceDemoV1 {
  return decodeRecord(parseProvisionDemoCommandRecord, value);
}

export function parseCommerceDemoProfile(value: unknown): CommerceDemoProfile {
  return decodeRecord(parseDemoProfileRecord, value);
}

export type CommerceAppInstallationV1 = Readonly<{
  credentialId: string;
  appId: string;
  scopes: readonly CommerceApiScope[];
  token: string;
}>;

function parseMerchantClosure(value: unknown): CommerceMerchantClosureV1 {
  return decodeRecord(parseCommerceMerchantClosureV1Record, value);
}

function parseAppInstallation(value: unknown): CommerceAppInstallationV1 {
  return decodeRecord(parseCommerceAppInstallationV1Record, value);
}

export function parseMerchantProvisioningResult(value: unknown): CommerceMerchantProvisioningResultV1 {
  return decodeRecord(parseMerchantProvisioningResultRecord, value);
}

export function parseCreateLocationCommand(value: unknown): CreateCommerceLocationV1 {
  return decodeRecord(parseCreateLocationCommandRecord, value);
}

export function parsePrepareCatalogListingCommand(value: unknown): PrepareCommerceCatalogListingV1 {
  return decodeRecord(parsePrepareCatalogListingCommandRecord, value);
}

export function parseUpdateProductDescriptionCommand(value: unknown): UpdateCommerceProductDescriptionV1 {
  return decodeRecord(parseUpdateProductDescriptionCommandRecord, value);
}

export function parseConfigurePickupStorefrontCommand(value: unknown): ConfigureCommercePickupStorefrontV1 {
  return decodeRecord(parseConfigurePickupStorefrontCommandRecord, value);
}

export function parseConfigureShippingStorefrontCommand(value: unknown): ConfigureCommerceShippingStorefrontV1 {
  return decodeRecord(parseConfigureShippingStorefrontCommandRecord, value);
}

export function parsePlaceChannelListingCommand(value: unknown): PlaceCommerceChannelListingV1 {
  return decodeRecord(parsePlaceChannelListingCommandRecord, value);
}

export function parseCreatePickupCheckoutCommand(value: unknown): CreateCommercePickupCheckoutV1 {
  return decodeRecord(parseCreatePickupCheckoutCommandRecord, value);
}

export function parsePublishPointOfSaleConfigurationCommand(value: unknown): PublishCommercePointOfSaleConfigurationV1 {
  return decodeRecord(parsePublishPointOfSaleConfigurationCommandRecord, value);
}

export function parseCreateInPersonCheckoutCommand(value: unknown): CreateCommerceInPersonCheckoutV1 {
  return decodeRecord(parseCreateInPersonCheckoutCommandRecord, value);
}

export function parseBeginCheckoutPaymentCommand(value: unknown): BeginCommerceCheckoutPaymentV1 {
  return decodeRecord(parseBeginCheckoutPaymentCommandRecord, value);
}

export function parseCollectInPersonCheckoutPaymentCommand(value: unknown): CollectCommerceInPersonCheckoutPaymentV1 {
  return decodeRecord(parseCollectInPersonCheckoutPaymentCommandRecord, value);
}

export function parseRecordCounterCashPaymentCommand(value: unknown): RecordCommerceCounterCashPaymentV1 {
  return decodeRecord(parseRecordCounterCashPaymentCommandRecord, value);
}

export function parseInPersonCheckoutPaymentCollection(
  value: unknown,
): CommerceInPersonCheckoutPaymentCollectionV1 {
  return decodeRecord(parseCommerceInPersonCheckoutPaymentCollectionV1Record, value);
}

export function parseRecordCheckoutPaymentCaptureCommand(value: unknown): RecordCommerceCheckoutPaymentCaptureV1 {
  return decodeRecord(parseRecordCheckoutPaymentCaptureCommandRecord, value);
}

export function parsePlacePaidCheckoutCommand(value: unknown): PlaceCommercePaidCheckoutV1 {
  return decodeRecord(parsePlacePaidCheckoutCommandRecord, value);
}

export function parseMarkPickupReadyCommand(value: unknown): MarkCommercePickupReadyV1 {
  return decodeRecord(parseMarkPickupReadyCommandRecord, value);
}

export function parseCompletePickupCommand(value: unknown): CompleteCommercePickupV1 {
  return decodeRecord(parseCompletePickupCommandRecord, value);
}

export function parseResolveCheckoutPaymentCommand(value: unknown): ResolveCommerceCheckoutPaymentV1 {
  return decodeRecord(parseResolveCheckoutPaymentCommandRecord, value);
}

export function parseExpireCheckoutCommand(value: unknown): ExpireCommerceCheckoutV1 {
  return decodeRecord(parseExpireCheckoutCommandRecord, value);
}

export function parsePublishCatalogListingCommand(value: unknown): PublishCommerceCatalogListingV1 {
  return decodeRecord(parsePublishCatalogListingCommandRecord, value);
}

export function parseCreateInventoryItemCommand(value: unknown): CreateCommerceInventoryItemV1 {
  return decodeRecord(parseCreateInventoryItemCommandRecord, value);
}

export function parseOpenInventoryPositionCommand(value: unknown): OpenCommerceInventoryPositionV1 {
  return decodeRecord(parseOpenInventoryPositionCommandRecord, value);
}

export function parseReceiveInventoryCommand(value: unknown): ReceiveCommerceInventoryV3 {
  return decodeRecord(parseReceiveInventoryCommandRecord, value);
}

export function parseReconcileInventoryCommand(value: unknown): ReconcileCommerceInventoryV1 {
  return decodeRecord(parseReconcileInventoryCommandRecord, value);
}

export function parseInventoryReconciliationTarget(value: unknown): ReconcileCommerceInventoryV1["target"] {
  return decodeRecord(parseInventoryReconciliationTargetRecord, value);
}

export function parseInventoryReconciliationChange(value: unknown): ReconcileCommerceInventoryV1["change"] {
  return decodeRecord(parseInventoryReconciliationChangeRecord, value);
}

function webhookSubscriptionPath(
  command: Readonly<{ merchantId: string; subscriptionId: string }>,
): string {
  return `/v1/admin/merchants/${encodeURIComponent(command.merchantId)}/webhook-subscriptions/${encodeURIComponent(command.subscriptionId)}`;
}

export function parseMigrationInventory(value: unknown): CommerceMigrationInventoryV2 {
  return decodeRecord(parseMigrationInventoryRecord, value);
}

/**
 * Decodes one Offer price response.
 *
 * An unrecognised shape throws rather than reading as accepted: a price change
 * reported as applied when it was not is the worst outcome available here.
 */
export function parseOfferPriceResult(body: unknown): CommerceOfferPriceResultV1 {
  return decodeRecord(parseOfferPriceResultRecord, body);
}

function squarePath(merchantId: string): string {
  return `/v1/admin/merchants/${encodeURIComponent(merchantId)}/square`;
}

// The governed commerce actions that an approval signs: the request of each
// kind, the path of an approved action and its errors. The action modules of
// commerce parse and build them; another area names them through the
// contract.
import type { CafeMenuDefinition } from "@purin-labs/area-cafe/server/contract/menu-publication";
import type { StockOperationAction } from "@purin-labs/area-kitchen/server/contract/stock-action";
import type {
  CommercePluginActionV1,
  CommercePluginEntityTypeV1,
  CommercePluginFieldV1,
  CommercePluginHandlerV1,
} from "@purin-labs/commerce-client";
import type { Variant } from "@purin-labs/type-utils";

export type MerchantPluginSettingKind =
  "integer" | "text" | "boolean" | "text_list";

export type MerchantPluginSettingProposal = Readonly<{
  key: string;
  valueKind: MerchantPluginSettingKind;
  description: string;
  value: number | string | boolean | readonly string[];
}>;

/** The commands that a merchant plugin's handlers and actions may submit. */
export type MerchantPluginCommand =
  "create_discount" | "set_plugin_field_values" | "credit_store_credit";

export type InstallMerchantPluginAction = Readonly<{
  kind: "install_merchant_plugin";
  pluginId: string;
  version: number;
  expectedRevision: number | null;
  title: string;
  purpose: string;
  settings: readonly MerchantPluginSettingProposal[];
  /** The `checkout.validate` function, or null for a plugin without one. */
  functionSource: string | null;
  commands: readonly MerchantPluginCommand[];
  handlers: readonly CommercePluginHandlerV1[];
  actions: readonly CommercePluginActionV1[];
  entityTypes: readonly CommercePluginEntityTypeV1[];
  /** Fields that the plugin keeps on products, variants or customers. */
  fields: readonly CommercePluginFieldV1[];
}>;

export type OrderRefundLine = Readonly<{
  orderLineId: string;
  title: string;
  amountMinor: number;
}>;

export type OrderRefundAction = Readonly<{
  kind: "refund_order";
  /** The canonical order id, as the action ledger names a record. */
  orderId: string;
  providerOrderId: string;
  expectedOrderRevision: number;
  reason: string;
  paymentId: string;
  refundPolicyId: string;
  amountMinor: number;
  currency: string;
  wholeOrder: boolean;
  lines: readonly OrderRefundLine[];
  taxes: readonly Readonly<{ orderLineId: string; amountMinor: number }>[];
  shippingMinor: number;
}>;

export type MenuPriceMoney = Readonly<{
  amountMinor: number;
  currency: string;
}>;

export type MenuPriceSide = Readonly<{
  price: MenuPriceMoney;
  /** The "was" price of a deal; null when the item has no deal. */
  compareAtPrice: MenuPriceMoney | null;
}>;

export type ChangeMenuPriceAction = Readonly<{
  kind: "change_menu_price";
  /** The plain Commerce offer ID of the menu item. */
  offerId: string;
  /** The offer revision that the proposal read; a later one is refused. */
  expectedOfferRevision: number;
  /** The menu item (Commerce menu entry) that the boards show. */
  menuEntryId: string;
  /** The item's name on the menu, for the card. */
  itemName: string;
  before: MenuPriceSide;
  after: MenuPriceSide;
}>;

export type PublishCafeMenuAction = Readonly<{
  kind: "publish_cafe_menu";
  /** The draft revision that the proposal read, for the approval card. */
  documentRevision: number;
  /** The published revision that this menu replaces; null for the first. */
  expectedMenuRevision: number | null;
  menu: CafeMenuDefinition;
  /** Each entry's name in the draft, because a Commerce entry has none. */
  entryNames: readonly Readonly<{ menuEntryId: string; displayName: string }>[];
  addedEntryIds: readonly string[];
  removedNames: readonly string[];
}>;

export type CommerceActionRequest =
  | InstallMerchantPluginAction
  | PublishCafeMenuAction
  | ChangeMenuPriceAction
  | OrderRefundAction
  | StockOperationAction
  | {
      readonly kind: "publish_catalog_listing";
      readonly productId: string;
      readonly productRevision: number;
      readonly variantId: string;
      readonly variantRevision: number;
      readonly offerId: string;
      readonly offerRevision: number;
      readonly salesChannelId: string;
      readonly salesChannelRevision: number;
    }
  | {
      readonly kind: "update_product_description";
      readonly productId: string;
      readonly productRevision: number;
      readonly description: string;
    }
  | {
      readonly kind: "cancel_order";
      readonly resourceId: string;
      readonly expectedRevision: number;
      readonly reason:
        "customer_requested" | "fraud_suspected" | "inventory_unavailable";
      readonly refund: "none" | "full";
      readonly restock: boolean;
      readonly notifyCustomer: boolean;
      readonly note: string | null;
    }
  | {
      readonly kind: "attach_tracking";
      readonly batchId: string;
      readonly merchantRevision: number;
      readonly orderId: string;
      readonly fulfillmentId: string;
      readonly fulfillmentRevision: number;
      readonly shipmentId: string;
      readonly shipmentRevision: number;
      readonly trackingNumber: string;
    }
  | {
      /**
       * One immediate price change on a listed Offer.
       *
       * Both revisions are bound: the Offer the proposal was built against and
       * the price policy the approval was given under. A change to either
       * needs a new proposal, because the allowance the operator approved may
       * no longer be the one that applies.
       */
      readonly kind: "adjust_offer_price";
      readonly offerId: string;
      readonly expectedOfferRevision: number;
      readonly expectedPolicyRevision: number;
      readonly proposedPriceMinor: number;
      readonly currency: string;
    }
  | {
      /**
       * Submitting one approved supplier payout to its provider.
       *
       * The payout revision is bound because the approval is single-use: a
       * payout that has moved on since the proposal was built is not the one
       * anybody approved, and the economics digest it carries is the proof of
       * which one they did.
       */
      readonly kind: "submit_supplier_payout";
      readonly payoutId: string;
      readonly expectedPayoutRevision: number;
      readonly approvalDigest: string;
    }
  | {
      /** Funding the exact Wise transfer recovered after interrupted creation. */
      readonly kind: "resume_supplier_payout_funding";
      readonly payoutId: string;
      readonly expectedPayoutRevision: number;
      readonly approvalDigest: string;
      readonly attemptId: string;
      readonly providerTransferId: string;
    };

export type CommerceCancellationRequest = Variant<
  CommerceActionRequest,
  "cancel_order"
>;

export type CommerceCancellationAuthority = Readonly<{
  readonly kind: "commerce_full_refund";
  readonly merchantRevision: number;
  readonly paymentId: string;
  readonly paymentRevision: number;
  readonly fulfillmentId: string;
  readonly fulfillmentRevision: number;
  readonly checkoutProfileId: string;
  readonly checkoutProfileRevision: number;
  readonly refundPolicyId: string;
  readonly refundAmountMinor: number;
  readonly refundCurrency: string;
  readonly refundGovernance: "automatic_eligible" | "approval_required";
}>;

type CommerceCancellationPathFields = Readonly<{
  readonly kind: "cancel_order";
  readonly resourceId: string;
  readonly expectedRevision: number;
  readonly reason: CommerceCancellationRequest["reason"];
  readonly refund: CommerceCancellationRequest["refund"];
  readonly restock: boolean;
  readonly notifyCustomer: boolean;
  readonly note: string | null;
}>;

export type CommerceActionError =
  | { readonly code: "commerce_action_invalid"; readonly field: string }
  | { readonly code: "commerce_action_projection_missing" }
  | { readonly code: "commerce_action_projection_kind_mismatch" }
  | {
      readonly code: "commerce_action_revision_stale";
      readonly expected: number;
      readonly actual: number;
    }
  | { readonly code: "commerce_action_provider_unsupported" }
  | {
      readonly code: "commerce_action_authority_rebase_required";
      readonly expectedRevision: number;
      readonly actualRevision: number;
    }
  | { readonly code: "commerce_action_path_invalid" }
  | { readonly code: "commerce_action_event_invalid"; readonly field: string };

/**
 * The path of an approved action: the request, with the execution of a
 * cancellation bound to its provider or to the full Commerce refund.
 */
export type CommerceActionPath =
  | Exclude<CommerceActionRequest, CommerceCancellationRequest>
  | (CommerceCancellationRequest & {
      readonly execution: Readonly<{ readonly kind: "provider_managed" }>;
    })
  | (CommerceCancellationPathFields & {
      readonly execution: CommerceCancellationAuthority;
    });

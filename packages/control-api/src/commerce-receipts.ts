/**
 * The receipt of a commerce provider effect, as the action ledger, the actor
 * relocation and the Case store it. It names no commerce package, so the
 * foundation can read it until the commerce area gives a port (Refactor 17,
 * steps A1.7 and A1.8).
 */
type CommerceFlowDecisionReceipt = {
  readonly flowBindingDigest: string;
  readonly decisionDigest: string;
};

export type CommerceLabProviderReceipt = CommerceFlowDecisionReceipt & {
  readonly kind: "commerce_provider_receipt";
  readonly provider: "lab";
  readonly receiptId: string;
  readonly effectId: string;
  readonly actionNonce: string;
  readonly eventId: string;
  readonly resourceId: string;
  readonly projectionKind: "offer" | "commerce_order" | "fulfillment";
  readonly revision: number;
  readonly status: "settled";
  readonly observedAt: string;
};

export type CommerceShopifyProviderReceipt = CommerceFlowDecisionReceipt & {
  readonly kind: "commerce_provider_receipt";
  readonly provider: "shopify";
  readonly receiptId: string;
  readonly effectId: string;
  readonly actionNonce: string;
  readonly eventId: null;
  readonly resourceId: string;
  readonly projectionKind: "commerce_order";
  readonly revision: number;
  readonly status: "accepted" | "failed" | "indeterminate";
  readonly jobId: string | null;
  readonly jobDone: boolean | null;
  readonly errors: readonly {
    readonly field: string | null;
    readonly code: string | null;
    readonly message: string;
  }[];
  readonly observedAt: string;
};

type CommerceProviderReceiptFields = CommerceFlowDecisionReceipt & {
  readonly kind: "commerce_provider_receipt";
  readonly provider: "underclerk";
  readonly receiptId: string;
  readonly effectId: string;
  readonly actionNonce: string;
  readonly eventId: string;
  readonly resourceId: string;
  readonly revision: number;
  readonly status: "accepted";
  readonly merchantId: string;
  readonly merchantRevision: number;
  readonly observedAt: string;
};

export type CommerceProviderResource = Readonly<{
  readonly kind: "refund_attempt";
  readonly id: string;
  readonly revision: number;
}>;

export type CommerceEngineProviderReceipt =
  | (CommerceProviderReceiptFields & {
      readonly projectionKind:
        | "offer"
        | "fulfillment"
        | "product"
        | "merchant_plugin"
        | "cafe_menu"
        | "order_refund"
        | "stock_operation";
      readonly providerResource?: never;
    })
  | (CommerceProviderReceiptFields & {
      readonly projectionKind: "commerce_order";
      readonly providerResource: CommerceProviderResource;
    });

export type CommerceProviderReceipt =
  | CommerceLabProviderReceipt
  | CommerceShopifyProviderReceipt
  | CommerceEngineProviderReceipt;

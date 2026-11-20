import type {
  CommerceEntityRef,
  CustomCommerceRelationshipRef,
  CommerceListEntryRef,
} from "@purin-labs/commerce-contracts";

export type CommerceBoardPresenceSelection =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "list_entry"; entryId: string; listId: string }>;

export type CommerceBoardDragPreview =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "moving";
      entryId: string;
      desiredStatusId: string | null;
    }>;

export type CommerceBoardPresenceEntry = Readonly<{
  userId: string;
  displayName: string;
  resourceKey: string;
  selection: CommerceBoardPresenceSelection;
  dragPreview: CommerceBoardDragPreview;
  observedAt: number;
}>;

export type CommerceActivityResource =
  | Readonly<{ kind: "entity"; reference: CommerceEntityRef }>
  | Readonly<{ kind: "relationship"; reference: CustomCommerceRelationshipRef }>
  | Readonly<{ kind: "list_entry"; reference: CommerceListEntryRef }>;

export type CommerceActivitySourceName =
  | "blotter_history"
  | "cases"
  | "proposals"
  | "approvals"
  | "underclerk_receipts"
  | "action_ledger";

export type CommerceActionFollowUp =
  | Readonly<{ kind: "complete"; retryAt?: never; code?: never }>
  | Readonly<{ kind: "pending"; retryAt: number; code?: never }>
  | Readonly<{ kind: "unavailable"; code: string; retryAt?: never }>;

export type CommerceObservationDisposition =
  "applied" | "duplicate" | "out_of_order";

export type SupplierCreation = Readonly<{
  supplierId: string;
  displayName: string;
  legalName: string;
  countryCode: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  leadTimeDays: number;
  minimumOrderQuantity: string | null;
  minimumOrderUnit: string | null;
  purchasingNotes: string | null;
  inventoryItemIds: readonly string[];
}>;

export type MissingTrackingException = Readonly<{
  kind: "missing_tracking";
  exceptionId: string;
  reason: string;
  owner: Readonly<{ kind: "unassigned" }>;
  dueAt: string;
  recommendedAction: Readonly<{
    kind: "attach_tracking";
    label: "Attach tracking";
  }>;
  resolution: Readonly<{
    kind: "fulfillment_lifecycle";
    expectedState: "handed_to_carrier";
  }>;
  target: TrackingActionTarget;
  freshness: "current";
}>;

export type TrackingActionTarget = Readonly<{
  merchantRevision: number;
  orderId: string;
  fulfillmentId: string;
  fulfillmentRevision: number;
  shipmentId: string;
  shipmentRevision: number;
  trackingNumber: string;
}>;

export type CommerceExceptionInbox =
  | Readonly<{
      kind: "ready";
      observedAt: string;
      items: readonly MissingTrackingException[];
    }>
  | Readonly<{
      kind: "unavailable";
      reason:
        | "commerce_system_unavailable"
        | "resolution_unsupported"
        | "entity_plane_unavailable";
    }>;

export type TrackingBatchAction = Readonly<{
  kind: "attach_tracking";
  batchId: string;
}> &
  TrackingActionTarget;

export type TrackingBatchPreviewItem =
  | Readonly<{
      exceptionId: string;
      validation: Readonly<{ kind: "valid" }>;
      action: TrackingBatchAction;
    }>
  | Readonly<{
      exceptionId: string;
      validation: Readonly<{ kind: "invalid"; reason: "closed_or_changed" }>;
      action: null;
    }>;

export type TrackingBatchPreview = Readonly<{
  kind: "tracking_batch_preview";
  batchId: string;
  frozenAt: string;
  items: readonly TrackingBatchPreviewItem[];
}>;

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

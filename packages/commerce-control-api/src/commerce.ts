import type {
  CommerceEntityRef,
  CustomCommerceRelationshipRef,
  CommerceListEntryRef,
} from "@purin-labs/commerce-contracts";
import type { TrackingActionTarget } from "@purin-labs/control-api";

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
  | "commerce_receipts"
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

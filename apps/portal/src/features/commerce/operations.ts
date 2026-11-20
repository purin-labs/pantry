import type { TrackingBatchAction } from "@purin-labs/commerce-control-api";

export type OrderCancellationAction = Readonly<{
  kind: "cancel_order";
  resourceId: string;
  expectedRevision: number;
  reason: "customer_requested" | "fraud_suspected" | "inventory_unavailable";
  refund: "none" | "full";
  restock: boolean;
  notifyCustomer: boolean;
  note: string | null;
}>;

export type CommerceOperationsTransport = Readonly<{
  previewTrackingBatch: (
    organisationId: string,
    exceptionIds: readonly string[],
  ) => Promise<unknown>;
  proposeAction: (
    organisationId: string,
    action: TrackingBatchAction | OrderCancellationAction,
    intent: string,
  ) => Promise<unknown>;
}>;

// The governed stock actions that Commerce approves and commits: receive and
// count stock, and change a production request or a purchase request (Plan 81
// slice 6). The Kitchen tools propose them; the proposal freezes what the
// approval card shows, and Commerce checks the revisions at commit.
import type {
  ListEntryAttributeValue,
  Quantity,
} from "@purin-labs/commerce-contracts";

export type StockReceiveOperation = Readonly<{
  kind: "receive_stock";
  inventoryItemId: string;
  inventoryPositionId: string;
  locationId: string;
  itemName: string;
  locationName: string;
  quantity: Quantity;
  lot:
    | Readonly<{ kind: "not_tracked" }>
    | Readonly<{ kind: "tracked"; lotCode: string; expiresAt: string | null }>;
  /** The purchase request that this delivery answers, if any. */
  purchaseRequestEntryId: string | null;
  /** Null records the time of the approved execution. */
  receivedAt: string | null;
}>;

export type StockCountOperation = Readonly<{
  kind: "count_stock";
  inventoryPositionId: string;
  expectedPositionRevision: number;
  itemName: string;
  locationName: string;
  /** What the record said when the agent proposed the change. */
  onHandAtProposal: Quantity | null;
  target:
    | Readonly<{ kind: "aggregate" }>
    | Readonly<{
        kind: "lot";
        lotId: string;
        lotRevision: number;
        lotCode: string;
      }>;
  change:
    | Readonly<{ kind: "count"; observedQuantity: Quantity }>
    | Readonly<{
        kind: "adjustment";
        direction: "increase" | "decrease";
        quantity: Quantity;
        reason: "correction" | "waste" | "damage";
      }>;
}>;

export type StockProductionRequestOperation = Readonly<{
  kind: "request_production";
  inventoryItemId: string;
  inventoryPositionId: string;
  locationId: string;
  itemName: string;
  locationName: string;
  recipeId: string;
  recipeRevision: number;
  recipeName: string;
  quantity: Quantity;
  neededBy: string;
  listRevision: number;
}>;

export type StockProductionAdvanceOperation = Readonly<{
  kind: "advance_production_request";
  entryId: string;
  expectedRevision: number;
  listRevision: number;
  status: "accepted" | "scheduled";
  itemName: string;
  recipeId: string;
  recipeRevision: number;
  locationId: string;
  quantity: Quantity;
  neededBy: string;
}>;

export type StockPurchaseRequestOperation = Readonly<{
  kind: "update_purchase_request";
  entryId: string;
  expectedRevision: number;
  listRevision: number;
  itemName: string;
  owner: string;
  purchaseRequestId: string;
  expectedDeliveryAt: string | null;
  notes: string | null;
  attributeValues: readonly ListEntryAttributeValue[];
}>;

export type StockOperation =
  | StockReceiveOperation
  | StockCountOperation
  | StockProductionRequestOperation
  | StockProductionAdvanceOperation
  | StockPurchaseRequestOperation;

export type StockOperationAction = Readonly<{
  kind: "stock_operation";
  /** The sentence that the approver reads, and the count's explanation. */
  reason: string;
  operation: StockOperation;
}>;

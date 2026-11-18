import type {
  StockOperationDetails,
  StockOperationView,
  StockQuantity,
} from "@seams/control-api/portal/stock-operation";

function amount(value: StockQuantity): string {
  return `${(value.amount / 10 ** value.scale).toLocaleString("en", {
    maximumFractionDigits: value.scale,
  })} ${value.unit}`;
}

function time(value: string): string {
  return new Date(value).toLocaleString("en", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

type Fact = readonly [label: string, value: string];

function facts(operation: StockOperationView): {
  readonly summary: string;
  readonly rows: readonly Fact[];
} {
  switch (operation.kind) {
    case "receive_stock":
      return {
        summary: `Receive ${amount(operation.quantity)} of ${operation.itemName}`,
        rows: [
          ["Location", operation.locationName],
          ...(operation.lot.kind === "tracked"
            ? ([["Lot", operation.lot.lotCode]] as const)
            : []),
          ...(operation.lot.kind === "tracked" &&
          operation.lot.expiresAt !== null
            ? ([["Expires", time(operation.lot.expiresAt)]] as const)
            : []),
          [
            "Received",
            operation.receivedAt === null
              ? "When you approve"
              : time(operation.receivedAt),
          ],
          [
            "Purchase request",
            operation.purchaseRequestEntryId === null ? "None" : "Linked",
          ],
        ],
      };
    case "count_stock":
      return {
        summary:
          operation.change.kind === "count"
            ? `Set ${operation.itemName} to the counted ${amount(operation.change.observedQuantity)}`
            : `${operation.change.direction === "increase" ? "Add" : "Remove"} ${amount(operation.change.quantity)} of ${operation.itemName}`,
        rows: [
          ["Location", operation.locationName],
          ...(operation.target.kind === "lot"
            ? ([["Lot", operation.target.lotCode]] as const)
            : []),
          [
            "Record now",
            operation.onHandAtProposal === null
              ? "Not recorded"
              : amount(operation.onHandAtProposal),
          ],
          ...(operation.change.kind === "adjustment"
            ? ([["Type", operation.change.reason]] as const)
            : []),
        ],
      };
    case "request_production":
      return {
        summary: `Make ${amount(operation.quantity)} of ${operation.itemName}`,
        rows: [
          ["Location", operation.locationName],
          ["Recipe", operation.recipeName],
          ["Needed by", time(operation.neededBy)],
        ],
      };
    case "advance_production_request":
      return {
        summary: `Mark the request for ${operation.itemName} as ${operation.status}`,
        rows: [
          ["Quantity", amount(operation.quantity)],
          ["Needed by", time(operation.neededBy)],
        ],
      };
    case "update_purchase_request":
      return {
        summary: `Record the purchase of ${operation.itemName}`,
        rows: [
          ["Owner", operation.owner],
          ["Purchase request", operation.purchaseRequestId],
          [
            "Expected delivery",
            operation.expectedDeliveryAt === null
              ? "Not known"
              : time(operation.expectedDeliveryAt),
          ],
          ...(operation.notes === null
            ? []
            : ([["Notes", operation.notes]] as const)),
        ],
      };
  }
}

/** The exact stock or purchasing change that the approval signs. */
export function StockOperationCard(input: {
  readonly details: StockOperationDetails;
}): React.JSX.Element {
  const { summary, rows } = facts(input.details.operation);
  return (
    <>
      <p className="action-summary">
        <strong>{summary}</strong>
      </p>
      <dl className="action-change-facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div>
          <dt>Reason</dt>
          <dd>{input.details.reason}</dd>
        </div>
      </dl>
    </>
  );
}

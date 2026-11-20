import React from "react";

import { formatMoneyMinorEnglish as money } from "../../formatting";

import type { CommerceActionDetails } from "@purin-labs/commerce-control-api/portal/commerce-actions";
import type { Variant } from "@purin-labs/type-utils";

/** The exact money that goes back, and where it comes from on the order. */
export function OrderRefundDetails(input: {
  readonly details: Variant<CommerceActionDetails, "refund_order">;
}): React.JSX.Element {
  const { details } = input;
  const taxes = new Map(
    details.taxes.map((tax) => [tax.orderLineId, tax.amountMinor]),
  );
  return (
    <>
      <p className="action-summary">
        <span>{details.wholeOrder ? "Refund the whole order" : "Refund"}</span>:{" "}
        <strong>{money(details.amountMinor, details.currency)}</strong>
      </p>
      <dl className="action-change-facts">
        {details.lines.map((line) => (
          <div key={line.orderLineId}>
            <dt>
              <bdi>{line.title}</bdi>
            </dt>
            <dd>
              {money(
                line.amountMinor + (taxes.get(line.orderLineId) ?? 0),
                details.currency,
              )}
            </dd>
          </div>
        ))}
        {details.shippingMinor > 0 ? (
          <div>
            <dt>Shipping</dt>
            <dd>{money(details.shippingMinor, details.currency)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Reason</dt>
          <dd>
            <bdi>{details.reason}</bdi>
          </dd>
        </div>
      </dl>
    </>
  );
}

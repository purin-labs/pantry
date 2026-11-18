import React from "react";

import { formatMenuPrice, menuPriceChangeKind } from "./menu-price-details";
import type {
  MenuPriceDetails,
  MenuPriceSideDetails,
} from "@seams/control-api/portal/menu-price-details";

function PriceSide(input: {
  readonly side: MenuPriceSideDetails;
}): React.JSX.Element {
  const { side } = input;
  return (
    <span className="menu-price-side">
      {side.compareAtPrice === null ? null : (
        <>
          <s aria-label={`Was ${formatMenuPrice(side.compareAtPrice)}`}>
            {formatMenuPrice(side.compareAtPrice)}
          </s>{" "}
        </>
      )}
      <strong>{formatMenuPrice(side.price)}</strong>
    </span>
  );
}

/**
 * The change card's body: the item, and the price that the boards show now
 * and after the approval, side by side.
 */
export function MenuPriceChangeDetails(input: {
  readonly details: MenuPriceDetails;
}): React.JSX.Element {
  const { details } = input;
  const kind = menuPriceChangeKind(details);
  return (
    <>
      <p className="action-summary">
        <span>
          {kind === "deal"
            ? "Deal on"
            : kind === "end_deal"
              ? "End the deal on"
              : "New price for"}
        </span>
        :{" "}
        <strong>
          <bdi>{details.itemName}</bdi>
        </strong>
      </p>
      <dl className="action-change-facts menu-price-change" data-change={kind}>
        <div>
          <dt>Before</dt>
          <dd data-side="before">
            <PriceSide side={details.before} />
          </dd>
        </div>
        <div>
          <dt>After</dt>
          <dd data-side="after">
            <PriceSide side={details.after} />
          </dd>
        </div>
        <div>
          <dt>Shows on</dt>
          <dd>Every menu board, screen and the QR order page</dd>
        </div>
      </dl>
    </>
  );
}

// The commerce types that other areas name. A type that the inside of
// commerce defines is exported here with `export type`, so the contract
// pulls in no implementation.
import type { RequestId } from "../../ids";

export type { CommerceActionPath } from "../action-model";

/** The price change that the agent proposes for a menu item. */
export type MenuPriceProposalRequest = Readonly<{
  itemId: string;
  priceMinor: number;
  /** True keeps the current price on the boards as the earlier price. */
  deal: boolean;
}>;

export type { PublishedResourceBoundaryError } from "../../data/agent-operations/scope-commerce";

/** The armed fault of the Café commerce acceptance journey. */
export type CafeCommerceAcceptanceFaultRecord = Readonly<{
  schemaVersion: 1;
  requestId: RequestId;
  merchantId: string;
  armedAt: number;
  queueConsumedAt: number | null;
}>;

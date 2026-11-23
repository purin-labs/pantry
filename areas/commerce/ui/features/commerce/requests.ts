import {
  parseInventoryProductionContext,
  parseInventoryReceiptContext,
  type InventoryProductionContext,
  type InventoryReceiptContext,
} from "@purin-labs/kitchen-control-api";

import { controlRead } from "@purin-labs/control/portal/control-client";

/** The inventory pages' reads of the Platform, and the paths they change. */

function inventoryPath(organisationId: string, resource = ""): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/inventory${resource}`;
}

export function productionPath(organisationId: string): string {
  return inventoryPath(organisationId, "/production-requests");
}

export function receiptPath(organisationId: string): string {
  return inventoryPath(organisationId, "/receipts");
}

export function reconciliationPath(organisationId: string): string {
  return inventoryPath(organisationId, "/reconciliations");
}

export function readInventory(organisationId: string): Promise<unknown> {
  return controlRead(inventoryPath(organisationId));
}

export function readCommerceCosts(organisationId: string): Promise<unknown> {
  return controlRead(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/costs`,
  );
}

/** The supplier deliveries of the stock timeline. The caller parses them. */
export function readInventoryDeliveries(
  organisationId: string,
): Promise<unknown> {
  return controlRead(inventoryPath(organisationId, "/deliveries"));
}

/** The production of one stock position: its recipes and its requests. */
export async function readProductionContext(
  organisationId: string,
  positionId: string,
): Promise<InventoryProductionContext> {
  return parseInventoryProductionContext(
    await controlRead(
      `${productionPath(organisationId)}?position=${encodeURIComponent(positionId)}`,
    ),
  );
}

/**
 * A page of production requests, with the item and location filters of
 * the page's address. The answer is checked by the caller.
 */
export function readProductionRequests(
  organisationId: string,
  cursor: string | null,
): Promise<unknown> {
  const selected = new URLSearchParams(window.location.search);
  const query = new URLSearchParams();
  for (const name of ["inventoryItem", "location"]) {
    const value = selected.get(name);
    if (value !== null) {
      query.set(name, value);
    }
  }
  if (cursor !== null) {
    query.set("cursor", cursor);
  }
  return controlRead(
    `${productionPath(organisationId)}${query.size === 0 ? "" : `?${query}`}`,
  );
}

/** The first page of production requests, with no filter. */
export function readAllProductionRequests(
  organisationId: string,
): Promise<unknown> {
  return controlRead(productionPath(organisationId));
}

/** One production request. The answer is checked by the caller. */
export function readProductionRequest(
  organisationId: string,
  requestId: string,
): Promise<unknown> {
  return controlRead(
    `${productionPath(organisationId)}?request=${encodeURIComponent(requestId)}`,
  );
}

/** The receipts and purchases of one stock position. */
export async function readReceiptContext(
  organisationId: string,
  positionId: string,
): Promise<InventoryReceiptContext> {
  return parseInventoryReceiptContext(
    await controlRead(
      `${receiptPath(organisationId)}?position=${encodeURIComponent(positionId)}`,
    ),
  );
}

/** The count of one stock position. */
export async function readReconciliationContext(
  organisationId: string,
  positionId: string,
): Promise<InventoryReceiptContext> {
  return parseInventoryReceiptContext(
    await controlRead(
      `${reconciliationPath(organisationId)}?position=${encodeURIComponent(positionId)}`,
    ),
  );
}

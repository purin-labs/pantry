import type { CommerceEntity } from "@purin-labs/commerce-contracts";
import { SUPPLIER_DIRECTORY_LIST_ID } from "@purin-labs/commerce-client";
import { commerceRecordLabel } from "./presentation";
import type { CommerceEntityPlaneRouteProps } from "./entity-plane-types";
import type { CommerceGraphPage } from "./route";

/**
 * The query parameter that opens the tab of a list, by the list's id, such
 * as `tab=supplier_directory`. The tab is the view that presents the list, or
 * the list itself when no view presents it.
 */
export const COMMERCE_TAB_PARAMETER = "tab";

/**
 * Back from a record to its page. A supplier goes back to the Supplier
 * Directory, the tab that lists it, and not to the first tab of Purchasing.
 */
export function backToCommerceCollection(
  onBack: CommerceEntityPlaneRouteProps["onBack"],
  page: CommerceGraphPage,
): void {
  onBack(
    page === "suppliers"
      ? `${COMMERCE_TAB_PARAMETER}=${SUPPLIER_DIRECTORY_LIST_ID}`
      : "",
  );
}

export function unchangedCommerceWatchCleanup(): void {}

export function incrementCommerceRefreshRevision(revision: number): number {
  return revision + 1;
}

export function commerceEntityName(entity: CommerceEntity): string {
  return commerceRecordLabel(entity.displayName);
}

import type { CommerceAdminClient } from "@purin-labs/commerce-client";

import { normalizeUntrustedText } from "@purin-labs/agent-tools/context/untrusted-text";
import { connectedStockOverview } from "@purin-labs/area-kitchen-contract/server/inventory-overview";
import {
  merchantReportDefinition,
  POPULATION_LIMIT,
  type MerchantReportRecord,
  type MerchantReportResult,
} from "./merchant-reports";
import type { Variant } from "@purin-labs/type-utils";

/** The record type whose read grant covers the stock shortage report. */
export const STOCK_SHORTAGE_SOURCE_TYPE = "inventory_position";

/**
 * Counts the stock rows that are low or out, from the same snapshot and the
 * same rule as the Products and Ingredients pages, so that the agent and the
 * pages give one number. An item with no stock at all counts, with or without a
 * reorder point.
 */
export async function readBoundStockShortages(
  input: Readonly<{
    /** A client scoped to the Organisation, so Commerce checks the tenant. */
    client: CommerceAdminClient;
    merchantId: string;
    now: string;
  }>,
): Promise<Variant<MerchantReportResult, "reported">> {
  const snapshot = await input.client.readStockSnapshot(input.merchantId);
  if (!snapshot.ok)
    throw new Error(`stock snapshot unavailable: ${snapshot.error.kind}`);
  const scope = snapshot.value.commerce;
  if (scope.merchantId !== input.merchantId)
    throw new Error("stock snapshot binding mismatch");
  const shortages = connectedStockOverview(snapshot.value).rows.filter(
    (row) => row.status === "low" || row.status === "out",
  );
  const definition = merchantReportDefinition("low_stock_exposure");
  const population: MerchantReportRecord[] = [];
  for (const row of shortages.slice(0, POPULATION_LIMIT)) {
    const name = normalizeUntrustedText(row.name, "display_name").text;
    const state = row.status === "out" ? "out of stock" : "low";
    population.push({
      entityType:
        row.positionId === null ? "inventory_item" : "inventory_position",
      entityId: row.positionId ?? row.inventoryItemId,
      revision: positionRevision(snapshot.value, row.positionId),
      displayName: `${name.length === 0 ? "Unnamed item" : name} (${row.kind === "supply" ? "supply" : "product"}, ${state})`,
    });
  }
  return {
    kind: "reported",
    name: definition.name,
    metric: definition.metric,
    entityType: definition.entityType,
    window: definition.window,
    unit: definition.unit,
    supportsDecision: definition.supportsDecision,
    value: shortages.length,
    population,
    populationTruncated: population.length < shortages.length,
    merchantRevision: scope.merchantRevision,
    provenance: [
      {
        source: "commerce_stock_snapshot",
        merchantId: scope.merchantId,
        merchantRevision: scope.merchantRevision,
      },
    ],
    freshness: [{ state: "current", observedAt: input.now }],
  };
}

function positionRevision(
  snapshot: Parameters<typeof connectedStockOverview>[0],
  positionId: string | null,
): number {
  for (const position of snapshot.commerce.resources.inventoryPositions)
    if (position.id === positionId) return position.revision;
  return 0;
}

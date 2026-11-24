import { isRecord } from "@purin-labs/std";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type {
  InspectedCommerceObservation,
  ProjectionRow,
} from "../commerce-projection";
import { projectionBody } from "./records";
import {
  projectionSelectSql,
  storedInventoryQuantity,
  type InventoryQuantity,
} from "./validation";
import type { InventoryStockChange } from "@purin-labs/area-commerce-contract/server/commerce-projection";

export type { InventoryStockChange } from "@purin-labs/area-commerce-contract/server/commerce-projection";

type PositionStock = Readonly<{
  inventoryItemId: string;
  locationId: string;
  available: InventoryQuantity;
}>;

function positionStock(body: unknown): PositionStock | null {
  if (
    !isRecord(body) ||
    typeof body.inventoryItemId !== "string" ||
    typeof body.locationId !== "string" ||
    !isRecord(body.balance)
  )
    return null;
  const available = storedInventoryQuantity(body.balance.available);
  return available === null
    ? null
    : {
        inventoryItemId: body.inventoryItemId,
        locationId: body.locationId,
        available,
      };
}

/**
 * Follows the positions of one delivery. A second change of the same position
 * in one delivery starts from the first one's result, because the stored rows
 * are written after every observation is checked.
 */
export class PositionStockTracker {
  readonly #latest = new Map<string, InventoryQuantity>();

  change(
    stored: ProjectionRow | null,
    observation: InspectedCommerceObservation,
  ): InventoryStockChange | null {
    if (
      observation.kind !== "upsert" ||
      observation.identity.kind !== "inventory_position"
    )
      return null;
    const next = positionStock(projectionBody(observation.projectionJson));
    if (next === null) return null;
    const canonicalId = observation.identity.canonicalId;
    const before =
      this.#latest.get(canonicalId) ??
      (stored === null
        ? null
        : (positionStock(projectionBody(stored.projectionJson))?.available ??
          null));
    this.#latest.set(canonicalId, next.available);
    return {
      inventoryItemId: next.inventoryItemId,
      locationId: next.locationId,
      before,
      after: next.available,
    };
  }
}

/** The available stock of an item at each of its positions. */
export function readInventoryItemStock(
  sql: SqlStorage,
  organisationId: OrganisationId,
  inventoryItemId: string,
): readonly Readonly<{ locationId: string; available: InventoryQuantity }>[] {
  const rows = sql
    .exec<ProjectionRow>(
      `${projectionSelectSql()}
     WHERE organisation_id = ?
       AND projection_kind = 'inventory_position'
       AND json_extract(projection_json, '$.projection.inventoryItemId') = ?
     ORDER BY canonical_id`,
      organisationId,
      inventoryItemId,
    )
    .toArray();
  const stock = [];
  for (const row of rows) {
    const position = positionStock(projectionBody(row.projectionJson));
    if (position !== null)
      stock.push({
        locationId: position.locationId,
        available: position.available,
      });
  }
  return stock;
}

/** Pieces of a quantity counted in `each`; null for any other unit. */
export function pieceCount(quantity: InventoryQuantity): number | null {
  return quantity.unit === "each"
    ? Math.floor(quantity.amount / 10 ** quantity.scale)
    : null;
}

/**
 * The active finished goods that Commerce counts in pieces, with the stock of
 * their first position: the products that a bake stock level may name.
 */
export function listCountedProducts(
  sql: SqlStorage,
  organisationId: OrganisationId,
): readonly Readonly<{
  inventoryItemId: string;
  name: string;
  counterPieces: number | null;
}>[] {
  const rows = sql
    .exec<ProjectionRow>(
      `${projectionSelectSql()}
     WHERE organisation_id = ? AND projection_kind = 'inventory_item'
       AND lifecycle = 'active'
       AND json_extract(projection_json, '$.projection.category') = 'finished_good'
       AND json_extract(projection_json, '$.projection.baseUnit') = 'each'
     ORDER BY canonical_id
     LIMIT 200`,
      organisationId,
    )
    .toArray();
  const products = [];
  for (const row of rows) {
    const body = projectionBody(row.projectionJson);
    if (body === null || typeof body.name !== "string") continue;
    const stock = readInventoryItemStock(
      sql,
      organisationId,
      row.canonicalId,
    )[0];
    products.push({
      inventoryItemId: row.canonicalId,
      name: body.name,
      counterPieces: stock === undefined ? null : pieceCount(stock.available),
    });
  }
  return products;
}

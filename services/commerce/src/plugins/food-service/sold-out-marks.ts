// "Sold out today" (Plan 40B phase 3): staff mark a drink that has no stock
// count. The mark belongs to one variant at one location, so that it holds on
// every menu of that shop, and it ends by itself at the shop's next midnight.
import type { CommerceSoldOutMarksV1 } from "@purin-labs/commerce-client";

import type { CommerceDatabase } from "../../database.ts";

type MarkRow = Readonly<{
  locationId: string;
  variantId: string;
  revision: number;
  soldOutUntil: string | null;
}>;

function markIsActive(until: string | null, now: string): boolean {
  return until !== null && Date.parse(until) > Date.parse(now);
}

export function variantIsMarkedSoldOut(
  database: CommerceDatabase,
  merchantId: string,
  locationId: string,
  variantId: string,
  now: string,
): boolean {
  const row = database
    .prepare(
      `SELECT sold_out_until AS soldOutUntil FROM menu_sold_out_mark
       WHERE merchant_id = ? AND location_id = ? AND variant_id = ?`,
    )
    .get<Readonly<{ soldOutUntil: string | null }>>(
      merchantId,
      locationId,
      variantId,
    );
  return row !== undefined && markIsActive(row.soldOutUntil, now);
}

/** All the marks of a location: one read for a whole catalog. */
export function variantsMarkedSoldOut(
  database: CommerceDatabase,
  merchantId: string,
  locationId: string,
  now: string,
): ReadonlySet<string> {
  const rows = database
    .prepare(
      `SELECT variant_id AS variantId, sold_out_until AS soldOutUntil
       FROM menu_sold_out_mark
       WHERE merchant_id = ? AND location_id = ? AND sold_out_until IS NOT NULL`,
    )
    .all<Readonly<{ variantId: string; soldOutUntil: string | null }>>(
      merchantId,
      locationId,
    );
  return new Set(
    rows
      .filter((row) => markIsActive(row.soldOutUntil, now))
      .map((row) => row.variantId),
  );
}

export function readSoldOutMarkRevision(
  database: CommerceDatabase,
  merchantId: string,
  locationId: string,
  variantId: string,
): number | undefined {
  return database
    .prepare(
      `SELECT revision FROM menu_sold_out_mark
       WHERE merchant_id = ? AND location_id = ? AND variant_id = ?`,
    )
    .get<Readonly<{ revision: number }>>(merchantId, locationId, variantId)
    ?.revision;
}

export function writeSoldOutMark(
  database: CommerceDatabase,
  merchantId: string,
  mark: MarkRow & Readonly<{ markedAt: string }>,
): void {
  database
    .prepare(
      `INSERT INTO menu_sold_out_mark (
         merchant_id, location_id, variant_id, revision, sold_out_until, marked_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (merchant_id, location_id, variant_id) DO UPDATE SET
         revision = excluded.revision,
         sold_out_until = excluded.sold_out_until,
         marked_at = excluded.marked_at`,
    )
    .run(
      merchantId,
      mark.locationId,
      mark.variantId,
      mark.revision,
      mark.soldOutUntil,
      mark.markedAt,
    );
}

export function readSoldOutMarks(
  database: CommerceDatabase,
  merchantId: string,
  merchantRevision: number,
  now: string,
): CommerceSoldOutMarksV1 {
  const rows = database
    .prepare(
      `SELECT location_id AS locationId, variant_id AS variantId, revision,
              sold_out_until AS soldOutUntil
       FROM menu_sold_out_mark WHERE merchant_id = ?
       ORDER BY location_id, variant_id`,
    )
    .all<MarkRow>(merchantId);
  const marks: CommerceSoldOutMarksV1["marks"][number][] = [];
  for (const row of rows) {
    if (row.soldOutUntil === null || !markIsActive(row.soldOutUntil, now))
      continue;
    marks.push({
      locationId: row.locationId,
      variantId: row.variantId,
      revision: row.revision,
      until: row.soldOutUntil,
    });
  }
  return {
    schemaVersion: "underclerk.sold-out-marks.v1",
    merchantId,
    merchantRevision,
    marks,
  };
}

/** Removes the marks of a variant that no longer exists. */
export function deleteVariantSoldOutMarks(
  database: CommerceDatabase,
  merchantId: string,
  variantId: string,
): void {
  database
    .prepare(
      "DELETE FROM menu_sold_out_mark WHERE merchant_id = ? AND variant_id = ?",
    )
    .run(merchantId, variantId);
}

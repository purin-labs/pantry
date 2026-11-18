// The `lot_expiry` pass of the merchant's alarm (Refactor 15, refactor 7,
// decision 3). A lot whose expiry passed leaves on hand as waste, through the
// same reconcile command that staff send, so the feed, the stock counts and
// the Costs page see one waste movement. The reconcile moves the lot to
// `expired` (the lot machine's `expire`, then `write_off`).
//
// On hand never goes below the stock that open allocations hold. So the pass
// writes off only the free part of a position; what a paid order still holds
// waits until the order releases it (a cancellation) or fresh stock arrives,
// and the pass after that request writes it off.
import type {
  ReconcileCommerceInventoryV1,
  CommerceMutationResultV1,
  CommerceQuantityV1,
} from "@seams/commerce-client";

import type { CommerceDatabase } from "../database.ts";
import {
  readInventoryLot,
  readInventoryPositionForItemLocation,
} from "../inventory-persistence.ts";
import { isAccountedPosition, scaledAmount } from "./inventory-planning.ts";
import type { MerchantRow } from "./ledger.ts";

/** At most this many write-offs in one pass; the next pass goes on. */
const PASS_LIMIT = 100;

type LotExpiryOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  readMerchant: (merchantId: string) => MerchantRow | undefined;
  reconcileInventory: (
    command: ReconcileCommerceInventoryV1,
  ) => CommerceMutationResultV1;
}>;

type LapsedLotRow = Readonly<{ merchantId: string; lotId: string }>;

/**
 * Writes off the expired lots that still count on hand. Returns when the
 * next lot expires, or now when the pass stopped at its limit.
 */
export function expireLapsedLots(options: LotExpiryOptions): string | null {
  const now = options.now();
  let written = 0;
  for (const row of lapsedLots(options.database, now)) {
    if (written === PASS_LIMIT) return now;
    const merchant = options.readMerchant(row.merchantId);
    const lot = readInventoryLot(options.database, row.merchantId, row.lotId);
    if (merchant === undefined || lot === undefined) continue;
    const position = readInventoryPositionForItemLocation(
      options.database,
      row.merchantId,
      lot.inventoryItemId,
      lot.locationId,
    );
    if (position === undefined || !isAccountedPosition(position)) continue;
    const quantity = freeWriteOff(lot.remainingQuantity, position.balance);
    if (quantity === undefined) continue;
    const expiresAt =
      lot.expiry.kind === "expires" ? lot.expiry.expiresAt : now;
    const result = options.reconcileInventory({
      schemaVersion: "underclerk.reconcile-inventory.v1",
      merchantId: row.merchantId,
      expectedMerchantRevision: merchant.revision,
      idempotencyKey: `lot_expiry_${lot.id}_${lot.revision}`,
      requestedAt: now,
      inventoryPositionId: position.id,
      inventoryPositionRevision: position.revision,
      target: { kind: "lot", lotId: lot.id, lotRevision: lot.revision },
      change: {
        kind: "adjustment",
        direction: "decrease",
        quantity,
        reason: "waste",
        explanation: `Lot ${lot.lotCode} expired at ${expiresAt}`,
      },
    });
    if (result.outcome === "rejected") {
      console.warn(
        "underclerk.lot_expiry_refused",
        row.lotId,
        result.error.code,
      );
      continue;
    }
    written += 1;
  }
  return nextLotExpiry(options.database, now);
}

// Lots past their expiry that still count on hand, the oldest first: an
// available lot that no pass reached yet, and an expired lot whose rest an
// order held.
function lapsedLots(
  database: CommerceDatabase,
  now: string,
): readonly LapsedLotRow[] {
  return database
    .prepare(
      `SELECT merchant_id AS merchantId, lot_id AS lotId FROM stock_lot
       WHERE lifecycle IN ('available', 'expired') AND expiry_kind = 'expires'
         AND remaining_amount > 0 AND expires_at <= ?
       ORDER BY expires_at, merchant_id, lot_id`,
    )
    .all<LapsedLotRow>(now);
}

function nextLotExpiry(database: CommerceDatabase, now: string): string | null {
  return (
    database
      .prepare(
        `SELECT MIN(expires_at) AS expiresAt FROM stock_lot
         WHERE lifecycle IN ('available', 'expired') AND expiry_kind = 'expires'
           AND remaining_amount > 0 AND expires_at > ?`,
      )
      .get<Readonly<{ expiresAt: string | null }>>(now)?.expiresAt ?? null
  );
}

/**
 * The part of the lot that no allocation holds, in the lot's own scale, or
 * undefined when the position's whole free stock is zero.
 */
function freeWriteOff(
  remaining: CommerceQuantityV1,
  balance: Readonly<{
    onHand: CommerceQuantityV1;
    allocated: CommerceQuantityV1;
  }>,
): CommerceQuantityV1 | undefined {
  if (
    balance.onHand.unit !== remaining.unit ||
    balance.allocated.unit !== remaining.unit
  )
    return undefined;
  const scale = Math.max(
    remaining.scale,
    balance.onHand.scale,
    balance.allocated.scale,
  );
  const free =
    scaledAmount(balance.onHand, scale) -
    scaledAmount(balance.allocated, scale);
  const lot = scaledAmount(remaining, scale);
  const factor = 10n ** BigInt(scale - remaining.scale);
  const amount = (free < lot ? free : lot) / factor;
  if (amount <= 0n) return undefined;
  return {
    amount: Number(amount),
    scale: remaining.scale,
    unit: remaining.unit,
  };
}

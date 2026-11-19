import {
  parseInventoryLot,
  parseInventoryPosition,
  type CommerceInventoryItemV1,
  type CommerceInventoryLotV1,
  type CommerceInventoryMovementV1,
  type CommerceInventoryPositionV1,
  type CommerceLotAllocationV1,
  type CommerceMutationErrorV1,
  type CommerceQuantityV1,
} from "@purin-labs/commerce-client";
import {
  commerceTransition,
  type InventoryAllocation,
} from "@purin-labs/commerce-contracts";
import type { Variant } from "@purin-labs/type-utils";
import type { CommerceDatabase } from "../database.ts";
import {
  listUsableInventoryLots,
  readInventoryItem,
} from "../inventory-persistence.ts";

type LotConsumptionPlanResult =
  | Readonly<{
      kind: "planned";
      allocation: Variant<
        CommerceInventoryMovementV1["change"],
        "decrease"
      >["lotAllocation"];
      lots: readonly CommerceInventoryLotV1[];
    }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export function isAccountedPosition(
  position: CommerceInventoryPositionV1,
): position is AccountedInventoryPosition {
  return position.balance.kind === "accounted";
}

type AccountedInventoryPosition = CommerceInventoryPositionV1 &
  Readonly<{
    balance: Variant<CommerceInventoryPositionV1["balance"], "accounted">;
  }>;

export function planSaleLotConsumption(
  item: CommerceInventoryItemV1,
  allocation: Readonly<
    Pick<InventoryAllocation, "inventoryItemId" | "locationId" | "quantity">
  >,
  currentLots: ReadonlyMap<string, CommerceInventoryLotV1>,
  changedLots: ReadonlyMap<string, CommerceInventoryLotV1>,
  occurredAt: string,
): LotConsumptionPlanResult {
  if (item.tracking.kind === "aggregate") {
    return { kind: "planned", allocation: { kind: "not_tracked" }, lots: [] };
  }
  const candidates: CommerceInventoryLotV1[] = [];
  for (const lot of currentLots.values()) {
    if (
      lot.inventoryItemId === allocation.inventoryItemId &&
      lot.locationId === allocation.locationId &&
      lot.lifecycle.state === "available" &&
      !lotExpiredAt(lot, occurredAt) &&
      lot.remainingQuantity.amount > 0
    ) {
      candidates.push(lot);
    }
  }
  candidates.sort(compareLotsForConsumption);
  const scale = maxLotConsumptionScale(candidates, allocation.quantity.scale);
  let remaining = scaledAmount(allocation.quantity, scale);
  const lotAllocations: CommerceLotAllocationV1[] = [];
  const lots: CommerceInventoryLotV1[] = [];
  for (const lot of candidates) {
    if (remaining === 0n) break;
    const available = scaledAmount(lot.remainingQuantity, scale);
    const factor = 10n ** BigInt(scale - lot.remainingQuantity.scale);
    let consumed = available < remaining ? available : remaining;
    consumed -= consumed % factor;
    if (consumed === 0n) continue;
    const consumedAmount = Number(consumed / factor);
    const nextRemainingAmount = lot.remainingQuantity.amount - consumedAmount;
    const revision = changedLots.has(lot.id) ? lot.revision : lot.revision + 1;
    lotAllocations.push({
      lotId: lot.id,
      quantity: {
        amount: consumedAmount,
        scale: lot.remainingQuantity.scale,
        unit: lot.remainingQuantity.unit,
      },
    });
    lots.push(
      parseInventoryLot({
        id: lot.id,
        lotCode: lot.lotCode,
        inventoryItemId: lot.inventoryItemId,
        locationId: lot.locationId,
        revision,
        sourceMovementId: lot.sourceMovementId,
        receivedQuantity: lot.receivedQuantity,
        remainingQuantity: {
          amount: nextRemainingAmount,
          scale: lot.remainingQuantity.scale,
          unit: lot.remainingQuantity.unit,
        },
        expiry: lot.expiry,
        lifecycle: movedLotLifecycle(lot, nextRemainingAmount, occurredAt),
        occurredAt,
      }),
    );
    remaining -= consumed;
  }
  if (remaining !== 0n)
    return lotConsumptionRejected("pickupCompletion.lotAvailability");
  return {
    kind: "planned",
    allocation: { kind: "allocated", lots: lotAllocations },
    lots,
  };
}

/**
 * The state of a lot after a movement leaves `remaining` in it, through the
 * lot machine: a lot past its expiry expires, an expired lot stays expired,
 * and otherwise the lot is depleted at zero and available above it. A
 * quarantined lot keeps its state; no command moves it.
 */
export function movedLotLifecycle(
  lot: CommerceInventoryLotV1,
  remaining: number,
  occurredAt: string,
): CommerceInventoryLotV1["lifecycle"] {
  const lifecycle = lot.lifecycle;
  if (lifecycle.state === "quarantined") return lifecycle;
  const event =
    lifecycle.state === "expired"
      ? "write_off"
      : lifecycle.state === "available" && lotExpiredAt(lot, occurredAt)
        ? "expire"
        : remaining === 0
          ? "deplete"
          : lifecycle.state === "depleted"
            ? "restock"
            : "draw";
  const move = commerceTransition("stock_lot", lifecycle, event);
  if (!move.allowed)
    throw new Error(`Inventory lot cannot ${event} from ${lifecycle.state}`);
  return { state: move.to };
}

export function usableInventoryQuantity(
  item: CommerceInventoryItemV1,
  position: CommerceInventoryPositionV1,
  lots: readonly CommerceInventoryLotV1[],
  occurredAt: string,
): CommerceQuantityV1 {
  if (item.tracking.kind === "aggregate") return position.balance.available;
  let scale = position.balance.available.scale;
  for (const lot of lots) {
    if (lot.inventoryItemId === item.id && lot.locationId === position.locationId) scale = Math.max(scale, lot.remainingQuantity.scale);
  }
  let eligible = 0n;
  for (const lot of lots) {
    if (lot.inventoryItemId === item.id && lot.locationId === position.locationId && lot.lifecycle.state === "available" && !lotExpiredAt(lot, occurredAt)) eligible += scaledAmount(lot.remainingQuantity, scale);
  }
  if (position.balance.kind === "accounted") eligible -= scaledAmount(position.balance.allocated, scale);
  if (eligible <= 0n) return { amount: 0, scale: 0, unit: item.baseUnit };
  if (eligible >= scaledAmount(position.balance.available, scale)) return position.balance.available;
  if (eligible > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Usable inventory exceeds safe quantity precision");
  return { amount: Number(eligible), scale, unit: item.baseUnit };
}

// What a sale can promise: unexpired lots less the stock already held. A ticket
// and a pickup completion consume with the same rule, so a sale that passes
// here can be made.
export function readUsableInventoryQuantity(
  database: CommerceDatabase,
  merchantId: string,
  position: CommerceInventoryPositionV1,
  occurredAt: string,
): CommerceQuantityV1 {
  const item = readInventoryItem(database, merchantId, position.inventoryItemId);
  if (item === undefined) throw new Error("Inventory position has no item");
  if (item.tracking.kind === "aggregate") return position.balance.available;
  return usableInventoryQuantity(
    item,
    position,
    listUsableInventoryLots(database, merchantId, item.id, position.locationId),
    occurredAt,
  );
}

export function wholeAmountAtScale(
  quantity: CommerceQuantityV1,
  scale: number,
): number {
  return quantity.scale <= scale
    ? quantity.amount * 10 ** (scale - quantity.scale)
    : Math.floor(quantity.amount / 10 ** (quantity.scale - scale));
}

export function accountedPositionCanCommit(
  position: AccountedInventoryPosition,
  quantity: CommerceQuantityV1,
): boolean {
  if (
    position.balance.onHand.unit !== quantity.unit ||
    position.balance.allocated.unit !== quantity.unit
  )
    return false;
  const scale = Math.max(position.balance.onHand.scale, quantity.scale);
  const committedAmount = scaledAmount(quantity, scale);
  return (
    scaledAmount(position.balance.onHand, scale) >= committedAmount &&
    scaledAmount(position.balance.allocated, scale) >= committedAmount
  );
}

export function accountedPositionCanConsume(
  position: AccountedInventoryPosition,
  quantity: CommerceQuantityV1,
): boolean {
  if (
    position.balance.onHand.unit !== quantity.unit ||
    position.balance.available.unit !== quantity.unit
  )
    return false;
  const scale = Math.max(position.balance.onHand.scale, quantity.scale);
  const consumed = scaledAmount(quantity, scale);
  return (
    scaledAmount(position.balance.onHand, scale) >= consumed &&
    scaledAmount(position.balance.available, scale) >= consumed
  );
}

export function consumedProductionInventoryPosition(
  position: AccountedInventoryPosition,
  quantity: CommerceQuantityV1,
  occurredAt: string,
  revisionAlreadyAdvanced: boolean,
): CommerceInventoryPositionV1 {
  const scale = Math.max(position.balance.onHand.scale, quantity.scale);
  const onHand = subtractQuantityAtScale(
    position.balance.onHand,
    quantity,
    scale,
  );
  const available = subtractQuantityAtScale(
    position.balance.available,
    quantity,
    scale,
  );
  const allocated = quantityAtScale(position.balance.allocated, scale);
  if (
    onHand === undefined ||
    available === undefined ||
    allocated === undefined
  ) {
    throw new Error("Production input quantity cannot be represented safely");
  }
  return parseInventoryPosition({
    id: position.id,
    revision: position.revision + (revisionAlreadyAdvanced ? 0 : 1),
    inventoryItemId: position.inventoryItemId,
    locationId: position.locationId,
    balance: { kind: "accounted", onHand, allocated, available },
    occurredAt,
  });
}

export function increasedProductionInventoryPosition(
  position: AccountedInventoryPosition,
  quantity: CommerceQuantityV1,
  occurredAt: string,
  revisionAlreadyAdvanced: boolean,
): CommerceInventoryPositionV1 {
  const scale = Math.max(position.balance.onHand.scale, quantity.scale);
  const onHand = addQuantity(position.balance.onHand, quantity);
  const available = addQuantity(position.balance.available, quantity);
  const allocated = quantityAtScale(position.balance.allocated, scale);
  if (
    onHand === undefined ||
    available === undefined ||
    allocated === undefined
  ) {
    throw new Error("Production output quantity cannot be represented safely");
  }
  return parseInventoryPosition({
    id: position.id,
    revision: position.revision + (revisionAlreadyAdvanced ? 0 : 1),
    inventoryItemId: position.inventoryItemId,
    locationId: position.locationId,
    balance: { kind: "accounted", onHand, allocated, available },
    occurredAt,
  });
}

export function accountedPositionCanRelease(
  position: AccountedInventoryPosition,
  quantity: CommerceQuantityV1,
): boolean {
  if (position.balance.allocated.unit !== quantity.unit) return false;
  const scale = Math.max(position.balance.allocated.scale, quantity.scale);
  return (
    scaledAmount(position.balance.allocated, scale) >=
    scaledAmount(quantity, scale)
  );
}

export function releasedInventoryPosition(
  position: AccountedInventoryPosition,
  quantity: CommerceQuantityV1,
  occurredAt: string,
  revisionAlreadyAdvanced: boolean,
): CommerceInventoryPositionV1 {
  const scale = Math.max(position.balance.allocated.scale, quantity.scale);
  const onHand = quantityAtScale(position.balance.onHand, scale);
  const allocated = subtractQuantityAtScale(
    position.balance.allocated,
    quantity,
    scale,
  );
  const released = quantityAtScale(quantity, scale);
  const currentAvailable = quantityAtScale(position.balance.available, scale);
  if (
    onHand === undefined ||
    allocated === undefined ||
    released === undefined ||
    currentAvailable === undefined
  ) {
    throw new Error("Checkout allocation release cannot be represented safely");
  }
  const available = addQuantity(currentAvailable, released);
  if (available === undefined) {
    throw new Error(
      "Checkout allocation release exceeds safe quantity precision",
    );
  }
  return parseInventoryPosition({
    id: position.id,
    revision: position.revision + (revisionAlreadyAdvanced ? 0 : 1),
    inventoryItemId: position.inventoryItemId,
    locationId: position.locationId,
    balance: { kind: "accounted", onHand, allocated, available },
    occurredAt,
  });
}

export function committedInventoryPosition(
  position: AccountedInventoryPosition,
  quantity: CommerceQuantityV1,
  occurredAt: string,
  revisionAlreadyAdvanced: boolean,
): CommerceInventoryPositionV1 {
  const scale = Math.max(position.balance.onHand.scale, quantity.scale);
  const onHand = subtractQuantityAtScale(
    position.balance.onHand,
    quantity,
    scale,
  );
  const allocated = subtractQuantityAtScale(
    position.balance.allocated,
    quantity,
    scale,
  );
  const available = quantityAtScale(position.balance.available, scale);
  if (
    onHand === undefined ||
    allocated === undefined ||
    available === undefined
  ) {
    throw new Error("Pickup completion quantity cannot be represented safely");
  }
  return parseInventoryPosition({
    id: position.id,
    revision: position.revision + (revisionAlreadyAdvanced ? 0 : 1),
    inventoryItemId: position.inventoryItemId,
    locationId: position.locationId,
    balance: {
      kind: "accounted",
      onHand,
      allocated,
      available,
    },
    occurredAt,
  });
}

export function sameQuantity(
  left: CommerceQuantityV1,
  right: CommerceQuantityV1,
): boolean {
  if (left.unit !== right.unit) return false;
  const scale = Math.max(left.scale, right.scale);
  return scaledAmount(left, scale) === scaledAmount(right, scale);
}

export function addQuantity(
  available: CommerceQuantityV1,
  received: CommerceQuantityV1,
): CommerceQuantityV1 | undefined {
  if (available.unit !== received.unit) return undefined;
  const scale = Math.max(available.scale, received.scale);
  const total = scaledAmount(available, scale) + scaledAmount(received, scale);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return { amount: Number(total), scale, unit: available.unit };
}

export function scaledAmount(
  quantity: CommerceQuantityV1,
  scale: number,
): bigint {
  return BigInt(quantity.amount) * 10n ** BigInt(scale - quantity.scale);
}

function lotExpiredAt(
  lot: CommerceInventoryLotV1,
  occurredAt: string,
): boolean {
  return (
    lot.expiry.kind === "expires" &&
    timestampAtOrBefore(lot.expiry.expiresAt, occurredAt)
  );
}

function compareLotsForConsumption(
  left: CommerceInventoryLotV1,
  right: CommerceInventoryLotV1,
): number {
  const leftExpiry =
    left.expiry.kind === "expires" ? left.expiry.expiresAt : "9999-12-31";
  const rightExpiry =
    right.expiry.kind === "expires" ? right.expiry.expiresAt : "9999-12-31";
  return (
    leftExpiry.localeCompare(rightExpiry) || left.id.localeCompare(right.id)
  );
}

function maxLotConsumptionScale(
  lots: readonly CommerceInventoryLotV1[],
  initial: number,
): number {
  let scale = initial;
  for (const lot of lots) scale = Math.max(scale, lot.remainingQuantity.scale);
  return scale;
}

function subtractQuantityAtScale(
  left: CommerceQuantityV1,
  right: CommerceQuantityV1,
  scale: number,
): CommerceQuantityV1 | undefined {
  if (left.unit !== right.unit) return undefined;
  return safeQuantityFromAmount(
    scaledAmount(left, scale) - scaledAmount(right, scale),
    scale,
    left.unit,
  );
}

export function quantityAtScale(
  quantity: CommerceQuantityV1,
  scale: number,
): CommerceQuantityV1 | undefined {
  return safeQuantityFromAmount(
    scaledAmount(quantity, scale),
    scale,
    quantity.unit,
  );
}

function safeQuantityFromAmount(
  amount: bigint,
  scale: number,
  unit: CommerceQuantityV1["unit"],
): CommerceQuantityV1 | undefined {
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return { amount: Number(amount), scale, unit };
}

function lotConsumptionRejected(field: string): LotConsumptionPlanResult {
  return {
    kind: "rejected",
    error: { code: "resource_relationship_invalid", field },
  };
}

function timestampAtOrBefore(left: string, right: string): boolean {
  return Date.parse(left) <= Date.parse(right);
}

/** The one position of `positions` that a movement changes. */
export function findPositionForMovement(
  positions: readonly CommerceInventoryPositionV1[],
  movement: CommerceInventoryMovementV1,
): CommerceInventoryPositionV1 {
  const matches = positions.filter(
    positionMatchesMovement.bind(undefined, movement),
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error("Inventory movement has no unique position");
  }
  return matches[0];
}

function positionMatchesMovement(
  movement: CommerceInventoryMovementV1,
  position: CommerceInventoryPositionV1,
): boolean {
  return (
    position.inventoryItemId === movement.inventoryItemId &&
    position.locationId === movement.locationId
  );
}

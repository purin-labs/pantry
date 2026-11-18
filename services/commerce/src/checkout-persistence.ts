import {
  checkoutOnlineSource,
  checkoutPointOfSaleSource,
  parseCart,
  parseCheckout,
  parseCheckoutPaymentAttempt,
  parseInventoryAllocation,
  parseInventoryConsumptionPlan,
  parseStorefront,
} from "@seams/commerce-client";
import {
  COMMERCE_MACHINES,
  commerceTransition,
  type Cart,
  type Checkout,
  type CheckoutPaymentAttempt,
  type CommerceMachineEvent,
  type InventoryAllocation,
  type InventoryConsumptionPlan,
  type Storefront,
} from "@seams/commerce-contracts";

import type { CommerceDatabase } from "./database.ts";
import type { VariantBy } from "@seams/type-utils";
import { assertNever, parseJson } from "@seams/std";

type StoredJsonRow = Readonly<{ storedJson: string }>;
type InventoryPositionIdentityRow = Readonly<{ inventoryPositionId: string }>;
type BuyerCartCommandReceiptRow = Readonly<{
  operationKind: string;
  requestDigest: string;
  cartJson: string;
}>;
type AllocationOwner = Readonly<{
  kind: "checkout" | "order";
  id: string;
  lineId: string | null;
}>;

export function writeStorefront(
  database: CommerceDatabase,
  merchantId: string,
  storefront: Storefront,
): void {
  database
    .prepare(
      `INSERT INTO storefront (
       merchant_id, storefront_id, revision, name, sales_channel_id,
       fulfillment_kind, fulfillment_json, checkout_json, lifecycle_state, lifecycle_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, storefront_id) DO UPDATE SET
       revision = excluded.revision,
       name = excluded.name,
       sales_channel_id = excluded.sales_channel_id,
       fulfillment_kind = excluded.fulfillment_kind,
       fulfillment_json = excluded.fulfillment_json,
       checkout_json = excluded.checkout_json,
       lifecycle_state = excluded.lifecycle_state,
       lifecycle_json = excluded.lifecycle_json`,
    )
    .run(
      merchantId,
      storefront.storefrontId,
      storefront.revision,
      storefront.name,
      storefront.salesChannelId,
      storefront.fulfillment.kind,
      JSON.stringify(storefront.fulfillment),
      JSON.stringify(storefront.checkout),
      storefront.lifecycle.state,
      JSON.stringify(storefront.lifecycle),
    );
}

/**
 * The active pickup storefront serving one Pantry location.
 *
 * A terminal belongs to a location, not to a storefront, so an in-person
 * checkout resolves its tax and lead-time policy this way rather than making
 * an operator name a storefront they never see. Exactly one active pickup
 * storefront may serve a location; anything else is ambiguous and returns
 * undefined rather than guessing.
 */
export function readStorefrontForPickupLocation(
  database: CommerceDatabase,
  merchantId: string,
  locationId: string,
): Storefront | undefined {
  const rows = database
    .prepare(
      `SELECT storefront_id AS storefrontId
     FROM storefront
     WHERE merchant_id = ?
       AND json_extract(fulfillment_json, '$.kind') = 'pickup'
       AND json_extract(fulfillment_json, '$.locationId') = ?
       AND json_extract(lifecycle_json, '$.state') = 'active'`,
    )
    .all<Readonly<{ storefrontId: string }>>(merchantId, locationId);
  const only = rows.length === 1 ? rows[0] : undefined;
  return only === undefined
    ? undefined
    : readStorefront(database, merchantId, only.storefrontId);
}

export function readStorefront(
  database: CommerceDatabase,
  merchantId: string,
  storefrontId: string,
): Storefront | undefined {
  return readStoredJson(
    database,
    `SELECT json_object(
       'storefrontId', storefront_id,
       'revision', revision,
       'name', name,
       'salesChannelId', sales_channel_id,
       'fulfillment', json(fulfillment_json),
       'checkout', json(checkout_json),
       'lifecycle', json(lifecycle_json)
     ) AS storedJson
     FROM storefront WHERE merchant_id = ? AND storefront_id = ?`,
    [merchantId, storefrontId],
    parseStorefront,
  );
}

export function readChannelShippingStorefront(
  database: CommerceDatabase,
  merchantId: string,
  salesChannelId: string,
): Storefront | undefined {
  return readStoredJson(
    database,
    `SELECT json_object(
       'storefrontId', storefront_id,
       'revision', revision,
       'name', name,
       'salesChannelId', sales_channel_id,
       'fulfillment', json(fulfillment_json),
       'checkout', json(checkout_json),
       'lifecycle', json(lifecycle_json)
     ) AS storedJson
     FROM storefront
     WHERE merchant_id = ? AND sales_channel_id = ?
       AND fulfillment_kind = 'shipping' AND lifecycle_state = 'active'
     ORDER BY storefront_id LIMIT 1`,
    [merchantId, salesChannelId],
    parseStorefront,
  );
}

export function writeConsumptionPlan(
  database: CommerceDatabase,
  merchantId: string,
  plan: InventoryConsumptionPlan,
): void {
  const scopeLocationId =
    plan.scope.kind === "location" ? plan.scope.locationId : null;
  const directCommitOn =
    plan.mode.kind === "direct" ? plan.mode.commitOn : null;
  const recipeId = plan.mode.kind === "prepared" ? plan.mode.recipeId : null;
  const recipeRevision =
    plan.mode.kind === "prepared" ? plan.mode.recipeRevision : null;
  database
    .prepare(
      `INSERT INTO inventory_consumption_plan (
       merchant_id, consumption_plan_id, variant_id, revision,
       scope_kind, scope_location_id, mode_kind, direct_commit_on,
       recipe_id, recipe_revision, lifecycle
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, consumption_plan_id) DO UPDATE SET
       variant_id = excluded.variant_id,
       revision = excluded.revision,
       scope_kind = excluded.scope_kind,
       scope_location_id = excluded.scope_location_id,
       mode_kind = excluded.mode_kind,
       direct_commit_on = excluded.direct_commit_on,
       recipe_id = excluded.recipe_id,
       recipe_revision = excluded.recipe_revision,
       lifecycle = excluded.lifecycle`,
    )
    .run(
      merchantId,
      plan.consumptionPlanId,
      plan.variantId,
      plan.revision,
      plan.scope.kind,
      scopeLocationId,
      plan.mode.kind,
      directCommitOn,
      recipeId,
      recipeRevision,
      plan.lifecycle,
    );
  database
    .prepare(
      `DELETE FROM inventory_consumption_requirement
     WHERE merchant_id = ? AND consumption_plan_id = ?`,
    )
    .run(merchantId, plan.consumptionPlanId);
  if (plan.mode.kind !== "direct") return;
  for (const requirement of plan.mode.components) {
    database
      .prepare(
        `INSERT INTO inventory_consumption_requirement (
         merchant_id, consumption_plan_id, inventory_item_id,
         quantity_amount, quantity_scale, quantity_unit
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        plan.consumptionPlanId,
        requirement.inventoryItemId,
        requirement.quantity.amount,
        requirement.quantity.scale,
        requirement.quantity.unit,
      );
  }
}

export function readConsumptionPlan(
  database: CommerceDatabase,
  merchantId: string,
  consumptionPlanId: string,
): InventoryConsumptionPlan | undefined {
  const row = database
    .prepare(
      `SELECT variant_id AS variantId, revision, scope_kind AS scopeKind,
            scope_location_id AS scopeLocationId, mode_kind AS modeKind,
            direct_commit_on AS directCommitOn, recipe_id AS recipeId,
            recipe_revision AS recipeRevision, lifecycle
     FROM inventory_consumption_plan
     WHERE merchant_id = ? AND consumption_plan_id = ?`,
    )
    .get<
      Readonly<{
        variantId: string;
        revision: number;
        scopeKind: string;
        scopeLocationId: string | null;
        modeKind: string;
        directCommitOn: string | null;
        recipeId: string | null;
        recipeRevision: number | null;
        lifecycle: string;
      }>
    >(merchantId, consumptionPlanId);
  if (row === undefined) return undefined;
  const requirements = database
    .prepare(
      `SELECT inventory_item_id AS inventoryItemId,
            quantity_amount AS amount, quantity_scale AS scale, quantity_unit AS unit
     FROM inventory_consumption_requirement
     WHERE merchant_id = ? AND consumption_plan_id = ?
     ORDER BY inventory_item_id`,
    )
    .all<
      Readonly<{
        inventoryItemId: string;
        amount: number;
        scale: number;
        unit: string;
      }>
    >(merchantId, consumptionPlanId);
  return parseInventoryConsumptionPlan({
    consumptionPlanId,
    variantId: row.variantId,
    revision: row.revision,
    scope: consumptionScope(row.scopeKind, row.scopeLocationId),
    mode: consumptionMode(row, requirements),
    lifecycle: row.lifecycle,
  });
}

export function listConsumptionPlansForVariant(
  database: CommerceDatabase,
  merchantId: string,
  variantId: string,
): readonly InventoryConsumptionPlan[] {
  const rows = database
    .prepare(
      `SELECT consumption_plan_id AS consumptionPlanId
     FROM inventory_consumption_plan
     WHERE merchant_id = ? AND variant_id = ?
     ORDER BY consumption_plan_id`,
    )
    .all<Readonly<{ consumptionPlanId: string }>>(merchantId, variantId);
  const plans: InventoryConsumptionPlan[] = [];
  for (const row of rows) {
    const plan = readConsumptionPlan(
      database,
      merchantId,
      row.consumptionPlanId,
    );
    if (plan === undefined)
      throw new Error("Consumption plan disappeared during read");
    plans.push(plan);
  }
  return plans;
}

export function writeCart(
  database: CommerceDatabase,
  merchantId: string,
  cart: Cart,
): void {
  const existingOwner = readBuyerSessionOwner(database, merchantId, {
    kind: "cart",
    id: cart.cartId,
  });
  if (
    existingOwner !== undefined &&
    existingOwner !== cart.buyerSessionDigest
  ) {
    throw new Error("Cart buyer session ownership cannot change");
  }
  database
    .prepare(
      `INSERT INTO buyer_cart (
       merchant_id, cart_id, storefront_id, checkout_profile_id,
       checkout_profile_revision, buyer_session_digest, revision,
       lifecycle_state, lifecycle_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, cart_id) DO UPDATE SET
       storefront_id = excluded.storefront_id,
       revision = excluded.revision,
       lifecycle_state = excluded.lifecycle_state,
       lifecycle_json = excluded.lifecycle_json
     WHERE buyer_cart.buyer_session_digest = excluded.buyer_session_digest`,
    )
    .run(
      merchantId,
      cart.cartId,
      cart.storefrontId,
      cart.checkoutProfile.checkoutProfileId,
      cart.checkoutProfile.revision,
      cart.buyerSessionDigest,
      cart.revision,
      cart.lifecycle.state,
      JSON.stringify(cart.lifecycle),
    );
  if (
    readBuyerSessionOwner(database, merchantId, {
      kind: "cart",
      id: cart.cartId,
    }) !== cart.buyerSessionDigest
  ) {
    throw new Error("Cart buyer session ownership did not persist");
  }
  database
    .prepare(
      "DELETE FROM buyer_cart_line WHERE merchant_id = ? AND cart_id = ?",
    )
    .run(merchantId, cart.cartId);
  for (const line of cart.lines) {
    database
      .prepare(
        `INSERT INTO buyer_cart_line (
         merchant_id, cart_id, cart_line_id, variant_id, source_json,
         quantity_amount, quantity_scale, quantity_unit
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        cart.cartId,
        line.cartLineId,
        cartLineVariantId(line),
        JSON.stringify(line.source),
        line.quantity.amount,
        line.quantity.scale,
        line.quantity.unit,
      );
  }
}

function cartLineVariantId(line: Cart["lines"][number]): string {
  switch (line.source.kind) {
    case "catalog":
    case "food_service":
      return line.source.variantId;
    default:
      throw new Error("Source-only cart lines cannot be persisted");
  }
}

export function readCart(
  database: CommerceDatabase,
  merchantId: string,
  cartId: string,
): Cart | undefined {
  const cart = database
    .prepare(
      `SELECT storefront_id AS storefrontId,
            checkout_profile_id AS checkoutProfileId,
            checkout_profile_revision AS checkoutProfileRevision,
            buyer_session_digest AS buyerSessionDigest, revision,
            lifecycle_json AS lifecycleJson
     FROM buyer_cart WHERE merchant_id = ? AND cart_id = ?`,
    )
    .get<
      Readonly<{
        storefrontId: string;
        checkoutProfileId: string;
        checkoutProfileRevision: number;
        buyerSessionDigest: string;
        revision: number;
        lifecycleJson: string;
      }>
    >(merchantId, cartId);
  if (cart === undefined) return undefined;
  const lines = database
    .prepare(
      `SELECT cart_line_id AS cartLineId, variant_id AS variantId, source_json AS sourceJson,
            quantity_amount AS amount, quantity_scale AS scale, quantity_unit AS unit
     FROM buyer_cart_line WHERE merchant_id = ? AND cart_id = ? ORDER BY cart_line_id`,
    )
    .all<
      Readonly<{
        cartLineId: string;
        variantId: string;
        sourceJson: string;
        amount: number;
        scale: number;
        unit: string;
      }>
    >(merchantId, cartId);
  return parseCart({
    cartId,
    storefrontId: cart.storefrontId,
    checkoutProfile: {
      checkoutProfileId: cart.checkoutProfileId,
      revision: cart.checkoutProfileRevision,
    },
    buyerSessionDigest: cart.buyerSessionDigest,
    revision: cart.revision,
    lines: cartLines(lines),
    lifecycle: parseJson(cart.lifecycleJson),
  });
}

export type BuyerCartCommandReceipt = Readonly<{
  operationKind: "create" | "replace";
  requestDigest: string;
  cart: Cart;
}>;

export function readBuyerCartCommandReceipt(
  database: CommerceDatabase,
  merchantId: string,
  buyerSessionDigest: string,
  idempotencyKey: string,
): BuyerCartCommandReceipt | undefined {
  const row = database
    .prepare(
      `SELECT operation_kind AS operationKind, request_digest AS requestDigest,
            cart_json AS cartJson
     FROM buyer_cart_command_receipt
     WHERE merchant_id = ? AND buyer_session_digest = ? AND idempotency_key = ?`,
    )
    .get<BuyerCartCommandReceiptRow>(
      merchantId,
      buyerSessionDigest,
      idempotencyKey,
    );
  if (row === undefined) return undefined;
  if (!/^[0-9a-f]{64}$/u.test(row.requestDigest)) {
    throw new Error("Stored buyer Cart command digest is invalid");
  }
  switch (row.operationKind) {
    case "create":
    case "replace":
      return {
        operationKind: row.operationKind,
        requestDigest: row.requestDigest,
        cart: parseCart(parseJson(row.cartJson)),
      };
    default:
      throw new Error("Stored buyer Cart command operation is invalid");
  }
}

export function writeBuyerCartCommandReceipt(
  database: CommerceDatabase,
  input: Readonly<{
    merchantId: string;
    buyerSessionDigest: string;
    idempotencyKey: string;
    operationKind: "create" | "replace";
    requestDigest: string;
    cart: Cart;
    createdAt: string;
  }>,
): void {
  database
    .prepare(
      `INSERT INTO buyer_cart_command_receipt (
       merchant_id, buyer_session_digest, idempotency_key, operation_kind,
       request_digest, cart_id, cart_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.merchantId,
      input.buyerSessionDigest,
      input.idempotencyKey,
      input.operationKind,
      input.requestDigest,
      input.cart.cartId,
      JSON.stringify(input.cart),
      input.createdAt,
    );
}

export function writeCheckout(
  database: CommerceDatabase,
  merchantId: string,
  checkout: Checkout,
): void {
  const online = checkoutOnlineSource(checkout);
  if (online !== undefined) {
    // Cart ownership and profile agreement are online invariants: a counter
    // sale has no durable cart to own or disagree with.
    const existingOwner = readBuyerSessionOwner(database, merchantId, {
      kind: "checkout",
      id: checkout.checkoutId,
    });
    if (
      existingOwner !== undefined &&
      existingOwner !== online.buyerSessionDigest
    ) {
      throw new Error("Checkout buyer session ownership cannot change");
    }
    const cart = readCart(database, merchantId, online.cartId);
    if (
      cart === undefined ||
      cart.checkoutProfile.checkoutProfileId !==
        online.checkoutProfile.checkoutProfileId ||
      cart.checkoutProfile.revision !== online.checkoutProfile.revision
    ) {
      throw new Error("Checkout profile must match its cart");
    }
  }
  const pointOfSale = checkoutPointOfSaleSource(checkout);
  database
    .prepare(
      `INSERT INTO buyer_checkout (
       merchant_id, checkout_id, source_kind, storefront_id, cart_id,
       buyer_session_digest, satyr_location_id, operator_identity,
       terminal_assignment_revision, point_of_sale_buyer_kind,
       point_of_sale_customer_id, checkout_profile_id,
       checkout_profile_revision, pos_configuration_revision, revision,
       lifecycle_state, quote_digest, checkout_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, checkout_id) DO UPDATE SET
       storefront_id = excluded.storefront_id,
       cart_id = excluded.cart_id,
       revision = excluded.revision,
       lifecycle_state = excluded.lifecycle_state,
       quote_digest = excluded.quote_digest,
       checkout_json = excluded.checkout_json
     WHERE buyer_checkout.source_kind = excluded.source_kind
       AND buyer_checkout.buyer_session_digest IS excluded.buyer_session_digest`,
    )
    .run(
      merchantId,
      checkout.checkoutId,
      checkout.source.kind,
      online?.storefrontId ?? null,
      online?.cartId ?? null,
      online?.buyerSessionDigest ?? null,
      pointOfSale?.satyrLocationId ?? null,
      pointOfSale?.operatorIdentity ?? null,
      pointOfSale?.terminalAssignmentRevision ?? null,
      pointOfSale?.buyer.kind ?? null,
      pointOfSale?.buyer.kind === "identified_customer"
        ? pointOfSale.buyer.customerId
        : null,
      // Each channel writes only its own: the CHECK requires the other to be
      // null, so neither carries a field it does not have.
      online?.checkoutProfile.checkoutProfileId ?? null,
      online?.checkoutProfile.revision ?? null,
      pointOfSale?.posConfigurationRevision ?? null,
      checkout.revision,
      checkout.lifecycle.state,
      checkout.lifecycle.quote.quoteDigest,
      JSON.stringify(checkout),
    );
  if (
    online !== undefined &&
    readBuyerSessionOwner(database, merchantId, {
      kind: "checkout",
      id: checkout.checkoutId,
    }) !== online.buyerSessionDigest
  ) {
    throw new Error("Checkout buyer session ownership did not persist");
  }
}

function readBuyerSessionOwner(
  database: CommerceDatabase,
  merchantId: string,
  resource: Readonly<{ kind: "cart" | "checkout"; id: string }>,
): string | undefined {
  const query =
    resource.kind === "cart"
      ? `SELECT buyer_session_digest AS buyerSessionDigest
       FROM buyer_cart WHERE merchant_id = ? AND cart_id = ?`
      : `SELECT buyer_session_digest AS buyerSessionDigest
       FROM buyer_checkout WHERE merchant_id = ? AND checkout_id = ?`;
  return database
    .prepare(query)
    .get<Readonly<{ buyerSessionDigest: string }>>(merchantId, resource.id)
    ?.buyerSessionDigest;
}

export function readCheckout(
  database: CommerceDatabase,
  merchantId: string,
  checkoutId: string,
): Checkout | undefined {
  // The columns are the authority for the fields they mirror, and each channel
  // restores only its own. A point-of-sale row has no buyer session and no
  // checkout profile; writing those NULLs into the JSON would produce a source
  // the parser must reject.
  return readStoredJson(
    database,
    `SELECT CASE WHEN source_kind = 'online' THEN json_set(
       checkout_json,
       '$.source.buyerSessionDigest',
       buyer_session_digest,
       '$.source.checkoutProfile.checkoutProfileId',
       checkout_profile_id,
       '$.source.checkoutProfile.revision',
       checkout_profile_revision
     ) ELSE json_set(
       checkout_json,
       '$.source.posConfigurationRevision',
       pos_configuration_revision
     ) END AS storedJson FROM buyer_checkout
     WHERE merchant_id = ? AND checkout_id = ?`,
    [merchantId, checkoutId],
    parseCheckout,
  );
}

/** The merchant's checkouts, the most recently created first. */
export function listRecentCheckoutIds(
  database: CommerceDatabase,
  merchantId: string,
  limit: number,
): readonly string[] {
  return database
    .prepare(
      `SELECT checkout_id AS checkoutId FROM buyer_checkout
       WHERE merchant_id = ? ORDER BY rowid DESC LIMIT ?`,
    )
    .all<Readonly<{ checkoutId: string }>>(merchantId, limit)
    .map((row) => row.checkoutId);
}

export function writeCheckoutPaymentAttempt(
  database: CommerceDatabase,
  merchantId: string,
  attempt: CheckoutPaymentAttempt,
): void {
  database
    .prepare(
      `INSERT INTO checkout_payment_attempt (
       merchant_id, payment_attempt_id, checkout_id, revision,
       checkout_revision, quote_digest, amount_minor, currency, payment_provider,
       provider_request_id, idempotency_key, lifecycle_state, payment_attempt_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, payment_attempt_id) DO UPDATE SET
       revision = excluded.revision,
       checkout_revision = excluded.checkout_revision,
       quote_digest = excluded.quote_digest,
       amount_minor = excluded.amount_minor,
       currency = excluded.currency,
       payment_provider = excluded.payment_provider,
       provider_request_id = excluded.provider_request_id,
       idempotency_key = excluded.idempotency_key,
       lifecycle_state = excluded.lifecycle_state,
       payment_attempt_json = excluded.payment_attempt_json`,
    )
    .run(
      merchantId,
      attempt.paymentAttemptId,
      attempt.binding.checkoutId,
      attempt.revision,
      attempt.binding.checkoutRevision,
      attempt.binding.quoteDigest,
      attempt.binding.amount.amountMinor,
      attempt.binding.amount.currency,
      attempt.binding.paymentBinding.provider,
      attempt.binding.providerRequestId,
      attempt.binding.idempotencyKey,
      attempt.lifecycle.state,
      JSON.stringify(attempt),
    );
}

export function readCheckoutPaymentAttempt(
  database: CommerceDatabase,
  merchantId: string,
  paymentAttemptId: string,
): CheckoutPaymentAttempt | undefined {
  return readStoredJson(
    database,
    `SELECT payment_attempt_json AS storedJson FROM checkout_payment_attempt
     WHERE merchant_id = ? AND payment_attempt_id = ?`,
    [merchantId, paymentAttemptId],
    parseCheckoutPaymentAttempt,
  );
}

export function readCheckoutPaymentAttemptForCheckout(
  database: CommerceDatabase,
  merchantId: string,
  checkoutId: string,
): CheckoutPaymentAttempt | undefined {
  const rows = database
    .prepare(
      `SELECT payment_attempt_json AS storedJson FROM checkout_payment_attempt
     WHERE merchant_id = ? AND checkout_id = ?`,
    )
    .all<StoredJsonRow>(merchantId, checkoutId);
  const row = rows.length === 1 ? rows[0] : undefined;
  return row === undefined
    ? undefined
    : parseCheckoutPaymentAttempt(parseJson(row.storedJson));
}

/**
 * How a commit changes one allocation: `open` writes a new allocation at
 * revision 1 in an initial state; any other value is the machine event that
 * moves the stored allocation to `allocation` (Refactor 15, refactor 7).
 */
export type InventoryAllocationWrite =
  "open" | CommerceMachineEvent<"inventory_allocation">;

/**
 * The one writer of `inventory_allocation`. A new allocation is inserted and
 * a second insert of the same ID fails. A move reads the stored allocation,
 * checks `event` through the allocation machine, and writes only over the
 * revision and the state that it read. A refused or stale move is a planner
 * bug, so it throws and the commit rolls back.
 */
export function writeInventoryAllocation(
  database: CommerceDatabase,
  merchantId: string,
  event: InventoryAllocationWrite,
  allocation: InventoryAllocation,
): void {
  if (event === "open") {
    if (
      allocation.revision !== 1 ||
      COMMERCE_MACHINES.inventory_allocation.states[allocation.lifecycle.state]
        .kind !== "initial"
    )
      throw new Error(
        "A new inventory allocation must open in an initial state",
      );
    insertInventoryAllocation(database, merchantId, allocation);
    return;
  }
  const stored = readInventoryAllocation(
    database,
    merchantId,
    allocation.allocationId,
  );
  if (stored === undefined)
    throw new Error("Inventory allocation does not exist");
  const move = commerceTransition(
    "inventory_allocation",
    stored.lifecycle,
    event,
  );
  if (!move.allowed || move.to !== allocation.lifecycle.state)
    throw new Error(
      `Inventory allocation cannot ${event} from ${stored.lifecycle.state}`,
    );
  const owner = allocationOwner(allocation.lifecycle);
  const updated = database
    .prepare(
      `UPDATE inventory_allocation
       SET revision = ?, lifecycle_state = ?, owner_kind = ?, owner_id = ?,
           owner_line_id = ?, allocation_json = ?
       WHERE merchant_id = ? AND allocation_id = ? AND revision = ?
         AND lifecycle_state = ?`,
    )
    .run(
      allocation.revision,
      allocation.lifecycle.state,
      owner.kind,
      owner.id,
      owner.lineId,
      JSON.stringify(allocation),
      merchantId,
      allocation.allocationId,
      stored.revision,
      stored.lifecycle.state,
    );
  if (updated.changes !== 1 || allocation.revision !== stored.revision + 1)
    throw new Error("Inventory allocation revision changed during commit");
}

/**
 * An order edit or exchange releases the allocations of the lines that it
 * changed and opens new ones for the lines that it added.
 */
export function orderChangeAllocationWrite(
  allocation: InventoryAllocation,
): "open" | "release" {
  if (allocation.lifecycle.state === "released") return "release";
  if (
    allocation.lifecycle.state === "allocated_to_order" &&
    allocation.revision === 1
  )
    return "open";
  throw new Error("An order change writes only new or released allocations");
}

function insertInventoryAllocation(
  database: CommerceDatabase,
  merchantId: string,
  allocation: InventoryAllocation,
): void {
  const position = database
    .prepare(
      `SELECT inventory_position_id AS inventoryPositionId
     FROM inventory_position
     WHERE merchant_id = ? AND inventory_item_id = ? AND location_id = ?`,
    )
    .get<InventoryPositionIdentityRow>(
      merchantId,
      allocation.inventoryItemId,
      allocation.locationId,
    );
  if (position === undefined) {
    throw new Error("Inventory allocation position does not exist");
  }
  const owner = allocationOwner(allocation.lifecycle);
  database
    .prepare(
      `INSERT INTO inventory_allocation (
       merchant_id, allocation_id, inventory_item_id, inventory_position_id,
       location_id, quantity_amount, quantity_scale, quantity_unit, revision,
       lifecycle_state, owner_kind, owner_id, owner_line_id, allocation_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      allocation.allocationId,
      allocation.inventoryItemId,
      position.inventoryPositionId,
      allocation.locationId,
      allocation.quantity.amount,
      allocation.quantity.scale,
      allocation.quantity.unit,
      allocation.revision,
      allocation.lifecycle.state,
      owner.kind,
      owner.id,
      owner.lineId,
      JSON.stringify(allocation),
    );
}

export function readInventoryAllocation(
  database: CommerceDatabase,
  merchantId: string,
  allocationId: string,
): InventoryAllocation | undefined {
  return readStoredJson(
    database,
    `SELECT allocation_json AS storedJson FROM inventory_allocation
     WHERE merchant_id = ? AND allocation_id = ?`,
    [merchantId, allocationId],
    parseInventoryAllocation,
  );
}

export function listInventoryAllocations(
  database: CommerceDatabase,
  merchantId: string,
): readonly InventoryAllocation[] {
  const rows = database
    .prepare(
      `SELECT allocation_json AS storedJson FROM inventory_allocation
     WHERE merchant_id = ? ORDER BY allocation_id`,
    )
    .all<StoredJsonRow>(merchantId);
  return rows.map((row) => parseInventoryAllocation(parseJson(row.storedJson)));
}

function readStoredJson<T>(
  database: CommerceDatabase,
  query: string,
  bindings: readonly string[],
  parser: (value: unknown) => T,
): T | undefined {
  const row = database.prepare(query).get<StoredJsonRow>(...bindings);
  return row === undefined ? undefined : parser(parseJson(row.storedJson));
}

function consumptionScope(kind: string, locationId: string | null): unknown {
  return kind === "location" ? { kind, locationId } : { kind };
}

function consumptionMode(
  plan: Readonly<{
    modeKind: string;
    directCommitOn: string | null;
    recipeId: string | null;
    recipeRevision: number | null;
  }>,
  requirements: readonly Readonly<{
    inventoryItemId: string;
    amount: number;
    scale: number;
    unit: string;
  }>[],
): unknown {
  switch (plan.modeKind) {
    case "untracked":
      return { kind: plan.modeKind };
    case "direct":
      return {
        kind: plan.modeKind,
        components: consumptionRequirements(requirements),
        commitOn: plan.directCommitOn,
      };
    case "prepared":
      return {
        kind: plan.modeKind,
        recipeId: plan.recipeId,
        recipeRevision: plan.recipeRevision,
      };
    default:
      throw new Error("Stored inventory consumption mode is unsupported");
  }
}

function consumptionRequirements(
  requirements: readonly Readonly<{
    inventoryItemId: string;
    amount: number;
    scale: number;
    unit: string;
  }>[],
): readonly unknown[] {
  const values: unknown[] = [];
  for (const requirement of requirements) {
    values.push({
      inventoryItemId: requirement.inventoryItemId,
      quantity: {
        amount: requirement.amount,
        scale: requirement.scale,
        unit: requirement.unit,
      },
    });
  }
  return values;
}

function cartLines(
  lines: readonly Readonly<{
    cartLineId: string;
    variantId: string;
    sourceJson: string;
    amount: number;
    scale: number;
    unit: string;
  }>[],
): readonly unknown[] {
  const values: unknown[] = [];
  for (const line of lines) {
    values.push({
      cartLineId: line.cartLineId,
      source: parseJson(line.sourceJson),
      quantity: { amount: line.amount, scale: line.scale, unit: line.unit },
    });
  }
  return values;
}

function allocationOwner(
  lifecycle: InventoryAllocation["lifecycle"],
): AllocationOwner {
  switch (lifecycle.state) {
    case "held":
      return allocationHeldOwner(lifecycle.demand);
    case "allocated_to_order":
      return {
        kind: "order",
        id: lifecycle.orderId,
        lineId: lifecycle.orderLineId,
      };
    case "committed":
    case "released":
    case "expired":
      return allocationTerminalOwner(lifecycle.demand);
    default:
      return assertNever(lifecycle, "Unhandled checkout persistence branch");
  }
}

function allocationHeldOwner(
  demand: VariantBy<
    InventoryAllocation["lifecycle"],
    "state",
    "held"
  >["demand"],
): AllocationOwner {
  return {
    kind: demand.kind,
    id: demand.checkoutId,
    lineId: demand.checkoutLineId,
  };
}

function allocationTerminalOwner(
  demand:
    | VariantBy<
        InventoryAllocation["lifecycle"],
        "state",
        "committed"
      >["demand"]
    | VariantBy<
        InventoryAllocation["lifecycle"],
        "state",
        "released"
      >["demand"],
): AllocationOwner {
  switch (demand.kind) {
    case "checkout":
      return {
        kind: demand.kind,
        id: demand.checkoutId,
        lineId: demand.checkoutLineId,
      };
    case "order":
      return {
        kind: demand.kind,
        id: demand.orderId,
        lineId: demand.orderLineId,
      };
    default:
      return assertNever(demand, "Unhandled checkout persistence branch");
  }
}

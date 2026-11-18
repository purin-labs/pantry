import {
  parseCreateDiscountCommand,
  parseDeactivateDiscountCommand,
  parseDiscount,
  type CommerceDiscountCommandV1,
  type CommerceDiscountV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";

import { commerceTransition } from "@seams/commerce-contracts";

import type { CommerceDatabase } from "../../database.ts";

export type DiscountMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

export type DiscountCommitRequest = Readonly<{
  command: CommerceDiscountCommandV1;
  merchant: DiscountMerchantRow;
  discountId: string;
  revision: number;
  write: () => void;
}>;

export type DiscountAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  readMerchant: (merchantId: string) => DiscountMerchantRow | undefined;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command: CommerceDiscountCommandV1,
  ) => CommerceMutationResultV1 | undefined;
  validateMerchant: (
    merchantId: string,
    merchant: DiscountMerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
  commit: (request: DiscountCommitRequest) => CommerceMutationResultV1;
}>;

/** What a checkout asks of the discounts: its codes and its buyer. */
export type CheckoutDiscountRequest = Readonly<{
  codes: readonly string[];
  /** The buyer's customer, when known; one-use discounts need it. */
  customerId: string | null;
  /**
   * Code discounts that a refreshed checkout already holds. The buyer does
   * not enter the code again; one that no longer applies drops from the
   * new quote instead of refusing it.
   */
  keptDiscountIds?: readonly string[];
}>;

export type DiscountHold = Readonly<{ discountId: string; amountMinor: number }>;

export type DiscountEvaluation =
  | Readonly<{
      kind: "applied";
      /** The discount on each line, in the order of the lines given. */
      lineDiscounts: readonly number[];
      holds: readonly DiscountHold[];
    }>
  | Readonly<{ kind: "rejected"; field: string }>;

export class DiscountAuthority {
  readonly #options: DiscountAuthorityOptions;

  constructor(options: DiscountAuthorityOptions) {
    this.#options = options;
  }

  createDiscount(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseCreateDiscountCommand, (command) => {
      const { database } = this.#options;
      if (readDiscount(database, command.merchantId, command.discountId) !== undefined)
        return {
          code: "resource_already_exists",
          kind: "discount",
          id: command.discountId,
        };
      const codes = command.method.kind === "code" ? command.method.codes : [];
      for (const code of codes)
        if (discountIdForCode(database, command.merchantId, code) !== undefined)
          return invalid("discount.code.taken");
      const discount: CommerceDiscountV1 = {
        id: command.discountId,
        revision: 1,
        title: command.title,
        method: command.method,
        rule: command.rule,
        conditions: command.conditions,
        status: "active",
        redeemed: 0,
        occurredAt: command.requestedAt,
      };
      return {
        discountId: discount.id,
        revision: 1,
        write: () => {
          database
            .prepare(
              `INSERT INTO discount (
                 merchant_id, discount_id, revision, status, method_kind,
                 discount_json, occurred_at
               ) VALUES (?, ?, 1, 'active', ?, ?, ?)`,
            )
            .run(
              command.merchantId,
              discount.id,
              discount.method.kind,
              JSON.stringify(discount),
              discount.occurredAt,
            );
          for (const code of codes)
            database
              .prepare(
                "INSERT INTO discount_code (merchant_id, code, discount_id) VALUES (?, ?, ?)",
              )
              .run(command.merchantId, code, discount.id);
        },
      };
    });
  }

  deactivateDiscount(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseDeactivateDiscountCommand, (command) => {
      const current = readDiscount(
        this.#options.database,
        command.merchantId,
        command.discountId,
      );
      if (current === undefined)
        return { code: "resource_not_found", kind: "discount", id: command.discountId };
      if (current.revision !== command.expectedRevision)
        return {
          code: "stale_resource_revision",
          kind: "discount",
          id: current.id,
          expected: command.expectedRevision,
          actual: current.revision,
        };
      const deactivate = commerceTransition(
        "discount",
        { state: current.status },
        "deactivate",
      );
      if (!deactivate.allowed) return deactivate.refusal;
      const next: CommerceDiscountV1 = {
        ...current,
        revision: current.revision + 1,
        status: deactivate.to,
        occurredAt: command.requestedAt,
      };
      return {
        discountId: next.id,
        revision: next.revision,
        write: () =>
          this.#options.database
            .prepare(
              `UPDATE discount SET revision = ?, status = 'inactive',
                 discount_json = ?, occurred_at = ?
               WHERE merchant_id = ? AND discount_id = ? AND revision = ?`,
            )
            .run(
              next.revision,
              JSON.stringify(next),
              next.occurredAt,
              command.merchantId,
              next.id,
              current.revision,
            ),
      };
    });
  }

  listDiscounts(merchantId: string): readonly CommerceDiscountV1[] {
    return this.#options.database
      .prepare(
        "SELECT discount_id AS id FROM discount WHERE merchant_id = ? ORDER BY discount_id",
      )
      .all<Readonly<{ id: string }>>(merchantId)
      .flatMap((row) => {
        const discount = readDiscount(this.#options.database, merchantId, row.id);
        return discount === undefined ? [] : [discount];
      });
  }

  #run<TCommand extends CommerceDiscountCommandV1>(
    rawCommand: unknown,
    parse: (value: unknown) => TCommand,
    plan: (
      command: TCommand,
    ) => Omit<DiscountCommitRequest, "command" | "merchant"> | CommerceMutationErrorV1,
  ): CommerceMutationResultV1 {
    let command: TCommand;
    try {
      command = parse(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined) return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    const planned = plan(command);
    if ("code" in planned) return this.#options.rejected(planned);
    return this.#options.commit({ command, merchant, ...planned });
  }
}

/**
 * The one discount evaluator for checkout quotes. Product discounts come
 * first, then order discounts on what is left. Each discount is spread over
 * its lines in proportion to their amounts; the units left by rounding go to
 * the lines with the largest remainders, then to the earlier line, so the
 * same cart always gives the same result.
 */
export function evaluateCheckoutDiscounts(
  database: CommerceDatabase,
  merchantId: string,
  input: Readonly<{
    checkoutId: string;
    request: CheckoutDiscountRequest;
    at: string;
    currency: string;
    lines: readonly Readonly<{ productId: string | null; amountMinor: number }>[];
  }>,
): DiscountEvaluation {
  const codeDiscounts: string[] = [];
  for (const code of input.request.codes) {
    const discountId = discountIdForCode(database, merchantId, code);
    if (discountId === undefined) return { kind: "rejected", field: "discount.code.unknown" };
    if (!codeDiscounts.includes(discountId)) codeDiscounts.push(discountId);
  }
  const automatic = database
    .prepare(
      `SELECT discount_id AS id FROM discount
       WHERE merchant_id = ? AND method_kind = 'automatic' AND status = 'active'
       ORDER BY discount_id`,
    )
    .all<Readonly<{ id: string }>>(merchantId)
    .map((row) => row.id);
  const gross = input.lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const kept = (input.request.keptDiscountIds ?? []).filter(
    (discountId) => !codeDiscounts.includes(discountId),
  );
  const candidates: CommerceDiscountV1[] = [];
  for (const discountId of [...codeDiscounts, ...kept, ...automatic]) {
    const discount = readDiscount(database, merchantId, discountId);
    if (discount === undefined) continue;
    const refusal = refusalOf(database, merchantId, discount, input, gross);
    if (refusal !== undefined) {
      if (codeDiscounts.includes(discountId)) return { kind: "rejected", field: refusal };
      continue;
    }
    candidates.push(discount);
  }
  // Product discounts, then order discounts; in each group, by identifier.
  candidates.sort(
    (left, right) =>
      ruleOrder(left) - ruleOrder(right) || (left.id < right.id ? -1 : 1),
  );
  const net = input.lines.map((line) => line.amountMinor);
  const lineDiscounts = input.lines.map(() => 0);
  const holds: DiscountHold[] = [];
  for (const discount of candidates) {
    const eligible = input.lines.map((line, index) =>
      discount.rule.kind === "amount_off_order" ||
      (line.productId !== null && discount.rule.productIds.includes(line.productId))
        ? index
        : -1,
    ).filter((index) => index >= 0 && (net[index] ?? 0) > 0);
    const base = eligible.reduce((sum, index) => sum + (net[index] ?? 0), 0);
    if (base === 0) continue;
    const value = discount.rule.value;
    const amount = Math.min(
      base,
      value.kind === "percentage"
        ? Math.floor((base * value.basisPoints + 5_000) / 10_000)
        : value.amount.amountMinor,
    );
    if (amount === 0) continue;
    const shares = spread(
      amount,
      eligible.map((index) => net[index] ?? 0),
    );
    eligible.forEach((index, position) => {
      const share = shares[position] ?? 0;
      net[index] = (net[index] ?? 0) - share;
      lineDiscounts[index] = (lineDiscounts[index] ?? 0) + share;
    });
    holds.push({ discountId: discount.id, amountMinor: amount });
  }
  return { kind: "applied", lineDiscounts, holds };
}

/** How many discounts are active, and how many checkouts hold their uses. */
export function discountActivity(
  database: CommerceDatabase,
  merchantId: string,
): Readonly<{ discounts: number; heldCheckouts: number }> {
  const discounts =
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM discount
         WHERE merchant_id = ? AND status = 'active'`,
      )
      .get<Readonly<{ count: number }>>(merchantId)?.count ?? 0;
  const heldCheckouts =
    database
      .prepare(
        `SELECT COUNT(DISTINCT checkout_id) AS count FROM discount_redemption
         WHERE merchant_id = ? AND state = 'held'`,
      )
      .get<Readonly<{ count: number }>>(merchantId)?.count ?? 0;
  return { discounts, heldCheckouts };
}

/** Records the uses a new checkout holds, in its transaction. */
export function holdDiscounts(
  database: CommerceDatabase,
  merchantId: string,
  checkoutId: string,
  customerId: string | null,
  holds: readonly DiscountHold[],
  expiresAt: string,
  at: string,
): void {
  // A refreshed checkout replaces what it held before.
  database
    .prepare(
      `DELETE FROM discount_redemption
       WHERE merchant_id = ? AND checkout_id = ? AND state = 'held'`,
    )
    .run(merchantId, checkoutId);
  for (const hold of holds)
    database
      .prepare(
        `INSERT OR REPLACE INTO discount_redemption (
           merchant_id, discount_id, checkout_id, order_id, customer_id, state,
           amount_minor, expires_at, created_at
         ) VALUES (?, ?, ?, NULL, ?, 'held', ?, ?, ?)`,
      )
      .run(
        merchantId,
        hold.discountId,
        checkoutId,
        customerId,
        hold.amountMinor,
        expiresAt,
        at,
      );
}

/** The code discounts a checkout holds, and the buyer they were held for. */
export function heldCodeDiscounts(
  database: CommerceDatabase,
  merchantId: string,
  checkoutId: string,
): Readonly<{ discountIds: readonly string[]; customerId: string | null }> {
  const rows = database
    .prepare(
      `SELECT r.discount_id AS discountId, r.customer_id AS customerId
       FROM discount_redemption r
       JOIN discount d ON d.merchant_id = r.merchant_id AND d.discount_id = r.discount_id
       WHERE r.merchant_id = ? AND r.checkout_id = ? AND r.state = 'held'
         AND d.method_kind = 'code'
       ORDER BY r.discount_id`,
    )
    .all<Readonly<{ discountId: string; customerId: string | null }>>(
      merchantId,
      checkoutId,
    );
  return {
    discountIds: rows.map((row) => row.discountId),
    customerId: rows.find((row) => row.customerId !== null)?.customerId ?? null,
  };
}

/** At placement: the held uses count, and they belong to the buyer. */
export function redeemDiscounts(
  database: CommerceDatabase,
  merchantId: string,
  checkoutId: string,
  orderId: string,
  customerId: string | null,
): void {
  database
    .prepare(
      `UPDATE discount_redemption
       SET state = 'redeemed', order_id = ?, customer_id = COALESCE(customer_id, ?)
       WHERE merchant_id = ? AND checkout_id = ? AND state = 'held'`,
    )
    .run(orderId, customerId, merchantId, checkoutId);
}

function refusalOf(
  database: CommerceDatabase,
  merchantId: string,
  discount: CommerceDiscountV1,
  input: Readonly<{
    checkoutId: string;
    request: CheckoutDiscountRequest;
    at: string;
    currency: string;
  }>,
  gross: number,
): string | undefined {
  const { conditions } = discount;
  const at = Date.parse(input.at);
  // A buyer learns only that the code does not apply, not that it is off.
  if (
    !commerceTransition("discount", { state: discount.status }, "apply")
      .allowed ||
    Date.parse(conditions.startsAt) > at ||
    (conditions.endsAt !== null && Date.parse(conditions.endsAt) <= at)
  )
    return "discount.code.unavailable";
  if (
    (discount.rule.value.kind === "fixed_amount" &&
      discount.rule.value.amount.currency !== input.currency) ||
    (conditions.minimumSubtotal !== null &&
      (conditions.minimumSubtotal.currency !== input.currency ||
        gross < conditions.minimumSubtotal.amountMinor))
  )
    return "discount.code.conditions";
  // Uses count when redeemed, or held by another checkout that can still pay.
  const uses = database
    .prepare(
      `SELECT r.customer_id AS customerId FROM discount_redemption r
       LEFT JOIN buyer_checkout c
         ON c.merchant_id = r.merchant_id AND c.checkout_id = r.checkout_id
       WHERE r.merchant_id = ? AND r.discount_id = ? AND r.checkout_id != ?
         AND (r.state = 'redeemed' OR c.lifecycle_state = 'payment_pending'
           OR (c.lifecycle_state = 'quoted' AND r.expires_at > ?))`,
    )
    .all<Readonly<{ customerId: string | null }>>(
      merchantId,
      discount.id,
      input.checkoutId,
      input.at,
    );
  if (conditions.usageLimit !== null && uses.length >= conditions.usageLimit)
    return "discount.code.exhausted";
  if (
    conditions.oncePerCustomer &&
    input.request.customerId !== null &&
    uses.some((use) => use.customerId === input.request.customerId)
  )
    return "discount.code.used";
  return undefined;
}

function spread(amount: number, weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const shares = weights.map((weight) => Math.floor((amount * weight) / total));
  let left = amount - shares.reduce((sum, share) => sum + share, 0);
  const order = weights
    .map((weight, index) => ({ index, remainder: (amount * weight) % total }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (left === 0) break;
    shares[index] = (shares[index] ?? 0) + 1;
    left -= 1;
  }
  return shares;
}

function ruleOrder(discount: CommerceDiscountV1): number {
  return discount.rule.kind === "amount_off_products" ? 0 : 1;
}

function readDiscount(
  database: CommerceDatabase,
  merchantId: string,
  discountId: string,
): CommerceDiscountV1 | undefined {
  const row = database
    .prepare(
      "SELECT discount_json AS json FROM discount WHERE merchant_id = ? AND discount_id = ?",
    )
    .get<Readonly<{ json: string }>>(merchantId, discountId);
  if (row === undefined) return undefined;
  const redeemed =
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM discount_redemption
         WHERE merchant_id = ? AND discount_id = ? AND state = 'redeemed'`,
      )
      .get<Readonly<{ count: number }>>(merchantId, discountId)?.count ?? 0;
  return parseDiscount({ ...JSON.parse(row.json), redeemed });
}

function discountIdForCode(
  database: CommerceDatabase,
  merchantId: string,
  code: string,
): string | undefined {
  return database
    .prepare(
      "SELECT discount_id AS id FROM discount_code WHERE merchant_id = ? AND code = ?",
    )
    .get<Readonly<{ id: string }>>(merchantId, code)?.id;
}

function invalid(field: string): CommerceMutationErrorV1 {
  return { code: "resource_relationship_invalid", field };
}

/** Whether a discount's rule names this product. */
export function discountCitesProduct(
  database: CommerceDatabase,
  merchantId: string,
  productId: string,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 FROM discount
         WHERE merchant_id = ? AND instr(discount_json, ?) > 0 LIMIT 1`,
      )
      .get(merchantId, productId) !== undefined
  );
}

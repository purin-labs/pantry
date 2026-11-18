// Gift cards and store credit (Plan 76 phase 8). An account's balance is the
// sum of its entries: credits and refunds add, a checkout's hold and an
// order's redemption take away. A checkout holds what it will take when it is
// quoted; the placed order turns each hold into a redemption with its own
// payment, and an expired checkout deletes its holds. Every change happens in
// the merchant object's one writer, so a balance never goes below zero.
import {
  parseCreditStoreCreditCommand,
  parseDisableStoredValueAccountCommand,
  parseIssueGiftCardCommand,
  type CommerceGiftCardBalanceV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
  type CommerceStoredValueAccountV1,
  type CommerceStoredValueCommandV1,
  type CommerceStoredValueLiabilityV1,
} from "@seams/commerce-client";
import {
  commerceTransition,
  type CheckoutStoredValueTender,
} from "@seams/commerce-contracts";

import type { CommerceDatabase } from "../../database.ts";
import { customerIsActive } from "../customers/index.ts";
import { sha256 } from "../../commerce-authority/checkout-shared.ts";

type Money = Readonly<{ amountMinor: number; currency: string }>;

export type StoredValueMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

export type StoredValueCommitRequest = Readonly<{
  command: CommerceStoredValueCommandV1;
  merchant: StoredValueMerchantRow;
  accountId: string;
  revision: number;
  write: () => void;
}>;

type StoredValueAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  readMerchant: (merchantId: string) => StoredValueMerchantRow | undefined;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command: CommerceStoredValueCommandV1,
  ) => CommerceMutationResultV1 | undefined;
  validateMerchant: (
    merchantId: string,
    merchant: StoredValueMerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
  commit: (request: StoredValueCommitRequest) => CommerceMutationResultV1;
}>;

type AccountRow = Readonly<{
  accountId: string;
  revision: number;
  kind: "gift_card" | "store_credit";
  lastCharacters: string | null;
  customerId: string | null;
  currency: string;
  status: "active" | "disabled";
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
  occurredAt: string;
}>;

const ACCOUNT_COLUMNS = `account_id AS accountId, revision, kind,
  last_characters AS lastCharacters, customer_id AS customerId, currency,
  status, expires_at AS expiresAt, note, created_at AS createdAt,
  occurred_at AS occurredAt`;

export class StoredValueAuthority {
  readonly #options: StoredValueAuthorityOptions;

  constructor(options: StoredValueAuthorityOptions) {
    this.#options = options;
  }

  issueGiftCard(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseIssueGiftCardCommand, (command) => {
      const { database } = this.#options;
      if (
        readAccount(database, command.merchantId, command.accountId) !==
        undefined
      )
        return {
          code: "resource_already_exists",
          kind: "stored_value_account",
          id: command.accountId,
        };
      const digest = giftCardCodeDigest(command.merchantId, command.code);
      if (accountIdForCode(database, command.merchantId, digest) !== undefined)
        return invalid("giftCard.code.taken");
      if (
        command.expiresAt !== null &&
        command.expiresAt <= command.requestedAt
      )
        return invalid("giftCard.expiresAt");
      return {
        accountId: command.accountId,
        revision: 1,
        write: () => {
          insertAccount(database, command.merchantId, {
            accountId: command.accountId,
            kind: "gift_card",
            codeDigest: digest,
            lastCharacters: command.code.slice(-4),
            customerId: null,
            currency: command.amount.currency,
            expiresAt: command.expiresAt,
            note: command.note,
            at: command.requestedAt,
          });
          insertEntry(database, command.merchantId, command.accountId, {
            entryId: `issue_${command.idempotencyKey}`,
            kind: "credit",
            amountMinor: command.amount.amountMinor,
            at: command.requestedAt,
          });
        },
      };
    });
  }

  creditStoreCredit(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseCreditStoreCreditCommand, (command) => {
      const { database } = this.#options;
      if (!customerIsActive(database, command.merchantId, command.customerId))
        return {
          code: "resource_not_found",
          kind: "customer",
          id: command.customerId,
        };
      const accountId = storeCreditAccountId(
        command.customerId,
        command.amount.currency,
      );
      const current = readAccount(database, command.merchantId, accountId);
      if (current !== undefined) {
        const credit = commerceTransition(
          "stored_value_account",
          { state: current.status },
          "credit",
        );
        if (!credit.allowed) return credit.refusal;
      }
      return {
        accountId,
        revision: (current?.revision ?? 0) + 1,
        write: () => {
          if (current === undefined)
            insertAccount(database, command.merchantId, {
              accountId,
              kind: "store_credit",
              codeDigest: null,
              lastCharacters: null,
              customerId: command.customerId,
              currency: command.amount.currency,
              expiresAt: null,
              note: command.note,
              at: command.requestedAt,
            });
          else
            touchAccount(
              database,
              command.merchantId,
              current,
              command.requestedAt,
            );
          insertEntry(database, command.merchantId, accountId, {
            entryId: `credit_${command.idempotencyKey}`,
            kind: "credit",
            amountMinor: command.amount.amountMinor,
            at: command.requestedAt,
          });
        },
      };
    });
  }

  disableAccount(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(
      rawCommand,
      parseDisableStoredValueAccountCommand,
      (command) => {
        const { database } = this.#options;
        const current = readAccount(
          database,
          command.merchantId,
          command.accountId,
        );
        if (current === undefined)
          return {
            code: "resource_not_found",
            kind: "stored_value_account",
            id: command.accountId,
          };
        if (current.revision !== command.expectedRevision)
          return {
            code: "stale_resource_revision",
            kind: "stored_value_account",
            id: current.accountId,
            expected: command.expectedRevision,
            actual: current.revision,
          };
        const disable = commerceTransition(
          "stored_value_account",
          { state: current.status },
          "disable",
        );
        if (!disable.allowed) return disable.refusal;
        return {
          accountId: current.accountId,
          revision: current.revision + 1,
          write: () =>
            database
              .prepare(
                `UPDATE stored_value_account
               SET revision = revision + 1, status = 'disabled', occurred_at = ?
               WHERE merchant_id = ? AND account_id = ? AND revision = ?`,
              )
              .run(
                command.requestedAt,
                command.merchantId,
                current.accountId,
                current.revision,
              ),
        };
      },
    );
  }

  listAccounts(merchantId: string): readonly CommerceStoredValueAccountV1[] {
    return this.#options.database
      .prepare(
        `SELECT ${ACCOUNT_COLUMNS} FROM stored_value_account
         WHERE merchant_id = ? ORDER BY created_at, account_id`,
      )
      .all<AccountRow>(merchantId)
      .map((row) => accountView(this.#options.database, merchantId, row));
  }

  /**
   * The balance a buyer sees for a gift card code, or undefined when no
   * card has that code.
   */
  giftCardBalance(
    merchantId: string,
    code: string,
    at: string,
  ): CommerceGiftCardBalanceV1 | undefined {
    const { database } = this.#options;
    const accountId = accountIdForCode(
      database,
      merchantId,
      giftCardCodeDigest(merchantId, code),
    );
    const account =
      accountId === undefined
        ? undefined
        : readAccount(database, merchantId, accountId);
    if (account === undefined || account.lastCharacters === null)
      return undefined;
    return {
      schemaVersion: "underclerk.gift-card-balance.v1",
      lastCharacters: account.lastCharacters,
      balance: {
        amountMinor: accountBalance(database, merchantId, account.accountId),
        currency: account.currency,
      },
      status:
        account.status === "disabled"
          ? "disabled"
          : account.expiresAt !== null && account.expiresAt <= at
            ? "expired"
            : "active",
      expiresAt: account.expiresAt,
    };
  }

  /**
   * Unused balances at one moment: every entry made by then except holds,
   * which are still unused value. A gift card that expired by then counts
   * nothing.
   */
  liability(merchantId: string, at: string): CommerceStoredValueLiabilityV1 {
    const rows = this.#options.database
      .prepare(
        `SELECT a.currency AS currency, a.kind AS kind,
                COALESCE(SUM(e.amount_minor), 0) AS amountMinor,
                COUNT(DISTINCT a.account_id) AS accounts
         FROM stored_value_account a
         JOIN stored_value_entry e
           ON e.merchant_id = a.merchant_id AND e.account_id = a.account_id
         WHERE a.merchant_id = ? AND a.created_at <= ?
           AND (a.expires_at IS NULL OR a.expires_at > ?)
           AND e.kind <> 'hold' AND e.created_at <= ?
         GROUP BY a.currency, a.kind
         ORDER BY a.currency, a.kind`,
      )
      .all<
        Readonly<{
          currency: string;
          kind: "gift_card" | "store_credit";
          amountMinor: number;
          accounts: number;
        }>
      >(merchantId, at, at, at);
    const currencies = new Map<
      string,
      { giftCards: number; storeCredit: number; accounts: number }
    >();
    for (const row of rows) {
      const entry = currencies.get(row.currency) ?? {
        giftCards: 0,
        storeCredit: 0,
        accounts: 0,
      };
      if (row.kind === "gift_card") entry.giftCards += row.amountMinor;
      else entry.storeCredit += row.amountMinor;
      entry.accounts += row.accounts;
      currencies.set(row.currency, entry);
    }
    return {
      schemaVersion: "underclerk.stored-value-liability.v1",
      at,
      currencies: [...currencies].map(([currency, entry]) => ({
        currency,
        giftCards: { amountMinor: entry.giftCards, currency },
        storeCredit: { amountMinor: entry.storeCredit, currency },
        accounts: entry.accounts,
      })),
    };
  }

  #run<TCommand extends CommerceStoredValueCommandV1>(
    rawCommand: unknown,
    parse: (value: unknown) => TCommand,
    plan: (
      command: TCommand,
    ) =>
      | Omit<StoredValueCommitRequest, "command" | "merchant">
      | CommerceMutationErrorV1,
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
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
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

/** What a checkout asks of stored value. */
export type CheckoutStoredValueRequest = Readonly<{
  giftCardCodes: readonly string[];
  /** The buyer's customer; store credit needs one. */
  customerId: string | null;
  storeCredit: boolean;
  /**
   * Accounts that a refreshed checkout already holds. The buyer does not
   * enter the code again; one that no longer pays drops from the new quote
   * instead of refusing it.
   */
  keptAccountIds?: readonly string[];
}>;

type StoredValueEvaluation =
  | Readonly<{ kind: "applied"; tenders: readonly CheckoutStoredValueTender[] }>
  | Readonly<{ kind: "rejected"; field: string }>;

/**
 * The tenders that pay a checkout total: entered gift cards in order, then
 * kept accounts, then store credit, each paying what it can of what is left.
 * The checkout's own earlier holds do not count against the balances.
 */
export function evaluateCheckoutStoredValue(
  database: CommerceDatabase,
  merchantId: string,
  input: Readonly<{
    checkoutId: string;
    request: CheckoutStoredValueRequest;
    at: string;
    total: Money;
  }>,
): StoredValueEvaluation {
  const { request, at, total } = input;
  const tenders: CheckoutStoredValueTender[] = [];
  let left = total.amountMinor;
  const pay = (account: AccountRow) => {
    if (
      left === 0 ||
      tenders.some((tender) => tender.accountId === account.accountId)
    )
      return;
    const available = accountBalance(
      database,
      merchantId,
      account.accountId,
      input.checkoutId,
    );
    const amount = Math.min(available, left);
    if (amount <= 0) return;
    left -= amount;
    tenders.push({
      accountId: account.accountId,
      kind: account.kind,
      ...(account.lastCharacters === null
        ? {}
        : { lastCharacters: account.lastCharacters }),
      amount: { amountMinor: amount, currency: total.currency },
    });
  };
  // A buyer learns only that the card does not pay, not that it is off.
  const usable = (account: AccountRow | undefined): account is AccountRow =>
    account !== undefined &&
    commerceTransition(
      "stored_value_account",
      { state: account.status },
      "apply",
    ).allowed &&
    account.currency === total.currency &&
    (account.expiresAt === null || account.expiresAt > at);
  for (const code of request.giftCardCodes) {
    const accountId = accountIdForCode(
      database,
      merchantId,
      giftCardCodeDigest(merchantId, code),
    );
    const account =
      accountId === undefined
        ? undefined
        : readAccount(database, merchantId, accountId);
    if (!usable(account) || account.kind !== "gift_card")
      return { kind: "rejected", field: "checkout.storedValue.giftCard" };
    if (
      accountBalance(
        database,
        merchantId,
        account.accountId,
        input.checkoutId,
      ) <= 0
    )
      return {
        kind: "rejected",
        field: "checkout.storedValue.giftCard.balance",
      };
    pay(account);
  }
  for (const accountId of request.keptAccountIds ?? []) {
    const account = readAccount(database, merchantId, accountId);
    if (
      usable(account) &&
      (account.kind === "gift_card" ||
        account.customerId === request.customerId)
    )
      pay(account);
  }
  if (request.storeCredit) {
    if (request.customerId === null)
      return { kind: "rejected", field: "checkout.storedValue.storeCredit" };
    const account = readAccount(
      database,
      merchantId,
      storeCreditAccountId(request.customerId, total.currency),
    );
    if (usable(account)) pay(account);
  }
  return { kind: "applied", tenders };
}

/** Records the holds of a quoted checkout, in its transaction. */
export function holdStoredValue(
  database: CommerceDatabase,
  merchantId: string,
  checkoutId: string,
  tenders: readonly CheckoutStoredValueTender[],
  at: string,
): void {
  // A refreshed checkout replaces what it held before.
  releaseStoredValue(database, merchantId, checkoutId);
  for (const tender of tenders)
    insertEntry(database, merchantId, tender.accountId, {
      entryId: `hold_${checkoutId}`,
      kind: "hold",
      amountMinor: -tender.amount.amountMinor,
      checkoutId,
      at,
    });
}

/** Ends the holds of a checkout that expired or will be quoted again. */
export function releaseStoredValue(
  database: CommerceDatabase,
  merchantId: string,
  checkoutId: string,
): void {
  database
    .prepare(
      `DELETE FROM stored_value_entry
       WHERE merchant_id = ? AND checkout_id = ? AND kind = 'hold'`,
    )
    .run(merchantId, checkoutId);
}

/** The accounts a checkout holds, for a refresh that keeps them. */
export function heldStoredValueAccounts(
  database: CommerceDatabase,
  merchantId: string,
  checkoutId: string,
): readonly string[] {
  return database
    .prepare(
      `SELECT account_id AS accountId FROM stored_value_entry
       WHERE merchant_id = ? AND checkout_id = ? AND kind = 'hold'
       ORDER BY rowid`,
    )
    .all<Readonly<{ accountId: string }>>(merchantId, checkoutId)
    .map((row) => row.accountId);
}

/** The payment of an order that one stored-value tender makes. */
export function storedValuePaymentId(
  orderId: string,
  accountId: string,
): string {
  return `payment_stored_value_${sha256(`${orderId}:${accountId}`).slice(0, 24)}`;
}

/**
 * At placement: each hold becomes the redemption of its order's payment.
 * Refuses when a hold no longer matches the quote's tender.
 */
export function redeemStoredValue(
  database: CommerceDatabase,
  merchantId: string,
  checkoutId: string,
  orderId: string,
  tenders: readonly CheckoutStoredValueTender[],
): CommerceMutationErrorV1 | undefined {
  const holds = database
    .prepare(
      `SELECT account_id AS accountId, amount_minor AS amountMinor
       FROM stored_value_entry
       WHERE merchant_id = ? AND checkout_id = ? AND kind = 'hold'`,
    )
    .all<Readonly<{ accountId: string; amountMinor: number }>>(
      merchantId,
      checkoutId,
    );
  if (
    holds.length !== tenders.length ||
    tenders.some(
      (tender) =>
        !holds.some(
          (hold) =>
            hold.accountId === tender.accountId &&
            hold.amountMinor === -tender.amount.amountMinor,
        ),
    )
  )
    return invalid("checkout.storedValue.hold");
  for (const tender of tenders)
    database
      .prepare(
        `UPDATE stored_value_entry
         SET kind = 'redemption', order_id = ?, payment_id = ?
         WHERE merchant_id = ? AND account_id = ? AND checkout_id = ? AND kind = 'hold'`,
      )
      .run(
        orderId,
        storedValuePaymentId(orderId, tender.accountId),
        merchantId,
        tender.accountId,
        checkoutId,
      );
  return undefined;
}

/** The account that a stored-value payment redeemed, if it is one. */
/** How many checkouts hold stored value now. */
export function storedValueHeldCheckouts(
  database: CommerceDatabase,
  merchantId: string,
): number {
  return (
    database
      .prepare(
        `SELECT COUNT(DISTINCT checkout_id) AS count FROM stored_value_entry
         WHERE merchant_id = ? AND kind = 'hold'`,
      )
      .get<Readonly<{ count: number }>>(merchantId)?.count ?? 0
  );
}

export function storedValueRedemption(
  database: CommerceDatabase,
  merchantId: string,
  paymentId: string,
):
  | Readonly<{ accountId: string; amountMinor: number; orderId: string }>
  | undefined {
  return database
    .prepare(
      `SELECT account_id AS accountId, -amount_minor AS amountMinor,
              order_id AS orderId
       FROM stored_value_entry
       WHERE merchant_id = ? AND payment_id = ? AND kind = 'redemption'`,
    )
    .get<Readonly<{ accountId: string; amountMinor: number; orderId: string }>>(
      merchantId,
      paymentId,
    );
}

/**
 * Returns a refund to an account, in the refund's transaction: to the
 * stored-value payment's own account, or to a customer's store credit,
 * which it opens when the customer has none in that currency.
 */
export function creditStoredValueRefund(
  database: CommerceDatabase,
  merchantId: string,
  target:
    | Readonly<{ kind: "account"; accountId: string }>
    | Readonly<{ kind: "store_credit"; customerId: string; currency: string }>,
  refund: Readonly<{
    refundAttemptId: string;
    amountMinor: number;
    orderId: string;
    paymentId: string;
    at: string;
  }>,
): string {
  let accountId: string;
  if (target.kind === "account") accountId = target.accountId;
  else {
    accountId = storeCreditAccountId(target.customerId, target.currency);
    const current = readAccount(database, merchantId, accountId);
    if (current === undefined)
      insertAccount(database, merchantId, {
        accountId,
        kind: "store_credit",
        codeDigest: null,
        lastCharacters: null,
        customerId: target.customerId,
        currency: target.currency,
        expiresAt: null,
        note: null,
        at: refund.at,
      });
    else touchAccount(database, merchantId, current, refund.at);
  }
  insertEntry(database, merchantId, accountId, {
    entryId: `refund_${refund.refundAttemptId}`,
    kind: "refund",
    amountMinor: refund.amountMinor,
    orderId: refund.orderId,
    paymentId: refund.paymentId,
    refundAttemptId: refund.refundAttemptId,
    at: refund.at,
  });
  return accountId;
}

function storeCreditAccountId(customerId: string, currency: string): string {
  return `store_credit_${sha256(`${customerId}:${currency}`).slice(0, 24)}`;
}

function giftCardCodeDigest(merchantId: string, code: string): string {
  return sha256(`underclerk.gift-card-code.v1:${merchantId}:${code}`);
}

function accountIdForCode(
  database: CommerceDatabase,
  merchantId: string,
  digest: string,
): string | undefined {
  return database
    .prepare(
      `SELECT account_id AS accountId FROM stored_value_account
       WHERE merchant_id = ? AND code_digest = ?`,
    )
    .get<Readonly<{ accountId: string }>>(merchantId, digest)?.accountId;
}

function readAccount(
  database: CommerceDatabase,
  merchantId: string,
  accountId: string,
): AccountRow | undefined {
  return database
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM stored_value_account
       WHERE merchant_id = ? AND account_id = ?`,
    )
    .get<AccountRow>(merchantId, accountId);
}

function accountBalance(
  database: CommerceDatabase,
  merchantId: string,
  accountId: string,
  exceptCheckoutId?: string,
): number {
  return (
    database
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS balance FROM stored_value_entry
         WHERE merchant_id = ? AND account_id = ?
           AND NOT (kind = 'hold' AND checkout_id IS ?)`,
      )
      .get<Readonly<{ balance: number }>>(
        merchantId,
        accountId,
        exceptCheckoutId ?? null,
      )?.balance ?? 0
  );
}

function accountView(
  database: CommerceDatabase,
  merchantId: string,
  row: AccountRow,
): CommerceStoredValueAccountV1 {
  const credited =
    database
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS credited FROM stored_value_entry
         WHERE merchant_id = ? AND account_id = ? AND amount_minor > 0`,
      )
      .get<Readonly<{ credited: number }>>(merchantId, row.accountId)
      ?.credited ?? 0;
  return {
    id: row.accountId,
    revision: row.revision,
    kind: row.kind,
    lastCharacters: row.lastCharacters,
    customerId: row.customerId,
    balance: {
      amountMinor: accountBalance(database, merchantId, row.accountId),
      currency: row.currency,
    },
    credited: { amountMinor: credited, currency: row.currency },
    status: row.status,
    expiresAt: row.expiresAt,
    note: row.note,
    createdAt: row.createdAt,
    occurredAt: row.occurredAt,
  };
}

function insertAccount(
  database: CommerceDatabase,
  merchantId: string,
  account: Readonly<{
    accountId: string;
    kind: "gift_card" | "store_credit";
    codeDigest: string | null;
    lastCharacters: string | null;
    customerId: string | null;
    currency: string;
    expiresAt: string | null;
    note: string | null;
    at: string;
  }>,
): void {
  database
    .prepare(
      `INSERT INTO stored_value_account (
         merchant_id, account_id, revision, kind, code_digest, last_characters,
         customer_id, currency, status, expires_at, note, created_at, occurred_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      account.accountId,
      account.kind,
      account.codeDigest,
      account.lastCharacters,
      account.customerId,
      account.currency,
      account.expiresAt,
      account.note,
      account.at,
      account.at,
    );
}

// A credit to an existing account moves its revision, so a reader of the
// account's events sees each change.
function touchAccount(
  database: CommerceDatabase,
  merchantId: string,
  account: AccountRow,
  at: string,
): void {
  database
    .prepare(
      `UPDATE stored_value_account SET revision = revision + 1, occurred_at = ?
       WHERE merchant_id = ? AND account_id = ? AND revision = ?`,
    )
    .run(at, merchantId, account.accountId, account.revision);
}

function insertEntry(
  database: CommerceDatabase,
  merchantId: string,
  accountId: string,
  entry: Readonly<{
    entryId: string;
    kind: "credit" | "hold" | "redemption" | "refund";
    amountMinor: number;
    checkoutId?: string;
    orderId?: string;
    paymentId?: string;
    refundAttemptId?: string;
    at: string;
  }>,
): void {
  database
    .prepare(
      `INSERT INTO stored_value_entry (
         merchant_id, account_id, entry_id, kind, amount_minor, checkout_id,
         order_id, payment_id, refund_attempt_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      accountId,
      entry.entryId,
      entry.kind,
      entry.amountMinor,
      entry.checkoutId ?? null,
      entry.orderId ?? null,
      entry.paymentId ?? null,
      entry.refundAttemptId ?? null,
      entry.at,
    );
}

function invalid(field: string): CommerceMutationErrorV1 {
  return { code: "resource_relationship_invalid", field };
}

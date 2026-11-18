import type {
  PaymentDispute,
  PaymentDisputeLifecycle,
  RefundAttempt,
} from "@seams/commerce-contracts";
import {
  parsePaymentDispute,
  parseRefundAttempt,
} from "@seams/commerce-client";

import type { CommerceDatabase } from "../database.ts";
import { assertNever } from "@seams/std";

type RefundAttemptRow = Readonly<{
  commandDigest: string;
  attemptJson: string;
}>;

type PaymentDisputeRow = Readonly<{
  disputeId: string;
  orderId: string;
  paymentId: string;
  revision: number;
  providerDisputeReference: string;
  amountMinor: number;
  currency: string;
  lifecycleState: string;
  disputeJson: string;
}>;

export type PaymentDisputeLifecycleAdvanceValidation =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "terminal" }>
  | Readonly<{ kind: "timestamp_not_forward" }>;

export type StoredRefundAttempt = Readonly<{
  attempt: RefundAttempt;
  commandDigest: string;
}>;

export function reserveRefundAttempt(
  database: CommerceDatabase,
  merchantId: string,
  attempt: RefundAttempt,
  commandDigest: string,
): void {
  requireCommandDigest(commandDigest);
  if (attempt.revision !== 1 || attempt.lifecycle.state !== "requested") {
    throw new Error(
      "A refund reservation must be a revision-one requested attempt",
    );
  }
  database
    .prepare(
      `INSERT INTO refund_attempt (
       merchant_id, refund_attempt_id, order_id, payment_id, revision,
       idempotency_identity, command_digest, lifecycle_state, attempt_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      attempt.refundAttemptId,
      attempt.orderId,
      attempt.paymentId,
      attempt.revision,
      attempt.idempotencyIdentity,
      commandDigest,
      attempt.lifecycle.state,
      JSON.stringify(attempt),
    );
}

export function advanceRefundAttempt(
  database: CommerceDatabase,
  merchantId: string,
  expectedRevision: number,
  attempt: RefundAttempt,
): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
    throw new Error("Refund attempt expected revision must be positive");
  }
  if (attempt.revision !== expectedRevision + 1) {
    throw new Error("Refund attempt revision must advance exactly once");
  }
  const stored = readRefundAttempt(
    database,
    merchantId,
    attempt.refundAttemptId,
  );
  if (stored === undefined) throw new Error("Refund attempt does not exist");
  requireSameRefundIdentity(stored.attempt, attempt);
  const result = database
    .prepare(
      `UPDATE refund_attempt
     SET revision = ?, lifecycle_state = ?, attempt_json = ?
     WHERE merchant_id = ? AND refund_attempt_id = ? AND revision = ?`,
    )
    .run(
      attempt.revision,
      attempt.lifecycle.state,
      JSON.stringify(attempt),
      merchantId,
      attempt.refundAttemptId,
      expectedRevision,
    );
  if (result.changes !== 1) throw new Error("Refund attempt revision conflict");
}

/**
 * Keeps the command that reserved a refund attempt, as its caller sent it,
 * so that a pending refund can be read again with that same command.
 */
export function insertRefundCommand(
  database: CommerceDatabase,
  merchantId: string,
  refundAttemptId: string,
  command: unknown,
): void {
  database
    .prepare(
      `INSERT INTO refund_command (merchant_id, refund_attempt_id, command_json)
       VALUES (?, ?, ?)`,
    )
    .run(merchantId, refundAttemptId, JSON.stringify(command));
}

/** The command that reserved a refund attempt, as its caller sent it. */
export function readRefundCommand(
  database: CommerceDatabase,
  merchantId: string,
  refundAttemptId: string,
): unknown {
  const row = database
    .prepare(
      `SELECT command_json AS commandJson FROM refund_command
       WHERE merchant_id = ? AND refund_attempt_id = ?`,
    )
    .get<Readonly<{ commandJson: string }>>(merchantId, refundAttemptId);
  return row === undefined
    ? undefined
    : (JSON.parse(row.commandJson) as unknown);
}

export type PendingRefund = Readonly<{
  merchantId: string;
  refundAttemptId: string;
  reconcileAfter: string;
  command: unknown;
}>;

/** The refunds that wait on the payment provider, the earliest due first. */
export function listPendingRefunds(
  database: CommerceDatabase,
  limit: number,
): readonly PendingRefund[] {
  return database
    .prepare(
      `SELECT attempt.merchant_id AS merchantId,
              attempt.refund_attempt_id AS refundAttemptId,
              json_extract(attempt.attempt_json, '$.lifecycle.reconcileAfter')
                AS reconcileAfter,
              command.command_json AS commandJson
       FROM refund_attempt AS attempt
       JOIN refund_command AS command
         ON command.merchant_id = attempt.merchant_id
        AND command.refund_attempt_id = attempt.refund_attempt_id
       WHERE attempt.lifecycle_state IN ('processing', 'indeterminate')
       ORDER BY reconcileAfter, attempt.refund_attempt_id
       LIMIT ?`,
    )
    .all<
      Readonly<{
        merchantId: string;
        refundAttemptId: string;
        reconcileAfter: string;
        commandJson: string;
      }>
    >(limit)
    .map((row) => ({
      merchantId: row.merchantId,
      refundAttemptId: row.refundAttemptId,
      reconcileAfter: row.reconcileAfter,
      command: JSON.parse(row.commandJson) as unknown,
    }));
}

export function readRefundAttempt(
  database: CommerceDatabase,
  merchantId: string,
  refundAttemptId: string,
): StoredRefundAttempt | undefined {
  return readRefundAttemptRow(
    database
      .prepare(
        `SELECT command_digest AS commandDigest, attempt_json AS attemptJson
       FROM refund_attempt
       WHERE merchant_id = ? AND refund_attempt_id = ?`,
      )
      .get<RefundAttemptRow>(merchantId, refundAttemptId),
  );
}

export function listRefundAttemptsForOrder(
  database: CommerceDatabase,
  merchantId: string,
  orderId: string,
): readonly StoredRefundAttempt[] {
  const rows = database
    .prepare(
      `SELECT command_digest AS commandDigest, attempt_json AS attemptJson
     FROM refund_attempt
     WHERE merchant_id = ? AND order_id = ?
     ORDER BY refund_attempt_id`,
    )
    .all<RefundAttemptRow>(merchantId, orderId);
  return rows.map(readRequiredRefundAttemptRow);
}

export function reservePaymentDispute(
  database: CommerceDatabase,
  merchantId: string,
  dispute: PaymentDispute,
): void {
  if (dispute.revision !== 1) {
    throw new Error("A payment dispute reservation must be revision one");
  }
  database
    .prepare(
      `INSERT INTO payment_dispute (
       merchant_id, dispute_id, order_id, payment_id, revision,
       provider_dispute_reference, amount_minor, currency, lifecycle_state, dispute_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      merchantId,
      dispute.disputeId,
      dispute.orderId,
      dispute.paymentId,
      dispute.revision,
      dispute.providerDisputeReference,
      dispute.amount.amountMinor,
      dispute.amount.currency,
      dispute.lifecycle.state,
      JSON.stringify(dispute),
    );
}

export function advancePaymentDispute(
  database: CommerceDatabase,
  merchantId: string,
  expectedRevision: number,
  dispute: PaymentDispute,
): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
    throw new Error("Payment dispute expected revision must be positive");
  }
  if (dispute.revision !== expectedRevision + 1) {
    throw new Error("Payment dispute revision must advance exactly once");
  }
  const current = readPaymentDispute(database, merchantId, dispute.disputeId);
  if (current === undefined) throw new Error("Payment dispute does not exist");
  requireSamePaymentDisputeIdentity(current, dispute);
  const lifecycleValidation = validatePaymentDisputeLifecycleAdvance(
    current.lifecycle,
    dispute.lifecycle,
  );
  switch (lifecycleValidation.kind) {
    case "accepted":
      break;
    case "terminal":
      throw new Error("terminal payment dispute cannot change");
    case "timestamp_not_forward":
      throw new Error("payment dispute lifecycle timestamps must move forward");
    default:
      assertNever(lifecycleValidation, "Unsupported payment dispute lifecycle");
  }
  const result = database
    .prepare(
      `UPDATE payment_dispute
     SET revision = ?, lifecycle_state = ?, dispute_json = ?
     WHERE merchant_id = ? AND dispute_id = ? AND revision = ?`,
    )
    .run(
      dispute.revision,
      dispute.lifecycle.state,
      JSON.stringify(dispute),
      merchantId,
      dispute.disputeId,
      expectedRevision,
    );
  if (result.changes !== 1)
    throw new Error("Payment dispute revision conflict");
}

export function readPaymentDispute(
  database: CommerceDatabase,
  merchantId: string,
  disputeId: string,
): PaymentDispute | undefined {
  const row = database
    .prepare(
      `SELECT dispute_id AS disputeId, order_id AS orderId, payment_id AS paymentId,
            revision, provider_dispute_reference AS providerDisputeReference,
            amount_minor AS amountMinor, currency,
            lifecycle_state AS lifecycleState, dispute_json AS disputeJson
     FROM payment_dispute
     WHERE merchant_id = ? AND dispute_id = ?`,
    )
    .get<PaymentDisputeRow>(merchantId, disputeId);
  if (row === undefined) return undefined;
  return parsePaymentDisputeRow(row);
}

export function readPaymentDisputeByProviderReference(
  database: CommerceDatabase,
  merchantId: string,
  providerDisputeReference: string,
): PaymentDispute | undefined {
  const row = database
    .prepare(
      `SELECT dispute_id AS disputeId, order_id AS orderId, payment_id AS paymentId,
            revision, provider_dispute_reference AS providerDisputeReference,
            amount_minor AS amountMinor, currency,
            lifecycle_state AS lifecycleState, dispute_json AS disputeJson
     FROM payment_dispute
     WHERE merchant_id = ? AND provider_dispute_reference = ?`,
    )
    .get<PaymentDisputeRow>(merchantId, providerDisputeReference);
  if (row === undefined) return undefined;
  return parsePaymentDisputeRow(row);
}

export function listPaymentDisputesForOrder(
  database: CommerceDatabase,
  merchantId: string,
  orderId: string,
): readonly PaymentDispute[] {
  const rows = database
    .prepare(
      `SELECT dispute_id AS disputeId, order_id AS orderId, payment_id AS paymentId,
            revision, provider_dispute_reference AS providerDisputeReference,
            amount_minor AS amountMinor, currency,
            lifecycle_state AS lifecycleState, dispute_json AS disputeJson
     FROM payment_dispute
     WHERE merchant_id = ? AND order_id = ?
     ORDER BY dispute_id`,
    )
    .all<PaymentDisputeRow>(merchantId, orderId);
  const disputes: PaymentDispute[] = [];
  for (const row of rows) disputes.push(parsePaymentDisputeRow(row));
  return disputes;
}

function readRefundAttemptRow(
  row: RefundAttemptRow | undefined,
): StoredRefundAttempt | undefined {
  if (row === undefined) return undefined;
  requireCommandDigest(row.commandDigest);
  return {
    attempt: parseRefundAttempt(JSON.parse(row.attemptJson)),
    commandDigest: row.commandDigest,
  };
}

function readRequiredRefundAttemptRow(
  row: RefundAttemptRow,
): StoredRefundAttempt {
  const stored = readRefundAttemptRow(row);
  if (stored === undefined)
    throw new Error("Listed refund attempt disappeared during read");
  return stored;
}

function requireCommandDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("Refund attempt command digest must be lowercase SHA-256");
  }
}

function requireSameRefundIdentity(
  current: RefundAttempt,
  next: RefundAttempt,
): void {
  if (
    current.refundAttemptId !== next.refundAttemptId ||
    current.orderId !== next.orderId ||
    current.paymentId !== next.paymentId ||
    current.idempotencyIdentity !== next.idempotencyIdentity ||
    JSON.stringify(current.reason) !== JSON.stringify(next.reason) ||
    JSON.stringify(current.allocation) !== JSON.stringify(next.allocation)
  ) {
    throw new Error("Refund attempt identity and allocation are immutable");
  }
}

function parsePaymentDisputeRow(row: PaymentDisputeRow): PaymentDispute {
  const dispute = parsePaymentDispute(JSON.parse(row.disputeJson));
  if (
    dispute.disputeId !== row.disputeId ||
    dispute.orderId !== row.orderId ||
    dispute.paymentId !== row.paymentId ||
    dispute.revision !== row.revision ||
    dispute.providerDisputeReference !== row.providerDisputeReference ||
    dispute.amount.amountMinor !== row.amountMinor ||
    dispute.amount.currency !== row.currency ||
    dispute.lifecycle.state !== row.lifecycleState
  ) {
    throw new Error(
      "Stored PaymentDispute columns do not match its exact aggregate",
    );
  }
  return dispute;
}

function requireSamePaymentDisputeIdentity(
  current: PaymentDispute,
  next: PaymentDispute,
): void {
  if (
    current.disputeId !== next.disputeId ||
    current.orderId !== next.orderId ||
    current.paymentId !== next.paymentId ||
    current.providerDisputeReference !== next.providerDisputeReference ||
    current.amount.amountMinor !== next.amount.amountMinor ||
    current.amount.currency !== next.amount.currency ||
    current.reason !== next.reason ||
    JSON.stringify(current.evidenceReferences) !==
      JSON.stringify(next.evidenceReferences)
  ) {
    throw new Error("Payment dispute identity and evidence are immutable");
  }
}

export function validatePaymentDisputeLifecycleAdvance(
  current: PaymentDisputeLifecycle,
  next: PaymentDisputeLifecycle,
): PaymentDisputeLifecycleAdvanceValidation {
  if (current.state === "won" || current.state === "lost") {
    return { kind: "terminal" };
  }
  if (
    paymentDisputeTimestampNanoseconds(
      paymentDisputeLifecycleTimestamp(next),
    ) <=
    paymentDisputeTimestampNanoseconds(
      paymentDisputeLifecycleTimestamp(current),
    )
  ) {
    return { kind: "timestamp_not_forward" };
  }
  return { kind: "accepted" };
}

function paymentDisputeLifecycleTimestamp(
  lifecycle: PaymentDisputeLifecycle,
): string {
  switch (lifecycle.state) {
    case "action_required":
    case "under_review":
      return lifecycle.observedAt;
    case "won":
    case "lost":
      return lifecycle.resolvedAt;
    default:
      return assertNever(lifecycle, "Unsupported payment dispute lifecycle");
  }
}

function paymentDisputeTimestampNanoseconds(timestamp: string): bigint {
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(
      timestamp,
    );
  if (match === null)
    throw new Error("payment dispute lifecycle timestamp is invalid");
  const wholeSecond = timestamp.replace(
    /\.\d{1,9}(?=(?:Z|[+-]\d{2}:\d{2})$)/u,
    "",
  );
  const milliseconds = Date.parse(wholeSecond);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("payment dispute lifecycle timestamp is invalid");
  }
  return (
    BigInt(milliseconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"))
  );
}

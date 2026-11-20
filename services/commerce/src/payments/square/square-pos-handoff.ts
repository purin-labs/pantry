// The Square Point of Sale app takes a counter payment on the Register's iPad
// with a Square Reader (Plan 90 Phase 3B). The Register opens the app with a
// `square-commerce-v1://payment/create` link, and the app returns to the
// Register's callback page with a `data` JSON object.
// https://developer.squareup.com/docs/pos-api/web-technical-reference
//
// That answer comes through the browser, so it is a hint only. Commerce keeps
// the first answer for the attempt, then reads the order and the payment from
// Square: the order is the app's `transaction_id`, its one tender is the
// payment. The capture is recorded only for a completed payment of that order
// at the binding's location, for the exact amount, with no tip, made after the
// handoff started, with no reference id (an API payment, such as a Terminal
// checkout, carries one), and taken by no other handoff.
import { createHash } from "node:crypto";

import type {
  CommerceInPersonCollectionResultV1,
  CommercePaymentCaptureResultV1,
} from "@purin-labs/commerce-client";
import { isRecord } from "@purin-labs/std";

import type { CommerceDatabase } from "../../database.ts";
import type {
  InPersonClientHandoffOutcome,
  InPersonClientHandoffResult,
  MerchantInPersonCollectionCommand,
  MerchantPaymentReconciliationCommand,
} from "../provider.ts";
import type { SquareApi, SquareEnvironment } from "./square-api.ts";
import { squareTenderEvidence } from "./square-tender-evidence.ts";

/** Square's clock and Commerce's clock may differ by this much. */
const CLOCK_SKEW_MS = 120_000;
const ERROR_CODE_PATTERN = /^[a-z_]{1,64}$/u;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/** The tender types that the app may offer: e-money is a card tender in Japan. */
type TenderFamily = "card" | "qr_code";

type HandoffRow = Readonly<{
  paymentProviderBindingId: string;
  handoffReference: string;
  tenderFamily: TenderFamily;
  createdAt: string;
  resultStatus: "ok" | "error" | null;
  transactionId: string | null;
  clientTransactionId: string | null;
  errorCode: string | null;
  paymentId: string | null;
}>;

export type SquarePosCredentials = Readonly<{
  api: SquareApi;
  credential(
    merchantId: string,
    paymentProviderBindingId: string,
  ): Promise<
    | Readonly<{ environment: SquareEnvironment; accessToken: string }>
    | undefined
  >;
}>;

/**
 * Opens the handoff for a payment attempt, or reads the one that an earlier
 * try opened: the first try fixes the reference and the tender family.
 */
export function startSquarePosHandoff(
  database: CommerceDatabase,
  request: MerchantInPersonCollectionCommand,
  options: Readonly<{
    paymentProviderBindingId: string;
    applicationId: string;
    locationId: string;
    now: string;
  }>,
): CommerceInPersonCollectionResultV1 {
  const family: TenderFamily =
    request.paymentMethod === "qr_code" ? "qr_code" : "card";
  database
    .prepare(
      `INSERT OR IGNORE INTO square_pos_handoff (
         merchant_id, payment_attempt_id, payment_provider_binding_id,
         handoff_reference, tender_family, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      request.merchantId,
      request.paymentAttemptId,
      options.paymentProviderBindingId,
      handoffReference(request.merchantId, request.paymentAttemptId),
      family,
      options.now,
    );
  const row = readHandoff(
    database,
    request.merchantId,
    request.paymentAttemptId,
  );
  if (row === undefined) throw new Error("Square POS handoff was not stored");
  return {
    schemaVersion: "underclerk.in-person-collection-result.v1",
    kind: "ready",
    paymentAttemptId: request.paymentAttemptId,
    session: {
      kind: "client_app_handoff",
      app: "square_point_of_sale",
      clientId: options.applicationId,
      locationId: options.locationId,
      amountMinor: request.money.amountMinor,
      currency: request.money.currency,
      tenderTypes:
        row.tenderFamily === "qr_code" ? ["PAYPAY"] : ["CREDIT_CARD"],
      handoffReference: row.handoffReference,
      note: `${request.receiptSummary.merchantName.slice(0, 200)} (${request.receiptSummary.lineCount})`,
      expiresAt: request.expiresAt,
    },
  };
}

/**
 * Keeps the app's answer for the attempt. The first answer stays: the same
 * answer again is a retry, and another answer is refused.
 */
export function recordSquarePosHandoffResult(
  database: CommerceDatabase,
  merchantId: string,
  paymentAttemptId: string,
  result: InPersonClientHandoffResult,
  now: string,
): InPersonClientHandoffOutcome {
  const row = readHandoff(database, merchantId, paymentAttemptId);
  if (row === undefined) return "not_found";
  if (row.handoffReference !== result.handoffReference)
    return "reference_mismatch";
  if (!wellFormed(result)) return "result_invalid";
  if (row.resultStatus !== null) {
    return row.resultStatus === result.status &&
      row.transactionId === result.transactionId &&
      row.clientTransactionId === result.clientTransactionId &&
      row.errorCode === result.errorCode
      ? "already_recorded"
      : "result_conflict";
  }
  if (
    result.transactionId !== null &&
    database
      .prepare(
        `SELECT 1 AS taken FROM square_pos_handoff
         WHERE merchant_id = ? AND transaction_id = ?`,
      )
      .get<Readonly<{ taken: number }>>(merchantId, result.transactionId) !==
      undefined
  )
    return "transaction_already_used";
  database
    .prepare(
      `UPDATE square_pos_handoff
       SET result_status = ?, transaction_id = ?, client_transaction_id = ?,
           error_code = ?, reported_at = ?
       WHERE merchant_id = ? AND payment_attempt_id = ? AND result_status IS NULL`,
    )
    .run(
      result.status,
      result.transactionId,
      result.clientTransactionId,
      result.errorCode,
      now,
      merchantId,
      paymentAttemptId,
    );
  return "recorded";
}

/**
 * Reads the handoff's payment from Square. Undefined when the attempt has no
 * handoff here.
 */
export async function reconcileSquarePosHandoff(
  database: CommerceDatabase,
  accounts: SquarePosCredentials,
  request: MerchantPaymentReconciliationCommand,
  locationId: string,
  now: string,
): Promise<CommercePaymentCaptureResultV1 | undefined> {
  const row = readHandoff(
    database,
    request.merchantId,
    request.paymentAttemptId,
  );
  if (row === undefined) return undefined;
  // No alarm reads a handoff: the callback page and staff ask again, so the
  // next read may come at once. A later reconcile time would refuse the
  // capture of an answer that arrives within it.
  const later = now;
  if (row.resultStatus === null)
    return {
      schemaVersion: "underclerk.payment-capture-result.v1",
      kind: "processing",
      reason: "square_pos_app_open",
      reconcileAfter: later,
    };
  if (row.resultStatus === "error")
    return {
      schemaVersion: "underclerk.payment-capture-result.v1",
      kind: "declined",
      reason:
        row.errorCode === "payment_canceled"
          ? "payment_cancelled"
          : `square_pos_${row.errorCode ?? "error"}`,
    };
  const indeterminate = (reason: string): CommercePaymentCaptureResultV1 => ({
    schemaVersion: "underclerk.payment-capture-result.v1",
    kind: "indeterminate",
    reason,
    reconcileAfter: later,
  });
  // In Offline Mode the app answers with no transaction id. The payment
  // reaches Square later, and staff check it in the Square Dashboard.
  if (row.transactionId === null)
    return indeterminate("square_pos_offline_payment");
  const credential = await accounts.credential(
    request.merchantId,
    row.paymentProviderBindingId,
  );
  if (credential === undefined)
    return indeterminate("payment_credential_unavailable");
  const read = await accounts.api.request(
    credential.environment,
    credential.accessToken,
    "GET",
    `/v2/orders/${encodeURIComponent(row.transactionId)}`,
  );
  if (read.kind === "unavailable") return indeterminate("provider_unavailable");
  if (read.kind === "refused")
    return indeterminate("square_pos_order_not_found");
  const paymentId = orderPaymentId(
    read.body.order,
    row.transactionId,
    locationId,
  );
  if (paymentId === undefined)
    return indeterminate("provider_response_invalid");
  const paid = await accounts.api.request(
    credential.environment,
    credential.accessToken,
    "GET",
    `/v2/payments/${encodeURIComponent(paymentId)}`,
  );
  if (paid.kind !== "ok") return indeterminate("provider_unavailable");
  const payment = paid.body.payment;
  if (
    !isRecord(payment) ||
    payment.id !== paymentId ||
    payment.status !== "COMPLETED" ||
    payment.location_id !== locationId ||
    payment.order_id !== row.transactionId ||
    !isRecord(payment.amount_money) ||
    payment.amount_money.amount !== request.money.amountMinor ||
    payment.amount_money.currency !== request.money.currency ||
    tipOf(payment) !== 0
  )
    return indeterminate("provider_response_invalid");
  if (payment.reference_id !== undefined && payment.reference_id !== null)
    return indeterminate("square_pos_payment_from_another_integration");
  const createdAt =
    typeof payment.created_at === "string"
      ? Date.parse(payment.created_at)
      : NaN;
  if (
    Number.isNaN(createdAt) ||
    createdAt < Date.parse(row.createdAt) - CLOCK_SKEW_MS ||
    createdAt > Date.parse(now) + CLOCK_SKEW_MS
  )
    return indeterminate("square_pos_payment_outside_handoff");
  const evidence = squareTenderEvidence(payment);
  const allowed =
    row.tenderFamily === "qr_code"
      ? evidence?.paymentMethod === "qr_code"
      : evidence?.paymentMethod === "card" ||
        evidence?.paymentMethod === "felica";
  if (evidence === undefined || !allowed)
    return indeterminate("square_pos_tender_unexpected");
  const takenBy = database
    .prepare(
      `SELECT payment_attempt_id AS paymentAttemptId FROM square_pos_handoff
       WHERE merchant_id = ? AND payment_id = ?`,
    )
    .get<Readonly<{ paymentAttemptId: string }>>(request.merchantId, paymentId);
  if (
    takenBy !== undefined &&
    takenBy.paymentAttemptId !== request.paymentAttemptId
  )
    return indeterminate("provider_payment_already_used");
  database
    .prepare(
      `UPDATE square_pos_handoff SET payment_id = ?
       WHERE merchant_id = ? AND payment_attempt_id = ? AND payment_id IS NULL`,
    )
    .run(paymentId, request.merchantId, request.paymentAttemptId);
  return {
    schemaVersion: "underclerk.payment-capture-result.v1",
    kind: "captured",
    providerPaymentReference: paymentId,
    capturedAt: now,
    paymentMethod: evidence.paymentMethod,
    tenderBrand: evidence.tenderBrand,
    providerRefundable: evidence.providerRefundable,
  };
}

/** The handoff's `state`: 40 hex characters, fixed for the attempt. */
function handoffReference(
  merchantId: string,
  paymentAttemptId: string,
): string {
  return createHash("sha256")
    .update(`${merchantId}\n${paymentAttemptId}\nsquare_point_of_sale`)
    .digest("hex")
    .slice(0, 40);
}

function wellFormed(result: InPersonClientHandoffResult): boolean {
  const id = (value: string | null): boolean =>
    value === null || ID_PATTERN.test(value);
  if (!id(result.transactionId) || !id(result.clientTransactionId))
    return false;
  return result.status === "ok"
    ? result.errorCode === null
    : result.transactionId === null &&
        result.errorCode !== null &&
        ERROR_CODE_PATTERN.test(result.errorCode);
}

/** The one payment of a Point of Sale order at the location. */
function orderPaymentId(
  order: unknown,
  transactionId: string,
  locationId: string,
): string | undefined {
  if (
    !isRecord(order) ||
    order.id !== transactionId ||
    order.location_id !== locationId ||
    !Array.isArray(order.tenders) ||
    order.tenders.length !== 1
  )
    return undefined;
  const tender: unknown = order.tenders[0];
  if (!isRecord(tender) || typeof tender.id !== "string") return undefined;
  if (tender.payment_id !== undefined && tender.payment_id !== tender.id)
    return undefined;
  return tender.id;
}

function tipOf(payment: Readonly<Record<string, unknown>>): unknown {
  return isRecord(payment.tip_money) ? payment.tip_money.amount : 0;
}

function readHandoff(
  database: CommerceDatabase,
  merchantId: string,
  paymentAttemptId: string,
): HandoffRow | undefined {
  return database
    .prepare(
      `SELECT payment_provider_binding_id AS paymentProviderBindingId,
              handoff_reference AS handoffReference,
              tender_family AS tenderFamily,
              created_at AS createdAt,
              result_status AS resultStatus,
              transaction_id AS transactionId,
              client_transaction_id AS clientTransactionId,
              error_code AS errorCode,
              payment_id AS paymentId
       FROM square_pos_handoff WHERE merchant_id = ? AND payment_attempt_id = ?`,
    )
    .get<HandoffRow>(merchantId, paymentAttemptId);
}

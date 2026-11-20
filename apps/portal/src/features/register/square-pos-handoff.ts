// The Register hands a counter payment to the Square Point of Sale app on the
// same iPad (Plan 90 Phase 3B). The app returns to one fixed callback page,
// which sends the shop back to its own Register with the app's answer. The
// answer is a hint: Commerce reads the payment from Square before it places
// the order.
// https://developer.squareup.com/docs/pos-api/web-technical-reference
import { isRecord, parseJsonOrNull } from "@purin-labs/std";

/** The one callback URL path that the Square Developer Console must list. */
export const SQUARE_POS_CALLBACK_PATH = "/portal/square-pos-return";

const REGISTER_PATH = /^\/portal\/[^/?#]+\/[^/?#]+\/register$/u;
const ID = /^[A-Za-z0-9_-]{1,255}$/u;

/** What Commerce returns for a client app handoff. */
export type SquarePosHandoffSession = Readonly<{
  kind: "client_app_handoff";
  app: "square_point_of_sale";
  clientId: string;
  locationId: string;
  amountMinor: number;
  currency: string;
  tenderTypes: readonly ("CREDIT_CARD" | "PAYPAY")[];
  handoffReference: string;
  note: string;
  expiresAt: string;
}>;

/** The app's answer, as the Register sends it to the control API. */
export type SquarePosHandoffAnswer = Readonly<{
  checkoutId: string;
  result: Readonly<{
    paymentAttemptId: string;
    handoffReference: string;
    status: "ok" | "error";
    transactionId: string | null;
    clientTransactionId: string | null;
    errorCode: string | null;
  }>;
}>;

/** The state that the app returns unchanged: where to go back to. */
type HandoffState = Readonly<{
  r: string;
  a: string;
  c: string;
  p: string;
}>;

export function isSquarePosHandoffSession(
  value: unknown,
): value is SquarePosHandoffSession {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "client_app_handoff" &&
    (value as { app?: unknown }).app === "square_point_of_sale"
  );
}

/** The `square-commerce-v1://payment/create` link that opens the app. */
export function squarePosHandoffLink(
  session: SquarePosHandoffSession,
  sale: Readonly<{ checkoutId: string; paymentAttemptId: string }>,
  page: Readonly<{ origin: string; registerPath: string }>,
): string {
  const state: HandoffState = {
    r: session.handoffReference,
    a: sale.paymentAttemptId,
    c: sale.checkoutId,
    p: page.registerPath,
  };
  const data = {
    amount_money: {
      amount: String(session.amountMinor),
      currency_code: session.currency,
    },
    callback_url: `${page.origin}${SQUARE_POS_CALLBACK_PATH}`,
    client_id: session.clientId,
    version: "1.3",
    notes: session.note,
    location_id: session.locationId,
    state: JSON.stringify(state),
    options: {
      supported_tender_types: session.tenderTypes,
      auto_return: true,
      skip_receipt: true,
    },
  };
  return `square-commerce-v1://payment/create?data=${encodeURIComponent(JSON.stringify(data))}`;
}

/**
 * The Register address to go back to from the callback page, with the app's
 * answer in its query, or null when the answer is not one that this Register
 * sent. The path must be a Register path, so the page cannot send the
 * browser elsewhere.
 */
export function squarePosReturnAddress(search: string): string | null {
  const answer = readCallback(search);
  if (answer === null) return null;
  const query = new URLSearchParams({
    sale: answer.answer.checkoutId,
    squarePos: JSON.stringify(answer.answer.result),
  });
  return `${answer.registerPath}?${query.toString()}`;
}

/** The answer that the callback page put in the Register's query. */
export function readSquarePosAnswer(
  search: string,
): SquarePosHandoffAnswer | null {
  const params = new URLSearchParams(search);
  const checkoutId = params.get("sale");
  const raw = params.get("squarePos");
  if (checkoutId === null || raw === null || !ID.test(checkoutId)) return null;
  const result = readRecord(raw);
  if (
    result === null ||
    !text(result.paymentAttemptId) ||
    !text(result.handoffReference) ||
    (result.status !== "ok" && result.status !== "error") ||
    !nullableText(result.transactionId) ||
    !nullableText(result.clientTransactionId) ||
    !nullableText(result.errorCode)
  )
    return null;
  return {
    checkoutId,
    result: {
      paymentAttemptId: result.paymentAttemptId,
      handoffReference: result.handoffReference,
      status: result.status,
      transactionId: result.transactionId,
      clientTransactionId: result.clientTransactionId,
      errorCode: result.errorCode,
    },
  };
}

function readCallback(
  search: string,
): Readonly<{ answer: SquarePosHandoffAnswer; registerPath: string }> | null {
  const data = readRecord(new URLSearchParams(search).get("data"));
  if (data === null || typeof data.state !== "string") return null;
  const state = readRecord(data.state);
  if (
    state === null ||
    !text(state.r) ||
    !text(state.a) ||
    typeof state.c !== "string" ||
    !ID.test(state.c) ||
    typeof state.p !== "string" ||
    !REGISTER_PATH.test(state.p)
  )
    return null;
  const ok = data.status === "ok";
  return {
    registerPath: state.p,
    answer: {
      checkoutId: state.c,
      result: {
        paymentAttemptId: state.a,
        handoffReference: state.r,
        status: ok ? "ok" : "error",
        transactionId:
          ok && text(data.transaction_id) ? data.transaction_id : null,
        clientTransactionId:
          ok && text(data.client_transaction_id)
            ? data.client_transaction_id
            : null,
        errorCode: ok
          ? null
          : text(data.error_code)
            ? data.error_code
            : "unknown_error",
      },
    },
  };
}

/** The JSON object in `raw`, or null for anything else. */
function readRecord(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  const value = parseJsonOrNull(raw);
  return isRecord(value) ? value : null;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255;
}

function nullableText(value: unknown): value is string | null {
  return value === null || text(value);
}

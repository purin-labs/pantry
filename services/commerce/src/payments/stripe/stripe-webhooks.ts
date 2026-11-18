// Stripe's notifications for the payments that Commerce runs (Plan 76
// phase 3). One Connect endpoint receives the events of every connected
// account. A payment notification is only a prompt: Commerce checks its
// signature, finds the merchant and the payment attempt in the PaymentIntent's
// metadata, and then reads the payment's state from Stripe itself before it
// changes anything. A dispute names only its PaymentIntent, so the Worker
// reads that PaymentIntent to find the merchant.
import { createHmac, timingSafeEqual } from "node:crypto";

import { isRecord } from "@seams/std";

import { parseStripeDisputeEvent } from "./stripe-disputes.ts";

/** Stripe's default tolerance for the signed timestamp. */
const TOLERANCE_SECONDS = 300;

type StripePaymentNotification =
  | Readonly<{
      kind: "payment_attempt";
      eventId: string;
      merchantId: string;
      paymentAttemptId: string;
    }>
  | Readonly<{
      kind: "dispute";
      eventId: string;
      accountId: string;
      paymentIntentId: string;
    }>
  | Readonly<{ kind: "ignored"; eventId: string }>;

/**
 * The event of a correctly signed body, or undefined. `Stripe-Signature`
 * holds `t=<seconds>` and one or more `v1=<hex>` signatures of `t.body`.
 */
export function verifiedStripeNotification(
  body: string,
  signatureHeader: string | null,
  secret: string,
  nowSeconds: number,
): StripePaymentNotification | undefined {
  if (signatureHeader === null) return undefined;
  const parts = signatureHeader
    .split(",")
    .map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts
    .filter(([key, value]) => key === "v1" && value !== undefined)
    .map(([, value]) => value ?? "");
  if (
    timestamp === undefined ||
    !/^\d{1,12}$/u.test(timestamp) ||
    Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS ||
    signatures.length === 0
  )
    return undefined;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest();
  const signed = signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/u.test(signature)) return false;
    return timingSafeEqual(Buffer.from(signature, "hex"), expected);
  });
  if (!signed) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (
    !isRecord(event) ||
    event.object !== "event" ||
    typeof event.id !== "string"
  )
    return undefined;
  if (
    typeof event.type === "string" &&
    event.type.startsWith("charge.dispute.")
  ) {
    const dispute = parseStripeDisputeEvent(event);
    return dispute === undefined
      ? { kind: "ignored", eventId: event.id }
      : {
          kind: "dispute",
          eventId: dispute.eventId,
          accountId: dispute.accountId,
          paymentIntentId: dispute.providerPaymentReference,
        };
  }
  const object = isRecord(event.data) ? event.data.object : undefined;
  if (
    typeof event.type !== "string" ||
    !event.type.startsWith("payment_intent.") ||
    !isRecord(object) ||
    object.object !== "payment_intent" ||
    !isRecord(object.metadata)
  )
    return { kind: "ignored", eventId: event.id };
  const {
    underclerk_merchant_id: merchantId,
    underclerk_payment_attempt_id: paymentAttemptId,
  } = object.metadata;
  return typeof merchantId === "string" &&
    merchantId.length > 0 &&
    typeof paymentAttemptId === "string" &&
    paymentAttemptId.length > 0
    ? {
        kind: "payment_attempt",
        eventId: event.id,
        merchantId,
        paymentAttemptId,
      }
    : { kind: "ignored", eventId: event.id };
}

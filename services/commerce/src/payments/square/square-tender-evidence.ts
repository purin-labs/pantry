// What a Square counter payment actually collected, read from the Payment
// object (`GET /v2/payments/:id`). Square records a Japanese e-money payment
// as a CARD payment: the card brand is FELICA and the sub-brand is in
// `electronic_money_details.felica_details.felica_brand` (FELICA_ID,
// FELICA_QP, FELICA_TRANSPORTATION or UNKNOWN). Older payments show the card
// brand OTHER_BRAND with the same e-money details. A QR wallet payment is a
// WALLET payment with `wallet_details.brand` (PAYPAY, D_BARAI, RAKUTEN_PAY,
// AU_PAY, MERPAY, ALIPAY and others).
// https://developer.squareup.com/docs/international-development/japan
import type { InPersonPaymentMethod } from "@purin-labs/commerce-contracts";
import { isRecord } from "@purin-labs/std";

export type SquareTenderEvidence = Readonly<{
  paymentMethod: InPersonPaymentMethod;
  tenderBrand: string;
  /**
   * Square's Refunds API refuses transit IC refunds (`REFUND_DECLINED`).
   * Every FeliCa capture is refunded in cash at the counter (Plan 90 D6), so
   * the electronic capture stays as Square settled it.
   */
  providerRefundable: boolean;
}>;

/** Reads the tender of a payment, or undefined for any other source. */
export function squareTenderEvidence(
  payment: Readonly<Record<string, unknown>>,
): SquareTenderEvidence | undefined {
  if (payment.source_type === "WALLET") {
    if (!isRecord(payment.wallet_details)) return undefined;
    return {
      paymentMethod: "qr_code",
      tenderBrand: textOr(payment.wallet_details.brand, "WALLET"),
      providerRefundable: true,
    };
  }
  if (payment.source_type !== "CARD") return undefined;
  const card =
    isRecord(payment.card_details) && isRecord(payment.card_details.card)
      ? payment.card_details.card
      : undefined;
  const cardBrand = textOr(card?.card_brand, "CARD");
  const felica =
    isRecord(payment.electronic_money_details) &&
    isRecord(payment.electronic_money_details.felica_details)
      ? payment.electronic_money_details.felica_details
      : undefined;
  if (cardBrand === "FELICA" || felica !== undefined) {
    return {
      paymentMethod: "felica",
      tenderBrand: textOr(felica?.felica_brand, "FELICA"),
      providerRefundable: false,
    };
  }
  return {
    paymentMethod: "card",
    tenderBrand: cardBrand,
    providerRefundable: true,
  };
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 64)
    : fallback;
}

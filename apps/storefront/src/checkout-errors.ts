// What the buyer reads when the commerce engine refuses a checkout step.
import type { CommerceClientError } from "@purin-labs/commerce-client";

export type CafeLanguage = "en" | "ja";

const PAYMENT_UNAVAILABLE: Readonly<Record<CafeLanguage, string>> = {
  en: "This shop cannot take card payments right now. Your order was not placed, and you were not charged.",
  ja: "このお店では現在カード決済をご利用いただけません。ご注文は確定しておらず、請求もされていません。",
};

export function buyerClientError(error: CommerceClientError): string {
  if (error.kind === "invalid_response")
    return "The store's reply could not be read. Try again.";
  return error.message.length === 0
    ? "Something went wrong. Try again."
    : `${error.message} Try again.`;
}

export function shippingCheckoutError(error: CommerceClientError): string {
  return error.kind === "rejected" &&
    error.error.code === "resource_relationship_invalid" &&
    error.error.field === "buyerCheckout.shippingServiceAvailability"
    ? "Delivery is temporarily unavailable. Try again later."
    : buyerClientError(error);
}

/**
 * A refused payment session. The engine refuses the payment binding when the
 * shop has no payment account that can charge a card: a retry cannot help, so
 * the buyer learns that no order was placed.
 */
export function paymentSessionError(
  error: CommerceClientError,
  language: CafeLanguage,
): string {
  return error.kind === "rejected" &&
    error.error.code === "resource_relationship_invalid" &&
    error.error.field === "buyerCheckout.paymentBinding"
    ? PAYMENT_UNAVAILABLE[language]
    : buyerClientError(error);
}

export function isQuoteExpiredError(error: CommerceClientError): boolean {
  return (
    error.kind === "rejected" && error.error.code === "checkout_quote_expired"
  );
}

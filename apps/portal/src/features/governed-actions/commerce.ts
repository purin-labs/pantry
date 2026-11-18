import type { ActionLedgerActivity } from "@seams/control-api/portal/agent-operations";
import { assertNever } from "@seams/std";
import type { CommerceActionAmount, CommerceActionRecord } from "@seams/control-api/portal/commerce-actions";

/**
 * Renders a minor-unit price for a reader deciding whether to approve it.
 *
 * The action carries minor units and a code, not a decimal, so the exponent
 * has to come from the locale data rather than a fixed divisor: JPY has none,
 * most currencies have two, and a few have three.
 */
export function formatOfferPrice(
  amountMinor: number,
  currency: string,
): string {
  try {
    const format = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      currencyDisplay: "code",
    });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(amountMinor / 10 ** digits);
  } catch {
    return `${amountMinor} ${currency}`;
  }
}

export function formatCommerceActionAmount(
  amount: CommerceActionAmount,
): string {
  if (amount === null) return "Refund amount unavailable";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: amount.currency,
      currencyDisplay: "code",
    }).format(amount.value);
  } catch {
    return `${amount.value} ${amount.currency}`;
  }
}

export function commerceActionTitle(verb: string): string {
  switch (verb) {
    case "commerce.catalog.publish":
      return "Publish catalog listing";
    case "commerce.menu.publish":
      return "Publish café menu";
    case "commerce.menu.change_price":
      return "Change a menu price";
    case "commerce.order.refund":
      return "Refund order";
    case "commerce.stock.receive":
      return "Receive stock";
    case "commerce.stock.count":
      return "Correct stock";
    case "commerce.production_request.create":
      return "Request production";
    case "commerce.production_request.advance":
      return "Advance production request";
    case "commerce.purchase_request.update":
      return "Update purchase request";
    case "commerce.order.cancel":
      return "Cancel customer order";
    case "commerce.fulfillment.attach_tracking":
      return "Attach fulfillment tracking";
    default:
      return "Commerce change requiring approval";
  }
}

export function commerceActionStateLabel(
  state: CommerceActionRecord["state"] | ActionLedgerActivity["state"],
): string {
  switch (state) {
    case "proposed":
    case "approval_requested":
      return "Needs approval";
    case "signed":
      return "Approved";
    case "executing":
      return "Applying";
    case "confirmed":
      return "Accepted";
    case "failed":
      return "Failed";
    case "rejected":
      return "Rejected";
    case "expired":
      return "Expired";
    case "indeterminate":
      return "Outcome unknown";
    default:
      return assertNever(state, "Unhandled automation value");
  }
}

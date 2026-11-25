// The payment bindings that a merchant's linked accounts can charge now: an
// active Stripe account or a linked Square location. The storefront template
// puts its checkout profile on one of them (spec §4).
import type { CommerceDatabase } from "./database.ts";

/** Who installs and moves the storefront's own checkout profile. */
export const STOREFRONT_TEMPLATE_IDENTITY = "system_storefront_template";

/**
 * The binding of a template profile when the merchant has no working account
 * yet. The deterministic gateway of a lab charges it; a real gateway refuses
 * it until an account is linked, and the profile then follows that account.
 */
export const TEMPLATE_PAYMENT_BINDING_ID = "payment_binding_primary_online";

/** The binding ids of the merchant's working accounts, in a stable order. */
export function workingPaymentBindingIds(
  database: CommerceDatabase,
  merchantId: string,
): readonly string[] {
  return database
    .prepare(
      `SELECT payment_provider_binding_id AS bindingId FROM payment_provider_account
       WHERE merchant_id = ? AND state = 'active'
       UNION
       SELECT payment_provider_binding_id AS bindingId FROM square_payment_account
       WHERE merchant_id = ?
       ORDER BY bindingId`,
    )
    .all<Readonly<{ bindingId: string }>>(merchantId, merchantId)
    .map((row) => row.bindingId);
}

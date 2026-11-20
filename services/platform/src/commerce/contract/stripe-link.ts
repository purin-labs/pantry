// Stripe payments of a Pantry commerce merchant run in Commerce (Plan 80
// step 5). Commerce charges a connected account with the platform key, so
// Pantry only names the account: at connection and in each provider check it
// links the organisation's connected Stripe account to the merchant under
// the primary online binding, which checkout profiles name.
import { newRequestId, type OrganisationId } from "../../ids";
import { traceWarn } from "../../observability";
import type { CommerceMerchant } from "./square-link";

/** The online payment binding that the shop's checkout profiles name. */
export const PRIMARY_ONLINE_PAYMENT_BINDING_ID =
  "payment_binding_primary_online";

type StripeLinkOutcome =
  | Readonly<{ kind: "linked"; state: string }>
  | Readonly<{ kind: "skipped"; reason: string }>;

/** Never fails: the next provider check links again. */
export async function linkStripePaymentAccount(
  merchant: CommerceMerchant,
  organisationId: OrganisationId,
  accountId: string,
): Promise<StripeLinkOutcome> {
  try {
    const linked = await merchant.client.linkStripeAccount(
      merchant.merchantId,
      {
        paymentProviderBindingId: PRIMARY_ONLINE_PAYMENT_BINDING_ID,
        accountId,
      },
    );
    if (linked.ok) return { kind: "linked", state: linked.value.state };
    warn(organisationId, linked.error.kind);
    return { kind: "skipped", reason: "link_refused" };
  } catch {
    warn(organisationId, "exception");
    return { kind: "skipped", reason: "link_failed" };
  }
}

function warn(organisationId: OrganisationId, kind: string): void {
  traceWarn("underclerk.stripe_link_failed", {
    requestId: newRequestId(),
    organisation_id: organisationId,
    kind,
  });
}

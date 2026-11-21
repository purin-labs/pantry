// The purge of an Organisation closes its Commerce merchants (Refactor 15,
// refactor 11). Without the close, the API keys, the outbound webhook
// subscriptions and the Stripe and Square links that the Organisation set up
// stay live after the Organisation is gone. The purge runs this before its
// D1 batch; the merchant bindings stay after the purge, so a purge that
// stopped here finds the same merchants again, and a repeated close changes
// nothing.
import type { OrganisationDatabase } from "../../database-handles";
import type { Env } from "../../env";
import type { OrganisationId } from "../../ids";
import { createCommerceClient } from "./client";

export async function closeOrganisationCommerceMerchants(
  env: Env,
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<number> {
  const bindings = await db
    .prepare(
      `SELECT merchant_id AS merchantId FROM underclerk_merchant_binding
       WHERE organisation_id = ? ORDER BY merchant_id`,
    )
    .bind(organisationId)
    .all<{ readonly merchantId: string }>();
  if (bindings.results.length === 0) return 0;
  const commerceEngine = createCommerceClient(env, undefined, {
    kind: "operator",
  });
  if (commerceEngine === null) throw new Error("underclerk_unavailable_for_purge");
  let closed = 0;
  for (const { merchantId } of bindings.results) {
    const result = await commerceEngine.closeMerchant(merchantId);
    // A merchant that Commerce never made has nothing to close.
    if (result.ok) closed += 1;
    else if (result.error.kind !== "http" || result.error.status !== 404)
      throw new Error("underclerk_merchant_not_closed");
  }
  return closed;
}

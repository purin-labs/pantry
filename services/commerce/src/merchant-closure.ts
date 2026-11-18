// The close of a merchant whose Organisation ended (Refactor 15, refactor
// 11, spec section 3). Platform calls it from the Organisation purge. The
// close revokes every API key and app installation, removes every outbound
// webhook subscription with its deliveries, and ends the Stripe and Square
// links, so nothing that the Organisation set up still works after it is
// gone. A closed merchant gets no new credential, subscription or provider
// link. A repeated close answers the first one.
import {
  parseCommerceMerchantClosureV1Record,
  type CommerceMerchantClosureV1,
} from "@seams/commerce-contracts/records/api-access";

import type { ApiAccess } from "./api-access.ts";
import type { CommerceDatabase } from "./database.ts";
import type { SquareConnections } from "./payments/square/square-connection.ts";

/** The admin routes that a closed merchant refuses: each starts a new link. */
export const CLOSED_MERCHANT_REFUSED_ROUTES: ReadonlySet<string> = new Set([
  "issue_api_key",
  "install_app",
  "create_webhook_subscription",
  "restart_webhook_subscription",
  "link_stripe_account",
  "start_stripe_onboarding",
  "link_square_account",
  "connect_square",
]);

export type MerchantClosureResult =
  | Readonly<{ kind: "closed"; closure: CommerceMerchantClosureV1 }>
  | Readonly<{ kind: "not_found" }>;

export async function closeMerchant(
  deps: Readonly<{
    database: CommerceDatabase;
    access: ApiAccess;
    squareConnections: SquareConnections | undefined;
    now: () => string;
  }>,
  merchantId: string,
): Promise<MerchantClosureResult> {
  const { database } = deps;
  const earlier = readClosure(database, merchantId);
  if (earlier !== undefined) return { kind: "closed", closure: earlier };
  const merchant = database
    .prepare("SELECT 1 AS present FROM merchant WHERE merchant_id = ?")
    .get<Readonly<{ present: number }>>(merchantId);
  if (merchant === undefined) return { kind: "not_found" };
  // Square revokes the application's tokens for the seller. When Square
  // cannot, Commerce still forgets the tokens and the locations, so no
  // payment of this merchant runs again.
  let square: CommerceMerchantClosureV1["square"] = "none";
  if (
    database
      .prepare(
        "SELECT 1 AS present FROM square_connection WHERE merchant_id = ?",
      )
      .get<Readonly<{ present: number }>>(merchantId) !== undefined
  ) {
    const revoked = await deps.squareConnections
      ?.disconnect(merchantId)
      .catch(() => undefined);
    square = revoked?.kind === "ok" ? "revoked" : "forgotten";
  }
  return database.transaction((): MerchantClosureResult => {
    const again = readClosure(database, merchantId);
    if (again !== undefined) return { kind: "closed", closure: again };
    const closedAt = deps.now();
    const revokedCredentials = deps.access.revokeAll(merchantId, closedAt);
    database
      .prepare("DELETE FROM webhook_delivery WHERE merchant_id = ?")
      .run(merchantId);
    const removedWebhookSubscriptions = database
      .prepare("DELETE FROM webhook_subscription WHERE merchant_id = ?")
      .run(merchantId).changes;
    const removedStripeAccounts = database
      .prepare("DELETE FROM payment_provider_account WHERE merchant_id = ?")
      .run(merchantId).changes;
    database
      .prepare("DELETE FROM square_payment_account WHERE merchant_id = ?")
      .run(merchantId);
    database
      .prepare("DELETE FROM square_connection WHERE merchant_id = ?")
      .run(merchantId);
    const closure: CommerceMerchantClosureV1 = {
      schemaVersion: "underclerk.merchant-closure.v1",
      merchantId,
      closedAt,
      revokedCredentials,
      removedWebhookSubscriptions,
      removedStripeAccounts,
      square,
    };
    database
      .prepare(
        `INSERT INTO merchant_closure (merchant_id, closed_at, closure_json)
         VALUES (?, ?, ?)`,
      )
      .run(merchantId, closedAt, JSON.stringify(closure));
    return { kind: "closed", closure };
  });
}

function readClosure(
  database: CommerceDatabase,
  merchantId: string,
): CommerceMerchantClosureV1 | undefined {
  const row = database
    .prepare(
      "SELECT closure_json AS closureJson FROM merchant_closure WHERE merchant_id = ?",
    )
    .get<Readonly<{ closureJson: string }>>(merchantId);
  if (row === undefined) return undefined;
  const parsed = parseCommerceMerchantClosureV1Record(
    JSON.parse(row.closureJson),
  );
  if (!parsed.ok) throw new Error("A stored merchant closure is not valid");
  return parsed.value;
}

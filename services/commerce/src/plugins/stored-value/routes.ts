// This built-in plugin's routes (Plan 77 step 3). The core's route table
// takes them from the plugin's index.ts.
import type { CommerceApiScope } from "@seams/commerce-client";

import { routeFor, type RouteDefinition } from "../../route-definitions.ts";

export type StoredValueRoute =
  | Readonly<{ kind: "issue_gift_card"; merchantId: string }>
  | Readonly<{ kind: "credit_store_credit"; merchantId: string }>
  | Readonly<{
      kind: "disable_stored_value_account";
      merchantId: string;
      accountId: string;
    }>
  | Readonly<{ kind: "list_stored_value_accounts"; merchantId: string }>
  | Readonly<{ kind: "read_stored_value_liability"; merchantId: string }>
  | Readonly<{
      kind: "read_gift_card_balance";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{
      kind: "place_buyer_stored_value_checkout";
      merchantId: string;
      storefrontId: string;
      checkoutId: string;
    }>;

const route = routeFor<StoredValueRoute>();

export const STORED_VALUE_ROUTES: readonly RouteDefinition<StoredValueRoute>[] =
  [
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/gift-cards",
      "issue_gift_card",
      "underclerk.issue-gift-card.v1",
    ),
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/store-credit",
      "credit_store_credit",
      "underclerk.credit-store-credit.v1",
    ),
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/stored-value-accounts/:accountId/disable",
      "disable_stored_value_account",
      "underclerk.disable-stored-value-account.v1",
    ),
    route(
      "GET",
      "/v1/admin/merchants/:merchantId/stored-value-accounts",
      "list_stored_value_accounts",
    ),
    route(
      "GET",
      "/v1/admin/merchants/:merchantId/stored-value-liability",
      "read_stored_value_liability",
    ),
    route(
      "POST",
      "/v1/public/merchants/:merchantId/storefronts/:storefrontId/gift-card-balances",
      "read_gift_card_balance",
    ),
    route(
      "POST",
      "/v1/public/merchants/:merchantId/storefronts/:storefrontId/checkouts/:checkoutId/stored-value-placement",
      "place_buyer_stored_value_checkout",
    ),
  ];

/** The routes a storefront buyer calls without the service token. */
export const STORED_VALUE_BUYER_ROUTE_KINDS = [
  "read_gift_card_balance",
  "place_buyer_stored_value_checkout",
] as const satisfies readonly StoredValueRoute["kind"][];

/**
 * The scope each admin route needs; "operator" routes take only the operator
 * token.
 */
export const STORED_VALUE_ROUTE_ACCESS: Readonly<
  Record<
    Exclude<
      StoredValueRoute["kind"],
      (typeof STORED_VALUE_BUYER_ROUTE_KINDS)[number]
    >,
    CommerceApiScope | "operator"
  >
> = {
  issue_gift_card: "stored_value:write",
  credit_store_credit: "stored_value:write",
  disable_stored_value_account: "stored_value:write",
  list_stored_value_accounts: "stored_value:read",
  read_stored_value_liability: "stored_value:read",
};

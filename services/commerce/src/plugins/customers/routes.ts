// The routes of the customers built-in plugin (Plan 77 step 3). The core's
// route table takes them from this plugin's index.ts.
import type { CommerceApiScope } from "@purin-labs/commerce-client";

import { routeFor, type RouteDefinition } from "../../route-definitions.ts";

export type CustomersRoute =
  | Readonly<{ kind: "create_customer"; merchantId: string }>
  | Readonly<{
      kind: "update_customer";
      merchantId: string;
      customerId: string;
    }>
  | Readonly<{ kind: "erase_customer"; merchantId: string; customerId: string }>
  | Readonly<{ kind: "read_customer"; merchantId: string; customerId: string }>
  | Readonly<{
      kind: "export_customer";
      merchantId: string;
      customerId: string;
    }>
  | Readonly<{
      kind: "request_customer_sign_in";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{
      kind: "verify_customer_sign_in";
      merchantId: string;
      storefrontId: string;
      challengeId: string;
    }>
  | Readonly<{
      kind: "read_buyer_customer";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{
      kind: "save_customer_address";
      merchantId: string;
      storefrontId: string;
    }>;

const route = routeFor<CustomersRoute>();

export const CUSTOMERS_ROUTES: readonly RouteDefinition<CustomersRoute>[] = [
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/customers",
    "create_customer",
    "commerce.create-customer.v1",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/customers/:customerId",
    "update_customer",
    "commerce.update-customer.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/customers/:customerId/erasure",
    "erase_customer",
    "commerce.erase-customer.v1",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/customers/:customerId",
    "read_customer",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/customers/:customerId/export",
    "export_customer",
  ),
  route(
    "POST",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/customer-sign-ins",
    "request_customer_sign_in",
  ),
  route(
    "POST",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/customer-sign-ins/:challengeId/verification",
    "verify_customer_sign_in",
  ),
  route(
    "GET",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/customer",
    "read_buyer_customer",
  ),
  route(
    "POST",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/customer/addresses",
    "save_customer_address",
  ),
];

/** The routes a storefront buyer calls without the service token. */
export const CUSTOMERS_BUYER_ROUTE_KINDS = [
  "request_customer_sign_in",
  "verify_customer_sign_in",
  "read_buyer_customer",
  "save_customer_address",
] as const satisfies readonly CustomersRoute["kind"][];

/**
 * The scope each admin route needs; "operator" routes take only the operator
 * token.
 */
export const CUSTOMERS_ROUTE_ACCESS: Readonly<
  Record<
    Exclude<
      CustomersRoute["kind"],
      (typeof CUSTOMERS_BUYER_ROUTE_KINDS)[number]
    >,
    CommerceApiScope | "operator"
  >
> = {
  create_customer: "customers:write",
  update_customer: "customers:write",
  erase_customer: "customers:write",
  read_customer: "customers:read",
  export_customer: "customers:read",
};

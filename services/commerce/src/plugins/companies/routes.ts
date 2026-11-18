// The routes of the b2b companies built-in plugin (Plan 77 step 3). The core's
// route table takes them from this plugin's index.ts.
import type { CommerceApiScope } from "@seams/commerce-client";

import { routeFor, type RouteDefinition } from "../../route-definitions.ts";

export type CompaniesRoute =
  | Readonly<{ kind: "create_company"; merchantId: string }>
  | Readonly<{ kind: "list_companies"; merchantId: string }>
  | Readonly<{ kind: "update_company"; merchantId: string; companyId: string }>
  | Readonly<{
      kind: "place_draft_order_on_terms";
      merchantId: string;
      draftOrderId: string;
    }>
  | Readonly<{
      kind: "record_invoice_payment";
      merchantId: string;
      invoiceId: string;
    }>
  | Readonly<{ kind: "list_invoices"; merchantId: string }>;

const route = routeFor<CompaniesRoute>();

export const COMPANIES_ROUTES: readonly RouteDefinition<CompaniesRoute>[] = [
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/companies",
    "create_company",
    "underclerk.create-company.v1",
  ),
  route("GET", "/v1/admin/merchants/:merchantId/companies", "list_companies"),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/companies/:companyId",
    "update_company",
    "underclerk.update-company.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/draft-orders/:draftOrderId/terms-placement",
    "place_draft_order_on_terms",
    "underclerk.place-draft-order-on-terms.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/invoices/:invoiceId/payments",
    "record_invoice_payment",
    "underclerk.record-invoice-payment.v1",
  ),
  route("GET", "/v1/admin/merchants/:merchantId/invoices", "list_invoices"),
];

/** The routes a storefront buyer calls without the service token. */
export const COMPANIES_BUYER_ROUTE_KINDS =
  [] as const satisfies readonly CompaniesRoute["kind"][];

/**
 * The scope each admin route needs; "operator" routes take only the operator
 * token.
 */
export const COMPANIES_ROUTE_ACCESS: Readonly<
  Record<
    Exclude<
      CompaniesRoute["kind"],
      (typeof COMPANIES_BUYER_ROUTE_KINDS)[number]
    >,
    CommerceApiScope | "operator"
  >
> = {
  // A company names customers and their prices.
  create_company: "customers:write",
  update_company: "customers:write",
  list_companies: "customers:read",
  place_draft_order_on_terms: "orders:write",
  record_invoice_payment: "orders:write",
  list_invoices: "orders:read",
};

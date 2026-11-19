// The companies built-in plugin (Plan 76 phase 8 slice 2). Code outside
// this directory reaches the plugin only through this file.
import type { CommerceCompanyCommandV1 } from "@purin-labs/commerce-client";
import type { InvoiceCommand } from "./invoices.ts";

export * from "./companies.ts";
export * from "./invoices.ts";
export { COMPANY_SCHEMA } from "./schema.ts";
export {
  COMPANIES_BUYER_ROUTE_KINDS,
  COMPANIES_ROUTE_ACCESS,
  COMPANIES_ROUTES,
  type CompaniesRoute,
} from "./routes.ts";
export { COMPANIES_COMMAND_EVENTS } from "./events.ts";

export { companyCitesVariant } from "./companies.ts";

/** The commands that this plugin commits through the ledger. */
export type CompaniesCommand = CommerceCompanyCommandV1 | InvoiceCommand;

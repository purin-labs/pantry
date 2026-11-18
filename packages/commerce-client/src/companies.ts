// B2B companies (Plan 76 phase 8 slice 3). A company groups customers who
// buy for a business, and gives them its own price for some variants at
// pickup and shipping checkouts. Staff can place a draft order for its buyer
// on the company's invoice terms, and record the bank transfer later. The schemas in `@seams/commerce-contracts` are
// the only source of these records (Plan 78).
import { decodeRecord } from "./entity-plane/record-decoding.ts";
import {
  parseCreateCommerceCompanyV1,
  parsePlaceCommerceDraftOrderOnTermsV1,
  parseRecordCommerceInvoicePaymentV1,
  parseCommerceCompaniesV1,
  parseCommerceCompanyInvoiceV1,
  parseCommerceCompanyInvoicesV1,
  parseCommerceCompanyV1,
  parseUpdateCommerceCompanyV1,
} from "@seams/commerce-contracts/records/api-companies";

export type {
  CreateCommerceCompanyV1,
  PlaceCommerceDraftOrderOnTermsV1,
  RecordCommerceInvoicePaymentV1,
  CommerceCompaniesV1,
  CommerceCompanyCommandV1,
  CommerceCompanyInvoiceV1,
  CommerceCompanyPaymentTermsV1,
  CommerceCompanyPricesV1,
  CommerceCompanyV1,
  UpdateCommerceCompanyV1,
} from "@seams/commerce-contracts/records/api-companies";

export function parseCompany(value: unknown) {
  return decodeRecord(parseCommerceCompanyV1, value);
}

export function parseCompanies(value: unknown) {
  return decodeRecord(parseCommerceCompaniesV1, value).companies;
}

export function parseCreateCompanyCommand(value: unknown) {
  return decodeRecord(parseCreateCommerceCompanyV1, value);
}

export function parseUpdateCompanyCommand(value: unknown) {
  return decodeRecord(parseUpdateCommerceCompanyV1, value);
}

export function parseCompanyInvoice(value: unknown) {
  return decodeRecord(parseCommerceCompanyInvoiceV1, value);
}

export function parseCompanyInvoices(value: unknown) {
  return decodeRecord(parseCommerceCompanyInvoicesV1, value).invoices;
}

export function parsePlaceDraftOrderOnTermsCommand(value: unknown) {
  return decodeRecord(parsePlaceCommerceDraftOrderOnTermsV1, value);
}

export function parseRecordInvoicePaymentCommand(value: unknown) {
  return decodeRecord(parseRecordCommerceInvoicePaymentV1, value);
}

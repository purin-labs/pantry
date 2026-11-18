// B2B companies (Plan 76 phase 8 slice 2). A company groups the customers
// who buy for a business and gives them its unit price of some variants. At
// a pickup or shipping checkout in the shop currency, a signed-in member
// pays the company price of a listed catalog line; discounts and merchant
// plugin hooks come after it.
import {
  parseCompany,
  parseCreateCompanyCommand,
  parseUpdateCompanyCommand,
  type CommerceCompanyCommandV1,
  type CommerceCompanyV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";

import { listVariants } from "../../commerce-persistence.ts";
import type { CommerceDatabase } from "../../database.ts";
import { customerIsActive } from "../customers/index.ts";
import type { MerchantRow } from "../../commerce-authority/ledger.ts";
import {
  commitPlannedCommand,
  type MerchantCommandPorts,
} from "../../commerce-authority/merchant-command.ts";

export type CompanyCommitRequest = Readonly<{
  command: CommerceCompanyCommandV1;
  merchant: MerchantRow;
  company: CommerceCompanyV1;
  previousRevision: number | undefined;
}>;

type CompanyAuthorityOptions = MerchantCommandPorts<CommerceCompanyCommandV1> &
  Readonly<{
    database: CommerceDatabase;
    commit: (request: CompanyCommitRequest) => CommerceMutationResultV1;
  }>;

export class CompanyAuthority {
  readonly #options: CompanyAuthorityOptions;

  constructor(options: CompanyAuthorityOptions) {
    this.#options = options;
  }

  createCompany(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseCreateCompanyCommand, (command) => {
      if (
        readCompany(
          this.#options.database,
          command.merchantId,
          command.companyId,
        ) !== undefined
      )
        return {
          code: "resource_already_exists",
          kind: "company",
          id: command.companyId,
        };
      return this.#checked(
        command.merchantId,
        {
          id: command.companyId,
          revision: 1,
          name: command.name,
          customerIds: command.customerIds,
          prices: command.prices,
          paymentTerms: command.paymentTerms ?? null,
          status: "active",
          occurredAt: command.requestedAt,
        },
        undefined,
      );
    });
  }

  updateCompany(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseUpdateCompanyCommand, (command) => {
      const current = readCompany(
        this.#options.database,
        command.merchantId,
        command.companyId,
      );
      if (current === undefined)
        return {
          code: "resource_not_found",
          kind: "company",
          id: command.companyId,
        };
      if (current.revision !== command.expectedRevision)
        return {
          code: "stale_resource_revision",
          kind: "company",
          id: current.id,
          expected: command.expectedRevision,
          actual: current.revision,
        };
      return this.#checked(
        command.merchantId,
        {
          ...current,
          ...command.changes,
          revision: current.revision + 1,
          occurredAt: command.requestedAt,
        },
        current.revision,
      );
    });
  }

  listCompanies(merchantId: string): readonly CommerceCompanyV1[] {
    return this.#options.database
      .prepare(
        "SELECT company_json AS json FROM company WHERE merchant_id = ? ORDER BY company_id",
      )
      .all<Readonly<{ json: string }>>(merchantId)
      .map((row) => parseCompany(JSON.parse(row.json)));
  }

  // Each member is an active customer in no other company, and the prices
  // name known variants.
  #checked(
    merchantId: string,
    company: CommerceCompanyV1,
    previousRevision: number | undefined,
  ):
    | Omit<CompanyCommitRequest, "command" | "merchant">
    | CommerceMutationErrorV1 {
    const { database } = this.#options;
    for (const customerId of company.customerIds) {
      if (!customerIsActive(database, merchantId, customerId))
        return { code: "resource_not_found", kind: "customer", id: customerId };
      const other = companyIdOfCustomer(database, merchantId, customerId);
      if (other !== undefined && other !== company.id)
        return {
          code: "resource_relationship_invalid",
          field: "company.customerIds",
        };
    }
    const known = new Set(
      listVariants(database, merchantId).map((variant) => variant.id),
    );
    const unknown = company.prices.items.find(
      (item) => !known.has(item.variantId),
    );
    if (unknown !== undefined)
      return {
        code: "resource_not_found",
        kind: "sellable_variant",
        id: unknown.variantId,
      };
    return { company, previousRevision };
  }

  #run<TCommand extends CommerceCompanyCommandV1>(
    rawCommand: unknown,
    parse: (value: unknown) => TCommand,
    plan: (
      command: TCommand,
    ) =>
      | Omit<CompanyCommitRequest, "command" | "merchant">
      | CommerceMutationErrorV1,
  ): CommerceMutationResultV1 {
    return commitPlannedCommand(this.#options, rawCommand, parse, plan);
  }
}

/** Writes a company and its member rows, at the revision it read. */
export function writeCompany(
  database: CommerceDatabase,
  merchantId: string,
  company: CommerceCompanyV1,
  previousRevision: number | undefined,
): void {
  if (previousRevision === undefined)
    database
      .prepare(
        `INSERT INTO company (
           merchant_id, company_id, revision, status, company_json, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        company.id,
        company.revision,
        company.status,
        JSON.stringify(company),
        company.occurredAt,
      );
  else {
    const written = database
      .prepare(
        `UPDATE company SET revision = ?, status = ?, company_json = ?,
           occurred_at = ?
         WHERE merchant_id = ? AND company_id = ? AND revision = ?`,
      )
      .run(
        company.revision,
        company.status,
        JSON.stringify(company),
        company.occurredAt,
        merchantId,
        company.id,
        previousRevision,
      );
    if (written.changes !== 1)
      throw new Error(`Company ${company.id} moved during the write`);
  }
  database
    .prepare(
      "DELETE FROM company_member WHERE merchant_id = ? AND company_id = ?",
    )
    .run(merchantId, company.id);
  for (const customerId of company.customerIds)
    database
      .prepare(
        `INSERT INTO company_member (merchant_id, customer_id, company_id)
         VALUES (?, ?, ?)`,
      )
      .run(merchantId, customerId, company.id);
}

function readCompany(
  database: CommerceDatabase,
  merchantId: string,
  companyId: string,
): CommerceCompanyV1 | undefined {
  const row = database
    .prepare(
      "SELECT company_json AS json FROM company WHERE merchant_id = ? AND company_id = ?",
    )
    .get<Readonly<{ json: string }>>(merchantId, companyId);
  return row === undefined ? undefined : parseCompany(JSON.parse(row.json));
}

function companyIdOfCustomer(
  database: CommerceDatabase,
  merchantId: string,
  customerId: string,
): string | undefined {
  return database
    .prepare(
      "SELECT company_id AS companyId FROM company_member WHERE merchant_id = ? AND customer_id = ?",
    )
    .get<Readonly<{ companyId: string }>>(merchantId, customerId)?.companyId;
}

/** The active company of a checkout's customer, or undefined. */
export function activeCompanyOf(
  database: CommerceDatabase,
  merchantId: string,
  customerId: string | null,
): CommerceCompanyV1 | undefined {
  if (customerId === null) return undefined;
  const companyId = companyIdOfCustomer(database, merchantId, customerId);
  const company =
    companyId === undefined
      ? undefined
      : readCompany(database, merchantId, companyId);
  return company?.status === "active" ? company : undefined;
}

/** The invoice terms of a customer's active company, or undefined. */
export function termsOfCustomer(
  database: CommerceDatabase,
  merchantId: string,
  customerId: string | null,
): Readonly<{ companyId: string; netDays: number }> | undefined {
  const company = activeCompanyOf(database, merchantId, customerId);
  return company?.paymentTerms === null || company === undefined
    ? undefined
    : { companyId: company.id, netDays: company.paymentTerms.netDays };
}

/** Whether a company's price list names this variant. */
export function companyCitesVariant(
  database: CommerceDatabase,
  merchantId: string,
  variantId: string,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 FROM company
         WHERE merchant_id = ? AND instr(company_json, ?) > 0 LIMIT 1`,
      )
      .get(merchantId, variantId) !== undefined
  );
}

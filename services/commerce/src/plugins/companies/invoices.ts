// Invoices of orders on a company's terms (Plan 76 phase 8 slice 3). Staff
// place a draft order for a company's buyer on the company's net terms: the
// order holds a captured payment of the amount due, so it is prepared and
// handed over as a paid order is, and the invoice is what the company owes.
// Staff record the company's bank transfer with its reference; the payment
// then has a bank-transfer tender, as if staff took the money then. An
// invoice that is still open at its due date becomes overdue, in a system
// commit from the alarm. A refund or a cancellation waits for the payment.
import {
  parseCompanyInvoice,
  parseRecordInvoicePaymentCommand,
  type RecordCommerceInvoicePaymentV1,
  type CommerceCompanyInvoiceV1,
  type CommerceMutationResultV1,
} from "@purin-labs/commerce-client";

import type { CommerceDatabase } from "../../database.ts";
import type { MerchantRow } from "../../commerce-authority/ledger.ts";
import {
  beginMerchantCommand,
  type MerchantCommandPorts,
} from "../../commerce-authority/merchant-command.ts";
import { writeManualTender } from "../../payments/manual-tender.ts";

const DAY_MS = 86_400_000;

/** The system command that marks an invoice overdue; no route takes it. */
type MarkInvoiceOverdueCommand = Readonly<{
  schemaVersion: "commerce.mark-invoice-overdue.internal.v1";
  merchantId: string;
  idempotencyKey: string;
  requestedAt: string;
  invoiceId: string;
}>;

export type InvoiceCommand =
  RecordCommerceInvoicePaymentV1 | MarkInvoiceOverdueCommand;

export type InvoiceCommitRequest = Readonly<{
  command: InvoiceCommand;
  merchant: MerchantRow;
  invoice: CommerceCompanyInvoiceV1;
  previousRevision: number;
}>;

type InvoiceAuthorityOptions = MerchantCommandPorts<InvoiceCommand> &
  Readonly<{
    database: CommerceDatabase;
    now: () => string;
    commit: (request: InvoiceCommitRequest) => CommerceMutationResultV1;
  }>;

/** The invoice of an order that staff place on terms. */
export function termsInvoice(
  input: Readonly<{
    invoiceId: string;
    companyId: string;
    netDays: number;
    orderId: string;
    paymentId: string;
    amount: Readonly<{ amountMinor: number; currency: string }>;
    issuedAt: string;
  }>,
): CommerceCompanyInvoiceV1 {
  return parseCompanyInvoice({
    id: input.invoiceId,
    revision: 1,
    companyId: input.companyId,
    orderId: input.orderId,
    paymentId: input.paymentId,
    amount: input.amount,
    issuedAt: input.issuedAt,
    dueAt: new Date(
      Date.parse(input.issuedAt) + input.netDays * DAY_MS,
    ).toISOString(),
    state: { kind: "open" },
    occurredAt: input.issuedAt,
  });
}

export class InvoiceAuthority {
  readonly #options: InvoiceAuthorityOptions;

  constructor(options: InvoiceAuthorityOptions) {
    this.#options = options;
  }

  listInvoices(merchantId: string): readonly CommerceCompanyInvoiceV1[] {
    return this.#options.database
      .prepare(
        `SELECT invoice_json AS json FROM company_invoice
         WHERE merchant_id = ? ORDER BY invoice_id`,
      )
      .all<Readonly<{ json: string }>>(merchantId)
      .map((row) => parseCompanyInvoice(JSON.parse(row.json)));
  }

  /** The company paid by bank transfer: the invoice is paid. */
  recordInvoicePayment(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginMerchantCommand(
      this.#options,
      rawCommand,
      parseRecordInvoicePaymentCommand,
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant } = start;
    const current = readInvoice(
      this.#options.database,
      command.merchantId,
      command.invoiceId,
    );
    if (current === undefined)
      return this.#options.rejected({
        code: "resource_not_found",
        kind: "company_invoice",
        id: command.invoiceId,
      });
    if (current.revision !== command.expectedRevision)
      return this.#options.rejected({
        code: "stale_resource_revision",
        kind: "company_invoice",
        id: current.id,
        expected: command.expectedRevision,
        actual: current.revision,
      });
    if (current.state.kind === "paid")
      return this.#options.rejected({
        code: "resource_relationship_invalid",
        field: "invoice.paid",
      });
    return this.#options.commit({
      command,
      merchant,
      previousRevision: current.revision,
      invoice: {
        ...current,
        revision: current.revision + 1,
        state: {
          kind: "paid",
          paidAt: command.requestedAt,
          reference: command.reference,
        },
        occurredAt: command.requestedAt,
      },
    });
  }

  /**
   * Marks each open invoice whose due date has come as overdue, one system
   * commit each, and returns when the next open invoice is due.
   */
  markOverdueInvoices(): string | null {
    const { database } = this.#options;
    const now = this.#options.now();
    for (const row of database
      .prepare(
        `SELECT merchant_id AS merchantId, invoice_json AS json
         FROM company_invoice WHERE state = 'open' AND due_at <= ?
         ORDER BY due_at, invoice_id LIMIT 50`,
      )
      .all<Readonly<{ merchantId: string; json: string }>>(now)) {
      const invoice = parseCompanyInvoice(JSON.parse(row.json));
      const merchant = this.#options.readMerchant(row.merchantId);
      if (merchant === undefined) continue;
      const key = `invoice_overdue_${invoice.id}`;
      const command: MarkInvoiceOverdueCommand = {
        schemaVersion: "commerce.mark-invoice-overdue.internal.v1",
        merchantId: row.merchantId,
        idempotencyKey: key,
        requestedAt: invoice.dueAt,
        invoiceId: invoice.id,
      };
      if (this.#options.readReplay(row.merchantId, key, command) !== undefined)
        continue;
      this.#options.commit({
        command,
        merchant,
        previousRevision: invoice.revision,
        invoice: {
          ...invoice,
          revision: invoice.revision + 1,
          state: { kind: "overdue", since: invoice.dueAt },
          occurredAt: invoice.dueAt,
        },
      });
    }
    return (
      database
        .prepare(
          `SELECT MIN(due_at) AS dueAt FROM company_invoice WHERE state = 'open'`,
        )
        .get<Readonly<{ dueAt: string | null }>>()?.dueAt ?? null
    );
  }
}

function readInvoice(
  database: CommerceDatabase,
  merchantId: string,
  invoiceId: string,
): CommerceCompanyInvoiceV1 | undefined {
  const row = database
    .prepare(
      `SELECT invoice_json AS json FROM company_invoice
       WHERE merchant_id = ? AND invoice_id = ?`,
    )
    .get<Readonly<{ json: string }>>(merchantId, invoiceId);
  return row === undefined
    ? undefined
    : parseCompanyInvoice(JSON.parse(row.json));
}

/**
 * Writes an invoice at the revision it read. Paid, its payment gets the
 * bank transfer as its tender, so a later refund goes back the same way.
 */
export function writeInvoice(
  database: CommerceDatabase,
  merchantId: string,
  invoice: CommerceCompanyInvoiceV1,
  previousRevision: number | undefined,
): void {
  if (previousRevision === undefined)
    database
      .prepare(
        `INSERT INTO company_invoice (
           merchant_id, invoice_id, revision, company_id, order_id, payment_id,
           state, due_at, invoice_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        invoice.id,
        invoice.revision,
        invoice.companyId,
        invoice.orderId,
        invoice.paymentId,
        invoice.state.kind,
        invoice.dueAt,
        JSON.stringify(invoice),
      );
  else {
    const written = database
      .prepare(
        `UPDATE company_invoice SET revision = ?, state = ?, invoice_json = ?
         WHERE merchant_id = ? AND invoice_id = ? AND revision = ?`,
      )
      .run(
        invoice.revision,
        invoice.state.kind,
        JSON.stringify(invoice),
        merchantId,
        invoice.id,
        previousRevision,
      );
    if (written.changes !== 1)
      throw new Error(`Invoice ${invoice.id} moved during the write`);
  }
  if (invoice.state.kind === "paid")
    writeManualTender(database, merchantId, {
      method: "bank_transfer",
      reference: invoice.state.reference,
      paymentId: invoice.paymentId,
      orderId: invoice.orderId,
      amountMinor: invoice.amount.amountMinor,
      currency: invoice.amount.currency,
      recordedAt: invoice.state.paidAt,
    });
}

/** Whether a payment's invoice is not paid yet. */
export function paymentAwaitsInvoice(
  database: CommerceDatabase,
  merchantId: string,
  paymentId: string,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS found FROM company_invoice
         WHERE merchant_id = ? AND payment_id = ? AND state != 'paid'`,
      )
      .get<Readonly<{ found: number }>>(merchantId, paymentId) !== undefined
  );
}

// Plan 76 phase 8 slice 3, part 2: invoice terms. "Shibuya Office Gifts"
// pays 30 days after an order. Staff place a draft order of ten tins for its
// buyer on those terms: the order is placed with an open invoice due in 30
// days, and staff prepare it and hand it over before the company pays. A
// cancellation or a refund waits for the payment. A draft for a buyer
// without terms is refused. On day 31 the alarm marks the invoice overdue,
// once. Staff record the bank transfer with its reference; a stale revision
// and a second payment are refused, and the refund then goes back as a bank
// transfer. Set INVOICE_TERMS_ARTIFACT_DIR to keep the run's evidence; the
// file repeats byte for byte for the same commit.
import type {
  CommerceAdminClient,
  CommerceDraftOrderLineV1,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import {
  NOW,
  merchantId,
  rejectedWith,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

const DAY_MS = 86_400_000;
const LINES: readonly CommerceDraftOrderLineV1[] = [
  {
    lineId: "line_tins",
    variantId: SMALL_SENCHA,
    quantity: 10,
    priceOverride: null,
  },
];

it(
  "places a company's order on invoice terms and records its bank transfer",
  { timeout: 120_000 },
  invoiceTerms,
);

async function invoiceTerms(): Promise<void> {
  let clock = Date.parse(NOW);
  const backend = await startBackend({
    customers: true,
    now: () => new Date(clock).toISOString(),
  });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin } = backend;
    const staff = new TermsDesk(admin);
    await staff.createTea();
    await staff.createCustomer("customer_office", "office@example.test");
    await staff.createCustomer("customer_cafe", "cafe@example.test");
    expect(
      await staff.createCompany("company_shibuya", ["customer_office"], 30),
    ).toMatchObject({ outcome: "applied" });

    // A buyer without terms cannot have an order on terms.
    await staff.createDraft("draft_cafe", LINES);
    const noTerms = await staff.placeOnTerms("draft_cafe", 1);
    expect(noTerms).toMatchObject(
      rejectedWith({ field: "company.paymentTerms" }),
    );

    // The office's ten tins are placed on 30 days' terms.
    await staff.createDraft("draft_office", LINES);
    const placed = await staff.placeOnTerms("draft_office", 1);
    expect(placed).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "place_draft_order_on_terms",
        resource: { kind: "commerce_order", id: "order_office" },
      },
    });
    const order = await staff.order("order_office");
    const [issued] = await required(admin.listInvoices(merchantId));
    expect(issued).toEqual({
      id: "invoice_office",
      revision: 1,
      companyId: "company_shibuya",
      orderId: "order_office",
      paymentId: "payment_office",
      amount: order.totals.total,
      issuedAt: NOW,
      dueAt: new Date(Date.parse(NOW) + 30 * DAY_MS).toISOString(),
      state: { kind: "open" },
      occurredAt: NOW,
    });

    // The order cannot be cancelled while the invoice is open, but it is
    // prepared and handed over before the company pays; a refund waits.
    const waits = { cancel: await staff.cancel("order_office") };
    expect(waits.cancel).toMatchObject(
      rejectedWith({ field: "invoice.unpaid" }),
    );
    expect(await staff.markReady("order_office")).toMatchObject({
      outcome: "applied",
    });
    expect(await staff.completePickup("order_office")).toMatchObject({
      outcome: "applied",
    });
    const line = await staff.lineId("order_office");
    const refundBefore = await staff.refund(
      "order_office",
      line,
      "refund_early",
      1_200,
    );
    expect(refundBefore).toMatchObject(
      rejectedWith({ field: "invoice.unpaid" }),
    );

    // On day 31 the alarm marks the invoice overdue, once.
    clock += 31 * DAY_MS;
    await backend.runDueWork();
    await backend.runDueWork();
    const overdue = (await required(admin.listInvoices(merchantId)))[0];
    expect(overdue).toMatchObject({
      revision: 2,
      state: { kind: "overdue", since: issued?.dueAt },
    });

    // Staff record the bank transfer; a stale revision and a second payment
    // are refused.
    const refusals = {
      stale: await staff.pay("invoice_office", 1, "MIZUHO 0001"),
      unknown: await staff.pay("invoice_missing", 1, "MIZUHO 0001"),
    };
    expect(refusals).toMatchObject({
      stale: rejectedWith({ code: "stale_resource_revision" }),
      unknown: rejectedWith({
        code: "resource_not_found",
        kind: "company_invoice",
      }),
    });
    expect(await staff.pay("invoice_office", 2, "MIZUHO 0001")).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "record_invoice_payment" },
    });
    expect(await staff.pay("invoice_office", 3, "MIZUHO 0002")).toMatchObject(
      rejectedWith({ field: "invoice.paid" }),
    );
    const paid = (await required(admin.listInvoices(merchantId)))[0];
    expect(paid?.state).toEqual({
      kind: "paid",
      paidAt: new Date(clock).toISOString(),
      reference: "MIZUHO 0001",
    });

    // Paid, a refund goes back as a bank transfer.
    expect(
      await staff.refund("order_office", line, "refund_late", 1_200),
    ).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "refund_order" },
    });

    const invoiceEvents = (
      await required(admin.readEvents(merchantId, { limit: 300 }))
    ).events
      .map((event) => event.kind)
      .filter((kind) => kind.startsWith("invoice."));
    expect(invoiceEvents).toEqual(["invoice.overdue", "invoice.paid"]);

    Object.assign(evidence, {
      receipts: staff.receipts,
      noTerms,
      issued,
      waits,
      refundBefore,
      overdue,
      refusals,
      paid,
      invoiceEvents,
    });
  } finally {
    writeEvidence("INVOICE_TERMS_ARTIFACT_DIR", "invoice-terms", evidence);
    backend.close();
  }
}

class TermsDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "invoice_terms");
  }

  createCustomer(customerId: string, email: string) {
    return this.apply(
      this.admin.createCustomer({
        ...this.editBase(`customer_${customerId}`),
        customerId,
        email,
        name: null,
        phone: null,
        note: null,
        tags: [],
      }),
    );
  }

  createCompany(
    companyId: string,
    customerIds: readonly string[],
    netDays: number,
  ) {
    return this.edit(
      this.admin.createCompany({
        ...this.editBase(`company_${companyId}`),
        companyId,
        name: "Shibuya Office Gifts",
        customerIds,
        prices: { currency: "JPY", items: [] },
        paymentTerms: { netDays },
      }),
    );
  }

  placeOnTerms(draftOrderId: string, expectedDraftOrderRevision: number) {
    const name = draftOrderId.replace("draft_", "");
    return this.edit(
      this.admin.placeDraftOrderOnTerms({
        ...this.editBase(`terms_${name}_${this.step}`),
        draftOrderId,
        expectedDraftOrderRevision,
        orderId: `order_${name}`,
        paymentId: `payment_${name}`,
        fulfillmentId: `fulfillment_${name}`,
        invoiceId: `invoice_${name}`,
      }),
    );
  }

  pay(invoiceId: string, expectedRevision: number, reference: string) {
    return this.edit(
      this.admin.recordInvoicePayment({
        // The transfer arrives on the day staff record it.
        ...this.editBase(`pay_${invoiceId}_${this.step}`),
        invoiceId,
        expectedRevision,
        reference,
      }),
    );
  }
}

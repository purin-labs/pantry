// Plan 76A step 2A: staff build a draft order with staff prices, send an
// invoice link, and the buyer pays it. The draft keeps its buyer's email only
// in a sealed customer record, so erasing the customer leaves no email behind.
// Set DRAFT_ORDER_ARTIFACT_DIR to keep the run's evidence; the file repeats
// byte for byte for the same commit.
import type {
  CommerceAdminClient,
  CommerceDraftOrderLineV1,
  CommerceDraftInvoiceV1,
  CommerceMutationResultV1,
  CommerceStorefrontClient,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  STOREFRONT,
  StaffDesk,
  jpy,
  merchantId,
  rejectedWith,
  rejectionOf,
  required,
  startBackend,
  usd,
  writeEvidence,
  type Evidence,
  type Quoted,
} from "./journey-support.ts";

const WEEK_LATER = "2026-08-21T10:00:00.000Z";

it(
  "turns a staff draft with staff prices into a paid order through its invoice link",
  { timeout: 60_000 },
  payDraftThroughInvoice,
);

async function payDraftThroughInvoice(): Promise<void> {
  const backend = await startBackend({ customers: true });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new DraftStaff(admin);
    await staff.createTea();

    // Staff draft an order for Kenji: a staff price on the small sencha, the
    // catalog price on the large one.
    const kenjiLines: readonly CommerceDraftOrderLineV1[] = [
      line("line_small", "variant_tea_small_sencha", 2, {
        unitPrice: jpy(1_000),
        reason: "Regular customer",
      }),
      line("line_large", "variant_tea_large_sencha", 1, null),
    ];
    expect(await staff.create("draft_kenji", kenjiLines)).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "create_draft_order",
        resource: { kind: "draft_order", id: "draft_kenji", revision: 1 },
      },
    });
    // Lines the storefront cannot sell, or staff prices in another currency,
    // are refused.
    expect(
      await staff.create("draft_unknown", [
        line("line_x", "variant_missing", 1, null),
      ]),
    ).toMatchObject(rejectedWith({ code: "resource_not_found" }));
    expect(
      await staff.create("draft_dollars", [
        line("line_x", "variant_tea_small_sencha", 1, {
          unitPrice: usd(800),
          reason: "Wrong currency",
        }),
      ]),
    ).toMatchObject(rejectedWith({ field: "draftOrder.lines.priceOverride" }));
    // Kenji wants three small tins.
    expect(
      await staff.update("draft_kenji", 1, [
        line("line_small", "variant_tea_small_sencha", 3, {
          unitPrice: jpy(1_000),
          reason: "Regular customer",
        }),
        kenjiLines[1]!,
      ]),
    ).toMatchObject({
      outcome: "applied",
      receipt: { resource: { revision: 2 } },
    });
    expect(await staff.update("draft_kenji", 1, kenjiLines)).toMatchObject(
      rejectedWith({ code: "stale_resource_revision" }),
    );

    const sent = await staff.sendInvoice("draft_kenji", 2);
    expect(sent.mutation).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "send_draft_invoice" },
    });
    const kenjiLink = sent.invoice?.token;
    if (kenjiLink === undefined) throw new Error("No invoice link was sent");

    // Kenji opens the link: the quote carries the staff price.
    const opened = await openInvoice(buyer, "draft_kenji", kenjiLink);
    expect(linePrices(opened.checkout)).toEqual({
      variant_tea_small_sencha: { quantity: 3, unitPrice: jpy(1_000) },
      variant_tea_large_sencha: { quantity: 1, unitPrice: jpy(1_800) },
    });
    // Opening the link again reaches the same checkout.
    const again = await openInvoice(buyer, "draft_kenji", kenjiLink);
    expect(again.checkout.checkoutId).toBe(opened.checkout.checkoutId);
    const kenji = new Buyer(buyer, "kenji", opened.session.token);
    // A refresh would price the lines from the catalog, so it is refused.
    expect(
      rejectionOf(
        await buyer.refreshPickupCheckout(
          merchantId,
          STOREFRONT,
          opened.checkout.checkoutId,
          opened.session.token,
          {
            schemaVersion: "commerce.refresh-buyer-pickup-checkout.v1",
            idempotencyKey: "kenji_refresh",
            checkoutRevision: opened.checkout.revision,
            quoteDigest: opened.checkout.quote.quoteDigest,
            lines: [
              {
                kind: "catalog",
                variantId: "variant_tea_small_sencha",
                quantity: 3,
              },
            ],
          },
        ),
      ),
    ).toMatchObject({ field: "checkout.draftOrder" });

    // Staff raise the catalog price of the large tin before Kenji pays. The
    // catalog-priced line must follow; the staff price stays.
    const large = await staff.offer("offer_tea_large_sencha");
    expect(
      await staff.updateOffer(large.id, large.revision, jpy(1_900)),
    ).toMatchObject({ outcome: "applied" });
    expect(await kenji.tryPay(opened.checkout)).toMatchObject({
      code: "checkout_refresh_required",
    });
    const requoted = await openInvoice(buyer, "draft_kenji", kenjiLink);
    expect(requoted.checkout.checkoutId).not.toBe(opened.checkout.checkoutId);
    expect(linePrices(requoted.checkout)).toEqual({
      variant_tea_small_sencha: { quantity: 3, unitPrice: jpy(1_000) },
      variant_tea_large_sencha: { quantity: 1, unitPrice: jpy(1_900) },
    });
    const kenjiOrder = await new Buyer(
      buyer,
      "kenji",
      requoted.session.token,
    ).pay(requoted.checkout);

    // The draft now names its order and can no longer change.
    const view = await required(
      admin.readDraftOrder(merchantId, "draft_kenji"),
    );
    expect(view.completion).toEqual({
      checkoutId: requoted.checkout.checkoutId,
      orderId: kenjiOrder,
    });
    expect(view.draftOrder.lines[0]?.priceOverride?.reason).toBe(
      "Regular customer",
    );
    expect(await staff.update("draft_kenji", 3, kenjiLines)).toMatchObject(
      rejectedWith({ field: "draftOrder.completed" }),
    );
    expect(
      await openInvoiceRefusal(buyer, "draft_kenji", kenjiLink),
    ).toMatchObject({ field: "draftOrder.completed" });
    const order = (await staff.orders()).find((item) => item.id === kenjiOrder);
    expect(
      order?.lineItems.map((item) => ({
        sku: item.sku,
        quantity: item.quantity.amount,
        unitPrice: item.unitPrice,
      })),
    ).toEqual([
      { sku: "TEA-S-SENCHA", quantity: 3, unitPrice: jpy(1_000) },
      { sku: "TEA-L-SENCHA", quantity: 1, unitPrice: jpy(1_900) },
    ]);

    // A change after sending reopens the draft, so the old link stops
    // working; a cancelled draft cannot be invoiced.
    await staff.create("draft_mai", [
      line("line_small", "variant_tea_small_hojicha", 1, null),
    ]);
    const maiSent = await staff.sendInvoice("draft_mai", 1);
    const maiLink = maiSent.invoice?.token;
    if (maiLink === undefined) throw new Error("No invoice link was sent");
    await staff.update("draft_mai", 2, [
      line("line_small", "variant_tea_small_hojicha", 2, null),
    ]);
    const staleLink = await buyer.openDraftInvoice(
      merchantId,
      STOREFRONT,
      "draft_mai",
      maiLink,
    );
    expect(staleLink).toMatchObject({ ok: false, error: { status: 410 } });
    // A new invoice for the changed draft: only the new link opens it.
    const maiResent = await staff.sendInvoice("draft_mai", 3);
    const maiNewLink = maiResent.invoice?.token;
    if (maiNewLink === undefined) throw new Error("No invoice link was sent");
    expect(
      await buyer.openDraftInvoice(
        merchantId,
        STOREFRONT,
        "draft_mai",
        maiLink,
      ),
    ).toMatchObject({ ok: false, error: { status: 410 } });
    const maiOpened = await openInvoice(buyer, "draft_mai", maiNewLink);
    expect(linePrices(maiOpened.checkout)).toEqual({
      variant_tea_small_hojicha: { quantity: 2, unitPrice: jpy(1_200) },
    });
    expect(await staff.cancel("draft_mai", 4)).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "cancel_draft_order" },
    });
    expect(
      await buyer.openDraftInvoice(
        merchantId,
        STOREFRONT,
        "draft_mai",
        maiNewLink,
      ),
    ).toMatchObject({ ok: false, error: { status: 410 } });
    expect((await staff.sendInvoice("draft_mai", 5)).mutation).toMatchObject(
      rejectedWith({
        code: "invalid_transition",
        machine: "draft_order",
        state: "cancelled",
        event: "send_invoice",
      }),
    );

    // Staff read Rin's email from the draft, but the stored draft holds none.
    // After Rin is erased, the draft has no buyer to invoice.
    await staff.create("draft_rin", [
      line("line_small", "variant_tea_small_hojicha", 1, null),
    ]);
    const rin = await required(admin.readDraftOrder(merchantId, "draft_rin"));
    expect(rin.draftOrder.buyer.email).toBe("rin@example.test");
    const rinCustomer = rin.draftOrder.buyer.customerId;
    if (rinCustomer === null) throw new Error("Rin's draft names no customer");
    const stored = backend.database
      .prepare(
        `SELECT draft_json AS draftJson FROM draft_order
         WHERE merchant_id = ? AND draft_order_id = ?`,
      )
      .get<Readonly<{ draftJson: string }>>(merchantId, "draft_rin");
    expect(stored?.draftJson).not.toContain("rin@example.test");
    expect(await staff.erase(rinCustomer)).toMatchObject({
      outcome: "applied",
    });
    const erased = await required(
      admin.readDraftOrder(merchantId, "draft_rin"),
    );
    expect(erased.draftOrder.buyer).toEqual({
      customerId: rinCustomer,
      email: null,
    });
    const rinLink = (await staff.sendInvoice("draft_rin", 1)).invoice?.token;
    if (rinLink === undefined) throw new Error("No invoice link was sent");
    expect(await openInvoiceRefusal(buyer, "draft_rin", rinLink)).toMatchObject(
      { field: "draftOrder.buyer.erased" },
    );

    Object.assign(evidence, {
      receipts: staff.receipts,
      firstQuote: linePrices(opened.checkout),
      requote: linePrices(requoted.checkout),
      orderLines: order?.lineItems.map((item) => ({
        sku: item.sku,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
      })),
      orderTotal: order?.totals.total,
      draft: view,
    });
  } finally {
    writeEvidence("DRAFT_ORDER_ARTIFACT_DIR", "draft-order", evidence);
    backend.close();
  }
}

class DraftStaff extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "draft_order");
  }

  async erase(customerId: string): Promise<CommerceMutationResultV1> {
    const customer = await required(
      this.admin.readCustomer(merchantId, customerId),
    );
    return this.edit(
      this.admin.eraseCustomer({
        ...this.editBase(`erase_${customerId}`),
        customerId,
        expectedRevision: customer.revision,
        reason: "Customer asked to be forgotten",
      }),
    );
  }

  create(
    draftOrderId: string,
    lines: readonly CommerceDraftOrderLineV1[],
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.createDraftOrder({
        ...this.editBase(`create_${draftOrderId}`),
        draftOrderId,
        storefrontId: STOREFRONT,
        ...contents(draftOrderId, lines),
      }),
    );
  }

  update(
    draftOrderId: string,
    expectedDraftOrderRevision: number,
    lines: readonly CommerceDraftOrderLineV1[],
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.updateDraftOrder({
        ...this.editBase(`update_${draftOrderId}_${this.step}`),
        draftOrderId,
        expectedDraftOrderRevision,
        ...contents(draftOrderId, lines),
      }),
    );
  }

  cancel(
    draftOrderId: string,
    expectedDraftOrderRevision: number,
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.cancelDraftOrder({
        ...this.editBase(`cancel_${draftOrderId}`),
        draftOrderId,
        expectedDraftOrderRevision,
      }),
    );
  }

  async sendInvoice(
    draftOrderId: string,
    expectedDraftOrderRevision: number,
  ): Promise<CommerceDraftInvoiceV1> {
    const sent = await required(
      this.admin.sendDraftInvoice({
        ...this.editBase(`invoice_${draftOrderId}_${this.step}`),
        draftOrderId,
        expectedDraftOrderRevision,
        expiresAt: WEEK_LATER,
      }),
    );
    await this.edit(Promise.resolve({ ok: true, value: sent.mutation }));
    return sent;
  }

  updateOffer(
    offerId: string,
    expectedOfferRevision: number,
    price: ReturnType<typeof jpy>,
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.updateOffer({
        ...this.editBase(`offer_${this.step}`),
        offerId,
        expectedOfferRevision,
        changes: { price },
      }),
    );
  }

  async offer(offerId: string) {
    const offer = (await this.snapshot()).offers.find(
      (candidate) => candidate.id === offerId,
    );
    if (offer === undefined) throw new Error(`${offerId} is missing`);
    return offer;
  }

  async orders() {
    return (await this.snapshot()).orders;
  }
}

function contents(
  draftOrderId: string,
  lines: readonly CommerceDraftOrderLineV1[],
) {
  return {
    lines,
    buyer: { email: `${draftOrderId.replace("draft_", "")}@example.test` },
    note: "Collect at the counter.",
    tags: ["phone order"],
  };
}

function line(
  lineId: string,
  variantId: string,
  quantity: number,
  priceOverride: CommerceDraftOrderLineV1["priceOverride"],
): CommerceDraftOrderLineV1 {
  return { lineId, variantId, quantity, priceOverride };
}

function openInvoice(
  buyer: CommerceStorefrontClient,
  draftOrderId: string,
  token: string,
) {
  return required(
    buyer.openDraftInvoice(merchantId, STOREFRONT, draftOrderId, token),
  );
}

async function openInvoiceRefusal(
  buyer: CommerceStorefrontClient,
  draftOrderId: string,
  token: string,
) {
  return rejectionOf(
    await buyer.openDraftInvoice(merchantId, STOREFRONT, draftOrderId, token),
  );
}

function linePrices(checkout: Quoted) {
  return Object.fromEntries(
    checkout.quote.lines.map((item) => [
      item.kind === "order_balance" ? item.orderId : item.variantId,
      { quantity: item.quantity, unitPrice: item.unitPrice },
    ]),
  );
}

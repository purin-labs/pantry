// A shop in Japan lists its prices with the 8% tax inside them. Staff switch
// the café storefront to an included tax; a buyer then pays the listed
// price, and the order keeps the tax as a part of it. A refund of the whole
// order gives back what the buyer paid and nothing more, and a refund that
// names the tax on top of the lines is refused. Set
// INCLUDED_TAX_ARTIFACT_DIR to keep the run's evidence.
import {
  type CommerceBuyerSessionV4,
  type CommerceStorefrontClient,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  STOREFRONT,
  catalogLine,
  jpy,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { LARGE_SENCHA, OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

it(
  "charges listed prices that include 8% tax and refunds what the buyer paid",
  { timeout: 60_000 },
  includedTax,
);

async function includedTax(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new OrderDesk(admin, "included_tax");
    await staff.createTea();

    // Staff make the listed prices include 8% tax.
    const before = await storefrontRevision(buyer);
    const included = await required(
      admin.updateStorefrontTax({
        merchantId,
        idempotencyKey: "included_tax_8",
        storefrontId: STOREFRONT,
        expectedStorefrontRevision: before,
        tax: { kind: "percentage", basisPoints: 800, inclusion: "included" },
      }),
    );
    expect(included).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "update_storefront_tax",
        resource: { kind: "storefront", id: STOREFRONT, revision: before + 1 },
      },
    });
    // A second change that names the old revision is refused.
    expect(
      await required(
        admin.updateStorefrontTax({
          merchantId,
          idempotencyKey: "included_tax_stale",
          storefrontId: STOREFRONT,
          expectedStorefrontRevision: before,
          tax: { kind: "percentage", basisPoints: 1_000 },
        }),
      ),
    ).toMatchObject({
      outcome: "rejected",
      error: { code: "stale_resource_revision" },
    });

    // Aiko buys two large tins and one small tin. She pays the listed
    // prices; the tax is the part of them above the net amount.
    const aiko = await Buyer.start(buyer, "included_aiko");
    const lines = [
      { ...catalogLine(LARGE_SENCHA), quantity: 2 },
      catalogLine(SMALL_SENCHA),
    ];
    const quoted = await aiko.quote(lines);
    const totals = quoted.quote.totals;
    const subtotal = totals.subtotal.amountMinor;
    expect(totals.taxIncluded).toBe(true);
    expect(totals.total).toEqual(jpy(subtotal));
    expect(totals.tax).toEqual(jpy(Math.round((subtotal * 800) / 10_800)));
    const orderId = await aiko.pay(quoted);
    const order = await staff.order(orderId);
    expect(order.totals.taxIncluded).toBe(true);
    expect(order.totals.total).toEqual(jpy(subtotal));
    expect(
      order.lineItems.reduce((sum, line) => sum + line.tax.amountMinor, 0),
    ).toBe(totals.tax.amountMinor);

    // Tax named on top of a line refund is refused.
    const [first, second] = order.lineItems;
    if (first === undefined || second === undefined)
      throw new Error("Aiko's order needs two lines");
    expect(
      await staff.refundWithTax(orderId, first.id, "refund_aiko_tax", {
        line: first.lineTotal.amountMinor,
        tax: first.tax.amountMinor,
      }),
    ).toMatchObject({
      outcome: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "refund.relationships",
      },
    });

    // A refund of every line gives back what Aiko paid, and then nothing is
    // left to refund.
    expect(
      await staff.refundLines(orderId, "refund_aiko_all", [
        { orderLineId: first.id, amountMinor: first.lineTotal.amountMinor },
        { orderLineId: second.id, amountMinor: second.lineTotal.amountMinor },
      ]),
    ).toMatchObject({ outcome: "applied" });
    expect(
      await staff.refundLines(orderId, "refund_aiko_more", [
        { orderLineId: first.id, amountMinor: 1 },
      ]),
    ).toMatchObject({ outcome: "rejected" });

    // Ren's order is cancelled before pickup; the cancellation refunds the
    // listed prices that Ren paid.
    const ren = await Buyer.start(buyer, "included_ren");
    const renOrder = await ren.buyLines([catalogLine(SMALL_SENCHA)]);
    expect(await staff.cancel(renOrder)).toMatchObject({ outcome: "applied" });

    evidence.quote = totals;
    evidence.order = order.totals;
    evidence.receipts = staff.receipts;
    writeEvidence("INCLUDED_TAX_ARTIFACT_DIR", "included-tax", evidence);
  } finally {
    backend.close();
  }
}

async function storefrontRevision(
  client: CommerceStorefrontClient,
): Promise<number> {
  const session: CommerceBuyerSessionV4 = await required(
    client.createSession(merchantId, STOREFRONT, {
      schemaVersion: "underclerk.create-buyer-session.v1",
      buyer: { kind: "guest" },
    }),
  );
  return session.storefrontRevision;
}

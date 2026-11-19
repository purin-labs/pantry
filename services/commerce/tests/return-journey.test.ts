// Plan 76A step 2C: a buyer returns part of a collected order; staff
// authorize, receive, restock, refund with a restocking fee and close the
// return. Set RETURN_ARTIFACT_DIR to keep the run's evidence; the file
// repeats byte for byte for the same commit.
import type {
  AuthorizeCommerceReturnV1,
  ReceiveCommerceReturnV1,
  CommerceAdminClient,
  CommerceMutationResultV1,
  CommerceReturnRequestLineV1,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  LOCATION,
  NOW,
  STOREFRONT,
  StaffDesk,
  catalogLine,
  jpy,
  merchantId,
  rejectedWith,
  rejectionOf,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const TEA_POSITION = "position_tea_tin_cafe";

it(
  "returns part of a collected order with restock, a restocking fee and a refund",
  { timeout: 60_000 },
  returnPartOfAnOrder,
);

async function returnPartOfAnOrder(): Promise<void> {
  let clock = NOW;
  const backend = await startBackend({ now: () => clock });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new ReturnStaff(admin);
    await staff.createTea();

    // Lin buys three small tins and one large tin, and collects them.
    const lin = await Buyer.start(buyer, "lin");
    const orderId = await lin.buyLines([
      { ...catalogLine("variant_tea_small_sencha"), quantity: 3 },
      catalogLine("variant_tea_large_sencha"),
    ]);
    const placement = lin.lastPlacement;
    if (placement === undefined) throw new Error("Lin's order has no recovery");
    expect(
      await staff.requestReturn("return_early", orderId, [
        returnLine(await staff.lineId(orderId, "TEA-S-SENCHA"), 1, "Too early"),
      ]),
    ).toMatchObject(
      rejectedWith({
        code: "invalid_transition",
        machine: "order",
        state: "fulfillment_pending",
        event: "request_return",
      }),
    );
    await staff.collect(orderId);
    expect(await staff.stock()).toBe(40 - 4);
    const small = await staff.lineId(orderId, "TEA-S-SENCHA");
    const large = await staff.lineId(orderId, "TEA-L-SENCHA");

    // Lin asks, with the order link, to return two small tins and the large.
    const requested = await required(
      buyer.requestReturn(
        merchantId,
        STOREFRONT,
        placement.checkoutId,
        placement.recoveryToken,
        {
          schemaVersion: "underclerk.request-buyer-return.v1",
          idempotencyKey: "lin_return",
          lines: [
            returnLine(small, 2, "Dented tins"),
            returnLine(large, 1, "Changed my mind"),
          ],
        },
      ),
    );
    expect(requested).toMatchObject({
      orderId,
      requestedBy: "buyer",
      lifecycle: { state: "requested" },
    });
    // The same request again returns the same return.
    const repeated = await required(
      buyer.requestReturn(
        merchantId,
        STOREFRONT,
        placement.checkoutId,
        placement.recoveryToken,
        {
          schemaVersion: "underclerk.request-buyer-return.v1",
          idempotencyKey: "lin_return",
          lines: [
            returnLine(small, 2, "Dented tins"),
            returnLine(large, 1, "Changed my mind"),
          ],
        },
      ),
    );
    expect(repeated.id).toBe(requested.id);
    // Lin cannot return more small tins than remain unreturned.
    expect(
      rejectionOf(
        await buyer.requestReturn(
          merchantId,
          STOREFRONT,
          placement.checkoutId,
          placement.recoveryToken,
          {
            schemaVersion: "underclerk.request-buyer-return.v1",
            idempotencyKey: "lin_return_more",
            lines: [returnLine(small, 2, "More dents")],
          },
        ),
      ),
    ).toMatchObject({ field: "return.lines.quantity" });
    // A request after the thirty-day window is refused.
    clock = "2026-09-14T10:00:01.000Z";
    expect(
      await staff.requestReturn("return_late", orderId, [
        returnLine(small, 1, "Late"),
      ]),
    ).toMatchObject(rejectedWith({ field: "return.window" }));
    clock = NOW;

    // Staff authorize the dented tins and reject the change of mind.
    expect(
      await staff.authorize(requested.id, 1, [
        { orderLineId: small, decision: "authorized" },
        { orderLineId: large, decision: "rejected" },
      ]),
    ).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "authorize_return", resource: { revision: 2 } },
    });
    // The receipt must name exactly the authorized lines.
    expect(
      await staff.receive(requested.id, 2, [
        { orderLineId: small, disposition: "restock" },
        { orderLineId: large, disposition: "restock" },
      ]),
    ).toMatchObject(rejectedWith({ field: "return.dispositions" }));
    expect(
      await staff.receive(requested.id, 2, [
        { orderLineId: small, disposition: "restock" },
      ]),
    ).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "receive_return" },
    });
    // Both restocked tins are on hand again.
    expect(await staff.stock()).toBe(40 - 4 + 2);

    // Staff refund the two tins less a 200 yen restocking fee, with tax.
    const refund = await staff.refund(orderId, small, 2 * 1_200 - 200, 220);
    expect(refund).toMatchObject({ outcome: "applied" });
    const refundAttemptId = "refund_return_lin";
    // A return cannot close on a refund that does not exist.
    expect(await staff.close(requested.id, 3, "refund_missing")).toMatchObject(
      rejectedWith({ code: "resource_not_found" }),
    );
    expect(await staff.close(requested.id, 3, refundAttemptId)).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "close_return", resource: { revision: 4 } },
    });

    // The last small tin can still be returned, once.
    expect(
      await staff.requestReturn("return_last", orderId, [
        returnLine(small, 1, "One more dent"),
      ]),
    ).toMatchObject({ outcome: "applied" });
    expect(
      await staff.requestReturn("return_extra", orderId, [
        returnLine(small, 1, "Another"),
      ]),
    ).toMatchObject(rejectedWith({ field: "return.lines.quantity" }));
    await staff.authorize("return_last", 1, [
      { orderLineId: small, decision: "authorized" },
    ]);
    // Damaged on arrival: no stock comes back.
    await staff.receive("return_last", 2, [
      { orderLineId: small, disposition: "damage" },
    ]);
    expect(await staff.stock()).toBe(40 - 4 + 2);
    // One refund settles one return only.
    expect(await staff.close("return_last", 3, refundAttemptId)).toMatchObject(
      rejectedWith({ field: "return.refund.used" }),
    );
    expect(await staff.close("return_last", 3, null)).toMatchObject({
      outcome: "applied",
    });

    const returns = await required(admin.listOrderReturns(merchantId, orderId));
    const byId = (left: { id: string }, right: { id: string }) =>
      left.id.localeCompare(right.id);
    expect(
      returns.map((item) => ({
        id: item.id,
        state: item.lifecycle.state,
        lines: item.lines.map((line) => [
          line.quantity,
          line.decision,
          line.disposition,
        ]),
      })),
    ).toEqual(
      [
        {
          id: "return_last",
          state: "closed",
          lines: [[1, "authorized", "damage"]],
        },
        {
          id: requested.id,
          state: "closed",
          lines: [
            [2, "authorized", "restock"],
            [1, "rejected", null],
          ],
        },
      ].sort(byId),
    );
    const payment = await staff.payment(orderId);
    expect(payment?.lifecycle).toMatchObject({
      state: "partially_refunded",
      refundedAmount: jpy(2_200 + 220),
    });

    Object.assign(evidence, {
      receipts: staff.receipts,
      returns,
      stockOnHand: await staff.stock(),
      payment,
    });
  } finally {
    writeEvidence("RETURN_ARTIFACT_DIR", "return", evidence);
    backend.close();
  }
}

class ReturnStaff extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "return");
  }

  async payment(orderId: string) {
    return (await this.snapshot()).payments.find(
      (item) => item.orderId === orderId,
    );
  }

  async lineId(orderId: string, sku: string): Promise<string> {
    const order = (await this.snapshot()).orders.find(
      (item) => item.id === orderId,
    );
    const line = order?.lineItems.find((item) => item.sku === sku);
    if (line === undefined) throw new Error(`${orderId} has no ${sku} line`);
    return line.id;
  }

  async stock(): Promise<number | undefined> {
    const position = (await this.snapshot()).inventoryPositions.find(
      (item) => item.id === TEA_POSITION,
    );
    return position?.balance.kind === "accounted"
      ? position.balance.onHand.amount
      : undefined;
  }

  /** Staff hand over a paid pickup order: ready, then collected. */
  async collect(orderId: string): Promise<void> {
    for (const step of ["ready", "complete"] as const) {
      const resources = await this.snapshot();
      const order = resources.orders.find((item) => item.id === orderId);
      const fulfillment = resources.fulfillments.find(
        (item) => item.orderId === orderId,
      );
      const payment = resources.payments.find(
        (item) => item.orderId === orderId,
      );
      if (
        order === undefined ||
        fulfillment === undefined ||
        payment === undefined
      )
        throw new Error(`${orderId} is incomplete`);
      const target = {
        ...(await this.base(`pickup_${step}`)),
        orderId,
        orderRevision: order.revision,
        fulfillmentId: fulfillment.id,
        fulfillmentRevision: fulfillment.revision,
      };
      await this.apply(
        step === "ready"
          ? this.admin.markPickupReady({
              ...target,
            })
          : this.admin.completePickup({
              ...target,
              paymentId: payment.id,
              paymentRevision: payment.revision,
            }),
      );
    }
  }

  requestReturn(
    returnId: string,
    orderId: string,
    lines: readonly CommerceReturnRequestLineV1[],
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.requestReturn({
        ...this.editBase(`request_${returnId}`),
        returnId,
        orderId,
        lines,
      }),
    );
  }

  authorize(
    returnId: string,
    expectedReturnRevision: number,
    decisions: AuthorizeCommerceReturnV1["decisions"],
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.authorizeReturn({
        ...this.editBase(`authorize_${returnId}_${this.step}`),
        returnId,
        expectedReturnRevision,
        decisions,
      }),
    );
  }

  receive(
    returnId: string,
    expectedReturnRevision: number,
    dispositions: ReceiveCommerceReturnV1["dispositions"],
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.receiveReturn({
        ...this.editBase(`receive_${returnId}_${this.step}`),
        returnId,
        expectedReturnRevision,
        locationId: LOCATION,
        dispositions,
      }),
    );
  }

  close(
    returnId: string,
    expectedReturnRevision: number,
    refundAttemptId: string | null,
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.closeReturn({
        ...this.editBase(`close_${returnId}_${this.step}`),
        returnId,
        expectedReturnRevision,
        refundAttemptId,
      }),
    );
  }

  async refund(
    orderId: string,
    orderLineId: string,
    lineMinor: number,
    taxMinor: number,
  ): Promise<CommerceMutationResultV1> {
    const resources = await this.snapshot();
    const order = resources.orders.find((item) => item.id === orderId);
    const payment = resources.payments.find((item) => item.orderId === orderId);
    if (order === undefined || payment === undefined)
      throw new Error(`${orderId} is incomplete`);
    return this.edit(
      this.admin.refundOrder({
        ...(await this.base("refund")),
        orderId,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId: "refund_return_lin",
        refundPolicyId: "refund_policy_standard",
        amount: jpy(lineMinor + taxMinor),
        allocation: {
          lineAllocations: [{ orderLineId, amount: jpy(lineMinor) }],
          taxAllocations: [{ orderLineId, amount: jpy(taxMinor) }],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason: "Returned dented tins, less a restocking fee",
      }),
    );
  }
}

function returnLine(
  orderLineId: string,
  quantity: number,
  reason: string,
): CommerceReturnRequestLineV1 {
  return { orderLineId, quantity, reason };
}

// The order list, as staff read it on the Orders page: when each order was
// placed and what it costs now. Staff add a tin to Aki's order twenty minutes
// after Aki paid. The list keeps the time that Aki placed the order and shows
// the new total. An order that the engine stored before orders kept their
// placed time still shows it, from its checkout. Set ORDER_LIST_ARTIFACT_DIR
// to keep the evidence.
import {
  CommerceEntityPlaneClient,
  type CommerceAdminClient,
} from "@purin-labs/commerce-client";
import type { CommerceEntity } from "@purin-labs/commerce-contracts";
import { expect, it } from "vitest";

import {
  BASE_URL,
  Buyer,
  NOW,
  SERVICE_TOKEN,
  StaffDesk,
  catalogLine,
  merchantId,
  startBackend,
  writeEvidence,
} from "./journey-support.ts";

const SMALL_SENCHA = "variant_tea_small_sencha";
const LARGE_SENCHA = "variant_tea_large_sencha";
const START = Date.parse(NOW);

class OrderListDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "order_list");
  }

  async addLargeTin(orderId: string): Promise<void> {
    const result = await this.edit(
      this.admin.editOrder({
        ...this.editBase(`edit_${orderId}`),
        editId: `edit_${orderId}`,
        orderId,
        expectedOrderRevision: 1,
        lineChanges: [],
        additions: [{ variantId: LARGE_SENCHA, quantity: 1 }],
        reason: "Buyer asked by phone",
      }),
    );
    if (result.outcome !== "applied")
      throw new Error(`The edit did not apply: ${JSON.stringify(result)}`);
  }

  async revision(orderId: string): Promise<number> {
    const order = (await this.snapshot()).orders.find(
      (item) => item.id === orderId,
    );
    if (order === undefined) throw new Error(`${orderId} is missing`);
    return order.revision;
  }
}

/** What the Orders page shows for one order. */
function listed(entity: CommerceEntity) {
  const value = (attributeId: string) =>
    entity.attributes.find((attribute) => attribute.attributeId === attributeId)
      ?.value;
  const placed = value("placed_at");
  const total = value("total");
  const lifecycle = value("lifecycle");
  return {
    id: entity.reference.entityId,
    placedAt: placed?.kind === "timestamp" ? placed.value : null,
    total:
      total?.kind === "money"
        ? `${total.value.amountMinor} ${total.value.currency}`
        : null,
    lifecycle: lifecycle?.kind === "status" ? String(lifecycle.value) : null,
  };
}

it(
  "lists when each order was placed and its total after staff edit it",
  { timeout: 120_000 },
  async () => {
    let clock = START;
    const at = (minutes: number): string =>
      new Date(START + minutes * 60_000).toISOString();
    const backend = await startBackend({
      now: () => new Date(clock).toISOString(),
    });
    try {
      const desk = new OrderListDesk(backend.admin);
      await desk.createTea();
      const graph = new CommerceEntityPlaneClient({
        baseUrl: BASE_URL,
        serviceToken: SERVICE_TOKEN,
        fetch: backend.fetch,
      });
      const place = async (name: string, minutes: number): Promise<string> => {
        clock = START + minutes * 60_000;
        const buyer = await Buyer.start(backend.buyer, name);
        return buyer.buyLines([catalogLine(SMALL_SENCHA)]);
      };
      const orderList = async () => {
        const result = await graph.query(merchantId, {
          kind: "entity_type_page",
          entityTypeId: { origin: "system", typeId: "order" },
          filter: { kind: "all" },
          sorts: [],
          pagination: { limit: 20, cursor: null },
          traversal: { maxDepth: 0, resultLimit: 20 },
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.value.entities
          .map(listed)
          .sort((left, right) => left.id.localeCompare(right.id));
      };

      const aki = await place("list_aki", 0);
      const ben = await place("list_ben", 5);
      clock = START + 20 * 60_000;
      await desk.addLargeTin(aki);
      expect(await desk.revision(aki)).toBe(2);

      // Aki's order costs more now, and still says when Aki placed it.
      const afterEdit = await orderList();
      expect(afterEdit).toEqual(
        [
          {
            id: aki,
            placedAt: at(0),
            total: "3300 JPY",
            lifecycle: "fulfillment_pending",
          },
          {
            id: ben,
            placedAt: at(5),
            total: "1320 JPY",
            lifecycle: "fulfillment_pending",
          },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );

      // Ben's order as the engine stored it before orders kept their placed
      // time. The next order that the shop takes brings the list up to date,
      // and Ben's placed time comes from the checkout that Ben paid.
      backend.database
        .prepare(
          `UPDATE commerce_order
              SET order_snapshot_json = json_remove(order_snapshot_json, '$.placedAt')
            WHERE merchant_id = ? AND resource_id = ?`,
        )
        .run(merchantId, ben);
      const cho = await place("list_cho", 30);
      const afterOldOrder = await orderList();
      expect(afterOldOrder.map((order) => [order.id, order.placedAt])).toEqual(
        [
          [aki, at(0)],
          [ben, at(5)],
          [cho, at(30)],
        ].sort((left, right) =>
          String(left[0]).localeCompare(String(right[0])),
        ),
      );

      writeEvidence("ORDER_LIST_ARTIFACT_DIR", "order-list", {
        afterEdit,
        afterOldOrder,
      });
    } finally {
      backend.close();
    }
  },
);

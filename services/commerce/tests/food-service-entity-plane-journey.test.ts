// Plan 77 step 6: the entity plane reads the food-service plugin's entity
// types through what the plugin contributes. A buyer orders a latte; the
// barista opens, starts and completes its preparation ticket. After each
// step the entity plane shows the ticket at its latest revision, with the
// lifecycle that the step set. A stock policy whose reorder point is over the
// stock reads as low stock. Set FOOD_SERVICE_ENTITY_PLANE_ARTIFACT_DIR to keep
// the run's evidence; the file repeats byte for byte for the same commit.
import {
  CommerceEntityPlaneClient,
  parseCommerceGraphQuery,
  type CommerceAdminClient,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import {
  BASE_URL,
  Buyer,
  LOCATION,
  NOW,
  SERVICE_TOKEN,
  StaffDesk,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const POLICY = "stock_policy_tea_tin_cafe";
const TICKET = "preparation_ticket_latte_journey";
const LATTE = {
  kind: "menu" as const,
  menuId: "menu_cafe_main",
  menuEntryId: "menu_entry_sesame_latte",
  modifierOptionIds: [],
  quantity: 1,
};

type SystemType = "stock_policy" | "preparation_ticket";

it(
  "reads food-service entities at their latest revision through the plugin's contribution",
  { timeout: 60_000 },
  foodServiceEntityPlane,
);

async function foodServiceEntityPlane(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const staff = new KitchenDesk(backend.admin);
    await staff.createTea();
    const plane = new CommerceEntityPlaneClient({
      baseUrl: BASE_URL,
      serviceToken: SERVICE_TOKEN,
      fetch: backend.fetch,
    });
    const read = async (typeId: SystemType, entityId: string) => {
      const result = await plane.query(
        merchantId,
        parseCommerceGraphQuery({
          kind: "entity_by_ref",
          reference: { origin: "system", typeId, entityId },
          traversal: { maxDepth: 0, resultLimit: 25 },
          filter: null,
        }),
      );
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const entity = result.value.entities[0];
      if (entity === undefined) throw new Error(`${entityId} is missing`);
      return {
        revision: entity.revision,
        attributes: Object.fromEntries(
          entity.attributes.map((attribute) => [
            attribute.attributeId,
            "value" in attribute.value ? attribute.value.value : null,
          ]),
        ),
      };
    };

    // 1. A reorder point over the 40 tins in stock reads as low stock.
    expect(await staff.policy(60)).toMatchObject({ outcome: "applied" });
    const policy = await read("stock_policy", POLICY);
    expect(policy).toEqual({
      revision: 1,
      attributes: { lifecycle: "active", low_stock: true },
    });

    // 2. The latte's ticket at each step of the bar.
    const orderId = await (
      await Buyer.start(backend.buyer, "entity_plane_latte")
    ).buyLines([LATTE]);
    const ticket: Record<string, unknown> = {};
    expect(await staff.ticket("create", orderId)).toMatchObject({
      outcome: "applied",
    });
    ticket.created = await read("preparation_ticket", TICKET);
    expect(await staff.ticket("start", orderId, 1)).toMatchObject({
      outcome: "applied",
    });
    ticket.started = await read("preparation_ticket", TICKET);
    expect(await staff.ticket("complete", orderId, 2)).toMatchObject({
      outcome: "applied",
    });
    ticket.completed = await read("preparation_ticket", TICKET);
    expect(ticket).toEqual({
      created: { revision: 1, attributes: { lifecycle: "queued" } },
      started: { revision: 2, attributes: { lifecycle: "preparing" } },
      completed: { revision: 3, attributes: { lifecycle: "completed" } },
    });

    Object.assign(evidence, { policy, ticket });
  } finally {
    writeEvidence(
      "FOOD_SERVICE_ENTITY_PLANE_ARTIFACT_DIR",
      "food-service-entity-plane",
      evidence,
    );
    backend.close();
  }
}

class KitchenDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "food_service_entity_plane");
  }

  async policy(reorderPoint: number) {
    const snapshot = await required(this.admin.readSnapshot(merchantId));
    return this.edit(
      this.admin.configureStockPolicy({
        merchantId,
        expectedMerchantRevision: snapshot.merchantRevision,
        idempotencyKey: "entity_plane_policy",
        stockPolicy: {
          stockPolicyId: POLICY,
          inventoryItemId: "inventory_tea_tin",
          locationId: LOCATION,
          replenishment: {
            kind: "threshold",
            reorderPoint: { amount: reorderPoint, scale: 0, unit: "each" },
            targetQuantity: {
              amount: reorderPoint * 2,
              scale: 0,
              unit: "each",
            },
          },
        },
      }),
    );
  }

  async ticket(
    step: "create" | "start" | "complete",
    orderId: string,
    expectedTicketRevision?: number,
  ) {
    const snapshot = await required(this.admin.readSnapshot(merchantId));
    const fulfillment = snapshot.resources.fulfillments.find(
      (item) => item.orderId === orderId,
    );
    if (fulfillment === undefined)
      throw new Error("The latte has no fulfillment");
    const key = `entity_plane_ticket_${step}`;
    return this.edit(
      this.admin.managePreparationTicket({
        merchantId,
        expectedMerchantRevision: snapshot.merchantRevision,
        idempotencyKey: key,
        operation:
          step === "create"
            ? {
                kind: "create",
                ticketId: TICKET,
                orderId,
                fulfillmentId: fulfillment.id,
                stationId: "station_bar",
              }
            : {
                kind: step,
                ticketId: TICKET,
                expectedTicketRevision: expectedTicketRevision ?? 1,
              },
      }),
    );
  }
}

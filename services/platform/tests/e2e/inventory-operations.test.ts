import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { commerceCommandInput } from "@purin-labs/commerce-client";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { parseInventory, type Quantity } from "@purin-labs/commerce-contracts";
import {
  parseInventoryReceiptContext,
  parseInventoryProductionContext,
  parseProductionDemand,
  type InventoryReceiptContext,
  type InventoryProductionCreation,
} from "@purin-labs/kitchen-control-api";
import {
  CommerceAdminClient,
  CommerceEntityPlaneClient,
  parseCommerceGraphQuery,
  parseEntityPlaneCommand,
  type CommerceStockSnapshot,
  type CommerceMutationResultV1,
  type CommerceClientResult,
} from "@purin-labs/commerce-client";
import type { Env } from "@purin-labs/kernel/env";
import { ensureCreatedOrganisationActor } from "@purin-labs/agent/control/organisation-runtime";
import { runScheduledCommerceOutboxReconciliation } from "../../src/commerce/outbox-worker";
import { handleInventoryProduction } from "../../src/control/routes/inventory-production";
import { handleInventoryReceipt } from "../../src/control/routes/inventory-receipts";
import {
  commerceClient,
  commerceWorkspace,
  commerceHeaders,
  connectCommerceFixture,
} from "./commerce-support";
import { placePickupOrder } from "./cafe-order-support";

// About 80 s on a laptop. A CI runner drains one queue message a second and
// passed 180 s (2026-11-21), so the limit leaves about five times the local time.
it(
  "reconciles supplier deliveries, counts, linked production and fulfilled or cancelled orders",
  { timeout: 420_000 },
  inventoryJourney,
);

async function inventoryJourney(context: TestContext): Promise<void> {
  const owner = await commerceClient(`inventory-owner-${crypto.randomUUID()}`);
  const foreign = await commerceClient(
    `inventory-foreign-${crypto.randomUUID()}`,
  );
  const viewer = await commerceClient(
    `inventory-viewer-${crypto.randomUUID()}`,
  );
  const organisationId = await commerceWorkspace(
    owner,
    "Inventory operations acceptance",
  );
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_bakery_c3_inventory_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, 'person_inventory_viewer', 'Viewer')",
      )
      .bind(organisationId),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, 'person_inventory_viewer', 'viewer', 'active', ?, NULL)",
      )
      .bind(organisationId, viewer.identity.userId, Date.now()),
  ]);
  const journey = new InventoryJourney(
    organisationId,
    merchantId,
    owner.session,
  );
  await required(
    journey.native.provisionDemo({
      schemaVersion: "commerce.provision-demo.v2",
      externalReference: organisationId,
      merchantId,
      profile: "cafe_patisserie",
      createdAt: journey.now,
    }),
  );
  const original = await journey.stock();
  const recipe =
    original.foodService.resources.recipeRevisions.find(sesameRecipe);
  if (recipe === undefined || recipe.output.kind !== "stocked")
    throw new Error("Production fixture recipe missing");
  const flour = recipe.inputs[0];
  if (flour === undefined) throw new Error("Recipe inputs missing");
  // The café starts this journey with no usable flour, so one request covers
  // each purchasing cycle.
  for (const lot of (await journey.context(flour.inventoryItemId)).lots) {
    if (lot.quantity.amount === 0) continue;
    await journey.adjustLot(
      flour.inventoryItemId,
      lot.id,
      "decrease",
      "waste",
      lot.quantity.amount / 10 ** lot.quantity.scale,
    );
  }
  const flourContext = await journey.context(flour.inventoryItemId);
  const current = flourContext.onHandQuantity;
  if (current === null || current.unit !== flour.quantity.unit)
    throw new Error("Fixture flour balance missing");
  const usableFlour = (await journey.stock()).usable.find(
    usableForPosition.bind(null, flourContext.inventoryPositionId),
  );
  if (usableFlour === undefined)
    throw new Error("Usable flour quantity missing");
  const currentAmount =
    usableFlour.quantity.amount / 10 ** usableFlour.quantity.scale;
  const batchAmount = flour.quantity.amount / 10 ** flour.quantity.scale;
  await applied(
    journey.native.configureStockPolicy({
      ...(await journey.base("flour-policy")),
      stockPolicy: {
        stockPolicyId: "policy_flour",
        inventoryItemId: flour.inventoryItemId,
        locationId: "location_cafe",
        replenishment: {
          kind: "threshold",
          reorderPoint: {
            amount: currentAmount + batchAmount,
            scale: 0,
            unit: current.unit,
          },
          targetQuantity: {
            amount: currentAmount + 2 * batchAmount,
            scale: 0,
            unit: current.unit,
          },
        },
      },
    }),
  );
  await journey.write("/purchasing/activate", {});
  await journey.write("/suppliers", {
    supplierId: "supplier_flour",
    displayName: "Acceptance mill",
    legalName: "Acceptance mill",
    countryCode: "JP",
    contactName: null,
    email: "mill@example.test",
    phone: null,
    leadTimeDays: 3,
    minimumOrderQuantity: "1",
    minimumOrderUnit: "bag",
    purchasingNotes: null,
    inventoryItemIds: [flour.inventoryItemId],
  });
  let purchasing = await journey.context(flour.inventoryItemId);
  if (
    purchasing.purchases.kind !== "ready" ||
    purchasing.purchases.entries.length !== 1
  )
    throw new Error(
      "Replenishment fixture did not open exactly one requirement",
    );
  const purchase = purchasing.purchases.entries[0];
  if (purchase === undefined) throw new Error("Purchase request missing");
  await verifyPurchasePagination(journey, flour.inventoryItemId);
  purchasing = await journey.context(flour.inventoryItemId);
  const first = journey.receipt(purchasing, flour.quantity, "flour-partial", {
    kind: "replenishment",
    entryId: purchase.id,
    entryRevision: purchase.revision,
  });
  const firstResult = await journey.write(
    "/inventory/receipts",
    first,
    "flour-partial",
  );
  expect(
    await journey.write("/inventory/receipts", first, "flour-partial"),
  ).toEqual(firstResult);
  expect(await journey.error("/inventory/receipts", first)).toMatchObject({
    error: "inventory_receipt_already_applied",
  });
  const partial = await journey.context(flour.inventoryItemId);
  if (partial.purchases.kind !== "ready")
    throw new Error("Partial purchase unavailable");
  expect(partial.purchases.entries).toHaveLength(1);
  expect(partial.purchases.entries[0]?.received).toBe(String(batchAmount));
  expect(partial.purchases.entries[0]?.required).toBe(String(batchAmount * 2));
  await journey.write(
    "/inventory/receipts",
    journey.receipt(partial, flour.quantity, "flour-unrelated", {
      kind: "unlinked",
    }),
  );
  await journey.write("/purchasing/reconcile", {});
  const afterUnrelated = await journey.context(flour.inventoryItemId);
  if (afterUnrelated.purchases.kind !== "ready")
    throw new Error("Purchase read unavailable");
  expect(afterUnrelated.purchases.entries[0]?.received).toBe(
    String(batchAmount),
  );
  const linked = afterUnrelated.purchases.entries[0];
  if (linked === undefined)
    throw new Error("Purchase disappeared before completion");
  await journey.write(
    "/inventory/receipts",
    journey.receipt(afterUnrelated, flour.quantity, "flour-complete", {
      kind: "replenishment",
      entryId: linked.id,
      entryRevision: linked.revision,
    }),
  );
  const complete = await journey.context(flour.inventoryItemId);
  expect(complete.purchases).toEqual({ kind: "ready", entries: [] });

  const lot = complete.lots.find(lotId.bind(null, "lot_flour-partial"));
  if (lot === undefined) throw new Error("Received flour lot missing");
  const count = {
    merchantRevision: complete.merchantRevision,
    inventoryPositionId: complete.inventoryPositionId,
    inventoryPositionRevision: complete.inventoryPositionRevision,
    target: { kind: "lot", lotId: lot.id, lotRevision: lot.revision },
    change: {
      kind: "count",
      observedQuantity: lot.quantity,
      explanation: "Physical supplier delivery count agrees",
    },
    requestedAt: journey.now,
  };
  const countResult = await journey.write(
    "/inventory/reconciliations",
    count,
    "count-agrees",
  );
  expect(
    await journey.write("/inventory/reconciliations", count, "count-agrees"),
  ).toEqual(countResult);
  expect(
    await journey.error("/inventory/reconciliations", count),
  ).toMatchObject({ error: "stale_merchant_revision" });
  const changed = await journey.context(flour.inventoryItemId);
  expect(
    await journey.error("/inventory/reconciliations", {
      ...count,
      merchantRevision: changed.merchantRevision,
    }),
  ).toMatchObject({ error: "stale_resource_revision" });
  const countedLot = changed.lots.find(lotId.bind(null, lot.id));
  if (countedLot === undefined) throw new Error("Counted lot missing");
  expect(
    await journey.error("/inventory/reconciliations", {
      ...count,
      merchantRevision: changed.merchantRevision,
      inventoryPositionRevision: changed.inventoryPositionRevision,
      target: {
        kind: "lot",
        lotId: countedLot.id,
        lotRevision: countedLot.revision,
      },
      change: {
        kind: "count",
        observedQuantity: { amount: 1, scale: 0, unit: "liter" },
        explanation: "Incompatible measurement",
      },
    }),
  ).toMatchObject({ error: "resource_relationship_invalid" });
  expect(
    (await journey.send("/inventory/reconciliations", count, viewer.session))
      .status,
  ).toBe(404);
  expect(
    (await journey.send("/inventory/reconciliations", count, foreign.session))
      .status,
  ).toBe(404);
  expect(
    (
      await journey.send(
        `/inventory/receipts?position=${complete.inventoryPositionId}`,
        undefined,
        viewer.session,
      )
    ).status,
  ).toBe(200);
  await verifyAdjustmentQueueFailure(journey, flour.inventoryItemId, lot.id);
  await journey.adjustLot(
    flour.inventoryItemId,
    lot.id,
    "decrease",
    "damage",
    1,
  );
  await journey.adjustLot(
    flour.inventoryItemId,
    lot.id,
    "increase",
    "correction",
    2,
  );
  for (const input of recipe.inputs.slice(1)) {
    const context = await journey.context(input.inventoryItemId);
    await journey.write(
      "/inventory/receipts",
      journey.receipt(
        context,
        { ...input.quantity, amount: input.quantity.amount * 2 },
        `input-${input.inventoryItemId}`,
        { kind: "unlinked" },
      ),
    );
  }
  const outputContext = await journey.context(recipe.output.inventoryItemId);
  const outputBefore = outputContext.onHand;
  const path = "/inventory/production-requests";
  const inactive = await journey.read(
    `${path}?position=${outputContext.inventoryPositionId}`,
  );
  expect(parseInventoryProductionContext(inactive).demand.kind).toBe(
    "inactive",
  );
  await journey.write(path, { kind: "setup" });
  const productionContext = parseInventoryProductionContext(
    await journey.read(`${path}?position=${outputContext.inventoryPositionId}`),
  );
  if (productionContext.demand.kind !== "ready")
    throw new Error("Production list missing");
  const productionRecovery = await verifyProductionRecovery(journey, {
    kind: "create",
    listRevision: productionContext.demand.listRevision,
    inventoryItemId: productionContext.inventoryItemId,
    locationId: productionContext.locationId,
    merchantRevision: productionContext.merchantRevision,
    positionId: productionContext.inventoryPositionId,
    positionRevision: productionContext.inventoryPositionRevision,
    recipeId: String(recipe.recipeId),
    recipeRevision: recipe.revision,
    quantity: recipe.output.yieldQuantity,
    neededBy: new Date(Date.now() + 86400000).toISOString(),
    requestedAt: new Date(Date.now() - 600000).toISOString(),
  });
  expect((await journey.context(recipe.output.inventoryItemId)).onHand).toBe(
    outputBefore,
  );
  const demand = await journey.advanceRequest("accept");
  const scheduled = await journey.advanceRequest("schedule");
  expect(scheduled.id).toBe(demand.id);
  const beforeBatch = await journey.stock();
  const output = positionForItem(beforeBatch, recipe.output.inventoryItemId);
  const batch = {
    ...(await journey.base("batch")),
    schemaVersion: "commerce.complete-production-batch.v1" as const,
    productionBatchId: "batch_inventory_acceptance",
    demand: {
      kind: "request" as const,
      requestId: scheduled.id,
      requestRevision: scheduled.revision,
    },
    outputLotId: "lot_inventory_cookies",
    outputInventoryPositionId: output.id,
    recipeId: String(recipe.recipeId),
    recipeRevision: recipe.revision,
    stationId: "station_bakery",
    locationId: output.locationId,
    plannedYield: recipe.output.yieldQuantity,
    actualYield: {
      ...recipe.output.yieldQuantity,
      amount: recipe.output.yieldQuantity.amount - 2,
    },
    outputLotCode: "ACCEPTANCE-COOKIES",
    outputExpiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    expectedInputPositionRevisions: recipe.inputs.map(
      inputRevision.bind(null, beforeBatch),
    ),
    expectedOutputPositionRevision: output.revision,
  };
  const baked = await applied(
    journey.native.completeProductionBatch(commerceCommandInput(batch)),
  );
  expect(
    await required(
      journey.native.completeProductionBatch(commerceCommandInput(batch)),
    ),
  ).toEqual({ ...baked, outcome: "replayed" });
  const afterBatch = await journey.stock();
  expect(afterBatch.foodService.resources.productionBatches).toHaveLength(1);
  const overproduction = await required(
    journey.native.completeProductionBatch({
      ...commerceCommandInput(batch),
      ...(await journey.base("overproduction")),
      productionBatchId: "batch_over_demand",
      outputLotId: "lot_over_demand",
      outputLotCode: "OVER-DEMAND",
      expectedInputPositionRevisions: recipe.inputs.map(
        inputRevision.bind(null, afterBatch),
      ),
      expectedOutputPositionRevision: positionForItem(
        afterBatch,
        recipe.output.inventoryItemId,
      ).revision,
    }),
  );
  expect(overproduction).toMatchObject({
    outcome: "rejected",
    error: { code: "resource_relationship_invalid" },
  });
  const finished = positionForItem(afterBatch, recipe.output.inventoryItemId);
  expect(finished.balance.available.amount).toBe(batch.actualYield.amount);
  const requests = await journey.read(path);
  if (!isRecord(requests)) throw new Error("Demand response invalid");
  const ready = parseProductionDemand(requests.demand);
  expect(ready).toMatchObject({
    kind: "ready",
    requests: [
      {
        batches: [
          { id: batch.productionBatchId, actualYield: batch.actualYield },
        ],
      },
    ],
  });
  const view = parseInventory(await journey.read("/inventory"));
  expect(
    view.rows.some(
      rowForItem.bind(null, recipe.output.inventoryItemId, "supply"),
    ),
  ).toBe(false);
  expect(
    view.rows.some(rowForItem.bind(null, flour.inventoryItemId, "product")),
  ).toBe(false);
  expect(
    view.rows.find(
      rowForItem.bind(null, recipe.output.inventoryItemId, "product"),
    ),
  ).toMatchObject({
    available: `${batch.actualYield.amount} each`,
    recipeCount: 1,
  });
  // Stock outbox acceptance precedes checkout receipts that require a Slack installation.
  const pagination = await verifyProductionPagination(
    journey,
    recipe.output.inventoryItemId,
  );
  const purchasingCycles = await verifySecondPurchasingCycle(
    journey,
    flour.inventoryItemId,
    purchase.id,
  );
  const queryIsolation = await verifyMerchantQueryIsolation(journey);
  const paid = await journey.placeOrder("fulfilled", 6);
  const reserved = positionForItem(
    await journey.stock(),
    recipe.output.inventoryItemId,
  );
  expect(reserved.balance).toMatchObject({
    kind: "accounted",
    onHand: { amount: batch.actualYield.amount },
    allocated: { amount: 6 },
    available: { amount: batch.actualYield.amount - 6 },
  });
  const productCount = await journey.context(recipe.output.inventoryItemId);
  const outputLot = productCount.lots.find(lotId.bind(null, batch.outputLotId));
  if (outputLot === undefined) throw new Error("Production output lot missing");
  expect(
    await journey.error("/inventory/reconciliations", {
      merchantRevision: productCount.merchantRevision,
      inventoryPositionId: productCount.inventoryPositionId,
      inventoryPositionRevision: productCount.inventoryPositionRevision,
      target: {
        kind: "lot",
        lotId: outputLot.id,
        lotRevision: outputLot.revision,
      },
      change: {
        kind: "count",
        observedQuantity: { amount: 5, scale: 0, unit: "each" },
        explanation: "Physical count below reserved orders",
      },
      requestedAt: journey.now,
    }),
  ).toMatchObject({
    error: "inventory_count_shortage",
    shortage: { reservedAmount: 6 },
  });
  await journey.fulfill(paid.orderId);
  expect(
    positionForItem(await journey.stock(), recipe.output.inventoryItemId)
      .balance,
  ).toMatchObject({
    kind: "accounted",
    onHand: { amount: batch.actualYield.amount - 6 },
    allocated: { amount: 0 },
    available: { amount: batch.actualYield.amount - 6 },
  });
  const cancelled = await journey.placeOrder("cancelled", 3);
  await journey.cancel(cancelled.orderId);
  const final = await journey.stock();
  expect(
    positionForItem(final, recipe.output.inventoryItemId).balance,
  ).toMatchObject({
    kind: "accounted",
    onHand: { amount: batch.actualYield.amount - 6 },
    allocated: { amount: 0 },
    available: { amount: batch.actualYield.amount - 6 },
  });
  await applied(
    journey.native.createInventoryItem({
      ...(await journey.base("unlinked-product")),
      inventoryItemId: "inventory_unlinked_cookie",
      merchantCode: "UNLINKED-COOKIE",
      name: "Unlinked cookie",
      baseUnit: "each",
      category: "finished_good",
      tracking: { kind: "aggregate" },
    }),
  );
  await applied(
    journey.native.openInventoryPosition({
      ...(await journey.base("unlinked-position")),
      inventoryPositionId: "position_unlinked_cookie",
      inventoryItemId: "inventory_unlinked_cookie",
      inventoryItemRevision: 1,
      locationId: "location_cafe",
      locationRevision: 1,
    }),
  );
  const unlinkedContext = parseInventoryProductionContext(
    await journey.read(`${path}?position=position_unlinked_cookie`),
  );
  expect(unlinkedContext.recipes).toHaveLength(0);
  await journey.write(path, {
    kind: "link_recipe",
    merchantRevision: unlinkedContext.merchantRevision,
    positionId: unlinkedContext.inventoryPositionId,
    positionRevision: unlinkedContext.inventoryPositionRevision,
    recipeId: String(recipe.recipeId),
    recipeRevision: recipe.revision,
    requestedAt: journey.now,
  });
  const linkedRecipe = parseInventoryProductionContext(
    await journey.read(`${path}?position=position_unlinked_cookie`),
  );
  expect(linkedRecipe.recipes).toHaveLength(1);
  expect(
    parseInventory(await journey.read("/inventory")).rows.find(
      rowForItem.bind(null, "inventory_unlinked_cookie", "unlinked_product"),
    ),
  ).toMatchObject({ available: "0 each", recipeCount: 1, product: null });
  const availableOnlyFixture = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${merchantId}/test-fixture`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer commerce-e2e-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "inventory_available_only",
        positionId: complete.inventoryPositionId,
      }),
    },
  );
  expect(availableOnlyFixture.status).toBe(200);
  const availableOnly = await journey.context(flour.inventoryItemId);
  expect(availableOnly.onHandQuantity).toBeNull();
  expect(availableOnly.allocated).toBeNull();
  expect(
    await journey.error("/inventory/reconciliations", {
      ...count,
      merchantRevision: availableOnly.merchantRevision,
      inventoryPositionRevision: availableOnly.inventoryPositionRevision,
    }),
  ).toMatchObject({ error: "resource_relationship_invalid" });
  Object.assign(context.task.meta, {
    inventoryOperationsEvidence: {
      fulfilledOrder: paid.orderId,
      cancelledOrder: cancelled.orderId,
      reservationShortageProtected: true,
      recipeLinked: true,
      availableOnlyCountRejected: true,
      adjustmentsAudited: true,
      queueFailureCommittedOnce: true,
      scheduledRecoveryDrainedOutbox: true,
      lostControlReceiptRecoveredFromNativeReplay: true,
      delayedProductionSubmissionAccepted: true,
      productionRecovery,
      pagination,
      purchasingCycles,
      queryIsolation,
      unrelatedPurchaseHistoryFiltered: true,
      finalStock: final,
      evidence: "plan47-inventory-operations",
      organisationId,
      merchantId,
      purchaseId: purchase.id,
      productionRequestId: scheduled.id,
      batchReceipt: baked.receipt,
      partialReceipts: true,
      unrelatedReceiptExcluded: true,
      countAudit: countResult,
      replayProtected: true,
      viewerRejected: true,
      foreignOrganisationRejected: true,
      stock: view,
    },
  });
}

class InventoryJourney {
  readonly entities = new CommerceEntityPlaneClient({
    baseUrl: "http://commerce.test",
    serviceToken: "commerce-e2e-token",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  readonly native = new CommerceAdminClient({
    baseUrl: "http://commerce.test",
    serviceToken: "commerce-e2e-token",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  readonly now = new Date().toISOString();
  constructor(
    readonly organisationId: string,
    readonly merchantId: string,
    readonly session: Awaited<ReturnType<typeof commerceClient>>["session"],
  ) {}
  async stock() {
    return required(this.native.readStockSnapshot(this.merchantId));
  }
  async graph(query: unknown) {
    return required(
      this.entities.query({
        merchantId: this.merchantId,
        query: parseCommerceGraphQuery(query),
      }),
    );
  }
  async adjustLot(
    itemId: string,
    id: string,
    direction: "increase" | "decrease",
    reason: "correction" | "waste" | "damage",
    amount: number,
  ) {
    const context = await this.context(itemId);
    const lot = context.lots.find(lotId.bind(null, id));
    if (lot === undefined) throw new Error("Adjustment lot missing");
    const result = await this.write("/inventory/reconciliations", {
      merchantRevision: context.merchantRevision,
      inventoryPositionId: context.inventoryPositionId,
      inventoryPositionRevision: context.inventoryPositionRevision,
      target: { kind: "lot", lotId: lot.id, lotRevision: lot.revision },
      change: {
        kind: "adjustment",
        direction,
        reason,
        quantity: { amount, scale: 0, unit: context.unit },
        explanation: `Physical ${reason} during stock review`,
      },
      requestedAt: this.now,
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        outcome: "applied",
        receipt: { commandKind: "reconcile_inventory" },
      },
    });
    expect((await this.stock()).movements).toContainEqual(
      expect.objectContaining({
        change: expect.objectContaining({
          reason: expect.objectContaining({ kind: reason }),
        }),
      }),
    );
  }
  async base(key: string) {
    const stock = await this.stock();
    return {
      merchantId: this.merchantId,
      expectedMerchantRevision: stock.commerce.merchantRevision,
      idempotencyKey: key,
    };
  }
  async send(
    suffix: string,
    body?: unknown,
    session = this.session,
    key = crypto.randomUUID(),
  ) {
    const headers = commerceHeaders(session);
    headers.set("idempotency-key", key);
    return exports.default.fetch(
      `https://localhost/v1/control/organisations/${this.organisationId}/commerce${suffix}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  }
  async read(suffix: string) {
    const response = await this.send(suffix);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }
  async write(suffix: string, body: unknown, key = crypto.randomUUID()) {
    const response = await this.send(suffix, body, this.session, key);
    expect(response.status, await response.clone().text()).toBe(200);
    const result: unknown = await response.json();
    if (suffix === "/inventory/receipts") {
      const recovered = await runScheduledCommerceOutboxReconciliation(
        env,
        Date.now(),
      );
      const diagnostic = await env.COMMERCE.fetch(
        `http://commerce.test/v1/admin/merchants/${this.merchantId}/test-fixture`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer commerce-e2e-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ kind: "outbox_status" }),
        },
      );
      expect(
        recovered,
        JSON.stringify({ recovered, outbox: await diagnostic.json() }),
      ).toEqual([expect.objectContaining({ kind: "drained", rejected: 0 })]);
    }
    return result;
  }
  async error(suffix: string, body: unknown) {
    const response = await this.send(suffix, body);
    expect(response.status).toBeGreaterThanOrEqual(400);
    return response.json();
  }
  async context(itemId: string): Promise<InventoryReceiptContext> {
    const stock = await this.stock();
    const position = positionForItem(stock, itemId);
    return parseInventoryReceiptContext(
      await this.read(`/inventory/receipts?position=${position.id}`),
    );
  }
  receipt(
    context: InventoryReceiptContext,
    quantity: Quantity,
    key: string,
    purchase:
      | { kind: "unlinked" }
      | { kind: "replenishment"; entryId: string; entryRevision: number },
  ) {
    return {
      merchantRevision: context.merchantRevision,
      inventoryItemId: context.inventoryItemId,
      inventoryItemRevision: context.inventoryItemRevision,
      inventoryPositionId: context.inventoryPositionId,
      inventoryPositionRevision: context.inventoryPositionRevision,
      locationId: context.locationId,
      receivedQuantity: quantity,
      purchase,
      lot:
        context.tracking.kind === "aggregate"
          ? { kind: "untracked" }
          : {
              kind: "tracked",
              lotId: `lot_${key}`,
              lotCode: key,
              expiry: {
                kind: "expires",
                expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
              },
            },
      receiptId: `receipt_${key}`,
      receiptLineId: "1",
      receivedAt: this.now,
    };
  }
  placeOrder(key: string, quantity: number) {
    return placePickupOrder(
      this.merchantId,
      "storefront_cafe",
      [{ kind: "catalog", variantId: "variant_sesame_cookie", quantity }],
      { key, email: "buyer@example.test" },
    );
  }
  async fulfill(orderId: string) {
    let target = await this.orderTarget(orderId);
    await applied(
      this.native.markPickupReady({
        ...(await this.base(`ready-${orderId}`)),
        orderId,
        orderRevision: target.order.revision,
        fulfillmentId: target.fulfillment.id,
        fulfillmentRevision: target.fulfillment.revision,
      }),
    );
    target = await this.orderTarget(orderId);
    const command = {
      ...(await this.base(`fulfill-${orderId}`)),
      schemaVersion: "commerce.complete-pickup.v1" as const,
      orderId,
      orderRevision: target.order.revision,
      fulfillmentId: target.fulfillment.id,
      fulfillmentRevision: target.fulfillment.revision,
      paymentId: target.payment.id,
      paymentRevision: target.payment.revision,
    };
    await applied(this.native.completePickup(commerceCommandInput(command)));
    expect(
      (
        await required(
          this.native.completePickup(commerceCommandInput(command)),
        )
      ).outcome,
    ).toBe("replayed");
  }
  async cancel(orderId: string) {
    const target = await this.orderTarget(orderId);
    const command = {
      ...(await this.base(`cancel-${orderId}`)),
      schemaVersion: "commerce.cancel-order.v1" as const,
      orderId,
      orderRevision: target.order.revision,
      fulfillmentId: target.fulfillment.id,
      fulfillmentRevision: target.fulfillment.revision,
      paymentId: target.payment.id,
      paymentRevision: target.payment.revision,
      refundAttemptId: `refund-${orderId}`,
      reason: "Buyer changed plans",
    };
    await applied(this.native.cancelOrder(commerceCommandInput(command)));
    expect(
      (await required(this.native.cancelOrder(commerceCommandInput(command))))
        .outcome,
    ).toBe("replayed");
  }
  async orderTarget(orderId: string) {
    const stock = await this.stock();
    const order = stock.commerce.resources.orders.find(
      orderIdentity.bind(null, orderId),
    );
    const payment = stock.commerce.resources.payments.find(
      orderPayment.bind(null, orderId),
    );
    const fulfillment = stock.commerce.resources.fulfillments.find(
      orderPayment.bind(null, orderId),
    );
    if (
      order === undefined ||
      payment === undefined ||
      fulfillment === undefined
    )
      throw new Error("Order resources missing");
    return { order, payment, fulfillment };
  }
  async advanceRequest(kind: "accept" | "schedule") {
    const raw = await this.read("/inventory/production-requests");
    if (!isRecord(raw)) throw new Error("Demand response invalid");
    const demand = parseProductionDemand(raw.demand);
    if (demand.kind !== "ready" || demand.requests[0] === undefined)
      throw new Error("Demand missing");
    const request = demand.requests[0];
    await this.write("/inventory/production-requests", {
      kind,
      merchantRevision: raw.merchantRevision,
      requestId: request.id,
      requestRevision: request.revision,
      listRevision: demand.listRevision,
      recipeId: request.recipeId,
      recipeRevision: request.recipeRevision,
      locationId: request.locationId,
      quantity: request.quantity,
      neededBy: request.neededBy,
      requestedAt: this.now,
    });
    const updated = await this.read("/inventory/production-requests");
    if (!isRecord(updated)) throw new Error("Updated demand response invalid");
    const result = parseProductionDemand(updated.demand);
    if (result.kind !== "ready" || result.requests[0] === undefined)
      throw new Error("Updated request missing");
    return result.requests[0];
  }
}
async function required<T>(
  result: Promise<
    Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>
  >,
): Promise<T> {
  const resolved = await result;
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.error));
  return resolved.value;
}
async function applied(
  result: Promise<CommerceClientResult<CommerceMutationResultV1>>,
) {
  const value = await required(result);
  if (value.outcome === "rejected")
    throw new Error(JSON.stringify(value.error));
  return value;
}
function sesameRecipe(
  recipe: CommerceStockSnapshot["foodService"]["resources"]["recipeRevisions"][number],
) {
  return recipe.recipeId === "recipe_sesame_cookie_stocked";
}
function positionForItem(stock: CommerceStockSnapshot, itemId: string) {
  const position = stock.commerce.resources.inventoryPositions.find(
    positionItem.bind(null, itemId),
  );
  if (position === undefined) throw new Error(`Position missing: ${itemId}`);
  return position;
}
function positionItem(
  itemId: string,
  position: CommerceStockSnapshot["commerce"]["resources"]["inventoryPositions"][number],
) {
  return position.inventoryItemId === itemId;
}
function lotId(id: string, lot: InventoryReceiptContext["lots"][number]) {
  return lot.id === id;
}
function inputRevision(
  stock: CommerceStockSnapshot,
  input: CommerceStockSnapshot["foodService"]["resources"]["recipeRevisions"][number]["inputs"][number],
) {
  const position = positionForItem(stock, input.inventoryItemId);
  return { inventoryPositionId: position.id, revision: position.revision };
}
function rowForItem(
  itemId: string,
  kind: string,
  row: ReturnType<typeof parseInventory>["rows"][number],
) {
  return row.inventoryItemId === itemId && row.kind === kind;
}

function orderIdentity(id: string, order: { id: string }) {
  return order.id === id;
}
function orderPayment(id: string, resource: { orderId: string }) {
  return resource.orderId === id;
}

function usableForPosition(
  id: string,
  usable: CommerceStockSnapshot["usable"][number],
) {
  return usable.positionId === id;
}

async function verifyAdjustmentQueueFailure(
  journey: InventoryJourney,
  itemId: string,
  id: string,
): Promise<void> {
  const context = await journey.context(itemId);
  const lot = context.lots.find(lotId.bind(null, id));
  if (lot === undefined) throw new Error("Adjustment lot missing");
  const before = await journey.stock();
  const body = {
    merchantRevision: context.merchantRevision,
    inventoryPositionId: context.inventoryPositionId,
    inventoryPositionRevision: context.inventoryPositionRevision,
    target: { kind: "lot", lotId: lot.id, lotRevision: lot.revision },
    change: {
      kind: "adjustment",
      direction: "decrease",
      reason: "waste",
      quantity: { amount: 1, scale: 0, unit: context.unit },
      explanation: "Spoiled during delivery",
    },
    requestedAt: journey.now,
  };
  const headers = commerceHeaders(journey.session);
  headers.set("idempotency-key", "queue-failed-adjustment");
  const request = new Request(
    `https://localhost/v1/control/organisations/${journey.organisationId}/commerce/inventory/reconciliations`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
  const queueUnavailable: Env = {
    ...env,
    EVENT_Q: {
      send: rejectQueueSend,
      sendBatch: env.EVENT_Q.sendBatch.bind(env.EVENT_Q),
      metrics: env.EVENT_Q.metrics.bind(env.EVENT_Q),
    },
  };
  const response = await handleInventoryReceipt(
    request,
    queueUnavailable,
    journey.organisationId,
    "reconciliation",
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const appliedResult = await response.json();
  const unread = async () => {
    const reader = await required(
      journey.native.readFeedConsumer(journey.merchantId, "pantry"),
    );
    const page = await required(
      journey.native.readEvents(journey.merchantId, { after: reader.cursor }),
    );
    return page.events;
  };
  expect((await unread()).length).toBeGreaterThan(0);
  const recovered = await runScheduledCommerceOutboxReconciliation(
    queueUnavailable,
    Date.now(),
  );
  expect(recovered).toEqual([
    expect.objectContaining({ kind: "drained", rejected: 0 }),
  ]);
  expect(await unread()).toHaveLength(0);
  // Lose the control receipt after native commit, then retry the frozen submission against fresh stock.
  await fixtureDatabase()
    .prepare(
      "DELETE FROM control_mutation_receipt WHERE organisation_scope = ? AND idempotency_key = ?",
    )
    .bind(journey.organisationId, "queue-failed-adjustment")
    .run();
  const refreshed = await journey.context(itemId);
  expect(refreshed.merchantRevision).toBeGreaterThan(context.merchantRevision);
  const replayed = await journey.write(
    "/inventory/reconciliations",
    body,
    "queue-failed-adjustment",
  );
  expect(replayed).toMatchObject({ ok: true, result: { outcome: "replayed" } });
  expect(
    isRecord(appliedResult) &&
      isRecord(appliedResult.result) &&
      isRecord(replayed) &&
      isRecord(replayed.result) &&
      replayed.result.receipt,
  ).toEqual(
    isRecord(appliedResult) &&
      isRecord(appliedResult.result) &&
      appliedResult.result.receipt,
  );
  expect(
    await journey.write(
      "/inventory/reconciliations",
      body,
      "queue-failed-adjustment",
    ),
  ).toEqual(replayed);
  const after = await journey.stock();
  expect(after.commerce.merchantRevision).toBeGreaterThan(
    before.commerce.merchantRevision,
  );
  expect(after.movements).toHaveLength(before.movements.length + 1);
}
async function rejectQueueSend(): Promise<never> {
  throw new Error("Acceptance queue outage");
}

async function verifySecondPurchasingCycle(
  journey: InventoryJourney,
  itemId: string,
  previousEntryId: string,
) {
  await runScheduledCommerceOutboxReconciliation(env, Date.now());
  const stocked = await journey.context(itemId);
  for (const lot of stocked.lots) {
    if (lot.quantity.amount === 0) continue;
    await journey.adjustLot(
      itemId,
      lot.id,
      "decrease",
      "waste",
      lot.quantity.amount / 10 ** lot.quantity.scale,
    );
    // Settle purchasing updates before taking the next merchant revision.
    expect(
      await runScheduledCommerceOutboxReconciliation(env, Date.now()),
    ).toEqual([expect.objectContaining({ kind: "drained", rejected: 0 })]);
  }
  await journey.write("/purchasing/reconcile", {});
  await journey.write("/purchasing/reconcile", {});
  const depleted = await journey.context(itemId);
  expect(depleted.onHandQuantity?.amount).toBe(0);
  if (depleted.purchases.kind !== "ready")
    throw new Error("Second purchasing cycle unavailable");
  expect(depleted.purchases.entries).toHaveLength(1);
  const entry = depleted.purchases.entries[0];
  if (entry === undefined) throw new Error("Second purchase request missing");
  expect(entry.id).not.toBe(previousEntryId);
  const requiredAmount = Number(entry.required);
  expect(Number.isSafeInteger(requiredAmount) && requiredAmount > 1).toBe(true);
  await journey.write(
    "/inventory/receipts",
    journey.receipt(
      depleted,
      { amount: 1, scale: 0, unit: depleted.unit },
      "second-cycle-partial",
      {
        kind: "replenishment",
        entryId: entry.id,
        entryRevision: entry.revision,
      },
    ),
    "second-cycle-partial",
  );
  const partial = await journey.context(itemId);
  if (partial.purchases.kind !== "ready")
    throw new Error("Second partial delivery unavailable");
  expect(partial.purchases.entries).toHaveLength(1);
  const remaining = partial.purchases.entries[0];
  if (remaining === undefined) throw new Error("Second request disappeared");
  expect(remaining).toMatchObject({ id: entry.id, received: "1" });
  const receipt = journey.receipt(
    partial,
    { amount: requiredAmount - 1, scale: 0, unit: partial.unit },
    "second-cycle-complete",
    {
      kind: "replenishment",
      entryId: entry.id,
      entryRevision: remaining.revision,
    },
  );
  const received = await journey.write(
    "/inventory/receipts",
    receipt,
    "second-cycle-complete",
  );
  const settled = await journey.stock();
  expect(
    await journey.write(
      "/inventory/receipts",
      receipt,
      "second-cycle-complete",
    ),
  ).toEqual(received);
  expect(await journey.stock()).toEqual(settled);
  expect((await journey.context(itemId)).purchases).toEqual({
    kind: "ready",
    entries: [],
  });
  const history = await journey.graph({
    kind: "commerce_list_page",
    listId: "replenishment_queue",
    filter: {
      kind: "entity",
      reference: {
        origin: "system",
        typeId: "stock_policy",
        entityId: "policy_flour",
      },
    },
    sorts: [],
    pagination: { limit: 100, cursor: null },
  });
  expect(history.listEntries.map(listEntryId).sort()).toEqual(
    [previousEntryId, entry.id].sort(),
  );
  return {
    completedEntryIds: [previousEntryId, entry.id],
    repeatedReconciliationKeptOneOpenRequest: true,
    partialDeliveryReconciled: true,
    replayPreservedStock: true,
    migratedFromVersions: [48, 49],
  };
}

async function verifyMerchantQueryIsolation(journey: InventoryJourney) {
  const merchantId = `merchant_bakery_c3_inventory_foreign_${crypto.randomUUID().replaceAll("-", "")}`;
  const organisationId = `organisation_foreign_${crypto.randomUUID()}`;
  await required(
    journey.native.provisionMerchant({
      schemaVersion: "commerce.provision-merchant.v2",
      merchantId,
      externalReference: organisationId,
      createdAt: journey.now,
    }),
  );
  await applied(
    journey.native.createInventoryItem({
      merchantId,
      expectedMerchantRevision: 0,
      idempotencyKey: "foreign-item",
      inventoryItemId: "private_inventory_item",
      merchantCode: "PRIVATE",
      name: "Private inventory",
      baseUnit: "each",
      category: "packaging",
      tracking: { kind: "aggregate" },
    }),
  );
  const stock = await journey.stock();
  const ownIds = stock.commerce.resources.inventoryItems
    .map(inventoryItemId)
    .sort();
  const filter = { kind: "any", filters: [{ kind: "all" }, { kind: "all" }] };
  const count = await journey.graph({
    kind: "aggregation",
    source: {
      kind: "entity_type",
      entityTypeId: { origin: "system", typeId: "inventory_item" },
    },
    aggregation: { kind: "count" },
    filter,
  });
  const aggregation = count.aggregations[0];
  if (aggregation?.kind !== "count")
    throw new Error("Inventory count aggregation missing");
  expect(String(aggregation.value)).toBe(String(ownIds.length));
  const foreign = await journey.graph({
    kind: "entity_type_page",
    entityTypeId: { origin: "system", typeId: "inventory_item" },
    filter: {
      kind: "any",
      filters: [
        {
          kind: "entity",
          reference: {
            origin: "system",
            typeId: "inventory_item",
            entityId: "missing_inventory_item",
          },
        },
        {
          kind: "entity",
          reference: {
            origin: "system",
            typeId: "inventory_item",
            entityId: "private_inventory_item",
          },
        },
      ],
    },
    sorts: [],
    pagination: { limit: 3, cursor: null },
    traversal: { maxDepth: 0, resultLimit: 100 },
  });
  expect(foreign.entities).toEqual([]);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await journey.graph({
      kind: "entity_type_page",
      entityTypeId: { origin: "system", typeId: "inventory_item" },
      filter,
      sorts: [],
      pagination: { limit: 3, cursor },
      traversal: { maxDepth: 0, resultLimit: 100 },
    });
    seen.push(...page.entities.map(graphEntityId));
    cursor = page.nextCursor;
    pages += 1;
    expect(pages).toBeLessThanOrEqual(ownIds.length);
  } while (cursor !== null);
  expect(seen.sort()).toEqual(ownIds);
  const nestedSearch = await journey.graph({
    kind: "entity_type_page",
    entityTypeId: { origin: "system", typeId: "inventory_item" },
    filter: {
      kind: "any",
      filters: [
        {
          kind: "entity",
          reference: {
            origin: "system",
            typeId: "inventory_item",
            entityId: "private_inventory_item",
          },
        },
        { kind: "not", filter: { kind: "search", text: "cookie" } },
      ],
    },
    sorts: [],
    pagination: { limit: 100, cursor: null },
    traversal: { maxDepth: 0, resultLimit: 100 },
  });
  expect(nestedSearch.entities.map(graphEntityId).sort()).toEqual(
    stock.commerce.resources.inventoryItems
      .filter(nonCookieItem)
      .map(inventoryItemId)
      .sort(),
  );
  return {
    merchantId,
    ownItemCount: ownIds.length,
    pages,
    foreignRows: 0,
    nestedSearchBound: true,
  };
}

function listEntryId(entry: { entryId: string }): string {
  return entry.entryId;
}

function inventoryItemId(item: { id: string }): string {
  return item.id;
}

function graphEntityId(entity: { reference: { entityId: string } }): string {
  return entity.reference.entityId;
}

function nonCookieItem(item: { name: string }): boolean {
  return !item.name.toLowerCase().includes("cookie");
}

async function verifyProductionPagination(
  journey: InventoryJourney,
  itemId: string,
) {
  const path = "/inventory/production-requests";
  for (let index = 0; index < 101; index += 1) {
    const stock = await journey.context(itemId);
    const context = parseInventoryProductionContext(
      await journey.read(`${path}?position=${stock.inventoryPositionId}`),
    );
    const recipe = context.recipes[0];
    if (recipe === undefined) throw new Error("Pagination recipe missing");
    await journey.write(
      path,
      {
        kind: "create",
        listRevision:
          context.demand.kind === "ready" ? context.demand.listRevision : 1,
        inventoryItemId: context.inventoryItemId,
        locationId: context.locationId,
        merchantRevision: context.merchantRevision,
        positionId: context.inventoryPositionId,
        positionRevision: context.inventoryPositionRevision,
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        quantity: recipe.yield,
        neededBy: new Date(Date.now() + 86400000).toISOString(),
        requestedAt: journey.now,
      },
      `pagination-${index}`,
    );
  }
  const firstRaw = await journey.read(path);
  if (!isRecord(firstRaw)) throw new Error("Production page missing");
  const first = parseProductionDemand(firstRaw.demand);
  if (first.kind !== "ready" || first.nextCursor === null)
    throw new Error("Production continuation missing");
  expect(first.requests).toHaveLength(100);
  const secondRaw = await journey.read(
    `${path}?cursor=${encodeURIComponent(first.nextCursor)}`,
  );
  if (!isRecord(secondRaw))
    throw new Error("Production continuation unavailable");
  const second = parseProductionDemand(secondRaw.demand);
  if (second.kind !== "ready" || second.requests[0] === undefined)
    throw new Error("Second-page demand missing");
  expect(second.requests).toHaveLength(2);
  expect(second.nextCursor).toBeNull();
  const request = second.requests[0];
  expect(request.quantity).toEqual(first.requests[0]?.quantity);
  await journey.write(path, {
    kind: "accept",
    merchantRevision: secondRaw.merchantRevision,
    requestId: request.id,
    requestRevision: request.revision,
    listRevision: second.listRevision,
    recipeId: request.recipeId,
    recipeRevision: request.recipeRevision,
    locationId: request.locationId,
    quantity: request.quantity,
    neededBy: request.neededBy,
    requestedAt: journey.now,
  });
  const stale = await journey.send(
    `${path}?cursor=${encodeURIComponent(first.nextCursor)}`,
  );
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    error: "production_cursor_stale",
  });
  const restarted = await journey.read(path);
  expect(
    isRecord(restarted) && parseProductionDemand(restarted.demand).kind,
  ).toBe("ready");
  const filtered = await journey.read(
    `${path}?inventoryItem=${encodeURIComponent(itemId)}&location=location_cafe`,
  );
  expect(
    isRecord(filtered) && parseProductionDemand(filtered.demand),
  ).toMatchObject({ kind: "ready", requests: expect.any(Array) });
  return {
    cursorInvalidationReported: true,
    requests: first.requests.length + second.requests.length,
    pages: 2,
    advancedRequestBeyondFirstPage: request.id,
  };
}
async function verifyPurchasePagination(
  journey: InventoryJourney,
  inventoryItemId: string,
): Promise<void> {
  const page = await required(
    journey.entities.query({
      merchantId: journey.merchantId,
      query: parseCommerceGraphQuery({
        kind: "commerce_list_page",
        listId: "replenishment_queue",
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 100, cursor: null },
      }),
    }),
  );
  const source = page.listEntries[0];
  if (source === undefined) throw new Error("Purchasing queue missing");
  for (let index = 0; index < 101; index += 1) {
    const policyId = `policy_history_${index}`;
    await applied(
      journey.native.configureStockPolicy({
        ...(await journey.base(`historic-policy-${index}`)),
        stockPolicy: {
          stockPolicyId: policyId,
          inventoryItemId,
          locationId: "location_cafe",
          replenishment: { kind: "none" },
        },
      }),
    );
    const entityRef = {
      origin: source.entityRef.origin,
      typeId: source.entityRef.typeId,
      entityId: policyId,
    };
    const stock = await journey.stock();
    const commandId = `purchasing-history-${index}`;
    const entryId = `historic_purchase_${index}`;
    const result = await required(
      journey.entities.command(
        parseEntityPlaneCommand({
          organisationId: journey.organisationId,
          merchantId: journey.merchantId,
          expectedMerchantRevision: stock.commerce.merchantRevision,
          commandId,
          authority: {
            kind: "commerce_list_entry_create",
            context: {
              organisationId: journey.organisationId,
              merchantId: journey.merchantId,
              principalId: "inventory-acceptance",
              sensitivityCeiling: "restricted",
              expiresAt: new Date(Date.now() + 300000).toISOString(),
              causation: { kind: "command", commandId },
            },
            scope: { kind: "commerce_list", listId: source.listId },
            target: {
              entry: { entryId, listId: source.listId, revision: 1 },
              listRevision: source.listRevision,
              entityTypeId: {
                origin: source.entityRef.origin,
                typeId: source.entityRef.typeId,
              },
              entityRef,
            },
          },
          command: {
            kind: "add_commerce_list_entry",
            command: {
              entryId,
              listId: source.listId,
              expectedListRevision: source.listRevision,
              entityRef,
              revision: 1,
              attributeValues: source.attributeValues.map(
                closedPurchaseAttribute,
              ),
            },
          },
        }),
      ),
    );
    if (result.status !== "accepted") throw new Error(result.error.code);
  }
}
function closedPurchaseAttribute(
  attribute: import("@purin-labs/commerce-contracts").ListEntryAttributeValue,
): unknown {
  switch (String(attribute.attributeId)) {
    case "status":
      return { ...attribute, value: { kind: "status", value: "received" } };
    default:
      return attribute;
  }
}

async function verifyProductionRecovery(
  journey: InventoryJourney,
  body: InventoryProductionCreation,
) {
  const service = new ProductionRecoveryService(env.COMMERCE);
  const outage: Env = { ...env, COMMERCE: service };
  const headers = commerceHeaders(journey.session);
  headers.set("idempotency-key", "production-demand");

  const lost = await handleInventoryProduction(
    productionRecoveryRequest(journey, headers, body),
    outage,
    journey.organisationId,
  );
  expect(lost.status).toBe(503);
  const before = await journey.stock();
  const recovered = await handleInventoryProduction(
    productionRecoveryRequest(journey, headers, body),
    outage,
    journey.organisationId,
  );
  expect(recovered.status, await recovered.clone().text()).toBe(200);
  const nativeReplay: unknown = await recovered.json();
  expect(nativeReplay).toMatchObject({
    ok: true,
    result: { status: "accepted", receipt: { outcome: "already_applied" } },
  });
  expect(service.stockReads).toBe(0);
  const after = await journey.stock();
  expect(after.commerce.merchantRevision).toBe(
    before.commerce.merchantRevision,
  );
  expect(after.movements).toEqual(before.movements);
  const invalidGenericWritesRejected = await verifyNativeProductionValidation(
    journey,
    body,
  );
  const signingRepair = await verifyOutboxSigningRepair(journey);
  return {
    nativeReplay,
    stockReads: service.stockReads,
    invalidGenericWritesRejected,
    signingRepair,
  };
}

async function verifyNativeProductionValidation(
  journey: InventoryJourney,
  body: InventoryProductionCreation,
) {
  const before = await journey.stock();
  const failures = [
    {
      id: "fractional",
      quantity: { unscaled: 500000, scale: 6 },
      unit: "each",
      recipe: body.recipeId,
      status: "requested",
    },
    {
      id: "zero",
      quantity: { unscaled: 0, scale: 6 },
      unit: "each",
      recipe: body.recipeId,
      status: "requested",
    },
    {
      id: "recipe",
      quantity: { unscaled: 24000000, scale: 6 },
      unit: "each",
      recipe: "missing_recipe",
      status: "requested",
    },
    {
      id: "status",
      quantity: { unscaled: 24000000, scale: 6 },
      unit: "each",
      recipe: body.recipeId,
      status: "scheduled",
    },
  ];
  for (const fault of failures) {
    const commandId = `invalid_production_${fault.id}`;
    const entryId = commandId;
    const entityRef = {
      origin: "system",
      typeId: "inventory_item",
      entityId: body.inventoryItemId,
    };
    const entry = { entryId, listId: "production_requests", revision: 1 };
    const attributes = [
      { attributeId: "status", value: { kind: "status", value: fault.status } },
      {
        attributeId: "recipe_id",
        value: { kind: "short_text", value: fault.recipe },
      },
      {
        attributeId: "recipe_revision",
        value: { kind: "integer", value: body.recipeRevision },
      },
      {
        attributeId: "location_id",
        value: { kind: "short_text", value: body.locationId },
      },
      {
        attributeId: "requested_quantity",
        value: { kind: "decimal", value: fault.quantity },
      },
      {
        attributeId: "quantity_unit",
        value: { kind: "short_text", value: fault.unit },
      },
      {
        attributeId: "needed_by",
        value: { kind: "timestamp", value: body.neededBy },
      },
    ].map(productionTestAttribute);
    const result = await journey.entities.command(
      parseEntityPlaneCommand({
        organisationId: journey.organisationId,
        merchantId: journey.merchantId,
        expectedMerchantRevision: before.commerce.merchantRevision,
        commandId,
        authority: {
          kind: "commerce_list_entry_create",
          context: {
            organisationId: journey.organisationId,
            merchantId: journey.merchantId,
            principalId: "inventory_acceptance",
            sensitivityCeiling: "restricted",
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            causation: { kind: "command", commandId },
          },
          scope: { kind: "commerce_list", listId: "production_requests" },
          target: {
            entry,
            listRevision: body.listRevision,
            entityTypeId: { origin: "system", typeId: "inventory_item" },
            entityRef,
          },
        },
        command: {
          kind: "add_commerce_list_entry",
          command: {
            entryId,
            listId: "production_requests",
            expectedListRevision: body.listRevision,
            entityRef,
            revision: 1,
            attributeValues: attributes,
          },
        },
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { status: "rejected", error: { code: "invalid_attribute_value" } },
    });
  }
  expect((await journey.stock()).commerce.merchantRevision).toBe(
    before.commerce.merchantRevision,
  );
  return failures.length;
}

function productionTestAttribute(field: {
  attributeId: string;
  value: unknown;
}) {
  return {
    attributeId: field.attributeId,
    value: field.value,
    scope: {
      kind: "system",
      entityTypeId: "inventory_item",
      schemaRevision: 1,
    },
    definitionRevision: 1,
    sensitivity: "internal",
  };
}

async function verifyOutboxSigningRepair(
  journey: InventoryJourney,
): Promise<unknown> {
  const response = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${journey.merchantId}/test-fixture`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer commerce-e2e-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "outbox_signing_migration" }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const result: unknown = await response.json();
  expect(result).toMatchObject({
    repaired: 2,
    quarantined: 1,
    untouched: 2,
    verified: true,
    repeatedRepairs: 0,
  });
  return result;
}

function productionRecoveryRequest(
  journey: InventoryJourney,
  headers: Headers,
  body: InventoryProductionCreation,
): Request {
  return new Request(
    `https://localhost/v1/control/organisations/${journey.organisationId}/commerce/inventory/production-requests`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

class ProductionRecoveryService {
  readonly connect: Env["COMMERCE"]["connect"];
  readonly native: Env["COMMERCE"];
  dropped = false;
  stockReads = 0;

  constructor(native: Env["COMMERCE"]) {
    this.native = native;
    this.connect = native.connect.bind(native);
  }
  async fetch(
    input: RequestInfo | URL,
    options?: RequestInit,
  ): Promise<Response> {
    const request = new Request(input, options);
    if (request.url.endsWith("/inventory/snapshot")) {
      this.stockReads += 1;
      return Response.json(
        { message: "Acceptance stock read unavailable" },
        { status: 503 },
      );
    }
    const response = await this.native.fetch(request);
    if (
      !this.dropped &&
      request.url.endsWith("/entity-plane/commands") &&
      response.ok
    ) {
      this.dropped = true;
      throw new Error("Acceptance lost response after native commit");
    }
    return response;
  }
}

// Plan 81 slice 6: the agent proposes stock, production request and purchase
// request changes, through the person's commands, approvals and receipts. Each
// change happens only after an owner approves the exact card, happens one time,
// and is refused when the shelf moved after a count.
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { http, type HttpResponseResolver } from "msw";
import { isRecord } from "@purin-labs/std";
import {
  parseInventoryDeliveries,
  parseInventoryReceiptContext,
  type InventoryDeliveries,
  type InventoryReceiptContext,
} from "@purin-labs/kitchen-control-api";
import {
  parseCommerceGraphQuery,
  parseListEntryReadRequest,
  CommerceEntityPlaneClient,
} from "@purin-labs/commerce-client";
import { commerceActionTitle } from "../../../../apps/portal/src/features/governed-actions/commerce";
import {
  parseCommerceActionRecordResponse,
} from "@purin-labs/commerce-control-api/portal/commerce-actions";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import { googleConfig } from "../../src/control/google-oidc-config";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { completeCommerceApprovalFixture } from "./commerce-approval-fixture";
import { network } from "./network";
import { givePortalHandles } from "./permission-request-support";
import {
  MERCHANT,
  OWNER,
  installEffectAuthority,
  listingNonce,
  postControl,
  providerClient,
  sendListingMessage,
} from "./pi-sdk-effect-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  createRequiredGrant,
  discoverSlackChannel,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  slackSimulator,
} from "./slack-journey-support";
import { trustShopDeliveries } from "./commerce-journey-support";
import { toolOutput } from "./chat-journey-support";

const BASE = `https://localhost/v1/control/organisations/${ORGANISATION_ID}`;
const FLOUR_RECIPE = "recipe_sesame_cookie_stocked";
const REASON = "The person asked in the Case.";
const LOCATION = "location_cafe";

type Step = (last: string) => Promise<Response> | Response;

const NULLS = {
  inventoryPositionId: null,
  entryId: null,
  quantity: null,
  lotId: null,
  lotCode: null,
  lotExpiresAt: null,
  receivedAt: null,
  purchaseRequestEntryId: null,
  direction: null,
  adjustmentReason: null,
  recipeId: null,
  neededBy: null,
  status: null,
  owner: null,
  purchaseRequestId: null,
  expectedDeliveryAt: null,
  notes: null,
};

it("changes stock and purchasing only after an owner approves the exact change", async () => {
  await installSlackActorFixture().then(async (fixture) => {
    const slack = slackSimulator();
    const requests: Record<string, unknown>[] = [];
    const steps: Step[] = [];
    network.use(
      slack.handler,
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        respond.bind(null, requests, steps),
      ),
    );
    const session = await installEffectAuthority(
      fixture.selectedIntegrationAccountId,
      "plugin",
    );
    await grantStockReads(fixture.selectedIntegrationAccountId, [
      ["inventory_position", entityTypeScope("inventory_position")],
      ["inventory_item", entityTypeScope("inventory_item")],
      ["production_requests", listScope("production_requests")],
    ]);
    await givePortalHandles(ORGANISATION_ID);
    await discoverSlackChannel("public_channel", Date.now() - 60_000);
    const shop = await provisionShop(session);

    const say = async (
      marker: string,
      text: string,
      ts: string,
      script: readonly Step[],
    ): Promise<void> => {
      steps.push(...script);
      await sendListingMessage(
        "app_mention",
        `Ev${marker}`,
        ts,
        `<@U0PANTRY> ${text}`,
        ts,
      );
      await expect
        .poll(() => delivered(slack), { timeout: 20_000 })
        .toContain(marker);
      expect(steps).toEqual([]);
    };
    const turn = async (
      marker: string,
      text: string,
      ts: string,
      script: readonly Step[],
    ): Promise<string> => {
      await say(marker, text, ts, script);
      return listingNonce(requests);
    };

    // The agent's wrong proposals are refused in words that it can act on.
    const flour = await readContext(session, shop.flourPositionId);
    const receive = (fields: Record<string, unknown>) => ({
      request: {
        ...NULLS,
        kind: "receive_stock",
        reason: REASON,
        expectedRevision: flour.inventoryPositionRevision,
        inventoryPositionId: shop.flourPositionId,
        ...fields,
      },
    });
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const receiveNonce = await turn(
      "PI_STOCK_RECEIVE",
      "The flour delivery arrived, 5 kg, lot MILL-1.",
      "1710000300.000100",
      [
        ...discover(),
        readSeeds("inventory_position", shop.flourPositionId, "stock_a"),
        expectRead(() =>
          propose(
            receive({
              expectedRevision: flour.inventoryPositionRevision + 5,
              quantity: "5",
              lotCode: "MILL-1",
              lotExpiresAt: expiresAt,
            }),
            "stock_stale",
          ),
        ),
        (last) => {
          expect(last).toContain("Read this stock position");
          return propose(receive({ quantity: "5" }), "stock_no_lot");
        },
        (last) => {
          expect(last).toContain("needs lotCode");
          return propose(
            receive({
              quantity: "5",
              lotCode: "MILL-1",
              lotExpiresAt: expiresAt,
            }),
            "stock_receive",
          );
        },
        answer("PI_STOCK_RECEIVE"),
      ],
    );

    // The card reads the record that the approval signs.
    const card = await readCard(session, receiveNonce);
    expect(commerceActionTitle(card.verb)).toBe("Receive stock");
    if (
      card.details.kind !== "stock_operation" ||
      card.details.operation.kind !== "receive_stock"
    )
      throw new Error(`Unexpected card ${card.details.kind}`);
    expect(card.details.operation.quantity.amount).toBe(5);
    expect(card.details.operation.lot).toMatchObject({ lotCode: "MILL-1" });

    // No stock moves before the approval.
    const early = await postControl(
      session,
      `/${receiveNonce}/execute`,
      {},
      "pi-stock-early",
    );
    expect(early.status).toBe(409);
    const beforeReceipt = await readContext(session, shop.flourPositionId);
    expect(beforeReceipt.lots.map((lot) => lot.code)).not.toContain("MILL-1");

    const received = await approveAndExecute(session, receiveNonce, "receive");
    expect(received).toMatchObject({
      ok: true,
      action: { state: "confirmed" },
      receipt: { projectionKind: "stock_operation" },
    });
    const afterReceipt = await readContext(session, shop.flourPositionId);
    const newLot = afterReceipt.lots.find((lot) => lot.code === "MILL-1");
    expect(newLot?.quantity).toMatchObject({ amount: 5, scale: 0 });

    // A second execution returns the first result and adds nothing.
    const replayed = await postControl(
      session,
      `/${receiveNonce}/execute`,
      {},
      "pi-stock-receive-execute",
    );
    expect(await replayed.json()).toEqual(received);
    expect((await readContext(session, shop.flourPositionId)).lots).toEqual(
      afterReceipt.lots,
    );

    // A count that the shelf overtakes fails, and changes nothing.
    if (newLot === undefined) throw new Error("No new lot");
    const countNonce = await turn(
      "PI_STOCK_COUNT",
      "We threw away 1 kg of that lot.",
      "1710000400.000100",
      [
        ...discover(),
        readSeeds("inventory_position", shop.flourPositionId, "stock_b"),
        expectRead(() =>
          propose(
            {
              request: {
                ...NULLS,
                kind: "adjust_stock",
                reason: "Waste from a torn bag.",
                expectedRevision: afterReceipt.inventoryPositionRevision,
                inventoryPositionId: shop.flourPositionId,
                quantity: "1",
                lotId: newLot.id,
                direction: "decrease",
                adjustmentReason: "waste",
              },
            },
            "stock_adjust",
          ),
        ),
        answer("PI_STOCK_COUNT"),
      ],
    );
    expect(commerceActionTitle((await readCard(session, countNonce)).verb)).toBe(
      "Correct stock",
    );
    await personReceives(session, shop.flourPositionId, "later-delivery");
    const beforeCount = await readContext(session, shop.flourPositionId);
    const refused = await approveAndExecute(session, countNonce, "count");
    expect(refused).toMatchObject({
      ok: false,
      error: "commerce_action_provider_execution_failed",
    });
    expect((await readCard(session, countNonce)).state).toBe("failed");
    expect((await readContext(session, shop.flourPositionId)).lots).toEqual(
      beforeCount.lots,
    );

    // A production request starts as the person's does, and moves one step.
    const cookie = await readContext(session, shop.cookiePositionId);
    const neededBy = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const productionNonce = await turn(
      "PI_STOCK_PRODUCTION",
      "Ask the kitchen for 24 sesame cookies by Tuesday.",
      "1710000500.000100",
      [
        ...discover(),
        readSeeds("inventory_position", shop.cookiePositionId, "stock_c"),
        expectRead(() =>
          propose(
            {
              request: {
                ...NULLS,
                kind: "request_production",
                reason: "Tuesday's order.",
                expectedRevision: cookie.inventoryPositionRevision,
                inventoryPositionId: shop.cookiePositionId,
                quantity: "24",
                neededBy,
                recipeId: FLOUR_RECIPE,
              },
            },
            "stock_production",
          ),
        ),
        answer("PI_STOCK_PRODUCTION"),
      ],
    );
    await expect
      .poll(() => productionEntries(session))
      .toEqual([]);
    expect(
      await approveAndExecute(session, productionNonce, "production"),
    ).toMatchObject({ action: { state: "confirmed" } });
    const [request] = await productionEntries(session);
    if (request === undefined) throw new Error("No production request");
    expect(request.status).toBe("requested");
    expect(request.quantity).toMatchObject({ amount: 24 });
    expect(request.recipeId).toBe(FLOUR_RECIPE);

    const acceptNonce = await turn(
      "PI_STOCK_ACCEPT",
      "Accept that production request.",
      "1710000600.000100",
      [
        ...discover(),
        readList("production_requests", "stock_d"),
        expectEntries(() =>
          propose(
            {
              request: {
                ...NULLS,
                kind: "advance_production_request",
                reason: "The kitchen has room.",
                expectedRevision: request.revision,
                entryId: request.id,
                status: "scheduled",
              },
            },
            "stock_skip",
          ),
        ),
        (last) => {
          expect(last).toContain("must be accepted before");
          return propose(
            {
              request: {
                ...NULLS,
                kind: "advance_production_request",
                reason: "The kitchen has room.",
                expectedRevision: request.revision,
                entryId: request.id,
                status: "accepted",
              },
            },
            "stock_accept",
          );
        },
        answer("PI_STOCK_ACCEPT"),
      ],
    );
    expect(
      await approveAndExecute(session, acceptNonce, "accept"),
    ).toMatchObject({ action: { state: "confirmed" } });
    expect((await productionEntries(session))[0]?.status).toBe("accepted");

    // With no grant for purchase requests, the read is refused and the agent
    // asks a person to allow that one read.
    const open = await openPurchase(session, shop.flourPositionId);
    await say(
      "PI_STOCK_ASK",
      "Which purchase requests are open?",
      "1710000650.000100",
      [
        ...discover(),
        readList("replenishment_queue", "stock_denied"),
        (last) => {
          expect(last).toContain("commerce_context_authority_denied");
          return openRouterToolCall(
            "request_permission",
            { capabilityIds: [], entityTypeReads: ["replenishment_queue"] },
            "stock_ask",
          );
        },
        (last) => {
          expect(last).toContain("permission_requested");
          return openRouterText("PI_STOCK_ASK", "stock_ask_answer");
        },
      ],
    );
    expect(delivered(slack).toLowerCase()).toContain("read purchase requests");
    await grantStockReads(fixture.selectedIntegrationAccountId, [
      ["replenishment_queue", listScope("replenishment_queue")],
    ]);

    // A purchase request records the purchase, then a delivery answers it.
    const purchaseNonce = await turn(
      "PI_STOCK_PURCHASE",
      "I ordered that flour from the mill, PO-77, Sam owns it.",
      "1710000700.000100",
      [
        ...discover(),
        readList("replenishment_queue", "stock_e"),
        expectEntries(() =>
          propose(
            {
              request: {
                ...NULLS,
                kind: "update_purchase_request",
                reason: "The mill took the order.",
                expectedRevision: open.revision,
                entryId: open.id,
                owner: "Sam",
                purchaseRequestId: "PO-77",
                expectedDeliveryAt: neededBy,
              },
            },
            "stock_purchase",
          ),
        ),
        answer("PI_STOCK_PURCHASE"),
      ],
    );
    expect(
      await approveAndExecute(session, purchaseNonce, "purchase"),
    ).toMatchObject({ action: { state: "confirmed" } });
    const updated = await readEntry("replenishment_queue", open.id);
    const values = new Map(
      updated.attributeValues.map((attribute) => [
        String(attribute.attributeId),
        attribute.value,
      ]),
    );
    expect(values.get("owner")).toMatchObject({ value: "Sam" });
    expect(values.get("purchase_request_id")).toMatchObject({ value: "PO-77" });
    expect(values.get("status")).toMatchObject({ value: "expected" });
    // The stock timeline finds the purchase on its delivery date.
    const deliveries = await readDeliveries(session);
    expect(deliveries).toMatchObject({ kind: "ready", truncated: false });
    expect(
      deliveries.kind === "ready"
        ? deliveries.entries.find((entry) => entry.id === String(open.id))
        : undefined,
    ).toMatchObject({ status: "expected" });
    expect(
      deliveries.kind === "ready"
        ? Date.parse(
            deliveries.entries.find((entry) => entry.id === String(open.id))
              ?.expectedAt ?? "",
          )
        : 0,
    ).toBe(Date.parse(neededBy));

    const ordered = await readContext(session, shop.flourPositionId);
    if (ordered.purchases.kind !== "ready")
      throw new Error("Purchases unavailable");
    const expected = ordered.purchases.entries.find(
      (entry) => entry.id === open.id,
    );
    if (expected === undefined) throw new Error("No purchase to answer");
    const answerNonce = await turn(
      "PI_STOCK_DELIVERY",
      "That flour order arrived in full, lot MILL-2.",
      "1710000800.000100",
      [
        ...discover(),
        readPositionAndList(
          shop.flourPositionId,
          "replenishment_queue",
          "stock_f",
        ),
        expectEntries(() =>
          propose(
            receive({
              expectedRevision: ordered.inventoryPositionRevision,
              quantity: expected.required,
              lotCode: "MILL-2",
              lotExpiresAt: expiresAt,
              purchaseRequestEntryId: open.id,
            }),
            "stock_linked",
          ),
        ),
        answer("PI_STOCK_DELIVERY"),
      ],
    );
    expect(
      await approveAndExecute(session, answerNonce, "delivery"),
    ).toMatchObject({ action: { state: "confirmed" } });
    // The stock delivery reaches the records, and that closes the request.
    await expect
      .poll(
        async () =>
          (await readContext(session, shop.flourPositionId)).purchases,
        { timeout: 20_000 },
      )
      .toEqual({ kind: "ready", entries: [] });
  });
}, 180_000);

function entityTypeScope(typeId: "inventory_position" | "inventory_item") {
  return {
    kind: "entity_type" as const,
    entityTypeId: { origin: "system" as const, typeId },
  };
}

function listScope(listId: string) {
  const query = parseCommerceGraphQuery({
    kind: "commerce_list_page",
    listId,
    filter: { kind: "all" },
    sorts: [],
    pagination: { limit: 1, cursor: null },
  });
  if (query.kind !== "commerce_list_page") throw new Error("Invalid list");
  return { kind: "commerce_list" as const, listId: query.listId };
}

async function grantStockReads(
  slackAccountId: string,
  scopes: readonly (readonly [
    string,
    ReturnType<typeof entityTypeScope> | ReturnType<typeof listScope>,
  ])[],
): Promise<void> {
  const now = Date.now();
  for (const [name, scope] of scopes) {
    const target = {
      kind: "commerce_read" as const,
      capabilityId: "commerce.entity.read" as const,
      capabilityVersion: 1,
      scope,
    };
    await createRequiredGrant({
      grantId: `grant_stock_read_${name}`,
      subject: { kind: "organisation_role", role: "owner" },
      target,
      now,
    });
    await createRequiredGrant({
      grantId: `grant_stock_channel_${name}`,
      subject: {
        kind: "conversation",
        integrationAccountId: slackAccountId,
        conversationId: CHANNEL_ID,
      },
      target,
      now,
    });
  }
}

async function provisionShop(session: IssuedControlSession) {
  const client = providerClient();
  const provisioned = await client.provisionDemo({
    schemaVersion: "commerce.provision-demo.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  if (!provisioned.ok) throw new Error(JSON.stringify(provisioned.error));
  await trustShopDeliveries(MERCHANT);
  const stock = await readStock();
  const recipe = stock.foodService.resources.recipeRevisions.find(
    (candidate) => candidate.recipeId === FLOUR_RECIPE,
  );
  if (recipe === undefined || recipe.output.kind !== "stocked")
    throw new Error("No sesame cookie recipe");
  const flourItem = recipe.inputs[0]?.inventoryItemId;
  const position = (itemId: string | undefined) => {
    const found = stock.commerce.resources.inventoryPositions.find(
      (candidate) =>
        candidate.inventoryItemId === itemId &&
        candidate.locationId === LOCATION,
    );
    if (found === undefined) throw new Error(`No position for ${itemId}`);
    return found.id;
  };
  await postPerson(
    session,
    "commerce/inventory/production-requests",
    { kind: "setup" },
    "stock-setup-production",
  );
  return {
    flourItem: flourItem as string,
    flourPositionId: position(flourItem),
    cookiePositionId: position(recipe.output.inventoryItemId),
  };
}

async function readStock() {
  const stock = await providerClient().readStockSnapshot(MERCHANT);
  if (!stock.ok) throw new Error(JSON.stringify(stock.error));
  return stock.value;
}

function plane(): CommerceEntityPlaneClient {
  return new CommerceEntityPlaneClient({
    baseUrl: "http://commerce.test",
    serviceToken: "commerce-e2e-token",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
}

async function readEntry(listId: string, entryId: string) {
  const read = await plane().readListEntry(
    parseListEntryReadRequest({ merchantId: MERCHANT, listId, entryId }),
  );
  if (!read.ok || read.value.kind === "missing")
    throw new Error(`No entry ${entryId}`);
  return read.value.entry;
}

function controlHeaders(
  session: IssuedControlSession,
  key: string = crypto.randomUUID(),
): Record<string, string> {
  return {
    "content-type": "application/json",
    origin: "https://localhost",
    cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
    "x-pantry-csrf": session.csrfToken,
    "idempotency-key": key,
  };
}

async function postPerson(
  session: IssuedControlSession,
  path: string,
  body: unknown,
  key: string,
): Promise<void> {
  const response = await exports.default.fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: controlHeaders(session, key),
    body: JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function readDeliveries(
  session: IssuedControlSession,
): Promise<InventoryDeliveries> {
  const response = await exports.default.fetch(
    `${BASE}/commerce/inventory/deliveries`,
    { headers: controlHeaders(session) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { deliveries?: unknown };
  return parseInventoryDeliveries(body.deliveries);
}

async function readContext(
  session: IssuedControlSession,
  positionId: string,
): Promise<InventoryReceiptContext> {
  const response = await exports.default.fetch(
    `${BASE}/commerce/inventory/receipts?position=${encodeURIComponent(positionId)}`,
    { headers: controlHeaders(session) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return parseInventoryReceiptContext(await response.json());
}

/** The person's own delivery, on the page, while a proposal waits. */
async function personReceives(
  session: IssuedControlSession,
  positionId: string,
  key: string,
): Promise<void> {
  const context = await readContext(session, positionId);
  await postPerson(
    session,
    "commerce/inventory/receipts",
    {
      merchantRevision: context.merchantRevision,
      inventoryItemId: context.inventoryItemId,
      inventoryItemRevision: context.inventoryItemRevision,
      inventoryPositionId: context.inventoryPositionId,
      inventoryPositionRevision: context.inventoryPositionRevision,
      locationId: context.locationId,
      receivedQuantity: { amount: 2, scale: 0, unit: context.unit },
      purchase: { kind: "unlinked" },
      lot: {
        kind: "tracked",
        lotId: `lot_${key}`,
        lotCode: key,
        expiry: {
          kind: "expires",
          expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        },
      },
      receiptId: `receipt_${key}`,
      receiptLineId: "1",
      receivedAt: new Date().toISOString(),
    },
    key,
  );
}

async function productionEntries(session: IssuedControlSession) {
  const response = await exports.default.fetch(
    `${BASE}/commerce/inventory/production-requests`,
    { headers: controlHeaders(session) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body.demand))
    throw new Error("No production demand");
  const requests = Array.isArray(body.demand.requests)
    ? (body.demand.requests as Record<string, unknown>[])
    : [];
  return requests.map((request) => ({
    id: String(request.id),
    revision: Number(request.revision),
    status: String(request.status),
    quantity: request.quantity,
    recipeId: String(request.recipeId),
  }));
}

/** Opens one purchase request as the person's purchasing setup does. */
async function openPurchase(
  session: IssuedControlSession,
  positionId: string,
): Promise<Readonly<{ id: string; revision: number }>> {
  const context = await readContext(session, positionId);
  const stock = await readStock();
  const usable = stock.usable.find(
    (candidate) => candidate.positionId === positionId,
  );
  if (usable === undefined) throw new Error("No usable flour");
  const amount = usable.quantity.amount / 10 ** usable.quantity.scale;
  const configured = await providerClient().configureStockPolicy({
    merchantId: MERCHANT,
    expectedMerchantRevision: stock.commerce.merchantRevision,
    idempotencyKey: "stock-flour-policy",
    stockPolicy: {
      stockPolicyId: "policy_flour",
      inventoryItemId: context.inventoryItemId,
      locationId: context.locationId,
      replenishment: {
        kind: "threshold",
        reorderPoint: { amount: amount + 5, scale: 0, unit: context.unit },
        targetQuantity: { amount: amount + 10, scale: 0, unit: context.unit },
      },
    },
  });
  if (!configured.ok) throw new Error(JSON.stringify(configured.error));
  await postPerson(
    session,
    "commerce/purchasing/activate",
    {},
    "stock-purchasing-activate",
  );
  await postPerson(
    session,
    "commerce/suppliers",
    {
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
      inventoryItemIds: [context.inventoryItemId],
    },
    "stock-supplier",
  );
  const purchases = (await readContext(session, positionId)).purchases;
  if (purchases.kind !== "ready" || purchases.entries[0] === undefined)
    throw new Error("No purchase request");
  return purchases.entries[0];
}

async function readCard(session: IssuedControlSession, nonce: string) {
  return parseCommerceActionRecordResponse(
    await (
      await exports.default.fetch(`${BASE}/commerce/actions/${nonce}`, {
        headers: controlHeaders(session),
      })
    ).json(),
  );
}

async function approveAndExecute(
  session: IssuedControlSession,
  nonce: string,
  name: string,
): Promise<unknown> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const action = await organisation.getAction({
    organisationId: ORGANISATION_ID,
    nonce,
    now: Date.now(),
  });
  if (!action.ok) throw new Error(action.error.code);
  const config = googleConfig(env);
  if (config === null) throw new Error("Missing approval configuration");
  const grant = await completeCommerceApprovalFixture({
    db: env.DB,
    config,
    action: action.value.action,
    userId: OWNER,
    subject: "e2e-slack-actor",
    email: "e2e-slack-actor@example.invalid",
    stepUpId: `pi-stock-${name}-step-up`,
  });
  const approved = await postControl(
    session,
    `/${nonce}/approval`,
    {},
    `pi-stock-${name}-approve`,
    grant,
  );
  expect(approved.status, await approved.clone().text()).toBe(200);
  const executed = await postControl(
    session,
    `/${nonce}/execute`,
    {},
    name === "receive" ? "pi-stock-receive-execute" : `pi-stock-${name}-execute`,
  );
  return executed.json();
}

function delivered(slack: ReturnType<typeof slackSimulator>): string {
  return slack.messages.map((message) => message.text).join("\n");
}

function discover(): readonly Step[] {
  return [
    () =>
      openRouterToolCall(
        "tool_search",
        { query: "commerce_entity_context", limit: 1 },
        `stock_discover_read_${crypto.randomUUID()}`,
      ),
    () =>
      openRouterToolCall(
        "tool_search",
        { query: "commerce_propose_stock_action", limit: 1 },
        `stock_discover_${crypto.randomUUID()}`,
      ),
  ];
}

function readSeeds(typeId: string, entityId: string, callId: string): Step {
  return () =>
    readWith(
      {
        kind: "entity_seeds",
        seeds: [{ origin: "system", typeId, entityId }],
      },
      callId,
    );
}

function listSelection(listId: string) {
  return {
    kind: "selector",
    selector: {
      selectorId: `list:${listId}`,
      revision: 1,
      query: {
        kind: "commerce_list_page",
        listId,
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 10, cursor: null },
      },
    },
  };
}

function readList(listId: string, callId: string): Step {
  return () => readWith(listSelection(listId), callId);
}

/** Code Mode runs one script in a turn, so one script makes both reads. */
function readPositionAndList(
  positionId: string,
  listId: string,
  callId: string,
): Step {
  const position = contextRequest({
    kind: "entity_seeds",
    seeds: [{ origin: "system", typeId: "inventory_position", entityId: positionId }],
  });
  const list = contextRequest(listSelection(listId));
  return () =>
    openRouterToolCall(
      "codemode",
      {
        code: `const position = await tools.commerce_entity_context({ request: ${JSON.stringify(position)} });\nconst list = await tools.commerce_entity_context({ request: ${JSON.stringify(list)} });\nif (!position.ok || !list.ok) throw new Error("Denied");\ntext("entries=" + list.result.listEntries.length);`,
      },
      callId,
    );
}

function contextRequest(selection: unknown) {
  return {
    selection,
    traversal: { maxDepth: 0, resultLimit: 10 },
    allowedSensitivity: "internal",
    allowedAttributeIds: [],
    freshnessRequirement: "current_only",
  };
}

function readWith(selection: unknown, callId: string): Response {
  const request = contextRequest(selection);
  return openRouterToolCall(
    "codemode",
    {
      code: `const graph = await tools.commerce_entity_context({ request: ${JSON.stringify(request)} });\nif (!graph.ok) throw new Error(graph.error.message);\ntext("entities=" + graph.result.entities.length + " entries=" + graph.result.listEntries.length);`,
    },
    callId,
  );
}

function expectRead(next: () => Response): Step {
  return (last) => {
    expect(last).toContain("entities=1");
    return next();
  };
}

function expectEntries(next: () => Response): Step {
  return (last) => {
    expect(last).toMatch(/entries=[1-9]/u);
    return next();
  };
}

function propose(
  args: Readonly<Record<string, unknown>>,
  callId: string,
): Response {
  return openRouterToolCall("commerce_propose_stock_action", args, callId);
}

function answer(marker: string): Step {
  return (last) => {
    expect(last).toContain("commerce_action_proposed");
    return openRouterText(marker, `stock_${marker}`);
  };
}

async function respond(
  requests: Record<string, unknown>[],
  steps: Step[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid stock model request");
  requests.push(body);
  const step = steps.shift();
  if (step === undefined)
    throw new Error(`Unexpected model request ${requests.length}`);
  return step(toolOutput(body));
}

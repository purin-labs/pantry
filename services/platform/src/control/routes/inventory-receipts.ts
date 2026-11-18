import { pantryCommerceAccess } from "../../commerce/app-access";
import type {
  InventoryDeliveries,
  InventoryDelivery,
  InventoryReceiptContext,
} from "@seams/control-api";
import {
  parseReceiveInventoryCommand,
  parseReconcileInventoryCommand,
  commerceCommandInput,
  parseCommerceGraphQuery,
  CommerceEntityPlaneClient,
  type ReconcileCommerceInventoryV1,
  type ReceiveCommerceInventoryV3,
  type CommerceStockSnapshot,
} from "@seams/commerce-client";
import { inventoryQuantity } from "../../commerce/inventory-overview";
import type { Env } from "../../env";
import { controlError, controlJson, readJsonRecord } from "../http";
import {
  resolveInventoryAccess,
  resolveInventoryMutation,
  finishInventoryOperation,
} from "./inventory-control";

export async function handleInventoryReceipt(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  operation: "receipt" | "reconciliation",
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  const access = await resolveInventoryAccess(
    request,
    env,
    organisationIdRaw,
    request.method === "GET" ? "viewer" : "operator",
  );
  if (!access.ok) return access.response;
  const { authorized, binding, client } = access.value;

  if (request.method === "GET") {
    const positionId = new URL(request.url).searchParams.get("position");
    if (positionId === null || positionId.length === 0)
      return controlError("inventory_position_missing", 422);
    const snapshot = await client.readStockSnapshot(binding.merchantId);
    if (!snapshot.ok) return controlError("underclerk_unavailable", 503);
    if (snapshot.value.commerce.merchantId !== binding.merchantId)
      return controlError("underclerk_scope_mismatch", 502);
    const context = receiptContext(snapshot.value, positionId);
    if (context !== null && operation === "receipt") {
      const purchases = await readPurchases(
        env,
        String(authorized.organisationId),
        binding.merchantId,
        context.inventoryItemId,
        context.locationId,
      );
      return controlJson({ ok: true, context: { ...context, purchases } });
    }
    return context === null
      ? controlError("inventory_position_missing", 404)
      : controlJson({ ok: true, context });
  }

  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("inventory_receipt_invalid", 422);
  const mutation = await resolveInventoryMutation(
    request,
    env,
    access.value,
    body.value,
    operation === "receipt" ? "inventory.receive" : "inventory.reconcile",
  );
  if (!mutation.ok) return mutation.response;
  const boundary = mutation.value.boundary;
  let command: ReceiveCommerceInventoryV3 | ReconcileCommerceInventoryV1;
  try {
    command =
      operation === "receipt"
        ? parseReceiveInventoryCommand({
            schemaVersion: "underclerk.receive-inventory.v3",
            purchase: body.value.purchase,
            organisationId: authorized.organisationId,
            merchantId: binding.merchantId,
            expectedMerchantRevision: body.value.merchantRevision,
            inventoryItemId: body.value.inventoryItemId,
            inventoryItemRevision: body.value.inventoryItemRevision,
            inventoryPositionId: body.value.inventoryPositionId,
            inventoryPositionRevision: body.value.inventoryPositionRevision,
            locationId: body.value.locationId,
            receivedQuantity: body.value.receivedQuantity,
            lot: body.value.lot,
            receiptId: body.value.receiptId,
            receiptLineId: body.value.receiptLineId,
            receivedAt: body.value.receivedAt,
            requestedAt: body.value.receivedAt,
            idempotencyKey: boundary.idempotencyKey,
            actionNonce: `inventory_receipt:${boundary.idempotencyKey}`,
          })
        : parseReconcileInventoryCommand({
            schemaVersion: "underclerk.reconcile-inventory.v1",
            organisationId: authorized.organisationId,
            merchantId: binding.merchantId,
            expectedMerchantRevision: body.value.merchantRevision,
            inventoryPositionId: body.value.inventoryPositionId,
            inventoryPositionRevision: body.value.inventoryPositionRevision,
            target: body.value.target,
            change: body.value.change,
            requestedAt: body.value.requestedAt,
            idempotencyKey: boundary.idempotencyKey,
            actionNonce: `inventory_reconciliation:${boundary.idempotencyKey}`,
          });
  } catch {
    return controlError("inventory_receipt_invalid", 422);
  }
  const received =
    command.schemaVersion === "underclerk.receive-inventory.v3"
      ? await client.receiveInventory(commerceCommandInput(command))
      : await client.reconcileInventory(commerceCommandInput(command));
  if (!received.ok) return controlError("underclerk_unavailable", 503);
  if (
    received.value.outcome === "rejected" &&
    received.value.error.code === "inventory_count_shortage"
  )
    return controlJson(
      {
        ok: false,
        error: "inventory_count_shortage",
        shortage: received.value.error,
        result: received.value,
      },
      409,
    );
  if (received.value.outcome === "rejected")
    return controlJson(
      {
        ok: false,
        error:
          received.value.error.code === "invalid_command"
            ? "inventory_receipt_invalid"
            : received.value.error.code,
        result: received.value,
      },
      409,
    );
  if (received.value.receipt.merchantId !== binding.merchantId)
    return controlError("underclerk_scope_mismatch", 502);
  const responseBody = { ok: true, result: received.value };
  return finishInventoryOperation(request, env, mutation.value, responseBody);
}

function receiptContext(
  snapshot: CommerceStockSnapshot,
  positionId: string,
): InventoryReceiptContext | null {
  const resources = snapshot.commerce.resources;
  for (const position of resources.inventoryPositions) {
    if (position.id !== positionId) continue;
    for (const item of resources.inventoryItems) {
      if (item.id !== position.inventoryItemId || item.lifecycle !== "active")
        continue;
      for (const location of resources.locations) {
        if (location.id !== position.locationId) continue;
        return {
          merchantRevision: snapshot.commerce.merchantRevision,
          inventoryItemId: item.id,
          inventoryItemRevision: item.revision,
          inventoryPositionId: position.id,
          inventoryPositionRevision: position.revision,
          locationId: location.id,
          itemName: item.name,
          locationName: location.name,
          unit: item.baseUnit,
          tracking: item.tracking,
          onHand:
            position.balance.kind === "accounted"
              ? inventoryQuantity(position.balance.onHand)
              : null,
          available: inventoryQuantity(usableQuantity(snapshot, position.id)),
          allocated:
            position.balance.kind === "accounted"
              ? inventoryQuantity(position.balance.allocated)
              : null,
          onHandQuantity:
            position.balance.kind === "accounted"
              ? position.balance.onHand
              : null,
          lots: snapshot.lots
            .filter(
              lotForPosition.bind(
                null,
                position.inventoryItemId,
                position.locationId,
              ),
            )
            .map(lotContext),
          purchases: { kind: "unavailable" },
        };
      }
    }
  }
  return null;
}

function lotForPosition(
  itemId: string,
  locationId: string,
  lot: CommerceStockSnapshot["lots"][number],
): boolean {
  return lot.inventoryItemId === itemId && lot.locationId === locationId;
}
function lotContext(lot: CommerceStockSnapshot["lots"][number]) {
  return {
    id: lot.id,
    revision: lot.revision,
    code: lot.lotCode,
    quantity: lot.remainingQuantity,
  };
}
/** The pages of open purchases that one read carries: 500 purchases. */
const MAX_DELIVERY_PAGES = 5;

/**
 * Every open purchase of the shop with its delivery date, for the stock
 * timeline. The list keeps the date on the purchase, so one read serves a week
 * or a month. A person who may read stock may read this.
 */
export async function handleInventoryDeliveries(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const access = await resolveInventoryAccess(
    request,
    env,
    organisationIdRaw,
    "viewer",
  );
  if (!access.ok) return access.response;
  const { authorized, binding } = access.value;
  const deliveries = await readDeliveries(
    env,
    String(authorized.organisationId),
    binding.merchantId,
  );
  return controlJson({ ok: true, deliveries });
}

async function readDeliveries(
  env: Env,
  organisationId: string,
  merchantId: string,
): Promise<InventoryDeliveries> {
  if (
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  )
    return { kind: "unavailable" };
  const client = new CommerceEntityPlaneClient({
    baseUrl: env.UNDERCLERK_BASE_URL,
    ...pantryCommerceAccess(
      env.UNDERCLERK_SERVICE_TOKEN,
      organisationId,
      env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
    ),
  });
  const entries: InventoryDelivery[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_DELIVERY_PAGES; page += 1) {
    const result: Awaited<ReturnType<typeof client.query>> = await client.query(
      {
        merchantId,
        query: parseCommerceGraphQuery({
          kind: "commerce_list_page",
          listId: "replenishment_queue",
          filter: {
            kind: "not",
            filter: {
              kind: "attribute",
              filter: {
                operator: "equals",
                attributeId: "status",
                value: { kind: "status", value: "received" },
              },
            },
          },
          sorts: [],
          pagination: { limit: 100, cursor },
        }),
      },
    );
    if (!result.ok) return { kind: "unavailable" };
    for (const entry of result.value.listEntries) {
      const attributes = new Map(entry.attributeValues.map(purchaseAttribute));
      entries.push({
        id: String(entry.entryId),
        inventoryItemId: attributes.get("inventory_item_id") ?? "",
        locationId: attributes.get("location_id") ?? "",
        supplier: attributes.get("supplier_id") ?? "Supplier linkage missing",
        status: attributes.get("status") ?? "requested",
        required: attributes.get("required_quantity") ?? "Not reported",
        received: attributes.get("received_quantity") ?? "Not reported",
        expectedAt: attributes.get("expected_delivery_at") || null,
      });
    }
    cursor = result.value.nextCursor;
    if (cursor === null) break;
  }
  return { kind: "ready", entries, truncated: cursor !== null };
}

async function readPurchases(
  env: Env,
  organisationId: string,
  merchantId: string,
  itemId: string,
  locationId: string,
): Promise<InventoryReceiptContext["purchases"]> {
  if (
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  )
    return { kind: "unavailable" };
  const client = new CommerceEntityPlaneClient({
    baseUrl: env.UNDERCLERK_BASE_URL,
    ...pantryCommerceAccess(
      env.UNDERCLERK_SERVICE_TOKEN,
      organisationId,
      env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
    ),
  });
  const entries = [];
  let cursor: string | null = null;
  do {
    const result: Awaited<ReturnType<typeof client.query>> = await client.query(
      {
        merchantId,
        query: parseCommerceGraphQuery({
          kind: "commerce_list_page",
          listId: "replenishment_queue",
          filter: {
            kind: "not",
            filter: {
              kind: "any",
              filters: [
                {
                  kind: "not",
                  filter: {
                    kind: "attribute",
                    filter: {
                      operator: "equals",
                      attributeId: "inventory_item_id",
                      value: { kind: "short_text", value: itemId },
                    },
                  },
                },
                {
                  kind: "not",
                  filter: {
                    kind: "attribute",
                    filter: {
                      operator: "equals",
                      attributeId: "location_id",
                      value: { kind: "short_text", value: locationId },
                    },
                  },
                },
                {
                  kind: "attribute",
                  filter: {
                    operator: "equals",
                    attributeId: "status",
                    value: { kind: "status", value: "received" },
                  },
                },
              ],
            },
          },
          sorts: [],
          pagination: { limit: 100, cursor },
        }),
      },
    );
    if (!result.ok) return { kind: "unavailable" };
    for (const entry of result.value.listEntries) {
      const attributes = new Map(entry.attributeValues.map(purchaseAttribute));
      entries.push({
        id: String(entry.entryId),
        revision: Number(entry.revision),
        supplier: attributes.get("supplier_id") ?? "Supplier linkage missing",
        required: attributes.get("required_quantity") ?? "Not reported",
        received: attributes.get("received_quantity") ?? "Not reported",
      });
    }
    cursor = result.value.nextCursor;
  } while (cursor !== null);
  return { kind: "ready", entries };
}
function purchaseAttribute(
  attribute: import("@seams/contracts").ListEntryAttributeValue,
): [string, string] {
  const value = attribute.value;
  switch (value.kind) {
    case "short_text":
    case "status":
    case "timestamp":
      return [String(attribute.attributeId), String(value.value)];
    case "decimal":
      return [
        String(attribute.attributeId),
        String(Number(value.value.unscaled) / 10 ** value.value.scale),
      ];
    default:
      return [String(attribute.attributeId), ""];
  }
}

function usableQuantity(snapshot: CommerceStockSnapshot, positionId: string) {
  for (const usable of snapshot.usable)
    if (usable.positionId === positionId) return usable.quantity;
  throw new Error("Usable stock quantity missing");
}

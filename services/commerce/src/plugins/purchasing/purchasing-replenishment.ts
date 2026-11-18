import type {
  PurchaseRequestStatus,
  AttributeValue,
  CommerceCommandResult,
  CommerceEntityPlaneCommand,
  CommerceList,
  CommerceListEntry,
  ListEntryAttributeValue,
} from "@seams/commerce-contracts";
import {
  parseAttributeOptionId,
  parseCommerceCommandId,
  parseFoodServiceObservation,
} from "@seams/commerce-client";
import {
  readInventoryItem,
  readInventoryPositionForItemLocation,
  listInventoryLots,
} from "../../inventory-persistence.ts";
import { usableInventoryQuantity } from "../../commerce-authority/inventory-planning.ts";
import type { CommerceInventoryLotV1 } from "@seams/commerce-client";
import type { CommerceDatabase } from "../../database.ts";
import type { PurchasingReconciliationResult } from "../built-in-ports.ts";
import {
  CommerceLists,
  type StoredListEntryRow,
} from "../../entity-plane/commerce-lists.ts";
import { readMerchant } from "../../entity-plane/entities.ts";
import {
  parseCommerceEntityPlaneCommand,
  parseCommerceList,
  parseSnapshotRevision,
} from "../../entity-plane/parsers.ts";
import {
  REPLENISHMENT_QUEUE,
  REPLENISHMENT_QUEUE_LIST_ID,
} from "./purchasing-preset.ts";
import type { EntityPlaneMutationRequest } from "../../entity-plane/receipt-outbox-settlement.ts";
import { readLatestFoodServiceJson } from "../food-service/index.ts";
import {
  purchaseRequestMoveAllowed,
  purchaseRequestStatus,
  receivedForRequest,
} from "./purchase-request.ts";

const QUANTITY_SCALE = 6;
const SYSTEM_OWNER = "CafeOS purchasing";

type ExecuteEntityPlaneMutation = (
  request: EntityPlaneMutationRequest,
) => CommerceCommandResult;

type ReplenishmentStatus = PurchaseRequestStatus;

type PositionRow = Readonly<{
  inventoryPositionId: string;
  revision: number;
  availableAmount: number;
  quantityScale: number;
  quantityUnit: string;
}>;

type ReplenishmentRequirement = Readonly<{
  stockPolicyId: string;
  inventoryItemId: string;
  locationId: string;
  positionRevision: number;
  available: number;
  reorderPoint: number;
  target: number;
  required: number;
  unit: string;
  supplierId: string;
}>;

export type PurchasingReplenishmentOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  commerceLists: CommerceLists;
  executeMutation: ExecuteEntityPlaneMutation;
}>;

export class PurchasingReplenishment {
  readonly #database: CommerceDatabase;
  readonly #now: () => string;
  readonly #commerceLists: CommerceLists;
  readonly #executeMutation: ExecuteEntityPlaneMutation;

  constructor(options: PurchasingReplenishmentOptions) {
    this.#database = options.database;
    this.#now = options.now;
    this.#commerceLists = options.commerceLists;
    this.#executeMutation = options.executeMutation;
  }

  reconcile(merchantId: string): PurchasingReconciliationResult {
    const storedList = this.#commerceLists.readList(
      merchantId,
      REPLENISHMENT_QUEUE.listId,
    );
    if (storedList === undefined || storedList.lifecycleState !== "published") {
      return { kind: "inactive" };
    }
    const list = parseCommerceList(JSON.parse(storedList.definitionJson));
    const entries = this.#activeQueueEntries(merchantId);
    const closedEntryIds = new Set<string>();
    let updated = 0;
    let received = 0;
    for (const entry of entries) {
      const outcome = this.#reconcileEntry(merchantId, list, entry);
      if (outcome === "unchanged") continue;
      updated += 1;
      if (outcome === "received") {
        received += 1;
        closedEntryIds.add(String(entry.entryId));
      }
    }

    const requirements = this.#requirements(merchantId);
    let opened = 0;
    for (const requirement of requirements) {
      if (
        hasOpenRequirement(entries, requirement.stockPolicyId, closedEntryIds)
      ) {
        continue;
      }
      const result = this.#openRequirement(merchantId, list, requirement);
      if (result.status !== "accepted") {
        throw new Error(
          `Replenishment recipe could not open ${requirement.stockPolicyId}: ${result.error.code}`,
        );
      }
      opened += 1;
    }
    return { kind: "reconciled", opened, updated, received };
  }

  #activeQueueEntries(merchantId: string): readonly CommerceListEntry[] {
    const rows = this.#database
      .prepare(
        `SELECT entry_id AS entryId, list_id AS listId, list_revision AS listRevision,
              entity_origin AS entityOrigin, entity_type_id AS entityTypeId,
              entity_id AS entityId, revision, lifecycle_state AS lifecycleState
         FROM commerce_list_entry
        WHERE merchant_id = ? AND list_id = ? AND lifecycle_state = 'active'
        ORDER BY entry_id`,
      )
      .all<StoredListEntryRow>(merchantId, REPLENISHMENT_QUEUE_LIST_ID);
    const entries: CommerceListEntry[] = [];
    for (const row of rows)
      entries.push(this.#commerceLists.hydrateEntry(merchantId, row));
    return entries;
  }

  #reconcileEntry(
    merchantId: string,
    list: CommerceList,
    entry: CommerceListEntry,
  ): "unchanged" | "updated" | "received" {
    const status = statusAttribute(entry);
    if (status === "received") return "unchanged";
    const inventoryItemId = textAttribute(entry, "inventory_item_id");
    const locationId = textAttribute(entry, "location_id");
    const required = decimalAttribute(entry, "required_quantity");
    const receivedQuantity = receivedForRequest(
      this.#database,
      merchantId,
      String(entry.entryId),
      {
        inventoryItemId,
        locationId,
        unit: textAttribute(entry, "quantity_unit"),
        required,
      },
    );
    const deliveryPassed = isPastExpectedDelivery(entry, this.#now());
    let desiredStatus: ReplenishmentStatus = status;
    if (receivedQuantity >= required) desiredStatus = "received";
    else if (receivedQuantity > 0) desiredStatus = "partial";
    else if (deliveryPassed) desiredStatus = "late";
    // Each move goes through the purchase request machine.
    if (
      desiredStatus !== status &&
      !purchaseRequestMoveAllowed(status, desiredStatus, {
        received: receivedQuantity,
        required,
        deliveryPassed,
      })
    )
      desiredStatus = status;
    const closedAt = desiredStatus === "received" ? this.#now() : null;
    const recordedReceived = decimalAttribute(entry, "received_quantity");
    if (desiredStatus === status && recordedReceived === receivedQuantity) {
      return "unchanged";
    }
    const attributes = updatedEntryAttributes(
      list,
      entry.attributeValues,
      desiredStatus,
      receivedQuantity,
      closedAt,
    );
    const command = parseCommerceEntityPlaneCommand({
      kind: "patch_commerce_list_entry",
      command: {
        target: {
          entry: {
            entryId: entry.entryId,
            listId: entry.listId,
            revision: entry.revision,
          },
          expectedRevision: entry.revision,
        },
        expectedListRevision: list.publishedRevision,
        attributeValues: attributes,
      },
    });
    const result = this.#execute(
      merchantId,
      `recipe:replenishment:${String(entry.entryId)}:${desiredStatus}:${receivedQuantity}`,
      command,
    );
    if (result.status !== "accepted") {
      throw new Error(
        `Replenishment recipe could not update ${String(entry.entryId)}: ${result.error.code}`,
      );
    }
    return desiredStatus === "received" ? "received" : "updated";
  }

  #requirements(merchantId: string): readonly ReplenishmentRequirement[] {
    const policies = readLatestFoodServiceJson(
      this.#database,
      merchantId,
      "stock_policy",
    ).map((resourceJson) => ({ resourceJson }));
    const requirements: ReplenishmentRequirement[] = [];
    const lots = listInventoryLots(this.#database, merchantId);
    const observedAt = this.#now();
    for (const row of policies) {
      const observation = parseFoodServiceObservation({
        kind: "stock_policy",
        resource: JSON.parse(row.resourceJson),
      });
      if (
        observation.kind !== "stock_policy" ||
        observation.resource.lifecycle !== "active"
      )
        continue;
      const policy = observation.resource;
      if (policy.replenishment.kind !== "threshold") continue;
      const position = this.#position(
        merchantId,
        String(policy.inventoryItemId),
        String(policy.locationId),
        lots,
        observedAt,
      );
      if (
        position === undefined ||
        position.quantityUnit !== policy.replenishment.reorderPoint.unit ||
        position.quantityUnit !== policy.replenishment.targetQuantity.unit
      )
        continue;
      const available = scaleQuantity(
        position.availableAmount,
        position.quantityScale,
      );
      const reorderPoint = scaleQuantity(
        policy.replenishment.reorderPoint.amount,
        policy.replenishment.reorderPoint.scale,
      );
      if (available >= reorderPoint) continue;
      const target = scaleQuantity(
        policy.replenishment.targetQuantity.amount,
        policy.replenishment.targetQuantity.scale,
      );
      const required = target - available;
      if (required <= 0) continue;
      const supplierId = this.#configuredSupplier(
        merchantId,
        String(policy.inventoryItemId),
      );
      if (supplierId === null) continue;
      requirements.push({
        stockPolicyId: String(policy.stockPolicyId),
        inventoryItemId: String(policy.inventoryItemId),
        locationId: String(policy.locationId),
        positionRevision: position.revision,
        available,
        reorderPoint,
        target,
        required,
        unit: position.quantityUnit,
        supplierId,
      });
    }
    return requirements;
  }

  #position(
    merchantId: string,
    inventoryItemId: string,
    locationId: string,
    lots: readonly CommerceInventoryLotV1[],
    observedAt: string,
  ): PositionRow | undefined {
    const item = readInventoryItem(this.#database, merchantId, inventoryItemId);
    const position = readInventoryPositionForItemLocation(
      this.#database,
      merchantId,
      inventoryItemId,
      locationId,
    );
    if (item === undefined || position === undefined) return undefined;
    const available = usableInventoryQuantity(item, position, lots, observedAt);
    return {
      inventoryPositionId: position.id,
      revision: position.revision,
      availableAmount: available.amount,
      quantityScale: available.scale,
      quantityUnit: available.unit,
    };
  }

  #configuredSupplier(
    merchantId: string,
    inventoryItemId: string,
  ): string | null {
    const rows = this.#database
      .prepare(
        `SELECT relationship.source_entity_id AS supplierId
         FROM commerce_relationship AS relationship
         JOIN custom_entity AS supplier
           ON supplier.merchant_id = relationship.merchant_id
          AND supplier.entity_id = relationship.source_entity_id
          AND supplier.entity_type_id = 'trade_partner'
          AND supplier.lifecycle_state = 'active'
         JOIN commerce_list_entry AS directory
           ON directory.merchant_id = supplier.merchant_id
          AND directory.list_id = 'supplier_directory'
          AND directory.entity_origin = 'custom'
          AND directory.entity_type_id = 'trade_partner'
          AND directory.entity_id = supplier.entity_id
          AND directory.lifecycle_state = 'active'
        WHERE relationship.merchant_id = ?
          AND relationship.relationship_definition_id = 'supplier_inventory_item'
          AND relationship.lifecycle_state = 'active'
          AND relationship.source_origin = 'custom'
          AND relationship.source_type_id = 'trade_partner'
          AND relationship.target_origin = 'system'
          AND relationship.target_type_id = 'inventory_item'
          AND relationship.target_entity_id = ?
        ORDER BY relationship.source_entity_id`,
      )
      .all<Readonly<{ supplierId: string }>>(merchantId, inventoryItemId);
    return rows.length === 1 && rows[0] !== undefined
      ? rows[0].supplierId
      : null;
  }

  #openRequirement(
    merchantId: string,
    list: CommerceList,
    requirement: ReplenishmentRequirement,
  ): CommerceCommandResult {
    const openedAt = this.#now();
    const entryId = `replenishment_${requirement.stockPolicyId}_${requirement.positionRevision}`;
    const attributes = openingAttributes(list, requirement, openedAt);
    const command = parseCommerceEntityPlaneCommand({
      kind: "add_commerce_list_entry",
      command: {
        entryId,
        listId: list.listId,
        expectedListRevision: list.publishedRevision,
        entityRef: {
          origin: "system",
          typeId: "stock_policy",
          entityId: requirement.stockPolicyId,
        },
        attributeValues: attributes,
        revision: 1,
      },
    });
    return this.#execute(
      merchantId,
      `recipe:replenishment:open:${entryId}`,
      command,
    );
  }

  #execute(
    merchantId: string,
    commandId: string,
    command: CommerceEntityPlaneCommand,
  ): CommerceCommandResult {
    const merchant = readMerchant(this.#database, merchantId);
    if (merchant === undefined)
      throw new Error(`Merchant not found: ${merchantId}`);
    return this.#executeMutation({
      organisationId: merchant.organisationId,
      merchantId,
      commandId: parseCommerceCommandId(commandId),
      expectedMerchantRevision: parseSnapshotRevision(
        merchant.revision,
        "expectedMerchantRevision",
      ),
      command,
    });
  }
}

function openingAttributes(
  list: CommerceList,
  requirement: ReplenishmentRequirement,
  openedAt: string,
): readonly ListEntryAttributeValue[] {
  return [
    listAttribute(list, "status", {
      kind: "status",
      value: parseAttributeOptionId("needs_review"),
    }),
    listAttribute(list, "supplier_id", {
      kind: "short_text",
      value: requirement.supplierId,
    }),
    listAttribute(list, "owner", { kind: "short_text", value: SYSTEM_OWNER }),
    listAttribute(list, "inventory_item_id", {
      kind: "short_text",
      value: requirement.inventoryItemId,
    }),
    listAttribute(list, "location_id", {
      kind: "short_text",
      value: requirement.locationId,
    }),
    listAttribute(list, "opened_at", { kind: "timestamp", value: openedAt }),
    listAttribute(
      list,
      "available_quantity",
      decimalValue(requirement.available),
    ),
    listAttribute(
      list,
      "reorder_point",
      decimalValue(requirement.reorderPoint),
    ),
    listAttribute(list, "target_quantity", decimalValue(requirement.target)),
    listAttribute(
      list,
      "required_quantity",
      decimalValue(requirement.required),
    ),
    listAttribute(list, "received_quantity", decimalValue(0)),
    listAttribute(list, "quantity_unit", {
      kind: "short_text",
      value: requirement.unit,
    }),
  ];
}

function updatedEntryAttributes(
  list: CommerceList,
  current: readonly ListEntryAttributeValue[],
  status: ReplenishmentStatus,
  receivedQuantity: number,
  closedAt: string | null,
): readonly ListEntryAttributeValue[] {
  const attributes: ListEntryAttributeValue[] = [];
  for (const value of current) {
    if (
      value.attributeId === "status" ||
      value.attributeId === "received_quantity" ||
      value.attributeId === "closed_at"
    )
      continue;
    attributes.push(value);
  }
  attributes.push(
    listAttribute(list, "status", {
      kind: "status",
      value: parseAttributeOptionId(status),
    }),
  );
  attributes.push(
    listAttribute(list, "received_quantity", decimalValue(receivedQuantity)),
  );
  if (closedAt !== null) {
    attributes.push(
      listAttribute(list, "closed_at", { kind: "timestamp", value: closedAt }),
    );
  }
  return attributes;
}

function listAttribute(
  list: CommerceList,
  attributeId: string,
  value: AttributeValue,
): ListEntryAttributeValue {
  const attribute = findListAttribute(list, attributeId);
  return {
    attributeId: attribute.attributeId,
    scope: attribute.definition.scope,
    definitionRevision: attribute.definition.revision,
    sensitivity: attribute.definition.sensitivity,
    value,
  };
}

function findListAttribute(
  list: CommerceList,
  attributeId: string,
): CommerceList["entryAttributeDefinitions"][number] {
  for (const attribute of list.entryAttributeDefinitions) {
    if (attribute.attributeId === attributeId) return attribute;
  }
  throw new Error(`Replenishment list attribute is missing: ${attributeId}`);
}

function hasOpenRequirement(
  entries: readonly CommerceListEntry[],
  stockPolicyId: string,
  closedEntryIds: ReadonlySet<string>,
): boolean {
  for (const entry of entries) {
    if (closedEntryIds.has(String(entry.entryId))) continue;
    if (
      entry.entityRef.origin !== "system" ||
      entry.entityRef.typeId !== "stock_policy" ||
      String(entry.entityRef.entityId) !== stockPolicyId
    )
      continue;
    if (statusAttribute(entry) !== "received") return true;
  }
  return false;
}

function statusAttribute(entry: CommerceListEntry): ReplenishmentStatus {
  const value = attribute(entry, "status");
  if (value.value.kind !== "status")
    throw new Error("Replenishment status is invalid");
  const status = purchaseRequestStatus(String(value.value.value));
  if (status === undefined)
    throw new Error(
      `Unsupported replenishment status: ${String(value.value.value)}`,
    );
  return status;
}

function textAttribute(entry: CommerceListEntry, attributeId: string): string {
  const value = attribute(entry, attributeId);
  if (value.value.kind !== "short_text")
    throw new Error(`Replenishment ${attributeId} is invalid`);
  return value.value.value;
}

function decimalAttribute(
  entry: CommerceListEntry,
  attributeId: string,
): number {
  const value = attribute(entry, attributeId);
  if (
    value.value.kind !== "decimal" ||
    value.value.value.scale !== QUANTITY_SCALE
  ) {
    throw new Error(`Replenishment ${attributeId} is invalid`);
  }
  return value.value.value.unscaled;
}

function attribute(
  entry: CommerceListEntry,
  attributeId: string,
): ListEntryAttributeValue {
  for (const value of entry.attributeValues) {
    if (value.attributeId === attributeId) return value;
  }
  throw new Error(`Replenishment entry attribute is missing: ${attributeId}`);
}

function isPastExpectedDelivery(
  entry: CommerceListEntry,
  now: string,
): boolean {
  for (const value of entry.attributeValues) {
    if (value.attributeId !== "expected_delivery_at") continue;
    if (value.value.kind !== "timestamp")
      throw new Error("Expected delivery is invalid");
    return Date.parse(value.value.value) < Date.parse(now);
  }
  return false;
}

function decimalValue(unscaled: number): AttributeValue {
  if (!Number.isSafeInteger(unscaled))
    throw new Error("Replenishment quantity exceeds the safe integer range");
  return { kind: "decimal", value: { unscaled, scale: QUANTITY_SCALE } };
}

function scaleQuantity(amount: number, scale: number): number {
  if (
    !Number.isSafeInteger(amount) ||
    !Number.isSafeInteger(scale) ||
    scale < 0 ||
    scale > QUANTITY_SCALE
  ) {
    throw new Error(
      "Inventory quantity cannot be represented by the replenishment evidence scale",
    );
  }
  const scaled = BigInt(amount) * 10n ** BigInt(QUANTITY_SCALE - scale);
  const value = Number(scaled);
  if (!Number.isSafeInteger(value))
    throw new Error("Inventory quantity exceeds the safe integer range");
  return value;
}

import { createHash } from "node:crypto";

import type { CommerceMigrationInventoryV2 } from "@seams/commerce-client";

import type {
  CountRow,
  CommerceDatabase,
  CommerceSqlValue,
} from "./database.ts";

const TARGET_CONTRACT_REVISION = "satyr.commerce.inventory.v1" as const;

const MERCHANT_TABLES = [
  "location",
  "sales_channel",
  "product",
  "sellable_variant",
  "inventory_item",
  "offer",
  "inventory_position",
  "commerce_order",
  "payment",
  "fulfillment",
  "shipment",
  "stock_lot",
  "stock_movement",
  "command_receipt",
  "observation_outbox",
] as const;

type MerchantTable = (typeof MERCHANT_TABLES)[number];
const LEGACY_FOOD_SERVICE_TABLES = [
  "food_service_menu",
  "food_service_recipe",
  "food_service_preparation_ticket",
  "food_service_observation_outbox",
] as const;
type MerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;
type SchemaVersionRow = Readonly<{ version: number | null }>;
type SqlRow = Record<string, CommerceSqlValue>;

export function readCommerceMigrationInventory(
  database: CommerceDatabase,
  merchantId: string,
): CommerceMigrationInventoryV2 | undefined {
  if (!hasTable(database, "merchant")) return undefined;
  const merchant = database
    .prepare(
      `SELECT merchant_id AS merchantId, external_reference AS organisationId, revision
     FROM merchant WHERE merchant_id = ?`,
    )
    .get<MerchantRow>(requireIdentity(merchantId));
  if (merchant === undefined) return undefined;

  const storageSchemaVersion = readStorageSchemaVersion(database);
  const counts = readCounts(database, merchant.merchantId);
  const unresolvedMappings = readUnresolvedMappings(
    database,
    merchant.merchantId,
    counts,
  );
  const invariantFailures = readInvariantFailures(
    database,
    merchant.merchantId,
  );
  const hasUnresolvedMappings =
    Object.values(unresolvedMappings).some(isPositive);
  const candidateClassification =
    hasUnresolvedMappings || invariantFailures.length > 0
      ? "reject"
      : "migrate";
  const receiptIdentities = readReceiptIdentities(
    database,
    merchant.merchantId,
  );
  const operations = readOperations(
    database,
    merchant.merchantId,
    counts.commandReceipts,
  );
  const tableDigests: Array<
    Readonly<{ table: MerchantTable; digest: string }>
  > = [];
  for (const table of MERCHANT_TABLES) {
    tableDigests.push(tableDigest(database, table, merchant.merchantId));
  }
  const migrationDigest = digest({
    storageSchemaVersion,
    merchantRevision: merchant.revision,
    tables: tableDigests,
  });

  return {
    schemaVersion: "underclerk.migration-inventory.v2",
    organisationId: merchant.organisationId,
    merchantId: merchant.merchantId,
    merchantRevision: merchant.revision,
    storageSchemaVersion,
    contractRevisions: {
      source: sourceContractRevision(storageSchemaVersion),
      target: TARGET_CONTRACT_REVISION,
    },
    migrationDigest,
    candidateClassification,
    classificationCounts: {
      migrate: candidateClassification === "migrate" ? 1 : 0,
      reset: 0,
      reject: candidateClassification === "reject" ? 1 : 0,
    },
    resources: {
      locations: counts.locations,
      salesChannels: counts.salesChannels,
      products: counts.products,
      variants: counts.variants,
      inventoryItems: counts.inventoryItems,
      offers: counts.offers,
      inventoryPositions: counts.inventoryPositions,
      orders: counts.orders,
      payments: counts.payments,
      fulfillments: counts.fulfillments,
      shipments: counts.shipments,
    },
    foodService: {
      resourceSnapshots: counts.resourceSnapshots,
    },
    inventoryLedger: {
      lots: counts.lots,
      movements: counts.movements,
      receiptIdentities: receiptIdentities.count,
      receiptIdentityDigest: receiptIdentities.digest,
    },
    unresolvedMappings,
    invariantFailures,
    operations,
  };
}

type MigrationCounts = Readonly<{
  locations: number;
  salesChannels: number;
  products: number;
  variants: number;
  inventoryItems: number;
  offers: number;
  inventoryPositions: number;
  orders: number;
  payments: number;
  fulfillments: number;
  shipments: number;
  resourceSnapshots: number;
  lots: number;
  movements: number;
  commandReceipts: number;
}>;

function readCounts(
  database: CommerceDatabase,
  merchantId: string,
): MigrationCounts {
  return {
    locations: countRows(database, "location", merchantId),
    salesChannels: countRows(database, "sales_channel", merchantId),
    products: countRows(database, "product", merchantId),
    variants: countRows(database, "sellable_variant", merchantId),
    inventoryItems: countRows(database, "inventory_item", merchantId),
    offers: countRows(database, "offer", merchantId),
    inventoryPositions: countRows(database, "inventory_position", merchantId),
    orders: countRows(database, "commerce_order", merchantId),
    payments: countRows(database, "payment", merchantId),
    fulfillments: countRows(database, "fulfillment", merchantId),
    shipments: countRows(database, "shipment", merchantId),
    resourceSnapshots: hasTable(database, "food_service_resource")
      ? countRowsByName(database, "food_service_resource", merchantId)
      : 0,
    lots: countRows(database, "stock_lot", merchantId),
    movements: countRows(database, "stock_movement", merchantId),
    commandReceipts: countRows(database, "command_receipt", merchantId),
  };
}

function readUnresolvedMappings(
  database: CommerceDatabase,
  merchantId: string,
  counts: MigrationCounts,
): CommerceMigrationInventoryV2["unresolvedMappings"] {
  if (hasColumn(database, "inventory_item", "inventory_item_id")) {
    return {
      inventoryItemCategories: 0,
      inventoryItemTrackingPolicies: 0,
      inventoryItemBaseUnits: 0,
      inventoryPositionBalances: 0,
      receiptIds: 0,
    };
  }
  return {
    inventoryItemCategories: countJsonFieldMissing(
      database,
      "inventory_item",
      merchantId,
      "category",
    ),
    inventoryItemTrackingPolicies: countJsonFieldMissing(
      database,
      "inventory_item",
      merchantId,
      "tracking",
    ),
    inventoryItemBaseUnits: countJsonAlternativesMissing(
      database,
      "inventory_item",
      merchantId,
      "baseUnit",
      "unit",
    ),
    inventoryPositionBalances: countUnresolvedPositionBalances(
      database,
      merchantId,
    ),
    receiptIds:
      counts.movements > 0
        ? countJsonFieldMissing(
            database,
            "stock_movement",
            merchantId,
            "source.receiptId",
          )
        : counts.lots,
  };
}

function readInvariantFailures(
  database: CommerceDatabase,
  merchantId: string,
): readonly Readonly<{ code: string; count: number }>[] {
  const failures = [
    failure(
      "inventory_position_identity_ambiguous",
      countDuplicatePositions(database, merchantId),
    ),
    failure(
      "inventory_position_item_missing",
      countOrphanPositions(database, merchantId),
    ),
    failure(
      "inventory_position_balance_invalid",
      countInvalidAccountedBalances(database, merchantId),
    ),
    failure(
      "legacy_backorder_balance_unsupported",
      countLegacyBackorders(database, merchantId),
    ),
    failure(
      "stock_lot_relationship_invalid",
      countOrphanLots(database, merchantId),
    ),
    failure(
      "stock_lot_tracking_invalid",
      countAggregateItemLots(database, merchantId),
    ),
    failure(
      "stock_movement_relationship_invalid",
      countOrphanMovements(database, merchantId),
    ),
    failure(
      "legacy_food_service_rows",
      countLegacyFoodServiceRows(database, merchantId),
    ),
    failure(
      "legacy_generic_receipt_unsettled",
      countUnsettledLegacyGenericReceipts(database, merchantId),
    ),
  ];
  return failures.filter(isFailure);
}

function readReceiptIdentities(
  database: CommerceDatabase,
  merchantId: string,
): Readonly<{ count: number; digest: string }> {
  if (!hasTable(database, "stock_movement"))
    return { count: 0, digest: digest([]) };
  if (hasColumn(database, "stock_movement", "receipt_id")) {
    const rows = database
      .prepare(
        `SELECT receipt_id AS receiptId, receipt_line_id AS receiptLineId
       FROM stock_movement
       WHERE merchant_id = ? AND reason_kind = 'receipt'
       ORDER BY receipt_id, receipt_line_id`,
      )
      .all<{ receiptId: string; receiptLineId: string }>(merchantId);
    return {
      count: rows.length,
      digest: digest(rows.map(normalizedReceiptIdentity)),
    };
  }
  const rows = database
    .prepare(
      `SELECT source_id AS sourceId FROM stock_movement
     WHERE merchant_id = ? ORDER BY source_kind, source_id`,
    )
    .all<{ sourceId: string }>(merchantId);
  return { count: rows.length, digest: digest(rows.map(receiptSourceId)) };
}

function readOperations(
  database: CommerceDatabase,
  merchantId: string,
  commandReceipts: number,
): CommerceMigrationInventoryV2["operations"] {
  const mutationLeases = hasTable(database, "mutation_lease")
    ? countRowsByName(database, "mutation_lease", merchantId)
    : 0;
  return {
    commandReceipts,
    pendingCommands: mutationLeases,
    mutationLeases,
    pendingReceipts: countPendingReceipts(database, merchantId),
    pendingCommerceDeliveries: countOutbox(
      database,
      "observation_outbox",
      merchantId,
      "pending",
    ),
    deliveredCommerceDeliveries: countOutbox(
      database,
      "observation_outbox",
      merchantId,
      "delivered",
    ),
  };
}

function countRows(
  database: CommerceDatabase,
  table: MerchantTable,
  merchantId: string,
): number {
  return hasTable(database, table)
    ? countRowsByName(database, table, merchantId)
    : 0;
}

function countRowsByName(
  database: CommerceDatabase,
  table: string,
  merchantId: string,
): number {
  return (
    database
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE merchant_id = ?`)
      .get<CountRow>(merchantId)?.count ?? 0
  );
}

function countJsonFieldMissing(
  database: CommerceDatabase,
  table: MerchantTable,
  merchantId: string,
  path: string,
): number {
  if (
    !hasTable(database, table) ||
    !hasColumn(database, table, "resource_json")
  )
    return 0;
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM ${table}
     WHERE merchant_id = ? AND json_type(resource_json, ?) IS NULL`,
      )
      .get<CountRow>(merchantId, `$.${path}`)?.count ?? 0
  );
}

function countJsonAlternativesMissing(
  database: CommerceDatabase,
  table: MerchantTable,
  merchantId: string,
  firstPath: string,
  secondPath: string,
): number {
  if (
    !hasTable(database, table) ||
    !hasColumn(database, table, "resource_json")
  )
    return 0;
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM ${table}
     WHERE merchant_id = ?
       AND json_type(resource_json, ?) IS NULL
       AND json_type(resource_json, ?) IS NULL`,
      )
      .get<CountRow>(merchantId, `$.${firstPath}`, `$.${secondPath}`)?.count ??
    0
  );
}

function countUnresolvedPositionBalances(
  database: CommerceDatabase,
  merchantId: string,
): number {
  if (!hasTable(database, "inventory_position")) return 0;
  if (hasColumn(database, "inventory_position", "on_hand_amount")) return 0;
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM inventory_position
     WHERE merchant_id = ?
       AND COALESCE(json_extract(resource_json, '$.balance.kind'), '')
           NOT IN ('accounted', 'available_only')
       AND COALESCE(json_extract(resource_json, '$.availability.state'), '')
           NOT IN ('in_stock', 'out_of_stock')`,
      )
      .get<CountRow>(merchantId)?.count ?? 0
  );
}

function countDuplicatePositions(
  database: CommerceDatabase,
  merchantId: string,
): number {
  if (!hasTable(database, "inventory_position")) return 0;
  if (hasColumn(database, "inventory_position", "inventory_item_id")) {
    return (
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM (
         SELECT inventory_item_id, location_id
         FROM inventory_position
         WHERE merchant_id = ?
         GROUP BY inventory_item_id, location_id HAVING COUNT(*) > 1
       )`,
        )
        .get<CountRow>(merchantId)?.count ?? 0
    );
  }
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM (
       SELECT json_extract(resource_json, '$.inventoryItemId'),
              json_extract(resource_json, '$.locationId')
       FROM inventory_position
       WHERE merchant_id = ?
       GROUP BY 1, 2 HAVING COUNT(*) > 1
     )`,
      )
      .get<CountRow>(merchantId)?.count ?? 0
  );
}

function countOrphanPositions(
  database: CommerceDatabase,
  merchantId: string,
): number {
  if (!hasTable(database, "inventory_position")) return 0;
  if (!hasTable(database, "inventory_item")) {
    return countRows(database, "inventory_position", merchantId);
  }
  if (hasColumn(database, "inventory_position", "inventory_item_id")) {
    return (
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM inventory_position AS position
       LEFT JOIN inventory_item AS item
         ON item.merchant_id = position.merchant_id
        AND item.inventory_item_id = position.inventory_item_id
       WHERE position.merchant_id = ? AND item.inventory_item_id IS NULL`,
        )
        .get<CountRow>(merchantId)?.count ?? 0
    );
  }
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM inventory_position AS position
     LEFT JOIN inventory_item AS item
       ON item.merchant_id = position.merchant_id
      AND item.resource_id = json_extract(position.resource_json, '$.inventoryItemId')
     WHERE position.merchant_id = ? AND item.resource_id IS NULL`,
      )
      .get<CountRow>(merchantId)?.count ?? 0
  );
}

function countInvalidAccountedBalances(
  database: CommerceDatabase,
  merchantId: string,
): number {
  if (!hasTable(database, "inventory_position")) return 0;
  if (hasColumn(database, "inventory_position", "on_hand_amount")) {
    if (hasColumn(database, "inventory_position", "balance_kind")) {
      return (
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM inventory_position
         WHERE merchant_id = ? AND (
           (balance_kind = 'accounted' AND (
             on_hand_amount IS NULL OR allocated_amount IS NULL OR
             allocated_amount > on_hand_amount OR
             available_amount != on_hand_amount - allocated_amount
           )) OR
           (balance_kind = 'available_only' AND (
             on_hand_amount IS NOT NULL OR allocated_amount IS NOT NULL
           )) OR
           balance_kind NOT IN ('accounted', 'available_only') OR
           available_amount < 0 OR
           (quantity_unit = 'each' AND quantity_scale != 0)
         )`,
          )
          .get<CountRow>(merchantId)?.count ?? 0
      );
    }
    return (
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM inventory_position
       WHERE merchant_id = ? AND (
         allocated_amount > on_hand_amount OR
         allocated_amount < 0 OR on_hand_amount < 0 OR
         (quantity_unit = 'each' AND quantity_scale != 0)
       )`,
        )
        .get<CountRow>(merchantId)?.count ?? 0
    );
  }
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM inventory_position
     WHERE merchant_id = ?
       AND json_extract(resource_json, '$.balance.kind') = 'accounted'
       AND (
         json_extract(resource_json, '$.balance.available.amount') !=
           json_extract(resource_json, '$.balance.onHand.amount') -
           COALESCE(
             json_extract(resource_json, '$.balance.allocated.amount'),
             json_extract(resource_json, '$.balance.reserved.amount')
           )
         OR json_extract(resource_json, '$.balance.onHand.scale') !=
           COALESCE(
             json_extract(resource_json, '$.balance.allocated.scale'),
             json_extract(resource_json, '$.balance.reserved.scale')
           )
         OR json_extract(resource_json, '$.balance.onHand.scale') !=
           json_extract(resource_json, '$.balance.available.scale')
         OR json_extract(resource_json, '$.balance.onHand.unit') !=
           COALESCE(
             json_extract(resource_json, '$.balance.allocated.unit'),
             json_extract(resource_json, '$.balance.reserved.unit')
           )
         OR json_extract(resource_json, '$.balance.onHand.unit') !=
           json_extract(resource_json, '$.balance.available.unit')
       )`,
      )
      .get<CountRow>(merchantId)?.count ?? 0
  );
}

function countLegacyBackorders(
  database: CommerceDatabase,
  merchantId: string,
): number {
  if (!hasTable(database, "inventory_position")) return 0;
  if (!hasColumn(database, "inventory_position", "resource_json")) return 0;
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM inventory_position
     WHERE merchant_id = ?
       AND json_extract(resource_json, '$.availability.state') = 'backordered'`,
      )
      .get<CountRow>(merchantId)?.count ?? 0
  );
}

function countOrphanLots(
  database: CommerceDatabase,
  merchantId: string,
): number {
  if (!hasTable(database, "stock_lot")) return 0;
  if (
    !hasTable(database, "inventory_item") ||
    !hasTable(database, "inventory_position")
  ) {
    return countRows(database, "stock_lot", merchantId);
  }
  if (hasColumn(database, "inventory_item", "inventory_item_id")) {
    return (
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM stock_lot AS lot
       LEFT JOIN inventory_item AS item
         ON item.merchant_id = lot.merchant_id
        AND item.inventory_item_id = lot.inventory_item_id
       LEFT JOIN inventory_position AS position
         ON position.merchant_id = lot.merchant_id
        AND position.inventory_position_id = lot.inventory_position_id
       WHERE lot.merchant_id = ?
         AND (item.inventory_item_id IS NULL OR position.inventory_position_id IS NULL)`,
        )
        .get<CountRow>(merchantId)?.count ?? 0
    );
  }
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM stock_lot AS lot
     LEFT JOIN inventory_item AS item
       ON item.merchant_id = lot.merchant_id AND item.resource_id = lot.inventory_item_id
     LEFT JOIN inventory_position AS position
       ON position.merchant_id = lot.merchant_id AND position.resource_id = lot.inventory_position_id
     WHERE lot.merchant_id = ? AND (item.resource_id IS NULL OR position.resource_id IS NULL)`,
      )
      .get<CountRow>(merchantId)?.count ?? 0
  );
}

function countAggregateItemLots(
  database: CommerceDatabase,
  merchantId: string,
): number {
  if (!hasTable(database, "stock_lot") || !hasTable(database, "inventory_item"))
    return 0;
  if (hasColumn(database, "inventory_item", "inventory_item_id")) {
    return (
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM stock_lot AS lot
       JOIN inventory_item AS item
         ON item.merchant_id = lot.merchant_id
        AND item.inventory_item_id = lot.inventory_item_id
       WHERE lot.merchant_id = ? AND item.tracking_kind = 'aggregate'`,
        )
        .get<CountRow>(merchantId)?.count ?? 0
    );
  }
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM stock_lot AS lot
     JOIN inventory_item AS item
       ON item.merchant_id = lot.merchant_id AND item.resource_id = lot.inventory_item_id
     WHERE lot.merchant_id = ?
       AND json_extract(item.resource_json, '$.tracking.kind') = 'aggregate'`,
      )
      .get<CountRow>(merchantId)?.count ?? 0
  );
}

function countOrphanMovements(
  database: CommerceDatabase,
  merchantId: string,
): number {
  if (!hasTable(database, "stock_movement")) return 0;
  if (
    !hasTable(database, "inventory_item") ||
    !hasTable(database, "inventory_position")
  ) {
    return countRows(database, "stock_movement", merchantId);
  }
  if (hasColumn(database, "inventory_item", "inventory_item_id")) {
    return (
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM stock_movement AS movement
       LEFT JOIN inventory_item AS item
         ON item.merchant_id = movement.merchant_id
        AND item.inventory_item_id = movement.inventory_item_id
       LEFT JOIN inventory_position AS position
         ON position.merchant_id = movement.merchant_id
        AND position.inventory_position_id = movement.inventory_position_id
       WHERE movement.merchant_id = ?
         AND (item.inventory_item_id IS NULL OR position.inventory_position_id IS NULL)`,
        )
        .get<CountRow>(merchantId)?.count ?? 0
    );
  }
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM stock_movement AS movement
     LEFT JOIN inventory_item AS item
       ON item.merchant_id = movement.merchant_id
      AND item.resource_id = movement.inventory_item_id
     LEFT JOIN inventory_position AS position
       ON position.merchant_id = movement.merchant_id
      AND position.resource_id = movement.inventory_position_id
     LEFT JOIN stock_lot AS lot
       ON lot.merchant_id = movement.merchant_id AND lot.lot_id = movement.lot_id
     WHERE movement.merchant_id = ?
       AND (item.resource_id IS NULL OR position.resource_id IS NULL OR lot.lot_id IS NULL)`,
      )
      .get<CountRow>(merchantId)?.count ?? 0
  );
}

function countPendingReceipts(
  database: CommerceDatabase,
  merchantId: string,
): number {
  if (!hasTable(database, "command_receipt")) return 0;
  let count = 0;
  if (hasTable(database, "observation_outbox")) {
    count += countPendingReceiptsInOutbox(
      database,
      "observation_outbox",
      merchantId,
    );
  }
  return count;
}

function countPendingReceiptsInOutbox(
  database: CommerceDatabase,
  table: "observation_outbox",
  merchantId: string,
): number {
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM command_receipt AS receipt
     JOIN ${table} AS outbox
       ON outbox.delivery_id = json_extract(receipt.receipt_json, '$.deliveryId')
     WHERE receipt.merchant_id = ? AND outbox.status = 'pending'`,
      )
      .get<CountRow>(merchantId)?.count ?? 0
  );
}

function countOutbox(
  database: CommerceDatabase,
  table: "observation_outbox",
  merchantId: string,
  status: "pending" | "delivered",
): number {
  if (!hasTable(database, table)) return 0;
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE merchant_id = ? AND status = ?`,
      )
      .get<CountRow>(merchantId, status)?.count ?? 0
  );
}

function countLegacyFoodServiceRows(
  database: CommerceDatabase,
  merchantId: string,
): number {
  let count = 0;
  for (const table of LEGACY_FOOD_SERVICE_TABLES) {
    if (!hasTable(database, table)) continue;
    count += hasColumn(database, table, "merchant_id")
      ? countRowsByName(database, table, merchantId)
      : (database
          .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get<CountRow>()?.count ?? 0);
  }
  return count;
}

function countUnsettledLegacyGenericReceipts(
  database: CommerceDatabase,
  merchantId: string,
): number {
  if (!hasTable(database, "command_receipt")) return 0;
  if (!hasTable(database, "observation_outbox")) {
    return (
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM command_receipt
       WHERE merchant_id = ?
         AND json_extract(receipt_json, '$.commandKind') = 'upsert_resources'`,
        )
        .get<CountRow>(merchantId)?.count ?? 0
    );
  }
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count
     FROM command_receipt AS receipt
     LEFT JOIN observation_outbox AS outbox
       ON outbox.delivery_id = json_extract(receipt.receipt_json, '$.deliveryId')
     WHERE receipt.merchant_id = ?
       AND json_extract(receipt.receipt_json, '$.commandKind') = 'upsert_resources'
       AND (outbox.delivery_id IS NULL OR outbox.status != 'delivered')`,
      )
      .get<CountRow>(merchantId)?.count ?? 0
  );
}

function tableDigest(
  database: CommerceDatabase,
  table: MerchantTable,
  merchantId: string,
): Readonly<{ table: MerchantTable; digest: string }> {
  if (!hasTable(database, table)) return { table, digest: digest([]) };
  const rows = database
    .prepare(`SELECT * FROM ${table} WHERE merchant_id = ?`)
    .all<SqlRow>(merchantId);
  const normalizedRows = rows.map(stableSqlRow).sort();
  return { table, digest: digest(normalizedRows) };
}

function stableSqlRow(row: SqlRow): string {
  const entries = Object.entries(row).sort(compareEntries);
  return JSON.stringify(entries);
}

function compareEntries(
  left: readonly [string, CommerceSqlValue],
  right: readonly [string, CommerceSqlValue],
): number {
  return left[0].localeCompare(right[0]);
}

function hasTable(database: CommerceDatabase, table: string): boolean {
  return (
    (database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?",
      )
      .get<CountRow>(table)?.count ?? 0) === 1
  );
}

function hasColumn(
  database: CommerceDatabase,
  table: string,
  column: string,
): boolean {
  if (!hasTable(database, table)) return false;
  const rows = database
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>();
  for (const row of rows) {
    if (row.name === column) return true;
  }
  return false;
}

function readStorageSchemaVersion(database: CommerceDatabase): number {
  if (!hasTable(database, "schema_migration")) return 1;
  const row = database
    .prepare("SELECT MAX(version) AS version FROM schema_migration")
    .get<SchemaVersionRow>();
  return row?.version ?? 1;
}

function sourceContractRevision(storageSchemaVersion: number): string {
  if (storageSchemaVersion >= 8) return TARGET_CONTRACT_REVISION;
  return storageSchemaVersion >= 7
    ? "underclerk.commerce.v1"
    : "underclerk.legacy-commerce.v1";
}

function failure(
  code: string,
  count: number,
): Readonly<{ code: string; count: number }> | undefined {
  return count === 0 ? undefined : { code, count };
}

function isFailure(
  value: Readonly<{ code: string; count: number }> | undefined,
): value is Readonly<{ code: string; count: number }> {
  return value !== undefined;
}

function isPositive(value: number): boolean {
  return value > 0;
}

function receiptSourceId(row: Readonly<{ sourceId: string }>): string {
  return row.sourceId;
}

function normalizedReceiptIdentity(
  row: Readonly<{ receiptId: string; receiptLineId: string }>,
): string {
  return `${row.receiptId}:${row.receiptLineId}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireIdentity(value: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new Error("merchantId must be normalized text");
  }
  return value;
}

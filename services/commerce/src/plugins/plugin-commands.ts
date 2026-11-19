// The event handlers and actions of merchant plugins (Plan 77 step 5). A
// handler runs after the commit, once for each new event of the kinds that it
// names; an action runs when staff or an agent call it with typed inputs. Each
// returns `{ refusals?, commands? }` with at most five commands. The core
// applies each through the same path as a staff call, one event for each,
// inside one outer transaction, so a run applies all of them or none.
import type {
  CommercePluginActionV1,
  CommercePluginHandlerV1,
} from "@purin-labs/commerce-client";

import {
  parsePluginRunOutput,
  type PluginRunOutput,
  type PluginRunOutputCommand,
} from "@purin-labs/commerce-contracts/records/plugin-outputs";

import { sha256 } from "../commerce-authority/checkout-shared.ts";
import type { CommerceDatabase } from "../database.ts";

/** The commands that a handler or an action can return. */
export const PLUGIN_COMMANDS: readonly string[] = [
  "create_discount",
  "set_plugin_field_values",
  "credit_store_credit",
];

/** One command as a function returns it: its kind and its own fields. */
export type PluginOperation = PluginRunOutputCommand;

/** The output of a handler or an action, or undefined when it has no shape. */
export { parsePluginRunOutput as parseRunOutput };
export type { PluginRunOutput };

/**
 * The command that an operation names, for the core's own parser, or
 * undefined when it names unknown fields. The discount id comes from the
 * plugin and the operation's key, so one key makes one discount.
 */
export function operationCommand(
  operation: PluginOperation,
  base: Readonly<{
    organisationId: string;
    merchantId: string;
    pluginId: string;
    idempotencyKey: string;
    at: string;
    /** The revision of the plugin's own values on a record, or null. */
    fieldRevision: (entityType: unknown, entityId: unknown) => number | null;
    /** An order's customer and currency, or undefined. */
    orderBuyer: (
      orderId: string,
    ) => Readonly<{ customerId: string; currency: string }> | undefined;
  }>,
): unknown {
  if (operation.kind === "credit_store_credit") {
    // Store credit goes only to an order's customer, in the order's
    // currency.
    const { kind: _kind, orderId, amountMinor, note, ...rest } = operation;
    if (
      Object.keys(rest).length > 0 ||
      typeof orderId !== "string" ||
      typeof amountMinor !== "number" ||
      !Number.isSafeInteger(amountMinor) ||
      amountMinor <= 0 ||
      (note !== undefined && typeof note !== "string")
    )
      return undefined;
    const buyer = base.orderBuyer(orderId);
    if (buyer === undefined) return undefined;
    return {
      schemaVersion: "underclerk.credit-store-credit.v1",
      merchantId: base.merchantId,
      idempotencyKey: base.idempotencyKey,
      requestedAt: base.at,
      customerId: buyer.customerId,
      amount: { amountMinor, currency: buyer.currency },
      note: note ?? null,
    };
  }
  if (operation.kind === "set_plugin_field_values") {
    // A plugin sets only its own values, at the record's current revision.
    // It names a customer by an order, as store credit does, so it never
    // holds a customer id.
    const { kind: _kind, entityType, values, ...named } = operation;
    let entityId: unknown;
    if (entityType === "customer") {
      const { orderId, ...rest } = named;
      if (Object.keys(rest).length > 0 || typeof orderId !== "string")
        return undefined;
      entityId = base.orderBuyer(orderId)?.customerId;
      if (entityId === undefined) return undefined;
    } else {
      const { entityId: id, ...rest } = named;
      if (Object.keys(rest).length > 0) return undefined;
      entityId = id;
    }
    return {
      schemaVersion: "underclerk.set-plugin-field-values.v1",
      merchantId: base.merchantId,
      idempotencyKey: base.idempotencyKey,
      requestedAt: base.at,
      pluginId: base.pluginId,
      entityType,
      entityId,
      values,
      expectedRevision: base.fieldRevision(entityType, entityId),
    };
  }
  if (operation.kind !== "create_discount") return undefined;
  const {
    kind: _kind,
    key,
    title,
    code,
    percentOff,
    amountOff,
    usageLimit,
    oncePerCustomer,
    endsAt,
    ...rest
  } = operation;
  if (
    Object.keys(rest).length > 0 ||
    typeof key !== "string" ||
    !/^[a-z0-9_-]{1,80}$/u.test(key) ||
    (percentOff === undefined) === (amountOff === undefined)
  )
    return undefined;
  return {
    schemaVersion: "underclerk.create-discount.v1",
    merchantId: base.merchantId,
    idempotencyKey: base.idempotencyKey,
    requestedAt: base.at,
    discountId: `discount_plugin_${sha256(`${base.pluginId}:${key}`).slice(0, 32)}`,
    title,
    method: { kind: "code", codes: [code] },
    rule: {
      kind: "amount_off_order",
      value:
        percentOff === undefined
          ? { kind: "fixed_amount", amount: amountOff }
          : {
              kind: "percentage",
              basisPoints:
                typeof percentOff === "number" ? percentOff * 100 : percentOff,
            },
    },
    conditions: {
      minimumSubtotal: null,
      startsAt: base.at,
      endsAt: endsAt ?? null,
      usageLimit: usageLimit ?? null,
      oncePerCustomer: oncePerCustomer ?? false,
    },
  };
}

/** Whether a handler's kinds, such as `order.created` or `order.*`, name a kind. */
export function namesEventKind(
  kinds: readonly string[],
  kind: string,
): boolean {
  return kinds.some(
    (candidate) =>
      candidate === kind ||
      (candidate.endsWith(".*") &&
        kind.startsWith(candidate.slice(0, candidate.length - 1))),
  );
}

export type StoredHandler = CommercePluginHandlerV1 &
  Readonly<{ pluginId: string; cursor: string }>;

type HandlerRow = Readonly<{
  pluginId: string;
  handlerId: string;
  eventKindsJson: string;
  source: string;
  cursor: string;
}>;

/** The merchants that have a plugin with an event handler. */
export function handlerMerchantIds(
  database: CommerceDatabase,
): readonly string[] {
  return database
    .prepare(
      `SELECT DISTINCT merchant_id AS merchantId FROM merchant_plugin_handler
       ORDER BY merchant_id`,
    )
    .all<Readonly<{ merchantId: string }>>()
    .map((row) => row.merchantId);
}

/** A merchant's handlers with their cursors, in plugin and list order. */
export function storedHandlers(
  database: CommerceDatabase,
  merchantId: string,
  pluginId?: string,
): readonly StoredHandler[] {
  return database
    .prepare(
      `SELECT plugin_id AS pluginId, handler_id AS handlerId,
              event_kinds_json AS eventKindsJson, source, cursor
       FROM merchant_plugin_handler
       WHERE merchant_id = ? AND (? IS NULL OR plugin_id = ?)
       ORDER BY plugin_id, position`,
    )
    .all<HandlerRow>(merchantId, pluginId ?? null, pluginId ?? null)
    .map(({ eventKindsJson, ...row }) => ({
      ...row,
      eventKinds: JSON.parse(eventKindsJson) as string[],
    }));
}

/**
 * Replaces a plugin's handlers. A handler that stays keeps its cursor, so
 * a new version does not read an event twice; a new one starts at `head`.
 */
export function writePluginHandlers(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
  handlers: readonly CommercePluginHandlerV1[],
  head: string,
): void {
  const cursors = new Map(
    storedHandlers(database, merchantId, pluginId).map((handler) => [
      handler.handlerId,
      handler.cursor,
    ]),
  );
  database
    .prepare(
      "DELETE FROM merchant_plugin_handler WHERE merchant_id = ? AND plugin_id = ?",
    )
    .run(merchantId, pluginId);
  handlers.forEach((handler, position) =>
    database
      .prepare(
        `INSERT INTO merchant_plugin_handler (
           merchant_id, plugin_id, handler_id, event_kinds_json, source,
           cursor, position
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        pluginId,
        handler.handlerId,
        JSON.stringify(handler.eventKinds),
        handler.source,
        cursors.get(handler.handlerId) ?? head,
        position,
      ),
  );
}

export function moveHandlerCursor(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
  handlerId: string,
  cursor: string,
): void {
  database
    .prepare(
      `UPDATE merchant_plugin_handler SET cursor = ?
       WHERE merchant_id = ? AND plugin_id = ? AND handler_id = ?`,
    )
    .run(cursor, merchantId, pluginId, handlerId);
}

export function listPluginActions(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
): readonly CommercePluginActionV1[] {
  return database
    .prepare(
      `SELECT action_id AS actionId, title, inputs_json AS inputsJson, source
       FROM merchant_plugin_action
       WHERE merchant_id = ? AND plugin_id = ? ORDER BY position`,
    )
    .all<
      Readonly<{
        actionId: string;
        title: string;
        inputsJson: string;
        source: string;
      }>
    >(merchantId, pluginId)
    .map(({ inputsJson, ...row }) => ({
      ...row,
      inputs: JSON.parse(inputsJson) as CommercePluginActionV1["inputs"],
    }));
}

export function writePluginActions(
  database: CommerceDatabase,
  merchantId: string,
  pluginId: string,
  actions: readonly CommercePluginActionV1[],
): void {
  database
    .prepare(
      "DELETE FROM merchant_plugin_action WHERE merchant_id = ? AND plugin_id = ?",
    )
    .run(merchantId, pluginId);
  actions.forEach((action, position) =>
    database
      .prepare(
        `INSERT INTO merchant_plugin_action (
           merchant_id, plugin_id, action_id, title, inputs_json, source,
           position
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        pluginId,
        action.actionId,
        action.title,
        JSON.stringify(action.inputs),
        action.source,
        position,
      ),
  );
}

/**
 * The orders that an identified buyer placed up to and with this one, or
 * null for a guest. The count is the same when a handler reads the event
 * again later.
 */
export function buyerOrderCount(
  database: CommerceDatabase,
  merchantId: string,
  orderId: string,
): number | null {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS placed FROM commerce_order AS earlier
       JOIN commerce_order AS this_order
         ON this_order.merchant_id = earlier.merchant_id
        AND this_order.resource_id = ?
       WHERE earlier.merchant_id = ?
         AND json_extract(earlier.order_snapshot_json, '$.buyer.customerReference')
           = json_extract(this_order.order_snapshot_json, '$.buyer.customerReference')
         AND earlier.rowid <= this_order.rowid`,
    )
    .get<Readonly<{ placed: number }>>(orderId, merchantId);
  return row === undefined || row.placed === 0 ? null : row.placed;
}

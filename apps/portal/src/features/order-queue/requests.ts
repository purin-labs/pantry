import {
  parseOrderQueueEntries,
  parseSoldOutItems,
  type OrderQueueAction,
  type OrderQueueEntry,
  type SoldOutItem,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import { controlMutation, controlRead } from "../../control-client";
import { controlPath } from "../../control-paths";

/** The order queue's calls to the Platform. */

function queuePath(organisationId: string): string {
  return controlPath(organisationId, "commerce/order-queue");
}

function soldOutPath(organisationId: string): string {
  return controlPath(organisationId, "commerce/sold-out");
}

export async function readOrderQueue(
  organisationId: string,
  signal: AbortSignal,
): Promise<readonly OrderQueueEntry[]> {
  const raw = await controlRead(queuePath(organisationId), signal);
  const entries = isRecord(raw) ? parseOrderQueueEntries(raw.entries) : null;
  if (entries === null) throw new Error("The order queue answer is not valid.");
  return entries;
}

export function advanceOrder(
  organisationId: string,
  fulfillmentId: string,
  action: OrderQueueAction,
  idempotencyKey: string,
): Promise<unknown> {
  return controlMutation(
    `${queuePath(organisationId)}/${encodeURIComponent(fulfillmentId)}/advance`,
    "POST",
    { action },
    undefined,
    { kind: "prepared", idempotencyKey },
  );
}

export async function readSoldOutItems(
  organisationId: string,
  signal: AbortSignal,
): Promise<readonly SoldOutItem[]> {
  const raw = await controlRead(soldOutPath(organisationId), signal);
  const items = isRecord(raw) ? parseSoldOutItems(raw.items) : null;
  if (items === null) throw new Error("The sold-out answer is not valid.");
  return items;
}

/** Marks an item as sold out until midnight, or puts it back on sale. */
export function writeSoldOut(
  organisationId: string,
  item: SoldOutItem,
  idempotencyKey: string,
): Promise<unknown> {
  return controlMutation(
    `${soldOutPath(organisationId)}/${encodeURIComponent(item.variantId)}`,
    "POST",
    {
      soldOut: item.soldOutUntil === null,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    undefined,
    { kind: "prepared", idempotencyKey },
  );
}

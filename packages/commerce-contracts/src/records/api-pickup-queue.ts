// The pickup queue (Plan 40B phase 3): the open pickups of a merchant, oldest
// first, as staff work through them and as a pickup board shows them. It
// names no buyer: an order's code and its lines are enough at the counter.
import { Type, type Static } from "typebox";
import { normalizedTextSchema } from "./fields.ts";
import {
  ImmutableArray,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;
const revision = Type.Integer({ minimum: 1 });

/**
 * The code that a buyer sees for an order and that staff call out, such as
 * F-062. It comes from the order's ID alone, so that every surface agrees
 * with no stored number. Two open orders can share a code, about once in
 * 26,000 pairs.
 */
export function commercePickupCode(orderId: string): string {
  let hash = 0;
  for (const character of orderId)
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  const letter = String.fromCharCode(65 + (hash % 26));
  const digits = String(Math.floor(hash / 26) % 1000).padStart(3, "0");
  return `${letter}-${digits}`;
}

/** The ticket of a pickup's made-to-order lines. A pickup has one ticket. */
export function commercePickupTicketId(
  orderId: string,
  fulfillmentId: string,
): string {
  return `preparation_ticket_${orderId}_${fulfillmentId}`;
}

const preparationSchema = Type.Union([
  /** No line is made to order: staff only mark the pickup ready. */
  ReadonlyStrictObject({ state: Type.Literal("not_needed") }),
  /** Null when the pickup's location has no active preparation station. */
  ReadonlyStrictObject({
    state: Type.Literal("not_started"),
    ticketId: text,
    stationId: Type.Union([text, Type.Null()]),
  }),
  ReadonlyStrictObject({
    state: Type.Union([
      Type.Literal("queued"),
      Type.Literal("preparing"),
      Type.Literal("completed"),
    ]),
    ticketId: text,
    ticketRevision: revision,
  }),
]);

export const commercePickupQueueEntryV1Schema = ReadonlyStrictObject({
  orderId: text,
  orderRevision: revision,
  fulfillmentId: text,
  fulfillmentRevision: revision,
  locationId: text,
  code: text,
  channel: Type.Union([Type.Literal("online"), Type.Literal("counter")]),
  stage: Type.Union([Type.Literal("preparing"), Type.Literal("ready")]),
  /** When the pickup entered its stage. */
  since: text,
  /** The order's captured payment; null when another tender paid for it. */
  payment: Type.Union([
    ReadonlyStrictObject({ paymentId: text, paymentRevision: revision }),
    Type.Null(),
  ]),
  lines: ImmutableArray(
    ReadonlyStrictObject({
      title: text,
      quantity: Type.Integer({ minimum: 0 }),
      modifiers: ImmutableArray(text),
    }),
  ),
  preparation: preparationSchema,
});
export type CommercePickupQueueEntryV1 = Static<
  typeof commercePickupQueueEntryV1Schema
>;

export const commercePickupQueueV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.pickup-queue.v1"),
  merchantId: text,
  merchantRevision: Type.Integer({ minimum: 0 }),
  entries: ImmutableArray(commercePickupQueueEntryV1Schema),
});
export type CommercePickupQueueV1 = Static<
  typeof commercePickupQueueV1Schema
>;

export const parseCommercePickupQueueV1 = wireRecordParser(
  commercePickupQueueV1Schema,
);

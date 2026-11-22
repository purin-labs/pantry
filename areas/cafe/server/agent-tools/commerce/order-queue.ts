import { Type } from "typebox";
import { isIanaTimezone } from "@purin-labs/control-api";
import type {
  CounterSaleReadRequest,
  CounterSaleToolRead,
  OrderQueueAdvanceRequest,
  OrderQueueToolRead,
  SoldOutMarkRequest,
  SoldOutToolRead,
} from "../../contract/order-queue-commands";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import {
  defineToolFamily,
  noArguments,
  stringEnum,
} from "@purin-labs/agent-tools/define-tool";
import type { PageViewExecute } from "@purin-labs/area-kitchen/server/agent-tools/kitchen/services";
import { ProposalArgumentError } from "@purin-labs/agent-tools/errors";
import type { PreparedEffect } from "@purin-labs/agent-tools/tool-effect";

type OrderQueueReadTool = () => Promise<OrderQueueToolRead>;

type CounterSaleReadTool = (
  request: CounterSaleReadRequest,
) => Promise<CounterSaleToolRead>;

type OrderQueueAdvanceTool = (
  request: OrderQueueAdvanceRequest,
  operationId: string,
) => Promise<PreparedEffect>;

type SoldOutReadTool = () => Promise<SoldOutToolRead>;

type SoldOutMarkTool = (
  request: SoldOutMarkRequest,
  operationId: string,
) => Promise<PreparedEffect>;

/** What a turn gives to the order queue and Register tools. */
export type CafeToolServices = {
  readonly readOrderQueue: OrderQueueReadTool;
  readonly readCounterSale?: CounterSaleReadTool;
  readonly advanceOrderQueue: OrderQueueAdvanceTool;
  readonly readSoldOut: SoldOutReadTool;
  readonly markSoldOut: SoldOutMarkTool;
  /** Stages items in the basket of Café › Register on the person's screen. */
  readonly executeRegisterViewCommand?: PageViewExecute;
};

export const defineCafeTool = defineToolFamily<CafeToolServices>()("cafe");

const ID_PATTERN = "^[A-Za-z0-9_:-]{1,128}$";

export const orderQueueRead = defineCafeTool({
  name: "order_queue_read",
  description:
    "Read the shop's open pickup orders, as staff see them on the order queue page: each order's pickup code, stage, preparation state, lines and fulfillmentId. It names no buyer.",
  input: noArguments(),
  decode: () => null,
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceEntityPlaneContext,
  },
  unavailable: "order queue read is unavailable",
  handler: ({ readOrderQueue }) =>
    readOrderQueue === undefined ? undefined : () => readOrderQueue(),
});

export const orderQueueAdvance = defineCafeTool({
  name: "order_queue_advance",
  description:
    "Move one order through the shop's order queue, as staff do on the order queue page. Use a fulfillmentId from order_queue_read. " +
    "action start: staff begin to prepare the order. ready: the order waits for pickup. hand_over: the buyer has the order, and it leaves the queue. " +
    "Hand over only when the person says that the buyer has the order. An order must be ready before it is handed over. This moves no money. A person's order queue page and pickup board show the move.",
  input: Type.Object(
    {
      fulfillmentId: Type.String({ pattern: ID_PATTERN }),
      action: stringEnum(["start", "ready", "hand_over"]),
    },
    { additionalProperties: false },
  ),
  decode: (input) => ({
    fulfillmentId: input.fulfillmentId,
    action: input.action,
  }),
  effect: "receipt",
  rerun: {
    kind: "any_caller",
    reason:
      "A move has a receipt under the call's key, and the queue's stage refuses a step that already happened, so a repeated call moves nothing twice.",
  },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceOrderQueueAdvance,
  },
  unavailable: "order queue move is unavailable",
  prepare: ({ advanceOrderQueue }) =>
    advanceOrderQueue === undefined
      ? undefined
      : (request, call) => advanceOrderQueue(request, call.operationId),
});

export const soldOutRead = defineCafeTool({
  name: "sold_out_read",
  description:
    "Read the items of the café's published menu, as staff see them on the order queue page: each item's variantId, title and soldOutUntil. soldOutUntil is null for an item on sale.",
  input: noArguments(),
  decode: () => null,
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceEntityPlaneContext,
  },
  unavailable: "sold out read is unavailable",
  handler: ({ readSoldOut }) =>
    readSoldOut === undefined ? undefined : () => readSoldOut(),
});

export const soldOutMark = defineCafeTool({
  name: "sold_out_mark",
  description:
    "Mark one menu item sold out today, or clear its mark, as staff do on the order queue page. Use a variantId from sold_out_read. " +
    "With soldOut true, give timeZone: the shop's IANA time zone, such as Asia/Tokyo. The mark ends at the next midnight there. If you do not know the shop's time zone, ask the person. " +
    "With soldOut false, set timeZone to null. Screens and the order page show the mark, and checkout refuses the item. The stock count and the price do not change.",
  input: Type.Object(
    {
      variantId: Type.String({ pattern: ID_PATTERN }),
      soldOut: Type.Boolean(),
      timeZone: Type.Unsafe<string | null>({
        type: ["string", "null"],
        maxLength: 64,
      }),
    },
    { additionalProperties: false },
  ),
  decode: (input): SoldOutMarkRequest => {
    if (!input.soldOut) {
      if (input.timeZone !== null) {
        throw new TypeError(
          "sold_out_mark timeZone must be null to clear a mark",
        );
      }
      return { variantId: input.variantId, mark: { kind: "cleared" } };
    }
    if (!isIanaTimezone(input.timeZone)) {
      throw new ProposalArgumentError(
        "sold_out_mark needs the shop's IANA time zone, such as Asia/Tokyo. Ask the person if you do not know it.",
      );
    }
    return {
      variantId: input.variantId,
      mark: { kind: "today", timeZone: input.timeZone },
    };
  },
  effect: "receipt",
  rerun: {
    kind: "any_caller",
    reason:
      "The same receipt answers a repeated mark, and a mark that stands has the same result.",
  },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceSoldOutMark,
  },
  unavailable: "sold out mark is unavailable",
  prepare: ({ markSoldOut }) =>
    markSoldOut === undefined
      ? undefined
      : (request, call) => markSoldOut(request, call.operationId),
});

export const counterSaleRead = defineCafeTool({
  name: "counter_sale_read",
  description:
    "Read one counter sale from Café › Register by checkoutId: its state, quote total, pickup code, payment method, cash change, and fulfillment stage. Read-only: agents cannot charge terminals, accept cash, kick drawers, or issue unapproved refunds.",
  input: Type.Object(
    {
      checkoutId: Type.String({ pattern: ID_PATTERN }),
    },
    { additionalProperties: false },
  ),
  decode: (input) => ({ checkoutId: input.checkoutId }),
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceEntityPlaneContext,
  },
  unavailable: "counter sale read is unavailable",
  handler: ({ readCounterSale }) =>
    readCounterSale === undefined
      ? undefined
      : (request) => readCounterSale(request),
});

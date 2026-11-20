// What a merchant plugin function returns from its QuickJS VM (Plan 77 steps
// 4 and 5), as Commerce's plugin host checks it (Plan 78 step 2). An output
// that a schema refuses is an `invalid_output` failure: the function is
// skipped, or the checkout is refused when the function is required. Each
// parser gives the value that the host applies.
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  NonNegativeInteger,
  PositiveInteger,
} from "@purin-labs/contract-schema";
import { decodeValue } from "@purin-labs/contract-schema/sorted-unions";

/** A message for a buyer or staff: not blank, at most 300 characters. */
const messageSchema = Type.Refine(Type.String(), isMessage, messageError);

function isMessage(value: string): boolean {
  return value.trim() !== "" && value.length <= 300;
}

function messageError(): string {
  return "must be a message of 1 to 300 characters";
}

/** An object that may hold other fields, which the host does not read. */
function LooseObject<Properties extends Record<string, TSchema>>(
  properties: Properties,
) {
  return Type.Object(properties, { additionalProperties: true });
}

/** Exactly these keys. */
function ExactObject<Properties extends Record<string, TSchema>>(
  properties: Properties,
) {
  return Type.Object(properties, { additionalProperties: false });
}

const refusalListSchema = Type.Array(LooseObject({ message: messageSchema }));
type RefusalList = Static<typeof refusalListSchema>;

function messagesOf(refusals: RefusalList): string[] {
  return refusals.map(messageOf);
}

function messageOf(refusal: Readonly<{ message: string }>): string {
  return refusal.message;
}

/** `checkout.validate` and `machine.guard`: `{ refusals: [{ message }] }`. */
const validationOutputSchema = Type.Unsafe<readonly string[]>(
  Type.Codec(LooseObject({ refusals: refusalListSchema }))
    .Decode(validationMessages)
    .Encode(validationRefusals),
);

function validationMessages(
  output: Readonly<{ refusals: RefusalList }>,
): readonly string[] {
  return messagesOf(output.refusals);
}

function validationRefusals(
  messages: readonly string[],
): Readonly<{ refusals: RefusalList }> {
  return { refusals: messages.map(refusalOf) };
}

function refusalOf(message: string): Readonly<{ message: string }> {
  return { message };
}

/** The most commands that one handler or action run may return. */
export const PLUGIN_RUN_COMMANDS = 5;

/**
 * A handler's or an action's output: `{ refusals?, commands? }` with at most
 * five commands, which the core applies all or none. A command keeps every
 * field, for the core's own parser.
 */
const runOutputShape = ExactObject({
  refusals: Type.Optional(refusalListSchema),
  commands: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Array(LooseObject({ kind: Type.String() }), {
        maxItems: PLUGIN_RUN_COMMANDS,
      }),
    ]),
  ),
});
type RunOutputShape = Static<typeof runOutputShape>;

export type PluginRunOutputCommand = Readonly<{ kind: string }> &
  Readonly<Record<string, unknown>>;

export type PluginRunOutput = Readonly<{
  refusals: readonly string[];
  commands: readonly PluginRunOutputCommand[];
}>;

const runOutputSchema = Type.Unsafe<PluginRunOutput>(
  Type.Codec(runOutputShape).Decode(runOutput).Encode(runOutputFields),
);

function runOutput(output: RunOutputShape): PluginRunOutput {
  return {
    refusals: messagesOf(output.refusals ?? []),
    commands: (output.commands ?? []) as PluginRunOutputCommand[],
  };
}

function runOutputFields(output: PluginRunOutput): RunOutputShape {
  return {
    refusals: output.refusals.map(refusalOf),
    commands: output.commands as RunOutputShape["commands"],
  };
}

export type LinePrice = Readonly<{
  checkoutLineId: string;
  unitPriceMinor: number;
}>;

/** `checkout.lines`: `{ prices: [{ checkoutLineId, unitPriceMinor }] }`. */
const linesOutputSchema = Type.Unsafe<readonly LinePrice[]>(
  Type.Codec(
    ExactObject({
      prices: Type.Array(
        ExactObject({
          checkoutLineId: Type.String(),
          unitPriceMinor: NonNegativeInteger,
        }),
      ),
    }),
  )
    .Decode(pricesOf)
    .Encode(pricesOutput),
);

function pricesOf(output: Readonly<{ prices: LinePrice[] }>): LinePrice[] {
  return output.prices;
}

function pricesOutput(prices: LinePrice[]): Readonly<{ prices: LinePrice[] }> {
  return { prices };
}

export type PluginDiscount = Readonly<{
  /** One line, or the whole order when null. */
  checkoutLineId: string | null;
  amountMinor: number;
}>;

/**
 * `checkout.discount`: `{ discounts: [{ checkoutLineId?, amountMinor }] }`
 * with an amount above zero; a discount without a line is for the order.
 */
const discountOutputShape = ExactObject({
  discounts: Type.Array(
    Type.Union([
      ExactObject({
        checkoutLineId: Type.String(),
        amountMinor: PositiveInteger,
      }),
      ExactObject({ amountMinor: PositiveInteger }),
    ]),
  ),
});
type DiscountOutputShape = Static<typeof discountOutputShape>;

const discountOutputSchema = Type.Unsafe<readonly PluginDiscount[]>(
  Type.Codec(discountOutputShape).Decode(discountsOf).Encode(discountsOutput),
);

function discountsOf(output: DiscountOutputShape): PluginDiscount[] {
  return output.discounts.map(discountOf);
}

function discountOf(
  discount: DiscountOutputShape["discounts"][number],
): PluginDiscount {
  return {
    checkoutLineId:
      "checkoutLineId" in discount ? discount.checkoutLineId : null,
    amountMinor: discount.amountMinor,
  };
}

function discountsOutput(
  discounts: readonly PluginDiscount[],
): DiscountOutputShape {
  return { discounts: discounts.map(discountFields) };
}

function discountFields(
  discount: PluginDiscount,
): DiscountOutputShape["discounts"][number] {
  return discount.checkoutLineId === null
    ? { amountMinor: discount.amountMinor }
    : discount;
}

export type TenderRefusal = Readonly<{
  tender: "gift_card" | "store_credit";
  message: string;
}>;

/** `checkout.tenders`: `{ refusals: [{ tender, message }] }`. */
const tendersOutputSchema = Type.Unsafe<readonly TenderRefusal[]>(
  Type.Codec(
    ExactObject({
      refusals: Type.Array(
        ExactObject({
          tender: Type.Union([
            Type.Literal("gift_card"),
            Type.Literal("store_credit"),
          ]),
          message: messageSchema,
        }),
      ),
    }),
  )
    .Decode(tenderRefusalsOf)
    .Encode(tenderRefusalsOutput),
);

function tenderRefusalsOf(
  output: Readonly<{ refusals: TenderRefusal[] }>,
): TenderRefusal[] {
  return output.refusals;
}

function tenderRefusalsOutput(
  refusals: TenderRefusal[],
): Readonly<{ refusals: TenderRefusal[] }> {
  return { refusals };
}

export type DeliveryOutput = Readonly<{
  refusals: readonly string[];
  /** For a pickup: the earliest time that the order can be ready. */
  earliestReadyAt: string | null;
  /** Why, for a buyer whose chosen pickup time is earlier. */
  message: string | null;
}>;

const readyTimeSchema = Type.Refine(Type.String(), isReadyTime, readyTimeError);

function isReadyTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function readyTimeError(): string {
  return "must be a time";
}

/**
 * `checkout.delivery`: `{ refusals?, earliestReadyAt?, message? }`, each
 * refusal `{ message }` only. An empty array has none of the keys, so the
 * host reads it as an output with nothing to apply.
 */
const deliveryOutputShape = Type.Union([
  ExactObject({
    refusals: Type.Optional(
      Type.Array(ExactObject({ message: messageSchema })),
    ),
    earliestReadyAt: Type.Optional(readyTimeSchema),
    message: Type.Optional(messageSchema),
  }),
  Type.Array(Type.Never(), { maxItems: 0 }),
]);
type DeliveryOutputShape = Static<typeof deliveryOutputShape>;

const deliveryOutputSchema = Type.Unsafe<DeliveryOutput>(
  Type.Codec(deliveryOutputShape)
    .Decode(deliveryOutput)
    .Encode(deliveryOutputFields),
);

function deliveryOutput(output: DeliveryOutputShape): DeliveryOutput {
  if (Array.isArray(output))
    return { refusals: [], earliestReadyAt: null, message: null };
  return {
    refusals: messagesOf(output.refusals ?? []),
    earliestReadyAt:
      output.earliestReadyAt === undefined
        ? null
        : new Date(Date.parse(output.earliestReadyAt)).toISOString(),
    message: output.message ?? null,
  };
}

function deliveryOutputFields(output: DeliveryOutput): DeliveryOutputShape {
  return {
    refusals: output.refusals.map(refusalOf),
    ...(output.earliestReadyAt === null
      ? {}
      : { earliestReadyAt: output.earliestReadyAt }),
    ...(output.message === null ? {} : { message: output.message }),
  };
}

/**
 * The parser of one output. The output is free JSON from the VM, so it is
 * checked as it is: no Rust boundary rules, and no defaults to fill.
 */
function outputParser<T extends TSchema>(schema: T) {
  return readOutput.bind(null, schema) as (
    output: unknown,
  ) => Static<T> | undefined;
}

function readOutput<T extends TSchema>(
  schema: T,
  output: unknown,
): Static<T> | undefined {
  if (!Value.Check(schema, output)) return undefined;
  return decodeValue(schema, Value.Clone(output)) as Static<T>;
}

/** The refusal messages of a `checkout.validate` output, or undefined. */
export const parseValidationOutput = outputParser(validationOutputSchema);
/** The output of a handler or an action, or undefined. */
export const parsePluginRunOutput = outputParser(runOutputSchema);
export const parseLinesOutput = outputParser(linesOutputSchema);
export const parseDiscountOutput = outputParser(discountOutputSchema);
export const parseTendersOutput = outputParser(tendersOutputSchema);
export const parseDeliveryOutput = outputParser(deliveryOutputSchema);

// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, SafeInteger, recordParser } from "../schema.ts";

export const currencyCodeSchema = Type.String();
export type CurrencyCode = Static<typeof currencyCodeSchema>;

export const moneySchema = OpenObject({
  amountMinor: SafeInteger,
  currency: currencyCodeSchema,
});
export type Money = Static<typeof moneySchema>;

// Parsers of the records above (Plan 78 step 2).
export const parseMoney = recordParser(moneySchema);

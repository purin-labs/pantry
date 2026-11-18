// The money that Stripe and Square send to the merchant's bank: how much, the
// day that it arrives, and the sales that it pays out. It names no bank account.
import { Type, type Static } from "typebox";
import {
  currencyCodeTextSchema,
  normalizedTextSchema,
  utcTimestampSchema,
} from "./fields.ts";
import {
  ImmutableArray,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const provider = Type.Union([Type.Literal("stripe"), Type.Literal("square")]);

export const commerceBankPayoutV1Schema = ReadonlyStrictObject({
  provider,
  /** The provider's own id for this payout. */
  payoutId: normalizedTextSchema,
  amount: ReadonlyStrictObject({
    /** Negative when the provider takes money back from the bank account. */
    amountMinor: Type.Integer(),
    currency: currencyCodeTextSchema,
  }),
  status: Type.Union([
    Type.Literal("on_its_way"),
    Type.Literal("arrived"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  /** The calendar day at the bank, as the provider gives it. */
  arrivalDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  sentAt: utcTimestampSchema,
  /** The first and the last sale that it pays out; null when not known. */
  sales: Type.Union([
    ReadonlyStrictObject({
      from: utcTimestampSchema,
      to: utcTimestampSchema,
    }),
    Type.Null(),
  ]),
});
export type CommerceBankPayoutV1 = Static<
  typeof commerceBankPayoutV1Schema
>;

export const commerceBankPayoutSourceV1Schema = ReadonlyStrictObject({
  provider,
  /**
   * How this read went for the provider: `read`, a key or a token that the
   * provider refused (`needs_permission`), a provider that did not answer, or
   * for Square the connection's cause: a missing scope such as PAYOUTS_READ,
   * a token that Square refused to refresh, or the application removed in
   * Square. The payouts of an earlier read stay in the answer in each case.
   */
  state: Type.Union([
    Type.Literal("read"),
    Type.Literal("needs_permission"),
    Type.Literal("scope_missing"),
    Type.Literal("refresh_failed"),
    Type.Literal("revoked"),
    Type.Literal("unavailable"),
  ]),
});
export type CommerceBankPayoutSourceV1 = Static<
  typeof commerceBankPayoutSourceV1Schema
>;

export const commerceBankPayoutsV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("underclerk.bank-payouts.v1"),
  merchantId: normalizedTextSchema,
  /** The providers that this merchant connected. */
  sources: ImmutableArray(commerceBankPayoutSourceV1Schema),
  /** True when the window held more payouts than this read returns. */
  truncated: Type.Boolean(),
  payouts: ImmutableArray(commerceBankPayoutV1Schema),
});
export type CommerceBankPayoutsV1 = Static<
  typeof commerceBankPayoutsV1Schema
>;

export const parseCommerceBankPayoutsV1 = wireRecordParser(
  commerceBankPayoutsV1Schema,
);

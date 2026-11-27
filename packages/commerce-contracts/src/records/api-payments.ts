// The payments of a time window: each card payment that the provider answered,
// paid or declined. A step has the shape of a failed-payment step, so a decline
// still shows the later try that followed it. A payment still waiting for the
// provider is not listed. It names no buyer: the lines and the amount are
// enough for staff.
import { Type, type Static } from "typebox";
import { NonNegativeInteger } from "@purin-labs/contract-schema";
import { commerceFailedPaymentStepV1Schema } from "./api-failed-payments.ts";
import { normalizedTextSchema } from "./fields.ts";
import {
  ImmutableArray,
  ReadonlyStrictObject,
  wireRecordParser,
} from "./wire-objects.ts";

const commercePaymentStepV1Schema =
  commerceFailedPaymentStepV1Schema;

const commercePaymentsV1Schema = ReadonlyStrictObject({
  schemaVersion: Type.Literal("commerce.payments.v1"),
  merchantId: normalizedTextSchema,
  merchantRevision: NonNegativeInteger,
  /** True when the window held more payments than this read returns. */
  truncated: Type.Boolean(),
  steps: ImmutableArray(commercePaymentStepV1Schema),
});
export type CommercePaymentsV1 = Static<typeof commercePaymentsV1Schema>;

export const parseCommercePaymentsV1 = wireRecordParser(
  commercePaymentsV1Schema,
);

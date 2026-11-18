// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, SafeInteger, recordParser } from "../schema.ts";
import {
  commerceProjectionSchema,
  commerceValidationErrorSchema,
} from "./commerce-records.ts";
import { resourceIdSchema } from "./identifiers.ts";
import { currencyCodeSchema } from "./money.ts";
import { commerceTimestampSchema } from "./provenance.ts";

export const commerceApplyOutcomeSchema = Type.Union([
  Type.Literal("created"),
  Type.Literal("advanced"),
  Type.Literal("replayed"),
  Type.Literal("ignored_stale"),
]);
export type CommerceApplyOutcome = Static<typeof commerceApplyOutcomeSchema>;

export const appliedCommerceObservationSchema = OpenObject({
  outcome: commerceApplyOutcomeSchema,
  projection: commerceProjectionSchema,
});
export type AppliedCommerceObservation = Static<
  typeof appliedCommerceObservationSchema
>;

export const assignFulfillmentProposalSchema = OpenObject({
  orderId: resourceIdSchema,
  fulfillmentId: resourceIdSchema,
  locationId: resourceIdSchema,
});
export type AssignFulfillmentProposal = Static<
  typeof assignFulfillmentProposalSchema
>;

export const attachTrackingProposalSchema = OpenObject({
  orderId: resourceIdSchema,
  fulfillmentId: resourceIdSchema,
  shipmentId: resourceIdSchema,
  trackingNumber: Type.String(),
});
export type AttachTrackingProposal = Static<
  typeof attachTrackingProposalSchema
>;

export const commerceCueFactSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("payment_failed"),
    orderId: resourceIdSchema,
    paymentId: resourceIdSchema,
    amountMinor: SafeInteger,
    currency: currencyCodeSchema,
    reason: Type.String(),
  }),
  OpenObject({
    kind: Type.Literal("inventory_shortage"),
    orderId: resourceIdSchema,
    sku: Type.String(),
    requested: SafeInteger,
    available: SafeInteger,
    locationId: resourceIdSchema,
  }),
  OpenObject({
    kind: Type.Literal("order_unshipped"),
    orderId: resourceIdSchema,
    fulfillmentId: resourceIdSchema,
    expectedBy: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("tracking_stalled"),
    orderId: resourceIdSchema,
    shipmentId: resourceIdSchema,
    trackingNumber: Type.String(),
    lastEventAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("delivery_exception"),
    orderId: resourceIdSchema,
    shipmentId: resourceIdSchema,
    trackingNumber: Type.String(),
    status: Type.String(),
    reason: Type.String(),
  }),
  OpenObject({
    kind: Type.Literal("cancellation_refund_proposed"),
    orderId: resourceIdSchema,
    paymentId: resourceIdSchema,
    amountMinor: SafeInteger,
    currency: currencyCodeSchema,
    reason: Type.String(),
  }),
]);
export type CommerceCueFact = Static<typeof commerceCueFactSchema>;

export const notifyOperatorProposalSchema = OpenObject({
  orderId: resourceIdSchema,
  subjectId: resourceIdSchema,
  reason: Type.String(),
});
export type NotifyOperatorProposal = Static<
  typeof notifyOperatorProposalSchema
>;

export const prepareCustomerCommunicationProposalSchema = OpenObject({
  orderId: resourceIdSchema,
  shipmentId: resourceIdSchema,
  reason: Type.String(),
});
export type PrepareCustomerCommunicationProposal = Static<
  typeof prepareCustomerCommunicationProposalSchema
>;

export const commerceOperationalProposalSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("assign_fulfillment"),
    details: assignFulfillmentProposalSchema,
  }),
  OpenObject({
    kind: Type.Literal("attach_tracking"),
    details: attachTrackingProposalSchema,
  }),
  OpenObject({
    kind: Type.Literal("notify_operator"),
    details: notifyOperatorProposalSchema,
  }),
  OpenObject({
    kind: Type.Literal("prepare_customer_communication"),
    details: prepareCustomerCommunicationProposalSchema,
  }),
]);
export type CommerceOperationalProposal = Static<
  typeof commerceOperationalProposalSchema
>;

export const commerceTransitionErrorSchema = Type.Union([
  OpenObject({ code: Type.Literal("delete_requires_projection_store") }),
  OpenObject({ code: Type.Literal("projection_kind_mismatch") }),
  OpenObject({ code: Type.Literal("resource_identity_mismatch") }),
  OpenObject({
    code: Type.Literal("revision_conflict"),
    revision: SafeInteger,
  }),
  OpenObject({ code: Type.Literal("terminal_state"), state: Type.String() }),
  OpenObject({ code: Type.Literal("invalid_timestamp_order") }),
  OpenObject({
    code: Type.Literal("validation"),
    error: commerceValidationErrorSchema,
  }),
]);
export type CommerceTransitionError = Static<
  typeof commerceTransitionErrorSchema
>;

// Parsers of the records above (Plan 78 step 2).
export const parseCommerceApplyOutcome = recordParser(
  commerceApplyOutcomeSchema,
);
export const parseAppliedCommerceObservation = recordParser(
  appliedCommerceObservationSchema,
);
export const parseAssignFulfillmentProposal = recordParser(
  assignFulfillmentProposalSchema,
);
export const parseAttachTrackingProposal = recordParser(
  attachTrackingProposalSchema,
);
export const parseCommerceCueFact = recordParser(commerceCueFactSchema);
export const parseNotifyOperatorProposal = recordParser(
  notifyOperatorProposalSchema,
);
export const parsePrepareCustomerCommunicationProposal = recordParser(
  prepareCustomerCommunicationProposalSchema,
);
export const parseCommerceOperationalProposal = recordParser(
  commerceOperationalProposalSchema,
);
export const parseCommerceTransitionError = recordParser(
  commerceTransitionErrorSchema,
);

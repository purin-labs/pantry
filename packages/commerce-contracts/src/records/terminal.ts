// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import {
  OpenObject,
  SafeInteger,
  recordParser,
} from "@purin-labs/contract-schema";
import {
  inPersonTerminalTransportSchema,
  paymentProviderAccountBindingSchema,
} from "./commerce-records.ts";
import {
  commerceMerchantIdSchema,
  organisationIdSchema,
  providerDeliveryIdSchema,
  resourceIdSchema,
} from "./identifiers.ts";
import { moneySchema } from "./money.ts";
import { commerceTimestampSchema } from "./provenance.ts";

/**
 * What a terminal assignment actually points at. A Sandbox simulation target
 * is never recorded as a paired physical device.
 */
export const terminalTargetSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("sandbox_simulated"),
    testDeviceId: resourceIdSchema,
  }),
  OpenObject({
    kind: Type.Literal("paired_physical"),
    providerDeviceId: resourceIdSchema,
  }),
  OpenObject({
    kind: Type.Literal("lan_gateway_device"),
    gatewayId: resourceIdSchema,
    deviceSourceKey: resourceIdSchema,
  }),
  // The Square Point of Sale app on the counter iPad (Plan 90 Phase 3B).
  OpenObject({
    kind: Type.Literal("square_pos_app"),
  }),
]);
export type TerminalTarget = Static<typeof terminalTargetSchema>;

/**
 * Why an assignment stopped being payment authority.
 */
export const terminalRetirementReasonSchema = Type.Union([
  Type.Literal("replaced"),
  Type.Literal("revoked"),
  Type.Literal("connection_removed"),
]);
export type TerminalRetirementReason = Static<
  typeof terminalRetirementReasonSchema
>;

/**
 * An assignment is active or retired. Retirement is an operator or credential
 * decision, never a health observation.
 */
export const terminalAssignmentStateSchema = Type.Union([
  OpenObject({ kind: Type.Literal("active") }),
  OpenObject({
    kind: Type.Literal("retired"),
    reason: terminalRetirementReasonSchema,
    retiredAt: commerceTimestampSchema,
  }),
]);
export type TerminalAssignmentState = Static<
  typeof terminalAssignmentStateSchema
>;

/**
 * One Pantry location bound to one terminal target at one provider location.
 */
export const terminalAssignmentSchema = OpenObject({
  assignmentId: resourceIdSchema,
  organisationId: organisationIdSchema,
  merchantId: commerceMerchantIdSchema,
  satyrLocationId: resourceIdSchema,
  account: paymentProviderAccountBindingSchema,
  providerLocationId: resourceIdSchema,
  target: terminalTargetSchema,
  transport: inPersonTerminalTransportSchema,
  adapterVersion: Type.String(),
  revision: SafeInteger,
  state: terminalAssignmentStateSchema,
});
export type TerminalAssignment = Static<typeof terminalAssignmentSchema>;

/**
 * Observed device health. Diagnostic evidence about a target, never part of an
 * assignment, so it cannot change payment authority.
 */
export const terminalDeviceHealthSchema = Type.Union([
  Type.Literal("unknown"),
  Type.Literal("available"),
  Type.Literal("unavailable"),
]);
export type TerminalDeviceHealth = Static<typeof terminalDeviceHealthSchema>;

/**
 * Where a health reading came from. A simulated target has no provider device
 * resource behind it, so its readings are labelled as such and never read as
 * evidence about physical hardware.
 */
export const terminalHealthSourceSchema = Type.Union([
  Type.Literal("provider_readback"),
  Type.Literal("simulated_target"),
]);
export type TerminalHealthSource = Static<typeof terminalHealthSourceSchema>;

/**
 * One health readback for the target an assignment names.
 *
 * Every reading carries when it was seen and where it came from, so a caller
 * can judge staleness. Collection eligibility never consults this: it comes
 * from the assignment, certification, credentials, and collection ownership.
 */
export const terminalDeviceHealthObservationSchema = OpenObject({
  assignmentId: resourceIdSchema,
  deviceId: resourceIdSchema,
  health: terminalDeviceHealthSchema,
  source: terminalHealthSourceSchema,
  observedAt: commerceTimestampSchema,
});
export type TerminalDeviceHealthObservation = Static<
  typeof terminalDeviceHealthObservationSchema
>;

/**
 * A pairing ceremony. A production device code is short-lived: it either
 * completes or ends, and only a completed attempt yields a physical target.
 */
export const terminalPairingAttemptStateSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("open"),
    pairingCodeId: resourceIdSchema,
    expiresAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("paired"),
    providerDeviceId: resourceIdSchema,
    pairedAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("expired"),
    expiredAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("cancelled"),
    cancelledAt: commerceTimestampSchema,
  }),
]);
export type TerminalPairingAttemptState = Static<
  typeof terminalPairingAttemptStateSchema
>;

/**
 * One pairing attempt against one exact provider location.
 */
export const terminalPairingAttemptSchema = OpenObject({
  attemptId: resourceIdSchema,
  organisationId: organisationIdSchema,
  merchantId: commerceMerchantIdSchema,
  satyrLocationId: resourceIdSchema,
  account: paymentProviderAccountBindingSchema,
  providerLocationId: resourceIdSchema,
  state: terminalPairingAttemptStateSchema,
});
export type TerminalPairingAttempt = Static<
  typeof terminalPairingAttemptSchema
>;

/**
 * The normalized card-present payment lifecycle. Only a completed payment
 * owns a provider payment identity, and a completed Terminal checkout is
 * still only evidence until Pantry reads back the provider Payment.
 */
export const terminalPaymentLifecycleSchema = Type.Union([
  OpenObject({ kind: Type.Literal("pending") }),
  OpenObject({ kind: Type.Literal("in_progress") }),
  OpenObject({ kind: Type.Literal("completed"), paymentId: resourceIdSchema }),
  OpenObject({ kind: Type.Literal("cancelled") }),
  OpenObject({ kind: Type.Literal("failed") }),
]);
export type TerminalPaymentLifecycle = Static<
  typeof terminalPaymentLifecycleSchema
>;

/**
 * One verified terminal payment observation. Catalog, order, inventory,
 * customer, and fulfillment fields in a provider payload have no home here
 * and are dropped at the boundary parser.
 */
export const terminalPaymentObservationSchema = OpenObject({
  providerDeliveryId: providerDeliveryIdSchema,
  providerAccountId: Type.String(),
  terminalCheckoutId: resourceIdSchema,
  providerLocationId: resourceIdSchema,
  deviceId: resourceIdSchema,
  amount: moneySchema,
  lifecycle: terminalPaymentLifecycleSchema,
  observedAt: commerceTimestampSchema,
});
export type TerminalPaymentObservation = Static<
  typeof terminalPaymentObservationSchema
>;

// Parsers of the records above (Plan 78 step 2).
export const parseTerminalTarget = recordParser(terminalTargetSchema);
export const parseTerminalRetirementReason = recordParser(
  terminalRetirementReasonSchema,
);
export const parseTerminalAssignmentState = recordParser(
  terminalAssignmentStateSchema,
);
export const parseTerminalAssignment = recordParser(terminalAssignmentSchema);
export const parseTerminalDeviceHealth = recordParser(
  terminalDeviceHealthSchema,
);
export const parseTerminalHealthSource = recordParser(
  terminalHealthSourceSchema,
);
export const parseTerminalDeviceHealthObservation = recordParser(
  terminalDeviceHealthObservationSchema,
);
export const parseTerminalPairingAttemptState = recordParser(
  terminalPairingAttemptStateSchema,
);
export const parseTerminalPairingAttempt = recordParser(
  terminalPairingAttemptSchema,
);
export const parseTerminalPaymentLifecycle = recordParser(
  terminalPaymentLifecycleSchema,
);
export const parseTerminalPaymentObservation = recordParser(
  terminalPaymentObservationSchema,
);

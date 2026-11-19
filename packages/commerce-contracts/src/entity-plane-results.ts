import {
  OpenObject,
  StrictObject,
  parseContract,
  type ContractDecodeResult,
} from "./schema.ts";
import { Type, type StaticDecode } from "typebox";
import { assertNever } from "@purin-labs/std";
import { type StrictUnion } from "@purin-labs/type-utils";
import { commerceIntegerSchema } from "./cursor-values.ts";
import {
  commerceMutationReceiptV1Schema,
  parseCommerceMutationReceipt,
  type CommerceMutationReceiptV1,
} from "./entity-plane-receipts.ts";
import {
  commerceObservationOutcomeSchema,
  commerceEntityPlaneObservationV1Schema,
  entityPlaneObservationWireSchema,
  parseCommerceEntityPlaneObservation,
  type CommerceEntityPlaneObservationV1,
} from "./entity-plane-observations.ts";
import { invalidShape } from "./query-parts.ts";
import { javascriptTrimmedTextSchema as diagnosticTextSchema } from "./identity-text.ts";

export const commerceEntityPlaneErrorSchema = Type.Union([
  OpenObject({
    code: Type.Literal("invalid_identity"),
    field: diagnosticTextSchema,
  }),
  OpenObject({
    code: Type.Literal("invalid_revision"),
    field: diagnosticTextSchema,
  }),
  OpenObject({ code: Type.Literal("invalid_date") }),
  OpenObject({
    code: Type.Literal("invalid_text"),
    field: diagnosticTextSchema,
  }),
  OpenObject({
    code: Type.Literal("invalid_attribute_value"),
    attributeId: diagnosticTextSchema,
  }),
  OpenObject({
    code: Type.Literal("invalid_attribute_namespace"),
    attributeId: diagnosticTextSchema,
  }),
  OpenObject({
    code: Type.Literal("system_attribute_shadowing"),
    attributeId: diagnosticTextSchema,
  }),
  OpenObject({
    code: Type.Literal("attribute_definition_mismatch"),
    attributeId: diagnosticTextSchema,
  }),
  OpenObject({ code: Type.Literal("invalid_relationship_endpoint") }),
  OpenObject({ code: Type.Literal("relationship_definition_mismatch") }),
  OpenObject({ code: Type.Literal("provenance_identity_mismatch") }),
  OpenObject({ code: Type.Literal("system_relationship_immutable") }),
  OpenObject({ code: Type.Literal("invalid_list_entry_entity_type") }),
  OpenObject({ code: Type.Literal("invalid_view_source") }),
  OpenObject({ code: Type.Literal("invalid_view_presentation") }),
  OpenObject({ code: Type.Literal("invalid_query") }),
  OpenObject({
    code: Type.Literal("missing_authority_field"),
    field: diagnosticTextSchema,
  }),
  OpenObject({ code: Type.Literal("authority_expired") }),
  OpenObject({ code: Type.Literal("authority_out_of_scope") }),
  OpenObject({ code: Type.Literal("sensitivity_denied") }),
  OpenObject({
    code: Type.Literal("revision_conflict"),
    expected: commerceIntegerSchema,
    received: commerceIntegerSchema,
  }),
  OpenObject({ code: Type.Literal("not_found") }),
  OpenObject({ code: Type.Literal("duplicate_identity") }),
  OpenObject({ code: Type.Literal("unsupported_command") }),
  OpenObject({ code: Type.Literal("parse"), reason: diagnosticTextSchema }),
]);
export type CommerceEntityPlaneError = StrictUnion<
  StaticDecode<typeof commerceEntityPlaneErrorSchema>
>;
export const commerceCommandResultSchema = Type.Union([
  StrictObject({
    status: Type.Literal("accepted"),
    receipt: Type.Unsafe<CommerceMutationReceiptV1>(
      commerceMutationReceiptV1Schema,
    ),
  }),
  StrictObject({
    status: Type.Literal("rejected"),
    error: Type.Unsafe<CommerceEntityPlaneError>(
      commerceEntityPlaneErrorSchema,
    ),
  }),
]);
export type CommerceCommandResult = StrictUnion<
  StaticDecode<typeof commerceCommandResultSchema>
>;
export const commerceObservationResultSchema = Type.Union([
  OpenObject({
    status: Type.Literal("accepted"),
    outcome: commerceObservationOutcomeSchema,
    observation: Type.Unsafe<CommerceEntityPlaneObservationV1>(
      commerceEntityPlaneObservationV1Schema,
    ),
  }),
  OpenObject({
    status: Type.Literal("rejected"),
    error: Type.Unsafe<CommerceEntityPlaneError>(
      commerceEntityPlaneErrorSchema,
    ),
  }),
]);
export type CommerceObservationResult = StrictUnion<
  StaticDecode<typeof commerceObservationResultSchema>
>;
const commandResultWire = Type.Union([
  StrictObject({
    status: Type.Literal("accepted"),
    // The SDK delegates missing/malformed receipts to the receipt parser's refusal.
    receipt: Type.Optional(Type.Unknown()),
  }),
  StrictObject({
    status: Type.Literal("rejected"),
    error: commerceEntityPlaneErrorSchema,
  }),
]);
const observationResultWire = Type.Union([
  OpenObject({
    status: Type.Literal("accepted"),
    outcome: commerceObservationOutcomeSchema,
    observation: entityPlaneObservationWireSchema,
  }),
  OpenObject({
    status: Type.Literal("rejected"),
    error: commerceEntityPlaneErrorSchema,
  }),
]);

export function parseCommerceEntityPlaneError(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneError> {
  const parsed = parseContract(
    commerceEntityPlaneErrorSchema,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const error = parsed.value;
  switch (error.code) {
    case "invalid_identity":
    case "invalid_revision":
    case "invalid_text":
    case "missing_authority_field":
      return { ok: true, value: { code: error.code, field: error.field } };
    case "invalid_attribute_value":
    case "invalid_attribute_namespace":
    case "system_attribute_shadowing":
    case "attribute_definition_mismatch":
      return {
        ok: true,
        value: { code: error.code, attributeId: error.attributeId },
      };
    case "revision_conflict":
      return {
        ok: true,
        value: {
          code: error.code,
          expected: BigInt(error.expected),
          received: BigInt(error.received),
        },
      };
    case "parse":
      return { ok: true, value: { code: error.code, reason: error.reason } };
    case "invalid_date":
    case "invalid_relationship_endpoint":
    case "relationship_definition_mismatch":
    case "provenance_identity_mismatch":
    case "system_relationship_immutable":
    case "invalid_list_entry_entity_type":
    case "invalid_view_source":
    case "invalid_view_presentation":
    case "invalid_query":
    case "authority_expired":
    case "authority_out_of_scope":
    case "sensitivity_denied":
    case "not_found":
    case "duplicate_identity":
    case "unsupported_command":
      return { ok: true, value: { code: error.code } };
    default:
      return assertNever(error);
  }
}
export function parseCommerceCommandResult(
  input: unknown,
): ContractDecodeResult<CommerceCommandResult> {
  const parsed = parseContract(commandResultWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  switch (parsed.value.status) {
    case "accepted": {
      const receipt = parseCommerceMutationReceipt(parsed.value.receipt);
      if (!receipt.ok) return receipt;
      return {
        ok: true,
        value: { status: "accepted", receipt: receipt.value },
      };
    }
    case "rejected": {
      const error = parseCommerceEntityPlaneError(parsed.value.error);
      if (!error.ok) return error;
      return { ok: true, value: { status: "rejected", error: error.value } };
    }
    default:
      return assertNever(parsed.value);
  }
}
export function parseCommerceObservationResult(
  input: unknown,
): ContractDecodeResult<CommerceObservationResult> {
  const parsed = parseContract(observationResultWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  switch (parsed.value.status) {
    case "accepted": {
      const observation = parseCommerceEntityPlaneObservation(
        parsed.value.observation,
      );
      if (!observation.ok) return observation;
      return {
        ok: true,
        value: {
          status: "accepted",
          outcome: parsed.value.outcome,
          observation: observation.value,
        },
      };
    }
    case "rejected": {
      const error = parseCommerceEntityPlaneError(parsed.value.error);
      if (!error.ok) return error;
      return { ok: true, value: { status: "rejected", error: error.value } };
    }
    default:
      return assertNever(parsed.value);
  }
}

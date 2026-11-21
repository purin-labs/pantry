import type {
  SupplierPayoutExecutionPlan,
  SupplierPayoutState,
  SupplierPayable,
  CanonicalCommerceDelivery,
  CommerceCueFact,
  CommerceCursor,
  CommerceCursorPayload,
  CommerceEntityPlaneCommand,
  CommerceGraphQuery,
  CommerceQueryPlan,
  CommerceQueryPlanOutcome,
} from "@purin-labs/commerce-contracts";
import { parseCommerceCursorValue } from "@purin-labs/commerce-client";
import {
  decodeCommerceCursor as decodeCommerceCursorTypescript,
  parseCommerceCursorPayload,
} from "@purin-labs/commerce-contracts/cursor-payload";
import { validateCommerceEntityPlaneCommandAuthority } from "@purin-labs/commerce-contracts/entity-plane-command-authority";
import { parseCommerceEntityPlaneCommand } from "@purin-labs/commerce-contracts/entity-plane-commands";
import { parseCommerceGraphQuery } from "@purin-labs/commerce-contracts/graph-query";
import { encodeCommerceCursor as encodeCommerceCursorTypescript } from "@purin-labs/commerce-contracts/query-encoders";
import { parseCommerceQueryPlan } from "@purin-labs/commerce-contracts/query-plan";
import { planCommerceGraphQuery as planCommerceGraphQueryTypescript } from "@purin-labs/commerce-contracts/query-planner";
import type { ContractDecodeResult } from "@purin-labs/contract-schema";
import type { CommerceBoundaryResponse } from "@purin-labs/commerce-contracts/commerce-boundary";
import {
  deriveLabEventCueFacts as deriveLabEventCueFactsTypescript,
  normalizeLabEvent as normalizeLabEventTypescript,
} from "@purin-labs/commerce-contracts/lab-normalizer";
import {
  applySupplierPayableCommand as applySupplierPayableCommandTypescript,
  reconcileSupplierPayout as reconcileSupplierPayoutTypescript,
  validateSupplierPayoutObservation as validateSupplierPayoutObservationTypescript,
  validateSupplierPayoutPlan as validateSupplierPayoutPlanTypescript,
} from "@purin-labs/commerce-contracts/supplier-payouts";
import {
  parseCanonicalCommerceDelivery,
  parseCommerceCueFacts,
} from "../actors/commerce-projection";
import type { Result } from "../result";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import { assertNever, isRecord } from "@purin-labs/std";

export type CommerceWasmError =
  | { readonly code: "commerce_wasm_input_invalid" }
  | { readonly code: "commerce_wasm_response_invalid" }
  | {
      readonly code: "commerce_wasm_rejected";
      readonly reason: string;
    };

/** Proves a shared query at the Platform boundary. */
export function assertCommerceGraphQueryWithLexicon(
  value: unknown,
): asserts value is CommerceGraphQuery {
  decideLexiconValue(parseCommerceGraphQuery, value, "CommerceGraphQuery");
}

/** Proves a shared command at the Platform boundary. */
export function assertCommerceEntityPlaneCommandWithLexicon(
  value: unknown,
): asserts value is CommerceEntityPlaneCommand {
  decideLexiconValue(
    parseCommerceEntityPlaneCommand,
    value,
    "CommerceEntityPlaneCommand",
  );
}

/** Proves a compiled query plan at the Platform boundary. */
export function assertCommerceQueryPlanWithLexicon(
  value: unknown,
): asserts value is CommerceQueryPlan {
  decideLexiconValue(parseCommerceQueryPlan, value, "CommerceQueryPlan");
}

/** Proves the command/authority binding before an Commerce RPC. */
export function assertCommerceEntityPlaneCommandAuthorityWithLexicon(
  value: unknown,
): void {
  decideLexiconValue(
    validateCommerceEntityPlaneCommandAuthority,
    value,
    "CommerceEntityPlaneCommandAuthority",
  );
}

export function normalizeLabCommerceDelivery(
  input: unknown,
): Result<CanonicalCommerceDelivery, CommerceWasmError> {
  return normalizeCommerceDelivery(input, normalizeLabEventTypescript);
}

/**
 * Runs a normalizer of a provider payload and checks the canonical delivery
 * that it returns. A provider module gives its normalizer
 * (`shopify/delivery-normalizers.ts`).
 */
export function normalizeCommerceDelivery(
  input: unknown,
  typescript: (input: unknown) => CommerceBoundaryResponse,
): Result<CanonicalCommerceDelivery, CommerceWasmError> {
  const bytes = encodeJson(input);

  if (!bytes.ok) {
    return bytes;
  }

  const normalized = decideCommerceResponse(typescript, bytes.value);

  if (!normalized.ok) {
    return normalized;
  }

  const delivery = parseCanonicalCommerceDelivery(normalized.value);

  return delivery.ok
    ? delivery
    : { ok: false, error: { code: "commerce_wasm_response_invalid" } };
}

export function deriveLabCommerceCueFacts(
  input: unknown,
): Result<readonly CommerceCueFact[], CommerceWasmError> {
  const bytes = encodeJson(input);

  if (!bytes.ok) {
    return bytes;
  }

  const derived = decideCommerceResponse(
    deriveLabEventCueFactsTypescript,
    bytes.value,
  );

  if (!derived.ok) {
    return derived;
  }

  const facts = parseCommerceCueFacts(derived.value);

  return facts.ok
    ? facts
    : { ok: false, error: { code: "commerce_wasm_response_invalid" } };
}

/** Compiles the shared graph-query grammar. */
export function planCommerceGraphQuery(
  input: unknown,
): Result<CommerceQueryPlanOutcome, CommerceWasmError> {
  const request = encodeJson(input);
  if (!request.ok) return request;
  const planned = planCommerceGraphQueryTypescript(request.value);
  if (!planned.ok) return plannerFailure(typescriptRefusal(planned));
  return { ok: true, value: planned.value };
}

/** Encodes a cursor payload with the contracts codec. */
export function encodeCommerceCursor(
  input: unknown,
): Result<CommerceCursor, CommerceWasmError> {
  const payload = encodeJson(input);
  if (!payload.ok) return payload;
  const encoded = typescriptCursor(payload.value);
  if (!encoded.ok) return typescriptRefusal(encoded);
  return { ok: true, value: parseCommerceCursorValue(encoded.value) };
}

/** Decodes a cursor and validates the canonical payload shape at the boundary. */
export function decodeCommerceCursor(
  input: unknown,
): Result<CommerceCursorPayload, CommerceWasmError> {
  const cursor = encodeJson(input);
  if (!cursor.ok) return cursor;
  const decoded = typescriptDecodedCursor(cursor.value);
  if (!decoded.ok) return typescriptRefusal(decoded);
  return { ok: true, value: decoded.value as CommerceCursorPayload };
}

function plannerFailure(result: {
  readonly ok: false;
  readonly error: CommerceWasmError;
}): Result<never, CommerceWasmError> {
  return result.error.code === "commerce_wasm_rejected" &&
    result.error.reason.startsWith("invalid_request")
    ? { ok: false, error: { code: "commerce_wasm_input_invalid" } }
    : result;
}

/**
 * Move money between a payable's buckets, under Lexicon's rules.
 *
 * The worker holds no arithmetic of its own here. Whether an allocation fits,
 * whether a settlement is legal, and above all whether held money may be freed
 * are decided by the contract — the last of those from the payout's own state,
 * so a caller cannot assert a failure in order to release money the provider
 * may still move.
 */
export function applySupplierPayableCommandWithLexicon(
  input: Readonly<{
    payable: unknown;
    command: unknown;
  }>,
): Result<SupplierPayable, CommerceWasmError> {
  const encoded = encodeJson({
    payable: input.payable,
    command: input.command,
  });
  if (!encoded.ok) {
    return { ok: false, error: { code: "commerce_wasm_input_invalid" } };
  }
  const response = decideCommerceResponse(
    applySupplierPayableCommandTypescript,
    encoded.value,
  );
  if (!response.ok) return response;
  return isSupplierPayableResponse(response.value)
    ? { ok: true, value: response.value }
    : { ok: false, error: { code: "commerce_wasm_response_invalid" } };
}

// Successful output has already passed the payable constructors.
function isSupplierPayableResponse(value: unknown): value is SupplierPayable {
  return isRecord(value) && isRecord(value.allocation);
}

/**
 * What Lexicon says about a payout plan.
 *
 * `matchesApproval` is the one an executor must consult: a plan whose
 * economics no longer digest to the seal it carries was approved for something
 * else, whatever else about it still validates.
 */
type SupplierPayoutPlanValidation = Readonly<{
  economicsDigest: string;
  matchesApproval: boolean;
}>;

/**
 * Prove a payout plan with Lexicon's own constructors, and get back the digest
 * of its economics.
 *
 * The worker deliberately owns no copy of this arithmetic. One implementation,
 * in the language that owns the rules, is what stops an approval being checked
 * against a digest computed two different ways.
 */
export function validateSupplierPayoutPlanWithLexicon(
  plan: unknown,
): Result<SupplierPayoutPlanValidation, CommerceWasmError> {
  const encoded = encodeJson(plan);
  if (!encoded.ok) {
    return { ok: false, error: { code: "commerce_wasm_input_invalid" } };
  }
  const response = decideCommerceResponse(
    validateSupplierPayoutPlanTypescript,
    encoded.value,
  );
  if (!response.ok) return response;
  const value = response.value;
  if (
    !isRecord(value) ||
    typeof value.economicsDigest !== "string" ||
    typeof value.matchesApproval !== "boolean"
  ) {
    return { ok: false, error: { code: "commerce_wasm_response_invalid" } };
  }
  return {
    ok: true,
    value: {
      economicsDigest: value.economicsDigest,
      matchesApproval: value.matchesApproval,
    },
  };
}

export function assertSupplierPayoutPlanWithLexicon(
  value: unknown,
): asserts value is SupplierPayoutExecutionPlan {
  decideCommerceValue(
    validateSupplierPayoutPlanTypescript,
    value,
    "SupplierPayoutExecutionPlan",
  );
}

export type SupplierPayoutObservation = Variant<
  SupplierPayoutState,
  | "provider_pending"
  | "settled"
  | "return_pending"
  | "returned"
  | "reversal_pending"
  | "reversed"
  | "failed"
  | "cancelled"
>;

export function assertSupplierPayoutObservationWithLexicon(
  value: unknown,
): asserts value is SupplierPayoutObservation {
  decideCommerceValue(
    validateSupplierPayoutObservationTypescript,
    value,
    "SupplierPayoutObservation",
  );
}

type SupplierPayoutReconciliation = Readonly<{
  state: SupplierPayoutObservation;
  payable: SupplierPayable;
}>;

export function reconcileSupplierPayoutWithLexicon(
  input: Readonly<{
    fromKind: SupplierPayoutState["kind"];
    observation: SupplierPayoutObservation;
    payable: unknown;
    amount: Readonly<{ amountMinor: number; currency: string }>;
  }>,
): Result<SupplierPayoutReconciliation, CommerceWasmError> {
  const encoded = encodeJson(input);
  if (!encoded.ok)
    return { ok: false, error: { code: "commerce_wasm_input_invalid" } };
  const result = decideCommerceResponse(
    reconcileSupplierPayoutTypescript,
    encoded.value,
  );
  if (!result.ok) return result;
  return isPayoutReconciliationResponse(result.value)
    ? { ok: true, value: result.value }
    : { ok: false, error: { code: "commerce_wasm_response_invalid" } };
}

// The successful response has already parsed the state and rebuilt the payable.
function isPayoutReconciliationResponse(
  value: unknown,
): value is SupplierPayoutReconciliation {
  return isRecord(value) && isRecord(value.state) && isRecord(value.payable);
}

/** The response of a commerce boundary function as a Platform result. */
function decideCommerceResponse(
  typescript: (input: unknown) => CommerceBoundaryResponse,
  input: unknown,
): Result<unknown, CommerceWasmError> {
  return decodeWasmValue(typescript(input));
}

/** A commerce validation that throws on refusal. */
function decideCommerceValue(
  typescript: (input: unknown) => CommerceBoundaryResponse,
  value: unknown,
  label: string,
): void {
  const encoded = encodeJson(value);
  if (!encoded.ok) {
    throw new Error(
      `${label} rejected by Lexicon: commerce_wasm_input_invalid`,
    );
  }
  const response = decideCommerceResponse(typescript, encoded.value);
  if (!response.ok) {
    throw new Error(
      `${label} rejected by Lexicon: ${commerceWasmErrorReason(response.error)}`,
    );
  }
}

/** The contract parser decides, and a refusal throws. */
function decideLexiconValue(
  parse: (input: unknown) => ContractDecodeResult<unknown>,
  value: unknown,
  label: string,
): void {
  const encoded = encodeJson(value);
  if (!encoded.ok) {
    throw new Error(
      `${label} rejected by Lexicon: commerce_wasm_input_invalid`,
    );
  }
  const parsed = parse(encoded.value);
  if (!parsed.ok) {
    throw new Error(
      `${label} rejected by Lexicon: ${typescriptRefusal(parsed).error.reason}`,
    );
  }
}

function typescriptCursor(input: unknown): ContractDecodeResult<string> {
  const payload = parseCommerceCursorPayload(input);
  if (!payload.ok) return payload;
  return { ok: true, value: encodeCommerceCursorTypescript(payload.value) };
}

function typescriptDecodedCursor(
  input: unknown,
): ContractDecodeResult<unknown> {
  if (typeof input !== "string")
    return {
      ok: false,
      error: {
        kind: "validation_rejected",
        code: "invalid_cursor",
        reason: "cursor is not a string",
        details: null,
      },
    };
  return decodeCommerceCursorTypescript(input as CommerceCursor);
}

/** A TypeScript refusal in the Rust boundary's error form, `code: reason`. */
function typescriptRefusal(result: {
  readonly ok: false;
  readonly error: Readonly<{ code: string; reason: string }>;
}): {
  readonly ok: false;
  readonly error: VariantBy<
    CommerceWasmError,
    "code",
    "commerce_wasm_rejected"
  >;
} {
  return {
    ok: false,
    error: {
      code: "commerce_wasm_rejected",
      reason: `${result.error.code}: ${result.error.reason}`,
    },
  };
}

/** The JSON copy of a value, as the contract parsers read it. */
function encodeJson(value: unknown): Result<unknown, CommerceWasmError> {
  let encoded: string | undefined;

  try {
    encoded = JSON.stringify(value, encodeWasmJsonValue);
  } catch {
    return { ok: false, error: { code: "commerce_wasm_input_invalid" } };
  }

  return encoded === undefined
    ? { ok: false, error: { code: "commerce_wasm_input_invalid" } }
    : { ok: true, value: JSON.parse(encoded) };
}

function encodeWasmJsonValue(_key: string, value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || BigInt(number) !== value) {
    throw new Error("Wasm JSON integer exceeds the safe range");
  }
  return number;
}

function decodeWasmValue(decoded: unknown): Result<unknown, CommerceWasmError> {
  if (!isRecord(decoded) || typeof decoded.status !== "string") {
    return { ok: false, error: { code: "commerce_wasm_response_invalid" } };
  }

  if (decoded.status === "ok" && Object.hasOwn(decoded, "value")) {
    return { ok: true, value: decoded.value };
  }

  if (decoded.status === "error" && Object.hasOwn(decoded, "error")) {
    return {
      ok: false,
      error: {
        code: "commerce_wasm_rejected",
        reason: wasmErrorReason(decoded.error),
      },
    };
  }

  return { ok: false, error: { code: "commerce_wasm_response_invalid" } };
}

function wasmErrorReason(raw: unknown): string {
  if (!isRecord(raw)) {
    return "unknown";
  }
  if (
    typeof raw.code === "string" &&
    raw.code.length > 0 &&
    typeof raw.reason === "string" &&
    raw.reason.length > 0
  ) {
    return `${raw.code}: ${raw.reason}`;
  }
  if (typeof raw.code === "string" && raw.code.length > 0) {
    return raw.code;
  }
  if (typeof raw.reason === "string" && raw.reason.length > 0) {
    return raw.reason;
  }
  return "unknown";
}

function commerceWasmErrorReason(error: CommerceWasmError): string {
  switch (error.code) {
    case "commerce_wasm_input_invalid":
      return error.code;
    case "commerce_wasm_response_invalid":
      return error.code;
    case "commerce_wasm_rejected":
      return error.reason;
    default:
      return assertNever(error, "Unexpected commerce Wasm error");
  }
}

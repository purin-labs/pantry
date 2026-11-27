import { parseCommerceEntityShape } from "./entity-record.ts";
import { parseCommerceRelationshipShape } from "./relationships.ts";
import {
  jsonSafeInteger,
  UnsafeJsonIntegerError,
  type ContractDecodeResult,
} from "@purin-labs/contract-schema";

import { isRecord } from "@purin-labs/std";

class LexiconValidationError extends TypeError {
  readonly code: string;
  readonly details: unknown;

  constructor(error: Readonly<{ code?: unknown; reason?: unknown }>) {
    const code =
      typeof error.code === "string" ? error.code : "invalid_contract";
    const reason =
      typeof error.reason === "string"
        ? error.reason
        : "Lexicon rejected the contract value";
    super(`${code}: ${reason}`);
    this.name = "LexiconValidationError";
    this.code = code;
    this.details = error;
  }
}

function jsonValue(value: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, jsonSafeInteger);
  } catch (error) {
    throw new LexiconValidationError(
      error instanceof UnsafeJsonIntegerError
        ? {
            code: "invalid_json_integer",
            reason: "contract integer exceeds the JavaScript safe range",
          }
        : { code: "invalid_json", reason: "value is not JSON serializable" },
    );
  }
  if (text === undefined)
    throw new LexiconValidationError({
      code: "invalid_json",
      reason: "value is not JSON serializable",
    });
  return JSON.parse(text);
}

/** The Wasm module's output: plain JSON, with `integer` values as bigints. */
function reviveIntegers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveIntegers);
  if (!isRecord(value)) return value;
  for (const key of Object.keys(value)) value[key] = reviveIntegers(value[key]);
  if (value.kind === "integer" && typeof value.value === "number")
    value.value = BigInt(value.value);
  return value;
}

function validated<T>(
  parse: (input: unknown) => ContractDecodeResult<unknown>,
  value: unknown,
): T {
  const result = parse(jsonValue(value));
  if (!result.ok) {
    const details = isRecord(result.error.details) ? result.error.details : {};
    throw new LexiconValidationError({
      ...details,
      code: result.error.code,
      reason: result.error.reason,
    });
  }
  return reviveIntegers(jsonValue(result.value)) as T;
}

export function validateCommerceEntityShape<T>(value: unknown): T {
  return validated(parseCommerceEntityShape, value);
}
export function validateCommerceRelationshipShape<T>(value: unknown): T {
  return validated(parseCommerceRelationshipShape, value);
}

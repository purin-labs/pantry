// The commerce validators that the Portal and the client call on records they
// receive. Each one checks with the contract parser and returns the parsed
// value, with integer values revived as bigint where the record schema holds
// a bigint; a refusal throws LexiconValidationError.
import { parseCommerceEntityAuthority } from "./command-authority.ts";
import { parseCommerceCursorPayload } from "./cursor-payload.ts";
import { parseCommerceEntity } from "./entity-definition.ts";
import { validateCommerceEntityPlaneCommandAuthority as validateCommandAuthority } from "./entity-plane-command-authority.ts";
import { parseCommerceEntityPlaneCommand } from "./entity-plane-commands.ts";
import { parseCommerceEntityPlaneObservation } from "./entity-plane-observations.ts";
import { parseCommerceMutationReceipt } from "./entity-plane-receipts.ts";
import { parseCommerceEntityShape } from "./entity-record.ts";
import { parseCommerceEntityType } from "./entity-type.ts";
import {
  parseCommerceGraphQuery,
  parsePublishedCommerceSelector,
} from "./graph-query.ts";
import {
  parseCommerceList,
  parseCommerceListEntry,
  parseCommerceListEntryShape,
} from "./list-records.ts";
import { parseCommerceQueryPlan } from "./query-plan.ts";
import {
  parseCommerceRelationship,
  parseCommerceRelationshipShape,
  parseRelationshipDefinition,
} from "./relationships.ts";
import type { ContractDecodeResult } from "./schema.ts";

export type { ContractDecodeError, ContractDecodeResult } from "./schema.ts";
import { parseSavedCommerceView } from "./view-records.ts";
import { isRecord } from "@purin-labs/std";

export class LexiconValidationError extends TypeError {
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

export function initializeBrowserValidators(): Promise<void> {
  return Promise.resolve();
}

class UnsafeIntegerError extends TypeError {}

function jsonValue(value: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, safeInteger);
  } catch (error) {
    throw new LexiconValidationError(
      error instanceof UnsafeIntegerError
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

function safeInteger(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || BigInt(number) !== value)
      throw new UnsafeIntegerError();
    return number;
  }
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value)
  )
    throw new UnsafeIntegerError();
  return value;
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

function definedEntity(input: unknown): ContractDecodeResult<unknown> {
  return isRecord(input)
    ? parseCommerceEntity(input.entity, input.attributeDefinitions)
    : parseCommerceEntity(undefined, undefined);
}

export function validateCommerceGraphQuery<T>(value: unknown): T {
  return validated(parseCommerceGraphQuery, value);
}
export function validateCommerceEntityPlaneCommand<T>(value: unknown): T {
  return validated(parseCommerceEntityPlaneCommand, value);
}
export function validateCommerceEntityAuthority<T>(value: unknown): T {
  return validated(parseCommerceEntityAuthority, value);
}
export function validateCommerceQueryPlan<T>(value: unknown): T {
  return validated(parseCommerceQueryPlan, value);
}
export function validateCommerceCursorPayload<T>(value: unknown): T {
  return validated(parseCommerceCursorPayload, value);
}
export function validateCommerceEntity<T>(value: unknown): T {
  return validated(definedEntity, value);
}
export function validateCommerceEntityShape<T>(value: unknown): T {
  return validated(parseCommerceEntityShape, value);
}
export function validateCommerceEntityType<T>(value: unknown): T {
  return validated(parseCommerceEntityType, value);
}
export function validateCommerceRelationship<T>(value: unknown): T {
  return validated(parseCommerceRelationship, value);
}
export function validateCommerceRelationshipShape<T>(value: unknown): T {
  return validated(parseCommerceRelationshipShape, value);
}
export function validateRelationshipDefinition<T>(value: unknown): T {
  return validated(parseRelationshipDefinition, value);
}
export function validateCommerceList<T>(value: unknown): T {
  return validated(parseCommerceList, value);
}
export function validateCommerceListEntry<T>(value: unknown): T {
  return validated(parseCommerceListEntry, value);
}
export function validateCommerceListEntryShape<T>(value: unknown): T {
  return validated(parseCommerceListEntryShape, value);
}
export function validateSavedCommerceView<T>(value: unknown): T {
  return validated(parseSavedCommerceView, value);
}
export function validatePublishedCommerceSelector<T>(value: unknown): T {
  return validated(parsePublishedCommerceSelector, value);
}
export function validateCommerceMutationReceipt<T>(value: unknown): T {
  return validated(parseCommerceMutationReceipt, value);
}
export function validateCommerceEntityPlaneObservation<T>(value: unknown): T {
  return validated(parseCommerceEntityPlaneObservation, value);
}
export function validateCommerceEntityPlaneCommandAuthority<T>(
  value: unknown,
): T {
  return validated(validateCommandAuthority, value);
}

import { parseCommerceGraphResponse } from "@purin-labs/commerce-client";
import type { CommerceGraphQueryResult } from "@purin-labs/commerce-contracts";
import { isRecord } from "@purin-labs/std";

export type CommercePresentationParseError = Readonly<{
  kind: "invalid_response";
  path: string;
}>;

export type CommercePresentationParseResult<TValue> =
  | Readonly<{ ok: true; value: TValue }>
  | Readonly<{ ok: false; error: CommercePresentationParseError }>;

export function parseCommerceGraphQueryResult(
  value: unknown,
): CommercePresentationParseResult<CommerceGraphQueryResult> {
  try {
    return {
      ok: true,
      value: parseCommerceGraphResponse(
        normalizeGraphWirePayload(graphResponsePayload(value)),
      ),
    };
  } catch {
    return {
      ok: false,
      error: { kind: "invalid_response", path: "response" },
    };
  }
}

function graphResponsePayload(value: unknown): unknown {
  if (isRecord(value) && value.ok === true && "result" in value)
    return value.result;
  return value;
}

function normalizeGraphWirePayload(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.aggregations)) return value;
  return {
    ...value,
    entities: Array.isArray(value.entities)
      ? value.entities.map(normalizeRecordAttributes)
      : value.entities,
    listEntries: Array.isArray(value.listEntries)
      ? value.listEntries.map(normalizeRecordAttributes)
      : value.listEntries,
    aggregations: value.aggregations.map(normalizeAggregationWireValue),
  };
}

/**
 * An entity carries `attributes`; a list entry carries `attributeValues`.
 * The wire sends an integer value of either as a decimal string.
 */
function normalizeRecordAttributes(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    ...(Array.isArray(value.attributes)
      ? { attributes: value.attributes.map(normalizeAttributeWireValue) }
      : {}),
    ...(Array.isArray(value.attributeValues)
      ? {
          attributeValues: value.attributeValues.map(
            normalizeAttributeWireValue,
          ),
        }
      : {}),
  };
}

function normalizeAttributeWireValue(value: unknown): unknown {
  if (
    !isRecord(value) ||
    !isRecord(value.value) ||
    value.value.kind !== "integer" ||
    typeof value.value.value !== "string"
  )
    return value;
  const text = value.value.value;
  if (!/^-?(0|[1-9][0-9]*)$/.test(text))
    throw new Error("Integer attribute must contain a whole number.");
  const number = Number(text);
  if (!Number.isSafeInteger(number))
    throw new Error("Integer attribute is outside the safe integer range.");
  return { ...value, value: { kind: "integer", value: number } };
}

function normalizeAggregationWireValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (
    (value.kind === "count" || value.kind === "number") &&
    typeof value.value === "string"
  ) {
    return { ...value, value: safeAggregationNumber(value.value) };
  }
  if (value.kind === "grouped_count" && Array.isArray(value.groups)) {
    return {
      ...value,
      groups: value.groups.map(normalizeAggregationGroupWireValue),
    };
  }
  if (value.kind === "age_buckets" && Array.isArray(value.buckets)) {
    return {
      ...value,
      buckets: value.buckets.map(normalizeAggregationBucketWireValue),
    };
  }
  return value;
}

function normalizeAggregationGroupWireValue(value: unknown): unknown {
  if (!isRecord(value) || typeof value.count !== "string") return value;
  return { ...value, count: safeAggregationNumber(value.count) };
}

function normalizeAggregationBucketWireValue(value: unknown): unknown {
  if (!isRecord(value) || typeof value.count !== "string") return value;
  return { ...value, count: safeAggregationNumber(value.count) };
}

function safeAggregationNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(
      "Commerce aggregation count is outside the safe integer range.",
    );
  return parsed;
}

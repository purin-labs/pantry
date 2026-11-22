import {
  customConnectorValueMatchesSchema,
  type CustomConnectorSchema,
  type JsonValue,
} from "./definition";
import type { Result } from "@purin-labs/kernel/result";

type Projection = Result<
  JsonValue,
  { readonly code: "response_contract_changed" }
>;

// Provider responses often contain additional fields. Only reviewed fields cross
// this boundary; input validation remains strict about undeclared properties.
export function projectReviewedResponse(
  raw: unknown,
  schema: CustomConnectorSchema,
): Projection {
  if (raw === null) return checked(null, schema);
  if (schema.kind === "object") {
    if (typeof raw !== "object" || Array.isArray(raw)) return invalid();
    const value: Record<string, JsonValue> = {};
    for (const [key, property] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(raw, key)) continue;
      const projected = projectReviewedResponse(
        Reflect.get(raw, key),
        property,
      );
      if (!projected.ok) return projected;
      Object.defineProperty(value, key, {
        value: projected.value,
        enumerable: true,
      });
    }
    return checked(value, schema);
  }
  if (schema.kind === "array") {
    if (!Array.isArray(raw) || raw.length > schema.maxItems) return invalid();
    const value: JsonValue[] = [];
    for (const item of raw) {
      const projected = projectReviewedResponse(item, schema.items);
      if (!projected.ok) return projected;
      value.push(projected.value);
    }
    return checked(value, schema);
  }
  if (
    typeof raw === "string" ||
    typeof raw === "number" ||
    typeof raw === "boolean"
  )
    return checked(raw, schema);
  return invalid();
}

function checked(value: JsonValue, schema: CustomConnectorSchema): Projection {
  return customConnectorValueMatchesSchema(value, schema)
    ? { ok: true, value }
    : invalid();
}

function invalid(): Projection {
  return { ok: false, error: { code: "response_contract_changed" } };
}

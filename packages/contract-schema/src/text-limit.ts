import { Type, type TSchema } from "typebox";
import { codePointCount, isRecord, utf8ByteLength } from "@purin-labs/std";

/**
 * What a text limit counts: Unicode code points (Rust `chars().count()`), or
 * UTF-8 bytes (Rust `len()`) where a store or a provider limits bytes.
 */
export type TextLimitUnit = "code_points" | "utf8_bytes";

/** The checks that `textLimit` made; `holdsTextLimits` runs only these. */
const TEXT_LIMIT_CHECKS = new WeakSet<(value: unknown) => boolean>();

/**
 * A size limit on a string schema (FND-11). TypeBox `maxLength` counts
 * grapheme clusters, so one letter with many combining marks counts as one
 * and passes any limit. `textLimit` keeps `maxLength` as the hint that a
 * model or a form reads, and adds a check of the code points or the UTF-8
 * bytes of the text against the same number.
 *
 * It takes a `Type.String` schema or a plain JSON schema object, also one of
 * type `["string", "null"]`; a value that is not a string passes this check.
 * TypeBox keeps the check under a hidden key, so the JSON of the schema, and
 * the tool schema that a model reads, do not change. `pnpm lint:text-limits`
 * refuses a new string schema that sets `maxLength` outside `textLimit`.
 */
export function textLimit<const Schema extends object>(
  schema: Schema,
  unit: TextLimitUnit = "code_points",
): Schema {
  // TypeBox's TString type does not carry its options, so the limit is read
  // here; a schema with no limit is a programmer error.
  const limit = (schema as Readonly<{ maxLength?: unknown }>).maxLength;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0)
    throw new TypeError("textLimit needs a string schema with a maxLength");
  const size = unit === "code_points" ? codePointCount : utf8ByteLength;
  const words = unit === "code_points" ? "characters" : "UTF-8 bytes";
  const check = (value: unknown) =>
    typeof value !== "string" || size(value) <= limit;
  TEXT_LIMIT_CHECKS.add(check);
  return Type.Refine(
    schema as unknown as TSchema,
    check,
    () => `Expected at most ${limit} ${words}`,
  ) as unknown as Schema;
}

type Refinement = Readonly<{ check: (value: unknown) => boolean }>;

/**
 * True when each `textLimit` check of `schema` holds for `value`. It reads
 * no other keyword: it is for a value that a decoder checks, such as the
 * input of a decode-only agent tool, which TypeBox does not check. It
 * follows `properties`, `items`, `anyOf` and `oneOf`; in a union it reads
 * the branches whose `type` admits the value.
 */
export function holdsTextLimits(schema: unknown, value: unknown): boolean {
  if (!isRecord(schema)) return true;
  const refinements = schema["~refine"];
  if (
    Array.isArray(refinements) &&
    !(refinements as readonly Refinement[]).every(
      (refinement) =>
        !TEXT_LIMIT_CHECKS.has(refinement.check) || refinement.check(value),
    )
  )
    return false;
  const branches = [schema.anyOf, schema.oneOf].find(Array.isArray);
  if (branches !== undefined) {
    const admitting = (branches as readonly unknown[]).filter((branch) =>
      admits(branch, value),
    );
    if (
      admitting.length > 0 &&
      !admitting.some((branch) => holdsTextLimits(branch, value))
    )
      return false;
  }
  if (Array.isArray(value))
    return value.every((item) => holdsTextLimits(schema.items, item));
  if (isRecord(value) && isRecord(schema.properties)) {
    const properties = schema.properties;
    return Object.keys(value).every((key) =>
      Object.hasOwn(properties, key)
        ? holdsTextLimits(properties[key], value[key])
        : true,
    );
  }
  return true;
}

function admits(branch: unknown, value: unknown): boolean {
  if (!isRecord(branch)) return false;
  const declared = branch.type;
  if (declared === undefined) return true;
  const types = Array.isArray(declared) ? declared : [declared];
  return types.some((type) => jsonTypeHolds(type, value));
}

function jsonTypeHolds(type: unknown, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    default:
      return false;
  }
}

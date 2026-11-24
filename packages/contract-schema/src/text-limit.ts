import { Type, type TSchema } from "typebox";
import { codePointCount, utf8ByteLength } from "@purin-labs/std";

/**
 * What a text limit counts: Unicode code points (Rust `chars().count()`), or
 * UTF-8 bytes (Rust `len()`) where a store or a provider limits bytes.
 */
export type TextLimitUnit = "code_points" | "utf8_bytes";

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
  return Type.Refine(
    schema as unknown as TSchema,
    (value: unknown) => typeof value !== "string" || size(value) <= limit,
    () => `Expected at most ${limit} ${words}`,
  ) as unknown as Schema;
}

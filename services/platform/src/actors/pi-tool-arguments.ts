import { compile, type CoercingValidator } from "@earendil-works/pi-schema";
import { isRecord } from "@seams/std";

const validators = new WeakMap<object, CoercingValidator>();

function validatorFor(schema: object): CoercingValidator {
  let validator = validators.get(schema);
  if (validator === undefined) {
    validator = compile(schema, { coerce: true, unresolvedRefs: "reject" });
    validators.set(schema, validator);
  }
  return validator;
}

/**
 * Pi coerces a model's tool arguments before the check, and some of its rules
 * change the meaning: `2.5` and `"2.5"` become the integer `2`, and `null` for
 * a required string becomes the text `"null"`. A stock count or an ID must not
 * change on the way to its tool, so such a call fails and the model sends it
 * again. The other rules keep the value: `"2"` to `2`, `7` to `"7"`, `"true"`
 * to `true`, a single value to a one-item array, and an optional `null` left
 * out.
 */
export function refuseChangedToolArguments(schema: object, args: unknown) {
  const changed = changedPath(args, validatorFor(schema).coerce(args), "");
  if (changed !== null)
    throw new Error(
      `Tool argument ${changed === "" ? "root" : changed.slice(1)} does not fit its type`,
    );
  return args as never;
}

function changedPath(
  sent: unknown,
  coerced: unknown,
  path: string,
): string | null {
  if (sent === coerced) return null;
  if (Array.isArray(coerced)) {
    if (!Array.isArray(sent)) return changedPath(sent, coerced[0], path);
    for (const [index, item] of sent.entries()) {
      const changed = changedPath(item, coerced[index], `${path}.${index}`);
      if (changed !== null) return changed;
    }
    return null;
  }
  if (isRecord(sent) && isRecord(coerced)) {
    for (const [key, value] of Object.entries(sent)) {
      // Pi leaves out an optional `null`; the check refuses an unknown field.
      if (!(key in coerced)) continue;
      const changed = changedPath(value, coerced[key], `${path}.${key}`);
      if (changed !== null) return changed;
    }
    return null;
  }
  if (sent === null) return coerced === undefined ? null : path;
  if (typeof coerced === "number") {
    if (typeof sent === "number") return path;
    if (typeof sent === "string")
      return sent.trim() !== "" && Number(sent) === coerced ? null : path;
  }
  return null;
}

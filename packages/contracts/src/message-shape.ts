import { hasLoneSurrogate, isRecord } from "@seams/std";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

/**
 * A refusal in the form of the Rust message validators: the code, and the
 * reason text. A contract refusal names the constructor field as its reason,
 * as Rust does; a shape refusal carries a TypeBox message instead of serde's.
 */
export type MessageRejection = Readonly<{
  kind: "validation_rejected";
  code: string;
  reason: string;
  details: null;
}>;

export type MessageParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: MessageRejection }>;

export function messageError(code: string, reason: string): MessageRejection {
  return { kind: "validation_rejected", code, reason, details: null };
}

/** serde: the value has the derived shape, or the request is refused. */
export function parseShape<Schema extends TSchema>(
  schema: Schema,
  input: unknown,
): MessageParseResult<Static<Schema>> {
  if (Value.Check(schema, input))
    return { ok: true, value: input as Static<Schema> };
  const [first] = Value.Errors(schema, input);
  return {
    ok: false,
    error: messageError(
      "invalid_request",
      first === undefined
        ? "value does not match the contract"
        : `${first.instancePath || "/"} ${first.message}`,
    ),
  };
}

/**
 * serde_json refuses a JSON text with an unpaired surrogate escape before any
 * field is read, so every entry point checks the whole value first.
 */
export function admitJson(input: unknown): MessageParseResult<unknown> {
  return containsLoneSurrogate(input)
    ? {
        ok: false,
        error: messageError("invalid_request", "lone surrogate in a string"),
      }
    : { ok: true, value: input };
}

function containsLoneSurrogate(value: unknown): boolean {
  if (typeof value === "string") return hasLoneSurrogate(value);
  if (Array.isArray(value)) return value.some(containsLoneSurrogate);
  if (!isRecord(value)) return false;
  for (const [key, member] of Object.entries(value))
    if (hasLoneSurrogate(key) || containsLoneSurrogate(member)) return true;
  return false;
}

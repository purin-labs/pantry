// TypeBox's `Clean`, `Decode` and `DecodeUnsafe` reorder each union of the
// schema, from the narrowest variant to the broadest, on every call. The
// order depends only on the schema, so these passes keep it for each schema
// and run TypeBox without the repeated sort. On the inventory journey the sort
// took half of Commerce's CPU time, most of it in stock snapshot reads.
import type { StaticDecode, TSchema } from "typebox";
import { Settings } from "typebox/system";
import {
  Check,
  Clean,
  Clone,
  Convert,
  DecodeError,
  DecodeUnsafe,
  Default,
  Errors,
  UnionPrioritySort,
} from "typebox/value";

const sortedSchemas = new WeakMap<TSchema, TSchema>();
/**
 * True while one of these passes runs TypeBox with the sort off. A decode
 * callback can parse another record; that pass sorts its own schema.
 */
let sortOff = false;

function sortedUnions(schema: TSchema): TSchema {
  let sorted = sortedSchemas.get(schema);
  if (sorted === undefined) {
    sorted = UnionPrioritySort(schema);
    sortedSchemas.set(schema, sorted);
  }
  return sorted;
}

/** `Value.Clean(schema, value)`; the value is changed in place. */
export function cleanValue(schema: TSchema, value: unknown): unknown {
  if (sortOff) return Clean(sortedUnions(schema), value);
  if (!Settings.Get().unionPrioritySort) return Clean(schema, value);
  sortOff = true;
  Settings.Set({ unionPrioritySort: false });
  try {
    return Clean(sortedUnions(schema), value);
  } finally {
    Settings.Set({ unionPrioritySort: true });
    sortOff = false;
  }
}

/** `DecodeUnsafe({}, schema, value)`: the decode callbacks only. */
export function decodeValue(schema: TSchema, value: unknown): unknown {
  if (sortOff) return DecodeUnsafe({}, sortedUnions(schema), value);
  if (!Settings.Get().unionPrioritySort) return DecodeUnsafe({}, schema, value);
  sortOff = true;
  Settings.Set({ unionPrioritySort: false });
  try {
    return DecodeUnsafe({}, sortedUnions(schema), value);
  } finally {
    Settings.Set({ unionPrioritySort: true });
    sortOff = false;
  }
}

/** `Value.Decode(schema, value)`: default, convert, clean, check, decode. */
export function decodeChecked<T extends TSchema>(
  schema: T,
  value: unknown,
): StaticDecode<T> {
  const cleaned = cleanValue(
    schema,
    Convert(schema, Default(schema, Clone(value))),
  );
  if (!Check(schema, cleaned))
    throw new DecodeError(cleaned, Errors(schema, cleaned));
  return decodeValue(schema, cleaned) as StaticDecode<T>;
}

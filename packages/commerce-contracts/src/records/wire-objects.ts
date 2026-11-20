// Builders for the Commerce HTTP wire records that the client reads (Plan 78
// step 2). The client types use `Readonly<{ … }>` and `readonly T[]`, so the
// schemas mark each property readonly and each array immutable.
import {
  Type,
  type Static,
  type TArray,
  type TImmutable,
  type TProperties,
  type TSchema,
} from "typebox";
import { Settings } from "typebox/system";
import {
  OpenObject,
  StrictObject,
  recordParser,
  type ContractDecodeResult,
} from "@purin-labs/contract-schema";

type ReadonlyProperties<Properties extends TProperties> = {
  [Key in keyof Properties]: ReturnType<typeof Type.Readonly<Properties[Key]>>;
};

const readonlyMarker = Object.getOwnPropertyDescriptor(
  Type.Readonly(Type.Never()),
  "~readonly",
)!;
const immutableMarker = Object.getOwnPropertyDescriptor(
  Type.Immutable(Type.Never()),
  "~immutable",
)!;

function readonlyProperties<Properties extends TProperties>(
  properties: Properties,
): ReadonlyProperties<Properties> {
  const result: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(properties)) {
    // Wire schemas share their unchanged children. Preserve TypeBox's hidden
    // metadata and codecs without copying the whole schema tree per field.
    const descriptors = Object.getOwnPropertyDescriptors(value);
    descriptors["~readonly"] = {
      ...readonlyMarker,
      enumerable: Settings.Get().enumerableKind,
    };
    const schema = Object.defineProperties({}, descriptors);
    result[key] = Settings.Get().immutableTypes
      ? Object.freeze(schema)
      : schema;
  }
  return result as ReadonlyProperties<Properties>;
}

/** `Readonly<{ … }>` with exact keys (`requireExactObjectKeys`). */
export function ReadonlyStrictObject<Properties extends TProperties>(
  properties: Properties,
) {
  return StrictObject(readonlyProperties(properties));
}

/** `Readonly<{ … }>` whose reader keeps its own fields and drops the rest. */
export function ReadonlyOpenObject<Properties extends TProperties>(
  properties: Properties,
) {
  return OpenObject(readonlyProperties(properties));
}

/** `readonly T[]`. */
export function ImmutableArray<Item extends TSchema>(
  item: Item,
  options: Readonly<{
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    default?: readonly never[];
  }> = {},
) {
  const descriptors = Object.getOwnPropertyDescriptors(
    Type.Array(item, options),
  );
  descriptors["~immutable"] = {
    ...immutableMarker,
    enumerable: Settings.Get().enumerableKind,
  };
  const schema = Object.defineProperties({}, descriptors) as TImmutable<
    TArray<Item>
  >;
  return Settings.Get().immutableTypes ? Object.freeze(schema) : schema;
}

/** A field that a variant leaves out (`field?: never`). */
export const Absent = Type.Optional(Type.Never());

/**
 * The parser of a wire record: the record parser, which fills each missing
 * field that has a default, refuses what the schema refuses, and returns a
 * copy with only the record's own fields, decoded by its codecs.
 */
export function wireRecordParser<T extends TSchema>(
  schema: T,
): (input: unknown) => ContractDecodeResult<Static<T>> {
  return recordParser(schema);
}

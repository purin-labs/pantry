// The default and clean passes of the record parsers (Plan 78 step 2).
// TypeBox's `Value.Default` and `Value.Clean` try each union variant on a
// fresh clone and evaluate each intersection on every call, which costs tens
// of milliseconds on a merchant snapshot. These passes do the same work for
// the record shapes: objects, arrays, unions and intersections of objects.
// Other shapes go to TypeBox.
import { IsArray, IsIntersect, IsObject, IsUnion, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { cleanValue } from "./sorted-unions.ts";

type Schema = TSchema & Readonly<Record<string, unknown>>;

/**
 * Fill each missing field that has a default, as `Value.Default` does. Only
 * the parts of the schema that hold a `default` are visited. The value is
 * changed in place; pass a copy.
 */
export function fillRecordDefaults(schema: TSchema, value: unknown): unknown {
  const node = schema as Schema;
  if (!holdsDefault(node)) return value;
  if (value === undefined && "default" in node)
    return Value.Clone(node.default);
  if (IsObject(node)) {
    if (!isPlainObject(value)) return value;
    for (const [key, property] of Object.entries(objectProperties(node))) {
      const filled = fillRecordDefaults(property, value[key]);
      if (filled !== undefined) value[key] = filled;
    }
    return value;
  }
  if (IsArray(node)) {
    if (!Array.isArray(value)) return value;
    for (let index = 0; index < value.length; index++)
      value[index] = fillRecordDefaults(node.items, value[index]);
    return value;
  }
  if (IsUnion(node)) {
    // As in TypeBox: the first variant that checks once it is filled.
    for (const variant of node.anyOf) {
      const filled = fillRecordDefaults(variant, Value.Clone(value));
      if (Value.Check(variant, filled)) return filled;
    }
    return value;
  }
  return Value.Default(schema, value);
}

/**
 * Keep only the fields that the schema names, as `Value.Clean` does, for a
 * value that already passed `Value.Check`. A union keeps the first variant
 * that checks the value. The value is changed in place.
 */
export function cleanCheckedRecord(schema: TSchema, value: unknown): unknown {
  const node = schema as Schema;
  if (IsObject(node) && isSchemaValue(node.additionalProperties))
    return cleanValue(schema, value);
  if (IsObject(node) || isObjectIntersection(node)) {
    if (!isPlainObject(value)) return value;
    const properties = objectProperties(node);
    for (const key of Object.keys(value)) {
      const property = properties[key];
      if (property === undefined) delete value[key];
      else value[key] = cleanCheckedRecord(property, value[key]);
    }
    return value;
  }
  if (IsArray(node)) {
    if (!Array.isArray(value)) return value;
    for (let index = 0; index < value.length; index++)
      value[index] = cleanCheckedRecord(node.items, value[index]);
    return value;
  }
  if (IsUnion(node)) {
    const variant = checkedVariant(node, value);
    return variant === undefined ? value : cleanCheckedRecord(variant, value);
  }
  return cleanValue(schema, value);
}

/**
 * The variant that a checked value matched. A union whose variants each fix a
 * different literal in one field, such as `kind` or `state`, is read by that
 * field; any other union checks each variant in turn.
 */
function checkedVariant(union: Schema, value: unknown): TSchema | undefined {
  const variants = union.anyOf as TSchema[];
  const tag = unionTag(union);
  if (tag !== undefined && isPlainObject(value)) {
    const variant = tag.variants.get(value[tag.field]);
    if (variant !== undefined) return variant;
  }
  return variants.find(checks.bind(undefined, value));
}

function checks(value: unknown, variant: TSchema): boolean {
  return Value.Check(variant, value);
}

type UnionTag = Readonly<{ field: string; variants: Map<unknown, TSchema> }>;

const unionTags = new WeakMap<object, UnionTag | null>();

function unionTag(union: Schema): UnionTag | undefined {
  let tag = unionTags.get(union);
  if (tag === undefined) {
    tag = findUnionTag(union.anyOf as Schema[]) ?? null;
    unionTags.set(union, tag);
  }
  return tag ?? undefined;
}

function findUnionTag(variants: readonly Schema[]): UnionTag | undefined {
  if (!variants.every(isTaggable)) return undefined;
  for (const field of Object.keys(objectProperties(variants[0]!))) {
    const tagged = new Map<unknown, TSchema>();
    for (const variant of variants) {
      const property = objectProperties(variant)[field] as Schema | undefined;
      if (property === undefined || !("const" in property)) break;
      if (tagged.has(property.const)) break;
      tagged.set(property.const, variant);
    }
    if (tagged.size === variants.length) return { field, variants: tagged };
  }
  return undefined;
}

function isTaggable(schema: Schema): boolean {
  return IsObject(schema) || isObjectIntersection(schema);
}

/** Whether some part of the schema holds a `default`. */
export function recordHoldsDefault(schema: TSchema): boolean {
  return holdsDefault(schema as Schema);
}

const defaultHolders = new WeakMap<object, boolean>();

function holdsDefault(schema: Schema): boolean {
  let holds = defaultHolders.get(schema);
  if (holds === undefined) {
    holds = "default" in schema || children(schema).some(holdsDefault);
    defaultHolders.set(schema, holds);
  }
  return holds;
}

function children(schema: Schema): Schema[] {
  if (IsObject(schema)) return Object.values(schema.properties) as Schema[];
  if (IsArray(schema)) return [schema.items as Schema];
  if (IsUnion(schema)) return schema.anyOf as Schema[];
  if (IsIntersect(schema)) return schema.allOf as Schema[];
  return [];
}

const intersectionProperties = new WeakMap<
  object,
  Readonly<Record<string, TSchema>>
>();

/**
 * The fields of an object, or of an intersection of objects that allows
 * other fields. An intersection that refuses other fields goes to TypeBox.
 */
function objectProperties(schema: Schema): Readonly<Record<string, TSchema>> {
  if (IsObject(schema)) return schema.properties;
  let properties = intersectionProperties.get(schema);
  if (properties === undefined) {
    properties = Object.assign(
      {},
      ...(schema.allOf as Schema[]).map(objectProperties),
    ) as Record<string, TSchema>;
    intersectionProperties.set(schema, properties);
  }
  return properties;
}

function isObjectIntersection(schema: Schema): boolean {
  return (
    IsIntersect(schema) &&
    !("unevaluatedProperties" in schema) &&
    (schema.allOf as Schema[]).every(isOpenObjectPart)
  );
}

function isOpenObjectPart(schema: Schema): boolean {
  return (
    (IsObject(schema) && !("additionalProperties" in schema)) ||
    isObjectIntersection(schema)
  );
}

function isSchemaValue(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import {
  systemEntityTypeIdSchema,
  queryIdentitySchema,
  identityRefusal,
  invalidShape,
} from "./query-parts.ts";
import {
  OpenObject,
  parseContract,
  type ContractDecodeResult,
  NonNegativeInteger as revisionWire,
} from "./schema.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { type StrictUnion } from "@seams/type-utils";
import { revisionSchema } from "./entity-record.ts";

import { cursorRefusal } from "./cursor-values.ts";

const extensionRevision = revisionSchema<"MerchantExtensionSchemaRevision">();
const systemRevision = revisionSchema<"SystemSchemaRevision">();
const typeRevision = revisionSchema<"CustomEntityTypeRevision">();
const typeId = queryIdentitySchema<"CustomCommerceEntityTypeId">();
export const systemEntityExtensionSchema = Type.Union([
  OpenObject({ state: Type.Literal("absent") }),
  OpenObject({
    state: Type.Literal("published"),
    revision: extensionRevision,
  }),
]);
export type SystemEntityExtension = StrictUnion<
  Static<typeof systemEntityExtensionSchema>
>;
export const systemEntityTypeSchema = OpenObject({
  origin: Type.Literal("system"),
  typeId: systemEntityTypeIdSchema.properties.typeId,
  lexiconSchemaRevision: systemRevision,
  merchantExtension: Type.Unsafe<SystemEntityExtension>(
    systemEntityExtensionSchema,
  ),
});
export const customEntityTypeSchema = OpenObject({
  origin: Type.Literal("custom"),
  typeId,
  publishedRevision: typeRevision,
});
export const commerceEntityTypeSchema = Type.Union([
  systemEntityTypeSchema,
  customEntityTypeSchema,
]);
export type CommerceEntityType = StrictUnion<
  Static<typeof commerceEntityTypeSchema>
>;

const extensionWire = Type.Union([
  OpenObject({ state: Type.Literal("absent") }),
  OpenObject({ state: Type.Literal("published"), revision: revisionWire }),
]);
const typeWire = Type.Union([
  OpenObject({
    origin: Type.Literal("system"),
    typeId: systemEntityTypeSchema.properties.typeId,
    lexiconSchemaRevision: revisionWire,
    merchantExtension: extensionWire,
  }),
  OpenObject({
    origin: Type.Literal("custom"),
    typeId: Type.String(),
    publishedRevision: revisionWire,
  }),
]);
export function parseSystemEntityExtension(
  input: unknown,
): ContractDecodeResult<SystemEntityExtension> {
  const parsed = parseContract(extensionWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  if (parsed.value.state === "absent")
    return { ok: true, value: { state: "absent" } };
  const revision = parsed.value.revision;
  if (!Value.Check(extensionRevision, revision))
    return invalidRevision("MerchantExtensionSchemaRevision");
  return { ok: true, value: { state: "published", revision } };
}
export function parseCommerceEntityType(
  input: unknown,
): ContractDecodeResult<CommerceEntityType> {
  const parsed = parseContract(typeWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const entityType = parsed.value;
  if (entityType.origin === "system") {
    const lexiconSchemaRevision = entityType.lexiconSchemaRevision;
    if (!Value.Check(systemRevision, lexiconSchemaRevision))
      return invalidRevision("SystemSchemaRevision");
    const merchantExtension = parseSystemEntityExtension(
      entityType.merchantExtension,
    );
    if (!merchantExtension.ok) return merchantExtension;
    return {
      ok: true,
      value: {
        origin: "system",
        typeId: entityType.typeId,
        lexiconSchemaRevision,
        merchantExtension: merchantExtension.value,
      },
    };
  }
  const id = entityType.typeId;
  if (!Value.Check(typeId, id))
    return identityRefusal("CustomCommerceEntityTypeId");
  const publishedRevision = entityType.publishedRevision;
  if (!Value.Check(typeRevision, publishedRevision))
    return invalidRevision("CustomEntityTypeRevision");
  return {
    ok: true,
    value: { origin: "custom", typeId: id, publishedRevision },
  };
}
function invalidRevision(field: string): ContractDecodeResult<never> {
  return cursorRefusal("invalid_revision", { field });
}

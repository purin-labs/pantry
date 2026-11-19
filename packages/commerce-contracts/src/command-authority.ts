import {
  authorityValidationRequestSchema as envelope,
  invalidAuthorityRequest as invalidRequest,
} from "./command-authorization-input.ts";
import {
  customEntityRefWireSchema,
  commerceEntityRefWireSchema,
  commerceEntityTypeWireSchema,
} from "./query-wire.ts";
import {
  commerceListEntryAuthorityScopeWireSchema,
  commerceListAuthorityScopeSchema,
  commerceListEntryAuthorityScopeSchema,
  savedViewAuthorityScopeSchema,
  commerceAuthorityScopeWireSchema,
  commerceListEntryRefSchema,
  parseCommerceListEntryRef,
} from "./authority-scope.ts";
import {
  systemEntityTypeIdSchema,
  customEntityTypeIdSchema,
  commerceEntityTypeIdSchema,
  queryIdentitySchema,
  invalidShape,
  identityRefusal,
  parseCommerceEntityTypeId,
} from "./query-parts.ts";
import {
  OpenObject,
  StrictObject,
  parseContract,
  type ContractDecodeResult,
  NonNegativeInteger as revision,
} from "./schema.ts";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { cleanValue } from "./sorted-unions.ts";
import {
  assertNever,
  canonicalJsonByCodePoint,
  isRecord,
} from "@purin-labs/std";
import { type StrictUnion } from "@purin-labs/type-utils";
import {
  commerceCommandAuthorityContextSchema,
  commerceAuthorityContextWireSchema,
  parseCommerceAuthorityContext,
  relationshipAuthoritySchema,
  parseRelationshipAuthority,
} from "./relationship-authority.ts";

import {
  commerceEntityReadAuthoritySchema,
  parseCommerceEntityReadAuthority,
} from "./read-authority.ts";
import {
  commerceEntityRefSchema,
  customCommerceEntityRefSchema,
  parseCommerceEntityRef,
} from "./entity-reference.ts";

import { revisionSchema } from "./entity-record.ts";
import { trimmedIdentityTextSchema } from "./identity-text.ts";

import { cursorRefusal } from "./cursor-values.ts";

const typeId = queryIdentitySchema<"CustomCommerceEntityTypeId">();
const listId = queryIdentitySchema<"CommerceListId">();
const viewId = queryIdentitySchema<"SavedCommerceViewId">();
const systemKind = systemEntityTypeIdSchema.properties.typeId;
export const authorityTargetSchemas = {
  entity_command: OpenObject({
    entityRef: customCommerceEntityRefSchema,
    expectedRevision: revisionSchema<"CommerceEntityRevision">(),
  }),
  entity_create: OpenObject({
    entityId: queryIdentitySchema<"CustomCommerceEntityId">(),
    typeId,
  }),
  custom_entity_type_create: StrictObject({ typeId }),
  custom_entity_type_publish: StrictObject({
    typeId,
    revision: revisionSchema<"CustomEntityTypeRevision">(),
  }),
  system_entity_extension_schema_create: StrictObject({
    entityTypeId: systemKind,
  }),
  system_entity_extension_schema_publish: StrictObject({
    entityTypeId: systemKind,
    revision: revisionSchema<"MerchantExtensionSchemaRevision">(),
  }),
  commerce_list_command: OpenObject({
    listId,
    expectedRevision: revisionSchema<"CommerceListRevision">(),
  }),
  commerce_list_create: OpenObject({
    listId,
    entityTypeId: commerceEntityTypeIdSchema,
  }),
  commerce_list_entry_command: OpenObject({
    entry: commerceListEntryRefSchema,
    expectedRevision: revisionSchema<"CommerceListEntryRevision">(),
  }),
  commerce_list_entry_create: OpenObject({
    entry: commerceListEntryRefSchema,
    listRevision: revisionSchema<"CommerceListRevision">(),
    entityTypeId: commerceEntityTypeIdSchema,
    entityRef: commerceEntityRefSchema,
  }),
  saved_view_administration: OpenObject({
    viewId,
    expectedRevision: revisionSchema<"SavedCommerceViewRevision">(),
  }),
  saved_view_create: OpenObject({ viewId }),
};

const rawEntry = commerceListEntryAuthorityScopeWireSchema.properties.entry;
export const authorityTargetWireSchemas = {
  entity_command: OpenObject({
    entityRef: customEntityRefWireSchema,
    expectedRevision: revision,
  }),
  entity_create: OpenObject({
    entityId: Type.String(),
    typeId: Type.String(),
  }),
  custom_entity_type_create: StrictObject({ typeId: Type.String() }),
  custom_entity_type_publish: StrictObject({ typeId: Type.String(), revision }),
  system_entity_extension_schema_create: StrictObject({
    entityTypeId: systemKind,
  }),
  system_entity_extension_schema_publish: StrictObject({
    entityTypeId: systemKind,
    revision,
  }),
  commerce_list_command: OpenObject({
    listId: Type.String(),
    expectedRevision: revision,
  }),
  commerce_list_create: OpenObject({
    listId: Type.String(),
    entityTypeId: commerceEntityTypeWireSchema,
  }),
  commerce_list_entry_command: OpenObject({
    entry: rawEntry,
    expectedRevision: revision,
  }),
  commerce_list_entry_create: OpenObject({
    entry: rawEntry,
    listRevision: revision,
    entityTypeId: commerceEntityTypeWireSchema,
    entityRef: commerceEntityRefWireSchema,
  }),
  saved_view_administration: OpenObject({
    viewId: Type.String(),
    expectedRevision: revision,
  }),
  saved_view_create: OpenObject({ viewId: Type.String() }),
};
const entityScopeSchema = OpenObject({
  kind: Type.Literal("entity"),
  entityRef: customCommerceEntityRefSchema,
});
const customTypeScopeSchema = OpenObject({
  kind: Type.Literal("entity_type"),
  entityTypeId: customEntityTypeIdSchema,
});
const systemTypeScopeSchema = OpenObject({
  kind: Type.Literal("entity_type"),
  entityTypeId: systemEntityTypeIdSchema,
});
function authoritySchema<
  Kind extends string,
  Target extends TSchema,
  Scope extends TSchema,
>(kind: Kind, target: Target, scope: Scope) {
  return OpenObject({
    kind: Type.Literal(kind),
    context: commerceCommandAuthorityContextSchema,
    scope,
    target,
  });
}
function authorityWire<Kind extends string, Target extends TSchema>(
  kind: Kind,
  target: Target,
) {
  return OpenObject({
    kind: Type.Literal(kind),
    context: commerceAuthorityContextWireSchema,
    scope: commerceAuthorityScopeWireSchema,
    target,
  });
}
const remainingAuthoritiesSchema = Type.Union([
  authoritySchema(
    "entity_command",
    authorityTargetSchemas.entity_command,
    entityScopeSchema,
  ),
  authoritySchema(
    "entity_create",
    authorityTargetSchemas.entity_create,
    customTypeScopeSchema,
  ),
  authoritySchema(
    "custom_entity_type_create",
    authorityTargetSchemas.custom_entity_type_create,
    customTypeScopeSchema,
  ),
  authoritySchema(
    "custom_entity_type_publish",
    authorityTargetSchemas.custom_entity_type_publish,
    customTypeScopeSchema,
  ),
  authoritySchema(
    "system_entity_extension_schema_create",
    authorityTargetSchemas.system_entity_extension_schema_create,
    systemTypeScopeSchema,
  ),
  authoritySchema(
    "system_entity_extension_schema_publish",
    authorityTargetSchemas.system_entity_extension_schema_publish,
    systemTypeScopeSchema,
  ),
  authoritySchema(
    "commerce_list_command",
    authorityTargetSchemas.commerce_list_command,
    commerceListAuthorityScopeSchema,
  ),
  authoritySchema(
    "commerce_list_create",
    authorityTargetSchemas.commerce_list_create,
    commerceListAuthorityScopeSchema,
  ),
  authoritySchema(
    "commerce_list_entry_command",
    authorityTargetSchemas.commerce_list_entry_command,
    commerceListEntryAuthorityScopeSchema,
  ),
  authoritySchema(
    "commerce_list_entry_create",
    authorityTargetSchemas.commerce_list_entry_create,
    commerceListAuthorityScopeSchema,
  ),
  authoritySchema(
    "saved_view_administration",
    authorityTargetSchemas.saved_view_administration,
    savedViewAuthorityScopeSchema,
  ),
  authoritySchema(
    "saved_view_create",
    authorityTargetSchemas.saved_view_create,
    savedViewAuthorityScopeSchema,
  ),
]);
const remainingWire = Type.Union([
  authorityWire("entity_command", authorityTargetWireSchemas.entity_command),
  authorityWire("entity_create", authorityTargetWireSchemas.entity_create),
  authorityWire(
    "custom_entity_type_create",
    authorityTargetWireSchemas.custom_entity_type_create,
  ),
  authorityWire(
    "custom_entity_type_publish",
    authorityTargetWireSchemas.custom_entity_type_publish,
  ),
  authorityWire(
    "system_entity_extension_schema_create",
    authorityTargetWireSchemas.system_entity_extension_schema_create,
  ),
  authorityWire(
    "system_entity_extension_schema_publish",
    authorityTargetWireSchemas.system_entity_extension_schema_publish,
  ),
  authorityWire(
    "commerce_list_command",
    authorityTargetWireSchemas.commerce_list_command,
  ),
  authorityWire(
    "commerce_list_create",
    authorityTargetWireSchemas.commerce_list_create,
  ),
  authorityWire(
    "commerce_list_entry_command",
    authorityTargetWireSchemas.commerce_list_entry_command,
  ),
  authorityWire(
    "commerce_list_entry_create",
    authorityTargetWireSchemas.commerce_list_entry_create,
  ),
  authorityWire(
    "saved_view_administration",
    authorityTargetWireSchemas.saved_view_administration,
  ),
  authorityWire(
    "saved_view_create",
    authorityTargetWireSchemas.saved_view_create,
  ),
]);
export const commerceEntityAuthoritySchema = Type.Union([
  commerceEntityReadAuthoritySchema,
  ...relationshipAuthoritySchema.anyOf,
  ...remainingAuthoritiesSchema.anyOf,
]);
export type CommerceEntityAuthority = StrictUnion<
  Static<typeof commerceEntityAuthoritySchema>
>;

export function parseCommerceEntityAuthority(
  input: unknown,
): ContractDecodeResult<CommerceEntityAuthority> {
  const request = parseContract(envelope, input, invalidRequest);
  if (!request.ok) return request;
  const value = request.value.authority;
  if (!isRecord(value)) return cursorRefusal("parse");
  switch (value.kind) {
    case "entity_read":
      return parseCommerceEntityReadAuthority(request.value);
    case "custom_relationship_definition_create":
    case "custom_relationship_definition_publish":
    case "relationship_create":
    case "relationship_command":
    case "relationship_replacement":
      return parseRelationshipAuthority(request.value);
  }
  const parsed = parseContract(remainingWire, value, invalidShape);
  if (!parsed.ok) return parsed;
  const authority = parsed.value;
  const context = parseCommerceAuthorityContext(
    authority.context,
    request.value.now,
  );
  if (!context.ok) return context;
  if (context.value.causation.kind !== "command")
    return cursorRefusal("missing_authority_field", {
      field: "causation.command_id",
    });
  const target = validateTarget(authority);
  if (!target.ok) return target;
  if (!scopeMatches(authority)) return cursorRefusal("authority_out_of_scope");
  const schema = remainingAuthoritiesSchema.anyOf.find(
    authoritySchemaMatches.bind(null, authority.kind),
  );
  if (schema === undefined) throw new Error("Authority schema is missing");
  return parseContract(
    schema,
    cleanValue(schema, Value.Clone(authority)),
    invalidShape,
  );
}
type RemainingAuthority = Static<typeof remainingWire>;
function authoritySchemaMatches(
  kind: RemainingAuthority["kind"],
  schema: (typeof remainingAuthoritiesSchema.anyOf)[number],
): boolean {
  return schema.properties.kind.const === kind;
}
function validIdentity(
  value: string,
  field: string,
): ContractDecodeResult<null> {
  return Value.Check(trimmedIdentityTextSchema, value)
    ? { ok: true, value: null }
    : identityRefusal(field);
}
function validRevision(
  value: number,
  field: string,
): ContractDecodeResult<null> {
  return value > 0
    ? { ok: true, value: null }
    : cursorRefusal("invalid_revision", { field });
}
function validateTarget(
  authority: RemainingAuthority,
): ContractDecodeResult<unknown> {
  switch (authority.kind) {
    case "entity_command": {
      const reference = parseCommerceEntityRef(authority.target.entityRef);
      if (!reference.ok) return reference;
      return validRevision(
        authority.target.expectedRevision,
        "CommerceEntityRevision",
      );
    }
    case "entity_create": {
      const entity = validIdentity(
        authority.target.entityId,
        "CustomCommerceEntityId",
      );
      if (!entity.ok) return entity;
      return validIdentity(
        authority.target.typeId,
        "CustomCommerceEntityTypeId",
      );
    }
    case "custom_entity_type_create":
      return validIdentity(
        authority.target.typeId,
        "CustomCommerceEntityTypeId",
      );
    case "custom_entity_type_publish": {
      const id = validIdentity(
        authority.target.typeId,
        "CustomCommerceEntityTypeId",
      );
      if (!id.ok) return id;
      return validRevision(
        authority.target.revision,
        "CustomEntityTypeRevision",
      );
    }
    case "system_entity_extension_schema_create":
      return { ok: true, value: null };
    case "system_entity_extension_schema_publish":
      return validRevision(
        authority.target.revision,
        "MerchantExtensionSchemaRevision",
      );
    case "commerce_list_command": {
      const id = validIdentity(authority.target.listId, "CommerceListId");
      if (!id.ok) return id;
      return validRevision(
        authority.target.expectedRevision,
        "CommerceListRevision",
      );
    }
    case "commerce_list_create": {
      const id = validIdentity(authority.target.listId, "CommerceListId");
      if (!id.ok) return id;
      return parseCommerceEntityTypeId(authority.target.entityTypeId);
    }
    case "commerce_list_entry_command":
      return parseCommerceListEntryCommandTarget(authority.target);
    case "commerce_list_entry_create": {
      const entry = parseCommerceListEntryRef(authority.target.entry);
      if (!entry.ok) return entry;
      const revision = validRevision(
        authority.target.listRevision,
        "CommerceListRevision",
      );
      if (!revision.ok) return revision;
      const type = parseCommerceEntityTypeId(authority.target.entityTypeId);
      if (!type.ok) return type;
      const reference = parseCommerceEntityRef(authority.target.entityRef);
      if (!reference.ok) return reference;
      if (
        type.value.origin !== reference.value.origin ||
        type.value.typeId !== reference.value.typeId
      )
        return cursorRefusal("invalid_list_entry_entity_type");
      return { ok: true, value: null };
    }
    case "saved_view_administration":
      return parseSavedCommerceViewCommandTarget(authority.target);
    case "saved_view_create":
      return validIdentity(authority.target.viewId, "SavedCommerceViewId");
    default:
      return assertNever(authority);
  }
}

export function parseCommerceListEntryCommandTarget(
  input: unknown,
): ContractDecodeResult<CommerceListEntryCommandTarget> {
  const parsed = parseContract(
    authorityTargetWireSchemas.commerce_list_entry_command,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const entry = parseCommerceListEntryRef(parsed.value.entry);
  if (!entry.ok) return entry;
  const expectedRevision = parsed.value.expectedRevision;
  if (
    !Value.Check(
      authorityTargetSchemas.commerce_list_entry_command.properties
        .expectedRevision,
      expectedRevision,
    )
  )
    return cursorRefusal("invalid_revision", {
      field: "CommerceListEntryRevision",
    });
  if (expectedRevision !== entry.value.revision)
    return cursorRefusal("revision_conflict", {
      expected: expectedRevision,
      received: entry.value.revision,
    });
  return { ok: true, value: { entry: entry.value, expectedRevision } };
}

export function parseSavedCommerceViewCommandTarget(
  input: unknown,
): ContractDecodeResult<SavedCommerceViewCommandTarget> {
  const parsed = parseContract(
    authorityTargetWireSchemas.saved_view_administration,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const viewId = parsed.value.viewId;
  if (
    !Value.Check(
      authorityTargetSchemas.saved_view_administration.properties.viewId,
      viewId,
    )
  )
    return identityRefusal("SavedCommerceViewId");
  const expectedRevision = parsed.value.expectedRevision;
  if (
    !Value.Check(
      authorityTargetSchemas.saved_view_administration.properties
        .expectedRevision,
      expectedRevision,
    )
  )
    return cursorRefusal("invalid_revision", {
      field: "SavedCommerceViewRevision",
    });
  return { ok: true, value: { viewId, expectedRevision } };
}
function scopeMatches(authority: RemainingAuthority): boolean {
  const scope = authority.scope;
  switch (authority.kind) {
    case "entity_command":
      return (
        scope.kind === "entity" &&
        sameRaw(
          scope.entityRef,
          authority.target.entityRef,
          commerceEntityRefWireSchema,
        )
      );
    case "entity_create":
    case "custom_entity_type_create":
    case "custom_entity_type_publish":
      return (
        scope.kind === "entity_type" &&
        scope.entityTypeId.origin === "custom" &&
        scope.entityTypeId.typeId === authority.target.typeId
      );
    case "system_entity_extension_schema_create":
    case "system_entity_extension_schema_publish":
      return (
        scope.kind === "entity_type" &&
        scope.entityTypeId.origin === "system" &&
        scope.entityTypeId.typeId === authority.target.entityTypeId
      );
    case "commerce_list_command":
    case "commerce_list_create":
      return (
        scope.kind === "commerce_list" &&
        scope.listId === authority.target.listId
      );
    case "commerce_list_entry_command":
      return (
        scope.kind === "commerce_list_entry" &&
        sameRaw(scope.entry, authority.target.entry, rawEntry)
      );
    case "commerce_list_entry_create":
      return (
        scope.kind === "commerce_list" &&
        scope.listId === authority.target.entry.listId
      );
    case "saved_view_administration":
    case "saved_view_create":
      return (
        scope.kind === "saved_view" && scope.viewId === authority.target.viewId
      );
    default:
      return assertNever(authority);
  }
}
function sameRaw(left: unknown, right: unknown, schema: TSchema): boolean {
  return (
    canonicalJsonByCodePoint(cleanValue(schema, Value.Clone(left))) ===
    canonicalJsonByCodePoint(cleanValue(schema, Value.Clone(right)))
  );
}

export type CommerceEntityCommandTarget = Static<
  typeof authorityTargetSchemas.entity_command
>;

export type CustomCommerceEntityCreateTarget = Static<
  typeof authorityTargetSchemas.entity_create
>;

export type CustomCommerceEntityTypeCreateTarget = Static<
  typeof authorityTargetSchemas.custom_entity_type_create
>;

export type CustomCommerceEntityTypeCommandTarget = Static<
  typeof authorityTargetSchemas.custom_entity_type_publish
>;

export type SystemEntityExtensionSchemaCreateTarget = Static<
  typeof authorityTargetSchemas.system_entity_extension_schema_create
>;

export type SystemEntityExtensionSchemaCommandTarget = Static<
  typeof authorityTargetSchemas.system_entity_extension_schema_publish
>;

export type CommerceListCommandTarget = Static<
  typeof authorityTargetSchemas.commerce_list_command
>;

export type CommerceListCreateTarget = Static<
  typeof authorityTargetSchemas.commerce_list_create
>;

export type CommerceListEntryCommandTarget = Static<
  typeof authorityTargetSchemas.commerce_list_entry_command
>;

export type CommerceListEntryCreateTarget = Static<
  typeof authorityTargetSchemas.commerce_list_entry_create
>;

export type SavedCommerceViewCommandTarget = Static<
  typeof authorityTargetSchemas.saved_view_administration
>;

export type SavedCommerceViewCreateTarget = Static<
  typeof authorityTargetSchemas.saved_view_create
>;

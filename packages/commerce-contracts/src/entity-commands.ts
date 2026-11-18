import { customEntityRefWireSchema } from "./query-wire.ts";
import {
  StrictObject,
  OpenObject,
  parseContract,
  type ContractDecodeResult,
  NonNegativeInteger as revision,
} from "./schema.ts";
import { Type, type Static, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import { assertNever } from "@seams/std";
import { type StrictUnion } from "@seams/type-utils";
import { authorityTargetSchemas } from "./command-authority.ts";
import {
  attributeDefinitionSchema,
  parseAttributeDefinition,
} from "./attribute-definition.ts";
import {
  attributeDefinitionWireSchema,
  attributeAssignmentWireSchema,
  type AttributeAssignmentWire,
} from "./entity-wire.ts";
import {
  attributeValueAssignmentSchema,
  commerceSensitivitySchema,
  revisionSchema,
  parseAssignment,
  type AttributeValueAssignment,
} from "./entity-record.ts";
import {
  customCommerceEntityRefSchema,
  parseCommerceEntityRef,
} from "./entity-reference.ts";

import {
  queryIdentitySchema,
  identityRefusal,
  invalidShape,
} from "./query-parts.ts";
import { trimmedIdentityTextSchema } from "./identity-text.ts";
import { validTimestamp } from "./commerce-timestamp.ts";

import { cursorRefusal } from "./cursor-values.ts";

const entityId = queryIdentitySchema<"CustomCommerceEntityId">();
const typeId = queryIdentitySchema<"CustomCommerceEntityTypeId">();
const typeRevision = revisionSchema<"CustomEntityTypeRevision">();
const entityRevision = revisionSchema<"CommerceEntityRevision">();
const extensionRevision = revisionSchema<"MerchantExtensionSchemaRevision">();
const systemKind =
  authorityTargetSchemas.system_entity_extension_schema_create.properties
    .entityTypeId;

export const customCommerceEntityTypeDraftSchema = StrictObject({
  typeId,
  revision: typeRevision,
  label: Type.String(),
  description: Type.String(),
  attributes: Type.Array(attributeDefinitionSchema),
});
export const systemEntityExtensionSchemaDraftSchema = StrictObject({
  entityTypeId: systemKind,
  schemaRevision: extensionRevision,
  attributes: Type.Array(attributeDefinitionSchema),
});
const customDraftWire = StrictObject({
  typeId: Type.String(),
  revision,
  label: Type.String(),
  description: Type.String(),
  attributes: Type.Array(attributeDefinitionWireSchema),
});
const extensionDraftWire = StrictObject({
  entityTypeId: systemKind,
  schemaRevision: revision,
  attributes: Type.Array(attributeDefinitionWireSchema),
});
const assignments = Type.Unsafe<AttributeValueAssignment[]>(
  Type.Array(attributeValueAssignmentSchema),
);
export const entityLifecycleCommandSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("create_custom_entity_type"),
    command: StrictObject({ draft: customCommerceEntityTypeDraftSchema }),
  }),
  OpenObject({
    kind: Type.Literal("publish_custom_entity_type"),
    command: StrictObject({
      target: authorityTargetSchemas.custom_entity_type_publish,
    }),
  }),
  OpenObject({
    kind: Type.Literal("create_system_entity_extension_schema"),
    command: StrictObject({ draft: systemEntityExtensionSchemaDraftSchema }),
  }),
  OpenObject({
    kind: Type.Literal("publish_system_entity_extension_schema"),
    command: StrictObject({
      target: authorityTargetSchemas.system_entity_extension_schema_publish,
    }),
  }),
  OpenObject({
    kind: Type.Literal("create_custom_entity"),
    command: StrictObject({
      entityId,
      typeId,
      typeRevision,
      displayName: Type.String(),
      attributes: assignments,
      sensitivity: commerceSensitivitySchema,
    }),
  }),
  OpenObject({
    kind: Type.Literal("patch_custom_entity"),
    command: StrictObject({
      entityRef: customCommerceEntityRefSchema,
      typeRevision,
      expectedRevision: entityRevision,
      attributes: assignments,
      displayName: Type.Union([Type.String(), Type.Null()]),
    }),
  }),
  OpenObject({
    kind: Type.Literal("archive_custom_entity"),
    command: OpenObject({
      entityRef: customCommerceEntityRefSchema,
      expectedRevision: entityRevision,
      archivedAt: Type.String(),
    }),
  }),
]);
export type EntityLifecycleCommand = StrictUnion<
  StaticDecode<typeof entityLifecycleCommandSchema>
>;
export type CustomCommerceEntityTypeDraft = Static<
  typeof customCommerceEntityTypeDraftSchema
>;
export type SystemEntityExtensionSchemaDraft = Static<
  typeof systemEntityExtensionSchemaDraftSchema
>;

const commandWire = Type.Union([
  OpenObject({
    kind: Type.Literal("create_custom_entity_type"),
    command: StrictObject({ draft: customDraftWire }),
  }),
  OpenObject({
    kind: Type.Literal("publish_custom_entity_type"),
    command: StrictObject({
      target: StrictObject({ typeId: Type.String(), revision }),
    }),
  }),
  OpenObject({
    kind: Type.Literal("create_system_entity_extension_schema"),
    command: StrictObject({ draft: extensionDraftWire }),
  }),
  OpenObject({
    kind: Type.Literal("publish_system_entity_extension_schema"),
    command: StrictObject({
      target: StrictObject({ entityTypeId: systemKind, revision }),
    }),
  }),
  OpenObject({
    kind: Type.Literal("create_custom_entity"),
    command: StrictObject({
      entityId: Type.String(),
      typeId: Type.String(),
      typeRevision: revision,
      displayName: Type.String(),
      attributes: Type.Array(attributeAssignmentWireSchema),
      sensitivity: commerceSensitivitySchema,
    }),
  }),
  OpenObject({
    kind: Type.Literal("patch_custom_entity"),
    command: StrictObject({
      entityRef: customEntityRefWireSchema,
      typeRevision: revision,
      expectedRevision: revision,
      attributes: Type.Array(attributeAssignmentWireSchema),
      displayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  }),
  OpenObject({
    kind: Type.Literal("archive_custom_entity"),
    command: OpenObject({
      entityRef: customEntityRefWireSchema,
      expectedRevision: revision,
      archivedAt: Type.String(),
    }),
  }),
]);
function invalidRevision(field: string): ContractDecodeResult<never> {
  return cursorRefusal("invalid_revision", { field });
}
function invalidText(field: string): ContractDecodeResult<never> {
  return cursorRefusal("invalid_text", { field });
}
function mismatch(attributeId: string): ContractDecodeResult<never> {
  return cursorRefusal("attribute_definition_mismatch", { attributeId });
}
export function parseCustomCommerceEntityTypeDraft(
  input: unknown,
): ContractDecodeResult<CustomCommerceEntityTypeDraft> {
  const raw = parseContract(customDraftWire, input, invalidShape);
  if (!raw.ok) return raw;
  const draft = raw.value;
  const id = draft.typeId;
  if (!Value.Check(typeId, id))
    return identityRefusal("CustomCommerceEntityTypeId");
  const version = draft.revision;
  if (!Value.Check(typeRevision, version))
    return invalidRevision("CustomEntityTypeRevision");
  if (!Value.Check(trimmedIdentityTextSchema, draft.label))
    return invalidText("custom_entity_type.label");
  if (
    draft.description !== "" &&
    !Value.Check(trimmedIdentityTextSchema, draft.description)
  )
    return invalidText("custom_entity_type.description");
  const attributes = parseDefinitions(draft.attributes);
  if (!attributes.ok) return attributes;
  for (const attribute of attributes.value)
    if (
      attribute.scope.kind !== "custom" ||
      attribute.scope.entityTypeId !== id ||
      attribute.scope.typeRevision !== version
    )
      return mismatch(attribute.id);
  return {
    ok: true,
    value: {
      typeId: id,
      revision: version,
      label: draft.label,
      description: draft.description,
      attributes: attributes.value,
    },
  };
}
export function parseSystemEntityExtensionSchemaDraft(
  input: unknown,
): ContractDecodeResult<SystemEntityExtensionSchemaDraft> {
  const raw = parseContract(extensionDraftWire, input, invalidShape);
  if (!raw.ok) return raw;
  const draft = raw.value;
  const version = draft.schemaRevision;
  if (!Value.Check(extensionRevision, version))
    return invalidRevision("MerchantExtensionSchemaRevision");
  const attributes = parseDefinitions(draft.attributes);
  if (!attributes.ok) return attributes;
  for (const attribute of attributes.value)
    if (
      attribute.scope.kind !== "merchant_extension" ||
      attribute.scope.entityTypeId !== draft.entityTypeId ||
      attribute.scope.schemaRevision !== version
    )
      return mismatch(attribute.id);
  return {
    ok: true,
    value: {
      entityTypeId: draft.entityTypeId,
      schemaRevision: version,
      attributes: attributes.value,
    },
  };
}
function parseDefinitions(
  inputs: unknown[],
): ContractDecodeResult<CustomCommerceEntityTypeDraft["attributes"]> {
  const attributes: CustomCommerceEntityTypeDraft["attributes"] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const parsed = parseAttributeDefinition(input);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value.id)) return cursorRefusal("duplicate_identity");
    seen.add(parsed.value.id);
    attributes.push(parsed.value);
  }
  return { ok: true, value: attributes };
}
function parseCustomAssignments(
  inputs: AttributeAssignmentWire[],
  owner: Static<typeof typeId>,
  version: Static<typeof typeRevision>,
): ContractDecodeResult<AttributeValueAssignment[]> {
  const attributes: AttributeValueAssignment[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const parsed = parseAssignment(input);
    if (!parsed.ok) return parsed;
    const attribute = parsed.value;
    if (seen.has(attribute.attributeId)) return mismatch(attribute.attributeId);
    seen.add(attribute.attributeId);
    if (
      attribute.scope.kind !== "custom" ||
      attribute.scope.entityTypeId !== owner ||
      attribute.scope.typeRevision !== version
    )
      return mismatch(attribute.attributeId);
    attributes.push(attribute);
  }
  return { ok: true, value: attributes };
}
export function parseEntityLifecycleCommand(
  input: unknown,
): ContractDecodeResult<EntityLifecycleCommand> {
  const raw = parseContract(commandWire, input, invalidShape);
  if (!raw.ok) return raw;
  switch (raw.value.kind) {
    case "create_custom_entity_type": {
      const draft = parseCustomCommerceEntityTypeDraft(raw.value.command.draft);
      if (!draft.ok) return draft;
      return {
        ok: true,
        value: { kind: raw.value.kind, command: { draft: draft.value } },
      };
    }
    case "create_system_entity_extension_schema": {
      const draft = parseSystemEntityExtensionSchemaDraft(
        raw.value.command.draft,
      );
      if (!draft.ok) return draft;
      return {
        ok: true,
        value: { kind: raw.value.kind, command: { draft: draft.value } },
      };
    }
    case "publish_custom_entity_type": {
      const target = raw.value.command.target;
      const id = target.typeId;
      if (!Value.Check(typeId, id))
        return identityRefusal("CustomCommerceEntityTypeId");
      const version = target.revision;
      if (!Value.Check(typeRevision, version))
        return invalidRevision("CustomEntityTypeRevision");
      return {
        ok: true,
        value: {
          kind: raw.value.kind,
          command: { target: { typeId: id, revision: version } },
        },
      };
    }
    case "publish_system_entity_extension_schema": {
      const target = raw.value.command.target;
      const version = target.revision;
      if (!Value.Check(extensionRevision, version))
        return invalidRevision("MerchantExtensionSchemaRevision");
      return {
        ok: true,
        value: {
          kind: raw.value.kind,
          command: {
            target: { entityTypeId: target.entityTypeId, revision: version },
          },
        },
      };
    }
    case "create_custom_entity": {
      const command = raw.value.command;
      const id = command.entityId;
      const owner = command.typeId;
      const version = command.typeRevision;
      if (!Value.Check(entityId, id))
        return identityRefusal("CustomCommerceEntityId");
      if (!Value.Check(typeId, owner))
        return identityRefusal("CustomCommerceEntityTypeId");
      if (!Value.Check(typeRevision, version))
        return invalidRevision("CustomEntityTypeRevision");
      if (!Value.Check(trimmedIdentityTextSchema, command.displayName))
        return invalidText("create_custom_entity.display_name");
      const attributes = parseCustomAssignments(
        command.attributes,
        owner,
        version,
      );
      if (!attributes.ok) return attributes;
      return {
        ok: true,
        value: {
          kind: raw.value.kind,
          command: {
            entityId: id,
            typeId: owner,
            typeRevision: version,
            displayName: command.displayName,
            attributes: attributes.value,
            sensitivity: command.sensitivity,
          },
        },
      };
    }
    case "patch_custom_entity": {
      const command = raw.value.command;
      const reference = parseCommerceEntityRef(command.entityRef);
      if (!reference.ok) return reference;
      if (reference.value.origin !== "custom") return cursorRefusal("parse");
      const version = command.typeRevision;
      const expectedRevision = command.expectedRevision;
      if (!Value.Check(typeRevision, version))
        return invalidRevision("CustomEntityTypeRevision");
      if (!Value.Check(entityRevision, expectedRevision))
        return invalidRevision("CommerceEntityRevision");
      const attributes = parseCustomAssignments(
        command.attributes,
        reference.value.typeId,
        version,
      );
      if (!attributes.ok) return attributes;
      const displayName = command.displayName ?? null;
      if (
        displayName !== null &&
        !Value.Check(trimmedIdentityTextSchema, displayName)
      )
        return invalidText("patch_custom_entity.display_name");
      return {
        ok: true,
        value: {
          kind: raw.value.kind,
          command: {
            entityRef: reference.value,
            typeRevision: version,
            expectedRevision,
            attributes: attributes.value,
            displayName,
          },
        },
      };
    }
    case "archive_custom_entity": {
      const command = raw.value.command;
      const reference = parseCommerceEntityRef(command.entityRef);
      if (!reference.ok) return reference;
      if (reference.value.origin !== "custom") return cursorRefusal("parse");
      const expectedRevision = command.expectedRevision;
      if (!Value.Check(entityRevision, expectedRevision))
        return invalidRevision("CommerceEntityRevision");
      if (!validTimestamp(command.archivedAt)) return cursorRefusal("parse");
      return {
        ok: true,
        value: {
          kind: raw.value.kind,
          command: {
            entityRef: reference.value,
            expectedRevision,
            archivedAt: command.archivedAt,
          },
        },
      };
    }
    default:
      return assertNever(raw.value);
  }
}

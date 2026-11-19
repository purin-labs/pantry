import {
  customRelationshipRefSchema,
  customRelationshipDefinitionSchema,
  customRelationshipDefinitionRecordWireSchema,
  commerceRelationshipRefSchema,
  parseRelationshipDefinition,
} from "./relationships.ts";
import {
  customRelationshipDefinitionRefSchema,
  parseRelationshipDefinitionRef,
} from "./query-filter.ts";
import {
  systemRelationshipDefinitionWireSchema,
  customRelationshipDefinitionWireSchema,
  commerceEntityRefWireSchema,
} from "./query-wire.ts";
import {
  OpenObject,
  StrictObject,
  parseContract,
  type ContractDecodeResult,
  NonNegativeInteger as revision,
} from "./schema.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { assertNever } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";

import {
  commerceEntityRefSchema,
  parseCommerceEntityRef,
} from "./entity-reference.ts";

import {
  queryIdentitySchema,
  identityRefusal,
  invalidShape,
} from "./query-parts.ts";

import { cursorRefusal } from "./cursor-values.ts";

const id = queryIdentitySchema<"RelationshipId">();

const systemRelationshipRefWireSchema = OpenObject({
  origin: Type.Literal("system"),
  relationshipId: Type.String(),
  definition: systemRelationshipDefinitionWireSchema,
  revision,
});
export const customRelationshipRefWireSchema = OpenObject({
  origin: Type.Literal("custom"),
  relationshipId: Type.String(),
  definition: customRelationshipDefinitionWireSchema,
  revision,
});
export const relationshipRefWireSchema = Type.Union([
  systemRelationshipRefWireSchema,
  customRelationshipRefWireSchema,
]);
export const customCommerceRelationshipCreateTargetSchema = StrictObject({
  relationshipId: id,
  definition: customRelationshipDefinitionRefSchema,
  source: commerceEntityRefSchema,
  target: commerceEntityRefSchema,
});
export const customCommerceRelationshipCommandTargetSchema = OpenObject({
  relationship: customRelationshipRefSchema,
});
export const customCommerceRelationshipReplacementTargetSchema = OpenObject({
  relationship: customRelationshipRefSchema,
  replacementTarget: commerceEntityRefSchema,
});
export type CustomCommerceRelationshipCreateTarget = Static<
  typeof customCommerceRelationshipCreateTargetSchema
>;
export type CustomCommerceRelationshipCommandTarget = Static<
  typeof customCommerceRelationshipCommandTargetSchema
>;
export type CustomCommerceRelationshipReplacementTarget = Static<
  typeof customCommerceRelationshipReplacementTargetSchema
>;
export const relationshipCreateTargetWire = StrictObject({
  relationshipId: Type.String(),
  definition: customRelationshipDefinitionWireSchema,
  source: commerceEntityRefWireSchema,
  target: commerceEntityRefWireSchema,
});
export const relationshipCommandTargetWire = OpenObject({
  relationship: customRelationshipRefWireSchema,
});
export const relationshipReplacementTargetWire = OpenObject({
  relationship: customRelationshipRefWireSchema,
  replacementTarget: commerceEntityRefWireSchema,
});
export const customCommerceRelationshipDefinitionDraftSchema = StrictObject(
  customRelationshipDefinitionSchema.properties,
);
const relationshipDefinitionDraftWire = StrictObject(
  customRelationshipDefinitionRecordWireSchema.properties,
);
export const customCommerceRelationshipDefinitionCreateTargetSchema =
  StrictObject({
    definitionId: customRelationshipDefinitionSchema.properties.definitionId,
  });
export const customCommerceRelationshipDefinitionCommandTargetSchema =
  StrictObject({
    definitionId: customRelationshipDefinitionSchema.properties.definitionId,
    revision: customRelationshipDefinitionSchema.properties.revision,
  });
export const relationshipDefinitionCreateTargetWire = StrictObject({
  definitionId: Type.String(),
});
export const relationshipDefinitionCommandTargetWire = StrictObject({
  definitionId: Type.String(),
  revision,
});
export type CustomCommerceRelationshipDefinitionDraft = Static<
  typeof customCommerceRelationshipDefinitionDraftSchema
>;
export type CustomCommerceRelationshipDefinitionCreateTarget = Static<
  typeof customCommerceRelationshipDefinitionCreateTargetSchema
>;
export type CustomCommerceRelationshipDefinitionCommandTarget = Static<
  typeof customCommerceRelationshipDefinitionCommandTargetSchema
>;
export const relationshipLifecycleCommandSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("create_custom_relationship_definition"),
    command: StrictObject({
      draft: customCommerceRelationshipDefinitionDraftSchema,
    }),
  }),
  OpenObject({
    kind: Type.Literal("publish_custom_relationship_definition"),
    command: StrictObject({
      target: customCommerceRelationshipDefinitionCommandTargetSchema,
    }),
  }),
  OpenObject({
    kind: Type.Literal("create_custom_relationship"),
    command: OpenObject({
      target: customCommerceRelationshipCreateTargetSchema,
    }),
  }),
  OpenObject({
    kind: Type.Literal("delete_custom_relationship"),
    command: OpenObject({
      target: customCommerceRelationshipCommandTargetSchema,
    }),
  }),
  OpenObject({
    kind: Type.Literal("replace_custom_relationship"),
    command: OpenObject({
      target: customCommerceRelationshipReplacementTargetSchema,
    }),
  }),
]);
type RelationshipLifecycleCommand = StrictUnion<
  Static<typeof relationshipLifecycleCommandSchema>
>;
const commandWire = Type.Union([
  OpenObject({
    kind: Type.Literal("create_custom_relationship_definition"),
    command: StrictObject({ draft: relationshipDefinitionDraftWire }),
  }),
  OpenObject({
    kind: Type.Literal("publish_custom_relationship_definition"),
    command: StrictObject({ target: relationshipDefinitionCommandTargetWire }),
  }),
  OpenObject({
    kind: Type.Literal("create_custom_relationship"),
    command: OpenObject({ target: relationshipCreateTargetWire }),
  }),
  OpenObject({
    kind: Type.Literal("delete_custom_relationship"),
    command: OpenObject({ target: relationshipCommandTargetWire }),
  }),
  OpenObject({
    kind: Type.Literal("replace_custom_relationship"),
    command: OpenObject({ target: relationshipReplacementTargetWire }),
  }),
]);
export function parseCommerceRelationshipRef(input: unknown) {
  const parsed = parseContract(relationshipRefWireSchema, input, invalidShape);
  if (!parsed.ok) return parsed;
  const reference = parsed.value;
  if (!Value.Check(id, reference.relationshipId))
    return identityRefusal("RelationshipId");
  const definition = parseRelationshipDefinitionRef(reference.definition);
  if (!definition.ok) return definition;
  if (reference.revision === 0)
    return cursorRefusal("invalid_revision", { field: "RelationshipRevision" });
  return parseContract(
    commerceRelationshipRefSchema,
    {
      origin: reference.origin,
      relationshipId: reference.relationshipId,
      definition: definition.value,
      revision: reference.revision,
    },
    invalidShape,
  );
}
export function parseRelationshipCreateTarget(
  input: unknown,
): ContractDecodeResult<CustomCommerceRelationshipCreateTarget> {
  const parsed = parseContract(
    relationshipCreateTargetWire,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const target = parsed.value;
  if (!Value.Check(id, target.relationshipId))
    return identityRefusal("RelationshipId");
  const definition = parseRelationshipDefinitionRef(target.definition);
  if (!definition.ok) return definition;
  const source = parseCommerceEntityRef(target.source);
  if (!source.ok) return source;
  const endpoint = parseCommerceEntityRef(target.target);
  if (!endpoint.ok) return endpoint;
  if (
    source.value.origin === endpoint.value.origin &&
    source.value.typeId === endpoint.value.typeId &&
    source.value.entityId === endpoint.value.entityId
  )
    return cursorRefusal("invalid_relationship_endpoint");
  return parseContract(
    customCommerceRelationshipCreateTargetSchema,
    {
      relationshipId: target.relationshipId,
      definition: definition.value,
      source: source.value,
      target: endpoint.value,
    },
    invalidShape,
  );
}
export function parseRelationshipCommandTarget(
  input: unknown,
): ContractDecodeResult<CustomCommerceRelationshipCommandTarget> {
  const parsed = parseContract(
    relationshipCommandTargetWire,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const reference = parseCommerceRelationshipRef(parsed.value.relationship);
  if (!reference.ok) return reference;
  return parseContract(
    customCommerceRelationshipCommandTargetSchema,
    { relationship: reference.value },
    invalidShape,
  );
}
export function parseRelationshipReplacementTarget(
  input: unknown,
): ContractDecodeResult<CustomCommerceRelationshipReplacementTarget> {
  const parsed = parseContract(
    relationshipReplacementTargetWire,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const relationship = parseCommerceRelationshipRef(parsed.value.relationship);
  if (!relationship.ok) return relationship;
  const endpoint = parseCommerceEntityRef(parsed.value.replacementTarget);
  if (!endpoint.ok) return endpoint;
  return parseContract(
    customCommerceRelationshipReplacementTargetSchema,
    { relationship: relationship.value, replacementTarget: endpoint.value },
    invalidShape,
  );
}
export function parseRelationshipLifecycleCommand(
  input: unknown,
): ContractDecodeResult<RelationshipLifecycleCommand> {
  const parsed = parseContract(commandWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const command = parsed.value;
  switch (command.kind) {
    case "create_custom_relationship_definition": {
      const draft = parseRelationshipDefinitionDraft(command.command.draft);
      if (!draft.ok) return draft;
      return {
        ok: true,
        value: { kind: command.kind, command: { draft: draft.value } },
      };
    }
    case "publish_custom_relationship_definition": {
      const target = parseRelationshipDefinitionCommandTarget(
        command.command.target,
      );
      if (!target.ok) return target;
      return {
        ok: true,
        value: { kind: command.kind, command: { target: target.value } },
      };
    }
    case "create_custom_relationship": {
      const target = parseRelationshipCreateTarget(command.command.target);
      if (!target.ok) return target;
      return {
        ok: true,
        value: { kind: command.kind, command: { target: target.value } },
      };
    }
    case "delete_custom_relationship": {
      const target = parseRelationshipCommandTarget(command.command.target);
      if (!target.ok) return target;
      return {
        ok: true,
        value: { kind: command.kind, command: { target: target.value } },
      };
    }
    case "replace_custom_relationship": {
      const target = parseRelationshipReplacementTarget(command.command.target);
      if (!target.ok) return target;
      return {
        ok: true,
        value: { kind: command.kind, command: { target: target.value } },
      };
    }
    default:
      return assertNever(command);
  }
}

function parseRelationshipDefinitionDraft(
  input: unknown,
): ContractDecodeResult<CustomCommerceRelationshipDefinitionDraft> {
  const raw = parseContract(
    relationshipDefinitionDraftWire,
    input,
    invalidShape,
  );
  if (!raw.ok) return raw;
  const definition = parseRelationshipDefinition(raw.value);
  if (!definition.ok) return definition;
  return parseContract(
    customCommerceRelationshipDefinitionDraftSchema,
    definition.value,
    invalidShape,
  );
}
export function parseRelationshipDefinitionCreateTarget(
  input: unknown,
): ContractDecodeResult<CustomCommerceRelationshipDefinitionCreateTarget> {
  const raw = parseContract(
    relationshipDefinitionCreateTargetWire,
    input,
    invalidShape,
  );
  if (!raw.ok) return raw;
  if (
    !Value.Check(
      customCommerceRelationshipDefinitionCreateTargetSchema.properties
        .definitionId,
      raw.value.definitionId,
    )
  )
    return identityRefusal("RelationshipDefinitionId");
  return parseContract(
    customCommerceRelationshipDefinitionCreateTargetSchema,
    raw.value,
    invalidShape,
  );
}
export function parseRelationshipDefinitionCommandTarget(
  input: unknown,
): ContractDecodeResult<CustomCommerceRelationshipDefinitionCommandTarget> {
  const raw = parseContract(
    relationshipDefinitionCommandTargetWire,
    input,
    invalidShape,
  );
  if (!raw.ok) return raw;
  if (
    !Value.Check(
      customCommerceRelationshipDefinitionCommandTargetSchema.properties
        .definitionId,
      raw.value.definitionId,
    )
  )
    return identityRefusal("RelationshipDefinitionId");
  if (raw.value.revision === 0)
    return cursorRefusal("invalid_revision", {
      field: "RelationshipDefinitionRevision",
    });
  return parseContract(
    customCommerceRelationshipDefinitionCommandTargetSchema,
    raw.value,
    invalidShape,
  );
}

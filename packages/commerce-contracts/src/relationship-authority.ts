import {
  authorityValidationRequestSchema as envelope,
  invalidAuthorityRequest as invalidRequest,
  parseCommandAuthorizationInput,
} from "./command-authorization-input.ts";
import { customRelationshipDefinitionRefSchema } from "./query-filter.ts";
import { customRelationshipRefSchema } from "./relationships.ts";
import {
  OpenObject,
  parseContract,
  type ContractDecodeResult,
  NonNegativeInteger as revision,
} from "./schema.ts";

import { commerceAuthorityScopeWireSchema } from "./authority-scope.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { cleanValue } from "./sorted-unions.ts";
import { assertNever, canonicalJsonByCodePoint } from "@seams/std";
import { type StrictUnion } from "@seams/type-utils";
import { commerceSensitivitySchema } from "./entity-record.ts";
import { trimmedIdentityTextSchema } from "./identity-text.ts";
import {
  queryIdentitySchema,
  identityRefusal,
  invalidShape,
} from "./query-parts.ts";
import { relationshipDefinitionWireSchema } from "./query-wire.ts";

import {
  customCommerceRelationshipDefinitionCreateTargetSchema,
  customCommerceRelationshipDefinitionCommandTargetSchema,
  relationshipDefinitionCreateTargetWire,
  relationshipDefinitionCommandTargetWire,
  parseRelationshipDefinitionCreateTarget,
  parseRelationshipDefinitionCommandTarget,
  customCommerceRelationshipCreateTargetSchema,
  customCommerceRelationshipCommandTargetSchema,
  customCommerceRelationshipReplacementTargetSchema,
  relationshipRefWireSchema,
  relationshipCreateTargetWire,
  relationshipCommandTargetWire,
  relationshipReplacementTargetWire,
  parseRelationshipCreateTarget,
  parseRelationshipCommandTarget,
  parseRelationshipReplacementTarget,
  parseRelationshipLifecycleCommand,
} from "./relationship-commands.ts";
import { timestampNanoseconds } from "./commerce-timestamp.ts";

import { cursorRefusal } from "./cursor-values.ts";

const commandId = queryIdentitySchema<"CommerceCommandId">();
const causationId = queryIdentitySchema<"CommerceCausationId">();
export const commandAuthorityCausationSchema = OpenObject({
  kind: Type.Literal("command"),
  commandId,
});
export const eventAuthorityCausationSchema = OpenObject({
  kind: Type.Literal("event"),
  eventId: causationId,
});
export const ingressAuthorityCausationSchema = OpenObject({
  kind: Type.Literal("ingress"),
  observationId: causationId,
});
export const scheduleAuthorityCausationSchema = OpenObject({
  kind: Type.Literal("schedule"),
  scheduleId: causationId,
});
export const effectReceiptAuthorityCausationSchema = OpenObject({
  kind: Type.Literal("effect_receipt"),
  receiptId: causationId,
});
export const migrationAuthorityCausationSchema = OpenObject({
  kind: Type.Literal("migration"),
  migrationId: causationId,
});
export const commerceAuthorityCausationSchema = Type.Union([
  commandAuthorityCausationSchema,
  eventAuthorityCausationSchema,
  ingressAuthorityCausationSchema,
  scheduleAuthorityCausationSchema,
  effectReceiptAuthorityCausationSchema,
  migrationAuthorityCausationSchema,
]);
export const commerceAuthorityContextSchema = OpenObject({
  organisationId: trimmedIdentityTextSchema,
  merchantId: queryIdentitySchema<"CommerceMerchantId">(),
  principalId: queryIdentitySchema<"CommercePrincipalId">(),
  sensitivityCeiling: commerceSensitivitySchema,
  expiresAt: Type.String(),
  causation: commerceAuthorityCausationSchema,
});
export type CommerceAuthorityCausation = StrictUnion<
  Static<typeof commerceAuthorityCausationSchema>
>;
export type CommerceAuthorityContext = Static<
  typeof commerceAuthorityContextSchema
>;
const causationWire = Type.Union([
  OpenObject({ kind: Type.Literal("command"), commandId: Type.String() }),
  OpenObject({ kind: Type.Literal("event"), eventId: Type.String() }),
  OpenObject({ kind: Type.Literal("ingress"), observationId: Type.String() }),
  OpenObject({ kind: Type.Literal("schedule"), scheduleId: Type.String() }),
  OpenObject({
    kind: Type.Literal("effect_receipt"),
    receiptId: Type.String(),
  }),
  OpenObject({ kind: Type.Literal("migration"), migrationId: Type.String() }),
]);
export const commerceAuthorityContextWireSchema = OpenObject({
  organisationId: Type.String(),
  merchantId: Type.String(),
  principalId: Type.String(),
  sensitivityCeiling: commerceSensitivitySchema,
  expiresAt: Type.String(),
  causation: causationWire,
});

export const commerceCommandAuthorityContextSchema = OpenObject({
  ...commerceAuthorityContextSchema.properties,
  causation: commandAuthorityCausationSchema,
});
export type CommerceCommandAuthorityContext = Static<
  typeof commerceCommandAuthorityContextSchema
>;
const relationshipScope = OpenObject({
  kind: Type.Literal("relationship"),
  relationship: customRelationshipRefSchema,
});
const definitionScope = OpenObject({
  kind: Type.Literal("relationship_definition"),
  relationshipDefinition: customRelationshipDefinitionRefSchema,
});
// Creation authority binds an identity before a definition revision is published.
// Rust preserves the supplied revision here, including zero; publication matches it exactly.
const definitionCreateScope = OpenObject({
  kind: Type.Literal("relationship_definition"),
  relationshipDefinition: OpenObject({
    ...customRelationshipDefinitionRefSchema.properties,
    revision: Type.Unsafe<
      number & { readonly __brand: "RelationshipDefinitionRevision" }
    >(revision),
  }),
});
export const customRelationshipDefinitionCreateAuthoritySchema = OpenObject({
  kind: Type.Literal("custom_relationship_definition_create"),
  context: commerceCommandAuthorityContextSchema,
  scope: definitionCreateScope,
  target: customCommerceRelationshipDefinitionCreateTargetSchema,
});
export const customRelationshipDefinitionPublishAuthoritySchema = OpenObject({
  kind: Type.Literal("custom_relationship_definition_publish"),
  context: commerceCommandAuthorityContextSchema,
  scope: definitionScope,
  target: customCommerceRelationshipDefinitionCommandTargetSchema,
});
export const relationshipCreateAuthoritySchema = OpenObject({
  kind: Type.Literal("relationship_create"),
  context: commerceCommandAuthorityContextSchema,
  scope: definitionScope,
  target: customCommerceRelationshipCreateTargetSchema,
});
export const relationshipCommandAuthoritySchema = OpenObject({
  kind: Type.Literal("relationship_command"),
  context: commerceCommandAuthorityContextSchema,
  scope: relationshipScope,
  target: customCommerceRelationshipCommandTargetSchema,
});
export const relationshipReplacementAuthoritySchema = OpenObject({
  kind: Type.Literal("relationship_replacement"),
  context: commerceCommandAuthorityContextSchema,
  scope: relationshipScope,
  target: customCommerceRelationshipReplacementTargetSchema,
});
export const relationshipAuthoritySchema = Type.Union([
  customRelationshipDefinitionCreateAuthoritySchema,
  customRelationshipDefinitionPublishAuthoritySchema,
  relationshipCreateAuthoritySchema,
  relationshipCommandAuthoritySchema,
  relationshipReplacementAuthoritySchema,
]);
export type RelationshipAuthority = StrictUnion<
  Static<typeof relationshipAuthoritySchema>
>;
const authorityWire = Type.Union([
  OpenObject({
    kind: Type.Literal("custom_relationship_definition_create"),
    context: commerceAuthorityContextWireSchema,
    scope: commerceAuthorityScopeWireSchema,
    target: relationshipDefinitionCreateTargetWire,
  }),
  OpenObject({
    kind: Type.Literal("custom_relationship_definition_publish"),
    context: commerceAuthorityContextWireSchema,
    scope: commerceAuthorityScopeWireSchema,
    target: relationshipDefinitionCommandTargetWire,
  }),
  OpenObject({
    kind: Type.Literal("relationship_create"),
    context: commerceAuthorityContextWireSchema,
    scope: commerceAuthorityScopeWireSchema,
    target: relationshipCreateTargetWire,
  }),
  OpenObject({
    kind: Type.Literal("relationship_command"),
    context: commerceAuthorityContextWireSchema,
    scope: commerceAuthorityScopeWireSchema,
    target: relationshipCommandTargetWire,
  }),
  OpenObject({
    kind: Type.Literal("relationship_replacement"),
    context: commerceAuthorityContextWireSchema,
    scope: commerceAuthorityScopeWireSchema,
    target: relationshipReplacementTargetWire,
  }),
]);

export function parseRelationshipAuthority(
  input: unknown,
): ContractDecodeResult<RelationshipAuthority> {
  const request = parseContract(envelope, input, invalidRequest);
  if (!request.ok) return request;
  const parsed = parseContract(
    authorityWire,
    request.value.authority,
    invalidShape,
  );
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
  const scope = authority.scope;
  switch (authority.kind) {
    case "custom_relationship_definition_create": {
      const target = parseRelationshipDefinitionCreateTarget(authority.target);
      if (!target.ok) return target;
      if (
        scope.kind !== "relationship_definition" ||
        scope.relationshipDefinition.origin !== "custom" ||
        scope.relationshipDefinition.definitionId !== target.value.definitionId
      )
        return cursorRefusal("authority_out_of_scope");
      return parseContract(
        customRelationshipDefinitionCreateAuthoritySchema,
        {
          kind: authority.kind,
          context: context.value,
          scope: {
            kind: scope.kind,
            relationshipDefinition: {
              origin: scope.relationshipDefinition.origin,
              definitionId: scope.relationshipDefinition.definitionId,
              revision: scope.relationshipDefinition.revision,
            },
          },
          target: target.value,
        },
        invalidShape,
      );
    }
    case "custom_relationship_definition_publish": {
      const target = parseRelationshipDefinitionCommandTarget(authority.target);
      if (!target.ok) return target;
      if (
        scope.kind !== "relationship_definition" ||
        scope.relationshipDefinition.origin !== "custom" ||
        scope.relationshipDefinition.definitionId !==
          target.value.definitionId ||
        scope.relationshipDefinition.revision !== target.value.revision
      )
        return cursorRefusal("authority_out_of_scope");
      return parseContract(
        customRelationshipDefinitionPublishAuthoritySchema,
        {
          kind: authority.kind,
          context: context.value,
          scope: {
            kind: scope.kind,
            relationshipDefinition: {
              origin: scope.relationshipDefinition.origin,
              definitionId: scope.relationshipDefinition.definitionId,
              revision: scope.relationshipDefinition.revision,
            },
          },
          target: target.value,
        },
        invalidShape,
      );
    }
    case "relationship_create": {
      const target = parseRelationshipCreateTarget(authority.target);
      if (!target.ok) return target;
      if (
        scope.kind !== "relationship_definition" ||
        !sameDefinitionReference(
          scope.relationshipDefinition,
          target.value.definition,
        )
      )
        return cursorRefusal("authority_out_of_scope");
      return parseContract(
        relationshipCreateAuthoritySchema,
        {
          kind: authority.kind,
          context: context.value,
          scope: {
            kind: scope.kind,
            relationshipDefinition: target.value.definition,
          },
          target: target.value,
        },
        invalidShape,
      );
    }
    case "relationship_command": {
      const target = parseRelationshipCommandTarget(authority.target);
      if (!target.ok) return target;
      if (
        scope.kind !== "relationship" ||
        !sameRelationshipReference(
          scope.relationship,
          target.value.relationship,
        )
      )
        return cursorRefusal("authority_out_of_scope");
      return parseContract(
        relationshipCommandAuthoritySchema,
        {
          kind: authority.kind,
          context: context.value,
          scope: { kind: scope.kind, relationship: target.value.relationship },
          target: target.value,
        },
        invalidShape,
      );
    }
    case "relationship_replacement": {
      const target = parseRelationshipReplacementTarget(authority.target);
      if (!target.ok) return target;
      if (
        scope.kind !== "relationship" ||
        !sameRelationshipReference(
          scope.relationship,
          target.value.relationship,
        )
      )
        return cursorRefusal("authority_out_of_scope");
      return parseContract(
        relationshipReplacementAuthoritySchema,
        {
          kind: authority.kind,
          context: context.value,
          scope: { kind: scope.kind, relationship: target.value.relationship },
          target: target.value,
        },
        invalidShape,
      );
    }
    default:
      return assertNever(authority);
  }
}
function sameDefinitionReference(
  left: Static<typeof relationshipDefinitionWireSchema>,
  right: Static<typeof relationshipDefinitionWireSchema>,
): boolean {
  return (
    left.origin === right.origin &&
    left.definitionId === right.definitionId &&
    left.revision === right.revision
  );
}
function sameRelationshipReference(
  left: Static<typeof relationshipRefWireSchema>,
  right: Static<typeof relationshipRefWireSchema>,
): boolean {
  return (
    left.origin === right.origin &&
    left.relationshipId === right.relationshipId &&
    left.revision === right.revision &&
    sameDefinitionReference(left.definition, right.definition)
  );
}
export function parseCommerceAuthorityContext(
  input: unknown,
  now: string,
): ContractDecodeResult<CommerceAuthorityContext> {
  const parsed = parseContract(
    commerceAuthorityContextWireSchema,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const context = parsed.value;
  if (!Value.Check(trimmedIdentityTextSchema, context.organisationId))
    return cursorRefusal("parse");
  if (!Value.Check(trimmedIdentityTextSchema, context.merchantId))
    return identityRefusal("CommerceMerchantId");
  if (!Value.Check(trimmedIdentityTextSchema, context.principalId))
    return identityRefusal("principal_id");
  const expiry = timestampNanoseconds(context.expiresAt);
  if (expiry === null) return cursorRefusal("parse");
  const cause = context.causation;
  let id: string;
  switch (cause.kind) {
    case "command":
      id = cause.commandId;
      break;
    case "event":
      id = cause.eventId;
      break;
    case "ingress":
      id = cause.observationId;
      break;
    case "schedule":
      id = cause.scheduleId;
      break;
    case "effect_receipt":
      id = cause.receiptId;
      break;
    case "migration":
      id = cause.migrationId;
      break;
    default:
      return assertNever(cause);
  }
  if (!Value.Check(trimmedIdentityTextSchema, id))
    return identityRefusal(
      cause.kind === "command" ? "CommerceCommandId" : "causation_id",
    );
  const clock = timestampNanoseconds(now);
  if (clock === null) return cursorRefusal("parse");
  if (expiry <= clock) return cursorRefusal("authority_expired");
  return parseContract(
    commerceAuthorityContextSchema,
    cleanValue(commerceAuthorityContextSchema, Value.Clone(context)),
    invalidShape,
  );
}

export function validateRelationshipCommandAuthority(
  input: unknown,
): ContractDecodeResult<true> {
  const parsedRequest = parseCommandAuthorizationInput(input);
  if (!parsedRequest.ok) return parsedRequest;
  const request = parsedRequest.value;
  const authority = parseRelationshipAuthority({
    authority: request.authority,
    now: request.now,
  });
  if (!authority.ok) return authority;
  const command = parseRelationshipLifecycleCommand(request.command);
  if (!command.ok) return command;
  const context = authority.value.context;
  if (
    context.organisationId !== request.organisationId ||
    context.merchantId !== request.merchantId ||
    context.causation.commandId !== request.commandId
  )
    return cursorRefusal("authority_out_of_scope");
  if (command.value.kind === "create_custom_relationship_definition") {
    if (
      authority.value.kind !== "custom_relationship_definition_create" ||
      authority.value.target.definitionId !==
        command.value.command.draft.definitionId
    )
      return cursorRefusal("authority_out_of_scope");
    return { ok: true, value: true };
  }
  let expectedKind: RelationshipAuthority["kind"];
  switch (command.value.kind) {
    case "publish_custom_relationship_definition":
      expectedKind = "custom_relationship_definition_publish";
      break;
    case "create_custom_relationship":
      expectedKind = "relationship_create";
      break;
    case "delete_custom_relationship":
      expectedKind = "relationship_command";
      break;
    case "replace_custom_relationship":
      expectedKind = "relationship_replacement";
      break;
    default:
      return assertNever(command.value);
  }
  if (
    authority.value.kind !== expectedKind ||
    canonicalJsonByCodePoint(authority.value.target) !==
      canonicalJsonByCodePoint(command.value.command.target)
  )
    return cursorRefusal("authority_out_of_scope");
  return { ok: true, value: true };
}

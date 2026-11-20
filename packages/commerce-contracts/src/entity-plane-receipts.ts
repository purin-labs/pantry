import {
  commerceListEntryAuthorityScopeWireSchema,
  commerceListEntryRefSchema,
  parseCommerceListEntryRef,
} from "./authority-scope.ts";
import {
  customRelationshipRefWireSchema,
  parseCommerceRelationshipRef,
} from "./relationship-commands.ts";
import { customEntityRefWireSchema } from "./query-wire.ts";
import { customRelationshipRefSchema } from "./relationships.ts";
import {
  StrictObject,
  parseContract,
  type ContractDecodeResult,
  NonNegativeInteger as revisionWire,
} from "@purin-labs/contract-schema";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { assertNever, canonicalJsonByCodePoint } from "@purin-labs/std";
import { type StrictUnion } from "@purin-labs/type-utils";

import {
  authorityTargetSchemas,
  authorityTargetWireSchemas,
} from "./command-authority.ts";
import {
  customCommerceEntityRefSchema,
  parseCommerceEntityRef,
} from "./entity-reference.ts";

import {
  queryIdentitySchema,
  commerceListIdSchema,
  savedCommerceViewIdSchema,
  identityRefusal,
  invalidShape,
} from "./query-parts.ts";
import { revisionSchema } from "./entity-record.ts";
import { validTimestamp } from "./commerce-timestamp.ts";
import { cursorRefusal } from "./cursor-values.ts";

export const merchantRevisionSchema = revisionSchema<"MerchantRevision">();
export const commerceEntityPlaneDeliveryIdSchema =
  queryIdentitySchema<"CommerceEntityPlaneDeliveryId">();
export const commerceMutationReceiptKeyIdSchema =
  queryIdentitySchema<"CommerceMutationReceiptKeyId">();
export const commerceMutationReceiptSignatureSchema =
  queryIdentitySchema<"CommerceMutationReceiptSignature">();
export const commerceMutationReceiptSignatureAlgorithmSchema =
  Type.Literal("ed25519");
export const commerceMutationReceiptOutcomeSchema = Type.Enum([
  "applied",
  "already_applied",
]);
const commandIdSchema = queryIdentitySchema<"CommerceCommandId">();
const entityRevisionSchema = revisionSchema<"CommerceEntityRevision">();
const entryRevisionSchema = revisionSchema<"CommerceListEntryRevision">();
export const customEntityMutationTargetSchema = StrictObject({
  kind: Type.Literal("custom_entity"),
  entityRef: customCommerceEntityRefSchema,
  revision: entityRevisionSchema,
});
export const customRelationshipMutationTargetSchema = StrictObject({
  kind: Type.Literal("custom_relationship"),
  relationship: customRelationshipRefSchema,
});
export const commerceListMutationTargetSchema = StrictObject({
  kind: Type.Literal("commerce_list"),
  listId: commerceListIdSchema,
  revision: revisionSchema<"CommerceListRevision">(),
});
export const commerceListEntryMutationTargetSchema = StrictObject({
  kind: Type.Literal("commerce_list_entry"),
  entry: commerceListEntryRefSchema,
  revision: entryRevisionSchema,
});
export const savedCommerceViewMutationTargetSchema = StrictObject({
  kind: Type.Literal("saved_commerce_view"),
  viewId: savedCommerceViewIdSchema,
  revision: revisionSchema<"SavedCommerceViewRevision">(),
});
export const customEntityTypeMutationTargetSchema = StrictObject({
  kind: Type.Literal("custom_entity_type"),
  ...authorityTargetSchemas.custom_entity_type_publish.properties,
});
export const customRelationshipDefinitionMutationTargetSchema = StrictObject({
  kind: Type.Literal("custom_relationship_definition"),
  definitionId: queryIdentitySchema<"RelationshipDefinitionId">(),
  revision: revisionSchema<"RelationshipDefinitionRevision">(),
});
export const systemEntityExtensionSchemaMutationTargetSchema = StrictObject({
  kind: Type.Literal("system_entity_extension_schema"),
  ...authorityTargetSchemas.system_entity_extension_schema_publish.properties,
});
export const commerceMutationTargetSchema = Type.Union([
  customEntityMutationTargetSchema,
  customRelationshipMutationTargetSchema,
  commerceListMutationTargetSchema,
  commerceListEntryMutationTargetSchema,
  savedCommerceViewMutationTargetSchema,
  customEntityTypeMutationTargetSchema,
  customRelationshipDefinitionMutationTargetSchema,
  systemEntityExtensionSchemaMutationTargetSchema,
]);
export type CommerceMutationTarget = StrictUnion<
  Static<typeof commerceMutationTargetSchema>
>;
export const commerceMutationReceiptSignerSchema = StrictObject({
  keyId: commerceMutationReceiptKeyIdSchema,
  algorithm: commerceMutationReceiptSignatureAlgorithmSchema,
  signature: commerceMutationReceiptSignatureSchema,
});
const receiptFields = {
  commandId: commandIdSchema,
  outcome: commerceMutationReceiptOutcomeSchema,
  target: Type.Unsafe<CommerceMutationTarget>(commerceMutationTargetSchema),
  merchantRevision: merchantRevisionSchema,
  committedAt: Type.String(),
  deliveryId: Type.Union([commerceEntityPlaneDeliveryIdSchema, Type.Null()]),
};
export const commerceMutationReceiptSigningEnvelopeV1Schema = StrictObject({
  ...receiptFields,
  signer: Type.Optional(Type.Never()),
});
export const commerceMutationReceiptV1Schema = StrictObject({
  ...receiptFields,
  signer: commerceMutationReceiptSignerSchema,
});
export type MerchantRevision = Static<typeof merchantRevisionSchema>;
export type CommerceEntityPlaneDeliveryId = Static<
  typeof commerceEntityPlaneDeliveryIdSchema
>;
export type CommerceMutationReceiptKeyId = Static<
  typeof commerceMutationReceiptKeyIdSchema
>;
export type CommerceMutationReceiptSignature = Static<
  typeof commerceMutationReceiptSignatureSchema
>;
export type CommerceMutationReceiptSignatureAlgorithm = Static<
  typeof commerceMutationReceiptSignatureAlgorithmSchema
>;
export type CommerceMutationReceiptOutcome = Static<
  typeof commerceMutationReceiptOutcomeSchema
>;
export type CommerceMutationReceiptSigner = Static<
  typeof commerceMutationReceiptSignerSchema
>;
export type CommerceMutationReceiptSigningEnvelopeV1 = Static<
  typeof commerceMutationReceiptSigningEnvelopeV1Schema
>;
export type CommerceMutationReceiptV1 = Static<
  typeof commerceMutationReceiptV1Schema
>;

export const commerceMutationTargetWireSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("custom_entity"),
    entityRef: customEntityRefWireSchema,
    revision: revisionWire,
  }),
  StrictObject({
    kind: Type.Literal("custom_relationship"),
    relationship: customRelationshipRefWireSchema,
  }),
  StrictObject({
    kind: Type.Literal("commerce_list"),
    listId: Type.String(),
    revision: revisionWire,
  }),
  StrictObject({
    kind: Type.Literal("commerce_list_entry"),
    entry: commerceListEntryAuthorityScopeWireSchema.properties.entry,
    revision: revisionWire,
  }),
  StrictObject({
    kind: Type.Literal("saved_commerce_view"),
    viewId: Type.String(),
    revision: revisionWire,
  }),
  StrictObject({
    kind: Type.Literal("custom_entity_type"),
    ...authorityTargetWireSchemas.custom_entity_type_publish.properties,
  }),
  StrictObject({
    kind: Type.Literal("custom_relationship_definition"),
    definitionId: Type.String(),
    revision: revisionWire,
  }),
  StrictObject({
    kind: Type.Literal("system_entity_extension_schema"),
    ...authorityTargetWireSchemas.system_entity_extension_schema_publish
      .properties,
  }),
]);
const signerWire = StrictObject({
  keyId: Type.String(),
  algorithm: commerceMutationReceiptSignatureAlgorithmSchema,
  signature: Type.String(),
});
export const mutationReceiptWireSchema = StrictObject({
  commandId: Type.String(),
  outcome: commerceMutationReceiptOutcomeSchema,
  target: commerceMutationTargetWireSchema,
  merchantRevision: revisionWire,
  committedAt: Type.String(),
  deliveryId: Type.Union([Type.String(), Type.Null()]),
  signer: signerWire,
});

export function parseCommerceMutationTarget(
  input: unknown,
): ContractDecodeResult<CommerceMutationTarget> {
  const parsed = parseContract(
    commerceMutationTargetWireSchema,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const target = parsed.value;
  switch (target.kind) {
    case "custom_entity": {
      const entityRef = parseCommerceEntityRef(target.entityRef);
      if (!entityRef.ok) return entityRef;
      if (entityRef.value.origin !== "custom") return cursorRefusal("parse");
      const revision = target.revision;
      if (!Value.Check(entityRevisionSchema, revision))
        return invalidRevision("CommerceEntityRevision");
      return {
        ok: true,
        value: { kind: target.kind, entityRef: entityRef.value, revision },
      };
    }
    case "custom_relationship": {
      const relationship = parseCommerceRelationshipRef(target.relationship);
      if (!relationship.ok) return relationship;
      if (relationship.value.origin !== "custom") return cursorRefusal("parse");
      return {
        ok: true,
        value: { kind: target.kind, relationship: relationship.value },
      };
    }
    case "commerce_list": {
      const listId = target.listId;
      if (!Value.Check(commerceListIdSchema, listId))
        return identityRefusal("CommerceListId");
      const revision = target.revision;
      if (
        !Value.Check(
          commerceListMutationTargetSchema.properties.revision,
          revision,
        )
      )
        return invalidRevision("CommerceListRevision");
      return { ok: true, value: { kind: target.kind, listId, revision } };
    }
    case "commerce_list_entry": {
      const entry = parseCommerceListEntryRef(target.entry);
      if (!entry.ok) return entry;
      const revision = target.revision;
      if (!Value.Check(entryRevisionSchema, revision))
        return invalidRevision("CommerceListEntryRevision");
      if (entry.value.revision !== revision)
        return cursorRefusal("revision_conflict", {
          expected: revision,
          received: entry.value.revision,
        });
      return {
        ok: true,
        value: { kind: target.kind, entry: entry.value, revision },
      };
    }
    case "saved_commerce_view": {
      const viewId = target.viewId;
      if (!Value.Check(savedCommerceViewIdSchema, viewId))
        return identityRefusal("SavedCommerceViewId");
      const revision = target.revision;
      if (
        !Value.Check(
          savedCommerceViewMutationTargetSchema.properties.revision,
          revision,
        )
      )
        return invalidRevision("SavedCommerceViewRevision");
      return { ok: true, value: { kind: target.kind, viewId, revision } };
    }
    case "custom_entity_type": {
      const typeId = target.typeId;
      if (
        !Value.Check(
          authorityTargetSchemas.custom_entity_type_publish.properties.typeId,
          typeId,
        )
      )
        return identityRefusal("CustomCommerceEntityTypeId");
      const revision = target.revision;
      if (
        !Value.Check(
          authorityTargetSchemas.custom_entity_type_publish.properties.revision,
          revision,
        )
      )
        return invalidRevision("CustomEntityTypeRevision");
      return { ok: true, value: { kind: target.kind, typeId, revision } };
    }
    case "custom_relationship_definition": {
      const definitionId = target.definitionId;
      if (
        !Value.Check(
          customRelationshipDefinitionMutationTargetSchema.properties
            .definitionId,
          definitionId,
        )
      )
        return identityRefusal("RelationshipDefinitionId");
      const revision = target.revision;
      if (
        !Value.Check(
          customRelationshipDefinitionMutationTargetSchema.properties.revision,
          revision,
        )
      )
        return invalidRevision("RelationshipDefinitionRevision");
      return { ok: true, value: { kind: target.kind, definitionId, revision } };
    }
    case "system_entity_extension_schema": {
      const revision = target.revision;
      if (
        !Value.Check(
          authorityTargetSchemas.system_entity_extension_schema_publish
            .properties.revision,
          revision,
        )
      )
        return invalidRevision("MerchantExtensionSchemaRevision");
      return {
        ok: true,
        value: {
          kind: target.kind,
          entityTypeId: target.entityTypeId,
          revision,
        },
      };
    }
    default:
      return assertNever(target);
  }
}

export function parseCommerceMutationReceipt(
  input: unknown,
): ContractDecodeResult<CommerceMutationReceiptV1> {
  const parsed = parseContract(mutationReceiptWireSchema, input, invalidShape);
  if (!parsed.ok) return parsed;
  const receipt = parsed.value;
  const commandId = receipt.commandId;
  if (!Value.Check(commandIdSchema, commandId))
    return identityRefusal("CommerceCommandId");
  const merchantRevision = receipt.merchantRevision;
  if (!Value.Check(merchantRevisionSchema, merchantRevision))
    return invalidRevision("MerchantRevision");
  if (!validTimestamp(receipt.committedAt)) return cursorRefusal("parse");
  const deliveryId = receipt.deliveryId;
  if (
    deliveryId !== null &&
    !Value.Check(commerceEntityPlaneDeliveryIdSchema, deliveryId)
  )
    return identityRefusal("receipt.delivery_id");
  const keyId = receipt.signer.keyId;
  if (!Value.Check(commerceMutationReceiptKeyIdSchema, keyId))
    return identityRefusal("receipt.signer.key_id");
  const signature = receipt.signer.signature;
  if (!Value.Check(commerceMutationReceiptSignatureSchema, signature))
    return identityRefusal("receipt.signer.signature");
  const target = parseCommerceMutationTarget(receipt.target);
  if (!target.ok) return target;
  // The browser Rust boundary returns serde Value maps in code-point key order.
  const normalized: unknown = JSON.parse(
    canonicalJsonByCodePoint({
      commandId,
      outcome: receipt.outcome,
      target: target.value,
      merchantRevision,
      committedAt: receipt.committedAt,
      deliveryId,
      signer: { keyId, algorithm: receipt.signer.algorithm, signature },
    }),
  );
  return parseContract(
    commerceMutationReceiptV1Schema,
    normalized,
    invalidShape,
  );
}
function invalidRevision(field: string): ContractDecodeResult<never> {
  return cursorRefusal("invalid_revision", { field });
}

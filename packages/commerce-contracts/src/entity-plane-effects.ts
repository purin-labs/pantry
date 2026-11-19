import {
  customRelationshipRefWireSchema,
  parseCommerceRelationshipRef,
} from "./relationship-commands.ts";
import {
  customEntityRefWireSchema,
  customRelationshipDefinitionWireSchema,
  commerceEntityRefWireSchema,
} from "./query-wire.ts";
import { customRelationshipRefSchema } from "./relationships.ts";
import {
  customRelationshipDefinitionRefSchema,
  parseRelationshipDefinitionRef,
} from "./query-filter.ts";
import {
  StrictObject,
  parseContract,
  type ContractDecodeResult,
  NonNegativeInteger as revisionWire,
} from "./schema.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { assertNever } from "@purin-labs/std";
import { type StrictUnion } from "@purin-labs/type-utils";
import {
  commerceEntityRefSchema,
  customCommerceEntityRefSchema,
  parseCommerceEntityRef,
  type CommerceEntityRef,
} from "./entity-reference.ts";

import {
  authorityTargetSchemas,
  authorityTargetWireSchemas,
  parseCommerceListEntryCommandTarget,
} from "./command-authority.ts";
import { revisionSchema } from "./entity-record.ts";
import {
  queryIdentitySchema,
  commerceListIdSchema,
  identityRefusal,
  invalidShape,
} from "./query-parts.ts";
import { cursorRefusal } from "./cursor-values.ts";
import { sameRelationshipDefinitionRef } from "./commerce-relationship-references.ts";
import {
  commerceMutationReceiptV1Schema,
  mutationReceiptWireSchema,
  parseCommerceMutationReceipt,
  type CommerceMutationReceiptV1,
} from "./entity-plane-receipts.ts";

const entityRevision = revisionSchema<"CommerceEntityRevision">();
const typeRevision = revisionSchema<"CustomEntityTypeRevision">();
const listRevision = revisionSchema<"CommerceListRevision">();
const entryRevision = revisionSchema<"CommerceListEntryRevision">();
const relationshipId = queryIdentitySchema<"RelationshipId">();
const entryId = queryIdentitySchema<"CommerceListEntryId">();
const receiptSchema = Type.Unsafe<CommerceMutationReceiptV1>(
  commerceMutationReceiptV1Schema,
);
export const commerceEntityPlaneEffectSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("patch_custom_entity"),
    entityRef: customCommerceEntityRefSchema,
    typeRevision,
    expectedRevision: entityRevision,
    receipt: receiptSchema,
  }),
  StrictObject({
    kind: Type.Literal("create_custom_relationship"),
    relationshipId,
    definition: customRelationshipDefinitionRefSchema,
    source: commerceEntityRefSchema,
    target: commerceEntityRefSchema,
    receipt: receiptSchema,
  }),
  StrictObject({
    kind: Type.Literal("delete_custom_relationship"),
    relationship: customRelationshipRefSchema,
    receipt: receiptSchema,
  }),
  StrictObject({
    kind: Type.Literal("replace_custom_relationship"),
    relationship: customRelationshipRefSchema,
    replacementTarget: commerceEntityRefSchema,
    receipt: receiptSchema,
  }),
  StrictObject({
    kind: Type.Literal("add_commerce_list_entry"),
    entryId,
    listId: commerceListIdSchema,
    expectedListRevision: listRevision,
    entityRef: commerceEntityRefSchema,
    revision: entryRevision,
    receipt: receiptSchema,
  }),
  StrictObject({
    kind: Type.Literal("patch_commerce_list_entry"),
    entry: authorityTargetSchemas.commerce_list_entry_command,
    expectedListRevision: listRevision,
    receipt: receiptSchema,
  }),
  StrictObject({
    kind: Type.Literal("remove_commerce_list_entry"),
    entry: authorityTargetSchemas.commerce_list_entry_command,
    receipt: receiptSchema,
  }),
]);
export type CommerceEntityPlaneEffect = StrictUnion<
  Static<typeof commerceEntityPlaneEffectSchema>
>;

const effectWire = Type.Union([
  StrictObject({
    kind: Type.Literal("patch_custom_entity"),
    entityRef: customEntityRefWireSchema,
    typeRevision: revisionWire,
    expectedRevision: revisionWire,
    receipt: mutationReceiptWireSchema,
  }),
  StrictObject({
    kind: Type.Literal("create_custom_relationship"),
    relationshipId: Type.String(),
    definition: customRelationshipDefinitionWireSchema,
    source: commerceEntityRefWireSchema,
    target: commerceEntityRefWireSchema,
    receipt: mutationReceiptWireSchema,
  }),
  StrictObject({
    kind: Type.Literal("delete_custom_relationship"),
    relationship: customRelationshipRefWireSchema,
    receipt: mutationReceiptWireSchema,
  }),
  StrictObject({
    kind: Type.Literal("replace_custom_relationship"),
    relationship: customRelationshipRefWireSchema,
    replacementTarget: commerceEntityRefWireSchema,
    receipt: mutationReceiptWireSchema,
  }),
  StrictObject({
    kind: Type.Literal("add_commerce_list_entry"),
    entryId: Type.String(),
    listId: Type.String(),
    expectedListRevision: revisionWire,
    entityRef: commerceEntityRefWireSchema,
    revision: revisionWire,
    receipt: mutationReceiptWireSchema,
  }),
  StrictObject({
    kind: Type.Literal("patch_commerce_list_entry"),
    entry: authorityTargetWireSchemas.commerce_list_entry_command,
    expectedListRevision: revisionWire,
    receipt: mutationReceiptWireSchema,
  }),
  StrictObject({
    kind: Type.Literal("remove_commerce_list_entry"),
    entry: authorityTargetWireSchemas.commerce_list_entry_command,
    receipt: mutationReceiptWireSchema,
  }),
]);

export function parseCommerceEntityPlaneEffect(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneEffect> {
  const parsed = parseContract(effectWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const effect = parsed.value;
  switch (effect.kind) {
    case "patch_custom_entity": {
      const entityRef = parseCommerceEntityRef(effect.entityRef);
      if (!entityRef.ok) return entityRef;
      if (entityRef.value.origin !== "custom") return cursorRefusal("parse");
      const revision = effect.typeRevision;
      if (!Value.Check(typeRevision, revision))
        return invalidRevision("CustomEntityTypeRevision");
      const expectedRevision = effect.expectedRevision;
      if (!Value.Check(entityRevision, expectedRevision))
        return invalidRevision("CommerceEntityRevision");
      const receipt = parseCommerceMutationReceipt(effect.receipt);
      if (!receipt.ok) return receipt;
      return finishEffect({
        kind: effect.kind,
        entityRef: entityRef.value,
        typeRevision: revision,
        expectedRevision,
        receipt: receipt.value,
      });
    }
    case "create_custom_relationship": {
      const id = effect.relationshipId;
      if (!Value.Check(relationshipId, id))
        return identityRefusal("RelationshipId");
      const definition = parseRelationshipDefinitionRef(effect.definition);
      if (!definition.ok) return definition;
      if (definition.value.origin !== "custom") return cursorRefusal("parse");
      const source = parseCommerceEntityRef(effect.source);
      if (!source.ok) return source;
      const target = parseCommerceEntityRef(effect.target);
      if (!target.ok) return target;
      const receipt = parseCommerceMutationReceipt(effect.receipt);
      if (!receipt.ok) return receipt;
      return finishEffect({
        kind: effect.kind,
        relationshipId: id,
        definition: definition.value,
        source: source.value,
        target: target.value,
        receipt: receipt.value,
      });
    }
    case "delete_custom_relationship":
    case "replace_custom_relationship": {
      const relationship = parseCommerceRelationshipRef(effect.relationship);
      if (!relationship.ok) return relationship;
      if (relationship.value.origin !== "custom") return cursorRefusal("parse");
      if (effect.kind === "delete_custom_relationship") {
        const receipt = parseCommerceMutationReceipt(effect.receipt);
        if (!receipt.ok) return receipt;
        return finishEffect({
          kind: effect.kind,
          relationship: relationship.value,
          receipt: receipt.value,
        });
      }
      const replacementTarget = parseCommerceEntityRef(
        effect.replacementTarget,
      );
      if (!replacementTarget.ok) return replacementTarget;
      const receipt = parseCommerceMutationReceipt(effect.receipt);
      if (!receipt.ok) return receipt;
      return finishEffect({
        kind: effect.kind,
        relationship: relationship.value,
        replacementTarget: replacementTarget.value,
        receipt: receipt.value,
      });
    }
    case "add_commerce_list_entry": {
      const id = effect.entryId;
      if (!Value.Check(entryId, id))
        return identityRefusal("CommerceListEntryId");
      const listId = effect.listId;
      if (!Value.Check(commerceListIdSchema, listId))
        return identityRefusal("CommerceListId");
      const expectedListRevision = effect.expectedListRevision;
      if (!Value.Check(listRevision, expectedListRevision))
        return invalidRevision("CommerceListRevision");
      const entityRef = parseCommerceEntityRef(effect.entityRef);
      if (!entityRef.ok) return entityRef;
      const revision = effect.revision;
      if (!Value.Check(entryRevision, revision))
        return invalidRevision("CommerceListEntryRevision");
      if (revision !== 1)
        return cursorRefusal("revision_conflict", {
          expected: 1,
          received: revision,
        });
      const receipt = parseCommerceMutationReceipt(effect.receipt);
      if (!receipt.ok) return receipt;
      return finishEffect({
        kind: effect.kind,
        entryId: id,
        listId,
        expectedListRevision,
        entityRef: entityRef.value,
        revision,
        receipt: receipt.value,
      });
    }
    case "patch_commerce_list_entry":
    case "remove_commerce_list_entry": {
      const entry = parseCommerceListEntryCommandTarget(effect.entry);
      if (!entry.ok) return entry;
      if (effect.kind === "remove_commerce_list_entry") {
        const receipt = parseCommerceMutationReceipt(effect.receipt);
        if (!receipt.ok) return receipt;
        return finishEffect({
          kind: effect.kind,
          entry: entry.value,
          receipt: receipt.value,
        });
      }
      const expectedListRevision = effect.expectedListRevision;
      if (!Value.Check(listRevision, expectedListRevision))
        return invalidRevision("CommerceListRevision");
      const receipt = parseCommerceMutationReceipt(effect.receipt);
      if (!receipt.ok) return receipt;
      return finishEffect({
        kind: effect.kind,
        entry: entry.value,
        expectedListRevision,
        receipt: receipt.value,
      });
    }
    default:
      return assertNever(effect);
  }
}
/** Platform records an effect only when it has delivery evidence and a valid proposal. */
export function parseRecordedCommerceEntityPlaneEffect(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneEffect> {
  const parsed = parseCommerceEntityPlaneEffect(input);
  if (!parsed.ok) return parsed;
  const effect = parsed.value;
  if (effect.receipt.deliveryId === null) {
    return cursorRefusal("provenance_identity_mismatch");
  }
  if (
    effect.kind === "create_custom_relationship" &&
    sameEntity(effect.source, effect.target)
  ) {
    return cursorRefusal("invalid_relationship_endpoint");
  }
  return parsed;
}

function finishEffect(
  effect: CommerceEntityPlaneEffect,
): ContractDecodeResult<CommerceEntityPlaneEffect> {
  if (!effectMatchesReceipt(effect))
    return cursorRefusal("provenance_identity_mismatch");
  return { ok: true, value: effect };
}
function effectMatchesReceipt(effect: CommerceEntityPlaneEffect): boolean {
  const target = effect.receipt.target;
  switch (effect.kind) {
    case "patch_custom_entity":
      return (
        target.kind === "custom_entity" &&
        sameEntity(target.entityRef, effect.entityRef) &&
        target.revision === effect.expectedRevision + 1
      );
    case "create_custom_relationship":
      return (
        target.kind === "custom_relationship" &&
        target.relationship.relationshipId === effect.relationshipId &&
        sameRelationshipDefinitionRef(
          target.relationship.definition,
          effect.definition,
        ) &&
        target.relationship.revision === 1
      );
    case "delete_custom_relationship":
    case "replace_custom_relationship":
      return (
        target.kind === "custom_relationship" &&
        target.relationship.relationshipId ===
          effect.relationship.relationshipId &&
        sameRelationshipDefinitionRef(
          target.relationship.definition,
          effect.relationship.definition,
        ) &&
        target.relationship.revision === effect.relationship.revision + 1
      );
    case "add_commerce_list_entry":
      return (
        target.kind === "commerce_list_entry" &&
        target.entry.entryId === effect.entryId &&
        target.entry.listId === effect.listId &&
        target.revision === effect.revision
      );
    case "patch_commerce_list_entry":
    case "remove_commerce_list_entry":
      return (
        target.kind === "commerce_list_entry" &&
        target.entry.entryId === effect.entry.entry.entryId &&
        target.entry.listId === effect.entry.entry.listId &&
        target.entry.revision === effect.entry.entry.revision + 1
      );
    default:
      return assertNever(effect);
  }
}
function sameEntity(
  left: CommerceEntityRef,
  right: CommerceEntityRef,
): boolean {
  return (
    left.origin === right.origin &&
    left.typeId === right.typeId &&
    left.entityId === right.entityId
  );
}
function invalidRevision(field: string): ContractDecodeResult<never> {
  return cursorRefusal("invalid_revision", { field });
}

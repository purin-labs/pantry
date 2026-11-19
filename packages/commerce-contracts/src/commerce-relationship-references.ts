import type {
  CommerceRelationshipRef,
  CustomRelationshipDefinitionRef,
  RelationshipDefinition,
  RelationshipDefinitionId,
  RelationshipDefinitionRef,
  RelationshipDefinitionRevision,
  SystemRelationshipDefinitionRef,
} from "./index.ts";
import type { VariantBy } from "@purin-labs/type-utils";

export function relationshipDefinitionReference(
  definition: VariantBy<RelationshipDefinition, "origin", "custom">,
): CustomRelationshipDefinitionRef;
export function relationshipDefinitionReference(
  definition: VariantBy<RelationshipDefinition, "origin", "system">,
): SystemRelationshipDefinitionRef;
export function relationshipDefinitionReference(
  definition: RelationshipDefinition,
): RelationshipDefinitionRef;
export function relationshipDefinitionReference(
  definition: RelationshipDefinition,
): RelationshipDefinitionRef {
  return definition.origin === "custom"
    ? customRelationshipDefinitionReference(
        definition.definitionId,
        definition.revision,
      )
    : {
        origin: "system",
        definitionId: definition.definitionId,
        revision: definition.revision,
      };
}

export function customRelationshipDefinitionReference(
  definitionId: RelationshipDefinitionId,
  revision: RelationshipDefinitionRevision,
): CustomRelationshipDefinitionRef {
  return { origin: "custom", definitionId, revision };
}

export function sameRelationshipDefinitionRef(
  left: RelationshipDefinitionRef,
  right: RelationshipDefinitionRef,
): boolean {
  return (
    left.origin === right.origin &&
    left.definitionId === right.definitionId &&
    Number(left.revision) === Number(right.revision)
  );
}

export function sameCommerceRelationshipRef(
  left: CommerceRelationshipRef,
  right: CommerceRelationshipRef,
): boolean {
  return (
    left.origin === right.origin &&
    left.relationshipId === right.relationshipId &&
    sameRelationshipDefinitionRef(left.definition, right.definition) &&
    Number(left.revision) === Number(right.revision)
  );
}

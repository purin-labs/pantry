import type {
  CommerceCommandResult,
  CommerceEntityRef,
  CommerceEntityTypeId,
  CommerceRelationship,
  CustomCommerceRelationshipRef,
  MerchantRevision,
  RelationshipDefinition,
  RelationshipDefinitionRef,
  RelationshipRevision,
  CommerceEntityPlaneObservationV1,
} from "@seams/commerce-contracts";
import type { CommerceDatabase } from "../database.ts";
import { parsePositiveRevision } from "./parsers.ts";
import {
  deleteRelationship,
  findEntity,
  readCustomRelationshipDefinitionRevision,
  readRelationship,
  relationshipCardinalityConflict,
  relationshipReplacementCardinalityConflict,
  replaceRelationshipTarget,
  writeRelationship,
} from "./relationships.ts";
import {
  EntityPlaneSettlement,
  type CommandRequest,
  rejected,
} from "./receipt-outbox-settlement.ts";
import {
  relationshipDefinitionReference,
  sameRelationshipDefinitionRef,
} from "@seams/commerce-contracts/commerce-relationship-references";
import type { VariantBy } from "@seams/type-utils";

type RelationshipMutationHandlerOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  settlement: EntityPlaneSettlement;
}>;

export class RelationshipMutationHandler {
  readonly #database: CommerceDatabase;
  readonly #now: () => string;
  readonly #settlement: EntityPlaneSettlement;

  constructor(options: RelationshipMutationHandlerOptions) {
    this.#database = options.database;
    this.#now = options.now;
    this.#settlement = options.settlement;
  }

  create(
    request: CommandRequest<"create_custom_relationship">,
    previousRevision: number,
  ): CommerceCommandResult {
    const target = request.command.command.target;
    if (target.definition.origin !== "custom")
      return rejected({ code: "system_relationship_immutable" });
    const definition = readCustomRelationshipDefinitionRevision(
      this.#database,
      request.merchantId,
      target.definition.definitionId,
      target.definition.revision,
    );
    if (
      definition === undefined ||
      !sameRelationshipDefinitionRef(
        relationshipDefinitionReference(definition),
        target.definition,
      )
    ) {
      return rejected({ code: "relationship_definition_mismatch" });
    }
    if (
      !sameEntityType(target.source, definition.sourceType) ||
      !sameEntityType(target.target, definition.targetType) ||
      (target.source.origin === "system" && target.target.origin === "system")
    ) {
      return rejected({ code: "invalid_relationship_endpoint" });
    }
    if (
      findEntity(
        this.#database,
        request.merchantId,
        target.source,
        previousRevision,
      ) === undefined ||
      findEntity(
        this.#database,
        request.merchantId,
        target.target,
        previousRevision,
      ) === undefined
    ) {
      return rejected({ code: "not_found" });
    }
    if (
      readRelationship(
        this.#database,
        request.merchantId,
        target.relationshipId,
        previousRevision,
      ) !== undefined
    ) {
      return rejected({ code: "duplicate_identity" });
    }
    const revision = parsePositiveRevision<RelationshipRevision>(
      1,
      "relationship.revision",
    );
    const relationshipDefinition = relationshipDefinitionReference(definition);
    if (relationshipDefinition.origin !== "custom") {
      throw new Error("Custom relationship definition reference is invalid");
    }
    const relationship: CommerceRelationship = {
      origin: "custom",
      relationshipId: target.relationshipId,
      definition: relationshipDefinition,
      sensitivity: definition.sensitivity,
      source: target.source,
      target: target.target,
      revision,
    };
    const reference = customRelationshipReference(
      target.relationshipId,
      relationshipDefinition,
      revision,
    );
    return this.#settlement.commit(
      request,
      previousRevision,
      { kind: "custom_relationship", relationship: reference },
      { kind: "custom_relationship", ref: reference },
      "created",
      relationshipObservation(
        request.commandId,
        relationship,
        definition,
        nextMerchantRevision(previousRevision),
      ),
      () => {
        const cardinalityError = relationshipCardinalityConflict(
          this.#database,
          request.merchantId,
          definition,
          target.source,
          target.target,
        );
        if (cardinalityError !== undefined) return cardinalityError;
        writeRelationship(
          this.#database,
          request.merchantId,
          target.relationshipId,
          definition,
          target.source,
          target.target,
          this.#now(),
        );
        return undefined;
      },
    );
  }

  delete(
    request: CommandRequest<"delete_custom_relationship">,
    previousRevision: number,
  ): CommerceCommandResult {
    const command = request.command.command;
    const relation = readRelationship(
      this.#database,
      request.merchantId,
      command.target.relationship.relationshipId,
      previousRevision,
    );
    if (
      relation === undefined ||
      relation.origin !== "custom" ||
      !sameRelationshipDefinitionRef(
        relation.definition,
        command.target.relationship.definition,
      )
    ) {
      return rejected({ code: "not_found" });
    }
    if (
      Number(relation.revision) !== Number(command.target.relationship.revision)
    ) {
      return rejected({
        code: "revision_conflict",
        expected: BigInt(command.target.relationship.revision),
        received: BigInt(relation.revision),
      });
    }
    const definition = readCustomRelationshipDefinitionRevision(
      this.#database,
      request.merchantId,
      relation.definition.definitionId,
      relation.definition.revision,
    );
    if (definition === undefined) return rejected({ code: "not_found" });
    const revision = parsePositiveRevision<RelationshipRevision>(
      Number(command.target.relationship.revision) + 1,
      "relationship.revision",
    );
    const nextRelationship: CommerceRelationship = { ...relation, revision };
    const reference = customRelationshipReference(
      command.target.relationship.relationshipId,
      relation.definition,
      revision,
    );
    return this.#settlement.commit(
      request,
      previousRevision,
      { kind: "custom_relationship", relationship: reference },
      { kind: "custom_relationship", ref: reference },
      "deleted",
      relationshipObservation(
        request.commandId,
        nextRelationship,
        definition,
        nextMerchantRevision(previousRevision),
      ),
      () => {
        deleteRelationship(
          this.#database,
          request.merchantId,
          command.target.relationship.relationshipId,
          command.target.relationship.revision,
          this.#now(),
        );
      },
    );
  }

  replace(
    request: CommandRequest<"replace_custom_relationship">,
    previousRevision: number,
  ): CommerceCommandResult {
    const target = request.command.command.target;
    const relation = readRelationship(
      this.#database,
      request.merchantId,
      target.relationship.relationshipId,
      previousRevision,
    );
    if (
      relation === undefined ||
      relation.origin !== "custom" ||
      !sameRelationshipDefinitionRef(
        relation.definition,
        target.relationship.definition,
      )
    ) {
      return rejected({ code: "not_found" });
    }
    if (Number(relation.revision) !== Number(target.relationship.revision)) {
      return rejected({
        code: "revision_conflict",
        expected: BigInt(target.relationship.revision),
        received: BigInt(relation.revision),
      });
    }
    const definition = readCustomRelationshipDefinitionRevision(
      this.#database,
      request.merchantId,
      relation.definition.definitionId,
      relation.definition.revision,
    );
    if (definition === undefined) return rejected({ code: "not_found" });
    if (
      !sameEntityType(relation.source, definition.sourceType) ||
      !sameEntityType(target.replacementTarget, definition.targetType) ||
      sameEntityRef(relation.source, target.replacementTarget)
    ) {
      return rejected({ code: "invalid_relationship_endpoint" });
    }
    if (sameEntityRef(relation.target, target.replacementTarget)) {
      return rejected({ code: "duplicate_identity" });
    }
    if (
      findEntity(
        this.#database,
        request.merchantId,
        target.replacementTarget,
        previousRevision,
      ) === undefined
    ) {
      return rejected({ code: "not_found" });
    }
    const cardinalityError = relationshipReplacementCardinalityConflict(
      this.#database,
      request.merchantId,
      definition,
      relation.source,
      target.replacementTarget,
      relation.relationshipId,
    );
    if (cardinalityError !== undefined) return rejected(cardinalityError);
    const revision = parsePositiveRevision<RelationshipRevision>(
      Number(relation.revision) + 1,
      "relationship.revision",
    );
    const nextRelationship: CommerceRelationship = {
      ...relation,
      target: target.replacementTarget,
      revision,
    };
    const reference = customRelationshipReference(
      relation.relationshipId,
      relation.definition,
      revision,
    );
    return this.#settlement.commit(
      request,
      previousRevision,
      { kind: "custom_relationship", relationship: reference },
      { kind: "custom_relationship", ref: reference },
      "updated",
      relationshipObservation(
        request.commandId,
        nextRelationship,
        definition,
        nextMerchantRevision(previousRevision),
      ),
      applyRelationshipReplacement.bind(
        null,
        this.#database,
        request,
        this.#now(),
      ),
    );
  }
}

function applyRelationshipReplacement(
  database: CommerceDatabase,
  request: CommandRequest<"replace_custom_relationship">,
  now: string,
): void {
  const target = request.command.command.target;
  replaceRelationshipTarget(
    database,
    request.merchantId,
    target.relationship.relationshipId,
    target.relationship.revision,
    target.replacementTarget,
    now,
  );
}

function relationshipObservation(
  observationId: import("@seams/commerce-contracts").CommerceCommandId,
  relationship: CommerceRelationship,
  definition: RelationshipDefinition,
  merchantRevision: MerchantRevision,
): CommerceEntityPlaneObservationV1 {
  return {
    kind: "relationship_changed",
    observationId,
    relationship,
    definition,
    merchantRevision,
  };
}

function sameEntityType(
  reference: CommerceEntityRef,
  typeId: CommerceEntityTypeId,
): boolean {
  return (
    reference.origin === typeId.origin && reference.typeId === typeId.typeId
  );
}

function sameEntityRef(
  left: CommerceEntityRef,
  right: CommerceEntityRef,
): boolean {
  return (
    left.origin === right.origin &&
    left.typeId === right.typeId &&
    left.entityId === right.entityId
  );
}

function customRelationshipReference(
  relationshipId: import("@seams/commerce-contracts").RelationshipId,
  definition: VariantBy<RelationshipDefinitionRef, "origin", "custom">,
  revision: RelationshipRevision,
): CustomCommerceRelationshipRef {
  return { origin: "custom", relationshipId, definition, revision };
}

function nextMerchantRevision(previousRevision: number): MerchantRevision {
  return parsePositiveRevision<MerchantRevision>(
    previousRevision + 1,
    "merchantRevision",
  );
}

import type {
  AttributeDefinition,
  CommerceCommandResult,
  SystemCommerceEntityRef,
} from "@purin-labs/commerce-contracts";
import type { CommerceDatabase } from "../database.ts";
import {
  createSystemExtensionSchema as createSystemExtensionSchemaRow,
  publishCustomEntityType,
  publishSystemExtensionSchema as publishSystemExtensionSchemaRow,
  readCustomEntityType,
  writeCustomEntityType,
} from "./entities.ts";
import {
  createRelationshipDefinition as createRelationshipDefinitionRow,
  publishRelationshipDefinition as publishRelationshipDefinitionRow,
  readCustomRelationshipDefinition,
} from "./relationships.ts";
import {
  EntityPlaneSettlement,
  type CommandRequest,
  rejected,
} from "./receipt-outbox-settlement.ts";

type SchemaCommandHandlerOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  settlement: EntityPlaneSettlement;
}>;

export class SchemaCommandHandler {
  readonly #database: CommerceDatabase;
  readonly #now: () => string;
  readonly #settlement: EntityPlaneSettlement;

  constructor(options: SchemaCommandHandlerOptions) {
    this.#database = options.database;
    this.#now = options.now;
    this.#settlement = options.settlement;
  }

  createCustomEntityType(
    request: CommandRequest<"create_custom_entity_type">,
    previousRevision: number,
  ): CommerceCommandResult {
    const draft = request.command.command.draft;
    const existing = readCustomEntityType(
      this.#database,
      request.merchantId,
      draft.typeId,
    );
    const expectedRevision = existing === undefined ? 1 : existing.revision + 1;
    if (existing?.lifecycle === "draft")
      return rejected({ code: "duplicate_identity" });
    if (Number(draft.revision) !== expectedRevision) {
      return rejected({
        code: "revision_conflict",
        expected: BigInt(expectedRevision),
        received: BigInt(draft.revision),
      });
    }
    const typeId = { origin: "custom" as const, typeId: draft.typeId };
    return this.#settlement.commit(
      request,
      previousRevision,
      {
        kind: "custom_entity_type",
        typeId: draft.typeId,
        revision: draft.revision,
      },
      { kind: "entity_type", typeId },
      "created",
      undefined,
      () =>
        writeCustomEntityType(
          this.#database,
          request.merchantId,
          draft,
          this.#now(),
        ),
    );
  }

  publishCustomEntityType(
    request: CommandRequest<"publish_custom_entity_type">,
    previousRevision: number,
  ): CommerceCommandResult {
    const target = request.command.command.target;
    const existing = readCustomEntityType(
      this.#database,
      request.merchantId,
      target.typeId,
    );
    if (existing === undefined) return rejected({ code: "not_found" });
    if (
      Number(existing.revision) !== Number(target.revision) ||
      existing.lifecycle !== "draft"
    ) {
      return rejected({
        code: "revision_conflict",
        expected: BigInt(target.revision),
        received: BigInt(existing.revision),
      });
    }
    return this.#settlement.commit(
      request,
      previousRevision,
      {
        kind: "custom_entity_type",
        typeId: target.typeId,
        revision: target.revision,
      },
      {
        kind: "entity_type",
        typeId: { origin: "custom", typeId: target.typeId },
      },
      "published",
      undefined,
      () =>
        publishCustomEntityType(
          this.#database,
          request.merchantId,
          target.typeId,
          target.revision,
          this.#now(),
        ),
    );
  }

  createCustomRelationshipDefinition(
    request: CommandRequest<"create_custom_relationship_definition">,
    previousRevision: number,
  ): CommerceCommandResult {
    const draft = request.command.command.draft;
    const existing = readCustomRelationshipDefinition(
      this.#database,
      request.merchantId,
      draft.definitionId,
    );
    const expectedRevision =
      existing === undefined ? 1 : Number(existing.revision) + 1;
    const head = this.#readRelationshipDefinitionHead(
      request.merchantId,
      draft.definitionId,
    );
    if (head?.lifecycleState === "draft")
      return rejected({ code: "duplicate_identity" });
    if (Number(draft.revision) !== expectedRevision) {
      return rejected({
        code: "revision_conflict",
        expected: BigInt(expectedRevision),
        received: BigInt(draft.revision),
      });
    }
    return this.#settlement.commit(
      request,
      previousRevision,
      {
        kind: "custom_relationship_definition",
        definitionId: draft.definitionId,
        revision: draft.revision,
      },
      { kind: "relationship_definition", definitionId: draft.definitionId },
      "created",
      undefined,
      () =>
        createRelationshipDefinitionRow(
          this.#database,
          request.merchantId,
          draft,
          this.#now(),
        ),
    );
  }

  publishCustomRelationshipDefinition(
    request: CommandRequest<"publish_custom_relationship_definition">,
    previousRevision: number,
  ): CommerceCommandResult {
    const target = request.command.command.target;
    const existing = readCustomRelationshipDefinition(
      this.#database,
      request.merchantId,
      target.definitionId,
    );
    if (existing === undefined) return rejected({ code: "not_found" });
    const head = this.#readRelationshipDefinitionHead(
      request.merchantId,
      target.definitionId,
    );
    if (
      Number(existing.revision) !== Number(target.revision) ||
      head?.lifecycleState !== "draft"
    ) {
      return rejected({
        code: "revision_conflict",
        expected: BigInt(target.revision),
        received: BigInt(existing.revision),
      });
    }
    return this.#settlement.commit(
      request,
      previousRevision,
      {
        kind: "custom_relationship_definition",
        definitionId: target.definitionId,
        revision: target.revision,
      },
      { kind: "relationship_definition", definitionId: target.definitionId },
      "published",
      undefined,
      () =>
        publishRelationshipDefinitionRow(
          this.#database,
          request.merchantId,
          target.definitionId,
          target.revision,
          this.#now(),
        ),
    );
  }

  createSystemEntityExtensionSchema(
    request: CommandRequest<"create_system_entity_extension_schema">,
    previousRevision: number,
  ): CommerceCommandResult {
    const draft = request.command.command.draft;
    validateSystemExtensionDefinitions(
      draft.entityTypeId,
      draft.schemaRevision,
      draft.attributes,
    );
    const existing = this.#readSystemExtensionSchemaHead(
      request.merchantId,
      draft.entityTypeId,
    );
    const expectedRevision = existing === undefined ? 1 : existing.revision + 1;
    if (existing?.lifecycleState === "draft")
      return rejected({ code: "duplicate_identity" });
    if (Number(draft.schemaRevision) !== expectedRevision) {
      return rejected({
        code: "revision_conflict",
        expected: BigInt(expectedRevision),
        received: BigInt(draft.schemaRevision),
      });
    }
    return this.#settlement.commit(
      request,
      previousRevision,
      {
        kind: "system_entity_extension_schema",
        entityTypeId: draft.entityTypeId,
        revision: draft.schemaRevision,
      },
      {
        kind: "entity_type",
        typeId: { origin: "system", typeId: draft.entityTypeId },
      },
      "created",
      undefined,
      () =>
        createSystemExtensionSchemaRow(
          this.#database,
          request.merchantId,
          draft.entityTypeId,
          draft.schemaRevision,
          draft.attributes,
          this.#now(),
        ),
    );
  }

  publishSystemEntityExtensionSchema(
    request: CommandRequest<"publish_system_entity_extension_schema">,
    previousRevision: number,
  ): CommerceCommandResult {
    const target = request.command.command.target;
    const existing = this.#readSystemExtensionSchemaHead(
      request.merchantId,
      target.entityTypeId,
    );
    if (existing === undefined) return rejected({ code: "not_found" });
    if (
      Number(existing.revision) !== Number(target.revision) ||
      existing.lifecycleState !== "draft"
    ) {
      return rejected({
        code: "revision_conflict",
        expected: BigInt(target.revision),
        received: BigInt(existing.revision),
      });
    }
    return this.#settlement.commit(
      request,
      previousRevision,
      {
        kind: "system_entity_extension_schema",
        entityTypeId: target.entityTypeId,
        revision: target.revision,
      },
      {
        kind: "entity_type",
        typeId: { origin: "system", typeId: target.entityTypeId },
      },
      "published",
      undefined,
      () =>
        publishSystemExtensionSchemaRow(
          this.#database,
          request.merchantId,
          target.entityTypeId,
          target.revision,
          this.#now(),
        ),
    );
  }

  #readRelationshipDefinitionHead(merchantId: string, definitionId: string) {
    return this.#database
      .prepare(
        `SELECT lifecycle_state AS lifecycleState
       FROM relationship_definition_head
       WHERE merchant_id = ? AND relationship_definition_id = ?`,
      )
      .get<Readonly<{ lifecycleState: "draft" | "published" | "archived" }>>(
        merchantId,
        definitionId,
      );
  }

  #readSystemExtensionSchemaHead(merchantId: string, entityTypeId: string) {
    return this.#database
      .prepare(
        `SELECT current_revision AS revision, lifecycle_state AS lifecycleState
       FROM system_entity_extension_schema_head
       WHERE merchant_id = ? AND system_entity_type_id = ?`,
      )
      .get<
        Readonly<{
          revision: number;
          lifecycleState: "draft" | "published" | "archived";
        }>
      >(merchantId, entityTypeId);
  }
}

function validateSystemExtensionDefinitions(
  typeId: SystemCommerceEntityRef["typeId"],
  revision: number,
  definitions: readonly AttributeDefinition[],
): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (!seen.add(String(definition.id)))
      throw new Error(`Duplicate system extension attribute: ${definition.id}`);
    if (
      definition.scope.kind !== "merchant_extension" ||
      definition.scope.entityTypeId !== typeId ||
      Number(definition.scope.schemaRevision) !== revision ||
      Number(definition.revision) !== revision
    ) {
      throw new Error(
        `System extension attribute revision or owner is invalid: ${definition.id}`,
      );
    }
  }
}

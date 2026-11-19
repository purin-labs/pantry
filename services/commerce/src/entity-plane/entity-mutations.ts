import type {
  CommerceCommandResult,
  CommerceEntityPlaneError,
  CommerceEntityRevision,
  CustomCommerceEntityRef,
  MerchantRevision,
  CommerceEntityPlaneObservationV1,
} from "@purin-labs/commerce-contracts";
import type { CommerceDatabase } from "../database.ts";
import {
  archiveCustomEntity,
  readCustomEntity,
  readCustomEntityTypeRevision,
  readEntityMutationRow,
  updateCustomEntity,
  writeCustomEntity,
} from "./entities.ts";
import { validateEntityAttributes } from "./attribute-validation.ts";
import { parseEntityRef, parsePositiveRevision } from "./parsers.ts";
import {
  EntityPlaneSettlement,
  type CommandRequest,
  rejected,
} from "./receipt-outbox-settlement.ts";

type EntityMutationHandlerOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  settlement: EntityPlaneSettlement;
}>;

export class EntityMutationHandler {
  readonly #database: CommerceDatabase;
  readonly #now: () => string;
  readonly #settlement: EntityPlaneSettlement;

  constructor(options: EntityMutationHandlerOptions) {
    this.#database = options.database;
    this.#now = options.now;
    this.#settlement = options.settlement;
  }

  create(
    request: CommandRequest<"create_custom_entity">,
    previousRevision: number,
  ): CommerceCommandResult {
    const command = request.command.command;
    const type = readCustomEntityTypeRevision(
      this.#database,
      request.merchantId,
      command.typeId,
      command.typeRevision,
    );
    if (
      type === undefined ||
      type.lifecycle !== "published" ||
      Number(type.revision) !== Number(command.typeRevision)
    ) {
      return rejected({ code: "not_found" });
    }
    const reference = parseEntityRef({
      origin: "custom",
      typeId: command.typeId,
      entityId: command.entityId,
    });
    if (reference.origin !== "custom") {
      return rejected({
        code: "invalid_identity",
        field: "create_custom_entity.entityId",
      });
    }
    if (
      readCustomEntity(
        this.#database,
        request.merchantId,
        reference,
        previousRevision,
      ) !== undefined
    ) {
      return rejected({ code: "duplicate_identity" });
    }
    const validation = validateEntityAttributes(
      type.definition.attributes,
      command.attributes,
    );
    if (validation !== undefined) return rejected(validation);
    const revision = parsePositiveRevision<CommerceEntityRevision>(
      1,
      "customEntity.revision",
    );
    return this.#settlement.commit(
      request,
      previousRevision,
      { kind: "custom_entity", entityRef: reference, revision },
      { kind: "entity", ref: reference },
      "created",
      customEntityObservation(
        request.commandId,
        reference,
        revision,
        nextMerchantRevision(previousRevision),
      ),
      () =>
        writeCustomEntity(
          this.#database,
          request.merchantId,
          reference,
          command.typeRevision,
          command.displayName,
          command.sensitivity,
          command.attributes,
          this.#now(),
        ),
    );
  }

  patch(
    request: CommandRequest<"patch_custom_entity">,
    previousRevision: number,
  ): CommerceCommandResult {
    const command = request.command.command;
    const row = this.#activeEntity(request.merchantId, command);
    if ("code" in row) {
      return rejected(row);
    }
    const type = readCustomEntityTypeRevision(
      this.#database,
      request.merchantId,
      command.entityRef.typeId,
      command.typeRevision,
    );
    if (
      type === undefined ||
      type.lifecycle !== "published" ||
      Number(type.revision) !== Number(command.typeRevision) ||
      Number(row.entityTypeRevision) !== Number(command.typeRevision)
    ) {
      return rejected({ code: "not_found" });
    }
    const validation = validateEntityAttributes(
      type.definition.attributes,
      command.attributes,
    );
    if (validation !== undefined) return rejected(validation);
    const revision = parsePositiveRevision<CommerceEntityRevision>(
      Number(command.expectedRevision) + 1,
      "customEntity.revision",
    );
    return this.#settlement.commit(
      request,
      previousRevision,
      { kind: "custom_entity", entityRef: command.entityRef, revision },
      { kind: "entity", ref: command.entityRef },
      "updated",
      customEntityObservation(
        request.commandId,
        command.entityRef,
        revision,
        nextMerchantRevision(previousRevision),
      ),
      () => {
        updateCustomEntity(
          this.#database,
          request.merchantId,
          command.entityRef,
          row.revision,
          command.displayName,
          command.attributes,
          this.#now(),
        );
      },
    );
  }

  archive(
    request: CommandRequest<"archive_custom_entity">,
    previousRevision: number,
  ): CommerceCommandResult {
    const command = request.command.command;
    const row = this.#activeEntity(request.merchantId, command);
    if ("code" in row) {
      return rejected(row);
    }
    const revision = parsePositiveRevision<CommerceEntityRevision>(
      Number(command.expectedRevision) + 1,
      "customEntity.revision",
    );
    return this.#settlement.commit(
      request,
      previousRevision,
      { kind: "custom_entity", entityRef: command.entityRef, revision },
      { kind: "entity", ref: command.entityRef },
      "archived",
      customEntityObservation(
        request.commandId,
        command.entityRef,
        revision,
        nextMerchantRevision(previousRevision),
      ),
      () => {
        archiveCustomEntity(
          this.#database,
          request.merchantId,
          command.entityRef,
          row.revision,
          command.archivedAt,
        );
      },
    );
  }

  // The active entity that a patch or an archive names, at its expected
  // revision.
  #activeEntity(
    merchantId: string,
    command: Readonly<{
      entityRef: CustomCommerceEntityRef;
      expectedRevision: CommerceEntityRevision;
    }>,
  ):
    | NonNullable<ReturnType<typeof readEntityMutationRow>>
    | CommerceEntityPlaneError {
    const row = readEntityMutationRow(
      this.#database,
      merchantId,
      command.entityRef,
    );
    if (row === undefined || row.lifecycleState !== "active") {
      return { code: "not_found" };
    }
    if (row.revision !== Number(command.expectedRevision)) {
      return {
        code: "revision_conflict",
        expected: BigInt(command.expectedRevision),
        received: BigInt(row.revision),
      };
    }
    return row;
  }
}

function customEntityObservation(
  observationId: import("@purin-labs/commerce-contracts").CommerceCommandId,
  entityRef: CustomCommerceEntityRef,
  revision: CommerceEntityRevision,
  merchantRevision: MerchantRevision,
): CommerceEntityPlaneObservationV1 {
  return {
    kind: "custom_entity_changed",
    observationId,
    entityRef,
    revision,
    merchantRevision,
  };
}

function nextMerchantRevision(previousRevision: number): MerchantRevision {
  return parsePositiveRevision<MerchantRevision>(
    previousRevision + 1,
    "merchantRevision",
  );
}

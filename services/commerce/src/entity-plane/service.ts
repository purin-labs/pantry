import type {
  CommerceCommandResult,
  CommerceEntityPlaneError,
  CommerceEntityTypeId,
  CommerceGraphQueryPlanRequest,
  CommerceGraphQueryResult,
  CommerceMerchantId,
  CommerceQueryPlan,
  CommerceSnapshotRevision,
  OrganisationId,
} from "@purin-labs/commerce-contracts";
import {
  parseListEntryReadRequest,
  type CommerceListEntryReadResult,
  commerceExportPresetDigestPayload,
  EXPORT_COORDINATION_PRESET_ID,
  EXPORT_COORDINATION_PRESET_VERSION,
  parseCommerceCommandId,
  parseCommerceMerchantId,
  type CommerceEntityPlaneCapabilityMetadataRequest,
  type CommerceEntityPlaneCapabilityMetadataResponse,
  type CommerceEntityPlaneExportPresetPublishRequest,
  type CommerceEntityPlaneExportPresetPublishResponse,
  type CommerceEntityPlanePlannedQueryResponse,
  type CommerceEntityPlanePublishedResourceMetadataRequest,
  type CommerceEntityPlanePublishedResourceMetadataResponse,
  type CommerceEntityPlaneRelationshipTraversalStepRequest,
  type CommerceEntityPlaneRelationshipTraversalStepResponse,
  type CommercePurchasingPresetPublishRequest,
  type CommercePurchasingPresetPublishResponse,
  type CommercePurchasingReconcileRequest,
  type CommercePurchasingReconcileResponse,
} from "@purin-labs/commerce-client";
import type { CommerceDatabase } from "../database.ts";
import type { CommerceSigner } from "../commerce-authority/contracts.ts";
import {
  listEntityTypes,
  readCustomEntityType,
  readMerchant,
} from "./entities.ts";
import type { CommerceEntityRelationReadResult } from "./commerce-entity-relation.ts";
import {
  listRelationshipDefinitions,
  readCustomRelationshipDefinition,
} from "./relationships.ts";
import {
  parsePositiveRevision,
  parseCommerceEntityPlaneCommand,
  parseCommerceList,
  parseCommerceTimestamp,
  parseEntityPlaneChangeRequest,
  parseEntityPlaneCommandRequest,
  parseEntityPlaneQueryRequest,
  parseSavedCommerceView,
  parseSnapshotRevision,
  parsePositiveText,
} from "./parsers.ts";
import {
  EXPORT_COORDINATION_PRESET,
  type EntityPlanePresetBundle,
} from "./presets.ts";
import type {
  PurchasingReconciliationResult,
  PurchasingExtension,
} from "../plugins/built-in-ports.ts";
import { productionDemandExtension } from "../plugins/production-demand/index.ts";
import { purchasingExtension } from "../plugins/purchasing/index.ts";
import type {
  EntityPlaneChangeRequest,
  EntityPlaneChangeResponse,
  EntityPlaneCommandRequest,
  EntityPlaneQueryRequest,
  EntityPlaneSystemExtensionRequest,
  EntityPlaneSystemExtensionResponse,
} from "./entity-types.ts";
import { validateCommandAuthorityWithLexicon } from "./lexicon.ts";
import { EntityPlaneHttpError } from "./http-error.ts";
import {
  readExportPresetEvidence,
  readPublishedResourceMetadata as resolvePublishedResourceMetadata,
} from "./published-resource-resolution.ts";
import {
  EntityPlaneSettlement,
  type EntityPlaneMutationRequest,
  rejected,
} from "./receipt-outbox-settlement.ts";
import { SchemaCommandHandler } from "./schema-commands.ts";
import { EntityMutationHandler } from "./entity-mutations.ts";
import { RelationshipMutationHandler } from "./relationship-mutations.ts";
import { CommerceLists } from "./commerce-lists.ts";
import { SavedViewMutations } from "./saved-view-mutations.ts";
import { readEntityPlaneChanges } from "./entity-plane-changes.ts";
import { EntityPlanePlannedReads } from "./planned-reads.ts";
import { errorMessage, sameJson, sha256Hex } from "@purin-labs/std";

type EntityPlaneServiceOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  signer: CommerceSigner;
}>;

export class EntityPlaneService {
  readonly #database: CommerceDatabase;
  readonly #now: () => string;
  readonly #settlement: EntityPlaneSettlement;
  readonly #schemaCommands: SchemaCommandHandler;
  readonly #entityMutations: EntityMutationHandler;
  readonly #relationshipMutations: RelationshipMutationHandler;
  readonly #commerceLists: CommerceLists;
  readonly #savedViews: SavedViewMutations;
  readonly #plannedReads: EntityPlanePlannedReads;
  readonly #purchasingReplenishment: ReturnType<
    PurchasingExtension["replenishment"]
  >;

  constructor(options: EntityPlaneServiceOptions) {
    this.#database = options.database;
    this.#now = options.now;
    this.#settlement = new EntityPlaneSettlement(options);
    this.#schemaCommands = new SchemaCommandHandler({
      database: options.database,
      now: options.now,
      settlement: this.#settlement,
    });
    this.#entityMutations = new EntityMutationHandler({
      database: options.database,
      now: options.now,
      settlement: this.#settlement,
    });
    this.#relationshipMutations = new RelationshipMutationHandler({
      database: options.database,
      now: options.now,
      settlement: this.#settlement,
    });
    this.#commerceLists = new CommerceLists({
      database: options.database,
      now: options.now,
      settlement: this.#settlement,
      checkPurchaseRequestPatch: purchasingExtension.checkRequestPatch,
    });
    this.#purchasingReplenishment = purchasingExtension.replenishment({
      database: options.database,
      now: options.now,
      commerceLists: this.#commerceLists,
      executeMutation: this.#executeMutation.bind(this),
    });
    this.#savedViews = new SavedViewMutations({
      database: options.database,
      now: options.now,
      settlement: this.#settlement,
      commerceLists: this.#commerceLists,
    });
    this.#plannedReads = new EntityPlanePlannedReads({
      database: options.database,
      commerceLists: this.#commerceLists,
    });
  }

  readListEntry(rawRequest: unknown): CommerceListEntryReadResult {
    const request = parseListEntryReadRequest(rawRequest);
    const merchant = readMerchant(this.#database, request.merchantId);
    const list = this.#commerceLists.readList(
      request.merchantId,
      request.listId,
    );
    const entry = this.#commerceLists.readEntry(
      request.merchantId,
      request.entryId,
    );
    if (
      merchant === undefined ||
      list === undefined ||
      list.lifecycleState !== "published" ||
      entry === undefined ||
      entry.listId !== request.listId ||
      entry.lifecycleState !== "active"
    )
      return { kind: "missing" };
    return {
      kind: "found",
      merchantRevision: parseSnapshotRevision(
        merchant.revision,
        "merchant.revision",
      ),
      listRevision: parsePositiveRevision(list.revision, "list.revision"),
      entry: this.#commerceLists.hydrateEntry(request.merchantId, entry),
    };
  }

  query(rawRequest: unknown): CommerceGraphQueryResult {
    return this.readQuery(parseEntityPlaneQueryRequest(rawRequest));
  }

  readQuery(request: EntityPlaneQueryRequest): CommerceGraphQueryResult {
    return this.#plannedReads.readQuery(request);
  }

  readCapabilityMetadata(
    request: CommerceEntityPlaneCapabilityMetadataRequest,
  ): CommerceEntityPlaneCapabilityMetadataResponse {
    return this.#plannedReads.readCapabilityMetadata(request);
  }
  readPublishedResourceMetadata(
    request: CommerceEntityPlanePublishedResourceMetadataRequest,
  ): CommerceEntityPlanePublishedResourceMetadataResponse {
    return resolvePublishedResourceMetadata(this.#database, request);
  }

  async publishEntityPlaneExportPreset(
    request: CommerceEntityPlaneExportPresetPublishRequest,
  ): Promise<CommerceEntityPlaneExportPresetPublishResponse> {
    const merchant = readMerchant(this.#database, request.merchantId);
    if (merchant === undefined)
      throw new EntityPlaneHttpError(404, "Merchant not found");
    if (merchant.organisationId !== request.organisationId) {
      throw new EntityPlaneHttpError(
        403,
        "Merchant is outside the organisation authority",
        { code: "authority_out_of_scope" },
      );
    }
    if (
      request.presetId !== EXPORT_COORDINATION_PRESET_ID ||
      request.presetVersion !== EXPORT_COORDINATION_PRESET_VERSION
    ) {
      throw new EntityPlaneHttpError(
        400,
        "Unsupported entity-plane export preset",
      );
    }
    try {
      this.seedExportCoordinationPreset(request.merchantId);
    } catch (error) {
      throw new EntityPlaneHttpError(
        409,
        `Entity-plane export preset drift: ${errorMessage(error)}`,
      );
    }
    const published = readMerchant(this.#database, request.merchantId);
    if (published === undefined)
      throw new EntityPlaneHttpError(404, "Merchant not found");
    const organisationId = parsePositiveText<OrganisationId>(
      request.organisationId,
      "organisationId",
    );
    const merchantId = parsePositiveText<CommerceMerchantId>(
      request.merchantId,
      "merchantId",
    );
    const merchantRevision = parseSnapshotRevision<CommerceSnapshotRevision>(
      published.revision,
      "merchantRevision",
    );
    const evidence = readExportPresetEvidence(
      this.#database,
      request.merchantId,
    );
    const digest = await sha256Hex(
      commerceExportPresetDigestPayload({
        presetId: request.presetId,
        presetVersion: request.presetVersion,
        evidence,
      }),
    );
    return {
      kind: "published",
      organisationId,
      merchantId,
      presetId: EXPORT_COORDINATION_PRESET_ID,
      presetVersion: EXPORT_COORDINATION_PRESET_VERSION,
      merchantRevision,
      evidence,
      digest,
    };
  }

  readValidatedPlan(
    ownerId: string,
    plan: CommerceQueryPlan,
  ): CommerceEntityRelationReadResult {
    return this.#plannedReads.readValidatedPlan(ownerId, plan);
  }

  readValidatedRelationshipTraversalStep(
    request: CommerceEntityPlaneRelationshipTraversalStepRequest,
  ): CommerceEntityPlaneRelationshipTraversalStepResponse {
    return this.#plannedReads.readValidatedRelationshipTraversalStep(request);
  }

  executePlannedQuery(
    request: CommerceGraphQueryPlanRequest,
  ): CommerceEntityPlanePlannedQueryResponse {
    return this.#plannedReads.executePlannedQuery(request);
  }

  readSystemExtensionSidecars(
    request: EntityPlaneSystemExtensionRequest,
  ): EntityPlaneSystemExtensionResponse {
    return this.#plannedReads.readSystemExtensionSidecars(request);
  }

  changes(rawRequest: unknown): EntityPlaneChangeResponse {
    return this.readChanges(parseEntityPlaneChangeRequest(rawRequest));
  }

  readChanges(request: EntityPlaneChangeRequest): EntityPlaneChangeResponse {
    return readEntityPlaneChanges(this.#database, request);
  }

  command(rawRequest: unknown): CommerceCommandResult {
    try {
      return this.execute(
        parseEntityPlaneCommandRequest(
          rawRequest,
          parseCommerceTimestamp(this.#now(), "now"),
        ),
      );
    } catch (error) {
      const reason = authorityValidationReason(error);
      if (reason !== undefined) return rejected(commandAuthorityError(reason));
      throw error;
    }
  }

  execute(request: EntityPlaneCommandRequest): CommerceCommandResult {
    const merchant = readMerchant(this.#database, request.merchantId);
    if (merchant === undefined) return rejected({ code: "not_found" });
    if (merchant.organisationId !== request.organisationId)
      return rejected({ code: "authority_out_of_scope" });
    const authority = validateCommandAuthorityWithLexicon({
      authority: request.authority,
      command: request.command,
      organisationId: request.organisationId,
      merchantId: parseCommerceMerchantId(request.merchantId),
      commandId: request.commandId,
      now: this.#now(),
    });
    if (authority.kind === "error")
      return rejected(commandAuthorityError(authority.error.reason));
    return this.#executeMutation(request);
  }

  #executeMutation(request: EntityPlaneMutationRequest): CommerceCommandResult {
    const merchant = readMerchant(this.#database, request.merchantId);
    if (merchant === undefined) return rejected({ code: "not_found" });
    const replay = this.#settlement.readReplay(request);
    if (replay !== undefined) return replay;
    if (merchant.revision !== request.expectedMerchantRevision) {
      return rejected({
        code: "revision_conflict",
        expected: BigInt(request.expectedMerchantRevision),
        received: BigInt(merchant.revision),
      });
    }
    switch (request.command.kind) {
      case "create_custom_entity_type":
        return this.#schemaCommands.createCustomEntityType(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "publish_custom_entity_type":
        return this.#schemaCommands.publishCustomEntityType(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "create_custom_relationship_definition":
        return this.#schemaCommands.createCustomRelationshipDefinition(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "publish_custom_relationship_definition":
        return this.#schemaCommands.publishCustomRelationshipDefinition(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "create_system_entity_extension_schema":
        return this.#schemaCommands.createSystemEntityExtensionSchema(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "publish_system_entity_extension_schema":
        return this.#schemaCommands.publishSystemEntityExtensionSchema(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "create_custom_entity":
        return this.#entityMutations.create(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "patch_custom_entity":
        return this.#entityMutations.patch(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "archive_custom_entity":
        return this.#entityMutations.archive(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "create_custom_relationship":
        return this.#relationshipMutations.create(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "delete_custom_relationship":
        return this.#relationshipMutations.delete(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "replace_custom_relationship":
        return this.#relationshipMutations.replace(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "create_commerce_list":
        return this.#commerceLists.create(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "add_commerce_list_entry":
        return this.#commerceLists.addEntry(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "patch_commerce_list_entry":
        return this.#commerceLists.patchEntry(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "remove_commerce_list_entry":
        return this.#commerceLists.removeEntry(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "publish_saved_commerce_view":
        return this.#savedViews.publish(
          { ...request, command: request.command },
          merchant.revision,
        );
      case "archive_saved_commerce_view":
        return this.#savedViews.archive(
          { ...request, command: request.command },
          merchant.revision,
        );
      default:
        return rejected({ code: "unsupported_command" });
    }
  }

  seedExportCoordinationPreset(merchantId: string): void {
    this.#installPresetBundle(merchantId, "export", EXPORT_COORDINATION_PRESET);
  }

  seedPurchasingPreset(merchantId: string): void {
    this.#installPresetBundle(
      merchantId,
      "purchasing",
      purchasingExtension.preset,
    );
  }

  publishPurchasingPreset(
    request: CommercePurchasingPresetPublishRequest,
  ): CommercePurchasingPresetPublishResponse {
    this.#requirePurchasingMerchant(request.organisationId, request.merchantId);
    const { preset } = purchasingExtension;
    try {
      this.#installPresetBundle(request.merchantId, "purchasing", preset);
    } catch (error) {
      throw new EntityPlaneHttpError(
        409,
        `Purchasing preset drift: ${errorMessage(error)}`,
      );
    }
    const merchant = this.#requirePurchasingMerchant(
      request.organisationId,
      request.merchantId,
    );
    return {
      kind: "published",
      organisationId: request.organisationId,
      merchantId: request.merchantId,
      merchantRevision: parseSnapshotRevision(
        merchant.revision,
        "merchantRevision",
      ),
    };
  }

  publishProductionDemandPreset(
    request: CommercePurchasingPresetPublishRequest,
  ): CommercePurchasingPresetPublishResponse {
    this.#requirePurchasingMerchant(request.organisationId, request.merchantId);
    const { preset } = productionDemandExtension;
    try {
      this.#installPresetBundle(
        request.merchantId,
        "production_demand",
        preset,
      );
    } catch (error) {
      throw new EntityPlaneHttpError(
        409,
        `Production demand preset drift: ${errorMessage(error)}`,
      );
    }
    const merchant = this.#requirePurchasingMerchant(
      request.organisationId,
      request.merchantId,
    );
    return {
      kind: "published",
      organisationId: request.organisationId,
      merchantId: request.merchantId,
      merchantRevision: parseSnapshotRevision(
        merchant.revision,
        "merchantRevision",
      ),
    };
  }

  reconcilePurchasing(
    request: CommercePurchasingReconcileRequest,
  ): CommercePurchasingReconcileResponse {
    this.#requirePurchasingMerchant(request.organisationId, request.merchantId);
    const result = this.reconcilePurchasingForMerchant(request.merchantId);
    const merchant = this.#requirePurchasingMerchant(
      request.organisationId,
      request.merchantId,
    );
    return {
      ...result,
      organisationId: request.organisationId,
      merchantId: request.merchantId,
      merchantRevision: parseSnapshotRevision(
        merchant.revision,
        "merchantRevision",
      ),
    };
  }

  reconcilePurchasingForMerchant(
    merchantId: string,
  ): PurchasingReconciliationResult {
    return this.#purchasingReplenishment.reconcile(merchantId);
  }

  #requirePurchasingMerchant(organisationId: string, merchantId: string) {
    const merchant = readMerchant(this.#database, merchantId);
    if (merchant === undefined)
      throw new EntityPlaneHttpError(404, "Merchant not found");
    if (merchant.organisationId !== organisationId) {
      throw new EntityPlaneHttpError(
        403,
        "Merchant is outside the organisation authority",
        { code: "authority_out_of_scope" },
      );
    }
    return merchant;
  }

  #installPresetBundle(
    merchantId: string,
    commandNamespace: string,
    preset: EntityPlanePresetBundle,
  ): void {
    if (readMerchant(this.#database, merchantId) === undefined)
      throw new Error(`Merchant not found: ${merchantId}`);
    for (const definition of preset.definitions) {
      const existing = readCustomEntityType(
        this.#database,
        merchantId,
        definition.typeId,
      );
      if (existing === undefined) {
        const created = this.#executeMutation(
          presetCommandRequest(
            this.#database,
            merchantId,
            `preset:${commandNamespace}:${definition.typeId}:create`,
            {
              kind: "create_custom_entity_type",
              command: { draft: { ...definition, revision: 1 } },
            },
          ),
        );
        assertAcceptedPresetCommand(created, definition.typeId);
        const published = this.#executeMutation(
          presetCommandRequest(
            this.#database,
            merchantId,
            `preset:${commandNamespace}:${definition.typeId}:publish`,
            {
              kind: "publish_custom_entity_type",
              command: { target: { typeId: definition.typeId, revision: 1 } },
            },
          ),
        );
        assertAcceptedPresetCommand(published, definition.typeId);
        continue;
      }
      if (!sameJson(existing.definition, definition))
        throw new Error(`Preset definition mismatch: ${definition.typeId}`);
      if (existing.lifecycle === "draft") {
        const published = this.#executeMutation(
          presetCommandRequest(
            this.#database,
            merchantId,
            `preset:${commandNamespace}:${definition.typeId}:publish:${existing.revision}`,
            {
              kind: "publish_custom_entity_type",
              command: {
                target: {
                  typeId: definition.typeId,
                  revision: existing.revision,
                },
              },
            },
          ),
        );
        assertAcceptedPresetCommand(published, definition.typeId);
      } else if (existing.lifecycle !== "published")
        throw new Error(`Preset is unavailable: ${definition.typeId}`);
    }
    for (const definition of preset.relationshipDefinitions) {
      if (definition.origin !== "custom")
        throw new Error(
          `Preset relationship definition is not custom: ${String(definition.definitionId)}`,
        );
      const existing = readCustomRelationshipDefinition(
        this.#database,
        merchantId,
        definition.definitionId,
      );
      const published = listRelationshipDefinitions(
        this.#database,
        merchantId,
      ).find(
        (candidate) =>
          candidate.origin === "custom" &&
          candidate.definitionId === definition.definitionId,
      );
      if (existing === undefined) {
        const created = this.#executeMutation(
          presetCommandRequest(
            this.#database,
            merchantId,
            `preset:${commandNamespace}:${definition.definitionId}:create`,
            {
              kind: "create_custom_relationship_definition",
              command: { draft: definition },
            },
          ),
        );
        assertAcceptedPresetCommand(created, definition.definitionId);
        const publishedResult = this.#executeMutation(
          presetCommandRequest(
            this.#database,
            merchantId,
            `preset:${commandNamespace}:${definition.definitionId}:publish`,
            {
              kind: "publish_custom_relationship_definition",
              command: {
                target: {
                  definitionId: definition.definitionId,
                  revision: definition.revision,
                },
              },
            },
          ),
        );
        assertAcceptedPresetCommand(publishedResult, definition.definitionId);
      } else {
        if (!sameJson(existing, definition))
          throw new Error(
            `Preset relationship definition mismatch: ${definition.definitionId}`,
          );
        if (published === undefined) {
          const publishedResult = this.#executeMutation(
            presetCommandRequest(
              this.#database,
              merchantId,
              `preset:${commandNamespace}:${definition.definitionId}:publish:${existing.revision}`,
              {
                kind: "publish_custom_relationship_definition",
                command: {
                  target: {
                    definitionId: definition.definitionId,
                    revision: existing.revision,
                  },
                },
              },
            ),
          );
          assertAcceptedPresetCommand(publishedResult, definition.definitionId);
        }
      }
    }
    for (const list of preset.lists) {
      const existing = this.#commerceLists.readList(merchantId, list.listId);
      if (existing === undefined) {
        const created = this.#executeMutation(
          presetCommandRequest(
            this.#database,
            merchantId,
            `preset:${commandNamespace}:${list.listId}:create`,
            {
              kind: "create_commerce_list",
              command: list,
            },
          ),
        );
        assertAcceptedPresetCommand(created, list.listId);
      } else {
        if (
          !sameJson(
            parseCommerceList(JSON.parse(existing.definitionJson)),
            list,
          )
        )
          throw new Error(`Preset list mismatch: ${list.listId}`);
        if (existing.lifecycleState !== "published")
          throw new Error(`Preset list is unavailable: ${list.listId}`);
      }
    }
    for (const view of preset.views) {
      const existing = this.#savedViews.read(merchantId, view.viewId);
      if (existing === undefined) {
        const published = this.#executeMutation(
          presetCommandRequest(
            this.#database,
            merchantId,
            `preset:${commandNamespace}:${view.viewId}:publish`,
            {
              kind: "publish_saved_commerce_view",
              command: { view },
            },
          ),
        );
        assertAcceptedPresetCommand(published, view.viewId);
      } else {
        if (
          !sameJson(
            parseSavedCommerceView(JSON.parse(existing.definitionJson)),
            view,
          )
        )
          throw new Error(`Preset saved view mismatch: ${view.viewId}`);
        if (existing.lifecycleState !== "published")
          throw new Error(`Preset saved view is unavailable: ${view.viewId}`);
      }
    }
  }

  listEntityTypes(merchantId: string): readonly CommerceEntityTypeId[] {
    return listEntityTypes(this.#database, merchantId);
  }

  listRelationshipDefinitions(
    merchantId: string,
  ): readonly import("@purin-labs/commerce-contracts").RelationshipDefinition[] {
    return listRelationshipDefinitions(this.#database, merchantId);
  }
}

function presetCommandRequest(
  database: CommerceDatabase,
  merchantId: string,
  commandId: string,
  command: unknown,
): EntityPlaneMutationRequest {
  const merchant = readMerchant(database, merchantId);
  if (merchant === undefined)
    throw new Error(`Merchant not found: ${merchantId}`);
  return {
    organisationId: merchant.organisationId,
    merchantId,
    commandId: parseCommerceCommandId(commandId),
    expectedMerchantRevision: parseSnapshotRevision<CommerceSnapshotRevision>(
      merchant.revision,
      "expectedMerchantRevision",
    ),
    command: parseCommerceEntityPlaneCommand(command),
  };
}

function assertAcceptedPresetCommand(
  result: CommerceCommandResult,
  typeId: string,
): void {
  if (result.status !== "accepted")
    throw new Error(
      `Preset command failed for ${typeId}: ${result.error.code}`,
    );
}

function commandAuthorityError(reason: string): CommerceEntityPlaneError {
  switch (reason) {
    case "authority_expired":
      return { code: "authority_expired" };
    case "authority_out_of_scope":
      return { code: "authority_out_of_scope" };
    case "sensitivity_denied":
      return { code: "sensitivity_denied" };
    case "invalid_identity":
      return { code: "invalid_identity", field: "authority" };
    case "invalid_revision":
      return { code: "invalid_revision", field: "authority" };
    case "invalid_date":
      return { code: "invalid_date" };
    case "missing_authority_field":
      return { code: "missing_authority_field", field: "authority" };
    default:
      return { code: "parse", reason };
  }
}

function authorityValidationReason(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const prefix = "commerce entity authority rejected by Lexicon: ";
  return error.message.startsWith(prefix)
    ? error.message.slice(prefix.length)
    : undefined;
}

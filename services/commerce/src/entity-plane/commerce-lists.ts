import type { ProductionRequestFields } from "@seams/commerce-client";
import type {
  CommerceCommandResult,
  CommerceEntityPlaneError,
  CommerceEntityRef,
  CommerceEntityTypeId,
  CommerceListEntry,
  CommerceListEntryId,
  CommerceListEntryRef,
  CommerceListEntryRevision,
  CommerceListId,
  ListEntryAttributeValue,
  MerchantRevision,
  CommerceEntityPlaneObservationV1,
} from "@seams/commerce-contracts";
import type { CommerceDatabase } from "../database.ts";
import {
  entityTypeExists,
  isSystemEntityType,
  storageFields,
  storedValue,
  type StoredAttributeRow,
} from "./entities.ts";
import {
  listAttributeDefinitionMismatch,
  validateListEntryAttributes,
} from "./attribute-validation.ts";
import {
  parseAttributeValue,
  parseCommerceList,
  parseEntityRef,
  parseEntityTypeId,
  parsePositiveRevision,
  parsePositiveText,
} from "./parsers.ts";
import {
  commandJson,
  EntityPlaneSettlement,
  type CommandRequest,
  rejected,
} from "./receipt-outbox-settlement.ts";
import { findEntity } from "./relationships.ts";
import {
  readProductionRequestFields,
  validateProductionRequestWrite,
} from "./production-requests.ts";
import { validateCommerceListEntryWithLexicon } from "./lexicon.ts";
import type { PurchaseRequestPatchCheck } from "../plugins/built-in-ports.ts";

type StoredListRow = Readonly<{
  listId: string;
  entityTypeId: CommerceEntityTypeId;
  revision: number;
  lifecycleState: "draft" | "published" | "archived";
  name: string;
  definitionJson: string;
}>;

export type StoredListEntryRow = Readonly<{
  entryId: string;
  listId: string;
  listRevision: number;
  entityOrigin: "system" | "custom";
  entityTypeId: string;
  entityId: string;
  revision: number;
  lifecycleState: "active" | "archived";
}>;

type CommerceListsOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  settlement: EntityPlaneSettlement;
  /** The purchasing plugin's check of a purchase request patch. */
  checkPurchaseRequestPatch?: PurchaseRequestPatchCheck;
}>;

export class CommerceLists {
  readonly #database: CommerceDatabase;
  readonly #now: () => string;
  readonly #settlement: EntityPlaneSettlement;
  readonly #checkPurchaseRequestPatch: PurchaseRequestPatchCheck | undefined;

  constructor(options: CommerceListsOptions) {
    this.#database = options.database;
    this.#now = options.now;
    this.#settlement = options.settlement;
    this.#checkPurchaseRequestPatch = options.checkPurchaseRequestPatch;
  }

  create(
    request: CommandRequest<"create_commerce_list">,
    previousRevision: number,
  ): CommerceCommandResult {
    const command = request.command.command;
    if (
      !entityTypeExists(
        this.#database,
        request.merchantId,
        command.entityTypeId,
      )
    ) {
      return rejected({ code: "not_found" });
    }
    const existingList = this.readList(request.merchantId, command.listId);
    if (
      existingList !== undefined &&
      Number(command.publishedRevision) <= Number(existingList.revision)
    ) {
      return rejected({ code: "duplicate_identity" });
    }
    if (
      existingList !== undefined &&
      Number(command.publishedRevision) !== Number(existingList.revision) + 1
    ) {
      return rejected({
        code: "revision_conflict",
        expected: BigInt(Number(existingList.revision) + 1),
        received: BigInt(command.publishedRevision),
      });
    }
    const attributeMismatch = listAttributeDefinitionMismatch(
      command.entryAttributeDefinitions,
      command.entityTypeId,
    );
    if (attributeMismatch !== undefined) {
      return rejected({
        code: "attribute_definition_mismatch",
        attributeId: attributeMismatch,
      });
    }
    if (
      existingList !== undefined &&
      parseCommerceList(JSON.parse(existingList.definitionJson)).membership !==
        command.membership
    )
      return rejected({ code: "duplicate_identity" });
    const definition = parseCommerceList(command);
    return this.#settlement.commit(
      request,
      previousRevision,
      {
        kind: "commerce_list",
        listId: command.listId,
        revision: command.publishedRevision,
      },
      { kind: "commerce_list", listId: command.listId },
      "created",
      undefined,
      () => {
        this.#database
          .prepare(
            `INSERT INTO commerce_list (
             merchant_id, list_id, entity_type_id, revision, lifecycle_state,
             name, definition_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?)`,
          )
          .run(
            request.merchantId,
            command.listId,
            command.entityTypeId.typeId,
            command.publishedRevision,
            command.name,
            commandJson(definition),
            this.#now(),
            this.#now(),
          );
        const published = this.#database
          .prepare(
            `INSERT INTO commerce_list_head (
             merchant_id, list_id, current_revision, published_revision, lifecycle_state, updated_at
           ) VALUES (?, ?, ?, ?, 'published', ?)
           ON CONFLICT (merchant_id, list_id) DO UPDATE SET
             current_revision = excluded.current_revision,
             published_revision = excluded.published_revision,
             lifecycle_state = 'published',
             updated_at = excluded.updated_at`,
          )
          .run(
            request.merchantId,
            command.listId,
            command.publishedRevision,
            command.publishedRevision,
            this.#now(),
          );
        if (published.changes !== 1)
          throw new Error("Commerce list publication was not written");
        for (const attribute of command.entryAttributeDefinitions) {
          this.#database
            .prepare(
              `INSERT INTO commerce_list_entry_attribute_definition (
               merchant_id, list_id, list_revision, attribute_id, definition_json
             ) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              request.merchantId,
              command.listId,
              command.publishedRevision,
              attribute.attributeId,
              commandJson(attribute),
            );
        }
      },
    );
  }

  addEntry(
    request: CommandRequest<"add_commerce_list_entry">,
    previousRevision: number,
  ): CommerceCommandResult {
    const command = request.command.command;
    const list = this.readList(request.merchantId, command.listId);
    if (list === undefined || list.lifecycleState !== "published")
      return rejected({ code: "not_found" });
    if (Number(list.revision) !== Number(command.expectedListRevision)) {
      return rejected({
        code: "revision_conflict",
        expected: BigInt(command.expectedListRevision),
        received: BigInt(list.revision),
      });
    }
    if (!sameEntityType(command.entityRef, list.entityTypeId)) {
      return rejected({ code: "invalid_list_entry_entity_type" });
    }
    if (
      findEntity(
        this.#database,
        request.merchantId,
        command.entityRef,
        previousRevision,
      ) === undefined
    ) {
      return rejected({ code: "not_found" });
    }
    if (this.readEntry(request.merchantId, command.entryId) !== undefined) {
      return rejected({ code: "duplicate_identity" });
    }
    const definition = parseCommerceList(JSON.parse(list.definitionJson));
    const validation = validateListEntryAttributes(
      definition,
      command.attributeValues,
    );
    if (validation !== undefined) return rejected(validation);
    if (String(command.listId) === "production_requests") {
      const invalid = validateProductionRequestWrite(
        this.#database,
        request.merchantId,
        command.entityRef,
        command.attributeValues,
        null,
      );
      if (invalid !== undefined) return rejected(invalid);
    }
    const entryRef = listEntryReference(
      command.entryId,
      command.listId,
      command.revision,
    );
    const updatedAt = this.#now();
    const updatedAtMs = timestampMillis(updatedAt, "listEntry.updatedAt");
    return this.#settlement.commit(
      request,
      previousRevision,
      {
        kind: "commerce_list_entry",
        entry: entryRef,
        revision: command.revision,
      },
      { kind: "commerce_list_entry", ref: entryRef },
      "created",
      listEntryObservation(
        request.commandId,
        entryRef,
        command.entityRef,
        nextMerchantRevision(previousRevision),
      ),
      () => {
        this.#database
          .prepare(
            `INSERT INTO commerce_list_entry (
             merchant_id, entry_id, list_id, list_revision, membership_kind,
             entity_origin, entity_type_id, entity_id, revision,
             lifecycle_state, created_at, updated_at, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          )
          .run(
            request.merchantId,
            command.entryId,
            command.listId,
            command.expectedListRevision,
            definition.membership,
            command.entityRef.origin,
            command.entityRef.typeId,
            command.entityRef.entityId,
            command.revision,
            updatedAt,
            updatedAt,
            updatedAtMs,
          );
        this.#writeEntryAttributes(
          request.merchantId,
          command.entryId,
          command.revision,
          command.attributeValues,
        );
      },
    );
  }

  patchEntry(
    request: CommandRequest<"patch_commerce_list_entry">,
    previousRevision: number,
  ): CommerceCommandResult {
    const command = request.command.command;
    const entry = this.#targetEntry(request.merchantId, command.target);
    if ("code" in entry) {
      return rejected(entry);
    }
    const list = this.readList(
      request.merchantId,
      parsePositiveText<CommerceListId>(entry.listId, "listEntry.listId"),
    );
    if (list === undefined) return rejected({ code: "not_found" });
    if (Number(list.revision) !== Number(command.expectedListRevision)) {
      return rejected({
        code: "revision_conflict",
        expected: BigInt(command.expectedListRevision),
        received: BigInt(list.revision),
      });
    }
    const definition = parseCommerceList(JSON.parse(list.definitionJson));
    const validation = validateListEntryAttributes(
      definition,
      command.attributeValues,
    );
    if (validation !== undefined) return rejected(validation);
    const revision = parsePositiveRevision<CommerceListEntryRevision>(
      entry.revision + 1,
      "listEntry.revision",
    );
    const entryRef = listEntryReference(entry.entryId, entry.listId, revision);
    const entityRef = parseEntityRef({
      origin: entry.entityOrigin,
      typeId: entry.entityTypeId,
      entityId: entry.entityId,
    });
    if (entry.listId === "production_requests") {
      let previous: ProductionRequestFields;
      try {
        previous = readProductionRequestFields(
          this.#database,
          request.merchantId,
          entry.entryId,
          entry.revision,
        );
      } catch {
        return rejected({
          code: "invalid_attribute_value",
          attributeId: parsePositiveText(
            "requested_quantity",
            "production.quantity",
          ),
        });
      }
      const invalid = validateProductionRequestWrite(
        this.#database,
        request.merchantId,
        entityRef,
        command.attributeValues,
        previous,
      );
      if (invalid !== undefined) return rejected(invalid);
    }
    // A purchase request's status moves only through its machine.
    if (
      entry.listId === "replenishment_queue" &&
      this.#checkPurchaseRequestPatch !== undefined
    ) {
      const invalid = this.#checkPurchaseRequestPatch(
        this.#database,
        request.merchantId,
        entry.entryId,
        entry.revision,
        command.attributeValues,
        this.#now(),
      );
      if (invalid !== undefined) return rejected(invalid);
    }
    const updatedAt = this.#now();
    const updatedAtMs = timestampMillis(updatedAt, "listEntry.updatedAt");
    return this.#settlement.commit(
      request,
      previousRevision,
      { kind: "commerce_list_entry", entry: entryRef, revision },
      { kind: "commerce_list_entry", ref: entryRef },
      "updated",
      listEntryObservation(
        request.commandId,
        entryRef,
        entityRef,
        nextMerchantRevision(previousRevision),
      ),
      () => {
        const result = this.#database
          .prepare(
            `UPDATE commerce_list_entry SET revision = ?, updated_at = ?, updated_at_ms = ?
           WHERE merchant_id = ? AND entry_id = ? AND revision = ? AND lifecycle_state = 'active'`,
          )
          .run(
            revision,
            updatedAt,
            updatedAtMs,
            request.merchantId,
            entry.entryId,
            entry.revision,
          );
        if (result.changes !== 1)
          throw new Error(
            "List entry changed while committing entity-plane command",
          );
        this.#writeEntryAttributes(
          request.merchantId,
          entry.entryId,
          revision,
          command.attributeValues,
        );
      },
    );
  }

  removeEntry(
    request: CommandRequest<"remove_commerce_list_entry">,
    previousRevision: number,
  ): CommerceCommandResult {
    const command = request.command.command;
    const entry = this.#targetEntry(request.merchantId, command.target);
    if ("code" in entry) {
      return rejected(entry);
    }
    const revision = parsePositiveRevision<CommerceListEntryRevision>(
      entry.revision + 1,
      "listEntry.revision",
    );
    const entryRef = listEntryReference(entry.entryId, entry.listId, revision);
    const entityRef = parseEntityRef({
      origin: entry.entityOrigin,
      typeId: entry.entityTypeId,
      entityId: entry.entityId,
    });
    const updatedAt = this.#now();
    const updatedAtMs = timestampMillis(updatedAt, "listEntry.updatedAt");
    return this.#settlement.commit(
      request,
      previousRevision,
      { kind: "commerce_list_entry", entry: entryRef, revision },
      { kind: "commerce_list_entry", ref: entryRef },
      "deleted",
      listEntryObservation(
        request.commandId,
        entryRef,
        entityRef,
        nextMerchantRevision(previousRevision),
      ),
      () => {
        const result = this.#database
          .prepare(
            `UPDATE commerce_list_entry SET revision = ?, lifecycle_state = 'archived', updated_at = ?, updated_at_ms = ?
           WHERE merchant_id = ? AND entry_id = ? AND revision = ? AND lifecycle_state = 'active'`,
          )
          .run(
            revision,
            updatedAt,
            updatedAtMs,
            request.merchantId,
            entry.entryId,
            entry.revision,
          );
        if (result.changes !== 1)
          throw new Error(
            "List entry changed while committing entity-plane command",
          );
      },
    );
  }

  readList(
    merchantId: string,
    listId: CommerceListId,
  ): StoredListRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT list.list_id AS listId, list.entity_type_id AS entityTypeId, list.revision,
              head.lifecycle_state AS lifecycleState, list.name, list.definition_json AS definitionJson
       FROM commerce_list AS list
       JOIN commerce_list_head AS head
         ON head.merchant_id = list.merchant_id AND head.list_id = list.list_id
        AND head.current_revision = list.revision
       WHERE list.merchant_id = ? AND list.list_id = ?`,
      )
      .get<
        Readonly<Omit<StoredListRow, "entityTypeId"> & { entityTypeId: string }>
      >(merchantId, listId);
    if (row === undefined) return undefined;
    return { ...row, entityTypeId: parseStoredEntityTypeId(row.entityTypeId) };
  }

  // The active entry that a patch or a removal names, at the revision that
  // the command names twice.
  #targetEntry(
    merchantId: string,
    target:
      | CommandRequest<"patch_commerce_list_entry">["command"]["command"]["target"]
      | CommandRequest<"remove_commerce_list_entry">["command"]["command"]["target"],
  ): StoredListEntryRow | CommerceEntityPlaneError {
    const entry = this.readEntry(merchantId, target.entry.entryId);
    if (
      entry === undefined ||
      entry.lifecycleState !== "active" ||
      entry.listId !== String(target.entry.listId)
    ) {
      return { code: "not_found" };
    }
    if (entry.revision !== Number(target.entry.revision)) {
      return {
        code: "revision_conflict",
        expected: BigInt(target.entry.revision),
        received: BigInt(entry.revision),
      };
    }
    if (entry.revision !== Number(target.expectedRevision)) {
      return {
        code: "revision_conflict",
        expected: BigInt(target.expectedRevision),
        received: BigInt(entry.revision),
      };
    }
    return entry;
  }

  readEntry(
    merchantId: string,
    entryId: CommerceListEntryId,
  ): StoredListEntryRow | undefined {
    return this.#database
      .prepare(
        `SELECT entry_id AS entryId, list_id AS listId, list_revision AS listRevision,
              entity_origin AS entityOrigin, entity_type_id AS entityTypeId,
              entity_id AS entityId, revision, lifecycle_state AS lifecycleState
       FROM commerce_list_entry WHERE merchant_id = ? AND entry_id = ?`,
      )
      .get<StoredListEntryRow>(merchantId, entryId);
  }

  hydrateEntry(merchantId: string, row: StoredListEntryRow): CommerceListEntry {
    const entityRef = parseEntityRef({
      origin: row.entityOrigin,
      typeId: row.entityTypeId,
      entityId: row.entityId,
    });
    const list = this.#readListRevision(
      merchantId,
      parsePositiveText<CommerceListId>(row.listId, "listEntry.listId"),
      row.listRevision,
    );
    if (list === undefined)
      throw new Error(`Stored list is missing: ${row.listId}`);
    const definition = parseCommerceList(JSON.parse(list.definitionJson));
    const values = this.#database
      .prepare(
        `SELECT attribute_id AS attributeId, definition_revision AS definitionRevision,
              value_kind AS valueKind, short_text_value AS shortTextValue,
              long_text_value AS longTextValue, integer_value AS integerValue,
              decimal_value AS decimalValue, boolean_value AS booleanValue,
              date_value AS dateValue, timestamp_value AS timestampValue,
              status_value AS statusValue, choice_value AS choiceValue,
              money_amount_minor AS moneyAmountMinor, money_currency AS moneyCurrency,
              merchant_operator_reference_value AS merchantOperatorReferenceValue,
              external_resource_reference_value AS externalResourceReferenceValue
       FROM commerce_list_entry_attribute_value
       WHERE merchant_id = ? AND entry_id = ? AND entry_revision = ?
       ORDER BY attribute_id`,
      )
      .all<StoredAttributeRow & Readonly<{ definitionRevision: number }>>(
        merchantId,
        row.entryId,
        row.revision,
      );
    const entry: CommerceListEntry = {
      entryId: parsePositiveText(row.entryId, "listEntry.entryId"),
      listId: parsePositiveText(row.listId, "listEntry.listId"),
      listRevision: parsePositiveRevision(
        row.listRevision,
        "listEntry.listRevision",
      ),
      entityRef,
      attributeValues: values.map((value) => {
        const attribute = definition.entryAttributeDefinitions.find(
          (entry) => entry.attributeId === value.attributeId,
        );
        if (attribute === undefined) {
          throw new Error(
            `Stored list attribute is not in the published schema: ${value.attributeId}`,
          );
        }
        if (
          Number(value.definitionRevision) !==
          Number(attribute.definition.revision)
        ) {
          throw new Error(
            `Stored list attribute revision mismatch: ${value.attributeId}`,
          );
        }
        return {
          attributeId: parsePositiveText(
            value.attributeId,
            "listEntry.attributeId",
          ),
          scope: attribute.definition.scope,
          definitionRevision: parsePositiveRevision(
            value.definitionRevision,
            "listEntry.definitionRevision",
          ),
          sensitivity: attribute.definition.sensitivity,
          value: parseAttributeValue(storedValue(value)),
        };
      }),
      revision: parsePositiveRevision(row.revision, "listEntry.revision"),
    };
    validateCommerceListEntryWithLexicon(entry, definition);
    return entry;
  }

  #readListRevision(
    merchantId: string,
    listId: CommerceListId,
    revision: number,
  ): StoredListRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT list.list_id AS listId, list.entity_type_id AS entityTypeId, list.revision,
              list.lifecycle_state AS lifecycleState, list.name, list.definition_json AS definitionJson
       FROM commerce_list AS list
       WHERE list.merchant_id = ? AND list.list_id = ? AND list.revision = ?`,
      )
      .get<
        Readonly<Omit<StoredListRow, "entityTypeId"> & { entityTypeId: string }>
      >(merchantId, listId, revision);
    if (row === undefined) return undefined;
    return { ...row, entityTypeId: parseStoredEntityTypeId(row.entityTypeId) };
  }

  #writeEntryAttributes(
    merchantId: string,
    entryId: string,
    revision: number,
    values: readonly ListEntryAttributeValue[],
  ): void {
    for (const value of values) {
      const storage = storageFields(value.value);
      this.#database
        .prepare(
          `INSERT INTO commerce_list_entry_attribute_value (
           merchant_id, entry_id, entry_revision, attribute_id,
           definition_revision, value_kind,
           short_text_value, long_text_value, integer_value, decimal_value,
           boolean_value, date_value, timestamp_value, status_value, choice_value,
           money_amount_minor, money_currency,
           merchant_operator_reference_value, external_resource_reference_value
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          merchantId,
          entryId,
          revision,
          value.attributeId,
          value.definitionRevision,
          value.value.kind,
          storage.shortText,
          storage.longText,
          storage.integer,
          storage.decimal,
          storage.boolean,
          storage.date,
          storage.timestamp,
          storage.status,
          storage.choice,
          storage.moneyAmountMinor,
          storage.moneyCurrency,
          storage.merchantOperatorReference,
          storage.externalResourceReference,
        );
    }
  }
}

function parseStoredEntityTypeId(value: string): CommerceEntityTypeId {
  return parseEntityTypeId({
    origin: isSystemEntityType(value) ? "system" : "custom",
    typeId: value,
  });
}

function sameEntityType(
  reference: CommerceEntityRef,
  typeId: CommerceEntityTypeId,
): boolean {
  return (
    reference.origin === typeId.origin && reference.typeId === typeId.typeId
  );
}

function listEntryReference(
  entryId: string,
  listId: string,
  revision: number,
): CommerceListEntryRef {
  return {
    entryId: parsePositiveText(entryId, "listEntry.entryId"),
    listId: parsePositiveText(listId, "listEntry.listId"),
    revision: parsePositiveRevision(revision, "listEntry.revision"),
  };
}

function listEntryObservation(
  observationId: import("@seams/commerce-contracts").CommerceCommandId,
  entry: CommerceListEntryRef,
  entityRef: CommerceEntityRef,
  merchantRevision: MerchantRevision,
): CommerceEntityPlaneObservationV1 {
  return {
    kind: "commerce_list_entry_changed",
    observationId,
    entry,
    entityRef,
    revision: entry.revision,
    merchantRevision,
  };
}

function nextMerchantRevision(previousRevision: number): MerchantRevision {
  return parsePositiveRevision<MerchantRevision>(
    previousRevision + 1,
    "merchantRevision",
  );
}

function timestampMillis(value: string, field: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error(`${field} must be a non-negative millisecond timestamp`);
  }
  return milliseconds;
}

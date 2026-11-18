import type {
  CommerceCommandResult,
  CommerceEntityPlaneError,
  SavedCommerceViewId,
  SavedCommerceViewRevision,
} from "@seams/commerce-contracts";
import type { CommerceDatabase } from "../database.ts";
import { entityTypeExists } from "./entities.ts";
import { CommerceLists } from "./commerce-lists.ts";
import { parsePositiveRevision } from "./parsers.ts";
import { validateSavedViewPublication } from "./query-capabilities.ts";
import {
  commandJson,
  EntityPlaneSettlement,
  type CommandRequest,
} from "./receipt-outbox-settlement.ts";

type StoredSavedViewRow = Readonly<{
  revision: number;
  lifecycleState: "draft" | "published" | "archived";
  definitionJson: string;
}>;

type SavedViewMutationsOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  settlement: EntityPlaneSettlement;
  commerceLists: CommerceLists;
}>;

export class SavedViewMutations {
  readonly #database: CommerceDatabase;
  readonly #now: () => string;
  readonly #settlement: EntityPlaneSettlement;
  readonly #commerceLists: CommerceLists;

  constructor(options: SavedViewMutationsOptions) {
    this.#database = options.database;
    this.#now = options.now;
    this.#settlement = options.settlement;
    this.#commerceLists = options.commerceLists;
  }

  publish(
    request: CommandRequest<"publish_saved_commerce_view">,
    previousRevision: number,
  ): CommerceCommandResult {
    const command = request.command.command;
    const existing = this.read(request.merchantId, command.view.viewId);
    if (
      existing !== undefined &&
      Number(command.view.revision) <= Number(existing.revision)
    ) {
      return rejected({ code: "duplicate_identity" });
    }
    if (
      existing !== undefined &&
      Number(command.view.revision) !== Number(existing.revision) + 1
    ) {
      return rejected({
        code: "revision_conflict",
        expected: BigInt(Number(existing.revision) + 1),
        received: BigInt(command.view.revision),
      });
    }
    const source = command.view.source;
    if (
      source.kind === "entity_type" &&
      !entityTypeExists(this.#database, request.merchantId, source.entityTypeId)
    ) {
      return rejected({ code: "not_found" });
    }
    if (source.kind === "commerce_list") {
      const list = this.#commerceLists.readList(
        request.merchantId,
        source.listId,
      );
      if (list === undefined || list.lifecycleState !== "published")
        return rejected({ code: "not_found" });
    }
    const validation = validateSavedViewPublication(
      this.#database,
      request.merchantId,
      command.view,
    );
    if (validation !== undefined) return rejected(validation);
    const revision = command.view.revision;
    return this.#settlement.commit(
      request,
      previousRevision,
      { kind: "saved_commerce_view", viewId: command.view.viewId, revision },
      { kind: "saved_view", viewId: command.view.viewId },
      "published",
      undefined,
      () => {
        this.#database
          .prepare(
            `INSERT INTO saved_commerce_view (
             merchant_id, view_id, revision, lifecycle_state, source_kind,
             source_id, name, presentation_kind, definition_json, created_at, updated_at
           ) VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            request.merchantId,
            command.view.viewId,
            revision,
            source.kind,
            source.kind === "entity_type"
              ? source.entityTypeId.typeId
              : source.listId,
            command.view.name,
            command.view.presentation.kind,
            commandJson(command.view),
            this.#now(),
            this.#now(),
          );
        const published = this.#database
          .prepare(
            `INSERT INTO saved_commerce_view_head (
             merchant_id, view_id, current_revision, published_revision, lifecycle_state, updated_at
           ) VALUES (?, ?, ?, ?, 'published', ?)
           ON CONFLICT (merchant_id, view_id) DO UPDATE SET
             current_revision = excluded.current_revision,
             published_revision = excluded.published_revision,
             lifecycle_state = 'published',
             updated_at = excluded.updated_at`,
          )
          .run(
            request.merchantId,
            command.view.viewId,
            revision,
            revision,
            this.#now(),
          );
        if (published.changes !== 1)
          throw new Error("Saved view publication was not written");
      },
    );
  }

  archive(
    request: CommandRequest<"archive_saved_commerce_view">,
    previousRevision: number,
  ): CommerceCommandResult {
    const command = request.command.command;
    const row = this.read(request.merchantId, command.target.viewId);
    if (row === undefined || row.lifecycleState !== "published")
      return rejected({ code: "not_found" });
    if (row.revision !== Number(command.target.expectedRevision)) {
      return rejected({
        code: "revision_conflict",
        expected: BigInt(command.target.expectedRevision),
        received: BigInt(row.revision),
      });
    }
    const revision = parsePositiveRevision<SavedCommerceViewRevision>(
      row.revision + 1,
      "savedView.revision",
    );
    return this.#settlement.commit(
      request,
      previousRevision,
      { kind: "saved_commerce_view", viewId: command.target.viewId, revision },
      { kind: "saved_view", viewId: command.target.viewId },
      "archived",
      undefined,
      () => {
        const archived = this.#database
          .prepare(
            `INSERT INTO saved_commerce_view (
             merchant_id, view_id, revision, lifecycle_state, source_kind,
             source_id, name, presentation_kind, definition_json, created_at, updated_at
           )
           SELECT merchant_id, view_id, ?, 'archived', source_kind,
                  source_id, name, presentation_kind, definition_json, created_at, ?
           FROM saved_commerce_view
           WHERE merchant_id = ? AND view_id = ? AND revision = ?`,
          )
          .run(
            revision,
            this.#now(),
            request.merchantId,
            command.target.viewId,
            row.revision,
          );
        if (archived.changes !== 1)
          throw new Error("Saved view archive revision was not written");
        const updated = this.#database
          .prepare(
            `UPDATE saved_commerce_view_head
           SET current_revision = ?, published_revision = NULL, lifecycle_state = 'archived', updated_at = ?
           WHERE merchant_id = ? AND view_id = ? AND current_revision = ?`,
          )
          .run(
            revision,
            this.#now(),
            request.merchantId,
            command.target.viewId,
            row.revision,
          );
        if (updated.changes !== 1)
          throw new Error(
            "Saved view changed while committing entity-plane command",
          );
      },
    );
  }

  read(
    merchantId: string,
    viewId: SavedCommerceViewId,
  ): StoredSavedViewRow | undefined {
    return this.#database
      .prepare(
        `SELECT view.revision, head.lifecycle_state AS lifecycleState,
              view.definition_json AS definitionJson
       FROM saved_commerce_view AS view
       JOIN saved_commerce_view_head AS head
         ON head.merchant_id = view.merchant_id AND head.view_id = view.view_id
        AND head.current_revision = view.revision
       WHERE view.merchant_id = ? AND view.view_id = ?`,
      )
      .get(merchantId, viewId);
  }
}

function rejected(error: CommerceEntityPlaneError): CommerceCommandResult {
  return { status: "rejected", error };
}

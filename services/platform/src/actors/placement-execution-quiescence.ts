// What a placement move needs of each placed Actor before it copies state:
// each Actor stops its own work, and an Actor can empty its content tables.
import type { OrganisationDatabase } from "../database-handles";
import type { FrozenOrganisationPlacementMove } from "../data/organisation-placement";
import type { Env } from "../env";
import type { Result } from "../result";
import type { ActorExportError } from "./actor-export";
import {
  listPlacementActorRegistryEntries,
  type ActorRegistryError,
} from "./actor-registry";
import { isMovedRegistryEntry } from "./actor-relocation-exclusion";
import { actorStub } from "./actor-stubs";

export function eraseActorContentSql(sql: SqlStorage): void {
  const tables = sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'
      AND name NOT IN ('state_object_activation', 'state_object_import',
        'state_object_cleanup_export_barrier', 'do_schema_meta', 'do_schema_migration')`,
    )
    .toArray();
  sql.exec("PRAGMA defer_foreign_keys = ON");
  for (const table of tables)
    sql.exec(`DELETE FROM "${table.name.replace(/"/g, '""')}"`);
}

/**
 * The namespaces of the four Actors that stop their work for a move. Each
 * Actor has its own stop method, so the types come from the bindings.
 */
export type PlacementExecutionNamespaces = Readonly<{
  organisation: Env["ORGANISATION"];
  session: Env["SESSION"];
  case: Env["CASE"];
  connector: Env["CONNECTOR"];
}>;

export async function quiescePlacementExecution(
  db: OrganisationDatabase,
  namespaces: PlacementExecutionNamespaces,
  move: FrozenOrganisationPlacementMove,
): Promise<Result<null, ActorRegistryError | ActorExportError>> {
  const entries = await listPlacementActorRegistryEntries({
    db,
    organisationId: move.organisationId,
    placementEpoch: move.source.placement.placementEpoch,
  });
  if (!entries.ok) return entries;
  for (const entry of entries.value) {
    if (!isMovedRegistryEntry(entry)) continue;
    if (entry.identity.objectKind !== "organisation") continue;
    const actor = actorStub(
      namespaces.organisation,
      entry.physicalObjectName,
      entry.placement,
    );
    const quiescent = await actor.quiesceArchiveCleanup({
      expectedFenceToken: entry.fenceToken,
    });
    if (!quiescent.ok) return quiescent;
  }
  for (const entry of entries.value) {
    if (!isMovedRegistryEntry(entry)) continue;
    if (entry.identity.objectKind !== "session") continue;
    const actor = actorStub(
      namespaces.session,
      entry.physicalObjectName,
      entry.placement,
    );
    const quiescent = await actor.quiescePortalChatCleanup({
      expectedFenceToken: entry.fenceToken,
    });
    if (!quiescent.ok) return quiescent;
  }
  for (const entry of entries.value) {
    if (!isMovedRegistryEntry(entry)) continue;
    if (entry.identity.objectKind !== "case") continue;
    const actor = actorStub(
      namespaces.case,
      entry.physicalObjectName,
      entry.placement,
    );
    const quiescent = await actor.quiesceConversationExecution({
      expectedFenceToken: entry.fenceToken,
    });
    if (!quiescent.ok) return quiescent;
  }
  for (const entry of entries.value) {
    if (!isMovedRegistryEntry(entry)) continue;
    if (entry.identity.objectKind !== "connector") continue;
    const actor = actorStub(
      namespaces.connector,
      entry.physicalObjectName,
      entry.placement,
    );
    const quiescent = await actor.quiesceExecution({
      expectedFenceToken: entry.fenceToken,
    });
    if (!quiescent.ok) return quiescent;
  }
  return { ok: true, value: null };
}

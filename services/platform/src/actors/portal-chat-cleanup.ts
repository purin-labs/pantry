import type { OrganisationDatabase } from "../database-handles";
import { isNonEmptyString, isRecord } from "@purin-labs/std";
import {
  parseSessionId,
  parseOrganisationId,
  type SessionId,
  type OrganisationId,
} from "../ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { FrozenOrganisationPlacementMove } from "../data/organisation-placement";
import type { Result } from "../result";
import {
  listPlacementActorRegistryEntries,
  type ActorFenceToken,
  type ActorRegistryError,
} from "./actor-registry";
import type { ActorExportError } from "./actor-export";
import { isMovedRegistryEntry } from "./actor-relocation-exclusion";
import { actorStub } from "./actor-stubs";
import type { Env } from "../env";

export type PortalChatCleanupRequest = Readonly<{
  requestingOrganisationId: OrganisationId;
  sessionId: SessionId;
  placement: OrganisationExecutionScope["placement"];
  placementFenceToken: OrganisationExecutionScope["fenceToken"];
  objectKeys: readonly string[];
}>;

export type PortalChatCleanupError =
  | { readonly code: "chat_cleanup_conflict" }
  | { readonly code: "chat_cleanup_failed"; readonly detail: string };

export type PortalChatErasure =
  | Readonly<{
      kind: "pending";
      organisationId: OrganisationId;
      sessionId: SessionId;
      objectKeys: readonly string[];
    }>
  | Readonly<{
      kind: "erased";
      organisationId: OrganisationId;
      sessionId: SessionId;
      objectKeys?: never;
    }>;

export const PORTAL_CHAT_ERASURE_KEY = "portal-chat-erasure";

export function canAdmitSessionWork(
  sql: SqlStorage,
  request: Pick<
    PortalChatCleanupRequest,
    "requestingOrganisationId" | "sessionId" | "placement"
  >,
): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM state_object_activation
      WHERE singleton = 1 AND organisation_id = ? AND object_kind = 'session'
        AND logical_object_id = ? AND placement_epoch = ? AND placement_cell_id = ?
        AND NOT EXISTS (SELECT 1 FROM state_object_cleanup_export_barrier)`,
        request.requestingOrganisationId,
        request.sessionId,
        request.placement.placementEpoch,
        request.placement.placementCellId,
      )
      .toArray().length === 1
  );
}

export async function isPortalChatCleanupPlacementActive(
  db: D1Database,
  request: PortalChatCleanupRequest,
): Promise<boolean> {
  return (
    (await db
      .withSession("first-primary")
      .prepare(
        `SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ?
      AND placement_cell_id = ? AND fence_token = ? AND status = 'active'`,
      )
      .bind(
        request.requestingOrganisationId,
        request.placement.placementEpoch,
        request.placement.placementCellId,
        request.placementFenceToken,
      )
      .first()) !== null
  );
}

export function closePortalChatCleanupAdmission(
  sql: SqlStorage,
  expectedFenceToken: ActorFenceToken,
): Result<
  { organisationId: OrganisationId; sessionId: SessionId },
  ActorExportError
> {
  const row = sql
    .exec(
      "SELECT organisation_id, logical_object_id, fence_token, object_kind FROM state_object_activation WHERE singleton = 1",
    )
    .toArray()[0];
  if (row === undefined)
    return { ok: false, error: { code: "actor_not_activated" } };
  if (row.fence_token !== expectedFenceToken)
    return { ok: false, error: { code: "actor_fence_mismatch" } };
  if (
    typeof row.organisation_id !== "string" ||
    typeof row.logical_object_id !== "string"
  )
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  const organisation = parseOrganisationId(row.organisation_id);
  const session = parseSessionId(row.logical_object_id);
  if (row.object_kind !== "session" || !organisation.ok || !session.ok)
    return { ok: false, error: { code: "export_manifest_corrupt" } };
  sql.exec(
    "INSERT OR IGNORE INTO state_object_cleanup_export_barrier (singleton) VALUES (1)",
  );
  return {
    ok: true,
    value: { organisationId: organisation.value, sessionId: session.value },
  };
}

export async function readPortalChatErasure(
  storage: DurableObjectStorage,
): Promise<PortalChatErasure | null> {
  const raw = await storage.get<unknown>(PORTAL_CHAT_ERASURE_KEY);
  if (raw === undefined) return null;
  if (
    !isRecord(raw) ||
    typeof raw.organisationId !== "string" ||
    typeof raw.sessionId !== "string"
  )
    throw new Error("portal_chat_erasure_invalid");
  const organisation = parseOrganisationId(raw.organisationId);
  const session = parseSessionId(raw.sessionId);
  if (!organisation.ok || !session.ok)
    throw new Error("portal_chat_erasure_invalid");
  switch (raw.kind) {
    case "pending": {
      if (!Array.isArray(raw.objectKeys))
        throw new Error("portal_chat_erasure_invalid");
      const objectKeys: string[] = [];
      for (const key of raw.objectKeys) {
        if (!isNonEmptyString(key))
          throw new Error("portal_chat_erasure_invalid");
        objectKeys.push(key);
      }
      return {
        kind: "pending",
        organisationId: organisation.value,
        sessionId: session.value,
        objectKeys,
      };
    }
    case "erased":
      if (raw.objectKeys !== undefined)
        throw new Error("portal_chat_erasure_invalid");
      return {
        kind: "erased",
        organisationId: organisation.value,
        sessionId: session.value,
      };
    default:
      throw new Error("portal_chat_erasure_invalid");
  }
}

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

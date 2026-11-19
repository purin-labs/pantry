/**
 * A quarantined Actor does not block a relocation of its Organisation
 * (Refactor 15, refactor 5). The relocation leaves it out: its state is not
 * exported, and its registry entry stays quarantined at the source epoch. The
 * relocation journal keeps one operator receipt for each Actor that it left
 * out, with the quarantine time and reason, in
 * `state_object_relocation_exclusion`. The admin inspection of the relocation
 * shows the receipts. A new request for the same identity at the target gets
 * a new Actor, as after the operator's discard of a quarantined Actor.
 */
import type { GlobalDatabase } from "../database-handles";
import { newRequestId } from "../ids";
import { traceWarn } from "../observability";
import {
  parseActorRegistryId,
  type ActorRegistryEntry,
} from "./actor-registry";
import type { VariantBy } from "@purin-labs/type-utils";
import { isNonEmptyString, isNonNegativeInteger } from "@purin-labs/std";

type QuarantinedRegistryEntry = VariantBy<
  ActorRegistryEntry,
  "lifecycleStatus",
  "quarantined"
>;

export type ActorRelocationExclusion = Readonly<{
  sourceRegistryId: ActorRegistryEntry["registryId"];
  objectKind: ActorRegistryEntry["identity"]["objectKind"];
  logicalObjectId: string;
  quarantinedAt: number;
  quarantineReason: string;
  excludedAt: number;
}>;

/** True for an entry that a relocation moves: neither retired nor quarantined. */
export function isMovedRegistryEntry(entry: ActorRegistryEntry): boolean {
  return (
    entry.lifecycleStatus !== "retired" &&
    entry.lifecycleStatus !== "quarantined"
  );
}

function isQuarantinedRegistryEntry(
  entry: ActorRegistryEntry,
): entry is QuarantinedRegistryEntry {
  return entry.lifecycleStatus === "quarantined";
}

/**
 * The statements that record the receipts of the quarantined entries, while
 * the relocation has not quiesced its source. An entry that was active at
 * the start and is quarantined now loses its pending item in the same batch,
 * so the inventory still matches.
 */
export function prepareRelocationExclusions(
  directory: GlobalDatabase,
  relocationId: string,
  entries: readonly ActorRegistryEntry[],
  now: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const entry of entries) {
    if (!isQuarantinedRegistryEntry(entry)) continue;
    statements.push(
      directory
        .prepare(
          `INSERT OR IGNORE INTO state_object_relocation_exclusion (
             relocation_id, source_registry_id, object_kind, logical_object_id,
             quarantined_at, quarantine_reason, excluded_at
           ) SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM state_object_relocation
             WHERE relocation_id = ? AND status IN ('reserved', 'frozen')
               AND source_quiesced_at IS NULL)`,
        )
        .bind(
          relocationId,
          entry.registryId,
          entry.identity.objectKind,
          entry.identity.logicalObjectId,
          entry.quarantinedAt,
          entry.quarantineReason,
          now,
          relocationId,
        ),
      directory
        .prepare(
          `DELETE FROM state_object_relocation_item
           WHERE relocation_id = ? AND source_registry_id = ? AND status = 'pending'
             AND EXISTS (SELECT 1 FROM state_object_relocation
               WHERE relocation_id = ? AND status IN ('reserved', 'frozen')
                 AND source_quiesced_at IS NULL)`,
        )
        .bind(relocationId, entry.registryId, relocationId),
    );
  }
  return statements;
}

type ExclusionRow = Readonly<Record<keyof ActorRelocationExclusion, unknown>>;

/** The receipts of one relocation; null when a stored receipt is damaged. */
export async function readRelocationExclusions(
  directory: GlobalDatabase,
  relocationId: string,
): Promise<readonly ActorRelocationExclusion[] | null> {
  const rows = await directory
    .prepare(
      `SELECT source_registry_id AS sourceRegistryId, object_kind AS objectKind,
         logical_object_id AS logicalObjectId, quarantined_at AS quarantinedAt,
         quarantine_reason AS quarantineReason, excluded_at AS excludedAt
       FROM state_object_relocation_exclusion
       WHERE relocation_id = ?
       ORDER BY object_kind, logical_object_id`,
    )
    .bind(relocationId)
    .all<ExclusionRow>();
  const exclusions: ActorRelocationExclusion[] = [];
  for (const row of rows.results) {
    const registryId = parseActorRegistryId(row.sourceRegistryId);
    if (
      !registryId.ok ||
      !isActorObjectKind(row.objectKind) ||
      !isNonEmptyString(row.logicalObjectId) ||
      !isNonNegativeInteger(row.quarantinedAt) ||
      !isNonEmptyString(row.quarantineReason) ||
      !isNonNegativeInteger(row.excludedAt)
    )
      return null;
    exclusions.push({
      sourceRegistryId: registryId.value,
      objectKind: row.objectKind,
      logicalObjectId: row.logicalObjectId,
      quarantinedAt: row.quarantinedAt,
      quarantineReason: row.quarantineReason,
      excludedAt: row.excludedAt,
    });
  }
  return exclusions;
}

function isActorObjectKind(
  value: unknown,
): value is ActorRelocationExclusion["objectKind"] {
  return (
    value === "organisation" ||
    value === "session" ||
    value === "case" ||
    value === "connector"
  );
}

export function warnRelocationExclusions(
  organisationId: string,
  relocationId: string,
  entries: readonly ActorRegistryEntry[],
): void {
  for (const entry of entries) {
    if (!isQuarantinedRegistryEntry(entry)) continue;
    traceWarn("organisation.relocation_actor_excluded", {
      requestId: newRequestId(),
      organisation_id: organisationId,
      relocation_id: relocationId,
      object_kind: entry.identity.objectKind,
      quarantine_reason: entry.quarantineReason,
    });
  }
}

import type { Env } from "../env";
import type { OrganisationId } from "../ids";
import { memoryService } from "../memory/contract/memory-service";
import { type ShownMemoryRevision } from "../memory/contract/turn-memory";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";

/**
 * The Memory revisions the model of a reply turn was shown, kept with the
 * reply it drafted. They are identities only. A reply is previewed and sent
 * later than it was drafted, and it may be relied on only while each of
 * those revisions is still in force.
 */
export function createEmailProposalMemorySchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS email_proposal_memory (
    proposal_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    PRIMARY KEY (proposal_id, memory_id)
  )`);
}

/** Keeps what the turn was shown. A repeat of the same turn keeps the first. */
export function recordEmailProposalMemory(
  sql: SqlStorage,
  proposalId: string,
  shown: readonly ShownMemoryRevision[],
): void {
  for (const revision of shown)
    sql.exec(
      `INSERT INTO email_proposal_memory (proposal_id, memory_id, revision)
       VALUES (?, ?, ?) ON CONFLICT (proposal_id, memory_id) DO NOTHING`,
      proposalId,
      revision.memoryId,
      revision.revision,
    );
}

export function readEmailProposalMemory(
  sql: SqlStorage,
  proposalId: string,
): readonly ShownMemoryRevision[] {
  return sql
    .exec<{ memory_id: string; revision: number }>(
      `SELECT memory_id, revision FROM email_proposal_memory
       WHERE proposal_id = ? ORDER BY memory_id`,
      proposalId,
    )
    .toArray()
    .map((row) => ({ memoryId: row.memory_id, revision: row.revision }));
}

/** Removes the record of a proposal whose turn is to run afresh. */
export function clearEmailProposalMemory(
  sql: SqlStorage,
  proposalId: string,
): void {
  sql.exec(
    "DELETE FROM email_proposal_memory WHERE proposal_id = ?",
    proposalId,
  );
}

/**
 * Whether a reply may still be relied on, as far as the Memory its turn was
 * shown goes. A revision that was revoked or replaced, that no longer holds
 * today, or whose evidence no longer stands has changed, and the reply needs
 * a fresh turn. A lookup that failed is not a finding either way.
 */
export async function emailProposalMemoryStanding(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    sql: SqlStorage;
    organisationId: OrganisationId;
    proposalId: string;
    now: number;
  }>,
): Promise<"in_force" | "changed" | "unavailable"> {
  const shown = readEmailProposalMemory(input.sql, input.proposalId);
  if (shown.length === 0) return "in_force";
  return memoryService.use().readShownMemoryStanding({
    env: input.env,
    execution: input.scope,
    organisationId: input.organisationId,
    revisions: shown,
    now: input.now,
  });
}

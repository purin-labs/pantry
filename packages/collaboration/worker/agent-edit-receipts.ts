import { addMissingColumn } from "@purin-labs/actor-runtime/actors/schema-migrations";

/**
 * The receipt of an agent's edit of a shared draft answers a retry of the
 * same operation with the first result. A retry comes within minutes, so a
 * receipt answers for 7 days. The write of a new receipt deletes the older
 * ones: no alarm runs, and a draft that nobody edits writes nothing.
 */
const AGENT_EDIT_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Adds the time of each receipt to a receipt table from before the
 * retention. A receipt from before has no time and counts as older than
 * 7 days.
 */
export function addAgentEditReceiptTime(sql: SqlStorage, table: string): void {
  addMissingColumn(sql, table, "created_at", "INTEGER");
}

/** The oldest time of a receipt that still answers a retry at `now`. */
export function oldestAnsweringReceiptAt(now: number): number {
  return now - AGENT_EDIT_RECEIPT_RETENTION_MS;
}

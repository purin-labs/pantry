import type {
  EmbeddedHarnessModelUsage,
  HarnessTurnLease,
} from "@purin-labs/contracts";
import { parseJsonOrNull } from "@purin-labs/std";
import { parseModelUsage } from "./harness-history";

export function createPiUsageSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS satyr_pi_usage (
    runtime_generation INTEGER PRIMARY KEY,
    turn_id TEXT NOT NULL,
    usage_json TEXT NOT NULL
  )`);
}
export function savePiUsage(
  sql: SqlStorage,
  lease: HarnessTurnLease,
  usage: EmbeddedHarnessModelUsage,
): void {
  sql.exec(
    `INSERT INTO satyr_pi_usage (runtime_generation, turn_id, usage_json) VALUES (?, ?, ?)
    ON CONFLICT (runtime_generation) DO UPDATE SET usage_json = excluded.usage_json`,
    lease.runtimeLease.generation,
    lease.turn.turnId,
    JSON.stringify(usage),
  );
}
export function readPiUsage(
  sql: SqlStorage,
  lease: HarnessTurnLease,
): EmbeddedHarnessModelUsage | null {
  const row = sql
    .exec<{ usage_json: string }>(
      "SELECT usage_json FROM satyr_pi_usage WHERE runtime_generation = ? AND turn_id = ?",
      lease.runtimeLease.generation,
      lease.turn.turnId,
    )
    .toArray()[0];
  return row === undefined
    ? null
    : parseModelUsage(parseJsonOrNull(row.usage_json));
}

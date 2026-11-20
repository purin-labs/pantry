import type {
  BakeAuthorityMode,
  BakeRunState,
} from "@purin-labs/kitchen-control-api";
import type { OrganisationDatabase } from "../../database-handles";
import type { OrganisationId } from "../../ids";
import type { BakeDeciderRole } from "./records";

/**
 * The summary row of each bake run (Plan 24 S4). This module is the one
 * writer of `bake_run`. The run's Durable Object holds the engine state and
 * the dispatch records; it writes this row only when the run's state
 * changes, so a run that waits for a receipt writes nothing here.
 */

export type BakeRunSummary = Readonly<{
  runId: string;
  proposalId: string;
  actorId: string | null;
  mode: BakeAuthorityMode;
  state: BakeRunState;
  problem: Readonly<{ code: string; message: string }> | null;
  holdCode: string | null;
  startedAt: number | null;
  endedAt: number | null;
  check: Readonly<{
    by: string;
    role: BakeDeciderRole;
    at: number;
    goodPieces: number;
    receiptId: string;
  }> | null;
}>;

type RunRow = Readonly<{
  run_id: string;
  proposal_id: string;
  actor_id: string | null;
  mode: BakeAuthorityMode;
  state: BakeRunState;
  problem_code: string | null;
  problem_text: string | null;
  hold_code: string | null;
  started_at: number | null;
  ended_at: number | null;
  checked_by: string | null;
  checked_role: BakeDeciderRole | null;
  checked_at: number | null;
  good_pieces: number | null;
  stock_receipt_id: string | null;
}>;

const COLUMNS = `run_id, proposal_id, actor_id, mode, state, problem_code,
  problem_text, hold_code, started_at, ended_at, checked_by, checked_role,
  checked_at, good_pieces, stock_receipt_id`;

function fromRow(row: RunRow): BakeRunSummary {
  return {
    runId: row.run_id,
    proposalId: row.proposal_id,
    actorId: row.actor_id,
    mode: row.mode,
    state: row.state,
    problem:
      row.problem_code === null
        ? null
        : { code: row.problem_code, message: row.problem_text ?? "" },
    holdCode: row.hold_code,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    check:
      row.checked_at === null ||
      row.checked_by === null ||
      row.checked_role === null ||
      row.good_pieces === null ||
      row.stock_receipt_id === null
        ? null
        : {
            by: row.checked_by,
            role: row.checked_role,
            at: row.checked_at,
            goodPieces: row.good_pieces,
            receiptId: row.stock_receipt_id,
          },
  };
}

/** One run for each proposal: the run's id is the proposal's id. */
export function bakeRunIdOf(proposalId: string): string {
  return proposalId;
}

export async function readBakeRun(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  runId: string,
): Promise<BakeRunSummary | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM bake_run WHERE organisation_id = ? AND run_id = ?`,
    )
    .bind(organisationId, runId)
    .first<RunRow>();
  return row === null ? null : fromRow(row);
}

export async function listBakeRuns(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<readonly BakeRunSummary[]> {
  const rows = await db
    .prepare(
      `SELECT ${COLUMNS} FROM bake_run WHERE organisation_id = ?
        ORDER BY updated_at DESC LIMIT 200`,
    )
    .bind(organisationId)
    .all<RunRow>();
  return rows.results.map(fromRow);
}

/** The run did not start; the proposal shows the reason. */
export async function writeBakeRunNotStarted(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  input: Readonly<{
    runId: string;
    proposalId: string;
    mode: BakeAuthorityMode;
    code: string;
    message: string;
    now: number;
  }>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bake_run (run_id, organisation_id, proposal_id, mode, state,
         problem_code, problem_text, updated_at)
       VALUES (?, ?, ?, ?, 'not_started', ?, ?, ?)
       ON CONFLICT (run_id) DO UPDATE SET
         mode = excluded.mode,
         problem_code = excluded.problem_code,
         problem_text = excluded.problem_text,
         updated_at = excluded.updated_at
       WHERE bake_run.state = 'not_started'`,
    )
    .bind(
      input.runId,
      organisationId,
      input.proposalId,
      input.mode,
      input.code,
      input.message.slice(0, 500),
      input.now,
    )
    .run();
}

/** The run's Durable Object accepted the run. */
export async function writeBakeRunStarted(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  input: Readonly<{
    runId: string;
    proposalId: string;
    actorId: string;
    mode: BakeAuthorityMode;
    now: number;
  }>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bake_run (run_id, organisation_id, proposal_id, actor_id,
         mode, state, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
       ON CONFLICT (run_id) DO UPDATE SET
         actor_id = excluded.actor_id, mode = excluded.mode,
         state = 'running', problem_code = NULL,
         problem_text = NULL, started_at = excluded.started_at,
         updated_at = excluded.updated_at
       WHERE bake_run.state = 'not_started'`,
    )
    .bind(
      input.runId,
      organisationId,
      input.proposalId,
      input.actorId,
      input.mode,
      input.now,
      input.now,
    )
    .run();
}

/** A change of the run's state; the same state writes nothing. */
export async function writeBakeRunState(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  input: Readonly<{
    runId: string;
    state: Exclude<BakeRunState, "not_started" | "checked">;
    holdCode: string | null;
    endedAt: number | null;
    now: number;
  }>,
): Promise<void> {
  await db
    .prepare(
      `UPDATE bake_run SET state = ?, hold_code = ?, ended_at = ?, updated_at = ?
        WHERE organisation_id = ? AND run_id = ?
          AND state NOT IN ('not_started', 'checked')
          AND (state != ? OR hold_code IS NOT ?)`,
    )
    .bind(
      input.state,
      input.holdCode,
      input.endedAt,
      input.now,
      organisationId,
      input.runId,
      input.state,
      input.holdCode,
    )
    .run();
}

/** The person's check of the released pieces, once, after the run ended. */
export async function writeBakeRunCheck(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  input: Readonly<{
    runId: string;
    by: string;
    role: BakeDeciderRole;
    goodPieces: number;
    receiptId: string;
    now: number;
  }>,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE bake_run SET state = 'checked', checked_by = ?, checked_role = ?,
         checked_at = ?, good_pieces = ?, stock_receipt_id = ?, updated_at = ?
        WHERE organisation_id = ? AND run_id = ? AND state = 'completed'`,
    )
    .bind(
      input.by,
      input.role,
      input.now,
      input.goodPieces,
      input.receiptId,
      input.now,
      organisationId,
      input.runId,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

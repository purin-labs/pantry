import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  parseTerminalAssignment,
  terminalTargetDeviceId,
  type TerminalAssignment,
  type TerminalRetirementReason,
} from "@purin-labs/commerce-contracts";

import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";

/**
 * Which terminal a Pantry location currently sells through.
 *
 * Retired revisions are kept rather than deleted. An attempt dispatched under
 * an earlier revision still needs its binding to reconcile, so replacing a
 * terminal must not orphan a collection that is still unresolved — and the
 * operator surface has to be able to explain what a payment was taken on.
 */
type TerminalAssignmentError = Readonly<{
  code:
    | "terminal_assignment_not_found"
    | "terminal_assignment_corrupt"
    | "terminal_assignment_conflict";
}>;

/** The assignment a Pantry location currently sells through, if any. */
export async function readActiveTerminalAssignment(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  pantryLocationId: string,
): Promise<Result<TerminalAssignment, TerminalAssignmentError>> {
  const row = await db
    .prepare(
      `SELECT assignment_json AS assignmentJson
     FROM cafe_terminal_assignment
     WHERE organisation_id = ? AND pantry_location_id = ? AND state = 'active'`,
    )
    .bind(organisationId, pantryLocationId)
    .first<Readonly<{ assignmentJson: string }>>();
  return row === null
    ? { ok: false, error: { code: "terminal_assignment_not_found" } }
    : parseStoredAssignment(row.assignmentJson);
}

/**
 * Every location this organisation currently sells card-present through.
 *
 * The operator surface lists counters, not one counter: a merchant with three
 * tills needs to see which of them can take a payment, and a corrupt row must
 * not hide the other two.
 */
export async function listActiveTerminalAssignments(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<readonly Result<TerminalAssignment, TerminalAssignmentError>[]> {
  const rows = await db
    .prepare(
      `SELECT assignment_json AS assignmentJson
     FROM cafe_terminal_assignment
     WHERE organisation_id = ? AND state = 'active'
     ORDER BY pantry_location_id ASC`,
    )
    .bind(organisationId)
    .all<Readonly<{ assignmentJson: string }>>();
  return (rows.results ?? []).map((row) =>
    parseStoredAssignment(row.assignmentJson),
  );
}

/**
 * One exact revision.
 *
 * Recovery reads the revision an attempt was dispatched under, not whatever is
 * active now — otherwise replacing a terminal would silently re-point an
 * in-flight collection at different hardware.
 */
export async function readTerminalAssignmentRevision(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  assignmentId: string,
  revision: number,
): Promise<Result<TerminalAssignment, TerminalAssignmentError>> {
  const row = await db
    .prepare(
      `SELECT assignment_json AS assignmentJson
     FROM cafe_terminal_assignment
     WHERE organisation_id = ? AND assignment_id = ? AND revision = ?`,
    )
    .bind(organisationId, assignmentId, revision)
    .first<Readonly<{ assignmentJson: string }>>();
  return row === null
    ? { ok: false, error: { code: "terminal_assignment_not_found" } }
    : parseStoredAssignment(row.assignmentJson);
}

/**
 * Activate an assignment for its Pantry location, retiring whatever that
 * location was selling through.
 *
 * Retirement and activation happen together so the location is never briefly
 * bound to two terminals, and never to none.
 */
export async function activateTerminalAssignment(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    assignment: TerminalAssignment;
    now: number;
  }>,
): Promise<Result<TerminalAssignment, TerminalAssignmentError>> {
  const { assignment } = input;
  if (assignment.state.kind !== "active") {
    return { ok: false, error: { code: "terminal_assignment_conflict" } };
  }
  const statements = [
    input.db
      .prepare(
        `UPDATE cafe_terminal_assignment
       SET state = 'retired',
           assignment_json = json_set(assignment_json, '$.state', json(?))
       WHERE organisation_id = ? AND pantry_location_id = ? AND state = 'active'
         AND assignment_id <> ?`,
      )
      .bind(
        retiredState("replaced", input.now),
        input.organisationId,
        assignment.pantryLocationId,
        assignment.assignmentId,
      ),
    input.db
      .prepare(
        `INSERT INTO cafe_terminal_assignment (
         organisation_id, assignment_id, merchant_id, pantry_location_id,
         provider_location_id, device_id, target_kind, environment,
         revision, state, assignment_json, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT (organisation_id, assignment_id, revision) DO UPDATE SET
         state = 'active',
         assignment_json = excluded.assignment_json`,
      )
      .bind(
        input.organisationId,
        assignment.assignmentId,
        assignment.merchantId,
        assignment.pantryLocationId,
        assignment.providerLocationId,
        terminalTargetDeviceId(assignment.target),
        assignment.target.kind,
        assignment.account.environment,
        assignment.revision,
        JSON.stringify(assignment),
        input.now,
      ),
  ];
  // One batch so a location is never left with two active assignments, or none.
  await input.db.batch(statements);
  return readActiveTerminalAssignment(
    input.db,
    input.organisationId,
    assignment.pantryLocationId,
  );
}

/**
 * Retire a location's assignment without replacing it.
 *
 * The location stops taking card-present payments. A Square attempt keeps its
 * own binding and stays recoverable. A LAN collection needs the active
 * assignment, so `retireCounterTerminal` refuses while one is unresolved.
 */
export async function retireTerminalAssignment(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    assignmentId: string;
    revision: number;
    reason: TerminalRetirementReason;
    now: number;
  }>,
): Promise<boolean> {
  const result = await input.db
    .prepare(
      `UPDATE cafe_terminal_assignment
     SET state = 'retired',
         assignment_json = json_set(assignment_json, '$.state', json(?))
     WHERE organisation_id = ? AND assignment_id = ? AND revision = ? AND state = 'active'`,
    )
    .bind(
      retiredState(input.reason, input.now),
      input.organisationId,
      input.assignmentId,
      input.revision,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * The retired state, written into the stored assignment rather than only into
 * the row's state column.
 *
 * Both have to move together. Recovery reads an exact revision without
 * filtering on the column, so an assignment whose JSON still says "active"
 * would hand out payment authority the operator has already withdrawn.
 */
function retiredState(reason: TerminalRetirementReason, now: number): string {
  return JSON.stringify({
    kind: "retired",
    reason,
    retiredAt: new Date(now).toISOString(),
  });
}

function parseStoredAssignment(
  raw: string,
): Result<TerminalAssignment, TerminalAssignmentError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "terminal_assignment_corrupt" } };
  }
  const parsed = parseTerminalAssignment(decoded);
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, error: { code: "terminal_assignment_corrupt" } };
}

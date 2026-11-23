import { readConversationExecution } from "../chat/execution";
import { readCommerceApproval, readMeta } from "./case/context-source";
import { parseLifecycle } from "./case/record-parsers";
import type { AlarmReconciler } from "@purin-labs/actor-runtime/actors/lifecycle/actor-alarm";
import { nextUndeliveredOutputAt } from "./case/outputs";
import { ASSIGNMENT_ABANDON_AFTER_MS } from "./case/assignment.machine";
import { APPROVAL_READ_LATER_MS } from "./case/approval-wait.machine";
import { activeAssignmentTimes } from "./case/lifecycle";

/** How often a Case retries work that waits. */
const CASE_RECOVERY_INTERVAL_MS = 15_000;

/**
 * How often a Case that waits for an approval reads the action ledger: each
 * minute for the first ten minutes, then each quarter hour. A route that
 * decides an action tells the Case at once; this read ends a wait whose
 * update was lost (Refactor 15, refactor 1).
 */
const APPROVAL_READ_FIRST_MS = 60_000;
const APPROVAL_READ_FIRST_WINDOW_MS = 10 * 60_000;
/** The most approval waits that one alarm reads from the ledger. */
const APPROVAL_READ_PAGE = 10;

/**
 * The Case's alarm reconcilers. Each one retries its stored work every
 * CASE_RECOVERY_INTERVAL_MS while the work waits.
 */
export function caseAlarmReconcilers(
  sql: SqlStorage,
): readonly AlarmReconciler[] {
  return [
    {
      name: "context_projections",
      nextDue: (now) =>
        hasPendingContextProjections(sql)
          ? now + CASE_RECOVERY_INTERVAL_MS
          : null,
    },
    {
      name: "commerce_approval_wait",
      nextDue: (now) => commerceApprovalWaitDue(sql, now),
    },
    {
      name: "undelivered_outputs",
      nextDue: () => nextUndeliveredOutputAt(sql),
    },
    {
      name: "abandoned_assignments",
      nextDue: (now) => abandonedAssignmentDue(sql, now),
    },
    {
      name: "conversation",
      nextDue: (now) =>
        readConversationExecution(sql) === null
          ? null
          : now + CASE_RECOVERY_INTERVAL_MS,
    },
  ];
}

function hasPendingContextProjections(sql: SqlStorage): boolean {
  return (
    sql.exec("SELECT 1 FROM case_context_projection_outbox LIMIT 1").toArray()
      .length > 0
  );
}

/**
 * When the oldest active assignment may be abandoned. One that is already
 * old waits for a Session that still runs a turn: it is read again after
 * the same wait.
 */
function abandonedAssignmentDue(sql: SqlStorage, now: number): number | null {
  const due = oldestAssignmentAbandonAt(sql);
  if (due === null) return null;
  return due > now ? due : now + ASSIGNMENT_ABANDON_AFTER_MS;
}

/**
 * When the oldest active assignment becomes old enough to abandon, or null
 * when the Case has none. The time can be in the past.
 */
function oldestAssignmentAbandonAt(sql: SqlStorage): number | null {
  const times = activeAssignmentTimes(sql);
  if (times.length === 0) return null;
  return Math.min(...times) + ASSIGNMENT_ABANDON_AFTER_MS;
}

/**
 * The next ledger read of the approvals that the Case holds open, if any:
 * the one that the Case waits for, and each waiting approval that the Case
 * no longer waits for, as after the Case was archived during the wait.
 */
function commerceApprovalWaitDue(sql: SqlStorage, now: number): number | null {
  const requested = openCommerceApprovals(sql, now).map(
    (approval) => approval.requestedAt,
  );
  if (requested.length === 0) return null;
  return (
    now +
    (requested.some((at) => now - at < APPROVAL_READ_FIRST_WINDOW_MS)
      ? APPROVAL_READ_FIRST_MS
      : APPROVAL_READ_LATER_MS)
  );
}

/** The action nonces of the approvals that the next ledger read reads. */
export function commerceApprovalsToRead(sql: SqlStorage): readonly string[] {
  return openCommerceApprovals(sql, Date.now()).map(
    (approval) => approval.actionNonce,
  );
}

/**
 * The approval that the Case waits for first, then the other waiting
 * approval records, oldest first, up to one page. A wait whose record is
 * missing reads as requested now.
 */
function openCommerceApprovals(
  sql: SqlStorage,
  now: number,
): readonly Readonly<{ actionNonce: string; requestedAt: number }>[] {
  const meta = readMeta(sql);
  const lifecycle = meta === null ? null : parseLifecycle(meta.lifecycle_json);
  const waitedFor =
    lifecycle?.kind === "waiting" && lifecycle.wait.kind === "approval"
      ? String(lifecycle.wait.approvalRequestId)
      : null;
  const open: { actionNonce: string; requestedAt: number }[] = [];
  if (waitedFor !== null)
    open.push({
      actionNonce: waitedFor,
      requestedAt:
        readCommerceApproval(sql, waitedFor)?.request.requestedAt ?? now,
    });
  const waiting = sql
    .exec<{ actionNonce: string; requestedAt: number | null }>(
      `SELECT action_nonce AS actionNonce,
              json_extract(payload, '$.request.requestedAt') AS requestedAt
       FROM case_commerce_approval
       WHERE json_extract(payload, '$.kind') = 'waiting'
       ORDER BY requestedAt
       LIMIT ?`,
      APPROVAL_READ_PAGE,
    )
    .toArray();
  for (const row of waiting)
    if (row.actionNonce !== waitedFor && open.length < APPROVAL_READ_PAGE)
      open.push({
        actionNonce: row.actionNonce,
        requestedAt: typeof row.requestedAt === "number" ? row.requestedAt : 0,
      });
  return open;
}

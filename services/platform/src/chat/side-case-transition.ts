/**
 * The one writer of `side_case_proposal.status` (Refactor 15). The Portal
 * start and dismissal and the Slack start move a proposal only through
 * `writeSideCaseTransition`, which checks the move against
 * `SIDE_CASE_MACHINE` and writes it as a compare-and-set on the claim that
 * the caller read.
 *
 * A start holds a lease of `SIDE_CASE_START_LEASE_MS` from its claim. While
 * the lease holds, only the person who clicked Start continues it. When the
 * lease ends, the proposal reads as open again (or as expired after
 * `expires_at`): another person may start it, and in the Portal a person may
 * dismiss it. The person who clicked first still continues their own claim
 * until another claim replaces it. No alarm writes the release; the next
 * claim or dismissal writes over the lapsed start.
 */
import {
  machineTransition,
  type MachineState,
} from "@seams/std/state-machine";

import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Result } from "../result";
import { SIDE_CASE_MACHINE } from "./side-case.machine";

/** A start that did not finish in ten minutes lets go of its proposal. */
export const SIDE_CASE_START_LEASE_MS = 10 * 60 * 1000;

type SideCasePhase = MachineState<typeof SIDE_CASE_MACHINE>;

type SideCaseSource = "portal_chat" | "slack_thread";

/** The fields of a stored proposal that decide its phase. */
type SideCaseRecord = Readonly<{
  proposalId: string;
  status: "open" | "starting" | "started" | "dismissed";
  decidedByUserId: string | null;
  decidedAt: number | null;
  expiresAt: number;
}>;

type SideCaseMove =
  | Readonly<{
      event: "claim";
      userId: string;
      /** The Slack account of the person; null for a Portal start. */
      slackUserId: string | null;
      /**
       * The new chat of a Portal start. A Slack start keeps the thread that
       * an earlier claim posted, so its destination is recorded later.
       */
      destination: Readonly<{ conversationId: string; caseId: string }> | null;
    }>
  | Readonly<{ event: "start" }>
  | Readonly<{ event: "dismiss"; userId: string }>;

type SideCaseTransitionError =
  | "side_case_transition_invalid"
  /** The row changed since the caller read it; read it again and decide. */
  | "side_case_transition_stale"
  | "side_case_placement_conflict";

/** The phase of a proposal at `now`, with the two read-time rules applied. */
export function sideCasePhase(
  record: SideCaseRecord,
  now: number,
): SideCasePhase {
  let phase: SideCasePhase = record.status;
  if (phase === "starting") {
    const released = machineTransition(SIDE_CASE_MACHINE, phase, "release", {
      start_lease_ended: () => startLeaseEnded(record, now),
    });
    if (released.allowed) phase = released.to;
  }
  if (phase === "open") {
    const expired = machineTransition(SIDE_CASE_MACHINE, phase, "expire", {
      lifetime_ended: () => record.expiresAt <= now,
    });
    if (expired.allowed) phase = expired.to;
  }
  return phase;
}

/**
 * True when this person clicks Start on their own claim: the click continues
 * that claim and writes nothing, so a repeated start keeps the claim's time
 * and queues the same work.
 */
export function continuesOwnClaim(
  record: SideCaseRecord,
  userId: string,
): boolean {
  return record.status === "starting" && record.decidedByUserId === userId;
}

/** Writes one move of a proposal, checked against its machine. */
export async function writeSideCaseTransition(
  execution: OrganisationExecutionScope,
  source: SideCaseSource,
  record: SideCaseRecord,
  move: SideCaseMove,
  now: number,
): Promise<Result<SideCasePhase, SideCaseTransitionError>> {
  // A start that finishes after its lease, before another claim replaced
  // it, is still the start of its claim: the compare-and-set proves that.
  const phase =
    move.event === "start" ? record.status : sideCasePhase(record, now);
  const allowed = machineTransition(SIDE_CASE_MACHINE, phase, move.event);
  if (!allowed.allowed)
    return { ok: false, error: "side_case_transition_invalid" };
  const change = changeOf(source, move, now);
  const written = await execution.database
    .prepare(
      `UPDATE side_case_proposal SET ${change.set}
        WHERE organisation_id = ? AND proposal_id = ? AND source_kind = ?
          AND status = ? AND decided_by_user_id IS ? AND decided_at IS ?
          ${move.event === "start" ? "" : "AND expires_at > ?"}
          AND ${ACTIVE_PLACEMENT}`,
    )
    .bind(
      ...change.values,
      execution.organisationId,
      record.proposalId,
      source,
      record.status,
      record.decidedByUserId,
      record.decidedAt,
      ...(move.event === "start" ? [] : [now]),
      ...placementBindings(execution),
    )
    .run();
  if (!(await execution.isActive()))
    return { ok: false, error: "side_case_placement_conflict" };
  return written.meta.changes === 1
    ? { ok: true, value: allowed.to }
    : { ok: false, error: "side_case_transition_stale" };
}

function changeOf(
  source: SideCaseSource,
  move: SideCaseMove,
  now: number,
): Readonly<{ set: string; values: readonly (string | number | null)[] }> {
  switch (move.event) {
    case "claim":
      return source === "portal_chat"
        ? {
            set: `status = 'starting', decided_by_user_id = ?, decided_at = ?,
              destination_conversation_id = ?, destination_case_id = ?`,
            values: [
              move.userId,
              now,
              move.destination?.conversationId ?? null,
              move.destination?.caseId ?? null,
            ],
          }
        : {
            set: `status = 'starting', decided_by_user_id = ?,
              decided_by_slack_user_id = ?, decided_at = ?`,
            values: [move.userId, move.slackUserId, now],
          };
    case "start":
      return { set: "status = 'started'", values: [] };
    case "dismiss":
      // A dismissed Portal proposal names no new chat.
      return {
        set: `status = 'dismissed', decided_by_user_id = ?, decided_at = ?,
          destination_conversation_id = NULL, destination_case_id = NULL`,
        values: [move.userId, now],
      };
  }
}

function startLeaseEnded(record: SideCaseRecord, now: number): boolean {
  return (
    record.decidedAt === null ||
    record.decidedAt + SIDE_CASE_START_LEASE_MS <= now
  );
}

export const ACTIVE_PLACEMENT = `EXISTS (SELECT 1 FROM organisation_placement
  WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
    AND fence_token = ? AND status = 'active')`;

export function placementBindings(execution: OrganisationExecutionScope) {
  return [
    execution.organisationId,
    execution.placement.placementEpoch,
    execution.placement.placementCellId,
    execution.fenceToken,
  ];
}

import type { SessionId, OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { assertNever, isNonNegativeInteger } from "@purin-labs/std";

type SessionCutoverRuntime = {
  readonly persistence: "v28_canonical";
  readonly lifecycleKind:
    | "sleeping"
    | "activating"
    | "processing"
    | "recovering"
    | "checkpointing"
    | "cancelling"
    | "quarantined"
    | "terminal";
};

type SessionCutoverWork = {
  readonly pendingTurns: number;
  readonly runningStreams: number;
  readonly incompleteStartSagas: number;
  readonly pendingEffects: number;
  readonly dispatchingEffects: number;
  readonly indeterminateEffects: number;
  readonly scheduledFollowups: number;
  readonly scheduledTasks: number;
  readonly activeHarnessLeases: number;
  readonly expiredHarnessLeases: number;
  /** Checkpoints whose payload the archive does not hold yet. */
  readonly unpublishedCheckpoints: number;
};

export type SessionCutoverBlocker =
  | "busy_lifecycle"
  | "quarantined_lifecycle"
  | "runtime_attached"
  | "pending_turns"
  | "running_streams"
  | "incomplete_start_sagas"
  | "pending_effects"
  | "dispatching_effects"
  | "indeterminate_effects"
  | "scheduled_followups"
  | "scheduled_tasks"
  | "active_harness_leases"
  | "unpublished_checkpoints"
  | "scheduled_alarm";

type SessionCutoverBase = {
  readonly schemaVersion: "agent_session_cutover_quiescence.v1";
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly inspectedAt: number;
  readonly runtime: SessionCutoverRuntime;
  readonly work: SessionCutoverWork;
  readonly alarm:
    | { readonly kind: "none"; readonly scheduledAt: null }
    | { readonly kind: "scheduled"; readonly scheduledAt: number };
};

export type SessionCutoverQuiescence =
  | (SessionCutoverBase & {
      readonly kind: "ready";
      readonly alarm: { readonly kind: "none"; readonly scheduledAt: null };
      readonly blockers: readonly [];
    })
  | (SessionCutoverBase & {
      readonly kind: "work_pending";
      readonly blockers: readonly [
        SessionCutoverBlocker,
        ...SessionCutoverBlocker[],
      ];
    })
  | (SessionCutoverBase & {
      readonly kind: "blocked";
      readonly blockers: readonly [
        SessionCutoverBlocker,
        ...SessionCutoverBlocker[],
      ];
    });

export type SessionCutoverInspectionError =
  | { readonly code: "session_cutover_state_invalid"; readonly field: string }
  | { readonly code: "session_mismatch" };

type SessionCutoverRow = Record<string, SqlStorageValue> & {
  pending_turns: number;
  running_streams: number;
  incomplete_start_sagas: number;
  pending_effects: number;
  dispatching_effects: number;
  indeterminate_effects: number;
  scheduled_followups: number;
  scheduled_tasks: number;
  active_harness_leases: number;
  expired_harness_leases: number;
  unpublished_checkpoints: number;
};

export function inspectAgentSessionCutoverQuiescence(input: {
  readonly sql: SqlStorage;
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly inspectedAt: number;
  readonly alarmAt: number | null;
  readonly runtime: SessionCutoverRuntime;
}): Result<SessionCutoverQuiescence, SessionCutoverInspectionError> {
  if (!isNonNegativeInteger(input.inspectedAt)) {
    return invalidState("inspectedAt");
  }

  if (input.alarmAt !== null && !isNonNegativeInteger(input.alarmAt)) {
    return invalidState("alarmAt");
  }

  const row = readSessionCutoverRow(input.sql, input.inspectedAt);
  const parsed = parseSessionCutoverRow(row);

  if (!parsed.ok) {
    return parsed;
  }

  const work: SessionCutoverWork = {
    pendingTurns: row.pending_turns,
    runningStreams: row.running_streams,
    incompleteStartSagas: row.incomplete_start_sagas,
    pendingEffects: row.pending_effects,
    dispatchingEffects: row.dispatching_effects,
    indeterminateEffects: row.indeterminate_effects,
    scheduledFollowups: row.scheduled_followups,
    scheduledTasks: row.scheduled_tasks,
    activeHarnessLeases: row.active_harness_leases,
    expiredHarnessLeases: row.expired_harness_leases,
    unpublishedCheckpoints: row.unpublished_checkpoints,
  };
  const blockers = sessionCutoverBlockers(input.runtime, work, input.alarmAt);
  const base: SessionCutoverBase = {
    schemaVersion: "agent_session_cutover_quiescence.v1",
    organisationId: input.organisationId,
    sessionId: input.sessionId,
    inspectedAt: input.inspectedAt,
    runtime: input.runtime,
    work,
    alarm:
      input.alarmAt === null
        ? { kind: "none", scheduledAt: null }
        : { kind: "scheduled", scheduledAt: input.alarmAt },
  };
  const [first, ...rest] = blockers;

  if (first === undefined) {
    return {
      ok: true,
      value: {
        ...base,
        kind: "ready",
        alarm: { kind: "none", scheduledAt: null },
        blockers: [],
      },
    };
  }

  return {
    ok: true,
    value: unsafeSessionCutover(input.runtime, work)
      ? { ...base, kind: "blocked", blockers: [first, ...rest] }
      : { ...base, kind: "work_pending", blockers: [first, ...rest] },
  };
}

function readSessionCutoverRow(
  sql: SqlStorage,
  inspectedAt: number,
): SessionCutoverRow {
  const row = sql
    .exec<SessionCutoverRow>(
      `SELECT
      (SELECT COUNT(*) FROM session_turn_continuation) AS pending_turns,
      (SELECT COUNT(*) FROM session_turn_stream
       WHERE state = 'running') AS running_streams,
      0 AS incomplete_start_sagas,
      (SELECT COUNT(*) FROM actor_outbox
       WHERE state_kind = 'pending') AS pending_effects,
      (SELECT COUNT(*) FROM actor_outbox
       WHERE state_kind = 'dispatching') AS dispatching_effects,
      (SELECT COUNT(*) FROM actor_outbox
       WHERE state_kind = 'indeterminate') AS indeterminate_effects,
      0 AS scheduled_followups,
      0 AS scheduled_tasks,
      (SELECT COUNT(*) FROM session_harness_lease
       WHERE expires_at > ?) AS active_harness_leases,
      (SELECT COUNT(*) FROM session_harness_lease
       WHERE expires_at <= ?) AS expired_harness_leases,
      (SELECT COUNT(*) FROM session_harness_checkpoint
       WHERE upload_state = 'upload_pending') AS unpublished_checkpoints`,
      inspectedAt,
      inspectedAt,
    )
    .toArray()[0];

  if (row === undefined) {
    throw new Error("agent_session_cutover_query_empty");
  }

  return row;
}

function parseSessionCutoverRow(
  row: SessionCutoverRow,
): Result<null, SessionCutoverInspectionError> {
  const counts: ReadonlyArray<readonly [string, number]> = [
    ["pending_turns", row.pending_turns],
    ["running_streams", row.running_streams],
    ["incomplete_start_sagas", row.incomplete_start_sagas],
    ["pending_effects", row.pending_effects],
    ["dispatching_effects", row.dispatching_effects],
    ["indeterminate_effects", row.indeterminate_effects],
    ["scheduled_followups", row.scheduled_followups],
    ["scheduled_tasks", row.scheduled_tasks],
    ["active_harness_leases", row.active_harness_leases],
    ["expired_harness_leases", row.expired_harness_leases],
    ["unpublished_checkpoints", row.unpublished_checkpoints],
  ];

  for (const [field, value] of counts) {
    if (!isNonNegativeInteger(value)) {
      return invalidState(field);
    }
  }

  return { ok: true, value: null };
}

function sessionCutoverBlockers(
  runtime: SessionCutoverRuntime,
  work: SessionCutoverWork,
  alarmAt: number | null,
): SessionCutoverBlocker[] {
  const blockers: SessionCutoverBlocker[] = [];
  pushRuntimeBlockers(blockers, runtime);
  pushWorkBlocker(blockers, work.pendingTurns, "pending_turns");
  pushWorkBlocker(blockers, work.runningStreams, "running_streams");
  pushWorkBlocker(
    blockers,
    work.incompleteStartSagas,
    "incomplete_start_sagas",
  );
  pushWorkBlocker(blockers, work.pendingEffects, "pending_effects");
  pushWorkBlocker(blockers, work.dispatchingEffects, "dispatching_effects");
  pushWorkBlocker(blockers, work.indeterminateEffects, "indeterminate_effects");
  pushWorkBlocker(blockers, work.scheduledFollowups, "scheduled_followups");
  pushWorkBlocker(blockers, work.scheduledTasks, "scheduled_tasks");
  pushWorkBlocker(blockers, work.activeHarnessLeases, "active_harness_leases");
  pushWorkBlocker(
    blockers,
    work.unpublishedCheckpoints,
    "unpublished_checkpoints",
  );

  if (alarmAt !== null) {
    blockers.push("scheduled_alarm");
  }

  return blockers;
}

function pushRuntimeBlockers(
  blockers: SessionCutoverBlocker[],
  runtime: SessionCutoverRuntime,
): void {
  switch (runtime.lifecycleKind) {
    case "sleeping":
    case "terminal":
      return;
    case "quarantined":
      blockers.push("quarantined_lifecycle");
      return;
    case "activating":
    case "processing":
    case "recovering":
    case "checkpointing":
    case "cancelling":
      blockers.push("busy_lifecycle");
      return;
    default:
      assertNever(
        runtime.lifecycleKind,
        "Unhandled canonical session lifecycle",
      );
  }
}

function unsafeSessionCutover(
  runtime: SessionCutoverRuntime,
  work: SessionCutoverWork,
): boolean {
  return (
    work.indeterminateEffects > 0 || runtime.lifecycleKind === "quarantined"
  );
}

function pushWorkBlocker(
  blockers: SessionCutoverBlocker[],
  count: number,
  blocker: SessionCutoverBlocker,
): void {
  if (count > 0) {
    blockers.push(blocker);
  }
}

function invalidState(
  field: string,
): Result<never, SessionCutoverInspectionError> {
  return { ok: false, error: { code: "session_cutover_state_invalid", field } };
}

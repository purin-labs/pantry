import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { assertNever, isNonNegativeInteger } from "@purin-labs/std";

type OrganisationCutoverBacklog = {
  readonly proposedActions: number;
  readonly approvalRequestedActions: number;
  readonly enqueuedCommerceCues: number;
};

type OrganisationCutoverBlocker =
  | {
      readonly kind: "provider_actions";
      readonly signed: number;
      readonly executing: number;
      readonly indeterminate: number;
    }
  | {
      readonly kind: "claimed_cues";
      readonly count: number;
      readonly earliestLeaseExpiresAt: number;
    }
  | {
      readonly kind: "pending_commerce_cues";
      readonly count: number;
      readonly oldestCreatedAt: number;
    }
  | {
      readonly kind: "code_executions";
      readonly count: number;
      readonly earliestLeaseExpiresAt: number;
    }
  | {
      readonly kind: "workspace_allocations";
      readonly count: number;
      readonly earliestLeaseExpiresAt: number;
    }
  | { readonly kind: "capability_calls"; readonly count: number }
  | { readonly kind: "scheduled_alarm"; readonly scheduledAt: number };

type OrganisationCutoverQuiescenceBase = {
  readonly schemaVersion: "organisation_cutover_quiescence.v1";
  readonly organisationId: OrganisationId;
  readonly inspectedAt: number;
  readonly backlog: OrganisationCutoverBacklog;
};

export type OrganisationCutoverQuiescence =
  | (OrganisationCutoverQuiescenceBase & {
      readonly kind: "quiescent";
      readonly blockers: readonly [];
    })
  | (OrganisationCutoverQuiescenceBase & {
      readonly kind: "blocked";
      readonly blockers: readonly [
        OrganisationCutoverBlocker,
        ...OrganisationCutoverBlocker[],
      ];
    });

export type OrganisationCutoverInspectionError = {
  readonly code: "organisation_cutover_state_invalid";
  readonly field: string;
};

type OrganisationCutoverRow = Record<string, SqlStorageValue> & {
  signed_actions: number;
  executing_actions: number;
  indeterminate_actions: number;
  proposed_actions: number;
  approval_requested_actions: number;
  claimed_cues: number;
  claimed_cue_lease_at: number | null;
  pending_commerce_cues: number;
  pending_commerce_created_at: number | null;
  enqueued_commerce_cues: number;
  code_executions: number;
  code_execution_lease_at: number | null;
  workspace_allocations: number;
  workspace_allocation_lease_at: number | null;
  capability_calls: number;
};

export function inspectOrganisationCutoverQuiescence(input: {
  readonly sql: SqlStorage;
  readonly organisationId: OrganisationId;
  readonly inspectedAt: number;
  readonly alarmAt: number | null;
}): Result<OrganisationCutoverQuiescence, OrganisationCutoverInspectionError> {
  if (!isNonNegativeInteger(input.inspectedAt)) {
    return invalidState("inspectedAt");
  }

  if (input.alarmAt !== null && !isNonNegativeInteger(input.alarmAt)) {
    return invalidState("alarmAt");
  }

  const row = readOrganisationCutoverRow(input.sql);
  const parsed = parseOrganisationCutoverRow(row);

  if (!parsed.ok) {
    return parsed;
  }

  const blockers = buildOrganisationCutoverBlockers(
    parsed.value,
    input.alarmAt,
  );
  const backlog: OrganisationCutoverBacklog = {
    proposedActions: parsed.value.proposed_actions,
    approvalRequestedActions: parsed.value.approval_requested_actions,
    enqueuedCommerceCues: parsed.value.enqueued_commerce_cues,
  };
  const base: OrganisationCutoverQuiescenceBase = {
    schemaVersion: "organisation_cutover_quiescence.v1",
    organisationId: input.organisationId,
    inspectedAt: input.inspectedAt,
    backlog,
  };
  const [first, ...rest] = blockers;

  return {
    ok: true,
    value:
      first === undefined
        ? { ...base, kind: "quiescent", blockers: [] }
        : { ...base, kind: "blocked", blockers: [first, ...rest] },
  };
}

function readOrganisationCutoverRow(sql: SqlStorage): OrganisationCutoverRow {
  const row = sql
    .exec<OrganisationCutoverRow>(
      `SELECT
      (SELECT COUNT(*) FROM action_ledger WHERE state = 'signed') AS signed_actions,
      (SELECT COUNT(*) FROM action_ledger WHERE state = 'executing') AS executing_actions,
      (SELECT COUNT(*) FROM action_ledger WHERE state = 'indeterminate') AS indeterminate_actions,
      (SELECT COUNT(*) FROM action_ledger WHERE state = 'proposed') AS proposed_actions,
      (SELECT COUNT(*) FROM action_ledger WHERE state = 'approval_requested') AS approval_requested_actions,
      (SELECT COUNT(*) FROM cue_delivery WHERE state = 'claimed') AS claimed_cues,
      (SELECT MIN(lease_expires_at) FROM cue_delivery WHERE state = 'claimed') AS claimed_cue_lease_at,
      (SELECT COUNT(*) FROM commerce_cue_outbox WHERE state = 'pending') AS pending_commerce_cues,
      (SELECT MIN(created_at) FROM commerce_cue_outbox WHERE state = 'pending') AS pending_commerce_created_at,
      (SELECT COUNT(*) FROM commerce_cue_outbox o WHERE state = 'enqueued'
         AND NOT EXISTS (
           SELECT 1 FROM commerce_cue_settlement s
           WHERE s.organisation_id = o.organisation_id AND s.native_id = o.native_id
         )) AS enqueued_commerce_cues,
      (SELECT COUNT(*) FROM code_execution_reservation WHERE state = 'reserved') AS code_executions,
      (SELECT MIN(lease_expires_at) FROM code_execution_reservation WHERE state = 'reserved') AS code_execution_lease_at,
      (SELECT COUNT(*) FROM code_execution_nested_allocation WHERE state = 'reserved') AS workspace_allocations,
      (SELECT MIN(lease_expires_at) FROM code_execution_nested_allocation WHERE state = 'reserved') AS workspace_allocation_lease_at,
      (SELECT COUNT(*) FROM code_execution_call WHERE state = 'claimed') AS capability_calls`,
    )
    .toArray()[0];

  if (row === undefined) {
    throw new Error("organisation_cutover_query_empty");
  }

  return row;
}

function parseOrganisationCutoverRow(
  row: OrganisationCutoverRow,
): Result<OrganisationCutoverRow, OrganisationCutoverInspectionError> {
  const counts: ReadonlyArray<readonly [string, number]> = [
    ["signed_actions", row.signed_actions],
    ["executing_actions", row.executing_actions],
    ["indeterminate_actions", row.indeterminate_actions],
    ["proposed_actions", row.proposed_actions],
    ["approval_requested_actions", row.approval_requested_actions],
    ["claimed_cues", row.claimed_cues],
    ["pending_commerce_cues", row.pending_commerce_cues],
    ["enqueued_commerce_cues", row.enqueued_commerce_cues],
    ["code_executions", row.code_executions],
    ["workspace_allocations", row.workspace_allocations],
    ["capability_calls", row.capability_calls],
  ];

  for (const [field, value] of counts) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return invalidState(field);
    }
  }

  const timestamps: ReadonlyArray<readonly [string, number, number | null]> = [
    ["claimed_cue_lease_at", row.claimed_cues, row.claimed_cue_lease_at],
    [
      "pending_commerce_created_at",
      row.pending_commerce_cues,
      row.pending_commerce_created_at,
    ],
    [
      "code_execution_lease_at",
      row.code_executions,
      row.code_execution_lease_at,
    ],
    [
      "workspace_allocation_lease_at",
      row.workspace_allocations,
      row.workspace_allocation_lease_at,
    ],
  ];

  for (const [field, count, value] of timestamps) {
    if (
      (count === 0 && value !== null) ||
      (count > 0 && !isNonNegativeInteger(value))
    ) {
      return invalidState(field);
    }
  }

  return { ok: true, value: row };
}

function buildOrganisationCutoverBlockers(
  row: OrganisationCutoverRow,
  alarmAt: number | null,
): OrganisationCutoverBlocker[] {
  const blockers: OrganisationCutoverBlocker[] = [];

  if (
    row.signed_actions + row.executing_actions + row.indeterminate_actions >
    0
  ) {
    blockers.push({
      kind: "provider_actions",
      signed: row.signed_actions,
      executing: row.executing_actions,
      indeterminate: row.indeterminate_actions,
    });
  }

  pushTimestampBlocker(
    blockers,
    row.claimed_cues,
    row.claimed_cue_lease_at,
    "claimed_cues",
  );
  pushTimestampBlocker(
    blockers,
    row.pending_commerce_cues,
    row.pending_commerce_created_at,
    "pending_commerce_cues",
  );
  pushTimestampBlocker(
    blockers,
    row.code_executions,
    row.code_execution_lease_at,
    "code_executions",
  );
  pushTimestampBlocker(
    blockers,
    row.workspace_allocations,
    row.workspace_allocation_lease_at,
    "workspace_allocations",
  );

  if (row.capability_calls > 0) {
    blockers.push({ kind: "capability_calls", count: row.capability_calls });
  }

  if (alarmAt !== null) {
    blockers.push({ kind: "scheduled_alarm", scheduledAt: alarmAt });
  }

  return blockers;
}

function pushTimestampBlocker(
  blockers: OrganisationCutoverBlocker[],
  count: number,
  timestamp: number | null,
  kind:
    | "claimed_cues"
    | "pending_commerce_cues"
    | "code_executions"
    | "workspace_allocations",
): void {
  if (count === 0 || timestamp === null) {
    return;
  }

  switch (kind) {
    case "claimed_cues":
      blockers.push({ kind, count, earliestLeaseExpiresAt: timestamp });
      return;
    case "pending_commerce_cues":
      blockers.push({ kind, count, oldestCreatedAt: timestamp });
      return;
    case "code_executions":
    case "workspace_allocations":
      blockers.push({ kind, count, earliestLeaseExpiresAt: timestamp });
      return;
    default:
      assertNever(kind, "Unhandled Organisation cutover blocker");
  }
}

function invalidState(
  field: string,
): Result<never, OrganisationCutoverInspectionError> {
  return {
    ok: false,
    error: { code: "organisation_cutover_state_invalid", field },
  };
}

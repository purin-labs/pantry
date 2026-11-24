import type { AgentSessionLifecycle } from "@purin-labs/contracts";
import type { SessionId, OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  classifyHarnessCheckpoint,
  inspectLatestStoredHarnessCheckpoint,
  type HarnessAuthorityError,
} from "../agent-session-harness-authority";
import { digestModelRoute } from "../../models/route";
import type { EmbeddedHarnessAdapter } from "../embedded-harness";
import {
  readSessionBudgetAccount,
  type SessionBudgetError,
} from "../agent-session-budget";
import type { ModelRoute } from "@purin-labs/contracts";
import type {
  SessionBudgetInspection,
  SessionCheckpointInspection,
  SessionCheckpointInspectionBase,
  SessionInspectionError,
  SessionReservationInspection,
} from "./types";

type SessionInspectionHeaderRow = Record<string, SqlStorageValue> & {
  readonly organisation_id: string;
  readonly session_id: string;
  readonly lifecycle_kind: string;
};

export function readSessionInspectionHeader(
  sql: SqlStorage,
  input: {
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
  },
): Result<
  { readonly lifecycleKind: AgentSessionLifecycle["kind"] },
  SessionInspectionError
> {
  const rows = sql
    .exec<SessionInspectionHeaderRow>(
      `SELECT organisation_id, session_id, lifecycle_kind
     FROM session_meta
     LIMIT 2`,
    )
    .toArray();
  const row = rows[0];
  if (row === undefined)
    return { ok: false, error: { code: "session_not_initialized" } };
  if (rows.length !== 1)
    return { ok: false, error: { code: "session_inspection_corrupt" } };
  if (
    row.organisation_id !== input.organisationId ||
    row.session_id !== input.sessionId
  ) {
    return { ok: false, error: { code: "session_mismatch" } };
  }
  const lifecycleKind = parseSessionInspectionLifecycleKind(row.lifecycle_kind);
  return lifecycleKind === null
    ? { ok: false, error: { code: "session_inspection_corrupt" } }
    : { ok: true, value: { lifecycleKind } };
}

function parseSessionInspectionLifecycleKind(
  raw: string,
): AgentSessionLifecycle["kind"] | null {
  switch (raw) {
    case "sleeping":
    case "activating":
    case "processing":
    case "recovering":
    case "checkpointing":
    case "cancelling":
    case "quarantined":
    case "terminal":
      return raw;
    default:
      return null;
  }
}

export function inspectSessionBudget(
  sql: SqlStorage,
  input: {
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
  },
): Result<
  {
    readonly budget: SessionBudgetInspection;
    readonly reservation: SessionReservationInspection;
  },
  SessionBudgetError
> {
  const account = readSessionBudgetAccount(sql, input);
  if (!account.ok && account.error.code === "budget_account_missing") {
    return {
      ok: true,
      value: {
        budget: { kind: "missing" },
        reservation: { kind: "none" },
      },
    };
  }
  if (!account.ok) return account;

  const reservation = account.value.reservation;
  return {
    ok: true,
    value: {
      budget: {
        kind: account.value.kind,
        usage: account.value.usage,
        usageCursor: account.value.usageCursor,
      },
      reservation:
        reservation.kind === "none"
          ? { kind: "none" }
          : {
              kind: reservation.kind,
              reservationId: reservation.reservation.reservationId,
              runId: reservation.reservation.runId,
              turnId: reservation.reservation.turnId,
              deadlineAt: reservation.reservation.deadlineAt,
            },
    },
  };
}

export async function inspectSessionCheckpoint(
  sql: SqlStorage,
  organisationId: OrganisationId,
  sessionId: SessionId,
  modelRoute: ModelRoute,
  /** Null when the pinned model left its list: the next turn takes a new route. */
  adapter: EmbeddedHarnessAdapter | null,
): Promise<Result<SessionCheckpointInspection, HarnessAuthorityError>> {
  const inspected = inspectLatestStoredHarnessCheckpoint(sql, sessionId);
  if (inspected.kind === "missing")
    return { ok: true, value: { kind: "none" } };
  if (inspected.kind === "invalid") {
    return {
      ok: true,
      value: {
        kind: "invalid",
        classification: "retirement_required",
        reason: inspected.reason,
      },
    };
  }

  const checkpoint = inspected.checkpoint;
  if (
    checkpoint.session.organisationId !== organisationId ||
    checkpoint.session.sessionId !== sessionId
  ) {
    return { ok: false, error: { code: "harness_checkpoint_invalid" } };
  }
  const base = checkpointInspectionBase(checkpoint);
  if (checkpoint.backendId === "picocodex") {
    return {
      ok: true,
      value: {
        ...base,
        kind: "current",
        classification: "fresh_lineage_restart",
        reason: "backend_mismatch",
        budgetRevision: checkpoint.budgetRevision,
        usageCursor: checkpoint.usageCursor,
        budgetAccountDigest: checkpoint.budgetAccountDigest,
      },
    };
  }
  const modelRouteDigest = await digestModelRoute(modelRoute);
  const classification =
    adapter === null
      ? ({
          kind: "fresh_lineage_restart",
          reason: "model_route_digest_mismatch",
        } as const)
      : classifyHarnessCheckpoint({
          checkpoint,
          backendId: adapter.manifest.backendId,
          harnessBuild: adapter.manifest.harnessBuild,
          checkpointFormat: adapter.manifest.checkpointFormat,
          modelRouteDigest,
        });
  return classification.kind === "compatible"
    ? {
        ok: true,
        value: {
          ...base,
          kind: "current",
          classification: "compatible",
          budgetRevision: checkpoint.budgetRevision,
          usageCursor: checkpoint.usageCursor,
          budgetAccountDigest: checkpoint.budgetAccountDigest,
        },
      }
    : {
        ok: true,
        value: {
          ...base,
          kind: "current",
          classification: "fresh_lineage_restart",
          reason: classification.reason,
          budgetRevision: checkpoint.budgetRevision,
          usageCursor: checkpoint.usageCursor,
          budgetAccountDigest: checkpoint.budgetAccountDigest,
        },
      };
}

function checkpointInspectionBase(checkpoint: {
  readonly backendId: string;
  readonly blob: {
    readonly formatVersion: string;
    readonly harnessBuild: string;
    readonly createdAt: number;
    readonly sha256: string;
  };
  readonly runtimeLease: { readonly generation: number };
  readonly turn: { readonly turnId: string };
  readonly cursor: {
    readonly lastSequence: number;
    readonly lastEventDigest: string;
  };
  readonly instructionDigest: string;
  readonly toolCatalogDigest: string;
  readonly modelRouteDigest: string;
}): SessionCheckpointInspectionBase {
  return {
    backendId: checkpoint.backendId,
    formatVersion: checkpoint.blob.formatVersion,
    harnessBuild: checkpoint.blob.harnessBuild,
    createdAt: checkpoint.blob.createdAt,
    runtimeGeneration: checkpoint.runtimeLease.generation,
    turnId: checkpoint.turn.turnId,
    lastSequence: checkpoint.cursor.lastSequence,
    lastEventDigest: checkpoint.cursor.lastEventDigest,
    sha256: checkpoint.blob.sha256,
    instructionDigest: checkpoint.instructionDigest,
    toolCatalogDigest: checkpoint.toolCatalogDigest,
    modelRouteDigest: checkpoint.modelRouteDigest,
  };
}

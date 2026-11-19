import type { HarnessTurnLease, TurnIdentity } from "@purin-labs/contracts";
import { newRequestId, type RequestId, type OrganisationId } from "../../ids";
import { traceLog, traceWarn } from "../../observability";
import type {
  HarnessHistoryMaterialization,
  HarnessHistoryUsage,
} from "../agent-session-harness-authority";

export async function measureSessionHarnessPreparation<T>(
  input: {
    readonly requestId: RequestId;
    readonly requestingOrganisationId: OrganisationId;
    readonly lease: HarnessTurnLease;
  },
  phase: Parameters<typeof traceSessionHarnessPreparation>[2],
  preparation: Promise<T>,
  startedAt = Date.now(),
): Promise<T> {
  try {
    return await preparation;
  } finally {
    traceSessionHarnessPreparation(
      input,
      input.lease.turn.turnId,
      phase,
      startedAt,
    );
  }
}

export function traceSessionHarnessPreparation(
  input: {
    readonly requestId: RequestId;
    readonly requestingOrganisationId: OrganisationId;
  },
  turnId: string,
  phase:
    | "start_context"
    | "start_session"
    | "start_runtime_source"
    | "start_custom_catalog"
    | "start_checkpoint_binding"
    | "start_information_flow"
    | "start_stream_sink"
    | "start_commit"
    | "run_session"
    | "run_workspace_receipt"
    | "run_budget_admission"
    | "harness_input"
    | "harness_user_input"
    | "harness_session"
    | "harness_custom_catalog"
    | "harness_checkpoint_binding"
    | "harness_tool_host"
    | "harness_history_restore"
    | "harness_model_route"
    | "harness_runtime",
  startedAt: number,
): void {
  traceLog("session.harness_preparation_timing", {
    requestId: input.requestId,
    organisation_id: input.requestingOrganisationId,
    turn_id: turnId,
    phase,
    started_at: startedAt,
    duration_ms: Date.now() - startedAt,
  });
}

/** One step between the harness's last output and the completed turn. */
/**
 * Names the check that refused a finished turn. Each of them ends the turn
 * with `canonical_text_turn_state_invalid`, so the code alone cannot say why.
 */
export function traceTurnCompletionRefused(
  input: {
    readonly requestId: RequestId;
    readonly requestingOrganisationId: OrganisationId;
    readonly lease: { readonly turn: { readonly turnId: string } };
  },
  check: string,
): void {
  traceWarn("session.turn_completion_refused", {
    requestId: input.requestId,
    organisation_id: input.requestingOrganisationId,
    turn_id: input.lease.turn.turnId,
    check,
  });
}

export function traceSessionTurnCompletion(
  input: {
    readonly requestId: RequestId;
    readonly requestingOrganisationId: OrganisationId;
  },
  turnId: string,
  phase:
    | "turn_authority"
    | "runtime_close"
    | "goal_close"
    | "placement_check"
    | "checkpoint_accept"
    | "checkpoint_upload"
    | "checkpoint_publish"
    | "checkpoint_receipt"
    | "stream_completion",
  startedAt: number,
): void {
  traceLog("session.turn_completion_timing", {
    requestId: input.requestId,
    organisation_id: input.requestingOrganisationId,
    turn_id: turnId,
    phase,
    started_at: startedAt,
    duration_ms: Date.now() - startedAt,
  });
}

export function traceHarnessRestoreMetrics(
  identity: {
    readonly sessionId: string;
    readonly requestingOrganisationId: OrganisationId;
    readonly turn: TurnIdentity;
  },
  source: "fresh" | "fresh_lineage" | "checkpoint",
  retainedUsage: HarnessHistoryUsage,
  materialization: HarnessHistoryMaterialization,
  startedAt: number,
): void {
  const materializedBytes =
    materialization.kind === "history_materialization_limit"
      ? 0
      : materialization.encodedBytes;
  const peakEntryCount =
    materialization.kind === "history_materialization_limit"
      ? 0
      : materialization.history.entries.length;
  traceLog("session.harness_history_restore_metrics", {
    requestId: newRequestId(),
    organisation_id: identity.requestingOrganisationId,
    session_id: identity.sessionId,
    turn_id: identity.turn.turnId,
    restore_source: source,
    outcome: materialization.kind,
    retained_history_bytes: retainedUsage.inlineBytes,
    materialized_history_bytes: materializedBytes,
    peak_history_entry_count: peakEntryCount,
    restore_duration_ms: Date.now() - startedAt,
  });
}

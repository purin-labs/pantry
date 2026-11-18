import type {
  AgentSessionLifecycle,
  HarnessCheckpointRecord,
} from "@seams/contracts";
import type { Variant } from "@seams/type-utils";
import { parseOrganisationId } from "../ids";
import type { Result } from "../result";
import { readImportedCanonicalSession } from "./agent-session-canonical";
import { readSessionBudgetAccount } from "./agent-session-budget";
import {
  readLatestHarnessCheckpoint,
  readHarnessCheckpointPublication,
  type HarnessCheckpointPublication,
} from "./agent-session-harness-authority";
import { checkpointMatchesCheckpointingState } from "./agent-session-text-turn";
import { readSessionTurnReplay } from "./agent-session-turn-stream";

export type AcceptedCheckpointFinalization = {
  readonly current: Variant<AgentSessionLifecycle, "checkpointing">;
  readonly checkpoint: HarnessCheckpointRecord;
  readonly publication: HarnessCheckpointPublication;
};

export function readAcceptedCheckpointFinalization(sql: SqlStorage): Result<
  | { readonly kind: "none" }
  | {
      readonly kind: "pending";
      readonly finalization: AcceptedCheckpointFinalization;
    },
  { readonly code: "invalid_persisted_state" }
> {
  const row = sql
    .exec<{ organisation_id: string }>(
      "SELECT organisation_id FROM session_meta LIMIT 1",
    )
    .toArray()[0];
  if (row === undefined) return { ok: true, value: { kind: "none" } };
  const session = readImportedCanonicalSession(sql, row.organisation_id);
  if (!session.ok) return invalid();
  const current = session.value.lifecycle;
  if (current.kind !== "checkpointing")
    return { ok: true, value: { kind: "none" } };
  const saved = readLatestHarnessCheckpoint(
    sql,
    current.state.identity.sessionId,
  );
  const budget = readSessionBudgetAccount(sql, current.state.identity);
  if (
    !saved.ok ||
    saved.value === null ||
    !budget.ok ||
    budget.value.kind !== "open" ||
    budget.value.reservation.kind !== "none" ||
    !checkpointMatchesCheckpointingState({
      current,
      harnessCheckpoint: saved.value,
    }) ||
    saved.value.budgetRevision !== budget.value.budget.budgetRevision ||
    saved.value.usageCursor !== budget.value.usageCursor ||
    JSON.stringify(saved.value.budgetUsage) !==
      JSON.stringify(budget.value.usage)
  )
    return invalid();
  const organisationId = parseOrganisationId(
    current.state.identity.organisationId,
  );
  if (!organisationId.ok) return invalid();
  let afterSequence = -1;
  let done = false;
  let finalMessage = false;
  for (;;) {
    const replay = readSessionTurnReplay(sql, {
      organisationId: organisationId.value,
      turnId: current.state.turnId,
      afterSequence,
    });
    if (
      !replay.ok ||
      replay.value.state.kind !== "running" ||
      replay.value.state.lastSequence !== saved.value.cursor.lastSequence - 1
    )
      return invalid();
    for (const envelope of replay.value.envelopes) {
      afterSequence = envelope.sequence;
      if (envelope.event.type === "done") done = true;
      if (
        envelope.event.type === "agent_message" &&
        envelope.event.finalMessage
      )
        finalMessage = true;
    }
    if (replay.value.caughtUp) break;
  }
  if (!done || !finalMessage) return invalid();
  const publication = readHarnessCheckpointPublication(sql, saved.value);
  if (!publication.ok) return invalid();
  return {
    ok: true,
    value: {
      kind: "pending",
      finalization: {
        current,
        checkpoint: saved.value,
        publication: publication.value,
      },
    },
  };
}

function invalid(): {
  readonly ok: false;
  readonly error: { readonly code: "invalid_persisted_state" };
} {
  return { ok: false, error: { code: "invalid_persisted_state" } };
}

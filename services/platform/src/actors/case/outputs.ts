import type {
  CaseContent,
  RequestAuthority,
  SessionProposal,
} from "@seams/contracts";
import type {
  CaseContextReplayAuthority,
  ContextVisibility,
} from "../../context/projection";
import { FlowBinding, FlowLabel } from "../../policy";
import type { SerializedFlowBinding } from "../../policy";
import { sourceReaderForAuthority } from "../../policy/information-flow/source-readers";
import type { Variant } from "@seams/type-utils";
import {
  caseContentPreview,
  contextVisibilityKey,
  inspectStoredCase,
  readBindings,
  readMeta,
  readOutputLifecycle,
  receiptMatchesOutput,
  restoreCaseSnapshot,
  serializeCaseSnapshot,
} from "./context-source";
import {
  machineTransition,
  type MachineEvent,
} from "@seams/std/state-machine";
import { writeActorTransition } from "../lifecycle/state-transition";
import { retainContextProjection } from "./lifecycle";
import { CASE_OUTPUT_MACHINE } from "./output.machine";
import { equal, invalid, isOpen } from "./record-parsers";
import type { DropHeldOutputRequest } from "./request-parsers";
import type {
  AcceptDeliveryReceiptRequest,
  CaseContributionSource,
  CaseOutputDropReason,
  CaseResult,
  CaseSnapshot,
  RawCaseOutputLifecycle,
  RawCaseProposalAcceptance,
  StoredCaseOutput,
  StoredCaseOutputLifecycle,
} from "./types";

export function buildCaseOutputs(
  sql: SqlStorage,
  proposal: SessionProposal,
  revision: number,
  addressedAt: number,
  flowBinding: FlowBinding,
): CaseResult<StoredCaseOutput[]> {
  const outputs: StoredCaseOutput[] = [];
  for (const entry of proposal.entries) {
    if (entry.content.kind !== "text") continue;
    const output = buildCaseOutput(sql, {
      outputId: `output_${proposal.proposalId}_${entry.entryId}`,
      source: {
        kind: "agent_turn",
        assignmentId: proposal.assignmentId,
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        proposalId: proposal.proposalId,
      },
      entryId: entry.entryId,
      flowBinding: flowBinding.toJSON(),
      deliveryId: `delivery_${proposal.proposalId}_${entry.entryId}`,
      caseId: proposal.caseId,
      revision,
      content: entry.content,
      idempotencyKey: `case_output_${proposal.proposalId}_${entry.entryId}`,
      addressedAt,
    });
    if (!output.ok) return output;
    if (output.value !== null) outputs.push(output.value);
  }
  return { ok: true, value: outputs };
}

export function buildCaseOutput(
  sql: SqlStorage,
  input: {
    readonly outputId: string;
    readonly source: CaseContributionSource;
    readonly entryId: string;
    readonly caseId: string;
    readonly content: Variant<CaseContent, "text">;
    readonly revision: number;
    readonly addressedAt: number;
    readonly deliveryId: string;
    readonly idempotencyKey: string;
    readonly flowBinding: SerializedFlowBinding;
  },
): CaseResult<StoredCaseOutput | null> {
  const bindings = readBindings(sql);
  if (bindings === null) return invalid("case_storage_corrupt");
  if (bindings.length === 0) return { ok: true, value: null };
  if (bindings.length !== 1) return invalid("case_output_binding_invalid");
  const binding = bindings[0];
  if (binding === undefined) return invalid("case_output_binding_invalid");
  return {
    ok: true,
    value: {
      outputId: input.outputId,
      source: input.source,
      entryId: input.entryId,
      connectorId: binding.connectorId,
      flowBinding: input.flowBinding,
      delivery: {
        deliveryId: input.deliveryId,
        bindingId: binding.bindingId,
        address: binding.address,
        caseId: input.caseId,
        caseRevision: input.revision,
        content: input.content,
        idempotencyKey: input.idempotencyKey,
        addressedAt: input.addressedAt,
      },
    },
  };
}

export function persistProposal(
  sql: SqlStorage,
  proposal: SessionProposal,
  value: RawCaseProposalAcceptance,
  acceptedAt: number,
): void {
  sql.exec(
    "INSERT INTO case_proposal (proposal_id, payload, acceptance_json) VALUES (?, ?, ?)",
    proposal.proposalId,
    JSON.stringify(proposal),
    JSON.stringify({ ...value, acceptedAt }),
  );
}

export function persistPendingOutput(
  sql: SqlStorage,
  output: StoredCaseOutput,
): void {
  const lifecycle: StoredCaseOutputLifecycle = { kind: "pending", output };
  sql.exec(
    `INSERT INTO case_output (output_id, delivery_id, idempotency_key, lifecycle_json)
    VALUES (?, ?, ?, ?)`,
    output.outputId,
    output.delivery.deliveryId,
    output.delivery.idempotencyKey,
    JSON.stringify(lifecycle),
  );
}

export function settleCaseOutput(
  sql: SqlStorage,
  input: AcceptDeliveryReceiptRequest,
): CaseResult<{
  readonly kind: "settled" | "already_settled";
  readonly output: RawCaseOutputLifecycle;
}> {
  const lifecycle = readOutputLifecycle(sql, input.outputId);
  if (lifecycle === null) return invalid("case_output_missing");
  if (
    input.receipt.flowBindingDigest !== input.expectedFlowBindingDigest ||
    !receiptMatchesOutput(input.receipt, lifecycle.output)
  )
    return invalid("case_delivery_receipt_mismatch");
  if (lifecycle.kind === "dropped") return invalid("case_output_dropped");
  if (lifecycle.kind === "settled") {
    return equal(lifecycle.receipt, input.receipt)
      ? { ok: true, value: { kind: "already_settled", output: lifecycle } }
      : invalid("case_delivery_receipt_conflict");
  }
  const settled: RawCaseOutputLifecycle = {
    kind: "settled",
    output: lifecycle.output,
    receipt: input.receipt,
  };
  const moved = moveCaseOutput(
    sql,
    input.outputId,
    lifecycle.kind,
    "settle",
    settled,
  );
  if (!moved.ok) return moved;
  return { ok: true, value: { kind: "settled", output: settled } };
}

/**
 * Records that the exit check stopped an output and a person decides
 * (Refactor 15, refactor 2). After this, no resume path sends the output; the
 * person's decision settles or drops it. A repeated call with the same
 * request changes nothing.
 */
export function holdCaseOutputLifecycle(
  sql: SqlStorage,
  input: Readonly<{ outputId: string; requestId: string; heldAt: number }>,
): CaseResult<{ readonly kind: "held" | "already_held" | "not_pending" }> {
  const lifecycle = readOutputLifecycle(sql, input.outputId);
  if (lifecycle === null) return invalid("case_output_missing");
  if (lifecycle.kind === "held")
    return lifecycle.requestId === input.requestId
      ? { ok: true, value: { kind: "already_held" } }
      : invalid("case_output_hold_conflict");
  if (lifecycle.kind !== "pending")
    return { ok: true, value: { kind: "not_pending" } };
  const held: RawCaseOutputLifecycle = {
    kind: "held",
    output: lifecycle.output,
    requestId: input.requestId,
    heldAt: input.heldAt,
  };
  const moved = moveCaseOutput(sql, input.outputId, "pending", "hold", held);
  return moved.ok ? { ok: true, value: { kind: "held" } } : moved;
}

/**
 * Records that the provider refused an output's delivery for good, so that
 * no later trigger tries it again and fails on it.
 */
export function rejectCaseOutputLifecycle(
  sql: SqlStorage,
  input: Readonly<{ outputId: string; reason: string; rejectedAt: number }>,
): CaseResult<{ readonly kind: "rejected" | "not_open" }> {
  const lifecycle = readOutputLifecycle(sql, input.outputId);
  if (lifecycle === null) return invalid("case_output_missing");
  if (lifecycle.kind !== "pending" && lifecycle.kind !== "held")
    return { ok: true, value: { kind: "not_open" } };
  const rejected: RawCaseOutputLifecycle = {
    kind: "rejected",
    output: lifecycle.output,
    reason: input.reason.slice(0, 256),
    rejectedAt: input.rejectedAt,
  };
  const moved = moveCaseOutput(
    sql,
    input.outputId,
    lifecycle.kind,
    "reject",
    rejected,
  );
  return moved.ok ? { ok: true, value: { kind: "rejected" } } : moved;
}

/** The one write of a Case output's move, checked against its machine. */
function moveCaseOutput(
  sql: SqlStorage,
  outputId: string,
  from: RawCaseOutputLifecycle["kind"],
  event: MachineEvent<typeof CASE_OUTPUT_MACHINE>,
  next: RawCaseOutputLifecycle,
): CaseResult<null> {
  const allowed = machineTransition(CASE_OUTPUT_MACHINE, from, event);
  if (!allowed.allowed) return invalid("case_output_transition_invalid");
  return writeActorTransition(sql, CASE_OUTPUT_MACHINE.store, {
    key: outputId,
    from: allowed.from,
    value: JSON.stringify(next),
  })
    ? { ok: true, value: null }
    : invalid("case_output_transition_stale");
}

export function refusedEffectNote(reason: CaseOutputDropReason): string {
  return reason === "denied"
    ? "Sous Chef did not do the step that waited for approval, because a person denied it."
    : "Sous Chef did not do the step that waited for approval, because nobody approved it in seven days.";
}

export function droppedOutputNote(reason: CaseOutputDropReason): string {
  return reason === "denied"
    ? "Sous Chef did not send the previous answer to this conversation, because a person denied it."
    : "Sous Chef did not send the previous answer to this conversation, because nobody approved it in seven days.";
}

export function dropCaseOutput(
  sql: SqlStorage,
  input: DropHeldOutputRequest &
    Readonly<{
      content: Variant<CaseContent, "text">;
      digest: string;
      label: FlowLabel;
      replayAuthority: CaseContextReplayAuthority;
    }>,
): CaseResult<{ readonly kind: "dropped" | "already_dropped" }> {
  const lifecycle = readOutputLifecycle(sql, input.outputId);
  if (lifecycle === null) return invalid("case_output_missing");
  if (lifecycle.kind === "settled") return invalid("case_output_settled");
  if (lifecycle.kind === "dropped")
    return { ok: true, value: { kind: "already_dropped" } };
  const dropped: RawCaseOutputLifecycle = {
    kind: "dropped",
    output: lifecycle.output,
    reason: input.reason,
    droppedAt: input.droppedAt,
  };
  const moved = moveCaseOutput(
    sql,
    input.outputId,
    lifecycle.kind,
    "drop",
    dropped,
  );
  if (!moved.ok) return moved;
  const meta = readMeta(sql);
  if (meta !== null && isOpen(meta.lifecycle_json)) {
    const entryId = `output_dropped:${input.outputId}`;
    appendJournal(
      sql,
      entryId,
      input.content,
      input.digest,
      input.requestAuthority,
      sourceReaderForAuthority(input.requestAuthority),
      input.label,
      input.replayAuthority,
      input.droppedAt,
    );
    retainContextProjection(sql, entryId);
    sql.exec(
      "UPDATE case_meta SET revision = ? WHERE singleton = 1",
      meta.revision + 1,
    );
  }
  return { ok: true, value: { kind: "dropped" } };
}

export function appendJournal(
  sql: SqlStorage,
  entryId: string,
  content: CaseContent,
  contentDigest: string,
  requestAuthority: RequestAuthority,
  visibility: ContextVisibility,
  inputLabel: FlowLabel,
  replayAuthority: CaseContextReplayAuthority,
  acceptedAt: number,
): void {
  const payload = JSON.stringify(content);
  const preview = caseContentPreview(content).slice(0, 512);
  sql.exec(
    `INSERT INTO case_journal (
       entry_id, digest, preview, payload, request_authority_json,
       visibility_json, visibility_key, flow_label_json, authority_scope_json, accepted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    entryId,
    contentDigest,
    preview,
    payload,
    JSON.stringify(requestAuthority),
    JSON.stringify(visibility),
    contextVisibilityKey(visibility),
    JSON.stringify(inputLabel.toJSON()),
    JSON.stringify(replayAuthority),
    acceptedAt,
  );
}

export async function inspectCase(
  sql: SqlStorage,
): Promise<CaseResult<CaseSnapshot>> {
  const stored = inspectStoredCase(sql);
  if (!stored.ok) return stored;
  const restored = await restoreCaseSnapshot(stored.value);
  return restored.ok
    ? { ok: true, value: serializeCaseSnapshot(restored.value) }
    : restored;
}

/**
 * How long an answer may wait for its delivery (Refactor 15, refactor 2).
 * Every retry of its surface has ended long before: the Connector gives up
 * on a Case work item within minutes, and a held answer is `held`, not
 * pending. An older pending answer would only reach the conversation late,
 * beside newer answers.
 */
export const UNDELIVERED_OUTPUT_TTL_MS = 24 * 60 * 60_000;
const UNDELIVERED_OUTPUT_PAGE = 32;

const PENDING_OUTPUT_AGE = `FROM case_output AS output
  JOIN case_journal AS entry
    ON entry.entry_id = json_extract(output.lifecycle_json, '$.output.entryId')
  WHERE json_extract(output.lifecycle_json, '$.kind') = 'pending'`;

/** When the oldest pending answer of the Case passes its delivery time. */
export function nextUndeliveredOutputAt(sql: SqlStorage): number | null {
  const row = sql
    .exec<{ at: number | null }>(
      `SELECT MIN(entry.accepted_at) AS at ${PENDING_OUTPUT_AGE}`,
    )
    .toArray()[0];
  return row?.at == null ? null : row.at + UNDELIVERED_OUTPUT_TTL_MS;
}

/**
 * Drops each pending answer that waited longer than its delivery time. It
 * writes no journal note: no person decided, and the conversation already
 * showed that the request failed. Returns the dropped output ids.
 */
export function dropUndeliveredOutputs(
  sql: SqlStorage,
  now: number,
): readonly string[] {
  const rows = sql
    .exec<{ output_id: string }>(
      `SELECT output.output_id ${PENDING_OUTPUT_AGE}
         AND entry.accepted_at <= ?
       ORDER BY entry.accepted_at
       LIMIT ?`,
      now - UNDELIVERED_OUTPUT_TTL_MS,
      UNDELIVERED_OUTPUT_PAGE,
    )
    .toArray();
  const dropped: string[] = [];
  for (const row of rows) {
    const lifecycle = readOutputLifecycle(sql, row.output_id);
    if (lifecycle?.kind !== "pending") continue;
    const moved = moveCaseOutput(sql, row.output_id, "pending", "drop", {
      kind: "dropped",
      output: lifecycle.output,
      reason: "undelivered",
      droppedAt: now,
    });
    if (moved.ok) dropped.push(row.output_id);
  }
  return dropped;
}

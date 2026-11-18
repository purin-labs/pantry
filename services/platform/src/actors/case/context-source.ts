import type { OrganisationDatabase } from "../../database-handles";
import { deriveUserMessageViews } from "../../messages/message-wasm";
import type {
  CaseAssignment,
  CaseAssignmentLifecycle,
  CaseBinding,
  CaseContent,
  RequestAuthority,
  UserMessage,
} from "@seams/contracts";
import type { Env } from "../../env";
import {
  parseCaseId,
  parseOrganisationId,
  type OrganisationId,
} from "../../ids";
import { gmailConnectorIdValue } from "../../data/email-mailbox";
import { whatsappConnectorIdValue } from "../../data/whatsapp";
import type {
  CaseContextReplayAuthority,
  ContextVisibility,
  CaseContextSource,
  CaseContextSourceReader,
  CaseContextSourceReaderError,
} from "../../context/projection";
import {
  createContextProjectionCommand,
  MAX_BOUNDED_CONTEXT_TEXT_CHARS,
} from "../../context/projection";
import type {
  CaseContextTailCandidate,
  CaseContextTailReader,
} from "../../context/assembly";
import {
  encodeContextVisibility,
  parseContextVisibility as parseStoredContextVisibility,
} from "../../authorization/access-grants/visibility";
import { parseStoredRequestAuthority } from "../../request-authority";
import type { Result } from "../../result";
import {
  createCurrentSourceFlowLabel,
  FlowBinding,
  flowBindingMatchesTurn,
  FlowLabel,
} from "../../policy";
import { sourceReaderForAuthority } from "../../policy/information-flow/source-readers";
import { assertNever, isNonBlankString, isRecord, sha256Hex } from "@seams/std";
import {
  digest,
  equal,
  invalid,
  isPresent,
  parseAssignmentLifecycleJson,
  parseCaseBindingJson,
  parseCaseContent,
  parseCaseProposalAcceptanceJson,
  parseLifecycle,
  parseOutputLifecycleJson,
  parseSessionProposalJson,
} from "./record-parsers";
import {
  parseCaseCommerceApprovalRecordJson,
  parsePersistedCommerceProposalJson,
} from "./request-parsers";
import {
  type CaseCommerceApprovalRecord,
  type CaseMetaRow,
  type CaseOutput,
  type CaseOutputLifecycle,
  type CaseProposalAcceptance,
  type CaseResult,
  type CaseSnapshot,
  type CaseTriggerRecord,
  type ConnectorDeliveryReceipt,
  type ContextJournalRow,
  type JournalRow,
  type JsonRow,
  type LifecycleRow,
  PARTITION_INDEPENDENT_REPLAY_AUTHORITY,
  type PersistedCommerceProposal,
  type ProposalRow,
  type RawCaseOutput,
  type RawCaseOutputLifecycle,
  type RawCaseProposalAcceptance,
  type RawCaseSnapshot,
  type RestoredCaseOutput,
  type RestoredCaseOutputLifecycle,
  type RestoredCaseProposalAcceptance,
  type RestoredCaseSnapshot,
} from "./types";

export function inspectStoredCase(
  sql: SqlStorage,
): CaseResult<RawCaseSnapshot> {
  const meta = readMeta(sql);
  if (meta === null) return invalid("case_missing");
  const bindings = readBindings(sql);
  const assignmentLifecycles = readAssignmentLifecycles(sql);
  const outputs = readOutputLifecycles(sql);
  const commerceApprovals = readCommerceApprovals(sql);
  if (
    bindings === null ||
    assignmentLifecycles === null ||
    outputs === null ||
    commerceApprovals === null
  ) {
    return invalid("case_storage_corrupt");
  }
  // The snapshot names each entry and holds its preview. An entry's label
  // and authority are far larger than the rest of its row, and no reader of
  // the snapshot takes them, so this read leaves them in storage.
  const journal = sql
    .exec<Pick<JournalRow, "sequence" | "entry_id" | "digest" | "preview">>(
      `SELECT sequence, entry_id, digest, preview
       FROM case_journal
      ORDER BY sequence`,
    )
    .toArray();
  const last = journal.at(-1);
  const lifecycle = parseLifecycle(meta.lifecycle_json);
  if (
    lifecycle === null ||
    !isNonBlankString(meta.organisation_id) ||
    !isNonBlankString(meta.case_id) ||
    !isNonBlankString(meta.workspace_revision)
  )
    return invalid("case_storage_corrupt");
  return {
    ok: true,
    value: {
      identity: { organisationId: meta.organisation_id, caseId: meta.case_id },
      purpose: meta.purpose,
      workspaceRevision: meta.workspace_revision,
      revision: meta.revision,
      lifecycle,
      journalCursor:
        last === undefined
          ? { kind: "before_first" }
          : {
              kind: "accepted",
              sequence: last.sequence,
              entryDigest: last.digest,
            },
      bindings,
      assignmentLifecycles,
      acceptedProposalIds: acceptedProposalIds(sql),
      acceptedCommerceProposalIds: acceptedCommerceProposalIds(sql),
      commerceApprovals,
      entries: journal.map((row) => ({
        kind: "inline_preview",
        entryId: row.entry_id,
        digest: row.digest,
        preview: row.preview,
      })),
      outputs,
    },
  };
}

function acceptedProposalIds(sql: SqlStorage): string[] {
  return sql
    .exec<Pick<ProposalRow, "proposal_id">>(
      "SELECT proposal_id FROM case_proposal WHERE json_extract(acceptance_json, '$.disposition.kind') = 'accepted' ORDER BY proposal_id",
    )
    .toArray()
    .map((row) => row.proposal_id);
}

function acceptedCommerceProposalIds(sql: SqlStorage): string[] {
  return sql
    .exec<{ proposal_id: string }>(
      "SELECT proposal_id FROM case_commerce_proposal WHERE json_extract(acceptance_json, '$.kind') = 'accepted' ORDER BY proposal_id",
    )
    .toArray()
    .map((row) => row.proposal_id);
}

export function readCommerceProposal(
  sql: SqlStorage,
  proposalId: string,
): PersistedCommerceProposal | null {
  const row =
    sql
      .exec<JsonRow>(
        "SELECT payload FROM case_commerce_proposal WHERE proposal_id = ?",
        proposalId,
      )
      .toArray()[0] ?? null;
  return row === null ? null : parsePersistedCommerceProposalJson(row.payload);
}

export function readCommerceApproval(
  sql: SqlStorage,
  actionNonce: string,
): CaseCommerceApprovalRecord | null {
  const row =
    sql
      .exec<JsonRow>(
        "SELECT payload FROM case_commerce_approval WHERE action_nonce = ?",
        actionNonce,
      )
      .toArray()[0] ?? null;
  return row === null ? null : parseCaseCommerceApprovalRecordJson(row.payload);
}

function readCommerceApprovals(
  sql: SqlStorage,
): CaseCommerceApprovalRecord[] | null {
  const records = sql
    .exec<JsonRow>("SELECT payload FROM case_commerce_approval ORDER BY rowid")
    .toArray()
    .map((row) => parseCaseCommerceApprovalRecordJson(row.payload));
  return records.some((record) => record === null)
    ? null
    : records.filter(isPresent);
}

export function acceptedProposalBelongsTo(
  sql: SqlStorage,
  proposalId: string,
  assignment: CaseAssignment,
): boolean {
  const row =
    sql
      .exec<JsonRow & { acceptance_json: string }>(
        "SELECT payload, acceptance_json FROM case_proposal WHERE proposal_id = ?",
        proposalId,
      )
      .toArray()[0] ?? null;
  if (row === null) return false;
  const proposal = parseSessionProposalJson(row.payload);
  const acceptance = parseCaseProposalAcceptanceJson(row.acceptance_json);
  return (
    proposal !== null &&
    acceptance?.disposition.kind === "accepted" &&
    proposal.assignmentId === assignment.assignmentId &&
    proposal.sessionId === assignment.sessionId
  );
}

export function readMeta(sql: SqlStorage): CaseMetaRow | null {
  return (
    sql
      .exec<CaseMetaRow>(
        "SELECT organisation_id, case_id, purpose, workspace_revision, revision, lifecycle_json FROM case_meta WHERE singleton = 1",
      )
      .toArray()[0] ?? null
  );
}

export function readJournal(
  sql: SqlStorage,
  entryId: string,
): JournalRow | null {
  return (
    sql
      .exec<JournalRow>(
        `SELECT sequence, entry_id, digest, preview, request_authority_json,
            visibility_json, visibility_key, flow_label_json, authority_scope_json, accepted_at
       FROM case_journal
      WHERE entry_id = ?`,
        entryId,
      )
      .toArray()[0] ?? null
  );
}

export async function readCaseContextSource(
  sql: SqlStorage,
  input: Parameters<CaseContextSourceReader["read"]>[0],
): Promise<Result<CaseContextSource, CaseContextSourceReaderError>> {
  const organisationId = parseOrganisationId(input.organisationId);
  const caseId =
    input.source.kind === "case_entry"
      ? parseCaseId(input.source.caseId)
      : null;
  if (
    !organisationId.ok ||
    !caseId?.ok ||
    !Number.isSafeInteger(input.sourceRevision) ||
    input.sourceRevision < 1
  ) {
    return { ok: false, error: { code: "source_missing" } };
  }
  try {
    const row =
      sql
        .exec<ContextJournalRow>(
          `SELECT sequence, entry_id, digest, preview, payload,
              request_authority_json, visibility_json, visibility_key, flow_label_json,
              authority_scope_json, accepted_at
         FROM case_journal AS journal
         JOIN case_meta AS meta ON meta.singleton = 1
        WHERE meta.organisation_id = ? AND meta.case_id = ?
          AND journal.sequence = ? AND journal.entry_id = ?`,
          organisationId.value,
          caseId.value,
          input.sourceRevision,
          input.source.entryId,
        )
        .toArray()[0] ?? null;
    if (row === null) return { ok: false, error: { code: "source_missing" } };
    return contextSourceFromJournalRow(
      organisationId.value,
      caseId.value,
      row,
      input.source,
    );
  } catch {
    return { ok: false, error: { code: "storage_failure" } };
  }
}

export async function enqueueCaseContextProjection(
  env: Env,
  sql: SqlStorage,
  caseId: string,
  entryId: string,
): Promise<boolean> {
  const meta = readMeta(sql);
  if (meta === null || meta.case_id !== caseId) return false;
  const organisationId = parseOrganisationId(meta.organisation_id);
  if (!organisationId.ok) return false;
  const journal = readJournal(sql, entryId);
  if (journal === null) return false;
  await env.EVENT_Q.send(
    createContextProjectionCommand({
      organisationId: organisationId.value,
      source: { kind: "case_entry", caseId, entryId },
      sourceRevision: journal.sequence,
    }),
  );
  return true;
}

async function contextSourceFromJournalRow(
  organisationId: OrganisationId,
  caseId: string,
  row: ContextJournalRow,
  source: CaseContextSource["source"],
): Promise<Result<CaseContextSource, CaseContextSourceReaderError>> {
  let rawContent: unknown;
  let rawAuthority: unknown;
  let rawVisibility: unknown;
  let rawFlowLabel: unknown;
  try {
    rawContent = JSON.parse(row.payload);
    rawAuthority = JSON.parse(row.request_authority_json);
    rawVisibility = JSON.parse(row.visibility_json);
    rawFlowLabel =
      row.flow_label_json === null ? null : JSON.parse(row.flow_label_json);
  } catch {
    return { ok: false, error: { code: "storage_failure" } };
  }
  const content = parseCaseContent(rawContent);
  const authority = parseStoredRequestAuthority(rawAuthority);
  const parsedVisibility = parseStoredContextVisibility(rawVisibility);
  const visibility = parsedVisibility.ok ? parsedVisibility.value : null;
  const inputLabel = await FlowLabel.restore(rawFlowLabel);
  const replayAuthority = parseCaseContextReplayAuthority(
    row.authority_scope_json,
  );
  if (replayAuthority === null)
    return { ok: false, error: { code: "source_missing" } };
  if (
    content === null ||
    !authority.ok ||
    visibility === null ||
    !inputLabel.ok ||
    source.kind !== "case_entry" ||
    source.caseId !== caseId ||
    authority.value.requestAuthority.organisationId !== organisationId ||
    row.sequence < 1 ||
    row.accepted_at < 0 ||
    !Number.isSafeInteger(row.accepted_at) ||
    contextVisibilityKey(visibility) !== row.visibility_key ||
    !equal(
      visibility,
      sourceReaderForAuthority(authority.value.requestAuthority),
    ) ||
    row.entry_id.length === 0
  ) {
    return { ok: false, error: { code: "storage_failure" } };
  }
  return {
    ok: true,
    value: {
      organisationId,
      source,
      sourceRevision: row.sequence,
      replayAuthority,
      contentDigest: row.digest,
      content,
      visibility,
      inputLabel: inputLabel.value.toJSON(),
      observedAt: row.accepted_at,
    },
  };
}

export async function readCaseContextTail(
  sql: SqlStorage,
  input: Parameters<CaseContextTailReader["readTail"]>[0],
): Promise<readonly CaseContextTailCandidate[]> {
  const organisationId = parseOrganisationId(input.organisationId);
  const caseId = parseCaseId(input.caseId);
  if (
    !organisationId.ok ||
    !caseId.ok ||
    !digest(input.authorityPartitionDigest) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  )
    return [];
  const allowed = new Set(input.visibility.map(contextVisibilityKey));
  if (allowed.size === 0) return [];
  const placeholders = [...allowed]
    .map(contextVisibilityPlaceholder)
    .join(", ");
  const scopeKind =
    "CASE WHEN json_valid(journal.authority_scope_json) " +
    "THEN json_extract(journal.authority_scope_json, '$.kind') ELSE NULL END";
  const scopeDigest =
    "CASE WHEN json_valid(journal.authority_scope_json) " +
    "THEN json_extract(journal.authority_scope_json, '$.authorityPartitionDigest') ELSE NULL END";
  try {
    const rows = sql
      .exec<ContextJournalRow>(
        `SELECT journal.sequence, journal.entry_id, journal.digest, journal.preview,
              journal.payload, journal.request_authority_json,
              journal.visibility_json, journal.visibility_key, journal.flow_label_json,
              journal.authority_scope_json, journal.accepted_at
         FROM case_journal AS journal
         JOIN case_meta AS meta ON meta.singleton = 1
        WHERE meta.organisation_id = ? AND meta.case_id = ?
          AND journal.visibility_key IN (${placeholders})
          AND (
            ${scopeKind} = 'partition_independent'
            OR (${scopeKind} = 'authority_partition' AND ${scopeDigest} = ?${allowed.size + 3})
          )
        ORDER BY journal.sequence DESC
        LIMIT ?${allowed.size + 4}`,
        organisationId.value,
        caseId.value,
        ...allowed,
        input.authorityPartitionDigest,
        input.limit,
      )
      .toArray();
    const candidates: CaseContextTailCandidate[] = [];
    for (const row of rows) {
      const source = await contextSourceFromJournalRow(
        organisationId.value,
        caseId.value,
        row,
        { kind: "case_entry", caseId: caseId.value, entryId: row.entry_id },
      );
      if (
        !source.ok ||
        !allowed.has(contextVisibilityKey(source.value.visibility)) ||
        !replayAuthorityMatchesPartition(
          source.value.replayAuthority,
          input.authorityPartitionDigest,
        ) ||
        !(await contextSourceDigestMatches(source.value))
      )
        continue;
      const boundedExcerpt = boundedContextExcerpt(source.value.content);
      if (boundedExcerpt === null) continue;
      candidates.push({
        organisationId: source.value.organisationId,
        source: source.value.source,
        replayAuthority: source.value.replayAuthority,
        sourceRevision: source.value.sourceRevision,
        contentDigest: source.value.contentDigest,
        boundedExcerpt,
        inputLabel: source.value.inputLabel,
        observedAt: source.value.observedAt,
      });
      if (candidates.length === input.limit) break;
    }
    return candidates;
  } catch {
    return [];
  }
}

export function replayAuthorityForFlowBinding(
  binding: FlowBinding,
): CaseContextReplayAuthority {
  return replayAuthorityForPartition(binding.authorityPartitionDigest);
}

export function replayAuthorityForPartition(
  authorityPartitionDigest: string,
): CaseContextReplayAuthority {
  return Object.freeze({
    kind: "authority_partition",
    authorityPartitionDigest,
  });
}

function parseCaseContextReplayAuthority(
  value: string | null,
): CaseContextReplayAuthority | null {
  if (value === null) return null;
  try {
    const raw: unknown = JSON.parse(value);
    if (!isRecord(raw)) return null;
    if (raw.kind === "partition_independent" && Object.keys(raw).length === 1) {
      return PARTITION_INDEPENDENT_REPLAY_AUTHORITY;
    }
    return raw.kind === "authority_partition" &&
      Object.keys(raw).length === 2 &&
      digest(raw.authorityPartitionDigest)
      ? Object.freeze({
          kind: "authority_partition",
          authorityPartitionDigest: raw.authorityPartitionDigest,
        })
      : null;
  } catch {
    return null;
  }
}

function replayAuthorityMatchesPartition(
  authority: CaseContextReplayAuthority,
  authorityPartitionDigest: string,
): boolean {
  switch (authority.kind) {
    case "partition_independent":
      return true;
    case "authority_partition":
      return authority.authorityPartitionDigest === authorityPartitionDigest;
    default:
      return assertNever(authority);
  }
}

export async function contextSourceDigestMatches(
  source: CaseContextSource,
): Promise<boolean> {
  return (
    source.contentDigest === (await sha256Hex(JSON.stringify(source.content)))
  );
}

function contextVisibilityPlaceholder(_value: string, index: number): string {
  return `?${index + 3}`;
}

/** A short human-readable label for a Case entry, exhaustive by construction. */
export function caseContentPreview(content: CaseContent): string {
  switch (content.kind) {
    case "record_message":
    case "user_message":
      return caseContentAuthoredText(content.message) ?? "user message";
    case "text":
      return content.text;
    case "artifact":
      return content.preview;
    case "commerce_reference":
      return "commerce reference";
    case "entity_plane_proposal":
      return "entity-plane proposal";
    default:
      return assertNeverCaseContent(content);
  }
}

function caseContentAuthoredText(message: UserMessage): string | null {
  const authored: string[] = [];
  for (const part of [message.firstPart, ...message.remainingParts]) {
    if (part.kind === "text") authored.push(part.text);
  }
  return authored.length === 0 ? null : authored.join(" ");
}

function assertNeverCaseContent(value: never): never {
  throw new Error(`Unhandled Case content: ${JSON.stringify(value)}`);
}

function boundedContextExcerpt(content: CaseContent): string | null {
  // The model-visible excerpt renders the whole message. Authored text alone
  // would drop a file the author attached, so a later turn would have no way
  // to know it existed.
  const raw =
    content.kind === "user_message" || content.kind === "record_message"
      ? caseContentModelText(content.message)
      : content.kind === "text"
        ? content.text
        : content.kind === "artifact"
          ? content.preview
          : null;
  if (raw === null) return null;
  const normalized = raw
    .slice(0, MAX_BOUNDED_CONTEXT_TEXT_CHARS * 4)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const bounded = Array.from(normalized)
    .slice(0, MAX_BOUNDED_CONTEXT_TEXT_CHARS)
    .join("");
  return bounded.length > 0 ? bounded : null;
}

/** The same Rust rendering the turn prompt uses, so the two cannot disagree. */
function caseContentModelText(message: UserMessage): string | null {
  const derived = deriveUserMessageViews(message);

  return derived.ok
    ? derived.value.views.modelPrompt
    : caseContentAuthoredText(message);
}

export function contextVisibilityKey(visibility: ContextVisibility): string {
  return encodeContextVisibility(visibility);
}

/** A label read that started beside an admission which then refused. */
export function ignoreUnusedFlowLabel(): void {}

export async function flowLabelForAuthority(
  db: OrganisationDatabase,
  authority: RequestAuthority,
): Promise<FlowLabel | null> {
  const created = await createCurrentSourceFlowLabel({
    kind: "ingress",
    db,
    authority,
  });
  return created.ok ? created.value : null;
}

export function triggerAuthorityMatchesSource(
  trigger: CaseTriggerRecord,
): boolean {
  if (trigger.source.kind !== "connector") return true;
  switch (trigger.requestAuthority.kind) {
    case "direct_conversation":
    case "shared_conversation":
      return (
        trigger.requestAuthority.connectorId === trigger.source.connectorId
      );
    case "agent_mailbox":
      return (
        trigger.source.connectorId ===
        gmailConnectorIdValue(trigger.requestAuthority.integrationAccountId)
      );
    case "whatsapp_support":
      return (
        trigger.source.connectorId ===
        whatsappConnectorIdValue(trigger.requestAuthority.integrationAccountId)
      );
    case "workflow":
    case "control":
      return false;
  }
}

export function readBindings(sql: SqlStorage): CaseBinding[] | null {
  const values = sql
    .exec<JsonRow>("SELECT payload FROM case_binding ORDER BY rowid")
    .toArray()
    .map((row) => parseCaseBindingJson(row.payload));
  return values.some((value) => value === null)
    ? null
    : values.filter(isPresent);
}

export function readAssignmentLifecycle(
  sql: SqlStorage,
  assignmentId: string,
): CaseAssignmentLifecycle | null {
  const row =
    sql
      .exec<LifecycleRow>(
        "SELECT lifecycle_json FROM case_assignment WHERE assignment_id = ?",
        assignmentId,
      )
      .toArray()[0] ?? null;
  return row === null ? null : parseAssignmentLifecycleJson(row.lifecycle_json);
}

export function readAssignmentLifecycles(
  sql: SqlStorage,
): CaseAssignmentLifecycle[] | null {
  const values = sql
    .exec<LifecycleRow>(
      "SELECT lifecycle_json FROM case_assignment ORDER BY rowid",
    )
    .toArray()
    .map((row) => parseAssignmentLifecycleJson(row.lifecycle_json));
  return values.some((value) => value === null)
    ? null
    : values.filter(isPresent);
}

export function readOutputLifecycle(
  sql: SqlStorage,
  outputId: string,
): RawCaseOutputLifecycle | null {
  const row =
    sql
      .exec<LifecycleRow>(
        "SELECT lifecycle_json FROM case_output WHERE output_id = ?",
        outputId,
      )
      .toArray()[0] ?? null;
  return row === null ? null : parseOutputLifecycleJson(row.lifecycle_json);
}

function readOutputLifecycles(
  sql: SqlStorage,
): RawCaseOutputLifecycle[] | null {
  const values = sql
    .exec<LifecycleRow>("SELECT lifecycle_json FROM case_output ORDER BY rowid")
    .toArray()
    .map((row) => parseOutputLifecycleJson(row.lifecycle_json));
  return values.some((value) => value === null)
    ? null
    : values.filter(isPresent);
}

async function restoreStoredFlowBinding(
  raw: unknown,
): Promise<CaseResult<FlowBinding>> {
  const restored = await FlowBinding.restore(raw);
  return restored.ok ? restored : invalid("case_flow_binding_invalid");
}

export async function restoreCaseOutput(
  stored: RawCaseOutput,
): Promise<CaseResult<RestoredCaseOutput>> {
  const binding = await restoreStoredFlowBinding(stored.flowBinding);
  if (binding.ok && !outputSourceMatchesWork(stored, binding.value))
    return invalid("case_output_source_mismatch");
  return binding.ok
    ? { ok: true, value: { ...stored, flowBinding: binding.value } }
    : binding;
}

function outputSourceMatchesWork(
  output: RawCaseOutput,
  binding: FlowBinding,
): boolean {
  const source = output.source;
  switch (source.kind) {
    case "agent_turn":
      return (
        source.sessionId === binding.sessionId &&
        source.turnId === binding.turnId
      );
    case "commerce_outcome":
    case "commerce_approval_notice":
      return true;
    case "operator_command":
      return (
        binding.sessionId === source.commandId &&
        binding.turnId === `goal:${source.commandId}`
      );
    default:
      return assertNever(source);
  }
}

export async function restoreOutputLifecycle(
  stored: RawCaseOutputLifecycle,
): Promise<CaseResult<RestoredCaseOutputLifecycle>> {
  const output = await restoreCaseOutput(stored.output);
  if (!output.ok) return output;
  if (
    stored.kind === "dropped" ||
    stored.kind === "held" ||
    stored.kind === "rejected"
  )
    return { ok: true, value: { ...stored, output: output.value } };
  return stored.kind === "pending"
    ? { ok: true, value: { kind: "pending", output: output.value } }
    : {
        ok: true,
        value: {
          kind: "settled",
          output: output.value,
          receipt: stored.receipt,
        },
      };
}

export async function restoreCaseProposalAcceptance(
  stored: RawCaseProposalAcceptance,
): Promise<CaseResult<RestoredCaseProposalAcceptance>> {
  const outputs: RestoredCaseOutput[] = [];
  for (const output of stored.outputs) {
    const restored = await restoreCaseOutput(output);
    if (!restored.ok) return restored;
    outputs.push(restored.value);
  }
  return { ok: true, value: { ...stored, outputs } };
}

export async function restoreCaseSnapshot(
  stored: RawCaseSnapshot,
): Promise<CaseResult<RestoredCaseSnapshot>> {
  const outputs: RestoredCaseOutputLifecycle[] = [];
  for (const output of stored.outputs) {
    const restored = await restoreOutputLifecycle(output);
    if (!restored.ok) return restored;
    outputs.push(restored.value);
  }
  return { ok: true, value: { ...stored, outputs } };
}

export function serializeCaseOutput(output: RestoredCaseOutput): CaseOutput {
  return { ...output, flowBinding: output.flowBinding.toJSON() };
}

export function serializeOutputLifecycle(
  output: RestoredCaseOutputLifecycle,
): CaseOutputLifecycle {
  if (
    output.kind === "dropped" ||
    output.kind === "held" ||
    output.kind === "rejected"
  )
    return { ...output, output: serializeCaseOutput(output.output) };
  return output.kind === "pending"
    ? { kind: "pending", output: serializeCaseOutput(output.output) }
    : {
        kind: "settled",
        output: serializeCaseOutput(output.output),
        receipt: output.receipt,
      };
}

export function serializeCaseProposalAcceptance(
  output: RestoredCaseProposalAcceptance,
): CaseProposalAcceptance {
  return {
    ...output,
    outputs: output.outputs.map(serializeCaseOutput),
  };
}

export function serializeCaseSnapshot(
  snapshot: RestoredCaseSnapshot,
): CaseSnapshot {
  return {
    ...snapshot,
    outputs: snapshot.outputs.map(serializeOutputLifecycle),
  };
}

export async function readOutputFlowBinding(
  sql: SqlStorage,
  outputId: string,
): Promise<CaseResult<FlowBinding>> {
  const lifecycle = readOutputLifecycle(sql, outputId);
  return lifecycle === null
    ? invalid("case_output_missing")
    : restoreStoredFlowBinding(lifecycle.output.flowBinding);
}

export async function readCommerceProposalFlowBinding(
  sql: SqlStorage,
  proposalId: string,
): Promise<CaseResult<FlowBinding>> {
  const row =
    sql
      .exec<JsonRow & { readonly acceptance_json: string }>(
        "SELECT acceptance_json FROM case_commerce_proposal WHERE proposal_id = ?",
        proposalId,
      )
      .toArray()[0] ?? null;
  if (row === null) return invalid("case_commerce_proposal_missing");
  let raw: unknown;
  try {
    raw = JSON.parse(row.acceptance_json);
  } catch {
    return invalid("case_flow_binding_invalid");
  }
  return isRecord(raw) && raw.flowBinding !== undefined
    ? restoreStoredFlowBinding(raw.flowBinding)
    : invalid("case_flow_binding_invalid");
}

export function parsePersistedCommerceProposalFlowBinding(
  value: string,
): unknown | null {
  try {
    const decoded: unknown = JSON.parse(value);
    return isRecord(decoded) && isRecord(decoded.flowBinding)
      ? decoded.flowBinding
      : null;
  } catch {
    return null;
  }
}

export function journalEntryExists(sql: SqlStorage, entryId: string): boolean {
  return (
    sql
      .exec<Record<string, SqlStorageValue> & { found: number }>(
        "SELECT 1 AS found FROM case_journal WHERE entry_id = ?",
        entryId,
      )
      .toArray()[0] !== undefined
  );
}

export function assignmentMatches(
  assignment: CaseAssignment,
  caseId: string,
  assignmentId: string,
  sessionId: string,
  caseRevision: number,
): boolean {
  return (
    assignment.caseId === caseId &&
    assignment.assignmentId === assignmentId &&
    assignment.sessionId === sessionId &&
    assignment.caseRevision === caseRevision
  );
}

export function bindingMatchesAssignmentTurn(
  binding: FlowBinding,
  assignment: CaseAssignment,
  turnId: string | null,
  organisationId: string,
): boolean {
  return (
    turnId !== null &&
    flowBindingMatchesTurn(binding, {
      organisationId,
      sessionId: assignment.sessionId,
      turnId,
      authorityPartitionDigest: assignment.authorityPartition.digest,
    })
  );
}

export function receiptMatchesOutput(
  receipt: ConnectorDeliveryReceipt,
  output: RawCaseOutput,
): boolean {
  return (
    receipt.deliveryId === output.delivery.deliveryId &&
    receipt.connectorId === output.connectorId &&
    receipt.idempotencyKey === output.delivery.idempotencyKey
  );
}

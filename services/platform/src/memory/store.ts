import {
  parseMemoryAuthor,
  parseMemoryCommand,
  parseMemoryCommandReceipt,
  parseMemoryContent,
  parseMemoryRevisionState,
  parseMemoryRevisionView,
} from "@seams/control-api";
import type {
  MemoryAuthor,
  MemoryCommandErrorCode,
  MemoryCommandReceipt,
  MemoryContent,
  MemoryDecision,
  MemoryRevisionState,
  MemoryRevisionView,
} from "@seams/control-api";
import type { CommerceEntityRef } from "@seams/contracts";
import {
  assertNever,
  canonicalJson,
  isPositiveInteger,
  isRecord,
  parseJsonOrNull,
} from "@seams/std";
import type { Variant } from "@seams/type-utils";
import { parseEntityRef } from "@seams/commerce-client";

import type { SchemaTransaction } from "../actors/schema-migrations";
import type { CountRow } from "../actors/sql-rows";
import type { OrganisationId } from "../ids";
import {
  acceptedByPersonFlowLabel,
  canonicalFlowLabel,
  digestCanonical,
  FlowLabel,
  joinFlowLabels,
} from "../policy/information-flow";
import type { Result } from "../result";

declare const memoryRevisionBrand: unique symbol;

/**
 * One stored revision with the restrictions its evidence and author
 * contributed. Only this module's reads produce one.
 */
export type MemoryRevision = MemoryRevisionView &
  Readonly<{
    flowLabel: FlowLabel;
    [memoryRevisionBrand]: "MemoryRevision";
  }>;

export type Memory = Readonly<{
  organisationId: OrganisationId;
  memoryId: string;
  headRevision: number;
  revisions: readonly MemoryRevision[];
}>;

/**
 * One command against the store. A proposal carries its author and the joined
 * label; a decision carries the person who made it. An agent can author a
 * proposal and has no branch that decides one.
 */
export type MemoryStoreCommand = Readonly<{
  commandId: string;
  expectedRevision: number;
}> &
  (
    | Readonly<{
        kind: "propose";
        memoryId: string | null;
        /** The identity a new Memory takes. Ignored when `memoryId` is set. */
        newMemoryId: string;
        content: MemoryContent;
        author: MemoryAuthor;
        flowLabel: FlowLabel;
        revision?: never;
        reviewerPersonId?: never;
      }>
    | Readonly<{
        kind: "accept" | "reject" | "revoke";
        memoryId: string;
        revision: number;
        reviewerPersonId: string;
        newMemoryId?: never;
        content?: never;
        author?: never;
        flowLabel?: never;
      }>
  );

type MemoryCommandError = Readonly<{ code: MemoryCommandErrorCode }>;

/**
 * Who a command comes from, as its caller authenticated them. A person's
 * submission context arrives with the proposal, not with their identity.
 */
type MemoryPrincipal =
  | Variant<MemoryAuthor, "agent">
  | Readonly<{ kind: "operator"; personId: string }>;

/** A Memory as it crosses the Actor boundary, each label in canonical form. */
export type SerializedMemory = Readonly<{
  memoryId: string;
  headRevision: number;
  revisions: readonly (MemoryRevisionView &
    Readonly<{ flowLabel: ReturnType<typeof canonicalFlowLabel> }>)[];
}>;

type MemoryReadError = Readonly<{
  code: "memory_persisted_state_invalid";
}>;

type MemoryCommandInput = Readonly<{
  sql: SqlStorage;
  transaction: SchemaTransaction;
  organisationId: OrganisationId;
  requestDigest: string;
  now: number;
  command: MemoryStoreCommand;
  /** The revision `checkSharedReviewLabel` held the command's label to. */
  inheritedRevision: number | null;
}>;

type RevisionRow = Readonly<{
  memory_id: string;
  revision: number;
  content_json: string;
  author_json: string;
  flow_label_json: string;
  proposed_at: number;
  state_json: string;
}>;

const MAX_MEMORIES = 500;
const MAX_REVISIONS = 200;

export function createMemorySchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS memory (
    organisation_id TEXT NOT NULL, memory_id TEXT NOT NULL,
    head_revision INTEGER NOT NULL CHECK (head_revision > 0),
    PRIMARY KEY (organisation_id, memory_id)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS memory_revision (
    organisation_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
    content_json TEXT NOT NULL CHECK (json_valid(content_json)), applicability_key TEXT NOT NULL,
    author_json TEXT NOT NULL CHECK (json_valid(author_json)),
    flow_label_json TEXT NOT NULL CHECK (json_valid(flow_label_json)),
    proposed_at INTEGER NOT NULL CHECK (proposed_at >= 0),
    state TEXT NOT NULL CHECK (state IN ('candidate', 'accepted', 'rejected', 'superseded', 'revoked')),
    state_json TEXT NOT NULL CHECK (json_valid(state_json) AND json_extract(state_json, '$.kind') = state),
    PRIMARY KEY (organisation_id, memory_id, revision)
  )`);
  // A Memory has at most one accepted revision and one candidate under review.
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS memory_revision_accepted
    ON memory_revision (organisation_id, memory_id) WHERE state = 'accepted'`);
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS memory_revision_candidate
    ON memory_revision (organisation_id, memory_id) WHERE state = 'candidate'`);
  sql.exec(`CREATE INDEX IF NOT EXISTS memory_revision_applicable
    ON memory_revision (organisation_id, applicability_key) WHERE state = 'accepted'`);
  sql.exec(`CREATE TABLE IF NOT EXISTS memory_command (
    organisation_id TEXT NOT NULL, command_id TEXT NOT NULL, request_digest TEXT NOT NULL,
    receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
    PRIMARY KEY (organisation_id, command_id)
  )`);
}

/**
 * Applies one command atomically. Repeating a command returns its first
 * receipt, and reusing its identity for a different request is a conflict.
 */
export function applyMemoryCommand(
  input: MemoryCommandInput,
): Result<MemoryCommandReceipt, MemoryCommandError> {
  return input.transaction(applyCommand.bind(null, input));
}

/**
 * Turns one request into a store command. The caller has already
 * authenticated `principal` and, for a proposal, joined `flowLabel` from the
 * evidence and the author's input.
 */
export async function prepareMemoryCommand(
  input: Readonly<{ principal: unknown; body: unknown; flowLabel: unknown }>,
): Promise<
  Result<
    Readonly<{ command: MemoryStoreCommand; requestDigest: string }>,
    MemoryCommandError
  >
> {
  const principal = parseMemoryPrincipal(input.principal);
  const command = parseMemoryCommand(input.body, entityRefOrNull);
  if (principal === null || command === null) return failure("memory_invalid");
  if (command.kind !== "propose") {
    if (principal.kind !== "operator")
      return failure("memory_reviewer_required");
    if (input.flowLabel !== null) return failure("memory_invalid");
    return {
      ok: true,
      value: {
        command: {
          commandId: command.commandId,
          expectedRevision: command.expectedRevision,
          kind: command.kind,
          memoryId: command.memoryId,
          revision: command.revision,
          reviewerPersonId: principal.personId,
        },
        requestDigest: await digestCanonical({ principal, command }),
      },
    };
  }
  // Only a person edits on the shared review surface.
  if (principal.kind === "agent" && command.submission !== "own_input")
    return failure("memory_reviewer_required");
  const flowLabel = await FlowLabel.restore(input.flowLabel);
  if (!flowLabel.ok) return failure("memory_invalid");
  return {
    ok: true,
    value: {
      command: {
        commandId: command.commandId,
        expectedRevision: command.expectedRevision,
        kind: "propose",
        memoryId: command.memoryId,
        newMemoryId: `memory_${crypto.randomUUID()}`,
        content: command.content,
        author:
          principal.kind === "operator"
            ? { ...principal, submission: command.submission }
            : principal,
        flowLabel: flowLabel.value,
      },
      requestDigest: await digestCanonical({
        principal,
        command,
        flowLabelDigest: flowLabel.value.digest,
      }),
    },
  };
}

/**
 * A shared-review edit keeps every restriction of the revision it inherits
 * from: the candidate under review, or the accepted revision it proposes to
 * replace. The store checks this itself: a label that drops one of that
 * revision's policies is refused whoever assembled it. The result names the
 * revision the label was held to, and the command applies only while that is
 * still the revision it inherits from.
 */
export async function checkSharedReviewLabel(
  sql: SqlStorage,
  organisationId: OrganisationId,
  prepared: Readonly<{ command: MemoryStoreCommand; requestDigest: string }>,
): Promise<Result<number | null, MemoryCommandError>> {
  const { command } = prepared;
  if (
    command.kind !== "propose" ||
    command.author.kind !== "operator" ||
    command.author.submission !== "shared_review"
  )
    return { ok: true, value: null };
  // A command already applied is answered from its receipt. The Memory has
  // moved on since, so there is no current revision to hold its label to.
  const replayed = replayMemoryCommand({
    sql,
    organisationId,
    commandId: command.commandId,
    requestDigest: prepared.requestDigest,
  });
  if (!replayed.ok) return replayed;
  if (replayed.value !== null) return { ok: true, value: null };
  if (command.memoryId === null) return failure("memory_invalid");
  const head = readHeadRevision(sql, organisationId, command.memoryId);
  if (head === null) return failure("memory_unavailable");
  if (head !== command.expectedRevision) return failure("memory_conflict");
  const inherited = sharedReviewBase(
    sql,
    organisationId,
    command.memoryId,
    head,
  );
  if (inherited === null) return failure("memory_conflict");
  const row = sql
    .exec<{ flow_label_json: string }>(
      "SELECT flow_label_json FROM memory_revision WHERE organisation_id = ? AND memory_id = ? AND revision = ?",
      organisationId,
      command.memoryId,
      inherited,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("memory_revision_state_invalid");
  const base = await FlowLabel.restore(parseJsonOrNull(row.flow_label_json));
  if (!base.ok) throw new Error("memory_revision_label_invalid");
  const joined = await joinFlowLabels(command.flowLabel, base.value);
  return joined.ok && joined.value.digest === command.flowLabel.digest
    ? { ok: true, value: inherited }
    : failure("memory_invalid");
}

export function serializeMemory(memory: Memory): SerializedMemory {
  return {
    memoryId: memory.memoryId,
    headRevision: memory.headRevision,
    revisions: memory.revisions.map((revision) => ({
      ...revision,
      flowLabel: canonicalFlowLabel(revision.flowLabel),
    })),
  };
}

/** One accepted revision as it crosses the Actor boundary. */
export type SerializedAcceptedMemory = Readonly<{
  memoryId: string;
  revision: SerializedMemory["revisions"][number];
}>;

/** Where one page of accepted revisions ended. */
export type AcceptedMemoryCursor = Readonly<{
  applicabilityKey: string;
  memoryId: string;
}>;

/**
 * One page of the accepted revisions whose scope is one of
 * `applicabilityKeys`, read through the applicability index in a stable
 * order. `next` is the cursor for the following page, or null at the end.
 */
export function readAcceptedMemories(
  sql: SqlStorage,
  organisationId: OrganisationId,
  applicabilityKeys: readonly string[],
  after: AcceptedMemoryCursor | null,
  limit: number,
): Result<
  Readonly<{
    accepted: readonly SerializedAcceptedMemory[];
    next: AcceptedMemoryCursor | null;
  }>,
  MemoryReadError
> {
  const keys = [...new Set(applicabilityKeys)];
  const rows = sql
    .exec<RevisionRow & Readonly<{ applicability_key: string }>>(
      `SELECT memory_id, revision, content_json, author_json, flow_label_json,
              proposed_at, state_json, applicability_key
       FROM memory_revision
       WHERE organisation_id = ? AND state = 'accepted'
         AND applicability_key IN (${keys.map(() => "?").join(", ")})
         AND (applicability_key, memory_id) > (?, ?)
       ORDER BY applicability_key, memory_id LIMIT ?`,
      organisationId,
      ...keys,
      after?.applicabilityKey ?? "",
      after?.memoryId ?? "",
      limit,
    )
    .toArray();
  const accepted: SerializedAcceptedMemory[] = [];
  for (const row of rows) {
    const view = parseRevisionRow(row);
    const flowLabel: unknown = parseJsonOrNull(row.flow_label_json);
    if (view === null || !isRecord(flowLabel))
      return { ok: false, error: { code: "memory_persisted_state_invalid" } };
    accepted.push({
      memoryId: row.memory_id,
      // The label is verified where it is restored, on the other side.
      revision: {
        ...view,
        flowLabel:
          flowLabel as SerializedAcceptedMemory["revision"]["flowLabel"],
      },
    });
  }
  const last = rows.at(-1);
  return {
    ok: true,
    value: {
      accepted,
      next:
        last === undefined || rows.length < limit
          ? null
          : {
              applicabilityKey: last.applicability_key,
              memoryId: last.memory_id,
            },
    },
  };
}

/**
 * The accepted revision of each named Memory that has one. A Memory with no
 * accepted revision, or that does not exist, has no entry.
 */
export function readAcceptedMemoryRevisions(
  sql: SqlStorage,
  organisationId: OrganisationId,
  memoryIds: readonly string[],
): Result<readonly SerializedAcceptedMemory[], MemoryReadError> {
  const ids = [...new Set(memoryIds)];
  if (ids.length === 0) return { ok: true, value: [] };
  const rows = sql
    .exec<RevisionRow>(
      `SELECT memory_id, revision, content_json, author_json, flow_label_json,
              proposed_at, state_json
       FROM memory_revision
       WHERE organisation_id = ? AND state = 'accepted'
         AND memory_id IN (${ids.map(() => "?").join(", ")})
       ORDER BY memory_id`,
      organisationId,
      ...ids,
    )
    .toArray();
  const accepted: SerializedAcceptedMemory[] = [];
  for (const row of rows) {
    const view = parseRevisionRow(row);
    const flowLabel: unknown = parseJsonOrNull(row.flow_label_json);
    if (view === null || !isRecord(flowLabel))
      return { ok: false, error: { code: "memory_persisted_state_invalid" } };
    accepted.push({
      memoryId: row.memory_id,
      // The label is verified where it is restored, on the other side.
      revision: {
        ...view,
        flowLabel:
          flowLabel as SerializedAcceptedMemory["revision"]["flowLabel"],
      },
    });
  }
  return { ok: true, value: accepted };
}

/** Rebuilds one accepted revision, verifying its label. */
export async function restoreAcceptedMemory(
  raw: SerializedAcceptedMemory,
): Promise<Readonly<{ memoryId: string; revision: MemoryRevision }> | null> {
  const { flowLabel: rawLabel, ...rawView } = raw.revision;
  const view = parseMemoryRevisionView(rawView, entityRefOrNull);
  const flowLabel = await FlowLabel.restore(rawLabel);
  return view === null || view.kind !== "accepted" || !flowLabel.ok
    ? null
    : {
        memoryId: raw.memoryId,
        // A person accepted this text, so it enters a turn with no writer.
        revision: storedRevision(
          view,
          await acceptedByPersonFlowLabel(flowLabel.value),
        ),
      };
}

/** Rebuilds a Memory from its Actor-boundary form, verifying every label. */
export async function restoreSerializedMemory(
  organisationId: OrganisationId,
  raw: unknown,
): Promise<Memory | null> {
  if (
    !isRecord(raw) ||
    typeof raw.memoryId !== "string" ||
    !isPositiveInteger(raw.headRevision) ||
    !Array.isArray(raw.revisions) ||
    raw.revisions.length !== raw.headRevision
  )
    return null;
  const revisions: MemoryRevision[] = [];
  for (const entry of raw.revisions) {
    if (!isRecord(entry)) return null;
    const { flowLabel: rawLabel, ...rawView } = entry;
    const view = parseMemoryRevisionView(rawView, entityRefOrNull);
    const flowLabel = await FlowLabel.restore(rawLabel);
    if (view === null || !flowLabel.ok) return null;
    revisions.push(storedRevision(view, flowLabel.value));
  }
  return {
    organisationId,
    memoryId: raw.memoryId,
    headRevision: raw.headRevision,
    revisions,
  };
}

function replayMemoryCommand(
  input: Readonly<{
    sql: SqlStorage;
    organisationId: OrganisationId;
    commandId: string;
    requestDigest: string;
  }>,
): Result<MemoryCommandReceipt | null, MemoryCommandError> {
  if (!/^[a-f0-9]{64}$/u.test(input.requestDigest))
    return failure("memory_invalid");
  const row = input.sql
    .exec<{ request_digest: string; receipt_json: string }>(
      "SELECT request_digest, receipt_json FROM memory_command WHERE organisation_id = ? AND command_id = ?",
      input.organisationId,
      input.commandId,
    )
    .toArray()[0];
  if (row === undefined) return { ok: true, value: null };
  if (row.request_digest !== input.requestDigest)
    return failure("memory_command_conflict");
  const receipt = parseMemoryCommandReceipt(parseJsonOrNull(row.receipt_json));
  if (receipt === null) throw new Error("memory_command_receipt_invalid");
  return { ok: true, value: receipt };
}

/**
 * The receipt an applied command left, whatever a later request under the
 * same identity carries. It lets a repeated run name the first result.
 */
export function readMemoryCommandReceipt(
  sql: SqlStorage,
  organisationId: OrganisationId,
  commandId: string,
): MemoryCommandReceipt | null {
  const row = sql
    .exec<{ receipt_json: string }>(
      "SELECT receipt_json FROM memory_command WHERE organisation_id = ? AND command_id = ?",
      organisationId,
      commandId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const receipt = parseMemoryCommandReceipt(parseJsonOrNull(row.receipt_json));
  if (receipt === null) throw new Error("memory_command_receipt_invalid");
  return receipt;
}

export async function readMemory(
  sql: SqlStorage,
  organisationId: OrganisationId,
  memoryId: string,
): Promise<Result<Memory | null, MemoryReadError>> {
  const headRevision = readHeadRevision(sql, organisationId, memoryId);
  if (headRevision === null) return { ok: true, value: null };
  const rows = sql
    .exec<RevisionRow>(
      `SELECT memory_id, revision, content_json, author_json, flow_label_json, proposed_at, state_json
       FROM memory_revision WHERE organisation_id = ? AND memory_id = ? ORDER BY revision`,
      organisationId,
      memoryId,
    )
    .toArray();
  return restoreMemory(organisationId, memoryId, headRevision, rows);
}

export async function listMemories(
  sql: SqlStorage,
  organisationId: OrganisationId,
): Promise<Result<readonly Memory[], MemoryReadError>> {
  const heads = sql
    .exec<{ memory_id: string; head_revision: number }>(
      "SELECT memory_id, head_revision FROM memory WHERE organisation_id = ? ORDER BY memory_id",
      organisationId,
    )
    .toArray();
  const rows = sql
    .exec<RevisionRow>(
      `SELECT memory_id, revision, content_json, author_json, flow_label_json, proposed_at, state_json
       FROM memory_revision WHERE organisation_id = ? ORDER BY memory_id, revision`,
      organisationId,
    )
    .toArray();
  const memories: Memory[] = [];
  for (const head of heads) {
    const memory = await restoreMemory(
      organisationId,
      head.memory_id,
      head.head_revision,
      rows.filter((row) => row.memory_id === head.memory_id),
    );
    if (!memory.ok) return memory;
    memories.push(memory.value);
  }
  return { ok: true, value: memories };
}

function applyCommand(
  input: MemoryCommandInput,
): Result<MemoryCommandReceipt, MemoryCommandError> {
  const replayed = replayMemoryCommand({
    sql: input.sql,
    organisationId: input.organisationId,
    commandId: input.command.commandId,
    requestDigest: input.requestDigest,
  });
  if (!replayed.ok) return replayed;
  if (replayed.value !== null) return { ok: true, value: replayed.value };
  const command = input.command;
  const applied =
    command.kind === "propose"
      ? propose(input, command)
      : decide(input, command);
  if (!applied.ok) return applied;
  input.sql.exec(
    "INSERT INTO memory_command VALUES (?, ?, ?, ?)",
    input.organisationId,
    command.commandId,
    input.requestDigest,
    JSON.stringify(applied.value),
  );
  return applied;
}

function propose(
  input: MemoryCommandInput,
  command: Variant<MemoryStoreCommand, "propose">,
): Result<MemoryCommandReceipt, MemoryCommandError> {
  const { sql, organisationId } = input;
  if (command.memoryId === null) {
    if (command.expectedRevision !== 0) return failure("memory_invalid");
    const count = sql
      .exec<CountRow>(
        "SELECT COUNT(*) AS count FROM memory WHERE organisation_id = ?",
        organisationId,
      )
      .toArray()[0]?.count;
    if (count === undefined || count >= MAX_MEMORIES)
      return failure("memory_capacity_exceeded");
    if (readHeadRevision(sql, organisationId, command.newMemoryId) !== null)
      return failure("memory_conflict");
    sql.exec(
      "INSERT INTO memory VALUES (?, ?, 1)",
      organisationId,
      command.newMemoryId,
    );
    insertCandidate(input, command, command.newMemoryId, 1);
    return receipt(command, command.newMemoryId, 1, 1, "candidate");
  }
  const head = readHeadRevision(sql, organisationId, command.memoryId);
  if (head === null) return failure("memory_unavailable");
  if (head !== command.expectedRevision) return failure("memory_conflict");
  if (head >= MAX_REVISIONS) return failure("memory_capacity_exceeded");
  const next = head + 1;
  const headState = readRevisionState(
    sql,
    organisationId,
    command.memoryId,
    head,
  );
  // A shared edit needs a revision to inherit from. Proposed against an
  // accepted revision it is a replacement, and that revision stays in force
  // until the replacement is accepted.
  if (
    command.author.kind === "operator" &&
    command.author.submission === "shared_review" &&
    (input.inheritedRevision === null ||
      sharedReviewBase(sql, organisationId, command.memoryId, head) !==
        input.inheritedRevision)
  )
    return failure("memory_conflict");
  if (headState.kind === "candidate") {
    // Only a person may replace a candidate under review; the earlier text
    // stays in history as revised.
    if (command.author.kind !== "operator") return failure("memory_conflict");
    writeRevisionState(sql, organisationId, command.memoryId, head, {
      kind: "rejected",
      rejection: {
        ...decision(input, command.author.personId),
        reason: "revised",
        replacementRevision: next,
      },
    });
  }
  insertCandidate(input, command, command.memoryId, next);
  sql.exec(
    "UPDATE memory SET head_revision = ? WHERE organisation_id = ? AND memory_id = ?",
    next,
    organisationId,
    command.memoryId,
  );
  return receipt(command, command.memoryId, next, next, "candidate");
}

function decide(
  input: MemoryCommandInput,
  command: Variant<MemoryStoreCommand, "accept" | "reject" | "revoke">,
): Result<MemoryCommandReceipt, MemoryCommandError> {
  const { sql, organisationId } = input;
  const { memoryId, revision } = command;
  const head = readHeadRevision(sql, organisationId, memoryId);
  if (head === null) return failure("memory_unavailable");
  if (head !== command.expectedRevision) return failure("memory_conflict");
  if (revision > head) return failure("memory_invalid");
  const state = readRevisionState(sql, organisationId, memoryId, revision);
  const decided = decision(input, command.reviewerPersonId);
  switch (command.kind) {
    case "accept": {
      if (state.kind !== "candidate") return failure("memory_conflict");
      const current = readAcceptedRevision(sql, organisationId, memoryId);
      // Supersede first: the store allows one accepted revision at a time.
      if (current !== null)
        writeRevisionState(sql, organisationId, memoryId, current.revision, {
          kind: "superseded",
          acceptance: current.acceptance,
          supersession: {
            replacementRevision: revision,
            supersededAt: input.now,
          },
        });
      writeRevisionState(sql, organisationId, memoryId, revision, {
        kind: "accepted",
        acceptance: decided,
      });
      return receipt(command, memoryId, revision, head, "accepted");
    }
    case "reject":
      if (state.kind !== "candidate") return failure("memory_conflict");
      writeRevisionState(sql, organisationId, memoryId, revision, {
        kind: "rejected",
        rejection: { ...decided, reason: "declined" },
      });
      return receipt(command, memoryId, revision, head, "rejected");
    case "revoke":
      if (state.kind !== "accepted") return failure("memory_conflict");
      writeRevisionState(sql, organisationId, memoryId, revision, {
        kind: "revoked",
        acceptance: state.acceptance,
        revocation: decided,
      });
      return receipt(command, memoryId, revision, head, "revoked");
    default:
      return assertNever(command.kind);
  }
}

function insertCandidate(
  input: MemoryCommandInput,
  command: Variant<MemoryStoreCommand, "propose">,
  memoryId: string,
  revision: number,
): void {
  const state: MemoryRevisionState = { kind: "candidate" };
  input.sql.exec(
    `INSERT INTO memory_revision (
       organisation_id, memory_id, revision, content_json, applicability_key,
       author_json, flow_label_json, proposed_at, state, state_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.organisationId,
    memoryId,
    revision,
    JSON.stringify(command.content),
    memoryApplicabilityKey(command.content.applicability),
    JSON.stringify(command.author),
    JSON.stringify(canonicalFlowLabel(command.flowLabel)),
    input.now,
    state.kind,
    JSON.stringify(state),
  );
}

/** The exact-match key an applicable Memory is found by. */
export function memoryApplicabilityKey(
  applicability: MemoryContent["applicability"],
): string {
  return canonicalJson(applicability);
}

function readHeadRevision(
  sql: SqlStorage,
  organisationId: OrganisationId,
  memoryId: string,
): number | null {
  const row = sql
    .exec<{
      head_revision: number;
    }>(
      "SELECT head_revision FROM memory WHERE organisation_id = ? AND memory_id = ?",
      organisationId,
      memoryId,
    )
    .toArray()[0];
  return row === undefined ? null : row.head_revision;
}

function readRevisionState(
  sql: SqlStorage,
  organisationId: OrganisationId,
  memoryId: string,
  revision: number,
): MemoryRevisionState {
  const row = sql
    .exec<{
      state_json: string;
    }>(
      "SELECT state_json FROM memory_revision WHERE organisation_id = ? AND memory_id = ? AND revision = ?",
      organisationId,
      memoryId,
      revision,
    )
    .toArray()[0];
  const state =
    row === undefined
      ? null
      : parseMemoryRevisionState(parseJsonOrNull(row.state_json));
  if (state === null) throw new Error("memory_revision_state_invalid");
  return state;
}

/**
 * The revision a shared-review edit inherits its audience from: the candidate
 * under review, or else the accepted revision the edit proposes to replace.
 */
function sharedReviewBase(
  sql: SqlStorage,
  organisationId: OrganisationId,
  memoryId: string,
  head: number,
): number | null {
  return readRevisionState(sql, organisationId, memoryId, head).kind ===
    "candidate"
    ? head
    : (readAcceptedRevision(sql, organisationId, memoryId)?.revision ?? null);
}

function readAcceptedRevision(
  sql: SqlStorage,
  organisationId: OrganisationId,
  memoryId: string,
): Readonly<{ revision: number; acceptance: MemoryDecision }> | null {
  const row = sql
    .exec<{
      revision: number;
      state_json: string;
    }>(
      "SELECT revision, state_json FROM memory_revision WHERE organisation_id = ? AND memory_id = ? AND state = 'accepted'",
      organisationId,
      memoryId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const state = parseMemoryRevisionState(parseJsonOrNull(row.state_json));
  if (state?.kind !== "accepted")
    throw new Error("memory_revision_state_invalid");
  return { revision: row.revision, acceptance: state.acceptance };
}

function writeRevisionState(
  sql: SqlStorage,
  organisationId: OrganisationId,
  memoryId: string,
  revision: number,
  state: MemoryRevisionState,
): void {
  sql.exec(
    "UPDATE memory_revision SET state = ?, state_json = ? WHERE organisation_id = ? AND memory_id = ? AND revision = ?",
    state.kind,
    JSON.stringify(state),
    organisationId,
    memoryId,
    revision,
  );
}

async function restoreMemory(
  organisationId: OrganisationId,
  memoryId: string,
  headRevision: number,
  rows: readonly RevisionRow[],
): Promise<Result<Memory, MemoryReadError>> {
  const revisions: MemoryRevision[] = [];
  for (const row of rows) {
    const revision = await restoreRevision(row);
    if (revision === null)
      return { ok: false, error: { code: "memory_persisted_state_invalid" } };
    revisions.push(revision);
  }
  return revisions.length === headRevision
    ? { ok: true, value: { organisationId, memoryId, headRevision, revisions } }
    : { ok: false, error: { code: "memory_persisted_state_invalid" } };
}

async function restoreRevision(
  row: RevisionRow,
): Promise<MemoryRevision | null> {
  const view = parseRevisionRow(row);
  const flowLabel = await FlowLabel.restore(
    parseJsonOrNull(row.flow_label_json),
  );
  return view === null || !flowLabel.ok
    ? null
    : storedRevision(view, flowLabel.value);
}

function parseRevisionRow(row: RevisionRow): MemoryRevisionView | null {
  const content = parseMemoryContent(
    parseJsonOrNull(row.content_json),
    entityRefOrNull,
  );
  const proposedBy = parseMemoryAuthor(parseJsonOrNull(row.author_json));
  const state = parseMemoryRevisionState(parseJsonOrNull(row.state_json));
  return content === null || proposedBy === null || state === null
    ? null
    : {
        ...content,
        revision: row.revision,
        proposedBy,
        proposedAt: row.proposed_at,
        ...state,
      };
}

// A parsed view and its verified label are the only source of a stored revision.
function storedRevision(
  view: MemoryRevisionView,
  flowLabel: FlowLabel,
): MemoryRevision {
  return { ...view, flowLabel } as MemoryRevision;
}

/** The commerce entity reference `raw` holds, or null when it is not one. */
export function entityRefOrNull(raw: unknown): CommerceEntityRef | null {
  try {
    return parseEntityRef(raw);
  } catch {
    return null;
  }
}

function parseMemoryPrincipal(raw: unknown): MemoryPrincipal | null {
  if (
    isRecord(raw) &&
    raw.kind === "operator" &&
    Object.keys(raw).length === 2 &&
    typeof raw.personId === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9:_./-]{0,199}$/u.test(raw.personId)
  )
    return { kind: "operator", personId: raw.personId };
  const author = parseMemoryAuthor(raw);
  return author?.kind === "agent" ? author : null;
}

function decision(
  input: MemoryCommandInput,
  reviewerPersonId: string,
): MemoryDecision {
  return {
    reviewerPersonId,
    commandId: input.command.commandId,
    decidedAt: input.now,
  };
}

function receipt(
  command: MemoryStoreCommand,
  memoryId: string,
  revision: number,
  headRevision: number,
  state: MemoryRevisionState["kind"],
): Result<MemoryCommandReceipt, MemoryCommandError> {
  return {
    ok: true,
    value: {
      commandId: command.commandId,
      memoryId,
      revision,
      headRevision,
      state,
    },
  };
}

function failure(
  code: MemoryCommandErrorCode,
): Result<never, MemoryCommandError> {
  return { ok: false, error: { code } };
}

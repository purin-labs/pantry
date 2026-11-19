import {
  parseEvalAuthor,
  parseEvalCommand,
  parseEvalCommandReceipt,
  parseEvalContent,
  parseEvalRevisionView,
  parseEvalRunResult,
  parseMemoryRevisionState,
} from "@purin-labs/control-api";
import type {
  EvalAuthor,
  EvalCommandErrorCode,
  EvalCommandReceipt,
  EvalContent,
  EvalRevisionState,
  EvalRevisionView,
  EvalRunResult,
  MemoryDecision,
} from "@purin-labs/control-api";
import {
  assertNever,
  hasExactKeys,
  isPositiveInteger,
  isRecord,
  parseJsonOrNull,
  sameJson,
} from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";

import type { SchemaTransaction } from "../actors/schema-migrations";
import type { CountRow } from "../actors/sql-rows";
import type { OrganisationId } from "../ids";
import {
  canonicalFlowLabel,
  digestCanonical,
  FlowLabel,
  joinFlowLabels,
} from "../policy/information-flow";
import type { Result } from "../result";

declare const evalRevisionBrand: unique symbol;

/**
 * One stored revision with the restrictions its evidence and author
 * contributed. Only this module's reads produce one.
 */
export type EvalRevision = EvalRevisionView &
  Readonly<{
    flowLabel: FlowLabel;
    [evalRevisionBrand]: "EvalRevision";
  }>;

export type Eval = Readonly<{
  organisationId: OrganisationId;
  evalId: string;
  headRevision: number;
  revisions: readonly EvalRevision[];
}>;

/**
 * One command against the store. A proposal carries its author and the joined
 * label; a decision carries the person who made it. Pantry proposes a new
 * Eval, a person revises an existing one, and only a person decides.
 */
export type EvalStoreCommand = Readonly<{
  commandId: string;
  expectedRevision: number;
}> &
  (
    | Readonly<{
        kind: "propose";
        evalId: string | null;
        /** The identity a new Eval takes. Ignored when `evalId` is set. */
        newEvalId: string;
        content: EvalContent;
        author: EvalAuthor;
        flowLabel: FlowLabel;
        revision?: never;
        reviewerPersonId?: never;
      }>
    | Readonly<{
        kind: "accept" | "reject" | "revoke";
        evalId: string;
        revision: number;
        reviewerPersonId: string;
        newEvalId?: never;
        content?: never;
        author?: never;
        flowLabel?: never;
      }>
  );

type EvalCommandError = Readonly<{ code: EvalCommandErrorCode }>;

/** An Eval as it crosses the Actor boundary, each label in canonical form. */
type SerializedEval = Readonly<{
  evalId: string;
  headRevision: number;
  revisions: readonly (EvalRevisionView &
    Readonly<{ flowLabel: ReturnType<typeof canonicalFlowLabel> }>)[];
}>;

type EvalReadError = Readonly<{
  code: "eval_persisted_state_invalid";
}>;

type EvalCommandInput = Readonly<{
  sql: SqlStorage;
  transaction: SchemaTransaction;
  organisationId: OrganisationId;
  requestDigest: string;
  now: number;
  command: EvalStoreCommand;
  /** The revision `checkEvalReviewLabel` held the command's label to. */
  inheritedRevision: number | null;
}>;

type RevisionRow = Readonly<{
  eval_id: string;
  revision: number;
  content_json: string;
  author_json: string;
  flow_label_json: string;
  proposed_at: number;
  state_json: string;
}>;

/**
 * One settled run with the restrictions of everything its tasks observed.
 * The label joins the Eval revision's label with each task's turn label.
 */
export type StoredEvalRunResult = Readonly<{
  result: EvalRunResult;
  flowLabel: FlowLabel;
}>;

/** A settled run as it crosses the Actor boundary: its stored text. */
type SerializedEvalRunResult = Readonly<{
  resultJson: string;
  flowLabelJson: string;
}>;

/** How many Evals may be in use or wait for review at one time. */
const MAX_EVALS = 200;
/** How many Evals of any state one Organisation keeps. It bounds storage. */
const MAX_EVAL_RECORDS = 2_000;
const MAX_REVISIONS = 100;
/** How many settled runs one Eval keeps. The oldest beyond it are dropped. */
const MAX_RUN_RESULTS = 50;

export function createEvalSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS eval (
    organisation_id TEXT NOT NULL, eval_id TEXT NOT NULL,
    head_revision INTEGER NOT NULL CHECK (head_revision > 0),
    PRIMARY KEY (organisation_id, eval_id)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS eval_revision (
    organisation_id TEXT NOT NULL, eval_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
    content_json TEXT NOT NULL CHECK (json_valid(content_json)),
    author_json TEXT NOT NULL CHECK (json_valid(author_json)),
    flow_label_json TEXT NOT NULL CHECK (json_valid(flow_label_json)),
    proposed_at INTEGER NOT NULL CHECK (proposed_at >= 0),
    state TEXT NOT NULL CHECK (state IN ('candidate', 'accepted', 'rejected', 'superseded', 'revoked')),
    state_json TEXT NOT NULL CHECK (json_valid(state_json) AND json_extract(state_json, '$.kind') = state),
    PRIMARY KEY (organisation_id, eval_id, revision)
  )`);
  // An Eval has at most one accepted revision and one candidate under review.
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS eval_revision_accepted
    ON eval_revision (organisation_id, eval_id) WHERE state = 'accepted'`);
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS eval_revision_candidate
    ON eval_revision (organisation_id, eval_id) WHERE state = 'candidate'`);
  sql.exec(`CREATE TABLE IF NOT EXISTS eval_command (
    organisation_id TEXT NOT NULL, command_id TEXT NOT NULL, request_digest TEXT NOT NULL,
    receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
    PRIMARY KEY (organisation_id, command_id)
  )`);
  // Only a settled run is kept here. A run in progress lives with its Case.
  sql.exec(`CREATE TABLE IF NOT EXISTS eval_run_result (
    organisation_id TEXT NOT NULL, run_id TEXT NOT NULL, eval_id TEXT NOT NULL,
    eval_revision INTEGER NOT NULL CHECK (eval_revision > 0),
    settled_at INTEGER NOT NULL CHECK (settled_at >= 0), result_digest TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    flow_label_json TEXT NOT NULL CHECK (json_valid(flow_label_json)),
    PRIMARY KEY (organisation_id, run_id)
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS eval_run_result_eval
    ON eval_run_result (organisation_id, eval_id, settled_at)`);
}

/**
 * Records one settled run against the exact Eval revision it tried. The same
 * result recorded again changes nothing, and a different result under the
 * same run identity is refused.
 */
export async function settleEvalRunResult(
  input: Readonly<{
    sql: SqlStorage;
    transaction: SchemaTransaction;
    organisationId: OrganisationId;
    result: unknown;
    flowLabel: unknown;
  }>,
): Promise<
  Result<Readonly<{ kind: "recorded" | "already_recorded" }>, EvalCommandError>
> {
  const result = parseEvalRunResult(input.result);
  const flowLabel = await FlowLabel.restore(input.flowLabel);
  if (result === null || !flowLabel.ok) return failure("eval_invalid");
  const digest = await digestCanonical({
    result,
    flowLabelDigest: flowLabel.value.digest,
  });
  return input.transaction(
    recordRunResult.bind(null, input, result, flowLabel.value, digest),
  );
}

function recordRunResult(
  input: Readonly<{ sql: SqlStorage; organisationId: OrganisationId }>,
  result: EvalRunResult,
  flowLabel: FlowLabel,
  digest: string,
): Result<
  Readonly<{ kind: "recorded" | "already_recorded" }>,
  EvalCommandError
> {
  const { sql, organisationId } = input;
  const existing = sql
    .exec<{ result_digest: string }>(
      "SELECT result_digest FROM eval_run_result WHERE organisation_id = ? AND run_id = ?",
      organisationId,
      result.runId,
    )
    .toArray()[0];
  if (existing !== undefined)
    return existing.result_digest === digest
      ? { ok: true, value: { kind: "already_recorded" } }
      : failure("eval_conflict");
  const tried = sql
    .exec<CountRow>(
      "SELECT COUNT(*) AS count FROM eval_revision WHERE organisation_id = ? AND eval_id = ? AND revision = ?",
      organisationId,
      result.eval.evalId,
      result.eval.revision,
    )
    .toArray()[0]?.count;
  if (tried !== 1) return failure("eval_unavailable");
  sql.exec(
    "INSERT INTO eval_run_result VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    organisationId,
    result.runId,
    result.eval.evalId,
    result.eval.revision,
    result.settledAt,
    digest,
    JSON.stringify(result),
    JSON.stringify(canonicalFlowLabel(flowLabel)),
  );
  sql.exec(
    `DELETE FROM eval_run_result WHERE organisation_id = ? AND eval_id = ? AND run_id NOT IN (
       SELECT run_id FROM eval_run_result WHERE organisation_id = ? AND eval_id = ?
       ORDER BY settled_at DESC, run_id DESC LIMIT ?
     )`,
    organisationId,
    result.eval.evalId,
    organisationId,
    result.eval.evalId,
    MAX_RUN_RESULTS,
  );
  return { ok: true, value: { kind: "recorded" } };
}

/** The settled runs of one Eval, newest first, each with its label. */
export function listEvalRunResults(
  sql: SqlStorage,
  organisationId: OrganisationId,
  evalId: string,
): readonly SerializedEvalRunResult[] {
  return sql
    .exec<{ result_json: string; flow_label_json: string }>(
      `SELECT result_json, flow_label_json FROM eval_run_result
       WHERE organisation_id = ? AND eval_id = ?
       ORDER BY settled_at DESC, run_id DESC LIMIT ?`,
      organisationId,
      evalId,
      MAX_RUN_RESULTS,
    )
    .toArray()
    .map((row) => ({
      resultJson: row.result_json,
      flowLabelJson: row.flow_label_json,
    }));
}

/** Verifies a settled run read from its Actor. Null means it is not used. */
export async function restoreSerializedEvalRunResult(
  raw: SerializedEvalRunResult,
): Promise<StoredEvalRunResult | null> {
  const result = parseEvalRunResult(parseJsonOrNull(raw.resultJson));
  const flowLabel = await FlowLabel.restore(parseJsonOrNull(raw.flowLabelJson));
  return result === null || !flowLabel.ok
    ? null
    : { result, flowLabel: flowLabel.value };
}

/**
 * Applies one command atomically. Repeating a command returns its first
 * receipt, and reusing its identity for a different request is a conflict.
 */
export function applyEvalCommand(
  input: EvalCommandInput,
): Result<EvalCommandReceipt, EvalCommandError> {
  return input.transaction(applyCommand.bind(null, input));
}

/**
 * Turns one request into a store command. The caller has already
 * authenticated `principal` and, for a proposal or a revision, joined
 * `flowLabel` from the evidence and the revision it inherits from.
 *
 * An agent sends only a new Eval: `{ commandId, content }`. A person sends an
 * `EvalCommand` about an existing one.
 */
export async function prepareEvalCommand(
  input: Readonly<{ principal: unknown; body: unknown; flowLabel: unknown }>,
): Promise<
  Result<
    Readonly<{ command: EvalStoreCommand; requestDigest: string }>,
    EvalCommandError
  >
> {
  const principal = parseEvalAuthor(input.principal);
  if (principal === null) return failure("eval_invalid");
  if (principal.kind === "agent") {
    // Revising and deciding belong to a person on the review surface.
    if (parseEvalCommand(input.body) !== null)
      return failure("eval_reviewer_required");
    const proposal = parseAgentProposal(input.body);
    const flowLabel = await FlowLabel.restore(input.flowLabel);
    if (proposal === null || !flowLabel.ok) return failure("eval_invalid");
    return {
      ok: true,
      value: {
        command: {
          commandId: proposal.commandId,
          expectedRevision: 0,
          kind: "propose",
          evalId: null,
          newEvalId: `eval_${crypto.randomUUID()}`,
          content: proposal.content,
          author: principal,
          flowLabel: flowLabel.value,
        },
        requestDigest: await digestCanonical({
          principal,
          proposal,
          flowLabelDigest: flowLabel.value.digest,
        }),
      },
    };
  }
  const command = parseEvalCommand(input.body);
  if (command === null) return failure("eval_invalid");
  if (command.kind !== "revise") {
    if (input.flowLabel !== null) return failure("eval_invalid");
    return {
      ok: true,
      value: {
        command: {
          commandId: command.commandId,
          expectedRevision: command.expectedRevision,
          kind: command.kind,
          evalId: command.evalId,
          revision: command.revision,
          reviewerPersonId: principal.personId,
        },
        requestDigest: await digestCanonical({ principal, command }),
      },
    };
  }
  const flowLabel = await FlowLabel.restore(input.flowLabel);
  if (!flowLabel.ok) return failure("eval_invalid");
  return {
    ok: true,
    value: {
      command: {
        commandId: command.commandId,
        expectedRevision: command.expectedRevision,
        kind: "propose",
        evalId: command.evalId,
        newEvalId: command.evalId,
        content: command.content,
        author: principal,
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
 * A person's revision keeps every restriction of the revision it inherits
 * from: the candidate under review, or the accepted revision it proposes to
 * replace. The store checks this itself: a label that drops one of that
 * revision's policies is refused whoever assembled it. The result names the
 * revision the label was held to, and the command applies only while that is
 * still the revision it inherits from.
 */
export async function checkEvalReviewLabel(
  sql: SqlStorage,
  organisationId: OrganisationId,
  prepared: Readonly<{ command: EvalStoreCommand; requestDigest: string }>,
): Promise<Result<number | null, EvalCommandError>> {
  const { command } = prepared;
  if (command.kind !== "propose" || command.evalId === null)
    return { ok: true, value: null };
  // A command already applied is answered from its receipt. The Eval has
  // moved on since, so there is no current revision to hold its label to.
  const replayed = replayEvalCommand({
    sql,
    organisationId,
    commandId: command.commandId,
    requestDigest: prepared.requestDigest,
  });
  if (!replayed.ok) return replayed;
  if (replayed.value !== null) return { ok: true, value: null };
  const head = readHeadRevision(sql, organisationId, command.evalId);
  if (head === null) return failure("eval_unavailable");
  if (head !== command.expectedRevision) return failure("eval_conflict");
  const inherited = reviewBase(sql, organisationId, command.evalId, head);
  if (inherited === null) return failure("eval_conflict");
  const row = sql
    .exec<{ flow_label_json: string }>(
      "SELECT flow_label_json FROM eval_revision WHERE organisation_id = ? AND eval_id = ? AND revision = ?",
      organisationId,
      command.evalId,
      inherited,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("eval_revision_state_invalid");
  const base = await FlowLabel.restore(parseJsonOrNull(row.flow_label_json));
  if (!base.ok) throw new Error("eval_revision_label_invalid");
  const joined = await joinFlowLabels(command.flowLabel, base.value);
  return joined.ok && joined.value.digest === command.flowLabel.digest
    ? { ok: true, value: inherited }
    : failure("eval_invalid");
}

export function serializeEval(stored: Eval): SerializedEval {
  return {
    evalId: stored.evalId,
    headRevision: stored.headRevision,
    revisions: stored.revisions.map((revision) => ({
      ...revision,
      flowLabel: canonicalFlowLabel(revision.flowLabel),
    })),
  };
}

/** Rebuilds an Eval from its Actor-boundary form, verifying every label. */
export async function restoreSerializedEval(
  organisationId: OrganisationId,
  raw: unknown,
): Promise<Eval | null> {
  if (
    !isRecord(raw) ||
    typeof raw.evalId !== "string" ||
    !isPositiveInteger(raw.headRevision) ||
    !Array.isArray(raw.revisions) ||
    raw.revisions.length !== raw.headRevision
  )
    return null;
  const revisions: EvalRevision[] = [];
  for (const entry of raw.revisions) {
    if (!isRecord(entry)) return null;
    const { flowLabel: rawLabel, ...rawView } = entry;
    const view = parseEvalRevisionView(rawView);
    const flowLabel = await FlowLabel.restore(rawLabel);
    if (view === null || !flowLabel.ok) return null;
    revisions.push(storedRevision(view, flowLabel.value));
  }
  return {
    organisationId,
    evalId: raw.evalId,
    headRevision: raw.headRevision,
    revisions,
  };
}

function replayEvalCommand(
  input: Readonly<{
    sql: SqlStorage;
    organisationId: OrganisationId;
    commandId: string;
    requestDigest: string;
  }>,
): Result<EvalCommandReceipt | null, EvalCommandError> {
  if (!/^[a-f0-9]{64}$/u.test(input.requestDigest))
    return failure("eval_invalid");
  const row = input.sql
    .exec<{ request_digest: string; receipt_json: string }>(
      "SELECT request_digest, receipt_json FROM eval_command WHERE organisation_id = ? AND command_id = ?",
      input.organisationId,
      input.commandId,
    )
    .toArray()[0];
  if (row === undefined) return { ok: true, value: null };
  if (row.request_digest !== input.requestDigest)
    return failure("eval_command_conflict");
  const receipt = parseEvalCommandReceipt(parseJsonOrNull(row.receipt_json));
  if (receipt === null) throw new Error("eval_command_receipt_invalid");
  return { ok: true, value: receipt };
}

/**
 * The receipt an applied command left, whatever a later request under the
 * same identity carries. It lets a repeated run name the first result.
 */
export function readEvalCommandReceipt(
  sql: SqlStorage,
  organisationId: OrganisationId,
  commandId: string,
): EvalCommandReceipt | null {
  const row = sql
    .exec<{ receipt_json: string }>(
      "SELECT receipt_json FROM eval_command WHERE organisation_id = ? AND command_id = ?",
      organisationId,
      commandId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const receipt = parseEvalCommandReceipt(parseJsonOrNull(row.receipt_json));
  if (receipt === null) throw new Error("eval_command_receipt_invalid");
  return receipt;
}

export async function readEval(
  sql: SqlStorage,
  organisationId: OrganisationId,
  evalId: string,
): Promise<Result<Eval | null, EvalReadError>> {
  const headRevision = readHeadRevision(sql, organisationId, evalId);
  if (headRevision === null) return { ok: true, value: null };
  const rows = sql
    .exec<RevisionRow>(
      `SELECT eval_id, revision, content_json, author_json, flow_label_json, proposed_at, state_json
       FROM eval_revision WHERE organisation_id = ? AND eval_id = ? ORDER BY revision`,
      organisationId,
      evalId,
    )
    .toArray();
  return restoreEval(organisationId, evalId, headRevision, rows);
}

export async function listEvals(
  sql: SqlStorage,
  organisationId: OrganisationId,
): Promise<Result<readonly Eval[], EvalReadError>> {
  const heads = sql
    .exec<{ eval_id: string; head_revision: number }>(
      "SELECT eval_id, head_revision FROM eval WHERE organisation_id = ? ORDER BY eval_id",
      organisationId,
    )
    .toArray();
  const rows = sql
    .exec<RevisionRow>(
      `SELECT eval_id, revision, content_json, author_json, flow_label_json, proposed_at, state_json
       FROM eval_revision WHERE organisation_id = ? ORDER BY eval_id, revision`,
      organisationId,
    )
    .toArray();
  const evals: Eval[] = [];
  for (const head of heads) {
    const restored = await restoreEval(
      organisationId,
      head.eval_id,
      head.head_revision,
      rows.filter((row) => row.eval_id === head.eval_id),
    );
    if (!restored.ok) return restored;
    evals.push(restored.value);
  }
  return { ok: true, value: evals };
}

function applyCommand(
  input: EvalCommandInput,
): Result<EvalCommandReceipt, EvalCommandError> {
  const replayed = replayEvalCommand({
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
    "INSERT INTO eval_command VALUES (?, ?, ?, ?)",
    input.organisationId,
    command.commandId,
    input.requestDigest,
    JSON.stringify(applied.value),
  );
  return applied;
}

function propose(
  input: EvalCommandInput,
  command: Variant<EvalStoreCommand, "propose">,
): Result<EvalCommandReceipt, EvalCommandError> {
  const { sql, organisationId } = input;
  if (command.evalId === null) {
    // Pantry opens an Eval. A person's words reach one only as a revision.
    if (command.author.kind !== "agent")
      return failure("eval_reviewer_required");
    if (command.expectedRevision !== 0) return failure("eval_invalid");
    const count = sql
      .exec<CountRow>(
        "SELECT COUNT(*) AS count FROM eval WHERE organisation_id = ?",
        organisationId,
      )
      .toArray()[0]?.count;
    if (
      count === undefined ||
      count >= MAX_EVAL_RECORDS ||
      evalsInUse(sql, organisationId) >= MAX_EVALS
    )
      return failure("eval_capacity_exceeded");
    if (readHeadRevision(sql, organisationId, command.newEvalId) !== null)
      return failure("eval_conflict");
    sql.exec(
      "INSERT INTO eval VALUES (?, ?, 1)",
      organisationId,
      command.newEvalId,
    );
    insertCandidate(input, command, command.newEvalId, 1);
    return receipt(command, command.newEvalId, 1, 1, "candidate");
  }
  if (command.author.kind !== "operator")
    return failure("eval_reviewer_required");
  const head = readHeadRevision(sql, organisationId, command.evalId);
  if (head === null) return failure("eval_unavailable");
  if (head !== command.expectedRevision) return failure("eval_conflict");
  if (head >= MAX_REVISIONS) return failure("eval_capacity_exceeded");
  // The revision keeps the audience of the one its label was held to.
  if (
    input.inheritedRevision === null ||
    reviewBase(sql, organisationId, command.evalId, head) !==
      input.inheritedRevision
  )
    return failure("eval_conflict");
  // A revision tries the same agent from the same origin as the one it edits.
  const inherited = readRevisionContent(
    sql,
    organisationId,
    command.evalId,
    input.inheritedRevision,
  );
  if (
    !sameJson(inherited.subject, command.content.subject) ||
    inherited.sourceCaseId !== command.content.sourceCaseId
  )
    return failure("eval_invalid");
  const next = head + 1;
  const headState = readRevisionState(
    sql,
    organisationId,
    command.evalId,
    head,
  );
  // The earlier candidate stays in history as revised.
  if (headState.kind === "candidate")
    writeRevisionState(sql, organisationId, command.evalId, head, {
      kind: "rejected",
      rejection: {
        ...decision(input, command.author.personId),
        reason: "revised",
        replacementRevision: next,
      },
    });
  insertCandidate(input, command, command.evalId, next);
  sql.exec(
    "UPDATE eval SET head_revision = ? WHERE organisation_id = ? AND eval_id = ?",
    next,
    organisationId,
    command.evalId,
  );
  return receipt(command, command.evalId, next, next, "candidate");
}

/**
 * The Evals that count against the limit: each has an accepted revision or a
 * candidate under review. A declined or revoked Eval keeps its history and
 * leaves room for another. It cannot return: a revision needs a candidate or
 * an accepted revision to build on.
 */
function evalsInUse(sql: SqlStorage, organisationId: string): number {
  return (
    sql
      .exec<CountRow>(
        `SELECT COUNT(DISTINCT eval_id) AS count FROM eval_revision
         WHERE organisation_id = ? AND state IN ('candidate', 'accepted')`,
        organisationId,
      )
      .toArray()[0]?.count ?? MAX_EVALS
  );
}

function decide(
  input: EvalCommandInput,
  command: Variant<EvalStoreCommand, "accept" | "reject" | "revoke">,
): Result<EvalCommandReceipt, EvalCommandError> {
  const { sql, organisationId } = input;
  const { evalId, revision } = command;
  const head = readHeadRevision(sql, organisationId, evalId);
  if (head === null) return failure("eval_unavailable");
  if (head !== command.expectedRevision) return failure("eval_conflict");
  if (revision > head) return failure("eval_invalid");
  const state = readRevisionState(sql, organisationId, evalId, revision);
  const decided = decision(input, command.reviewerPersonId);
  switch (command.kind) {
    case "accept": {
      if (state.kind !== "candidate") return failure("eval_conflict");
      const current = readAcceptedRevision(sql, organisationId, evalId);
      // Supersede first: the store allows one accepted revision at a time.
      if (current !== null)
        writeRevisionState(sql, organisationId, evalId, current.revision, {
          kind: "superseded",
          acceptance: current.acceptance,
          supersession: {
            replacementRevision: revision,
            supersededAt: input.now,
          },
        });
      writeRevisionState(sql, organisationId, evalId, revision, {
        kind: "accepted",
        acceptance: decided,
      });
      return receipt(command, evalId, revision, head, "accepted");
    }
    case "reject":
      if (state.kind !== "candidate") return failure("eval_conflict");
      writeRevisionState(sql, organisationId, evalId, revision, {
        kind: "rejected",
        rejection: { ...decided, reason: "declined" },
      });
      return receipt(command, evalId, revision, head, "rejected");
    case "revoke":
      if (state.kind !== "accepted") return failure("eval_conflict");
      writeRevisionState(sql, organisationId, evalId, revision, {
        kind: "revoked",
        acceptance: state.acceptance,
        revocation: decided,
      });
      return receipt(command, evalId, revision, head, "revoked");
    default:
      return assertNever(command.kind);
  }
}

function insertCandidate(
  input: EvalCommandInput,
  command: Variant<EvalStoreCommand, "propose">,
  evalId: string,
  revision: number,
): void {
  const state: EvalRevisionState = { kind: "candidate" };
  input.sql.exec(
    `INSERT INTO eval_revision (
       organisation_id, eval_id, revision, content_json, author_json,
       flow_label_json, proposed_at, state, state_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.organisationId,
    evalId,
    revision,
    JSON.stringify(command.content),
    JSON.stringify(command.author),
    JSON.stringify(canonicalFlowLabel(command.flowLabel)),
    input.now,
    state.kind,
    JSON.stringify(state),
  );
}

function readHeadRevision(
  sql: SqlStorage,
  organisationId: OrganisationId,
  evalId: string,
): number | null {
  const row = sql
    .exec<{
      head_revision: number;
    }>(
      "SELECT head_revision FROM eval WHERE organisation_id = ? AND eval_id = ?",
      organisationId,
      evalId,
    )
    .toArray()[0];
  return row === undefined ? null : row.head_revision;
}

function readRevisionState(
  sql: SqlStorage,
  organisationId: OrganisationId,
  evalId: string,
  revision: number,
): EvalRevisionState {
  const row = sql
    .exec<{
      state_json: string;
    }>(
      "SELECT state_json FROM eval_revision WHERE organisation_id = ? AND eval_id = ? AND revision = ?",
      organisationId,
      evalId,
      revision,
    )
    .toArray()[0];
  const state =
    row === undefined
      ? null
      : parseMemoryRevisionState(parseJsonOrNull(row.state_json));
  if (state === null) throw new Error("eval_revision_state_invalid");
  return state;
}

function readRevisionContent(
  sql: SqlStorage,
  organisationId: OrganisationId,
  evalId: string,
  revision: number,
): EvalContent {
  const row = sql
    .exec<{
      content_json: string;
    }>(
      "SELECT content_json FROM eval_revision WHERE organisation_id = ? AND eval_id = ? AND revision = ?",
      organisationId,
      evalId,
      revision,
    )
    .toArray()[0];
  const content =
    row === undefined
      ? null
      : parseEvalContent(parseJsonOrNull(row.content_json));
  if (content === null) throw new Error("eval_revision_content_invalid");
  return content;
}

/**
 * The revision a person's revision inherits its audience from: the candidate
 * under review, or else the accepted revision it proposes to replace.
 */
function reviewBase(
  sql: SqlStorage,
  organisationId: OrganisationId,
  evalId: string,
  head: number,
): number | null {
  return readRevisionState(sql, organisationId, evalId, head).kind ===
    "candidate"
    ? head
    : (readAcceptedRevision(sql, organisationId, evalId)?.revision ?? null);
}

function readAcceptedRevision(
  sql: SqlStorage,
  organisationId: OrganisationId,
  evalId: string,
): Readonly<{ revision: number; acceptance: MemoryDecision }> | null {
  const row = sql
    .exec<{
      revision: number;
      state_json: string;
    }>(
      "SELECT revision, state_json FROM eval_revision WHERE organisation_id = ? AND eval_id = ? AND state = 'accepted'",
      organisationId,
      evalId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const state = parseMemoryRevisionState(parseJsonOrNull(row.state_json));
  if (state?.kind !== "accepted")
    throw new Error("eval_revision_state_invalid");
  return { revision: row.revision, acceptance: state.acceptance };
}

function writeRevisionState(
  sql: SqlStorage,
  organisationId: OrganisationId,
  evalId: string,
  revision: number,
  state: EvalRevisionState,
): void {
  sql.exec(
    "UPDATE eval_revision SET state = ?, state_json = ? WHERE organisation_id = ? AND eval_id = ? AND revision = ?",
    state.kind,
    JSON.stringify(state),
    organisationId,
    evalId,
    revision,
  );
}

async function restoreEval(
  organisationId: OrganisationId,
  evalId: string,
  headRevision: number,
  rows: readonly RevisionRow[],
): Promise<Result<Eval, EvalReadError>> {
  const revisions: EvalRevision[] = [];
  for (const row of rows) {
    const view = parseRevisionRow(row);
    const flowLabel = await FlowLabel.restore(
      parseJsonOrNull(row.flow_label_json),
    );
    if (view === null || !flowLabel.ok)
      return { ok: false, error: { code: "eval_persisted_state_invalid" } };
    revisions.push(storedRevision(view, flowLabel.value));
  }
  return revisions.length === headRevision
    ? { ok: true, value: { organisationId, evalId, headRevision, revisions } }
    : { ok: false, error: { code: "eval_persisted_state_invalid" } };
}

function parseRevisionRow(row: RevisionRow): EvalRevisionView | null {
  const content = parseEvalContent(parseJsonOrNull(row.content_json));
  const proposedBy = parseEvalAuthor(parseJsonOrNull(row.author_json));
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
  view: EvalRevisionView,
  flowLabel: FlowLabel,
): EvalRevision {
  return { ...view, flowLabel } as EvalRevision;
}

function parseAgentProposal(
  raw: unknown,
): Readonly<{ commandId: string; content: EvalContent }> | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["commandId", "content"]) ||
    typeof raw.commandId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:_./-]{0,199}$/u.test(raw.commandId)
  )
    return null;
  const content = parseEvalContent(raw.content);
  return content === null ? null : { commandId: raw.commandId, content };
}

function decision(
  input: EvalCommandInput,
  reviewerPersonId: string,
): MemoryDecision {
  return {
    reviewerPersonId,
    commandId: input.command.commandId,
    decidedAt: input.now,
  };
}

function receipt(
  command: EvalStoreCommand,
  evalId: string,
  revision: number,
  headRevision: number,
  state: EvalRevisionState["kind"],
): Result<EvalCommandReceipt, EvalCommandError> {
  return {
    ok: true,
    value: {
      commandId: command.commandId,
      evalId,
      revision,
      headRevision,
      state,
    },
  };
}

function failure(code: EvalCommandErrorCode): Result<never, EvalCommandError> {
  return { ok: false, error: { code } };
}

import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  OrganisationAccess,
  OrganisationUserAuthority,
  OrganisationAdmissionAction,
} from "../organisation-access/access";
import type { RequestAuthority } from "@purin-labs/contracts";

import {
  compileTurnAuthority,
  bindMailboxCaseContextCollectionAuthority,
  CONTEXT_CASE_READ_CAPABILITY,
  type CompiledTurnAuthority,
} from "../authorization/access-grants/turn-authority";
import { audiencesForAdmission } from "../policy";
import type { FlowRecipient } from "../policy/information-flow/types";
import {
  newRequestId,
  type CaseId,
  type AssignmentId,
  type SessionId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { traceLog } from "@purin-labs/kernel/observability";
import type { PinnedSessionPolicy } from "../policy-snapshot";
import { parseStoredRequestAuthority } from "../request-authority";
import type { Result } from "@purin-labs/kernel/result";
import {
  CONTEXT_ASSEMBLY_STRATEGY_VERSION,
  normalizeContextQuery,
  type ContextReadFields,
  type CaseContextTailReader,
  type ContextAssemblyResult,
  type ContextAssemblyScope,
  type TurnMemoryReader,
} from "./assembly";
import {
  assembleAuthorizedContext,
  startWorkspaceContextReads,
  type StartedContextReads,
} from "./assembly/internal";
import { createContextProjectionReader } from "./projection";

type PreparedTurnContext = {
  readonly turnAuthority: CompiledTurnAuthority;
  readonly context: ContextAssemblyResult;
};

export type PrepareTurnContextError = {
  readonly code: string;
};

/** A person waits for this turn, so a slow Memory read is left behind. */
const INTERACTIVE_MEMORY_DEADLINE_MS = 250;
/**
 * No person waits for this turn: a mail turn or an Eval turn. A reply that
 * lacks an accepted Memory is worse than a reply that comes seconds later.
 */
export const BACKGROUND_MEMORY_DEADLINE_MS = 5_000;

export async function prepareTurnContext(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly accountAccess: OrganisationAccess;
    readonly userAuthority: OrganisationUserAuthority;
    readonly action: OrganisationAdmissionAction;
    readonly organisationId: OrganisationId;
    readonly caseId: CaseId;
    readonly assignmentId: AssignmentId;
    readonly sessionId: SessionId;
    readonly requestAuthority: RequestAuthority;
    readonly policy: PinnedSessionPolicy;
    readonly query: string;
    readonly now: number;
    readonly tailReader: CaseContextTailReader;
    readonly memoryReader: TurnMemoryReader;
    /**
     * The verified recipient this turn's output is bound to. A turn that
     * names none is offered no Memory bound to a recipient.
     */
    readonly replyRecipient?: FlowRecipient | null;
    /**
     * How long the turn waits for its Memory read. The default is the short
     * wait of a turn that a person waits for.
     */
    readonly memoryDeadlineMs?: number;
  }>,
): Promise<Result<PreparedTurnContext, PrepareTurnContextError>> {
  const permit = await prepareTurnContextRead(input);
  if (!permit.ok) return permit;
  const context = await permit.value.assemble("workspace");
  return context.ok
    ? {
        ok: true,
        value: {
          turnAuthority: permit.value.turnAuthority,
          context: context.value,
        },
      }
    : context;
}

export async function prepareTurnContextRead(
  input: Parameters<typeof prepareTurnContext>[0],
): Promise<Result<AuthorizedContextRead, PrepareTurnContextError>> {
  return AuthorizedContextRead.compile(input);
}

export async function prepareTurnAuthority(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly accountAccess: OrganisationAccess;
    readonly userAuthority: OrganisationUserAuthority;
    readonly action: OrganisationAdmissionAction;
    readonly organisationId: OrganisationId;
    readonly requestAuthority: RequestAuthority;
    readonly policy:
      | Pick<PinnedSessionPolicy, "version">
      | Promise<Pick<PinnedSessionPolicy, "version">>;
  }>,
): Promise<Result<CompiledTurnAuthority, PrepareTurnContextError>> {
  const projection = parseStoredRequestAuthority(input.requestAuthority);
  if (
    !projection.ok ||
    projection.value.requestAuthority.organisationId !== input.organisationId
  ) {
    return { ok: false, error: { code: "request_authority_invalid" } };
  }
  const compiled = await compileTurnAuthority({
    db: input.db,
    accountAccess: input.accountAccess,
    userAuthority: input.userAuthority,
    action: input.action,
    organisationId: input.organisationId,
    requestAuthority: projection.value.requestAuthority,
    policy: input.policy,
  });
  if (!compiled.ok) return { ok: false, error: { code: compiled.error.code } };
  return compiled;
}

export async function assembleTurnContext(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly caseId: CaseId;
    readonly assignmentId: AssignmentId;
    readonly sessionId: SessionId;
    readonly policy: PinnedSessionPolicy;
    /**
     * `null` is the empty-query path, taken when a message carries no useful
     * semantic query — a file-only or bare-link message. It is a distinct state,
     * not a search for the empty string.
     */
    readonly query: string | null;
    readonly now: number;
    readonly tailReader: CaseContextTailReader;
    readonly memoryReader: TurnMemoryReader;
    readonly turnAuthority: CompiledTurnAuthority;
    readonly replyRecipient?: FlowRecipient | null;
    readonly memoryDeadlineMs?: number;
  }>,
): Promise<Result<ContextAssemblyResult, PrepareTurnContextError>> {
  if (!hasCapability(input.turnAuthority, CONTEXT_CASE_READ_CAPABILITY)) {
    return { ok: false, error: { code: "context_capability_missing" } };
  }
  const fields = buildContextReadFields({
    policy: input.policy,
    db: input.db,
    organisationId: input.organisationId,
    caseId: input.caseId,
    assignmentId: input.assignmentId,
    sessionId: input.sessionId,
    query: input.query,
    now: input.now,
    tailReader: input.tailReader,
    memoryReader: input.memoryReader,
    turnAuthority: input.turnAuthority,
    projectionReader: createContextProjectionReader(input.db),
    replyRecipient: input.replyRecipient ?? null,
    memoryDeadlineMs: input.memoryDeadlineMs,
  });
  // The authority check below waits for the database. The two reads take
  // only these fields, so they start now and share that wait. Their results
  // reach the assembler only with the permit of that check.
  const startedAt = Date.now();
  const started = startWorkspaceContextReads(fields);
  const waits = { searchMs: -1, tailMs: -1 };
  const recordSearch = recordWait.bind(null, waits, "searchMs", startedAt);
  const recordTail = recordWait.bind(null, waits, "tailMs", startedAt);
  started.projection.then(recordSearch, recordSearch);
  started.tail.then(recordTail, recordTail);
  const permit = await AuthorizedContextRead.prepare({
    policy: input.policy,
    db: input.db,
    organisationId: input.organisationId,
    turnAuthority: input.turnAuthority,
    fields,
  });
  const authorityMs = Date.now() - startedAt;
  if (!permit.ok) return permit;
  const assembled = await permit.value.assemble("workspace", started);
  traceLog("context.turn_read_timing", {
    requestId: newRequestId(),
    organisation_id: input.organisationId,
    case_id: input.caseId,
    // Each figure is the time from the start of the read to the end of that
    // step. The three steps overlap.
    authority_ms: authorityMs,
    search_ms: waits.searchMs,
    tail_ms: waits.tailMs,
    total_ms: Date.now() - startedAt,
  });
  return assembled;
}

function recordWait(
  waits: { searchMs: number; tailMs: number },
  step: "searchMs" | "tailMs",
  startedAt: number,
): void {
  waits[step] = Date.now() - startedAt;
}

function buildContextReadFields(
  input: Readonly<{
    readonly policy: PinnedSessionPolicy;
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly caseId: CaseId;
    readonly assignmentId: AssignmentId;
    readonly sessionId: SessionId;
    readonly query: string | null;
    readonly now: number;
    readonly tailReader: CaseContextTailReader;
    readonly memoryReader: TurnMemoryReader;
    readonly turnAuthority: CompiledTurnAuthority;
    readonly projectionReader: ReturnType<typeof createContextProjectionReader>;
    readonly replyRecipient?: FlowRecipient | null;
    readonly memoryDeadlineMs?: number;
  }>,
): ContextReadFields {
  return {
    kind: "authorized_context_read",
    db: input.db,
    organisationId: input.organisationId,
    caseId: input.caseId,
    assignmentId: input.assignmentId,
    sessionId: input.sessionId,
    requestAuthority: input.turnAuthority.requestAuthority,
    authorityPartitionDigest: input.turnAuthority.authorityPartition.digest,
    contextVisibility: audiencesForAdmission(
      input.turnAuthority.requestAuthority,
      input.caseId,
    ),
    policyVersion: input.turnAuthority.authorityPartition.policyVersion,
    assemblyStrategyVersion: CONTEXT_ASSEMBLY_STRATEGY_VERSION,
    query: input.query === null ? "" : normalizeContextQuery(input.query),
    itemLimit: 12,
    tokenLimit: 2_048,
    timeLimitMs: 250,
    freshnessBoundMs: 24 * 60 * 60 * 1_000,
    assembledAt: input.now,
    projectionReader: input.projectionReader,
    tailReader: input.tailReader,
    memoryReader: input.memoryReader,
    memoryDeadlineMs: input.memoryDeadlineMs ?? INTERACTIVE_MEMORY_DEADLINE_MS,
    replyRecipient: input.replyRecipient ?? null,
  };
}

function hasCapability(
  authority: CompiledTurnAuthority,
  capabilityId: string,
): boolean {
  return authority.effectiveGrantSet.capabilities.some(
    (capability) =>
      capability.definition.kind === "platform_capability" &&
      capability.definition.capabilityId === capabilityId &&
      capability.definition.capabilityVersion === 1,
  );
}

class AuthorizedContextRead {
  readonly #fields: ContextReadFields;
  private constructor(
    fields: ContextReadFields,
    readonly turnAuthority: CompiledTurnAuthority,
  ) {
    this.#fields = Object.freeze(fields);
  }
  static is(value: unknown): value is AuthorizedContextRead {
    return typeof value === "object" && value !== null && #fields in value;
  }
  static async compile(
    input: Parameters<typeof prepareTurnContext>[0],
  ): Promise<Result<AuthorizedContextRead, PrepareTurnContextError>> {
    const compiled = await prepareTurnAuthority(input);
    if (!compiled.ok) return compiled;
    if (!hasCapability(compiled.value, CONTEXT_CASE_READ_CAPABILITY))
      return { ok: false, error: { code: "context_capability_missing" } };
    return {
      ok: true,
      value: new AuthorizedContextRead(
        buildContextReadFields({
          ...input,
          turnAuthority: compiled.value,
          projectionReader: createContextProjectionReader(input.db),
        }),
        compiled.value,
      ),
    };
  }
  async assemble(
    scope: ContextAssemblyScope,
    started: StartedContextReads | null = null,
  ): Promise<Result<ContextAssemblyResult, PrepareTurnContextError>> {
    // Reads that started early count only for the fields of this permit.
    if (started !== null && started.fields !== this.#fields)
      return { ok: false, error: { code: "context_reads_mismatched" } };
    const assembled = await assembleAuthorizedContext(this, scope, started);
    return assembled.ok
      ? { ok: true, value: assembled.value }
      : { ok: false, error: { code: assembled.error.code } };
  }
  /**
   * Check the turn's authority again and give the permit for `fields`, which
   * the caller built from that same authority.
   */
  static async prepare(
    input: Readonly<{
      readonly db: OrganisationDatabase;
      readonly organisationId: OrganisationId;
      readonly policy: PinnedSessionPolicy;
      readonly turnAuthority: CompiledTurnAuthority;
      readonly fields: ContextReadFields;
    }>,
  ): Promise<Result<AuthorizedContextRead, PrepareTurnContextError>> {
    const compiled = await prepareTurnAuthority({
      db: input.db,
      accountAccess: input.turnAuthority.accountAccess,
      userAuthority: input.turnAuthority.userAuthority,
      action: input.turnAuthority.action,
      organisationId: input.organisationId,
      requestAuthority: input.turnAuthority.requestAuthority,
      policy: input.policy,
    });
    if (!compiled.ok) return compiled;
    const key = input.turnAuthority.authorityPartition.key;
    const current =
      key.kind === "agent_mailbox" &&
      key.replyScope.kind === "case_context_collection_evidence"
        ? await bindMailboxCaseContextCollectionAuthority(
            compiled.value,
            key.replyScope,
          )
        : compiled;
    if (!current.ok) return current;
    if (
      !hasCapability(current.value, CONTEXT_CASE_READ_CAPABILITY) ||
      current.value.authorityPartition.digest !==
        input.turnAuthority.authorityPartition.digest
    )
      return { ok: false, error: { code: "context_authority_changed" } };
    return {
      ok: true,
      value: new AuthorizedContextRead(input.fields, current.value),
    };
  }
  get kind() {
    return this.#fields.kind;
  }
  get db() {
    return this.#fields.db;
  }
  get organisationId() {
    return this.#fields.organisationId;
  }
  get caseId() {
    return this.#fields.caseId;
  }
  get assignmentId() {
    return this.#fields.assignmentId;
  }
  get sessionId() {
    return this.#fields.sessionId;
  }
  get requestAuthority() {
    return this.#fields.requestAuthority;
  }
  get authorityPartitionDigest() {
    return this.#fields.authorityPartitionDigest;
  }
  get contextVisibility() {
    return this.#fields.contextVisibility;
  }
  get policyVersion() {
    return this.#fields.policyVersion;
  }
  get assemblyStrategyVersion() {
    return this.#fields.assemblyStrategyVersion;
  }
  get query() {
    return this.#fields.query;
  }
  get itemLimit() {
    return this.#fields.itemLimit;
  }
  get tokenLimit() {
    return this.#fields.tokenLimit;
  }
  get timeLimitMs() {
    return this.#fields.timeLimitMs;
  }
  get freshnessBoundMs() {
    return this.#fields.freshnessBoundMs;
  }
  get assembledAt() {
    return this.#fields.assembledAt;
  }
  get projectionReader() {
    return this.#fields.projectionReader;
  }
  get tailReader() {
    return this.#fields.tailReader;
  }
  get memoryReader() {
    return this.#fields.memoryReader;
  }
  get memoryDeadlineMs() {
    return this.#fields.memoryDeadlineMs;
  }
  get replyRecipient() {
    return this.#fields.replyRecipient;
  }
}
export type { AuthorizedContextRead };
export function isAuthorizedContextRead(
  value: unknown,
): value is AuthorizedContextRead {
  return AuthorizedContextRead.is(value);
}

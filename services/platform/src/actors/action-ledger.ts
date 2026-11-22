import {
  isCommerceSystemKind,
  type AuthorityPartition,
  type CanonicalAction,
  type RequestAuthority,
} from "@purin-labs/contracts";
import type { CommerceTypeParts } from "@purin-labs/kernel/commerce-type-parts";

type CommerceEntityPlaneEffect = CommerceTypeParts["entityPlaneEffect"];

import {
  parseCaseId,
  parseIntegrationAccountId,
  parseSessionId,
  parseOrganisationId,
  type CaseId,
  type IntegrationAccountId,
  type SessionId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  parseCommerceSystemRevision,
  type CommerceSystem,
  type CommerceSystemRevision,
} from "../data/organisation-commerce-system";
import {
  parseApprovalEvidence,
  parseMerchantActionRejectionEvidence,
  parseStoredApprovalEvidence,
  parseStoredMerchantActionRejectionEvidence,
  serializeApprovalEvidence,
  serializeMerchantActionRejectionEvidence,
  type ApprovalEvidence,
  type MerchantActionRejectionEvidence,
} from "../approval-authentication";
import { parseStoredRequestAuthority } from "../request-authority";
import {
  authorityPartitionKey,
  parseStoredAuthorityPartition,
} from "../authorization/access-grants/turn-authority";
import type { SerializedFlowBinding } from "../policy";
import { flowBindingMatchesIdentity } from "../policy";
import { definePort } from "@purin-labs/kernel/port";
import type { VariantBy } from "@purin-labs/type-utils";
import { isNonNegativeInteger, isRecord, isSha256Hex } from "@purin-labs/std";
import { armAlarmBy } from "./lifecycle/actor-alarm";

export type CanonicalActionDraft = {
  host: string;
  verb: string;
  path: string;
  argsHash: string;
  amount: CanonicalAction["amount"];
  resourceKey: string;
};

export type ActionAuthority =
  | Readonly<{
      kind: "commerce_system";
      system: CommerceSystem["kind"];
      revision: CommerceSystemRevision;
    }>
  | Readonly<{ kind: "integration_account" }>
  | CustomConnectorActionAuthority;

export type CustomConnectorActionAuthority = Readonly<{
  readonly kind: "custom_connector";
  readonly connectorId: string;
  readonly definitionRevision: number;
  readonly definitionDigest: string;
  readonly bindingRevision: number;
  readonly credentialGeneration: number;
  readonly operationId: string;
  readonly effect: "external_record_create" | "external_record_update";
  readonly retryPolicy:
    | Readonly<{ readonly kind: "single_attempt" }>
    | Readonly<{
        readonly kind: "provider_idempotent";
        readonly header: string;
      }>;
  readonly canonicalInputJson: string;
  readonly canonicalInputDigest: string;
  readonly outputContractDigest: string;
  readonly resourceIdentity:
    | Readonly<{ readonly kind: "new_record" }>
    | Readonly<{ readonly kind: "existing_record"; readonly value: string }>;
  readonly providerEffectId: string;
}>;

export type LedgerCanonicalAction = Omit<
  CanonicalAction,
  "organisationId" | "integrationAccountId" | "sessionId"
> & {
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  sessionId: SessionId;
  requestAuthority: RequestAuthority;
  authorityPartition: AuthorityPartition;
  authority: ActionAuthority;
  flowBinding: SerializedFlowBinding;
};

type ActionIdentity = {
  action: LedgerCanonicalAction;
  caseId: CaseId;
  proposalId: string;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
  commerceEffect: CommerceEntityPlaneEffect | null;
};

type ActionExecutionLease = Readonly<{
  leaseId: string;
  expiresAt: number;
}>;

const ACTION_EXECUTION_LEASE_DURATION_MS = 5 * 60_000;

type UnsignedAction = ActionIdentity & {
  approval?: never;
  rejection?: never;
  providerResult?: never;
  executionLease?: never;
};

type SignedAction = ActionIdentity & {
  approval: ApprovalEvidence;
  rejection?: never;
  providerResult?: never;
  executionLease?: never;
};

type ExecutingAction = ActionIdentity & {
  approval: ApprovalEvidence;
  rejection?: never;
  providerResult?: never;
  executionLease: ActionExecutionLease;
};

type TerminalAction = ActionIdentity & {
  approval: ApprovalEvidence;
  rejection?: never;
  providerResult: string;
  executionLease?: never;
};

type RejectedAction = ActionIdentity & {
  state: "rejected";
  approval?: never;
  rejection: MerchantActionRejectionEvidence;
  providerResult?: never;
  executionLease?: never;
};

export type ActionLedgerEntry =
  | (UnsignedAction & { state: "proposed" })
  | (UnsignedAction & { state: "approval_requested" })
  | (SignedAction & { state: "signed" })
  | (ExecutingAction & { state: "executing" })
  | (SignedAction & { state: "indeterminate" })
  | (TerminalAction & { state: "confirmed" })
  | (TerminalAction & { state: "failed" })
  | RejectedAction
  | (ActionIdentity & {
      state: "expired";
      approval: ApprovalEvidence | null;
      rejection?: never;
      providerResult?: never;
      executionLease?: never;
    });

export type ExecutingActionLedgerEntry = VariantBy<
  ActionLedgerEntry,
  "state",
  "executing"
>;

export type ReadActionActivityInput = {
  readonly organisationId: OrganisationId;
  readonly resourceKey: string | null;
  readonly limit: number;
};

/** The host of every commerce action in the ledger. */
const COMMERCE_ACTION_HOST = "pantry.commerce";

/**
 * True for a commerce action. The ledger also holds the writes of custom
 * connectors, which have the host of their own service.
 */
export function isCommerceLedgerAction(
  action: Readonly<{ host: string }>,
): boolean {
  return action.host === COMMERCE_ACTION_HOST;
}

export type ActionLedgerActivity = {
  readonly action: LedgerCanonicalAction;
  readonly caseId: CaseId;
  readonly proposalId: string;
  readonly state: ActionLedgerEntry["state"];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly providerResult: string | null;
  readonly commerceEffect: CommerceEntityPlaneEffect | null;
};

export type ProposeActionInput = {
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  requestAuthority: RequestAuthority;
  authorityPartition: AuthorityPartition;
  authority: ActionAuthority;
  caseId: CaseId;
  proposalId: string;
  sessionId: SessionId;
  threadId: string;
  draft: CanonicalActionDraft;
  flowBinding: SerializedFlowBinding;
  exp: number;
  now: number;
};

export type RequestActionApprovalInput = {
  organisationId: OrganisationId;
  nonce: string;
  now: number;
};

export type SignActionInput = RequestActionApprovalInput & {
  approval: ApprovalEvidence;
};

export type RejectActionInput = RequestActionApprovalInput & {
  rejection: MerchantActionRejectionEvidence;
};

export type BeginActionExecutionInput = RequestActionApprovalInput;

export type ActionExecutionRetryEvidence =
  | Readonly<{
      kind: "provider_idempotency_absent";
      integrationAccountId: IntegrationAccountId;
      idempotencyKey: string;
      observedAt: number;
    }>
  | Readonly<{
      kind: "provider_idempotent_replay";
      integrationAccountId: IntegrationAccountId;
      idempotencyKey: string;
      observedAt: number;
    }>
  | Readonly<{
      kind: "local_effect_absent";
      integrationAccountId: IntegrationAccountId;
      resourceKey: string;
      observedAt: number;
    }>;

export type RetryIndeterminateActionExecutionInput =
  RequestActionApprovalInput &
    Readonly<{
      evidence: ActionExecutionRetryEvidence;
    }>;

export type GetActionInput = RequestActionApprovalInput;

export type CompleteActionExecutionInput = RequestActionApprovalInput & {
  executionLeaseId: string;
  outcome: "confirmed" | "failed" | "indeterminate";
  providerResult: string;
};

export type ReconcileActionExecutionInput = RequestActionApprovalInput & {
  outcome: "confirmed" | "failed" | "indeterminate";
  providerResult: string;
};

/**
 * The commerce parts of the action ledger: the check of a recorded commerce
 * effect, and the rule that says which actions a Slack approval may sign.
 * Commerce owns both, and the Worker registers them (`worker-ports.ts`).
 */
export type ActionLedgerCommerce = Readonly<{
  /** The recorded commerce effect, or null when the value is not one. */
  parseEffect(raw: unknown): CommerceEntityPlaneEffect | null;
  /** Whether a Slack approval may sign this action: it moves no money. */
  slackMayApprove(
    action: Pick<LedgerCanonicalAction, "verb" | "path">,
  ): boolean;
}>;

export const actionLedgerCommerce = definePort<ActionLedgerCommerce>(
  "action_ledger_commerce",
);

export type RecordCommerceEntityPlaneEffectInput =
  RequestActionApprovalInput & {
    effect: CommerceEntityPlaneEffect;
  };

export type ActionLedgerError =
  | { code: "invalid_action"; field: string }
  | { code: "action_not_found" }
  | { code: "action_expired" }
  | { code: "action_replay" }
  | { code: "resource_busy"; resourceKey: string }
  | { code: "invalid_action_transition"; state: ActionLedgerEntry["state"] }
  | { code: "action_receipt_conflict" }
  | { code: "action_execution_lease_invalid" };

type ActionLedgerRow = Record<string, SqlStorageValue> & {
  action_json: string;
  case_id: string;
  proposal_id: string;
  resource_key: string;
  idempotency_key: string;
  state: string;
  approval_json: string | null;
  rejection_json: string | null;
  provider_result: string | null;
  commerce_effect_json: string | null;
  execution_lease_id: string | null;
  execution_lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
};

export function createActionLedgerSchema(sql: SqlStorage): void {
  createCurrentActionLedger(sql);
  createActionLedgerIndexes(sql);
}

function createCurrentActionLedger(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS action_ledger (
      organisation_id TEXT NOT NULL,
      integration_account_id TEXT NOT NULL,
      nonce TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      verb TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      action_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN (
        'proposed', 'approval_requested', 'signed', 'executing',
        'confirmed', 'failed', 'rejected', 'expired', 'indeterminate'
      )),
      approval_json TEXT,
      rejection_json TEXT,
      provider_result TEXT,
      commerce_effect_json TEXT CHECK (commerce_effect_json IS NULL OR json_valid(commerce_effect_json)),
      execution_lease_id TEXT,
      execution_lease_expires_at INTEGER,
      expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      CHECK (
        (state IN ('proposed', 'approval_requested')
          AND approval_json IS NULL
          AND rejection_json IS NULL
          AND provider_result IS NULL
          AND execution_lease_id IS NULL
          AND execution_lease_expires_at IS NULL) OR
        (state IN ('signed', 'indeterminate')
          AND approval_json IS NOT NULL
          AND rejection_json IS NULL
          AND provider_result IS NULL
          AND execution_lease_id IS NULL
          AND execution_lease_expires_at IS NULL) OR
        (state = 'executing'
          AND approval_json IS NOT NULL
          AND rejection_json IS NULL
          AND provider_result IS NULL
          AND execution_lease_id IS NOT NULL
          AND length(execution_lease_id) > 0
          AND execution_lease_expires_at IS NOT NULL
          AND execution_lease_expires_at >= 0) OR
        (state IN ('confirmed', 'failed')
          AND approval_json IS NOT NULL
          AND rejection_json IS NULL
          AND provider_result IS NOT NULL
          AND execution_lease_id IS NULL
          AND execution_lease_expires_at IS NULL) OR
        (state = 'rejected'
          AND approval_json IS NULL
          AND rejection_json IS NOT NULL
          AND provider_result IS NULL
          AND execution_lease_id IS NULL
          AND execution_lease_expires_at IS NULL) OR
        (state = 'expired'
          AND rejection_json IS NULL
          AND execution_lease_id IS NULL
          AND execution_lease_expires_at IS NULL)
      ),
      CHECK (
        (execution_lease_id IS NULL AND execution_lease_expires_at IS NULL) OR
        (execution_lease_id IS NOT NULL AND execution_lease_expires_at IS NOT NULL)
      )
    )`,
  );
}

function createActionLedgerIndexes(sql: SqlStorage): void {
  sql.exec(
    `CREATE INDEX IF NOT EXISTS action_ledger_retry
     ON action_ledger (
       organisation_id, integration_account_id, session_id, verb, args_hash, state, expires_at
     )`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS action_ledger_resource
     ON action_ledger (organisation_id, integration_account_id, resource_key, state)`,
  );
}

export function proposeAction(
  sql: SqlStorage,
  input: ProposeActionInput,
): Result<ActionLedgerEntry, ActionLedgerError> {
  const valid = validateProposal(input);

  if (!valid.ok) {
    return valid;
  }

  expireActions(sql, input.organisationId, input.now);
  const existing = readProposalAction(sql, input);

  if (existing !== undefined) {
    const replay = actionFromRow(existing);
    return actionMatchesProposal(replay, input)
      ? { ok: true, value: replay }
      : { ok: false, error: { code: "action_replay" } };
  }

  const nonce = crypto.randomUUID();
  const action: LedgerCanonicalAction = {
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    requestAuthority: input.requestAuthority,
    authorityPartition: input.authorityPartition,
    authority: input.authority,
    threadId: input.threadId,
    sessionId: input.sessionId,
    host: input.draft.host,
    verb: input.draft.verb,
    path: input.draft.path,
    argsHash: input.draft.argsHash,
    amount: input.draft.amount,
    nonce: { value: nonce },
    exp: input.exp,
    resourceKey: input.draft.resourceKey,
    flowBinding: input.flowBinding,
  };
  const idempotencyKey = idempotencyKeyForNonce(
    input.integrationAccountId,
    nonce,
  );

  sql.exec(
    `INSERT INTO action_ledger (
       organisation_id, integration_account_id, nonce, case_id, proposal_id, session_id, thread_id,
       resource_key, verb, args_hash,
       action_json, idempotency_key, state, approval_json, rejection_json,
       provider_result, expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, NULL, NULL, ?, ?, ?)`,
    input.organisationId,
    input.integrationAccountId,
    nonce,
    input.caseId,
    input.proposalId,
    input.sessionId,
    input.threadId,
    input.draft.resourceKey,
    input.draft.verb,
    input.draft.argsHash,
    JSON.stringify(action),
    idempotencyKey,
    input.exp,
    input.now,
    input.now,
  );

  return readActionResult(sql, input.organisationId, nonce);
}

export function requestActionApproval(
  sql: SqlStorage,
  input: RequestActionApprovalInput,
): Result<ActionLedgerEntry, ActionLedgerError> {
  expireActions(sql, input.organisationId, input.now);
  const current = readAction(sql, input.organisationId, input.nonce);

  if (current === undefined) {
    return { ok: false, error: { code: "action_not_found" } };
  }

  const entry = actionFromRow(current);

  if (entry.state === "approval_requested") {
    return { ok: true, value: entry };
  }

  if (entry.state === "expired") {
    return { ok: false, error: { code: "action_expired" } };
  }

  if (entry.state !== "proposed") {
    return invalidTransition(entry.state);
  }

  sql.exec(
    `UPDATE action_ledger SET state = 'approval_requested', updated_at = ?
     WHERE organisation_id = ? AND nonce = ? AND state = 'proposed'`,
    input.now,
    input.organisationId,
    input.nonce,
  );
  return readActionResult(sql, input.organisationId, input.nonce);
}

export function rejectAction(
  sql: SqlStorage,
  input: RejectActionInput,
): Result<ActionLedgerEntry, ActionLedgerError> {
  const rejection = parseMerchantActionRejectionEvidence(input.rejection);
  if (
    !rejection.ok ||
    rejection.value.decision.action.organisationId !== input.organisationId ||
    rejection.value.decision.action.actionNonce !== input.nonce
  ) {
    return { ok: false, error: { code: "invalid_action", field: "rejection" } };
  }
  expireActions(sql, input.organisationId, input.now);
  const current = readAction(sql, input.organisationId, input.nonce);
  if (current === undefined)
    return { ok: false, error: { code: "action_not_found" } };
  const entry = actionFromRow(current);
  if (entry.state === "rejected") {
    return serializeMerchantActionRejectionEvidence(entry.rejection) ===
      serializeMerchantActionRejectionEvidence(rejection.value)
      ? { ok: true, value: entry }
      : invalidTransition(entry.state);
  }
  if (entry.state === "expired")
    return { ok: false, error: { code: "action_expired" } };
  if (entry.state !== "proposed" && entry.state !== "approval_requested") {
    return invalidTransition(entry.state);
  }
  sql.exec(
    `UPDATE action_ledger
        SET state = 'rejected', rejection_json = ?, updated_at = ?
      WHERE organisation_id = ? AND nonce = ? AND state IN ('proposed', 'approval_requested')`,
    serializeMerchantActionRejectionEvidence(rejection.value),
    input.now,
    input.organisationId,
    input.nonce,
  );
  return readActionResult(sql, input.organisationId, input.nonce);
}

export function getAction(
  sql: SqlStorage,
  input: GetActionInput,
): Result<ActionLedgerEntry, ActionLedgerError> {
  expireActions(sql, input.organisationId, input.now);
  return readActionResult(sql, input.organisationId, input.nonce);
}

export function readActionActivity(
  sql: SqlStorage,
  input: ReadActionActivityInput,
): Result<readonly ActionLedgerActivity[], ActionLedgerError> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    return { ok: false, error: { code: "invalid_action", field: "limit" } };
  }
  if (
    input.resourceKey !== null &&
    (input.resourceKey.length === 0 || input.resourceKey.length > 256)
  ) {
    return {
      ok: false,
      error: { code: "invalid_action", field: "resourceKey" },
    };
  }
  expireActions(sql, input.organisationId, Date.now());
  const rows = sql
    .exec<ActionLedgerRow>(
      `SELECT action_json, idempotency_key, state, approval_json, rejection_json,
            provider_result, commerce_effect_json, execution_lease_id, execution_lease_expires_at,
            case_id, proposal_id,
            resource_key, created_at, updated_at
       FROM action_ledger
      WHERE organisation_id = ?
        AND (? IS NULL OR resource_key = ?)
      ORDER BY updated_at DESC, nonce DESC
      LIMIT ?`,
      input.organisationId,
      input.resourceKey,
      input.resourceKey,
      input.limit,
    )
    .toArray();
  return {
    ok: true,
    value: rows.flatMap(function parseCurrentActionActivity(row) {
      const activity = tryActionActivityFromRow(row);
      return activity === null ? [] : [activity];
    }),
  };
}

function tryActionActivityFromRow(
  row: ActionLedgerRow,
): ActionLedgerActivity | null {
  try {
    return actionActivityFromRow(row);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "invalid_canonical_action_record"
    ) {
      return null;
    }
    throw error;
  }
}

export function signAction(
  sql: SqlStorage,
  input: SignActionInput,
): Result<ActionLedgerEntry, ActionLedgerError> {
  const approval = parseApprovalEvidence(input.approval);
  if (!approval.ok) {
    return { ok: false, error: { code: "invalid_action", field: "approval" } };
  }

  expireActions(sql, input.organisationId, input.now);
  const current = readAction(sql, input.organisationId, input.nonce);

  if (current === undefined) {
    return { ok: false, error: { code: "action_not_found" } };
  }

  const entry = actionFromRow(current);

  if (entry.state === "expired") {
    return { ok: false, error: { code: "action_expired" } };
  }

  if (
    entry.state === "signed" ||
    entry.state === "executing" ||
    entry.state === "indeterminate" ||
    entry.state === "confirmed" ||
    entry.state === "failed"
  ) {
    return approvalEvidenceMatchesForLedger(entry.approval, approval.value)
      ? { ok: true, value: entry }
      : invalidTransition(entry.state);
  }

  if (entry.state !== "approval_requested") {
    return invalidTransition(entry.state);
  }

  // A Slack approval proves less than a step-up: it signs only the action it
  // names, and only an action that moves no money.
  const authentication = approval.value.authentication;
  if (
    authentication.kind === "slack_verified_link" &&
    (authentication.challenge.organisationId !== input.organisationId ||
      authentication.challenge.actionNonce !== input.nonce ||
      !actionLedgerCommerce.use().slackMayApprove(entry.action))
  ) {
    return { ok: false, error: { code: "invalid_action", field: "approval" } };
  }

  sql.exec(
    `UPDATE action_ledger
     SET state = 'signed', approval_json = ?, updated_at = ?
     WHERE organisation_id = ? AND nonce = ? AND state = 'approval_requested'`,
    serializeApprovalEvidence(approval.value),
    input.now,
    input.organisationId,
    input.nonce,
  );
  return readActionResult(sql, input.organisationId, input.nonce);
}

function approvalEvidenceMatchesForLedger(
  current: ApprovalEvidence,
  next: ApprovalEvidence,
): boolean {
  return serializeApprovalEvidence(current) === serializeApprovalEvidence(next);
}

export function beginActionExecution(
  sql: SqlStorage,
  input: BeginActionExecutionInput,
): Result<ActionLedgerEntry, ActionLedgerError> {
  if (
    !Number.isSafeInteger(input.now) ||
    input.now < 0 ||
    !Number.isSafeInteger(input.now + ACTION_EXECUTION_LEASE_DURATION_MS)
  ) {
    return { ok: false, error: { code: "invalid_action", field: "now" } };
  }
  expireActions(sql, input.organisationId, input.now);
  const current = readAction(sql, input.organisationId, input.nonce);

  if (current === undefined) {
    return { ok: false, error: { code: "action_not_found" } };
  }

  const entry = actionFromRow(current);

  if (entry.state === "confirmed" || entry.state === "failed") {
    return { ok: false, error: { code: "action_replay" } };
  }

  if (entry.state === "expired") {
    return { ok: false, error: { code: "action_expired" } };
  }

  if (entry.state !== "signed") {
    return invalidTransition(entry.state);
  }

  if (
    hasBusyResource(
      sql,
      input.organisationId,
      entry.action.integrationAccountId,
      entry.action.resourceKey,
      input.nonce,
    )
  ) {
    return {
      ok: false,
      error: { code: "resource_busy", resourceKey: entry.action.resourceKey },
    };
  }

  sql.exec(
    `UPDATE action_ledger
        SET state = 'executing', execution_lease_id = ?,
            execution_lease_expires_at = ?, updated_at = ?
     WHERE organisation_id = ? AND nonce = ? AND state = 'signed'`,
    crypto.randomUUID(),
    input.now + ACTION_EXECUTION_LEASE_DURATION_MS,
    input.now,
    input.organisationId,
    input.nonce,
  );
  return readActionResult(sql, input.organisationId, input.nonce);
}

export function retryIndeterminateActionExecution(
  sql: SqlStorage,
  input: RetryIndeterminateActionExecutionInput,
): Result<ActionLedgerEntry, ActionLedgerError> {
  if (
    !Number.isSafeInteger(input.now) ||
    input.now < 0 ||
    !Number.isSafeInteger(input.now + ACTION_EXECUTION_LEASE_DURATION_MS) ||
    !Number.isSafeInteger(input.evidence.observedAt) ||
    input.evidence.observedAt < 0 ||
    input.evidence.observedAt > input.now ||
    !retryEvidenceHasRequiredIdentity(input.evidence)
  ) {
    return {
      ok: false,
      error: { code: "invalid_action", field: "retryEvidence" },
    };
  }
  expireActions(sql, input.organisationId, input.now);
  const current = readAction(sql, input.organisationId, input.nonce);
  if (current === undefined)
    return { ok: false, error: { code: "action_not_found" } };
  const entry = actionFromRow(current);
  if (entry.state === "confirmed" || entry.state === "failed") {
    return { ok: false, error: { code: "action_replay" } };
  }
  if (entry.state === "expired")
    return { ok: false, error: { code: "action_expired" } };
  if (entry.state !== "indeterminate") return invalidTransition(entry.state);
  if (
    !retryEvidenceMatchesAction(input.evidence, entry) ||
    input.evidence.observedAt < entry.updatedAt
  ) {
    return {
      ok: false,
      error: { code: "invalid_action", field: "retryEvidence" },
    };
  }
  if (
    hasBusyResource(
      sql,
      input.organisationId,
      entry.action.integrationAccountId,
      entry.action.resourceKey,
      input.nonce,
    )
  ) {
    return {
      ok: false,
      error: { code: "resource_busy", resourceKey: entry.action.resourceKey },
    };
  }
  sql.exec(
    `UPDATE action_ledger
        SET state = 'executing', execution_lease_id = ?,
            execution_lease_expires_at = ?, updated_at = ?
      WHERE organisation_id = ? AND nonce = ? AND state = 'indeterminate'`,
    crypto.randomUUID(),
    input.now + ACTION_EXECUTION_LEASE_DURATION_MS,
    input.now,
    input.organisationId,
    input.nonce,
  );
  return readActionResult(sql, input.organisationId, input.nonce);
}

function retryEvidenceHasRequiredIdentity(
  evidence: ActionExecutionRetryEvidence,
): boolean {
  switch (evidence.kind) {
    case "provider_idempotency_absent":
    case "provider_idempotent_replay":
      return (
        typeof evidence.idempotencyKey === "string" &&
        evidence.idempotencyKey.length > 0
      );
    case "local_effect_absent":
      return (
        typeof evidence.resourceKey === "string" &&
        evidence.resourceKey.length > 0
      );
  }
}

function retryEvidenceMatchesAction(
  evidence: ActionExecutionRetryEvidence,
  entry: ActionLedgerEntry,
): boolean {
  if (evidence.integrationAccountId !== entry.action.integrationAccountId)
    return false;
  // A custom connector write may replay only when its reviewed definition
  // declared provider idempotency.
  if (
    entry.action.authority.kind === "custom_connector" &&
    (evidence.kind !== "provider_idempotent_replay" ||
      entry.action.authority.retryPolicy.kind !== "provider_idempotent")
  )
    return false;
  switch (evidence.kind) {
    case "provider_idempotency_absent":
    case "provider_idempotent_replay":
      return evidence.idempotencyKey === entry.idempotencyKey;
    case "local_effect_absent":
      return evidence.resourceKey === entry.action.resourceKey;
  }
}

export function completeActionExecution(
  sql: SqlStorage,
  input: CompleteActionExecutionInput,
): Result<ActionLedgerEntry, ActionLedgerError> {
  if (input.providerResult.length === 0) {
    return {
      ok: false,
      error: { code: "invalid_action", field: "providerResult" },
    };
  }

  expireActions(sql, input.organisationId, input.now);
  const current = readAction(sql, input.organisationId, input.nonce);

  if (current === undefined) {
    return { ok: false, error: { code: "action_not_found" } };
  }

  const entry = actionFromRow(current);

  if (entry.state !== "executing") {
    if (entry.state === "indeterminate") {
      return { ok: false, error: { code: "action_execution_lease_invalid" } };
    }
    return invalidTransition(entry.state);
  }

  if (
    entry.executionLease.leaseId !== input.executionLeaseId ||
    entry.executionLease.expiresAt <= input.now
  ) {
    return { ok: false, error: { code: "action_execution_lease_invalid" } };
  }

  if (input.outcome === "indeterminate") {
    sql.exec(
      `UPDATE action_ledger
          SET state = 'indeterminate', execution_lease_id = NULL,
              execution_lease_expires_at = NULL, updated_at = ?
       WHERE organisation_id = ? AND nonce = ? AND state = 'executing'
         AND execution_lease_id = ? AND execution_lease_expires_at > ?`,
      input.now,
      input.organisationId,
      input.nonce,
      input.executionLeaseId,
      input.now,
    );
  } else {
    sql.exec(
      `UPDATE action_ledger
          SET state = ?, provider_result = ?, execution_lease_id = NULL,
              execution_lease_expires_at = NULL, updated_at = ?
       WHERE organisation_id = ? AND nonce = ? AND state = 'executing'
         AND execution_lease_id = ? AND execution_lease_expires_at > ?`,
      input.outcome,
      input.providerResult,
      input.now,
      input.organisationId,
      input.nonce,
      input.executionLeaseId,
      input.now,
    );
  }

  return readActionResult(sql, input.organisationId, input.nonce);
}

/**
 * Settles an execution from a provider receipt after the process that started
 * the effect may have disappeared. A matching terminal receipt is idempotent;
 * a different receipt is a conflict and never overwrites durable evidence.
 */
export function reconcileActionExecution(
  sql: SqlStorage,
  input: ReconcileActionExecutionInput,
): Result<ActionLedgerEntry, ActionLedgerError> {
  if (input.providerResult.length === 0) {
    return {
      ok: false,
      error: { code: "invalid_action", field: "providerResult" },
    };
  }

  const current = readAction(sql, input.organisationId, input.nonce);
  if (current === undefined) {
    return { ok: false, error: { code: "action_not_found" } };
  }

  const entry = actionFromRow(current);
  if (entry.state === "confirmed" || entry.state === "failed") {
    return entry.state === input.outcome &&
      entry.providerResult === input.providerResult
      ? { ok: true, value: entry }
      : { ok: false, error: { code: "action_receipt_conflict" } };
  }
  if (entry.state !== "executing" && entry.state !== "indeterminate") {
    return invalidTransition(entry.state);
  }
  if (input.outcome === "indeterminate") {
    if (entry.state === "indeterminate") {
      return { ok: true, value: entry };
    }
    sql.exec(
      `UPDATE action_ledger
          SET state = 'indeterminate', execution_lease_id = NULL,
              execution_lease_expires_at = NULL, updated_at = ?
        WHERE organisation_id = ? AND nonce = ? AND state = 'executing'`,
      input.now,
      input.organisationId,
      input.nonce,
    );
  } else {
    sql.exec(
      `UPDATE action_ledger
          SET state = ?, provider_result = ?, execution_lease_id = NULL,
              execution_lease_expires_at = NULL, updated_at = ?
        WHERE organisation_id = ? AND nonce = ? AND state IN ('executing', 'indeterminate')`,
      input.outcome,
      input.providerResult,
      input.now,
      input.organisationId,
      input.nonce,
    );
  }
  return readActionResult(sql, input.organisationId, input.nonce);
}

export function recordCommerceEntityPlaneEffect(
  sql: SqlStorage,
  input: RecordCommerceEntityPlaneEffectInput,
): Result<ActionLedgerEntry, ActionLedgerError> {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    return { ok: false, error: { code: "invalid_action", field: "now" } };
  }
  const effect = actionLedgerCommerce.use().parseEffect(input.effect);
  if (effect === null) {
    return { ok: false, error: { code: "invalid_action", field: "effect" } };
  }
  const current = readAction(sql, input.organisationId, input.nonce);
  if (current === undefined)
    return { ok: false, error: { code: "action_not_found" } };
  const entry = actionFromRow(current);
  if (entry.commerceEffect !== null) {
    return JSON.stringify(entry.commerceEffect) === JSON.stringify(effect)
      ? { ok: true, value: entry }
      : { ok: false, error: { code: "action_receipt_conflict" } };
  }
  if (entry.state !== "confirmed") {
    return invalidTransition(entry.state);
  }
  sql.exec(
    `UPDATE action_ledger
        SET commerce_effect_json = ?, updated_at = ?
      WHERE organisation_id = ? AND nonce = ? AND state = 'confirmed'
        AND commerce_effect_json IS NULL`,
    JSON.stringify(effect),
    input.now,
    input.organisationId,
    input.nonce,
  );
  if (sqlChanges(sql) === 0) {
    const replay = readAction(sql, input.organisationId, input.nonce);
    if (replay === undefined)
      return { ok: false, error: { code: "action_receipt_conflict" } };
    const replayEntry = actionFromRow(replay);
    return replayEntry.commerceEffect !== null &&
      JSON.stringify(replayEntry.commerceEffect) === JSON.stringify(effect)
      ? { ok: true, value: replayEntry }
      : { ok: false, error: { code: "action_receipt_conflict" } };
  }
  return readActionResult(sql, input.organisationId, input.nonce);
}

function validateProposal(
  input: ProposeActionInput,
): Result<null, ActionLedgerError> {
  const values: readonly [string, string][] = [
    ["integrationAccountId", input.integrationAccountId],
    ["caseId", input.caseId],
    ["proposalId", input.proposalId],
    ["threadId", input.threadId],
    ["host", input.draft.host],
    ["verb", input.draft.verb],
    ["path", input.draft.path],
    ["argsHash", input.draft.argsHash],
    ["resourceKey", input.draft.resourceKey],
  ];

  for (const [field, value] of values) {
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, error: { code: "invalid_action", field } };
    }
  }

  if (
    !Number.isSafeInteger(input.now) ||
    !Number.isSafeInteger(input.exp) ||
    input.exp <= input.now
  ) {
    return { ok: false, error: { code: "invalid_action", field: "exp" } };
  }
  if (!validActionAuthorityPartition(input)) {
    return {
      ok: false,
      error: { code: "invalid_action", field: "authorityPartition" },
    };
  }
  if (!validateActionAuthority(input.authority)) {
    return { ok: false, error: { code: "invalid_action", field: "authority" } };
  }
  if (!validSerializedFlowBinding(input.flowBinding)) {
    return {
      ok: false,
      error: { code: "invalid_action", field: "flowBinding" },
    };
  }
  if (
    !flowBindingMatchesIdentity(input.flowBinding, {
      organisationId: input.organisationId,
      sessionId: input.sessionId,
      authorityPartitionDigest: input.authorityPartition.digest,
    })
  ) {
    return {
      ok: false,
      error: { code: "invalid_action", field: "flowBinding.identity" },
    };
  }

  return { ok: true, value: null };
}

function actionMatchesProposal(
  entry: ActionLedgerEntry,
  input: ProposeActionInput,
): boolean {
  const action = entry.action;
  return (
    action.organisationId === input.organisationId &&
    action.integrationAccountId === input.integrationAccountId &&
    entry.caseId === input.caseId &&
    action.sessionId === input.sessionId &&
    action.threadId === input.threadId &&
    action.host === input.draft.host &&
    action.verb === input.draft.verb &&
    action.path === input.draft.path &&
    action.argsHash === input.draft.argsHash &&
    action.resourceKey === input.draft.resourceKey &&
    JSON.stringify(action.amount) === JSON.stringify(input.draft.amount) &&
    JSON.stringify(action.requestAuthority) ===
      JSON.stringify(input.requestAuthority) &&
    action.authorityPartition.digest === input.authorityPartition.digest &&
    JSON.stringify(action.authority) === JSON.stringify(input.authority) &&
    JSON.stringify(action.flowBinding) === JSON.stringify(input.flowBinding)
  );
}

function readProposalAction(
  sql: SqlStorage,
  input: ProposeActionInput,
): ActionLedgerRow | undefined {
  return sql
    .exec<ActionLedgerRow>(
      `SELECT action_json, idempotency_key, state, approval_json, rejection_json,
            provider_result, commerce_effect_json, execution_lease_id, execution_lease_expires_at,
            case_id, proposal_id,
            created_at, updated_at
     FROM action_ledger
     WHERE proposal_id = ?`,
      input.proposalId,
    )
    .toArray()[0];
}

function readAction(
  sql: SqlStorage,
  organisationId: OrganisationId,
  nonce: string,
): ActionLedgerRow | undefined {
  return sql
    .exec<ActionLedgerRow>(
      `SELECT action_json, idempotency_key, state, approval_json, rejection_json,
            provider_result, commerce_effect_json, execution_lease_id, execution_lease_expires_at,
            case_id, proposal_id,
            created_at, updated_at
     FROM action_ledger WHERE organisation_id = ? AND nonce = ?`,
      organisationId,
      nonce,
    )
    .toArray()[0];
}

export function readActionResult(
  sql: SqlStorage,
  organisationId: OrganisationId,
  nonce: string,
): Result<ActionLedgerEntry, ActionLedgerError> {
  const row = readAction(sql, organisationId, nonce);

  if (row === undefined) {
    return { ok: false, error: { code: "action_not_found" } };
  }

  return { ok: true, value: actionFromRow(row) };
}

function actionFromRow(row: ActionLedgerRow): ActionLedgerEntry {
  const action = parseCanonicalAction(row.action_json);
  const identity: ActionIdentity = {
    action,
    caseId: requireCaseId(row.case_id),
    proposalId: requireString(row.proposal_id, "proposal_id"),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    commerceEffect: parseCommerceEffect(row.commerce_effect_json),
  };

  switch (row.state) {
    case "proposed":
      return { ...identity, state: row.state };
    case "approval_requested":
      return { ...identity, state: row.state };
    case "signed":
    case "indeterminate":
      return {
        ...identity,
        state: row.state,
        approval: requireApprovalEvidence(row.approval_json),
      };
    case "executing":
      return {
        ...identity,
        state: row.state,
        approval: requireApprovalEvidence(row.approval_json),
        executionLease: requireExecutionLease(
          row.execution_lease_id,
          row.execution_lease_expires_at,
        ),
      };
    case "confirmed":
    case "failed":
      return {
        ...identity,
        state: row.state,
        approval: requireApprovalEvidence(row.approval_json),
        providerResult: requireString(row.provider_result, "provider_result"),
      };
    case "rejected":
      return {
        ...identity,
        state: row.state,
        rejection: requireMerchantActionRejectionEvidence(row.rejection_json),
      };
    case "expired":
      return {
        ...identity,
        state: row.state,
        approval:
          row.approval_json === null
            ? null
            : requireApprovalEvidence(row.approval_json),
      };
    default:
      throw new Error("invalid_action_ledger_state");
  }
}

function actionActivityFromRow(row: ActionLedgerRow): ActionLedgerActivity {
  const entry = actionFromRow(row);
  const providerResult =
    entry.state === "confirmed" || entry.state === "failed"
      ? entry.providerResult
      : null;
  return {
    action: entry.action,
    caseId: entry.caseId,
    proposalId: entry.proposalId,
    state: entry.state,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    providerResult,
    commerceEffect: entry.commerceEffect,
  };
}

function parseCommerceEffect(
  value: string | null,
): CommerceEntityPlaneEffect | null {
  if (value === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("invalid_commerce_entity_plane_effect");
  }
  const parsed = actionLedgerCommerce.use().parseEffect(raw);
  if (parsed === null) throw new Error("invalid_commerce_entity_plane_effect");
  return parsed;
}

function parseCanonicalAction(raw: string): LedgerCanonicalAction {
  const parsed: unknown = JSON.parse(raw);

  if (
    !isRecord(parsed) ||
    !isRecord(parsed.nonce) ||
    typeof parsed.nonce.value !== "string"
  ) {
    throw new Error("invalid_canonical_action_record");
  }

  if (
    typeof parsed.organisationId !== "string" ||
    typeof parsed.integrationAccountId !== "string" ||
    !isRecord(parsed.authority) ||
    typeof parsed.threadId !== "string" ||
    typeof parsed.sessionId !== "string" ||
    typeof parsed.host !== "string" ||
    typeof parsed.verb !== "string" ||
    typeof parsed.path !== "string" ||
    typeof parsed.argsHash !== "string" ||
    typeof parsed.exp !== "number" ||
    typeof parsed.resourceKey !== "string" ||
    !Number.isSafeInteger(parsed.exp) ||
    parsed.exp < 0 ||
    !validSerializedFlowBinding(parsed.flowBinding) ||
    !isAmount(parsed.amount)
  ) {
    throw new Error("invalid_canonical_action_record");
  }

  const organisationId = parseOrganisationId(parsed.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    parsed.integrationAccountId,
  );
  const sessionId = parseSessionId(parsed.sessionId);
  const authority = parseActionAuthority(parsed.authority);
  const requestAuthority = parseStoredRequestAuthority(parsed.requestAuthority);
  const authorityPartition = requestAuthority.ok
    ? parseLedgerAuthorityPartition(
        parsed.authorityPartition,
        requestAuthority.value.requestAuthority,
      )
    : null;

  if (
    !organisationId.ok ||
    !integrationAccountId.ok ||
    !sessionId.ok ||
    authority === null ||
    !requestAuthority.ok ||
    authorityPartition === null ||
    requestAuthority.value.requestAuthority.organisationId !==
      organisationId.value ||
    !partitionAdmitsAction(
      authorityPartition,
      integrationAccountId.value,
      parsed.resourceKey,
      authority,
    ) ||
    !flowBindingMatchesIdentity(parsed.flowBinding, {
      organisationId: organisationId.value,
      sessionId: sessionId.value,
      authorityPartitionDigest: authorityPartition.digest,
    })
  ) {
    throw new Error("invalid_canonical_action_record");
  }

  return {
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    requestAuthority: requestAuthority.value.requestAuthority,
    authorityPartition,
    authority,
    threadId: parsed.threadId,
    sessionId: sessionId.value,
    host: parsed.host,
    verb: parsed.verb,
    path: parsed.path,
    argsHash: parsed.argsHash,
    amount: parsed.amount,
    nonce: { value: parsed.nonce.value },
    exp: parsed.exp,
    resourceKey: parsed.resourceKey,
    flowBinding: parsed.flowBinding,
  };
}

function validSerializedFlowBinding(
  value: unknown,
): value is SerializedFlowBinding {
  if (
    !isRecord(value) ||
    !isRecord(value.flowLabel) ||
    typeof value.organisationId !== "string" ||
    value.organisationId.length === 0 ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    typeof value.turnId !== "string" ||
    value.turnId.length === 0 ||
    !isSha256Hex(value.authorityPartitionDigest) ||
    !isSha256Hex(value.informationFlowContextDigest) ||
    !isSha256Hex(value.observationSetDigest) ||
    !isNonNegativeInteger(value.contextRevision)
  ) {
    return false;
  }
  return (
    isRecord(value.flowLabel) &&
    Array.isArray(value.flowLabel.policies) &&
    isSha256Hex(value.flowLabel.digest)
  );
}

function validateActionAuthority(authority: ActionAuthority): boolean {
  switch (authority.kind) {
    case "commerce_system":
      return (
        isCommerceSystemKind(authority.system) &&
        parseCommerceSystemRevision(authority.revision).ok
      );
    case "integration_account":
      return true;
    case "custom_connector":
      return validCustomConnectorActionAuthority(authority);
  }
}

function parseActionAuthority(
  raw: Record<string, unknown>,
): ActionAuthority | null {
  switch (raw.kind) {
    case "commerce_system": {
      const revision = parseCommerceSystemRevision(raw.revision);
      return Object.keys(raw).length === 3 &&
        isCommerceSystemKind(raw.system) &&
        revision.ok
        ? {
            kind: "commerce_system",
            system: raw.system,
            revision: revision.value,
          }
        : null;
    }
    case "integration_account":
      return Object.keys(raw).length === 1
        ? { kind: "integration_account" }
        : null;
    case "custom_connector":
      return parseCustomConnectorActionAuthority(raw);
    default:
      return null;
  }
}

function validCustomConnectorActionAuthority(
  authority: CustomConnectorActionAuthority,
): boolean {
  return (
    authority.connectorId.length > 0 &&
    Number.isSafeInteger(authority.definitionRevision) &&
    authority.definitionRevision > 0 &&
    isSha256Hex(authority.definitionDigest) &&
    Number.isSafeInteger(authority.bindingRevision) &&
    authority.bindingRevision > 0 &&
    Number.isSafeInteger(authority.credentialGeneration) &&
    authority.credentialGeneration > 0 &&
    /^[a-z][a-z0-9_]{0,47}$/u.test(authority.operationId) &&
    (authority.effect === "external_record_create" ||
      authority.effect === "external_record_update") &&
    validCustomConnectorRetryPolicy(authority.retryPolicy) &&
    authority.canonicalInputJson.length > 0 &&
    isSha256Hex(authority.canonicalInputDigest) &&
    isSha256Hex(authority.outputContractDigest) &&
    authority.providerEffectId.length > 0 &&
    authority.providerEffectId.length <= 256 &&
    validCustomConnectorResourceIdentity(authority.resourceIdentity)
  );
}

function validCustomConnectorRetryPolicy(
  policy: CustomConnectorActionAuthority["retryPolicy"],
): boolean {
  switch (policy.kind) {
    case "single_attempt":
      return Object.keys(policy).length === 1;
    case "provider_idempotent":
      return (
        Object.keys(policy).length === 2 &&
        /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/u.test(policy.header)
      );
  }
}

function parseCustomConnectorRetryPolicy(
  raw: Record<string, unknown>,
): CustomConnectorActionAuthority["retryPolicy"] | null {
  if (raw.kind === "single_attempt" && Object.keys(raw).length === 1)
    return { kind: "single_attempt" };
  if (
    raw.kind === "provider_idempotent" &&
    Object.keys(raw).length === 2 &&
    typeof raw.header === "string"
  ) {
    const policy = { kind: "provider_idempotent" as const, header: raw.header };
    return validCustomConnectorRetryPolicy(policy) ? policy : null;
  }
  return null;
}

function validCustomConnectorResourceIdentity(
  identity: CustomConnectorActionAuthority["resourceIdentity"],
): boolean {
  switch (identity.kind) {
    case "new_record":
      return Object.keys(identity).length === 1;
    case "existing_record":
      return identity.value.length > 0 && identity.value.length <= 256;
  }
}

function parseCustomConnectorActionAuthority(
  raw: Record<string, unknown>,
): CustomConnectorActionAuthority | null {
  if (
    Object.keys(raw).length !== 14 ||
    typeof raw.connectorId !== "string" ||
    typeof raw.definitionRevision !== "number" ||
    typeof raw.definitionDigest !== "string" ||
    typeof raw.bindingRevision !== "number" ||
    typeof raw.credentialGeneration !== "number" ||
    typeof raw.operationId !== "string" ||
    (raw.effect !== "external_record_create" &&
      raw.effect !== "external_record_update") ||
    !isRecord(raw.retryPolicy) ||
    typeof raw.canonicalInputJson !== "string" ||
    typeof raw.canonicalInputDigest !== "string" ||
    typeof raw.outputContractDigest !== "string" ||
    !isRecord(raw.resourceIdentity) ||
    typeof raw.providerEffectId !== "string"
  ) {
    return null;
  }
  const resourceIdentity = parseCustomConnectorResourceIdentity(
    raw.resourceIdentity,
  );
  if (resourceIdentity === null) return null;
  const retryPolicy = parseCustomConnectorRetryPolicy(raw.retryPolicy);
  if (retryPolicy === null) return null;
  const authority: CustomConnectorActionAuthority = {
    kind: "custom_connector",
    connectorId: raw.connectorId,
    definitionRevision: raw.definitionRevision,
    definitionDigest: raw.definitionDigest,
    bindingRevision: raw.bindingRevision,
    credentialGeneration: raw.credentialGeneration,
    operationId: raw.operationId,
    effect: raw.effect,
    retryPolicy,
    canonicalInputJson: raw.canonicalInputJson,
    canonicalInputDigest: raw.canonicalInputDigest,
    outputContractDigest: raw.outputContractDigest,
    resourceIdentity,
    providerEffectId: raw.providerEffectId,
  };
  return validCustomConnectorActionAuthority(authority) ? authority : null;
}

function parseCustomConnectorResourceIdentity(
  raw: Record<string, unknown>,
): CustomConnectorActionAuthority["resourceIdentity"] | null {
  if (raw.kind === "new_record" && Object.keys(raw).length === 1) {
    return { kind: "new_record" };
  }
  return raw.kind === "existing_record" &&
    Object.keys(raw).length === 2 &&
    typeof raw.value === "string" &&
    raw.value.length > 0 &&
    raw.value.length <= 256
    ? { kind: "existing_record", value: raw.value }
    : null;
}

function validActionAuthorityPartition(input: ProposeActionInput): boolean {
  const authority = parseStoredRequestAuthority(input.requestAuthority);
  if (
    !authority.ok ||
    authority.value.requestAuthority.organisationId !== input.organisationId
  )
    return false;
  const parsed = parseLedgerAuthorityPartition(
    input.authorityPartition,
    authority.value.requestAuthority,
  );
  return (
    parsed !== null &&
    parsed.digest === input.authorityPartition.digest &&
    partitionAdmitsAction(
      parsed,
      input.integrationAccountId,
      input.draft.resourceKey,
      input.authority,
    )
  );
}

function parseLedgerAuthorityPartition(
  raw: unknown,
  requestAuthority: RequestAuthority,
): AuthorityPartition | null {
  const parsed = parseStoredAuthorityPartition(raw);
  return parsed.ok &&
    JSON.stringify(parsed.value.key) ===
      JSON.stringify(authorityPartitionKey(requestAuthority))
    ? parsed.value
    : null;
}

function partitionAdmitsAction(
  partition: AuthorityPartition,
  integrationAccountId: IntegrationAccountId,
  providerResourceScope: string,
  authority: ActionAuthority,
): boolean {
  if (authority.kind === "custom_connector") {
    return partition.capabilityKeys.includes(
      [
        "custom_connector",
        "custom_connector.write",
        "1",
        integrationAccountId,
        authority.connectorId,
        String(authority.definitionRevision),
        authority.definitionDigest,
        authority.operationId,
      ].join(":"),
    );
  }
  const prefix = `provider:commerce.action.propose:1:${integrationAccountId}:`;
  return (
    partition.capabilityKeys.includes(`${prefix}${providerResourceScope}`) ||
    partition.capabilityKeys.includes(`${prefix}*`)
  );
}

function isAmount(raw: unknown): raw is CanonicalAction["amount"] {
  return (
    raw === null ||
    (isRecord(raw) &&
      typeof raw.value === "number" &&
      Number.isFinite(raw.value) &&
      typeof raw.currency === "string")
  );
}

function hasBusyResource(
  sql: SqlStorage,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  resourceKey: string,
  nonce: string,
): boolean {
  const row = sql
    .exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM action_ledger
     WHERE organisation_id = ? AND integration_account_id = ?
       AND resource_key = ? AND nonce <> ?
       AND state IN ('signed', 'executing', 'indeterminate')`,
      organisationId,
      integrationAccountId,
      resourceKey,
      nonce,
    )
    .toArray()[0];
  return (row?.count ?? 0) > 0;
}

function sqlChanges(sql: SqlStorage): number {
  return (
    sql.exec<{ count: number }>("SELECT changes() AS count").toArray()[0]
      ?.count ?? 0
  );
}

export function expireDueActionExecutions(
  sql: SqlStorage,
  organisationId: OrganisationId,
  now: number,
): number {
  sql.exec(
    `UPDATE action_ledger
        SET state = 'indeterminate', execution_lease_id = NULL,
            execution_lease_expires_at = NULL, updated_at = ?
      WHERE organisation_id = ? AND state = 'executing'
        AND execution_lease_expires_at <= ?`,
    now,
    organisationId,
    now,
  );
  return (
    sql.exec<{ count: number }>("SELECT changes() AS count").toArray()[0]
      ?.count ?? 0
  );
}

export function readNextActionExecutionLeaseDeadline(
  sql: SqlStorage,
  organisationId: OrganisationId,
): number | null {
  const next = sql
    .exec<{ next_at: number | null }>(
      `SELECT MIN(execution_lease_expires_at) AS next_at
       FROM action_ledger
      WHERE organisation_id = ? AND state = 'executing'`,
      organisationId,
    )
    .toArray()[0]?.next_at;
  return typeof next === "number" && Number.isSafeInteger(next) ? next : null;
}

function expireActions(
  sql: SqlStorage,
  organisationId: OrganisationId,
  now: number,
): void {
  sql.exec(
    `UPDATE action_ledger SET state = 'expired', updated_at = ?
     WHERE organisation_id = ? AND expires_at <= ?
       AND state IN ('proposed', 'approval_requested', 'signed')`,
    now,
    organisationId,
    now,
  );
  expireDueActionExecutions(sql, organisationId, now);
}

function idempotencyKeyForNonce(
  integrationAccountId: IntegrationAccountId,
  nonce: string,
): string {
  return `pantry:${integrationAccountId}:${nonce}`;
}

function invalidTransition(
  state: ActionLedgerEntry["state"],
): Result<never, ActionLedgerError> {
  return { ok: false, error: { code: "invalid_action_transition", state } };
}

function requireCaseId(value: string): CaseId {
  const parsed = parseCaseId(value);
  if (!parsed.ok) throw new Error("invalid_action_ledger_case_id");
  return parsed.value;
}

function requireString(value: string | null, field: string): string {
  if (value === null || value.length === 0) {
    throw new Error(`invalid_action_ledger_${field}`);
  }

  return value;
}

function requireApprovalEvidence(value: string | null): ApprovalEvidence {
  const parsed = parseStoredApprovalEvidence(value);
  if (!parsed.ok) {
    throw new Error("invalid_action_ledger_approval");
  }
  return parsed.value;
}

function requireMerchantActionRejectionEvidence(
  value: string | null,
): MerchantActionRejectionEvidence {
  const parsed = parseStoredMerchantActionRejectionEvidence(value);
  if (!parsed.ok) throw new Error("invalid_action_ledger_rejection");
  return parsed.value;
}

function requireExecutionLease(
  leaseId: string | null,
  expiresAt: number | null,
): ActionExecutionLease {
  if (
    leaseId === null ||
    leaseId.length === 0 ||
    expiresAt === null ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 0
  ) {
    throw new Error("invalid_action_ledger_execution_lease");
  }
  return { leaseId, expiresAt };
}

/** Arms the alarm of the actor for the end of an action execution lease. */
export async function armActionExecutionAlarm(
  storage: DurableObjectStorage,
  now: number,
): Promise<void> {
  const deadline = now + ACTION_EXECUTION_LEASE_DURATION_MS;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(deadline))
    return;
  await armAlarmBy(storage, deadline);
}

import type { AlarmReconciler } from "./lifecycle/actor-alarm";
import type { SqlStorage } from "@cloudflare/workers-types";

import type { Result } from "../result";
import { backoffDelay, isRecord } from "@purin-labs/std";
import type { SchemaTransaction } from "./schema-migrations";
import {
  advanceWhatsAppProposal,
  createConnectorWhatsAppProposalSchema,
  insertWhatsAppProposal,
  WHATSAPP_SEND_ATTEMPT_LEASE_MS,
  type WhatsAppProposalState,
} from "./whatsapp-reply-proposal-transition";

/**
 * Phone-number-addressed Connector runtime. This is the only durable home for
 * an open WhatsApp support Case: the ordered active envelope, the debounce
 * clock, provider dedupe, policy counters, token reservations, ownership, and
 * proposal lifecycle all live here.
 *
 * Every text value stored here is application-encrypted and bounded to the
 * open Case. Rows outside the envelope and proposal tables hold identifiers,
 * digests, counters, and instants only.
 */

const WHATSAPP_SERVICE_WINDOW_MS = 24 * 3_600_000;

export type WhatsAppIngressLimits = {
  readonly maxActiveCases: number;
  readonly maxMessagesPerHour: number;
  readonly dailyAgentTokenBudget: number;
  readonly maxMessageBytes: number;
  readonly maxActiveCaseMessages: number;
  readonly maxActiveCaseBytes: number;
  readonly debounceSeconds: number;
};

export type WhatsAppPauseReason =
  | {
      readonly kind: "active_case_limit";
      readonly observed: number;
      readonly limit: number;
    }
  | {
      readonly kind: "hourly_message_limit";
      readonly observed: number;
      readonly limit: number;
      readonly windowEndsAt: number;
    }
  | {
      readonly kind: "daily_token_budget";
      readonly reserved: number;
      readonly consumed: number;
      readonly limit: number;
      readonly windowEndsAt: number;
    }
  | {
      readonly kind: "message_too_large";
      readonly providerMessageId: string;
      readonly observedBytes: number;
      readonly limitBytes: number;
    }
  | {
      readonly kind: "unsupported_message_type";
      readonly providerMessageId: string;
      readonly messageType: string;
    }
  | {
      readonly kind: "service_window_expired";
      readonly caseId: string;
      readonly expiredAt: number;
    }
  | {
      readonly kind: "send_indeterminate";
      readonly proposalId: string;
      readonly caseId: string;
    };

type WhatsAppProcessingState =
  | { readonly kind: "waiting" }
  | { readonly kind: "scheduled"; readonly at: number }
  | {
      readonly kind: "processing";
      readonly caseId: string;
      readonly startedAt: number;
    }
  | {
      readonly kind: "paused";
      readonly reason: WhatsAppPauseReason;
      readonly pausedAt: number;
      readonly policyVersion: number;
    };

export type WhatsAppRuntimeSnapshot = {
  readonly organisationId: string;
  readonly integrationAccountId: string;
  readonly policyVersion: number;
  readonly limits: WhatsAppIngressLimits;
  readonly supportBindingId: string;
  readonly bindingRevision: number;
  readonly credentialGeneration: number;
  readonly processing: WhatsAppProcessingState;
  readonly activationFloor: number;
  readonly disabledAt: number | null;
};

type WhatsAppRuntimeError = { readonly code: string };

type WhatsAppEnvelopeReadError = {
  readonly code: "connector_whatsapp_storage_corrupt";
};

export type WhatsAppOwnership =
  | { readonly kind: "agent_active" }
  | {
      readonly kind: "human_owned";
      readonly ownerId: string;
      readonly startedAt: number;
      readonly reason: "operator_takeover" | "agent_handoff";
    };

type WhatsAppCaseRow = {
  readonly caseId: string;
  readonly customerWaId: string;
  readonly conversationWindowSequence: number;
  readonly ownership: WhatsAppOwnership;
  readonly messageCount: number;
  readonly byteCount: number;
  readonly latestCustomerAt: number;
  readonly serviceWindowExpiresAt: number;
  readonly debounceDueAt: number | null;
  readonly turnAttempts: number;
  readonly handoffRequestedAt: number | null;
  readonly handoffReason: string | null;
  readonly openedAt: number;
  readonly closedAt: number | null;
};

type WhatsAppEnvelopeEntry = {
  readonly sequence: number;
  readonly direction: "inbound" | "outbound";
  readonly providerMessageId: string;
  readonly nonceB64: string;
  readonly ciphertextB64: string;
  readonly bytes: number;
  readonly occurredAt: number;
};

export type { WhatsAppProposalState };

export type WhatsAppProposalRow = {
  readonly proposalId: string;
  readonly version: number;
  readonly caseId: string;
  readonly customerWaId: string;
  readonly author: "agent" | "human";
  readonly bodyDigest: string;
  readonly nonceB64: string | null;
  readonly ciphertextB64: string | null;
  readonly state: WhatsAppProposalState;
  /** The attempt that holds a `sending` version; null in every other state. */
  readonly sendAttemptId: string | null;
  readonly approvedBodyDigest: string | null;
  readonly sentMessageId: string | null;
  readonly policyVersion: number;
  readonly credentialGeneration: number;
  readonly serviceWindowExpiresAt: number;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export function createConnectorWhatsAppSchema(
  sql: SqlStorage,
  transaction: SchemaTransaction = (operation) => operation(),
): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_whatsapp_runtime (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    organisation_id TEXT NOT NULL,
    integration_account_id TEXT NOT NULL,
    policy_version INTEGER NOT NULL CHECK (policy_version > 0),
    limits_json TEXT NOT NULL,
    support_binding_id TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
    credential_generation INTEGER NOT NULL CHECK (credential_generation > 0),
    processing_json TEXT NOT NULL,
    activation_floor INTEGER NOT NULL,
    disabled_at INTEGER
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_whatsapp_message (
    provider_message_id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    customer_wa_id TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('admitted', 'skipped', 'deferred')),
    policy_version INTEGER NOT NULL,
    admitted_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_connector_whatsapp_message_admitted
    ON connector_whatsapp_message (disposition, admitted_at)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_whatsapp_case (
    case_id TEXT PRIMARY KEY,
    customer_wa_id TEXT NOT NULL,
    conversation_window_sequence INTEGER NOT NULL CHECK (conversation_window_sequence > 0),
    ownership_json TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    byte_count INTEGER NOT NULL DEFAULT 0,
    latest_customer_at INTEGER NOT NULL,
    service_window_expires_at INTEGER NOT NULL,
    debounce_due_at INTEGER,
    turn_attempts INTEGER NOT NULL DEFAULT 0,
    handoff_requested_at INTEGER,
    handoff_reason TEXT,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_connector_whatsapp_case_open
    ON connector_whatsapp_case (closed_at, debounce_due_at)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_whatsapp_envelope (
    case_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    provider_message_id TEXT NOT NULL,
    nonce_b64 TEXT NOT NULL,
    ciphertext_b64 TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK (bytes >= 0),
    occurred_at INTEGER NOT NULL,
    PRIMARY KEY (case_id, sequence)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_whatsapp_reservation (
    reservation_id TEXT PRIMARY KEY,
    utc_day TEXT NOT NULL,
    tokens INTEGER NOT NULL CHECK (tokens > 0),
    state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released')),
    settled_tokens INTEGER,
    created_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_connector_whatsapp_reservation_day
    ON connector_whatsapp_reservation (utc_day, state)`);
  createConnectorWhatsAppProposalSchema(sql, transaction);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_whatsapp_operator_notice (
    notice_key TEXT PRIMARY KEY,
    reason_json TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    raised_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    delivered_at INTEGER
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_whatsapp_status (
    whatsapp_message_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
    status_at INTEGER NOT NULL,
    failure_code TEXT,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (whatsapp_message_id, status)
  )`);
}

export function readWhatsAppRuntime(
  sql: SqlStorage,
): WhatsAppRuntimeSnapshot | null {
  const row =
    sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT organisation_id, integration_account_id, policy_version, limits_json,
            support_binding_id, binding_revision, credential_generation,
            processing_json, activation_floor, disabled_at
       FROM connector_whatsapp_runtime WHERE singleton = 1`,
      )
      .toArray()[0] ?? null;
  if (row === null) return null;
  const limits = parseLimits(row.limits_json);
  const processing = parseProcessing(row.processing_json);
  if (limits === null || processing === null) return null;
  return {
    organisationId: String(row.organisation_id),
    integrationAccountId: String(row.integration_account_id),
    policyVersion: Number(row.policy_version),
    limits,
    supportBindingId: String(row.support_binding_id),
    bindingRevision: Number(row.binding_revision),
    credentialGeneration: Number(row.credential_generation),
    processing,
    activationFloor: Number(row.activation_floor),
    disabledAt: row.disabled_at === null ? null : Number(row.disabled_at),
  };
}

/**
 * Enablement commits an activation floor. Only messages Meta stamped at or
 * after the floor are eligible, so enabling a number never pulls in chats
 * that happened before the owner turned it on.
 */
export function activateWhatsAppRuntime(
  sql: SqlStorage,
  input: Readonly<{
    organisationId: string;
    integrationAccountId: string;
    policyVersion: number;
    limits: WhatsAppIngressLimits;
    supportBindingId: string;
    bindingRevision: number;
    credentialGeneration: number;
    now: number;
  }>,
): Result<WhatsAppRuntimeSnapshot, WhatsAppRuntimeError> {
  const existing = readWhatsAppRuntime(sql);
  if (existing !== null && existing.disabledAt === null) {
    return updateWhatsAppRuntimePolicy(sql, input);
  }
  const activationFloor = existing?.activationFloor ?? input.now;
  sql.exec(
    `INSERT INTO connector_whatsapp_runtime (
       singleton, organisation_id, integration_account_id, policy_version, limits_json,
       support_binding_id, binding_revision, credential_generation,
       processing_json, activation_floor, disabled_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (singleton) DO UPDATE SET
       organisation_id = excluded.organisation_id,
       integration_account_id = excluded.integration_account_id,
       policy_version = excluded.policy_version,
       limits_json = excluded.limits_json,
       support_binding_id = excluded.support_binding_id,
       binding_revision = excluded.binding_revision,
       credential_generation = excluded.credential_generation,
       processing_json = excluded.processing_json,
       disabled_at = NULL`,
    input.organisationId,
    input.integrationAccountId,
    input.policyVersion,
    JSON.stringify(input.limits),
    input.supportBindingId,
    input.bindingRevision,
    input.credentialGeneration,
    JSON.stringify({ kind: "waiting" }),
    activationFloor,
  );
  const snapshot = readWhatsAppRuntime(sql);
  return snapshot === null
    ? { ok: false, error: { code: "connector_whatsapp_runtime_missing" } }
    : { ok: true, value: snapshot };
}

export function updateWhatsAppRuntimePolicy(
  sql: SqlStorage,
  input: Readonly<{
    policyVersion: number;
    limits: WhatsAppIngressLimits;
    supportBindingId: string;
    bindingRevision: number;
    credentialGeneration: number;
  }>,
): Result<WhatsAppRuntimeSnapshot, WhatsAppRuntimeError> {
  const existing = readWhatsAppRuntime(sql);
  if (existing === null) {
    return { ok: false, error: { code: "connector_whatsapp_runtime_missing" } };
  }
  sql.exec(
    `UPDATE connector_whatsapp_runtime
        SET policy_version = ?, limits_json = ?, support_binding_id = ?,
            binding_revision = ?, credential_generation = ?
      WHERE singleton = 1`,
    input.policyVersion,
    JSON.stringify(input.limits),
    input.supportBindingId,
    input.bindingRevision,
    input.credentialGeneration,
  );
  const snapshot = readWhatsAppRuntime(sql);
  return snapshot === null
    ? { ok: false, error: { code: "connector_whatsapp_runtime_missing" } }
    : { ok: true, value: snapshot };
}

/**
 * Disable, revoke, and organisation erasure all land here. Active content is
 * deleted in the same transaction as the state change, so a disabled number
 * never leaves a readable envelope or proposal body behind.
 */
export function disableWhatsAppRuntime(
  sql: SqlStorage,
  input: Readonly<{ now: number }>,
): Result<null, WhatsAppRuntimeError> {
  const existing = readWhatsAppRuntime(sql);
  if (existing === null) {
    return { ok: false, error: { code: "connector_whatsapp_runtime_missing" } };
  }
  sql.exec(
    `UPDATE connector_whatsapp_runtime
        SET disabled_at = ?, processing_json = ? WHERE singleton = 1`,
    input.now,
    JSON.stringify({ kind: "waiting" }),
  );
  purgeWhatsAppActiveContent(sql, input.now);
  return { ok: true, value: null };
}

/** Deletes every envelope entry and proposal body and closes open Cases. */
function purgeWhatsAppActiveContent(sql: SqlStorage, now: number): void {
  sql.exec("DELETE FROM connector_whatsapp_envelope");
  // A version that is being sent is revoked too: its attempt then finds the
  // row moved and records nothing, so no envelope comes back after the purge.
  for (const proposal of openWhatsAppProposals(sql, null))
    advanceWhatsAppProposal(sql, proposal, { event: "revoke" }, now);
  sql.exec(
    `UPDATE connector_whatsapp_proposal SET nonce_b64 = NULL, ciphertext_b64 = NULL
      WHERE nonce_b64 IS NOT NULL`,
  );
  sql.exec(
    `UPDATE connector_whatsapp_case
        SET closed_at = ?, debounce_due_at = NULL, message_count = 0, byte_count = 0,
            handoff_requested_at = NULL, handoff_reason = NULL
      WHERE closed_at IS NULL`,
    now,
  );
}

type WhatsAppPauseOutcome = {
  readonly kind: "paused" | "already_paused";
  /**
   * The receipt this pause is owed a notice for, or null when an identical
   * pause under the same published policy already produced one. Overflow
   * notifies once, not once per message.
   */
  readonly pendingNoticeKey: string | null;
};

export function pauseWhatsAppRuntime(
  sql: SqlStorage,
  input: Readonly<{
    reason: WhatsAppPauseReason;
    now: number;
  }>,
): WhatsAppPauseOutcome {
  const runtime = readWhatsAppRuntime(sql);
  if (runtime === null)
    return { kind: "already_paused", pendingNoticeKey: null };
  const alreadyPaused = runtime.processing.kind === "paused";
  if (!alreadyPaused) {
    sql.exec(
      "UPDATE connector_whatsapp_runtime SET processing_json = ? WHERE singleton = 1",
      JSON.stringify({
        kind: "paused",
        reason: input.reason,
        pausedAt: input.now,
        policyVersion: runtime.policyVersion,
      }),
    );
  }
  return {
    kind: alreadyPaused ? "already_paused" : "paused",
    pendingNoticeKey: recordWhatsAppOperatorNotice(sql, {
      reason: input.reason,
      policyVersion: runtime.policyVersion,
      now: input.now,
    }),
  };
}

/**
 * Records one notice-worthy event and returns its key, or null when the same
 * event under the same published policy has already been raised. Republishing
 * the policy is the operator saying they have seen the last one, so it opens a
 * fresh notice.
 *
 * Not every notice pauses the account: a proposal that outlived its service
 * window is worth telling an operator about without stopping the number.
 */
export function recordWhatsAppOperatorNotice(
  sql: SqlStorage,
  input: Readonly<{
    reason: WhatsAppPauseReason;
    policyVersion: number;
    now: number;
  }>,
): string | null {
  const noticeKey = whatsAppNoticeKey(input.policyVersion, input.reason);
  const existing =
    sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT delivered_at FROM connector_whatsapp_operator_notice WHERE notice_key = ?",
        noticeKey,
      )
      .toArray()[0] ?? null;
  if (existing !== null) {
    // Deduplication is about not telling an operator the same thing twice —
    // not about giving up after one failed attempt. A notice that was raised
    // but never delivered stays claimable, so a transient Slack failure or a
    // destination selected later still reaches someone.
    return existing.delivered_at === null ? noticeKey : null;
  }
  sql.exec(
    `INSERT INTO connector_whatsapp_operator_notice (
       notice_key, reason_json, policy_version, raised_at, next_attempt_at, delivered_at
     ) VALUES (?, ?, ?, ?, ?, NULL)`,
    noticeKey,
    JSON.stringify(input.reason),
    input.policyVersion,
    input.now,
    input.now,
  );
  return noticeKey;
}

/** One notice per published policy per reason, and per item where the reason names one. */
function whatsAppNoticeKey(
  policyVersion: number,
  reason: WhatsAppPauseReason,
): string {
  switch (reason.kind) {
    case "message_too_large":
    case "unsupported_message_type":
      return `notice_${policyVersion}_${reason.kind}_${reason.providerMessageId}`;
    case "service_window_expired":
      return `notice_${policyVersion}_${reason.kind}_${reason.caseId}`;
    case "send_indeterminate":
      return `notice_${policyVersion}_${reason.kind}_${reason.proposalId}`;
    case "active_case_limit":
    case "hourly_message_limit":
    case "daily_token_budget":
      return `notice_${policyVersion}_${reason.kind}`;
  }
}

export function markWhatsAppNoticeDelivered(
  sql: SqlStorage,
  noticeKey: string,
  now: number,
): void {
  sql.exec(
    "UPDATE connector_whatsapp_operator_notice SET delivered_at = ? WHERE notice_key = ?",
    now,
    noticeKey,
  );
}

export function readWhatsAppOperatorNotice(
  sql: SqlStorage,
  noticeKey: string,
): {
  readonly reason: WhatsAppPauseReason;
  readonly policyVersion: number;
  readonly deliveredAt: number | null;
} | null {
  const row =
    sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT reason_json, policy_version, delivered_at
       FROM connector_whatsapp_operator_notice WHERE notice_key = ?`,
        noticeKey,
      )
      .toArray()[0] ?? null;
  if (row === null) return null;
  const reason = parsePauseReason(safeJson(row.reason_json));
  return reason === null
    ? null
    : {
        reason,
        policyVersion: Number(row.policy_version),
        deliveredAt:
          row.delivered_at === null ? null : Number(row.delivered_at),
      };
}

export function resumeWhatsAppRuntime(
  sql: SqlStorage,
  input: Readonly<{
    policyVersion: number;
    limits: WhatsAppIngressLimits;
    supportBindingId: string;
    bindingRevision: number;
    credentialGeneration: number;
    skipProviderMessageId: string | null;
    now: number;
  }>,
): Result<WhatsAppRuntimeSnapshot, WhatsAppRuntimeError> {
  const runtime = readWhatsAppRuntime(sql);
  if (runtime === null || runtime.disabledAt !== null) {
    return { ok: false, error: { code: "connector_whatsapp_runtime_missing" } };
  }
  if (runtime.processing.kind !== "paused") {
    return { ok: false, error: { code: "connector_whatsapp_not_paused" } };
  }
  if (input.skipProviderMessageId !== null) {
    const admitted =
      sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT 1 AS present FROM connector_whatsapp_message
        WHERE provider_message_id = ? AND disposition = 'admitted'`,
          input.skipProviderMessageId,
        )
        .toArray().length > 0;
    if (!admitted) {
      return {
        ok: false,
        error: { code: "connector_whatsapp_skip_target_invalid" },
      };
    }
    sql.exec(
      `UPDATE connector_whatsapp_message SET disposition = 'skipped'
        WHERE provider_message_id = ? AND disposition = 'admitted'`,
      input.skipProviderMessageId,
    );
  }
  const updated = updateWhatsAppRuntimePolicy(sql, input);
  if (!updated.ok) return updated;
  const next = nextWhatsAppDebounceAt(sql);
  sql.exec(
    "UPDATE connector_whatsapp_runtime SET processing_json = ? WHERE singleton = 1",
    JSON.stringify(
      next === null ? { kind: "waiting" } : { kind: "scheduled", at: next },
    ),
  );
  const snapshot = readWhatsAppRuntime(sql);
  return snapshot === null
    ? { ok: false, error: { code: "connector_whatsapp_runtime_missing" } }
    : { ok: true, value: snapshot };
}

type WhatsAppAdmissionReservation =
  | {
      readonly kind: "ready";
      readonly caseId: string;
      readonly conversationWindowSequence: number;
      readonly serviceWindowExpiresAt: number;
      readonly debounceDueAt: number;
      readonly opened: boolean;
    }
  | {
      readonly kind: "duplicate";
      readonly caseId: string;
      readonly conversationWindowSequence: number;
      readonly serviceWindowExpiresAt: number;
    }
  | { readonly kind: "rejected"; readonly reason: WhatsAppPauseReason };

/**
 * First half of admission: dedupe, enforce the published limits, resolve or
 * open the support conversationWindow, and push the debounce forward. The Case row is
 * created here so the caller can seal the message body under the exact Case
 * the commit will use, and so a concurrent message for the same customer
 * joins that conversationWindow instead of racing a second one into existence.
 */
export function beginWhatsAppAdmission(
  sql: SqlStorage,
  input: Readonly<{
    providerMessageId: string;
    customerWaId: string;
    providerTimestamp: number;
    declaredBytes: number;
    limits: WhatsAppIngressLimits;
    caseIdFor: (conversationWindowSequence: number) => string;
    now: number;
  }>,
): WhatsAppAdmissionReservation {
  const existing =
    sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT case_id FROM connector_whatsapp_message WHERE provider_message_id = ?",
        input.providerMessageId,
      )
      .toArray()[0] ?? null;
  if (existing !== null) {
    const duplicateCaseId = String(existing.case_id);
    const known = readWhatsAppCase(sql, duplicateCaseId);
    return {
      kind: "duplicate",
      caseId: duplicateCaseId,
      conversationWindowSequence: known?.conversationWindowSequence ?? 1,
      serviceWindowExpiresAt:
        known?.serviceWindowExpiresAt ??
        input.providerTimestamp + WHATSAPP_SERVICE_WINDOW_MS,
    };
  }
  if (input.declaredBytes > input.limits.maxMessageBytes) {
    return {
      kind: "rejected",
      reason: {
        kind: "message_too_large",
        providerMessageId: input.providerMessageId,
        observedBytes: input.declaredBytes,
        limitBytes: input.limits.maxMessageBytes,
      },
    };
  }
  const admittedLastHour = countWhatsAppAdmissionsSince(
    sql,
    input.now - 3_600_000,
  );
  if (admittedLastHour >= input.limits.maxMessagesPerHour) {
    return {
      kind: "rejected",
      reason: {
        kind: "hourly_message_limit",
        observed: admittedLastHour,
        limit: input.limits.maxMessagesPerHour,
        windowEndsAt: input.now + 3_600_000,
      },
    };
  }
  const open = readOpenWhatsAppCaseForCustomer(
    sql,
    input.customerWaId,
    input.now,
  );
  if (open === null) {
    const activeCases = countOpenWhatsAppCases(sql, input.now);
    if (activeCases >= input.limits.maxActiveCases) {
      return {
        kind: "rejected",
        reason: {
          kind: "active_case_limit",
          observed: activeCases,
          limit: input.limits.maxActiveCases,
        },
      };
    }
  }
  const conversationWindowSequence =
    open?.conversationWindowSequence ??
    nextWhatsAppConversationWindowSequence(sql, input.customerWaId);
  const caseId = open?.caseId ?? input.caseIdFor(conversationWindowSequence);
  const serviceWindowExpiresAt =
    input.providerTimestamp + WHATSAPP_SERVICE_WINDOW_MS;
  const debounceDueAt = input.now + input.limits.debounceSeconds * 1000;
  if (open === null) {
    sql.exec(
      `INSERT INTO connector_whatsapp_case (
         case_id, customer_wa_id, conversation_window_sequence, ownership_json, message_count,
         byte_count, latest_customer_at, service_window_expires_at, debounce_due_at,
         turn_attempts, handoff_requested_at, handoff_reason, opened_at, closed_at
       ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, 0, NULL, NULL, ?, NULL)`,
      caseId,
      input.customerWaId,
      conversationWindowSequence,
      JSON.stringify({ kind: "agent_active" }),
      input.providerTimestamp,
      serviceWindowExpiresAt,
      debounceDueAt,
      input.now,
    );
  } else {
    sql.exec(
      `UPDATE connector_whatsapp_case
          SET latest_customer_at = ?, service_window_expires_at = ?, debounce_due_at = ?,
              turn_attempts = 0
        WHERE case_id = ?`,
      Math.max(open.latestCustomerAt, input.providerTimestamp),
      Math.max(open.serviceWindowExpiresAt, serviceWindowExpiresAt),
      debounceDueAt,
      caseId,
    );
  }
  scheduleWhatsAppProcessing(sql, debounceDueAt);
  return {
    kind: "ready",
    caseId,
    conversationWindowSequence,
    serviceWindowExpiresAt:
      open === null
        ? serviceWindowExpiresAt
        : Math.max(open.serviceWindowExpiresAt, serviceWindowExpiresAt),
    debounceDueAt,
    opened: open === null,
  };
}

type WhatsAppAdmissionCommit =
  | { readonly kind: "committed"; readonly sequence: number }
  | { readonly kind: "duplicate" }
  | { readonly kind: "case_closed" };

/**
 * Second half of admission: store the sealed body in the active envelope and
 * record the provider message id. Both are idempotent, so a Meta retry that
 * lands after the reservation still converges on one envelope entry.
 *
 * Sealing the body is an await, and the Actor yields there. An operator can
 * close the Case in that gap. Committing anyway would append content to a Case
 * whose close already deleted its envelope, leaving text nothing will ever
 * delete again — so the reservation is rechecked here and the message is left
 * for Meta to redeliver into a fresh Case.
 */
export function commitWhatsAppAdmission(
  sql: SqlStorage,
  input: Readonly<{
    caseId: string;
    providerMessageId: string;
    customerWaId: string;
    providerTimestamp: number;
    nonceB64: string;
    ciphertextB64: string;
    bytes: number;
    limits: WhatsAppIngressLimits;
    policyVersion: number;
    now: number;
  }>,
): WhatsAppAdmissionCommit {
  if (whatsAppMessageExists(sql, input.providerMessageId))
    return { kind: "duplicate" };
  if (!whatsAppCaseIsOpen(sql, input.caseId)) return { kind: "case_closed" };
  sql.exec(
    `INSERT INTO connector_whatsapp_message (
       provider_message_id, case_id, customer_wa_id, disposition, policy_version, admitted_at
     ) VALUES (?, ?, ?, 'admitted', ?, ?)`,
    input.providerMessageId,
    input.caseId,
    input.customerWaId,
    input.policyVersion,
    input.now,
  );
  const sequence = appendWhatsAppEnvelopeEntry(sql, {
    caseId: input.caseId,
    direction: "inbound",
    providerMessageId: input.providerMessageId,
    nonceB64: input.nonceB64,
    ciphertextB64: input.ciphertextB64,
    bytes: input.bytes,
    occurredAt: input.providerTimestamp,
    limits: input.limits,
  });
  return { kind: "committed", sequence };
}

/**
 * Records a message the published limits refused, content-free, so it is not
 * lost. Meta has already been told the delivery succeeded and there is no
 * inbox to refetch from, so the only alternative to recording it is losing it.
 */
export function deferWhatsAppMessage(
  sql: SqlStorage,
  input: Readonly<{
    providerMessageId: string;
    customerWaId: string;
    policyVersion: number;
    now: number;
  }>,
): { readonly kind: "deferred" | "duplicate" } {
  if (whatsAppMessageExists(sql, input.providerMessageId))
    return { kind: "duplicate" };
  sql.exec(
    `INSERT INTO connector_whatsapp_message (
       provider_message_id, case_id, customer_wa_id, disposition, policy_version, admitted_at
     ) VALUES (?, '', ?, 'deferred', ?, ?)`,
    input.providerMessageId,
    input.customerWaId,
    input.policyVersion,
    input.now,
  );
  return { kind: "deferred" };
}

/** Records a non-text message content-free so an operator can see it exists. */
export function recordWhatsAppUnsupportedMessage(
  sql: SqlStorage,
  input: Readonly<{
    providerMessageId: string;
    customerWaId: string;
    policyVersion: number;
    now: number;
  }>,
): { readonly kind: "recorded" | "duplicate" } {
  if (whatsAppMessageExists(sql, input.providerMessageId))
    return { kind: "duplicate" };
  sql.exec(
    `INSERT INTO connector_whatsapp_message (
       provider_message_id, case_id, customer_wa_id, disposition, policy_version, admitted_at
     ) VALUES (?, '', ?, 'skipped', ?, ?)`,
    input.providerMessageId,
    input.customerWaId,
    input.policyVersion,
    input.now,
  );
  return { kind: "recorded" };
}

function whatsAppMessageExists(
  sql: SqlStorage,
  providerMessageId: string,
): boolean {
  return (
    sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT 1 AS present FROM connector_whatsapp_message WHERE provider_message_id = ?",
        providerMessageId,
      )
      .toArray().length > 0
  );
}

function whatsAppCaseIsOpen(sql: SqlStorage, caseId: string): boolean {
  return (
    sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT 1 AS present FROM connector_whatsapp_case WHERE case_id = ? AND closed_at IS NULL",
        caseId,
      )
      .toArray().length > 0
  );
}

export function appendWhatsAppEnvelopeEntry(
  sql: SqlStorage,
  input: Readonly<{
    caseId: string;
    direction: "inbound" | "outbound";
    providerMessageId: string;
    nonceB64: string;
    ciphertextB64: string;
    bytes: number;
    occurredAt: number;
    limits: WhatsAppIngressLimits;
  }>,
): number {
  const highest =
    sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT MAX(sequence) AS sequence FROM connector_whatsapp_envelope WHERE case_id = ?",
        input.caseId,
      )
      .toArray()[0] ?? null;
  const sequence = Number(highest?.sequence ?? 0) + 1;
  sql.exec(
    `INSERT INTO connector_whatsapp_envelope (
       case_id, sequence, direction, provider_message_id, nonce_b64, ciphertext_b64,
       bytes, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.caseId,
    sequence,
    input.direction,
    input.providerMessageId,
    input.nonceB64,
    input.ciphertextB64,
    input.bytes,
    input.occurredAt,
  );
  trimWhatsAppEnvelope(sql, input.caseId, input.limits, input.occurredAt);
  return sequence;
}

/**
 * Enforces the published envelope bounds and the 24-hour maximum by deleting
 * the oldest entries. Trimming is destructive on purpose: Pantry keeps only
 * what the open Case needs, and WhatsApp remains the durable message system.
 */
function trimWhatsAppEnvelope(
  sql: SqlStorage,
  caseId: string,
  limits: WhatsAppIngressLimits,
  now: number,
): void {
  sql.exec(
    "DELETE FROM connector_whatsapp_envelope WHERE case_id = ? AND occurred_at < ?",
    caseId,
    now - WHATSAPP_SERVICE_WINDOW_MS,
  );
  sql.exec(
    `DELETE FROM connector_whatsapp_envelope
      WHERE case_id = ? AND sequence NOT IN (
        SELECT sequence FROM connector_whatsapp_envelope
         WHERE case_id = ? ORDER BY sequence DESC LIMIT ?)`,
    caseId,
    caseId,
    limits.maxActiveCaseMessages,
  );
  let total = 0;
  const rows = sql
    .exec<Record<string, SqlStorageValue>>(
      "SELECT sequence, bytes FROM connector_whatsapp_envelope WHERE case_id = ? ORDER BY sequence DESC",
      caseId,
    )
    .toArray();
  const keep: number[] = [];
  for (const row of rows) {
    const bytes = Number(row.bytes);
    if (total + bytes > limits.maxActiveCaseBytes && keep.length > 0) break;
    total += bytes;
    keep.push(Number(row.sequence));
  }
  const lowest = keep.at(-1) ?? 0;
  sql.exec(
    "DELETE FROM connector_whatsapp_envelope WHERE case_id = ? AND sequence < ?",
    caseId,
    lowest,
  );
  sql.exec(
    `UPDATE connector_whatsapp_case
        SET message_count = (SELECT COUNT(*) FROM connector_whatsapp_envelope WHERE case_id = ?),
            byte_count = (SELECT COALESCE(SUM(bytes), 0) FROM connector_whatsapp_envelope WHERE case_id = ?)
      WHERE case_id = ?`,
    caseId,
    caseId,
    caseId,
  );
}

function decodeWhatsAppEnvelopeDirection(
  value: unknown,
): WhatsAppEnvelopeEntry["direction"] | null {
  if (value === "inbound" || value === "outbound") return value;
  return null;
}

function decodeWhatsAppEnvelopeEntry(
  row: Record<string, SqlStorageValue>,
): WhatsAppEnvelopeEntry | null {
  const direction = decodeWhatsAppEnvelopeDirection(row.direction);
  const sequence = row.sequence;
  const providerMessageId = row.provider_message_id;
  const nonceB64 = row.nonce_b64;
  const ciphertextB64 = row.ciphertext_b64;
  const bytes = row.bytes;
  const occurredAt = row.occurred_at;
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence <= 0 ||
    direction === null ||
    typeof providerMessageId !== "string" ||
    providerMessageId.trim().length === 0 ||
    typeof nonceB64 !== "string" ||
    nonceB64.length === 0 ||
    typeof ciphertextB64 !== "string" ||
    ciphertextB64.length === 0 ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    typeof occurredAt !== "number" ||
    !Number.isSafeInteger(occurredAt) ||
    occurredAt < 0
  ) {
    return null;
  }
  return {
    sequence,
    direction,
    providerMessageId,
    nonceB64,
    ciphertextB64,
    bytes,
    occurredAt,
  };
}

export function readWhatsAppEnvelope(
  sql: SqlStorage,
  caseId: string,
): Result<readonly WhatsAppEnvelopeEntry[], WhatsAppEnvelopeReadError> {
  const rows = sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT sequence, direction, provider_message_id, nonce_b64, ciphertext_b64, bytes, occurred_at
       FROM connector_whatsapp_envelope WHERE case_id = ? ORDER BY sequence`,
      caseId,
    )
    .toArray();
  const entries: WhatsAppEnvelopeEntry[] = [];
  for (const row of rows) {
    const entry = decodeWhatsAppEnvelopeEntry(row);
    if (entry === null) {
      return {
        ok: false,
        error: { code: "connector_whatsapp_storage_corrupt" },
      };
    }
    entries.push(entry);
  }
  return { ok: true, value: entries };
}

function deleteWhatsAppEnvelope(sql: SqlStorage, caseId: string): void {
  sql.exec("DELETE FROM connector_whatsapp_envelope WHERE case_id = ?", caseId);
  sql.exec(
    "UPDATE connector_whatsapp_case SET message_count = 0, byte_count = 0 WHERE case_id = ?",
    caseId,
  );
}

export function closeWhatsAppCase(
  sql: SqlStorage,
  caseId: string,
  now: number,
): void {
  sql.exec(
    `UPDATE connector_whatsapp_case
        SET closed_at = ?, debounce_due_at = NULL,
            handoff_requested_at = NULL, handoff_reason = NULL
      WHERE case_id = ? AND closed_at IS NULL`,
    now,
    caseId,
  );
  deleteWhatsAppEnvelope(sql, caseId);
}

export function readWhatsAppCase(
  sql: SqlStorage,
  caseId: string,
): WhatsAppCaseRow | null {
  const row =
    sql
      .exec<Record<string, SqlStorageValue>>(
        `${CASE_SELECT} WHERE case_id = ?`,
        caseId,
      )
      .toArray()[0] ?? null;
  return row === null ? null : parseCaseRow(row);
}

function readOpenWhatsAppCaseForCustomer(
  sql: SqlStorage,
  customerWaId: string,
  now: number,
): WhatsAppCaseRow | null {
  const row =
    sql
      .exec<Record<string, SqlStorageValue>>(
        `${CASE_SELECT}
      WHERE customer_wa_id = ? AND closed_at IS NULL AND service_window_expires_at > ?
      ORDER BY conversation_window_sequence DESC LIMIT 1`,
        customerWaId,
        now,
      )
      .toArray()[0] ?? null;
  return row === null ? null : parseCaseRow(row);
}

/**
 * The agent asked for a human. Agent work stops for this Case until an
 * operator either takes it over or returns it, so the request is a Case fact
 * rather than a fake human owner.
 */
export function requestWhatsAppHandoff(
  sql: SqlStorage,
  caseId: string,
  reason: string,
  now: number,
): { readonly kind: "requested" | "missing" } {
  if (!whatsAppCaseIsOpen(sql, caseId)) return { kind: "missing" };
  sql.exec(
    `UPDATE connector_whatsapp_case
        SET handoff_requested_at = ?, handoff_reason = ?, debounce_due_at = NULL
      WHERE case_id = ? AND closed_at IS NULL`,
    now,
    reason,
    caseId,
  );
  return { kind: "requested" };
}

/**
 * The handoff reason is model output derived from customer text, so it is
 * active content: it is cleared with the rest of the Case rather than left in
 * storage after close, disable, or revoke.
 */
export function clearWhatsAppHandoff(sql: SqlStorage, caseId: string): void {
  sql.exec(
    `UPDATE connector_whatsapp_case SET handoff_requested_at = NULL, handoff_reason = NULL
      WHERE case_id = ?`,
    caseId,
  );
}

export function setWhatsAppCaseOwnership(
  sql: SqlStorage,
  caseId: string,
  ownership: WhatsAppOwnership,
): { readonly kind: "updated" | "missing" } {
  if (!whatsAppCaseIsOpen(sql, caseId)) return { kind: "missing" };
  sql.exec(
    "UPDATE connector_whatsapp_case SET ownership_json = ? WHERE case_id = ? AND closed_at IS NULL",
    JSON.stringify(ownership),
    caseId,
  );
  return { kind: "updated" };
}

export function scheduleWhatsAppCaseForAgent(
  sql: SqlStorage,
  caseId: string,
  now: number,
): { readonly kind: "scheduled" | "missing" } {
  if (!whatsAppCaseIsOpen(sql, caseId)) return { kind: "missing" };
  sql.exec(
    `UPDATE connector_whatsapp_case
        SET debounce_due_at = ?, turn_attempts = 0
      WHERE case_id = ? AND closed_at IS NULL`,
    now,
    caseId,
  );
  scheduleWhatsAppProcessing(sql, now);
  return { kind: "scheduled" };
}

export function countOpenWhatsAppCases(sql: SqlStorage, now: number): number {
  const row =
    sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT COUNT(*) AS openCount FROM connector_whatsapp_case
      WHERE closed_at IS NULL AND service_window_expires_at > ?`,
        now,
      )
      .toArray()[0] ?? null;
  return Number(row?.openCount ?? 0);
}

export function countWhatsAppAdmissionsSince(
  sql: SqlStorage,
  since: number,
): number {
  const row =
    sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT COUNT(*) AS admitted FROM connector_whatsapp_message
      WHERE disposition = 'admitted' AND admitted_at >= ?`,
        since,
      )
      .toArray()[0] ?? null;
  return Number(row?.admitted ?? 0);
}

function nextWhatsAppConversationWindowSequence(
  sql: SqlStorage,
  customerWaId: string,
): number {
  const row =
    sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT MAX(conversation_window_sequence) AS sequence FROM connector_whatsapp_case WHERE customer_wa_id = ?",
        customerWaId,
      )
      .toArray()[0] ?? null;
  return Number(row?.sequence ?? 0) + 1;
}

const WHATSAPP_PROCESSING_LEASE_MS = 4 * 60_000;

/**
 * Every future instant this Connector must wake for, not just the next
 * debounce. Content is bounded by time as well as by count and bytes, so an
 * account that goes quiet still has to wake to expire proposals, close Cases
 * whose service window has passed, and delete their envelopes — otherwise the
 * 24-hour bound is only enforced by the next customer message, which may never
 * come.
 */
/** Creates the tables of WhatsApp, each change in its own transaction. */
export function createWhatsAppChannelSchema(
  storage: DurableObjectStorage,
): void {
  createConnectorWhatsAppSchema(
    storage.sql,
    storage.transactionSync.bind(storage),
  );
}

/** The due time of the WhatsApp sweep: debounces, windows and notices. */
export function whatsAppAlarmDue(sql: SqlStorage): readonly AlarmReconciler[] {
  return [{ name: "whatsapp_sweep", nextDue: () => nextWhatsAppSweepAt(sql) }];
}

export function nextWhatsAppSweepAt(sql: SqlStorage): number | null {
  const runtime = readWhatsAppRuntime(sql);
  if (runtime === null || runtime.disabledAt !== null) return null;
  const candidates: number[] = [];
  const debounce = nextWhatsAppDebounceAt(sql);
  if (debounce !== null) candidates.push(debounce);
  const notice =
    sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT MIN(next_attempt_at) AS due FROM connector_whatsapp_operator_notice
      WHERE delivered_at IS NULL`,
      )
      .toArray()[0]?.due ?? null;
  if (notice !== null) candidates.push(Number(notice));
  const proposal =
    sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT MIN(MIN(expires_at, service_window_expires_at)) AS due
       FROM connector_whatsapp_proposal
      WHERE state = 'awaiting_approval'`,
      )
      .toArray()[0]?.due ?? null;
  if (proposal !== null) candidates.push(Number(proposal));
  const attempt =
    sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT MIN(updated_at) AS claimed_at FROM connector_whatsapp_proposal
      WHERE state = 'sending'`,
      )
      .toArray()[0]?.claimed_at ?? null;
  if (attempt !== null)
    candidates.push(Number(attempt) + WHATSAPP_SEND_ATTEMPT_LEASE_MS);
  const supportCase =
    sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT MIN(service_window_expires_at) AS due FROM connector_whatsapp_case
      WHERE closed_at IS NULL`,
      )
      .toArray()[0]?.due ?? null;
  if (supportCase !== null) candidates.push(Number(supportCase));
  if (runtime.processing.kind === "processing") {
    candidates.push(
      runtime.processing.startedAt + WHATSAPP_PROCESSING_LEASE_MS,
    );
  }
  return candidates.length === 0 ? null : Math.min(...candidates);
}

type WhatsAppSweep = {
  readonly closedCaseIds: readonly string[];
  readonly recoveredProcessing: boolean;
};

/**
 * Time-driven cleanup. Closes every Case whose service window has passed —
 * deleting its envelope with it — and releases a processing claim whose turn
 * never reported back, so a crash mid-turn cannot strand the number.
 */
export function sweepWhatsAppDeadlines(
  sql: SqlStorage,
  now: number,
): WhatsAppSweep {
  const runtime = readWhatsAppRuntime(sql);
  if (runtime === null || runtime.disabledAt !== null) {
    return { closedCaseIds: [], recoveredProcessing: false };
  }
  const expired = sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT case_id FROM connector_whatsapp_case
      WHERE closed_at IS NULL AND service_window_expires_at <= ?`,
      now,
    )
    .toArray()
    .map((row) => String(row.case_id));
  for (const caseId of expired) {
    invalidateOpenWhatsAppProposalsForCase(sql, caseId, now);
    closeWhatsAppCase(sql, caseId, now);
  }
  let recoveredProcessing = false;
  if (
    runtime.processing.kind === "processing" &&
    now >= runtime.processing.startedAt + WHATSAPP_PROCESSING_LEASE_MS
  ) {
    // The turn that held this claim never reported back. Re-arm the Case so
    // the next sweep runs it rather than leaving the number stuck.
    sql.exec(
      "UPDATE connector_whatsapp_case SET debounce_due_at = ? WHERE case_id = ? AND closed_at IS NULL",
      now,
      runtime.processing.caseId,
    );
    sql.exec(
      "UPDATE connector_whatsapp_runtime SET processing_json = ? WHERE singleton = 1",
      JSON.stringify({ kind: "scheduled", at: now }),
    );
    recoveredProcessing = true;
  }
  return { closedCaseIds: expired, recoveredProcessing };
}

function invalidateOpenWhatsAppProposalsForCase(
  sql: SqlStorage,
  caseId: string,
  now: number,
): void {
  // A version that is being sent stays with its attempt; the attempt's lease
  // ends it, as `send_indeterminate`, if the attempt never reports.
  for (const proposal of openWhatsAppProposals(sql, caseId))
    if (proposal.state === "awaiting_approval")
      advanceWhatsAppProposal(sql, proposal, { event: "expire" }, now);
}

export function nextWhatsAppDebounceAt(sql: SqlStorage): number | null {
  const row =
    sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT MIN(debounce_due_at) AS due FROM connector_whatsapp_case
      WHERE closed_at IS NULL AND debounce_due_at IS NOT NULL`,
      )
      .toArray()[0] ?? null;
  const due = row?.due ?? null;
  return due === null ? null : Number(due);
}

type WhatsAppDebounceClaim =
  | {
      readonly kind: "due";
      readonly caseId: string;
      readonly customerWaId: string;
    }
  | { readonly kind: "idle" };

/**
 * Claims one quiet, due Case for an agent turn. A burst of quick messages
 * keeps pushing the debounce forward, so a customer typing three lines gets
 * one turn after the quiet period, not three.
 */
export function claimDueWhatsAppCase(
  sql: SqlStorage,
  now: number,
): WhatsAppDebounceClaim {
  const runtime = readWhatsAppRuntime(sql);
  if (runtime === null || runtime.disabledAt !== null) return { kind: "idle" };
  if (
    runtime.processing.kind === "paused" ||
    runtime.processing.kind === "processing"
  ) {
    return { kind: "idle" };
  }
  const row =
    sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT case_id, customer_wa_id FROM connector_whatsapp_case
      WHERE closed_at IS NULL AND debounce_due_at IS NOT NULL AND debounce_due_at <= ?
        AND handoff_requested_at IS NULL
        AND json_extract(ownership_json, '$.kind') = 'agent_active'
      ORDER BY debounce_due_at LIMIT 1`,
        now,
      )
      .toArray()[0] ?? null;
  if (row === null) return { kind: "idle" };
  const caseId = String(row.case_id);
  sql.exec(
    "UPDATE connector_whatsapp_case SET debounce_due_at = NULL WHERE case_id = ?",
    caseId,
  );
  sql.exec(
    "UPDATE connector_whatsapp_runtime SET processing_json = ? WHERE singleton = 1",
    JSON.stringify({ kind: "processing", caseId, startedAt: now }),
  );
  return { kind: "due", caseId, customerWaId: String(row.customer_wa_id) };
}

/**
 * Releases the processing claim after a turn. A pause raised *during* that
 * turn — an exhausted budget, or the send-indeterminate fence — outranks the
 * release: clearing it here would silently un-pause an account an operator
 * has just been told about, and leave their Resume button reporting that
 * nothing is paused.
 */
export const WHATSAPP_MAX_TURN_ATTEMPTS = 3;

type WhatsAppRearm =
  | {
      readonly kind: "rearmed";
      readonly attempts: number;
      readonly dueAt: number;
    }
  | { readonly kind: "exhausted"; readonly attempts: number }
  | { readonly kind: "unavailable" };

/**
 * Puts a claimed Case back on the clock after a turn that produced no outcome.
 * Claiming clears `debounce_due_at`, and only a new inbound customer message
 * ever sets it again — so without this a transient failure (an unavailable
 * model route, a busy Case, a Worker restart) leaves an admitted message with
 * no proposal and nothing anywhere to surface it.
 *
 * Bounded: a Case that keeps failing stops retrying and becomes an operator
 * notice instead of an endless loop.
 */
export function rearmWhatsAppDebounce(
  sql: SqlStorage,
  input: Readonly<{
    caseId: string;
    retryAt: number;
  }>,
): WhatsAppRearm {
  const supportCase = readWhatsAppCase(sql, input.caseId);
  if (
    supportCase === null ||
    supportCase.closedAt !== null ||
    supportCase.handoffRequestedAt !== null ||
    supportCase.ownership.kind !== "agent_active"
  ) {
    return { kind: "unavailable" };
  }
  const attempts = supportCase.turnAttempts + 1;
  if (attempts >= WHATSAPP_MAX_TURN_ATTEMPTS) {
    sql.exec(
      "UPDATE connector_whatsapp_case SET turn_attempts = ?, debounce_due_at = NULL WHERE case_id = ?",
      attempts,
      input.caseId,
    );
    return { kind: "exhausted", attempts };
  }
  sql.exec(
    "UPDATE connector_whatsapp_case SET turn_attempts = ?, debounce_due_at = ? WHERE case_id = ?",
    attempts,
    input.retryAt,
    input.caseId,
  );
  return { kind: "rearmed", attempts, dueAt: input.retryAt };
}

/** A turn that produced an outcome clears the retry counter. */
export function settleWhatsAppTurn(sql: SqlStorage, caseId: string): void {
  sql.exec(
    "UPDATE connector_whatsapp_case SET turn_attempts = 0 WHERE case_id = ?",
    caseId,
  );
}

/** Notices raised but never delivered, oldest first. */
/** First retry a minute out, doubling to an hourly floor for a destination nobody has configured. */
const WHATSAPP_NOTICE_RETRY_BASE_MS = 60_000;
const WHATSAPP_NOTICE_RETRY_CEILING_MS = 3_600_000;

export function undeliveredWhatsAppNoticeKeys(
  sql: SqlStorage,
  now: number,
): readonly string[] {
  return sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT notice_key FROM connector_whatsapp_operator_notice
      WHERE delivered_at IS NULL AND next_attempt_at <= ?
      ORDER BY raised_at LIMIT 8`,
      now,
    )
    .toArray()
    .map((row) => String(row.notice_key));
}

/**
 * Backs a notice off after a delivery attempt that did not land. The notice
 * stays undelivered and keeps its place in the queue — a destination
 * configured later still receives it.
 */
export function deferWhatsAppNotice(
  sql: SqlStorage,
  noticeKey: string,
  now: number,
): void {
  const attempts =
    Number(
      sql
        .exec<Record<string, SqlStorageValue>>(
          "SELECT attempts FROM connector_whatsapp_operator_notice WHERE notice_key = ?",
          noticeKey,
        )
        .toArray()[0]?.attempts ?? 0,
    ) + 1;
  const delay = backoffDelay(
    attempts - 1,
    WHATSAPP_NOTICE_RETRY_BASE_MS,
    WHATSAPP_NOTICE_RETRY_CEILING_MS,
  );
  sql.exec(
    `UPDATE connector_whatsapp_operator_notice
        SET attempts = ?, next_attempt_at = ?
      WHERE notice_key = ? AND delivered_at IS NULL`,
    attempts,
    now + delay,
    noticeKey,
  );
}

export function completeWhatsAppProcessing(sql: SqlStorage): void {
  const runtime = readWhatsAppRuntime(sql);
  if (runtime === null || runtime.processing.kind === "paused") return;
  const next = nextWhatsAppDebounceAt(sql);
  sql.exec(
    "UPDATE connector_whatsapp_runtime SET processing_json = ? WHERE singleton = 1",
    JSON.stringify(
      next === null ? { kind: "waiting" } : { kind: "scheduled", at: next },
    ),
  );
}

function scheduleWhatsAppProcessing(sql: SqlStorage, at: number): void {
  const runtime = readWhatsAppRuntime(sql);
  if (runtime === null) return;
  if (
    runtime.processing.kind === "paused" ||
    runtime.processing.kind === "processing"
  )
    return;
  const next = nextWhatsAppDebounceAt(sql) ?? at;
  sql.exec(
    "UPDATE connector_whatsapp_runtime SET processing_json = ? WHERE singleton = 1",
    JSON.stringify({ kind: "scheduled", at: next }),
  );
}

export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function utcDayEndsAt(now: number): number {
  return Date.parse(`${utcDayKey(now)}T23:59:59.999Z`) + 1;
}

export function whatsAppTokenWindowTotals(
  sql: SqlStorage,
  utcDay: string,
): { readonly reserved: number; readonly consumed: number } {
  const rows = sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT state, SUM(tokens) AS tokens, SUM(COALESCE(settled_tokens, 0)) AS settled
       FROM connector_whatsapp_reservation WHERE utc_day = ? GROUP BY state`,
      utcDay,
    )
    .toArray();
  let reserved = 0;
  let consumed = 0;
  for (const row of rows) {
    if (row.state === "reserved") reserved += Number(row.tokens ?? 0);
    if (row.state === "settled") consumed += Number(row.settled ?? 0);
  }
  return { reserved, consumed };
}

export function reserveWhatsAppTokens(
  sql: SqlStorage,
  input: Readonly<{
    reservationId: string;
    utcDay: string;
    tokens: number;
    limit: number;
    now: number;
  }>,
): { readonly kind: "reserved" | "duplicate" | "exhausted" } {
  const existing =
    sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT state FROM connector_whatsapp_reservation WHERE reservation_id = ?",
        input.reservationId,
      )
      .toArray()[0] ?? null;
  if (existing !== null) return { kind: "duplicate" };
  const totals = whatsAppTokenWindowTotals(sql, input.utcDay);
  if (totals.reserved + totals.consumed + input.tokens > input.limit) {
    return { kind: "exhausted" };
  }
  sql.exec(
    `INSERT INTO connector_whatsapp_reservation (
       reservation_id, utc_day, tokens, state, settled_tokens, created_at
     ) VALUES (?, ?, ?, 'reserved', NULL, ?)`,
    input.reservationId,
    input.utcDay,
    input.tokens,
    input.now,
  );
  return { kind: "reserved" };
}

export function settleWhatsAppReservation(
  sql: SqlStorage,
  input: Readonly<{
    reservationId: string;
    actualTokens: number;
  }>,
): void {
  sql.exec(
    `UPDATE connector_whatsapp_reservation
        SET state = 'settled', settled_tokens = ?
      WHERE reservation_id = ? AND state = 'reserved'`,
    Math.max(0, input.actualTokens),
    input.reservationId,
  );
}

export function releaseWhatsAppReservation(
  sql: SqlStorage,
  reservationId: string,
): void {
  sql.exec(
    `UPDATE connector_whatsapp_reservation SET state = 'released'
      WHERE reservation_id = ? AND state = 'reserved'`,
    reservationId,
  );
}

/** Stores a new version that waits for approval; see `insertWhatsAppProposal`. */
export function recordWhatsAppProposal(
  sql: SqlStorage,
  input: Parameters<typeof insertWhatsAppProposal>[1],
): void {
  insertWhatsAppProposal(sql, input);
}

export function latestWhatsAppProposal(
  sql: SqlStorage,
  proposalId: string,
): WhatsAppProposalRow | null {
  const row =
    sql
      .exec<Record<string, SqlStorageValue>>(
        `${PROPOSAL_SELECT} WHERE proposal_id = ? ORDER BY version DESC LIMIT 1`,
        proposalId,
      )
      .toArray()[0] ?? null;
  return row === null ? null : parseProposalRow(row);
}

/**
 * The versions that wait for approval or are being sent, of one Case, or of
 * every Case when `caseId` is null. The newest version comes first.
 */
export function openWhatsAppProposals(
  sql: SqlStorage,
  caseId: string | null,
): readonly WhatsAppProposalRow[] {
  return sql
    .exec<Record<string, SqlStorageValue>>(
      `${PROPOSAL_SELECT}
      WHERE (? IS NULL OR case_id = ?) AND state IN ('awaiting_approval', 'sending')
      ORDER BY version DESC`,
      caseId,
      caseId,
    )
    .toArray()
    .map(parseProposalRow)
    .filter(isPresentProposal);
}

type WhatsAppExpiry = {
  readonly proposalId: string;
  readonly caseId: string;
  readonly noticeKey: string | null;
};

type WhatsAppSendClaim =
  | { readonly kind: "claimed"; readonly proposal: WhatsAppProposalRow }
  | { readonly kind: "already_sent"; readonly whatsappMessageId: string }
  | { readonly kind: "unavailable"; readonly state: WhatsAppProposalState };

/**
 * The serialization point for sending. A Durable Object is single-threaded but
 * yields at every `await`, so two approvals that both read a proposal as
 * `awaiting_approval` can both reach the provider call. This claim contains no
 * `await`: whichever approval runs it first stores the proposal as `sending`
 * with its own attempt id, and the other one finds it already taken, so the
 * customer cannot receive the same reply twice. The stored attempt outlives
 * the Actor instance: after a restart, the alarm ends an attempt that never
 * reported as `send_indeterminate`.
 */
export function claimWhatsAppProposalForSend(
  sql: SqlStorage,
  input: Readonly<{
    proposalId: string;
    version: number;
    bodyDigest: string;
    now: number;
  }>,
): WhatsAppSendClaim {
  const proposal = latestWhatsAppProposal(sql, input.proposalId);
  if (proposal === null) return { kind: "unavailable", state: "revoked" };
  if (proposal.state === "sent" && proposal.sentMessageId !== null) {
    return { kind: "already_sent", whatsappMessageId: proposal.sentMessageId };
  }
  if (
    proposal.state !== "awaiting_approval" ||
    proposal.version !== input.version ||
    proposal.bodyDigest !== input.bodyDigest
  ) {
    return { kind: "unavailable", state: proposal.state };
  }
  const attemptId = `whatsapp_send_${crypto.randomUUID()}`;
  const claimed = advanceWhatsAppProposal(
    sql,
    proposal,
    { event: "claim", attemptId, approvedBodyDigest: input.bodyDigest },
    input.now,
  );
  if (!claimed.ok) return { kind: "unavailable", state: proposal.state };
  return {
    kind: "claimed",
    proposal: {
      ...proposal,
      state: "sending",
      sendAttemptId: attemptId,
      approvedBodyDigest: input.bodyDigest,
      updatedAt: input.now,
    },
  };
}

/**
 * Sweeps proposals that outlived their approval TTL or their service window.
 * Expiry deletes the body and raises an operator notice, but does not pause
 * the account: one stale draft is not a reason to stop taking new customers.
 * A version that is being sent does not expire; its attempt's lease ends it.
 */
export function expireWhatsAppProposals(
  sql: SqlStorage,
  now: number,
): readonly WhatsAppExpiry[] {
  const runtime = readWhatsAppRuntime(sql);
  const expired: WhatsAppExpiry[] = [];
  for (const proposal of openWhatsAppProposals(sql, null)) {
    if (
      proposal.state !== "awaiting_approval" ||
      (proposal.expiresAt > now && proposal.serviceWindowExpiresAt > now)
    )
      continue;
    if (!advanceWhatsAppProposal(sql, proposal, { event: "expire" }, now).ok)
      continue;
    const caseId = proposal.caseId;
    expired.push({
      proposalId: proposal.proposalId,
      caseId,
      noticeKey:
        runtime === null
          ? null
          : recordWhatsAppOperatorNotice(sql, {
              reason: {
                kind: "service_window_expired",
                caseId,
                expiredAt: now,
              },
              policyVersion: runtime.policyVersion,
              now,
            }),
    });
  }
  return expired;
}

export function recordWhatsAppStatus(
  sql: SqlStorage,
  input: Readonly<{
    whatsappMessageId: string;
    status: "sent" | "delivered" | "read" | "failed";
    statusAt: number;
    failureCode: string | null;
    now: number;
  }>,
): { readonly kind: "recorded" | "duplicate" } {
  const existing =
    sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT 1 AS present FROM connector_whatsapp_status
      WHERE whatsapp_message_id = ? AND status = ?`,
        input.whatsappMessageId,
        input.status,
      )
      .toArray().length > 0;
  if (existing) return { kind: "duplicate" };
  sql.exec(
    `INSERT INTO connector_whatsapp_status (
       whatsapp_message_id, status, status_at, failure_code, observed_at
     ) VALUES (?, ?, ?, ?, ?)`,
    input.whatsappMessageId,
    input.status,
    input.statusAt,
    input.status === "failed" ? input.failureCode : null,
    input.now,
  );
  return { kind: "recorded" };
}

const CASE_SELECT = `SELECT case_id, customer_wa_id, conversation_window_sequence, ownership_json,
            message_count, byte_count, latest_customer_at, service_window_expires_at,
            debounce_due_at, turn_attempts, handoff_requested_at, handoff_reason,
            opened_at, closed_at
       FROM connector_whatsapp_case`;

const PROPOSAL_SELECT = `SELECT proposal_id, version, case_id, customer_wa_id, author,
            body_digest, nonce_b64, ciphertext_b64, state, send_attempt_id,
            approved_body_digest, sent_message_id, policy_version,
            credential_generation, service_window_expires_at, expires_at,
            created_at, updated_at
       FROM connector_whatsapp_proposal`;

function parseCaseRow(
  row: Record<string, SqlStorageValue>,
): WhatsAppCaseRow | null {
  const ownership = parseOwnership(row.ownership_json);
  if (ownership === null) return null;
  return {
    caseId: String(row.case_id),
    customerWaId: String(row.customer_wa_id),
    conversationWindowSequence: Number(row.conversation_window_sequence),
    ownership,
    messageCount: Number(row.message_count),
    byteCount: Number(row.byte_count),
    latestCustomerAt: Number(row.latest_customer_at),
    serviceWindowExpiresAt: Number(row.service_window_expires_at),
    debounceDueAt:
      row.debounce_due_at === null ? null : Number(row.debounce_due_at),
    turnAttempts: Number(row.turn_attempts ?? 0),
    handoffRequestedAt:
      row.handoff_requested_at === null
        ? null
        : Number(row.handoff_requested_at),
    handoffReason:
      row.handoff_reason === null ? null : String(row.handoff_reason),
    openedAt: Number(row.opened_at),
    closedAt: row.closed_at === null ? null : Number(row.closed_at),
  };
}

function parseProposalRow(
  row: Record<string, SqlStorageValue>,
): WhatsAppProposalRow | null {
  const state = row.state;
  if (
    !isProposalState(state) ||
    (row.author !== "agent" && row.author !== "human")
  )
    return null;
  return {
    proposalId: String(row.proposal_id),
    version: Number(row.version),
    caseId: String(row.case_id),
    customerWaId: String(row.customer_wa_id),
    author: row.author,
    bodyDigest: String(row.body_digest),
    nonceB64: row.nonce_b64 === null ? null : String(row.nonce_b64),
    ciphertextB64:
      row.ciphertext_b64 === null ? null : String(row.ciphertext_b64),
    state,
    sendAttemptId:
      row.send_attempt_id === null ? null : String(row.send_attempt_id),
    approvedBodyDigest:
      row.approved_body_digest === null
        ? null
        : String(row.approved_body_digest),
    sentMessageId:
      row.sent_message_id === null ? null : String(row.sent_message_id),
    policyVersion: Number(row.policy_version),
    credentialGeneration: Number(row.credential_generation),
    serviceWindowExpiresAt: Number(row.service_window_expires_at),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function isPresentProposal(
  proposal: WhatsAppProposalRow | null,
): proposal is WhatsAppProposalRow {
  return proposal !== null;
}

function isProposalState(value: unknown): value is WhatsAppProposalState {
  return (
    value === "awaiting_approval" ||
    value === "sending" ||
    value === "sent" ||
    value === "send_indeterminate" ||
    value === "rejected" ||
    value === "expired" ||
    value === "superseded" ||
    value === "taken_over" ||
    value === "revoked"
  );
}

function parseOwnership(
  raw: SqlStorageValue | undefined,
): WhatsAppOwnership | null {
  const value = safeJson(raw);
  if (!isRecord(value)) return null;
  if (value.kind === "agent_active") return { kind: "agent_active" };
  if (value.kind !== "human_owned") return null;
  if (typeof value.ownerId !== "string" || typeof value.startedAt !== "number")
    return null;
  if (value.reason !== "operator_takeover" && value.reason !== "agent_handoff")
    return null;
  return {
    kind: "human_owned",
    ownerId: value.ownerId,
    startedAt: value.startedAt,
    reason: value.reason,
  };
}

function parseLimits(
  raw: SqlStorageValue | undefined,
): WhatsAppIngressLimits | null {
  const value = safeJson(raw);
  if (!isRecord(value)) return null;
  const fields = [
    "maxActiveCases",
    "maxMessagesPerHour",
    "dailyAgentTokenBudget",
    "maxMessageBytes",
    "maxActiveCaseMessages",
    "maxActiveCaseBytes",
    "debounceSeconds",
  ] as const;
  for (const field of fields) {
    const candidate = value[field];
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate <= 0
    ) {
      return null;
    }
  }
  return {
    maxActiveCases: Number(value.maxActiveCases),
    maxMessagesPerHour: Number(value.maxMessagesPerHour),
    dailyAgentTokenBudget: Number(value.dailyAgentTokenBudget),
    maxMessageBytes: Number(value.maxMessageBytes),
    maxActiveCaseMessages: Number(value.maxActiveCaseMessages),
    maxActiveCaseBytes: Number(value.maxActiveCaseBytes),
    debounceSeconds: Number(value.debounceSeconds),
  };
}

function parseProcessing(
  raw: SqlStorageValue | undefined,
): WhatsAppProcessingState | null {
  const value = safeJson(raw);
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "waiting":
      return { kind: "waiting" };
    case "scheduled":
      return typeof value.at === "number"
        ? { kind: "scheduled", at: value.at }
        : null;
    case "processing":
      return typeof value.caseId === "string" &&
        typeof value.startedAt === "number"
        ? {
            kind: "processing",
            caseId: value.caseId,
            startedAt: value.startedAt,
          }
        : null;
    case "paused": {
      const reason = parsePauseReason(value.reason);
      return reason !== null &&
        typeof value.pausedAt === "number" &&
        typeof value.policyVersion === "number"
        ? {
            kind: "paused",
            reason,
            pausedAt: value.pausedAt,
            policyVersion: value.policyVersion,
          }
        : null;
    }
    default:
      return null;
  }
}

function parsePauseReason(raw: unknown): WhatsAppPauseReason | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "active_case_limit":
      return numbers(raw, ["observed", "limit"])
        ? {
            kind: raw.kind,
            observed: Number(raw.observed),
            limit: Number(raw.limit),
          }
        : null;
    case "hourly_message_limit":
      return numbers(raw, ["observed", "limit", "windowEndsAt"])
        ? {
            kind: raw.kind,
            observed: Number(raw.observed),
            limit: Number(raw.limit),
            windowEndsAt: Number(raw.windowEndsAt),
          }
        : null;
    case "daily_token_budget":
      return numbers(raw, ["reserved", "consumed", "limit", "windowEndsAt"])
        ? {
            kind: raw.kind,
            reserved: Number(raw.reserved),
            consumed: Number(raw.consumed),
            limit: Number(raw.limit),
            windowEndsAt: Number(raw.windowEndsAt),
          }
        : null;
    case "message_too_large":
      return typeof raw.providerMessageId === "string" &&
        numbers(raw, ["observedBytes", "limitBytes"])
        ? {
            kind: raw.kind,
            providerMessageId: raw.providerMessageId,
            observedBytes: Number(raw.observedBytes),
            limitBytes: Number(raw.limitBytes),
          }
        : null;
    case "unsupported_message_type":
      return typeof raw.providerMessageId === "string" &&
        typeof raw.messageType === "string"
        ? {
            kind: raw.kind,
            providerMessageId: raw.providerMessageId,
            messageType: raw.messageType,
          }
        : null;
    case "service_window_expired":
      return typeof raw.caseId === "string" && numbers(raw, ["expiredAt"])
        ? {
            kind: raw.kind,
            caseId: raw.caseId,
            expiredAt: Number(raw.expiredAt),
          }
        : null;
    case "send_indeterminate":
      return typeof raw.proposalId === "string" &&
        typeof raw.caseId === "string"
        ? { kind: raw.kind, proposalId: raw.proposalId, caseId: raw.caseId }
        : null;
    default:
      return null;
  }
}

function numbers(
  raw: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => typeof raw[field] === "number");
}

function safeJson(raw: SqlStorageValue | undefined): unknown {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

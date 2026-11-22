import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import {
  fetchConnectorMail,
  type MailConnectorContext,
} from "../mail-inbox/execution";
import { isActorExecutionActive } from "./actor-execution-quiescence";
import { GMAIL_MAILBOX } from "../mail/gmail-mail-adapter";
import type { DurableObjectStorage } from "@cloudflare/workers-types";

import { resolveActiveProviderConnectionCredential } from "../credential-vault/provider-connection-resolution";
import {
  gmailThreadCaseIdValue,
  bindAdmittedEmailMessageSender,
  recordEmailMessageReceipt,
  recordEmailThreadCase,
} from "../data/email-mailbox";
import {
  connectionCredentialAuthority,
  markIntegrationAccountReauthRequired,
  resolveActiveProviderAccountContext,
  setIntegrationAccountLifecycle,
} from "../data/integration-account";
import type { Env } from "@purin-labs/kernel/env";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { readEndpointVerificationStanding } from "../data/contact-verification";
import {
  extractMailbox,
  type GmailHistoryMessage,
  type GmailInboxEntry,
  type GmailMessageMetadata,
} from "../mail/gmail-adapter";
import { assertNever } from "@purin-labs/std";
import {
  gmailGrantRefused,
  resolveGmailAccessToken,
} from "../mail/gmail-oauth";
import {
  newRequestId,
  parseIntegrationAccountId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";
import { admitEmailThreadCase } from "./email-case-admission";
import type { Result } from "@purin-labs/kernel/result";
import { traceLog, traceWarn } from "@purin-labs/kernel/observability";
import { readMailHead } from "../mail-inbox/store";
import { claimMailResponseOwner } from "../mail-inbox/response-store";
import {
  claimDueEmailEvaluation,
  completeEmailEvaluation,
  countEmailAdmissionsSince,
  countEmailThreadsInProgress,
  emailMessageDisposition,
  emailTokenWindowTotals,
  markEmailWatch,
  deferEmailWatchCleanup,
  nextEmailWatchCleanupAt,
  readEmailRuntime,
  settleEmailWatchCleanup,
  emailCaseForThread,
  emailThreadInProgress,
  pauseEmailRuntime,
  recordEmailAdmissions,
  recordEmailCaseContextDiscovery,
  recordEmailReplyTurn,
  utcDayEndsAt,
  utcDayKey,
  type EmailAdmission,
  type EmailIngressLimits,
  type EmailRuntimeSnapshot,
} from "./connector-email";

const HOUR_MS = 3_600_000;
const MAX_METADATA_FETCHES = 50;
/** The oldest mail rescued from Spam that the evaluation admits. */
const SPAM_RESCUE_MAX_AGE_MS = 72 * HOUR_MS;

type ConnectorEmailAccessError = {
  readonly code: string;
  /**
   * True when the mailbox cannot recover without a human re-authorizing.
   * A refresh token that Google has expired or revoked answers 400/401 and
   * will answer the same way on every retry, so processing must fail closed
   * and say so rather than deferring hourly and looking merely quiet.
   */
  readonly authorizationExpired?: boolean;
};

const TERMINAL_AUTHORIZATION_CODES: ReadonlySet<string> = new Set([
  "provider_identity_unverified",
  "provider_credential_revoked",
  "credential_revoked",
  "provider_connection_not_found",
  "integration_account_not_found",
  "connector_email_credential_invalid",
]);

function classifyGmailAccessFailure(
  error: Readonly<{ code: string; status?: number; lifecycle?: string }>,
): ConnectorEmailAccessError {
  // An account that already records Google's refusal fails as the refusal
  // did: processing stays paused until a person reconnects it.
  if (
    error.code === "integration_account_inactive" &&
    error.lifecycle === "reauth_required"
  )
    return {
      code: "connector_email_authorization_expired",
      authorizationExpired: true,
    };
  if (error.code === "provider_oauth_exchange_failed") {
    const status = error.status ?? 0;
    // Google answers 400 invalid_grant for an expired or revoked refresh
    // token. Anything else — 429, 5xx, a transport failure — may still succeed.
    return status === 400 || status === 401
      ? {
          code: "connector_email_authorization_expired",
          authorizationExpired: true,
        }
      : { code: error.code };
  }
  return TERMINAL_AUTHORIZATION_CODES.has(error.code)
    ? { code: error.code, authorizationExpired: true }
    : { code: error.code };
}

/**
 * Resolves one short-lived Gmail access token for the mailbox behind this
 * Connector. Tokens stay inside this call chain: they reach the stateless
 * adapter and are never written to Actor storage or D1.
 */
export async function resolveConnectorGmailAccess(
  input: Readonly<{
    env: Env;
    organisationId: string;
    integrationAccountId: string;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<string, ConnectorEmailAccessError>> {
  const organisationId = parseOrganisationId(input.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    input.integrationAccountId,
  );
  if (!organisationId.ok || !integrationAccountId.ok) {
    return { ok: false, error: { code: "connector_email_identity_invalid" } };
  }
  const execution = await OrganisationExecutionScope.resolve(
    input.env,
    organisationId.value,
  );
  if (!execution.ok)
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const context = await resolveActiveProviderAccountContext({
    db: execution.value.database,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
  });
  if (!context.ok)
    return { ok: false, error: classifyGmailAccessFailure(context.error) };
  const secret = await resolveActiveProviderConnectionCredential({
    db: execution.value.database,
    keys: input.env,
    context: context.value,
    expectedProvider: "gmail",
  });
  if (!secret.ok)
    return { ok: false, error: classifyGmailAccessFailure(secret.error) };
  const authority = connectionCredentialAuthority(
    context.value.connection.authority,
  );
  if (secret.value.kind !== "oauth_tokens" || authority === null) {
    return { ok: false, error: { code: "connector_email_credential_invalid" } };
  }
  const authorizationProduct = context.value.connection.authorizationProduct;
  if (
    authorizationProduct.kind !== "gmail" ||
    authorizationProduct.product !== "full_mailbox_pilot"
  ) {
    return { ok: false, error: { code: "connector_email_credential_invalid" } };
  }
  const token = await resolveGmailAccessToken({
    env: input.env,
    scope: execution.value,
    handle: authority.credentialRef,
    tokens: secret.value,
    product: authorizationProduct.product,
    now: input.now,
    fetcher: input.fetcher,
  });
  if (token.ok) return token;
  // The account then shows "Reconnect needed", and no later read asks Google
  // again: each one stops at the account's state.
  if (gmailGrantRefused(token.error))
    await markIntegrationAccountReauthRequired({
      db: execution.value.database,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      readUpdatedAt: context.value.account.updatedAt,
      reasonCode: GMAIL_GRANT_REFUSED_REASON,
      now: input.now,
    });
  return { ok: false, error: classifyGmailAccessFailure(token.error) };
}

/** The account's reason when Google refuses its sign-in (`invalid_grant`). */
const GMAIL_GRANT_REFUSED_REASON = "provider_grant_refused";

type ConnectorEmailActivation = {
  readonly activationFloor: string;
  readonly watchExpiresAt: number;
};

/** The profile fixes the floor before starting the watch; its acknowledgment
 * returns both values for the caller to retain before release or export. */
export async function establishConnectorEmailWatch(
  input: MailConnectorContext &
    Readonly<{
      integrationAccountId: string;
      now: number;
      fetcher: typeof fetch;
    }>,
): Promise<Result<ConnectorEmailActivation, ConnectorEmailAccessError>> {
  const mailOperations = GMAIL_MAILBOX;
  if (!(await isActorExecutionActive(input.storage.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const fetcher = fetchConnectorMail.bind(
    null,
    input.storage.sql,
    input.scope,
    input.fetcher,
  );
  if (input.env.GMAIL_PUBSUB_TOPIC === undefined) {
    return { ok: false, error: { code: "connector_email_topic_missing" } };
  }
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
    now: input.now,
    fetcher,
  });
  if (!access.ok) return access;
  const profile = await mailOperations.reads.readProfile({
    accessToken: access.value,
    fetcher,
  });
  if (!profile.ok) return { ok: false, error: { code: profile.error.code } };
  const watch = await mailOperations.observation.startWatch({
    accessToken: access.value,
    topicName: input.env.GMAIL_PUBSUB_TOPIC,
    fetcher,
  });
  if (!watch.ok) return { ok: false, error: { code: watch.error.code } };
  return {
    ok: true,
    value: {
      activationFloor: profile.value.historyId,
      watchExpiresAt: watch.value.expiration,
    },
  };
}

/**
 * The mailbox's current Gmail history id, read with the mailbox's own
 * credential. A check for new mail admits it as a push would bring it, for a
 * push that is late or that never comes.
 */
export async function readConnectorEmailHistoryId(
  input: MailConnectorContext &
    Readonly<{
      integrationAccountId: string;
      now: number;
      fetcher: typeof fetch;
    }>,
): Promise<Result<string, ConnectorEmailAccessError>> {
  if (!(await isActorExecutionActive(input.storage.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const fetcher = fetchConnectorMail.bind(
    null,
    input.storage.sql,
    input.scope,
    input.fetcher,
  );
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
    now: input.now,
    fetcher,
  });
  if (!access.ok) return access;
  const profile = await GMAIL_MAILBOX.reads.readProfile({
    accessToken: access.value,
    fetcher,
  });
  return profile.ok
    ? { ok: true, value: profile.value.historyId }
    : { ok: false, error: { code: profile.error.code } };
}

export async function renewConnectorEmailWatch(
  input: MailConnectorContext &
    Readonly<{
      integrationAccountId: string;
      now: number;
      fetcher: typeof fetch;
    }>,
): Promise<Result<number, ConnectorEmailAccessError>> {
  const mailOperations = GMAIL_MAILBOX;
  if (!(await isActorExecutionActive(input.storage.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const fetcher = fetchConnectorMail.bind(
    null,
    input.storage.sql,
    input.scope,
    input.fetcher,
  );
  if (input.env.GMAIL_PUBSUB_TOPIC === undefined) {
    return { ok: false, error: { code: "connector_email_topic_missing" } };
  }
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
    now: input.now,
    fetcher,
  });
  if (!access.ok) return access;
  const watch = await mailOperations.observation.startWatch({
    accessToken: access.value,
    topicName: input.env.GMAIL_PUBSUB_TOPIC,
    fetcher,
  });
  if (!watch.ok) return { ok: false, error: { code: watch.error.code } };
  input.storage.transactionSync(
    markEmailWatch.bind(null, input.storage.sql, watch.value.expiration),
  );
  return { ok: true, value: watch.value.expiration };
}

export async function stopConnectorEmailWatch(
  input: MailConnectorContext &
    Readonly<{ now: number; fetcher: typeof fetch }>,
): Promise<Result<null, ConnectorEmailAccessError>> {
  const sql = input.storage.sql;
  if (!(await isActorExecutionActive(sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (nextEmailWatchCleanupAt(sql) === null) return { ok: true, value: null };
  const runtime = readEmailRuntime(sql);
  if (runtime === null) {
    settleEmailWatchCleanup(sql);
    return { ok: true, value: null };
  }
  deferEmailWatchCleanup(sql, input.now);
  const fetcher = fetchConnectorMail.bind(
    null,
    sql,
    input.scope,
    input.fetcher,
  );
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: runtime.organisationId,
    integrationAccountId: runtime.integrationAccountId,
    now: input.now,
    fetcher,
  });
  if (!access.ok) return access;
  const stopped = await GMAIL_MAILBOX.observation.stopWatch({
    accessToken: access.value,
    fetcher,
  });
  if (!stopped.ok) return { ok: false, error: { code: stopped.error.code } };
  // Keep an acknowledged stop in the export even when placement froze in flight.
  input.storage.transactionSync(settleEmailWatchCleanup.bind(null, sql));
  if (!(await isActorExecutionActive(sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  return { ok: true, value: null };
}

type AdmittedEmailThreadSummary = {
  readonly threadId: string;
  readonly caseId: string;
  readonly messageIds: readonly string[];
};

type EmailEvaluationOutcome =
  | { readonly kind: "idle" }
  | {
      readonly kind: "evaluated";
      readonly admitted: number;
      readonly deduplicated: number;
      readonly threads: readonly AdmittedEmailThreadSummary[];
    }
  | { readonly kind: "paused"; readonly reason: string }
  | { readonly kind: "degraded"; readonly reason: string }
  | { readonly kind: "deferred"; readonly reason: string };

/**
 * One push-triggered evaluation: reconcile Gmail history from the accepted cursor,
 * enforce every ingress limit before admission, coalesce messages by thread,
 * and record metadata-only admissions. A limit breach pauses processing
 * before the first unadmitted message and never advances the accepted
 * cursor past it.
 */
export async function runConnectorEmailEvaluation(
  input: MailConnectorContext &
    Readonly<{ now: number; fetcher: typeof fetch }>,
): Promise<EmailEvaluationOutcome> {
  const mailOperations = GMAIL_MAILBOX;
  const sql = input.storage.sql;
  if (!(await isActorExecutionActive(sql, input.scope)))
    return { kind: "deferred", reason: "connector_placement_conflict" };
  const fetcher = fetchConnectorMail.bind(
    null,
    input.storage.sql,
    input.scope,
    input.fetcher ?? runtimeFetch,
  );
  const claim = input.storage.transactionSync(() =>
    claimDueEmailEvaluation(sql, input.now),
  );
  if (claim.kind === "idle") return { kind: "idle" };
  const runtime = claim.runtime;
  if (runtime.organisationId !== input.scope.organisationId)
    return { kind: "deferred", reason: "connector_placement_conflict" };
  const access = await resolveConnectorGmailAccess({
    env: input.env,
    organisationId: runtime.organisationId,
    integrationAccountId: runtime.integrationAccountId,
    now: input.now,
    fetcher,
  });
  if (!(await isActorExecutionActive(sql, input.scope)))
    return { kind: "deferred", reason: "connector_placement_conflict" };
  if (!access.ok) {
    // A transient failure defers to the next scheduled pass; an expired grant fails
    // closed, because retrying it hourly forever would leave the mailbox
    // silently unattended while looking merely quiet.
    if (access.error.authorizationExpired === true) {
      const paused = input.storage.transactionSync(() => {
        completeEmailEvaluation(sql, {
          acceptedHistoryId: runtime.acceptedHistoryId,
          now: input.now,
        });
        return pauseEmailRuntime(sql, {
          reason: {
            kind: "authorization_expired",
            reasonCode: access.error.code,
            observedAt: input.now,
          },
          now: input.now,
        });
      });
      traceWarn("connector.email_authorization_expired", {
        requestId: newRequestId(),
        integration_account_id: runtime.integrationAccountId,
        code: access.error.code,
        first_pause: paused.ok ? paused.value.firstPause : false,
      });
      return { kind: "paused", reason: "authorization_expired" };
    }
    input.storage.transactionSync(() => {
      completeEmailEvaluation(sql, {
        acceptedHistoryId: runtime.acceptedHistoryId,
        now: input.now,
      });
    });
    traceWarn("connector.email_access_unavailable", {
      requestId: newRequestId(),
      code: access.error.code,
    });
    return { kind: "deferred", reason: access.error.code };
  }
  const history = await mailOperations.observation.readInboxAdditions({
    accessToken: access.value,
    startHistoryId: runtime.acceptedHistoryId,
    fetcher,
  });
  if (!(await isActorExecutionActive(sql, input.scope)))
    return { kind: "deferred", reason: "connector_placement_conflict" };
  if (!history.ok) {
    if (history.error.code === "gmail_history_expired") {
      return degradeExpiredCursor(input, runtime);
    }
    input.storage.transactionSync(() => {
      completeEmailEvaluation(sql, {
        acceptedHistoryId: runtime.acceptedHistoryId,
        now: input.now,
      });
    });
    return { kind: "deferred", reason: history.error.code };
  }
  const fresh = history.value.messages.filter(
    (message) => emailMessageDisposition(sql, message.messageId) === null,
  );
  const cueMessages = input.storage.transactionSync(() =>
    selectCueMessages(sql, fresh),
  );
  const metadata: GmailMessageMetadata[] = [];
  let rescuedRead = 0;
  let rescuedAdmissible = 0;
  for (const message of cueMessages.slice(0, MAX_METADATA_FETCHES)) {
    const detail = await mailOperations.reads.readMessageMetadata({
      accessToken: access.value,
      messageId: message.messageId,
      fetcher,
    });
    if (!(await isActorExecutionActive(sql, input.scope)))
      return { kind: "deferred", reason: "connector_placement_conflict" };
    if (!detail.ok) {
      if (detail.error.code === "gmail_not_found") continue;
      input.storage.transactionSync(() => {
        completeEmailEvaluation(sql, {
          acceptedHistoryId: runtime.acceptedHistoryId,
          now: input.now,
        });
      });
      return { kind: "deferred", reason: detail.error.code };
    }
    const admissible = inboxMessageIsAdmissible(
      detail.value,
      message.entry,
      input.now,
    );
    if (message.entry === "rescued_from_spam") {
      rescuedRead += 1;
      if (admissible) rescuedAdmissible += 1;
    }
    if (admissible) metadata.push(detail.value);
  }
  if (rescuedRead > 0)
    traceLog("connector.email_spam_rescue_read", {
      requestId: newRequestId(),
      rescued: rescuedRead,
      admissible: rescuedAdmissible,
    });
  metadata.sort((left, right) =>
    left.internalDate === right.internalDate
      ? left.messageId < right.messageId
        ? -1
        : 1
      : left.internalDate - right.internalDate,
  );

  const decision = decideEmailAdmissions({
    sql,
    runtime,
    limits: runtime.limits,
    messages: metadata,
    now: input.now,
  });
  const pause = decision.pause;
  const binding = await readMailboxBindingProjection(input.scope, runtime);
  const threads = groupAdmissionsByThread(runtime, decision.admitted);
  const admittedThreads: AdmittedEmailThreadSummary[] = [];
  let admissionDeferred = false;
  let admittedCount = 0;
  for (const thread of threads) {
    if (binding === null) {
      admissionDeferred = true;
      traceWarn("connector.email_case_admission_deferred", {
        requestId: newRequestId(),
        code: "mailbox_binding_missing",
      });
      break;
    }
    if (!(await isActorExecutionActive(sql, input.scope)))
      return { kind: "deferred", reason: "connector_placement_conflict" };
    const admitted = await admitEmailThreadCase(input.env, {
      scope: input.scope,
      organisationId: runtime.organisationId,
      integrationAccountId: runtime.integrationAccountId,
      gmailThreadId: thread.threadId,
      caseId: thread.caseId,
      messageIds: thread.messageIds,
      mailboxBindingId: binding.mailboxBindingId,
      bindingRevision: binding.currentRevision,
      policyVersion: runtime.policyVersion,
      receivedAt: input.now,
      subject: admittedThreadSubject(metadata, thread),
    });
    if (!(await isActorExecutionActive(sql, input.scope)))
      return { kind: "deferred", reason: "connector_placement_conflict" };
    if (!admitted.ok) {
      admissionDeferred = true;
      traceWarn("connector.email_case_admission_deferred", {
        requestId: newRequestId(),
        code: admitted.error.code,
      });
      continue;
    }
    const projected = await projectThreadAdmissions(
      input.scope,
      runtime,
      binding,
      thread,
      input.now,
      admittedSenders(metadata),
    );
    if (!(await isActorExecutionActive(sql, input.scope)))
      return { kind: "deferred", reason: "connector_placement_conflict" };
    if (!projected.ok) {
      admissionDeferred = true;
      continue;
    }
    input.storage.transactionSync(() => {
      recordEmailAdmissions(sql, {
        admitted: thread.admissions,
        policyVersion: runtime.policyVersion,
        now: input.now,
      });
      recordEmailCaseContextDiscovery(sql, {
        organisationId: runtime.organisationId,
        integrationAccountId: runtime.integrationAccountId,
        caseId: thread.caseId,
        threadId: thread.threadId,
        messageIds: thread.messageIds,
        policyVersion: runtime.policyVersion,
        now: input.now,
      });
      // The reply turn is owed from the moment the mail is admitted.
      recordEmailReplyTurn(sql, {
        caseId: thread.caseId,
        threadId: thread.threadId,
        messageIds: thread.messageIds,
        now: input.now,
      });
    });
    admittedCount += thread.admissions.length;
    admittedThreads.push({
      threadId: thread.threadId,
      caseId: thread.caseId,
      messageIds: thread.messageIds,
    });
  }
  if (!(await isActorExecutionActive(sql, input.scope)))
    return { kind: "deferred", reason: "connector_placement_conflict" };
  if (pause !== null) {
    input.storage.transactionSync(() => {
      pauseEmailRuntime(sql, { reason: pause, now: input.now });
    });
    traceLog("connector.email_paused", {
      requestId: newRequestId(),
      reason: pause.kind,
    });
    return { kind: "paused", reason: pause.kind };
  }
  // A read that the page limit stopped still advances, to the last record it
  // read: every message up to it went through admission. The history also
  // carries the label changes of Inbox mail, such as read and unread. A burst
  // of them longer than the page limit would otherwise make each evaluation
  // read the same pages from the same start again.
  const advance =
    cueMessages.length <= MAX_METADATA_FETCHES && !admissionDeferred;
  input.storage.transactionSync(() => {
    completeEmailEvaluation(sql, {
      acceptedHistoryId: advance
        ? history.value.latestHistoryId
        : runtime.acceptedHistoryId,
      now: input.now,
    });
  });
  return {
    kind: "evaluated",
    admitted: admittedCount,
    deduplicated: history.value.messages.length - fresh.length,
    threads: admittedThreads,
  };
}

type AdmittedEmailThread = {
  readonly threadId: string;
  readonly caseId: string;
  readonly messageIds: readonly string[];
  readonly admissions: readonly EmailAdmission[];
};

/** The subject of a thread's oldest admitted message: its Case's title. */
export function admittedThreadSubject(
  messages: readonly GmailMessageMetadata[],
  thread: Readonly<{ messageIds: readonly string[] }>,
): string | null {
  const oldest = thread.messageIds[0];
  return (
    messages.find((message) => message.messageId === oldest)?.subject ?? null
  );
}

export function groupAdmissionsByThread(
  runtime: EmailRuntimeSnapshot,
  admitted: readonly EmailAdmission[],
): readonly AdmittedEmailThread[] {
  const byThread = new Map<string, EmailAdmission[]>();
  for (const admission of admitted) {
    const existing = byThread.get(admission.threadId) ?? [];
    existing.push(admission);
    byThread.set(admission.threadId, existing);
  }
  return [...byThread.entries()].map(([threadId, admissions]) => ({
    threadId,
    caseId:
      admissions[0]?.caseId ??
      `case_gmail_${runtime.integrationAccountId}_${threadId}`,
    messageIds: admissions.map((admission) => admission.providerMessageId),
    admissions,
  }));
}

type EmailAdmissionDecision = {
  readonly admitted: readonly EmailAdmission[];
  readonly pause:
    import("../data/email-mailbox").MailboxProcessingPauseReason | null;
};

export function decideEmailAdmissions(
  input: Readonly<{
    sql: import("@cloudflare/workers-types").SqlStorage;
    runtime: EmailRuntimeSnapshot;
    limits: EmailIngressLimits;
    messages: readonly GmailMessageMetadata[];
    now: number;
  }>,
): EmailAdmissionDecision {
  const admitted: EmailAdmission[] = [];
  const admittedThreads = new Set<string>();
  let hourlyCount = countEmailAdmissionsSince(input.sql, input.now - HOUR_MS);
  let inProgress = countEmailThreadsInProgress(input.sql);
  const window = emailTokenWindowTotals(input.sql, utcDayKey(input.now));
  for (const message of input.messages) {
    if (window.reserved + window.consumed >= input.limits.dailyTokenBudget) {
      return {
        admitted,
        pause: {
          kind: "daily_token_budget",
          reserved: window.reserved,
          consumed: window.consumed,
          limit: input.limits.dailyTokenBudget,
          windowEndsAt: utcDayEndsAt(input.now),
        },
      };
    }
    if (hourlyCount >= input.limits.maxMessagesPerHour) {
      return {
        admitted,
        pause: {
          kind: "hourly_message_limit",
          observed: hourlyCount,
          limit: input.limits.maxMessagesPerHour,
          windowEndsAt: input.now + HOUR_MS,
        },
      };
    }
    if (message.sizeEstimate > input.limits.maxMessageBytes) {
      return {
        admitted,
        pause: {
          kind: "message_too_large",
          providerMessageId: message.messageId,
          observedBytes: message.sizeEstimate,
          limitBytes: input.limits.maxMessageBytes,
        },
      };
    }
    // A thread whose reply is still in progress takes the new message into
    // that work. Any other thread needs a free place.
    const joinsWork =
      admittedThreads.has(message.threadId) ||
      emailThreadInProgress(input.sql, message.threadId);
    if (!joinsWork && inProgress >= input.limits.maxActiveCases) {
      return {
        admitted,
        pause: {
          kind: "active_case_limit",
          observed: inProgress,
          limit: input.limits.maxActiveCases,
        },
      };
    }
    const caseId =
      emailCaseForThread(input.sql, message.threadId) ??
      caseIdForThread(input.runtime.integrationAccountId, message.threadId);
    if (!joinsWork) inProgress += 1;
    admittedThreads.add(message.threadId);
    hourlyCount += 1;
    admitted.push({
      providerMessageId: message.messageId,
      threadId: message.threadId,
      caseId,
    });
  }
  return { admitted, pause: null };
}

function caseIdForThread(
  integrationAccountId: string,
  threadId: string,
): string {
  const parsed = gmailThreadCaseIdValue(integrationAccountId, threadId);
  if (parsed.ok) return parsed.value;
  return `case_gmail_${integrationAccountId}_${threadId}`.replaceAll(
    /[^A-Za-z0-9_]/gu,
    "_",
  );
}

type MailboxBindingProjection = {
  readonly mailboxBindingId: string;
  readonly currentRevision: number;
};

async function readMailboxBindingProjection(
  scope: OrganisationExecutionScope,
  runtime: EmailRuntimeSnapshot,
): Promise<MailboxBindingProjection | null> {
  const organisationId = parseOrganisationId(runtime.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    runtime.integrationAccountId,
  );
  if (!organisationId.ok || !integrationAccountId.ok) return null;
  return scope.database
    .prepare(
      `SELECT mailbox_binding_id AS mailboxBindingId, current_revision AS currentRevision
       FROM agent_mailbox_binding WHERE organisation_id = ? AND integration_account_id = ?`,
    )
    .bind(organisationId.value, integrationAccountId.value)
    .first<MailboxBindingProjection>();
}

/**
 * The sender each message may be bound to: its From header, when a reply to
 * the message goes to that same address. A message that names another reply
 * address is bound to nobody, because a reply to it does not reach its sender.
 */
export function admittedSenders(
  messages: readonly GmailMessageMetadata[],
): ReadonlyMap<string, string | null> {
  const senders = new Map<string, string | null>();
  for (const message of messages) {
    const from = message.from === null ? null : extractMailbox(message.from);
    const replyTo =
      message.replyTo === null ? from : extractMailbox(message.replyTo);
    senders.set(
      message.messageId,
      from !== null && replyTo === from ? message.from : null,
    );
  }
  return senders;
}

/**
 * Records each admitted message's receipt and binds it to the sender's
 * verified contact, when a reply goes to the sender and the sender's address
 * matches exactly one current verification for this mailbox. The address is
 * used for that match alone and is not stored. A verification that could not
 * be read defers the thread, so an unknown sender is never recorded as an
 * unverified one.
 */
export async function projectThreadAdmissions(
  scope: OrganisationExecutionScope,
  runtime: EmailRuntimeSnapshot,
  binding: MailboxBindingProjection,
  thread: AdmittedEmailThread,
  now: number,
  senders: ReadonlyMap<string, string | null>,
): Promise<Result<null, { readonly code: string }>> {
  const organisationId = parseOrganisationId(runtime.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    runtime.integrationAccountId,
  );
  if (
    !organisationId.ok ||
    !integrationAccountId.ok ||
    organisationId.value !== scope.organisationId
  )
    return { ok: false, error: { code: "email_case_identity_invalid" } };
  const caseId = gmailThreadCaseIdValue(
    runtime.integrationAccountId,
    thread.threadId,
  );
  if (!caseId.ok) return { ok: false, error: { code: caseId.error.code } };
  const mapped = await recordEmailThreadCase({
    scope,
    integrationAccountId: integrationAccountId.value,
    gmailThreadId: thread.threadId,
    caseId: caseId.value,
    mailboxBindingId: binding.mailboxBindingId,
    bindingRevision: binding.currentRevision,
    now,
  });
  if (!mapped.ok) {
    traceWarn("connector.email_projection_deferred", {
      requestId: newRequestId(),
      code: mapped.error.code,
    });
    return mapped;
  }
  for (const admission of thread.admissions) {
    const receipt = await recordEmailMessageReceipt({
      scope,
      integrationAccountId: integrationAccountId.value,
      providerMessageId: admission.providerMessageId,
      gmailThreadId: thread.threadId,
      caseId: mapped.value,
      policyVersion: runtime.policyVersion,
      now,
    });
    if (!receipt.ok) {
      traceWarn("connector.email_projection_deferred", {
        requestId: newRequestId(),
        code: receipt.error.code,
      });
      return receipt;
    }
    const from = senders.get(admission.providerMessageId) ?? null;
    const address = from === null ? null : extractMailbox(from);
    if (address === null) continue;
    const standing = await readEndpointVerificationStanding({
      db: scope.database,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      endpoint: { channel: "gmail", address },
    });
    if (standing.kind === "not_current") continue;
    const bound =
      standing.kind === "verified"
        ? await bindAdmittedEmailMessageSender({
            scope,
            integrationAccountId: integrationAccountId.value,
            providerMessageId: admission.providerMessageId,
            caseId: mapped.value,
            verificationId: standing.endpoint.verificationId,
            verificationRevision: standing.endpoint.revision,
          })
        : {
            ok: false as const,
            error: { code: "contact_verification_unreadable" as const },
          };
    if (!bound.ok) {
      traceWarn("connector.email_projection_deferred", {
        requestId: newRequestId(),
        code: bound.error.code,
      });
      return bound;
    }
  }
  return { ok: true, value: null };
}

function selectCueMessages<Message extends GmailHistoryMessage>(
  sql: import("@cloudflare/workers-types").SqlStorage,
  messages: readonly Message[],
): readonly Message[] {
  const head = readMailHead(sql);
  const selected: Message[] = [];
  for (const message of messages)
    if (claimMailResponseOwner(sql, head, message).kind === "cue")
      selected.push(message);
  return selected;
}

/**
 * Whether a message that the history names goes on to admission. Admission
 * itself is the same for every message: the dedupe before this check, and the
 * limits, sender binding, Case and reply turn after it.
 *
 * The message must be in the Inbox now. A delivered message needs nothing
 * more. A message rescued from Spam must also be out of Spam now, and Gmail
 * must have received it no more than SPAM_RESCUE_MAX_AGE_MS before the
 * evaluation.
 *
 * The activation floor is a position in the Gmail history, and the history
 * read starts at it. So it applies to the event that put the message in the
 * Inbox: the delivery, or the "Not spam" press. A mail that came into Spam
 * before activation and is rescued after it comes into the Inbox after the
 * floor, as a new mail does, and is admitted. A rescue before activation is
 * behind the floor and is never read. The age limit keeps a person who moves
 * an old Spam folder to the Inbox from making the agent answer mail of past
 * days or weeks. Mail that the agent admitted before is never admitted again,
 * because the dedupe removes it before this check.
 */
function inboxMessageIsAdmissible(
  message: GmailMessageMetadata,
  entry: GmailInboxEntry,
  now: number,
): boolean {
  if (!message.labelIds.includes("INBOX")) return false;
  switch (entry) {
    case "delivered":
      return true;
    case "rescued_from_spam":
      return (
        !message.labelIds.includes("SPAM") &&
        message.internalDate >= now - SPAM_RESCUE_MAX_AGE_MS
      );
    default:
      return assertNever(entry);
  }
}

function degradeExpiredCursor(
  input: Readonly<{
    storage: DurableObjectStorage;
    scope: OrganisationExecutionScope;
    env: Env;
    now: number;
  }>,
  runtime: EmailRuntimeSnapshot,
): Promise<EmailEvaluationOutcome> {
  return (async () => {
    input.storage.transactionSync(() => {
      completeEmailEvaluation(input.storage.sql, {
        acceptedHistoryId: runtime.acceptedHistoryId,
        now: input.now,
      });
    });
    const organisationId = parseOrganisationId(runtime.organisationId);
    const integrationAccountId = parseIntegrationAccountId(
      runtime.integrationAccountId,
    );
    if (organisationId.ok && integrationAccountId.ok) {
      await setIntegrationAccountLifecycle({
        db: input.scope.database,
        organisationId: organisationId.value,
        integrationAccountId: integrationAccountId.value,
        lifecycle: { kind: "degraded", reasonCode: "gmail_history_expired" },
        now: input.now,
      });
    }
    traceWarn("connector.email_history_expired", {
      requestId: newRequestId(),
      integration_account_id: runtime.integrationAccountId,
    });
    return { kind: "degraded", reason: "gmail_history_expired" };
  })();
}

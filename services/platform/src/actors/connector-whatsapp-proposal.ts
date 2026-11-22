import type { SqlStorage } from "@cloudflare/workers-types";

import {
  readWhatsAppSendAuthority,
  recordWhatsAppMessageReceipt,
  type WhatsAppSendRefusal,
} from "@purin-labs/area-inbox/server/data/whatsapp";
import type { Env } from "@purin-labs/kernel/env";
import {
  newRequestId,
  parseIntegrationAccountId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { isActorExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import { resolveWhatsAppOrganisationCredential } from "../whatsapp/credential";
import { sendWhatsAppText } from "@purin-labs/connections/whatsapp/graph";
import {
  appendWhatsAppEnvelopeEntry,
  claimWhatsAppProposalForSend,
  latestWhatsAppProposal,
  openWhatsAppProposals,
  pauseWhatsAppRuntime,
  readWhatsAppCase,
  readWhatsAppRuntime,
  recordWhatsAppProposal,
  WHATSAPP_DISPOSAL_EVENTS,
  type WhatsAppProposalRow,
} from "@purin-labs/area-inbox/server/actors/connector-whatsapp";
import type { WhatsAppContentCipher } from "@purin-labs/area-inbox/server/actors/whatsapp-active-content";
import {
  advanceWhatsAppProposal,
  WHATSAPP_SEND_ATTEMPT_LEASE_MS,
} from "@purin-labs/area-inbox/server/actors/whatsapp-reply-proposal-transition";

/**
 * The WhatsApp proposal store and the immutable send ladder.
 *
 * WhatsApp has no provider draft object, so the proposal body lives
 * application-encrypted beside the Case until it is sent, rejected, replaced,
 * expired, taken over, or revoked. Sending revalidates every frozen fact,
 * makes exactly one provider attempt, and settles only on a WhatsApp message
 * id. An ambiguous attempt becomes `send_indeterminate`, fences the Case, and
 * is never retried automatically.
 */

type WhatsAppProposalError = { readonly code: string };

type WhatsAppProposalPreview = {
  readonly proposalId: string;
  readonly version: number;
  readonly caseId: string;
  readonly customerWaId: string;
  readonly author: "agent" | "human";
  readonly body: string;
  readonly bodyDigest: string;
  readonly state: WhatsAppProposalRow["state"];
  readonly serviceWindowExpiresAt: number;
  readonly expiresAt: number;
};

export type WhatsAppProposalPreviewOutcome =
  | { readonly kind: "current"; readonly preview: WhatsAppProposalPreview }
  | { readonly kind: "proposal_missing" }
  | { readonly kind: "expired" }
  | { readonly kind: "send_indeterminate"; readonly version: number };

export async function previewWhatsAppProposal(
  input: Readonly<{
    sql: SqlStorage;
    scope: OrganisationExecutionScope;
    cipher: WhatsAppContentCipher;
    proposalId: string;
    now: number;
  }>,
): Promise<Result<WhatsAppProposalPreviewOutcome, WhatsAppProposalError>> {
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const runtime = readWhatsAppRuntime(input.sql);
  if (runtime === null || runtime.organisationId !== input.scope.organisationId)
    return {
      ok: false,
      error: { code: "connector_whatsapp_identity_invalid" },
    };
  const proposal = latestWhatsAppProposal(input.sql, input.proposalId);
  if (proposal === null)
    return { ok: true, value: { kind: "proposal_missing" } };
  if (proposal.state === "send_indeterminate") {
    return {
      ok: true,
      value: { kind: "send_indeterminate", version: proposal.version },
    };
  }
  if (proposal.state === "expired") {
    return { ok: true, value: { kind: "expired" } };
  }
  if (proposal.state !== "awaiting_approval" && proposal.state !== "sending") {
    return { ok: true, value: { kind: "proposal_missing" } };
  }
  if (
    proposal.state === "awaiting_approval" &&
    (input.now > proposal.expiresAt ||
      input.now > proposal.serviceWindowExpiresAt)
  ) {
    advanceWhatsAppProposal(
      input.sql,
      proposal,
      { event: "expire" },
      input.now,
    );
    return { ok: true, value: { kind: "expired" } };
  }
  if (proposal.nonceB64 === null || proposal.ciphertextB64 === null) {
    return { ok: true, value: { kind: "proposal_missing" } };
  }
  const opened = await input.cipher.open(
    proposal.caseId,
    {
      kind: "proposal",
      proposalId: proposal.proposalId,
      version: proposal.version,
    },
    { nonceB64: proposal.nonceB64, ciphertextB64: proposal.ciphertextB64 },
  );
  if (!opened.ok) return { ok: false, error: { code: opened.error.code } };
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  return {
    ok: true,
    value: {
      kind: "current",
      preview: {
        proposalId: proposal.proposalId,
        version: proposal.version,
        caseId: proposal.caseId,
        customerWaId: proposal.customerWaId,
        author: proposal.author,
        body: opened.value,
        bodyDigest: proposal.bodyDigest,
        state: proposal.state,
        serviceWindowExpiresAt: proposal.serviceWindowExpiresAt,
        expiresAt: proposal.expiresAt,
      },
    },
  };
}

type WhatsAppProposalEditOutcome =
  | {
      readonly kind: "versioned";
      readonly version: number;
      readonly bodyDigest: string;
    }
  | { readonly kind: "proposal_missing" }
  | { readonly kind: "expired" };

/** Editing never mutates a version: it freezes a new one for a new approval. */
export async function editWhatsAppProposal(
  input: Readonly<{
    sql: SqlStorage;
    authorizeExecution: () => Promise<boolean>;
    cipher: WhatsAppContentCipher;
    proposalId: string;
    body: string;
    maxReplyChars: number;
    now: number;
  }>,
): Promise<Result<WhatsAppProposalEditOutcome, WhatsAppProposalError>> {
  if (!(await input.authorizeExecution()))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  const proposal = latestWhatsAppProposal(input.sql, input.proposalId);
  // A version that is being sent cannot change: its attempt sends the body
  // that was approved.
  if (proposal === null || proposal.state !== "awaiting_approval") {
    return { ok: true, value: { kind: "proposal_missing" } };
  }
  if (
    input.now > proposal.expiresAt ||
    input.now > proposal.serviceWindowExpiresAt
  ) {
    advanceWhatsAppProposal(
      input.sql,
      proposal,
      { event: "expire" },
      input.now,
    );
    return { ok: true, value: { kind: "expired" } };
  }
  const body = input.body.trim();
  if (body.length === 0 || body.length > input.maxReplyChars) {
    return { ok: false, error: { code: "whatsapp_proposal_body_invalid" } };
  }
  const version = proposal.version + 1;
  // Keyed, like the receipt digest. Reply text is the most guessable content
  // in the system — "Your order has shipped" — so an unkeyed digest surviving
  // in Actor storage after the ciphertext is dropped would be a confirmation
  // oracle for anyone holding it. Approvers echo this value back opaquely;
  // nothing outside the Actor recomputes it.
  const bodyDigest = await input.cipher.digest(body);
  const sealed = await input.cipher.seal(
    proposal.caseId,
    { kind: "proposal", proposalId: proposal.proposalId, version },
    body,
  );
  if (!(await input.authorizeExecution()))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  recordWhatsAppProposal(input.sql, {
    proposalId: proposal.proposalId,
    version,
    caseId: proposal.caseId,
    customerWaId: proposal.customerWaId,
    author: proposal.author,
    bodyDigest,
    nonceB64: sealed.nonceB64,
    ciphertextB64: sealed.ciphertextB64,
    policyVersion: proposal.policyVersion,
    credentialGeneration: proposal.credentialGeneration,
    serviceWindowExpiresAt: proposal.serviceWindowExpiresAt,
    expiresAt: proposal.expiresAt,
    now: input.now,
  });
  return { ok: true, value: { kind: "versioned", version, bodyDigest } };
}

export type WhatsAppDispatchOutcome =
  | {
      readonly kind: "sent";
      readonly whatsappMessageId: string;
      readonly version: number;
      readonly bodyDigest: string;
    }
  | {
      readonly kind: "stale_approval";
      readonly currentVersion: number;
      readonly currentBodyDigest: string;
    }
  | { readonly kind: "proposal_missing" }
  | { readonly kind: "expired" }
  | { readonly kind: "service_window_closed" }
  | {
      readonly kind: "refused";
      readonly reason:
        WhatsAppSendRefusal | "ownership_conflict" | "authority_moved";
    }
  | { readonly kind: "rejected"; readonly providerCode: string | null }
  | { readonly kind: "send_indeterminate"; readonly reason: string };

/**
 * The send ladder. Order matters: nothing contacts Meta until every durable
 * fact the proposal froze still holds, and nothing is recorded as delivered
 * until Meta returns a WhatsApp message id.
 *
 * The claim stores the version as `sending` with a new attempt id before the
 * call, and only that attempt records the outcome. If the Actor stops during
 * the call, the stored attempt stays; when its lease has passed, the alarm or
 * the next approval fences the Case as `send_indeterminate`.
 */
export async function dispatchWhatsAppReply(
  input: Readonly<{
    sql: SqlStorage;
    authorizeExecution: () => Promise<boolean>;
    scope: OrganisationExecutionScope;
    cipher: WhatsAppContentCipher;
    env: Env;
    proposalId: string;
    approvedVersion: number;
    approvedBodyDigest: string;
    approvedBy: string;
    now: number;
    fetcher: typeof fetch;
    /** Sets the alarm after the claim, so a lost attempt's lease is swept. */
    armAlarm?: () => Promise<unknown>;
  }>,
): Promise<Result<WhatsAppDispatchOutcome, WhatsAppProposalError>> {
  if (!(await input.authorizeExecution()))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const runtime = readWhatsAppRuntime(input.sql);
  if (runtime === null || runtime.disabledAt !== null) {
    return { ok: false, error: { code: "connector_whatsapp_runtime_missing" } };
  }
  if (runtime.organisationId !== input.scope.organisationId)
    return {
      ok: false,
      error: { code: "connector_whatsapp_identity_invalid" },
    };
  if (
    runtime.processing.kind === "paused" &&
    runtime.processing.reason.kind === "send_indeterminate"
  ) {
    return { ok: false, error: { code: "connector_whatsapp_case_fenced" } };
  }
  const proposal = latestWhatsAppProposal(input.sql, input.proposalId);
  if (proposal === null)
    return { ok: true, value: { kind: "proposal_missing" } };
  if (proposal.state === "sent") {
    return proposal.sentMessageId === null
      ? { ok: false, error: { code: "whatsapp_proposal_sent_without_receipt" } }
      : {
          ok: true,
          value: {
            kind: "sent",
            whatsappMessageId: proposal.sentMessageId,
            version: proposal.version,
            bodyDigest: proposal.bodyDigest,
          },
        };
  }
  if (proposal.state === "send_indeterminate") {
    return {
      ok: true,
      value: { kind: "send_indeterminate", reason: "already_indeterminate" },
    };
  }
  if (proposal.state === "expired") {
    return { ok: true, value: { kind: "expired" } };
  }
  if (proposal.state === "sending") {
    // A version left in `sending` past its lease belongs to an attempt that
    // stopped before it recorded its outcome. Pantry cannot prove whether Meta
    // took that message, so the Case is fenced rather than sent again.
    if (abandonSendAttempt(input.sql, proposal, input.now))
      return fencedIndeterminate(
        input.sql,
        proposal,
        "whatsapp_send_attempt_unfinished",
        input.now,
      );
    // The attempt that claimed this version is still inside its lease and
    // records its own outcome. This approval lost the race that the claim
    // settles, so it gets the same answer.
    return {
      ok: true,
      value: {
        kind: "stale_approval",
        currentVersion: proposal.version,
        currentBodyDigest: proposal.bodyDigest,
      },
    };
  }
  if (proposal.state !== "awaiting_approval") {
    return { ok: true, value: { kind: "proposal_missing" } };
  }
  if (
    proposal.version !== input.approvedVersion ||
    proposal.bodyDigest !== input.approvedBodyDigest
  ) {
    return {
      ok: true,
      value: {
        kind: "stale_approval",
        currentVersion: proposal.version,
        currentBodyDigest: proposal.bodyDigest,
      },
    };
  }
  if (input.now > proposal.expiresAt) {
    advanceWhatsAppProposal(
      input.sql,
      proposal,
      { event: "expire" },
      input.now,
    );
    return { ok: true, value: { kind: "expired" } };
  }
  if (input.now >= proposal.serviceWindowExpiresAt) {
    advanceWhatsAppProposal(
      input.sql,
      proposal,
      { event: "expire" },
      input.now,
    );
    return { ok: true, value: { kind: "service_window_closed" } };
  }
  const organisationId = parseOrganisationId(runtime.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    runtime.integrationAccountId,
  );
  if (!organisationId.ok || !integrationAccountId.ok) {
    return {
      ok: false,
      error: { code: "connector_whatsapp_identity_invalid" },
    };
  }
  const authority = await readWhatsAppSendAuthority({
    db: input.scope.database,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    caseId: proposal.caseId,
  });
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  if (authority.kind === "unauthorized") {
    return { ok: true, value: { kind: "refused", reason: authority.reason } };
  }
  if (
    authority.customerWaId !== proposal.customerWaId ||
    authority.policyVersion !== proposal.policyVersion ||
    authority.credentialGeneration !== proposal.credentialGeneration ||
    authority.supportBindingId !== runtime.supportBindingId ||
    authority.bindingRevision !== runtime.bindingRevision
  ) {
    return { ok: true, value: { kind: "refused", reason: "authority_moved" } };
  }
  const ownershipAllowsSend =
    proposal.author === "agent"
      ? authority.ownership.kind === "agent_active" &&
        authority.handoffRequestedAt === null
      : authority.ownership.kind === "human_owned";
  if (!ownershipAllowsSend) {
    return {
      ok: true,
      value: { kind: "refused", reason: "ownership_conflict" },
    };
  }
  if (proposal.nonceB64 === null || proposal.ciphertextB64 === null) {
    return { ok: true, value: { kind: "proposal_missing" } };
  }
  const opened = await input.cipher.open(
    proposal.caseId,
    {
      kind: "proposal",
      proposalId: proposal.proposalId,
      version: proposal.version,
    },
    { nonceB64: proposal.nonceB64, ciphertextB64: proposal.ciphertextB64 },
  );
  if (!opened.ok) return { ok: false, error: { code: opened.error.code } };
  const frozenDigest = await input.cipher.digest(opened.value);
  if (frozenDigest !== proposal.bodyDigest) {
    return {
      ok: false,
      error: { code: "whatsapp_proposal_body_digest_mismatch" },
    };
  }
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  const credential = await resolveWhatsAppOrganisationCredential({
    env: input.env,
    scope: input.scope,
    integrationAccountId: integrationAccountId.value,
    now: input.now,
  });
  if (!credential.ok)
    return { ok: false, error: { code: credential.error.code } };
  if (credential.value.credentialGeneration !== proposal.credentialGeneration) {
    return { ok: true, value: { kind: "refused", reason: "authority_moved" } };
  }
  if (!(await isActorExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "connector_placement_conflict" } };
  // Everything above this line is a gate that can refuse without contacting
  // Meta. This claim is the point of no return, and it is atomic: a second
  // approval that raced through the same gates finds the proposal taken.
  if (!(await input.authorizeExecution()))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  const claim = claimWhatsAppProposalForSend(input.sql, {
    proposalId: proposal.proposalId,
    version: proposal.version,
    bodyDigest: proposal.bodyDigest,
    now: input.now,
  });
  if (claim.kind === "already_sent") {
    return {
      ok: true,
      value: {
        kind: "sent",
        whatsappMessageId: claim.whatsappMessageId,
        version: proposal.version,
        bodyDigest: proposal.bodyDigest,
      },
    };
  }
  if (claim.kind !== "claimed") {
    return {
      ok: true,
      value: {
        kind: "stale_approval",
        currentVersion: proposal.version,
        currentBodyDigest: proposal.bodyDigest,
      },
    };
  }
  const attempt = claim.proposal;
  // The stored attempt is the fence; the alarm only brings its sweep sooner.
  // A failed arm does not stop the send: the next arm of the Connector
  // covers the attempt's lease.
  try {
    await input.armAlarm?.();
  } catch {
    traceWarn("connector.whatsapp_send_alarm_failed", {
      requestId: newRequestId(),
    });
  }
  const outcome = await sendWhatsAppText({
    phoneNumberId: authority.phoneNumberId,
    recipientWaId: authority.customerWaId,
    body: opened.value,
    accessToken: credential.value.accessToken,
    fetcher: input.fetcher,
  });
  if (outcome.kind === "indeterminate") {
    traceWarn("connector.whatsapp_send_indeterminate", {
      requestId: newRequestId(),
      reason: outcome.reason,
    });
    if (
      !advanceWhatsAppProposal(
        input.sql,
        attempt,
        { event: "outcome_unknown" },
        input.now,
      ).ok
    )
      return settledElsewhere(input.sql, attempt, outcome.kind);
    return fencedIndeterminate(input.sql, attempt, outcome.reason, input.now);
  }
  if (outcome.kind === "rejected") {
    // Meta refused the message, so it was not sent. The version waits for a
    // new decision only while its deadlines hold; a version that another
    // writer moved during the call keeps that move.
    const current = latestWhatsAppProposal(input.sql, attempt.proposalId);
    const deadlinesOpen =
      current !== null &&
      input.now <= current.expiresAt &&
      input.now < current.serviceWindowExpiresAt;
    const returned = deadlinesOpen
      ? advanceWhatsAppProposal(
          input.sql,
          attempt,
          { event: "provider_rejected" },
          input.now,
          { deadlines_open: () => deadlinesOpen },
        )
      : advanceWhatsAppProposal(
          input.sql,
          attempt,
          { event: "provider_rejected_late" },
          input.now,
          { deadlines_passed: () => !deadlinesOpen },
        );
    if (!returned.ok) return settledElsewhere(input.sql, attempt, outcome.kind);
    return returned.value === "expired"
      ? { ok: true, value: { kind: "expired" } }
      : {
          ok: true,
          value: { kind: "rejected", providerCode: outcome.error.providerCode },
        };
  }
  const sealedOutbound = await input.cipher.seal(
    proposal.caseId,
    { kind: "message", providerMessageId: outcome.whatsappMessageId },
    opened.value,
  );
  // No `await` separates the move from the envelope entry, so a purge or a
  // close that came first leaves no entry behind.
  if (
    !advanceWhatsAppProposal(
      input.sql,
      attempt,
      {
        event: "provider_accepted",
        sentMessageId: outcome.whatsappMessageId,
      },
      input.now,
    ).ok
  )
    return settledElsewhere(input.sql, attempt, outcome.kind);
  if (readWhatsAppCase(input.sql, proposal.caseId)?.closedAt === null)
    appendWhatsAppEnvelopeEntry(input.sql, {
      caseId: proposal.caseId,
      direction: "outbound",
      providerMessageId: outcome.whatsappMessageId,
      nonceB64: sealedOutbound.nonceB64,
      ciphertextB64: sealedOutbound.ciphertextB64,
      bytes: sealedOutbound.bytes,
      occurredAt: input.now,
      limits: runtime.limits,
    });
  await recordWhatsAppMessageReceipt({
    db: input.scope.database,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    providerMessageId: outcome.whatsappMessageId,
    customerWaId: authority.customerWaId,
    caseId: proposal.caseId,
    direction: "outbound",
    bodyDigest: await input.cipher.digest(opened.value),
    bodyBytes: sealedOutbound.bytes,
    policyVersion: proposal.policyVersion,
    providerTimestamp: input.now,
    now: input.now,
  });
  return {
    ok: true,
    value: {
      kind: "sent",
      whatsappMessageId: outcome.whatsappMessageId,
      version: proposal.version,
      bodyDigest: proposal.bodyDigest,
    },
  };
}

/**
 * The answer for an attempt whose version another writer moved during the
 * call to Meta: a revoke, a purge on disable, or the alarm's fence. That move
 * stays, and the attempt records nothing.
 */
function settledElsewhere(
  sql: SqlStorage,
  attempt: WhatsAppProposalRow,
  providerOutcome: string,
): Result<WhatsAppDispatchOutcome, WhatsAppProposalError> {
  const current = latestWhatsAppProposal(sql, attempt.proposalId);
  traceWarn("connector.whatsapp_send_settled_after_move", {
    requestId: newRequestId(),
    reason: providerOutcome,
    state: current?.state ?? "missing",
  });
  if (current === null || current.version !== attempt.version)
    return { ok: true, value: { kind: "proposal_missing" } };
  switch (current.state) {
    case "sent":
      return current.sentMessageId === null
        ? {
            ok: false,
            error: { code: "whatsapp_proposal_sent_without_receipt" },
          }
        : {
            ok: true,
            value: {
              kind: "sent",
              whatsappMessageId: current.sentMessageId,
              version: current.version,
              bodyDigest: current.bodyDigest,
            },
          };
    case "send_indeterminate":
      return {
        ok: true,
        value: { kind: "send_indeterminate", reason: "already_indeterminate" },
      };
    case "expired":
      return { ok: true, value: { kind: "expired" } };
    default:
      return { ok: true, value: { kind: "proposal_missing" } };
  }
}

/**
 * Ends an attempt whose lease has passed as `send_indeterminate`. Returns
 * false while the attempt still holds its lease, or when the row moved.
 */
function abandonSendAttempt(
  sql: SqlStorage,
  attempt: WhatsAppProposalRow,
  now: number,
): boolean {
  const leaseEnded = now >= attempt.updatedAt + WHATSAPP_SEND_ATTEMPT_LEASE_MS;
  return (
    leaseEnded &&
    advanceWhatsAppProposal(sql, attempt, { event: "abandon" }, now, {
      attempt_lease_ended: () => leaseEnded,
    }).ok
  );
}

/**
 * Records the one outcome Pantry cannot prove. The proposal body is already
 * deleted by the move; the account stops taking new agent work, and only an
 * explicit operator resolution moves the Case forward.
 */
function fencedIndeterminate(
  sql: SqlStorage,
  proposal: WhatsAppProposalRow,
  reason: string,
  now: number,
): Result<WhatsAppDispatchOutcome, WhatsAppProposalError> {
  pauseWhatsAppRuntime(sql, {
    reason: {
      kind: "send_indeterminate",
      proposalId: proposal.proposalId,
      caseId: proposal.caseId,
    },
    now,
  });
  return { ok: true, value: { kind: "send_indeterminate", reason } };
}

/**
 * The alarm's exit for `sending` (Refactor 15): every attempt whose lease has
 * passed stopped with an Actor instance before it recorded its outcome. Each
 * becomes `send_indeterminate` and fences its account, never `expired`, so no
 * later reply goes out until a person states what the customer received.
 * Returns the operator notices to deliver.
 */
export function fenceAbandonedWhatsAppSends(
  sql: SqlStorage,
  now: number,
): readonly string[] {
  const notices: string[] = [];
  for (const proposal of openWhatsAppProposals(sql, null)) {
    if (proposal.state !== "sending" || !abandonSendAttempt(sql, proposal, now))
      continue;
    traceWarn("connector.whatsapp_send_indeterminate", {
      requestId: newRequestId(),
      reason: "whatsapp_send_attempt_unfinished",
    });
    const paused = pauseWhatsAppRuntime(sql, {
      reason: {
        kind: "send_indeterminate",
        proposalId: proposal.proposalId,
        caseId: proposal.caseId,
      },
      now,
    });
    if (paused.pendingNoticeKey !== null) notices.push(paused.pendingNoticeKey);
  }
  return notices;
}

type WhatsAppDisposalOutcome =
  | { readonly kind: "disposed"; readonly state: WhatsAppProposalRow["state"] }
  | { readonly kind: "proposal_missing" };

/**
 * Terminal disposal for reject, takeover, and revoke. The stored body is
 * deleted in the same statement, so no path can leave a readable draft. A
 * version that is being sent can only be revoked; its attempt then records
 * nothing.
 */
export function disposeWhatsAppProposal(
  input: Readonly<{
    sql: SqlStorage;
    proposalId: string;
    state: Extract<
      WhatsAppProposalRow["state"],
      "rejected" | "taken_over" | "revoked" | "expired"
    >;
    now: number;
  }>,
): WhatsAppDisposalOutcome {
  const proposal = latestWhatsAppProposal(input.sql, input.proposalId);
  if (proposal === null) return { kind: "proposal_missing" };
  const moved = advanceWhatsAppProposal(
    input.sql,
    proposal,
    { event: WHATSAPP_DISPOSAL_EVENTS[input.state] },
    input.now,
  );
  return moved.ok
    ? { kind: "disposed", state: moved.value }
    : { kind: "proposal_missing" };
}

/**
 * Operator resolution of a fenced Case. Pantry cannot prove the outcome, so
 * the operator states it: `delivered` records the message id they observed in
 * WhatsApp, `not_delivered` returns the proposal for a fresh decision.
 */
export type WhatsAppIndeterminateResolution =
  | { readonly kind: "delivered"; readonly whatsappMessageId: string }
  | { readonly kind: "not_delivered" };

export function resolveWhatsAppIndeterminateSend(
  input: Readonly<{
    sql: SqlStorage;
    proposalId: string;
    resolution: WhatsAppIndeterminateResolution;
    now: number;
  }>,
): Result<
  { readonly kind: "resolved"; readonly state: WhatsAppProposalRow["state"] },
  WhatsAppProposalError
> {
  const proposal = latestWhatsAppProposal(input.sql, input.proposalId);
  if (proposal === null || proposal.state !== "send_indeterminate") {
    return {
      ok: false,
      error: { code: "whatsapp_proposal_not_indeterminate" },
    };
  }
  const resolved =
    input.resolution.kind === "delivered"
      ? advanceWhatsAppProposal(
          input.sql,
          proposal,
          {
            event: "operator_saw_delivery",
            sentMessageId: input.resolution.whatsappMessageId,
          },
          input.now,
        )
      : advanceWhatsAppProposal(
          input.sql,
          proposal,
          { event: "operator_saw_no_delivery" },
          input.now,
        );
  if (!resolved.ok)
    return {
      ok: false,
      error: { code: "whatsapp_proposal_not_indeterminate" },
    };
  return { ok: true, value: { kind: "resolved", state: resolved.value } };
}

/**
 * Takeover invalidates and deletes any open proposal for the Case before the
 * operator can compose their own reply. A close revokes a version that is
 * being sent as well; a takeover and a new draft leave it to its attempt.
 */
/**
 * A human-authored reply. It still goes through the same send ladder, so the
 * service window, organisation credential, account state, and ownership gates apply;
 * it needs no second-person approval because the human is the author.
 */
export async function composeWhatsAppHumanReply(
  input: Readonly<{
    sql: SqlStorage;
    authorizeExecution: () => Promise<boolean>;
    cipher: WhatsAppContentCipher;
    caseId: string;
    proposalId: string;
    body: string;
    maxReplyChars: number;
    now: number;
    expiresAt: number;
  }>,
): Promise<
  Result<
    {
      readonly proposalId: string;
      readonly version: number;
      readonly bodyDigest: string;
    },
    WhatsAppProposalError
  >
> {
  if (!(await input.authorizeExecution()))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  const runtime = readWhatsAppRuntime(input.sql);
  const supportCase = readWhatsAppCase(input.sql, input.caseId);
  if (
    runtime === null ||
    runtime.disabledAt !== null ||
    supportCase === null ||
    supportCase.closedAt !== null
  ) {
    return {
      ok: false,
      error: { code: "connector_whatsapp_case_unavailable" },
    };
  }
  const body = input.body.trim();
  if (body.length === 0 || body.length > input.maxReplyChars) {
    return { ok: false, error: { code: "whatsapp_proposal_body_invalid" } };
  }
  // Keyed, like the receipt digest. Reply text is the most guessable content
  // in the system — "Your order has shipped" — so an unkeyed digest surviving
  // in Actor storage after the ciphertext is dropped would be a confirmation
  // oracle for anyone holding it. Approvers echo this value back opaquely;
  // nothing outside the Actor recomputes it.
  const bodyDigest = await input.cipher.digest(body);
  const sealed = await input.cipher.seal(
    input.caseId,
    { kind: "proposal", proposalId: input.proposalId, version: 1 },
    body,
  );
  if (!(await input.authorizeExecution()))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  recordWhatsAppProposal(input.sql, {
    proposalId: input.proposalId,
    version: 1,
    caseId: input.caseId,
    customerWaId: supportCase.customerWaId,
    author: "human",
    bodyDigest,
    nonceB64: sealed.nonceB64,
    ciphertextB64: sealed.ciphertextB64,
    policyVersion: runtime.policyVersion,
    credentialGeneration: runtime.credentialGeneration,
    serviceWindowExpiresAt: supportCase.serviceWindowExpiresAt,
    expiresAt: input.expiresAt,
    now: input.now,
  });
  return {
    ok: true,
    value: { proposalId: input.proposalId, version: 1, bodyDigest },
  };
}

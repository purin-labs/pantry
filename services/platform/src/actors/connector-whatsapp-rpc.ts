import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { assertNever, isRecord, hasExactKeys } from "@purin-labs/std";
import {
  authorizeSessionTurnExecution,
  parseSessionTurnExecution,
  type SessionTurnExecution,
} from "../chat/turn-access";
import type { DurableObjectStorage } from "@cloudflare/workers-types";

import {
  closeWhatsAppCaseConversationWindow,
  openWhatsAppCaseConversationWindow,
  projectWhatsAppReplyProposal,
  recordWhatsAppDeliveryStatus,
  recordWhatsAppMessageReceipt,
  setWhatsAppCaseOwnership,
  clearWhatsAppCaseHandoff,
  whatsappConversationWindowCaseId,
  type WhatsAppReplyProposalLifecycle,
} from "../data/whatsapp";
import type { Env } from "@purin-labs/kernel/env";
import {
  newRequestId,
  parseCaseId,
  parseIntegrationAccountId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { isActorExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import {
  parseWhatsAppCustomerId,
  parseWhatsAppMessageId,
} from "../whatsapp/identifiers";
import { admitWhatsAppSupportCase } from "./whatsapp-case-admission";
import {
  composeWhatsAppHumanReply,
  dispatchWhatsAppReply,
  disposeWhatsAppProposal,
  editWhatsAppProposal,
  previewWhatsAppProposal,
  resolveWhatsAppIndeterminateSend,
  type WhatsAppDispatchOutcome,
  type WhatsAppIndeterminateResolution,
  type WhatsAppProposalPreviewOutcome,
} from "./connector-whatsapp-proposal";
import {
  beginWhatsAppAdmission,
  clearWhatsAppHandoff,
  commitWhatsAppAdmission,
  deferWhatsAppMessage,
  closeWhatsAppCase,
  countOpenWhatsAppCases,
  countWhatsAppAdmissionsSince,
  deferWhatsAppNotice,
  latestWhatsAppProposal,
  pauseWhatsAppRuntime,
  readWhatsAppCase,
  readWhatsAppEnvelope,
  readWhatsAppRuntime,
  recordWhatsAppOperatorNotice,
  recordWhatsAppStatus,
  recordWhatsAppUnsupportedMessage,
  invalidateOpenWhatsAppProposal,
  scheduleWhatsAppCaseForAgent,
  setWhatsAppCaseOwnership as setConnectorCaseOwnership,
  utcDayKey,
  whatsAppTokenWindowTotals,
  type WhatsAppOwnership,
  type WhatsAppPauseReason,
  type WhatsAppRuntimeSnapshot,
} from "./connector-whatsapp";
import { deliverWhatsAppOperatorNotice } from "./whatsapp-operator-notice";
import {
  createWhatsAppContentCipher,
  type WhatsAppContentCipher,
} from "./whatsapp-active-content";
import type { Variant } from "@purin-labs/type-utils";
import type { WhatsAppCasePanelEntry } from "@purin-labs/control-api";

/**
 * The Connector's WhatsApp request surface. Webhook admission runs
 * synchronously against Durable Object storage so the Worker can acknowledge
 * Meta only after the event is durable, and every operator action revalidates
 * the runtime before touching content.
 */

export type WhatsAppRpcDeps = {
  readonly storage: DurableObjectStorage;
  readonly env: Env;
};

export type WhatsAppExecutionDeps = WhatsAppRpcDeps & {
  readonly scope: OrganisationExecutionScope;
};

export type WhatsAppReplyOrigin =
  | Readonly<{ kind: "operator"; execution?: never }>
  | Readonly<{ kind: "automatic"; execution?: never }>
  | Readonly<{ kind: "session_turn"; execution: SessionTurnExecution }>;

export type WhatsAppReplyExecutionDeps = WhatsAppExecutionDeps & {
  readonly origin: WhatsAppReplyOrigin;
};

export function parseWhatsAppReplyOrigin(
  raw: unknown,
): WhatsAppReplyOrigin | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "operator" && hasExactKeys(raw, ["kind"]))
    return { kind: "operator" };
  if (raw.kind === "session_turn" && hasExactKeys(raw, ["kind", "execution"])) {
    const execution = parseSessionTurnExecution(raw.execution);
    return execution === null ? null : { kind: "session_turn", execution };
  }
  // Automatic dispatch is internal and is never accepted from an RPC request.
  return null;
}

async function isWhatsAppReplyExecutionActive(
  deps: WhatsAppReplyExecutionDeps,
): Promise<boolean> {
  if (!(await isActorExecutionActive(deps.storage.sql, deps.scope)))
    return false;
  switch (deps.origin.kind) {
    case "automatic":
    case "operator":
      return true;
    case "session_turn": {
      const authorized = await authorizeSessionTurnExecution(
        deps.env.DB,
        deps.scope.database,
        deps.scope.organisationId,
        deps.origin.execution,
        deps.scope.accountAccess,
      );
      return (
        authorized &&
        (await isActorExecutionActive(deps.storage.sql, deps.scope))
      );
    }
    default:
      return assertNever(deps.origin);
  }
}

type WhatsAppRpcError = { readonly code: string };

export type WhatsAppDisposalResult = {
  readonly kind: "disposed" | "proposal_missing";
};
export type WhatsAppResolutionResult = { readonly state: string };
export type WhatsAppTakeoverResult = {
  readonly invalidatedProposalId: string | null;
};
export type WhatsAppReturnResult = { readonly kind: "returned" };
export type WhatsAppCloseResult = { readonly kind: "closed" };
export type WhatsAppHumanReplyResult = {
  readonly proposalId: string;
  readonly version: number;
  readonly bodyDigest: string;
};

export type WhatsAppAdmissionResult =
  | {
      readonly kind: "admitted";
      readonly caseId: string;
      readonly conversationWindowSequence: number;
      readonly customerWaId: string;
      readonly providerMessageId: string;
      readonly debounceDueAt: number;
    }
  | { readonly kind: "duplicate"; readonly caseId: string }
  | { readonly kind: "paused"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly messageType: string }
  | { readonly kind: "status_recorded"; readonly status: string }
  | { readonly kind: "status_duplicate"; readonly status: string }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "not_enabled" };

export type WhatsAppRuntimeStatus = WhatsAppRuntimeSnapshot & {
  readonly usage: {
    readonly activeCases: number;
    readonly admittedLastHour: number;
    readonly tokens: { readonly reserved: number; readonly consumed: number };
  };
};

export type WhatsAppCasePanel = {
  readonly caseId: string;
  readonly customerWaId: string;
  readonly ownership: WhatsAppOwnership;
  readonly handoffRequestedAt: number | null;
  readonly handoffReason: string | null;
  readonly serviceWindowExpiresAt: number;
  readonly messages: readonly WhatsAppCasePanelEntry[];
};

/** What the one Inbox shows for one open Case. It is not stored for the list. */
export type WhatsAppConversationHead = {
  readonly caseId: string;
  readonly preview: string | null;
  readonly lastDirection: "inbound" | "outbound" | null;
  readonly lastInboundAt: number | null;
};

const WHATSAPP_PREVIEW_MAX = 200;

async function cipherFor(
  deps: WhatsAppRpcDeps,
  runtime: WhatsAppRuntimeSnapshot,
): Promise<Result<WhatsAppContentCipher, WhatsAppRpcError>> {
  const cipher = await createWhatsAppContentCipher({
    root: deps.env.DATA_ENCRYPTION_ROOT,
    organisationId: runtime.organisationId,
    integrationAccountId: runtime.integrationAccountId,
  });
  return cipher.ok ? cipher : { ok: false, error: { code: cipher.error.code } };
}

function requireRuntime(
  deps: WhatsAppRpcDeps,
): Result<WhatsAppRuntimeSnapshot, WhatsAppRpcError> {
  const runtime = readWhatsAppRuntime(deps.storage.sql);
  return runtime === null || runtime.disabledAt !== null
    ? { ok: false, error: { code: "connector_whatsapp_runtime_missing" } }
    : { ok: true, value: runtime };
}

export type WhatsAppAdmissionRequest =
  | {
      readonly kind: "text_message";
      readonly customerWaId: string;
      readonly providerMessageId: string;
      readonly providerTimestamp: number;
      readonly body: string;
    }
  | {
      readonly kind: "unsupported_message";
      readonly customerWaId: string;
      readonly providerMessageId: string;
      readonly messageType: string;
    }
  | {
      readonly kind: "status";
      readonly whatsappMessageId: string;
      readonly status: "sent" | "delivered" | "read" | "failed";
      readonly statusAt: number;
      readonly failureCode: string | null;
    };

/**
 * Durably admits one parsed webhook event. Dedupe, envelope append, and
 * debounce scheduling happen inside one storage transaction; the Case trigger
 * and D1 projections follow, and every one of them is idempotent so a Meta
 * retry converges rather than duplicating work.
 */
export async function acceptWhatsAppEvent(
  deps: WhatsAppExecutionDeps,
  input: WhatsAppAdmissionRequest,
  now: number,
): Promise<Result<WhatsAppAdmissionResult, WhatsAppRpcError>> {
  if (!(await isActorExecutionActive(deps.storage.sql, deps.scope))) {
    return { ok: false, error: { code: "connector_placement_conflict" } };
  }
  const runtime = requireRuntime(deps);
  if (!runtime.ok) {
    // Plan 32 leaves a connected number processing-disabled until the owner
    // publishes a policy. Meta still delivers to it, so this is an ordinary
    // acknowledged event: failing would make the plan's default state a
    // permanent Meta retry storm against a number that is working as intended.
    return { ok: true, value: { kind: "not_enabled" } };
  }
  if (runtime.value.organisationId !== deps.scope.organisationId) {
    return { ok: false, error: { code: "connector_placement_conflict" } };
  }
  if (input.kind === "status") {
    const recorded = deps.storage.transactionSync(() =>
      recordWhatsAppStatus(deps.storage.sql, {
        whatsappMessageId: input.whatsappMessageId,
        status: input.status,
        statusAt: input.statusAt,
        failureCode: input.failureCode,
        now,
      }),
    );
    await projectDeliveryStatus(deps, runtime.value, input, now);
    return {
      ok: true,
      value:
        recorded.kind === "duplicate"
          ? { kind: "status_duplicate", status: input.status }
          : { kind: "status_recorded", status: input.status },
    };
  }
  if (input.kind === "unsupported_message") {
    const recorded = deps.storage.transactionSync(() =>
      recordWhatsAppUnsupportedMessage(deps.storage.sql, {
        providerMessageId: input.providerMessageId,
        customerWaId: input.customerWaId,
        policyVersion: runtime.value.policyVersion,
        now,
      }),
    );
    if (recorded.kind === "recorded") {
      // Plan 32 pauses *that item*, not the number: the message is already
      // recorded `skipped` and never reaches an agent, so a photo from one
      // customer must not stop text support for everyone else.
      await notifyUnsupportedItem(
        deps,
        runtime.value,
        {
          kind: "unsupported_message_type",
          providerMessageId: input.providerMessageId,
          messageType: input.messageType,
        },
        now,
      );
    }
    return {
      ok: true,
      value: { kind: "unsupported", messageType: input.messageType },
    };
  }
  if (input.providerTimestamp < runtime.value.activationFloor) {
    return {
      ok: true,
      value: { kind: "ignored", reason: "before_activation_floor" },
    };
  }
  const cipher = await cipherFor(deps, runtime.value);
  if (!(await isActorExecutionActive(deps.storage.sql, deps.scope))) {
    return { ok: false, error: { code: "connector_placement_conflict" } };
  }
  if (!cipher.ok) return cipher;
  const declaredBytes = new TextEncoder().encode(input.body).byteLength;
  const reserved = deps.storage.transactionSync(() =>
    beginWhatsAppAdmission(deps.storage.sql, {
      providerMessageId: input.providerMessageId,
      customerWaId: input.customerWaId,
      providerTimestamp: input.providerTimestamp,
      declaredBytes,
      limits: runtime.value.limits,
      caseIdFor: (conversationWindowSequence: number) => {
        const caseId = whatsappConversationWindowCaseId(
          runtime.value.integrationAccountId,
          input.customerWaId,
          conversationWindowSequence,
        );
        if (!caseId.ok) throw new Error("whatsapp case id invariant failed");
        return caseId.value;
      },
      now,
    }),
  );
  if (reserved.kind === "rejected") {
    // The message that trips a limit is still durable: it is recorded
    // `deferred` so a resume can replay it and an operator can see it
    // existed. Losing it would be unrecoverable — there is no inbox to
    // refetch from, and Meta has already been told the delivery succeeded.
    deps.storage.transactionSync(() =>
      deferWhatsAppMessage(deps.storage.sql, {
        providerMessageId: input.providerMessageId,
        customerWaId: input.customerWaId,
        policyVersion: runtime.value.policyVersion,
        now,
      }),
    );
    await pauseAndNotify(deps, runtime.value, reserved.reason, now);
    return {
      ok: true,
      value: { kind: "paused", reason: reserved.reason.kind },
    };
  }
  if (reserved.kind === "duplicate") {
    // A Meta retry lands here. The message is already durable, but an earlier
    // attempt may have failed *after* storing it and before projecting the
    // conversationWindow — so the projection is re-driven rather than skipped, otherwise
    // the retry that exists to repair it would silently short-circuit.
    const repaired = await projectAdmittedMessage(
      deps,
      runtime.value,
      input,
      reserved,
      null,
      now,
    );
    return repaired.ok
      ? { ok: true, value: { kind: "duplicate", caseId: reserved.caseId } }
      : repaired;
  }
  const sealed = await cipher.value.seal(
    reserved.caseId,
    { kind: "message", providerMessageId: input.providerMessageId },
    input.body,
  );
  const bodyDigest = await cipher.value.digest(input.body);
  if (!(await isActorExecutionActive(deps.storage.sql, deps.scope))) {
    return { ok: false, error: { code: "connector_placement_conflict" } };
  }
  const committed = deps.storage.transactionSync(() =>
    commitWhatsAppAdmission(deps.storage.sql, {
      caseId: reserved.caseId,
      providerMessageId: input.providerMessageId,
      customerWaId: input.customerWaId,
      providerTimestamp: input.providerTimestamp,
      nonceB64: sealed.nonceB64,
      ciphertextB64: sealed.ciphertextB64,
      bytes: sealed.bytes,
      limits: runtime.value.limits,
      policyVersion: runtime.value.policyVersion,
      now,
    }),
  );
  if (committed.kind === "duplicate") {
    return { ok: true, value: { kind: "duplicate", caseId: reserved.caseId } };
  }
  if (committed.kind === "case_closed") {
    // Nothing was stored. Failing tells the gateway not to ACK, so Meta
    // redelivers and the message opens a new Case instead of vanishing.
    return {
      ok: false,
      error: { code: "connector_whatsapp_case_unavailable" },
    };
  }
  const projected = await projectAdmittedMessage(
    deps,
    runtime.value,
    input,
    reserved,
    { bytes: sealed.bytes, bodyDigest },
    now,
  );
  if (!projected.ok) return projected;
  return {
    ok: true,
    value: {
      kind: "admitted",
      caseId: reserved.caseId,
      conversationWindowSequence: reserved.conversationWindowSequence,
      customerWaId: input.customerWaId,
      providerMessageId: input.providerMessageId,
      debounceDueAt: reserved.debounceDueAt,
    },
  };
}

/**
 * Mirrors one admitted message into D1. A projection failure is not swallowed:
 * the Connector already holds the message, but a Case with no D1 conversationWindow can
 * never be replied to, so the caller reports failure and Meta retries.
 */
async function projectAdmittedMessage(
  deps: WhatsAppExecutionDeps,
  runtime: WhatsAppRuntimeSnapshot,
  input: Variant<WhatsAppAdmissionRequest, "text_message">,
  reserved: Readonly<{
    caseId: string;
    conversationWindowSequence: number;
    serviceWindowExpiresAt: number;
  }>,
  /** Null on a Meta retry, where the receipt already exists. */
  body: Readonly<{ bytes: number; bodyDigest: string }> | null,
  now: number,
): Promise<Result<null, WhatsAppRpcError>> {
  const caseId = reserved.caseId;
  const organisationId = parseOrganisationId(runtime.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    runtime.integrationAccountId,
  );
  const customerWaId = parseWhatsAppCustomerId(input.customerWaId);
  const parsedCaseId = parseCaseId(caseId);
  if (
    !organisationId.ok ||
    !integrationAccountId.ok ||
    !customerWaId.ok ||
    !parsedCaseId.ok
  ) {
    return {
      ok: false,
      error: { code: "whatsapp_projection_identity_invalid" },
    };
  }
  const conversationWindow = await openWhatsAppCaseConversationWindow({
    db: deps.scope.database,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    customerWaId: customerWaId.value,
    caseId: parsedCaseId.value,
    conversationWindowSequence: reserved.conversationWindowSequence,
    supportBindingId: runtime.supportBindingId,
    bindingRevision: runtime.bindingRevision,
    policyVersion: runtime.policyVersion,
    serviceWindowExpiresAt: reserved.serviceWindowExpiresAt,
    now,
  });
  if (!conversationWindow.ok)
    return { ok: false, error: { code: conversationWindow.error.code } };
  if (body !== null) {
    await recordWhatsAppMessageReceipt({
      db: deps.scope.database,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      providerMessageId: input.providerMessageId,
      customerWaId: customerWaId.value,
      caseId,
      direction: "inbound",
      bodyDigest: body.bodyDigest,
      bodyBytes: body.bytes,
      policyVersion: runtime.policyVersion,
      providerTimestamp: input.providerTimestamp,
      now,
    });
  }
  const admitted = await admitWhatsAppSupportCase(deps.env, {
    scope: deps.scope,
    organisationId: runtime.organisationId,
    integrationAccountId: runtime.integrationAccountId,
    customerWaId: input.customerWaId,
    caseId,
    providerMessageIds: [input.providerMessageId],
    supportBindingId: runtime.supportBindingId,
    bindingRevision: runtime.bindingRevision,
    policyVersion: runtime.policyVersion,
    receivedAt: now,
  });
  return admitted.ok
    ? { ok: true, value: null }
    : { ok: false, error: { code: admitted.error.code } };
}

async function projectDeliveryStatus(
  deps: WhatsAppExecutionDeps,
  runtime: WhatsAppRuntimeSnapshot,
  input: Variant<WhatsAppAdmissionRequest, "status">,
  now: number,
): Promise<void> {
  const organisationId = parseOrganisationId(runtime.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    runtime.integrationAccountId,
  );
  const messageId = parseWhatsAppMessageId(input.whatsappMessageId);
  if (!organisationId.ok || !integrationAccountId.ok || !messageId.ok) return;
  await recordWhatsAppDeliveryStatus({
    db: deps.scope.database,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    whatsappMessageId: messageId.value,
    status: input.status,
    statusAt: input.statusAt,
    failureCode: input.failureCode,
    now,
  });
}

/**
 * Raises an item-scoped notice without stopping the number. Used where Plan 32
 * pauses one item rather than the account.
 */
async function notifyUnsupportedItem(
  deps: WhatsAppExecutionDeps,
  runtime: WhatsAppRuntimeSnapshot,
  reason: WhatsAppPauseReason,
  now: number,
): Promise<void> {
  const noticeKey = deps.storage.transactionSync(() =>
    recordWhatsAppOperatorNotice(deps.storage.sql, {
      reason,
      policyVersion: runtime.policyVersion,
      now,
    }),
  );
  if (noticeKey === null) return;
  await notifyOperator(deps, runtime, noticeKey, now);
}

/**
 * Pausing and notifying are one operator-visible event. The pause is durable
 * first; the notice is best effort, and a failed delivery leaves the receipt
 * un-notified so the next pause on the same cause tries again.
 */
async function pauseAndNotify(
  deps: WhatsAppExecutionDeps,
  runtime: WhatsAppRuntimeSnapshot,
  reason: WhatsAppPauseReason,
  now: number,
): Promise<void> {
  const paused = deps.storage.transactionSync(() =>
    pauseWhatsAppRuntime(deps.storage.sql, { reason, now }),
  );
  if (paused.pendingNoticeKey === null) return;
  await notifyOperator(deps, runtime, paused.pendingNoticeKey, now);
}

/**
 * Best-effort delivery of one already-recorded notice. A failure leaves the
 * notice undelivered so the next occurrence of the same cause tries again.
 */
export async function notifyOperator(
  deps: WhatsAppExecutionDeps,
  runtime: WhatsAppRuntimeSnapshot,
  noticeKey: string,
  now: number,
): Promise<void> {
  if (
    runtime.organisationId !== deps.scope.organisationId ||
    !(await isActorExecutionActive(deps.storage.sql, deps.scope))
  )
    return;
  const account = await deps.scope.database
    .prepare(
      `SELECT display_phone_number AS displayPhoneNumber
       FROM whatsapp_phone_number_account
      WHERE integration_account_id = ? AND organisation_id = ?`,
    )
    .bind(runtime.integrationAccountId, runtime.organisationId)
    .first<{ readonly displayPhoneNumber: string }>();
  if (account === null) return;
  const delivered = await deliverWhatsAppOperatorNotice({
    env: deps.env,
    sql: deps.storage.sql,
    scope: deps.scope,
    displayPhoneNumber: account.displayPhoneNumber,
    noticeKey,
    now,
    fetcher: runtimeFetch,
  });
  // An undelivered notice stays queued. Backing it off keeps the sweep from
  // hammering an unreachable destination while still reaching an operator who
  // selects a channel later.
  if (!delivered.ok || delivered.value.kind === "undeliverable") {
    deferWhatsAppNotice(deps.storage.sql, noticeKey, now);
  }
}

export function inspectWhatsAppRuntime(
  deps: WhatsAppRpcDeps,
  now: number,
): WhatsAppRuntimeStatus | null {
  const runtime = readWhatsAppRuntime(deps.storage.sql);
  if (runtime === null) return null;
  return {
    ...runtime,
    usage: {
      activeCases: countOpenWhatsAppCases(deps.storage.sql, now),
      admittedLastHour: countWhatsAppAdmissionsSince(
        deps.storage.sql,
        now - 3_600_000,
      ),
      tokens: whatsAppTokenWindowTotals(deps.storage.sql, utcDayKey(now)),
    },
  };
}

/** The temporary active-Case panel. Served `no-store`; nothing is cached. */
/**
 * The newest customer text and the last direction of each open Case that the
 * caller names. It decrypts one message for each Case, and a Case that this
 * Connector does not hold has no head.
 */
export async function readWhatsAppConversationHeads(
  deps: WhatsAppExecutionDeps,
  caseIds: readonly string[],
): Promise<Result<readonly WhatsAppConversationHead[], WhatsAppRpcError>> {
  if (!(await isActorExecutionActive(deps.storage.sql, deps.scope))) {
    return { ok: false, error: { code: "connector_placement_conflict" } };
  }
  // A number with its processing off holds no open text. Its rows have no head.
  const runtime = requireRuntime(deps);
  if (!runtime.ok) return { ok: true, value: [] };
  if (runtime.value.organisationId !== deps.scope.organisationId) {
    return { ok: false, error: { code: "connector_placement_conflict" } };
  }
  const cipher = await cipherFor(deps, runtime.value);
  if (!cipher.ok) return cipher;
  const heads: WhatsAppConversationHead[] = [];
  for (const caseId of caseIds) {
    const supportCase = readWhatsAppCase(deps.storage.sql, caseId);
    if (supportCase === null || supportCase.closedAt !== null) continue;
    const envelope = readWhatsAppEnvelope(deps.storage.sql, caseId);
    if (!envelope.ok)
      return { ok: false, error: { code: envelope.error.code } };
    const inbound = envelope.value.filter(
      (entry) => entry.direction === "inbound",
    );
    const newest = inbound.at(-1);
    let preview: string | null = null;
    if (newest !== undefined) {
      const opened = await cipher.value.open(
        caseId,
        { kind: "message", providerMessageId: newest.providerMessageId },
        newest,
      );
      if (!(await isActorExecutionActive(deps.storage.sql, deps.scope))) {
        return { ok: false, error: { code: "connector_placement_conflict" } };
      }
      if (!opened.ok) return { ok: false, error: { code: opened.error.code } };
      preview = opened.value.slice(0, WHATSAPP_PREVIEW_MAX);
    }
    heads.push({
      caseId,
      preview,
      lastDirection: envelope.value.at(-1)?.direction ?? null,
      lastInboundAt: newest?.occurredAt ?? null,
    });
  }
  return { ok: true, value: heads };
}

export async function readWhatsAppCasePanel(
  deps: WhatsAppExecutionDeps,
  caseId: string,
): Promise<Result<WhatsAppCasePanel, WhatsAppRpcError>> {
  if (!(await isActorExecutionActive(deps.storage.sql, deps.scope))) {
    return { ok: false, error: { code: "connector_placement_conflict" } };
  }
  const runtime = requireRuntime(deps);
  if (!runtime.ok) return runtime;
  if (runtime.value.organisationId !== deps.scope.organisationId) {
    return { ok: false, error: { code: "connector_placement_conflict" } };
  }
  const supportCase = readWhatsAppCase(deps.storage.sql, caseId);
  if (supportCase === null || supportCase.closedAt !== null) {
    return { ok: false, error: { code: "connector_whatsapp_case_missing" } };
  }
  const envelope = readWhatsAppEnvelope(deps.storage.sql, caseId);
  if (!envelope.ok) return { ok: false, error: { code: envelope.error.code } };
  const cipher = await cipherFor(deps, runtime.value);
  if (!(await isActorExecutionActive(deps.storage.sql, deps.scope))) {
    return { ok: false, error: { code: "connector_placement_conflict" } };
  }
  if (!cipher.ok) return cipher;
  const entries: WhatsAppCasePanelEntry[] = [];
  for (const entry of envelope.value) {
    const opened = await cipher.value.open(
      caseId,
      { kind: "message", providerMessageId: entry.providerMessageId },
      entry,
    );
    if (!(await isActorExecutionActive(deps.storage.sql, deps.scope))) {
      return { ok: false, error: { code: "connector_placement_conflict" } };
    }
    if (!opened.ok) return { ok: false, error: { code: opened.error.code } };
    entries.push({
      direction: entry.direction,
      occurredAt: entry.occurredAt,
      providerMessageId: entry.providerMessageId,
      text: opened.value,
    });
  }
  return {
    ok: true,
    value: {
      caseId,
      customerWaId: supportCase.customerWaId,
      ownership: supportCase.ownership,
      handoffRequestedAt: supportCase.handoffRequestedAt,
      handoffReason: supportCase.handoffReason,
      serviceWindowExpiresAt: supportCase.serviceWindowExpiresAt,
      messages: entries,
    },
  };
}

export async function previewWhatsAppProposalFor(
  deps: WhatsAppExecutionDeps,
  proposalId: string,
  now: number,
): Promise<Result<WhatsAppProposalPreviewOutcome, WhatsAppRpcError>> {
  const runtime = requireRuntime(deps);
  if (!runtime.ok) return runtime;
  const cipher = await cipherFor(deps, runtime.value);
  if (!cipher.ok) return cipher;
  const preview = await previewWhatsAppProposal({
    sql: deps.storage.sql,
    scope: deps.scope,
    cipher: cipher.value,
    proposalId,
    now,
  });
  return preview.ok
    ? preview
    : { ok: false, error: { code: preview.error.code } };
}

export type WhatsAppProposalEditResult =
  | {
      readonly kind: "versioned";
      readonly version: number;
      readonly bodyDigest: string;
    }
  | { readonly kind: "proposal_missing" }
  | { readonly kind: "expired" };

export async function editWhatsAppProposalFor(
  deps: WhatsAppReplyExecutionDeps,
  input: Readonly<{
    proposalId: string;
    body: string;
    maxReplyChars: number;
    now: number;
  }>,
): Promise<Result<WhatsAppProposalEditResult, WhatsAppRpcError>> {
  if (!(await isWhatsAppReplyExecutionActive(deps)))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  const runtime = requireRuntime(deps);
  if (!runtime.ok) return runtime;
  const cipher = await cipherFor(deps, runtime.value);
  if (!cipher.ok) return cipher;
  const edited = await editWhatsAppProposal({
    sql: deps.storage.sql,
    authorizeExecution: isWhatsAppReplyExecutionActive.bind(null, deps),
    cipher: cipher.value,
    proposalId: input.proposalId,
    body: input.body,
    maxReplyChars: input.maxReplyChars,
    now: input.now,
  });
  if (!edited.ok) return { ok: false, error: { code: edited.error.code } };
  if (edited.value.kind !== "versioned") {
    return { ok: true, value: { kind: edited.value.kind } };
  }
  await syncProposalProjection(
    deps,
    runtime.value,
    input.proposalId,
    { kind: "awaiting_approval" },
    input.now,
  );
  if (!(await isWhatsAppReplyExecutionActive(deps)))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  return {
    ok: true,
    value: {
      kind: "versioned",
      version: edited.value.version,
      bodyDigest: edited.value.bodyDigest,
    },
  };
}

export async function dispatchWhatsAppReplyFor(
  deps: WhatsAppReplyExecutionDeps &
    Readonly<{ armAlarm: () => Promise<unknown> }>,
  input: Readonly<{
    proposalId: string;
    approvedVersion: number;
    approvedBodyDigest: string;
    approvedBy: string;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<WhatsAppDispatchOutcome, WhatsAppRpcError>> {
  if (!(await isWhatsAppReplyExecutionActive(deps)))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  const runtime = requireRuntime(deps);
  if (!runtime.ok) return runtime;
  const cipher = await cipherFor(deps, runtime.value);
  if (!cipher.ok) return cipher;
  const dispatched = await dispatchWhatsAppReply({
    sql: deps.storage.sql,
    authorizeExecution: isWhatsAppReplyExecutionActive.bind(null, deps),
    scope: deps.scope,
    cipher: cipher.value,
    env: deps.env,
    proposalId: input.proposalId,
    approvedVersion: input.approvedVersion,
    approvedBodyDigest: input.approvedBodyDigest,
    approvedBy: input.approvedBy,
    now: input.now,
    fetcher: input.fetcher,
    armAlarm: deps.armAlarm,
  });
  if (!dispatched.ok)
    return { ok: false, error: { code: dispatched.error.code } };
  if (dispatched.value.kind === "send_indeterminate") {
    traceWarn("connector.whatsapp_send_indeterminate", {
      requestId: newRequestId(),
      proposalId: input.proposalId,
      reason: dispatched.value.reason,
    });
  }
  const lifecycle = proposalLifecycleFor(dispatched.value, input);
  if (lifecycle !== null) {
    await syncProposalProjection(
      deps,
      runtime.value,
      input.proposalId,
      lifecycle,
      input.now,
    );
  }
  if (dispatched.value.kind === "send_indeterminate") {
    // The fence already paused the account; the operator is the only one who
    // can resolve it, so they are told once.
    const noticeKey = deps.storage.transactionSync(() =>
      recordWhatsAppOperatorNotice(deps.storage.sql, {
        reason: {
          kind: "send_indeterminate",
          proposalId: input.proposalId,
          caseId:
            latestWhatsAppProposal(deps.storage.sql, input.proposalId)
              ?.caseId ?? "",
        },
        policyVersion: runtime.value.policyVersion,
        now: input.now,
      }),
    );
    if (noticeKey !== null) {
      await notifyOperator(deps, runtime.value, noticeKey, input.now);
    }
  }
  if (
    deps.origin.kind === "session_turn" &&
    !(await isWhatsAppReplyExecutionActive(deps))
  )
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  return dispatched;
}

function proposalLifecycleFor(
  outcome: WhatsAppDispatchOutcome,
  input: Readonly<{ approvedBy: string; now: number }>,
): WhatsAppReplyProposalLifecycle | null {
  switch (outcome.kind) {
    case "sent":
      return {
        kind: "sent",
        whatsappMessageId: outcome.whatsappMessageId,
        sentAt: input.now,
      };
    case "send_indeterminate":
      return { kind: "send_indeterminate", fencedAt: input.now };
    case "expired":
    case "service_window_closed":
      return {
        kind: "expired",
        expiredAt: input.now,
        disposal: { kind: "cleaned", deletedAt: input.now },
      };
    case "stale_approval":
    case "proposal_missing":
    case "refused":
    case "rejected":
      return null;
  }
}

export async function disposeWhatsAppProposalFor(
  deps: WhatsAppExecutionDeps,
  input: Readonly<{
    proposalId: string;
    state: "rejected" | "taken_over" | "revoked" | "expired";
    actorUserId: string;
    now: number;
  }>,
): Promise<Result<WhatsAppDisposalResult, WhatsAppRpcError>> {
  const runtime = requireRuntime(deps);
  if (!runtime.ok) return runtime;
  const disposed = deps.storage.transactionSync(() =>
    disposeWhatsAppProposal({
      sql: deps.storage.sql,
      proposalId: input.proposalId,
      state: input.state,
      now: input.now,
    }),
  );
  if (disposed.kind === "proposal_missing") {
    return { ok: true, value: { kind: "proposal_missing" } };
  }
  const disposal = { kind: "cleaned" as const, deletedAt: input.now };
  const lifecycle: WhatsAppReplyProposalLifecycle =
    input.state === "rejected"
      ? {
          kind: "rejected",
          rejectedBy: input.actorUserId,
          rejectedAt: input.now,
          disposal,
        }
      : input.state === "taken_over"
        ? {
            kind: "taken_over",
            takenOverBy: input.actorUserId,
            takenOverAt: input.now,
            disposal,
          }
        : input.state === "expired"
          ? { kind: "expired", expiredAt: input.now, disposal }
          : { kind: "revoked", revokedAt: input.now, disposal };
  await syncProposalProjection(
    deps,
    runtime.value,
    input.proposalId,
    lifecycle,
    input.now,
  );
  return { ok: true, value: { kind: "disposed" } };
}

export async function resolveWhatsAppIndeterminateFor(
  deps: WhatsAppExecutionDeps,
  input: Readonly<{
    proposalId: string;
    resolution: WhatsAppIndeterminateResolution;
    now: number;
  }>,
): Promise<Result<WhatsAppResolutionResult, WhatsAppRpcError>> {
  const runtime = requireRuntime(deps);
  if (!runtime.ok) return runtime;
  const resolved = deps.storage.transactionSync(() =>
    resolveWhatsAppIndeterminateSend({
      sql: deps.storage.sql,
      proposalId: input.proposalId,
      resolution: input.resolution,
      now: input.now,
    }),
  );
  if (!resolved.ok) return { ok: false, error: { code: resolved.error.code } };
  const lifecycle: WhatsAppReplyProposalLifecycle =
    input.resolution.kind === "delivered"
      ? {
          kind: "sent",
          whatsappMessageId: input.resolution.whatsappMessageId,
          sentAt: input.now,
        }
      : {
          kind: "revoked",
          revokedAt: input.now,
          disposal: { kind: "cleaned", deletedAt: input.now },
        };
  await syncProposalProjection(
    deps,
    runtime.value,
    input.proposalId,
    lifecycle,
    input.now,
  );
  return { ok: true, value: { state: resolved.value.state } };
}

export async function takeOverWhatsAppCase(
  deps: WhatsAppReplyExecutionDeps,
  input: Readonly<{
    caseId: string;
    operatorUserId: string;
    now: number;
  }>,
): Promise<Result<WhatsAppTakeoverResult, WhatsAppRpcError>> {
  if (!(await isWhatsAppReplyExecutionActive(deps)))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  const runtime = requireRuntime(deps);
  if (!runtime.ok) return runtime;
  const supportCase = readWhatsAppCase(deps.storage.sql, input.caseId);
  if (supportCase === null || supportCase.closedAt !== null) {
    return { ok: false, error: { code: "connector_whatsapp_case_missing" } };
  }
  const reason =
    supportCase.handoffRequestedAt === null
      ? ("operator_takeover" as const)
      : ("agent_handoff" as const);
  const ownership = {
    kind: "human_owned" as const,
    ownerId: input.operatorUserId,
    startedAt: input.now,
    reason,
  };
  const invalidated = deps.storage.transactionSync(() => {
    setConnectorCaseOwnership(deps.storage.sql, input.caseId, ownership);
    clearWhatsAppHandoff(deps.storage.sql, input.caseId);
    return invalidateOpenWhatsAppProposal(
      deps.storage.sql,
      input.caseId,
      "taken_over",
      input.now,
    );
  });
  const organisationId = parseOrganisationId(runtime.value.organisationId);
  const ownerId = parseUserId(input.operatorUserId);
  if (organisationId.ok && ownerId.ok) {
    await setWhatsAppCaseOwnership({
      db: deps.scope.database,
      organisationId: organisationId.value,
      caseId: input.caseId,
      ownership: {
        kind: "human_owned",
        ownerId: ownerId.value,
        startedAt: input.now,
        reason,
      },
    });
    await clearWhatsAppCaseHandoff({
      db: deps.scope.database,
      organisationId: organisationId.value,
      caseId: input.caseId,
    });
  }
  if (invalidated.kind === "invalidated") {
    await syncProposalProjection(
      deps,
      runtime.value,
      invalidated.proposalId,
      {
        kind: "taken_over",
        takenOverBy: input.operatorUserId,
        takenOverAt: input.now,
        disposal: { kind: "cleaned", deletedAt: input.now },
      },
      input.now,
    );
  }
  if (!(await isWhatsAppReplyExecutionActive(deps)))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  return {
    ok: true,
    value: {
      invalidatedProposalId:
        invalidated.kind === "invalidated" ? invalidated.proposalId : null,
    },
  };
}

export async function returnWhatsAppCaseToAgent(
  deps: WhatsAppExecutionDeps,
  input: Readonly<{ caseId: string; now: number }>,
): Promise<Result<WhatsAppReturnResult, WhatsAppRpcError>> {
  const runtime = requireRuntime(deps);
  if (!runtime.ok) return runtime;
  const updated = deps.storage.transactionSync(() => {
    clearWhatsAppHandoff(deps.storage.sql, input.caseId);
    const ownership = setConnectorCaseOwnership(
      deps.storage.sql,
      input.caseId,
      { kind: "agent_active" },
    );
    if (ownership.kind === "missing") return ownership;
    return scheduleWhatsAppCaseForAgent(
      deps.storage.sql,
      input.caseId,
      input.now,
    );
  });
  if (updated.kind === "missing") {
    return { ok: false, error: { code: "connector_whatsapp_case_missing" } };
  }
  const organisationId = parseOrganisationId(runtime.value.organisationId);
  if (organisationId.ok) {
    await setWhatsAppCaseOwnership({
      db: deps.scope.database,
      organisationId: organisationId.value,
      caseId: input.caseId,
      ownership: { kind: "agent_active" },
    });
    await clearWhatsAppCaseHandoff({
      db: deps.scope.database,
      organisationId: organisationId.value,
      caseId: input.caseId,
    });
  }
  return { ok: true, value: { kind: "returned" } };
}

export async function composeWhatsAppHumanReplyFor(
  deps: WhatsAppReplyExecutionDeps,
  input: Readonly<{
    caseId: string;
    proposalId: string;
    body: string;
    maxReplyChars: number;
    expiresAt: number;
    now: number;
  }>,
): Promise<Result<WhatsAppHumanReplyResult, WhatsAppRpcError>> {
  if (!(await isWhatsAppReplyExecutionActive(deps)))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  const runtime = requireRuntime(deps);
  if (!runtime.ok) return runtime;
  const cipher = await cipherFor(deps, runtime.value);
  if (!cipher.ok) return cipher;
  const composed = await composeWhatsAppHumanReply({
    sql: deps.storage.sql,
    authorizeExecution: isWhatsAppReplyExecutionActive.bind(null, deps),
    cipher: cipher.value,
    caseId: input.caseId,
    proposalId: input.proposalId,
    body: input.body,
    maxReplyChars: input.maxReplyChars,
    now: input.now,
    expiresAt: input.expiresAt,
  });
  if (!composed.ok) return { ok: false, error: { code: composed.error.code } };
  const supportCase = readWhatsAppCase(deps.storage.sql, input.caseId);
  const organisationId = parseOrganisationId(runtime.value.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    runtime.value.integrationAccountId,
  );
  if (supportCase !== null && organisationId.ok && integrationAccountId.ok) {
    await projectWhatsAppReplyProposal({
      db: deps.scope.database,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      proposalId: input.proposalId,
      caseId: input.caseId,
      customerWaId: supportCase.customerWaId,
      currentVersion: composed.value.version,
      lifecycleKind: "awaiting_approval",
      author: "human",
      serviceWindowExpiresAt: supportCase.serviceWindowExpiresAt,
      now: input.now,
    });
  }
  if (!(await isWhatsAppReplyExecutionActive(deps)))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  return composed;
}

export async function closeWhatsAppSupportCase(
  deps: WhatsAppExecutionDeps,
  input: Readonly<{ caseId: string; now: number }>,
): Promise<Result<WhatsAppCloseResult, WhatsAppRpcError>> {
  const runtime = requireRuntime(deps);
  if (!runtime.ok) return runtime;
  deps.storage.transactionSync(() => {
    invalidateOpenWhatsAppProposal(
      deps.storage.sql,
      input.caseId,
      "revoked",
      input.now,
    );
    closeWhatsAppCase(deps.storage.sql, input.caseId, input.now);
  });
  const organisationId = parseOrganisationId(runtime.value.organisationId);
  if (organisationId.ok) {
    await closeWhatsAppCaseConversationWindow({
      db: deps.scope.database,
      organisationId: organisationId.value,
      caseId: input.caseId,
      now: input.now,
    });
  }
  return { ok: true, value: { kind: "closed" } };
}

async function syncProposalProjection(
  deps: WhatsAppExecutionDeps,
  runtime: WhatsAppRuntimeSnapshot,
  proposalId: string,
  lifecycle: WhatsAppReplyProposalLifecycle,
  now: number,
): Promise<void> {
  const proposal = latestWhatsAppProposal(deps.storage.sql, proposalId);
  const organisationId = parseOrganisationId(runtime.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    runtime.integrationAccountId,
  );
  if (proposal === null || !organisationId.ok || !integrationAccountId.ok)
    return;
  await projectWhatsAppReplyProposal({
    db: deps.scope.database,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    proposalId,
    caseId: proposal.caseId,
    customerWaId: proposal.customerWaId,
    currentVersion: proposal.version,
    lifecycleKind: lifecycle.kind,
    author: proposal.author,
    serviceWindowExpiresAt: proposal.serviceWindowExpiresAt,
    now,
  });
}

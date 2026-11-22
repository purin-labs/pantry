import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { PageEffectSettlement } from "./session/tool-wiring";
import {
  isRehearsalChange,
  quarterTurnDegrees,
} from "@purin-labs/bakery-model/bakery-surface";
import { canonicalJson, assertNever } from "@purin-labs/std";
import type { SurfacePageCommandV1 } from "@purin-labs/control-api";
import type { HarnessTurnLease } from "@purin-labs/contracts";
import {
  createBakerySurfaceEffect,
  bakeryEffectDeliveryTarget,
  createBakerySurfaceReceipt,
  parseBakerySurfaceAttachment,
  parseBakerySurfaceEffect,
  parseBakerySurfaceReceipt,
  verifyBakerySurfaceAttachment,
  verifyBakerySurfaceEffect,
  verifyBakerySurfaceReceipt,
  type BakerySurfaceAttachmentV1,
  type BakerySurfaceEffectV1,
  type BakerySurfaceReceiptV1,
  type ExecutableBakerySurfaceEffectV1,
  type BakerySurfaceProductionDraft,
  type BakerySurfaceRehearsalTray,
  type BakeryProductionEdit,
  type BakeryRehearsalEdit,
  type BakeryStoreInteriorAction,
  type BakerySurfaceStoreInterior,
} from "@purin-labs/bakery-model/bakery-surface";
import { newRequestId, type OrganisationId } from "@purin-labs/kernel/ids";
import {
  parsePersistedHarnessTurnLease,
  preflightHarnessTurnLease,
  preflightHarnessTurnLeaseInTransaction,
} from "./agent-session-harness-authority";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import {
  hasExactKeys,
  isNonEmptyString,
  isRecord,
  parseJsonOrNull,
  sameJson,
  sha256Hex,
} from "@purin-labs/std";
import { armAlarmBy } from "./lifecycle/actor-alarm";
import { traceWarn } from "@purin-labs/kernel/observability";

export const SURFACE_EFFECT_TTL_MS = 20_000;
const SURFACE_SIMULATION_TTL_MS = 150_000;
const SURFACE_EFFECT_POLL_MS = 50;
const SURFACE_EFFECT_RETRY_MS = 1_000;
const SURFACE_EFFECT_RECOVERY_LIMIT = 32;
/**
 * A settled or uncertain effect whose Portal projection fails this many
 * times is quarantined. The retries back off from 1 s to 15 minutes, so the
 * last one comes about 45 minutes after the first failure.
 */
const SURFACE_EFFECT_REPAIR_ATTEMPTS = 12;
const SURFACE_EFFECT_MAX_BACKOFF_MS = 15 * 60_000;
const SURFACE_TIMELINE_PAGE_LIMIT = 100;

type SurfaceOutboxRow = Readonly<{
  effectId: string;
  organisationId: string;
  requestEnvelope: string;
  stateKind:
    "dispatching" | "settled" | "reconciled" | "indeterminate" | "quarantined";
  stateProjection: string;
  updatedAt: number;
}>;

type SurfaceEffectRequestV1 = Readonly<{
  kind: "bakery_surface_effect.v1";
  organisationId: string;
  sessionId: string;
  turnId: string;
  requestId: string;
  callId: string;
  userId: string;
  lease: HarnessTurnLease;
  effect: BakerySurfaceEffectV1;
}>;

type SurfaceEffectProjection =
  | Readonly<{
      kind: "surface_dispatching";
      publication: "pending" | "published";
    }>
  | Readonly<{
      kind: "surface_settled";
      receipt: BakerySurfaceReceiptV1;
      settledAt: number;
    }>
  | Readonly<{
      kind: "surface_indeterminate";
      reason: "cancelled_after_dispatch" | "expired_after_dispatch";
    }>;

type DeliveryRow = Readonly<{
  effectId: string;
  effectJson: string;
  deadlineAt: number;
}>;

type SettledSurfaceProjection = Variant<
  SurfaceEffectProjection,
  "surface_settled"
>;

type TerminalSurfaceProjection = Exclude<
  SurfaceEffectProjection,
  { kind: "surface_dispatching" }
>;

type SurfaceSettlementCommit =
  | Readonly<{
      ok: true;
      kind: "accepted" | "duplicate";
      request: SurfaceEffectRequestV1;
      projection: SettledSurfaceProjection;
    }>
  | VariantBy<BakerySurfaceEffectSettlement, "ok", false>;

type TerminalSurfaceCommit =
  | Readonly<{
      kind: "terminal";
      request: SurfaceEffectRequestV1;
      projection: TerminalSurfaceProjection;
    }>
  | Readonly<{ kind: "live" }>
  | Readonly<{ kind: "missing_or_corrupt" }>;

type TimelineRow = Readonly<{
  sequence: number;
  effectId: string;
  eventKind: "started" | "settled" | "indeterminate";
  requestId: string;
  sessionId: string;
  turnId: string;
  effectJson: string;
  receiptJson: string | null;
  createdAt: number;
}>;

export type BakerySurfaceEffectDispatch = Readonly<{
  receiptId: string;
  receipt: BakerySurfaceReceiptV1;
}>;

/** The Session defines the answer, because its RPC method returns it. */
export type BakerySurfaceEffectSettlement = PageEffectSettlement;

type PendingBakerySurfaceEffect = Readonly<{
  effect: BakerySurfaceEffectV1;
}>;

export async function resumeBakerySurfaceEffect(input: {
  readonly db: OrganisationDatabase;
  readonly storage: DurableObjectStorage;
  readonly organisationId: OrganisationId;
  readonly sessionId: string;
  readonly requestId: string;
  readonly userId: string;
  readonly lease: HarnessTurnLease;
  readonly callId: string;
  readonly commandKind: ExecutableBakerySurfaceEffectV1["command"]["kind"];
  readonly announce?: () => void;
}): Promise<
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "dispatched"; result: BakerySurfaceEffectDispatch }>
> {
  const identityDigest = await surfaceEffectIdentityDigest(input);
  const row = readSurfaceOutbox(
    input.storage.sql,
    `surface_effect_${identityDigest.slice(0, 40)}`,
  );
  if (row === null) return { kind: "missing" };
  const stored = parseSurfaceOutbox(row);
  if (
    stored === null ||
    stored.request.organisationId !== input.organisationId ||
    stored.request.sessionId !== input.sessionId ||
    stored.request.requestId !== input.requestId ||
    stored.request.userId !== input.userId ||
    !sameSurfaceRecoveryAuthority(stored.request.lease, input.lease) ||
    stored.request.effect.command.kind !== input.commandKind
  )
    throw new Error("surface_effect_conflict");
  // Accepted call IDs are immutable; recovery retains the originally dispatched target.
  return {
    kind: "dispatched",
    result: await dispatchBakerySurfaceEffect({
      db: input.db,
      storage: input.storage,
      organisationId: input.organisationId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      userId: input.userId,
      lease: input.lease,
      callId: input.callId,
      command: stored.request.effect.command,
      ...(input.announce === undefined ? {} : { announce: input.announce }),
    }),
  };
}

/** Rebind receipt collection after the canonical recovery transition fences the old lease. */
export function rebindBakerySurfaceRecovery(
  sql: SqlStorage,
  previous: HarnessTurnLease,
  next: HarnessTurnLease,
): void {
  if (
    !sameSurfaceRecoveryAuthority(previous, next) ||
    !preflightHarnessTurnLeaseInTransaction(sql, next, Date.now()).ok
  )
    throw new Error("surface_effect_authority_invalid");
  const rows = sql
    .exec<{ effectId: string }>(
      "SELECT effect_id AS effectId FROM actor_outbox WHERE json_extract(request_envelope, '$.kind') = 'bakery_surface_effect.v1' AND json_extract(request_envelope, '$.lease.leaseId') = ?",
      previous.leaseId,
    )
    .toArray();
  for (const row of rows) {
    const record = readSurfaceOutbox(sql, row.effectId);
    const stored = record === null ? null : parseSurfaceOutbox(record);
    if (stored === null) throw new Error("surface_effect_conflict");
    if (stored.projection.kind !== "surface_dispatching") continue;
    sql.exec(
      "UPDATE actor_outbox SET request_envelope = json_set(request_envelope, '$.lease', json(?)) WHERE effect_id = ?",
      JSON.stringify(next),
      row.effectId,
    );
  }
}
function sameSurfaceRecoveryAuthority(
  previous: HarnessTurnLease,
  next: HarnessTurnLease,
): boolean {
  return (
    previous.session.sessionId === next.session.sessionId &&
    previous.session.organisationId === next.session.organisationId &&
    previous.turn.turnId === next.turn.turnId &&
    previous.turn.inputId === next.turn.inputId &&
    previous.authorityPartitionDigest === next.authorityPartitionDigest &&
    sameJson(previous.requestAuthority, next.requestAuthority) &&
    (previous.leaseId === next.leaseId ||
      next.runtimeLease.generation > previous.runtimeLease.generation)
  );
}

export type BakerySurfaceTimelineEvent = Readonly<{
  sequence: number;
  requestId: string;
  sessionId: string;
  turnId: string;
  createdAt: number;
  effect: BakerySurfaceEffectV1;
  terminal:
    | Readonly<{ kind: "started" }>
    | Readonly<{ kind: "settled"; receipt: BakerySurfaceReceiptV1 }>
    | Readonly<{ kind: "indeterminate" }>;
}>;

export async function dispatchBakerySurfaceEffect(input: {
  readonly db: OrganisationDatabase;
  readonly storage: DurableObjectStorage;
  readonly organisationId: OrganisationId;
  readonly sessionId: string;
  readonly requestId: string;
  readonly userId: string;
  readonly lease: HarnessTurnLease;
  readonly callId: string;
  readonly command: BakerySurfaceEffectV1["command"];
  readonly now?: number;
  /**
   * Tells the user's chat pages that the effect waits, so the browser reads
   * it at once (Plan 87 phase 3). The browser's poll stays the fallback.
   */
  readonly announce?: () => void;
}): Promise<BakerySurfaceEffectDispatch> {
  const now = input.now ?? Date.now();
  const identityDigest = await surfaceEffectIdentityDigest(input);
  const effectId = `surface_effect_${identityDigest.slice(0, 40)}`;
  const effect = await createBakerySurfaceEffect({
    effectId,
    dispatchId: `surface_dispatch_${identityDigest.slice(0, 40)}`,
    deadlineAt: Math.min(
      input.lease.expiresAt,
      now +
        (input.command.kind === "simulate_workcell"
          ? SURFACE_SIMULATION_TTL_MS
          : SURFACE_EFFECT_TTL_MS),
    ),
    command: input.command,
  });
  const existing = readSurfaceOutbox(input.storage.sql, effectId);
  if (existing !== null) {
    const stored = parseSurfaceOutbox(existing);
    if (
      stored === null ||
      !(await verifyBakerySurfaceEffect(stored.request.effect)) ||
      stored.request.effect.commandDigest !== effect.commandDigest
    )
      throw new Error("surface_effect_conflict");
    if (stored.projection.kind === "surface_settled") {
      await repairSurfaceProjection(
        input.db,
        stored.request,
        stored.projection,
      );
      markSurfaceProjectionComplete(
        input.storage.sql,
        stored.request,
        stored.projection,
        now,
      );
      return dispatchResult(stored.projection.receipt);
    }
    if (stored.projection.kind === "surface_indeterminate") {
      await projectSurfaceIndeterminate(input.db, stored.request, now);
      markSurfaceProjectionComplete(
        input.storage.sql,
        stored.request,
        stored.projection,
        now,
      );
      return indeterminateDispatch(stored.request.effect);
    }
    try {
      await publishSurfaceDelivery(input.db, stored.request);
      markSurfacePublished(input.storage.sql, effectId, now);
      input.announce?.();
    } catch (error) {
      await scheduleBakerySurfaceEffectRecovery(
        input.storage,
        now + SURFACE_EFFECT_RETRY_MS,
      );
      throw error;
    }
    await scheduleBakerySurfaceEffectRecovery(
      input.storage,
      stored.request.effect.deadlineAt,
    );
    return waitForSurfaceReceipt({
      db: input.db,
      storage: input.storage,
      organisationId: input.organisationId,
      effect,
    });
  }

  const request: SurfaceEffectRequestV1 = {
    kind: "bakery_surface_effect.v1",
    organisationId: input.organisationId,
    sessionId: input.sessionId,
    turnId: input.lease.turn.turnId,
    requestId: input.requestId,
    callId: input.callId,
    userId: input.userId,
    lease: input.lease,
    effect,
  };
  persistSurfaceDispatch(input.storage.sql, request, now);
  await scheduleBakerySurfaceEffectRecovery(input.storage, effect.deadlineAt);
  try {
    await publishSurfaceDelivery(input.db, request);
    markSurfacePublished(input.storage.sql, effectId, now);
    input.announce?.();
  } catch (error) {
    await scheduleBakerySurfaceEffectRecovery(
      input.storage,
      now + SURFACE_EFFECT_RETRY_MS,
    );
    throw error;
  }
  return waitForSurfaceReceipt({
    db: input.db,
    storage: input.storage,
    organisationId: input.organisationId,
    effect,
  });
}

async function surfaceEffectIdentityDigest(input: {
  readonly sessionId: string;
  readonly lease: HarnessTurnLease;
  readonly callId: string;
}): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      sessionId: input.sessionId,
      turnId: input.lease.turn.turnId,
      callId: input.callId,
    }),
  );
}

export async function settleBakerySurfaceEffect(input: {
  readonly db: OrganisationDatabase;
  readonly storage: DurableObjectStorage;
  readonly organisationId: OrganisationId;
  /** The receipt as the page sent it. This function parses it first. */
  readonly receipt: unknown;
  readonly now?: () => number;
}): Promise<BakerySurfaceEffectSettlement> {
  const receipt = parseBakerySurfaceReceipt(input.receipt);
  if (
    receipt.kind === "invalid" ||
    !(await verifyBakerySurfaceReceipt(receipt.value))
  )
    return { ok: false, code: "surface_effect_receipt_invalid" };
  const row = readSurfaceOutbox(input.storage.sql, receipt.value.effectId);
  if (row === null) return { ok: false, code: "surface_effect_missing" };
  const stored = parseSurfaceOutbox(row);
  if (stored === null) return { ok: false, code: "surface_effect_conflict" };
  if (!(await verifyBakerySurfaceEffect(stored.request.effect)))
    return { ok: false, code: "surface_effect_conflict" };
  if (stored.request.organisationId !== input.organisationId)
    return { ok: false, code: "surface_effect_organisation_mismatch" };
  if (!receiptMatchesEffect(receipt.value, stored.request.effect))
    return { ok: false, code: "surface_effect_conflict" };
  if (stored.projection.kind === "surface_settled") {
    if (!sameReceipt(stored.projection.receipt, receipt.value))
      return { ok: false, code: "surface_effect_conflict" };
    await repairProjectionAfterSettlement(
      input.storage,
      input.db,
      stored.request,
      stored.projection,
    );
    return { ok: true, kind: "duplicate" };
  }
  if (stored.projection.kind !== "surface_dispatching")
    return { ok: false, code: "surface_effect_conflict" };
  if (stored.projection.publication !== "published")
    return { ok: false, code: "surface_effect_receipt_invalid" };
  const now = input.now ?? Date.now;
  const validatedAt = now();
  if (validatedAt >= stored.request.effect.deadlineAt)
    return { ok: false, code: "surface_effect_expired" };
  if (
    !preflightHarnessTurnLease(input.storage, stored.request.lease, validatedAt)
      .ok
  )
    return { ok: false, code: "surface_effect_authority_invalid" };
  if (
    !(await validReceiptForStoredCommand(
      stored.request.effect,
      receipt.value,
      validatedAt,
    ))
  )
    return { ok: false, code: "surface_effect_receipt_invalid" };
  const committed = commitSurfaceSettlement({
    storage: input.storage,
    organisationId: input.organisationId,
    receipt: receipt.value,
    now,
    validatedRequest: stored.request,
  });
  if (!committed.ok) return committed;
  await repairProjectionAfterSettlement(
    input.storage,
    input.db,
    committed.request,
    committed.projection,
  );
  return { ok: true, kind: committed.kind };
}

export async function reconcileBakerySurfaceEffects(input: {
  readonly db: OrganisationDatabase;
  readonly storage: DurableObjectStorage;
  readonly now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  // A quarantined effect is terminal and never a candidate. A row whose
  // repair failed waits for its backoff, so it cannot hold the page.
  const candidates = input.storage.sql
    .exec<SurfaceOutboxRow>(
      `SELECT effect_id AS effectId, organisation_id AS organisationId,
              request_envelope AS requestEnvelope, state_kind AS stateKind,
              state_projection AS stateProjection, updated_at AS updatedAt
       FROM actor_outbox
       WHERE json_extract(request_envelope, '$.kind') = 'bakery_surface_effect.v1'
         AND state_kind IN ('dispatching', 'settled', 'indeterminate')
         AND ${SURFACE_REPAIR_DUE} <= ?
       ORDER BY updated_at ASC, effect_id ASC
       LIMIT ?`,
      now,
      SURFACE_EFFECT_RECOVERY_LIMIT + 1,
    )
    .toArray();
  const rows = candidates.slice(0, SURFACE_EFFECT_RECOVERY_LIMIT);
  let retryAt: number | null =
    candidates.length > SURFACE_EFFECT_RECOVERY_LIMIT
      ? now + SURFACE_EFFECT_RETRY_MS
      : null;
  for (const row of rows) {
    const stored = parseSurfaceOutbox(row);
    if (
      stored === null ||
      !(await verifyBakerySurfaceEffect(stored.request.effect))
    ) {
      quarantineSurfaceEffect(input.storage.sql, row, now, "corrupt");
      continue;
    }
    try {
      if (stored.projection.kind === "surface_settled") {
        await repairSurfaceProjection(
          input.db,
          stored.request,
          stored.projection,
        );
        markSurfaceProjectionComplete(
          input.storage.sql,
          stored.request,
          stored.projection,
          now,
        );
        continue;
      }
      if (stored.projection.kind === "surface_indeterminate") {
        await projectSurfaceIndeterminate(input.db, stored.request, now);
        markSurfaceProjectionComplete(
          input.storage.sql,
          stored.request,
          stored.projection,
          now,
        );
        continue;
      }
      const authority = preflightHarnessTurnLease(
        input.storage,
        stored.request.lease,
        now,
      );
      if (!authority.ok || now >= stored.request.effect.deadlineAt) {
        await reconcileTerminalSurfaceDispatch({
          db: input.db,
          storage: input.storage,
          request: stored.request,
          now,
          cause: authority.ok ? "expired" : "cancelled",
        });
        continue;
      }
      await publishSurfaceDelivery(input.db, stored.request);
      markSurfacePublished(input.storage.sql, row.effectId, now);
    } catch {
      // A live dispatch retries until its deadline ends it. A settled or
      // uncertain effect counts the failed repair and backs off.
      if (row.stateKind === "dispatching")
        retryAt = Math.min(retryAt ?? Infinity, now + SURFACE_EFFECT_RETRY_MS);
      else recordSurfaceRepairFailure(input.storage.sql, row, now);
    }
  }
  const deadline = nextSurfaceEffectDeadline(input.storage.sql);
  const next = minimumTime(
    minimumTime(retryAt, deadline),
    nextSurfaceRepairAt(input.storage.sql),
  );
  if (next !== null)
    await scheduleBakerySurfaceEffectRecovery(input.storage, next);
}

export async function listPendingBakerySurfaceEffects(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly userId: string;
  readonly browserBinding: import("@purin-labs/bakery-model/bakery-context").BakeryBrowserBinding;
  readonly now?: number;
}): Promise<readonly PendingBakerySurfaceEffect[]> {
  const now = input.now ?? Date.now();
  const result = await input.db
    .prepare(
      `SELECT effect_id AS effectId, effect_json AS effectJson,
              deadline_at AS deadlineAt
       FROM bakery_surface_effect_delivery AS delivery
       WHERE organisation_id = ? AND user_id = ?
         AND (EXISTS (
           SELECT 1 FROM bakery_surface_effect_delivery AS preparation
           WHERE preparation.organisation_id = delivery.organisation_id
             AND preparation.user_id = delivery.user_id
             AND preparation.session_id = delivery.session_id
             AND preparation.turn_id = delivery.turn_id
             AND preparation.request_id = delivery.request_id
             AND preparation.surface_session_id = ?
             AND json_extract(preparation.effect_json, '$.command.kind') = 'prepare_context'
             AND json_extract(preparation.effect_json, '$.command.binding.conversationId') = ?
         ) OR (
           -- A page command names its browser itself (Plan 87 phase 4).
           delivery.surface_session_id = ?
           AND json_extract(delivery.effect_json, '$.command.kind') = 'page_command'
           AND json_extract(delivery.effect_json, '$.command.binding.conversationId') = ?
         ))
         AND state_kind = 'dispatching'
         AND deadline_at > ?
       ORDER BY created_at ASC, effect_id ASC
       LIMIT 4`,
    )
    .bind(
      input.organisationId,
      input.userId,
      `browser:${input.browserBinding.browserInstanceId}`,
      input.browserBinding.conversationId,
      `browser:${input.browserBinding.browserInstanceId}`,
      input.browserBinding.conversationId,
      now,
    )
    .all<DeliveryRow>();
  const effects: PendingBakerySurfaceEffect[] = [];
  for (const row of result.results) {
    const parsed = parseBakerySurfaceEffect(jsonOrNull(row.effectJson));
    if (
      parsed.kind === "valid" &&
      parsed.value.effectId === row.effectId &&
      parsed.value.deadlineAt === row.deadlineAt &&
      (await verifyBakerySurfaceEffect(parsed.value))
    )
      effects.push({ effect: parsed.value });
  }
  return effects;
}

export async function listBakerySurfaceTimelineEvents(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly userId: string;
  readonly requestIds: readonly string[];
  readonly afterSequence: number;
}): Promise<readonly BakerySurfaceTimelineEvent[]> {
  const result = await input.db
    .prepare(
      `SELECT event.sequence AS sequence, event.effect_id AS effectId,
              event.event_kind AS eventKind, event.request_id AS requestId,
              event.session_id AS sessionId, event.turn_id AS turnId,
              delivery.effect_json AS effectJson,
              delivery.receipt_json AS receiptJson,
              event.created_at AS createdAt
       FROM bakery_surface_timeline_event AS event
       JOIN bakery_surface_effect_delivery AS delivery
         ON delivery.effect_id = event.effect_id
       WHERE event.organisation_id = ? AND event.user_id = ?
         AND event.request_id IN (SELECT value FROM json_each(?))
         AND event.sequence > ?
       ORDER BY event.sequence ASC
       LIMIT ?`,
    )
    .bind(
      input.organisationId,
      input.userId,
      JSON.stringify(input.requestIds),
      input.afterSequence,
      SURFACE_TIMELINE_PAGE_LIMIT,
    )
    .all<TimelineRow>();
  const events: BakerySurfaceTimelineEvent[] = [];
  for (const row of result.results) {
    const effect = parseBakerySurfaceEffect(jsonOrNull(row.effectJson));
    if (
      effect.kind === "invalid" ||
      !(await verifyBakerySurfaceEffect(effect.value))
    )
      throw new Error("surface_effect_timeline_invalid");
    if (row.eventKind === "settled") {
      const receipt = parseBakerySurfaceReceipt(jsonOrNull(row.receiptJson));
      if (
        receipt.kind === "invalid" ||
        !receiptMatchesEffect(receipt.value, effect.value) ||
        !(await verifyBakerySurfaceReceipt(receipt.value))
      )
        throw new Error("surface_effect_timeline_invalid");
      events.push(
        timelineEvent(row, effect.value, {
          kind: "settled",
          receipt: receipt.value,
        }),
      );
      continue;
    }
    events.push(
      timelineEvent(
        row,
        effect.value,
        row.eventKind === "started"
          ? { kind: "started" }
          : { kind: "indeterminate" },
      ),
    );
  }
  return events;
}

/**
 * The newest page state that the browser reported for the requests of one
 * chat in other Sessions: each model step of a Portal chat request has its own
 * Session. The current Session is left out, so that a re-entered step keeps
 * its prompt.
 */
export async function readLatestBakerySurfaceOfRequests(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly userId: string;
  readonly requestIds: readonly string[];
  readonly currentSessionId: string;
}): Promise<BakerySurfaceAttachmentV1 | null> {
  const row = await input.db
    .prepare(
      `SELECT COALESCE(
                json_extract(delivery.receipt_json, '$.outcome.result.surface'),
                json_extract(delivery.receipt_json, '$.outcome.surface')
              ) AS surface
       FROM bakery_surface_timeline_event AS event
       JOIN bakery_surface_effect_delivery AS delivery
         ON delivery.effect_id = event.effect_id
       WHERE event.organisation_id = ? AND event.user_id = ?
         AND event.request_id IN (SELECT value FROM json_each(?))
         AND event.session_id <> ?
         AND event.event_kind = 'settled'
         AND surface IS NOT NULL
       ORDER BY event.sequence DESC
       LIMIT 1`,
    )
    .bind(
      input.organisationId,
      input.userId,
      JSON.stringify(input.requestIds),
      input.currentSessionId,
    )
    .first<{ surface: string }>();
  if (row === null) return null;
  const surface = parseBakerySurfaceAttachment(jsonOrNull(row.surface));
  if (
    surface.kind === "invalid" ||
    !(await verifyBakerySurfaceAttachment(surface.value))
  )
    throw new Error("surface_effect_timeline_invalid");
  return surface.value;
}

export async function readBakerySurfaceDeliveryTarget(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly userId: string;
  readonly effectId: string;
}): Promise<{ readonly sessionId: string } | null> {
  const row = await input.db
    .prepare(
      `SELECT session_id AS sessionId
       FROM bakery_surface_effect_delivery
       WHERE organisation_id = ? AND user_id = ? AND effect_id = ?`,
    )
    .bind(input.organisationId, input.userId, input.effectId)
    .first<{ sessionId: string }>();
  return row === null || typeof row.sessionId !== "string"
    ? null
    : { sessionId: row.sessionId };
}

export async function scheduleBakerySurfaceEffectRecovery(
  storage: DurableObjectStorage,
  recoveryAt: number,
): Promise<void> {
  await armAlarmBy(storage, recoveryAt);
}

async function waitForSurfaceReceipt(input: {
  readonly db: OrganisationDatabase;
  readonly storage: DurableObjectStorage;
  readonly organisationId: OrganisationId;
  readonly effect: BakerySurfaceEffectV1;
}): Promise<BakerySurfaceEffectDispatch> {
  for (;;) {
    const row = readSurfaceOutbox(input.storage.sql, input.effect.effectId);
    if (row === null) throw new Error("surface_effect_missing");
    const stored = parseSurfaceOutbox(row);
    if (stored === null) throw new Error("surface_effect_persistence_invalid");
    if (stored.projection.kind === "surface_settled")
      return dispatchResult(stored.projection.receipt);
    if (stored.projection.kind === "surface_indeterminate")
      return indeterminateDispatch(stored.request.effect);
    const now = Date.now();
    const authority = preflightHarnessTurnLease(
      input.storage,
      stored.request.lease,
      now,
    );
    if (!authority.ok || now >= stored.request.effect.deadlineAt) {
      await reconcileTerminalSurfaceDispatch({
        db: input.db,
        storage: input.storage,
        request: stored.request,
        now,
        cause: authority.ok ? "expired" : "cancelled",
      });
      continue;
    }
    await scheduler.wait(
      Math.min(SURFACE_EFFECT_POLL_MS, stored.request.effect.deadlineAt - now),
    );
  }
}

async function reconcileTerminalSurfaceDispatch(input: {
  readonly db: OrganisationDatabase;
  readonly storage: DurableObjectStorage;
  readonly request: SurfaceEffectRequestV1;
  readonly now: number;
  readonly cause: "cancelled" | "expired";
}): Promise<void> {
  const published = await surfaceDeliveryWasPublished(
    input.db,
    input.request.effect.effectId,
  );
  let proposed: TerminalSurfaceProjection;
  if (published && input.request.effect.command.kind !== "prepare_context") {
    proposed = {
      kind: "surface_indeterminate",
      reason:
        input.cause === "cancelled"
          ? "cancelled_after_dispatch"
          : "expired_after_dispatch",
    };
  } else {
    const receipt = await createBakerySurfaceReceipt(input.request.effect, {
      kind: "delivery_failed",
      code:
        input.cause === "cancelled"
          ? "effect_cancelled"
          : "surface_unavailable",
      message:
        input.cause === "cancelled"
          ? "The Kitchen command was cancelled before browser delivery."
          : "The Kitchen surface was unavailable before the command deadline.",
    });
    proposed = {
      kind: "surface_settled",
      receipt,
      settledAt: input.now,
    };
  }
  const committed = commitTerminalSurfaceProjection({
    storage: input.storage,
    request: input.request,
    proposed,
    now: input.now,
  });
  if (committed.kind !== "terminal") return;
  await repairTerminalSurfaceProjection(
    input.storage,
    input.db,
    committed.request,
    committed.projection,
    input.now,
  );
}

async function repairProjectionAfterSettlement(
  storage: DurableObjectStorage,
  db: OrganisationDatabase,
  request: SurfaceEffectRequestV1,
  projection: Variant<SurfaceEffectProjection, "surface_settled">,
): Promise<void> {
  await repairTerminalSurfaceProjection(
    storage,
    db,
    request,
    projection,
    projection.settledAt,
  );
}

async function repairTerminalSurfaceProjection(
  storage: DurableObjectStorage,
  db: OrganisationDatabase,
  request: SurfaceEffectRequestV1,
  projection: TerminalSurfaceProjection,
  repairedAt: number,
): Promise<void> {
  try {
    if (projection.kind === "surface_settled")
      await repairSurfaceProjection(db, request, projection);
    else await projectSurfaceIndeterminate(db, request, repairedAt);
    markSurfaceProjectionComplete(storage.sql, request, projection, repairedAt);
  } catch {
    await scheduleBakerySurfaceEffectRecovery(
      storage,
      Date.now() + SURFACE_EFFECT_RETRY_MS,
    );
  }
}

async function publishSurfaceDelivery(
  db: OrganisationDatabase,
  request: SurfaceEffectRequestV1,
): Promise<void> {
  const effect = request.effect;
  await db.batch([
    db
      .prepare(
        `INSERT INTO bakery_surface_effect_delivery (
           effect_id, organisation_id, user_id, session_id, turn_id,
           request_id, surface_session_id, surface_epoch, command_digest,
           effect_json, state_kind, receipt_json, deadline_at, created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', NULL, ?, ?, ?)
         ON CONFLICT (effect_id) DO UPDATE SET
           effect_json = excluded.effect_json,
           updated_at = excluded.updated_at
         WHERE bakery_surface_effect_delivery.state_kind = 'dispatching'`,
      )
      .bind(
        effect.effectId,
        request.organisationId,
        request.userId,
        request.sessionId,
        request.turnId,
        request.requestId,
        bakeryEffectDeliveryTarget(effect).surfaceSessionId,
        bakeryEffectDeliveryTarget(effect).surfaceEpoch,
        effect.commandDigest,
        JSON.stringify(effect),
        effect.deadlineAt,
        request.lease.issuedAt,
        request.lease.issuedAt,
      ),
    timelineStatement(db, request, "started", request.lease.issuedAt),
  ]);
}

async function repairSurfaceProjection(
  db: OrganisationDatabase,
  request: SurfaceEffectRequestV1,
  projection: Variant<SurfaceEffectProjection, "surface_settled">,
): Promise<void> {
  const receipt = projection.receipt;
  const settledAt = projection.settledAt;
  await db.batch([
    db
      .prepare(
        `INSERT INTO bakery_surface_effect_delivery (
           effect_id, organisation_id, user_id, session_id, turn_id,
           request_id, surface_session_id, surface_epoch, command_digest,
           effect_json, state_kind, receipt_json, deadline_at, created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?, ?, ?)
         ON CONFLICT (effect_id) DO UPDATE SET
           state_kind = 'settled', receipt_json = excluded.receipt_json,
           updated_at = excluded.updated_at`,
      )
      .bind(
        request.effect.effectId,
        request.organisationId,
        request.userId,
        request.sessionId,
        request.turnId,
        request.requestId,
        bakeryEffectDeliveryTarget(request.effect).surfaceSessionId,
        bakeryEffectDeliveryTarget(request.effect).surfaceEpoch,
        request.effect.commandDigest,
        JSON.stringify(request.effect),
        JSON.stringify(receipt),
        request.effect.deadlineAt,
        request.lease.issuedAt,
        settledAt,
      ),
    timelineStatement(db, request, "started", request.lease.issuedAt),
    timelineStatement(db, request, "settled", settledAt),
  ]);
}

async function projectSurfaceIndeterminate(
  db: OrganisationDatabase,
  request: SurfaceEffectRequestV1,
  at: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO bakery_surface_effect_delivery (
           effect_id, organisation_id, user_id, session_id, turn_id,
           request_id, surface_session_id, surface_epoch, command_digest,
           effect_json, state_kind, receipt_json, deadline_at, created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'indeterminate', NULL, ?, ?, ?)
         ON CONFLICT (effect_id) DO UPDATE SET
           state_kind = 'indeterminate', receipt_json = NULL,
           updated_at = excluded.updated_at`,
      )
      .bind(
        request.effect.effectId,
        request.organisationId,
        request.userId,
        request.sessionId,
        request.turnId,
        request.requestId,
        bakeryEffectDeliveryTarget(request.effect).surfaceSessionId,
        bakeryEffectDeliveryTarget(request.effect).surfaceEpoch,
        request.effect.commandDigest,
        JSON.stringify(request.effect),
        request.effect.deadlineAt,
        request.lease.issuedAt,
        at,
      ),
    timelineStatement(db, request, "started", request.lease.issuedAt),
    timelineStatement(db, request, "indeterminate", at),
  ]);
}

function timelineStatement(
  db: OrganisationDatabase,
  request: SurfaceEffectRequestV1,
  kind: "started" | "settled" | "indeterminate",
  createdAt: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO bakery_surface_timeline_event (
         organisation_id, user_id, session_id, turn_id, request_id,
         effect_id, event_kind, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      request.organisationId,
      request.userId,
      request.sessionId,
      request.turnId,
      request.requestId,
      request.effect.effectId,
      kind,
      createdAt,
    );
}

function persistSurfaceDispatch(
  sql: SqlStorage,
  request: SurfaceEffectRequestV1,
  now: number,
): void {
  sql.exec(
    `INSERT INTO actor_outbox (
       effect_id, organisation_id, originating_event_id, request_envelope,
       state_kind, state_projection, updated_at
     ) VALUES (?, ?, ?, ?, 'dispatching', ?, ?)`,
    request.effect.effectId,
    request.organisationId,
    `surface:${request.turnId}:${request.callId}`,
    JSON.stringify(request),
    JSON.stringify({
      kind: "surface_dispatching",
      publication: "pending",
    } satisfies SurfaceEffectProjection),
    now,
  );
}

function markSurfacePublished(
  sql: SqlStorage,
  effectId: string,
  now: number,
): void {
  sql.exec(
    `UPDATE actor_outbox
     SET state_projection = ?, updated_at = ?
     WHERE effect_id = ? AND state_kind = 'dispatching'`,
    JSON.stringify({
      kind: "surface_dispatching",
      publication: "published",
    } satisfies SurfaceEffectProjection),
    now,
    effectId,
  );
}

function commitSurfaceSettlement(input: {
  readonly storage: DurableObjectStorage;
  readonly organisationId: OrganisationId;
  readonly receipt: BakerySurfaceReceiptV1;
  readonly now: () => number;
  readonly validatedRequest: SurfaceEffectRequestV1;
}): SurfaceSettlementCommit {
  return input.storage.transactionSync(
    commitSurfaceSettlementTransaction.bind(
      null,
      input.storage.sql,
      input.organisationId,
      input.receipt,
      input.now,
      input.validatedRequest,
    ),
  );
}

function commitSurfaceSettlementTransaction(
  sql: SqlStorage,
  organisationId: OrganisationId,
  receipt: BakerySurfaceReceiptV1,
  now: () => number,
  validatedRequest: SurfaceEffectRequestV1,
): SurfaceSettlementCommit {
  const row = readSurfaceOutbox(sql, receipt.effectId);
  if (row === null) return { ok: false, code: "surface_effect_missing" };
  const stored = parseSurfaceOutbox(row);
  if (stored === null || !sameJson(stored.request, validatedRequest))
    return { ok: false, code: "surface_effect_conflict" };
  if (stored.request.organisationId !== organisationId)
    return { ok: false, code: "surface_effect_organisation_mismatch" };
  if (!receiptMatchesEffect(receipt, stored.request.effect))
    return { ok: false, code: "surface_effect_conflict" };
  if (stored.projection.kind === "surface_settled") {
    return sameReceipt(stored.projection.receipt, receipt)
      ? {
          ok: true,
          kind: "duplicate",
          request: stored.request,
          projection: stored.projection,
        }
      : { ok: false, code: "surface_effect_conflict" };
  }
  if (stored.projection.kind === "surface_indeterminate")
    return { ok: false, code: "surface_effect_conflict" };
  if (stored.projection.publication !== "published")
    return { ok: false, code: "surface_effect_receipt_invalid" };
  const settledAt = now();
  if (settledAt >= stored.request.effect.deadlineAt)
    return { ok: false, code: "surface_effect_expired" };
  if (
    !preflightHarnessTurnLeaseInTransaction(
      sql,
      stored.request.lease,
      settledAt,
    ).ok
  )
    return { ok: false, code: "surface_effect_authority_invalid" };
  const projection: SettledSurfaceProjection = {
    kind: "surface_settled",
    receipt,
    settledAt,
  };
  writeTerminalSurfaceProjection(sql, stored.request, projection, settledAt);
  const committed = readSurfaceOutbox(sql, receipt.effectId);
  const canonical = committed === null ? null : parseSurfaceOutbox(committed);
  if (
    canonical === null ||
    canonical.projection.kind !== "surface_settled" ||
    !sameReceipt(canonical.projection.receipt, receipt)
  )
    return { ok: false, code: "surface_effect_conflict" };
  return {
    ok: true,
    kind: "accepted",
    request: canonical.request,
    projection: canonical.projection,
  };
}

function commitTerminalSurfaceProjection(input: {
  readonly storage: DurableObjectStorage;
  readonly request: SurfaceEffectRequestV1;
  readonly proposed: TerminalSurfaceProjection;
  readonly now: number;
}): TerminalSurfaceCommit {
  return input.storage.transactionSync(
    commitTerminalSurfaceProjectionTransaction.bind(
      null,
      input.storage.sql,
      input.request,
      input.proposed,
      input.now,
    ),
  );
}

function commitTerminalSurfaceProjectionTransaction(
  sql: SqlStorage,
  request: SurfaceEffectRequestV1,
  proposed: TerminalSurfaceProjection,
  now: number,
): TerminalSurfaceCommit {
  const row = readSurfaceOutbox(sql, request.effect.effectId);
  const stored = row === null ? null : parseSurfaceOutbox(row);
  if (stored === null || !sameJson(stored.request, request))
    return { kind: "missing_or_corrupt" };
  if (stored.projection.kind !== "surface_dispatching")
    return {
      kind: "terminal",
      request: stored.request,
      projection: stored.projection,
    };
  const authority = preflightHarnessTurnLeaseInTransaction(
    sql,
    stored.request.lease,
    now,
  );
  if (authority.ok && now < stored.request.effect.deadlineAt)
    return { kind: "live" };
  writeTerminalSurfaceProjection(sql, stored.request, proposed, now);
  const committed = readSurfaceOutbox(sql, request.effect.effectId);
  const canonical = committed === null ? null : parseSurfaceOutbox(committed);
  if (canonical === null || canonical.projection.kind === "surface_dispatching")
    return { kind: "missing_or_corrupt" };
  return {
    kind: "terminal",
    request: canonical.request,
    projection: canonical.projection,
  };
}

function writeTerminalSurfaceProjection(
  sql: SqlStorage,
  request: SurfaceEffectRequestV1,
  projection: TerminalSurfaceProjection,
  now: number,
): void {
  const stateKind =
    projection.kind === "surface_settled" ? "settled" : "indeterminate";
  sql.exec(
    `UPDATE actor_outbox
     SET state_kind = ?, state_projection = ?, updated_at = ?
     WHERE effect_id = ? AND organisation_id = ? AND state_kind = 'dispatching'`,
    stateKind,
    JSON.stringify(projection),
    now,
    request.effect.effectId,
    request.organisationId,
  );
}

function markSurfaceProjectionComplete(
  sql: SqlStorage,
  request: SurfaceEffectRequestV1,
  projection: TerminalSurfaceProjection,
  now: number,
): void {
  const stateKind =
    projection.kind === "surface_settled" ? "settled" : "indeterminate";
  sql.exec(
    `UPDATE actor_outbox
     SET state_kind = 'reconciled', updated_at = ?
     WHERE effect_id = ? AND organisation_id = ? AND state_kind = ?
       AND state_projection = ?`,
    now,
    request.effect.effectId,
    request.organisationId,
    stateKind,
    JSON.stringify(projection),
  );
}

/**
 * The time a surface effect is due for recovery: at once, or after the
 * backoff of its failed repairs (1 s, doubled, at most 15 minutes).
 */
const SURFACE_REPAIR_DUE = `(CASE WHEN recovery_attempts = 0 THEN 0
  ELSE updated_at + min(${SURFACE_EFFECT_MAX_BACKOFF_MS},
    ${SURFACE_EFFECT_RETRY_MS} << (recovery_attempts - 1)) END)`;

/**
 * Moves a surface effect that recovery cannot use to the terminal
 * `quarantined` state. A pending or dispatching effect reads as uncertain, so
 * a turn that waits for it ends; a settled or uncertain effect keeps its
 * evidence. The write compares the state that recovery read.
 */
function quarantineSurfaceEffect(
  sql: SqlStorage,
  row: SurfaceOutboxRow,
  now: number,
  reason: "corrupt" | "repair_failed",
): void {
  const written = sql.exec(
    `UPDATE actor_outbox
     SET state_kind = 'quarantined', recovery_attempts = recovery_attempts + 1,
         updated_at = ?,
         state_projection = CASE WHEN state_kind IN ('pending', 'dispatching')
           THEN ? ELSE state_projection END
     WHERE effect_id = ? AND state_kind = ?`,
    now,
    JSON.stringify({
      kind: "surface_indeterminate",
      reason: "expired_after_dispatch",
    } satisfies SurfaceEffectProjection),
    row.effectId,
    row.stateKind,
  );
  if (written.rowsWritten === 1)
    traceWarn("bakery_surface_effect.quarantined", {
      requestId: newRequestId(),
      effect_id: row.effectId,
      from: row.stateKind,
      reason,
    });
}

/**
 * Counts one failed repair of a settled or uncertain effect. The row moves to
 * the end of the recovery order, and the last allowed failure quarantines it.
 */
function recordSurfaceRepairFailure(
  sql: SqlStorage,
  row: SurfaceOutboxRow,
  now: number,
): void {
  const attempts =
    sql
      .exec<{ attempts: number }>(
        "SELECT recovery_attempts AS attempts FROM actor_outbox WHERE effect_id = ? AND state_kind = ?",
        row.effectId,
        row.stateKind,
      )
      .toArray()[0]?.attempts ?? null;
  if (attempts === null) return;
  if (attempts + 1 >= SURFACE_EFFECT_REPAIR_ATTEMPTS) {
    quarantineSurfaceEffect(sql, row, now, "repair_failed");
    return;
  }
  sql.exec(
    `UPDATE actor_outbox
     SET recovery_attempts = recovery_attempts + 1, updated_at = ?
     WHERE effect_id = ? AND state_kind = ? AND recovery_attempts = ?`,
    now,
    row.effectId,
    row.stateKind,
    attempts,
  );
}

/** The earliest time that a settled or uncertain effect may retry its repair. */
function nextSurfaceRepairAt(sql: SqlStorage): number | null {
  const row = sql
    .exec<{ dueAt: number | null }>(
      `SELECT MIN(${SURFACE_REPAIR_DUE}) AS dueAt
       FROM actor_outbox
       WHERE state_kind IN ('settled', 'indeterminate') AND recovery_attempts > 0
         AND json_extract(request_envelope, '$.kind') = 'bakery_surface_effect.v1'`,
    )
    .toArray()[0];
  return row?.dueAt ?? null;
}

function readSurfaceOutbox(
  sql: SqlStorage,
  effectId: string,
): SurfaceOutboxRow | null {
  const row = sql
    .exec<SurfaceOutboxRow>(
      `SELECT effect_id AS effectId, organisation_id AS organisationId,
              request_envelope AS requestEnvelope, state_kind AS stateKind,
              state_projection AS stateProjection, updated_at AS updatedAt
       FROM actor_outbox WHERE effect_id = ? LIMIT 1`,
      effectId,
    )
    .toArray()[0];
  return row ?? null;
}

function parseSurfaceOutbox(row: SurfaceOutboxRow): Readonly<{
  request: SurfaceEffectRequestV1;
  projection: SurfaceEffectProjection;
}> | null {
  const request = parseSurfaceEffectRequest(row.requestEnvelope);
  const projection = parseSurfaceEffectProjection(row.stateProjection);
  if (
    request === null ||
    projection === null ||
    request.effect.effectId !== row.effectId ||
    request.organisationId !== row.organisationId ||
    !projectionMatchesState(row.stateKind, projection)
  )
    return null;
  return { request, projection };
}

function parseSurfaceEffectRequest(raw: string): SurfaceEffectRequestV1 | null {
  const value = jsonOrNull(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "kind",
      "organisationId",
      "sessionId",
      "turnId",
      "requestId",
      "callId",
      "userId",
      "lease",
      "effect",
    ]) ||
    value.kind !== "bakery_surface_effect.v1" ||
    !isNonEmptyString(value.organisationId) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.turnId) ||
    !isNonEmptyString(value.requestId) ||
    !isNonEmptyString(value.callId) ||
    !isNonEmptyString(value.userId)
  )
    return null;
  const lease = parsePersistedHarnessTurnLease(value.lease);
  const effect = parseBakerySurfaceEffect(value.effect);
  if (
    lease === null ||
    effect.kind === "invalid" ||
    lease.session.organisationId !== value.organisationId ||
    lease.session.sessionId !== value.sessionId ||
    lease.turn.turnId !== value.turnId ||
    lease.requestAuthority.kind !== "control" ||
    lease.requestAuthority.userId !== value.userId
  )
    return null;
  return {
    kind: "bakery_surface_effect.v1",
    organisationId: value.organisationId,
    sessionId: value.sessionId,
    turnId: value.turnId,
    requestId: value.requestId,
    callId: value.callId,
    userId: value.userId,
    lease,
    effect: effect.value,
  };
}

function parseSurfaceEffectProjection(
  raw: string,
): SurfaceEffectProjection | null {
  const value = jsonOrNull(raw);
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "surface_dispatching")
    return hasExactKeys(value, ["kind", "publication"]) &&
      (value.publication === "pending" || value.publication === "published")
      ? { kind: "surface_dispatching", publication: value.publication }
      : null;
  if (value.kind === "surface_settled") {
    if (
      !hasExactKeys(value, ["kind", "receipt", "settledAt"]) ||
      typeof value.settledAt !== "number" ||
      !Number.isSafeInteger(value.settledAt) ||
      value.settledAt < 0
    )
      return null;
    const receipt = parseBakerySurfaceReceipt(value.receipt);
    return receipt.kind === "valid"
      ? {
          kind: "surface_settled",
          receipt: receipt.value,
          settledAt: value.settledAt,
        }
      : null;
  }
  if (value.kind !== "surface_indeterminate") return null;
  return hasExactKeys(value, ["kind", "reason"]) &&
    (value.reason === "cancelled_after_dispatch" ||
      value.reason === "expired_after_dispatch")
    ? { kind: "surface_indeterminate", reason: value.reason }
    : null;
}

function projectionMatchesState(
  state: SurfaceOutboxRow["stateKind"],
  projection: SurfaceEffectProjection,
): boolean {
  return (
    (state === "dispatching" && projection.kind === "surface_dispatching") ||
    (state === "settled" && projection.kind === "surface_settled") ||
    (state === "indeterminate" &&
      projection.kind === "surface_indeterminate") ||
    ((state === "reconciled" || state === "quarantined") &&
      projection.kind !== "surface_dispatching")
  );
}

// A standalone attempt adopts its browser request, then its preview (+2). A
// scheduled first step also adopts one before its candidate (+2); a
// continuation's request is already bound, so only the candidate changes it.
function simulationEpoch(
  command: Variant<BakerySurfaceEffectV1["command"], "simulate_workcell">,
  epoch: number,
): boolean {
  const target = command.target.surfaceEpoch;
  return command.schemaVersion === 2
    ? epoch === target + 1 || epoch === target + 2
    : epoch === target + 2;
}

/**
 * A page command's receipt names the page instance that the command targeted
 * and shows it as the browser captured it after the command (Plan 87).
 */
function pageReceiptIsValid(
  command: SurfacePageCommandV1,
  receipt: BakerySurfaceReceiptV1,
  deadlineAt: number,
  now: number,
): boolean {
  if (receipt.outcome.kind === "page_rejected") return true;
  if (receipt.outcome.kind !== "page_completed") return false;
  const observation = receipt.outcome.observation;
  return (
    observation.surface === command.surface &&
    observation.instance?.surfaceSessionId ===
      command.target.surfaceSessionId &&
    observation.capturedAt >= deadlineAt - SURFACE_EFFECT_TTL_MS &&
    observation.capturedAt <= now + SURFACE_EFFECT_TTL_MS
  );
}

async function validReceiptForStoredCommand(
  effect: BakerySurfaceEffectV1,
  receipt: BakerySurfaceReceiptV1,
  now: number,
): Promise<boolean> {
  if (!receiptMatchesEffect(receipt, effect)) return false;
  if (receipt.outcome.kind === "delivery_failed") return true;
  if (effect.command.kind === "prepare_context") {
    return (
      receipt.outcome.kind === "prepared" &&
      sameJson(receipt.outcome.binding, effect.command.binding) &&
      receipt.outcome.surface.context.capturedAt >=
        effect.deadlineAt - SURFACE_EFFECT_TTL_MS &&
      receipt.outcome.surface.context.capturedAt <=
        now + SURFACE_EFFECT_TTL_MS &&
      receipt.outcome.surface.context.supportedCommands.includes(
        effect.command.requiredCommand,
      ) &&
      (await verifyBakerySurfaceAttachment(receipt.outcome.surface))
    );
  }
  if (effect.command.kind === "page_command")
    return pageReceiptIsValid(effect.command, receipt, effect.deadlineAt, now);
  if (receipt.outcome.kind !== "completed") return false;
  const result = receipt.outcome.result;
  if (result.command !== effect.command.kind) return false;
  if (result.kind === "rejected") return true;
  if (!(await verifyBakerySurfaceAttachment(result.surface))) return false;
  const context = result.surface.context;
  if (
    context.surfaceSessionId !==
      bakeryEffectDeliveryTarget(effect).surfaceSessionId ||
    (effect.command.kind === "accept_candidate"
      ? context.surfaceEpoch !==
          bakeryEffectDeliveryTarget(effect).surfaceEpoch &&
        context.surfaceEpoch !==
          bakeryEffectDeliveryTarget(effect).surfaceEpoch + 1
      : (effect.command.kind === "file_action" &&
            effect.command.action.kind === "import") ||
          effect.command.kind === "prepare_workcell" ||
          effect.command.kind === "prepare_run_open" ||
          effect.command.kind === "run_shift" ||
          effect.command.kind === "rotate_equipment" ||
          effect.command.kind === "set_equipment_angle" ||
          effect.command.kind === "move_equipment" ||
          effect.command.kind === "toggle_opening" ||
          effect.command.kind === "select_floor_plan" ||
          effect.command.kind === "reset_floor_plan" ||
          (effect.command.kind === "edit_rehearsal" &&
            !isRehearsalChange(effect.command.edit))
        ? context.surfaceEpoch !==
          bakeryEffectDeliveryTarget(effect).surfaceEpoch + 1
        : effect.command.kind === "simulate_workcell"
          ? !simulationEpoch(effect.command, context.surfaceEpoch)
          : effect.command.kind === "compare_shift" ||
              effect.command.kind === "apply_production"
            ? context.surfaceEpoch !==
                bakeryEffectDeliveryTarget(effect).surfaceEpoch &&
              context.surfaceEpoch !==
                bakeryEffectDeliveryTarget(effect).surfaceEpoch + 1
            : effect.command.kind === "start_production"
              ? context.surfaceEpoch !==
                bakeryEffectDeliveryTarget(effect).surfaceEpoch + 2
              : context.surfaceEpoch !==
                bakeryEffectDeliveryTarget(effect).surfaceEpoch)
  )
    return false;
  switch (effect.command.kind) {
    case "inspect_surface":
      return result.output.kind === "surface";
    case "file_action":
      return (
        result.output.kind === "file" &&
        result.output.action === effect.command.action.kind &&
        (effect.command.action.kind !== "import" ||
          result.output.manifest.digest === effect.command.action.digest)
      );
    case "inspect_scenario_save":
      return result.output.kind === "scenario_save_inspection";
    case "inspect_run_save":
      return (
        result.output.kind === "run_save_inspection" &&
        result.output.runKind === effect.command.runKind
      );
    case "list_saved_runs":
      return (
        result.output.kind === "saved_runs" &&
        result.output.runKind === effect.command.runKind &&
        result.output.cursor === effect.command.cursor
      );
    case "prepare_run_open":
      return (
        result.output.kind === "surface" &&
        context.runOpenReview !== null &&
        context.runOpenReview.id === effect.command.id &&
        context.runOpenReview.runKind === effect.command.runKind &&
        ((context.active.kind === "production" &&
          effect.command.runKind === "production") ||
          (context.active.kind === "rehearsal" &&
            context.active.rehearsalKind === "scheduled" &&
            effect.command.runKind === "rehearsal")) &&
        context.active.panel === "files" &&
        context.active.playback?.playback === "paused"
      );
    case "prepare_workcell":
      return (
        result.output.kind === "surface" &&
        context.active.kind === "rehearsal" &&
        context.active.rehearsalKind === "scheduled" &&
        context.active.pendingOperation !== null &&
        context.active.tasks.length > 0
      );
    case "stop_simulation":
      return result.output.kind === "surface" && context.simulation === null;
    case "control_workspace_view": {
      if (
        context.active.kind === "persistent" ||
        context.active.kind === "persistent-snapshot"
      )
        return false;
      if (result.output.kind !== "surface") return false;
      const action = effect.command.action;
      if (action.kind === "setCamera")
        return context.active.view.camera === action.camera;
      if (action.kind === "resetCamera")
        return context.active.view.camera === "perspective";
      if (action.kind === "setDoorPreview") {
        if (
          context.active.kind !== "rehearsal" ||
          context.active.rehearsalKind !== "standalone" ||
          context.active.readiness !== "ready"
        )
          return false;
        const door = context.active.view.doorInspection;
        return action.degrees === null
          ? door.kind === "recorded"
          : door.kind === "preview" &&
              door.degrees === action.degrees &&
              context.active.playback.playback === "paused";
      }
      if (context.active.kind !== "shift") return false;
      const view = context.active.view;
      switch (action.kind) {
        case "openDock":
          return view.dock === action.dock;
        case "resetView":
          return view.camera === "perspective" && view.dock === "closed";
        case "setLabels":
          return view.labels === action.labels;
        case "setMinimap":
          return view.minimap === action.visible;
        case "setChrome":
          return view.chrome === action.chrome;
        default:
          return assertNever(action);
      }
    }
    case "show_production_panel":
      return (
        result.output.kind === "surface" &&
        ((context.active.kind === "production" &&
          context.active.readiness === "ready") ||
          (context.active.kind === "rehearsal" &&
            context.active.rehearsalKind === "scheduled" &&
            context.active.readiness === "ready")) &&
        context.active.panel === effect.command.panel
      );
    case "control_baseline": {
      if (
        result.output.kind !== "surface" ||
        context.comparison === null ||
        canonicalJson(context.comparison.current) !==
          canonicalJson(effect.command.comparison.current)
      )
        return false;
      return effect.command.action === "clear"
        ? context.comparison.baseline === null
        : canonicalJson(context.comparison.baseline) ===
            canonicalJson(effect.command.comparison.current);
    }
    case "control_playback": {
      if (result.output.kind !== "surface") return false;
      if (
        context.active.kind === "persistent" ||
        context.active.kind === "persistent-snapshot"
      )
        return false;
      const playback = context.active.playback;
      if (playback === null) return false;
      switch (effect.command.action.kind) {
        case "play":
          return playback.playback === "playing";
        case "pause":
          return playback.playback === "paused";
        case "seek":
          return (
            playback.playback === "paused" &&
            playback.cursorSeconds === effect.command.action.seconds
          );
        case "restart":
          return playback.playback === "paused" && playback.cursorSeconds === 0;
        case "speed":
          return playback.speed === effect.command.action.speed;
        case "next_event":
          return playback.playback === "paused";
      }
    }
    case "read_draft":
      return (
        result.output.kind === "draft" &&
        context.active.kind === "shift" &&
        sameJson(result.output.draft.reference, context.active.draft)
      );
    case "query_tasks":
      return (
        result.output.kind === "task_query" &&
        result.output.tasks.length <= effect.command.filter.limit &&
        result.output.tasks.every(
          taskMatchesQuery.bind(null, effect.command.filter.text),
        )
      );
    case "set_view":
      return (
        result.output.kind === "surface" &&
        (context.active.kind === "shift" ||
          context.active.kind === "rehearsal" ||
          (context.active.kind === "production" &&
            context.active.readiness === "ready")) &&
        context.active.selection !== null &&
        context.active.selection.kind === effect.command.view.selection.kind &&
        context.active.selection.id === effect.command.view.selection.id &&
        context.active.playback.cursorSeconds ===
          effect.command.view.cursorSeconds &&
        context.active.playback.playback === "paused"
      );
    case "prepare_layout": {
      if (
        result.output.kind !== "surface" ||
        context.active.kind !== "rehearsal"
      )
        return false;
      const layout = context.active.rackLayout;
      const proposal = layout?.proposal;
      if (
        effect.command.schemaVersion === 2 &&
        (context.active.rehearsalKind !== "scheduled" ||
          context.active.rackLayout?.operationId !== effect.command.operationId)
      )
        return false;
      return (
        layout !== null &&
        proposal != null &&
        layout.modelHash === effect.command.baseModelHash &&
        proposal.baseModelHash === effect.command.baseModelHash &&
        proposal.xMm === effect.command.xMm &&
        proposal.yMm === effect.command.yMm
      );
    }
    case "prepare_production_control":
      return (
        result.output.kind === "surface" &&
        context.active.kind === "persistent" &&
        context.active.pendingControl !== null &&
        sameJson(context.active.target, effect.command.production) &&
        sameJson(
          context.active.pendingControl.target,
          effect.command.production,
        ) &&
        sameJson(
          context.active.pendingControl.control,
          effect.command.control,
        ) &&
        context.active.pendingControl.expiresAt === effect.deadlineAt
      );
    case "prepare_edit":
      return (
        result.output.kind === "surface" &&
        context.active.kind === "shift" &&
        context.active.pendingEdit !== null &&
        sameJson(
          context.active.pendingEdit.baseDraft,
          effect.command.baseDraft,
        ) &&
        sameJson(context.active.pendingEdit.edits, effect.command.edits)
      );
    // A shift run recalculates from 06:00: a new draft revision, playback
    // reset and paused, and no proposal left to apply.
    case "run_shift":
      return (
        result.output.kind === "surface" &&
        context.active.kind === "shift" &&
        context.active.pendingEdit === null &&
        context.active.draft.revision > effect.command.baseDraft.revision &&
        context.active.playback.cursorSeconds === 0 &&
        context.active.playback.playback === "paused"
      );
    case "select_item":
      return (
        result.output.kind === "surface" &&
        context.active.kind === "shift" &&
        context.active.view.dock === "inspector" &&
        context.active.selection.kind === effect.command.selection.kind &&
        context.active.selection.id === effect.command.selection.id
      );
    // Rotate 90° snaps to a quarter turn and turns once; the run follows the
    // new layout.
    case "rotate_equipment": {
      const applianceId = effect.command.applianceId;
      const rotated =
        context.active.kind === "shift"
          ? context.active.layout?.equipment.find(
              (item) => item.id === applianceId,
            )
          : undefined;
      return (
        result.output.kind === "surface" &&
        rotated !== undefined &&
        rotated.rotationDegrees ===
          quarterTurnDegrees(effect.command.rotationDegrees)
      );
    }
    case "move_equipment": {
      const applianceId = effect.command.applianceId;
      const moved =
        context.active.kind === "shift"
          ? context.active.layout?.equipment.find(
              (item) => item.id === applianceId,
            )
          : undefined;
      return result.output.kind === "surface" && moved !== undefined;
    }
    case "toggle_opening": {
      const openingId = effect.command.openingId;
      const opening =
        context.active.kind === "shift"
          ? context.active.layout?.openings?.find(
              (item) => item.id === openingId,
            )
          : undefined;
      return (
        result.output.kind === "surface" &&
        opening !== undefined &&
        (effect.command.open ? opening.progress > 0 : opening.progress < 1)
      );
    }
    case "select_floor_plan":
      return (
        result.output.kind === "surface" &&
        context.active.kind === "shift" &&
        context.active.layout?.floorPlan === effect.command.floorPlan
      );
    case "set_equipment_angle": {
      const applianceId = effect.command.applianceId;
      const rotated =
        context.active.kind === "shift"
          ? context.active.layout?.equipment.find(
              (item) => item.id === applianceId,
            )
          : undefined;
      return (
        result.output.kind === "surface" &&
        rotated !== undefined &&
        rotated.rotationDegrees === effect.command.yawDegrees
      );
    }
    case "configure_interior": {
      const interior =
        context.active.kind === "shift"
          ? context.active.layout?.interior
          : undefined;
      return (
        result.output.kind === "surface" &&
        interior !== undefined &&
        interiorActionApplied(interior, effect.command.action)
      );
    }
    case "reset_floor_plan": {
      const layout =
        context.active.kind === "shift" ? context.active.layout : undefined;
      return (
        result.output.kind === "surface" &&
        layout !== undefined &&
        (effect.command.action === "reset_appliances"
          ? layout.history?.hasCustomLayout !== true
          : effect.command.action === "reset_initial"
            ? layout.history?.canUndo !== true &&
              layout.history?.canRedo !== true &&
              layout.history?.hasCustomLayout !== true
            : true)
      );
    }
    // Compare shifts resets playback to 06:00 on the chosen run.
    case "compare_shift":
      return (
        result.output.kind === "surface" &&
        context.active.kind === "shift" &&
        context.active.variant === effect.command.mode &&
        context.active.view.dock === "comparison" &&
        context.active.playback.cursorSeconds === 0 &&
        context.active.playback.playback === "paused"
      );
    case "prepare_run_save":
      return (
        result.output.kind === "run_save_proposal" &&
        context.active.kind === "rehearsal" &&
        context.active.runSaveProposal !== null &&
        result.output.manifest.name === effect.command.name &&
        sameJson(result.output.manifest, context.active.runSaveProposal)
      );
    case "prepare_scenario_save":
      return (
        result.output.kind === "scenario_save_proposal" &&
        (context.active.kind === "shift" ||
          context.active.kind === "production") &&
        context.active.scenarioSaveProposal !== null &&
        result.output.manifest.name === effect.command.name &&
        sameJson(result.output.manifest, context.active.scenarioSaveProposal)
      );
    case "simulate_workcell":
      // A scheduled step's result waits as a production candidate for the
      // exact operation; a first step adopts a new browser request first.
      if (effect.command.schemaVersion === 2)
        return (
          result.output.kind === "simulation" &&
          result.output.mode === effect.command.mode &&
          ((context.active.kind === "production" &&
            context.active.readiness === "ready") ||
            (context.active.kind === "rehearsal" &&
              context.active.rehearsalKind === "scheduled")) &&
          context.active.candidate?.kind === "production" &&
          context.active.candidate.operationId === effect.command.operationId &&
          context.active.candidate.recordingDigest ===
            result.output.recordingDigest
        );
      return (
        result.output.kind === "simulation" &&
        result.output.mode === effect.command.mode &&
        context.active.kind === "rehearsal" &&
        context.active.rehearsalKind === "standalone" &&
        context.active.candidate?.kind === "workcell" &&
        context.active.candidate.recordingDigest ===
          result.output.recordingDigest &&
        context.active.attemptId !== effect.command.attemptId
      );
    case "apply_reviewed_edit":
      return (
        result.output.kind === "surface" &&
        context.active.kind === "shift" &&
        context.active.pendingEdit === null &&
        context.active.draft.revision > effect.command.baseDraft.revision
      );
    case "edit_rehearsal":
      if (isRehearsalChange(effect.command.edit)) {
        const active = context.active;
        return (
          result.output.kind === "surface" &&
          active.kind === "rehearsal" &&
          active.rehearsalKind === "scheduled" &&
          active.planFingerprint === effect.command.planFingerprint &&
          active.editReview !== null &&
          active.editReview.sourceFingerprint ===
            effect.command.planFingerprint &&
          canonicalJson(active.editReview.change) ===
            canonicalJson(effect.command.edit)
        );
      }
      return (
        result.output.kind === "surface" &&
        context.active.kind === "rehearsal" &&
        context.active.rehearsalKind === "scheduled" &&
        context.active.readiness === "ready" &&
        context.active.planFingerprint !== effect.command.planFingerprint &&
        rehearsalEditVisible(
          effect.command.edit,
          context.active.trays,
          context.active.faults,
        )
      );
    // Draft edits and previews keep the run and its epoch; each changes the
    // draft the digest named.
    case "edit_production":
      if (effect.command.edit.kind === "prepare_replacement") {
        const active = context.active;
        return (
          result.output.kind === "surface" &&
          active.kind === "production" &&
          active.readiness === "ready" &&
          active.draft?.replacement !== null &&
          active.draft?.replacement !== undefined &&
          active.draft.replacement.source === effect.command.edit.source &&
          active.draft.replacement.sourceFingerprint === active.planFingerprint
        );
      }
      return (
        result.output.kind === "surface" &&
        context.active.kind === "production" &&
        context.active.draft !== null &&
        context.active.draft.digest !== effect.command.draftDigest &&
        productionEditVisible(
          effect.command.edit,
          context.active.draft,
          context.active.planFingerprint,
        )
      );
    case "preview_production":
      return (
        result.output.kind === "surface" &&
        context.active.kind === "production" &&
        context.active.draft !== null &&
        context.active.draft.digest !== effect.command.draftDigest &&
        context.active.draft.preview !== null &&
        context.active.draft.preview.planFingerprint !==
          context.active.planFingerprint
      );
    // Applying starts the previewed run on the next epoch. Over accepted
    // results, the operator's replacement review of that preview opens
    // instead, and the run stays on its epoch.
    case "apply_production": {
      const active = context.active;
      if (
        result.output.kind !== "surface" ||
        active.kind !== "production" ||
        active.readiness !== "ready"
      )
        return false;
      if (
        context.surfaceEpoch ===
        bakeryEffectDeliveryTarget(effect).surfaceEpoch + 1
      )
        return (
          active.planFingerprint === effect.command.planFingerprint &&
          active.draft?.preview?.planFingerprint ===
            effect.command.planFingerprint
        );
      const replacement = active.draft?.replacement ?? null;
      return (
        active.panel === "author" &&
        replacement !== null &&
        replacement.source === "preview" &&
        replacement.sourceFingerprint === active.planFingerprint &&
        replacement.proposedFingerprint === effect.command.planFingerprint &&
        replacement.currentResults > 0
      );
    }
    // The catalog opens the financier production run.
    case "start_production":
      return (
        result.output.kind === "surface" && context.active.kind === "production"
      );
    case "discard_candidate":
      return (
        result.output.kind === "surface" &&
        ((context.active.kind === "production" &&
          context.active.readiness === "ready") ||
          (context.active.kind === "rehearsal" &&
            context.active.rehearsalKind === "scheduled")) &&
        context.active.candidate === null &&
        context.active.planFingerprint ===
          effect.command.candidate.planFingerprint
      );
    case "accept_candidate":
      if (
        context.active.kind === "shift" ||
        context.active.kind === "persistent" ||
        context.active.kind === "persistent-snapshot"
      )
        return false;
      return (
        result.output.kind === "surface" &&
        (effect.command.candidate.kind === "production"
          ? context.active.kind === "production" ||
            context.active.rehearsalKind === "scheduled"
          : context.active.kind === "rehearsal") &&
        context.active.candidate === null
      );
  }
}

// A baker or prerequisite change shows on its tray; the other edits show as a
// changed plan fingerprint.
function rehearsalEditVisible(
  edit: Exclude<
    BakeryRehearsalEdit,
    {
      kind:
        | "replace_preset"
        | "clear_results"
        | "remove_tray"
        | "set_ingredients"
        | "set_cell"
        | "add_human_transfer";
    }
  >,
  trays: readonly BakerySurfaceRehearsalTray[],
  faults: Variant<BakeryRehearsalEdit, "set_faults">["faults"],
): boolean {
  switch (edit.kind) {
    case "set_faults":
      return canonicalJson(edit.faults) === canonicalJson(faults);
    case "set_baker":
      return trays.some(
        (tray) => tray.batchId === edit.batchId && tray.baker === edit.baker,
      );
    case "set_prerequisites":
      return trays.some(
        (tray) =>
          tray.batchId === edit.batchId &&
          tray.dependsOn.length === edit.dependsOn.length &&
          edit.dependsOn.every((id) => tray.dependsOn.includes(id)),
      );
    case "add_tray_chain":
    case "set_start":
      return true;
  }
}

// Each draft edit shows on the tray or task it changes; discarding shows the
// applied run as the draft's preview.
function productionEditVisible(
  edit: Exclude<BakeryProductionEdit, { kind: "prepare_replacement" }>,
  draft: BakerySurfaceProductionDraft,
  planFingerprint: string | null,
): boolean {
  if (edit.kind === "set_variant") return draft.variant === edit.variant;
  if (edit.kind === "discard_draft")
    return (
      draft.preview !== null &&
      draft.preview.planFingerprint === planFingerprint
    );
  if (edit.kind === "set_manual_task") {
    const task = draft.manualTasks.find(
      (candidate) => candidate.bakeryTaskId === edit.bakeryTaskId,
    );
    return edit.baker === null &&
      edit.dependsOn.length === 0 &&
      edit.earliestStartSeconds === 0
      ? task === undefined
      : task !== undefined &&
          task.baker === edit.baker &&
          task.earliestStartSeconds === edit.earliestStartSeconds &&
          sameLinks(task.dependsOn, edit.dependsOn);
  }
  const tray = draft.assignments.find(
    (assignment) =>
      assignment.batchId === edit.batchId && assignment.tray === edit.tray,
  );
  switch (edit.kind) {
    case "assign_tray":
      return tray !== undefined;
    case "unassign_tray":
      return tray === undefined;
    case "set_baker":
      return tray?.baker === edit.baker;
    case "set_start":
      return tray?.earliestStartSeconds === edit.earliestStartSeconds;
    case "set_prerequisites":
      return tray !== undefined && sameLinks(tray.dependsOn, edit.dependsOn);
  }
}

function sameLinks(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && right.every((id) => left.includes(id));
}

function taskMatchesQuery(
  query: string,
  task: Extract<
    Variant<BakerySurfaceReceiptV1["outcome"], "completed">["result"],
    { kind: "succeeded"; command: "query_tasks" }
  >["output"]["tasks"][number],
): boolean {
  const haystack = [
    task.id,
    task.name,
    task.batchId,
    ...task.resources,
    ...task.constraints,
  ]
    .join(" ")
    .toLocaleLowerCase();
  return haystack.includes(query.toLocaleLowerCase());
}

function receiptMatchesEffect(
  receipt: BakerySurfaceReceiptV1,
  effect: BakerySurfaceEffectV1,
): boolean {
  return (
    receipt.effectId === effect.effectId &&
    receipt.dispatchId === effect.dispatchId &&
    receipt.commandDigest === effect.commandDigest
  );
}

function sameReceipt(
  left: BakerySurfaceReceiptV1,
  right: BakerySurfaceReceiptV1,
): boolean {
  return sameJson(left, right);
}

async function surfaceDeliveryWasPublished(
  db: OrganisationDatabase,
  effectId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT state_kind AS stateKind
       FROM bakery_surface_effect_delivery WHERE effect_id = ?`,
    )
    .bind(effectId)
    .first<{ stateKind: string }>();
  return row !== null;
}

function nextSurfaceEffectDeadline(sql: SqlStorage): number | null {
  const row = sql
    .exec<{ deadlineAt: number | null }>(
      `SELECT MIN(json_extract(request_envelope, '$.effect.deadlineAt')) AS deadlineAt
       FROM actor_outbox
       WHERE state_kind = 'dispatching'
         AND json_extract(request_envelope, '$.kind') = 'bakery_surface_effect.v1'`,
    )
    .toArray()[0];
  return row?.deadlineAt ?? null;
}

function minimumTime(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function interiorActionApplied(
  interior: BakerySurfaceStoreInterior,
  action: BakeryStoreInteriorAction,
): boolean {
  switch (action.kind) {
    case "apply_preset":
      return interior.preset === action.preset;
    case "set_floor_material":
      return interior.floorMaterial === action.floorMaterial;
    case "set_wall_material":
      return interior.wallMaterial === action.wallMaterial;
    case "set_fixture_finish":
      return interior.fixtureFinish === action.fixtureFinish;
    case "set_lighting_style":
      return interior.lightingStyle === action.lightingStyle;
    case "set_wall_height":
      return interior.wallHeightMode === action.wallHeightMode;
    case "set_furnishings":
      return interior.showFurnishings === action.showFurnishings;
    default:
      return assertNever(action);
  }
}

function timelineEvent(
  row: TimelineRow,
  effect: BakerySurfaceEffectV1,
  terminal: BakerySurfaceTimelineEvent["terminal"],
): BakerySurfaceTimelineEvent {
  return {
    sequence: row.sequence,
    requestId: row.requestId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    createdAt: row.createdAt,
    effect,
    terminal,
  };
}

function dispatchResult(
  receipt: BakerySurfaceReceiptV1,
): BakerySurfaceEffectDispatch {
  return {
    receiptId: `surface_receipt_${receipt.effectId}`,
    receipt,
  };
}

async function indeterminateDispatch(
  effect: BakerySurfaceEffectV1,
): Promise<BakerySurfaceEffectDispatch> {
  return dispatchResult(
    await createBakerySurfaceReceipt(effect, {
      kind: "delivery_failed",
      code: "effect_indeterminate",
      message:
        "Kitchen delivery began, but its final browser outcome is unknown.",
    }),
  );
}

function jsonOrNull(raw: string | null): unknown {
  return raw === null ? null : parseJsonOrNull(raw);
}

import type { OrganisationDatabase } from "../database-handles";
import {
  createCommerceClient,
  createCommerceEntityPlaneClient,
} from "./contract/client";
import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
} from "../organisation-execution-scope";
import type { CanonicalCommerceDelivery } from "@purin-labs/commerce-contracts";
import type {
  CommerceAdminClient,
  CommerceClientResult,
  CommerceReceivedDeliveryV1,
} from "@purin-labs/commerce-client";

import { requireActiveOrganisationActorAtPlacement } from "../actors/actor-router";
import type { PendingCommerceCue } from "../actors/commerce-projection";
import { resolveCommerceMerchantBinding } from "../data/commerce-merchant-binding";
import {
  ensureCommerceWebhookSubscription,
  startCommerceWebhookRead,
} from "./webhooks";
import { resolveOrganisationCommerceSystemAuthority } from "../data/organisation-commerce-system";
import {
  createCommerceEntityPlaneCueEvents,
  createCueQueueMessage,
  ensureCommerceLowStockCueSnapshot,
} from "../cues/engine";
import type { Env, OrganisationActorStub } from "../env";
import {
  createCommerceOutboxReconcileQueueMessage,
  type CommerceOutboxReconcileQueueMessage,
} from "./contract/queue-messages";
import { newRequestId } from "../ids";
import { traceWarn } from "../observability";
import {
  parseOrganisationId,
  parseIntegrationAccountId,
  type OrganisationId,
} from "../ids";
import {
  createCommerceEd25519Verifier,
  normalizeCommerceEngineDelivery,
} from "./provider";
import { recordPaidReceipts } from "./paid-receipt";
import { assertNever } from "@purin-labs/std";
import { CUE_CLAIM_ABANDONED_AFTER_MS } from "../actors/cue-delivery";

/**
 * A cue that the queue has not settled is sent again only after its claim can
 * have been ended as abandoned: the new message then reads a settled claim and
 * settles the cue, and the queue's own retries are not doubled.
 */
const COMMERCE_CUE_RESEND_AFTER_MS = CUE_CLAIM_ABANDONED_AFTER_MS + 5 * 60_000;

type CommerceOutboxReconcileResult =
  | Readonly<{
      kind: "drained";
      acknowledged: number;
      replayed: number;
      /** Deliveries quarantined this pass; they stay pending at Commerce. */
      rejected: number;
    }>
  | Readonly<{
      kind: "rejected";
      deliveryId: string | null;
      code: string;
    }>
  | Readonly<{
      kind: "retry";
      deliveryId: string | null;
      code: string;
    }>;

export async function runScheduledCommerceOutboxReconciliation(
  env: Env,
  now: number,
): Promise<readonly CommerceOutboxReconcileResult[]> {
  const results: CommerceOutboxReconcileResult[] = [];
  // A binding is stored with its Organisation, so every regional database is read.
  for (const database of configuredOrganisationDatabases(env))
    await reconcileCommerceBindings(env, database, now, results);
  return results;
}

async function reconcileCommerceBindings(
  env: Env,
  database: OrganisationDatabase,
  now: number,
  results: CommerceOutboxReconcileResult[],
): Promise<void> {
  const session = database.withSession("first-primary");
  let after = "";
  for (;;) {
    const rows = await session
      .prepare(
        // A Pantry commerce binding names an account identity that has no account row.
        // Where a row exists, it must be active.
        `SELECT b.binding_id AS bindingId, b.organisation_id AS organisationId,
                b.integration_account_id AS integrationAccountId
         FROM underclerk_merchant_binding b
         JOIN organisation t ON t.organisation_id = b.organisation_id AND t.status = 'active'
         JOIN organisation_commerce_system s ON s.organisation_id = b.organisation_id
           AND s.system_kind = 'satyr_commerce' AND s.underclerk_binding_id = b.binding_id
         LEFT JOIN integration_account a ON a.integration_account_id = b.integration_account_id
           AND a.organisation_id = b.organisation_id
         WHERE b.binding_id > ? AND (a.integration_account_id IS NULL OR a.lifecycle = 'active')
         ORDER BY b.binding_id LIMIT 100`,
      )
      .bind(after)
      .all<Record<string, unknown>>();
    for (const row of rows.results) {
      if (
        typeof row.bindingId !== "string" ||
        typeof row.organisationId !== "string" ||
        typeof row.integrationAccountId !== "string"
      )
        throw new Error("Invalid Underclerk binding identity");
      after = row.bindingId;
      const organisationId = parseOrganisationId(row.organisationId);
      const integrationAccountId = parseIntegrationAccountId(
        row.integrationAccountId,
      );
      if (!organisationId.ok || !integrationAccountId.ok)
        throw new Error("Invalid Underclerk binding scope");
      const execution = await OrganisationExecutionScope.resolve(
        env,
        organisationId.value,
      );
      // Another database owns this Organisation and reports the binding itself.
      // An unresolved placement continues, so that reconciliation records it.
      if (execution.ok && execution.value.database !== database) continue;
      const message = createCommerceOutboxReconcileQueueMessage({
        requestId: newRequestId(),
        receivedAt: now,
        organisationId: organisationId.value,
        integrationAccountId: integrationAccountId.value,
      });
      await subscribeToCommerceWebhooks(env, database, message, now);
      try {
        const result = await reconcileCommerceOutbox({ env, message, now });
        results.push(result);
        if (result.kind !== "drained")
          traceWarn("underclerk.scheduled_recovery_pending", {
            requestId: message.requestId,
            organisation_id: message.organisationId,
            code: result.code,
          });
      } catch {
        results.push({
          kind: "retry",
          deliveryId: null,
          code: "underclerk_scheduled_reconciliation_failed",
        });
        traceWarn("underclerk.scheduled_recovery_failed", {
          requestId: message.requestId,
          organisation_id: message.organisationId,
        });
      }
    }
    if (rows.results.length < 100) return;
  }
}

/**
 * Makes the merchant post its events to Pantry (Plan 77 step 8). The read in
 * this run stays the backstop: a merchant that cannot post is read here.
 */
async function subscribeToCommerceWebhooks(
  env: Env,
  database: OrganisationDatabase,
  message: CommerceOutboxReconcileQueueMessage,
  now: number,
): Promise<void> {
  const binding = await resolveCommerceMerchantBinding({
    db: database,
    organisationId: message.organisationId,
    integrationAccountId: message.integrationAccountId,
  });
  if (!binding.ok) return;
  const client = createCommerceClient(env, undefined, {
    kind: "organisation",
    organisationId: String(message.organisationId),
  });
  if (client === null) return;
  try {
    await ensureCommerceWebhookSubscription({
      env,
      db: database,
      client,
      binding: binding.value,
      now,
      requestId: message.requestId,
    });
  } catch {
    traceWarn("underclerk.webhook_subscription_failed", {
      requestId: message.requestId,
      organisation_id: message.organisationId,
    });
  }
}

/** Apply errors decided by the delivery's own content — no retry can change them. */
function deterministicCommerceApplyError(code: string): boolean {
  switch (code) {
    case "commerce_event_invalid":
    case "commerce_event_organisation_mismatch":
    case "commerce_event_integration_account_mismatch":
    case "commerce_delivery_conflict":
    case "commerce_revision_conflict":
    case "commerce_terminal_state_regression":
      return true;
    default:
      return false;
  }
}

export async function reconcileCommerceOutbox(
  input: Readonly<{
    env: Env;
    message: CommerceOutboxReconcileQueueMessage;
    fetcher?: typeof fetch;
    now?: number;
  }>,
): Promise<CommerceOutboxReconcileResult> {
  const execution = await OrganisationExecutionScope.resolve(
    input.env,
    input.message.organisationId,
  );
  if (!execution.ok) {
    return { kind: "retry", deliveryId: null, code: execution.error.code };
  }
  const scope = execution.value;
  const binding = await resolveCommerceMerchantBinding({
    db: scope.database,
    organisationId: input.message.organisationId,
    integrationAccountId: input.message.integrationAccountId,
  });
  if (!binding.ok)
    return { kind: "rejected", deliveryId: null, code: binding.error.code };
  const commerceAuthority = await resolveOrganisationCommerceSystemAuthority({
    db: scope.database,
    organisationId: input.message.organisationId,
  });
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.message.organisationId),
  });
  if (client === null) {
    return {
      kind: "retry",
      deliveryId: null,
      code: "underclerk_client_unconfigured",
    };
  }
  await startCommerceWebhookRead(scope.database, binding.value.bindingId);
  const pending = await readCommerceFeed(client, binding.value.merchantId);
  if (!pending.ok) {
    return {
      kind: "retry",
      deliveryId: null,
      code: `underclerk_delivery_read_${pending.error.kind}`,
    };
  }
  const now = input.now ?? Date.now();
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env: input.env,
    organisationId: input.message.organisationId,
    placement: scope.placement,
    now,
  });
  try {
    await ensureCommerceLowStockCueSnapshot({
      db: scope.database,
      kv: input.env.POLICY_KV,
      organisationId: input.message.organisationId,
      now,
    });
  } catch {
    return {
      kind: "retry",
      deliveryId: null,
      code: "underclerk_cue_snapshot_refresh_failed",
    };
  }
  const storedCues = await organisation.readRecoverableCommerceCues({
    organisationId: input.message.organisationId,
    limit: 100,
    retryBefore: Math.max(0, now - COMMERCE_CUE_RESEND_AFTER_MS),
  });
  if (!storedCues.ok) {
    return { kind: "retry", deliveryId: null, code: storedCues.error.code };
  }
  const recovered = await enqueueRecoverableCues({
    env: input.env,
    message: input.message,
    organisation,
    recoverableCues: storedCues.value.filter(
      (cue) => cue.integrationAccountId === input.message.integrationAccountId,
    ),
    enqueuedAt: now,
  });
  if (!recovered.ok) {
    return { kind: "retry", deliveryId: null, code: recovered.code };
  }
  if (pending.value.length === 0) {
    if (
      !commerceAuthority.ok ||
      commerceAuthority.value.provider !== "underclerk" ||
      commerceAuthority.value.integrationAccountId !==
        input.message.integrationAccountId
    ) {
      return {
        kind: "rejected",
        deliveryId: null,
        code: "underclerk_commerce_system_mismatch",
      };
    }
    return completeCommerceSync({
      organisation,
      message: input.message,
      validatedAt: now,
      acknowledged: 0,
      replayed: 0,
      rejected: 0,
    });
  }
  const verifier = createCommerceEd25519Verifier({
    expectedKeyId: binding.value.deliverySigningKeyId,
    publicKey: binding.value.deliverySigningPublicKey,
  });

  let acknowledged = 0;
  let replayed = 0;
  let rejected = 0;
  let requiresProjectionValidation = false;
  // Commerce's purchasing recipe reads the merchant's current stock, not
  // the delivery. Every delivery of this read committed before the read, so
  // one reconcile, before the first inventory delivery is acknowledged,
  // covers them all.
  let purchasingReconciled = false;
  /* A delivery that can never apply — malformed, or deterministically refused
     by the projection — is quarantined: skipped without acknowledgement so it
     stays visible at Commerce, while the deliveries behind it keep
     draining. Aborting the batch here wedged every later delivery behind one
     poisoned one, and retrying the queue message spun forever on an error
     retries cannot change. Per-entity revisions make skipping safe: later
     revisions supersede, replays land as duplicates. */
  for (const { delivery, cursor } of pending.value) {
    const normalized = await normalizeCommerceEngineDelivery({
      delivery,
      organisationId: input.message.organisationId,
      merchantId: binding.value.merchantId,
      integrationAccountId: input.message.integrationAccountId,
      verifier,
    });
    if (!normalized.ok) {
      if (
        !commerceAuthority.ok ||
        commerceAuthority.value.provider !== "underclerk" ||
        commerceAuthority.value.integrationAccountId !==
          input.message.integrationAccountId
      ) {
        return {
          kind: "rejected",
          deliveryId: delivery.deliveryId,
          code: "underclerk_commerce_system_mismatch",
        };
      }
      console.error("underclerk_outbox.delivery_rejected", {
        organisationId: input.message.organisationId,
        deliveryId: delivery.deliveryId,
        code: normalized.error,
      });
      const retired = await retireCommerceDelivery({
        client,
        cursor,
        organisationId: input.message.organisationId,
        merchantId: binding.value.merchantId,
        deliveryId: delivery.deliveryId,
        reason: normalized.error,
        acknowledgedAt: new Date(now).toISOString(),
      });
      if (retired.kind === "retry") return retired;
      rejected += 1;
      continue;
    }
    // A delivery with no observation carries nothing to project: Commerce
    // records one for each commit, also for payment steps, drafts and media.
    // It is acknowledged like any applied delivery, not refused as invalid.
    const nothingToProject =
      normalized.kind === "aggregate" &&
      normalized.delivery.observations.length === 0;
    if (normalized.kind !== "aggregate" || nothingToProject) {
      const events =
        normalized.kind === "aggregate"
          ? []
          : createCommerceEntityPlaneCueEvents({
              organisationId: input.message.organisationId,
              integrationAccountId: input.message.integrationAccountId,
              deliveryId: normalized.admission.deliveryId,
              merchantId: normalized.admission.merchantId,
              merchantRevision: normalized.admission.merchantRevision,
              observedAt: normalized.admission.observedAt,
              observations: normalized.admission.observations,
              at: now,
            });
      for (const event of events) {
        try {
          await input.env.CUE_Q.send(
            createCueQueueMessage({
              requestId: input.message.requestId,
              receivedAt: input.message.receivedAt,
              event,
            }),
          );
        } catch {
          return {
            kind: "retry",
            deliveryId: delivery.deliveryId,
            code: "underclerk_entity_plane_cue_enqueue_failed",
          };
        }
      }
      const acknowledgement = await acknowledgeCommerceDelivery({
        client,
        cursor,
        organisationId: input.message.organisationId,
        merchantId: binding.value.merchantId,
        deliveryId: delivery.deliveryId,
        acknowledgedAt: new Date(now).toISOString(),
      });
      switch (acknowledgement.kind) {
        case "acknowledged":
          acknowledged += 1;
          break;
        case "already_acknowledged":
          replayed += 1;
          break;
        case "rejected":
        case "already_rejected":
          rejected += 1;
          break;
        case "retry":
          return acknowledgement;
        default:
          return assertNever(
            acknowledgement,
            "Unexpected Underclerk outbox result",
          );
      }
      continue;
    }
    if (
      !commerceAuthority.ok ||
      commerceAuthority.value.provider !== "underclerk" ||
      commerceAuthority.value.integrationAccountId !==
        input.message.integrationAccountId
    ) {
      return {
        kind: "rejected",
        deliveryId: delivery.deliveryId,
        code: "underclerk_commerce_system_mismatch",
      };
    }
    requiresProjectionValidation = true;
    const applied = await organisation.applyCommerceDelivery({
      organisationId: input.message.organisationId,
      integrationAccountId: input.message.integrationAccountId,
      delivery: normalized.delivery,
      cueFacts: [],
      labRunId: null,
      processedAt: now,
      commerceSystem: {
        kind: commerceAuthority.value.commerceSystem.kind,
        revision: commerceAuthority.value.commerceSystem.revision,
      },
    });
    if (!applied.ok) {
      if (applied.error.code === "commerce_revision_conflict") {
        console.error("underclerk_outbox.commerce_revision_conflict", {
          organisationId: input.message.organisationId,
          deliveryId: delivery.deliveryId,
          projectionKind: applied.error.projectionKind,
          canonicalId: applied.error.canonicalId,
          currentIntegrationAccountId:
            applied.error.currentIntegrationAccountId,
          receivedIntegrationAccountId:
            applied.error.receivedIntegrationAccountId,
          currentRevision: applied.error.currentRevision,
          receivedRevision: applied.error.receivedRevision,
        });
      }
      if (applied.error.code === "commerce_event_invalid") {
        console.error("underclerk_outbox.commerce_event_invalid", {
          organisationId: input.message.organisationId,
          deliveryId: delivery.deliveryId,
          field: applied.error.field,
        });
      }
      if (deterministicCommerceApplyError(applied.error.code)) {
        const retired = await retireCommerceDelivery({
          client,
          cursor,
          organisationId: input.message.organisationId,
          merchantId: binding.value.merchantId,
          deliveryId: delivery.deliveryId,
          reason: applied.error.code,
          acknowledgedAt: new Date(now).toISOString(),
        });
        if (retired.kind === "retry") return retired;
        rejected += 1;
        continue;
      }
      return {
        kind: "retry",
        deliveryId: delivery.deliveryId,
        code: applied.error.code,
      };
    }
    if (
      !purchasingReconciled &&
      deliveryAffectsPurchasing(normalized.delivery)
    ) {
      const reconciled = await reconcilePurchasingAfterCommerceDelivery({
        env: input.env,
        fetcher: input.fetcher,
        organisationId: input.message.organisationId,
        merchantId: binding.value.merchantId,
      });
      if (!reconciled.ok) {
        return {
          kind: "retry",
          deliveryId: delivery.deliveryId,
          code: reconciled.code,
        };
      }
      purchasingReconciled = true;
    }
    const cues = await enqueueRecoverableCues({
      env: input.env,
      message: input.message,
      organisation,
      recoverableCues: applied.value.pendingCues,
      enqueuedAt: now,
    });
    if (!cues.ok) {
      return {
        kind: "retry",
        deliveryId: delivery.deliveryId,
        code: cues.code,
      };
    }
    // The Slack receipt of a paid order waits in its own outbox: a Slack
    // connection that is missing, disabled or refused never holds the
    // shop's later events (Refactor 15).
    const receipts = await recordPaidReceipts({
      env: input.env,
      scope,
      delivery: normalized.delivery,
      addressedAt: input.message.receivedAt,
      now,
    });
    if (!receipts.ok) {
      return {
        kind: "retry",
        deliveryId: delivery.deliveryId,
        code: receipts.error.code,
      };
    }
    const acknowledgement = await acknowledgeCommerceDelivery({
      client,
      cursor,
      organisationId: input.message.organisationId,
      merchantId: binding.value.merchantId,
      deliveryId: delivery.deliveryId,
      acknowledgedAt: new Date(now).toISOString(),
    });
    switch (acknowledgement.kind) {
      case "acknowledged":
        // A delivery read again after a lost cursor move is a replay: the
        // projection keeps one receipt for each delivery.
        if (applied.value.disposition === "duplicate") replayed += 1;
        else acknowledged += 1;
        break;
      case "already_acknowledged":
        replayed += 1;
        break;
      case "rejected":
      case "already_rejected":
        /* A prior pass retired this delivery; a plain acknowledgement cannot
           un-reject it, so it simply counts as rejected again. */
        rejected += 1;
        break;
      case "retry":
        return acknowledgement;
      default:
        return assertNever(
          acknowledgement,
          "Unexpected Underclerk outbox result",
        );
    }
  }
  // A new event can change what the shop's menu boards show: a sale of the
  // last item, a stock count or a new menu (Plan 40B). The screens read
  // their feed again; a lost signal costs them their next timed read.
  if (acknowledged > 0)
    await organisation
      .signalMenuScreens({ organisationId: input.message.organisationId })
      .catch(ignoreScreenSignalFailure);
  if (!requiresProjectionValidation) {
    return { kind: "drained", acknowledged, replayed, rejected };
  }
  return completeCommerceSync({
    organisation,
    message: input.message,
    validatedAt: now,
    acknowledged,
    replayed,
    rejected,
  });
}

function ignoreScreenSignalFailure(): number {
  return 0;
}

function deliveryAffectsPurchasing(
  delivery: CanonicalCommerceDelivery,
): boolean {
  for (const observation of delivery.observations) {
    if (observation.kind !== "upsert") continue;
    switch (observation.projection.kind) {
      case "inventory_movement":
      case "inventory_position":
      case "stock_policy":
        return true;
      default:
        continue;
    }
  }
  return false;
}

async function reconcilePurchasingAfterCommerceDelivery(
  input: Readonly<{
    env: Env;
    fetcher: typeof fetch | undefined;
    organisationId: OrganisationId;
    merchantId: string;
  }>,
): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>> {
  const client = createCommerceEntityPlaneClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.organisationId),
  });
  if (client === null)
    return { ok: false, code: "underclerk_purchasing_reconcile_unconfigured" };
  const reconciled = await client.reconcilePurchasing({
    organisationId: input.organisationId,
    merchantId: input.merchantId,
  });
  if (!reconciled.ok) {
    return {
      ok: false,
      code: `underclerk_purchasing_reconcile_${reconciled.error.kind}`,
    };
  }
  if (
    reconciled.value.organisationId !== input.organisationId ||
    reconciled.value.merchantId !== input.merchantId
  ) {
    return {
      ok: false,
      code: "underclerk_purchasing_reconcile_scope_mismatch",
    };
  }
  return { ok: true };
}

async function completeCommerceSync(
  input: Readonly<{
    organisation: OrganisationActorStub;
    message: CommerceOutboxReconcileQueueMessage;
    validatedAt: number;
    acknowledged: number;
    replayed: number;
    rejected: number;
  }>,
): Promise<CommerceOutboxReconcileResult> {
  const validated = await input.organisation.validateCommerceSystemProjections({
    organisationId: input.message.organisationId,
    integrationAccountId: input.message.integrationAccountId,
    validatedAt: input.validatedAt,
  });
  return validated.ok
    ? {
        kind: "drained",
        acknowledged: input.acknowledged,
        replayed: input.replayed,
        rejected: input.rejected,
      }
    : { kind: "retry", deliveryId: null, code: validated.error.code };
}

async function enqueueRecoverableCues(
  input: Readonly<{
    env: Env;
    message: CommerceOutboxReconcileQueueMessage;
    organisation: OrganisationActorStub;
    recoverableCues: readonly PendingCommerceCue[];
    enqueuedAt: number;
  }>,
): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>> {
  for (const cue of input.recoverableCues) {
    try {
      await input.env.CUE_Q.send(
        createCueQueueMessage({
          requestId: input.message.requestId,
          receivedAt: input.message.receivedAt,
          event: cue.event,
        }),
      );
    } catch {
      return { ok: false, code: "underclerk_cue_enqueue_failed" };
    }
    const marked = await input.organisation.markCommerceCuesEnqueued({
      organisationId: input.message.organisationId,
      nativeIds: [cue.nativeId],
      enqueuedAt: input.enqueuedAt,
    });
    if (!marked.ok) return { ok: false, code: marked.error.code };
  }
  return { ok: true };
}

/**
 * Settles one delivery by moving Pantry's feed cursor past it (Plan 76
 * phase 4). A delivery that can never apply is first marked rejected, so it
 * stays visible at Commerce.
 */
async function acknowledgeCommerceDelivery(
  input: Readonly<{
    client: CommerceAdminClient;
    cursor: string;
    organisationId: string;
    merchantId: string;
    deliveryId: string;
    acknowledgedAt: string;
    rejection?: Readonly<{ reason: string }>;
  }>,
): Promise<CommerceDeliveryAcknowledgementResult> {
  let outcome: Exclude<
    CommerceDeliveryAcknowledgementResult["kind"],
    "retry"
  > = "acknowledged";
  if (input.rejection !== undefined) {
    const rejected = await input.client.acknowledgeDelivery({
      schemaVersion: "underclerk.acknowledge-commerce-delivery.v2",
      merchantId: input.merchantId,
      deliveryId: input.deliveryId,
      acknowledgedAt: input.acknowledgedAt,
      rejection: input.rejection,
    });
    if (!rejected.ok)
      return {
        kind: "retry",
        deliveryId: input.deliveryId,
        code: `underclerk_delivery_ack_${rejected.error.kind}`,
      };
    outcome = rejected.value.outcome;
  }
  const advanced = await input.client.advanceFeedConsumer(
    input.merchantId,
    SATYR_FEED_CONSUMER,
    input.cursor,
  );
  // Another run of Pantry's reader passed this event first.
  if (
    advanced.ok &&
    outcome === "acknowledged" &&
    advanced.value.cursor !== input.cursor
  )
    outcome = "already_acknowledged";
  return advanced.ok
    ? { kind: outcome, deliveryId: input.deliveryId }
    : {
        kind: "retry",
        deliveryId: input.deliveryId,
        code:
          advanced.error.kind === "http"
            ? `underclerk_feed_cursor_http_${advanced.error.status}`
            : `underclerk_feed_cursor_${advanced.error.kind}`,
      };
}

/** Pantry's place in each merchant's event feed. */
const SATYR_FEED_CONSUMER = "satyr";
const FEED_PAGE = 100;
const FEED_PAGES_PER_RUN = 10;

/**
 * The events after Pantry's cursor, in feed order, up to ten pages. A first
 * read starts at the oldest delivery that nobody acknowledged.
 */
async function readCommerceFeed(
  client: CommerceAdminClient,
  merchantId: string,
): Promise<
  CommerceClientResult<
    readonly Readonly<{
      delivery: CommerceReceivedDeliveryV1;
      cursor: string;
    }>[]
  >
> {
  const consumer = await client.readFeedConsumer(
    merchantId,
    SATYR_FEED_CONSUMER,
  );
  if (!consumer.ok) return consumer;
  const events: Readonly<{
    delivery: CommerceReceivedDeliveryV1;
    cursor: string;
  }>[] = [];
  let after = consumer.value.cursor;
  for (let page = 0; page < FEED_PAGES_PER_RUN; page += 1) {
    const read = await client.readEvents(merchantId, {
      after,
      limit: FEED_PAGE,
    });
    if (!read.ok) return read;
    for (const event of read.value.events)
      events.push({ delivery: event.delivery, cursor: event.cursor });
    if (read.value.nextCursor === null || read.value.events.length < FEED_PAGE)
      break;
    after = read.value.nextCursor;
  }
  return { ok: true, value: events };
}

/**
 * Retires a poisoned delivery at Commerce so it leaves the pending set for
 * good instead of resurfacing on every reconcile. Any settled outcome counts
 * as retired; only a transport failure asks the queue message to retry.
 */
async function retireCommerceDelivery(
  input: Readonly<{
    client: CommerceAdminClient;
    cursor: string;
    organisationId: string;
    merchantId: string;
    deliveryId: string;
    reason: string;
    acknowledgedAt: string;
  }>,
): Promise<
  | Readonly<{ kind: "retired" }>
  | Readonly<{ kind: "retry"; deliveryId: string; code: string }>
> {
  const acknowledgement = await acknowledgeCommerceDelivery({
    client: input.client,
    cursor: input.cursor,
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    deliveryId: input.deliveryId,
    acknowledgedAt: input.acknowledgedAt,
    rejection: { reason: input.reason },
  });
  return acknowledgement.kind === "retry"
    ? acknowledgement
    : { kind: "retired" };
}

type CommerceDeliveryAcknowledgementResult =
  | Readonly<{
      kind:
        | "acknowledged"
        | "already_acknowledged"
        | "rejected"
        | "already_rejected";
      deliveryId: string;
    }>
  | Readonly<{ kind: "retry"; deliveryId: string; code: string }>;

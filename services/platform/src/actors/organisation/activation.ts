import type { OrganisationDatabase } from "../../database-handles";
import { OrganisationExecutionScope } from "../../organisation-execution-scope";
import type { Env } from "../../env";
import {
  activatePendingIntegrationAccounts,
  checkpointActivationStep,
  failOnboardingActivation,
  type ActivationContext,
  type ActivationFailureReceipt,
} from "../../data/activation";
import {
  parseRequestId,
  parseThreadKey,
  type ChannelId,
  type OrganisationId,
  type ThreadKey,
  type WorkspaceId,
} from "../../ids";
import { compilePublishAndActivateOrganisationPolicy } from "../../policy-snapshot";
import {
  compileAndStoreCueSnapshot,
  writeTierOneCommerceSubscription,
  writeTierOneShopifySubscription,
  writeTierOneStripeSubscription,
} from "../../cues/engine";
import type { Result } from "../../result";
import { expireDueActionExecutions } from "../action-ledger";
import { expireCodeModeOrganisationReservations } from "../code-mode-budget";
import { expireAbandonedCueClaims } from "../cue-delivery";
import type { OrganisationCutoverQuiescence } from "../organisation-cutover-quiescence";
import { isNonNegativeInteger } from "@purin-labs/std";
import type { ActivationExecutionFailure } from "./activation-types";
import type { CafeCommerceAcceptanceFaultRecord } from "../../commerce/contract/types";

export const CAFE_COMMERCE_ACCEPTANCE_FAULT_KEY =
  "acceptance:cafe-commerce-fault:v1";

export function expireOrganisationLeases(
  sql: SqlStorage,
  organisationId: OrganisationId,
  now: number,
): void {
  expireDueActionExecutions(sql, organisationId, now);
  expireCodeModeOrganisationReservations(sql, now);
  expireAbandonedCueClaims(sql, organisationId, now);
}

export function isExpiredOrganisationCutoverCue(
  inspection: OrganisationCutoverQuiescence,
  settledAt: number,
): boolean {
  if (inspection.kind !== "blocked" || inspection.blockers.length !== 1) {
    return false;
  }

  const blocker = inspection.blockers[0];
  return (
    blocker.kind === "claimed_cues" &&
    blocker.count === 1 &&
    blocker.earliestLeaseExpiresAt <= settledAt
  );
}

export async function ensureActivationReadinessStep(
  db: OrganisationDatabase,
  context: ActivationContext,
  now: number,
): Promise<void> {
  if (context.completedSteps.has("readiness")) {
    return;
  }
  await checkpointActivationStep({
    db,
    context,
    step: "readiness",
    receipt: {
      readinessVersion: context.readinessVersion,
      readinessHash: context.readinessHash,
    },
    now,
  });
}

/** The one method of the Organisation actor that the placement step calls. */
type OrganisationRecordWriter = Readonly<{
  ensureOrganisation(
    input: Readonly<{
      organisationId: OrganisationId;
      name: string;
      plan: "beta";
      status: "active";
      createdAt: number;
    }>,
  ): Promise<unknown>;
}>;

export async function ensureActivationPlacementStep(
  organisation: OrganisationRecordWriter,
  db: OrganisationDatabase,
  context: ActivationContext,
  now: number,
): Promise<void> {
  if (context.completedSteps.has("placement")) {
    return;
  }
  await organisation.ensureOrganisation({
    organisationId: context.organisationId,
    name: context.organisationName,
    plan: "beta",
    status: "active",
    createdAt: now,
  });
  await checkpointActivationStep({
    db,
    context,
    step: "placement",
    receipt: { actor: "organisation", status: "active" },
    now,
  });
}

export async function ensureActivationPolicyStep(
  organisation: Parameters<
    typeof compilePublishAndActivateOrganisationPolicy
  >[0]["organisation"],
  env: Env,
  scope: OrganisationExecutionScope,
  context: ActivationContext,
  now: number,
): Promise<Result<null, { readonly code: "activation_policy_failed" }>> {
  if (context.completedSteps.has("policy")) {
    return { ok: true, value: null };
  }
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: {
      db: scope.database,
      kv: env.POLICY_KV,
    },
    organisationId: context.organisationId,
    organisation,
    now,
  });
  if (!published.ok) {
    return { ok: false, error: { code: "activation_policy_failed" } };
  }
  await checkpointActivationStep({
    db: scope.database,
    context,
    step: "policy",
    receipt: {
      setupSnapshotId: context.policySnapshotId,
      policyVersion: published.value.snapshot.version,
    },
    now,
  });
  return { ok: true, value: null };
}

export async function ensureActivationCueStep(
  env: Env,
  scope: OrganisationExecutionScope,
  context: ActivationContext,
  now: number,
): Promise<Result<null, { readonly code: "activation_cues_failed" }>> {
  if (context.completedSteps.has("cues")) {
    return { ok: true, value: null };
  }
  try {
    await materializeCueSelection(scope.database, context);
    const snapshot = await compileAndStoreCueSnapshot({
      db: scope.database,
      kv: env.POLICY_KV,
      organisationId: context.organisationId,
      now,
    });
    await checkpointActivationStep({
      db: scope.database,
      context,
      step: "cues",
      receipt: {
        setupSnapshotId: context.cueSnapshotId,
        cueVersion: snapshot.version,
        subscriptionCount: snapshot.subscriptions.length,
      },
      now,
    });
    return { ok: true, value: null };
  } catch {
    return { ok: false, error: { code: "activation_cues_failed" } };
  }
}

async function materializeCueSelection(
  db: OrganisationDatabase,
  context: ActivationContext,
): Promise<void> {
  const threadKey = parseThreadKey(
    `slack:${context.cueSelection.workspaceId}:${context.cueSelection.channelId}:channel`,
  );
  if (!threadKey.ok) {
    throw new Error("cue target thread invariant failed");
  }
  await materializeCommerceCues(
    db,
    context.organisationId,
    context.cueSelection.workspaceId,
    context.cueSelection.channelId,
    threadKey.value,
  );
  if (context.cueSelection.presetId === "observe_commerce") {
    return;
  }
  await writeTierOneStripeSubscription({
    db,
    organisationId: context.organisationId,
    subscriptionId: "onboarding-stripe-charge-failed",
    workspaceId: context.cueSelection.workspaceId,
    channelId: context.cueSelection.channelId,
    threadKey: threadKey.value,
    eventType: "charge.failed",
    template:
      "A Stripe charge failed. Review the payment and propose the next safe action.",
    delivery: { kind: "immediate" },
    debounceMs: 5 * 60 * 1000,
    maxPerHour: 4,
  });
  await writeTierOneShopifySubscription({
    db,
    organisationId: context.organisationId,
    subscriptionId: "onboarding-shopify-order-created",
    workspaceId: context.cueSelection.workspaceId,
    channelId: context.cueSelection.channelId,
    threadKey: threadKey.value,
    eventType: "orders/create",
    template:
      "A Shopify order was created. Review fulfillment state and surface any exception.",
    delivery: { kind: "immediate" },
    debounceMs: 60 * 1000,
    maxPerHour: 12,
  });
  if (context.cueSelection.presetId === "proactive_triage") {
    await materializeProactiveCues(
      db,
      context.organisationId,
      context.cueSelection.workspaceId,
      context.cueSelection.channelId,
      threadKey.value,
    );
  }
}

async function materializeCommerceCues(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  threadKey: ThreadKey,
): Promise<void> {
  const subscriptions = [
    {
      subscriptionId: "onboarding-commerce-payment-failed",
      eventType: "payment_failed",
      template:
        "A payment failed. Review the order and propose a safe recovery step.",
      debounceMs: 5 * 60 * 1000,
      maxPerHour: 4,
    },
    {
      subscriptionId: "onboarding-commerce-inventory-shortage",
      eventType: "inventory_shortage",
      template:
        "Inventory cannot satisfy an order. Review stock and propose a fulfillment plan.",
      debounceMs: 5 * 60 * 1000,
      maxPerHour: 6,
    },
    {
      subscriptionId: "onboarding-commerce-inventory-low-stock",
      eventType: "inventory_low_stock",
      template:
        "Inventory crossed the stock policy reorder point. Review the item and propose replenishment.",
      debounceMs: 30 * 60 * 1000,
      maxPerHour: 6,
    },
    {
      subscriptionId: "onboarding-commerce-order-unshipped",
      eventType: "order_unshipped",
      template:
        "An order remains unshipped past its expected handoff. Review fulfillment status.",
      debounceMs: 15 * 60 * 1000,
      maxPerHour: 4,
    },
    {
      subscriptionId: "onboarding-commerce-tracking-stalled",
      eventType: "tracking_stalled",
      template:
        "Shipment tracking has stalled. Review the latest carrier state and propose follow-up.",
      debounceMs: 30 * 60 * 1000,
      maxPerHour: 4,
    },
    {
      subscriptionId: "onboarding-commerce-delivery-exception",
      eventType: "delivery_exception",
      template:
        "A delivery exception occurred. Review the shipment and propose the next safe action.",
      debounceMs: 15 * 60 * 1000,
      maxPerHour: 4,
    },
    {
      subscriptionId: "onboarding-commerce-cancellation-refund-proposed",
      eventType: "cancellation_refund_proposed",
      template:
        "A cancellation and refund is proposed. Require approval before any provider write.",
      debounceMs: 5 * 60 * 1000,
      maxPerHour: 4,
    },
  ] as const;

  for (const subscription of subscriptions) {
    await writeTierOneCommerceSubscription({
      db,
      organisationId,
      subscriptionId: subscription.subscriptionId,
      workspaceId,
      channelId,
      threadKey,
      eventType: subscription.eventType,
      template: subscription.template,
      delivery: { kind: "immediate" },
      debounceMs: subscription.debounceMs,
      maxPerHour: subscription.maxPerHour,
    });
  }
}

async function materializeProactiveCues(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  threadKey: ThreadKey,
): Promise<void> {
  await writeTierOneStripeSubscription({
    db,
    organisationId,
    subscriptionId: "onboarding-stripe-invoice-payment-failed",
    workspaceId,
    channelId,
    threadKey,
    eventType: "invoice.payment_failed",
    template:
      "A Stripe invoice payment failed. Review collection status and propose the next safe action.",
    delivery: { kind: "immediate" },
    debounceMs: 5 * 60 * 1000,
    maxPerHour: 4,
  });
  await writeTierOneShopifySubscription({
    db,
    organisationId,
    subscriptionId: "onboarding-shopify-inventory-updated",
    workspaceId,
    channelId,
    threadKey,
    eventType: "inventory_levels/update",
    template:
      "Shopify inventory changed. Triage low-stock or oversell risk for the operator.",
    delivery: { kind: "digest", windowMs: 15 * 60 * 1000 },
    debounceMs: 5 * 60 * 1000,
    maxPerHour: 12,
  });
}

export async function ensureActivationAccountsStep(
  db: OrganisationDatabase,
  context: ActivationContext,
  now: number,
): Promise<void> {
  if (context.completedSteps.has("accounts")) {
    return;
  }
  const activatedAccounts = await activatePendingIntegrationAccounts({
    db,
    organisationId: context.organisationId,
    now,
  });
  await checkpointActivationStep({
    db,
    context,
    step: "accounts",
    receipt: { activatedAccounts },
    now,
  });
}

export async function recordActivationFailure(
  db: OrganisationDatabase,
  context: ActivationContext,
  failureCode: ActivationExecutionFailure["code"],
  now: number,
): Promise<ActivationFailureReceipt> {
  return failOnboardingActivation({
    db,
    context,
    failureCode,
    retryable: true,
    now,
  });
}

export function activationExecutionFailure(
  code: ActivationExecutionFailure["code"],
  receipt: ActivationFailureReceipt,
): ActivationExecutionFailure {
  return {
    code,
    retryable: receipt.retryable,
    correlationId: receipt.correlationId,
    supportReference: receipt.supportReference,
  };
}

export function hasOnboardingActivationAcceptanceFaultsEnabled(
  env: Env,
): boolean {
  return (
    typeof env.PANTRY_FAULT_INJECTION_TOKEN === "string" &&
    env.PANTRY_FAULT_INJECTION_TOKEN.length > 0
  );
}

export function parseCafeCommerceAcceptanceFault(
  raw: unknown,
): CafeCommerceAcceptanceFaultRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("cafe_commerce_acceptance_fault_invalid");
  }
  const record = raw as Record<string, unknown>;
  const requestId =
    typeof record.requestId === "string"
      ? parseRequestId(record.requestId)
      : { ok: false as const };
  if (
    record.schemaVersion !== 1 ||
    !requestId.ok ||
    typeof record.merchantId !== "string" ||
    record.merchantId.length === 0 ||
    !isNonNegativeInteger(record.armedAt) ||
    !isNullableAcceptanceTimestamp(record.queueConsumedAt)
  ) {
    throw new Error("cafe_commerce_acceptance_fault_invalid");
  }
  return {
    schemaVersion: 1,
    requestId: requestId.value,
    merchantId: record.merchantId,
    armedAt: record.armedAt,
    queueConsumedAt: record.queueConsumedAt,
  };
}

function isNullableAcceptanceTimestamp(raw: unknown): raw is number | null {
  return raw === null || isNonNegativeInteger(raw);
}

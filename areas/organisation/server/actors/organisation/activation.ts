import type { OrganisationModuleHost } from "@purin-labs/tenancy/actors/organisation/module-host";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Env } from "@purin-labs/kernel/env";
import { faultInjectionEnabled } from "@purin-labs/kernel/fault-injection-auth";
import {
  activatePendingIntegrationAccounts,
  beginOnboardingActivation,
  checkpointActivationStep,
  completeOnboardingActivation,
  failOnboardingActivation,
  type ActivationContext,
  type ActivationFailureReceipt,
  type ActivationReceipt,
  type OnboardingActivationInput,
} from "../../data/activation";
import {
  newRequestId,
  parseThreadKey,
  type ChannelId,
  type OrganisationId,
  type ThreadKey,
  type WorkspaceId,
} from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import { compilePublishAndActivateOrganisationPolicy } from "@purin-labs/authority/policy-snapshot";
import {
  compileAndStoreCueSnapshot,
  writeTierOneCommerceSubscription,
  writeTierOneShopifySubscription,
  writeTierOneStripeSubscription,
} from "@purin-labs/agent/cues/engine";
import type { Result } from "@purin-labs/kernel/result";
import { errorMessage } from "@purin-labs/std";
import {
  armOnboardingActivationAcceptanceFault,
  clearOnboardingActivationAcceptanceFault,
  consumeOnboardingActivationAcceptanceFault,
  inspectOnboardingActivationAcceptanceFault,
  type OnboardingActivationAcceptanceFaultError,
  type OnboardingActivationAcceptanceFaultInput,
  type OnboardingActivationAcceptanceFaultInspection,
  type OnboardingActivationAcceptanceFaultRecord,
} from "../../contract/onboarding-activation-acceptance-fault";
import type {
  ActivationExecutionFailure,
  OnboardingActivationError,
} from "../../contract/activation-types";

async function ensureActivationReadinessStep(
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

async function ensureActivationPlacementStep(
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

async function ensureActivationPolicyStep(
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

async function ensureActivationCueStep(
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

async function ensureActivationAccountsStep(
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

async function recordActivationFailure(
  db: OrganisationDatabase,
  context: ActivationContext,
  failureCode: ActivationExecutionFailure["code"],
  now: number,
): Promise<ActivationFailureReceipt> {
  return failOnboardingActivation({
    db,
    context,
    failureCode,
    now,
  });
}

function activationExecutionFailure(
  code: ActivationExecutionFailure["code"],
  receipt: ActivationFailureReceipt,
): ActivationExecutionFailure {
  return {
    code,
    correlationId: receipt.correlationId,
    supportReference: receipt.supportReference,
  };
}

/** What an onboarding activation needs from the rest of the Organisation. */
type OnboardingActivationParts = Parameters<
  typeof ensureActivationPlacementStep
>[0] &
  Parameters<typeof ensureActivationPolicyStep>[0];

/**
 * The onboarding activation of the Organisation: the activation steps, and
 * the acceptance fault that interrupts them in a fault journey.
 */
export class OrganisationActivation {
  constructor(
    private readonly host: OrganisationModuleHost,
    /**
     * The two steps of an onboarding activation that other parts of the
     * Organisation own: its record and its policy.
     */
    private readonly organisation: OnboardingActivationParts,
  ) {}

  async activateOnboarding(
    input: OnboardingActivationInput,
  ): Promise<Result<ActivationReceipt, OnboardingActivationError>> {
    return this.host.command(
      input.organisationId,
      this.admittedActivateOnboarding.bind(this, input),
    );
  }

  private async admittedActivateOnboarding(
    input: OnboardingActivationInput,
    scope: OrganisationExecutionScope,
  ): Promise<Result<ActivationReceipt, OnboardingActivationError>> {
    const started = await beginOnboardingActivation({
      db: scope.database,
      request: input,
      fence: scope,
    });
    if (!started.ok) {
      return started;
    }
    if (started.value.kind === "completed") {
      return { ok: true, value: started.value.receipt };
    }
    const context = started.value.context;
    try {
      await ensureActivationReadinessStep(scope.database, context, input.now);
      await ensureActivationPlacementStep(
        this.organisation,
        scope.database,
        context,
        input.now,
      );
      const interrupted = await this.interruptOnboardingActivationForAcceptance(
        scope,
        context,
        input.now,
      );
      if (interrupted !== null) {
        return { ok: false, error: interrupted };
      }
      const policy = await ensureActivationPolicyStep(
        this.organisation,
        this.host.env,
        scope,
        context,
        input.now,
      );
      if (!policy.ok) {
        const failure = await recordActivationFailure(
          scope.database,
          context,
          policy.error.code,
          input.now,
        );
        return {
          ok: false,
          error: activationExecutionFailure(policy.error.code, failure),
        };
      }
      const cues = await ensureActivationCueStep(
        this.host.env,
        scope,
        context,
        input.now,
      );
      if (!cues.ok) {
        const failure = await recordActivationFailure(
          scope.database,
          context,
          cues.error.code,
          input.now,
        );
        return {
          ok: false,
          error: activationExecutionFailure(cues.error.code, failure),
        };
      }
      await ensureActivationAccountsStep(scope.database, context, input.now);
      await checkpointActivationStep({
        db: scope.database,
        context,
        step: "publish",
        receipt: { activationReadyToFinalize: true },
        now: input.now,
      });
      const receipt = await completeOnboardingActivation({
        db: scope.database,
        context,
        now: input.now,
      });
      return { ok: true, value: receipt };
    } catch (error) {
      const failure = await recordActivationFailure(
        scope.database,
        context,
        "activation_publish_failed",
        input.now,
      );
      traceWarn("organisation.onboarding_activation_failed", {
        requestId: newRequestId(),
        organisation_id: context.organisationId,
        activation_attempt_id: context.attemptId,
        error: errorMessage(error),
      });
      return {
        ok: false,
        error: activationExecutionFailure("activation_publish_failed", failure),
      };
    }
  }

  async armOnboardingActivationAcceptanceFault(
    input: OnboardingActivationAcceptanceFaultInput,
  ): Promise<
    Result<
      OnboardingActivationAcceptanceFaultRecord,
      OnboardingActivationAcceptanceFaultError
    >
  > {
    return armOnboardingActivationAcceptanceFault(this.host.ctx.storage, input);
  }

  async inspectOnboardingActivationAcceptanceFault(): Promise<
    Result<
      OnboardingActivationAcceptanceFaultInspection,
      OnboardingActivationAcceptanceFaultError
    >
  > {
    return inspectOnboardingActivationAcceptanceFault(this.host.ctx.storage);
  }

  async clearOnboardingActivationAcceptanceFault(): Promise<void> {
    await clearOnboardingActivationAcceptanceFault(this.host.ctx.storage);
  }

  private async interruptOnboardingActivationForAcceptance(
    scope: OrganisationExecutionScope,
    context: ActivationContext,
    now: number,
  ): Promise<ActivationExecutionFailure | null> {
    if (!faultInjectionEnabled(this.host.env.PANTRY_FAULT_INJECTION_TOKEN)) {
      return null;
    }
    const consumed = await consumeOnboardingActivationAcceptanceFault(
      this.host.ctx.storage,
      now,
    );
    if (!consumed.ok) {
      throw new Error(consumed.error.code);
    }
    if (consumed.value.kind === "inactive") {
      return null;
    }
    const failure = await recordActivationFailure(
      scope.database,
      context,
      "activation_interrupted",
      now,
    );
    traceWarn("organisation.onboarding_activation_acceptance_interrupted", {
      requestId: consumed.value.fault.requestId,
      organisation_id: context.organisationId,
      activation_attempt_id: context.attemptId,
      activation_phase: consumed.value.fault.phase,
    });
    return activationExecutionFailure("activation_interrupted", failure);
  }
}

/** The RPC methods of this module. The Actor class has one method for each. */
export type OrganisationActivationRpc = Pick<
  OrganisationActivation,
  | "activateOnboarding"
  | "armOnboardingActivationAcceptanceFault"
  | "inspectOnboardingActivationAcceptanceFault"
  | "clearOnboardingActivationAcceptanceFault"
>;

import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationActorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import type { Result } from "@purin-labs/kernel/result";
import { resolveActiveCaseActor, resolveActiveCaseActorAtPlacement } from "@purin-labs/actor-runtime/actors/actor-router";
import type { ActionLedgerEntry } from "@purin-labs/authority/actors/action-ledger";
import type { OrganisationCommerce } from "./actors/organisation/organisation-commerce";
import type { MerchantActionRejectionEvidence } from "@purin-labs/authority/approval-authentication";
import { parseCommerceActionPath, parseCommerceEntityPlaneActionPath, parseCommerceProviderReceipt, type CommerceActionError, type CommerceEntityPlaneActionPath, type CommerceActionPath, type CommerceActionRequest } from "./action-model";
import { executeCommerceEntityPlaneAction, type CommerceEntityPlaneExecutionOutcome } from "./entity-plane/execution";
import { admitCommerceCapability } from "./data/commerce-capability-activation";
import { admitCommerceActionCapability, executeCommerceProviderAction, reconcileCommerceProviderAction, validateCommerceActionAuthorityBeforeExecution } from "./provider-execution";
import type { CommerceProviderExecutionError } from "./contract/commerce-provider";
import { createCommerceOutboxReconcileQueueMessage } from "./contract/queue-messages";
import { newRequestId } from "@purin-labs/kernel/ids";
import { parseStoredRequestAuthority } from "@purin-labs/authority/request-authority/index";
import { deliverCommerceCaseOutput } from "./case-commerce-delivery";
import { commerceApprovalCardTexts } from "./contract/approval-card-texts";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import type { CommerceActionFollowUp } from "@purin-labs/commerce-control-api";
import type { CommerceProviderReceipt } from "@purin-labs/control-api";

export function commerceActionProjectionTarget(
  action: CommerceActionRequest | CommerceActionPath,
): {
  readonly kind: "product" | "offer" | "commerce_order" | "fulfillment";
  readonly resourceId: string;
} | null {
  switch (action.kind) {
    case "update_product_description":
      return { kind: "product", resourceId: action.productId };
    case "publish_catalog_listing":
    case "adjust_offer_price":
      return { kind: "offer", resourceId: action.offerId };
    case "cancel_order":
      return { kind: "commerce_order", resourceId: action.resourceId };
    case "attach_tracking":
      return { kind: "fulfillment", resourceId: action.fulfillmentId };
    case "install_merchant_plugin":
    case "publish_cafe_menu":
    case "change_menu_price":
    case "refund_order":
    case "stock_operation":
      // A plugin or a menu is configuration in Commerce, not a projection.
      // A refund binds the order revision that Commerce checks at commit,
      // a stock action the revisions that its approval signed, and a menu
      // price the offer revision.
      return null;
    case "submit_supplier_payout":
    case "resume_supplier_payout_funding":
      // A payout is not a commerce projection. Its subject is its own row, and
      // what an approval binds is the economics digest, not an Order revision.
      return null;
    default:
      return assertNever(action);
  }
}

/** The finished outcome of a commerce action: the body that the caller records. */
type CommerceActionDone = Readonly<{ body: Record<string, unknown> }>;

/** Why a commerce action stopped before it finished, or that it is still pending. */
export type CommerceActionFailure =
  | Readonly<{ kind: "case_unavailable" }>
  | Readonly<{ kind: "proposal_unavailable" }>
  | Readonly<{ kind: "capability_inactive" }>
  | Readonly<{ kind: "reconciliation_pending"; action: CommerceActionRecord }>
  | Readonly<{ kind: "action"; error: CommerceActionError }>
  | Readonly<{ kind: "entity_plane"; error: Readonly<{ code: string }> }>
  | Readonly<{ kind: "projection"; code: string }>
  | Readonly<{ kind: "provider"; error: CommerceProviderExecutionError }>
  | Readonly<{ kind: "ledger"; error: Readonly<{ code: string }> }>;

/**
 * Run an approved commerce action against its provider, or reconcile one whose
 * outcome is unknown, and record the outcome in the ledger. Every branch but a
 * supplier payout is here, so the Portal's execute route and an approval in
 * Slack run the same code. A Response is a refusal or a pending outcome; the
 * body is the finished outcome, which the caller records and answers.
 */
export async function executeCommerceAction(
  input: Readonly<{
    env: Env;
    executionScope: OrganisationExecutionScope;
    organisation: OrganisationActorStub;
    action: ActionLedgerEntry;
    actionNonce: string;
    now: number;
  }>,
): Promise<Result<CommerceActionDone, CommerceActionFailure>> {
  const { env, now } = input;
  const preflightPath = parseCommerceActionPath(input.action.action);
  if (!preflightPath.ok) {
    const caseActor = await resolveActiveCaseActor({
      env: env,
      namespace: env.CASE,
      organisationId: input.executionScope.organisationId,
      caseId: input.action.caseId,
      now,
    });
    if (!caseActor.ok)
      return { ok: false, error: { kind: "case_unavailable" } };
    const proposal =
      await caseActor.value.readAcceptedCommerceEntityPlaneProposal({
        proposalId: input.action.proposalId,
      });
    if (!proposal.ok)
      return { ok: false, error: { kind: "proposal_unavailable" } };
    if (proposal.value === null)
      return { ok: false, error: { kind: "action", error: preflightPath.error } };
    if (input.action.state === "signed") {
      const admitted = await admitCommerceCapability({
        db: input.executionScope.database,
        organisationId: input.executionScope.organisationId,
        capability: "core",
        scope: { kind: "organisation" },
      });
      if (!admitted.ok)
        return { ok: false, error: { kind: "capability_inactive" } };
    }
    const executed = await executeCommerceEntityPlaneAction({
      env,
      execution: input.executionScope,
      organisation: input.organisation,
      caseActor: caseActor.value,
      action: input.action,
      now,
    });
    if (!executed.ok)
      return { ok: false, error: { kind: "entity_plane", error: executed.error } };
    const responseBody = {
      ok: true,
      action: commerceEntityPlaneActionRecord(executed.value),
      receipt: executed.value.receipt,
      effect: executed.value.effect,
      follow_up: { kind: "complete" } satisfies CommerceActionFollowUp,
    };
    return { ok: true, value: { body: responseBody } };
  }
  if (input.action.state === "confirmed" || input.action.state === "failed") {
    const storedReceipt = parseStoredCommerceProviderReceipt(
      input.action.providerResult,
    );
    // A later call on a failed change settles a delivery that could not finish.
    const followUp: CommerceActionFollowUp =
      storedReceipt !== null
        ? await completeCommerceActionFollowUp({
            env,
            entry: input.action,
            receipt: storedReceipt,
            now,
          })
        : input.action.state === "failed"
          ? await reportCommerceExecutionFailure({
              env,
              entry: input.action,
              now,
            })
          : { kind: "complete" };
    const responseBody = {
      ok: true,
      action: commerceActionRecord(input.action),
      receipt: parseProviderReceipt(input.action.providerResult),
      follow_up: followUp,
    };
    return { ok: true, value: { body: responseBody } };
  }
  const preflightTarget = commerceActionProjectionTarget(preflightPath.value);
  if (
    preflightTarget === null &&
    preflightPath.value.kind !== "install_merchant_plugin" &&
    preflightPath.value.kind !== "publish_cafe_menu" &&
    preflightPath.value.kind !== "change_menu_price" &&
    preflightPath.value.kind !== "refund_order" &&
    preflightPath.value.kind !== "stock_operation"
  ) {
    return { ok: false, error: { kind: "action", error: {
      code: "commerce_action_path_invalid",
    } } };
  }
  // A plugin or a menu is configuration in Commerce: no projection to read.
  const preflightProjection =
    preflightTarget === null
      ? ({ ok: true, value: null } as const)
      : await input.organisation.readCurrentCommerceProjection({
          organisationId: input.executionScope.organisationId,
          kind: preflightTarget.kind,
          canonicalId: preflightTarget.resourceId,
        });
  if (!preflightProjection.ok)
    return { ok: false, error: { kind: "projection", code: preflightProjection.error.code } };
  const authority = await validateCommerceActionAuthorityBeforeExecution({
    scope: input.executionScope,
    action: input.action.action,
    current: preflightProjection.value,
    now,
  });
  if (!authority.ok)
    return { ok: false, error: { kind: "provider", error: authority.error } };
  let begun: Awaited<ReturnType<OrganisationCommerce["beginActionExecution"]>>;
  if (input.action.state === "indeterminate") {
    const reconciliation = await reconcileCommerceProviderAction({
      env,
      scope: input.executionScope,
      action: input.action,
      current: preflightProjection.value,
      now,
    });
    if (!reconciliation.ok) {
      return { ok: false, error: { kind: "provider", error: reconciliation.error } };
    }
    if (reconciliation.value.kind === "unresolved") {
      return { ok: false, error: { kind: "reconciliation_pending", action: commerceActionRecord(input.action) } };
    }
    if (reconciliation.value.kind === "settled") {
      const completed =
        await input.organisation.reconcileCommerceProviderReceipt({
          organisationId: input.executionScope.organisationId,
          nonce: input.actionNonce,
          now,
          receipt: reconciliation.value.receipt,
        });
      if (!completed.ok) return { ok: false, error: { kind: "ledger", error: completed.error } };
      if (
        completed.value.state !== "confirmed" &&
        completed.value.state !== "failed"
      ) {
        return { ok: false, error: { kind: "ledger", error: { code: "invalid_action_transition" } } };
      }
      const followUp = await completeCommerceActionFollowUp({
        env,
        entry: completed.value,
        receipt: reconciliation.value.receipt,
        now,
      });
      const responseBody = {
        ok: true,
        action: commerceActionRecord(completed.value),
        receipt: reconciliation.value.receipt,
        projection: null,
        projection_refresh: "awaiting_provider_event" as const,
        follow_up: followUp,
      };
      return { ok: true, value: { body: responseBody } };
    }
    begun = await input.organisation.retryIndeterminateActionExecution({
      organisationId: input.executionScope.organisationId,
      nonce: input.actionNonce,
      evidence: reconciliation.value.evidence,
      now,
    });
  } else {
    const admitted = await admitCommerceActionCapability({
      scope: input.executionScope,
      action: input.action.action,
      path: preflightPath.value,
      current: preflightProjection.value,
    });
    if (!admitted.ok)
      return { ok: false, error: { kind: "provider", error: admitted.error } };
    begun = await input.organisation.beginActionExecution({
      organisationId: input.executionScope.organisationId,
      nonce: input.actionNonce,
      now,
    });
  }
  if (!begun.ok) return { ok: false, error: { kind: "ledger", error: begun.error } };
  if (begun.value.state !== "executing") {
    return { ok: false, error: { kind: "ledger", error: { code: "invalid_action_transition" } } };
  }
  const path = parseCommerceActionPath(begun.value.action);
  if (!path.ok) {
    const failed = await input.organisation.completeActionExecution({
      organisationId: input.executionScope.organisationId,
      nonce: input.actionNonce,
      now,
      executionLeaseId: begun.value.executionLease.leaseId,
      outcome: "failed",
      providerResult: JSON.stringify(path.error),
    });
    if (!failed.ok) return { ok: false, error: { kind: "ledger", error: failed.error } };
    if (failed.value.state === "failed")
      await reportCommerceExecutionFailure({ env, entry: failed.value, now });
    return { ok: false, error: { kind: "action", error: path.error } };
  }
  const target = commerceActionProjectionTarget(path.value);
  if (
    target === null &&
    path.value.kind !== "install_merchant_plugin" &&
    path.value.kind !== "publish_cafe_menu" &&
    path.value.kind !== "change_menu_price" &&
    path.value.kind !== "refund_order" &&
    path.value.kind !== "stock_operation"
  ) {
    return { ok: false, error: { kind: "action", error: {
      code: "commerce_action_path_invalid",
    } } };
  }
  const current =
    target === null
      ? ({ ok: true, value: null } as const)
      : await input.organisation.readCurrentCommerceProjection({
          organisationId: input.executionScope.organisationId,
          kind: target.kind,
          canonicalId: target.resourceId,
        });
  if (!current.ok) {
    const indeterminate = await input.organisation.completeActionExecution({
      organisationId: input.executionScope.organisationId,
      nonce: input.actionNonce,
      now,
      executionLeaseId: begun.value.executionLease.leaseId,
      outcome: "indeterminate",
      providerResult: JSON.stringify({ code: current.error.code }),
    });
    return indeterminate.ok
      ? { ok: false, error: { kind: "projection", code: current.error.code } }
      : { ok: false, error: { kind: "ledger", error: indeterminate.error } };
  }
  const operation = await executeCommerceProviderAction({
    env,
    scope: input.executionScope,
    action: begun.value,
    current: current.value,
    now,
  });
  if (!operation.ok) {
    const completion = await input.organisation.completeActionExecution({
      organisationId: input.executionScope.organisationId,
      nonce: input.actionNonce,
      now,
      executionLeaseId: begun.value.executionLease.leaseId,
      outcome:
        operation.error.code === "commerce_action_provider_indeterminate"
          ? "indeterminate"
          : "failed",
      providerResult: JSON.stringify(operation.error),
    });
    if (!completion.ok) return { ok: false, error: { kind: "ledger", error: completion.error } };
    if (completion.value.state === "failed")
      await reportCommerceExecutionFailure({
        env,
        entry: completion.value,
        now,
      });
    return { ok: false, error: { kind: "provider", error: operation.error } };
  }

  if (operation.value.kind === "projection_delivery") {
    const applied = await input.organisation.applyCommerceDelivery({
      organisationId: input.executionScope.organisationId,
      integrationAccountId: begun.value.action.integrationAccountId,
      delivery: operation.value.delivery,
      cueFacts: [],
      labRunId: null,
      processedAt: now,
      commerceSystem:
        begun.value.action.authority.kind === "commerce_system"
          ? {
              kind: begun.value.action.authority.system,
              revision: begun.value.action.authority.revision,
            }
          : { kind: "lab", revision: null },
    });
    if (!applied.ok) {
      const failed = await input.organisation.completeActionExecution({
        organisationId: input.executionScope.organisationId,
        nonce: input.actionNonce,
        now,
        executionLeaseId: begun.value.executionLease.leaseId,
        outcome: "failed",
        providerResult: JSON.stringify(applied.error),
      });
      if (!failed.ok) return { ok: false, error: { kind: "ledger", error: failed.error } };
      if (failed.value.state === "failed")
        await reportCommerceExecutionFailure({ env, entry: failed.value, now });
      return { ok: false, error: { kind: "projection", code: applied.error.code } };
    }
    const completed = await input.organisation.completeActionExecution({
      organisationId: input.executionScope.organisationId,
      nonce: input.actionNonce,
      now,
      executionLeaseId: begun.value.executionLease.leaseId,
      outcome: "confirmed",
      providerResult: JSON.stringify(operation.value.receipt),
    });
    if (!completed.ok) return { ok: false, error: { kind: "ledger", error: completed.error } };
    if (completed.value.state !== "confirmed") {
      return { ok: false, error: { kind: "ledger", error: { code: "invalid_action_transition" } } };
    }
    const followUp = await completeCommerceActionFollowUp({
      env,
      entry: completed.value,
      receipt: operation.value.receipt,
      now,
    });
    const responseBody = {
      ok: true,
      action: commerceActionRecord(completed.value),
      receipt: operation.value.receipt,
      projection: applied.value,
      follow_up: followUp,
    };
    return { ok: true, value: { body: responseBody } };
  }

  const completed = await input.organisation.reconcileCommerceProviderReceipt({
    organisationId: input.executionScope.organisationId,
    nonce: input.actionNonce,
    now,
    receipt: operation.value.receipt,
  });
  if (!completed.ok) return { ok: false, error: { kind: "ledger", error: completed.error } };
  if (
    completed.value.state !== "confirmed" &&
    completed.value.state !== "failed"
  ) {
    return { ok: false, error: { kind: "ledger", error: { code: "invalid_action_transition" } } };
  }
  const followUp = await completeCommerceActionFollowUp({
    env,
    entry: completed.value,
    receipt: operation.value.receipt,
    now,
  });
  const responseBody = {
    ok: true,
    action: commerceActionRecord(completed.value),
    receipt: operation.value.receipt,
    projection: null,
    projection_refresh: "awaiting_provider_event" as const,
    follow_up: followUp,
  };
  return { ok: true, value: { body: responseBody } };
}

async function completeCommerceActionFollowUp(
  input: Readonly<{
    env: Env;
    entry: VariantBy<ActionLedgerEntry, "state", "confirmed" | "failed">;
    receipt: CommerceProviderReceipt;
    now: number;
  }>,
): Promise<CommerceActionFollowUp> {
  // The provider result is already durable. Reporting cannot change that outcome.
  try {
    if (!(await scheduleCommerceProjectionRefresh(input))) {
      return {
        kind: "unavailable",
        code: "commerce_projection_refresh_unavailable",
      };
    }
    const result = await acceptAndDeliverCommerceOutcome({
      kind: "provider_receipt",
      env: input.env,
      entry: input.entry,
      receipt: input.receipt,
      now: input.now,
    });
    return commerceOutcomeFollowUp(result);
  } catch {
    return { kind: "unavailable", code: "commerce_follow_up_unavailable" };
  }
}

/** Tells the Case that an approved change failed, so its card says so. */
async function reportCommerceExecutionFailure(
  input: Readonly<{
    env: Env;
    entry: VariantBy<ActionLedgerEntry, "state", "failed">;
    now: number;
  }>,
): Promise<CommerceActionFollowUp> {
  // The failure is already durable. Reporting cannot change that outcome.
  let followUp: CommerceActionFollowUp;
  try {
    followUp = commerceOutcomeFollowUp(
      await acceptAndDeliverCommerceOutcome({
        kind: "execution_failure",
        ...input,
      }),
    );
  } catch {
    followUp = { kind: "unavailable", code: "commerce_follow_up_unavailable" };
  }
  if (followUp.kind !== "complete")
    traceWarn("commerce.action.failure_report_unfinished", {
      requestId: newRequestId(),
      organisation_id: input.entry.action.organisationId,
      action_nonce: input.entry.action.nonce.value,
      detail: followUp.kind === "unavailable" ? followUp.code : "pending",
    });
  return followUp;
}

function commerceOutcomeFollowUp(
  result: CommerceCaseOutcomeResult,
): CommerceActionFollowUp {
  if (!result.ok) return { kind: "unavailable", code: result.error.code };
  switch (result.value.kind) {
    case "pending":
      return { kind: "pending", retryAt: result.value.retryAt };
    case "delivered":
    case "already_settled":
    case "unaddressed":
    case "held":
      return { kind: "complete" };
    default:
      return assertNever(result.value);
  }
}

async function scheduleCommerceProjectionRefresh(
  input: Readonly<{
    env: Env;
    entry: ActionLedgerEntry;
    receipt: CommerceProviderReceipt;
    now: number;
  }>,
): Promise<boolean> {
  if (input.receipt.provider !== "commerce") return true;
  try {
    await input.env.EVENT_Q.send(
      createCommerceOutboxReconcileQueueMessage({
        requestId: newRequestId(),
        receivedAt: input.now,
        organisationId: input.entry.action.organisationId,
        integrationAccountId: input.entry.action.integrationAccountId,
      }),
      { contentType: "json" },
    );
    return true;
  } catch {
    return false;
  }
}

type CommerceCaseOutcomeDelivery =
  | {
      readonly kind: "delivered" | "already_settled";
      readonly caseRevision: number;
      readonly deliveryReceiptId: string;
    }
  | { readonly kind: "unaddressed"; readonly caseRevision: number }
  | { readonly kind: "held"; readonly caseRevision: number }
  | {
      readonly kind: "pending";
      readonly caseRevision: number;
      readonly retryAt: number;
    };

type CommerceCaseOutcomeResult =
  | { readonly ok: true; readonly value: CommerceCaseOutcomeDelivery }
  | { readonly ok: false; readonly error: { readonly code: string } };

type DeliverCommerceOutcomeInput =
  | {
      readonly kind: "provider_receipt";
      readonly env: Env;
      readonly entry: ActionLedgerEntry;
      readonly receipt: CommerceProviderReceipt;
      readonly now: number;
    }
  | {
      readonly kind: "merchant_rejection";
      readonly env: Env;
      readonly entry: VariantBy<ActionLedgerEntry, "state", "rejected">;
      readonly rejection: MerchantActionRejectionEvidence;
      readonly now: number;
    }
  | {
      readonly kind: "execution_failure";
      readonly env: Env;
      readonly entry: VariantBy<ActionLedgerEntry, "state", "failed">;
      readonly now: number;
    };

export async function acceptAndDeliverCommerceOutcome(
  input: DeliverCommerceOutcomeInput,
): Promise<CommerceCaseOutcomeResult> {
  const execution = await OrganisationExecutionScope.resolve(
    input.env,
    input.entry.action.organisationId,
  );
  if (!execution.ok)
    return { ok: false, error: { code: execution.error.code } };
  const caseActor = await resolveActiveCaseActorAtPlacement({
    placement: execution.value.placement,
    env: input.env,
    namespace: input.env.CASE,
    organisationId: input.entry.action.organisationId,
    caseId: input.entry.caseId,
    now: input.now,
  });
  if (!caseActor.ok)
    return { ok: false, error: { code: caseActor.error.code } };
  // The outcome's text is the card of the approval notice with its new state.
  const notice = await caseActor.value.readCommerceApprovalNotice({
    caseId: input.entry.caseId,
    actionNonce: input.entry.action.nonce.value,
  });
  const accepted = await caseActor.value.acceptCommerceOutcome({
    caseId: input.entry.caseId,
    proposalId: input.entry.proposalId,
    actionNonce: input.entry.action.nonce.value,
    outcome: commerceCaseOutcome(input),
    content: {
      kind: "text",
      text: commerceApprovalCardTexts
        .use()
        .actionCardText(
          notice === null
            ? commerceApprovalCardTexts.use().actionSummary(input.entry.action)
            : commerceApprovalCardTexts.use().cardSummary(notice),
          input.entry,
        ),
    },
    acceptedAt: input.now,
  });
  if (accepted.ok !== true) return accepted;
  const output = accepted.value.output;
  if (output === null)
    return {
      ok: true,
      value: { kind: "unaddressed", caseRevision: accepted.value.revision },
    };
  if (output.kind === "settled") {
    return {
      ok: true,
      value: {
        kind: "already_settled",
        caseRevision: accepted.value.revision,
        deliveryReceiptId: output.receipt.nativeReceiptId,
      },
    };
  }
  // A held outcome waits for a person; only that decision sends it. A dropped
  // or rejected one never goes out (Refactor 15).
  if (output.kind === "held")
    return {
      ok: true,
      value: { kind: "held", caseRevision: accepted.value.revision },
    };
  if (output.kind === "dropped" || output.kind === "rejected")
    return {
      ok: true,
      value: { kind: "unaddressed", caseRevision: accepted.value.revision },
    };

  const requestAuthority = parseStoredRequestAuthority(
    input.entry.action.requestAuthority,
  );
  if (!requestAuthority.ok) {
    return { ok: false, error: { code: "commerce_case_authority_invalid" } };
  }
  const delivered = await deliverCommerceCaseOutput({
    env: input.env,
    scope: execution.value,
    caseActor: caseActor.value,
    output: output.output,
    authority: {
      organisationId: input.entry.action.organisationId,
      sessionId: input.entry.action.sessionId,
      executionId: input.entry.action.nonce.value,
      requestAuthority: requestAuthority.value.requestAuthority,
      authorityPartitionDigest: input.entry.action.authorityPartition.digest,
    },
    now: input.now,
  });
  if (!delivered.ok) return delivered;
  if (delivered.value.kind === "held")
    return {
      ok: true,
      value: { kind: "held", caseRevision: accepted.value.revision },
    };
  return {
    ok: true,
    value:
      delivered.value.kind === "pending"
        ? {
            kind: "pending",
            caseRevision: accepted.value.revision,
            retryAt: delivered.value.retryAt,
          }
        : {
            kind: delivered.value.kind,
            caseRevision: accepted.value.revision,
            deliveryReceiptId: delivered.value.deliveryReceiptId,
          },
  };
}

function commerceCaseOutcome(input: DeliverCommerceOutcomeInput):
  | {
      readonly kind: "provider_receipt";
      readonly receipt: CommerceProviderReceipt;
    }
  | {
      readonly kind: "merchant_rejection";
      readonly evidence: MerchantActionRejectionEvidence;
    }
  | {
      readonly kind: "execution_failure";
      readonly actionNonce: string;
    } {
  switch (input.kind) {
    case "provider_receipt":
      return { kind: "provider_receipt", receipt: input.receipt };
    case "merchant_rejection":
      return { kind: "merchant_rejection", evidence: input.rejection };
    case "execution_failure":
      return {
        kind: "execution_failure",
        actionNonce: input.entry.action.nonce.value,
      };
    default:
      return assertNever(input);
  }
}

type CommerceActionRecordDetails =
  CommerceActionPath | CommerceEntityPlaneActionPath;

type CommerceActionRecordAuthority =
  | Variant<ActionLedgerEntry["action"]["authority"], "commerce_system">
  | {
      readonly kind: "integration_account";
      readonly integrationAccountId: ActionLedgerEntry["action"]["integrationAccountId"];
    };

export type CommerceActionRecord = {
  readonly nonce: ActionLedgerEntry["action"]["nonce"];
  readonly caseId: ActionLedgerEntry["caseId"];
  readonly proposalId: string;
  readonly state: ActionLedgerEntry["state"];
  readonly verb: string;
  readonly resourceKey: string;
  readonly amount: ActionLedgerEntry["action"]["amount"];
  readonly details: CommerceActionRecordDetails;
  readonly commerceSystem: CommerceActionRecordAuthority;
  readonly providerResult: string | null;
};

export function commerceActionRecord(entry: ActionLedgerEntry): CommerceActionRecord {
  const details = parseCommerceActionPath(entry.action);
  let recordDetails: CommerceActionRecordDetails;
  if (details.ok) {
    recordDetails = details.value;
  } else {
    const entityPlaneDetails = parseCommerceEntityPlaneActionPath(entry.action);
    if (!entityPlaneDetails.ok) throw new Error("commerce_action_path_invalid");
    recordDetails = entityPlaneDetails.value;
  }
  return {
    nonce: entry.action.nonce,
    caseId: entry.caseId,
    proposalId: entry.proposalId,
    state: entry.state,
    verb: entry.action.verb,
    resourceKey: entry.action.resourceKey,
    amount: entry.action.amount,
    details: recordDetails,
    commerceSystem: commerceActionAuthorityRecord(entry),
    providerResult: commerceActionProviderResult(entry),
  };
}

function commerceActionAuthorityRecord(
  entry: ActionLedgerEntry,
): CommerceActionRecordAuthority {
  switch (entry.action.authority.kind) {
    case "commerce_system":
      return entry.action.authority;
    case "integration_account":
      return {
        kind: "integration_account",
        integrationAccountId: entry.action.integrationAccountId,
      };
    case "custom_connector":
      throw new Error("custom_connector_action_outside_commerce_route");
    default:
      return assertNever(entry.action.authority);
  }
}

function commerceActionProviderResult(entry: ActionLedgerEntry): string | null {
  switch (entry.state) {
    case "confirmed":
    case "failed":
      return entry.providerResult;
    case "proposed":
    case "approval_requested":
    case "signed":
    case "executing":
    case "indeterminate":
    case "rejected":
    case "expired":
      return null;
    default:
      return assertNever(entry);
  }
}

function commerceEntityPlaneActionRecord(
  outcome: CommerceEntityPlaneExecutionOutcome,
): CommerceActionRecord {
  return commerceActionRecord(outcome.action);
}

function parseProviderReceipt(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { kind: "receipt_unparseable" };
  }
}

function parseStoredCommerceProviderReceipt(
  value: string,
): CommerceProviderReceipt | null {
  const parsed = parseCommerceProviderReceipt(parseProviderReceipt(value));
  return parsed.ok ? parsed.value : null;
}

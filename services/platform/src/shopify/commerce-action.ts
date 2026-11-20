// The execution and the reconciliation of a commerce action on Shopify. The
// commerce area calls these two functions for a shop whose commerce system is
// Shopify. Today the one action is the cancellation of an order.
import type { CommerceProjection } from "@purin-labs/commerce-contracts";
import { type CommerceActionPath } from "../commerce/action-model";
import type {
  ActionLedgerEntry,
  ExecutingActionLedgerEntry,
  LedgerCanonicalAction,
} from "../actors/action-ledger";
import type { Env } from "../env";
import {
  buildShopifyOrderCancelDraft,
  parseShopifyOrderCancelArgs,
  SHOPIFY_ORDER_CANCEL_TOOL,
} from "../generated/action-registry";
import {
  executeShopifyAction,
  reconcileShopifyOrderCancellation,
  resolveShopifyWriteCredential,
  resolveShopifyWriteCredentialForAction,
} from "./action-execution";
import type { ShopifyExecutionReceipt } from "./action-execution";
import type { Result } from "../result";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import type { CommerceShopifyProviderReceipt } from "@purin-labs/commerce-control-api";
import {
  type CommerceEffectGatePermit,
  type CommerceProviderExecutionError,
  type CommerceProviderOperation,
  type CommerceProviderReconciliation,
  commerceProjectionRevision,
} from "../commerce/provider-execution";

export async function reconcileShopifyCommerceAction(
  input: Readonly<{
    env: Env;
    action: VariantBy<ActionLedgerEntry, "state", "indeterminate">;
    current: Variant<CommerceProjection, "commerce_order">;
    path: Variant<CommerceActionPath, "cancel_order">;
    permit: Variant<CommerceEffectGatePermit, "shopify">;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<
  Result<CommerceProviderReconciliation, CommerceProviderExecutionError>
> {
  const parsedArgs = orderCancelArgs(input);
  if (!parsedArgs.ok) return { ok: true, value: { kind: "unresolved" } };
  const credential = await resolveShopifyWriteCredential({
    env: input.env,
    organisationId: input.action.action.organisationId,
    integrationAccountId: input.action.action.integrationAccountId,
    fetcher: input.fetcher,
    now: input.now,
  });
  if (!credential.ok) return { ok: true, value: { kind: "unresolved" } };
  const reconciliation = await reconcileShopifyOrderCancellation({
    credential: credential.value,
    orderId: input.current.projection.provenance.resourceId,
    fetcher: input.fetcher,
  });
  if (
    !reconciliation.ok ||
    reconciliation.value.kind !== "cancelled" ||
    reconciliation.value.cancelReason !== shopifyCancelReason(input.path.reason)
  ) {
    return { ok: true, value: { kind: "unresolved" } };
  }
  return {
    ok: true,
    value: {
      kind: "settled",
      receipt: shopifyReceipt({
        actionNonce: input.action.action.nonce.value,
        flowBindingDigest: input.permit.flowDecision.flowBindingDigest,
        decisionDigest: input.permit.flowDecision.decisionDigest,
        resourceId: input.path.resourceId,
        revision: commerceProjectionRevision(input.current),
        observedAt: reconciliation.value.cancelledAt,
        result: {
          kind: "confirmed",
          actionKind: "shopify_order_cancel",
          provider: "shopify",
          statusCode: 200,
          orderId: reconciliation.value.orderId,
          jobId: `shopify_reconciled_${input.action.action.nonce.value}`,
          jobDone: true,
        },
      }),
    },
  };
}

export async function executeShopifyCommerceAction(input: {
  readonly env: Env;
  readonly action: ExecutingActionLedgerEntry;
  readonly current: Variant<CommerceProjection, "commerce_order">;
  readonly path: Variant<CommerceActionPath, "cancel_order">;
  readonly permit: Variant<CommerceEffectGatePermit, "shopify">;
  readonly currentRevision: number;
  readonly now: number;
  readonly fetcher: typeof fetch;
}): Promise<Result<CommerceProviderOperation, CommerceProviderExecutionError>> {
  const parsedArgs = orderCancelArgs(input);
  if (!parsedArgs.ok) {
    return {
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    };
  }

  const draft = await buildShopifyOrderCancelDraft(parsedArgs.value);
  const providerAction: LedgerCanonicalAction = {
    ...input.action.action,
    host: draft.host,
    verb: draft.verb,
    path: draft.path,
    argsHash: draft.argsHash,
    amount: draft.amount,
    resourceKey: draft.resourceKey,
  };
  const credential = await resolveShopifyWriteCredentialForAction({
    env: input.env,
    action: input.action,
    fetcher: input.fetcher,
    now: input.now,
  });
  if (!credential.ok) {
    return {
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    };
  }
  const executed = await executeShopifyAction({
    action: providerAction,
    call: {
      kind: "shopify_order_cancel",
      tool: SHOPIFY_ORDER_CANCEL_TOOL,
      args: parsedArgs.value,
    },
    credential: credential.value,
    fetcher: input.fetcher,
  });
  if (!executed.ok) {
    return {
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    };
  }

  const receipt: CommerceShopifyProviderReceipt = shopifyReceipt({
    actionNonce: input.action.action.nonce.value,
    flowBindingDigest: input.permit.flowDecision.flowBindingDigest,
    decisionDigest: input.permit.flowDecision.decisionDigest,
    resourceId: input.path.resourceId,
    revision: input.currentRevision,
    observedAt: new Date(input.now).toISOString(),
    result: executed.value,
  });
  return { ok: true, value: { kind: "provider_receipt", receipt } };
}

/** The arguments of a Shopify order cancellation, from the commerce action. */
function orderCancelArgs(
  input: Readonly<{
    current: Variant<CommerceProjection, "commerce_order">;
    path: Variant<CommerceActionPath, "cancel_order">;
    permit: Variant<CommerceEffectGatePermit, "shopify">;
  }>,
) {
  return parseShopifyOrderCancelArgs({
    shopDomain: input.permit.accountContext.account.providerAccountId,
    orderId: input.current.projection.provenance.resourceId,
    cancelReason: shopifyCancelReason(input.path.reason),
    refundOriginal: input.path.refund === "full",
    restock: input.path.restock,
    notifyCustomer: input.path.notifyCustomer,
    staffNote: input.path.note,
  });
}

function shopifyCancelReason(
  reason: Variant<CommerceActionPath, "cancel_order">["reason"],
): "CUSTOMER" | "FRAUD" | "INVENTORY" {
  switch (reason) {
    case "customer_requested":
      return "CUSTOMER";
    case "fraud_suspected":
      return "FRAUD";
    case "inventory_unavailable":
      return "INVENTORY";
  }
}

function shopifyReceipt(input: {
  readonly actionNonce: string;
  readonly flowBindingDigest: string;
  readonly decisionDigest: string;
  readonly resourceId: string;
  readonly revision: number;
  readonly observedAt: string;
  readonly result: ShopifyExecutionReceipt;
}): CommerceShopifyProviderReceipt {
  switch (input.result.kind) {
    case "confirmed":
      return {
        kind: "commerce_provider_receipt",
        provider: "shopify",
        receiptId: `shopify_receipt_${input.actionNonce}`,
        effectId: `shopify_effect_${input.actionNonce}`,
        actionNonce: input.actionNonce,
        flowBindingDigest: input.flowBindingDigest,
        decisionDigest: input.decisionDigest,
        eventId: null,
        resourceId: input.resourceId,
        projectionKind: "commerce_order",
        revision: input.revision,
        status: "accepted",
        jobId: input.result.jobId,
        jobDone: input.result.jobDone,
        errors: [],
        observedAt: input.observedAt,
      };
    case "failed":
      return {
        kind: "commerce_provider_receipt",
        provider: "shopify",
        receiptId: `shopify_receipt_${input.actionNonce}`,
        effectId: `shopify_effect_${input.actionNonce}`,
        actionNonce: input.actionNonce,
        flowBindingDigest: input.flowBindingDigest,
        decisionDigest: input.decisionDigest,
        eventId: null,
        resourceId: input.resourceId,
        projectionKind: "commerce_order",
        revision: input.revision,
        status: "failed",
        jobId: null,
        jobDone: null,
        errors: input.result.errors,
        observedAt: input.observedAt,
      };
    case "indeterminate":
      return {
        kind: "commerce_provider_receipt",
        provider: "shopify",
        receiptId: `shopify_receipt_${input.actionNonce}`,
        effectId: `shopify_effect_${input.actionNonce}`,
        actionNonce: input.actionNonce,
        flowBindingDigest: input.flowBindingDigest,
        decisionDigest: input.decisionDigest,
        eventId: null,
        resourceId: input.resourceId,
        projectionKind: "commerce_order",
        revision: input.revision,
        status: "indeterminate",
        jobId: null,
        jobDone: null,
        errors: [],
        observedAt: input.observedAt,
      };
  }
}

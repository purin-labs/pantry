// The `CommerceProvider` of Shopify (Refactor 17, step A2.5): the credential,
// the execution and the reconciliation of a commerce action, the graph read
// source and the control API shape of the selected shop. Today the one action
// is the cancellation of an order.
import type { CommerceProjection } from "@purin-labs/commerce-contracts";
import type { CommerceActionPath } from "../commerce/contract/types";
import { commerceProjectionRevision } from "../commerce/contract/commerce-provider";
import type {
  ActionLedgerEntry,
  ExecutingActionLedgerEntry,
  LedgerCanonicalAction,
} from "@purin-labs/authority/actors/action-ledger";
import type { Env } from "@purin-labs/kernel/env";
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
import type { Result } from "@purin-labs/kernel/result";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import type { CommerceShopifyProviderReceipt } from "@purin-labs/control-api";
import {
  commerceProviderUnsupported,
  type CommerceEffectGatePermit,
  type CommerceProvider,
  type CommerceProviderExecutionError,
  type CommerceProviderOperation,
  type CommerceProviderReconciliation,
} from "../commerce/contract/commerce-provider";
import { resolveActiveProviderAccountContext } from "@purin-labs/connections/data/integration-account";
import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";

async function reconcileShopifyCommerceAction(
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

async function executeShopifyCommerceAction(input: {
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

export const shopifyCommerceProvider: CommerceProvider<"shopify"> = {
  kind: "shopify",
  wire: (system) => ({
    kind: "shopify",
    organisationId: system.organisationId,
    integrationAccountId: system.integrationAccountId,
    shopDomain: system.shopDomain,
    revision: system.revision,
  }),
  graphSource: (system) => ({
    kind: "provider_backed",
    integrationAccountId: system.integrationAccountId,
  }),
  async resolveActionCredential(input) {
    const accountContext = await resolveActiveProviderAccountContext(input);
    return accountContext.ok &&
      accountContext.value.account.provider === "shopify"
      ? {
          ok: true,
          value: { kind: "shopify", accountContext: accountContext.value },
        }
      : {
          ok: false,
          error: { code: "commerce_action_provider_execution_failed" },
        };
  },
  executeAction(input) {
    const { path, permit } = input;
    if (
      permit.kind !== "shopify" ||
      path.kind !== "cancel_order" ||
      permit.current.kind !== "commerce_order"
    )
      return Promise.resolve(commerceProviderUnsupported());
    return executeShopifyCommerceAction({
      env: input.env,
      action: input.action,
      current: permit.current,
      path,
      permit,
      currentRevision: input.currentRevision,
      now: input.now,
      fetcher: input.fetcher ?? runtimeFetch,
    });
  },
  reconcileAction(input) {
    const { path, permit } = input;
    if (
      permit.kind !== "shopify" ||
      path.kind !== "cancel_order" ||
      permit.current.kind !== "commerce_order"
    )
      return Promise.resolve(commerceProviderUnsupported());
    return reconcileShopifyCommerceAction({
      env: input.env,
      action: input.action,
      current: permit.current,
      path,
      permit,
      now: input.now,
      fetcher: input.fetcher ?? runtimeFetch,
    });
  },
};

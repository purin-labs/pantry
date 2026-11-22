import { commerceSystemKindOfSource } from "@purin-labs/contracts";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationAccess } from "@purin-labs/tenancy/organisation-access/access";
import { acceptedExecutionAuthority } from "@purin-labs/tenancy/organisation-access/access";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { decideCurrentAuthorityFlowSink } from "../chat/information-flow";
import type { CommerceProjection } from "@purin-labs/commerce-contracts";

import {
  buildCommerceLabDelivery,
  commerceActionExpectedRevision,
  parseCommerceActionPath,
  type CommerceActionPath,
} from "./action-model";
import { commerceProjectionRevision } from "./contract/commerce-provider";
import {
  admitCommerceCapability,
  type CommerceCapability,
} from "../data/commerce-capability-activation";
import { resolveCommerceMerchantBinding } from "@purin-labs/connections/data/commerce-merchant-binding";
import { resolveOrganisationCommerceSystemAuthority } from "@purin-labs/connections/data/organisation-commerce-system";
import type {
  ActionLedgerEntry,
  ExecutingActionLedgerEntry,
  LedgerCanonicalAction,
} from "../actors/action-ledger";
import type { Env } from "@purin-labs/kernel/env";
import {
  commerceProviderUnsupported,
  type CommerceEffectGatePermit,
  type CommerceProviderExecuteInput,
  type CommerceProviderExecutionError,
  type CommerceProviderOperation,
  type CommerceProviderReconcileInput,
  type CommerceProviderReconciliation,
} from "./contract/commerce-provider";
import {
  commerceProvider,
  commerceProviderOfPermit,
} from "./commerce-providers";
import type { Result } from "@purin-labs/kernel/result";
import { assertNever } from "@purin-labs/std";
import {
  createCommerceClient,
  createCommerceEntityPlaneClient,
} from "./contract/client";
import {
  cancelOrderThroughCommerce,
  publishCatalogListingThroughCommerce,
  updateProductDescriptionThroughCommerce,
  adjustOfferPriceThroughCommerce,
  installMerchantPluginThroughCommerce,
  reconcileCommerceCafeMenuPublication,
  reconcileCommerceOfferUpdate,
  reconcileCommerceOrderRefund,
  reconcileCommerceCatalogPublication,
  reconcileCommerceProductDescriptionUpdate,
  reconcileCommerceOrderCancellation,
} from "./provider";
import { commerceProviderResourceId } from "./contract/resource-ids";
import { authorizeCapabilityUse } from "../authorization/access-grants/turn-authority";
import type { ProviderCapabilityDefinition } from "../authorization/access-grants/capability-key";
import { parseStoredRequestAuthority } from "../request-authority";
import {
  flowBindingMatchesIdentity,
  FlowBinding,
  type FlowDecision,
} from "../policy";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import type { CommerceMutationErrorV1 } from "@purin-labs/commerce-client";
import type { CommerceEngineProviderReceipt } from "@purin-labs/control-api";
import {
  MERCHANT_PLUGIN_INSTALL_VERB,
  merchantPluginInstallation,
  merchantPluginParts,
} from "./merchant-plugin-action";
import { CAFE_MENU_PUBLISH_VERB } from "./cafe-menu-action";
import { MENU_PRICE_CHANGE_VERB } from "./menu-price-action";
import {
  ORDER_REFUND_VERB,
  orderRefundAllocation,
} from "./order-refund-action";
import { isStockOperationVerb, stockOperationResourceId } from "../kitchen/contract/stock-action";
import {
  executeStockOperation,
  reconcileStockOperation,
  type StockExecution,
} from "../kitchen/contract/stock-action-execution";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { createCommerceOutboxReconcileQueueMessage } from "./contract/queue-messages";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";

type ApprovedCommerceActionEntry = VariantBy<
  ActionLedgerEntry,
  "state",
  "executing" | "indeterminate"
>;

export async function validateCommerceActionAuthorityBeforeExecution(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    action: LedgerCanonicalAction;
    current: CommerceProjection | null;
    now: number;
  }>,
): Promise<Result<null, CommerceProviderExecutionError>> {
  if (
    input.scope.organisationId !== input.action.organisationId ||
    !(await input.scope.isActive())
  ) {
    return {
      ok: false,
      error: { code: "commerce_action_authority_superseded" },
    };
  }
  const requestAuthority = parseStoredRequestAuthority(
    input.action.requestAuthority,
  );
  if (
    !requestAuthority.ok ||
    requestAuthority.value.requestAuthority.organisationId !==
      input.action.organisationId
  ) {
    return {
      ok: false,
      error: { code: "commerce_action_authority_superseded" },
    };
  }
  const requiredCapability = commerceActionCapability(input.action);
  const liveAuthority = await authorizeCapabilityUse({
    db: input.scope.database,
    accountAccess: input.scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      input.action.sessionId,
      input.action.nonce.value,
    ),
    action: "execute",
    organisationId: input.action.organisationId,
    authority: requestAuthority.value.requestAuthority,
    authorityPartition: input.action.authorityPartition,
    request: { capabilities: [requiredCapability] },
  });
  if (!liveAuthority.ok) {
    return {
      ok: false,
      error: { code: "commerce_action_authority_superseded" },
    };
  }
  if (input.current === null) {
    return input.action.verb === MERCHANT_PLUGIN_INSTALL_VERB ||
      input.action.verb === CAFE_MENU_PUBLISH_VERB ||
      input.action.verb === MENU_PRICE_CHANGE_VERB ||
      input.action.verb === ORDER_REFUND_VERB ||
      isStockOperationVerb(input.action.verb)
      ? validateMerchantPluginAuthority(input.scope, input.action)
      : { ok: false, error: { code: "commerce_action_projection_missing" } };
  }
  if (input.current.projection.provenance.source === "lab") {
    return input.current.projection.provenance.integrationAccountId ===
      input.action.integrationAccountId
      ? { ok: true, value: null }
      : { ok: false, error: { code: "commerce_action_provider_unsupported" } };
  }
  if (input.action.authority.kind !== "commerce_system") {
    return authorityRebaseRequired(0, 0);
  }
  const authority = await resolveOrganisationCommerceSystemAuthority({
    db: input.scope.database,
    organisationId: input.action.organisationId,
  });
  if (
    !authority.ok ||
    authority.value.commerceSystem.kind !== input.action.authority.system ||
    authority.value.provider !== input.current.projection.provenance.source ||
    authority.value.integrationAccountId !==
      input.action.integrationAccountId ||
    authority.value.commerceSystem.revision !== input.action.authority.revision
  ) {
    return authorityRebaseRequired(
      input.action.authority.revision,
      authority.ok ? authority.value.commerceSystem.revision : 0,
    );
  }
  return input.current.projection.provenance.integrationAccountId ===
    input.action.integrationAccountId
    ? { ok: true, value: null }
    : { ok: false, error: { code: "commerce_action_provider_unsupported" } };
}

// A merchant plugin has no projection. The commerce system that the proposal
// named must still be Pantry Commerce, on the same account and revision.
async function validateMerchantPluginAuthority(
  scope: OrganisationExecutionScope,
  action: LedgerCanonicalAction,
): Promise<Result<null, CommerceProviderExecutionError>> {
  if (action.authority.kind !== "commerce_system") {
    return authorityRebaseRequired(0, 0);
  }
  const authority = await resolveOrganisationCommerceSystemAuthority({
    db: scope.database,
    organisationId: action.organisationId,
  });
  if (
    !authority.ok ||
    authority.value.commerceSystem.kind !== action.authority.system ||
    authority.value.provider !== "commerce" ||
    authority.value.integrationAccountId !== action.integrationAccountId ||
    authority.value.commerceSystem.revision !== action.authority.revision
  ) {
    return authorityRebaseRequired(
      action.authority.revision,
      authority.ok ? authority.value.commerceSystem.revision : 0,
    );
  }
  return { ok: true, value: null };
}

function commerceActionCapability(
  action: LedgerCanonicalAction,
): ProviderCapabilityDefinition {
  return {
    kind: "provider_resource",
    capabilityId: "commerce.action.propose",
    capabilityVersion: 1,
    integrationAccountId: action.integrationAccountId,
    resourceScope: action.resourceKey,
  };
}

export async function admitCommerceActionCapability(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    action: LedgerCanonicalAction;
    path: CommerceActionPath;
    current: CommerceProjection | null;
  }>,
): Promise<Result<null, CommerceProviderExecutionError>> {
  if (
    input.scope.organisationId !== input.action.organisationId ||
    !(await input.scope.isActive())
  ) {
    return {
      ok: false,
      error: { code: "commerce_action_authority_superseded" },
    };
  }
  if (
    input.current === null &&
    input.path.kind !== "install_merchant_plugin" &&
    input.path.kind !== "publish_cafe_menu" &&
    input.path.kind !== "change_menu_price" &&
    input.path.kind !== "refund_order" &&
    input.path.kind !== "stock_operation"
  ) {
    return { ok: false, error: { code: "commerce_action_projection_missing" } };
  }
  const capability = commerceActionPathCapability(input.path);
  if (
    capability === null ||
    input.current?.projection.provenance.source === "lab"
  ) {
    return { ok: true, value: null };
  }
  const admitted = await admitCommerceCapability({
    db: input.scope.database,
    organisationId: input.action.organisationId,
    capability,
    scope: { kind: "organisation" },
  });
  return admitted.ok
    ? { ok: true, value: null }
    : { ok: false, error: { code: "commerce_action_capability_inactive" } };
}

function commerceActionPathCapability(
  path: CommerceActionPath,
): CommerceCapability | null {
  switch (path.kind) {
    case "publish_catalog_listing":
    case "attach_tracking":
      return "online_commerce";
    case "update_product_description":
    case "adjust_offer_price":
    case "cancel_order":
    case "install_merchant_plugin":
    case "publish_cafe_menu":
    case "change_menu_price":
    case "refund_order":
    case "stock_operation":
      return "core";
    case "submit_supplier_payout":
    case "resume_supplier_payout_funding":
      return null;
    default:
      return assertNever(path);
  }
}

async function authorizeCommerceEffectGatePlan(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    action: ApprovedCommerceActionEntry;
    current: CommerceProjection | null;
    now: number;
  }>,
): Promise<Result<CommerceEffectGatePermit, CommerceProviderExecutionError>> {
  const authority = await validateCommerceActionAuthorityBeforeExecution({
    scope: input.scope,
    action: input.action.action,
    current: input.current,
    now: input.now,
  });
  if (!authority.ok) return authority;
  if (input.current === null) {
    return { ok: false, error: { code: "commerce_action_projection_missing" } };
  }

  if (input.current.projection.provenance.source === "lab") {
    const flowDecision = await authorizeCommerceEffectSink(
      input.scope.database,
      input.scope.accountAccess,
      input.action.action,
    );
    return flowDecision.ok
      ? {
          ok: true,
          value: {
            kind: "lab",
            current: input.current,
            flowDecision: flowDecision.value,
            approval: input.action.approval,
          },
        }
      : flowDecision;
  }

  const systemKind = commerceSystemKindOfSource(
    input.current.projection.provenance.source,
  );
  if (systemKind !== null) {
    const credential = await commerceProvider(
      systemKind,
    ).resolveActionCredential({
      db: input.scope.database,
      organisationId: input.action.action.organisationId,
      integrationAccountId: input.action.action.integrationAccountId,
    });
    if (!credential.ok) return credential;
    const flowDecision = await authorizeCommerceEffectSink(
      input.scope.database,
      input.scope.accountAccess,
      input.action.action,
    );
    return flowDecision.ok
      ? {
          ok: true,
          value: {
            ...credential.value,
            current: input.current,
            flowDecision: flowDecision.value,
            approval: input.action.approval,
          },
        }
      : flowDecision;
  }

  return { ok: false, error: { code: "commerce_action_provider_unsupported" } };
}

export async function reconcileCommerceProviderAction(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    action: VariantBy<ActionLedgerEntry, "state", "indeterminate">;
    current: CommerceProjection | null;
    now: number;
    fetcher?: typeof fetch;
  }>,
): Promise<
  Result<CommerceProviderReconciliation, CommerceProviderExecutionError>
> {
  const path = parseCommerceActionPath(input.action.action);
  if (!path.ok) return path;
  if (
    path.value.kind === "publish_cafe_menu" ||
    path.value.kind === "change_menu_price" ||
    path.value.kind === "refund_order" ||
    path.value.kind === "stock_operation"
  ) {
    // The merchant revision moves after a commit, so the receipt under the
    // action's key decides. With no receipt, the action may run again.
    const shared = {
      env: input.env,
      scope: input.scope,
      action: input.action,
      now: input.now,
      fetcher: input.fetcher,
    };
    const publication =
      path.value.kind === "stock_operation"
        ? await runApprovedStockOperation(
            { ...shared, path: path.value },
            reconcileStockOperation,
          )
        : path.value.kind === "refund_order"
          ? await reconcileApprovedOrderRefund({ ...shared, path: path.value })
          : path.value.kind === "change_menu_price"
            ? await reconcileApprovedMenuPrice({ ...shared, path: path.value })
            : await reconcileApprovedCafeMenu({ ...shared, path: path.value });
    if (!publication.ok) return publication;
    switch (publication.value.kind) {
      case "settled":
        return {
          ok: true,
          value: { kind: "settled", receipt: publication.value.receipt },
        };
      case "absent":
        return {
          ok: true,
          value: {
            kind: "retryable",
            evidence: {
              kind: "provider_idempotency_absent",
              integrationAccountId: input.action.action.integrationAccountId,
              idempotencyKey: input.action.idempotencyKey,
              observedAt: input.now,
            },
          },
        };
      case "indeterminate":
        return { ok: true, value: { kind: "unresolved" } };
    }
  }
  if (path.value.kind === "install_merchant_plugin") {
    // Re-sending is safe: the idempotency key is the action's, so Commerce
    // replays the receipt rather than installing a second version.
    const installation = await installApprovedMerchantPlugin({
      env: input.env,
      scope: input.scope,
      action: input.action,
      path: path.value,
      now: input.now,
      fetcher: input.fetcher,
    });
    if (!installation.ok) return installation;
    switch (installation.value.kind) {
      case "settled":
        return {
          ok: true,
          value: { kind: "settled", receipt: installation.value.receipt },
        };
      case "absent":
        return {
          ok: true,
          value: {
            kind: "retryable",
            evidence: {
              kind: "provider_idempotency_absent",
              integrationAccountId: input.action.action.integrationAccountId,
              idempotencyKey: input.action.idempotencyKey,
              observedAt: input.now,
            },
          },
        };
      case "indeterminate":
        return { ok: true, value: { kind: "unresolved" } };
    }
  }
  const gate = await authorizeCommerceEffectGatePlan({
    scope: input.scope,
    action: input.action,
    current: input.current,
    now: input.now,
  });
  if (!gate.ok) {
    return gate.error.code === "commerce_action_projection_missing"
      ? { ok: true, value: { kind: "unresolved" } }
      : gate;
  }
  if (gate.value.kind === "lab") {
    return commerceProjectionRevision(gate.value.current) ===
      commerceActionExpectedRevision(path.value)
      ? {
          ok: true,
          value: {
            kind: "retryable",
            evidence: {
              kind: "local_effect_absent",
              integrationAccountId: input.action.action.integrationAccountId,
              resourceKey: input.action.action.resourceKey,
              observedAt: input.now,
            },
          },
        }
      : { ok: true, value: { kind: "unresolved" } };
  }
  const provider = commerceProviderOfPermit(gate.value);
  return provider === null
    ? commerceProviderUnsupported()
    : provider.reconcileAction({
        env: input.env,
        action: input.action,
        path: path.value,
        permit: gate.value,
        now: input.now,
        fetcher: input.fetcher,
      });
}

/** The reconciliation of an action on a record of the built-in engine. */
export async function reconcileBuiltInCommerceAction(
  input: CommerceProviderReconcileInput,
): Promise<
  Result<CommerceProviderReconciliation, CommerceProviderExecutionError>
> {
  const { path, permit } = input;
  if (permit.kind !== "commerce") return commerceProviderUnsupported();
  if (
    path.kind === "attach_tracking" &&
    permit.current.kind === "fulfillment"
  ) {
    const attachment = await attachTrackingThroughCommerce({
      env: input.env,
      action: input.action,
      path: path,
      permit: permit,
      fetcher: input.fetcher,
    });
    if (attachment.kind === "settled") {
      return {
        ok: true,
        value: { kind: "settled", receipt: attachment.receipt },
      };
    }
    return attachment.kind === "absent"
      ? {
          ok: true,
          value: {
            kind: "retryable",
            evidence: {
              kind: "provider_idempotency_absent",
              integrationAccountId: input.action.action.integrationAccountId,
              idempotencyKey: input.action.idempotencyKey,
              observedAt: input.now,
            },
          },
        }
      : { ok: true, value: { kind: "unresolved" } };
  }
  if (path.kind === "adjust_offer_price" && permit.current.kind === "offer") {
    // Re-sending is safe: the idempotency key is the action's, so Commerce
    // replays the receipt rather than moving the price a second time.
    const adjustment = await applyApprovedOfferPrice({
      env: input.env,
      action: input.action,
      path: path,
      permit: permit,
      fetcher: input.fetcher,
    });
    if (adjustment.kind === "settled") {
      return {
        ok: true,
        value: { kind: "settled", receipt: adjustment.receipt },
      };
    }
    return adjustment.kind === "absent"
      ? {
          ok: true,
          value: {
            kind: "retryable",
            evidence: {
              kind: "provider_idempotency_absent",
              integrationAccountId: input.action.action.integrationAccountId,
              idempotencyKey: input.action.idempotencyKey,
              observedAt: input.now,
            },
          },
        }
      : { ok: true, value: { kind: "unresolved" } };
  }
  if (
    path.kind === "publish_catalog_listing" &&
    permit.current.kind === "offer"
  ) {
    return reconcileCommerceAction({
      env: input.env,
      action: input.action,
      path: path,
      permit: permit,
      now: input.now,
      fetcher: input.fetcher,
    });
  }

  if (
    path.kind === "update_product_description" &&
    permit.current.kind === "product"
  ) {
    return reconcileCommerceProductDescriptionAction({
      env: input.env,
      action: input.action,
      current: permit.current,
      path: path,
      permit: permit,
      now: input.now,
      fetcher: input.fetcher,
    });
  }
  if (
    isCommerceCancellationPath(path) &&
    permit.current.kind === "commerce_order"
  ) {
    return reconcileCommerceCancellation({
      env: input.env,
      action: input.action,
      current: permit.current,
      path: path,
      permit: permit,
      now: input.now,
      fetcher: input.fetcher,
    });
  }
  return commerceProviderUnsupported();
}

async function reconcileCommerceAction(
  input: Readonly<{
    env: Env;
    action: VariantBy<ActionLedgerEntry, "state", "indeterminate">;
    path: Variant<CommerceActionPath, "publish_catalog_listing">;
    permit: Variant<CommerceEffectGatePermit, "commerce">;
    now: number;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<
  Result<CommerceProviderReconciliation, CommerceProviderExecutionError>
> {
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
    // The member who approved the action (Plan 80 step 3).
    actor: String(input.action.approval.principal.personId),
  });
  if (client === null) {
    return { ok: true, value: { kind: "unresolved" } };
  }
  const providerIds = commerceProviderIds(
    input.permit.merchantBinding.merchantId,
    input.path,
  );
  if (providerIds === null) return { ok: true, value: { kind: "unresolved" } };
  const reconciliation = await reconcileCommerceCatalogPublication({
    client,
    organisationId: input.action.action.organisationId,
    merchantId: input.permit.merchantBinding.merchantId,
    idempotencyKey: input.action.idempotencyKey,
    offerId: providerIds.offerId,
  });
  switch (reconciliation.kind) {
    case "committed":
      return {
        ok: true,
        value: {
          kind: "settled",
          receipt: commerceReceipt({
            receipt: reconciliation.receipt,
            actionNonce: input.action.action.nonce.value,
            resourceId: providerIds.path.offerId,
            projectionKind: "offer",
            flowDecision: input.permit.flowDecision,
          }),
        },
      };
    case "absent":
      return {
        ok: true,
        value: {
          kind: "retryable",
          evidence: {
            kind: "provider_idempotency_absent",
            integrationAccountId: input.action.action.integrationAccountId,
            idempotencyKey: input.action.idempotencyKey,
            observedAt: input.now,
          },
        },
      };
    case "indeterminate":
      return { ok: true, value: { kind: "unresolved" } };
  }
}

async function reconcileCommerceProductDescriptionAction(
  input: Readonly<{
    env: Env;
    action: VariantBy<ActionLedgerEntry, "state", "indeterminate">;
    current: Variant<CommerceProjection, "product">;
    path: Variant<CommerceActionPath, "update_product_description">;
    permit: Variant<CommerceEffectGatePermit, "commerce">;
    now: number;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<
  Result<CommerceProviderReconciliation, CommerceProviderExecutionError>
> {
  if (input.current.projection.provenance.resourceId !== input.path.productId) {
    return { ok: true, value: { kind: "unresolved" } };
  }
  const productId = commerceProviderResourceId(
    input.permit.merchantBinding.merchantId,
    input.path.productId,
  );
  if (productId === null) return { ok: true, value: { kind: "unresolved" } };
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
    // The member who approved the action (Plan 80 step 3).
    actor: String(input.action.approval.principal.personId),
  });
  if (client === null) return { ok: true, value: { kind: "unresolved" } };
  const reconciliation = await reconcileCommerceProductDescriptionUpdate({
    client,
    organisationId: input.action.action.organisationId,
    merchantId: input.permit.merchantBinding.merchantId,
    idempotencyKey: input.action.idempotencyKey,
    productId,
  });
  switch (reconciliation.kind) {
    case "committed":
      return {
        ok: true,
        value: {
          kind: "settled",
          receipt: commerceReceipt({
            receipt: reconciliation.receipt,
            actionNonce: input.action.action.nonce.value,
            resourceId: input.path.productId,
            projectionKind: "product",
            flowDecision: input.permit.flowDecision,
          }),
        },
      };
    case "absent":
      return {
        ok: true,
        value: {
          kind: "retryable",
          evidence: {
            kind: "provider_idempotency_absent",
            integrationAccountId: input.action.action.integrationAccountId,
            idempotencyKey: input.action.idempotencyKey,
            observedAt: input.now,
          },
        },
      };
    case "indeterminate":
      return { ok: true, value: { kind: "unresolved" } };
  }
}

type CommerceCancellationPath = Extract<
  CommerceActionPath,
  {
    readonly kind: "cancel_order";
    readonly execution: { readonly kind: "commerce_full_refund" };
  }
>;

function isCommerceCancellationPath(
  path: CommerceActionPath,
): path is CommerceCancellationPath {
  return (
    path.kind === "cancel_order" &&
    path.execution.kind === "commerce_full_refund"
  );
}

async function reconcileCommerceCancellation(
  input: Readonly<{
    env: Env;
    action: VariantBy<ActionLedgerEntry, "state", "indeterminate">;
    current: Variant<CommerceProjection, "commerce_order">;
    path: CommerceCancellationPath;
    permit: Variant<CommerceEffectGatePermit, "commerce">;
    now: number;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<
  Result<CommerceProviderReconciliation, CommerceProviderExecutionError>
> {
  const orderRevision = commerceProjectionRevision(input.current);
  if (orderRevision !== input.path.expectedRevision) {
    return { ok: true, value: { kind: "unresolved" } };
  }
  const providerIds = commerceCancellationProviderIds(
    input.permit.merchantBinding.merchantId,
    input.current,
    input.path,
  );
  if (providerIds === null) return { ok: true, value: { kind: "unresolved" } };
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
    // The member who approved the action (Plan 80 step 3).
    actor: String(input.action.approval.principal.personId),
  });
  if (client === null) return { ok: true, value: { kind: "unresolved" } };
  const refundAttemptId = commerceRefundAttemptId(
    input.action.action.nonce.value,
  );
  const reconciliation = await reconcileCommerceOrderCancellation({
    client,
    organisationId: input.action.action.organisationId,
    merchantId: input.permit.merchantBinding.merchantId,
    idempotencyKey: input.action.idempotencyKey,
    refundAttemptId,
  });
  switch (reconciliation.kind) {
    case "committed":
      if (
        !commerceCancellationReceiptMatches(reconciliation.receipt, {
          merchantId: input.permit.merchantBinding.merchantId,
          idempotencyKey: input.action.idempotencyKey,
          refundAttemptId,
        })
      ) {
        return { ok: true, value: { kind: "unresolved" } };
      }
      return {
        ok: true,
        value: {
          kind: "settled",
          receipt: commerceCancellationReceipt({
            receipt: reconciliation.receipt,
            actionNonce: input.action.action.nonce.value,
            resourceId: providerIds.path.resourceId,
            revision: orderRevision,
            refundAttemptId,
            flowDecision: input.permit.flowDecision,
          }),
        },
      };
    case "absent":
      return {
        ok: true,
        value: {
          kind: "retryable",
          evidence: {
            kind: "provider_idempotency_absent",
            integrationAccountId: input.action.action.integrationAccountId,
            idempotencyKey: input.action.idempotencyKey,
            observedAt: input.now,
          },
        },
      };
    case "indeterminate":
      return { ok: true, value: { kind: "unresolved" } };
  }
}

export async function executeCommerceProviderAction(input: {
  readonly env: Env;
  scope: OrganisationExecutionScope;
  readonly action: ExecutingActionLedgerEntry;
  readonly current: CommerceProjection | null;
  readonly now: number;
  readonly fetcher?: typeof fetch;
}): Promise<Result<CommerceProviderOperation, CommerceProviderExecutionError>> {
  const path = parseCommerceActionPath(input.action.action);
  if (!path.ok) return path;
  if (
    path.value.kind === "publish_cafe_menu" ||
    path.value.kind === "change_menu_price" ||
    path.value.kind === "refund_order" ||
    path.value.kind === "stock_operation"
  ) {
    const shared = {
      env: input.env,
      scope: input.scope,
      action: input.action,
      now: input.now,
      fetcher: input.fetcher,
    };
    const publication =
      path.value.kind === "stock_operation"
        ? await runApprovedStockOperation(
            { ...shared, path: path.value },
            executeStockOperation,
          )
        : path.value.kind === "refund_order"
          ? await refundApprovedOrder({ ...shared, path: path.value })
          : path.value.kind === "change_menu_price"
            ? await changeApprovedMenuPrice({ ...shared, path: path.value })
            : await publishApprovedCafeMenu({ ...shared, path: path.value });
    if (!publication.ok) return publication;
    switch (publication.value.kind) {
      case "settled":
        return {
          ok: true,
          value: {
            kind: "provider_receipt",
            receipt: publication.value.receipt,
          },
        };
      case "indeterminate":
        return {
          ok: false,
          error: { code: "commerce_action_provider_indeterminate" },
        };
      case "absent":
        return {
          ok: false,
          error: { code: "commerce_action_provider_execution_failed" },
        };
    }
  }
  if (path.value.kind === "install_merchant_plugin") {
    const installation = await installApprovedMerchantPlugin({
      env: input.env,
      scope: input.scope,
      action: input.action,
      path: path.value,
      now: input.now,
      fetcher: input.fetcher,
    });
    if (!installation.ok) return installation;
    switch (installation.value.kind) {
      case "settled":
        return {
          ok: true,
          value: {
            kind: "provider_receipt",
            receipt: installation.value.receipt,
          },
        };
      case "indeterminate":
        return {
          ok: false,
          error: { code: "commerce_action_provider_indeterminate" },
        };
      case "absent":
        return {
          ok: false,
          error: { code: "commerce_action_provider_execution_failed" },
        };
    }
  }
  const gate = await authorizeCommerceEffectGatePlan({
    scope: input.scope,
    action: input.action,
    current: input.current,
    now: input.now,
  });
  if (!gate.ok) return gate;
  const currentRevision = commerceProjectionRevision(gate.value.current);
  const expectedRevision = commerceActionExpectedRevision(path.value);
  if (currentRevision !== expectedRevision) {
    return {
      ok: false,
      error: {
        code: "commerce_action_revision_stale",
        expected: expectedRevision,
        actual: currentRevision,
      },
    };
  }
  if (gate.value.kind === "lab") {
    const delivery = await buildCommerceLabDelivery({
      action: input.action.action,
      current: gate.value.current,
      now: input.now,
    });
    return delivery.ok
      ? {
          ok: true,
          value: {
            kind: "projection_delivery",
            delivery: delivery.value.delivery,
            receipt: {
              ...delivery.value.receipt,
              flowBindingDigest: gate.value.flowDecision.flowBindingDigest,
              decisionDigest: gate.value.flowDecision.decisionDigest,
            },
          },
        }
      : delivery;
  }

  const provider = commerceProviderOfPermit(gate.value);
  return provider === null
    ? commerceProviderUnsupported()
    : provider.executeAction({
        env: input.env,
        action: input.action,
        path: path.value,
        permit: gate.value,
        currentRevision,
        now: input.now,
        fetcher: input.fetcher,
      });
}

/** The execution of an action on a record of the built-in engine. */
export async function executeBuiltInCommerceAction(
  input: CommerceProviderExecuteInput,
): Promise<Result<CommerceProviderOperation, CommerceProviderExecutionError>> {
  const { path, permit } = input;
  if (permit.kind !== "commerce") return commerceProviderUnsupported();
  if (
    path.kind === "publish_catalog_listing" &&
    permit.current.kind === "offer"
  ) {
    return executeCommerceEngineAction({
      env: input.env,
      action: input.action,
      path: path,
      permit: permit,
      now: input.now,
      fetcher: input.fetcher,
    });
  }

  if (
    path.kind === "update_product_description" &&
    permit.current.kind === "product"
  ) {
    const update = await applyApprovedProductDescription({
      env: input.env,
      action: input.action,
      current: permit.current,
      path: path,
      permit: permit,
      now: input.now,
      fetcher: input.fetcher,
    });
    if (update.kind === "settled") {
      return {
        ok: true,
        value: { kind: "provider_receipt", receipt: update.receipt },
      };
    }
    return update.kind === "indeterminate"
      ? { ok: false, error: { code: "commerce_action_provider_indeterminate" } }
      : {
          ok: false,
          error: { code: "commerce_action_provider_execution_failed" },
        };
  }

  if (
    isCommerceCancellationPath(path) &&
    permit.current.kind === "commerce_order"
  ) {
    return executeCommerceCancellation({
      env: input.env,
      action: input.action,
      current: permit.current,
      path: path,
      permit: permit,
      fetcher: input.fetcher,
    });
  }

  if (
    path.kind === "attach_tracking" &&
    permit.current.kind === "fulfillment"
  ) {
    const attachment = await attachTrackingThroughCommerce({
      env: input.env,
      action: input.action,
      path: path,
      permit: permit,
      fetcher: input.fetcher,
    });
    if (attachment.kind === "settled") {
      return {
        ok: true,
        value: { kind: "provider_receipt", receipt: attachment.receipt },
      };
    }
    return attachment.kind === "indeterminate"
      ? { ok: false, error: { code: "commerce_action_provider_indeterminate" } }
      : {
          ok: false,
          error: { code: "commerce_action_provider_execution_failed" },
        };
  }

  if (path.kind === "adjust_offer_price" && permit.current.kind === "offer") {
    const adjustment = await applyApprovedOfferPrice({
      env: input.env,
      action: input.action,
      path: path,
      permit: permit,
      fetcher: input.fetcher,
    });
    if (adjustment.kind === "settled") {
      return {
        ok: true,
        value: { kind: "provider_receipt", receipt: adjustment.receipt },
      };
    }
    return adjustment.kind === "indeterminate"
      ? { ok: false, error: { code: "commerce_action_provider_indeterminate" } }
      : {
          ok: false,
          error: { code: "commerce_action_provider_execution_failed" },
        };
  }

  return commerceProviderUnsupported();
}

function authorityRebaseRequired(
  expectedRevision: number,
  actualRevision: number,
): Result<never, CommerceProviderExecutionError> {
  return {
    ok: false,
    error: {
      code: "commerce_action_authority_rebase_required",
      expectedRevision,
      actualRevision,
    },
  };
}

async function executeCommerceEngineAction(
  input: Readonly<{
    env: Env;
    action: ExecutingActionLedgerEntry;
    path: Variant<CommerceActionPath, "publish_catalog_listing">;
    permit: Variant<CommerceEffectGatePermit, "commerce">;
    now: number;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<Result<CommerceProviderOperation, CommerceProviderExecutionError>> {
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
    // The member who approved the action (Plan 80 step 3).
    actor: String(input.action.approval.principal.personId),
  });
  if (client === null) {
    return {
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    };
  }
  const providerIds = commerceProviderIds(
    input.permit.merchantBinding.merchantId,
    input.path,
  );
  if (providerIds === null) {
    return {
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    };
  }
  const publication = await publishCatalogListingThroughCommerce({
    client,
    command: {
      merchantId: input.permit.merchantBinding.merchantId,
      idempotencyKey: input.action.idempotencyKey,
      productId: providerIds.productId,
      productRevision: providerIds.path.productRevision,
      variantId: providerIds.variantId,
      variantRevision: providerIds.path.variantRevision,
      offerId: providerIds.offerId,
      offerRevision: providerIds.path.offerRevision,
      salesChannelId: providerIds.salesChannelId,
      salesChannelRevision: providerIds.path.salesChannelRevision,
    },
  });
  if (publication.status === "unavailable") {
    return {
      ok: false,
      error: { code: "commerce_action_provider_indeterminate" },
    };
  }
  if (publication.status === "rejected") {
    return {
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    };
  }
  return {
    ok: true,
    value: {
      kind: "provider_receipt",
      receipt: commerceReceipt({
        receipt: publication.receipt,
        actionNonce: input.action.action.nonce.value,
        resourceId: providerIds.path.offerId,
        projectionKind: "offer",
        flowDecision: input.permit.flowDecision,
      }),
    },
  };
}

async function executeCommerceCancellation(
  input: Readonly<{
    env: Env;
    action: ExecutingActionLedgerEntry;
    current: Variant<CommerceProjection, "commerce_order">;
    path: CommerceCancellationPath;
    permit: Variant<CommerceEffectGatePermit, "commerce">;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<Result<CommerceProviderOperation, CommerceProviderExecutionError>> {
  const orderRevision = commerceProjectionRevision(input.current);
  if (orderRevision !== input.path.expectedRevision) {
    return {
      ok: false,
      error: {
        code: "commerce_action_revision_stale",
        expected: input.path.expectedRevision,
        actual: orderRevision,
      },
    };
  }
  const providerIds = commerceCancellationProviderIds(
    input.permit.merchantBinding.merchantId,
    input.current,
    input.path,
  );
  if (providerIds === null) {
    return {
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    };
  }
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
    // The member who approved the action (Plan 80 step 3).
    actor: String(input.action.approval.principal.personId),
  });
  if (client === null) {
    return {
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    };
  }
  const refundAttemptId = commerceRefundAttemptId(
    input.action.action.nonce.value,
  );
  const cancellation = await cancelOrderThroughCommerce({
    client,
    command: {
      merchantId: input.permit.merchantBinding.merchantId,
      expectedMerchantRevision: input.path.execution.merchantRevision,
      idempotencyKey: input.action.idempotencyKey,
      orderId: providerIds.orderId,
      orderRevision,
      paymentId: providerIds.paymentId,
      paymentRevision: input.path.execution.paymentRevision,
      fulfillmentId: providerIds.fulfillmentId,
      fulfillmentRevision: input.path.execution.fulfillmentRevision,
      refundAttemptId,
      reason: input.path.reason,
    },
  });
  switch (cancellation.status) {
    case "unavailable":
      return {
        ok: false,
        error: { code: "commerce_action_provider_indeterminate" },
      };
    case "rejected":
      return {
        ok: false,
        error: {
          code: preparationEnded(cancellation.error)
            ? "commerce_action_order_has_prepared_lines"
            : "commerce_action_provider_execution_failed",
        },
      };
    case "applied":
    case "replayed":
      if (
        !commerceCancellationReceiptMatches(cancellation.receipt, {
          merchantId: input.permit.merchantBinding.merchantId,
          idempotencyKey: input.action.idempotencyKey,
          refundAttemptId,
        })
      ) {
        return {
          ok: false,
          error: { code: "commerce_action_provider_execution_failed" },
        };
      }
      return {
        ok: true,
        value: {
          kind: "provider_receipt",
          receipt: commerceCancellationReceipt({
            receipt: cancellation.receipt,
            actionNonce: input.action.action.nonce.value,
            resourceId: providerIds.path.resourceId,
            revision: orderRevision,
            refundAttemptId,
            flowDecision: input.permit.flowDecision,
          }),
        },
      };
  }
}

/**
 * Commerce cancels a made-to-order order until its preparation ends. A
 * ticket that staff completed refuses the cancellation: its stock was used.
 */
function preparationEnded(error: CommerceMutationErrorV1): boolean {
  return (
    error.code === "invalid_transition" &&
    error.machine === "preparation_ticket" &&
    error.event === "cancel"
  );
}

function commerceCancellationProviderIds(
  merchantId: string,
  current: Variant<CommerceProjection, "commerce_order">,
  path: CommerceCancellationPath,
): Readonly<{
  readonly path: CommerceCancellationPath;
  readonly orderId: string;
  readonly paymentId: string;
  readonly fulfillmentId: string;
}> | null {
  if (
    current.projection.provenance.resourceType !== "commerce_order" ||
    current.projection.provenance.resourceId !== path.resourceId
  ) {
    return null;
  }
  const orderId = commerceProviderResourceId(merchantId, path.resourceId);
  const paymentId = path.execution.paymentId;
  const fulfillmentId = path.execution.fulfillmentId;
  if (
    orderId === null ||
    paymentId.length === 0 ||
    fulfillmentId.length === 0
  ) {
    return null;
  }
  return { path, orderId, paymentId, fulfillmentId };
}

function commerceRefundAttemptId(actionNonce: string): string {
  return `refund_attempt_${actionNonce}`;
}

function commerceCancellationReceiptMatches(
  receipt: {
    readonly merchantId: string;
    readonly idempotencyKey: string;
    readonly commandKind: string;
    readonly resource: {
      readonly kind: string;
      readonly id: string;
      readonly revision: number;
    };
  },
  expected: Readonly<{
    readonly merchantId: string;
    readonly idempotencyKey: string;
    readonly refundAttemptId: string;
  }>,
): boolean {
  return (
    receipt.merchantId === expected.merchantId &&
    receipt.idempotencyKey === expected.idempotencyKey &&
    receipt.commandKind === "cancel_order" &&
    receipt.resource.kind === "refund_attempt" &&
    receipt.resource.id === expected.refundAttemptId
  );
}

function commerceProviderIds(
  merchantId: string,
  path: Variant<CommerceActionPath, "publish_catalog_listing">,
): Readonly<{
  readonly path: Variant<CommerceActionPath, "publish_catalog_listing">;
  readonly productId: string;
  readonly variantId: string;
  readonly offerId: string;
  readonly salesChannelId: string;
}> | null {
  const productId = commerceProviderResourceId(merchantId, path.productId);
  const variantId = commerceProviderResourceId(merchantId, path.variantId);
  const offerId = commerceProviderResourceId(merchantId, path.offerId);
  const salesChannelId = commerceProviderResourceId(
    merchantId,
    path.salesChannelId,
  );
  if (
    productId === null ||
    variantId === null ||
    offerId === null ||
    salesChannelId === null
  )
    return null;
  return { path, productId, variantId, offerId, salesChannelId };
}

type CommerceTrackingAttachmentResult =
  | Readonly<{ kind: "settled"; receipt: CommerceEngineProviderReceipt }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "indeterminate" }>;

async function attachTrackingThroughCommerce(
  input: Readonly<{
    env: Env;
    action: ApprovedCommerceActionEntry;
    path: Variant<CommerceActionPath, "attach_tracking">;
    permit: Variant<CommerceEffectGatePermit, "commerce">;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<CommerceTrackingAttachmentResult> {
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
    // The member who approved the action (Plan 80 step 3).
    actor: String(input.action.approval.principal.personId),
  });
  if (client === null) return { kind: "indeterminate" };
  const orderId = commerceProviderResourceId(
    input.permit.merchantBinding.merchantId,
    input.path.orderId,
  );
  const fulfillmentId = commerceProviderResourceId(
    input.permit.merchantBinding.merchantId,
    input.path.fulfillmentId,
  );
  const shipmentId = commerceProviderResourceId(
    input.permit.merchantBinding.merchantId,
    input.path.shipmentId,
  );
  if (orderId === null || fulfillmentId === null || shipmentId === null)
    return { kind: "absent" };
  const attachment = await client.attachFulfillmentTracking({
    merchantId: input.permit.merchantBinding.merchantId,
    expectedMerchantRevision: input.path.merchantRevision,
    idempotencyKey: input.action.idempotencyKey,
    orderId,
    fulfillmentId,
    fulfillmentRevision: input.path.fulfillmentRevision,
    shipmentId,
    shipmentRevision: input.path.shipmentRevision,
    trackingNumber: input.path.trackingNumber,
  });
  if (!attachment.ok) {
    return attachment.error.kind === "rejected"
      ? { kind: "absent" }
      : { kind: "indeterminate" };
  }
  if (attachment.value.outcome === "rejected") return { kind: "absent" };
  return {
    kind: "settled",
    receipt: commerceReceipt({
      receipt: attachment.value.receipt,
      actionNonce: input.action.action.nonce.value,
      resourceId: input.path.fulfillmentId,
      projectionKind: "fulfillment",
      flowDecision: input.permit.flowDecision,
    }),
  };
}

/**
 * Applies one approved Offer price change through Commerce.
 *
 * The approval carries both revisions it was built against. Commerce
 * re-checks them, the allowance, and the listing state at execution, so an
 * approval that has gone stale is refused there rather than applied here.
 */
async function applyApprovedOfferPrice(
  input: Readonly<{
    env: Env;
    action: ApprovedCommerceActionEntry;
    path: Variant<CommerceActionPath, "adjust_offer_price">;
    permit: Variant<CommerceEffectGatePermit, "commerce">;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<CommerceTrackingAttachmentResult> {
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
    // The member who approved the action (Plan 80 step 3).
    actor: String(input.action.approval.principal.personId),
  });
  if (client === null) return { kind: "indeterminate" };
  const offerId = commerceProviderResourceId(
    input.permit.merchantBinding.merchantId,
    input.path.offerId,
  );
  if (offerId === null) return { kind: "absent" };
  const adjustment = await adjustOfferPriceThroughCommerce({
    client,
    command: {
      merchantId: input.permit.merchantBinding.merchantId,
      idempotencyKey: input.action.idempotencyKey,
      offerId,
      expectedOfferRevision: input.path.expectedOfferRevision,
      expectedPolicyRevision: input.path.expectedPolicyRevision,
      proposedPriceMinor: input.path.proposedPriceMinor,
      currency: input.path.currency,
    },
  });
  if (adjustment.status === "unavailable") return { kind: "indeterminate" };
  if (adjustment.status === "rejected") return { kind: "absent" };
  return {
    kind: "settled",
    receipt: commerceReceipt({
      receipt: adjustment.receipt,
      actionNonce: input.action.action.nonce.value,
      resourceId: input.path.offerId,
      projectionKind: "offer",
      flowDecision: input.permit.flowDecision,
    }),
  };
}

/** What the approval card shows of a plugin's run over recent checkouts. */
type MerchantPluginActionPreview =
  | Readonly<{ kind: "no_checkout_function" }>
  | Readonly<{
      kind: "previewed";
      checkouts: number;
      refusals: readonly Readonly<{ message: string; checkouts: number }>[];
      failures: readonly Readonly<{ reason: string; checkouts: number }>[];
    }>;

/**
 * Runs a proposed plugin's checkout functions over the merchant's recent
 * checkouts as they stand now. It changes nothing, and it reads the
 * definition from the action path, so it previews exactly what an approval
 * signs. Refusals and failures are grouped by message, without checkout ids.
 */
export async function previewMerchantPluginAction(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    action: ActionLedgerEntry;
    fetcher?: typeof fetch;
  }>,
): Promise<
  Result<MerchantPluginActionPreview, CommerceProviderExecutionError>
> {
  const path = parseCommerceActionPath(input.action.action);
  if (!path.ok) return path;
  if (path.value.kind !== "install_merchant_plugin")
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  if (path.value.functionSource === null)
    return { ok: true, value: { kind: "no_checkout_function" } };
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.scope.database,
    organisationId: input.action.action.organisationId,
    integrationAccountId: input.action.action.integrationAccountId,
  });
  const client = merchantBinding.ok
    ? createCommerceClient(input.env, input.fetcher, {
        kind: "organisation",
        organisationId: String(input.action.action.organisationId),
      })
    : null;
  if (!merchantBinding.ok || client === null)
    return {
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    };
  const preview = await client.previewMerchantPlugin(
    merchantBinding.value.merchantId,
    {
      schemaVersion: "commerce.preview-merchant-plugin.v1",
      ...merchantPluginInstallation(path.value),
    },
  );
  if (!preview.ok)
    return {
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    };
  return {
    ok: true,
    value: {
      kind: "previewed",
      checkouts: preview.value.checkouts,
      refusals: countedBy(
        preview.value.refused.flatMap((refusal) =>
          [...new Set(refusal.messages)].map((message) => ({
            key: message,
            checkoutId: refusal.checkoutId,
          })),
        ),
      ).map(([message, checkouts]) => ({ message, checkouts })),
      failures: countedBy(
        preview.value.failed.map((failure) => ({
          key: failure.reason,
          checkoutId: failure.checkoutId,
        })),
      ).map(([reason, checkouts]) => ({ reason, checkouts })),
    },
  };
}

/** Each key with the number of different checkouts that have it, in order. */
function countedBy(
  items: readonly Readonly<{ key: string; checkoutId: string }>[],
): [string, number][] {
  const checkouts = new Map<string, Set<string>>();
  for (const item of items)
    checkouts.set(
      item.key,
      (checkouts.get(item.key) ?? new Set()).add(item.checkoutId),
    );
  return [...checkouts].map(([key, ids]) => [key, ids.size]);
}

async function installApprovedMerchantPlugin(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    action: ApprovedCommerceActionEntry;
    path: Variant<CommerceActionPath, "install_merchant_plugin">;
    now: number;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<
  Result<CommerceTrackingAttachmentResult, CommerceProviderExecutionError>
> {
  const authority = await validateCommerceActionAuthorityBeforeExecution({
    scope: input.scope,
    action: input.action.action,
    current: null,
    now: input.now,
  });
  if (!authority.ok) return authority;
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.scope.database,
    organisationId: input.action.action.organisationId,
    integrationAccountId: input.action.action.integrationAccountId,
  });
  if (!merchantBinding.ok) {
    return {
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    };
  }
  const flowDecision = await authorizeCommerceEffectSink(
    input.scope.database,
    input.scope.accountAccess,
    input.action.action,
  );
  if (!flowDecision.ok) return flowDecision;
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
    // The member who approved the action (Plan 80 step 3).
    actor: String(input.action.approval.principal.personId),
  });
  if (client === null) return { ok: true, value: { kind: "indeterminate" } };
  const installation = merchantPluginInstallation(input.path);
  const installed = await installMerchantPluginThroughCommerce({
    client,
    command: {
      merchantId: merchantBinding.value.merchantId,
      idempotencyKey: input.action.idempotencyKey,
      definition: installation.definition,
      settings: installation.settings,
      ...merchantPluginParts(input.path),
      expectedRevision: input.path.expectedRevision,
    },
  });
  if (installed.status === "unavailable")
    return { ok: true, value: { kind: "indeterminate" } };
  if (installed.status === "rejected")
    return { ok: true, value: { kind: "absent" } };
  return {
    ok: true,
    value: {
      kind: "settled",
      receipt: commerceReceipt({
        receipt: installed.receipt,
        actionNonce: input.action.action.nonce.value,
        resourceId: input.path.pluginId,
        projectionKind: "merchant_plugin",
        flowDecision: flowDecision.value,
      }),
    },
  };
}

/**
 * Publishes the menu that the approval signed. Commerce checks the menu
 * revision and each offer and plan revision at commit, so a menu that the
 * shop changed since the proposal is refused there.
 */
async function publishApprovedCafeMenu(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    action: ApprovedCommerceActionEntry;
    path: Variant<CommerceActionPath, "publish_cafe_menu">;
    now: number;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<
  Result<CommerceTrackingAttachmentResult, CommerceProviderExecutionError>
> {
  const authority = await validateCommerceActionAuthorityBeforeExecution({
    scope: input.scope,
    action: input.action.action,
    current: null,
    now: input.now,
  });
  if (!authority.ok) return authority;
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.scope.database,
    organisationId: input.action.action.organisationId,
    integrationAccountId: input.action.action.integrationAccountId,
  });
  if (!merchantBinding.ok) {
    return {
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    };
  }
  const flowDecision = await authorizeCommerceEffectSink(
    input.scope.database,
    input.scope.accountAccess,
    input.action.action,
  );
  if (!flowDecision.ok) return flowDecision;
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
    // The member who approved the action (Plan 80 step 3).
    actor: String(input.action.approval.principal.personId),
  });
  if (client === null) return { ok: true, value: { kind: "indeterminate" } };
  const merchantId = merchantBinding.value.merchantId;
  const stock = await client.readStockSnapshot(merchantId);
  if (!stock.ok) return { ok: true, value: { kind: "indeterminate" } };
  const published = await client.publishMenu({
    merchantId,
    expectedMerchantRevision: stock.value.commerce.merchantRevision,
    idempotencyKey: input.action.idempotencyKey,
    menu: input.path.menu,
    ...(input.path.expectedMenuRevision === null
      ? {}
      : { expectedMenuRevision: input.path.expectedMenuRevision }),
  });
  if (!published.ok) return { ok: true, value: { kind: "indeterminate" } };
  if (published.value.outcome === "rejected")
    return { ok: true, value: { kind: "absent" } };
  await signalCafeMenuScreens(input.env, input.action);
  return {
    ok: true,
    value: {
      kind: "settled",
      receipt: commerceReceipt({
        receipt: published.value.receipt,
        actionNonce: input.action.action.nonce.value,
        resourceId: input.path.menu.menuId,
        projectionKind: "cafe_menu",
        flowDecision: flowDecision.value,
      }),
    },
  };
}

/**
 * Sets the price, and the "was" price of a deal, that the approval signed
 * (Plan 40B phase 4). Commerce checks the offer revision at commit, so a
 * price that changed since the proposal is refused there and stays.
 */
async function changeApprovedMenuPrice(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    action: ApprovedCommerceActionEntry;
    path: Variant<CommerceActionPath, "change_menu_price">;
    now: number;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<
  Result<CommerceTrackingAttachmentResult, CommerceProviderExecutionError>
> {
  const authority = await validateCommerceActionAuthorityBeforeExecution({
    scope: input.scope,
    action: input.action.action,
    current: null,
    now: input.now,
  });
  if (!authority.ok) return authority;
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.scope.database,
    organisationId: input.action.action.organisationId,
    integrationAccountId: input.action.action.integrationAccountId,
  });
  if (!merchantBinding.ok) {
    return {
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    };
  }
  const flowDecision = await authorizeCommerceEffectSink(
    input.scope.database,
    input.scope.accountAccess,
    input.action.action,
  );
  if (!flowDecision.ok) return flowDecision;
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
    // The member who approved the action (Plan 80 step 3).
    actor: String(input.action.approval.principal.personId),
  });
  if (client === null) return { ok: true, value: { kind: "indeterminate" } };
  const updated = await client.updateOffer({
    merchantId: merchantBinding.value.merchantId,
    idempotencyKey: input.action.idempotencyKey,
    offerId: input.path.offerId,
    expectedOfferRevision: input.path.expectedOfferRevision,
    changes: {
      price: input.path.after.price,
      compareAtPrice: input.path.after.compareAtPrice,
    },
  });
  if (!updated.ok) return { ok: true, value: { kind: "indeterminate" } };
  if (updated.value.outcome === "rejected")
    return { ok: true, value: { kind: "absent" } };
  await signalCafeMenuScreens(input.env, input.action);
  return {
    ok: true,
    value: {
      kind: "settled",
      receipt: commerceReceipt({
        receipt: updated.value.receipt,
        actionNonce: input.action.action.nonce.value,
        resourceId: input.path.offerId,
        projectionKind: "offer",
        flowDecision: flowDecision.value,
      }),
    },
  };
}

async function reconcileApprovedMenuPrice(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    action: ApprovedCommerceActionEntry;
    path: Variant<CommerceActionPath, "change_menu_price">;
    now: number;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<
  Result<CommerceTrackingAttachmentResult, CommerceProviderExecutionError>
> {
  const authority = await validateCommerceActionAuthorityBeforeExecution({
    scope: input.scope,
    action: input.action.action,
    current: null,
    now: input.now,
  });
  if (!authority.ok) return authority;
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.scope.database,
    organisationId: input.action.action.organisationId,
    integrationAccountId: input.action.action.integrationAccountId,
  });
  if (!merchantBinding.ok)
    return { ok: true, value: { kind: "indeterminate" } };
  const flowDecision = await authorizeCommerceEffectSink(
    input.scope.database,
    input.scope.accountAccess,
    input.action.action,
  );
  if (!flowDecision.ok) return flowDecision;
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
  });
  if (client === null) return { ok: true, value: { kind: "indeterminate" } };
  const reconciliation = await reconcileCommerceOfferUpdate({
    client,
    merchantId: merchantBinding.value.merchantId,
    idempotencyKey: input.action.idempotencyKey,
    offerId: input.path.offerId,
  });
  if (reconciliation.kind !== "committed")
    return { ok: true, value: reconciliation };
  await signalCafeMenuScreens(input.env, input.action);
  return {
    ok: true,
    value: {
      kind: "settled",
      receipt: commerceReceipt({
        receipt: reconciliation.receipt,
        actionNonce: input.action.action.nonce.value,
        resourceId: input.path.offerId,
        projectionKind: "offer",
        flowDecision: flowDecision.value,
      }),
    },
  };
}

/**
 * Refunds exactly what the approval signed. The merchant and payment revisions
 * are current ones; the order revision is the proposal's, so an order that
 * changed since the proposal is refused.
 */
async function refundApprovedOrder(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    action: ApprovedCommerceActionEntry;
    path: Variant<CommerceActionPath, "refund_order">;
    now: number;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<
  Result<CommerceTrackingAttachmentResult, CommerceProviderExecutionError>
> {
  const authority = await validateCommerceActionAuthorityBeforeExecution({
    scope: input.scope,
    action: input.action.action,
    current: null,
    now: input.now,
  });
  if (!authority.ok) return authority;
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.scope.database,
    organisationId: input.action.action.organisationId,
    integrationAccountId: input.action.action.integrationAccountId,
  });
  if (!merchantBinding.ok) {
    return {
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    };
  }
  const flowDecision = await authorizeCommerceEffectSink(
    input.scope.database,
    input.scope.accountAccess,
    input.action.action,
  );
  if (!flowDecision.ok) return flowDecision;
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
    // The member who approved the action (Plan 80 step 3).
    actor: String(input.action.approval.principal.personId),
  });
  if (client === null) return { ok: true, value: { kind: "indeterminate" } };
  const merchantId = merchantBinding.value.merchantId;
  const snapshot = await client.readSnapshot(merchantId);
  if (!snapshot.ok) return { ok: true, value: { kind: "indeterminate" } };
  const payment = snapshot.value.resources.payments.find(
    (candidate) => candidate.id === input.path.paymentId,
  );
  if (payment === undefined) return { ok: true, value: { kind: "absent" } };
  const refunded = await client.refundOrder({
    merchantId,
    expectedMerchantRevision: snapshot.value.merchantRevision,
    idempotencyKey: input.action.idempotencyKey,
    orderId: input.path.providerOrderId,
    orderRevision: input.path.expectedOrderRevision,
    paymentId: payment.id,
    paymentRevision: payment.revision,
    refundAttemptId: commerceRefundAttemptId(input.action.action.nonce.value),
    refundPolicyId: input.path.refundPolicyId,
    amount: {
      amountMinor: input.path.amountMinor,
      currency: input.path.currency,
    },
    allocation: orderRefundAllocation(input.path),
    reason: input.path.reason,
  });
  if (!refunded.ok)
    return refunded.error.kind === "rejected"
      ? { ok: true, value: { kind: "absent" } }
      : { ok: true, value: { kind: "indeterminate" } };
  if (refunded.value.outcome === "rejected")
    return { ok: true, value: { kind: "absent" } };
  return {
    ok: true,
    value: {
      kind: "settled",
      receipt: commerceReceipt({
        receipt: refunded.value.receipt,
        actionNonce: input.action.action.nonce.value,
        resourceId: input.path.orderId,
        projectionKind: "order_refund",
        flowDecision: flowDecision.value,
      }),
    },
  };
}

/**
 * Runs or reconciles the stock change that the approval signed, under the
 * member who approved it, and refreshes the Portal's stock records after it.
 */
async function runApprovedStockOperation(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    action: ApprovedCommerceActionEntry;
    path: Variant<CommerceActionPath, "stock_operation">;
    now: number;
    fetcher: typeof fetch | undefined;
  }>,
  run: typeof executeStockOperation,
): Promise<
  Result<CommerceTrackingAttachmentResult, CommerceProviderExecutionError>
> {
  const authority = await validateCommerceActionAuthorityBeforeExecution({
    scope: input.scope,
    action: input.action.action,
    current: null,
    now: input.now,
  });
  if (!authority.ok) return authority;
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.scope.database,
    organisationId: input.action.action.organisationId,
    integrationAccountId: input.action.action.integrationAccountId,
  });
  if (!merchantBinding.ok)
    return { ok: true, value: { kind: "indeterminate" } };
  const flowDecision = await authorizeCommerceEffectSink(
    input.scope.database,
    input.scope.accountAccess,
    input.action.action,
  );
  if (!flowDecision.ok) return flowDecision;
  const organisationId = String(input.action.action.organisationId);
  const actor = String(input.action.approval.principal.personId);
  const caller = { kind: "organisation", organisationId, actor } as const;
  const admin = createCommerceClient(input.env, input.fetcher, caller);
  const plane = createCommerceEntityPlaneClient(
    input.env,
    input.fetcher,
    caller,
  );
  if (admin === null || plane === null)
    return { ok: true, value: { kind: "indeterminate" } };
  const result: StockExecution = await run({
    admin,
    plane,
    organisationId,
    merchantId: merchantBinding.value.merchantId,
    actor,
    idempotencyKey: input.action.idempotencyKey,
    nonce: input.action.action.nonce.value,
    action: input.path,
    now: input.now,
  });
  if (result.kind !== "settled") return { ok: true, value: result };
  await refreshStockRecords(input);
  return {
    ok: true,
    value: {
      kind: "settled",
      receipt: commerceReceipt({
        receipt: result.receipt,
        actionNonce: input.action.action.nonce.value,
        resourceId: stockOperationResourceId(input.path.operation),
        projectionKind: "stock_operation",
        flowDecision: flowDecision.value,
      }),
    },
  };
}

async function refreshStockRecords(
  input: Readonly<{ env: Env; action: ApprovedCommerceActionEntry }>,
): Promise<void> {
  const message = createCommerceOutboxReconcileQueueMessage({
    requestId: newRequestId(),
    receivedAt: Date.now(),
    organisationId: input.action.action.organisationId,
    integrationAccountId: input.action.action.integrationAccountId,
  });
  try {
    await input.env.EVENT_Q.send(message, { contentType: "json" });
  } catch {
    // Scheduled recovery drains the native outbox independently of this call.
    traceWarn("stock_action.projection_refresh_pending", {
      requestId: message.requestId,
    });
  }
}

async function reconcileApprovedOrderRefund(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    action: ApprovedCommerceActionEntry;
    path: Variant<CommerceActionPath, "refund_order">;
    now: number;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<
  Result<CommerceTrackingAttachmentResult, CommerceProviderExecutionError>
> {
  const authority = await validateCommerceActionAuthorityBeforeExecution({
    scope: input.scope,
    action: input.action.action,
    current: null,
    now: input.now,
  });
  if (!authority.ok) return authority;
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.scope.database,
    organisationId: input.action.action.organisationId,
    integrationAccountId: input.action.action.integrationAccountId,
  });
  if (!merchantBinding.ok)
    return { ok: true, value: { kind: "indeterminate" } };
  const flowDecision = await authorizeCommerceEffectSink(
    input.scope.database,
    input.scope.accountAccess,
    input.action.action,
  );
  if (!flowDecision.ok) return flowDecision;
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
    actor: String(input.action.approval.principal.personId),
  });
  if (client === null) return { ok: true, value: { kind: "indeterminate" } };
  const reconciliation = await reconcileCommerceOrderRefund({
    client,
    merchantId: merchantBinding.value.merchantId,
    idempotencyKey: input.action.idempotencyKey,
    refundAttemptId: commerceRefundAttemptId(input.action.action.nonce.value),
  });
  switch (reconciliation.kind) {
    case "committed":
      return {
        ok: true,
        value: {
          kind: "settled",
          receipt: commerceReceipt({
            receipt: reconciliation.receipt,
            actionNonce: input.action.action.nonce.value,
            resourceId: input.path.orderId,
            projectionKind: "order_refund",
            flowDecision: flowDecision.value,
          }),
        },
      };
    case "absent":
      return { ok: true, value: { kind: "absent" } };
    case "indeterminate":
      return { ok: true, value: { kind: "indeterminate" } };
  }
}

async function reconcileApprovedCafeMenu(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    action: ApprovedCommerceActionEntry;
    path: Variant<CommerceActionPath, "publish_cafe_menu">;
    now: number;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<
  Result<CommerceTrackingAttachmentResult, CommerceProviderExecutionError>
> {
  const authority = await validateCommerceActionAuthorityBeforeExecution({
    scope: input.scope,
    action: input.action.action,
    current: null,
    now: input.now,
  });
  if (!authority.ok) return authority;
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.scope.database,
    organisationId: input.action.action.organisationId,
    integrationAccountId: input.action.action.integrationAccountId,
  });
  if (!merchantBinding.ok)
    return { ok: true, value: { kind: "indeterminate" } };
  const flowDecision = await authorizeCommerceEffectSink(
    input.scope.database,
    input.scope.accountAccess,
    input.action.action,
  );
  if (!flowDecision.ok) return flowDecision;
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
  });
  if (client === null) return { ok: true, value: { kind: "indeterminate" } };
  const reconciliation = await reconcileCommerceCafeMenuPublication({
    client,
    merchantId: merchantBinding.value.merchantId,
    idempotencyKey: input.action.idempotencyKey,
    menuId: input.path.menu.menuId,
  });
  if (reconciliation.kind !== "committed")
    return { ok: true, value: reconciliation };
  await signalCafeMenuScreens(input.env, input.action);
  return {
    ok: true,
    value: {
      kind: "settled",
      receipt: commerceReceipt({
        receipt: reconciliation.receipt,
        actionNonce: input.action.action.nonce.value,
        resourceId: input.path.menu.menuId,
        projectionKind: "cafe_menu",
        flowDecision: flowDecision.value,
      }),
    },
  };
}

/** A lost signal costs the screens a later read, never the publication. */
async function signalCafeMenuScreens(
  env: Env,
  action: ApprovedCommerceActionEntry,
): Promise<void> {
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: action.action.organisationId,
      now: Date.now(),
    });
    await organisation.signalMenuScreens({
      organisationId: action.action.organisationId,
    });
  } catch {
    return;
  }
}

async function applyApprovedProductDescription(
  input: Readonly<{
    env: Env;
    action: ApprovedCommerceActionEntry;
    current: Variant<CommerceProjection, "product">;
    path: Variant<CommerceActionPath, "update_product_description">;
    permit: Variant<CommerceEffectGatePermit, "commerce">;
    now: number;
    fetcher: typeof fetch | undefined;
  }>,
): Promise<CommerceTrackingAttachmentResult> {
  if (input.current.projection.provenance.resourceId !== input.path.productId) {
    return { kind: "absent" };
  }
  const merchantId = input.permit.merchantBinding.merchantId;
  const productId = commerceProviderResourceId(
    merchantId,
    input.path.productId,
  );
  if (productId === null) return { kind: "absent" };
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.action.action.organisationId),
    // The member who approved the action (Plan 80 step 3).
    actor: String(input.action.approval.principal.personId),
  });
  if (client === null) return { kind: "indeterminate" };
  const snapshot = await client.readSnapshot(merchantId);
  if (
    !snapshot.ok ||
    snapshot.value.merchantId !== merchantId ||
    !Number.isSafeInteger(snapshot.value.merchantRevision) ||
    snapshot.value.merchantRevision < 1
  ) {
    return { kind: "indeterminate" };
  }
  const update = await updateProductDescriptionThroughCommerce({
    client,
    command: {
      merchantId,
      expectedMerchantRevision: snapshot.value.merchantRevision,
      productId,
      expectedProductRevision: input.path.productRevision,
      description: input.path.description,
      idempotencyKey: input.action.idempotencyKey,
    },
  });
  if (update.status === "unavailable") return { kind: "indeterminate" };
  if (update.status === "rejected") return { kind: "absent" };
  return {
    kind: "settled",
    receipt: commerceReceipt({
      receipt: update.receipt,
      actionNonce: input.action.action.nonce.value,
      resourceId: input.path.productId,
      projectionKind: "product",
      flowDecision: input.permit.flowDecision,
    }),
  };
}

function commerceReceipt(
  input: Readonly<{
    receipt: {
      readonly receiptId: string;
      readonly effectId: string;
      readonly deliveryId: string;
      readonly resource: { readonly revision: number };
      readonly merchantId: string;
      readonly merchantRevision: number;
      readonly committedAt: string;
    };
    actionNonce: string;
    resourceId: string;
    projectionKind:
      | "offer"
      | "fulfillment"
      | "product"
      | "merchant_plugin"
      | "cafe_menu"
      | "order_refund"
      | "stock_operation";
    flowDecision: Variant<FlowDecision, "allow">;
  }>,
): VariantBy<
  CommerceEngineProviderReceipt,
  "projectionKind",
  | "offer"
  | "fulfillment"
  | "product"
  | "merchant_plugin"
  | "cafe_menu"
  | "order_refund"
  | "stock_operation"
> {
  return {
    kind: "commerce_provider_receipt",
    provider: "commerce",
    receiptId: input.receipt.receiptId,
    effectId: input.receipt.effectId,
    actionNonce: input.actionNonce,
    flowBindingDigest: input.flowDecision.flowBindingDigest,
    decisionDigest: input.flowDecision.decisionDigest,
    eventId: input.receipt.deliveryId,
    resourceId: input.resourceId,
    projectionKind: input.projectionKind,
    revision: input.receipt.resource.revision,
    status: "accepted",
    merchantId: input.receipt.merchantId,
    merchantRevision: input.receipt.merchantRevision,
    observedAt: input.receipt.committedAt,
  };
}

function commerceCancellationReceipt(
  input: Readonly<{
    receipt: {
      readonly receiptId: string;
      readonly effectId: string;
      readonly deliveryId: string;
      readonly resource: {
        readonly kind: string;
        readonly id: string;
        readonly revision: number;
      };
      readonly merchantId: string;
      readonly merchantRevision: number;
      readonly committedAt: string;
    };
    actionNonce: string;
    resourceId: string;
    revision: number;
    refundAttemptId: string;
    flowDecision: Variant<FlowDecision, "allow">;
  }>,
): VariantBy<
  CommerceEngineProviderReceipt,
  "projectionKind",
  "commerce_order"
> {
  return {
    kind: "commerce_provider_receipt",
    provider: "commerce",
    receiptId: input.receipt.receiptId,
    effectId: input.receipt.effectId,
    actionNonce: input.actionNonce,
    flowBindingDigest: input.flowDecision.flowBindingDigest,
    decisionDigest: input.flowDecision.decisionDigest,
    eventId: input.receipt.deliveryId,
    resourceId: input.resourceId,
    projectionKind: "commerce_order",
    revision: input.revision,
    status: "accepted",
    merchantId: input.receipt.merchantId,
    merchantRevision: input.receipt.merchantRevision,
    providerResource: {
      kind: "refund_attempt",
      id: input.refundAttemptId,
      revision: input.receipt.resource.revision,
    },
    observedAt: input.receipt.committedAt,
  };
}

async function authorizeCommerceEffectSink(
  db: OrganisationDatabase,
  accountAccess: OrganisationAccess,
  action: LedgerCanonicalAction,
): Promise<
  Result<Variant<FlowDecision, "allow">, CommerceProviderExecutionError>
> {
  const binding = await FlowBinding.restore(action.flowBinding);
  if (
    !binding.ok ||
    !flowBindingMatchesIdentity(binding.value, {
      organisationId: action.organisationId,
      sessionId: action.sessionId,
      authorityPartitionDigest: action.authorityPartition.digest,
    })
  ) {
    return {
      ok: false,
      error: { code: "commerce_action_flow_binding_invalid" },
    };
  }
  const decision = await decideCurrentAuthorityFlowSink(db, accountAccess, {
    binding: binding.value,
    sink: {
      kind: "tool_effect",
      destinationAuthority: action.requestAuthority,
      capabilityId: "commerce.action.propose",
      integrationAccountId: action.integrationAccountId,
      resourceScope: action.resourceKey,
      approvalSatisfied: true,
    },
  });
  return decision.kind === "allow"
    ? { ok: true, value: decision }
    : { ok: false, error: { code: "commerce_action_flow_denied" } };
}

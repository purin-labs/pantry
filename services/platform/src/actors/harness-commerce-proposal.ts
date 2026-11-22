import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { acceptedExecutionAuthority } from "@purin-labs/tenancy/organisation-access/access";
import { sessionActionMutationExecution } from "@purin-labs/conversation/actors/action-mutation-execution";
import {
  requireSessionExecution,
  admittedSessionOperation,
} from "@purin-labs/agent/actors/session-execution-admission";
import type {
  CommerceProjection,
  CommerceSource,
  SourceProvenance,
} from "@purin-labs/commerce-contracts";
import {
  assertNever,
  sha256Hex,
} from "@purin-labs/std";
import type { CommerceOrderV1 } from "@purin-labs/commerce-client";
import type { Variant } from "@purin-labs/type-utils";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationActorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import type { Result } from "@purin-labs/kernel/result";
import {
  newRequestId,
  parseCaseId,
  parseIntegrationAccountId,
  parseSessionId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { CanonicalActionDraft } from "@purin-labs/authority/actors/action-ledger";
import {
  requireActiveOrganisationActor,
  resolveActiveCaseActor,
} from "@purin-labs/actor-runtime/actors/actor-router";
import type { CommerceActionProposalOrigin } from "@purin-labs/agent-tools/catalog/types";
import {
  readSessionTurnFlowBinding as readPersistedSessionTurnFlowBinding,
  sessionObservedCommerceEntity,
  sessionObservedCommerceEntityId,
  type CommerceObservationEntity,
} from "@purin-labs/agent/actors/agent-session-information-flow";
import {
  merchantPluginInstallation,
  type InstallMerchantPluginAction,
  type MerchantPluginDraft,
} from "../commerce/merchant-plugin-action";
import {
  buildCommerceActionDraft,
  buildCafeMenuActionDraft,
  buildMenuPriceActionDraft,
  buildOrderRefundActionDraft,
  buildStockOperationActionDraft,
  buildMerchantPluginActionDraft,
  buildCommerceCancellationActionDraft,
  commerceActionExpectedRevision,
  commerceTrackingAttachmentTargetMatches,
  type CommerceActionError,
  type CommerceActionRequest,
  slackMayApproveAction,
} from "../commerce/action-model";
import { commerceProjectionRevision } from "../commerce/contract/commerce-provider";
import {
  resolveOrganisationCommerceSystemAuthority,
  type CommerceSystemProviderAuthority,
} from "@purin-labs/connections/data/organisation-commerce-system";
import { resolveCommerceMerchantBinding } from "@purin-labs/connections/data/commerce-merchant-binding";
import {
  createCommerceClient,
  createCommerceEntityPlaneClient,
} from "../commerce/contract/client";
import { deliverCommerceCaseOutput } from "../commerce/case-commerce-delivery";
import {
  CAFE_MENU_ID,
  CAFE_STOREFRONT_ID,
  planCafeMenu,
} from "../cafe/contract/menu-publication";
import type { PublishCafeMenuAction } from "../commerce/cafe-menu-action";
import { MenuDraftRequestError } from "../cafe/contract/request-errors";
import { MenuBoardRequestError } from "../cafe/contract/request-errors";
import type { ChangeMenuPriceAction } from "../commerce/menu-price-action";
import {
  OrderRefundRequestError,
  planOrderRefund,
  type OrderRefundAction,
  type OrderRefundLineRequest,
} from "../commerce/order-refund-action";
import {
  planStockOperation,
  type StockProposalRequest,
} from "../kitchen/contract/stock-action-plan";
import { stockOperationResourceId } from "../kitchen/contract/stock-action";
import { traceWarn } from "@purin-labs/kernel/observability";
import { resolveCommerceCancellationAuthority } from "../commerce/provider";
import { commerceProviderResourceId } from "../commerce/contract/resource-ids";
import { authorizeCapabilityUse } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import type { ProviderCapabilityDefinition } from "@purin-labs/authority/authorization/access-grants/capability-key";
import { readOrganisationDefaultWorkspacePortalAddress } from "@purin-labs/agent/data/organisation-workspace";
import { readOfferPriceAllowanceView } from "../commerce/contract/offer-price-allowance";
import {
  commerceApprovalCardTexts,
  type CommerceChangeFacts,
} from "../commerce/contract/approval-card-texts";
import { CARD_ONLY_REPLY_INSTRUCTION } from "../slack/card-only-reply";
import type { SessionToolContext } from "@purin-labs/agent/agent-tools/context";
import type { MenuPriceProposalRequest } from "../commerce/contract/types";

function commerceActionProjectionTarget(action: CommerceActionRequest): {
  readonly kind: "product" | "offer" | "commerce_order" | "fulfillment";
  readonly resourceId: string;
} | null {
  switch (action.kind) {
    case "publish_catalog_listing":
    case "adjust_offer_price":
      return { kind: "offer", resourceId: action.offerId };
    case "update_product_description":
      return { kind: "product", resourceId: action.productId };
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
      // and a menu price the offer revision.
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

function commerceActionProviderSupported(
  source: CommerceSource,
  kind: CommerceActionRequest["kind"],
): boolean {
  if (source === "lab") return true;
  if (source === "shopify") return kind === "cancel_order";
  if (source === "commerce") {
    return (
      kind === "update_product_description" ||
      kind === "publish_catalog_listing" ||
      kind === "cancel_order" ||
      kind === "attach_tracking" ||
      kind === "adjust_offer_price"
    );
  }
  return false;
}

type CommerceCancellationDraftError =
  | { readonly code: "commerce_projection_mismatch" }
  | { readonly code: "commerce_binding_unavailable" }
  | { readonly code: "commerce_binding_identity_mismatch" }
  | { readonly code: "commerce_client_unavailable" }
  | { readonly code: "commerce_order_id_invalid" }
  | { readonly code: "commerce_cancellation_authority_unavailable" }
  | CommerceActionError;

async function buildCommerceCancellationActionDraftForAgent(
  input: Readonly<{
    readonly env: Env;
    readonly db: OrganisationDatabase;
    readonly fetcher: typeof fetch;
    readonly authorizeRead: () => Promise<void>;
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: IntegrationAccountId;
    readonly request: Variant<CommerceActionRequest, "cancel_order">;
    readonly current: Variant<CommerceProjection, "commerce_order">;
    readonly actionNow: number;
  }>,
): Promise<
  Result<CanonicalActionDraft, CommerceCancellationDraftError>
> {
  if (
    input.current.projection.provenance.source !== "commerce" ||
    input.current.projection.provenance.integrationAccountId !==
      input.integrationAccountId ||
    input.current.projection.provenance.resourceId !==
      input.request.resourceId ||
    input.current.projection.provenance.revision !==
      input.request.expectedRevision
  ) {
    return { ok: false, error: { code: "commerce_projection_mismatch" } };
  }
  await input.authorizeRead();
  const binding = await resolveCommerceMerchantBinding({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (!binding.ok) {
    return { ok: false, error: { code: "commerce_binding_unavailable" } };
  }
  if (
    binding.value.organisationId !== input.organisationId ||
    binding.value.integrationAccountId !== input.integrationAccountId
  ) {
    return {
      ok: false,
      error: { code: "commerce_binding_identity_mismatch" },
    };
  }
  const client = createCommerceClient(input.env, input.fetcher, {
    kind: "organisation",
    organisationId: String(input.organisationId),
  });
  if (client === null) {
    return { ok: false, error: { code: "commerce_client_unavailable" } };
  }
  const orderId = commerceProviderResourceId(
    String(binding.value.merchantId),
    input.request.resourceId,
  );
  if (orderId === null) {
    return { ok: false, error: { code: "commerce_order_id_invalid" } };
  }
  await input.authorizeRead();
  const authority = await resolveCommerceCancellationAuthority({
    client,
    organisationId: String(input.organisationId),
    merchantId: String(binding.value.merchantId),
    orderId,
    orderRevision: input.request.expectedRevision,
    requestedAt: new Date(input.actionNow).toISOString(),
  });
  await input.authorizeRead();
  if (!authority.ok) {
    return {
      ok: false,
      error: { code: "commerce_cancellation_authority_unavailable" },
    };
  }
  return buildCommerceCancellationActionDraft({
    request: input.request,
    authority: authority.value,
    current: input.current,
  });
}

export async function proposeCommerceActionForHarness(
  input: SessionToolContext,
  proposed: CommerceActionRequest,
  origin?: CommerceActionProposalOrigin,
): Promise<unknown> {
  await requireSessionExecution(input.execution, input.lease);
  let request = proposed;
  if (request.kind === "adjust_offer_price") {
    // The read showed the agent the offer's provider id; the session holds
    // the canonical id of the offer it read.
    const offerId = sessionObservedCommerceEntityId({
      sql: input.storage.sql,
      organisationId: String(input.execution.scope.organisationId),
      sessionId: String(input.assignment.sessionId),
      entityType: "offer",
      entityId: request.offerId,
      revision: request.expectedOfferRevision,
    });
    if (offerId !== null) request = { ...request, offerId };
  }
  if (request.kind === "update_product_description") {
    const productId = sessionObservedCommerceEntityId({
      sql: input.storage.sql,
      organisationId: String(input.execution.scope.organisationId),
      sessionId: String(input.assignment.sessionId),
      entityType: "product",
      entityId: request.productId,
      revision: request.productRevision,
    });
    if (productId !== null) request = { ...request, productId };
  }
  if (request.kind === "attach_tracking") {
    const scope = {
      sql: input.storage.sql,
      organisationId: String(input.execution.scope.organisationId),
      sessionId: String(input.assignment.sessionId),
    };
    const fulfillmentId = sessionObservedCommerceEntityId({
      ...scope,
      entityType: "fulfillment",
      entityId: request.fulfillmentId,
      revision: request.fulfillmentRevision,
    });
    const shipmentId = sessionObservedCommerceEntityId({
      ...scope,
      entityType: "shipment",
      entityId: request.shipmentId,
      revision: request.shipmentRevision,
    });
    request = {
      ...request,
      fulfillmentId: fulfillmentId ?? request.fulfillmentId,
      shipmentId: shipmentId ?? request.shipmentId,
    };
  }
  // A proposal may only target records this session read. Checking the
  // current revision alone would let a plausible identifier through; the
  // agent must have observed the record it proposes to change.
  for (const observedTarget of commerceProposalObservedTargets(request)) {
    if (
      !sessionObservedCommerceEntity({
        sql: input.storage.sql,
        organisationId: String(input.execution.scope.organisationId),
        sessionId: String(input.assignment.sessionId),
        entityType: observedTarget.entityType,
        entityId: observedTarget.entityId,
        revision: observedTarget.revision,
      })
    ) {
      throw new Error("commerce proposal target was not observed in this Case");
    }
  }
  const organisation = await requireActiveOrganisationActor({
    env: input.env,
    organisationId: input.execution.scope.organisationId,
    now: Date.now(),
  });
  const target = commerceActionProjectionTarget(request);
  if (target === null) {
    // A supplier payout has no commerce projection to read. Its own store is
    // the authority on whether the submission may be proposed, and the
    // control route checks that before an action is drafted.
    throw new Error("commerce proposal target is not a commerce projection");
  }
  const projectionKind = target.kind;
  const resourceId = target.resourceId;
  await requireSessionExecution(input.execution, input.lease);
  const current = await organisation.readCurrentCommerceProjection({
    organisationId: input.execution.scope.organisationId,
    kind: projectionKind,
    canonicalId: resourceId,
  });
  await requireSessionExecution(input.execution, input.lease);
  if (!current.ok || current.value === null) {
    throw new Error(
      `commerce proposal projection unavailable: ${current.ok ? "missing" : current.error.code}`,
    );
  }
  if (
    !commerceActionProviderSupported(
      current.value.projection.provenance.source,
      request.kind,
    )
  ) {
    throw new Error("commerce proposal provider is unsupported");
  }
  const expectedRevision = commerceActionExpectedRevision(request);
  if (commerceProjectionRevision(current.value) !== expectedRevision) {
    throw new Error("commerce proposal projection revision is stale");
  }
  if (request.kind === "publish_catalog_listing") {
    const related = [
      {
        kind: "product" as const,
        id: request.productId,
        revision: request.productRevision,
      },
      {
        kind: "sellable_variant" as const,
        id: request.variantId,
        revision: request.variantRevision,
      },
      {
        kind: "offer" as const,
        id: request.offerId,
        revision: request.offerRevision,
      },
      {
        kind: "sales_channel" as const,
        id: request.salesChannelId,
        revision: request.salesChannelRevision,
      },
    ];
    for (const requirement of related) {
      await requireSessionExecution(input.execution, input.lease);
      const projection = await organisation.readCurrentCommerceProjection({
        organisationId: input.execution.scope.organisationId,
        kind: requirement.kind,
        canonicalId: requirement.id,
      });
      await requireSessionExecution(input.execution, input.lease);
      if (
        !projection.ok ||
        projection.value === null ||
        commerceProjectionRevision(projection.value) !== requirement.revision ||
        projection.value.projection.provenance.integrationAccountId !==
          current.value.projection.provenance.integrationAccountId
      ) {
        throw new Error("commerce proposal related projection is stale");
      }
    }
  }
  if (request.kind === "attach_tracking") {
    if (current.value.kind !== "fulfillment") {
      throw new Error("commerce proposal fulfillment target is invalid");
    }
    request = await agentTrackingRequest(input, request, current.value);
    await requireSessionExecution(input.execution, input.lease);
    const shipment = await organisation.readCurrentCommerceProjection({
      organisationId: input.execution.scope.organisationId,
      kind: "shipment",
      canonicalId: request.shipmentId,
    });
    await requireSessionExecution(input.execution, input.lease);
    if (
      !shipment.ok ||
      shipment.value === null ||
      shipment.value.kind !== "shipment" ||
      !commerceTrackingAttachmentTargetMatches({
        fulfillment: current.value,
        shipment: shipment.value,
        request,
      })
    ) {
      throw new Error("commerce proposal tracking target is stale");
    }
  }
  const integrationAccountId = parseIntegrationAccountId(
    current.value.projection.provenance.integrationAccountId,
  );
  if (!integrationAccountId.ok)
    throw new Error("commerce proposal integration identity is invalid");
  const commerceAuthority = await resolveOrganisationCommerceSystemAuthority({
    db: input.execution.scope.database,
    organisationId: input.execution.scope.organisationId,
  });
  if (
    !commerceAuthority.ok ||
    commerceAuthority.value.provider !==
      current.value.projection.provenance.source ||
    commerceAuthority.value.integrationAccountId !== integrationAccountId.value
  ) {
    throw new Error("commerce proposal authority is stale");
  }
  const currentProjection = current.value;
  const provenance = currentProjection.projection.provenance;
  const changeFacts = await proposalChangeFacts(
    input,
    organisation,
    request,
    currentProjection,
  );
  return recordCommerceProposal(input, origin, {
    organisation,
    request,
    integrationAccountId: integrationAccountId.value,
    commerceAuthority: commerceAuthority.value,
    provenance,
    resourceId,
    changeFacts,
    buildDraft: async (actionNow) => {
      let draft: Result<
        CanonicalActionDraft,
        CommerceCancellationDraftError
      >;
      if (
        request.kind === "cancel_order" &&
        currentProjection.projection.provenance.source === "commerce"
      ) {
        if (currentProjection.kind !== "commerce_order") {
          throw new Error(
            "commerce proposal cancellation projection is invalid",
          );
        }
        draft = await buildCommerceCancellationActionDraftForAgent({
          env: input.env,
          db: input.execution.scope.database,
          authorizeRead: requireSessionExecution.bind(
            null,
            input.execution,
            input.lease,
          ),
          fetcher: admittedSessionOperation(
            input.execution,
            input.lease,
            input.env.COMMERCE.fetch.bind(input.env.COMMERCE),
          ),
          organisationId: input.execution.scope.organisationId,
          integrationAccountId: integrationAccountId.value,
          request,
          current: currentProjection,
          actionNow,
        });
      } else {
        draft = await buildCommerceActionDraft({
          organisationId: String(input.execution.scope.organisationId),
          integrationAccountId: integrationAccountId.value,
          sessionId: String(input.assignment.sessionId),
          threadId: String(input.assignment.caseId),
          request,
          current: currentProjection,
          exp: actionNow + 15 * 60_000,
          now: actionNow,
        });
      }
      return draft;
    },
  });
}

/**
 * The agent names the fulfillment and the shipment that it read. The order,
 * the batch and the merchant revision come from current records, as in the
 * person's tracking preview, so the agent cannot name them wrongly.
 */
async function agentTrackingRequest(
  input: AgentProposalInput,
  request: Variant<CommerceActionRequest, "attach_tracking">,
  fulfillment: Variant<CommerceProjection, "fulfillment">,
): Promise<Variant<CommerceActionRequest, "attach_tracking">> {
  const organisationId = input.execution.scope.organisationId;
  const authority = await resolveOrganisationCommerceSystemAuthority({
    db: input.execution.scope.database,
    organisationId,
  });
  if (!authority.ok || authority.value.provider !== "commerce")
    throw new Error("tracking proposal needs Purin Checkout");
  const binding = await resolveCommerceMerchantBinding({
    db: input.execution.scope.database,
    organisationId,
    integrationAccountId: authority.value.integrationAccountId,
  });
  if (!binding.ok) throw new Error("tracking proposal merchant unavailable");
  const client = createCommerceClient(
    input.env,
    admittedSessionOperation(
      input.execution,
      input.lease,
      input.env.COMMERCE.fetch.bind(input.env.COMMERCE),
    ),
    { kind: "organisation", organisationId: String(organisationId) },
  );
  if (client === null) throw new Error("tracking proposal Commerce unavailable");
  await requireSessionExecution(input.execution, input.lease);
  const snapshot = await client.readSnapshot(binding.value.merchantId);
  await requireSessionExecution(input.execution, input.lease);
  if (!snapshot.ok) throw new Error("tracking proposal snapshot unavailable");
  const digest = await sha256Hex(
    JSON.stringify([
      request.fulfillmentId,
      request.fulfillmentRevision,
      request.shipmentId,
      request.shipmentRevision,
      request.trackingNumber,
    ]),
  );
  return {
    ...request,
    batchId: `tracking_batch_${digest}`,
    merchantRevision: snapshot.value.merchantRevision,
    orderId: fulfillment.projection.orderId,
  };
}

/**
 * Proposes a merchant plugin that the agent wrote (Plan 77 step 4). Platform
 * reads the plugin's current version from Commerce, runs the draft over the
 * merchant's recent checkouts, and records the installation for approval.
 * The agent gets the counts of the preview, not the checkouts themselves.
 */
export async function proposeMerchantPluginForHarness(
  input: AgentProposalInput,
  draft: MerchantPluginDraft,
  origin?: CommerceActionProposalOrigin,
): Promise<unknown> {
  await requireSessionExecution(input.execution, input.lease);
  const organisationId = input.execution.scope.organisationId;
  const organisation = await requireActiveOrganisationActor({
    env: input.env,
    organisationId,
    now: Date.now(),
  });
  const commerceAuthority = await resolveOrganisationCommerceSystemAuthority({
    db: input.execution.scope.database,
    organisationId,
  });
  if (
    !commerceAuthority.ok ||
    commerceAuthority.value.provider !== "commerce"
  )
    throw new Error("merchant plugin proposal needs Purin Checkout");
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.execution.scope.database,
    organisationId,
    integrationAccountId: commerceAuthority.value.integrationAccountId,
  });
  if (!merchantBinding.ok)
    throw new Error("merchant plugin proposal merchant binding unavailable");
  const merchantId = merchantBinding.value.merchantId;
  const client = createCommerceClient(
    input.env,
    admittedSessionOperation(
      input.execution,
      input.lease,
      input.env.COMMERCE.fetch.bind(input.env.COMMERCE),
    ),
    { kind: "organisation", organisationId: String(organisationId) },
  );
  if (client === null)
    throw new Error("merchant plugin proposal Commerce unavailable");
  await requireSessionExecution(input.execution, input.lease);
  const listed = await client.listPlugins(merchantId);
  await requireSessionExecution(input.execution, input.lease);
  if (!listed.ok)
    throw new Error(`merchant plugin list unavailable: ${listed.error.kind}`);
  const existing = listed.value.plugins.find(
    (plugin) => plugin.pluginId === draft.pluginId,
  );
  if (existing !== undefined && existing.kind !== "merchant")
    throw new Error("merchant plugin identifier names a built-in plugin");
  const request: InstallMerchantPluginAction = {
    kind: "install_merchant_plugin",
    ...draft,
    version: (existing?.version ?? 0) + 1,
    expectedRevision: existing?.revision ?? null,
  };
  // Only a checkout function runs over recent checkouts; handlers and
  // actions run on later events and calls.
  const preview =
    request.functionSource === null
      ? null
      : await client.previewMerchantPlugin(merchantId, {
          schemaVersion: "commerce.preview-merchant-plugin.v1",
          ...merchantPluginInstallation(request),
        });
  await requireSessionExecution(input.execution, input.lease);
  if (preview !== null && !preview.ok)
    throw new Error(`merchant plugin preview refused: ${preview.error.kind}`);
  const recorded = await recordCommerceProposal(input, origin, {
    organisation,
    request,
    integrationAccountId: commerceAuthority.value.integrationAccountId,
    commerceAuthority: commerceAuthority.value,
    provenance: null,
    changeFacts: { title: null, fromPriceMinor: null, allowedRange: null },
    resourceId: draft.pluginId,
    buildDraft: () => buildMerchantPluginActionDraft(request),
  });
  return {
    ...recorded,
    version: request.version,
    preview:
      preview === null
        ? null
        : {
            checkouts: preview.value.checkouts,
            refused: preview.value.refused.length,
            failed: preview.value.failed.length,
          },
  };
}

/**
 * Proposes the publication of the draft revision that the agent read. It
 * checks each item against the shop's stock now, so that a person sees a card
 * only for a menu that Commerce can sell. Nothing goes live here.
 */
export async function proposeCafeMenuPublicationForHarness(
  input: AgentProposalInput,
  request: Readonly<{ documentRevision: number }>,
  origin?: CommerceActionProposalOrigin,
): Promise<unknown> {
  await requireSessionExecution(input.execution, input.lease);
  const organisationId = input.execution.scope.organisationId;
  const organisation = await requireActiveOrganisationActor({
    env: input.env,
    organisationId,
    now: Date.now(),
  });
  const commerceAuthority = await resolveOrganisationCommerceSystemAuthority({
    db: input.execution.scope.database,
    organisationId,
  });
  if (
    !commerceAuthority.ok ||
    commerceAuthority.value.provider !== "commerce"
  )
    throw new Error("menu publication proposal needs Purin Checkout");
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.execution.scope.database,
    organisationId,
    integrationAccountId: commerceAuthority.value.integrationAccountId,
  });
  if (!merchantBinding.ok)
    throw new Error("menu publication merchant binding unavailable");
  const merchantId = merchantBinding.value.merchantId;
  const client = createCommerceClient(
    input.env,
    admittedSessionOperation(
      input.execution,
      input.lease,
      input.env.COMMERCE.fetch.bind(input.env.COMMERCE),
    ),
    { kind: "organisation", organisationId: String(organisationId) },
  );
  if (client === null)
    throw new Error("menu publication Commerce unavailable");
  await requireSessionExecution(input.execution, input.lease);
  const stored = await organisation.readMenuDraft({ organisationId });
  await requireSessionExecution(input.execution, input.lease);
  if (!stored.ok)
    throw new Error(`menu draft unavailable: ${stored.error.code}`);
  if (stored.value.revision !== request.documentRevision)
    throw new MenuDraftRequestError(
      `The menu changed since that read: it is now at revision ${stored.value.revision}. Read it again and check the changes before you propose a publication.`,
    );
  const [storefront, stock] = await Promise.all([
    client.readStorefront(merchantId, CAFE_STOREFRONT_ID),
    client.readStockSnapshot(merchantId),
  ]);
  await requireSessionExecution(input.execution, input.lease);
  if (!stock.ok) throw new Error("menu publication stock read failed");
  if (!storefront.ok || storefront.value.fulfillment.kind !== "pickup")
    throw new MenuDraftRequestError(
      "This shop has no café storefront, so the menu cannot be published.",
    );
  const plan = planCafeMenu(stored.value.draft, stock.value, {
    salesChannelId: storefront.value.salesChannelId,
    locationId: storefront.value.fulfillment.locationId,
  });
  if (plan.kind === "empty")
    throw new MenuDraftRequestError(
      "The menu has no items. Add an item before you propose a publication.",
    );
  if (plan.kind === "not_sellable")
    throw new MenuDraftRequestError(
      `The café cannot sell these items now, because each one needs a listed offer and a stock plan: ${plan.items.join(", ")}. Tell the person, or remove them from the draft.`,
    );
  const action: PublishCafeMenuAction = {
    kind: "publish_cafe_menu",
    documentRevision: request.documentRevision,
    expectedMenuRevision: plan.expectedMenuRevision ?? null,
    menu: plan.menu,
    entryNames: stored.value.draft.items.map((item) => ({
      menuEntryId: item.id,
      displayName: item.displayName,
    })),
    addedEntryIds: plan.addedEntryIds,
    removedNames: plan.removedNames,
  };
  return recordCommerceProposal(input, origin, {
    organisation,
    request: action,
    integrationAccountId: commerceAuthority.value.integrationAccountId,
    commerceAuthority: commerceAuthority.value,
    provenance: null,
    resourceId: CAFE_MENU_ID,
    changeFacts: { title: null, fromPriceMinor: null, allowedRange: null },
    buildDraft: () => buildCafeMenuActionDraft(action),
  });
}

/**
 * Proposes a new price, or a deal, for one item of the café menu (Plan 40B
 * phase 4). It reads the item's live offer now and freezes the price before
 * and after, so that the card shows both and the approval signs that change.
 * Nothing changes here; the boards show the new price after the approval.
 */
export async function proposeMenuPriceForHarness(
  input: AgentProposalInput,
  request: MenuPriceProposalRequest,
  origin?: CommerceActionProposalOrigin,
): Promise<unknown> {
  await requireSessionExecution(input.execution, input.lease);
  const organisationId = input.execution.scope.organisationId;
  const organisation = await requireActiveOrganisationActor({
    env: input.env,
    organisationId,
    now: Date.now(),
  });
  const commerceAuthority = await resolveOrganisationCommerceSystemAuthority({
    db: input.execution.scope.database,
    organisationId,
  });
  if (
    !commerceAuthority.ok ||
    commerceAuthority.value.provider !== "commerce"
  )
    throw new Error("menu price proposal needs Purin Checkout");
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.execution.scope.database,
    organisationId,
    integrationAccountId: commerceAuthority.value.integrationAccountId,
  });
  if (!merchantBinding.ok)
    throw new Error("menu price merchant binding unavailable");
  const merchantId = merchantBinding.value.merchantId;
  const client = createCommerceClient(
    input.env,
    admittedSessionOperation(
      input.execution,
      input.lease,
      input.env.COMMERCE.fetch.bind(input.env.COMMERCE),
    ),
    { kind: "organisation", organisationId: String(organisationId) },
  );
  if (client === null) throw new Error("menu price Commerce unavailable");
  await requireSessionExecution(input.execution, input.lease);
  const [stock, draft] = await Promise.all([
    client.readStockSnapshot(merchantId),
    organisation.readMenuDraft({ organisationId }),
  ]);
  await requireSessionExecution(input.execution, input.lease);
  if (!stock.ok) throw new Error("menu price stock read failed");
  const menu = stock.value.foodService.resources.menus.find(
    (candidate) =>
      candidate.menuId === CAFE_MENU_ID &&
      candidate.lifecycle.state === "published",
  );
  const entry = menu?.entries.find(
    (candidate) =>
      candidate.menuEntryId === request.itemId &&
      candidate.lifecycle === "active",
  );
  if (entry === undefined)
    throw new MenuBoardRequestError(
      "That item is not on the published menu. Read the boards again with menu_board_read and use an itemId from its items.",
    );
  const offer = stock.value.commerce.resources.offers.find(
    (candidate) => candidate.id === entry.offerId,
  );
  if (offer === undefined || offer.lifecycle.state !== "listed")
    throw new MenuBoardRequestError(
      "That item has no listed price now, so its price cannot change here.",
    );
  const before = {
    price: offer.price,
    compareAtPrice:
      offer.compareAtPrice !== null &&
      offer.compareAtPrice.amountMinor > offer.price.amountMinor
        ? offer.compareAtPrice
        : null,
  };
  const wasPrice = before.compareAtPrice ?? before.price;
  if (request.deal && request.priceMinor >= wasPrice.amountMinor)
    throw new MenuBoardRequestError(
      `A deal price must be lower than ${wasPrice.amountMinor} ${wasPrice.currency} minor units, the price that the board shows as the earlier price.`,
    );
  const after = {
    price: { amountMinor: request.priceMinor, currency: offer.price.currency },
    compareAtPrice: request.deal ? wasPrice : null,
  };
  if (
    after.price.amountMinor === before.price.amountMinor &&
    (after.compareAtPrice?.amountMinor ?? null) ===
      (before.compareAtPrice?.amountMinor ?? null)
  )
    throw new MenuBoardRequestError(
      "The item already has that price. Nothing needs approval.",
    );
  const itemName =
    (draft.ok
      ? draft.value.draft.items.find((item) => item.id === entry.menuEntryId)
          ?.displayName
      : undefined) ??
    stock.value.commerce.resources.products.find(
      (product) =>
        product.id ===
        stock.value.commerce.resources.variants.find(
          (variant) => variant.id === offer.variantId,
        )?.productId,
    )?.title ??
    entry.menuEntryId;
  const action: ChangeMenuPriceAction = {
    kind: "change_menu_price",
    offerId: offer.id,
    expectedOfferRevision: offer.revision,
    menuEntryId: entry.menuEntryId,
    itemName: itemName.slice(0, 280),
    before,
    after,
  };
  const recorded = await recordCommerceProposal(input, origin, {
    organisation,
    request: action,
    integrationAccountId: commerceAuthority.value.integrationAccountId,
    commerceAuthority: commerceAuthority.value,
    provenance: null,
    resourceId: offer.id,
    changeFacts: { title: null, fromPriceMinor: null, allowedRange: null },
    buildDraft: () => buildMenuPriceActionDraft(action),
  });
  return { ...recorded, itemName: action.itemName, before, after };
}

/**
 * Proposes a refund of an order that the session read. It reads the order and
 * its payment now and freezes the exact money, so that the card shows what the
 * approval signs. No money moves here.
 */
export async function proposeOrderRefundForHarness(
  input: AgentProposalInput,
  request: Readonly<{
    orderId: string;
    expectedRevision: number;
    reason: string;
    refundLines: readonly OrderRefundLineRequest[] | null;
  }>,
  origin?: CommerceActionProposalOrigin,
): Promise<unknown> {
  await requireSessionExecution(input.execution, input.lease);
  const organisationId = input.execution.scope.organisationId;
  const orderId = sessionObservedCommerceEntityId({
    sql: input.storage.sql,
    organisationId: String(organisationId),
    sessionId: String(input.assignment.sessionId),
    entityType: "order",
    entityId: request.orderId,
    revision: request.expectedRevision,
  });
  if (orderId === null)
    throw new OrderRefundRequestError(
      "Read this order with commerce_entity_context first. Give its id and the revision that you read.",
    );
  const organisation = await requireActiveOrganisationActor({
    env: input.env,
    organisationId,
    now: Date.now(),
  });
  const commerceAuthority = await resolveOrganisationCommerceSystemAuthority({
    db: input.execution.scope.database,
    organisationId,
  });
  if (
    !commerceAuthority.ok ||
    commerceAuthority.value.provider !== "commerce"
  )
    throw new Error("order refund proposal needs Purin Checkout");
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.execution.scope.database,
    organisationId,
    integrationAccountId: commerceAuthority.value.integrationAccountId,
  });
  if (!merchantBinding.ok)
    throw new Error("order refund merchant binding unavailable");
  const merchantId = merchantBinding.value.merchantId;
  const providerOrderId = commerceProviderResourceId(merchantId, orderId);
  if (providerOrderId === null)
    throw new Error("order refund order id is invalid");
  const client = createCommerceClient(
    input.env,
    admittedSessionOperation(
      input.execution,
      input.lease,
      input.env.COMMERCE.fetch.bind(input.env.COMMERCE),
    ),
    { kind: "organisation", organisationId: String(organisationId) },
  );
  if (client === null) throw new Error("order refund Commerce unavailable");
  await requireSessionExecution(input.execution, input.lease);
  const snapshot = await client.readSnapshot(merchantId);
  await requireSessionExecution(input.execution, input.lease);
  if (!snapshot.ok) throw new Error("order refund snapshot unavailable");
  const order = snapshot.value.resources.orders.find(
    (candidate) => candidate.id === providerOrderId,
  );
  if (order === undefined)
    throw new OrderRefundRequestError("This order no longer exists.");
  if (order.revision !== request.expectedRevision)
    throw new OrderRefundRequestError(
      `The order changed since that read: it is now at revision ${order.revision}. Read it again before you propose a refund.`,
    );
  const refundPolicyId = await orderRefundPolicyId(client, merchantId, order);
  await requireSessionExecution(input.execution, input.lease);
  const action: OrderRefundAction = {
    kind: "refund_order",
    orderId,
    providerOrderId,
    expectedOrderRevision: order.revision,
    reason: request.reason,
    refundPolicyId,
    ...planOrderRefund(
      order,
      snapshot.value.resources.payments,
      request.refundLines,
    ),
  };
  return recordCommerceProposal(input, origin, {
    organisation,
    request: action,
    integrationAccountId: commerceAuthority.value.integrationAccountId,
    commerceAuthority: commerceAuthority.value,
    provenance: null,
    resourceId: orderId,
    changeFacts: { title: null, fromPriceMinor: null, allowedRange: null },
    buildDraft: () => buildOrderRefundActionDraft(action),
  });
}

/**
 * Proposes a stock, production request or purchase request change on records
 * that the session read. It reads them now and freezes the exact change, so
 * that the card shows what the approval signs. No stock moves here.
 */
export async function proposeStockActionForHarness(
  input: AgentProposalInput,
  request: StockProposalRequest,
  origin?: CommerceActionProposalOrigin,
): Promise<unknown> {
  await requireSessionExecution(input.execution, input.lease);
  const organisationId = input.execution.scope.organisationId;
  const organisation = await requireActiveOrganisationActor({
    env: input.env,
    organisationId,
    now: Date.now(),
  });
  const commerceAuthority = await resolveOrganisationCommerceSystemAuthority({
    db: input.execution.scope.database,
    organisationId,
  });
  if (
    !commerceAuthority.ok ||
    commerceAuthority.value.provider !== "commerce"
  )
    throw new Error("stock proposal needs Purin Checkout");
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.execution.scope.database,
    organisationId,
    integrationAccountId: commerceAuthority.value.integrationAccountId,
  });
  if (!merchantBinding.ok)
    throw new Error("stock proposal merchant binding unavailable");
  const merchantId = merchantBinding.value.merchantId;
  const fetcher = admittedSessionOperation(
    input.execution,
    input.lease,
    input.env.COMMERCE.fetch.bind(input.env.COMMERCE),
  );
  const caller = {
    kind: "organisation",
    organisationId: String(organisationId),
  } as const;
  const client = createCommerceClient(input.env, fetcher, caller);
  const plane = createCommerceEntityPlaneClient(input.env, fetcher, caller);
  if (client === null || plane === null)
    throw new Error("stock proposal Commerce unavailable");
  await requireSessionExecution(input.execution, input.lease);
  const snapshot = await client.readStockSnapshot(merchantId);
  await requireSessionExecution(input.execution, input.lease);
  if (!snapshot.ok) throw new Error("stock proposal snapshot unavailable");
  const action = await planStockOperation(
    {
      organisationId: String(organisationId),
      merchantId,
      snapshot: snapshot.value,
      plane,
      observed: (entityType, entityId, revision) =>
        sessionObservedCommerceEntityId({
          sql: input.storage.sql,
          organisationId: String(organisationId),
          sessionId: String(input.assignment.sessionId),
          entityType,
          entityId,
          revision,
        }) !== null,
      providerId: (id) => commerceProviderResourceId(merchantId, id) ?? id,
    },
    request,
  );
  await requireSessionExecution(input.execution, input.lease);
  return recordCommerceProposal(input, origin, {
    organisation,
    request: action,
    integrationAccountId: commerceAuthority.value.integrationAccountId,
    commerceAuthority: commerceAuthority.value,
    provenance: null,
    resourceId: stockOperationResourceId(action.operation),
    changeFacts: { title: null, fromPriceMinor: null, allowedRange: null },
    buildDraft: () => buildStockOperationActionDraft(action),
  });
}

/** The refund policy that the sale's own configuration names. */
async function orderRefundPolicyId(
  client: NonNullable<ReturnType<typeof createCommerceClient>>,
  merchantId: string,
  order: CommerceOrderV1,
): Promise<string> {
  if (
    order.origin.kind === "online" &&
    order.origin.configuration.kind === "checkout_profile"
  ) {
    const profile = await client.readCheckoutProfile(
      merchantId,
      order.origin.configuration.checkoutProfile.checkoutProfileId,
      order.origin.configuration.checkoutProfile.revision,
    );
    if (!profile.ok) throw new Error("order refund profile unavailable");
    return profile.value.configuration.afterSalePolicy.refundPolicyId;
  }
  if (order.origin.kind === "point_of_sale") {
    const configuration = await client.readPointOfSaleConfiguration(
      merchantId,
      order.origin.locationId,
    );
    if (!configuration.ok)
      throw new Error("order refund point of sale configuration unavailable");
    return configuration.value.afterSalePolicy.refundPolicyId;
  }
  throw new OrderRefundRequestError(
    "This order has no refund policy that Purin Pantry can read. A person must refund it from the order in the Portal.",
  );
}

/**
 * The facts that an approval card shows. The card names a product only when
 * this Session read it, so the turn's flow binding covers the title. A fact
 * that cannot be read leaves the card with less detail, not without a card.
 */
async function proposalChangeFacts(
  input: AgentProposalInput,
  organisation: OrganisationActorStub,
  request: CommerceActionRequest,
  current: CommerceProjection,
): Promise<CommerceChangeFacts> {
  const title = await proposalProductTitle(
    input,
    organisation,
    request,
    current,
  );
  if (request.kind !== "adjust_offer_price" || current.kind !== "offer")
    return { title, fromPriceMinor: null, allowedRange: null };
  const allowance = await readOfferPriceAllowanceView(
    input.env,
    input.execution.scope,
    requireSessionExecution.bind(null, input.execution, input.lease),
    admittedSessionOperation(
      input.execution,
      input.lease,
      input.env.COMMERCE.fetch.bind(input.env.COMMERCE),
    ),
    request.offerId,
  ).catch(() => null);
  return {
    title,
    fromPriceMinor: current.projection.price.amountMinor,
    allowedRange: allowance?.allowedRange ?? null,
  };
}

async function proposalProductTitle(
  input: AgentProposalInput,
  organisation: OrganisationActorStub,
  request: CommerceActionRequest,
  current: CommerceProjection,
): Promise<string | null> {
  const organisationId = input.execution.scope.organisationId;
  let productId: string | null = null;
  if (
    request.kind === "publish_catalog_listing" ||
    request.kind === "update_product_description"
  )
    productId = request.productId;
  else if (current.kind === "offer") {
    const variant = await organisation.readCurrentCommerceProjection({
      organisationId,
      kind: "sellable_variant",
      canonicalId: current.projection.variantId,
    });
    if (variant.ok && variant.value?.kind === "sellable_variant")
      productId = variant.value.projection.productId;
  }
  if (productId === null) return null;
  const product = await organisation.readCurrentCommerceProjection({
    organisationId,
    kind: "product",
    canonicalId: productId,
  });
  await requireSessionExecution(input.execution, input.lease);
  if (!product.ok || product.value?.kind !== "product") return null;
  return sessionObservedCommerceEntity({
    sql: input.storage.sql,
    organisationId: String(organisationId),
    sessionId: String(input.assignment.sessionId),
    entityType: "product",
    entityId: productId,
    revision: commerceProjectionRevision(product.value),
  })
    ? product.value.projection.title
    : null;
}

type AgentProposalInput = SessionToolContext;

/**
 * Records one agent proposal in its Case and the action ledger, and waits for
 * the approval. The caller has checked the target and the commerce authority.
 */
async function recordCommerceProposal(
  input: AgentProposalInput,
  origin: CommerceActionProposalOrigin | undefined,
  shared: Readonly<{
    organisation: OrganisationActorStub;
    request: CommerceActionRequest;
    integrationAccountId: IntegrationAccountId;
    commerceAuthority: CommerceSystemProviderAuthority;
    provenance: SourceProvenance | null;
    resourceId: string;
    changeFacts: CommerceChangeFacts;
    buildDraft: (
      actionNow: number,
    ) => Promise<
      Result<CanonicalActionDraft, CommerceCancellationDraftError>
    >;
  }>,
) {
  const caseId = parseCaseId(String(input.assignment.caseId));
  if (!caseId.ok) throw new Error("commerce proposal Case identity is invalid");
  const sessionId = parseSessionId(String(input.assignment.sessionId));
  if (!sessionId.ok)
    throw new Error("commerce proposal session identity is invalid");
  const caseActor = await resolveActiveCaseActor({
    env: input.env,
    namespace: input.env.CASE,
    organisationId: input.execution.scope.organisationId,
    caseId: caseId.value,
    now: Date.now(),
  });
  if (!caseActor.ok)
    throw new Error(
      `commerce proposal Case unavailable: ${caseActor.error.code}`,
    );
  await requireSessionExecution(input.execution, input.lease);
  const inspected = await caseActor.value.inspect();
  await requireSessionExecution(input.execution, input.lease);
  if (!inspected.ok)
    throw new Error(
      `commerce proposal Case unavailable: ${inspected.error.code}`,
    );
  const proposalDigest = await sha256Hex(JSON.stringify(shared.request));
  const proposalId = `proposal_agent_${input.assignment.assignmentId}_${proposalDigest.slice(0, 24)}`;
  const actionNow = Date.now();
  const draft = await shared.buildDraft(actionNow);
  if (!draft.ok)
    throw new Error(`commerce proposal draft invalid: ${draft.error.code}`);
  const requiredCapability: ProviderCapabilityDefinition = {
    kind: "provider_resource",
    capabilityId: "commerce.action.propose",
    capabilityVersion: 1,
    integrationAccountId: shared.integrationAccountId,
    resourceScope: draft.value.resourceKey,
  };
  const providerAuthority = await authorizeCapabilityUse({
    db: input.execution.scope.database,
    accountAccess: input.execution.scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      input.lease.session.sessionId,
      input.lease.turn.turnId,
    ),
    action: "execute",
    organisationId: input.execution.scope.organisationId,
    authority: input.lease.requestAuthority,
    authorityPartition: input.assignment.authorityPartition,
    request: { capabilities: [requiredCapability] },
  });
  if (!providerAuthority.ok) {
    throw new Error(
      `commerce proposal authority rejected: ${providerAuthority.error.code}`,
    );
  }
  const informationFlow = await readPersistedSessionTurnFlowBinding(
    input.storage.sql,
    {
      organisationId: String(input.execution.scope.organisationId),
      sessionId: String(input.assignment.sessionId),
      turnId: String(input.lease.turn.turnId),
    },
  );
  if (
    !informationFlow.ok ||
    informationFlow.value === null ||
    informationFlow.value.authorityPartitionDigest !==
      input.lease.authorityPartitionDigest
  ) {
    throw new Error("commerce proposal information-flow binding unavailable");
  }
  const flowBinding = informationFlow.value.binding.toJSON();
  await requireSessionExecution(input.execution, input.lease);
  const accepted = await caseActor.value.acceptCommerceProposal({
    execution: sessionActionMutationExecution(
      input.execution.scope,
      input.lease,
    ),
    proposal: {
      proposalId,
      caseId: caseId.value,
      // An assignment keeps its first start across the turns of a thread, so
      // the proposal rests on the Case as this turn reads it, not as the
      // assignment first saw it. Each commerce record is still checked
      // against its current revision.
      basedOnRevision: inspected.value.revision,
      requestAuthority: input.lease.requestAuthority,
      action: shared.request,
      authority: {
        kind: "commerce_system",
        system: shared.commerceAuthority.commerceSystem.kind,
        revision: shared.commerceAuthority.commerceSystem.revision,
        integrationAccountId: shared.commerceAuthority.integrationAccountId,
      },
      provenance: shared.provenance,
      origin: {
        kind: "agent_session",
        sessionId: String(input.assignment.sessionId),
        assignmentId: String(input.assignment.assignmentId),
        threadId: String(input.assignment.caseId),
      },
    },
    acceptedAt: actionNow,
    flowBinding,
    ...(origin === undefined ? {} : { toolCallId: origin.toolCallId }),
    turnId: String(input.lease.turn.turnId),
  });
  await requireSessionExecution(input.execution, input.lease);
  if (!accepted.ok)
    throw new Error(`commerce proposal rejected: ${accepted.error.code}`);
  await requireSessionExecution(input.execution, input.lease);
  const ledger = await shared.organisation.proposeAction({
    execution: sessionActionMutationExecution(
      input.execution.scope,
      input.lease,
    ),
    organisationId: input.execution.scope.organisationId,
    integrationAccountId: shared.integrationAccountId,
    requestAuthority: input.lease.requestAuthority,
    authorityPartition: input.assignment.authorityPartition,
    authority: {
      kind: "commerce_system",
      system: shared.commerceAuthority.commerceSystem.kind,
      revision: shared.commerceAuthority.commerceSystem.revision,
    },
    caseId: caseId.value,
    proposalId,
    sessionId: sessionId.value,
    threadId: String(input.assignment.caseId),
    draft: draft.value,
    flowBinding: accepted.value.flowBinding,
    exp: actionNow + 15 * 60_000,
    now: actionNow,
  });
  if (!ledger.ok)
    throw new Error(`commerce proposal ledger rejected: ${ledger.error.code}`);
  const nonce = ledger.value.action.nonce.value;
  await requireSessionExecution(input.execution, input.lease);
  const address = await readOrganisationDefaultWorkspacePortalAddress({
    db: input.execution.scope.database,
    organisationId: input.execution.scope.organisationId,
  });
  await requireSessionExecution(input.execution, input.lease);
  const portalUrl = address.ok
    ? commerceApprovalCardTexts.use().portalUrl(input.env, address.value, nonce)
    : null;
  const waiting = await caseActor.value.waitForCommerceApproval({
    execution: sessionActionMutationExecution(
      input.execution.scope,
      input.lease,
    ),
    caseId: caseId.value,
    proposalId,
    actionNonce: nonce,
    expectedCaseRevision: accepted.value.revision,
    requestedAt: actionNow,
    // A Slack thread gets this notice whatever the agent writes.
    notice: {
      kind: "text",
      text: commerceApprovalCardTexts
        .use()
        .waitingCardText(
          commerceApprovalCardTexts
            .use()
            .changeSummary(shared.request, shared.changeFacts),
          slackMayApproveAction(ledger.value.action),
        ),
    },
  });
  await requireSessionExecution(input.execution, input.lease);
  if (!waiting.ok)
    throw new Error(`commerce approval wait rejected: ${waiting.error.code}`);
  let cardPosted = false;
  if (waiting.value.notice?.kind === "pending") {
    const delivered = await deliverCommerceCaseOutput({
      env: input.env,
      scope: input.execution.scope,
      caseActor: caseActor.value,
      output: waiting.value.notice.output,
      authority: {
        organisationId: input.execution.scope.organisationId,
        sessionId: String(input.lease.session.sessionId),
        executionId: String(input.lease.turn.turnId),
        requestAuthority: input.lease.requestAuthority,
        authorityPartitionDigest: input.lease.authorityPartitionDigest,
      },
      now: Date.now(),
    });
    cardPosted =
      delivered.ok &&
      (delivered.value.kind === "delivered" ||
        delivered.value.kind === "already_settled");
    // The proposal stands without its notice; the agent still gives the
    // link in its reply.
    if (!delivered.ok)
      traceWarn("commerce.approval_notice_undelivered", {
        requestId: newRequestId(),
        organisation_id: String(input.execution.scope.organisationId),
        action_nonce: nonce,
        code: delivered.error.code,
      });
  }
  await requireSessionExecution(input.execution, input.lease);
  return {
    kind: "commerce_action_proposed",
    caseId: String(caseId.value),
    proposalId,
    caseRevision: waiting.value.revision,
    state: ledger.value.state,
    nonce,
    resourceId: shared.resourceId,
    approval: cardPosted
      ? {
          portalUrl: null,
          instruction:
            `The thread now shows an approval card with this change and its buttons. Do not repeat the change's details, give a link or say who must approve it. ${CARD_ONLY_REPLY_INSTRUCTION}`,
        }
      : portalUrl !== null
        ? {
            portalUrl,
            instruction:
              "Tell the person in one or two sentences what the proposal changes and that nothing changes before an owner or admin approves it. End with portalUrl as a Markdown link: a Portal chat shows it as an approval card with an Approve and apply button. Do not tell the person to open a link or a page.",
          }
        : {
            portalUrl: null,
            instruction:
              "Tell the person in one or two sentences what the proposal changes, and that an owner or admin approves it under Operations in the Portal. Nothing changes before the approval.",
          },
  };
}

/**
 * The records a proposal must have observed before it can target them.
 *
 * Each entry is one commerce entity the action will act on, named at the
 * revision the proposal binds. The commerce entity type names match the read
 * surface's, so an observed record and a proposed target are comparable.
 */
function commerceProposalObservedTargets(
  request: CommerceActionRequest,
): readonly CommerceObservationEntity[] {
  if (
    request.kind === "install_merchant_plugin" ||
    request.kind === "publish_cafe_menu" ||
    request.kind === "change_menu_price" ||
    request.kind === "refund_order" ||
    request.kind === "stock_operation" ||
    request.kind === "submit_supplier_payout" ||
    request.kind === "resume_supplier_payout_funding"
  ) {
    // A plugin or a payout observes no commerce entity. A plugin binds the
    // version and installation revision that Commerce reported; a payout
    // binds its own revision and the digest of the approved economics.
    return [];
  }
  switch (request.kind) {
    case "publish_catalog_listing":
      return [
        {
          entityType: "product",
          entityId: request.productId,
          revision: request.productRevision,
        },
        {
          entityType: "sellable_variant",
          entityId: request.variantId,
          revision: request.variantRevision,
        },
        {
          entityType: "offer",
          entityId: request.offerId,
          revision: request.offerRevision,
        },
        {
          entityType: "sales_channel",
          entityId: request.salesChannelId,
          revision: request.salesChannelRevision,
        },
      ];
    case "update_product_description":
      return [
        {
          entityType: "product",
          entityId: request.productId,
          revision: request.productRevision,
        },
      ];
    case "cancel_order":
      return [
        {
          entityType: "order",
          entityId: request.resourceId,
          revision: request.expectedRevision,
        },
      ];
    case "attach_tracking":
      return [
        {
          entityType: "fulfillment",
          entityId: request.fulfillmentId,
          revision: request.fulfillmentRevision,
        },
        {
          entityType: "shipment",
          entityId: request.shipmentId,
          revision: request.shipmentRevision,
        },
      ];
    case "adjust_offer_price":
      return [
        {
          entityType: "offer",
          entityId: request.offerId,
          revision: request.expectedOfferRevision,
        },
      ];
  }
}

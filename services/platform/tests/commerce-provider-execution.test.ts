import { requireOrganisationId, requireIntegrationAccountId } from "./test-ids";
/// <reference types="@cloudflare/workers-types" />

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommerceProjection, RequestAuthority } from "@seams/contracts";

const accountMocks = vi.hoisted(() => ({
  resolveActiveProviderAccountContext: vi.fn(),
}));
const shopifyMocks = vi.hoisted(() => ({
  reconcileShopifyOrderCancellation: vi.fn(),
  resolveShopifyWriteCredential: vi.fn(),
  resolveShopifyWriteCredentialForAction: vi.fn(),
  executeShopifyAction: vi.fn(),
}));
const commerceEngineMocks = vi.hoisted(() => ({
  resolveCommerceMerchantBinding: vi.fn(),
  createCommerceClient: vi.fn(),
  reconcileCommerceCatalogPublication: vi.fn(),
  publishCatalogListingThroughCommerce: vi.fn(),
  adjustOfferPriceThroughCommerce: vi.fn(),
}));
const commerceSystemMocks = vi.hoisted(() => ({
  resolveOrganisationCommerceSystemAuthority: vi.fn(),
}));

vi.mock("../src/data/integration-account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/integration-account")>()),
  resolveActiveProviderAccountContext:
    accountMocks.resolveActiveProviderAccountContext,
}));
vi.mock("../src/shopify/action-execution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shopify/action-execution")>()),
  reconcileShopifyOrderCancellation:
    shopifyMocks.reconcileShopifyOrderCancellation,
  resolveShopifyWriteCredential: shopifyMocks.resolveShopifyWriteCredential,
  resolveShopifyWriteCredentialForAction:
    shopifyMocks.resolveShopifyWriteCredentialForAction,
  executeShopifyAction: shopifyMocks.executeShopifyAction,
}));
vi.mock("../src/data/commerce-merchant-binding", () => ({
  resolveCommerceMerchantBinding:
    commerceEngineMocks.resolveCommerceMerchantBinding,
}));
vi.mock("../src/commerce/outbox-worker", () => ({
  createCommerceClient: commerceEngineMocks.createCommerceClient,
}));
vi.mock("../src/commerce/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commerce/provider")>()),
  reconcileCommerceCatalogPublication:
    commerceEngineMocks.reconcileCommerceCatalogPublication,
  publishCatalogListingThroughCommerce:
    commerceEngineMocks.publishCatalogListingThroughCommerce,
  adjustOfferPriceThroughCommerce:
    commerceEngineMocks.adjustOfferPriceThroughCommerce,
}));
vi.mock("../src/data/organisation-commerce-system", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/data/organisation-commerce-system")
  >()),
  resolveOrganisationCommerceSystemAuthority:
    commerceSystemMocks.resolveOrganisationCommerceSystemAuthority,
}));

import {
  executeCommerceProviderAction,
  reconcileCommerceProviderAction,
} from "../src/commerce/provider-execution";
import type {
  ActionLedgerEntry,
  ExecutingActionLedgerEntry,
} from "../src/actors/action-ledger";
import {
  parseApprovalProofDigest,
  type ApprovalEvidence,
} from "../src/approval-authentication";
import { parseCommerceSystemRevision } from "../src/data/organisation-commerce-system";
import {
  parseCaseId,
  parseUserId,
  parseControlSessionId,
  parseIntegrationAccountId,
  parsePersonId,
  parseSessionId,
  parseOrganisationId,
} from "../src/ids";
import {
  realProviderActionAuthority,
  realProviderExecutionFixture,
} from "./real-provider-execution-fixture";
import {
  audiencesForDestination,
  flowBindingForContext,
  FlowLabel,
  InformationFlowContext,
  type FlowAudience,
  type SerializedFlowBinding,
} from "../src/policy";
import type { Variant, VariantBy } from "@seams/type-utils";

const NOW = Date.parse("2026-08-04T00:00:00.000Z");

describe("commerce provider dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commerceSystemMocks.resolveOrganisationCommerceSystemAuthority.mockResolvedValue(
      commerceAuthority("shopify", "integration_shopify_dispatch"),
    );
  });

  it("keeps OAC independent from the capability to cancel an order", async () => {
    accountMocks.resolveActiveProviderAccountContext.mockResolvedValue({
      ok: true,
      value: {
        account: {
          provider: "shopify",
          providerAccountId: "fixture.myshopify.com",
        },
        connection: { lifecycle: { kind: "active" } },
      },
    });
    shopifyMocks.resolveShopifyWriteCredentialForAction.mockResolvedValue({
      ok: true,
      value: {
        shopDomain: "fixture.myshopify.com",
        accessToken: "shopify-test-token-42",
        expiresAt: NOW + 60_000,
        scopes: ["write_orders"],
        webhookSigningSecret: "shopify-secret",
      },
    });
    shopifyMocks.executeShopifyAction.mockResolvedValue({
      ok: true,
      value: {
        kind: "confirmed",
        actionKind: "shopify_order_cancel",
        provider: "shopify",
        statusCode: 200,
        orderId: "gid://shopify/Order/42",
        jobId: null,
        jobDone: true,
      },
    });
    const action = await executingAction();
    const flowBinding = await organisationFlowBinding(action);
    const result = await executeCommerceProviderAction({
      ...(await providerFixture(action.action.integrationAccountId)),
      action: { ...action, action: { ...action.action, flowBinding } },
      current: orderProjection(),
      now: NOW,
      fetcher: fetch,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { kind: "provider_receipt" },
    });
  });

  it("keeps unsupported provider projections out of the Shopify adapter", async () => {
    const action = await executingAction();
    const result = await executeCommerceProviderAction({
      ...(await providerFixture(action.action.integrationAccountId)),
      action,
      current: {
        ...orderProjection(),
        projection: {
          ...orderProjection().projection,
          provenance: {
            ...orderProjection().projection.provenance,
            source: "stripe",
          },
        },
      },
      now: NOW,
      fetcher: fetch,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "commerce_action_authority_rebase_required" },
    });
    expect(shopifyMocks.executeShopifyAction).not.toHaveBeenCalled();
  });

  it("reports a refused price change as a failed execution rather than a receipt", async () => {
    commerceSystemMocks.resolveOrganisationCommerceSystemAuthority.mockResolvedValue(
      commerceAuthority("underclerk", "integration_underclerk_dispatch"),
    );
    commerceEngineMocks.resolveCommerceMerchantBinding.mockResolvedValue({
      ok: true,
      value: { merchantId: "merchant_cafe" },
    });
    commerceEngineMocks.createCommerceClient.mockReturnValue({
      kind: "underclerk_client",
    });
    commerceEngineMocks.adjustOfferPriceThroughCommerce.mockResolvedValue({
      status: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "offerPrice.offer_price_movement_exceeded",
      },
    });

    const action = await executingOfferPriceAction();
    const result = await executeCommerceProviderAction({
      ...(await providerFixture(action.action.integrationAccountId)),
      action,
      current: offerProjection(),
      now: NOW,
      fetcher: fetch,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "commerce_action_provider_execution_failed" },
    });
  });

  it("does not dispatch a provider effect when projection preflight is missing", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const action = await executingAction();
    const result = await executeCommerceProviderAction({
      ...(await providerFixture(action.action.integrationAccountId)),
      action,
      current: null,
      now: NOW,
      fetcher,
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "commerce_action_projection_missing" },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(shopifyMocks.executeShopifyAction).not.toHaveBeenCalled();
  });

  it("does not dispatch after the projection integration identity changes", async () => {
    commerceSystemMocks.resolveOrganisationCommerceSystemAuthority.mockResolvedValue(
      commerceAuthority("underclerk", "integration_underclerk_dispatch"),
    );
    const projection = offerProjection();
    const action = await executingListingAction();
    const result = await executeCommerceProviderAction({
      ...(await providerFixture(action.action.integrationAccountId)),
      action,
      current: {
        ...projection,
        projection: {
          ...projection.projection,
          provenance: {
            ...projection.projection.provenance,
            integrationAccountId: "integration_underclerk_replaced",
          },
        },
      },
      now: NOW,
      fetcher: fetch,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "commerce_action_provider_unsupported" },
    });
    expect(
      commerceEngineMocks.publishCatalogListingThroughCommerce,
    ).not.toHaveBeenCalled();
  });

  it("revalidates the live grant set before credentials or provider fetch", async () => {
    const action = await executingAction();
    const fetcher = vi.fn<typeof fetch>();
    const result = await executeCommerceProviderAction({
      ...(await providerFixture(action.action.integrationAccountId, false)),
      action,
      current: orderProjection(),
      now: NOW,
      fetcher,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "commerce_action_authority_superseded" },
    });
    expect(
      shopifyMocks.resolveShopifyWriteCredentialForAction,
    ).not.toHaveBeenCalled();
    expect(shopifyMocks.executeShopifyAction).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("denies a Shopify effect when its destination cannot receive the observed orders", async () => {
    const action = await executingAction();
    const flowBinding = await providerFlowBinding(
      action.action.organisationId,
      action.action.sessionId,
      action.action.requestAuthority,
      action.action.authorityPartition.digest,
      action.action.integrationAccountId,
      [
        {
          kind: "conversation",
          integrationAccountId: action.action.integrationAccountId,
          conversationId: "conversation_unrelated",
        },
      ],
    );
    const result = await executeCommerceProviderAction({
      ...(await providerFixture(action.action.integrationAccountId)),
      action: { ...action, action: { ...action.action, flowBinding } },
      current: orderProjection(),
      now: NOW,
      fetcher: fetch,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "commerce_action_flow_denied" },
    });
    expect(
      shopifyMocks.resolveShopifyWriteCredentialForAction,
    ).not.toHaveBeenCalled();
    expect(shopifyMocks.executeShopifyAction).not.toHaveBeenCalled();
  });

  it("does not admit the Underclerk service credential before the flow gate", async () => {
    commerceSystemMocks.resolveOrganisationCommerceSystemAuthority.mockResolvedValue(
      commerceAuthority("underclerk", "integration_underclerk_dispatch"),
    );
    commerceEngineMocks.resolveCommerceMerchantBinding.mockResolvedValue({
      ok: true,
      value: { merchantId: "merchant_cafe" },
    });
    const action = await executingListingAction();
    const flowBinding = await providerFlowBinding(
      action.action.organisationId,
      action.action.sessionId,
      action.action.requestAuthority,
      action.action.authorityPartition.digest,
      action.action.integrationAccountId,
      [
        {
          kind: "conversation",
          integrationAccountId: action.action.integrationAccountId,
          conversationId: "conversation_unrelated",
        },
      ],
    );
    const result = await executeCommerceProviderAction({
      ...(await providerFixture(action.action.integrationAccountId)),
      action: { ...action, action: { ...action.action, flowBinding } },
      current: offerProjection(),
      now: NOW,
      fetcher: fetch,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "commerce_action_flow_denied" },
    });
    expect(commerceEngineMocks.createCommerceClient).not.toHaveBeenCalled();
    expect(
      commerceEngineMocks.publishCatalogListingThroughCommerce,
    ).not.toHaveBeenCalled();
  });

  it("permits an Underclerk retry only after the exact idempotency receipt is absent", async () => {
    commerceSystemMocks.resolveOrganisationCommerceSystemAuthority.mockResolvedValue(
      commerceAuthority("underclerk", "integration_underclerk_dispatch"),
    );
    commerceEngineMocks.resolveCommerceMerchantBinding.mockResolvedValue({
      ok: true,
      value: { merchantId: "merchant_cafe" },
    });
    commerceEngineMocks.createCommerceClient.mockReturnValue({
      kind: "underclerk_client",
    });
    commerceEngineMocks.reconcileCommerceCatalogPublication.mockResolvedValue({
      kind: "absent",
    });
    const action = indeterminateAction(await executingListingAction());
    const result = await reconcileCommerceProviderAction({
      ...(await providerFixture(action.action.integrationAccountId)),
      action,
      current: offerProjection(),
      now: NOW + 1_000,
      fetcher: fetch,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "retryable",
        evidence: {
          kind: "provider_idempotency_absent",
          integrationAccountId: action.action.integrationAccountId,
          idempotencyKey: action.idempotencyKey,
          observedAt: NOW + 1_000,
        },
      },
    });
  });

  it("settles Shopify from cancellation evidence and never retries an active order", async () => {
    accountMocks.resolveActiveProviderAccountContext.mockResolvedValue({
      ok: true,
      value: {
        account: {
          provider: "shopify",
          providerAccountId: "fixture.myshopify.com",
        },
        connection: { lifecycle: { kind: "active" } },
      },
    });
    shopifyMocks.resolveShopifyWriteCredential.mockResolvedValue({
      ok: true,
      value: {
        shopDomain: "fixture.myshopify.com",
        accessToken: "shopify-test-token-42",
      },
    });
    shopifyMocks.reconcileShopifyOrderCancellation.mockResolvedValue({
      ok: true,
      value: {
        kind: "cancelled",
        provider: "shopify",
        orderId: "gid://shopify/Order/42",
        cancelledAt: "2026-08-04T00:00:01.000Z",
        cancelReason: "CUSTOMER",
      },
    });
    const action = indeterminateAction(await executingAction());
    const settled = await reconcileCommerceProviderAction({
      ...(await providerFixture(action.action.integrationAccountId)),
      action,
      current: orderProjection(),
      now: NOW + 1_000,
      fetcher: fetch,
    });
    expect(settled).toMatchObject({
      ok: true,
      value: {
        kind: "settled",
        receipt: { provider: "shopify", status: "accepted" },
      },
    });

    shopifyMocks.reconcileShopifyOrderCancellation.mockResolvedValue({
      ok: true,
      value: {
        kind: "not_cancelled",
        provider: "shopify",
        orderId: "gid://shopify/Order/42",
      },
    });
    const unresolved = await reconcileCommerceProviderAction({
      ...(await providerFixture(action.action.integrationAccountId)),
      action,
      current: orderProjection(),
      now: NOW + 2_000,
      fetcher: fetch,
    });
    expect(unresolved).toEqual({ ok: true, value: { kind: "unresolved" } });
    expect(shopifyMocks.executeShopifyAction).not.toHaveBeenCalled();
  });
});

function indeterminateAction(
  action: ExecutingActionLedgerEntry,
): VariantBy<ActionLedgerEntry, "state", "indeterminate"> {
  return {
    state: "indeterminate",
    action: action.action,
    caseId: action.caseId,
    proposalId: action.proposalId,
    commerceEffect: null,
    approval: action.approval,
    idempotencyKey: action.idempotencyKey,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

async function executingAction(): Promise<ExecutingActionLedgerEntry> {
  const organisationId = parseOrganisationId("organisation_provider_dispatch");
  const integrationAccountId = parseIntegrationAccountId(
    "integration_shopify_dispatch",
  );
  const sessionId = parseSessionId("session_provider_dispatch");
  const caseId = parseCaseId("case_provider_dispatch");
  if (
    !organisationId.ok ||
    !integrationAccountId.ok ||
    !sessionId.ok ||
    !caseId.ok
  )
    throw new Error("invalid provider dispatch fixture");
  const authority = realProviderActionAuthority({
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    providerResourceScope: "commerce:cancel_order:order_shopify_42",
  });
  const flowBinding = await providerFlowBinding(
    organisationId.value,
    sessionId.value,
    authority.requestAuthority,
    authority.authorityPartition.digest,
    integrationAccountId.value,
  );
  return {
    state: "executing",
    action: {
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      requestAuthority: authority.requestAuthority,
      authorityPartition: authority.authorityPartition,
      authority: {
        kind: "commerce_system",
        system: "shopify",
        revision: requiredCommerceSystemRevision(),
      },
      sessionId: sessionId.value,
      threadId: "case_provider_dispatch",
      host: "satyr.commerce",
      verb: "commerce.order.cancel",
      path: "/orders/order_shopify_42/cancel?expected_revision=3&reason=customer_requested&refund=full&restock=true&notify_customer=true&note=Customer%20requested%20cancellation.",
      argsHash: "commerce-args-hash",
      amount: null,
      nonce: { value: "98ed03e0-f1bd-4f5e-9dd5-b7334332fbac" },
      exp: NOW + 60_000,
      resourceKey: "commerce:cancel_order:order_shopify_42",
      flowBinding,
    },
    caseId: caseId.value,
    proposalId: "proposal_provider_dispatch",
    commerceEffect: null,
    approval: approvalEvidence(),
    executionLease: {
      leaseId: "lease_provider_dispatch",
      expiresAt: NOW + 30_000,
    },
    idempotencyKey: "provider-dispatch-idempotency",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function commerceAuthority(
  provider: "underclerk" | "shopify",
  integrationAccountIdRaw: string,
) {
  const organisationId = parseOrganisationId("organisation_provider_dispatch");
  const integrationAccountId = parseIntegrationAccountId(
    integrationAccountIdRaw,
  );
  if (!organisationId.ok || !integrationAccountId.ok)
    throw new Error("invalid commerce authority fixture");
  const revision = requiredCommerceSystemRevision();
  return {
    ok: true,
    value: {
      commerceSystem:
        provider === "underclerk"
          ? {
              kind: "satyr_commerce",
              organisationId: organisationId.value,
              bindingId: "underclerk_binding_dispatch",
              merchantId: "merchant_cafe",
              revision,
            }
          : {
              kind: "shopify",
              organisationId: organisationId.value,
              integrationAccountId: integrationAccountId.value,
              shopDomain: "fixture.myshopify.com",
              revision,
            },
      provider,
      integrationAccountId: integrationAccountId.value,
    },
  };
}

function requiredCommerceSystemRevision() {
  const parsed = parseCommerceSystemRevision(1);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

async function executingListingAction(): Promise<ExecutingActionLedgerEntry> {
  const integrationAccountId = parseIntegrationAccountId(
    "integration_underclerk_dispatch",
  );
  if (!integrationAccountId.ok) throw new Error("invalid Underclerk fixture");
  const base = await executingAction();
  const providerResourceScope =
    "commerce:publish_catalog_listing:underclerk:merchant_cafe:offer_coffee";
  const authority = realProviderActionAuthority({
    organisationId: base.action.organisationId,
    integrationAccountId: integrationAccountId.value,
    providerResourceScope,
  });
  const flowBinding = await providerFlowBinding(
    base.action.organisationId,
    base.action.sessionId,
    authority.requestAuthority,
    authority.authorityPartition.digest,
    integrationAccountId.value,
  );
  return {
    ...base,
    action: {
      ...base.action,
      authority: {
        kind: "commerce_system",
        system: "satyr_commerce",
        revision: requiredCommerceSystemRevision(),
      },
      integrationAccountId: integrationAccountId.value,
      requestAuthority: authority.requestAuthority,
      authorityPartition: authority.authorityPartition,
      flowBinding,
      verb: "commerce.catalog.publish",
      path: "/catalog/underclerk%3Amerchant_cafe%3Aoffer_coffee/listing?expected_revision=1&product_id=underclerk%3Amerchant_cafe%3Aproduct_coffee&product_revision=1&variant_id=underclerk%3Amerchant_cafe%3Avariant_coffee&variant_revision=1&offer_revision=1&sales_channel_id=underclerk%3Amerchant_cafe%3Achannel_online&sales_channel_revision=1",
      resourceKey:
        "commerce:publish_catalog_listing:underclerk:merchant_cafe:offer_coffee",
    },
  };
}

async function executingOfferPriceAction(): Promise<ExecutingActionLedgerEntry> {
  const integrationAccountId = parseIntegrationAccountId(
    "integration_underclerk_dispatch",
  );
  if (!integrationAccountId.ok) throw new Error("invalid Underclerk fixture");
  const base = await executingAction();
  const providerResourceScope =
    "commerce:adjust_offer_price:underclerk:merchant_cafe:offer_coffee";
  const authority = realProviderActionAuthority({
    organisationId: base.action.organisationId,
    integrationAccountId: integrationAccountId.value,
    providerResourceScope,
  });
  const flowBinding = await providerFlowBinding(
    base.action.organisationId,
    base.action.sessionId,
    authority.requestAuthority,
    authority.authorityPartition.digest,
    integrationAccountId.value,
  );
  return {
    ...base,
    action: {
      ...base.action,
      authority: {
        kind: "commerce_system",
        system: "satyr_commerce",
        revision: requiredCommerceSystemRevision(),
      },
      integrationAccountId: integrationAccountId.value,
      requestAuthority: authority.requestAuthority,
      authorityPartition: authority.authorityPartition,
      flowBinding,
      verb: "commerce.offer.adjust_price",
      path: "/offers/underclerk%3Amerchant_cafe%3Aoffer_coffee/price?expected_revision=1&expected_policy_revision=3&proposed_price_minor=450&currency=USD",
      resourceKey: providerResourceScope,
    },
  };
}

async function providerFlowBinding(
  organisationId: string,
  sessionId: string,
  requestAuthority: RequestAuthority,
  authorityPartitionDigest: string,
  integrationAccountId: string,
  readers: readonly FlowAudience[] = audiencesForDestination(requestAuthority),
): Promise<SerializedFlowBinding> {
  const label = await FlowLabel.create([
    {
      owner: {
        kind: "integration_resource",
        organisationId,
        integrationAccountId,
        resourceScope: "commerce:orders",
      },
      readers,
    },
  ]);
  if (!label.ok) throw new Error(label.error.code);
  const context = await InformationFlowContext.fromState({
    organisationId,
    sessionId,
    authorityPartitionDigest,
    workLabel: label.value,
    observationDigests: [],
    revision: 0,
  });
  if (!context.ok) throw new Error(context.error.code);
  return flowBindingForContext(context.value, "turn_provider_flow").toJSON();
}

async function organisationFlowBinding(
  action: ExecutingActionLedgerEntry,
): Promise<SerializedFlowBinding> {
  const label = await FlowLabel.create([
    {
      owner: {
        kind: "organisation",
        organisationId: action.action.organisationId,
      },
      readers: audiencesForDestination(action.action.requestAuthority),
    },
  ]);
  if (!label.ok) throw new Error(label.error.code);
  const context = await InformationFlowContext.fromState({
    organisationId: action.action.organisationId,
    sessionId: action.action.sessionId,
    authorityPartitionDigest: action.action.authorityPartition.digest,
    workLabel: label.value,
    observationDigests: [],
    revision: 0,
  });
  if (!context.ok) throw new Error(context.error.code);
  return flowBindingForContext(
    context.value,
    "turn_organisation_flow",
  ).toJSON();
}

function approvalEvidence(): ApprovalEvidence {
  const userId = parseUserId("user_e6efaaf9-70d3-5996-ad3e-86392019f2be");
  const controlSessionId = parseControlSessionId(
    "control_session_provider_dispatch",
  );
  const personId = parsePersonId("person_provider_dispatch");
  const organisationId = parseOrganisationId("organisation_provider_dispatch");
  const actionDigest = parseApprovalProofDigest("00".repeat(32));
  if (
    !userId.ok ||
    !controlSessionId.ok ||
    !personId.ok ||
    !organisationId.ok ||
    actionDigest === null
  ) {
    throw new Error("invalid approval fixture");
  }
  return {
    kind: "app_user",
    principal: {
      kind: "app_user",
      userId: userId.value,
      personId: personId.value,
      role: "owner",
    },
    authentication: {
      kind: "google_oidc_step_up",
      controlSessionId: controlSessionId.value,
      authenticatedAt: NOW,
      challenge: {
        stepUpId: "fixture:provider_dispatch",
        organisationId: organisationId.value,
        actionNonce: "action_provider_dispatch",
        actionDigest,
        policy: { kind: "unversioned_default" },
        issuedAt: NOW,
        expiresAt: NOW + 600_000,
      },
    },
  };
}

function orderProjection(): Variant<CommerceProjection, "commerce_order"> {
  return {
    kind: "commerce_order",
    projection: {
      provenance: {
        organisationId: "organisation_provider_dispatch",
        integrationAccountId: "integration_shopify_dispatch",
        source: "shopify",
        resourceType: "commerce_order",
        resourceId: "gid://shopify/Order/42",
        revision: 3,
        occurredAt: "2026-08-03T00:00:00.000Z",
        observedAt: "2026-08-03T00:00:00.000Z",
      },
      origin: {
        kind: "online",
        salesChannelId: "channel_shopify",
        storefrontId: "store_shopify",
        checkoutId: "gid://shopify/Checkout/42",
        configuration: { kind: "external_authority" },
      },
      buyer: { kind: "identified", customerReference: "customer-42" },
      lineItems: [],
      totals: {
        subtotal: { amountMinor: 1000, currency: "USD" },
        discount: { amountMinor: 0, currency: "USD" },
        tax: { amountMinor: 0, currency: "USD" },
        duty: { amountMinor: 0, currency: "USD" },
        shipping: { amountMinor: 0, currency: "USD" },
        serviceFee: { amountMinor: 0, currency: "USD" },
        tip: { amountMinor: 0, currency: "USD" },
        rounding: { amountMinor: 0, currency: "USD" },
        total: { amountMinor: 1000, currency: "USD" },
      },
      adjustments: [],
      lifecycle: {
        state: "confirmed",
        confirmedAt: "2026-08-03T00:00:00.000Z",
      },
    },
  };
}

function offerProjection(): Variant<CommerceProjection, "offer"> {
  return {
    kind: "offer",
    projection: {
      provenance: {
        organisationId: "organisation_provider_dispatch",
        integrationAccountId: "integration_underclerk_dispatch",
        source: "underclerk",
        resourceType: "offer",
        resourceId: "underclerk:merchant_cafe:offer_coffee",
        revision: 1,
        occurredAt: "2026-08-03T00:00:00.000Z",
        observedAt: "2026-08-03T00:00:00.000Z",
      },
      variantId: "underclerk:merchant_cafe:variant_coffee",
      salesChannelId: "underclerk:merchant_cafe:channel_online",
      price: { amountMinor: 500, currency: "USD" },
      availability: { state: "available" },
      lifecycle: { state: "prepared", preparedAt: "2026-08-03T00:00:00.000Z" },
    },
  };
}

async function providerFixture(
  integrationAccountId: string,
  grantActive = true,
) {
  return realProviderExecutionFixture({
    organisationId: requireOrganisationId("organisation_provider_dispatch"),
    integrationAccountId: requireIntegrationAccountId(integrationAccountId),
    capabilityId: "commerce.action.propose",
    resourceScope: "*",
    grantActive,
  });
}

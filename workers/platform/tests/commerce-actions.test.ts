/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";
import type { CommerceProjection } from "@purin-labs/commerce-contracts";

import {
  buildCommerceActionDraft,
  buildCommerceCancellationActionDraft,
  buildCommerceLabDelivery,
  commerceTrackingAttachmentTargetMatches,
  parseCommerceCancellationAuthority,
  reconcileCommerceProviderReceipt,
  parseCommerceActionPath,
  parseCommerceEntityPlaneActionPath,
  parseCommerceActionRequest,
} from "@purin-labs/area-commerce/server/action-model";
import { parseCommerceProviderReceipt } from "@purin-labs/area-commerce-contract/server/provider-receipts";
import type {
  CommerceActionPath,
  CommerceCancellationAuthority,
} from "@purin-labs/area-commerce/server/action-model";
import {
  beginActionExecution,
  createActionLedgerSchema,
  proposeAction,
  requestActionApproval,
  signAction,
  type LedgerCanonicalAction,
} from "@purin-labs/authority/actors/action-ledger";
import { COMMERCE_LAB_INTEGRATION_ACCOUNT_ID } from "@purin-labs/area-commerce/server/commerce-lab/lab-metadata";
import {
  parseApprovalProofDigest,
  type ApprovalEvidence,
} from "@purin-labs/authority/approval-authentication";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import {
  parseCaseId,
  parseControlSessionId,
  parseIntegrationAccountId,
  parsePersonId,
  parseSessionId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import { parseCommerceSystemRevision } from "@purin-labs/connections/data/organisation-commerce-system";
import {
  fixtureFlowBinding,
  fixtureProviderActionAuthority,
} from "./fixtures/plan25-turn";
import type { Variant } from "@purin-labs/type-utils";
import type { CommerceEngineProviderReceipt } from "@purin-labs/control-api";

const ORGANISATION_ID = "organisation_commerce_actions";
const OBSERVED_AT = "2026-08-04T00:00:00.000Z";

describe("commerce action contracts", () => {
  it("parses a strict reloadable entity-plane list-entry action path", () => {
    const action = {
      verb: "commerce.list_entry.patch",
      path: "/list-entries/entry_1/patch?list_id=export_coordination&expected_revision=3&expected_list_revision=1",
    };
    expect(parseCommerceEntityPlaneActionPath(action)).toEqual({
      ok: true,
      value: {
        kind: "patch_commerce_list_entry",
        entryId: "entry_1",
        listId: "export_coordination",
        expectedRevision: 3,
        expectedListRevision: 1,
      },
    });
    expect(
      parseCommerceEntityPlaneActionPath({
        ...action,
        path: `${action.path}&unexpected=true`,
      }),
    ).toEqual({ ok: false, error: { code: "commerce_action_path_invalid" } });
    expect(
      parseCommerceEntityPlaneActionPath({
        ...action,
        path: action.path.replace(
          "expected_revision=3",
          "expected_revision=3&expected_revision=4",
        ),
      }),
    ).toEqual({ ok: false, error: { code: "commerce_action_path_invalid" } });
  });

  it("builds a provider-neutral publish action and settles a lab event", async () => {
    const request = parseCommerceActionRequest({
      kind: "publish_catalog_listing",
      productId: "product_field_watch",
      productRevision: 1,
      variantId: "variant_field_watch_black",
      variantRevision: 1,
      offerId: "offer_field_watch_online",
      offerRevision: 1,
      salesChannelId: "sales_channel_online",
      salesChannelRevision: 1,
    });
    expect(request).toEqual({
      ok: true,
      value: {
        kind: "publish_catalog_listing",
        productId: "product_field_watch",
        productRevision: 1,
        variantId: "variant_field_watch_black",
        variantRevision: 1,
        offerId: "offer_field_watch_online",
        offerRevision: 1,
        salesChannelId: "sales_channel_online",
        salesChannelRevision: 1,
      },
    });
    if (!request.ok) throw new Error(request.error.code);

    const organisationId = requiredOrganisationId();
    const integrationAccountId = requiredIntegrationAccountId();
    const sessionId = requiredSessionId();
    const draft = await buildCommerceActionDraft({
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      sessionId,
      threadId: "thread_commerce_actions",
      request: request.value,
      current: offerProjection(integrationAccountId),
      exp: 2_000,
      now: 1_000,
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) throw new Error(draft.error.code);
    const authority = fixtureProviderActionAuthority({
      organisationId,
      integrationAccountId,
      providerResourceScope: draft.value.resourceKey,
    });

    const action: LedgerCanonicalAction = {
      organisationId,
      integrationAccountId,
      requestAuthority: authority.requestAuthority,
      authorityPartition: authority.authorityPartition,
      authority: {
        kind: "commerce_system",
        system: "builtin_commerce",
        revision: requiredCommerceSystemRevision(),
      },
      sessionId,
      threadId: "thread_commerce_actions",
      host: draft.value.host,
      verb: draft.value.verb,
      path: draft.value.path,
      argsHash: draft.value.argsHash,
      amount: null,
      nonce: { value: "00000000-0000-4000-8000-000000000001" },
      exp: 2_000,
      resourceKey: draft.value.resourceKey,
      flowBinding: fixtureFlowBinding({
        organisationId,
        sessionId,
        authorityPartitionDigest: authority.authorityPartition.digest,
      }),
    };
    const parsedPath = parseCommerceActionPath(action);
    expect(parsedPath).toMatchObject({ ok: true, value: request.value });

    const settled = await buildCommerceLabDelivery({
      action,
      current: offerProjection(integrationAccountId),
      now: Date.parse(OBSERVED_AT),
    });
    expect(settled).toMatchObject({
      ok: true,
      value: {
        delivery: {
          schemaVersion: 1,
          providerDeliveryId:
            "commerce_action_00000000-0000-4000-8000-000000000001",
          observations: [
            {
              projection: {
                kind: "offer",
                projection: {
                  lifecycle: { state: "listed", listedAt: OBSERVED_AT },
                  provenance: { revision: 2 },
                },
              },
            },
          ],
        },
        receipt: {
          provider: "lab",
          status: "settled",
          revision: 2,
        },
      },
    });
  });

  it("freezes an attach-tracking target and closes its fulfillment with ordinary evidence", async () => {
    const request = parseCommerceActionRequest({
      kind: "attach_tracking",
      batchId: `tracking_batch_${"0".repeat(64)}`,
      merchantRevision: 12,
      orderId: "order_1",
      fulfillmentId: "fulfillment_1",
      fulfillmentRevision: 4,
      shipmentId: "shipment_1",
      shipmentRevision: 7,
      trackingNumber: "JP123456789",
    });
    expect(request.ok).toBe(true);
    if (!request.ok || request.value.kind !== "attach_tracking") return;
    const organisationId = requiredOrganisationId();
    const integrationAccountId = requiredIntegrationAccountId();
    const sessionId = requiredSessionId();
    expect(
      commerceTrackingAttachmentTargetMatches({
        fulfillment: fulfillmentProjection(integrationAccountId, 4),
        shipment: shipmentProjection(integrationAccountId, 7, "JP123456789"),
        request: request.value,
      }),
    ).toBe(true);
    expect(
      commerceTrackingAttachmentTargetMatches({
        fulfillment: fulfillmentProjection(integrationAccountId, 4),
        shipment: shipmentProjection(integrationAccountId, 7, "JP000000000"),
        request: request.value,
      }),
    ).toBe(false);
    const draft = await buildCommerceActionDraft({
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      sessionId,
      threadId: "thread_tracking_attachment",
      request: request.value,
      current: fulfillmentProjection(integrationAccountId, 4),
      exp: 2_000,
      now: 1_000,
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const authority = fixtureProviderActionAuthority({
      organisationId,
      integrationAccountId,
      providerResourceScope: draft.value.resourceKey,
    });
    const action: LedgerCanonicalAction = {
      organisationId,
      integrationAccountId,
      requestAuthority: authority.requestAuthority,
      authorityPartition: authority.authorityPartition,
      authority: {
        kind: "commerce_system",
        system: "builtin_commerce",
        revision: requiredCommerceSystemRevision(),
      },
      sessionId,
      threadId: "thread_tracking_attachment",
      host: draft.value.host,
      verb: draft.value.verb,
      path: draft.value.path,
      argsHash: draft.value.argsHash,
      amount: null,
      nonce: { value: "00000000-0000-4000-8000-000000000010" },
      exp: 2_000,
      resourceKey: draft.value.resourceKey,
      flowBinding: fixtureFlowBinding({
        organisationId,
        sessionId,
        authorityPartitionDigest: authority.authorityPartition.digest,
      }),
    };
    expect(parseCommerceActionPath(action)).toEqual({
      ok: true,
      value: request.value,
    });

    const result = await buildCommerceLabDelivery({
      action,
      current: fulfillmentProjection(integrationAccountId, 4),
      now: Date.parse(OBSERVED_AT),
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        delivery: {
          observations: [
            {
              projection: {
                kind: "fulfillment",
                projection: {
                  lifecycle: {
                    state: "handed_to_carrier",
                    shipmentId: "shipment_1",
                    handedOverAt: OBSERVED_AT,
                  },
                  provenance: { revision: 5 },
                },
              },
            },
          ],
        },
        receipt: {
          provider: "lab",
          resourceId: "fulfillment_1",
          projectionKind: "fulfillment",
          revision: 5,
          status: "settled",
        },
      },
    });

    await expect(
      buildCommerceLabDelivery({
        action,
        current: fulfillmentProjection(integrationAccountId, 5),
        now: Date.parse(OBSERVED_AT),
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "commerce_action_revision_stale", expected: 4, actual: 5 },
    });
  });

  it("rejects stale revisions and malformed action requests", async () => {
    expect(
      parseCommerceActionRequest({
        kind: "cancel_order",
        resourceId: "order_1",
        expectedRevision: 1,
        reason: "customer_requested",
        refund: "none",
        restock: false,
        notifyCustomer: false,
        note: null,
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseCommerceActionRequest({
        kind: "cancel_order",
        resourceId: "order_1",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "commerce_action_invalid", field: "expectedRevision" },
    });

    const organisationId = requiredOrganisationId();
    const integrationAccountId = requiredIntegrationAccountId();
    const sessionId = requiredSessionId();
    const caseId = parseCaseId("case_commerce_recovery");
    if (!caseId.ok) throw new Error(caseId.error.code);
    const draft = await buildCommerceActionDraft({
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      sessionId,
      threadId: "thread_commerce_actions",
      request: {
        kind: "publish_catalog_listing",
        productId: "product_field_watch",
        productRevision: 1,
        variantId: "variant_field_watch_black",
        variantRevision: 1,
        offerId: "offer_field_watch_online",
        offerRevision: 1,
        salesChannelId: "sales_channel_online",
        salesChannelRevision: 1,
      },
      current: offerProjection(integrationAccountId),
      exp: 2_000,
      now: 1_000,
    });
    if (!draft.ok) throw new Error(draft.error.code);
    const authority = fixtureProviderActionAuthority({
      organisationId,
      integrationAccountId,
      providerResourceScope: draft.value.resourceKey,
    });
    const stale = await buildCommerceLabDelivery({
      action: {
        organisationId,
        integrationAccountId,
        requestAuthority: authority.requestAuthority,
        authorityPartition: authority.authorityPartition,
        authority: {
          kind: "commerce_system",
          system: "builtin_commerce",
          revision: requiredCommerceSystemRevision(),
        },
        sessionId,
        threadId: "thread_commerce_actions",
        host: draft.value.host,
        verb: draft.value.verb,
        path: draft.value.path,
        argsHash: draft.value.argsHash,
        amount: null,
        nonce: { value: "00000000-0000-4000-8000-000000000002" },
        exp: 2_000,
        resourceKey: draft.value.resourceKey,
        flowBinding: fixtureFlowBinding({
          organisationId,
          sessionId,
          authorityPartitionDigest: authority.authorityPartition.digest,
        }),
      },
      current: {
        ...offerProjection(integrationAccountId),
        projection: {
          ...offerProjection(integrationAccountId).projection,
          provenance: {
            ...offerProjection(integrationAccountId).projection.provenance,
            revision: 2,
          },
        },
      },
      now: Date.parse(OBSERVED_AT),
    });
    expect(stale).toEqual({
      ok: false,
      error: { code: "commerce_action_revision_stale", expected: 1, actual: 2 },
    });
  });

  it("round-trips a governed Commerce full refund with exact path binding", async () => {
    const request = parseCommerceActionRequest({
      kind: "cancel_order",
      resourceId: "order_commerce",
      expectedRevision: 7,
      reason: "customer_requested",
      refund: "full",
      restock: true,
      notifyCustomer: false,
      note: null,
    });
    if (!request.ok) throw new Error(request.error.code);
    if (request.value.kind !== "cancel_order")
      throw new Error("unexpected request kind");
    const authority = commerceCancellationAuthority({
      refundAmountMinor: 990,
      refundCurrency: "JPY",
    });
    const draft = await buildCommerceCancellationActionDraft({
      request: request.value,
      authority,
      current: orderProjection(requiredIntegrationAccountId()),
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) throw new Error(draft.error.code);

    const url = new URL(`https://commerce.invalid${draft.value.path}`);
    expect(url.searchParams.get("execution")).toBe("commerce_full_refund");
    expect(url.searchParams.get("merchant_revision")).toBe("12");
    expect(url.searchParams.get("payment_id")).toBe("payment_commerce");
    expect(url.searchParams.get("payment_revision")).toBe("4");
    expect(url.searchParams.get("fulfillment_id")).toBe(
      "fulfillment_commerce",
    );
    expect(url.searchParams.get("fulfillment_revision")).toBe("5");
    expect(url.searchParams.get("checkout_profile_id")).toBe(
      "checkout_profile_commerce",
    );
    expect(url.searchParams.get("checkout_profile_revision")).toBe("3");
    expect(url.searchParams.get("refund_policy_id")).toBe(
      "refund_policy_standard",
    );
    expect(url.searchParams.get("refund_amount_minor")).toBe("990");
    expect(url.searchParams.get("refund_currency")).toBe("JPY");
    expect(url.searchParams.has("refund_governance")).toBe(false);
    expect(draft.value.amount).toEqual({ value: 990, currency: "JPY" });
    expect(draft.value.argsHash).toBe(
      await sha256HexForTest(JSON.stringify(draft.value.path)),
    );

    expect(
      parseCommerceActionPath({
        verb: draft.value.verb,
        path: draft.value.path,
      }),
    ).toEqual({
      ok: true,
      value: {
        ...request.value,
        execution: authority,
      },
    });
  });

  it("converts two-decimal refund money for approval display", async () => {
    const request = parseCommerceActionRequest({
      kind: "cancel_order",
      resourceId: "order_commerce",
      expectedRevision: 7,
      reason: "fraud_suspected",
      refund: "full",
      restock: true,
      notifyCustomer: false,
      note: null,
    });
    if (!request.ok) throw new Error(request.error.code);
    if (request.value.kind !== "cancel_order")
      throw new Error("unexpected request kind");
    const draft = await buildCommerceCancellationActionDraft({
      request: request.value,
      authority: commerceCancellationAuthority({
        refundAmountMinor: 12_345,
        refundCurrency: "USD",
      }),
      current: orderProjection(requiredIntegrationAccountId(), {
        amountMinor: 12_345,
        currency: "USD",
      }),
    });
    expect(draft).toMatchObject({
      ok: true,
      value: { amount: { value: 123.45, currency: "USD" } },
    });
  });

  it("rejects unsupported Commerce cancellation semantics", async () => {
    const authority = commerceCancellationAuthority({
      refundAmountMinor: 990,
      refundCurrency: "JPY",
    });
    const semantics = [
      ["refund", "none"],
      ["restock", false],
      ["notifyCustomer", true],
      ["note", "operator note"],
    ] as const;
    for (const [field, value] of semantics) {
      const raw = {
        kind: "cancel_order" as const,
        resourceId: "order_commerce",
        expectedRevision: 7,
        reason: "customer_requested" as const,
        refund: "full" as const,
        restock: true,
        notifyCustomer: false,
        note: null as string | null,
        [field]: value,
      };
      const request = parseCommerceActionRequest(raw);
      if (!request.ok) throw new Error(request.error.code);
      if (request.value.kind !== "cancel_order")
        throw new Error("unexpected request kind");
      await expect(
        buildCommerceCancellationActionDraft({
          request: request.value,
          authority,
          current: orderProjection(requiredIntegrationAccountId()),
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "commerce_action_invalid", field },
      });
    }
  });

  it("rejects stale orders, mismatched identity, and mismatched refund money", async () => {
    const request = parseCommerceActionRequest({
      kind: "cancel_order",
      resourceId: "order_commerce",
      expectedRevision: 7,
      reason: "customer_requested",
      refund: "full",
      restock: true,
      notifyCustomer: false,
      note: null,
    });
    if (!request.ok) throw new Error(request.error.code);
    if (request.value.kind !== "cancel_order")
      throw new Error("unexpected request kind");
    const authority = commerceCancellationAuthority({
      refundAmountMinor: 990,
      refundCurrency: "JPY",
    });
    await expect(
      buildCommerceCancellationActionDraft({
        request: request.value,
        authority,
        current: orderProjection(requiredIntegrationAccountId(), {
          revision: 8,
        }),
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "commerce_action_revision_stale", expected: 7, actual: 8 },
    });
    await expect(
      buildCommerceCancellationActionDraft({
        request: { ...request.value, resourceId: "order_other" },
        authority,
        current: orderProjection(requiredIntegrationAccountId()),
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "commerce_action_revision_stale", expected: 7, actual: 7 },
    });
    await expect(
      buildCommerceCancellationActionDraft({
        request: request.value,
        authority,
        current: orderProjection(requiredIntegrationAccountId(), {
          amountMinor: 991,
        }),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "commerce_action_invalid",
        field: "authority.refundAmount",
      },
    });
  });

  it("rejects malformed or mixed execution authority and preserves provider-managed cancellation", async () => {
    const authority = commerceCancellationAuthority({
      refundAmountMinor: 990,
      refundCurrency: "JPY",
    });
    expect(parseCommerceCancellationAuthority(authority)).toEqual({
      ok: true,
      value: authority,
    });
    expect(
      parseCommerceCancellationAuthority({
        ...authority,
        paymentRevision: 0,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "commerce_action_invalid",
        field: "authority.paymentRevision",
      },
    });
    expect(
      parseCommerceCancellationAuthority({
        ...authority,
        refundCurrency: "usd",
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "commerce_action_invalid",
        field: "authority.refundCurrency",
      },
    });
    expect(
      parseCommerceCancellationAuthority({
        ...authority,
        unexpected: true,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "commerce_action_invalid", field: "authority" },
    });

    const mixedExecutionBranch = {
      kind: "cancel_order",
      resourceId: "order_commerce",
      expectedRevision: 7,
      reason: "customer_requested",
      refund: "full",
      restock: true,
      notifyCustomer: false,
      note: null,
      execution: { kind: "provider_managed" },
      // @ts-expect-error Provider-managed actions cannot carry Commerce authority.
      merchantRevision: 12,
    } satisfies CommerceActionPath;
    void mixedExecutionBranch;

    const incompletePath =
      "/orders/order_commerce/cancel?expected_revision=7&reason=customer_requested&refund=full&restock=true&notify_customer=false&note=&execution=commerce_full_refund&merchant_revision=12";
    expect(
      parseCommerceActionPath({
        verb: "commerce.order.cancel",
        path: incompletePath,
      }),
    ).toEqual({
      ok: false,
      error: { code: "commerce_action_path_invalid" },
    });
    expect(
      parseCommerceActionPath({
        verb: "commerce.order.cancel",
        path: `${incompletePath}&payment_id=payment_commerce`,
      }),
    ).toEqual({
      ok: false,
      error: { code: "commerce_action_path_invalid" },
    });
    expect(
      parseCommerceActionPath({
        verb: "commerce.order.cancel",
        path: "/orders/order_commerce/cancel?expected_revision=7&reason=customer_requested&refund=full&restock=true&notify_customer=true&note=&execution=provider_managed&payment_id=payment_commerce",
      }),
    ).toEqual({
      ok: false,
      error: { code: "commerce_action_path_invalid" },
    });
    expect(
      parseCommerceActionPath({
        verb: "commerce.order.cancel",
        path: "/orders/order_commerce/cancel?expected_revision=7&reason=customer_requested&refund=full&restock=true&notify_customer=false&note=&execution=unknown",
      }),
    ).toEqual({
      ok: false,
      error: { code: "commerce_action_path_invalid" },
    });
    expect(
      parseCommerceActionPath({
        verb: "commerce.order.cancel",
        path: "/orders/order_commerce/cancel?expected_revision=7&reason=customer_requested&refund=full&restock=true&notify_customer=false&note=&unknown=value",
      }),
    ).toEqual({
      ok: false,
      error: { code: "commerce_action_path_invalid" },
    });

    const request = parseCommerceActionRequest({
      kind: "cancel_order",
      resourceId: "order_commerce",
      expectedRevision: 7,
      reason: "customer_requested",
      refund: "full",
      restock: true,
      notifyCustomer: true,
      note: "Customer requested cancellation.",
    });
    if (!request.ok) throw new Error(request.error.code);
    const providerDraft = await buildCommerceActionDraft({
      organisationId: ORGANISATION_ID,
      integrationAccountId: requiredIntegrationAccountId(),
      sessionId: requiredSessionId(),
      threadId: "thread_provider_cancel",
      request: request.value,
      current: orderProjection(requiredIntegrationAccountId()),
      exp: 2_000,
      now: 1_000,
    });
    expect(providerDraft).toMatchObject({
      ok: true,
      value: {
        amount: null,
        path: "/orders/order_commerce/cancel?expected_revision=7&reason=customer_requested&refund=full&restock=true&notify_customer=true&note=Customer+requested+cancellation.",
      },
    });
    if (!providerDraft.ok) throw new Error(providerDraft.error.code);
    expect(
      parseCommerceActionPath({
        verb: providerDraft.value.verb,
        path: providerDraft.value.path,
      }),
    ).toMatchObject({
      ok: true,
      value: { execution: { kind: "provider_managed" } },
    });
  });

  it("keeps Commerce cancellation receipts separate from projection receipts", () => {
    const common = {
      kind: "commerce_provider_receipt" as const,
      provider: "commerce" as const,
      receiptId: "receipt_commerce_cancel",
      effectId: "effect_commerce_cancel",
      actionNonce: "00000000-0000-4000-8000-000000000001",
      flowBindingDigest: "a".repeat(64),
      decisionDigest: "b".repeat(64),
      eventId: "delivery_commerce_cancel",
      resourceId: "commerce:merchant_cafe:order_1",
      revision: 7,
      status: "accepted" as const,
      merchantId: "merchant_cafe",
      merchantRevision: 12,
      observedAt: OBSERVED_AT,
    };
    const offerReceipt = {
      ...common,
      resourceId: "commerce:merchant_cafe:offer_1",
      projectionKind: "offer" as const,
    } satisfies CommerceEngineProviderReceipt;
    const cancellationReceipt = {
      ...common,
      projectionKind: "commerce_order" as const,
      providerResource: {
        kind: "refund_attempt" as const,
        id: "refund_attempt_00000000-0000-4000-8000-000000000001",
        revision: 1,
      },
    } satisfies CommerceEngineProviderReceipt;
    // @ts-expect-error Projection receipts cannot carry a signed provider resource.
    const mixedReceipt: CommerceEngineProviderReceipt = {
      ...offerReceipt,
      providerResource: cancellationReceipt.providerResource,
    };
    void mixedReceipt;

    expect(parseCommerceProviderReceipt(offerReceipt)).toEqual({
      ok: true,
      value: offerReceipt,
    });
    expect(
      parseCommerceProviderReceipt({
        ...offerReceipt,
        providerResource: cancellationReceipt.providerResource,
      }),
    ).toEqual({
      ok: false,
      error: { code: "commerce_provider_receipt_invalid" },
    });
    expect(parseCommerceProviderReceipt(cancellationReceipt)).toEqual({
      ok: true,
      value: cancellationReceipt,
    });
    expect(
      parseCommerceProviderReceipt({
        ...cancellationReceipt,
        providerResource: {
          ...cancellationReceipt.providerResource,
          revision: 0,
        },
      }),
    ).toEqual({
      ok: false,
      error: { code: "commerce_provider_receipt_invalid" },
    });
  });

  it("settles a provider receipt after an interrupted dispatch and replays it once", async () => {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createActionLedgerSchema(sql);
    const organisationId = requiredOrganisationId();
    const integrationAccountId = requiredIntegrationAccountId();
    const sessionId = requiredSessionId();
    const caseId = parseCaseId("case_commerce_recovery");
    if (!caseId.ok) throw new Error(caseId.error.code);
    const draft = await buildCommerceActionDraft({
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      sessionId,
      threadId: "thread_commerce_recovery",
      request: {
        kind: "publish_catalog_listing",
        productId: "product_field_watch",
        productRevision: 1,
        variantId: "variant_field_watch_black",
        variantRevision: 1,
        offerId: "offer_field_watch_online",
        offerRevision: 1,
        salesChannelId: "sales_channel_online",
        salesChannelRevision: 1,
      },
      current: offerProjection(integrationAccountId),
      exp: 2_000,
      now: 1_000,
    });
    if (!draft.ok) throw new Error(draft.error.code);
    const authority = fixtureProviderActionAuthority({
      organisationId,
      integrationAccountId,
      providerResourceScope: draft.value.resourceKey,
    });
    const proposed = requireEntry(
      proposeAction(sql, {
        organisationId,
        integrationAccountId,
        requestAuthority: authority.requestAuthority,
        authorityPartition: authority.authorityPartition,
        authority: {
          kind: "commerce_system",
          system: "builtin_commerce",
          revision: requiredCommerceSystemRevision(),
        },
        caseId: caseId.value,
        proposalId: "proposal_commerce_recovery",
        sessionId,
        threadId: "thread_commerce_recovery",
        draft: draft.value,
        flowBinding: fixtureFlowBinding({
          organisationId,
          sessionId,
          authorityPartitionDigest: authority.authorityPartition.digest,
        }),
        exp: 2_000,
        now: 1_000,
      }),
    );
    requireEntry(
      requestActionApproval(sql, {
        organisationId,
        nonce: proposed.action.nonce.value,
        now: 1_010,
      }),
    );
    requireEntry(
      signAction(sql, {
        organisationId,
        nonce: proposed.action.nonce.value,
        approval: approvalEvidence(),
        now: 1_020,
      }),
    );
    requireEntry(
      beginActionExecution(sql, {
        organisationId,
        nonce: proposed.action.nonce.value,
        now: 1_030,
      }),
    );
    const receipt = {
      kind: "commerce_provider_receipt" as const,
      provider: "lab" as const,
      receiptId: "receipt_commerce_recovery",
      effectId: "effect_commerce_recovery",
      actionNonce: proposed.action.nonce.value,
      flowBindingDigest: "b".repeat(64),
      decisionDigest: "c".repeat(64),
      eventId: "event_commerce_recovery",
      resourceId: "offer_field_watch_online",
      projectionKind: "offer" as const,
      revision: 2,
      status: "settled" as const,
      observedAt: OBSERVED_AT,
    };
    const settled = reconcileCommerceProviderReceipt(sql, {
      organisationId,
      nonce: proposed.action.nonce.value,
      receipt,
      now: 1_040,
    });
    const replay = reconcileCommerceProviderReceipt(sql, {
      organisationId,
      nonce: proposed.action.nonce.value,
      receipt,
      now: 1_050,
    });
    expect(settled).toMatchObject({
      ok: true,
      value: { state: "confirmed", providerResult: JSON.stringify(receipt) },
    });
    expect(replay).toEqual(settled);
  });
  it("binds Wise funding resumption to the recovered attempt and transfer", async () => {
    const request = parseCommerceActionRequest({
      kind: "resume_supplier_payout_funding",
      payoutId: "supplier_payout_1",
      expectedPayoutRevision: 4,
      approvalDigest: "ab".repeat(32),
      attemptId: "attempt_1",
      providerTransferId: "transfer_1",
    });
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    const draft = await buildCommerceActionDraft({
      organisationId: ORGANISATION_ID,
      integrationAccountId: requiredIntegrationAccountId(),
      sessionId: "session_payout",
      threadId: "thread_payout",
      request: request.value,
      current: offerProjection(requiredIntegrationAccountId()),
      exp: 2_000,
      now: 1_000,
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(
      parseCommerceActionPath({
        verb: draft.value.verb,
        path: draft.value.path,
      }),
    ).toEqual({ ok: true, value: request.value });
    expect(
      parseCommerceActionPath({
        verb: draft.value.verb,
        path: draft.value.path.replace("&provider_transfer_id=transfer_1", ""),
      }),
    ).toEqual({ ok: false, error: { code: "commerce_action_path_invalid" } });
  });
});

function approvalEvidence(): ApprovalEvidence {
  const userId = parseUserId("user_f007856a-8781-50d3-8b65-93f9312d6357");
  const controlSessionId = parseControlSessionId(
    "control_session_commerce_recovery",
  );
  const personId = parsePersonId("person_commerce_recovery");
  const organisationId = parseOrganisationId(ORGANISATION_ID);
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
      authenticatedAt: 1_020,
      challenge: {
        stepUpId: "fixture:commerce-recovery",
        organisationId: organisationId.value,
        actionNonce: "action_commerce_recovery",
        actionDigest,
        policy: { kind: "unversioned_default" },
        issuedAt: 1_020,
        expiresAt: 2_000,
      },
    },
  };
}

function requireEntry<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function requiredOrganisationId() {
  const parsed = parseOrganisationId(ORGANISATION_ID);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function requiredIntegrationAccountId() {
  const parsed = parseIntegrationAccountId(COMMERCE_LAB_INTEGRATION_ACCOUNT_ID);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function requiredSessionId() {
  const parsed = parseSessionId("session_commerce_actions");
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function requiredCommerceSystemRevision() {
  const parsed = parseCommerceSystemRevision(1);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function commerceCancellationAuthority(
  overrides: Partial<CommerceCancellationAuthority> = {},
): CommerceCancellationAuthority {
  return {
    kind: "commerce_full_refund",
    merchantRevision: 12,
    paymentId: "payment_commerce",
    paymentRevision: 4,
    fulfillmentId: "fulfillment_commerce",
    fulfillmentRevision: 5,
    checkoutProfileId: "checkout_profile_commerce",
    checkoutProfileRevision: 3,
    refundPolicyId: "refund_policy_standard",
    refundAmountMinor: 990,
    refundCurrency: "JPY",
    ...overrides,
  };
}

function orderProjection(
  integrationAccountId: ReturnType<typeof requiredIntegrationAccountId>,
  options: Readonly<{
    resourceId?: string;
    revision?: number;
    amountMinor?: number;
    currency?: string;
  }> = {},
): Variant<CommerceProjection, "commerce_order"> {
  const resourceId = options.resourceId ?? "order_commerce";
  const revision = options.revision ?? 7;
  const amountMinor = options.amountMinor ?? 990;
  const currency = options.currency ?? "JPY";
  const money = { amountMinor, currency };
  return {
    kind: "commerce_order",
    projection: {
      provenance: {
        organisationId: requiredOrganisationId(),
        integrationAccountId,
        source: "lab",
        resourceType: "commerce_order",
        resourceId,
        revision,
        occurredAt: OBSERVED_AT,
        observedAt: OBSERVED_AT,
      },
      origin: {
        kind: "online",
        salesChannelId: "sales_channel_online",
        storefrontId: "storefront_commerce",
        checkoutId: "checkout_commerce",
        configuration: { kind: "external_authority" },
      },
      buyer: { kind: "guest" },
      lineItems: [],
      totals: {
        subtotal: money,
        discount: { amountMinor: 0, currency },
        tax: { amountMinor: 0, currency },
        duty: { amountMinor: 0, currency },
        shipping: { amountMinor: 0, currency },
        serviceFee: { amountMinor: 0, currency },
        tip: { amountMinor: 0, currency },
        rounding: { amountMinor: 0, currency },
        total: money,
      },
      adjustments: [],
      lifecycle: { state: "confirmed", confirmedAt: OBSERVED_AT },
    },
  };
}

async function sha256HexForTest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function offerProjection(
  integrationAccountId: ReturnType<typeof requiredIntegrationAccountId>,
): Variant<CommerceProjection, "offer"> {
  return {
    kind: "offer",
    projection: {
      provenance: {
        organisationId: requiredOrganisationId(),
        integrationAccountId,
        source: "lab",
        resourceType: "offer",
        resourceId: "offer_field_watch_online",
        revision: 1,
        occurredAt: OBSERVED_AT,
        observedAt: OBSERVED_AT,
      },
      variantId: "variant_field_watch_black",
      salesChannelId: "sales_channel_online",
      price: { amountMinor: 42_500, currency: "USD" },
      availability: { state: "available" },
      lifecycle: { state: "prepared", preparedAt: OBSERVED_AT },
    },
  };
}

function fulfillmentProjection(
  integrationAccountId: ReturnType<typeof requiredIntegrationAccountId>,
  revision: number,
): Variant<CommerceProjection, "fulfillment"> {
  return {
    kind: "fulfillment",
    projection: {
      kind: "shipping",
      provenance: {
        organisationId: requiredOrganisationId(),
        integrationAccountId,
        source: "lab",
        resourceType: "fulfillment",
        resourceId: "fulfillment_1",
        revision,
        occurredAt: OBSERVED_AT,
        observedAt: OBSERVED_AT,
      },
      orderId: "order_1",
      lineItems: [],
      locationId: "location_1",
      expectedBy: "2026-08-05T00:00:00.000Z",
      binding: { kind: "external", sourceReference: "lab_fulfillment_1" },
      lifecycle: {
        state: "requested",
        requestedAt: "2026-08-03T00:00:00.000Z",
      },
    },
  };
}

function shipmentProjection(
  integrationAccountId: ReturnType<typeof requiredIntegrationAccountId>,
  revision: number,
  trackingNumber: string,
): Variant<CommerceProjection, "shipment"> {
  return {
    kind: "shipment",
    projection: {
      kind: "first_party",
      provenance: {
        organisationId: requiredOrganisationId(),
        integrationAccountId,
        source: "lab",
        resourceType: "shipment",
        resourceId: "shipment_1",
        revision,
        occurredAt: OBSERVED_AT,
        observedAt: OBSERVED_AT,
      },
      orderId: "order_1",
      fulfillmentId: "fulfillment_1",
      package: {
        packageId: "package_1",
        weight: { grams: 100 },
        dimensions: {
          lengthMillimeters: 100,
          widthMillimeters: 100,
          heightMillimeters: 100,
        },
        lineQuantities: [],
        customsLines: [],
      },
      lifecycle: {
        state: "label_purchased",
        labelAttemptId: "label_attempt_1",
        trackingNumber,
        purchasedAt: "2026-08-03T00:00:00.000Z",
      },
      events: [],
    },
  };
}

// The portal owns its browser-only React runtime; the platform test harness renders it through the app-local package.
// @ts-expect-error React runtime declarations are scoped to apps/portal.
import React from "../../../apps/portal/node_modules/react";
// @ts-expect-error React DOM runtime declarations are scoped to apps/portal.
import { renderToStaticMarkup } from "../../../apps/portal/node_modules/react-dom/server";
import { describe, expect, it } from "vitest";

import { EMPTY_AGENT_OPERATIONS_SNAPSHOT, type AgentOperationsTransport } from "../../../apps/portal/src/agent-operations";
import { parseAgentOperationForm, parseAgentOperationsResponse, type AgentOperationsSnapshot } from "@seams/control-api/portal/agent-operations";
import { parseCommerceActionRecordResponse } from "@seams/control-api/portal/commerce-actions";
import type { CommerceOperationsTransport } from "../../../apps/portal/src/features/commerce/operations";
import {
  AgentOperationsRouteView,
  type AgentOperationsPageContent,
  // @ts-expect-error The portal build type-checks this JSX module.
} from "../../../apps/portal/src/pages/automation";
// @ts-expect-error Platform's test tsconfig intentionally excludes JSX; the portal build type-checks this module separately.
import { diffLines } from "../../../apps/portal/src/pages/agent-documents";
import type { Variant } from "@seams/type-utils";

const ORGANISATION_ID = "organisation_cafe";
const TRANSPORT: AgentOperationsTransport = {
  read: unusedRead,
  mutate: unusedMutation,
  readRevisions: unusedRead,
};
const COMMERCE_OPERATIONS: CommerceOperationsTransport = {
  previewTrackingBatch: unusedCommerceRequest,
  proposeAction: unusedCommerceRequest,
};

describe("CafeOS automation route ownership", () => {
  it("normalizes form data into a precise operation command", () => {
    const values = new FormData();
    values.set("name", "  Back bar  ");
    values.set("purpose", "Track milk and syrups");
    expect(parseAgentOperationForm("create_area", values)).toEqual({
      ok: true,
      command: {
        kind: "create_area",
        name: "Back bar",
        purpose: "Track milk and syrups",
      },
    });

    values.delete("name");
    expect(parseAgentOperationForm("create_area", values)).toEqual({
      ok: false,
      message: "Complete the required operation fields.",
    });

    const installation = new FormData();
    installation.set("agentDefinitionId", "agent_definition_support");
    installation.set("definitionRevision", "1");
    installation.set("areaId", "area_support");
    installation.set("responsibility", "Prepare customer replies for approval");
    installation.set("policyRevision", "1");
    expect(parseAgentOperationForm("install_agent", installation)).toEqual({
      ok: true,
      command: {
        kind: "install_agent",
        agentDefinitionId: "agent_definition_support",
        definitionRevision: 1,
        areaId: "area_support",
        responsibility: "Prepare customer replies for approval",
        scopeIds: [],
        policyRevision: 1,
        grantedCapabilities: [],
      },
    });
  });

  it("requires the current operations response shape at the request boundary", () => {
    expect(() =>
      parseAgentOperationsResponse({
        ok: true,
        operations: {
          areas: [],
          definitions: [],
          installations: [],
          skills: [],
          bindings: [],
          activeCases: [],
        },
      }),
    ).toThrow("Agent operations are unavailable.");
  });

  it("accepts a published saved selector with its validated commerce query", () => {
    const parsed = parseAgentOperationsResponse({
      ok: true,
      operations: {
        areas: [],
        responsibilityScopes: [
          {
            scopeId: "scope_export_board",
            organisationId: ORGANISATION_ID,
            areaId: "area_export_coordination",
            scope: {
              kind: "saved_selector",
              selector: {
                selectorId: "export_board",
                revision: 1,
                query: {
                  kind: "commerce_list_page",
                  listId: "export_coordination",
                  filter: { kind: "all" },
                  sorts: [],
                  pagination: { limit: 100, cursor: null },
                },
              },
            },
            lifecycle: "published",
            revision: 1,
            publishedAt: 10,
          },
        ],
        definitions: [],
        installations: [],
        skills: [],
        bindings: [],
        cueBindings: [],
        scheduleBindings: [],
        governance: [],
        escalationPolicies: [],
        configurationProposals: [],
        activeCases: [],
        commerceExceptions: {
          kind: "unavailable",
          reason: "commerce_system_unavailable",
        },
        actionLedger: [],
      },
    });

    const scope = parsed.responsibilityScopes[0]?.scope;
    expect(parsed.responsibilityScopes[0]?.organisationId).toBe(
      ORGANISATION_ID,
    );
    expect(scope?.kind).toBe("saved_selector");
    if (scope?.kind !== "saved_selector")
      throw new Error("saved selector scope was not parsed");
    expect(scope.selector.query.kind).toBe("commerce_list_page");
  });

  it("normalizes direct Action Ledger activity without a commerce work DTO", () => {
    const parsed = parseAgentOperationsResponse({
      ok: true,
      operations: {
        areas: [],
        responsibilityScopes: [],
        definitions: [],
        installations: [],
        skills: [],
        bindings: [],
        cueBindings: [],
        scheduleBindings: [],
        governance: [],
        escalationPolicies: [],
        configurationProposals: [],
        activeCases: [],
        commerceExceptions: {
          kind: "unavailable",
          reason: "commerce_system_unavailable",
        },
        actionLedger: [
          {
            action: {
              nonce: { value: "00000000-0000-4000-8000-000000000001" },
              host: "satyr.commerce",
              verb: "commerce.order.cancel",
              resourceKey: "commerce:cancel_order:order_1",
              amount: null,
            },
            caseId: "case_1",
            proposalId: "proposal_1",
            state: "proposed",
            createdAt: 10,
            updatedAt: 11,
            providerResult: null,
            commerceEffect: null,
          },
        ],
      },
    });

    expect(parsed.actionLedger).toHaveLength(1);
    expect(parsed.actionLedger[0]?.action.resourceKey).toBe(
      "commerce:cancel_order:order_1",
    );
    expect(parsed.actionLedger[0]?.commerceEffect).toBeNull();
  });

  it("renders an Underclerk governed refund amount", () => {
    const actionNonce = "00000000-0000-4000-8000-000000000002";
    const providerReceipt = {
      kind: "commerce_provider_receipt",
      provider: "underclerk",
      receiptId: "receipt_refund_1",
      effectId: "effect_refund_1",
      actionNonce,
      flowBindingDigest: "a".repeat(64),
      decisionDigest: "b".repeat(64),
      eventId: "delivery_refund_1",
      resourceId: "order_1",
      projectionKind: "commerce_order",
      revision: 8,
      status: "accepted",
      merchantId: "merchant_1",
      merchantRevision: 12,
      providerResource: {
        kind: "refund_attempt",
        id: "refund_attempt_1",
        revision: 2,
      },
      observedAt: "2026-08-30T02:00:00.000Z",
    };
    const providerResult = JSON.stringify(providerReceipt);
    const actionResponse = {
      ok: true,
      action: {
        nonce: { value: actionNonce },
        caseId: "case_refund_1",
        proposalId: "proposal_refund_1",
        state: "approval_requested",
        verb: "commerce.order.cancel",
        resourceKey: "commerce:cancel_order:order_1",
        amount: { value: 42.5, currency: "USD" },
        commerceSystem: {
          kind: "commerce_system",
          system: "satyr_commerce",
          revision: 3,
        },
        details: {
          kind: "cancel_order",
          resourceId: "order_1",
          expectedRevision: 8,
          reason: "customer_requested",
          refund: "full",
          restock: true,
          notifyCustomer: false,
          note: null,
          execution: {
            kind: "underclerk_full_refund",
            merchantRevision: 12,
            paymentId: "payment_1",
            paymentRevision: 4,
            fulfillmentId: "fulfillment_1",
            fulfillmentRevision: 5,
            checkoutProfileId: "profile_1",
            checkoutProfileRevision: 9,
            refundPolicyId: "refund_policy_1",
            refundAmountMinor: 4250,
            refundCurrency: "USD",
            refundGovernance: "automatic_eligible",
          },
        },
        providerResult,
      },
    };

    const action = parseCommerceActionRecordResponse(actionResponse);
    expect(action.receipt).toMatchObject({
      provider: "underclerk",
      projectionKind: "commerce_order",
      providerResource: {
        kind: "refund_attempt",
        id: "refund_attempt_1",
        revision: 2,
      },
    });
    const {
      providerResource: _providerResource,
      ...receiptWithoutProviderResource
    } = providerReceipt;
    expect(
      parseCommerceActionRecordResponse({
        ...actionResponse,
        action: {
          ...actionResponse.action,
          providerResult: JSON.stringify(receiptWithoutProviderResource),
        },
      }).receipt,
    ).toBeNull();
    const parsed = parseAgentOperationsResponse({
      ok: true,
      operations: {
        areas: [],
        responsibilityScopes: [],
        definitions: [],
        installations: [],
        skills: [],
        bindings: [],
        cueBindings: [],
        scheduleBindings: [],
        governance: [],
        escalationPolicies: [],
        configurationProposals: [],
        activeCases: [],
        commerceExceptions: {
          kind: "unavailable",
          reason: "commerce_system_unavailable",
        },
        actionLedger: [
          {
            action: {
              nonce: { value: actionNonce },
              host: "satyr.commerce",
              verb: "commerce.order.cancel",
              resourceKey: "commerce:cancel_order:order_1",
              amount: action.amount,
            },
            caseId: "case_refund_1",
            proposalId: "proposal_refund_1",
            state: "approval_requested",
            createdAt: 10,
            updatedAt: 11,
            providerResult,
            commerceEffect: null,
          },
        ],
      },
    });

    const markup = renderOperationsRoute(parsed, true);
    expect(markup).toContain("Refund amount");
    expect(markup).toContain("42.50");
    expect(markup).toContain("USD");
  });

  it("renders route loading, recovery, authorization, and local mutation feedback", () => {
    expect(renderRoute({ kind: "loading" }, { kind: "idle" })).toContain(
      'aria-busy="true"',
    );
    expect(
      renderRoute(
        {
          kind: "failed",
          problem: "Automation work could not be loaded.",
          recovery: { label: "Try again" },
        },
        { kind: "idle" },
      ),
    ).toContain(">Try again</button>");
    expect(
      renderRoute(
        {
          kind: "unauthorized",
          reason: "Your role cannot access automation configuration.",
        },
        { kind: "idle" },
      ),
    ).toContain("Your role cannot access automation configuration.");
    expect(
      renderRoute(
        readyContent(),
        {
          kind: "failed",
          formKey: "area-create",
          operation: "create_area",
          message: "Agent configuration could not be saved. Try again.",
          conflict: false,
        },
        true,
        "areas",
      ),
    ).toContain('role="alert"');
    expect(
      renderRoute(
        readyContent(),
        {
          kind: "succeeded",
          formKey: "area-create",
          message: "Area created.",
        },
        true,
        "areas",
      ),
    ).toContain("Area created.");
  });

  it("normalizes manual run form input", () => {
    const values = new FormData();
    values.set("installationId", "installation_inventory");
    values.set("instructionBody", "  Review today's low stock items.  ");
    expect(parseAgentOperationForm("dispatch_manual_run", values)).toEqual({
      ok: true,
      command: {
        kind: "dispatch_manual_run",
        installationId: "installation_inventory",
        instructionBody: "Review today's low stock items.",
      },
    });
    values.delete("instructionBody");
    expect(parseAgentOperationForm("dispatch_manual_run", values)).toEqual({
      ok: false,
      message: "Complete the required operation fields.",
    });
  });

  it("diffs document lines for conflict and proposal views", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
    ]);
    expect(diffLines("a\nb", "a\nb\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
      { kind: "added", text: "c" },
    ]);
    expect(
      diffLines("same", "same").every(
        (line: { readonly kind: string }) => line.kind === "same",
      ),
    ).toBe(true);
  });

  it("keeps the console read-only for reviewer roles", () => {
    const markup = renderRoute(readyContent(), { kind: "idle" }, false);
    expect(markup).toContain("Your role can review agent activity.");
    expect(markup).not.toContain("Create agent");
  });

  it("shows actual grants and enabled triggers without treating pending delivery as approval work", () => {
    for (const lifecycle of ["active", "suspended", "archived"] as const) {
      for (const enabled of [true, false]) {
        const snapshot = agentConsoleSnapshot(lifecycle, enabled);
        const markup = renderRoute(
          {
            kind: "ready",
            data: snapshot,
            freshness: { kind: "current" },
            updating: false,
          },
          { kind: "idle" },
        );
        expect(markup).toContain(
          "Checks stock and prepares restock proposals.",
        );
        expect(markup).toContain("Recent work");
        expect(markup).toContain("1 result awaiting delivery");
        expect(markup).not.toContain("Review changes");
        expect(markup).not.toContain("Propose commerce changes");
        if (lifecycle === "active") {
          expect(markup).toContain("Read commerce data");
          expect(markup).toContain(
            enabled ? "Triggers enabled" : "Manual only",
          );
        } else {
          expect(markup).not.toContain("Triggers enabled");
          expect(markup).toContain("No commerce tools");
        }
      }
    }
  });

  it("renders actionable exceptions with accessible selection", () => {
    const markup = renderOperationsRoute(operationsSnapshot(), true);
    expect(markup).toContain("Commerce exceptions");
    expect(markup).toContain("Select missing-tracking items");
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain("fulfillment_1");
    expect(markup).toContain("JP123456789");
    expect(markup).toContain("Order 1 · Shipment 1");

    const reviewerMarkup = renderOperationsRoute(operationsSnapshot(), false);
    expect(reviewerMarkup).toContain(
      'commerce-exception-selector" disabled=""',
    );
  });
});

function renderRoute(
  content: AgentOperationsPageContent,
  mutation: Parameters<typeof AgentOperationsRouteView>[0]["mutation"],
  canManage: boolean = true,
  page: "agents" | "areas" = "agents",
): string {
  return renderToStaticMarkup(
    React.createElement(AgentOperationsRouteView, {
      organisationId: ORGANISATION_ID,
      page,
      canManage,
      commerceActionBusy: false,
      refreshKey: "initial",
      loadAction: unusedLoadAction,
      transport: TRANSPORT,
      commerceOperations: COMMERCE_OPERATIONS,
      content,
      mutation,
      retry: ignore,
      submit: unusedSubmit,
      run: unusedRun,
      loadRevisions: unusedLoadRevisions,
    }),
  );
}

function agentConsoleSnapshot(
  lifecycle: "active" | "suspended" | "archived",
  enabled: boolean,
): AgentOperationsSnapshot {
  return {
    ...EMPTY_AGENT_OPERATIONS_SNAPSHOT,
    areas: [
      {
        areaId: "area_cafe",
        name: "Cafe operations",
        purpose: "Daily operations",
        lifecycle: "active",
      },
    ],
    definitions: [
      {
        agentDefinitionId: "agent_urk",
        displayName: "Urk",
        role: "merchant_operator",
        purpose: "Checks stock and prepares restock proposals.",
        lifecycle: "active",
        currentRevision: {
          revision: 1,
          instructions: "Prepare restock work.",
          requestedCapabilities: [
            "commerce.entity_plane.context",
            "commerce.action.propose",
          ],
          skillRefs: [],
          contentDigest: "digest_urk",
        },
      },
    ],
    installations: [
      {
        installationId: "installation_urk",
        agentDefinitionId: "agent_urk",
        definitionRevision: 1,
        policyRevision: 1,
        grantedCapabilities: ["commerce.entity_plane.context"],
        lifecycle,
        areaAssignments: [
          { areaId: "area_cafe", responsibility: "Stock checks", scopeIds: [] },
        ],
      },
    ],
    cueBindings: [
      {
        bindingId: "binding_stock",
        areaId: "area_cafe",
        scopeIds: [],
        installationId: "installation_urk",
        cueSource: "commerce",
        cueEventType: "inventory_low_stock",
        enabled,
        instructionBody: null,
        revision: 1,
      },
    ],
    activeCases: [
      {
        caseId: "case_stock",
        pinnedOrganisationId: ORGANISATION_ID,
        purpose: "<@U123> Check stock",
        revision: 1,
        lifecycle: "open",
        assignments: [],
        outputs: { pending: 1, settled: 0 },
      },
    ],
  };
}

function renderOperationsRoute(
  snapshot: AgentOperationsSnapshot,
  canManage: boolean,
): string {
  return renderToStaticMarkup(
    React.createElement(AgentOperationsRouteView, {
      organisationId: ORGANISATION_ID,
      page: "operations",
      canManage,
      commerceActionBusy: false,
      refreshKey: "initial",
      loadAction: unusedLoadAction,
      transport: TRANSPORT,
      commerceOperations: COMMERCE_OPERATIONS,
      content: {
        kind: "ready",
        data: snapshot,
        freshness: { kind: "current" },
        updating: false,
      },
      mutation: { kind: "idle" },
      retry: ignore,
      submit: unusedSubmit,
      run: unusedRun,
      loadRevisions: unusedLoadRevisions,
    }),
  );
}

function operationsSnapshot(): AgentOperationsSnapshot {
  return {
    ...EMPTY_AGENT_OPERATIONS_SNAPSHOT,
    commerceExceptions: {
      kind: "ready",
      observedAt: "2026-08-29T00:00:00.000Z",
      items: [
        {
          kind: "missing_tracking",
          exceptionId: "missing_tracking:fulfillment_1:shipment_1",
          reason:
            "This fulfillment has a shipping label and is waiting for its tracking reference to be attached.",
          owner: { kind: "unassigned" },
          dueAt: "2026-08-30T03:00:00.000Z",
          recommendedAction: {
            kind: "attach_tracking",
            label: "Attach tracking",
          },
          resolution: {
            kind: "fulfillment_lifecycle",
            expectedState: "handed_to_carrier",
          },
          target: {
            merchantRevision: 12,
            orderId: "order_1",
            fulfillmentId: "fulfillment_1",
            fulfillmentRevision: 4,
            shipmentId: "shipment_1",
            shipmentRevision: 7,
            trackingNumber: "JP123456789",
          },
          freshness: "current",
        },
      ],
    },
  };
}

function readyContent(): Variant<AgentOperationsPageContent, "ready"> {
  return {
    kind: "ready",
    data: EMPTY_AGENT_OPERATIONS_SNAPSHOT,
    freshness: { kind: "current" },
    updating: false,
  };
}

async function unusedRead(): Promise<unknown> {
  throw new Error("unused");
}
async function unusedCommerceRequest(): Promise<unknown> {
  throw new Error("unused");
}

async function unusedMutation(): Promise<unknown> {
  throw new Error("unused");
}

async function unusedLoadAction(): Promise<void> {}
async function unusedSubmit(): Promise<boolean> {
  return false;
}
async function unusedRun(): Promise<boolean> {
  return false;
}
async function unusedLoadRevisions(): Promise<never> {
  throw new Error("unused");
}
function ignore(): void {}

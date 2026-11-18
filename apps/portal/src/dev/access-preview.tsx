/**
 * Dev-only visual harness for the Access and data flow page.
 *
 * Serves at /access-preview.html under `pnpm portal`. Mounts the real
 * AccessRoute against an in-memory transport so every view, dialog, and
 * empty state can be exercised without the control plane. Scenarios:
 *
 *   ?scenario=fresh      new organisation right after Slack setup (baseline grants only)
 *   ?scenario=populated  Stripe, Drive, Shopify connected with operator grants
 *   ?scenario=viewer     read-only requester
 *
 * The subview is the same query param the page links use (?view=...).
 * A grant or a revoke changes the in-memory grants, so the page shows its
 * result until the next reload.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useSearchParams } from "react-router";
import type {
  CaseContextCollectionMetadataView,
  CaseContextCollectionRelationshipDecision,
  CaseContextCollectionRelationshipView,
} from "@seams/control-api";

import "../styles.css";
import { installCustomConnectorPreview } from "./custom-connector-preview";
import { installPermissionRequestsPreview } from "./permission-requests-preview-data";
import { AccessRoute } from "../features/access/route";
import { WorkspaceLayout } from "../shell";
import type {
  AiBudgetLimits,
  AiBudgetView,
} from "@seams/control-api/portal/ai-budget";
import type {
  AccessControlGrantView,
  AccessControlOption,
  AccessControlSourcePolicyView,
  AccessControlView,
  AccessControlCapabilityView,
  AccessExplainResult,
  AccessMutationCommand,
  AccessResult,
  AccessRouteTransport,
  AccessSubview,
  DropboxResourcePage,
} from "@seams/control-api/portal/access-models";
import type { CapabilityDefinition } from "@seams/contracts";

type Scenario = "fresh" | "populated" | "viewer" | "empty";

const NOW = Date.parse("2026-08-31T09:00:00+09:00");

const seed = (
  capabilityId: string,
  label: string,
  description: string,
  category: CapabilityDefinition["category"],
  risk: CapabilityDefinition["risk"],
  target: CapabilityDefinition["target"],
  providerDependency: CapabilityDefinition["providerDependency"],
  policyModes: CapabilityDefinition["policyModes"],
): CapabilityDefinition => ({
  capabilityId,
  capabilityVersion: 1,
  label,
  description,
  category,
  risk,
  target,
  providerDependency,
  policyModes,
});

const NONE: CapabilityDefinition["providerDependency"] = { kind: "none" };
const COMMERCE: CapabilityDefinition["providerDependency"] = {
  kind: "commerce_system",
  systems: ["satyr_commerce", "shopify"],
};
const SHOPIFY: CapabilityDefinition["providerDependency"] = {
  kind: "provider",
  providers: ["shopify"],
};
const STRIPE: CapabilityDefinition["providerDependency"] = {
  kind: "provider",
  providers: ["stripe"],
};
const FILES: CapabilityDefinition["providerDependency"] = {
  kind: "provider",
  providers: ["dropbox", "google_drive"],
};

const DEFINITIONS: readonly CapabilityDefinition[] = [
  seed(
    "custom_connector.read",
    "Read custom connector data",
    "Use an approved read operation on an exact custom connector account.",
    "customer_data",
    "read",
    "custom_connector_operation",
    NONE,
    "enabled_disabled",
  ),
  seed(
    "custom_connector.write",
    "Write through custom connectors",
    "Propose a change through an approved operation; each write requires approval.",
    "commerce",
    "external_effect",
    "custom_connector_operation",
    NONE,
    "approval_required_disabled",
  ),
  seed(
    "context.case.read",
    "Read Case context",
    "View accepted Case context available to the current authority.",
    "context",
    "read",
    "platform",
    NONE,
    "enabled_disabled",
  ),
  seed(
    "integration.discovery.read",
    "Discover connected integrations",
    "View bounded connection metadata and the data classes readable by the current authority.",
    "context",
    "read",
    "platform",
    NONE,
    "enabled_disabled",
  ),
  seed(
    "file.read",
    "Read connected files",
    "Read approved files from an exact connected account and file or folder scope.",
    "customer_data",
    "read",
    "file_resource",
    FILES,
    "enabled_disabled",
  ),
  seed(
    "commerce.entity_plane.context",
    "Read scoped commerce context",
    "Read the scoped commerce graph assembled for an agent.",
    "commerce",
    "read",
    "commerce_read",
    COMMERCE,
    "enabled_disabled",
  ),
  seed(
    "commerce.entity.read",
    "Read commerce records",
    "Read commerce records within an exact commerce-read scope.",
    "commerce",
    "read",
    "commerce_read",
    COMMERCE,
    "enabled_disabled",
  ),
  seed(
    "commerce.action.propose",
    "Propose governed commerce actions",
    "Prepare a governed commerce action without executing its effect.",
    "commerce",
    "propose",
    "provider_resource",
    COMMERCE,
    "enabled_disabled",
  ),
  seed(
    "commerce.catalog.publish",
    "Publish a catalogue listing",
    "Publish an approved catalogue listing to its selected sales channel.",
    "commerce",
    "external_effect",
    "provider_resource",
    SHOPIFY,
    "approval_required_disabled",
  ),
  seed(
    "commerce.order.cancel",
    "Cancel a customer order",
    "Cancel an approved customer order at its connected commerce provider.",
    "commerce",
    "external_effect",
    "provider_resource",
    SHOPIFY,
    "approval_required_disabled",
  ),
  seed(
    "commerce.fulfillment.attach_tracking",
    "Attach fulfillment tracking",
    "Attach approved tracking details to a fulfillment.",
    "commerce",
    "external_effect",
    "provider_resource",
    SHOPIFY,
    "approval_required_disabled",
  ),
  seed(
    "commerce.entity.patch",
    "Update a commerce record",
    "Update approved fields on an exact commerce record.",
    "commerce",
    "external_effect",
    "commerce_command",
    SHOPIFY,
    "enabled_approval_required_disabled",
  ),
  seed(
    "commerce.relationship.create",
    "Create a commerce relationship",
    "Connect exact commerce records through an approved relationship.",
    "commerce",
    "external_effect",
    "commerce_command",
    SHOPIFY,
    "enabled_approval_required_disabled",
  ),
  seed(
    "commerce.relationship.delete",
    "Delete a commerce relationship",
    "Remove an approved relationship between exact commerce records.",
    "commerce",
    "external_effect",
    "commerce_command",
    SHOPIFY,
    "enabled_approval_required_disabled",
  ),
  seed(
    "commerce.list_entry.add",
    "Add a commerce-list entry",
    "Add an approved record to an exact commerce list.",
    "commerce",
    "external_effect",
    "commerce_command",
    SHOPIFY,
    "enabled_approval_required_disabled",
  ),
  seed(
    "commerce.list_entry.patch",
    "Update a commerce-list entry",
    "Update approved fields on an exact commerce-list entry.",
    "commerce",
    "external_effect",
    "commerce_command",
    COMMERCE,
    "enabled_approval_required_disabled",
  ),
  seed(
    "commerce.list_entry.remove",
    "Remove a commerce-list entry",
    "Remove an exact record from an approved commerce list.",
    "commerce",
    "external_effect",
    "commerce_command",
    SHOPIFY,
    "enabled_approval_required_disabled",
  ),
  seed(
    "commerce.saved_view.publish",
    "Publish a saved commerce view",
    "Publish the current presentation of an exact saved commerce view.",
    "commerce",
    "external_effect",
    "commerce_command",
    SHOPIFY,
    "enabled_disabled",
  ),
  seed(
    "workspace.query",
    "Read the agent workspace",
    "Query the immutable workspace revision assigned to the agent turn.",
    "agent_operations",
    "read",
    "platform",
    NONE,
    "enabled_disabled",
  ),
  seed(
    "workspace.product_folder.update",
    "Update a product workspace folder",
    "Apply an approved product-folder update to the agent workspace.",
    "agent_operations",
    "external_effect",
    "platform",
    NONE,
    "enabled_disabled",
  ),
  seed(
    "stripe.charge.create",
    "Create a Stripe charge",
    "Create an approved charge on the exact connected Stripe account.",
    "payments",
    "external_effect",
    "provider_resource",
    STRIPE,
    "approval_required_disabled",
  ),
  seed(
    "stripe.refund.create",
    "Create a Stripe refund",
    "Create an approved refund for an exact Stripe charge.",
    "payments",
    "external_effect",
    "provider_resource",
    STRIPE,
    "approval_required_disabled",
  ),
  seed(
    "stripe.subscription.cancel",
    "Cancel a Stripe subscription",
    "Cancel an approved subscription on the exact connected Stripe account.",
    "payments",
    "external_effect",
    "provider_resource",
    STRIPE,
    "approval_required_disabled",
  ),
  seed(
    "stripe.payout.create",
    "Create a Stripe payout",
    "Create an approved payout from the exact connected Stripe account.",
    "payments",
    "external_effect",
    "provider_resource",
    STRIPE,
    "approval_required_disabled",
  ),
  seed(
    "stripe.transfer.create",
    "Create a Stripe transfer",
    "Create an approved transfer to an exact connected account destination.",
    "payments",
    "external_effect",
    "provider_resource",
    STRIPE,
    "approval_required_disabled",
  ),
  seed(
    "stripe.payment_intent.capture",
    "Capture a Stripe payment",
    "Capture an approved Stripe payment intent.",
    "payments",
    "external_effect",
    "provider_resource",
    STRIPE,
    "approval_required_disabled",
  ),
  seed(
    "stripe.payment_intent.confirm",
    "Confirm a Stripe payment",
    "Confirm an approved Stripe payment intent.",
    "payments",
    "external_effect",
    "provider_resource",
    STRIPE,
    "approval_required_disabled",
  ),
  seed(
    "stripe.subscription.update",
    "Update a Stripe subscription",
    "Apply an approved update to an exact Stripe subscription.",
    "payments",
    "external_effect",
    "provider_resource",
    STRIPE,
    "approval_required_disabled",
  ),
  seed(
    "shopify.order.cancel",
    "Cancel a Shopify order",
    "Cancel an approved order on the connected Shopify store.",
    "commerce",
    "external_effect",
    "provider_resource",
    SHOPIFY,
    "approval_required_disabled",
  ),
];

const BASELINE_PROVENANCE = {
  kind: "baseline",
  profile: "read_and_propose",
  profileVersion: 3,
  materializationReceiptId: "receipt_baseline_003",
} as const;

function capabilityView(
  definition: CapabilityDefinition,
  scenario: Scenario,
  overrides: Partial<
    Pick<
      AccessControlCapabilityView,
      "mode" | "availability" | "activeGrantCount" | "provenance"
    >
  > = {},
): AccessControlCapabilityView {
  const connectedProviders =
    scenario === "fresh"
      ? new Set(["slack"])
      : new Set(["slack", "stripe", "shopify", "google_drive"]);
  const dependencyMet =
    definition.providerDependency.kind === "none" ||
    (definition.providerDependency.kind === "commerce_system"
      ? true
      : definition.providerDependency.providers.some((provider) =>
          connectedProviders.has(provider),
        ));
  const defaultMode =
    definition.policyModes === "approval_required_disabled"
      ? dependencyMet
        ? "approval_required"
        : "disabled"
      : definition.risk === "external_effect"
        ? "disabled"
        : "enabled";
  return {
    definition,
    mode: overrides.mode ?? defaultMode,
    provenance: overrides.provenance ?? BASELINE_PROVENANCE,
    revision: 4,
    changedAt: NOW - 86_400_000,
    availability:
      overrides.availability ?? (dependencyMet ? "available" : "unavailable"),
    activeGrantCount: overrides.activeGrantCount ?? 0,
    actions: {
      kind: scenario === "viewer" ? "read_only" : "change_capability_mode",
    },
  };
}

const SUBJECTS = {
  ownerRole: {
    subjectRefId: "subject:role:owner",
    kind: "organisation_role",
    label: "Owners",
    availability: "available",
  },
  adminRole: {
    subjectRefId: "subject:role:admin",
    kind: "organisation_role",
    label: "Admins",
    availability: "available",
  },
  cafeOps: {
    subjectRefId: "subject:conversation:cafe-ops",
    kind: "conversation",
    label: "#cafe-ops (Nuki Cafe Slack)",
    availability: "available",
  },
  pta: {
    subjectRefId: "subject:person:pta",
    kind: "person",
    label: "Pta",
    availability: "available",
  },
  restock: {
    subjectRefId: "subject:workflow:restock",
    kind: "workflow",
    label: "Nightly restock automation",
    availability: "available",
  },
} as const;

function grant(
  id: string,
  subject: (typeof SUBJECTS)[keyof typeof SUBJECTS],
  definition: CapabilityDefinition,
  resource: AccessControlGrantView["resource"],
  provenance: AccessControlGrantView["provenance"],
  lifecycle: AccessControlGrantView["lifecycle"],
  scenario: Scenario,
): AccessControlGrantView {
  return {
    grantId: id,
    revision: 2,
    subject,
    capability: {
      capabilityId: definition.capabilityId,
      capabilityVersion: definition.capabilityVersion,
      label: definition.label,
      risk: definition.risk,
    },
    resource,
    provenance,
    lifecycle,
    actions: { kind: scenario === "viewer" ? "read_only" : "revoke_grant" },
  };
}

const PLATFORM_RESOURCE = (
  definition: CapabilityDefinition,
): AccessControlGrantView["resource"] => ({
  targetRefId: `target:platform:${definition.capabilityId}`,
  kind: "platform",
  label: "This workspace",
  integrationAccountId: null,
  revision: 1,
});

const ACTIVE = {
  kind: "active",
  revision: 2,
  activatedAt: NOW - 86_400_000 * 2,
} as const;
const BASELINE_GRANT = {
  kind: "baseline",
  label: "Recommended default",
} as const;
const OPERATOR_GRANT = { kind: "operator", label: "Granted by Pta" } as const;

function definitionById(capabilityId: string): CapabilityDefinition {
  const definition = DEFINITIONS.find(
    (entry) => entry.capabilityId === capabilityId,
  );
  if (definition === undefined) throw new Error(`missing ${capabilityId}`);
  return definition;
}

function baselineGrants(scenario: Scenario): AccessControlGrantView[] {
  const caseRead = definitionById("context.case.read");
  const discovery = definitionById("integration.discovery.read");
  return [
    grant(
      "grant_owner_case",
      SUBJECTS.ownerRole,
      caseRead,
      PLATFORM_RESOURCE(caseRead),
      BASELINE_GRANT,
      ACTIVE,
      scenario,
    ),
    grant(
      "grant_admin_case",
      SUBJECTS.adminRole,
      caseRead,
      PLATFORM_RESOURCE(caseRead),
      BASELINE_GRANT,
      ACTIVE,
      scenario,
    ),
    grant(
      "grant_owner_discovery",
      SUBJECTS.ownerRole,
      discovery,
      PLATFORM_RESOURCE(discovery),
      BASELINE_GRANT,
      ACTIVE,
      scenario,
    ),
    grant(
      "grant_admin_discovery",
      SUBJECTS.adminRole,
      discovery,
      PLATFORM_RESOURCE(discovery),
      BASELINE_GRANT,
      ACTIVE,
      scenario,
    ),
    grant(
      "grant_channel_case",
      SUBJECTS.cafeOps,
      caseRead,
      PLATFORM_RESOURCE(caseRead),
      BASELINE_GRANT,
      ACTIVE,
      scenario,
    ),
    grant(
      "grant_channel_discovery",
      SUBJECTS.cafeOps,
      discovery,
      PLATFORM_RESOURCE(discovery),
      BASELINE_GRANT,
      ACTIVE,
      scenario,
    ),
  ];
}

function populatedGrants(scenario: Scenario): AccessControlGrantView[] {
  const fileRead = definitionById("file.read");
  const entityRead = definitionById("commerce.entity.read");
  const refund = definitionById("stripe.refund.create");
  const listPatch = definitionById("commerce.list_entry.patch");
  return [
    ...baselineGrants(scenario),
    grant(
      "grant_pta_drive",
      SUBJECTS.pta,
      fileRead,
      {
        targetRefId: "target:file:drive-supplier-contracts",
        kind: "integration_resource",
        label: "Supplier contracts (Google Drive folder)",
        integrationAccountId: "intacc_drive",
        revision: 3,
      },
      OPERATOR_GRANT,
      ACTIVE,
      scenario,
    ),
    grant(
      "grant_channel_commerce",
      SUBJECTS.cafeOps,
      entityRead,
      {
        targetRefId: "target:commerce:cafe-read-scope",
        kind: "commerce_scope",
        label: "Nuki Cafe commerce records",
        integrationAccountId: null,
        revision: 2,
      },
      OPERATOR_GRANT,
      ACTIVE,
      scenario,
    ),
    grant(
      "grant_owner_refund",
      SUBJECTS.ownerRole,
      refund,
      {
        targetRefId: "target:stripe:acct-nuki",
        kind: "integration_resource",
        label: "Stripe · Nuki Cafe (acct)",
        integrationAccountId: "intacc_stripe",
        revision: 1,
      },
      OPERATOR_GRANT,
      ACTIVE,
      scenario,
    ),
    grant(
      "grant_restock_patch",
      SUBJECTS.restock,
      listPatch,
      {
        targetRefId: "target:commerce:menu-list",
        kind: "commerce_scope",
        label: "Menu availability list",
        integrationAccountId: null,
        revision: 5,
      },
      OPERATOR_GRANT,
      {
        kind: "revoked",
        revision: 3,
        revokedAt: NOW - 3_600_000,
        reason: "Revoked after operator review.",
      },
      scenario,
    ),
  ];
}

function sourcePolicies(scenario: Scenario): AccessControlSourcePolicyView[] {
  if (scenario === "fresh") return [];
  return [
    {
      sourceRefId: "source:drive-supplier-contracts",
      revision: 3,
      capability: {
        capabilityId: "file.read",
        capabilityVersion: 1,
        label: "Read connected files",
      },
      owner: {
        integrationAccountId: "intacc_drive",
        label: "Google Drive · nuki.cafe",
      },
      resourceLabel: "Supplier contracts (Google Drive folder)",
      readers: [SUBJECTS.pta],
      availability: { kind: "available" },
      actions: { kind: "check_destination" },
    },
    {
      sourceRefId: "source:commerce-read-scope",
      revision: 2,
      capability: {
        capabilityId: "commerce.entity.read",
        capabilityVersion: 1,
        label: "Read commerce records",
      },
      owner: {
        integrationAccountId: "intacc_commerce",
        label: "Seams Checkout",
      },
      resourceLabel: "Nuki Cafe commerce records",
      readers: [SUBJECTS.cafeOps, SUBJECTS.ownerRole],
      availability: { kind: "available" },
      actions: { kind: "check_destination" },
    },
    {
      sourceRefId: "source:stripe-account",
      revision: 1,
      capability: {
        capabilityId: "stripe.refund.create",
        capabilityVersion: 1,
        label: "Create a Stripe refund",
      },
      owner: {
        integrationAccountId: "intacc_stripe",
        label: "Stripe · Nuki Cafe",
      },
      resourceLabel: "Stripe · Nuki Cafe (acct)",
      readers: [SUBJECTS.ownerRole],
      availability: { kind: "unavailable", reason: "resource_unavailable" },
      actions: { kind: "check_destination" },
    },
  ];
}

function scenarioGrants(scenario: Scenario): AccessControlGrantView[] {
  if (scenario === "empty") return [];
  return scenario === "fresh"
    ? baselineGrants(scenario)
    : populatedGrants(scenario);
}

function buildView(
  scenario: Scenario,
  grants: readonly AccessControlGrantView[],
  revision: number,
): AccessControlView {
  const capabilities = DEFINITIONS.map((definition) => {
    const active = grants.filter(
      (entry) =>
        entry.capability.capabilityId === definition.capabilityId &&
        entry.lifecycle.kind === "active",
    ).length;
    return capabilityView(definition, scenario, { activeGrantCount: active });
  });
  const sources = sourcePolicies(scenario);
  const integrationResources: Array<
    AccessControlView["integrationResources"][number]
  > =
    scenario === "fresh"
      ? [
          {
            integrationAccountId: "intacc_slack",
            provider: "slack",
            displayName: "Nuki Cafe Slack",
            availability: "available",
            updatedAt: NOW,
            actions: { kind: "none" },
          },
        ]
      : [
          {
            integrationAccountId: "intacc_slack",
            provider: "slack",
            displayName: "Nuki Cafe Slack",
            availability: "available",
            updatedAt: NOW,
            actions: { kind: "none" },
          },
          {
            integrationAccountId: "intacc_stripe",
            provider: "stripe",
            displayName: "Stripe · Nuki Cafe",
            availability: "needs_attention",
            updatedAt: NOW,
            actions: { kind: "none" },
          },
          {
            integrationAccountId: "intacc_drive",
            provider: "google_drive",
            displayName: "Google Drive · nuki.cafe",
            availability: "available",
            updatedAt: NOW,
            actions: { kind: "none" },
          },
          {
            integrationAccountId: "intacc_shopify",
            provider: "shopify",
            displayName: "Shopify · nuki-cafe.myshopify.com",
            availability: "available",
            updatedAt: NOW,
            actions: { kind: "none" },
          },
        ];
  if (new URLSearchParams(window.location.search).has("filePicker")) {
    integrationResources.push(
      {
        integrationAccountId: "intacc_dropbox_kitchen",
        provider: "dropbox",
        displayName: "Kitchen recipes",
        availability: "available",
        updatedAt: NOW,
        actions: { kind: "none" },
      },
      {
        integrationAccountId: "intacc_dropbox_office",
        provider: "dropbox",
        displayName: "Office documents",
        availability: "available",
        updatedAt: NOW,
        actions: { kind: "none" },
      },
    );
  }
  return {
    organisation: {
      organisationId: "organisation_preview",
      name: "Nuki Cafe",
      lifecycle: "active",
      configurationVersion: 12,
      requesterRole: scenario === "viewer" ? "viewer" : "owner",
      actions:
        scenario === "viewer"
          ? { kind: "read_only" }
          : { kind: "manage", createGrant: true, applyDefaults: true },
    },
    revision,
    summary: {
      capabilities: capabilities.length,
      enabledCapabilities: capabilities.filter(
        (entry) => entry.mode === "enabled",
      ).length,
      approvalRequiredCapabilities: capabilities.filter(
        (entry) => entry.mode === "approval_required",
      ).length,
      integrations: integrationResources.length,
      activeGrants: grants.filter((entry) => entry.lifecycle.kind === "active")
        .length,
      sourcePolicies: sources.length,
    },
    capabilities,
    integrationResources,
    grants: { items: [...grants], nextCursor: null },
    sourceFlowPolicies: { items: sources, nextCursor: null },
  };
}

type PreviewAccessState = {
  grants: AccessControlGrantView[];
  revision: number;
};

function applyPreviewMutation(
  state: PreviewAccessState,
  command: AccessMutationCommand,
): void {
  switch (command.kind) {
    case "create_grant":
      state.grants.push(previewGrant(state, command));
      break;
    case "revoke_grant":
      state.grants = state.grants.map((entry) =>
        entry.grantId === command.grantId
          ? {
              ...entry,
              revision: entry.revision + 1,
              lifecycle: {
                kind: "revoked",
                revision: entry.lifecycle.revision + 1,
                revokedAt: NOW,
                reason: command.reason,
              },
              actions: { kind: "read_only" },
            }
          : entry,
      );
      break;
    case "change_capability_mode":
    case "apply_defaults":
      return;
  }
  state.revision += 1;
}

function previewGrant(
  state: PreviewAccessState,
  command: Extract<AccessMutationCommand, { kind: "create_grant" }>,
): AccessControlGrantView {
  const definition = definitionById(command.target.capabilityRef.capabilityId);
  const subject = Object.values(SUBJECTS).find(
    (entry) => entry.subjectRefId === command.subjectRef.subjectRefId,
  );
  if (subject === undefined) throw new Error("missing preview subject");
  return grant(
    `grant_preview_${state.grants.length + 1}`,
    subject,
    definition,
    previewResource(definition, command.target),
    OPERATOR_GRANT,
    ACTIVE,
    "populated",
  );
}

function previewResource(
  definition: CapabilityDefinition,
  target: Extract<AccessMutationCommand, { kind: "create_grant" }>["target"],
): AccessControlGrantView["resource"] {
  switch (target.kind) {
    case "platform":
      return PLATFORM_RESOURCE(definition);
    case "provider_resource": {
      const option = resourceOptions(target.integrationRef).find(
        (entry) => entry.refId === target.resourceRef,
      );
      return {
        targetRefId: `target:${target.resourceRef}`,
        kind: "integration_resource",
        label: option?.label ?? "Connected resource",
        integrationAccountId: target.integrationRef.slice(
          "integration:".length,
        ),
        revision: 1,
      };
    }
    case "file_resource":
    case "custom_connector_operation":
      return {
        targetRefId: `target:${definition.capabilityId}:${target.integrationRef}`,
        kind: "integration_resource",
        label: "Selected resource",
        integrationAccountId: target.integrationRef.slice(
          "integration:".length,
        ),
        revision: 1,
      };
    case "commerce_entity_type":
    case "commerce_list":
    case "existing_target":
    case "published_commerce_target":
      return {
        targetRefId: `target:commerce:${definition.capabilityId}`,
        kind: "commerce_scope",
        label: "Selected commerce scope",
        integrationAccountId: null,
        revision: 1,
      };
  }
}

function subjectOptions(): readonly AccessControlOption[] {
  return [
    {
      kind: "organisation_role",
      refId: SUBJECTS.ownerRole.subjectRefId,
      revision: 1,
      label: "Owners",
      detail: "Workspace role",
      availability: "available",
    },
    {
      kind: "organisation_role",
      refId: SUBJECTS.adminRole.subjectRefId,
      revision: 1,
      label: "Admins",
      detail: "Workspace role",
      availability: "available",
    },
    {
      kind: "person",
      refId: SUBJECTS.pta.subjectRefId,
      revision: 4,
      label: "Pta",
      detail: "Owner",
      availability: "available",
    },
    {
      kind: "conversation",
      refId: SUBJECTS.cafeOps.subjectRefId,
      revision: 7,
      label: "#cafe-ops",
      detail: "Nuki Cafe Slack",
      availability: "available",
    },
    {
      kind: "workflow",
      refId: SUBJECTS.restock.subjectRefId,
      revision: 2,
      label: "Nightly restock automation",
      detail: "Automation",
      availability: "available",
    },
  ];
}

function integrationOptions(
  scenario: Scenario,
): readonly AccessControlOption[] {
  if (scenario === "fresh") return [];
  return [
    {
      kind: "integration_account",
      refId: "integration:intacc_stripe",
      revision: 1,
      label: "Stripe · Nuki Cafe",
      detail: "Stripe",
      availability: "available",
    },
    {
      kind: "integration_account",
      refId: "integration:intacc_shopify",
      revision: 1,
      label: "Shopify · nuki-cafe",
      detail: "Shopify",
      availability: "available",
    },
    {
      kind: "integration_account",
      refId: "integration:intacc_drive",
      revision: 1,
      label: "Google Drive · nuki.cafe",
      detail: "Google Drive",
      availability: "available",
    },
  ];
}

function resourceOptions(
  integrationRef: string | null,
): readonly AccessControlOption[] {
  switch (integrationRef) {
    case "integration:intacc_stripe":
      return [
        {
          kind: "provider_resource",
          refId: "provider_resource:stripe_account",
          revision: 1,
          label: "Stripe account (acct_nuki)",
          detail: "Payments account",
          availability: "available",
        },
      ];
    case "integration:intacc_shopify":
      return [
        {
          kind: "provider_resource",
          refId: "provider_resource:shopify_store",
          revision: 1,
          label: "nuki-cafe.myshopify.com",
          detail: "Store",
          availability: "available",
        },
      ];
    default:
      return [];
  }
}

function caseOptions(): readonly AccessControlOption[] {
  return [
    {
      kind: "case",
      refId: "case:supplier-price-question",
      revision: 3,
      label: "Supplier price question",
      detail: "Case",
      availability: "available",
    },
  ];
}

function explainResult(scenario: Scenario): AccessExplainResult {
  if (scenario === "populated") {
    return {
      kind: "denied",
      stage: "flow_sink",
      reason:
        "Supplier-contract content granted to Pta cannot be delivered to a shared Slack channel.",
      remediation:
        "Grant the channel read access to this source, or deliver to a direct conversation with Pta.",
    };
  }
  return {
    kind: "allowed",
    effectiveGrants: [{ grantId: "grant_channel_case", revision: 2 }],
    policyMode: "enabled",
    flowReaders: ["#cafe-ops"],
  };
}

type CaseContextCollectionPreviewState = {
  revision: number;
  relationshipKind: CaseContextCollectionRelationshipView["kind"];
};

async function readCaseContextCollectionPreview(
  scenario: Scenario,
  state: CaseContextCollectionPreviewState,
): Promise<readonly CaseContextCollectionMetadataView[]> {
  if (scenario === "fresh" || scenario === "empty") return [];
  return [
    {
      caseContextCollectionId: "case_context_collection_supplier_delivery",
      revision: state.revision,
      lifecycle: "open",
      issueKind: "supplier_delivery",
      issueInstance: "PR-842",
      anchorCaseId: "case_supplier_question",
      relationships: [
        {
          relationshipId: "relationship_delivery",
          caseId: "case_delivery_exception",
          kind: state.relationshipKind,
        },
      ],
    },
  ];
}
async function reviewCaseContextCollectionPreview(
  state: CaseContextCollectionPreviewState,
  _organisationId: string,
  caseContextCollectionId: string,
  revision: number,
  decision: CaseContextCollectionRelationshipDecision,
): Promise<void> {
  if (
    caseContextCollectionId !== "case_context_collection_supplier_delivery" ||
    revision !== state.revision ||
    decision.relationshipId !== "relationship_delivery"
  )
    throw new Error("The relationship changed. Reload before reviewing.");
  switch (decision.kind) {
    case "confirm":
      state.relationshipKind = "attached";
      break;
    case "reject":
      state.relationshipKind = "rejected";
      break;
    case "detach":
      state.relationshipKind = "detached";
      break;
  }
  state.revision += 1;
}

function buildTransport(scenario: Scenario): AccessRouteTransport {
  const fileReads = { failedPage: false, failedSearch: false };
  const caseContextCollection: CaseContextCollectionPreviewState = {
    revision: 2,
    relationshipKind: "suggested",
  };
  const access: PreviewAccessState = {
    grants: scenarioGrants(scenario),
    revision: 41,
  };
  const budgetMaximum: AiBudgetLimits = {
    maxTokens: 1_000_000,
    maxWallMs: 600_000,
    maxToolCalls: 200,
  };
  const budget: AiBudgetView = {
    limits: { maxTokens: 64_000, maxWallMs: 180_000, maxToolCalls: 20 },
    maximum: budgetMaximum,
    revision: 1,
    activation: "active",
    canManage: scenario !== "viewer",
  };
  return {
    readBudget: async () => budget,
    readCaseContextCollections: readCaseContextCollectionPreview.bind(
      null,
      scenario,
      caseContextCollection,
    ),
    readCaseScreenObservations: async () => [
      {
        page: "Costs & margins",
        area: "BakeryOS",
        record: null,
        capturedAt: Date.now() - 4 * 60_000,
        sentAt: Date.now() - 4 * 60_000,
        sources: [],
      },
      {
        page: "Orders",
        area: "AgentCommerce",
        record: "#1042",
        capturedAt: Date.now() - 30 * 60_000,
        sentAt: Date.now() - 30 * 60_000,
        sources: [{ kind: "customer_order", id: "order_1042", revision: "3" }],
      },
    ],
    reviewCaseContextCollection: reviewCaseContextCollectionPreview.bind(
      null,
      caseContextCollection,
    ),
    saveBudget: async () => undefined,
    read: async () =>
      accessSuccess(buildView(scenario, access.grants, access.revision)),
    readOptions: async (
      _organisation,
      kind,
      _query,
      _cursor,
      integrationRef,
    ) => {
      switch (kind) {
        case "subjects":
          return accessSuccess({ items: subjectOptions(), nextCursor: null });
        case "resources":
          return accessSuccess({
            items:
              integrationRef === null
                ? integrationOptions(scenario)
                : resourceOptions(integrationRef),
            nextCursor: null,
          });
        case "cases":
          return accessSuccess({ items: caseOptions(), nextCursor: null });
        case "commerce_targets":
          return accessSuccess({
            items:
              scenario === "fresh"
                ? []
                : [
                    {
                      kind: "commerce_target",
                      refId: "commerce_target:menu-espresso",
                      revision: 2,
                      label: "Espresso menu entry",
                      detail: "Published list entry",
                      availability: "available",
                    },
                  ],
            nextCursor: null,
          });
      }
    },
    mutate: async (_organisation, command) => {
      console.log("[preview] mutate", command);
      if (
        new URLSearchParams(window.location.search).get("grantFailure") ===
          "stale" &&
        command.kind === "create_grant"
      ) {
        return {
          ok: false,
          error: {
            kind: "control",
            controlKind: "configuration_conflict",
            message:
              "The connector account changed. Reload the account and choose its current operation.",
          },
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
      applyPreviewMutation(access, command);
      return accessSuccess(undefined);
    },
    explain: async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return accessSuccess(explainResult(scenario));
    },
    discoverDropbox: previewDropboxDiscovery.bind(null, fileReads),
    pickGoogleDrive: previewGoogleDriveSelection,
  };
}

async function previewDropboxDiscovery(
  reads: { failedPage: boolean; failedSearch: boolean },
  _organisationId: string,
  input: {
    integrationAccountId: string;
    path: string;
    query: string;
    cursor: string | null;
  },
): Promise<DropboxResourcePage> {
  const mode = new URLSearchParams(window.location.search).get("filePicker");
  if (
    mode === "delayed" &&
    input.integrationAccountId === "intacc_dropbox_kitchen"
  )
    await new Promise<void>(delayFilePreview);
  if (mode === "retry" && !reads.failedSearch) {
    reads.failedSearch = true;
    throw new TypeError("Failed to fetch");
  }
  if (mode === "page-retry" && input.cursor !== null && !reads.failedPage) {
    reads.failedPage = true;
    throw new TypeError("Failed to fetch");
  }
  if (mode === "empty")
    return { provider: "dropbox", entries: [], nextCursor: null };
  const kitchen = input.integrationAccountId === "intacc_dropbox_kitchen";
  const entries: DropboxResourcePage["entries"] =
    input.cursor === null
      ? [
          {
            kind: "dropbox_folder",
            providerFolderId: kitchen ? "kitchen-recipes" : "office-contracts",
            name: kitchen ? "Recipes" : "Contracts",
            pathDisplay: kitchen ? "/Kitchen/Recipes" : "/Office/Contracts",
          },
        ]
      : [
          {
            kind: "dropbox_file",
            providerFileId: "kitchen-financier",
            name: "Autumn financier production notes and ingredient specifications.pdf",
            pathDisplay:
              "/Kitchen/Recipes/Autumn financier production notes and ingredient specifications.pdf",
          },
        ];
  return {
    provider: "dropbox",
    entries,
    nextCursor: kitchen && input.cursor === null ? "page-2" : null,
  };
}

function delayFilePreview(resolve: () => void): void {
  setTimeout(resolve, 1500);
}

async function previewGoogleDriveSelection(): Promise<{
  providerFileId: string;
  name: string;
} | null> {
  const outcome = new URLSearchParams(window.location.search).get("drive");
  await new Promise<void>(delayFilePreview);
  if (outcome === "cancel") return null;
  if (outcome === "failed") throw new TypeError("Failed to fetch");
  return { providerFileId: "drive_file_1", name: "Menu photos" };
}

function accessSuccess<TValue>(value: TValue): AccessResult<TValue> {
  return { ok: true, value };
}

function parseScenario(value: string | null): Scenario {
  return value === "populated" || value === "viewer" || value === "empty"
    ? value
    : "fresh";
}

function parseSubview(value: string | null): AccessSubview {
  return value === "capabilities" || value === "data_flow" ? value : "access";
}

function PreviewApp(): React.ReactNode {
  const [params] = useSearchParams();
  const scenario = parseScenario(params.get("scenario"));
  const subview = parseSubview(params.get("view"));
  const transport = React.useMemo(() => buildTransport(scenario), [scenario]);
  const paths: Record<AccessSubview, string> = {
    access: `/access-preview.html?scenario=${scenario}&view=access`,
    capabilities: `/access-preview.html?scenario=${scenario}&view=capabilities`,
    data_flow: `/access-preview.html?scenario=${scenario}&view=data_flow`,
  };
  return (
    <div
      className="portal-shell portal-shell-workspace"
      style={{ display: "block" }}
    >
      <main
        className="portal-main"
        style={{ padding: "24px", height: "100vh", overflowY: "auto" }}
      >
        <div className="portal-main-inner">
          <nav
            aria-label="Preview scenarios"
            style={{
              display: "flex",
              gap: "12px",
              marginBottom: "16px",
              fontSize: "13px",
            }}
          >
            {(["empty", "fresh", "populated", "viewer"] as const).map(
              (entry) => (
                <a
                  key={entry}
                  href={`/access-preview.html?scenario=${entry}&view=${subview}`}
                  aria-current={entry === scenario ? "page" : undefined}
                >
                  {entry}
                  {entry === scenario ? " ✓" : ""}
                </a>
              ),
            )}
          </nav>
          <header className="portal-heading">
            <h1 id="portal-page-title" tabIndex={-1}>
              Access and data flow
            </h1>
            <p>
              Choose who can use your connected data and where it can be shared.
            </p>
          </header>
          <AccessRoute
            organisationId="organisation_preview"
            subview={subview}
            paths={paths}
            integrationsPath={`/access-preview.html?scenario=${scenario}&view=${subview}`}
            refreshKey={scenario}
            transport={transport}
          />
        </div>
      </main>
    </div>
  );
}

const container = document.getElementById("root");
if (container !== null) {
  installCustomConnectorPreview();
  if (new URLSearchParams(window.location.search).has("requests"))
    installPermissionRequestsPreview();
  // `?shell=1` puts the page in the workspace frame, with the account menu
  // and its permission requests drawer.
  const shell = new URLSearchParams(window.location.search).has("shell");
  createRoot(container).render(
    <BrowserRouter>
      <Routes>
        {shell ? (
          <Route element={<ShellPreview />}>
            <Route path="*" element={<PreviewApp />} />
          </Route>
        ) : (
          <Route path="*" element={<PreviewApp />} />
        )}
      </Routes>
    </BrowserRouter>,
  );
}

function ShellPreview(): React.ReactNode {
  const [params] = useSearchParams();
  const scenario = parseScenario(params.get("scenario"));
  const transport = React.useMemo(() => buildTransport(scenario), [scenario]);
  return (
    <WorkspaceLayout
      organisationId="organisation_preview"
      loadCodexUsage={async () => null}
      displayName="Pta"
      logout={async () => {}}
      organisation={{
        organisationHandle: "preview",
        name: "Preview organisation",
        choices: [],
      }}
      workspace={{
        workspaceHandle: "cafe",
        name: "Cafe operations",
        choices: [],
      }}
      activePage="access"
      chatOpen={false}
      chat={null}
      sidebarFooter={null}
      title="Access and data flow"
      hideHeader
      description=""
      status={null}
      access={transport}
    />
  );
}

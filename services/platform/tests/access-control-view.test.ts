/// <reference types="@cloudflare/workers-types" />

import type {
  CapabilityDefinition,
  OrganisationCapabilityPolicy,
} from "@purin-labs/contracts";
import { describe, expect, it } from "vitest";

import {
  ACCESS_CONTROL_PAGE_LIMIT,
  assembleAccessControlView,
  type AccessControlResourceProjection,
  type AccessControlViewInput,
  type TrustedSourcePolicyProjection,
} from "../src/access-control/view";
import { opaqueContextVisibilityReference } from "../src/access-control/references";
import type { AccessGrant } from "../src/authorization/access-grants/types";
import { parsePersonId } from "../src/ids";
import { FlowLabel } from "../src/policy";
import {
  requireUserId,
  requireIntegrationAccountId,
  requireOrganisationId,
} from "./test-ids";

describe("access-control aggregate view", accessControlViewSuite);

function accessControlViewSuite(): void {
  it(
    "assembles bounded human-readable records from canonical projections",
    assemblesBoundedView,
  );
  it(
    "removes mutation actions for operators and viewers",
    removesMutationActions,
  );
  it(
    "accepts either selected native commerce system as read availability",
    acceptsNativeCommerceAvailability,
  );
  it(
    "rejects a source projection whose trusted label names another owner",
    rejectsMismatchedSourceOwner,
  );
}

async function assemblesBoundedView(): Promise<void> {
  const input = await viewInput("admin", "integration_google_drive_access");
  const assembled = assembleAccessControlView(input);

  expect(assembled).toMatchObject({
    ok: true,
    value: {
      organisation: {
        name: "Cafe Export",
        requesterRole: "admin",
        actions: { kind: "manage", createGrant: true, applyDefaults: true },
      },
      revision: 7,
      summary: {
        capabilities: 2,
        enabledCapabilities: 2,
        integrations: 1,
        activeGrants: 101,
        sourcePolicies: 101,
      },
      capabilities: [
        {
          definition: { capabilityId: "context.case.read" },
          activeGrantCount: 101,
          actions: { kind: "change_capability_mode" },
        },
        {
          definition: { capabilityId: "file.read" },
          availability: "available",
        },
      ],
    },
  });
  if (!assembled.ok) throw new Error(assembled.error.field);
  expect(assembled.value.grants.items[0]).toMatchObject({
    subject: { label: "Owners" },
    resource: { label: "Satyr" },
    actions: { kind: "revoke_grant" },
  });
  expect(assembled.value.sourceFlowPolicies.items[0]).toMatchObject({
    owner: { label: "Support Drive" },
    resourceLabel: "Supplier contracts",
    readers: [{ label: "Pta" }],
    availability: { kind: "available" },
  });
  expect(assembled.value.grants.items).toHaveLength(ACCESS_CONTROL_PAGE_LIMIT);
  expect(assembled.value.sourceFlowPolicies.items).toHaveLength(
    ACCESS_CONTROL_PAGE_LIMIT,
  );
  expect(assembled.value.grants.nextCursor).toBe("access_grants_7_100");
  expect(assembled.value.sourceFlowPolicies.nextCursor).toBe(
    "access_sources_7_100",
  );
  const serialized = JSON.stringify(assembled.value);
  expect(serialized).not.toContain(
    input.sourcePolicies[0]?.kind === "available"
      ? input.sourcePolicies[0].label.digest
      : "missing_label",
  );
  expect(serialized).not.toContain("predicate");
  expect(serialized).not.toContain("credential");
  expect(serialized).not.toContain("person_access_control_owner");
  expect(assembled.value.grants.items[0]?.subject.subjectRefId).toMatch(
    /^subject_[0-9a-f]{32}$/u,
  );
}

async function removesMutationActions(): Promise<void> {
  const input = await viewInput("viewer", "integration_google_drive_access");
  const assembled = assembleAccessControlView(input);
  if (!assembled.ok) throw new Error(assembled.error.field);

  expect(assembled.value.organisation.actions).toEqual({ kind: "read_only" });
  expect(assembled.value.capabilities[0]?.actions).toEqual({
    kind: "read_only",
  });
  expect(assembled.value.grants.items[0]?.actions).toEqual({
    kind: "read_only",
  });
}

async function acceptsNativeCommerceAvailability(): Promise<void> {
  const base = await viewInput("owner", "integration_google_drive_access");
  const definition: CapabilityDefinition = {
    capabilityId: "commerce.entity.read",
    capabilityVersion: 1,
    label: "Read commerce records",
    description: "Read commerce records.",
    category: "commerce",
    risk: "read",
    target: "commerce_read",
    providerDependency: {
      kind: "commerce_system",
      systems: ["satyr_commerce", "shopify"],
    },
    policyModes: "enabled_disabled",
  };
  const policy: OrganisationCapabilityPolicy = {
    organisationId: base.organisation.organisationId,
    capabilityId: definition.capabilityId,
    capabilityVersion: 1,
    mode: "enabled",
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_commerce_read_default",
    },
    revision: 1,
    changedAt: 1,
  };
  for (const commerceSystem of ["satyr_commerce", "shopify"] as const) {
    const assembled = assembleAccessControlView({
      ...base,
      capabilityDefinitions: [...base.capabilityDefinitions, definition],
      capabilityPolicies: [...base.capabilityPolicies, policy],
      availableCommerceSystems: [commerceSystem],
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) continue;
    expect(
      assembled.value.capabilities.find(isCommerceReadCapability)?.availability,
    ).toBe("available");
  }
}

async function rejectsMismatchedSourceOwner(): Promise<void> {
  const input = await viewInput("owner", "integration_other_drive");
  const assembled = assembleAccessControlView(input);

  expect(assembled).toEqual({
    ok: false,
    error: {
      code: "access_control_view_invalid",
      field: "sourcePolicies.owner",
    },
  });
}

async function viewInput(
  requesterRole: AccessControlViewInput["requesterRole"],
  labelOwnerIntegrationAccountId: string,
): Promise<AccessControlViewInput> {
  const organisationId = requireOrganisationId("organisation_access_control_view");
  const integrationAccountId = requireIntegrationAccountId(
    "integration_google_drive_access",
  );
  const personId = requiredPersonId("person_access_control_owner");
  const userId = requireUserId(
    "user_b8cc1496-74ce-577a-9ad2-2ec2116683e7",
  );
  const definitions = capabilityDefinitions();
  const grants = accessGrants(organisationId);
  const resources = resourceProjections(grants);
  const label = await sourceLabel(
    organisationId,
    labelOwnerIntegrationAccountId,
    personId,
  );
  const sourcePolicies = sourcePolicyProjections(
    organisationId,
    integrationAccountId,
    label,
  );
  const subjectReferenceIds = new Map<string, string>();
  const ownerSubject = { kind: "organisation_role" as const, role: "owner" };
  const personSubject = { kind: "person" as const, personId };
  subjectReferenceIds.set(
    JSON.stringify(ownerSubject),
    await opaqueContextVisibilityReference(organisationId, ownerSubject),
  );
  subjectReferenceIds.set(
    JSON.stringify(personSubject),
    await opaqueContextVisibilityReference(organisationId, personSubject),
  );
  return {
    organisation: {
      organisationId,
      name: "Cafe Export",
      lifecycle: "active",
      configurationVersion: 5,
      projectionRevision: 7,
    },
    requesterRole,
    members: [
      {
        organisationId,
        personId,
        userId,
        role: "owner",
        displayName: "Pta",
      },
    ],
    capabilityDefinitions: definitions,
    capabilityPolicies: capabilityPolicies(organisationId),
    integrations: [
      {
        organisationId,
        integrationAccountId,
        provider: "google_drive",
        displayName: "Support Drive",
        availability: "available",
        updatedAt: 1_000,
      },
    ],
    availableCommerceSystems: [],
    subjectReferenceIds,
    grants,
    resources,
    sourcePolicies,
    grantOffset: 0,
    sourcePolicyOffset: 0,
  };
}

function capabilityDefinitions(): readonly CapabilityDefinition[] {
  return [
    {
      capabilityId: "context.case.read",
      capabilityVersion: 1,
      label: "Read Case context",
      description: "Read accepted Case context.",
      category: "context",
      risk: "read",
      target: "platform",
      providerDependency: { kind: "none" },
      policyModes: "enabled_disabled",
    },
    {
      capabilityId: "file.read",
      capabilityVersion: 1,
      label: "Read connected files",
      description: "Read files from an exact connected account.",
      category: "customer_data",
      risk: "read",
      target: "file_resource",
      providerDependency: { kind: "provider", providers: ["google_drive"] },
      policyModes: "enabled_disabled",
    },
  ];
}

function capabilityPolicies(
  organisationId: ReturnType<typeof requireOrganisationId>,
): readonly OrganisationCapabilityPolicy[] {
  return [
    {
      organisationId,
      capabilityId: "context.case.read",
      capabilityVersion: 1,
      mode: "enabled",
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: "receipt_context_default",
      },
      revision: 1,
      changedAt: 1,
    },
    {
      organisationId,
      capabilityId: "file.read",
      capabilityVersion: 1,
      mode: "enabled",
      provenance: {
        kind: "integration_setup",
        integrationAccountId: "integration_google_drive_access",
        setupRevision: 1,
        materializationReceiptId: "receipt_drive_setup",
      },
      revision: 2,
      changedAt: 2,
    },
  ];
}

function accessGrants(
  organisationId: ReturnType<typeof requireOrganisationId>,
): readonly AccessGrant[] {
  const grants: AccessGrant[] = [];
  for (let index = 0; index < 101; index += 1) {
    grants.push({
      grantId: `grant_access_control_${String(index).padStart(3, "0")}`,
      organisationId,
      subject: { kind: "organisation_role", role: "owner" },
      target: {
        kind: "platform_capability",
        capabilityId: "context.case.read",
        capabilityVersion: 1,
      },
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: `receipt_access_control_${index}`,
      },
      lifecycle: { kind: "active", revision: 1, activatedAt: 1 },
    });
  }
  return grants;
}

function resourceProjections(
  grants: readonly AccessGrant[],
): readonly AccessControlResourceProjection[] {
  const resources: AccessControlResourceProjection[] = [];
  for (const grant of grants) {
    resources.push({
      kind: "platform",
      grantId: grant.grantId,
      targetRefId: `target_${grant.grantId}`,
      revision: grant.lifecycle.revision,
      label: "Satyr",
    });
  }
  return resources;
}

async function sourceLabel(
  organisationId: ReturnType<typeof requireOrganisationId>,
  integrationAccountId: string,
  personId: ReturnType<typeof requiredPersonId>,
): Promise<FlowLabel> {
  const created = await FlowLabel.create([
    {
      owner: {
        kind: "integration_resource",
        organisationId,
        integrationAccountId,
        resourceScope: "gdrive_file:supplier_contracts",
      },
      readers: [{ kind: "person", personId }],
    },
  ]);
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

function sourcePolicyProjections(
  organisationId: ReturnType<typeof requireOrganisationId>,
  integrationAccountId: ReturnType<typeof requireIntegrationAccountId>,
  label: FlowLabel,
): readonly TrustedSourcePolicyProjection[] {
  const sources: TrustedSourcePolicyProjection[] = [];
  for (let index = 0; index < 101; index += 1) {
    sources.push({
      kind: "available",
      organisationId,
      sourceRefId: `source_drive_supplier_contracts_${String(index).padStart(3, "0")}`,
      revision: 2,
      capabilityId: "file.read",
      capabilityVersion: 1,
      integrationAccountId,
      resourceScope: "gdrive_file:supplier_contracts",
      resourceLabel: "Supplier contracts",
      label,
    });
  }
  return sources;
}

function requiredPersonId(value: string) {
  const parsed = parsePersonId(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function isCommerceReadCapability(capability: {
  readonly definition: CapabilityDefinition;
}): boolean {
  return capability.definition.capabilityId === "commerce.entity.read";
}

import type { OrganisationDatabase } from "../database-handles";
import type {
  CapabilityCommerceSystem,
  CapabilityDefinition,
  OnboardingControlRole,
} from "@purin-labs/contracts";

import type { AccessGrant } from "../authorization/access-grants/types";
import {
  CAPABILITY_CATALOGUE,
  CAPABILITY_KEYS,
} from "../authorization/capability-catalogue";
import { listAccessGrants } from "../data/access-grants";
import { readOrganisationCapabilityPolicies } from "../data/capability-policy";
import { listOrganisationMembers } from "../data/control-plane";
import {
  listIntegrationAccounts,
  type IntegrationAccount,
  type IntegrationAccountLifecycle,
} from "../data/integration-account";
import {
  resolveOrganisationCommerceSystem,
  resolveOrganisationCommerceSystemAuthority,
} from "../data/organisation-commerce-system";
import { resolveCommerceMerchantBinding } from "../data/commerce-merchant-binding";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../ids";
import {
  createCurrentSourceFlowLabel,
  integrationResourceScopeForGrant,
  type CurrentSourceFlowLabelError,
} from "../policy/information-flow";
import type { Result } from "../result";
import {
  assembleAccessControlView,
  type AccessControlIntegrationProjection,
  type AccessControlMemberProjection,
  type AccessControlResourceProjection,
  type AccessControlOrganisationProjection,
  type AccessControlView,
  type TrustedSourcePolicyProjection,
} from "./view";
import {
  opaqueAccessTargetReference,
  opaqueContextVisibilityReference,
  opaqueInformationSourceReference,
} from "./references";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isPositiveInteger } from "@purin-labs/std";

type AccessControlOrganisationRow = Readonly<{
  organisationId: unknown;
  name: unknown;
  lifecycle: unknown;
  configurationVersion: unknown;
  projectionRevision: unknown;
}>;

type AccessControlReadError = Readonly<{
  code: "access_control_read_unavailable";
  field: string;
}>;

type SourcePolicyGroup = Readonly<{
  integrationAccountId: IntegrationAccountId;
  capabilityId: string;
  capabilityVersion: number;
  resourceScope: string;
  resourceLabel: string;
  grantIds: readonly string[];
  revision: number;
}>;

export async function readAccessControlView(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    requesterRole: OnboardingControlRole;
    grantOffset: number;
    sourcePolicyOffset: number;
  }>,
): Promise<Result<AccessControlView, AccessControlReadError>> {
  try {
    const organisation = await readAccessControlOrganisationProjection(
      input.db,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    const grants = await listAccessGrants({
      db: input.db,
      organisationId: input.organisationId,
    });
    if (!grants.ok) return unavailable(`grants.${grants.error.code}`);
    const capabilityPolicies = await readOrganisationCapabilityPolicies({
      db: input.db,
      organisationId: input.organisationId,
    });
    if (!capabilityPolicies.ok)
      return unavailable(`capabilities.${capabilityPolicies.error.code}`);
    const members = memberProjections(
      await listOrganisationMembers({ db: input.db, organisationId: input.organisationId }),
    );
    const accounts = await listIntegrationAccounts({
      db: input.db,
      organisationId: input.organisationId,
    });
    const externalIntegrations = integrationProjections(accounts);
    const customIntegrations = await readCustomIntegrationProjections(
      input.db,
      input.organisationId,
    );
    if (!customIntegrations.ok) return customIntegrations;
    const availableCommerceSystems = await readAvailableCommerceSystems(
      input.db,
      input.organisationId,
    );
    if (!availableCommerceSystems.ok) return availableCommerceSystems;
    const commerceAccount = await commerceIntegrationAccount(
      input.db,
      input.organisationId,
      grants.value,
    );
    if (!commerceAccount.ok) return commerceAccount;
    const integrations = await includeCommerceIntegration({
      db: input.db,
      organisationId: input.organisationId,
      integrations: [...externalIntegrations, ...customIntegrations.value],
      commerceIntegrationAccountId: commerceAccount.value,
      availableCommerceSystems: availableCommerceSystems.value,
    });
    if (!integrations.ok) return integrations;
    const resources = await resourceProjections(
      grants.value,
      integrations.value,
      commerceAccount.value,
      availableCommerceSystems.value,
    );
    if (!resources.ok) return resources;
    const sourcePolicies = await sourcePolicyProjections({
      db: input.db,
      organisationId: input.organisationId,
      grants: grants.value,
      integrations: integrations.value,
      commerceIntegrationAccountId: commerceAccount.value,
    });
    if (!sourcePolicies.ok) return sourcePolicies;
    const subjectReferenceIds = await buildSubjectReferenceIds(
      input.organisationId,
      grants.value,
      sourcePolicies.value,
    );
    const assembled = assembleAccessControlView({
      organisation: organisation.value,
      requesterRole: input.requesterRole,
      members,
      capabilityDefinitions: CAPABILITY_CATALOGUE,
      capabilityPolicies: capabilityPolicies.value,
      integrations: integrations.value,
      availableCommerceSystems: availableCommerceSystems.value,
      subjectReferenceIds,
      grants: grants.value,
      resources: resources.value,
      sourcePolicies: sourcePolicies.value,
      grantOffset: input.grantOffset,
      sourcePolicyOffset: input.sourcePolicyOffset,
    });
    return assembled.ok
      ? assembled
      : unavailable(`view.${assembled.error.field}`);
  } catch {
    return unavailable("database");
  }
}

type CustomIntegrationProjectionRow = Readonly<{
  integrationAccountId: unknown;
  displayName: unknown;
  lifecycle: unknown;
  updatedAt: unknown;
}>;

async function readCustomIntegrationProjections(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<
  Result<readonly AccessControlIntegrationProjection[], AccessControlReadError>
> {
  const rows = await db
    .prepare(
      `SELECT integration_account_id AS integrationAccountId,
              display_name AS displayName, lifecycle, updated_at AS updatedAt
       FROM integration_account
       WHERE organisation_id = ? AND source_kind = 'custom_api'
       ORDER BY lower(display_name), integration_account_id`,
    )
    .bind(organisationId)
    .all<CustomIntegrationProjectionRow>();
  const projections: AccessControlIntegrationProjection[] = [];
  for (const row of rows.results) {
    if (typeof row.integrationAccountId !== "string") {
      return unavailable("integrations.custom");
    }
    const integrationAccountId = parseIntegrationAccountId(
      row.integrationAccountId,
    );
    const availability = customIntegrationAvailability(row.lifecycle);
    if (
      !integrationAccountId.ok ||
      typeof row.displayName !== "string" ||
      availability === null ||
      !isPositiveInteger(row.updatedAt)
    ) {
      return unavailable("integrations.custom");
    }
    projections.push({
      organisationId,
      integrationAccountId: integrationAccountId.value,
      provider: "custom_api",
      displayName: row.displayName,
      availability,
      updatedAt: row.updatedAt,
    });
  }
  return { ok: true, value: projections };
}

function customIntegrationAvailability(
  lifecycle: unknown,
): AccessControlIntegrationProjection["availability"] | null {
  switch (lifecycle) {
    case "active":
      return "available";
    case "connecting":
    case "pending_activation":
    case "degraded":
    case "reauth_required":
      return "needs_attention";
    case "disabled":
    case "revoked":
      return "unavailable";
    default:
      return null;
  }
}

async function includeCommerceIntegration(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrations: readonly AccessControlIntegrationProjection[];
    commerceIntegrationAccountId: IntegrationAccountId | null;
    availableCommerceSystems: readonly CapabilityCommerceSystem[];
  }>,
): Promise<
  Result<readonly AccessControlIntegrationProjection[], AccessControlReadError>
> {
  if (
    input.commerceIntegrationAccountId === null ||
    findIntegration(input.integrations, input.commerceIntegrationAccountId) !==
      null
  ) {
    return { ok: true, value: input.integrations };
  }
  if (!input.availableCommerceSystems.includes("satyr_commerce")) {
    return unavailable("commerce.integration");
  }
  const binding = await resolveCommerceMerchantBinding({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.commerceIntegrationAccountId,
  });
  if (!binding.ok) return unavailable(`commerce.${binding.error.code}`);
  return {
    ok: true,
    value: [
      ...input.integrations,
      {
        organisationId: input.organisationId,
        integrationAccountId: binding.value.integrationAccountId,
        provider: "satyr_commerce",
        displayName: "Seams Checkout",
        availability: "available",
        updatedAt: binding.value.updatedAt,
      },
    ],
  };
}

async function buildSubjectReferenceIds(
  organisationId: OrganisationId,
  grants: readonly AccessGrant[],
  sourcePolicies: readonly TrustedSourcePolicyProjection[],
): Promise<ReadonlyMap<string, string>> {
  const references = new Map<string, string>();
  for (const grant of grants) {
    await addSubjectReference(references, organisationId, grant.subject);
  }
  for (const source of sourcePolicies) {
    if (source.kind !== "available") continue;
    for (const policy of source.label.policies) {
      for (const reader of policy.readers) {
        if (reader.kind === "project" || reader.kind === "chat_conversation") continue;
        await addSubjectReference(references, organisationId, reader);
      }
    }
  }
  return references;
}

async function addSubjectReference(
  references: Map<string, string>,
  organisationId: OrganisationId,
  subject: Parameters<typeof opaqueContextVisibilityReference>[1],
): Promise<void> {
  const key = JSON.stringify(subject);
  if (references.has(key)) return;
  references.set(
    key,
    await opaqueContextVisibilityReference(organisationId, subject),
  );
}

async function readAvailableCommerceSystems(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<
  Result<readonly CapabilityCommerceSystem[], AccessControlReadError>
> {
  const selected = await resolveOrganisationCommerceSystem({ db, organisationId });
  if (!selected.ok) {
    return selected.error.code === "commerce_system_not_found"
      ? { ok: true, value: [] }
      : unavailable(`commerceSystem.${selected.error.code}`);
  }
  return {
    ok: true,
    value: [selected.value.kind],
  };
}

export async function readAccessControlOrganisationProjection(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<Result<AccessControlOrganisationProjection, AccessControlReadError>> {
  try {
    const row = await db
      .prepare(
        `SELECT organisation.organisation_id AS organisationId,
              organisation.name,
              onboarding.lifecycle,
              onboarding.configuration_version AS configurationVersion,
              onboarding.projection_revision AS projectionRevision
         FROM organisation
         JOIN organisation_onboarding AS onboarding
           ON onboarding.organisation_id = organisation.organisation_id
        WHERE organisation.organisation_id = ?`,
      )
      .bind(organisationId)
      .first<AccessControlOrganisationRow>();
    return parseOrganisationProjection(organisationId, row);
  } catch {
    return unavailable("organisation");
  }
}

function parseOrganisationProjection(
  organisationId: OrganisationId,
  row: AccessControlOrganisationRow | null,
): Result<AccessControlOrganisationProjection, AccessControlReadError> {
  if (
    row === null ||
    row.organisationId !== organisationId ||
    typeof row.name !== "string" ||
    row.name.trim().length === 0
  ) {
    return unavailable("organisation");
  }
  const lifecycle = organisationLifecycle(row.lifecycle);
  if (lifecycle === null) return unavailable("organisation.lifecycle");
  if (!isPositiveInteger(row.configurationVersion))
    return unavailable("organisation.configurationVersion");
  if (!isPositiveInteger(row.projectionRevision))
    return unavailable("organisation.projectionRevision");
  return {
    ok: true,
    value: {
      organisationId,
      name: row.name,
      lifecycle,
      configurationVersion: row.configurationVersion,
      projectionRevision: row.projectionRevision,
    },
  };
}

function organisationLifecycle(
  value: unknown,
): AccessControlOrganisationProjection["lifecycle"] | null {
  return value === "draft" ||
    value === "configuring" ||
    value === "activating" ||
    value === "active" ||
    value === "suspended" ||
    value === "archived"
    ? value
    : null;
}

function memberProjections(
  members: Awaited<ReturnType<typeof listOrganisationMembers>>,
): readonly AccessControlMemberProjection[] {
  const projections: AccessControlMemberProjection[] = [];
  for (const member of members) {
    projections.push({
      organisationId: member.organisationId,
      personId: member.personId,
      userId: member.userId,
      role: member.role,
      displayName: member.displayName,
    });
  }
  return projections;
}

function integrationProjections(
  accounts: readonly IntegrationAccount[],
): readonly AccessControlIntegrationProjection[] {
  const projections: AccessControlIntegrationProjection[] = [];
  for (const account of accounts) {
    projections.push({
      organisationId: account.organisationId,
      integrationAccountId: account.integrationAccountId,
      provider: account.provider,
      displayName: account.displayName,
      availability: integrationAvailability(account.lifecycle),
      updatedAt: account.updatedAt,
    });
  }
  return projections;
}

function integrationAvailability(
  lifecycle: IntegrationAccountLifecycle,
): AccessControlIntegrationProjection["availability"] {
  switch (lifecycle.kind) {
    case "active":
      return "available";
    case "connecting":
    case "pending_activation":
    case "degraded":
    case "reauth_required":
      return "needs_attention";
    case "disabled":
    case "revoked":
      return "unavailable";
    default:
      return assertNever(lifecycle);
  }
}

async function commerceIntegrationAccount(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  grants: readonly AccessGrant[],
): Promise<Result<IntegrationAccountId | null, AccessControlReadError>> {
  if (!grants.some(grantUsesCommerceAccount)) return { ok: true, value: null };
  const authority = await resolveOrganisationCommerceSystemAuthority({
    db,
    organisationId,
  });
  return authority.ok
    ? { ok: true, value: authority.value.integrationAccountId }
    : unavailable(`commerce.${authority.error.code}`);
}

function grantUsesCommerceAccount(grant: AccessGrant): boolean {
  return (
    grant.target.kind === "commerce_read" ||
    grant.target.kind === "commerce_command" ||
    (grant.target.kind === "provider_resource" &&
      grant.target.capabilityId === CAPABILITY_KEYS.commerceActionPropose)
  );
}

async function resourceProjections(
  grants: readonly AccessGrant[],
  integrations: readonly AccessControlIntegrationProjection[],
  commerceIntegrationAccountId: IntegrationAccountId | null,
  availableCommerceSystems: readonly CapabilityCommerceSystem[],
): Promise<
  Result<readonly AccessControlResourceProjection[], AccessControlReadError>
> {
  const projections: AccessControlResourceProjection[] = [];
  for (const grant of grants) {
    const definition = definitionForGrant(grant);
    if (definition === null)
      return unavailable(`grant.${grant.grantId}.capability`);
    const targetRefId = await opaqueAccessTargetReference(
      grant.organisationId,
      grant.target,
    );
    switch (grant.target.kind) {
      case "platform_capability":
        projections.push({
          kind: "platform",
          grantId: grant.grantId,
          targetRefId,
          revision: grant.lifecycle.revision,
          label: definition.label,
        });
        break;
      case "provider_resource": {
        if (
          grant.target.capabilityId === CAPABILITY_KEYS.commerceActionPropose &&
          grant.target.resourceScope.startsWith("commerce:list_entry:") &&
          commerceIntegrationAccountId === grant.target.integrationAccountId &&
          availableCommerceSystems.includes("satyr_commerce")
        ) {
          projections.push({
            kind: "commerce_scope",
            grantId: grant.grantId,
            targetRefId,
            revision: grant.lifecycle.revision,
            label: `Seams Checkout · ${definition.label}`,
            integrationAccountId: commerceIntegrationAccountId,
          });
          break;
        }
        const integration = findIntegration(
          integrations,
          grant.target.integrationAccountId,
        );
        if (integration === null)
          return unavailable(`grant.${grant.grantId}.integration`);
        projections.push({
          kind: "integration_resource",
          grantId: grant.grantId,
          targetRefId,
          revision: grant.lifecycle.revision,
          label: `${integration.displayName} · ${definition.label}`,
          integrationAccountId: integration.integrationAccountId,
        });
        break;
      }
      case "file_resource": {
        const integration = findIntegration(
          integrations,
          grant.target.integrationAccountId,
        );
        if (integration === null)
          return unavailable(`grant.${grant.grantId}.integration`);
        projections.push({
          kind: "integration_resource",
          grantId: grant.grantId,
          targetRefId,
          revision: grant.lifecycle.revision,
          label: `${integration.displayName} · ${definition.label}`,
          integrationAccountId: integration.integrationAccountId,
        });
        break;
      }
      case "custom_connector_operation": {
        const integration = findIntegration(
          integrations,
          grant.target.integrationAccountId,
        );
        if (integration === null)
          return unavailable(`grant.${grant.grantId}.integration`);
        projections.push({
          kind: "integration_resource",
          grantId: grant.grantId,
          targetRefId,
          revision: grant.lifecycle.revision,
          label: `${integration.displayName} · ${definition.label}`,
          integrationAccountId: integration.integrationAccountId,
        });
        break;
      }
      case "commerce_read":
      case "commerce_command": {
        if (commerceIntegrationAccountId === null)
          return unavailable(`grant.${grant.grantId}.commerce`);
        const integration = findIntegration(
          integrations,
          commerceIntegrationAccountId,
        );
        if (integration === null)
          return unavailable(`grant.${grant.grantId}.commerceIntegration`);
        projections.push({
          kind: "commerce_scope",
          grantId: grant.grantId,
          targetRefId,
          revision: grant.lifecycle.revision,
          label: `${integration.displayName} · ${definition.label}`,
          integrationAccountId: commerceIntegrationAccountId,
        });
        break;
      }
      default:
        assertNever(grant.target);
    }
  }
  return { ok: true, value: projections };
}

async function sourcePolicyProjections(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    grants: readonly AccessGrant[];
    integrations: readonly AccessControlIntegrationProjection[];
    commerceIntegrationAccountId: IntegrationAccountId | null;
  }>,
): Promise<
  Result<readonly TrustedSourcePolicyProjection[], AccessControlReadError>
> {
  const groups = sourcePolicyGroups(input);
  if (!groups.ok) return groups;
  const projections: TrustedSourcePolicyProjection[] = [];
  for (const group of groups.value) {
    const sourceRefId = await opaqueInformationSourceReference(input.organisationId, {
      integrationAccountId: group.integrationAccountId,
      capabilityId: group.capabilityId,
      capabilityVersion: group.capabilityVersion,
      resourceScope: group.resourceScope,
    });
    const label = await createCurrentSourceFlowLabel({
      kind: "integration_resource",
      db: input.db,
      organisationId: input.organisationId,
      integrationAccountId: group.integrationAccountId,
      capabilityId: group.capabilityId,
      resourceScope: group.resourceScope,
      grantIds: group.grantIds,
    });
    const base = {
      organisationId: input.organisationId,
      sourceRefId,
      revision: group.revision,
      capabilityId: group.capabilityId,
      capabilityVersion: group.capabilityVersion,
      integrationAccountId: group.integrationAccountId,
      resourceScope: group.resourceScope,
      resourceLabel: group.resourceLabel,
    };
    projections.push(
      label.ok
        ? { kind: "available", ...base, label: label.value }
        : {
            kind: "unavailable",
            ...base,
            unavailableReason: unavailableSourceReason(label.error),
          },
    );
  }
  return { ok: true, value: projections };
}

function sourcePolicyGroups(
  input: Readonly<{
    grants: readonly AccessGrant[];
    integrations: readonly AccessControlIntegrationProjection[];
    commerceIntegrationAccountId: IntegrationAccountId | null;
  }>,
): Result<readonly SourcePolicyGroup[], AccessControlReadError> {
  const groups = new Map<
    string,
    {
      integrationAccountId: IntegrationAccountId;
      capabilityId: string;
      capabilityVersion: number;
      resourceScope: string;
      resourceLabel: string;
      grantIds: string[];
      revision: number;
    }
  >();
  for (const grant of input.grants) {
    if (grant.lifecycle.kind !== "active") continue;
    const definition = definitionForGrant(grant);
    if (definition === null)
      return unavailable(`grant.${grant.grantId}.capability`);
    const resourceScope = integrationResourceScopeForGrant(grant);
    if (definition.risk !== "read" || resourceScope === null) continue;
    const integrationAccountIdRaw = sourceIntegrationAccountId(
      grant,
      input.commerceIntegrationAccountId,
    );
    if (integrationAccountIdRaw === null)
      return unavailable(`grant.${grant.grantId}.sourceIntegration`);
    const integration = findIntegration(
      input.integrations,
      integrationAccountIdRaw,
    );
    if (integration === null)
      return unavailable(`grant.${grant.grantId}.sourceIntegration`);
    const integrationAccountId = integration.integrationAccountId;
    const key = JSON.stringify([
      integrationAccountId,
      definition.capabilityId,
      definition.capabilityVersion,
      resourceScope,
    ]);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        integrationAccountId,
        capabilityId: definition.capabilityId,
        capabilityVersion: definition.capabilityVersion,
        resourceScope,
        resourceLabel: `${integration.displayName} · ${definition.label}`,
        grantIds: [grant.grantId],
        revision: grant.lifecycle.revision,
      });
      continue;
    }
    existing.grantIds.push(grant.grantId);
    existing.revision = Math.max(existing.revision, grant.lifecycle.revision);
  }
  return { ok: true, value: [...groups.values()] };
}

function sourceIntegrationAccountId(
  grant: AccessGrant,
  commerceIntegrationAccountId: IntegrationAccountId | null,
): string | null {
  switch (grant.target.kind) {
    case "provider_resource":
    case "file_resource":
    case "custom_connector_operation":
      return grant.target.integrationAccountId;
    case "commerce_read":
      return commerceIntegrationAccountId;
    case "platform_capability":
    case "commerce_command":
      return null;
    default:
      return assertNever(grant.target);
  }
}

function unavailableSourceReason(
  error: CurrentSourceFlowLabelError,
): Variant<TrustedSourcePolicyProjection, "unavailable">["unavailableReason"] {
  switch (error.code) {
    case "source_capability_disabled":
      return "capability_disabled";
    case "source_resource_inactive":
      return "resource_unavailable";
    case "source_subject_inactive":
    case "source_grant_unavailable":
      return "subject_unavailable";
    case "source_policy_invalid":
    case "source_policy_unavailable":
    case "invalid_flow_policy":
    case "invalid_flow_label":
    case "flow_label_digest_mismatch":
      return "policy_unavailable";
    default:
      return assertNever(error);
  }
}

function definitionForGrant(grant: AccessGrant): CapabilityDefinition | null {
  for (const definition of CAPABILITY_CATALOGUE) {
    if (
      definition.capabilityId === grant.target.capabilityId &&
      definition.capabilityVersion === grant.target.capabilityVersion
    )
      return definition;
  }
  return null;
}

function findIntegration(
  integrations: readonly AccessControlIntegrationProjection[],
  integrationAccountId: string,
): AccessControlIntegrationProjection | null {
  for (const integration of integrations) {
    if (integration.integrationAccountId === integrationAccountId)
      return integration;
  }
  return null;
}

function unavailable(field: string): Result<never, AccessControlReadError> {
  return {
    ok: false,
    error: { code: "access_control_read_unavailable", field },
  };
}

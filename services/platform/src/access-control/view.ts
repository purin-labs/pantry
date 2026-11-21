import type {
  CommerceSystemKind,
  CapabilityDefinition,
  CapabilityMode,
  CapabilityPolicyProvenance,
  GrantProvenance,
  GrantSubject,
  OrganisationCapabilityPolicy,
} from "@purin-labs/contracts";

import type {
  AccessGrant,
  ContextVisibility,
} from "../authorization/access-grants/types";
import { CAPABILITY_KEYS } from "../authorization/capability-catalogue";
import type { IntegrationAccountId, PersonId, OrganisationId } from "../ids";
import type { UserId } from "@purin-labs/control-api/ids";
import { FlowLabel } from "../policy";
import type { Result } from "../result";
import type { ControlRole } from "../data/control-plane";
import type { Variant } from "@purin-labs/type-utils";
import {
  assertNever,
  isNonNegativeInteger,
  isPositiveInteger,
} from "@purin-labs/std";
import type {
  AccessControlAvailability,
  AccessControlBoundedPage,
} from "@purin-labs/control-api";

export const ACCESS_CONTROL_PAGE_LIMIT = 100;

export type AccessControlOrganisationProjection = Readonly<{
  organisationId: OrganisationId;
  name: string;
  lifecycle:
    | "draft"
    | "configuring"
    | "activating"
    | "active"
    | "suspended"
    | "archived";
  configurationVersion: number;
  projectionRevision: number;
}>;

export type AccessControlMemberProjection = Readonly<{
  organisationId: OrganisationId;
  personId: PersonId;
  userId: UserId;
  role: ControlRole;
  displayName: string;
}>;

export type AccessControlIntegrationProjection = Readonly<{
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  provider: string;
  displayName: string;
  availability: "available" | "needs_attention" | "unavailable";
  updatedAt: number;
}>;

type AccessControlResourceProjectionBase = Readonly<{
  grantId: AccessGrant["grantId"];
  targetRefId: string;
  revision: number;
  label: string;
}>;

export type AccessControlResourceProjection =
  | (AccessControlResourceProjectionBase &
      Readonly<{
        kind: "platform";
        integrationAccountId?: never;
      }>)
  | (AccessControlResourceProjectionBase &
      Readonly<{
        kind: "integration_resource";
        integrationAccountId: IntegrationAccountId;
      }>)
  | (AccessControlResourceProjectionBase &
      Readonly<{
        kind: "commerce_scope";
        integrationAccountId: IntegrationAccountId;
      }>);

type SourcePolicyProjectionBase = Readonly<{
  organisationId: OrganisationId;
  sourceRefId: string;
  revision: number;
  capabilityId: string;
  capabilityVersion: number;
  integrationAccountId: IntegrationAccountId;
  resourceScope: string;
  resourceLabel: string;
}>;

export type TrustedSourcePolicyProjection =
  | (SourcePolicyProjectionBase &
      Readonly<{
        kind: "available";
        label: FlowLabel;
        unavailableReason?: never;
      }>)
  | (SourcePolicyProjectionBase &
      Readonly<{
        kind: "unavailable";
        label?: never;
        unavailableReason:
          | "capability_disabled"
          | "resource_unavailable"
          | "subject_unavailable"
          | "policy_unavailable";
      }>);

export type AccessControlViewInput = Readonly<{
  organisation: AccessControlOrganisationProjection;
  requesterRole: ControlRole;
  members: readonly AccessControlMemberProjection[];
  capabilityDefinitions: readonly CapabilityDefinition[];
  capabilityPolicies: readonly OrganisationCapabilityPolicy[];
  integrations: readonly AccessControlIntegrationProjection[];
  availableCommerceSystems: readonly CommerceSystemKind[];
  subjectReferenceIds: ReadonlyMap<string, string>;
  grants: readonly AccessGrant[];
  resources: readonly AccessControlResourceProjection[];
  sourcePolicies: readonly TrustedSourcePolicyProjection[];
  grantOffset: number;
  sourcePolicyOffset: number;
}>;

type AccessControlCapabilityActions =
  | Readonly<{ kind: "read_only" }>
  | Readonly<{ kind: "change_capability_mode" }>;

type AccessControlGrantActions =
  Readonly<{ kind: "read_only" }> | Readonly<{ kind: "revoke_grant" }>;

type AccessControlViewActions =
  | Readonly<{ kind: "read_only" }>
  | Readonly<{ kind: "manage"; createGrant: true; applyDefaults: true }>;

type AccessControlCapabilityView = Readonly<{
  definition: CapabilityDefinition;
  mode: CapabilityMode;
  provenance: CapabilityPolicyProvenance;
  revision: number;
  changedAt: number;
  availability: AccessControlAvailability;
  activeGrantCount: number;
  actions: AccessControlCapabilityActions;
}>;

type AccessControlIntegrationView = Readonly<{
  integrationAccountId: IntegrationAccountId;
  provider: string;
  displayName: string;
  availability: AccessControlAvailability;
  updatedAt: number;
  actions: Readonly<{ kind: "none" }>;
}>;

type AccessControlSubjectView = Readonly<{
  subjectRefId: string;
  kind: GrantSubject["kind"] | ContextVisibility["kind"];
  label: string;
  availability: "available" | "unavailable";
}>;

type AccessControlResourceView = Readonly<{
  targetRefId: string;
  kind: AccessControlResourceProjection["kind"];
  label: string;
  integrationAccountId: IntegrationAccountId | null;
  revision: number;
}>;

type AccessControlProvenanceView = Readonly<{
  kind: GrantProvenance["kind"];
  label: string;
}>;

type AccessControlGrantView = Readonly<{
  grantId: AccessGrant["grantId"];
  revision: number;
  subject: AccessControlSubjectView;
  capability: Readonly<{
    capabilityId: string;
    capabilityVersion: number;
    label: string;
    risk: CapabilityDefinition["risk"];
  }>;
  resource: AccessControlResourceView;
  provenance: AccessControlProvenanceView;
  lifecycle: AccessGrant["lifecycle"];
  actions: AccessControlGrantActions;
}>;

type AccessControlSourcePolicyView = Readonly<{
  sourceRefId: string;
  revision: number;
  capability: Readonly<{
    capabilityId: string;
    capabilityVersion: number;
    label: string;
  }>;
  owner: Readonly<{
    integrationAccountId: IntegrationAccountId;
    label: string;
  }>;
  resourceLabel: string;
  readers: readonly AccessControlSubjectView[];
  availability:
    | Readonly<{ kind: "available" }>
    | Readonly<{
        kind: "unavailable";
        reason: Variant<
          TrustedSourcePolicyProjection,
          "unavailable"
        >["unavailableReason"];
      }>;
  actions: Readonly<{ kind: "check_destination" }>;
}>;

export type AccessControlView = Readonly<{
  organisation: Readonly<{
    organisationId: OrganisationId;
    name: string;
    lifecycle: AccessControlOrganisationProjection["lifecycle"];
    configurationVersion: number;
    requesterRole: ControlRole;
    actions: AccessControlViewActions;
  }>;
  revision: number;
  summary: Readonly<{
    capabilities: number;
    enabledCapabilities: number;
    approvalRequiredCapabilities: number;
    integrations: number;
    activeGrants: number;
    sourcePolicies: number;
  }>;
  capabilities: readonly AccessControlCapabilityView[];
  integrationResources: readonly AccessControlIntegrationView[];
  grants: AccessControlBoundedPage<AccessControlGrantView>;
  sourceFlowPolicies: AccessControlBoundedPage<AccessControlSourcePolicyView>;
}>;

type AccessControlViewError = Readonly<{
  code: "access_control_view_invalid";
  field: string;
}>;

export function assembleAccessControlView(
  input: AccessControlViewInput,
): Result<AccessControlView, AccessControlViewError> {
  const inputValidation = validateViewInput(input);
  if (!inputValidation.ok) return inputValidation;
  const policies = capabilityPolicyMap(input);
  if (!policies.ok) return policies;
  const integrations = integrationMap(input);
  if (!integrations.ok) return integrations;
  const members = memberMaps(input);
  if (!members.ok) return members;
  const resources = resourceMap(input);
  if (!resources.ok) return resources;
  const capabilityViews = buildCapabilityViews(
    input,
    policies.value,
    integrations.value,
  );
  if (!capabilityViews.ok) return capabilityViews;
  const definitions = definitionMap(input.capabilityDefinitions);
  if (!definitions.ok) return definitions;
  const grantViews = buildGrantViews(
    input,
    members.value,
    integrations.value,
    resources.value,
    definitions.value,
  );
  if (!grantViews.ok) return grantViews;
  const sourceViews = buildSourcePolicyViews(
    input,
    members.value,
    integrations.value,
    definitions.value,
    policies.value,
  );
  if (!sourceViews.ok) return sourceViews;
  const canManage = controlRoleCanManageAccess(input.requesterRole);
  return {
    ok: true,
    value: {
      organisation: {
        organisationId: input.organisation.organisationId,
        name: input.organisation.name,
        lifecycle: input.organisation.lifecycle,
        configurationVersion: input.organisation.configurationVersion,
        requesterRole: input.requesterRole,
        actions: canManage
          ? { kind: "manage", createGrant: true, applyDefaults: true }
          : { kind: "read_only" },
      },
      revision: input.organisation.projectionRevision,
      summary: buildSummary(
        capabilityViews.value,
        input.integrations,
        input.grants,
        sourceViews.value,
      ),
      capabilities: capabilityViews.value,
      integrationResources: buildIntegrationViews(input.integrations),
      grants: boundedPage(
        grantViews.value,
        input.grantOffset,
        "grants",
        input.organisation.projectionRevision,
      ),
      sourceFlowPolicies: boundedPage(
        sourceViews.value,
        input.sourcePolicyOffset,
        "sources",
        input.organisation.projectionRevision,
      ),
    },
  };
}

function validateViewInput(
  input: AccessControlViewInput,
): Result<true, AccessControlViewError> {
  if (input.organisation.name.trim().length === 0) return invalid("organisation.name");
  if (!isPositiveInteger(input.organisation.configurationVersion))
    return invalid("organisation.configurationVersion");
  if (!isPositiveInteger(input.organisation.projectionRevision))
    return invalid("organisation.projectionRevision");
  if (!isNonNegativeInteger(input.grantOffset)) return invalid("grantOffset");
  if (!isNonNegativeInteger(input.sourcePolicyOffset))
    return invalid("sourcePolicyOffset");
  return { ok: true, value: true };
}

function capabilityPolicyMap(
  input: AccessControlViewInput,
): Result<ReadonlyMap<string, OrganisationCapabilityPolicy>, AccessControlViewError> {
  const policies = new Map<string, OrganisationCapabilityPolicy>();
  for (const policy of input.capabilityPolicies) {
    if (
      policy.organisationId !== input.organisation.organisationId ||
      policies.has(capabilityKey(policy))
    ) {
      return invalid("capabilityPolicies");
    }
    policies.set(capabilityKey(policy), policy);
  }
  return { ok: true, value: policies };
}

function definitionMap(
  definitions: readonly CapabilityDefinition[],
): Result<ReadonlyMap<string, CapabilityDefinition>, AccessControlViewError> {
  const byKey = new Map<string, CapabilityDefinition>();
  for (const definition of definitions) {
    const key = capabilityKey(definition);
    if (byKey.has(key)) return invalid("capabilityDefinitions");
    byKey.set(key, definition);
  }
  return { ok: true, value: byKey };
}

function integrationMap(
  input: AccessControlViewInput,
): Result<
  ReadonlyMap<string, AccessControlIntegrationProjection>,
  AccessControlViewError
> {
  const byId = new Map<string, AccessControlIntegrationProjection>();
  for (const integration of input.integrations) {
    if (
      integration.organisationId !== input.organisation.organisationId ||
      integration.displayName.trim().length === 0 ||
      byId.has(integration.integrationAccountId)
    ) {
      return invalid("integrations");
    }
    byId.set(integration.integrationAccountId, integration);
  }
  return { ok: true, value: byId };
}

function memberMaps(input: AccessControlViewInput): Result<
  Readonly<{
    byPersonId: ReadonlyMap<string, AccessControlMemberProjection>;
    byUserId: ReadonlyMap<string, AccessControlMemberProjection>;
  }>,
  AccessControlViewError
> {
  const byPersonId = new Map<string, AccessControlMemberProjection>();
  const byUserId = new Map<string, AccessControlMemberProjection>();
  for (const member of input.members) {
    if (
      member.organisationId !== input.organisation.organisationId ||
      member.displayName.trim().length === 0 ||
      byPersonId.has(member.personId) ||
      byUserId.has(member.userId)
    ) {
      return invalid("members");
    }
    byPersonId.set(member.personId, member);
    byUserId.set(member.userId, member);
  }
  return { ok: true, value: { byPersonId, byUserId } };
}

function resourceMap(
  input: AccessControlViewInput,
): Result<
  ReadonlyMap<string, AccessControlResourceProjection>,
  AccessControlViewError
> {
  const byGrantId = new Map<string, AccessControlResourceProjection>();
  for (const resource of input.resources) {
    if (
      !isPositiveInteger(resource.revision) ||
      resource.label.trim().length === 0 ||
      resource.targetRefId.trim().length === 0 ||
      byGrantId.has(resource.grantId)
    ) {
      return invalid("resources");
    }
    if (
      resource.kind === "integration_resource" &&
      !input.integrations.some(integrationMatchesResource.bind(null, resource))
    ) {
      return invalid("resources.integrationAccountId");
    }
    if (
      resource.kind === "commerce_scope" &&
      !commerceResourceIsCurrent(input, resource)
    ) {
      return invalid("resources.commerceIntegrationAccountId");
    }
    byGrantId.set(resource.grantId, resource);
  }
  for (const grant of input.grants) {
    if (
      grant.organisationId !== input.organisation.organisationId ||
      !byGrantId.has(grant.grantId)
    ) {
      return invalid("grants.resource");
    }
  }
  return { ok: true, value: byGrantId };
}

function commerceResourceIsCurrent(
  input: AccessControlViewInput,
  resource: Variant<AccessControlResourceProjection, "commerce_scope">,
): boolean {
  if (input.availableCommerceSystems.length === 0) return false;
  const grant = input.grants.find(
    (candidate) => candidate.grantId === resource.grantId,
  );
  if (grant === undefined) return false;
  if (
    grant.target.kind === "commerce_read" ||
    grant.target.kind === "commerce_command"
  )
    return true;
  return (
    grant.target.kind === "provider_resource" &&
    grant.target.capabilityId === CAPABILITY_KEYS.commerceActionPropose &&
    grant.target.resourceScope.startsWith("commerce:list_entry:") &&
    input.availableCommerceSystems.includes("satyr_commerce")
  );
}

function integrationMatchesResource(
  resource: Exclude<AccessControlResourceProjection, { kind: "platform" }>,
  integration: AccessControlIntegrationProjection,
): boolean {
  return integration.integrationAccountId === resource.integrationAccountId;
}

function buildCapabilityViews(
  input: AccessControlViewInput,
  policies: ReadonlyMap<string, OrganisationCapabilityPolicy>,
  integrations: ReadonlyMap<string, AccessControlIntegrationProjection>,
): Result<readonly AccessControlCapabilityView[], AccessControlViewError> {
  const views: AccessControlCapabilityView[] = [];
  for (const definition of input.capabilityDefinitions) {
    const policy = policies.get(capabilityKey(definition));
    if (policy === undefined)
      return invalid(`capabilityPolicies.${definition.capabilityId}`);
    views.push({
      definition,
      mode: policy.mode,
      provenance: policy.provenance,
      revision: policy.revision,
      changedAt: policy.changedAt,
      availability: capabilityAvailability(
        definition,
        integrations,
        input.availableCommerceSystems,
      ),
      activeGrantCount: countActiveCapabilityGrants(input.grants, definition),
      actions: controlRoleCanManageAccess(input.requesterRole)
        ? { kind: "change_capability_mode" }
        : { kind: "read_only" },
    });
  }
  return { ok: true, value: views };
}

function capabilityAvailability(
  definition: CapabilityDefinition,
  integrations: ReadonlyMap<string, AccessControlIntegrationProjection>,
  availableCommerceSystems: readonly CommerceSystemKind[],
): AccessControlAvailability {
  if (definition.providerDependency.kind === "none") return "available";
  if (definition.providerDependency.kind === "commerce_system") {
    for (const system of definition.providerDependency.systems) {
      if (availableCommerceSystems.includes(system)) return "available";
    }
    return "unavailable";
  }
  let needsAttention = false;
  for (const integration of integrations.values()) {
    if (
      !providerMatchesDependency(
        definition.providerDependency.providers,
        integration.provider,
      )
    )
      continue;
    if (integration.availability === "available") return "available";
    if (integration.availability === "needs_attention") needsAttention = true;
  }
  return needsAttention ? "needs_attention" : "unavailable";
}

function countActiveCapabilityGrants(
  grants: readonly AccessGrant[],
  definition: CapabilityDefinition,
): number {
  let count = 0;
  for (const grant of grants) {
    if (
      grant.lifecycle.kind === "active" &&
      grant.target.capabilityId === definition.capabilityId &&
      grant.target.capabilityVersion === definition.capabilityVersion
    )
      count += 1;
  }
  return count;
}

function buildGrantViews(
  input: AccessControlViewInput,
  members: Readonly<{
    byPersonId: ReadonlyMap<string, AccessControlMemberProjection>;
    byUserId: ReadonlyMap<string, AccessControlMemberProjection>;
  }>,
  integrations: ReadonlyMap<string, AccessControlIntegrationProjection>,
  resources: ReadonlyMap<string, AccessControlResourceProjection>,
  definitions: ReadonlyMap<string, CapabilityDefinition>,
): Result<readonly AccessControlGrantView[], AccessControlViewError> {
  const views: AccessControlGrantView[] = [];
  for (const grant of input.grants) {
    const definition = definitions.get(capabilityKey(grant.target));
    const resource = resources.get(grant.grantId);
    if (definition === undefined || resource === undefined)
      return invalid(`grants.${grant.grantId}`);
    const subject = subjectView(
      grant.subject,
      members.byPersonId,
      integrations,
      input.subjectReferenceIds,
    );
    if (!subject.ok) return subject;
    views.push({
      grantId: grant.grantId,
      revision: grant.lifecycle.revision,
      subject: subject.value,
      capability: {
        capabilityId: definition.capabilityId,
        capabilityVersion: definition.capabilityVersion,
        label: definition.label,
        risk: definition.risk,
      },
      resource: resourceView(resource),
      provenance: provenanceView(
        grant.provenance,
        members.byUserId,
        integrations,
      ),
      lifecycle: grant.lifecycle,
      actions:
        controlRoleCanManageAccess(input.requesterRole) &&
        grant.lifecycle.kind === "active"
          ? { kind: "revoke_grant" }
          : { kind: "read_only" },
    });
  }
  views.sort(compareGrantViews);
  return { ok: true, value: views };
}

function subjectView(
  subject: GrantSubject | ContextVisibility,
  members: ReadonlyMap<string, AccessControlMemberProjection>,
  integrations: ReadonlyMap<string, AccessControlIntegrationProjection>,
  subjectReferenceIds: ReadonlyMap<string, string>,
): Result<AccessControlSubjectView, AccessControlViewError> {
  const subjectRefId = subjectReferenceIds.get(JSON.stringify(subject));
  if (subjectRefId === undefined) return invalid("subjectReferences");
  switch (subject.kind) {
    case "organisation_role":
      return {
        ok: true,
        value: subjectPresentation(
          subjectRefId,
          subject.kind,
          roleLabel(subject.role),
          "available",
        ),
      };
    case "person": {
      const member = members.get(subject.personId);
      return {
        ok: true,
        value: subjectPresentation(
          subjectRefId,
          subject.kind,
          member?.displayName ?? "Unavailable member",
          member === undefined ? "unavailable" : "available",
        ),
      };
    }
    case "conversation":
      return {
        ok: true,
        value: integrationSubjectPresentation(
          subjectRefId,
          subject.kind,
          subject.integrationAccountId,
          "Slack conversation",
          integrations,
        ),
      };
    case "workflow":
      return {
        ok: true,
        value: subjectPresentation(
          subjectRefId,
          subject.kind,
          "Automation",
          "available",
        ),
      };
    case "agent_mailbox":
      return {
        ok: true,
        value: integrationSubjectPresentation(
          subjectRefId,
          subject.kind,
          subject.integrationAccountId,
          "Agent mailbox",
          integrations,
        ),
      };
    case "whatsapp_support":
      return {
        ok: true,
        value: integrationSubjectPresentation(
          subjectRefId,
          subject.kind,
          subject.integrationAccountId,
          "WhatsApp support",
          integrations,
        ),
      };
    case "case":
      return {
        ok: true,
        value: subjectPresentation(
          subjectRefId,
          subject.kind,
          "Case participants",
          "available",
        ),
      };
    default:
      return assertNever(subject);
  }
}

function integrationSubjectPresentation(
  subjectRefId: string,
  kind: AccessControlSubjectView["kind"],
  integrationAccountId: string,
  noun: string,
  integrations: ReadonlyMap<string, AccessControlIntegrationProjection>,
): AccessControlSubjectView {
  const integration = integrations.get(integrationAccountId);
  return subjectPresentation(
    subjectRefId,
    kind,
    integration === undefined
      ? `Unavailable ${noun.toLowerCase()}`
      : `${integration.displayName} · ${noun}`,
    integration === undefined ? "unavailable" : "available",
  );
}

function subjectPresentation(
  subjectRefId: string,
  kind: AccessControlSubjectView["kind"],
  label: string,
  availability: AccessControlSubjectView["availability"],
): AccessControlSubjectView {
  return { subjectRefId, kind, label, availability };
}

function resourceView(
  resource: AccessControlResourceProjection,
): AccessControlResourceView {
  switch (resource.kind) {
    case "platform":
      return {
        targetRefId: resource.targetRefId,
        kind: resource.kind,
        label: resource.label,
        integrationAccountId: null,
        revision: resource.revision,
      };
    case "integration_resource":
    case "commerce_scope":
      return {
        targetRefId: resource.targetRefId,
        kind: resource.kind,
        label: resource.label,
        integrationAccountId: resource.integrationAccountId,
        revision: resource.revision,
      };
    default:
      return assertNever(resource);
  }
}

function provenanceView(
  provenance: GrantProvenance,
  members: ReadonlyMap<string, AccessControlMemberProjection>,
  integrations: ReadonlyMap<string, AccessControlIntegrationProjection>,
): AccessControlProvenanceView {
  switch (provenance.kind) {
    case "operator":
      return {
        kind: provenance.kind,
        label:
          members.get(provenance.userId)?.displayName ??
          "Former operator",
      };
    case "baseline":
      return { kind: provenance.kind, label: "Recommended default" };
    case "integration_setup":
      return {
        kind: provenance.kind,
        label:
          integrations.get(provenance.integrationAccountId)?.displayName ??
          "Integration setup",
      };
    case "cutover":
      return { kind: provenance.kind, label: "Imported setting" };
    default:
      return assertNever(provenance);
  }
}

function buildSourcePolicyViews(
  input: AccessControlViewInput,
  members: Readonly<{
    byPersonId: ReadonlyMap<string, AccessControlMemberProjection>;
    byUserId: ReadonlyMap<string, AccessControlMemberProjection>;
  }>,
  integrations: ReadonlyMap<string, AccessControlIntegrationProjection>,
  definitions: ReadonlyMap<string, CapabilityDefinition>,
  policies: ReadonlyMap<string, OrganisationCapabilityPolicy>,
): Result<readonly AccessControlSourcePolicyView[], AccessControlViewError> {
  const views: AccessControlSourcePolicyView[] = [];
  const sourceIds = new Set<string>();
  for (const source of input.sourcePolicies) {
    const key = capabilityKey(source);
    const definition = definitions.get(key);
    const policy = policies.get(key);
    const integration = integrations.get(source.integrationAccountId);
    if (
      source.organisationId !== input.organisation.organisationId ||
      definition === undefined ||
      policy === undefined ||
      integration === undefined ||
      sourceIds.has(source.sourceRefId) ||
      !isPositiveInteger(source.revision)
    ) {
      return invalid("sourcePolicies");
    }
    sourceIds.add(source.sourceRefId);
    if (source.kind === "unavailable") {
      views.push(unavailableSourcePolicyView(source, definition, integration));
      continue;
    }
    const projected = projectAvailableSourcePolicy(
      source,
      definition,
      integration,
      members.byPersonId,
      integrations,
      input.subjectReferenceIds,
    );
    if (!projected.ok) return projected;
    views.push(projected.value);
  }
  views.sort(compareSourcePolicyViews);
  return { ok: true, value: views };
}

function projectAvailableSourcePolicy(
  source: Variant<TrustedSourcePolicyProjection, "available">,
  definition: CapabilityDefinition,
  integration: AccessControlIntegrationProjection,
  members: ReadonlyMap<string, AccessControlMemberProjection>,
  integrations: ReadonlyMap<string, AccessControlIntegrationProjection>,
  subjectReferenceIds: ReadonlyMap<string, string>,
): Result<AccessControlSourcePolicyView, AccessControlViewError> {
  if (!FlowLabel.is(source.label) || source.label.policies.length !== 1)
    return invalid("sourcePolicies.label");
  const policy = source.label.policies[0];
  if (
    policy === undefined ||
    policy.owner.kind !== "integration_resource" ||
    policy.owner.organisationId !== source.organisationId ||
    policy.owner.integrationAccountId !== source.integrationAccountId ||
    policy.owner.resourceScope !== source.resourceScope
  ) {
    return invalid("sourcePolicies.owner");
  }
  const readers: AccessControlSubjectView[] = [];
  for (const reader of policy.readers) {
    if (reader.kind === "chat_conversation") return invalid("sourcePolicies.readers");
    // A schedule revision from before Plan 27C step 5 can still name a Project.
    if (reader.kind === "project") continue;
    const projected = subjectView(
      reader,
      members,
      integrations,
      subjectReferenceIds,
    );
    if (!projected.ok) return projected;
    readers.push(projected.value);
  }
  return {
    ok: true,
    value: {
      sourceRefId: source.sourceRefId,
      revision: source.revision,
      capability: capabilityRefView(definition),
      owner: {
        integrationAccountId: integration.integrationAccountId,
        label: integration.displayName,
      },
      resourceLabel: source.resourceLabel,
      readers,
      availability: { kind: "available" },
      actions: { kind: "check_destination" },
    },
  };
}

function unavailableSourcePolicyView(
  source: Variant<TrustedSourcePolicyProjection, "unavailable">,
  definition: CapabilityDefinition,
  integration: AccessControlIntegrationProjection,
): AccessControlSourcePolicyView {
  return {
    sourceRefId: source.sourceRefId,
    revision: source.revision,
    capability: capabilityRefView(definition),
    owner: {
      integrationAccountId: integration.integrationAccountId,
      label: integration.displayName,
    },
    resourceLabel: source.resourceLabel,
    readers: [],
    availability: { kind: "unavailable", reason: source.unavailableReason },
    actions: { kind: "check_destination" },
  };
}

function capabilityRefView(definition: CapabilityDefinition): Readonly<{
  capabilityId: string;
  capabilityVersion: number;
  label: string;
}> {
  return {
    capabilityId: definition.capabilityId,
    capabilityVersion: definition.capabilityVersion,
    label: definition.label,
  };
}

function buildIntegrationViews(
  integrations: readonly AccessControlIntegrationProjection[],
): readonly AccessControlIntegrationView[] {
  const views: AccessControlIntegrationView[] = [];
  for (const integration of integrations) {
    views.push({
      integrationAccountId: integration.integrationAccountId,
      provider: integration.provider,
      displayName: integration.displayName,
      availability: integration.availability,
      updatedAt: integration.updatedAt,
      actions: { kind: "none" },
    });
  }
  views.sort(compareIntegrationViews);
  return views;
}

function buildSummary(
  capabilities: readonly AccessControlCapabilityView[],
  integrations: readonly AccessControlIntegrationProjection[],
  grants: readonly AccessGrant[],
  sourcePolicies: readonly AccessControlSourcePolicyView[],
): AccessControlView["summary"] {
  let enabledCapabilities = 0;
  let approvalRequiredCapabilities = 0;
  for (const capability of capabilities) {
    if (capability.mode === "enabled") enabledCapabilities += 1;
    if (capability.mode === "approval_required")
      approvalRequiredCapabilities += 1;
  }
  let activeGrants = 0;
  for (const grant of grants) {
    if (grant.lifecycle.kind === "active") activeGrants += 1;
  }
  return {
    capabilities: capabilities.length,
    enabledCapabilities,
    approvalRequiredCapabilities,
    integrations: integrations.length,
    activeGrants,
    sourcePolicies: sourcePolicies.length,
  };
}

function boundedPage<T>(
  items: readonly T[],
  offset: number,
  kind: "grants" | "sources",
  revision: number,
): AccessControlBoundedPage<T> {
  const page = items.slice(offset, offset + ACCESS_CONTROL_PAGE_LIMIT);
  const nextOffset = offset + page.length;
  return {
    items: page,
    nextCursor:
      nextOffset < items.length
        ? `access_${kind}_${revision}_${nextOffset}`
        : null,
  };
}

function controlRoleCanManageAccess(role: ControlRole): boolean {
  switch (role) {
    case "owner":
    case "admin":
      return true;
    case "operator":
    case "viewer":
      return false;
    default:
      return assertNever(role);
  }
}

function roleLabel(role: string): string {
  switch (role) {
    case "owner":
      return "Owners";
    case "admin":
      return "Admins";
    case "operator":
      return "Operators";
    case "viewer":
      return "Viewers";
    default:
      return role;
  }
}

function capabilityKey(
  value: Readonly<{ capabilityId: string; capabilityVersion: number }>,
): string {
  return `${value.capabilityId}@${value.capabilityVersion}`;
}

function providerMatchesDependency(
  providers: readonly string[],
  provider: string,
): boolean {
  for (const candidate of providers) {
    if (candidate === provider) return true;
  }
  return false;
}

function compareGrantViews(
  left: AccessControlGrantView,
  right: AccessControlGrantView,
): number {
  return left.grantId.localeCompare(right.grantId);
}

function compareSourcePolicyViews(
  left: AccessControlSourcePolicyView,
  right: AccessControlSourcePolicyView,
): number {
  return left.sourceRefId.localeCompare(right.sourceRefId);
}

function compareIntegrationViews(
  left: AccessControlIntegrationView,
  right: AccessControlIntegrationView,
): number {
  return (
    left.displayName.localeCompare(right.displayName) ||
    left.integrationAccountId.localeCompare(right.integrationAccountId)
  );
}

function invalid(field: string): Result<never, AccessControlViewError> {
  return { ok: false, error: { code: "access_control_view_invalid", field } };
}

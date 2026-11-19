import type {
  AccessDecisionExplanation,
  AccessGrantLifecycle,
  CapabilityMode,
  CapabilityPolicyProvenance,
} from "@purin-labs/contracts";
import {
  decodeAccessGrantLifecycle,
  decodeCapabilityDefinition,
} from "@purin-labs/contracts/browser-validators";
import type {
  AccessDecodeError,
  AccessDecodeResult,
} from "@purin-labs/contracts/browser-validators";

import type {
  AccessBoundaryName,
  AccessError,
  AccessResult,
  AccessControlCapabilityView,
  AccessControlGrantView,
  AccessControlOption,
  AccessControlSourcePolicyView,
  AccessControlSubjectView,
  AccessControlView,
  AccessExplainResult,
  AccessOptionsPage,
  AccessRequesterRole,
} from "./access-models.ts";
import type { Variant } from "@purin-labs/type-utils";
import {
  assertNever,
  hasExactKeys,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";
import type { AccessControlAvailability } from "../index.ts";

type JsonRecord = Record<string, unknown>;

export function parseAccessControlResponse(
  raw: unknown,
): AccessResult<AccessControlView> {
  return decodeAccessBoundary(
    "access_control",
    parseAccessControlResponseValue,
    raw,
  );
}

export function parseAccessOptionsResponse(
  raw: unknown,
): AccessResult<AccessOptionsPage> {
  return decodeAccessBoundary(
    "access_options",
    parseAccessOptionsResponseValue,
    raw,
  );
}

export function parseAccessExplanationResponse(
  raw: unknown,
): AccessResult<AccessExplainResult> {
  return decodeAccessBoundary(
    "access_explanation",
    parseAccessExplanationResponseValue,
    raw,
  );
}

function parseAccessControlResponseValue(raw: unknown): AccessControlView {
  const response = exactRecord(
    raw,
    ["ok", "accessControl"],
    "access-control response",
  );
  if (response.ok !== true) throw invalid("access-control response");
  return parseAccessControlView(response.accessControl);
}

function parseAccessOptionsResponseValue(raw: unknown): AccessOptionsPage {
  const response = exactRecord(
    raw,
    ["ok", "options"],
    "access options response",
  );
  if (response.ok !== true) throw invalid("access options response");
  const options = exactRecord(
    response.options,
    ["items", "nextCursor"],
    "access options",
  );
  if (!Array.isArray(options.items) || !nullableText(options.nextCursor))
    throw invalid("access options");
  const items: AccessControlOption[] = [];
  for (const item of options.items) items.push(parseOption(item));
  return { items, nextCursor: options.nextCursor };
}

function parseAccessExplanationResponseValue(
  raw: unknown,
): AccessExplainResult {
  const response = exactRecord(
    raw,
    ["ok", "explanation"],
    "access explanation response",
  );
  if (response.ok !== true) throw invalid("access explanation response");
  return parseExplanation(response.explanation);
}

function parseAccessControlView(raw: unknown): AccessControlView {
  const view = exactRecord(
    raw,
    [
      "organisation",
      "revision",
      "summary",
      "capabilities",
      "integrationResources",
      "grants",
      "sourceFlowPolicies",
    ],
    "access-control view",
  );
  if (
    !isPositiveInteger(view.revision) ||
    !Array.isArray(view.capabilities) ||
    !Array.isArray(view.integrationResources)
  )
    throw invalid("access-control view");
  const capabilities: AccessControlCapabilityView[] = [];
  for (const capability of view.capabilities)
    capabilities.push(parseCapability(capability));
  const integrationResources: AccessControlView["integrationResources"][number][] =
    [];
  for (const integration of view.integrationResources)
    integrationResources.push(parseIntegration(integration));
  return {
    organisation: parseOrganisation(view.organisation),
    revision: view.revision,
    summary: parseSummary(view.summary),
    capabilities,
    integrationResources,
    grants: parseGrantPage(view.grants),
    sourceFlowPolicies: parseSourcePage(view.sourceFlowPolicies),
  };
}

function parseOrganisation(raw: unknown): AccessControlView["organisation"] {
  const organisation = exactRecord(
    raw,
    [
      "organisationId",
      "name",
      "lifecycle",
      "configurationVersion",
      "requesterRole",
      "actions",
    ],
    "access organisation",
  );
  if (
    !identifier(organisation.organisationId) ||
    !boundedText(organisation.name, 200) ||
    !organisationLifecycle(organisation.lifecycle) ||
    !isPositiveInteger(organisation.configurationVersion) ||
    !requesterRole(organisation.requesterRole)
  )
    throw invalid("access organisation");
  return {
    organisationId: organisation.organisationId,
    name: organisation.name,
    lifecycle: organisation.lifecycle,
    configurationVersion: organisation.configurationVersion,
    requesterRole: organisation.requesterRole,
    actions: parseOrganisationActions(organisation.actions),
  };
}

function parseOrganisationActions(
  raw: unknown,
): AccessControlView["organisation"]["actions"] {
  const actions = record(raw, "access organisation actions");
  switch (actions.kind) {
    case "read_only":
      requireExactKeys(actions, ["kind"], "access organisation actions");
      return { kind: "read_only" };
    case "manage":
      requireExactKeys(
        actions,
        ["kind", "createGrant", "applyDefaults"],
        "access organisation actions",
      );
      if (actions.createGrant !== true || actions.applyDefaults !== true)
        throw invalid("access organisation actions");
      return { kind: "manage", createGrant: true, applyDefaults: true };
    default:
      throw invalid("access organisation actions");
  }
}

function parseSummary(raw: unknown): AccessControlView["summary"] {
  const summary = exactRecord(
    raw,
    [
      "capabilities",
      "enabledCapabilities",
      "approvalRequiredCapabilities",
      "integrations",
      "activeGrants",
      "sourcePolicies",
    ],
    "access summary",
  );
  for (const value of Object.values(summary)) {
    if (!isNonNegativeInteger(value)) throw invalid("access summary");
  }
  return {
    capabilities: requireCount(summary.capabilities),
    enabledCapabilities: requireCount(summary.enabledCapabilities),
    approvalRequiredCapabilities: requireCount(
      summary.approvalRequiredCapabilities,
    ),
    integrations: requireCount(summary.integrations),
    activeGrants: requireCount(summary.activeGrants),
    sourcePolicies: requireCount(summary.sourcePolicies),
  };
}

function parseCapability(raw: unknown): AccessControlCapabilityView {
  const capability = exactRecord(
    raw,
    [
      "definition",
      "mode",
      "provenance",
      "revision",
      "changedAt",
      "availability",
      "activeGrantCount",
      "actions",
    ],
    "access capability",
  );
  if (
    !capabilityMode(capability.mode) ||
    !isPositiveInteger(capability.revision) ||
    !isNonNegativeInteger(capability.changedAt) ||
    !availability(capability.availability) ||
    !isNonNegativeInteger(capability.activeGrantCount)
  )
    throw invalid("access capability");
  return {
    definition: decodeContractValue(
      decodeCapabilityDefinition,
      capability.definition,
      "capability definition",
    ),
    mode: capability.mode,
    provenance: parseCapabilityProvenance(capability.provenance),
    revision: capability.revision,
    changedAt: capability.changedAt,
    availability: capability.availability,
    activeGrantCount: capability.activeGrantCount,
    actions: parseCapabilityActions(capability.actions),
  };
}

function parseCapabilityProvenance(raw: unknown): CapabilityPolicyProvenance {
  const value = record(raw, "capability provenance");
  switch (value.kind) {
    case "baseline":
      requireExactKeys(
        value,
        ["kind", "profile", "profileVersion", "materializationReceiptId"],
        "capability provenance",
      );
      if (
        !identifier(value.profile) ||
        !isPositiveInteger(value.profileVersion) ||
        !identifier(value.materializationReceiptId)
      )
        throw invalid("capability provenance");
      return {
        kind: "baseline",
        profile: value.profile,
        profileVersion: value.profileVersion,
        materializationReceiptId: value.materializationReceiptId,
      };
    case "operator":
      requireExactKeys(
        value,
        ["kind", "userId", "mutationReceiptId"],
        "capability provenance",
      );
      if (!identifier(value.userId) || !identifier(value.mutationReceiptId))
        throw invalid("capability provenance");
      return {
        kind: "operator",
        userId: value.userId,
        mutationReceiptId: value.mutationReceiptId,
      };
    case "integration_setup":
      requireExactKeys(
        value,
        [
          "kind",
          "integrationAccountId",
          "setupRevision",
          "materializationReceiptId",
        ],
        "capability provenance",
      );
      if (
        !identifier(value.integrationAccountId) ||
        !isPositiveInteger(value.setupRevision) ||
        !identifier(value.materializationReceiptId)
      )
        throw invalid("capability provenance");
      return {
        kind: "integration_setup",
        integrationAccountId: value.integrationAccountId,
        setupRevision: value.setupRevision,
        materializationReceiptId: value.materializationReceiptId,
      };
    case "cutover_enabled":
      requireExactKeys(
        value,
        ["kind", "migrationId", "previousEnabledAt"],
        "capability provenance",
      );
      if (
        !identifier(value.migrationId) ||
        !isNonNegativeInteger(value.previousEnabledAt)
      )
        throw invalid("capability provenance");
      return {
        kind: "cutover_enabled",
        migrationId: value.migrationId,
        previousEnabledAt: value.previousEnabledAt,
      };
    case "cutover_disabled":
      requireExactKeys(value, ["kind", "migrationId"], "capability provenance");
      if (!identifier(value.migrationId))
        throw invalid("capability provenance");
      return { kind: "cutover_disabled", migrationId: value.migrationId };
    default:
      throw invalid("capability provenance");
  }
}

function parseCapabilityActions(
  raw: unknown,
): AccessControlCapabilityView["actions"] {
  const actions = exactRecord(raw, ["kind"], "capability actions");
  if (actions.kind !== "read_only" && actions.kind !== "change_capability_mode")
    throw invalid("capability actions");
  return { kind: actions.kind };
}

function parseIntegration(
  raw: unknown,
): AccessControlView["integrationResources"][number] {
  const integration = exactRecord(
    raw,
    [
      "integrationAccountId",
      "provider",
      "displayName",
      "availability",
      "updatedAt",
      "actions",
    ],
    "access integration",
  );
  const actions = exactRecord(
    integration.actions,
    ["kind"],
    "access integration actions",
  );
  if (
    !identifier(integration.integrationAccountId) ||
    !boundedText(integration.provider, 100) ||
    !boundedText(integration.displayName, 200) ||
    !availability(integration.availability) ||
    !isNonNegativeInteger(integration.updatedAt) ||
    actions.kind !== "none"
  )
    throw invalid("access integration");
  return {
    integrationAccountId: integration.integrationAccountId,
    provider: integration.provider,
    displayName: integration.displayName,
    availability: integration.availability,
    updatedAt: integration.updatedAt,
    actions: { kind: "none" },
  };
}

function parseGrantPage(raw: unknown): AccessControlView["grants"] {
  const page = exactRecord(raw, ["items", "nextCursor"], "access grants page");
  if (!Array.isArray(page.items) || !nullableText(page.nextCursor))
    throw invalid("access grants page");
  const items: AccessControlGrantView[] = [];
  for (const item of page.items) items.push(parseGrant(item));
  return { items, nextCursor: page.nextCursor };
}

function parseGrant(raw: unknown): AccessControlGrantView {
  const grant = exactRecord(
    raw,
    [
      "grantId",
      "revision",
      "subject",
      "capability",
      "resource",
      "provenance",
      "lifecycle",
      "actions",
    ],
    "access grant",
  );
  if (!identifier(grant.grantId) || !isPositiveInteger(grant.revision))
    throw invalid("access grant");
  return {
    grantId: grant.grantId,
    revision: grant.revision,
    subject: parseSubject(grant.subject),
    capability: parseCapabilityReference(grant.capability, true),
    resource: parseResource(grant.resource),
    provenance: parseGrantProvenance(grant.provenance),
    lifecycle: parseLifecycle(grant.lifecycle),
    actions: parseGrantActions(grant.actions),
  };
}

function parseSubject(raw: unknown): AccessControlSubjectView {
  const subject = exactRecord(
    raw,
    ["subjectRefId", "kind", "label", "availability"],
    "access subject",
  );
  if (
    !opaqueReference(subject.subjectRefId, "subject") ||
    !subjectKind(subject.kind) ||
    !boundedText(subject.label, 200) ||
    (subject.availability !== "available" &&
      subject.availability !== "unavailable")
  ) {
    throw invalid("access subject");
  }
  return {
    subjectRefId: subject.subjectRefId,
    kind: subject.kind,
    label: subject.label,
    availability: subject.availability,
  };
}

function parseCapabilityReference(
  raw: unknown,
  riskRequired: true,
): AccessControlGrantView["capability"];
function parseCapabilityReference(
  raw: unknown,
  riskRequired: false,
): AccessControlSourcePolicyView["capability"];
function parseCapabilityReference(
  raw: unknown,
  riskRequired: boolean,
):
  | AccessControlGrantView["capability"]
  | AccessControlSourcePolicyView["capability"] {
  const keys = riskRequired
    ? ["capabilityId", "capabilityVersion", "label", "risk"]
    : ["capabilityId", "capabilityVersion", "label"];
  const capability = exactRecord(raw, keys, "capability reference");
  if (
    !identifier(capability.capabilityId) ||
    !isPositiveInteger(capability.capabilityVersion) ||
    !boundedText(capability.label, 200)
  )
    throw invalid("capability reference");
  if (!riskRequired) {
    return {
      capabilityId: capability.capabilityId,
      capabilityVersion: capability.capabilityVersion,
      label: capability.label,
    };
  }
  if (!capabilityRisk(capability.risk)) throw invalid("capability reference");
  return {
    capabilityId: capability.capabilityId,
    capabilityVersion: capability.capabilityVersion,
    label: capability.label,
    risk: capability.risk,
  };
}

function parseResource(raw: unknown): AccessControlGrantView["resource"] {
  const resource = exactRecord(
    raw,
    ["targetRefId", "kind", "label", "integrationAccountId", "revision"],
    "access resource",
  );
  if (
    !opaqueReference(resource.targetRefId, "target") ||
    !resourceKind(resource.kind) ||
    !boundedText(resource.label, 300) ||
    !nullableIdentifier(resource.integrationAccountId) ||
    !isPositiveInteger(resource.revision)
  )
    throw invalid("access resource");
  return {
    targetRefId: resource.targetRefId,
    kind: resource.kind,
    label: resource.label,
    integrationAccountId: resource.integrationAccountId,
    revision: resource.revision,
  };
}

function parseGrantProvenance(
  raw: unknown,
): AccessControlGrantView["provenance"] {
  const provenance = exactRecord(raw, ["kind", "label"], "grant provenance");
  if (
    !grantProvenanceKind(provenance.kind) ||
    !boundedText(provenance.label, 200)
  )
    throw invalid("grant provenance");
  return { kind: provenance.kind, label: provenance.label };
}

function parseLifecycle(raw: unknown): AccessGrantLifecycle {
  const lifecycle = decodeContractValue(
    decodeAccessGrantLifecycle,
    raw,
    "grant lifecycle",
  );
  if (!isPositiveInteger(lifecycle.revision)) throw invalid("grant lifecycle");
  return lifecycle;
}

function parseGrantActions(raw: unknown): AccessControlGrantView["actions"] {
  const actions = exactRecord(raw, ["kind"], "grant actions");
  if (actions.kind !== "read_only" && actions.kind !== "revoke_grant")
    throw invalid("grant actions");
  return { kind: actions.kind };
}

function parseSourcePage(
  raw: unknown,
): AccessControlView["sourceFlowPolicies"] {
  const page = exactRecord(raw, ["items", "nextCursor"], "source policy page");
  if (!Array.isArray(page.items) || !nullableText(page.nextCursor))
    throw invalid("source policy page");
  const items: AccessControlSourcePolicyView[] = [];
  for (const item of page.items) items.push(parseSource(item));
  return { items, nextCursor: page.nextCursor };
}

function parseSource(raw: unknown): AccessControlSourcePolicyView {
  const source = exactRecord(
    raw,
    [
      "sourceRefId",
      "revision",
      "capability",
      "owner",
      "resourceLabel",
      "readers",
      "availability",
      "actions",
    ],
    "source policy",
  );
  if (
    !opaqueReference(source.sourceRefId, "source") ||
    !isPositiveInteger(source.revision) ||
    !boundedText(source.resourceLabel, 300) ||
    !Array.isArray(source.readers)
  )
    throw invalid("source policy");
  const readers: AccessControlSubjectView[] = [];
  for (const reader of source.readers) readers.push(parseSubject(reader));
  const owner = exactRecord(
    source.owner,
    ["integrationAccountId", "label"],
    "source owner",
  );
  const actions = exactRecord(source.actions, ["kind"], "source actions");
  if (
    !identifier(owner.integrationAccountId) ||
    !boundedText(owner.label, 200) ||
    actions.kind !== "check_destination"
  )
    throw invalid("source policy");
  return {
    sourceRefId: source.sourceRefId,
    revision: source.revision,
    capability: parseCapabilityReference(source.capability, false),
    owner: {
      integrationAccountId: owner.integrationAccountId,
      label: owner.label,
    },
    resourceLabel: source.resourceLabel,
    readers,
    availability: parseSourceAvailability(source.availability),
    actions: { kind: "check_destination" },
  };
}

function parseSourceAvailability(
  raw: unknown,
): AccessControlSourcePolicyView["availability"] {
  const value = record(raw, "source availability");
  if (value.kind === "available") {
    requireExactKeys(value, ["kind"], "source availability");
    return { kind: "available" };
  }
  requireExactKeys(value, ["kind", "reason"], "source availability");
  if (value.kind !== "unavailable" || !sourceUnavailableReason(value.reason))
    throw invalid("source availability");
  return { kind: "unavailable", reason: value.reason };
}

function parseOption(raw: unknown): AccessControlOption {
  const option = exactRecord(
    raw,
    ["kind", "refId", "revision", "label", "detail", "availability"],
    "access option",
  );
  if (
    !optionKind(option.kind) ||
    !boundedText(option.refId, 600) ||
    !boundedText(option.label, 200) ||
    (option.revision !== null && !isPositiveInteger(option.revision)) ||
    !boundedText(option.detail, 200) ||
    !availability(option.availability)
  )
    throw invalid("access option");
  return {
    kind: option.kind,
    refId: option.refId,
    revision: option.revision,
    label: option.label,
    detail: option.detail,
    availability: option.availability,
  };
}

function parseExplanation(raw: unknown): AccessDecisionExplanation {
  const value = record(raw, "access explanation");
  switch (value.kind) {
    case "allowed":
      requireExactKeys(
        value,
        ["kind", "effectiveGrants", "policyMode", "flowReaders"],
        "access explanation",
      );
      if (
        !capabilityMode(value.policyMode) ||
        !Array.isArray(value.flowReaders)
      )
        throw invalid("access explanation");
      return {
        kind: "allowed",
        effectiveGrants: parseEffectiveGrants(value.effectiveGrants),
        policyMode: value.policyMode,
        flowReaders: parseTextArray(
          value.flowReaders,
          "access explanation readers",
        ),
      };
    case "approval_required":
      requireExactKeys(
        value,
        ["kind", "effectiveGrants", "policyMode", "reason"],
        "access explanation",
      );
      if (!capabilityMode(value.policyMode) || !boundedText(value.reason, 500))
        throw invalid("access explanation");
      return {
        kind: "approval_required",
        effectiveGrants: parseEffectiveGrants(value.effectiveGrants),
        policyMode: value.policyMode,
        reason: value.reason,
      };
    case "denied":
    case "unavailable":
      requireExactKeys(
        value,
        ["kind", "stage", "reason", "remediation"],
        "access explanation",
      );
      if (
        !decisionStage(value.stage) ||
        !boundedText(value.reason, 500) ||
        !boundedText(value.remediation, 500)
      ) {
        throw invalid("access explanation");
      }
      return {
        kind: value.kind,
        stage: value.stage,
        reason: value.reason,
        remediation: value.remediation,
      };
    default:
      throw invalid("access explanation");
  }
}

function parseEffectiveGrants(raw: unknown) {
  if (!Array.isArray(raw)) throw invalid("effective grants");
  const grants: { grantId: string; revision: number }[] = [];
  for (const item of raw) {
    const grant = exactRecord(item, ["grantId", "revision"], "effective grant");
    if (!identifier(grant.grantId) || !isPositiveInteger(grant.revision))
      throw invalid("effective grant");
    grants.push({ grantId: grant.grantId, revision: grant.revision });
  }
  return grants;
}

function parseTextArray(raw: readonly unknown[], field: string): string[] {
  const values: string[] = [];
  for (const value of raw) {
    if (!boundedText(value, 200)) throw invalid(field);
    values.push(value);
  }
  return values;
}

function decodeAccessBoundary<TValue>(
  boundary: AccessBoundaryName,
  parse: (raw: unknown) => TValue,
  raw: unknown,
): AccessResult<TValue> {
  try {
    return { ok: true, value: parse(raw) };
  } catch (error) {
    if (!(error instanceof AccessBoundaryFailure)) throw error;
    return { ok: false, error: boundaryFailure(boundary, error) };
  }
}

function boundaryFailure(
  boundary: AccessBoundaryName,
  error: AccessBoundaryFailure,
): AccessError {
  switch (error.contractKind) {
    case null:
    case "validation_rejected":
    case "input_invalid":
      return {
        kind: "decode",
        boundary,
        field: error.field,
        code: error.code ?? `invalid_${boundary}_response`,
        reason: error.reason,
        details: error.details,
      };
    default:
      return assertNever(
        error.contractKind,
        "Unhandled access validation error",
      );
  }
}

function decodeContractValue<TValue>(
  decode: (value: unknown) => AccessDecodeResult<TValue>,
  raw: unknown,
  field: string,
): TValue {
  const result = decode(raw);
  if (result.ok) return result.value;
  throw contractFailure(field, result.error);
}

function contractFailure(
  field: string,
  error: AccessDecodeError,
): AccessBoundaryFailure {
  return new AccessBoundaryFailure(
    field,
    error.kind,
    error.code,
    error.reason,
    error.details,
  );
}

function exactRecord(
  raw: unknown,
  keys: readonly string[],
  field: string,
): JsonRecord {
  const value = record(raw, field);
  requireExactKeys(value, keys, field);
  return value;
}

function record(raw: unknown, field: string): JsonRecord {
  if (!isRecord(raw)) throw invalid(field);
  return raw;
}

function requireExactKeys(
  value: JsonRecord,
  keys: readonly string[],
  field: string,
): void {
  if (!hasExactKeys(value, keys)) throw invalid(field);
}

function requireCount(value: unknown): number {
  if (!isNonNegativeInteger(value)) throw invalid("access summary");
  return value;
}

class AccessBoundaryFailure extends Error {
  constructor(
    readonly field: string,
    readonly contractKind: AccessDecodeError["kind"] | null = null,
    readonly code: string | null = null,
    readonly reason: string = "The server returned an invalid access response.",
    readonly details: Readonly<Record<string, string>> | null = null,
  ) {
    super(reason);
    this.name = "AccessBoundaryFailure";
  }
}

function invalid(field: string): never {
  throw new AccessBoundaryFailure(
    field,
    null,
    null,
    `The server returned an invalid ${field}.`,
  );
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 600
  );
}

function nullableIdentifier(value: unknown): value is string | null {
  return value === null || identifier(value);
}

function boundedText(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= limit
  );
}

function nullableText(value: unknown): value is string | null {
  return value === null || boundedText(value, 1_000);
}

function opaqueReference(
  value: unknown,
  prefix: "subject" | "source" | "target",
): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^${prefix}_[0-9a-f]{32}$`, "u").test(value)
  );
}

function capabilityMode(value: unknown): value is CapabilityMode {
  return (
    value === "enabled" || value === "approval_required" || value === "disabled"
  );
}

function availability(value: unknown): value is AccessControlAvailability {
  return (
    value === "available" ||
    value === "needs_attention" ||
    value === "unavailable"
  );
}

function requesterRole(value: unknown): value is AccessRequesterRole {
  return (
    value === "owner" ||
    value === "admin" ||
    value === "operator" ||
    value === "viewer"
  );
}

function organisationLifecycle(
  value: unknown,
): value is AccessControlView["organisation"]["lifecycle"] {
  return (
    value === "draft" ||
    value === "configuring" ||
    value === "activating" ||
    value === "active" ||
    value === "suspended" ||
    value === "archived"
  );
}

function subjectKind(
  value: unknown,
): value is AccessControlSubjectView["kind"] {
  return (
    value === "organisation_role" ||
    value === "person" ||
    value === "conversation" ||
    value === "workflow" ||
    value === "agent_mailbox" ||
    value === "whatsapp_support" ||
    value === "case"
  );
}

function resourceKind(
  value: unknown,
): value is AccessControlGrantView["resource"]["kind"] {
  return (
    value === "platform" ||
    value === "integration_resource" ||
    value === "commerce_scope"
  );
}

function grantProvenanceKind(
  value: unknown,
): value is AccessControlGrantView["provenance"]["kind"] {
  return (
    value === "operator" ||
    value === "baseline" ||
    value === "integration_setup" ||
    value === "cutover"
  );
}

function capabilityRisk(
  value: unknown,
): value is AccessControlGrantView["capability"]["risk"] {
  return value === "read" || value === "propose" || value === "external_effect";
}

function optionKind(value: unknown): value is AccessControlOption["kind"] {
  return (
    value === "organisation_role" ||
    value === "person" ||
    value === "conversation" ||
    value === "workflow" ||
    value === "agent_mailbox" ||
    value === "whatsapp_support" ||
    value === "case" ||
    value === "integration_account" ||
    value === "provider_resource" ||
    value === "access_target" ||
    value === "commerce_target"
  );
}

function sourceUnavailableReason(
  value: unknown,
): value is Variant<
  AccessControlSourcePolicyView["availability"],
  "unavailable"
>["reason"] {
  return (
    value === "capability_disabled" ||
    value === "resource_unavailable" ||
    value === "subject_unavailable" ||
    value === "policy_unavailable"
  );
}

function decisionStage(
  value: unknown,
): value is Variant<
  AccessDecisionExplanation,
  "denied" | "unavailable"
>["stage"] {
  return (
    value === "membership" ||
    value === "grant_selection" ||
    value === "organisation_policy" ||
    value === "assignment" ||
    value === "resource_lifecycle" ||
    value === "context_admission" ||
    value === "flow_sink" ||
    value === "approval" ||
    value === "credential_admission"
  );
}

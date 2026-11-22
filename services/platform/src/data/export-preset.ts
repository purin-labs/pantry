import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type {
  CommerceEntityTypeId,
  CommerceGraphQuery,
  CommerceListId,
  PublishedCommerceSelector,
  PublishedCommerceSelectorId,
  PublishedCommerceSelectorRevision,
  SavedCommerceView,
} from "@purin-labs/commerce-contracts";
import {
  EXPORT_COORDINATION_PRESET_ID,
  EXPORT_COORDINATION_PRESET_VERSION,
  commerceExportPresetDigestPayload,
  parseEntityPlaneExportPresetPublishResponse,
  parsePublishedCommerceSelectorId,
  parsePublishedCommerceSelectorRevision,
  type CommerceEntityPlaneExportPresetPublishRequest,
  type CommerceEntityPlaneExportPresetPublishResponse,
  type CommerceEntityPlaneClient,
} from "@purin-labs/commerce-client";

import type { CommerceReadGrantScope } from "../authorization/access-grants/types";
import {
  prepareControlMutationReceiptAfterWrite,
  readControlMutationReplay,
  prepareOnboardingAuditEventAfterWrite,
  type ControlMutationBoundary,
  type ControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "@purin-labs/tenancy/data/control-mutation";
import type { OrganisationEnvironment } from "@purin-labs/tenancy/data/control-plane";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { CAPABILITY_KEYS } from "../authorization/capability-catalogue";
import {
  prepareCapabilityPolicyWrite,
  capabilityPolicyAdmission,
  type CapabilityPolicyAdmission,
} from "./capability-policy";
import type { Variant } from "@purin-labs/type-utils";
import {
  prepareExportCoordinationArea,
  prepareExportCoordinatorInstallation,
  prepareExportResponsibilityScope,
} from "./agent-operations/export-coordinator-rows";
import { prepareGuardedFirstGrant } from "./access-grants";
import {
  prepareGuardedConfigurationVersionFence,
  preparePublicationRevision,
} from "@purin-labs/tenancy/data/organisation-onboarding-row";
import {
  assertNever,
  isRecord,
  nonNegativeIntegerOrNull,
  positiveIntegerOrNull,
  sha256Hex,
} from "@purin-labs/std";

const EXPORT_AREA_ID = "area_export_coordination_v1";
const EXPORT_SKILL_ID = "skill_export_coordination_v1";
const EXPORT_AGENT_ID = "agent_export_coordination_v1";
const EXPORT_INSTALLATION_ID = "installation_export_coordination_v1";
const EXPORT_CUE_BINDING_ID = "cue_export_coordination_v1";
const EXPORT_CAPABILITY_ID = CAPABILITY_KEYS.commerceEntityPlaneContext;
const EXPORT_READ_CAPABILITY_ID = CAPABILITY_KEYS.commerceEntityRead;
const EXPORT_OPERATOR_PATCH_CAPABILITY_ID =
  CAPABILITY_KEYS.commerceListEntryPatch;
const EXPORT_VIEW_PUBLISH_CAPABILITY_ID =
  CAPABILITY_KEYS.commerceSavedViewPublish;
const EXPORT_CUE_SOURCE = "commerce";
const EXPORT_CUE_EVENT_TYPE = "entity_plane_changed";
const EXPORT_SKILL_BODY =
  "Coordinate export documents, shipment handoffs, and trade-partner follow-up using the published commerce entity plane.";

type CommerceExportPresetPublishRequest = Readonly<{
  readonly presetId: typeof EXPORT_COORDINATION_PRESET_ID;
  readonly version: typeof EXPORT_COORDINATION_PRESET_VERSION;
}>;

type CommerceExportPresetPublication = Readonly<{
  readonly kind: "export_preset_published";
  readonly organisationId: OrganisationId;
  readonly merchantId: string;
  readonly presetId: typeof EXPORT_COORDINATION_PRESET_ID;
  readonly version: typeof EXPORT_COORDINATION_PRESET_VERSION;
  readonly merchantRevision: number;
  readonly digest: string;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
  readonly evidence: CommerceEntityPlaneExportPresetResponseEvidence;
}>;

type CommerceEntityPlaneExportPresetResponseEvidence =
  CommerceEntityPlaneExportPresetPublishResponse["evidence"];

export type CommerceExportPresetError =
  | Readonly<{
      readonly code: "commerce_export_preset_invalid";
      readonly field: string;
    }>
  | Readonly<{ readonly code: "organisation_placement_conflict" }>
  | Readonly<{ readonly code: "commerce_export_preset_organisation_not_found" }>
  | Readonly<{ readonly code: "commerce_export_preset_configuration_conflict" }>
  | Readonly<{
      readonly code: "commerce_export_preset_owner_conflict";
      readonly resource: string;
    }>
  | Readonly<{ readonly code: "commerce_export_preset_commerce_unavailable" }>
  | Readonly<{
      readonly code: "commerce_export_preset_commerce_mismatch";
      readonly field: string;
    }>
  | Readonly<{
      readonly code: "commerce_export_preset_drift";
      readonly field: string;
    }>
  | Readonly<{ readonly code: "commerce_export_preset_persistence_failed" }>;

type CommerceExportPresetPublishInput = Readonly<{
  readonly scope: OrganisationExecutionScope;
  readonly environment: OrganisationEnvironment;
  readonly merchantId: string;
  readonly request: CommerceExportPresetPublishRequest;
  readonly expectedConfigurationVersion: number;
  readonly controlMutation: Readonly<{
    readonly scope: ControlMutationReceiptScope;
    readonly boundary: Variant<
      ControlMutationBoundary,
      "configuration_versioned"
    >;
    readonly identity: ControlMutationIdentity;
  }>;
  readonly client: Pick<CommerceEntityPlaneClient, "publishExportPreset">;
}>;

type PublicationRow = Readonly<{
  readonly organisationId: unknown;
  readonly presetId: unknown;
  readonly presetVersion: unknown;
  readonly merchantId: unknown;
  readonly merchantRevision: unknown;
  readonly evidenceJson: unknown;
  readonly digest: unknown;
  readonly configurationVersion: unknown;
  readonly projectionRevision: unknown;
  readonly publishedAt: unknown;
}>;

type OnboardingRow = Readonly<{
  readonly lifecycle: unknown;
  readonly configurationVersion: unknown;
  readonly projectionRevision: unknown;
}>;

type PolicyVersionRow = Readonly<{ readonly version: unknown }>;

type ScopeRecord = Readonly<{
  readonly scopeId: string;
  readonly scope: ExportScope;
}>;

type ExportScope =
  | Readonly<{ kind: "entity_type"; entityTypeId: CommerceEntityTypeId }>
  | Readonly<{ kind: "commerce_list"; listId: CommerceListId }>
  | Readonly<{
      kind: "saved_selector";
      selector: Readonly<{
        selectorId: PublishedCommerceSelectorId;
        revision: PublishedCommerceSelectorRevision;
        query: Exclude<CommerceGraphQuery, { kind: "commerce_context" }>;
      }>;
    }>;

export function parseCommerceExportPresetPublishRequest(
  raw: unknown,
): Result<CommerceExportPresetPublishRequest, CommerceExportPresetError> {
  if (!isRecord(raw) || Object.keys(raw).length !== 2) {
    return invalid("request");
  }
  if (raw.presetId !== EXPORT_COORDINATION_PRESET_ID) {
    return invalid("presetId");
  }
  if (raw.version !== EXPORT_COORDINATION_PRESET_VERSION) {
    return invalid("version");
  }
  return {
    ok: true,
    value: {
      presetId: EXPORT_COORDINATION_PRESET_ID,
      version: EXPORT_COORDINATION_PRESET_VERSION,
    },
  };
}

export async function publishCommerceExportPreset(
  input: CommerceExportPresetPublishInput,
): Promise<Result<CommerceExportPresetPublication, CommerceExportPresetError>> {
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  if (
    input.environment !== "development" &&
    input.environment !== "production"
  ) {
    return {
      ok: false,
      error: { code: "commerce_export_preset_invalid", field: "environment" },
    };
  }
  if (
    !Number.isSafeInteger(input.expectedConfigurationVersion) ||
    input.expectedConfigurationVersion < 1
  ) {
    return {
      ok: false,
      error: {
        code: "commerce_export_preset_invalid",
        field: "configurationVersion",
      },
    };
  }

  const authoritative = await readAuthoritativePreset(input);
  if (!authoritative.ok) return authoritative;

  const existing = await readPublication(
    input.scope.database,
    input.scope.organisationId,
  );
  if (existing !== null) {
    const publication = replayOrDrift(input, existing, authoritative.value);
    return publication.ok
      ? settleExportReplay(input, publication.value)
      : publication;
  }

  const onboarding = await input.scope.database
    .prepare(
      `SELECT lifecycle, configuration_version AS configurationVersion,
            projection_revision AS projectionRevision
       FROM organisation_onboarding
      WHERE organisation_id = ?`,
    )
    .bind(input.scope.organisationId)
    .first<OnboardingRow>();
  if (onboarding === null) {
    return {
      ok: false,
      error: { code: "commerce_export_preset_organisation_not_found" },
    };
  }
  if (
    onboarding.lifecycle !== "active" &&
    onboarding.lifecycle !== "configuring"
  ) {
    return {
      ok: false,
      error: { code: "commerce_export_preset_configuration_conflict" },
    };
  }
  const configurationVersion = positiveIntegerOrNull(
    onboarding.configurationVersion,
  );
  const projectionRevision = positiveIntegerOrNull(
    onboarding.projectionRevision,
  );
  if (
    configurationVersion === null ||
    projectionRevision === null ||
    configurationVersion !== input.expectedConfigurationVersion
  ) {
    return {
      ok: false,
      error: { code: "commerce_export_preset_configuration_conflict" },
    };
  }

  const ownerCollision = await input.scope.database
    .prepare(
      `SELECT 1 AS present
       FROM operational_area
      WHERE organisation_id = ? AND area_id = ?`,
    )
    .bind(input.scope.organisationId, EXPORT_AREA_ID)
    .first<{ readonly present: unknown }>();
  if (ownerCollision !== null) {
    return {
      ok: false,
      error: {
        code: "commerce_export_preset_owner_conflict",
        resource: EXPORT_AREA_ID,
      },
    };
  }

  const policyVersionRow = await input.scope.database
    .prepare(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
       FROM policy_snapshot
      WHERE organisation_id = ?`,
    )
    .bind(input.scope.organisationId)
    .first<PolicyVersionRow>();
  const policyVersion = positiveIntegerOrNull(policyVersionRow?.version) ?? 1;
  const session = input.scope.database.withSession("first-primary");
  const admission: CapabilityPolicyAdmission = {
    kind: "accepted_mutation",
    scope: input.scope,
    auditEventId: input.controlMutation.identity.auditEventId,
    configurationVersion: configurationVersion + 1,
  };
  const guard = capabilityPolicyAdmission(admission);
  const records = await buildPublicationRecords(
    {
      organisationId: input.scope.organisationId,
      userId: input.controlMutation.scope.userId,
      mutationReceiptId: input.controlMutation.identity.receiptId,
      now: input.controlMutation.identity.createdAt,
      evidence: authoritative.value,
      policyVersion,
    },
    session,
    admission,
  );
  if (!records.ok) return records;

  const publication: CommerceExportPresetPublication = {
    kind: "export_preset_published",
    organisationId: input.scope.organisationId,
    merchantId: authoritative.value.merchantId,
    presetId: EXPORT_COORDINATION_PRESET_ID,
    version: EXPORT_COORDINATION_PRESET_VERSION,
    merchantRevision: Number(authoritative.value.merchantRevision),
    digest: authoritative.value.digest,
    configurationVersion: configurationVersion + 1,
    projectionRevision: projectionRevision + 1,
    evidence: authoritative.value.evidence,
  };
  const statements = [
    preparePublicationRevision(session, {
      nextConfigurationVersion: publication.configurationVersion,
      nextProjectionRevision: publication.projectionRevision,
      now: input.controlMutation.identity.createdAt,
      organisationId: input.scope.organisationId,
      configurationVersion,
      projectionRevision,
      placement: {
        placementEpoch: input.scope.placement.placementEpoch,
        placementCellId: input.scope.placement.placementCellId,
        fenceToken: input.scope.fenceToken,
      },
    }),
    prepareControlMutationReceiptAfterWrite(session, {
      scope: input.controlMutation.scope,
      boundary: input.controlMutation.boundary,
      identity: input.controlMutation.identity,
      responseStatus: 200,
      responseBody: { ok: true, publication },
    }),
    prepareOnboardingAuditEventAfterWrite(
      session,
      input.controlMutation.identity,
      {
        organisationId: input.scope.organisationId,
        environment: input.environment,
        actorUserId: input.controlMutation.scope.userId,
        operation: input.controlMutation.scope.operation,
        targetKind: "commerce_export_preset",
        targetId: publication.presetId,
        oldLifecycle: null,
        newLifecycle: "published",
        configurationVersion: publication.configurationVersion,
        projectionRevision: publication.projectionRevision,
        reasonCode: "operator_published_export_preset",
      },
    ),
    session
      .prepare(
        `INSERT INTO commerce_export_preset_publication (
         organisation_id, preset_id, preset_version, merchant_id, merchant_revision,
         evidence_json, digest, configuration_version, projection_revision, published_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.condition}`,
      )
      .bind(
        input.scope.organisationId,
        publication.presetId,
        publication.version,
        publication.merchantId,
        publication.merchantRevision,
        JSON.stringify(publication.evidence),
        publication.digest,
        publication.configurationVersion,
        publication.projectionRevision,
        input.controlMutation.identity.createdAt,
        ...guard.bindings,
      ),
    ...records.value,
    ...exportCapabilityPolicyStatements(session, input, admission),
  ];
  try {
    const results = await session.batch(statements);
    const fenceResult = results[0];
    if (fenceResult === undefined || fenceResult.meta.changes !== 1) {
      return {
        ok: false,
        error: {
          code: (await input.scope.isActive())
            ? "commerce_export_preset_configuration_conflict"
            : "organisation_placement_conflict",
        },
      };
    }
  } catch {
    return {
      ok: false,
      error: { code: "commerce_export_preset_persistence_failed" },
    };
  }
  return { ok: true, value: publication };
}

async function settleExportReplay(
  input: CommerceExportPresetPublishInput,
  publication: CommerceExportPresetPublication,
): Promise<Result<CommerceExportPresetPublication, CommerceExportPresetError>> {
  const replay = await readControlMutationReplay({
    db: input.scope.database,
    scope: input.controlMutation.scope,
    boundary: input.controlMutation.boundary,
  });
  if (replay.kind === "replay") return { ok: true, value: publication };
  if (replay.kind === "conflict")
    return {
      ok: false,
      error: { code: "commerce_export_preset_configuration_conflict" },
    };
  const session = input.scope.database.withSession("first-primary");
  const guard = capabilityPolicyAdmission({
    kind: "organisation_execution",
    scope: input.scope,
  });
  try {
    const [admission] = await session.batch([
      prepareGuardedConfigurationVersionFence(session, {
        organisationId: input.scope.organisationId,
        version: input.expectedConfigurationVersion,
        guard,
      }),
      prepareControlMutationReceiptAfterWrite(session, {
        scope: input.controlMutation.scope,
        boundary: input.controlMutation.boundary,
        identity: input.controlMutation.identity,
        responseStatus: 200,
        responseBody: { ok: true, publication },
      }),
    ]);
    if (admission?.meta.changes !== 1)
      return {
        ok: false,
        error: {
          code: (await input.scope.isActive())
            ? "commerce_export_preset_configuration_conflict"
            : "organisation_placement_conflict",
        },
      };
  } catch {
    return {
      ok: false,
      error: { code: "commerce_export_preset_persistence_failed" },
    };
  }
  return { ok: true, value: publication };
}

function exportCapabilityPolicyStatements(
  source: Pick<OrganisationDatabase, "prepare">,
  input: CommerceExportPresetPublishInput,
  admission: CapabilityPolicyAdmission,
): readonly D1PreparedStatement[] {
  const provenance = {
    kind: "operator" as const,
    userId: input.controlMutation.scope.userId,
    mutationReceiptId: input.controlMutation.identity.receiptId,
  };
  const now = input.controlMutation.identity.createdAt;
  return [
    prepareCapabilityPolicyWrite(source, admission, {
      kind: "replace",
      capabilityId: EXPORT_CAPABILITY_ID,
      mode: "enabled",
      provenance,
      now,
    }),
    prepareCapabilityPolicyWrite(source, admission, {
      kind: "replace",
      capabilityId: EXPORT_READ_CAPABILITY_ID,
      mode: "enabled",
      provenance,
      now,
    }),
    prepareCapabilityPolicyWrite(source, admission, {
      kind: "replace",
      capabilityId: EXPORT_OPERATOR_PATCH_CAPABILITY_ID,
      mode: "approval_required",
      provenance,
      now,
    }),
    prepareCapabilityPolicyWrite(source, admission, {
      kind: "replace",
      capabilityId: EXPORT_VIEW_PUBLISH_CAPABILITY_ID,
      mode: "enabled",
      provenance,
      now,
    }),
  ];
}

async function readAuthoritativePreset(
  input: CommerceExportPresetPublishInput,
): Promise<
  Result<
    CommerceEntityPlaneExportPresetPublishResponse,
    CommerceExportPresetError
  >
> {
  const request: CommerceEntityPlaneExportPresetPublishRequest = {
    organisationId: String(input.scope.organisationId),
    merchantId: input.merchantId,
    presetId: input.request.presetId,
    presetVersion: input.request.version,
  };
  let result: Awaited<
    ReturnType<CommerceEntityPlaneClient["publishExportPreset"]>
  >;
  try {
    result = await input.client.publishExportPreset(request);
  } catch {
    return {
      ok: false,
      error: { code: "commerce_export_preset_commerce_unavailable" },
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      error: { code: "commerce_export_preset_commerce_unavailable" },
    };
  }
  try {
    const parsed = parseEntityPlaneExportPresetPublishResponse(result.value);
    if (String(parsed.organisationId) !== String(input.scope.organisationId)) {
      return {
        ok: false,
        error: {
          code: "commerce_export_preset_commerce_mismatch",
          field: "organisationId",
        },
      };
    }
    if (String(parsed.merchantId) !== input.merchantId) {
      return {
        ok: false,
        error: {
          code: "commerce_export_preset_commerce_mismatch",
          field: "merchantId",
        },
      };
    }
    const expectedDigest = await sha256Hex(
      commerceExportPresetDigestPayload(parsed),
    );
    if (parsed.digest !== expectedDigest) {
      return {
        ok: false,
        error: {
          code: "commerce_export_preset_commerce_mismatch",
          field: "digest",
        },
      };
    }
    return { ok: true, value: parsed };
  } catch {
    return {
      ok: false,
      error: {
        code: "commerce_export_preset_commerce_mismatch",
        field: "response",
      },
    };
  }
}

async function readPublication(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<PublicationRow | null> {
  return db
    .prepare(
      `SELECT organisation_id AS organisationId, preset_id AS presetId,
            preset_version AS presetVersion, merchant_id AS merchantId,
            merchant_revision AS merchantRevision, evidence_json AS evidenceJson,
            digest, configuration_version AS configurationVersion,
            projection_revision AS projectionRevision, published_at AS publishedAt
       FROM commerce_export_preset_publication
      WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<PublicationRow>();
}

function replayOrDrift(
  input: CommerceExportPresetPublishInput,
  row: PublicationRow,
  authoritative: CommerceEntityPlaneExportPresetPublishResponse,
): Result<CommerceExportPresetPublication, CommerceExportPresetError> {
  if (String(row.merchantId) !== String(authoritative.merchantId)) {
    return {
      ok: false,
      error: { code: "commerce_export_preset_drift", field: "merchantId" },
    };
  }
  if (String(row.digest) !== authoritative.digest) {
    return {
      ok: false,
      error: { code: "commerce_export_preset_drift", field: "digest" },
    };
  }
  const evidence = parseStoredEvidence(
    row,
    input.scope.organisationId,
    authoritative,
  );
  if (!evidence.ok) return evidence;
  const configurationVersion = positiveIntegerOrNull(row.configurationVersion);
  const projectionRevision = positiveIntegerOrNull(row.projectionRevision);
  const merchantRevision = nonNegativeIntegerOrNull(row.merchantRevision);
  const publishedAt = nonNegativeIntegerOrNull(row.publishedAt);
  if (
    configurationVersion === null ||
    projectionRevision === null ||
    merchantRevision === null ||
    publishedAt === null
  ) {
    return {
      ok: false,
      error: { code: "commerce_export_preset_persistence_failed" },
    };
  }
  return {
    ok: true,
    value: {
      kind: "export_preset_published",
      organisationId: input.scope.organisationId,
      merchantId: String(row.merchantId),
      presetId: EXPORT_COORDINATION_PRESET_ID,
      version: EXPORT_COORDINATION_PRESET_VERSION,
      merchantRevision,
      digest: String(row.digest),
      configurationVersion,
      projectionRevision,
      evidence: evidence.value,
    },
  };
}

function parseStoredEvidence(
  row: PublicationRow,
  organisationId: OrganisationId,
  authoritative: CommerceEntityPlaneExportPresetPublishResponse,
): Result<
  CommerceEntityPlaneExportPresetResponseEvidence,
  CommerceExportPresetError
> {
  if (typeof row.evidenceJson !== "string") {
    return {
      ok: false,
      error: { code: "commerce_export_preset_persistence_failed" },
    };
  }
  try {
    const parsed = parseEntityPlaneExportPresetPublishResponse({
      kind: "published",
      organisationId: String(organisationId),
      merchantId: String(authoritative.merchantId),
      presetId: EXPORT_COORDINATION_PRESET_ID,
      presetVersion: EXPORT_COORDINATION_PRESET_VERSION,
      merchantRevision: authoritative.merchantRevision,
      evidence: JSON.parse(row.evidenceJson),
      digest: authoritative.digest,
    });
    if (
      JSON.stringify(parsed.evidence) !== JSON.stringify(authoritative.evidence)
    ) {
      return {
        ok: false,
        error: { code: "commerce_export_preset_drift", field: "evidence" },
      };
    }
    return { ok: true, value: parsed.evidence };
  } catch {
    return {
      ok: false,
      error: { code: "commerce_export_preset_persistence_failed" },
    };
  }
}

async function buildPublicationRecords(
  input: Readonly<{
    readonly organisationId: OrganisationId;
    readonly userId: string;
    readonly mutationReceiptId: string;
    readonly now: number;
    readonly evidence: CommerceEntityPlaneExportPresetPublishResponse;
    readonly policyVersion: number;
  }>,
  source: Pick<OrganisationDatabase, "prepare">,
  admission: CapabilityPolicyAdmission,
): Promise<Result<readonly D1PreparedStatement[], CommerceExportPresetError>> {
  const guard = capabilityPolicyAdmission(admission);
  const scopes = buildScopes(input.evidence.evidence);
  const skillDigest = await sha256Hex(EXPORT_SKILL_BODY);
  const agentBody = JSON.stringify({
    displayName: "Export coordinator",
    role: "export_coordinator",
    purpose: "Coordinate export handoffs and resolve missing documents.",
    instructions: EXPORT_SKILL_BODY,
    requestedCapabilities: [EXPORT_CAPABILITY_ID],
    skillRefs: [{ skillId: EXPORT_SKILL_ID, revision: 1 }],
  });
  const agentDigest = await sha256Hex(agentBody);
  const scopeIds: string[] = [];
  const scopeStatements: D1PreparedStatement[] = [];
  const grantStatements: D1PreparedStatement[] = [];
  for (const entry of scopes) {
    scopeIds.push(entry.scopeId);
    scopeStatements.push(
      responsibilityScopeStatement(source, input, entry, admission),
    );
    grantStatements.push(accessGrantStatement(source, input, entry, admission));
  }
  const statements = [
    prepareExportCoordinationArea(source, {
      guard,
      areaId: EXPORT_AREA_ID,
      organisationId: input.organisationId,
      purpose:
        "Coordinate published export documents and trade-partner handoffs.",
      userId: input.userId,
      now: input.now,
    }),
    ...scopeStatements,
    ...prepareExportCoordinatorInstallation(source, {
      guard,
      organisationId: input.organisationId,
      userId: input.userId,
      now: input.now,
      areaId: EXPORT_AREA_ID,
      skillId: EXPORT_SKILL_ID,
      skillBody: EXPORT_SKILL_BODY,
      skillDigest,
      agentDefinitionId: EXPORT_AGENT_ID,
      capabilitiesJson: JSON.stringify([EXPORT_CAPABILITY_ID]),
      skillRefsJson: JSON.stringify([
        { skillId: EXPORT_SKILL_ID, revision: 1 },
      ]),
      agentDigest,
      installationId: EXPORT_INSTALLATION_ID,
      policyVersion: input.policyVersion,
      scopeIdsJson: JSON.stringify(scopeIds),
      skillBindingId: `skill_binding_${EXPORT_AREA_ID}`,
      cueBindingId: EXPORT_CUE_BINDING_ID,
      cueSource: EXPORT_CUE_SOURCE,
      cueEventType: EXPORT_CUE_EVENT_TYPE,
    }),
    ...grantStatements,
  ];
  return { ok: true, value: statements };
}

function buildScopes(
  evidence: CommerceEntityPlaneExportPresetResponseEvidence,
): readonly ScopeRecord[] {
  const entityScopes = evidence.customEntityTypes.map((entityType) => ({
    scopeId: `scope_${EXPORT_COORDINATION_PRESET_ID}_entity_type_${String(entityType.typeId)}_v1`,
    scope: {
      kind: "entity_type" as const,
      entityTypeId: { origin: "custom" as const, typeId: entityType.typeId },
    },
  }));
  const listScopes = evidence.lists.map((list) => ({
    scopeId: `scope_${EXPORT_COORDINATION_PRESET_ID}_list_${String(list.listId)}_v1`,
    scope: { kind: "commerce_list" as const, listId: list.listId },
  }));
  const viewScopes = evidence.views.map((view) => ({
    scopeId: `scope_${EXPORT_COORDINATION_PRESET_ID}_view_${String(view.viewId)}_v1`,
    scope: {
      kind: "saved_selector" as const,
      selector: selectorFromView(view),
    },
  }));
  return [...entityScopes, ...listScopes, ...viewScopes];
}

function selectorFromView(view: SavedCommerceView): PublishedCommerceSelector {
  if (view.source.kind !== "commerce_list")
    throw new Error("export preset view source is unsupported");
  const query: CommerceGraphQuery = {
    kind: "commerce_list_page",
    listId: view.source.listId,
    filter: view.filter,
    sorts: view.sorts,
    pagination: { limit: 100, cursor: null },
  };
  return {
    selectorId: parsePublishedCommerceSelectorId(view.viewId),
    revision: parsePublishedCommerceSelectorRevision(view.revision),
    query,
  };
}

function responsibilityScopeStatement(
  source: Pick<OrganisationDatabase, "prepare">,
  input: Readonly<{
    readonly organisationId: OrganisationId;
    readonly now: number;
  }>,
  entry: ScopeRecord,
  admission: CapabilityPolicyAdmission,
): D1PreparedStatement {
  const guard = capabilityPolicyAdmission(admission);
  const columns = scopeColumns(entry.scope);
  return prepareExportResponsibilityScope(source, {
    guard,
    scopeId: entry.scopeId,
    organisationId: input.organisationId,
    areaId: EXPORT_AREA_ID,
    columns,
    now: input.now,
  });
}

function accessGrantStatement(
  source: Pick<OrganisationDatabase, "prepare">,
  input: Readonly<{
    readonly organisationId: OrganisationId;
    readonly userId: string;
    readonly mutationReceiptId: string;
    readonly now: number;
  }>,
  entry: ScopeRecord,
  admission: CapabilityPolicyAdmission,
): D1PreparedStatement {
  const guard = capabilityPolicyAdmission(admission);
  const scope = grantScope(entry.scope);
  return prepareGuardedFirstGrant(source, {
    guard,
    organisationId: input.organisationId,
    grantId: `grant_${entry.scopeId}`,
    subjectJson: JSON.stringify({
      kind: "workflow",
      workflowKind: "cue_subscription",
      workflowId: EXPORT_CUE_BINDING_ID,
      workflowRevision: 1,
    }),
    targetJson: JSON.stringify({
      kind: "commerce_read",
      capabilityId: EXPORT_READ_CAPABILITY_ID,
      capabilityVersion: 1,
      scope,
    }),
    provenanceJson: JSON.stringify({
      kind: "operator",
      userId: input.userId,
      mutationReceiptId: input.mutationReceiptId,
    }),
    changedAt: input.now,
  });
}

function scopeColumns(scope: ExportScope): Readonly<{
  readonly scopeKind: ExportScope["kind"];
  readonly entityTypeOrigin: string | null;
  readonly entityTypeId: string | null;
  readonly commerceListId: string | null;
  readonly relationshipJson: string | null;
  readonly listEntryJson: string | null;
  readonly selectorId: string | null;
  readonly selectorRevision: number | null;
  readonly selectorQueryJson: string | null;
}> {
  switch (scope.kind) {
    case "entity_type":
      return {
        scopeKind: scope.kind,
        entityTypeOrigin: scope.entityTypeId.origin,
        entityTypeId: String(scope.entityTypeId.typeId),
        commerceListId: null,
        relationshipJson: null,
        listEntryJson: null,
        selectorId: null,
        selectorRevision: null,
        selectorQueryJson: null,
      };
    case "commerce_list":
      return {
        scopeKind: scope.kind,
        entityTypeOrigin: null,
        entityTypeId: null,
        commerceListId: scope.listId,
        relationshipJson: null,
        listEntryJson: null,
        selectorId: null,
        selectorRevision: null,
        selectorQueryJson: null,
      };
    case "saved_selector":
      return {
        scopeKind: scope.kind,
        entityTypeOrigin: null,
        entityTypeId: null,
        commerceListId: null,
        relationshipJson: null,
        listEntryJson: null,
        selectorId: String(scope.selector.selectorId),
        selectorRevision: Number(scope.selector.revision),
        selectorQueryJson: JSON.stringify(scope.selector.query),
      };
    default:
      return assertNever(scope, "unexpected export preset value");
  }
}

function grantScope(scope: ExportScope): CommerceReadGrantScope {
  switch (scope.kind) {
    case "entity_type":
      return { kind: "entity_type", entityTypeId: scope.entityTypeId };
    case "commerce_list":
      return { kind: "commerce_list", listId: scope.listId };
    case "saved_selector":
      return { kind: "saved_selector", selector: scope.selector };
    default:
      return assertNever(scope, "unexpected export preset value");
  }
}

function invalid(field: string): Result<never, CommerceExportPresetError> {
  return {
    ok: false,
    error: { code: "commerce_export_preset_invalid", field },
  };
}

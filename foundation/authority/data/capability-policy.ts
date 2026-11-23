import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  CapabilityMode,
  CapabilityPolicyModes,
  CapabilityPolicyProvenance,
  OrganisationCapabilityPolicy,
} from "@purin-labs/contracts";

import {
  CAPABILITY_CATALOGUE,
  CAPABILITY_KEYS,
  capabilityDefinitionById,
  type ActiveCapabilityId,
} from "../authorization/capability-catalogue";
import type {
  ChannelId,
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { InitialOrganisationPlacement } from "@purin-labs/tenancy/placement";
import type { StrictUnion } from "@purin-labs/type-utils";
import type { OrganisationQuerySource } from "@purin-labs/tenancy/data/query-source";
import {
  assertNever,
  hasExactKeys,
  isNonBlankString,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  sha256Hex,
} from "@purin-labs/std";

const BASELINE_PROFILE = "read_and_propose";
const BASELINE_PROFILE_VERSION = 1;
const BASELINE_OWNER_CONTEXT_GRANT_ID =
  "grant_baseline_owner_context_case_read";
const BASELINE_ADMIN_CONTEXT_GRANT_ID =
  "grant_baseline_admin_context_case_read";
const BASELINE_OWNER_DISCOVERY_GRANT_ID =
  "grant_baseline_owner_integration_discovery_read";
const BASELINE_ADMIN_DISCOVERY_GRANT_ID =
  "grant_baseline_admin_integration_discovery_read";
export const READ_AND_PROPOSE_ORGANISATION_GRANT_IDS = [
  BASELINE_OWNER_CONTEXT_GRANT_ID,
  BASELINE_ADMIN_CONTEXT_GRANT_ID,
  BASELINE_OWNER_DISCOVERY_GRANT_ID,
  BASELINE_ADMIN_DISCOVERY_GRANT_ID,
] as const;
const BASELINE_ENABLED_CAPABILITIES = new Set<ActiveCapabilityId>([
  CAPABILITY_KEYS.contextCaseRead,
  CAPABILITY_KEYS.customConnectorDraft,
  CAPABILITY_KEYS.integrationDiscoveryRead,
  CAPABILITY_KEYS.fileRead,
  CAPABILITY_KEYS.messageAttachmentInspect,
  CAPABILITY_KEYS.messageLinkRead,
  CAPABILITY_KEYS.whatsappSupportReplySend,
  CAPABILITY_KEYS.voiceTranscription,
]);

type CapabilityPolicyRow = Readonly<{
  readonly organisationId: unknown;
  readonly capabilityId: unknown;
  readonly capabilityVersion: unknown;
  readonly mode: unknown;
  readonly provenanceJson: unknown;
  readonly revision: unknown;
  readonly changedAt: unknown;
}>;

export type CapabilityPolicyError =
  | Readonly<{
      readonly code: "capability_policy_invalid";
      readonly field: string;
    }>
  | Readonly<{
      readonly code: "capability_policy_revision_conflict";
      readonly expected: number;
    }>
  | Readonly<{ readonly code: "capability_policy_placement_conflict" }>
  | Readonly<{
      readonly code: "capability_policy_store_failed";
      readonly detail: string;
    }>;

export type CapabilityPolicyAdmission = StrictUnion<
  | Readonly<{
      kind: "organisation_creation";
      organisationId: OrganisationId;
      placement: InitialOrganisationPlacement;
    }>
  | Readonly<{
      kind: "organisation_execution";
      scope: OrganisationExecutionScope;
    }>
  | Readonly<{
      kind: "accepted_mutation";
      scope: OrganisationExecutionScope;
      auditEventId: string;
      configurationVersion: number;
    }>
>;

export function capabilityPolicyAdmission(
  admission: CapabilityPolicyAdmission,
) {
  switch (admission.kind) {
    case "organisation_creation":
      return {
        organisationId: admission.organisationId,
        condition: `EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
          AND placement_epoch = ? AND placement_cell_id = ? AND status = 'active')`,
        bindings: [
          admission.organisationId,
          admission.placement.placementEpoch,
          admission.placement.placementCellId,
        ],
      };
    case "organisation_execution":
    case "accepted_mutation": {
      const scope = admission.scope;
      const placement = `EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
        AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`;
      const bindings = [
        scope.organisationId,
        scope.placement.placementEpoch,
        scope.placement.placementCellId,
        scope.fenceToken,
      ];
      if (admission.kind === "organisation_execution")
        return {
          organisationId: scope.organisationId,
          condition: placement,
          bindings,
        };
      return {
        organisationId: scope.organisationId,
        condition: `${placement} AND EXISTS (SELECT 1 FROM onboarding_audit_event
          WHERE audit_event_id = ? AND organisation_id = ? AND configuration_version = ?)`,
        bindings: [
          ...bindings,
          admission.auditEventId,
          scope.organisationId,
          admission.configurationVersion,
        ],
      };
    }
    default:
      return assertNever(admission);
  }
}

export type CapabilityPolicyWrite = StrictUnion<
  | Readonly<{
      readonly kind: "materialize";
      readonly capabilityId: ActiveCapabilityId;
      readonly mode: CapabilityMode;
      readonly provenance: CapabilityPolicyProvenance;
      readonly now: number;
    }>
  | Readonly<{
      readonly kind: "replace";
      readonly capabilityId: ActiveCapabilityId;
      readonly mode: CapabilityMode;
      readonly provenance: CapabilityPolicyProvenance;
      readonly now: number;
    }>
  | Readonly<{
      readonly kind: "change";
      readonly capabilityId: ActiveCapabilityId;
      readonly expectedRevision: number;
      readonly mode: CapabilityMode;
      readonly provenance: CapabilityPolicyProvenance;
      readonly now: number;
    }>
>;

export async function readOrganisationCapabilityPolicies(
  input: Readonly<{
    readonly db: OrganisationQuerySource;
    readonly organisationId: OrganisationId;
  }>,
): Promise<
  Result<readonly OrganisationCapabilityPolicy[], CapabilityPolicyError>
> {
  try {
    const rows = await input.db
      .prepare(
        `SELECT organisation_id AS organisationId,
              capability_id AS capabilityId,
              capability_version AS capabilityVersion,
              mode,
              provenance_json AS provenanceJson,
              revision,
              changed_at AS changedAt
         FROM organisation_capability_policy
        WHERE organisation_id = ?
        ORDER BY capability_id, capability_version`,
      )
      .bind(input.organisationId)
      .all<CapabilityPolicyRow>();
    const policies: OrganisationCapabilityPolicy[] = [];
    for (const row of rows.results ?? []) {
      const parsed = parseCapabilityPolicyRow(input.organisationId, row);
      if (!parsed.ok) return parsed;
      policies.push(parsed.value);
    }
    return { ok: true, value: policies };
  } catch (error) {
    return storeFailure(error);
  }
}

export async function writeOrganisationCapabilityPolicy(
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly write: CapabilityPolicyWrite;
  }>,
): Promise<Result<OrganisationCapabilityPolicy, CapabilityPolicyError>> {
  if (!(await input.scope.isActive()))
    return {
      ok: false,
      error: { code: "capability_policy_placement_conflict" },
    };
  const validation = validateCapabilityPolicyWrite(input.write);
  if (!validation.ok) return validation;
  try {
    const result = await prepareCapabilityPolicyWrite(
      input.scope.database,
      { kind: "organisation_execution", scope: input.scope },
      input.write,
    ).run();
    if (!(await input.scope.isActive()))
      return {
        ok: false,
        error: { code: "capability_policy_placement_conflict" },
      };
    if (input.write.kind === "change" && result.meta.changes !== 1) {
      return {
        ok: false,
        error: {
          code: "capability_policy_revision_conflict",
          expected: input.write.expectedRevision,
        },
      };
    }
    return readOrganisationCapabilityPolicy({
      db: input.scope.database,
      organisationId: input.scope.organisationId,
      capabilityId: input.write.capabilityId,
    });
  } catch (error) {
    return storeFailure(error);
  }
}

export function prepareCapabilityPolicyWrite(
  source: OrganisationQuerySource,
  admission: CapabilityPolicyAdmission,
  write: CapabilityPolicyWrite,
): D1PreparedStatement {
  const validation = validateCapabilityPolicyWrite(write);
  if (!validation.ok) {
    const detail =
      validation.error.code === "capability_policy_invalid"
        ? validation.error.field
        : validation.error.code;
    throw new Error(`Invalid capability policy write: ${detail}`);
  }
  const guard = capabilityPolicyAdmission(admission);
  const definition = capabilityDefinitionById(write.capabilityId);
  if (write.kind === "materialize") {
    return source
      .prepare(
        `INSERT INTO organisation_capability_policy (
         organisation_id, capability_id, capability_version, mode,
         provenance_json, revision, changed_at
       ) SELECT ?, ?, ?, ?, ?, 1, ? WHERE ${guard.condition}
       ON CONFLICT (organisation_id, capability_id, capability_version) DO NOTHING`,
      )
      .bind(
        guard.organisationId,
        write.capabilityId,
        definition.capabilityVersion,
        write.mode,
        JSON.stringify(write.provenance),
        write.now,
        ...guard.bindings,
      );
  }
  if (write.kind === "replace") {
    return source
      .prepare(
        `INSERT INTO organisation_capability_policy (
         organisation_id, capability_id, capability_version, mode,
         provenance_json, revision, changed_at
       ) SELECT ?, ?, ?, ?, ?, 1, ? WHERE ${guard.condition}
       ON CONFLICT (organisation_id, capability_id, capability_version) DO UPDATE SET
         mode = excluded.mode,
         provenance_json = excluded.provenance_json,
         revision = organisation_capability_policy.revision + 1,
         changed_at = excluded.changed_at`,
      )
      .bind(
        guard.organisationId,
        write.capabilityId,
        definition.capabilityVersion,
        write.mode,
        JSON.stringify(write.provenance),
        write.now,
        ...guard.bindings,
      );
  }
  return source
    .prepare(
      `UPDATE organisation_capability_policy
        SET mode = ?,
            provenance_json = ?,
            revision = revision + 1,
            changed_at = ?
      WHERE organisation_id = ?
        AND capability_id = ?
        AND capability_version = ?
        AND revision = ? AND ${guard.condition}`,
    )
    .bind(
      write.mode,
      JSON.stringify(write.provenance),
      write.now,
      guard.organisationId,
      write.capabilityId,
      definition.capabilityVersion,
      write.expectedRevision,
      ...guard.bindings,
    );
}

export function prepareReadAndProposeCapabilityPolicies(
  input: Readonly<{
    readonly source: Pick<OrganisationDatabase, "prepare">;
    readonly admission: CapabilityPolicyAdmission;
    readonly materializationReceiptId: string;
    readonly now: number;
  }>,
): readonly D1PreparedStatement[] {
  const provenance: CapabilityPolicyProvenance = {
    kind: "baseline",
    profile: BASELINE_PROFILE,
    profileVersion: BASELINE_PROFILE_VERSION,
    materializationReceiptId: input.materializationReceiptId,
  };
  const statements: D1PreparedStatement[] = [];
  for (const definition of CAPABILITY_CATALOGUE) {
    statements.push(
      prepareCapabilityPolicyWrite(input.source, input.admission, {
        kind: "materialize",
        capabilityId: requireActiveCapabilityId(definition.capabilityId),
        mode: BASELINE_ENABLED_CAPABILITIES.has(
          requireActiveCapabilityId(definition.capabilityId),
        )
          ? "enabled"
          : "disabled",
        provenance,
        now: input.now,
      }),
    );
  }
  return statements;
}

export function prepareReadAndProposeAccessDefaults(
  input: Readonly<{
    readonly source: Pick<OrganisationDatabase, "prepare">;
    readonly admission: CapabilityPolicyAdmission;
    readonly materializationReceiptId: string;
    readonly now: number;
    readonly destination:
      | Readonly<{ readonly kind: "organisation" }>
      | Readonly<{
          readonly kind: "slack_conversation";
          readonly grantId: string;
          readonly integrationAccountId: IntegrationAccountId;
          readonly conversationId: ChannelId;
        }>;
  }>,
): readonly D1PreparedStatement[] {
  const provenance = JSON.stringify({
    kind: "baseline",
    profile: BASELINE_PROFILE,
    profileVersion: BASELINE_PROFILE_VERSION,
    materializationReceiptId: input.materializationReceiptId,
  });
  const statements = [
    ...prepareReadAndProposeCapabilityPolicies(input),
    baselinePlatformGrantStatement(input.source, {
      admission: input.admission,
      grantId: BASELINE_OWNER_CONTEXT_GRANT_ID,
      subject: { kind: "organisation_role", role: "owner" },
      capabilityId: CAPABILITY_KEYS.contextCaseRead,
      provenance,
      now: input.now,
    }),
    baselinePlatformGrantStatement(input.source, {
      admission: input.admission,
      grantId: BASELINE_ADMIN_CONTEXT_GRANT_ID,
      subject: { kind: "organisation_role", role: "admin" },
      capabilityId: CAPABILITY_KEYS.contextCaseRead,
      provenance,
      now: input.now,
    }),
    baselinePlatformGrantStatement(input.source, {
      admission: input.admission,
      grantId: BASELINE_OWNER_DISCOVERY_GRANT_ID,
      subject: { kind: "organisation_role", role: "owner" },
      capabilityId: CAPABILITY_KEYS.integrationDiscoveryRead,
      provenance,
      now: input.now,
    }),
    baselinePlatformGrantStatement(input.source, {
      admission: input.admission,
      grantId: BASELINE_ADMIN_DISCOVERY_GRANT_ID,
      subject: { kind: "organisation_role", role: "admin" },
      capabilityId: CAPABILITY_KEYS.integrationDiscoveryRead,
      provenance,
      now: input.now,
    }),
  ];
  switch (input.destination.kind) {
    case "organisation":
      return statements;
    case "slack_conversation":
      return [
        ...statements,
        ...prepareSlackConversationBaselineGrants({
          source: input.source,
          admission: input.admission,
          materializationReceiptId: input.materializationReceiptId,
          now: input.now,
          grantId: input.destination.grantId,
          integrationAccountId: input.destination.integrationAccountId,
          conversationId: input.destination.conversationId,
        }),
      ];
  }
}

/**
 * The baseline grants of a Slack channel that the agent posts in: people in
 * the channel let the agent read Case context, inspect message attachments
 * and read message links there. A grant that exists stays as it is.
 */
export function prepareSlackConversationBaselineGrants(
  input: Readonly<{
    readonly source: Pick<OrganisationDatabase, "prepare">;
    readonly admission: CapabilityPolicyAdmission;
    readonly materializationReceiptId: string;
    readonly now: number;
    readonly grantId: string;
    readonly integrationAccountId: IntegrationAccountId;
    readonly conversationId: ChannelId;
  }>,
): readonly D1PreparedStatement[] {
  const provenance = JSON.stringify({
    kind: "baseline",
    profile: BASELINE_PROFILE,
    profileVersion: BASELINE_PROFILE_VERSION,
    materializationReceiptId: input.materializationReceiptId,
  });
  const subject = {
    kind: "conversation" as const,
    integrationAccountId: input.integrationAccountId,
    conversationId: input.conversationId,
  };
  return (
    [
      [input.grantId, CAPABILITY_KEYS.contextCaseRead],
      [
        `${input.grantId}_message_attachment_inspect`,
        CAPABILITY_KEYS.messageAttachmentInspect,
      ],
      [`${input.grantId}_message_link_read`, CAPABILITY_KEYS.messageLinkRead],
    ] as const
  ).map(function grant([grantId, capabilityId]) {
    return baselinePlatformGrantStatement(input.source, {
      admission: input.admission,
      grantId,
      subject,
      capabilityId,
      provenance,
      now: input.now,
    });
  });
}

/** The baseline grant identifier of one Slack channel of an Organisation. */
export async function slackConversationBaselineGrantId(
  input: Readonly<{
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    channelId: ChannelId;
  }>,
): Promise<string> {
  const digest = await sha256Hex(
    JSON.stringify({
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      channelId: input.channelId,
    }),
  );
  return `grant_baseline_conversation_context_${digest.slice(0, 32)}`;
}

function baselinePlatformGrantStatement(
  source: Pick<OrganisationDatabase, "prepare">,
  input: Readonly<{
    readonly admission: CapabilityPolicyAdmission;
    readonly grantId: string;
    readonly subject:
      | Readonly<{
          readonly kind: "organisation_role";
          readonly role: "owner" | "admin";
        }>
      | Readonly<{
          readonly kind: "conversation";
          readonly integrationAccountId: IntegrationAccountId;
          readonly conversationId: ChannelId;
        }>;
    readonly capabilityId:
      | typeof CAPABILITY_KEYS.contextCaseRead
      | typeof CAPABILITY_KEYS.integrationDiscoveryRead
      | typeof CAPABILITY_KEYS.messageAttachmentInspect
      | typeof CAPABILITY_KEYS.messageLinkRead;
    readonly provenance: string;
    readonly now: number;
  }>,
): D1PreparedStatement {
  const guard = capabilityPolicyAdmission(input.admission);
  return source
    .prepare(
      `INSERT INTO access_grant (
       organisation_id, grant_id, subject_json, target_json, lifecycle,
       revision, reason, provenance_json, changed_at
     ) SELECT ?, ?, ?, ?, 'active', 1, NULL, ?, ? WHERE ${guard.condition}
     ON CONFLICT (organisation_id, grant_id) DO NOTHING`,
    )
    .bind(
      guard.organisationId,
      input.grantId,
      JSON.stringify(input.subject),
      JSON.stringify({
        kind: "platform_capability",
        capabilityId: input.capabilityId,
        capabilityVersion: 1,
      }),
      input.provenance,
      input.now,
      ...guard.bindings,
    );
}

function parseCapabilityPolicyRow(
  expectedOrganisationId: OrganisationId,
  row: CapabilityPolicyRow,
): Result<OrganisationCapabilityPolicy, CapabilityPolicyError> {
  if (row.organisationId !== expectedOrganisationId)
    return invalid("organisationId");
  if (typeof row.capabilityId !== "string") return invalid("capabilityId");
  const capabilityId = parseActiveCapabilityId(row.capabilityId);
  if (capabilityId === null) return invalid("capabilityId");
  const definition = capabilityDefinitionById(capabilityId);
  if (row.capabilityVersion !== definition.capabilityVersion)
    return invalid("capabilityVersion");
  if (
    !isCapabilityMode(row.mode) ||
    !supportsMode(definition.policyModes, row.mode)
  ) {
    return invalid("mode");
  }
  const provenance = parseCapabilityPolicyProvenance(row.provenanceJson);
  if (provenance === null) return invalid("provenance");
  if (!isPositiveInteger(row.revision)) return invalid("revision");
  if (!isNonNegativeInteger(row.changedAt)) return invalid("changedAt");
  return {
    ok: true,
    value: {
      organisationId: expectedOrganisationId,
      capabilityId,
      capabilityVersion: definition.capabilityVersion,
      mode: row.mode,
      provenance,
      revision: row.revision,
      changedAt: row.changedAt,
    },
  };
}

export async function readOrganisationCapabilityPolicy(
  input: Readonly<{
    readonly db: OrganisationQuerySource;
    readonly organisationId: OrganisationId;
    readonly capabilityId: ActiveCapabilityId;
  }>,
): Promise<Result<OrganisationCapabilityPolicy, CapabilityPolicyError>> {
  const definition = capabilityDefinitionById(input.capabilityId);
  const row = await input.db
    .prepare(
      `SELECT organisation_id AS organisationId,
            capability_id AS capabilityId,
            capability_version AS capabilityVersion,
            mode,
            provenance_json AS provenanceJson,
            revision,
            changed_at AS changedAt
       FROM organisation_capability_policy
      WHERE organisation_id = ? AND capability_id = ? AND capability_version = ?`,
    )
    .bind(
      input.organisationId,
      input.capabilityId,
      definition.capabilityVersion,
    )
    .first<CapabilityPolicyRow>();
  return row === null
    ? invalid("capabilityId")
    : parseCapabilityPolicyRow(input.organisationId, row);
}

function validateCapabilityPolicyWrite(
  write: CapabilityPolicyWrite,
): Result<true, CapabilityPolicyError> {
  const definition = capabilityDefinitionById(write.capabilityId);
  if (!supportsMode(definition.policyModes, write.mode)) return invalid("mode");
  if (!isNonNegativeInteger(write.now)) return invalid("changedAt");
  if (write.kind === "change" && !isPositiveInteger(write.expectedRevision)) {
    return invalid("expectedRevision");
  }
  return { ok: true, value: true };
}

function supportsMode(
  policyModes: CapabilityPolicyModes,
  mode: CapabilityMode,
): boolean {
  switch (policyModes) {
    case "enabled_disabled":
      return mode === "enabled" || mode === "disabled";
    case "approval_required_disabled":
      return mode === "approval_required" || mode === "disabled";
    case "enabled_approval_required_disabled":
      return true;
  }
}

function parseCapabilityPolicyProvenance(
  raw: unknown,
): CapabilityPolicyProvenance | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case "baseline":
      return hasExactKeys(value, [
        "kind",
        "profile",
        "profileVersion",
        "materializationReceiptId",
      ]) &&
        isNonBlankString(value.profile) &&
        isPositiveInteger(value.profileVersion) &&
        isNonBlankString(value.materializationReceiptId)
        ? {
            kind: "baseline",
            profile: value.profile,
            profileVersion: value.profileVersion,
            materializationReceiptId: value.materializationReceiptId,
          }
        : null;
    case "operator":
      return hasExactKeys(value, ["kind", "userId", "mutationReceiptId"]) &&
        isNonBlankString(value.userId) &&
        isNonBlankString(value.mutationReceiptId)
        ? {
            kind: "operator",
            userId: value.userId,
            mutationReceiptId: value.mutationReceiptId,
          }
        : null;
    case "integration_setup":
      return hasExactKeys(value, [
        "kind",
        "integrationAccountId",
        "setupRevision",
        "materializationReceiptId",
      ]) &&
        isNonBlankString(value.integrationAccountId) &&
        isPositiveInteger(value.setupRevision) &&
        isNonBlankString(value.materializationReceiptId)
        ? {
            kind: "integration_setup",
            integrationAccountId: value.integrationAccountId,
            setupRevision: value.setupRevision,
            materializationReceiptId: value.materializationReceiptId,
          }
        : null;
    case "cutover_enabled":
      return hasExactKeys(value, [
        "kind",
        "migrationId",
        "previousEnabledAt",
      ]) &&
        isNonBlankString(value.migrationId) &&
        isNonNegativeInteger(value.previousEnabledAt)
        ? {
            kind: "cutover_enabled",
            migrationId: value.migrationId,
            previousEnabledAt: value.previousEnabledAt,
          }
        : null;
    case "cutover_disabled":
      return hasExactKeys(value, ["kind", "migrationId"]) &&
        isNonBlankString(value.migrationId)
        ? { kind: "cutover_disabled", migrationId: value.migrationId }
        : null;
  }
  return null;
}

export function parseActiveCapabilityId(
  value: string,
): ActiveCapabilityId | null {
  for (const capabilityId of Object.values(CAPABILITY_KEYS)) {
    if (capabilityId === value) return capabilityId;
  }
  return null;
}

function requireActiveCapabilityId(value: string): ActiveCapabilityId {
  const capabilityId = parseActiveCapabilityId(value);
  if (capabilityId === null)
    throw new Error(`Unknown catalogue capability: ${value}`);
  return capabilityId;
}

function isCapabilityMode(value: unknown): value is CapabilityMode {
  return (
    value === "enabled" || value === "approval_required" || value === "disabled"
  );
}

function invalid(field: string): Result<never, CapabilityPolicyError> {
  return { ok: false, error: { code: "capability_policy_invalid", field } };
}

function storeFailure(error: unknown): Result<never, CapabilityPolicyError> {
  return {
    ok: false,
    error: {
      code: "capability_policy_store_failed",
      detail: error instanceof Error ? error.message : String(error),
    },
  };
}

import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";
import {
  prepareOrganisationLifecycleMove,
  type LifecycleFence,
  type OrganisationLifecycleState,
} from "./organisation-lifecycle-moves";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { ApprovalAuthenticationReadiness } from "@seams/contracts";
import {
  newSetupSnapshotId,
  parseChannelId,
  parseIntegrationAccountId,
  parseSetupSnapshotId,
  parseWorkspaceId,
  type ChannelId,
  type UserId,
  type IntegrationAccountId,
  type SetupSnapshotId,
  type OrganisationId,
  type WorkspaceId,
} from "../ids";
import type { Result } from "../result";
import type { OrganisationEnvironment } from "./control-plane";
import {
  prepareControlMutationReceiptAfterWrite,
  prepareOnboardingAuditEventAfterWrite,
  prepareOnboardingEventAfterWrite,
  prepareOnboardingEvent,
  type ControlMutationBoundary,
  type ControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "./control-mutation";
import {
  capabilityPolicyAdmission,
  prepareReadAndProposeAccessDefaults,
  slackConversationBaselineGrantId,
  type CapabilityPolicyAdmission,
} from "./capability-policy";
import type { Variant } from "@seams/type-utils";
import type { OrganisationQuerySource } from "./query-source";
import { isRecord } from "@seams/std";
import type { CuePresetId } from "@seams/control-api";

export type CapabilityProfile = "read_and_propose" | "approved_provider_writes";
export type PolicyTemplateId = "commerce_operator";
export type SetupSelection = {
  readonly policyTemplateId: PolicyTemplateId;
  readonly capabilityProfile: CapabilityProfile;
  readonly cuePresetId: CuePresetId;
  readonly cueTarget: {
    readonly workspaceId: WorkspaceId;
    readonly channelId: ChannelId;
  };
};

export type ReadinessBlocker =
  | { readonly code: "owner_missing" }
  | { readonly code: "placement_missing" }
  | { readonly code: "communication_connection_missing" }
  | { readonly code: "communication_destination_missing" }
  | { readonly code: "commerce_system_missing" }
  | {
      readonly code: "credential_unresolved";
      readonly integrationAccountId: IntegrationAccountId;
    }
  | {
      readonly code: "webhook_unhealthy";
      readonly integrationAccountId: IntegrationAccountId;
    }
  | { readonly code: "policy_snapshot_missing" }
  | { readonly code: "cue_snapshot_missing" }
  | { readonly code: "environment_conflict" }
  | { readonly code: "runtime_admission_unavailable" };

export type RuntimeAdmissionStatus = "available" | "unavailable" | "unknown";
type CommerceSystemReadiness = "ready" | "syncing" | "unknown";

type ReadyAssessment = {
  readonly kind: "ready";
  readonly organisationId: OrganisationId;
  readonly readinessVersion: number;
  readonly readinessHash: string;
  readonly configurationVersion: number;
  readonly environment: OrganisationEnvironment;
  readonly capabilityProfile: CapabilityProfile;
  readonly policySnapshotId: SetupSnapshotId;
  readonly cueSnapshotId: SetupSnapshotId;
  readonly approvalAuthentication: readonly ApprovalAuthenticationReadiness[];
  readonly assessedAt: number;
};

type BlockedAssessment = {
  readonly kind: "blocked";
  readonly organisationId: OrganisationId;
  readonly readinessVersion: number;
  readonly readinessHash: string;
  readonly configurationVersion: number;
  readonly environment: OrganisationEnvironment;
  readonly capabilityProfile: CapabilityProfile;
  readonly blockers: readonly ReadinessBlocker[];
  readonly approvalAuthentication: readonly ApprovalAuthenticationReadiness[];
  readonly assessedAt: number;
};

type ReadinessAssessment = ReadyAssessment | BlockedAssessment;

type SetupSnapshotRow = {
  snapshotId: unknown;
  snapshotKind: unknown;
  templateId: unknown;
  templateVersion: unknown;
  body: unknown;
  createdAt: unknown;
};

type AccountReadinessRow = {
  integrationAccountId: unknown;
  provider: unknown;
  lifecycle: unknown;
  credentialRef: unknown;
  manifestLifecycle: unknown;
  surfaceCount: unknown;
  liveWebhookCount: unknown;
  activeCredentialGenerationCount: unknown;
};

type SetupSelectionRow = {
  readonly policyTemplateId: unknown;
  readonly cuePresetId: unknown;
  readonly workspaceId: unknown;
  readonly channelId: unknown;
};

const POLICY_TEMPLATE_VERSION = 1;
const CUE_TEMPLATE_VERSION = 1;

type SetupMutation = {
  readonly boundary: Variant<
    ControlMutationBoundary,
    "configuration_versioned"
  >;
  readonly scope: ControlMutationReceiptScope;
  readonly identity: ControlMutationIdentity;
};

type SetupMutationResult = {
  readonly policySnapshotId: SetupSnapshotId;
  readonly cueSnapshotId: SetupSnapshotId;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
  readonly receiptId: string;
};

type SetupMutationError =
  | { readonly code: "organisation_placement_conflict" }
  | { readonly code: "organisation_not_found" }
  | { readonly code: "configuration_version_conflict" }
  | {
      readonly code: "organisation_lifecycle_conflict";
      readonly lifecycle: string;
    }
  | { readonly code: "communication_connection_missing" }
  | { readonly code: "commerce_system_missing" }
  | { readonly code: "provider_resource_not_accessible" };

export async function loadSetupSelection(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly capabilityProfile: CapabilityProfile;
}): Promise<SetupSelection | null> {
  const row = await input.db
    .prepare(
      `SELECT selection.policy_template_id AS policyTemplateId,
            selection.cue_preset_id AS cuePresetId,
            destination.workspace_id AS workspaceId,
            destination.channel_id AS channelId
     FROM organisation_onboarding_selection AS selection
     JOIN organisation_communication_destination AS destination
       ON destination.organisation_id = selection.organisation_id
     WHERE selection.organisation_id = ?`,
    )
    .bind(input.organisationId)
    .first<SetupSelectionRow>();
  return row === null
    ? null
    : requirePersistedSetupSelection(row, input.capabilityProfile);
}

export function parsePersistedCapabilityProfile(
  raw: unknown,
): CapabilityProfile {
  return requireCapabilityProfile(raw);
}

export async function selectSetupTemplates(input: {
  readonly scope: OrganisationExecutionScope;
  readonly selectedByUserId: UserId;
  readonly selection: SetupSelection;
  readonly mutation: SetupMutation;
  readonly now: number;
}): Promise<Result<SetupMutationResult, SetupMutationError>> {
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  const policySnapshotId = newSetupSnapshotId();
  const cueSnapshotId = newSetupSnapshotId();
  const policyBody = policyTemplateBody(
    input.selection.policyTemplateId,
    input.selection.capabilityProfile,
  );
  const cueBody = cuePresetBody(input.selection);
  const cueTarget = cueTargetColumns(input.selection);
  const session = input.scope.database.withSession("first-primary");
  const state = await readSetupMutationState(
    session,
    input.scope.organisationId,
  );
  if (state === null) {
    return { ok: false, error: { code: "organisation_not_found" } };
  }
  if (
    state.configurationVersion !==
    input.mutation.boundary.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  if (state.lifecycle !== "configuring" && state.lifecycle !== "active") {
    return {
      ok: false,
      error: {
        code: "organisation_lifecycle_conflict",
        lifecycle: state.lifecycle,
      },
    };
  }
  const communicationDestination = await resolveCommunicationDestination({
    db: session,
    organisationId: input.scope.organisationId,
    environment: state.environment,
    selection: input.selection,
  });
  if (!communicationDestination.ok) {
    return communicationDestination;
  }
  const configurationVersion = state.configurationVersion + 1;
  const projectionRevision = state.projectionRevision + 1;
  const destinationGrantId = await slackConversationBaselineGrantId({
    organisationId: input.scope.organisationId,
    integrationAccountId: communicationDestination.value.integrationAccountId,
    channelId: input.selection.cueTarget.channelId,
  });
  const receipt = {
    receipt_id: input.mutation.identity.receiptId,
    organisation_id: input.scope.organisationId,
  };
  const admission: CapabilityPolicyAdmission = {
    kind: "accepted_mutation",
    scope: input.scope,
    auditEventId: input.mutation.identity.auditEventId,
    configurationVersion,
  };
  const guard = capabilityPolicyAdmission(admission);
  const [accepted] = await session.batch([
    // A setup save starts the setup again: the Organisation is configuring
    // until its next activation.
    prepareOrganisationLifecycleMove(session, {
      organisationId: input.scope.organisationId,
      event: "save_setup",
      from: [state.lifecycle],
      fence: input.scope,
      set: {
        sql: `capability_profile = ?,
           activation_attempt_id = NULL, readiness_version = NULL,
           activated_at = NULL, activation_receipt_id = NULL,
           suspension_reason_code = NULL, suspended_at = NULL,
           archived_at = NULL, purge_after = NULL,
           configuration_version = ?, projection_revision = ?`,
        bindings: [
          input.selection.capabilityProfile,
          configurationVersion,
          projectionRevision,
        ],
      },
      guard: {
        sql: "configuration_version = ? AND projection_revision = ?",
        bindings: [state.configurationVersion, state.projectionRevision],
      },
      now: input.now,
    }),
    prepareControlMutationReceiptAfterWrite(session, {
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 200,
      responseBody: receipt,
    }),
    prepareOnboardingAuditEventAfterWrite(session, input.mutation.identity, {
      organisationId: input.scope.organisationId,
      environment: state.environment,
      actorUserId: input.selectedByUserId,
      operation: "setup.save",
      targetKind: "organisation_setup",
      targetId: input.scope.organisationId,
      oldLifecycle: state.lifecycle,
      newLifecycle: "configuring",
      configurationVersion,
      projectionRevision,
      reasonCode: "merchant_saved",
    }),
    prepareOnboardingEventAfterWrite(session, input.mutation.identity, {
      eventId: `event_${crypto.randomUUID()}`,
      eventType: "setup_saved",
      organisationId: input.scope.organisationId,
      environment: state.environment,
      projectionRevision,
      attributes: {
        capability_profile: input.selection.capabilityProfile,
        receipt_id: input.mutation.identity.receiptId,
      },
    }),
    prepareOnboardingEventAfterWrite(session, input.mutation.identity, {
      eventId: `event_${crypto.randomUUID()}`,
      eventType: "onboarding_stage_completed",
      organisationId: input.scope.organisationId,
      environment: state.environment,
      projectionRevision,
      attributes: {
        stage: "operating_profile",
        receipt_id: input.mutation.identity.receiptId,
      },
    }),
    prepareOnboardingEventAfterWrite(session, input.mutation.identity, {
      eventId: `event_${crypto.randomUUID()}`,
      eventType: "readiness_invalidated",
      organisationId: input.scope.organisationId,
      environment: state.environment,
      projectionRevision,
      attributes: {
        reason_code: "setup_changed",
        configuration_version: configurationVersion,
      },
    }),
    setupSnapshotInsert(
      session,
      input,
      "policy",
      policySnapshotId,
      input.selection.policyTemplateId,
      POLICY_TEMPLATE_VERSION,
      policyBody,
      admission,
    ),
    setupSnapshotInsert(
      session,
      input,
      "cue",
      cueSnapshotId,
      input.selection.cuePresetId,
      CUE_TEMPLATE_VERSION,
      cueBody,
      admission,
    ),
    session
      .prepare(
        `INSERT INTO organisation_onboarding_selection (
         organisation_id, policy_template_id, policy_template_version, cue_preset_id,
         cue_preset_version, cue_workspace_id, cue_channel_id,
         selected_by_user_id, selected_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.condition}
       ON CONFLICT (organisation_id) DO UPDATE SET
         policy_template_id = excluded.policy_template_id,
         policy_template_version = excluded.policy_template_version,
         cue_preset_id = excluded.cue_preset_id,
         cue_preset_version = excluded.cue_preset_version,
         cue_workspace_id = excluded.cue_workspace_id,
         cue_channel_id = excluded.cue_channel_id,
         selected_by_user_id = excluded.selected_by_user_id,
         selected_at = excluded.selected_at`,
      )
      .bind(
        input.scope.organisationId,
        input.selection.policyTemplateId,
        POLICY_TEMPLATE_VERSION,
        input.selection.cuePresetId,
        CUE_TEMPLATE_VERSION,
        cueTarget.workspaceId,
        cueTarget.channelId,
        input.selectedByUserId,
        input.now,
        ...guard.bindings,
      ),
    ...prepareReadAndProposeAccessDefaults({
      source: session,
      admission,
      materializationReceiptId: input.mutation.identity.receiptId,
      now: input.now,
      destination: {
        kind: "slack_conversation",
        grantId: destinationGrantId,
        integrationAccountId:
          communicationDestination.value.integrationAccountId,
        conversationId: input.selection.cueTarget.channelId,
      },
    }),
    session
      .prepare(
        `INSERT INTO organisation_communication_destination (
         organisation_id, integration_account_id, workspace_id, channel_id,
         provider_revision, selected_at
       ) SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.condition}
       ON CONFLICT (organisation_id) DO UPDATE SET
         integration_account_id = excluded.integration_account_id,
         workspace_id = excluded.workspace_id,
         channel_id = excluded.channel_id,
         provider_revision = excluded.provider_revision,
         selected_at = excluded.selected_at`,
      )
      .bind(
        input.scope.organisationId,
        communicationDestination.value.integrationAccountId,
        input.selection.cueTarget.workspaceId,
        input.selection.cueTarget.channelId,
        communicationDestination.value.providerRevision,
        input.now,
        ...guard.bindings,
      ),
    session
      .prepare(
        `INSERT INTO organisation_slack_channel (
         organisation_id, integration_account_id, workspace_id, channel_id,
         provider_revision, connected_at
       ) SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.condition}
       ON CONFLICT (organisation_id, workspace_id, channel_id) DO UPDATE SET
         integration_account_id = excluded.integration_account_id,
         provider_revision = excluded.provider_revision`,
      )
      .bind(
        input.scope.organisationId,
        communicationDestination.value.integrationAccountId,
        input.selection.cueTarget.workspaceId,
        input.selection.cueTarget.channelId,
        communicationDestination.value.providerRevision,
        input.now,
        ...guard.bindings,
      ),
  ]);
  if (accepted?.meta.changes !== 1)
    return {
      ok: false,
      error: {
        code: (await input.scope.isActive())
          ? "configuration_version_conflict"
          : "organisation_placement_conflict",
      },
    };
  return {
    ok: true,
    value: {
      policySnapshotId,
      cueSnapshotId,
      configurationVersion,
      projectionRevision,
      receiptId: input.mutation.identity.receiptId,
    },
  };
}

async function resolveCommunicationDestination(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly environment: OrganisationEnvironment;
  readonly selection: SetupSelection;
}): Promise<
  Result<
    {
      readonly integrationAccountId: IntegrationAccountId;
      readonly providerRevision: string;
    },
    SetupMutationError
  >
> {
  const communication = await input.db
    .prepare(
      `SELECT account.integration_account_id AS integrationAccountId,
            surface.workspace_id AS workspaceId
     FROM integration_account AS account
     JOIN surface_installation AS surface
       ON surface.integration_account_id = account.integration_account_id
      AND surface.organisation_id = account.organisation_id
     WHERE account.organisation_id = ? AND account.environment = ?
       AND account.provider = 'slack' AND account.lifecycle = 'active'
       AND surface.surface_kind = 'slack' AND surface.workspace_id = ?`,
    )
    .bind(
      input.organisationId,
      input.environment,
      input.selection.cueTarget.workspaceId,
    )
    .first<{
      readonly integrationAccountId: unknown;
      readonly workspaceId: unknown;
    }>();
  if (communication === null) {
    return { ok: false, error: { code: "communication_connection_missing" } };
  }
  const communicationAccountId = requireIntegrationAccountId(
    communication.integrationAccountId,
  );
  if (communication.workspaceId !== input.selection.cueTarget.workspaceId) {
    return { ok: false, error: { code: "provider_resource_not_accessible" } };
  }
  const selectedResource = await input.db
    .prepare(
      `SELECT resource.provider_revision AS providerRevision
       FROM provider_discovered_resource AS resource
       JOIN provider_resource_snapshot AS snapshot
         ON snapshot.snapshot_revision = resource.snapshot_revision
       WHERE snapshot.organisation_id = ?
         AND snapshot.integration_account_id = ?
         AND resource.canonical_resource_id = ?
         AND resource.access_state = 'accessible'
       ORDER BY snapshot.created_at DESC
       LIMIT 1`,
    )
    .bind(
      input.organisationId,
      communicationAccountId,
      input.selection.cueTarget.channelId,
    )
    .first<{ readonly providerRevision: unknown }>();
  if (
    selectedResource === null ||
    typeof selectedResource.providerRevision !== "string"
  ) {
    return { ok: false, error: { code: "provider_resource_not_accessible" } };
  }
  return {
    ok: true,
    value: {
      integrationAccountId: communicationAccountId,
      providerRevision: selectedResource.providerRevision,
    },
  };
}

export async function evaluateAndStoreReadiness(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  /** The placement that the caller holds (Refactor 15, refactor 5). */
  readonly fence: LifecycleFence;
  readonly now: number;
  readonly runtimeAdmission: RuntimeAdmissionStatus;
  readonly commerceSystemReadiness: CommerceSystemReadiness;
}): Promise<ReadinessAssessment> {
  const capabilityProfile = await resolveCapabilityProfile(
    input.db,
    input.organisationId,
  );
  const configuration = await resolveOnboardingConfiguration(
    input.db,
    input.organisationId,
  );
  const configurationVersion = configuration.configurationVersion;
  const snapshots = await latestSetupSnapshots(input.db, input.organisationId);
  const blockers = await collectReadinessBlockers({
    db: input.db,
    organisationId: input.organisationId,
    hasPolicySnapshot: snapshots.policy !== null,
    hasCueSnapshot: snapshots.cue !== null,
    runtimeAdmission: input.runtimeAdmission,
    commerceSystemReadiness: input.commerceSystemReadiness,
  });
  const approvalAuthentication = resolveApprovalAuthenticationReadiness(
    snapshots.policy?.body ?? null,
  );
  const readinessVersion = await nextReadinessVersion(
    input.db,
    input.organisationId,
  );
  const readinessHash = await readinessDigest({
    organisationId: input.organisationId,
    readinessVersion,
    configurationVersion,
    environment: configuration.environment,
    capabilityProfile,
    policySnapshotId: snapshots.policy?.snapshotId ?? null,
    cueSnapshotId: snapshots.cue?.snapshotId ?? null,
    runtimeAdmission: input.runtimeAdmission,
    commerceSystemReadiness: input.commerceSystemReadiness,
    blockers,
    ...(approvalAuthentication.length > 0 ? { approvalAuthentication } : {}),
  });
  if (
    blockers.length > 0 ||
    snapshots.policy === null ||
    snapshots.cue === null
  ) {
    const session = input.db.withSession("first-primary");
    const eventIdentity = readinessEventIdentity(input.now);
    await session.batch([
      readinessAssessmentInsert(session, {
        organisationId: input.organisationId,
        readinessVersion,
        readinessHash,
        configurationVersion,
        environment: configuration.environment,
        capabilityProfile,
        policySnapshotId: snapshots.policy?.snapshotId ?? null,
        cueSnapshotId: snapshots.cue?.snapshotId ?? null,
        blockers,
        approvalAuthentication,
        assessedAt: input.now,
      }),
      setConfiguringStatement(
        session,
        input.organisationId,
        input.fence,
        capabilityProfile,
        input.now,
      ),
      prepareOnboardingEvent(session, eventIdentity, {
        eventId: eventIdentity.auditEventId,
        eventType: "readiness_assessed",
        organisationId: input.organisationId,
        environment: configuration.environment,
        projectionRevision: configuration.projectionRevision + 1,
        attributes: {
          readiness_version: readinessVersion,
          configuration_version: configurationVersion,
          result: "blocked",
          blocker_count: blockers.length,
        },
      }),
    ]);
    return {
      kind: "blocked",
      organisationId: input.organisationId,
      readinessVersion,
      readinessHash,
      configurationVersion,
      environment: configuration.environment,
      capabilityProfile,
      blockers,
      approvalAuthentication,
      assessedAt: input.now,
    };
  }

  const session = input.db.withSession("first-primary");
  const eventIdentity = readinessEventIdentity(input.now);
  await session.batch([
    readinessAssessmentInsert(session, {
      organisationId: input.organisationId,
      readinessVersion,
      readinessHash,
      configurationVersion,
      environment: configuration.environment,
      capabilityProfile,
      policySnapshotId: snapshots.policy.snapshotId,
      cueSnapshotId: snapshots.cue.snapshotId,
      blockers: [],
      approvalAuthentication,
      assessedAt: input.now,
    }),
    setConfiguringStatement(
      session,
      input.organisationId,
      input.fence,
      capabilityProfile,
      input.now,
    ),
    prepareOnboardingEvent(session, eventIdentity, {
      eventId: eventIdentity.auditEventId,
      eventType: "readiness_assessed",
      organisationId: input.organisationId,
      environment: configuration.environment,
      projectionRevision: configuration.projectionRevision + 1,
      attributes: {
        readiness_version: readinessVersion,
        configuration_version: configurationVersion,
        result: "ready",
        blocker_count: 0,
      },
    }),
  ]);
  return {
    kind: "ready",
    organisationId: input.organisationId,
    readinessVersion,
    readinessHash,
    configurationVersion,
    environment: configuration.environment,
    capabilityProfile,
    policySnapshotId: snapshots.policy.snapshotId,
    cueSnapshotId: snapshots.cue.snapshotId,
    approvalAuthentication,
    assessedAt: input.now,
  };
}

export function ensureCurrentReadiness(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly fence: LifecycleFence;
  readonly now: number;
  readonly runtimeAdmission: RuntimeAdmissionStatus;
  readonly commerceSystemReadiness: CommerceSystemReadiness;
}): Promise<ReadinessAssessment | null> {
  return ensureCurrentReadinessFromSignals({
    db: input.db,
    organisationId: input.organisationId,
    fence: input.fence,
    now: input.now,
    signals: async () => ({
      runtimeAdmission: input.runtimeAdmission,
      commerceSystemReadiness: input.commerceSystemReadiness,
    }),
  });
}

/**
 * `ensureCurrentReadiness` for a caller that can defer its two signals. Only
 * an Organisation that is being configured can hold a stale assessment, so
 * the signals are read for that lifecycle alone.
 */
export async function ensureCurrentReadinessFromSignals(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly fence: LifecycleFence;
  readonly now: number;
  readonly signals: () => Promise<
    Readonly<{
      runtimeAdmission: RuntimeAdmissionStatus;
      commerceSystemReadiness: CommerceSystemReadiness;
    }>
  >;
}): Promise<ReadinessAssessment | null> {
  const [lifecycle, current] = await Promise.all([
    input.db
      .prepare(
        `SELECT lifecycle FROM organisation_onboarding WHERE organisation_id = ?`,
      )
      .bind(input.organisationId)
      .first<{ readonly lifecycle: unknown }>(),
    readCurrentReadiness({
      db: input.db,
      organisationId: input.organisationId,
    }),
  ]);
  if (lifecycle === null) {
    return null;
  }
  if (lifecycle.lifecycle !== "configuring") {
    return current;
  }
  const evaluation = {
    db: input.db,
    organisationId: input.organisationId,
    fence: input.fence,
    now: input.now,
    ...(await input.signals()),
  };
  if (current === null || current.readinessVersion === 0) {
    return evaluateAndStoreReadiness(evaluation);
  }
  return (await readinessAssessmentStale(evaluation, current))
    ? evaluateAndStoreReadiness(evaluation)
    : current;
}

/**
 * The stored assessment is a cache of `collectReadinessBlockers`. It used to
 * refresh only when the runtime-admission or commerce-sync signal disagreed
 * with it, so a configuration change the gate did not sample — connecting
 * Slack, choosing a channel, saving setup snapshots — left cleared blockers
 * on screen indefinitely. Staleness is now decided by recollecting the
 * blockers (a handful of indexed reads) and comparing; a new assessment
 * version is stored only on real drift. Signals reporting "unknown" cannot
 * vote: their codes are ignored on both sides, so an unknown probe neither
 * clears nor re-adds them.
 */
async function readinessAssessmentStale(
  input: {
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly runtimeAdmission: RuntimeAdmissionStatus;
    readonly commerceSystemReadiness: CommerceSystemReadiness;
  },
  current: ReadinessAssessment,
): Promise<boolean> {
  const snapshots = await latestSetupSnapshots(input.db, input.organisationId);
  const blockers = await collectReadinessBlockers({
    db: input.db,
    organisationId: input.organisationId,
    hasPolicySnapshot: snapshots.policy !== null,
    hasCueSnapshot: snapshots.cue !== null,
    runtimeAdmission: input.runtimeAdmission,
    commerceSystemReadiness: input.commerceSystemReadiness,
  });
  const ignored = new Set<string>();
  if (input.runtimeAdmission === "unknown")
    ignored.add("runtime_admission_unavailable");
  if (input.commerceSystemReadiness === "unknown")
    ignored.add("commerce_system_missing");
  const currentBlockers = current.kind === "blocked" ? current.blockers : [];
  return (
    readinessBlockerSetKey(blockers, ignored) !==
    readinessBlockerSetKey(currentBlockers, ignored)
  );
}

function readinessBlockerSetKey(
  blockers: readonly ReadinessBlocker[],
  ignored: ReadonlySet<string>,
): string {
  return blockers
    .filter((blocker) => !ignored.has(blocker.code))
    .map(
      (blocker) =>
        `${blocker.code}:${"integrationAccountId" in blocker ? blocker.integrationAccountId : ""}`,
    )
    .sort()
    .join("|");
}

export async function readCurrentReadiness(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
}): Promise<ReadinessAssessment | null> {
  const row = await input.db
    .prepare(
      `SELECT o.lifecycle,
            o.capability_profile AS capabilityProfile,
            o.configuration_version AS currentConfigurationVersion,
            o.environment AS currentEnvironment,
            a.readiness_version AS readinessVersion,
            a.readiness_hash AS readinessHash,
            a.configuration_version AS assessmentConfigurationVersion,
            a.environment AS assessmentEnvironment,
            a.policy_snapshot_id AS policySnapshotId,
            a.cue_snapshot_id AS cueSnapshotId,
            a.blockers,
            a.approval_authentication_json AS approvalAuthenticationJson,
            a.assessed_at AS assessedAt,
            attempt.readiness_version AS activatedReadinessVersion,
            receipt.readiness_hash AS activatedReadinessHash,
            receipt.policy_snapshot_id AS activatedPolicySnapshotId,
            receipt.cue_snapshot_id AS activatedCueSnapshotId,
            receipt.activated_at AS activatedAt
     FROM organisation_onboarding o
     LEFT JOIN organisation_activation_receipt AS receipt
       ON receipt.activation_receipt_id = o.activation_receipt_id
     LEFT JOIN organisation_activation_attempt AS attempt
       ON attempt.activation_attempt_id = receipt.activation_attempt_id
     LEFT JOIN organisation_readiness_assessment a
       ON a.organisation_id = o.organisation_id
      AND a.readiness_version = (
        SELECT MAX(latest.readiness_version)
        FROM organisation_readiness_assessment latest
        WHERE latest.organisation_id = o.organisation_id
      )
     WHERE o.organisation_id = ?`,
    )
    .bind(input.organisationId)
    .first<{
      lifecycle: unknown;
      capabilityProfile: unknown;
      currentConfigurationVersion: unknown;
      currentEnvironment: unknown;
      readinessVersion: unknown;
      readinessHash: unknown;
      assessmentConfigurationVersion: unknown;
      assessmentEnvironment: unknown;
      policySnapshotId: unknown;
      cueSnapshotId: unknown;
      blockers: unknown;
      approvalAuthenticationJson: unknown;
      assessedAt: unknown;
      activatedReadinessVersion: unknown;
      activatedReadinessHash: unknown;
      activatedPolicySnapshotId: unknown;
      activatedCueSnapshotId: unknown;
      activatedAt: unknown;
    }>();
  if (row === null) {
    return null;
  }
  const capabilityProfile = requireCapabilityProfile(row.capabilityProfile);
  const configurationVersion = requirePositiveInteger(
    row.currentConfigurationVersion,
    "onboarding configuration version",
  );
  const environment = requireOrganisationEnvironment(row.currentEnvironment);
  if (
    row.lifecycle === "active" &&
    typeof row.activatedReadinessVersion === "number" &&
    typeof row.activatedReadinessHash === "string" &&
    typeof row.activatedAt === "number"
  ) {
    return {
      kind: "ready",
      organisationId: input.organisationId,
      readinessVersion: requirePositiveInteger(
        row.activatedReadinessVersion,
        "activated readiness version",
      ),
      readinessHash: row.activatedReadinessHash,
      configurationVersion,
      environment,
      capabilityProfile,
      policySnapshotId: requireSetupSnapshotId(row.activatedPolicySnapshotId),
      cueSnapshotId: requireSetupSnapshotId(row.activatedCueSnapshotId),
      approvalAuthentication: parsePersistedApprovalAuthentication(
        row.approvalAuthenticationJson,
      ),
      assessedAt: requireInteger(row.activatedAt, "activated_at"),
    };
  }
  if (
    typeof row.readinessVersion !== "number" ||
    row.assessmentConfigurationVersion !== configurationVersion ||
    row.assessmentEnvironment !== environment
  ) {
    return {
      kind: "blocked",
      organisationId: input.organisationId,
      readinessVersion: 0,
      readinessHash: "unassessed",
      configurationVersion,
      environment,
      capabilityProfile,
      blockers: [],
      approvalAuthentication: [],
      assessedAt: 0,
    };
  }
  const readinessHash = requireString(row.readinessHash, "readiness hash");
  const assessedAt = requireInteger(row.assessedAt, "readiness assessed_at");
  const blockers = parsePersistedReadinessBlockers(row.blockers);
  const approvalAuthentication = parsePersistedApprovalAuthentication(
    row.approvalAuthenticationJson,
  );
  if (blockers.length > 0) {
    return {
      kind: "blocked",
      organisationId: input.organisationId,
      readinessVersion: row.readinessVersion,
      readinessHash,
      configurationVersion,
      environment,
      capabilityProfile,
      blockers,
      approvalAuthentication,
      assessedAt,
    };
  }
  const policySnapshotId = requireSetupSnapshotId(row.policySnapshotId);
  const cueSnapshotId = requireSetupSnapshotId(row.cueSnapshotId);
  return {
    kind: "ready",
    organisationId: input.organisationId,
    readinessVersion: row.readinessVersion,
    readinessHash,
    configurationVersion,
    environment,
    capabilityProfile,
    policySnapshotId,
    cueSnapshotId,
    approvalAuthentication,
    assessedAt,
  };
}

export function parseSetupSelection(
  raw: unknown,
): Result<SetupSelection, { readonly code: "invalid_setup_selection" }> {
  if (!isRecord(raw)) {
    return invalidSelection();
  }
  if (
    raw.policyTemplateId !== "commerce_operator" ||
    !isCuePresetId(raw.cuePresetId) ||
    !isCapabilityProfile(raw.capabilityProfile)
  ) {
    return invalidSelection();
  }
  const cueTarget = parseCueTarget(raw.cueTarget);
  return cueTarget.ok
    ? {
        ok: true,
        value: {
          policyTemplateId: raw.policyTemplateId,
          cuePresetId: raw.cuePresetId,
          capabilityProfile: raw.capabilityProfile,
          cueTarget: cueTarget.value,
        },
      }
    : invalidSelection();
}

export function setupCatalog(): {
  readonly policyTemplates: readonly {
    readonly id: PolicyTemplateId;
    readonly version: number;
  }[];
  readonly cuePresets: readonly {
    readonly id: CuePresetId;
    readonly version: number;
  }[];
} {
  return {
    policyTemplates: [
      { id: "commerce_operator", version: POLICY_TEMPLATE_VERSION },
    ],
    cuePresets: [
      { id: "observe_commerce", version: CUE_TEMPLATE_VERSION },
      { id: "commerce_operator", version: CUE_TEMPLATE_VERSION },
      { id: "proactive_triage", version: CUE_TEMPLATE_VERSION },
    ],
  };
}

function setupSnapshotInsert(
  session: OrganisationDatabaseSession,
  input: {
    readonly scope: OrganisationExecutionScope;
    readonly selectedByUserId: UserId;
    readonly now: number;
  },
  kind: "policy" | "cue",
  snapshotId: SetupSnapshotId,
  templateId: string,
  templateVersion: number,
  body: unknown,
  admission: CapabilityPolicyAdmission,
): D1PreparedStatement {
  const guard = capabilityPolicyAdmission(admission);
  return session
    .prepare(
      `INSERT INTO organisation_setup_snapshot (
       organisation_id, snapshot_kind, snapshot_id, template_id, template_version,
       body, selected_by_user_id, created_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.condition}`,
    )
    .bind(
      input.scope.organisationId,
      kind,
      snapshotId,
      templateId,
      templateVersion,
      JSON.stringify(body),
      input.selectedByUserId,
      input.now,
      ...guard.bindings,
    );
}

function policyTemplateBody(
  templateId: PolicyTemplateId,
  capabilityProfile: CapabilityProfile,
): unknown {
  return {
    templateId,
    version: POLICY_TEMPLATE_VERSION,
    capabilityProfile,
    outputScreeningMode: "stream",
    highStakesWrites:
      capabilityProfile === "approved_provider_writes"
        ? "approval_required"
        : "disabled",
  };
}

function cuePresetBody(selection: SetupSelection): unknown {
  switch (selection.cuePresetId) {
    case "observe_commerce":
      return {
        presetId: selection.cuePresetId,
        version: CUE_TEMPLATE_VERSION,
        target: selection.cueTarget,
        subscriptions: [],
      };
    case "commerce_operator":
      return {
        presetId: selection.cuePresetId,
        version: CUE_TEMPLATE_VERSION,
        target: selection.cueTarget,
        subscriptions: ["stripe.charge_failed", "shopify.order_created"],
      };
    case "proactive_triage":
      return {
        presetId: selection.cuePresetId,
        version: CUE_TEMPLATE_VERSION,
        target: selection.cueTarget,
        subscriptions: [
          "stripe.charge_failed",
          "stripe.invoice_payment_failed",
          "shopify.order_created",
          "shopify.inventory_updated",
        ],
      };
  }
}

function cueTargetColumns(selection: SetupSelection): {
  readonly workspaceId: WorkspaceId | null;
  readonly channelId: ChannelId | null;
} {
  return selection.cuePresetId === "observe_commerce"
    ? { workspaceId: null, channelId: null }
    : selection.cueTarget;
}

function parseCueTarget(raw: unknown): Result<
  {
    readonly workspaceId: WorkspaceId;
    readonly channelId: ChannelId;
  },
  { readonly code: "invalid_setup_selection" }
> {
  if (
    !isRecord(raw) ||
    typeof raw.workspaceId !== "string" ||
    typeof raw.channelId !== "string"
  ) {
    return invalidSelection();
  }
  const workspaceId = parseWorkspaceId(raw.workspaceId);
  const channelId = parseChannelId(raw.channelId);
  return workspaceId.ok && channelId.ok
    ? {
        ok: true,
        value: { workspaceId: workspaceId.value, channelId: channelId.value },
      }
    : invalidSelection();
}

async function collectReadinessBlockers(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly hasPolicySnapshot: boolean;
  readonly hasCueSnapshot: boolean;
  readonly runtimeAdmission: RuntimeAdmissionStatus;
  readonly commerceSystemReadiness: CommerceSystemReadiness;
}): Promise<ReadinessBlocker[]> {
  const blockers: ReadinessBlocker[] = [];
  const owner = await input.db
    .prepare(
      `SELECT 1 AS present
     FROM service_role_grant m
     WHERE m.organisation_id = ? AND m.role = 'owner' AND m.status = 'active'
     ORDER BY m.created_at LIMIT 1`,
    )
    .bind(input.organisationId)
    .first<{ present: unknown }>();
  if (owner === null) {
    blockers.push({ code: "owner_missing" });
  }
  const onboarding = await resolveOnboardingConfiguration(
    input.db,
    input.organisationId,
  );
  const placement = await input.db
    .prepare(
      `SELECT 1 AS present
     FROM organisation_placement
     WHERE organisation_id = ? AND status = 'active' AND environment = ?
     LIMIT 1`,
    )
    .bind(input.organisationId, onboarding.environment)
    .first<{ readonly present: unknown }>();
  if (placement?.present !== 1) {
    blockers.push({ code: "placement_missing" });
  }
  const destination = await input.db
    .prepare(
      `SELECT 1 AS accessible
     FROM organisation_communication_destination AS destination
     JOIN provider_resource_snapshot AS snapshot
       ON snapshot.organisation_id = destination.organisation_id
      AND snapshot.integration_account_id = destination.integration_account_id
     JOIN provider_discovered_resource AS resource
       ON resource.snapshot_revision = snapshot.snapshot_revision
      AND resource.canonical_resource_id = destination.channel_id
      AND resource.provider_revision = destination.provider_revision
      AND resource.access_state = 'accessible'
     WHERE destination.organisation_id = ?
     ORDER BY snapshot.created_at DESC
     LIMIT 1`,
    )
    .bind(input.organisationId)
    .first<{ readonly accessible: unknown }>();
  if (destination?.accessible !== 1) {
    blockers.push({ code: "communication_destination_missing" });
  }
  const environmentConflict = await input.db
    .prepare(
      `SELECT 1 AS conflict
     FROM (
       SELECT environment FROM provider_connection WHERE organisation_id = ?
       UNION ALL
       SELECT environment FROM integration_account WHERE organisation_id = ?
       UNION ALL
       SELECT environment FROM provider_webhook WHERE organisation_id = ?
       UNION ALL
       SELECT environment FROM provider_credential_generation WHERE organisation_id = ?
     ) AS subject
     WHERE subject.environment != ?
     LIMIT 1`,
    )
    .bind(
      input.organisationId,
      input.organisationId,
      input.organisationId,
      input.organisationId,
      onboarding.environment,
    )
    .first<{ readonly conflict: unknown }>();
  if (environmentConflict?.conflict === 1) {
    blockers.push({ code: "environment_conflict" });
  }
  const accounts = await accountReadinessRows(input.db, input.organisationId);
  if (!accounts.some(isConversationalAccount)) {
    blockers.push({ code: "communication_connection_missing" });
  }
  const commerceSystemReady = await hasReadyCommerceSystem(
    input.db,
    input.organisationId,
    onboarding.environment,
    accounts,
  );
  if (!commerceSystemReady || input.commerceSystemReadiness === "syncing") {
    blockers.push({ code: "commerce_system_missing" });
  }
  for (const account of accounts) {
    appendAccountBlockers(blockers, account);
  }
  if (!input.hasPolicySnapshot) {
    blockers.push({ code: "policy_snapshot_missing" });
  }
  if (!input.hasCueSnapshot) {
    blockers.push({ code: "cue_snapshot_missing" });
  }
  if (input.runtimeAdmission === "unavailable") {
    blockers.push({ code: "runtime_admission_unavailable" });
  }
  return blockers;
}

function appendAccountBlockers(
  blockers: ReadinessBlocker[],
  row: AccountReadinessRow,
): void {
  const integrationAccountId = requireIntegrationAccountId(
    row.integrationAccountId,
  );
  if (
    typeof row.credentialRef !== "string" ||
    row.credentialRef.includes(":unresolved") ||
    row.activeCredentialGenerationCount !== 1
  ) {
    blockers.push({ code: "credential_unresolved", integrationAccountId });
  }
  if (row.provider !== "slack" && row.liveWebhookCount !== 1) {
    blockers.push({ code: "webhook_unhealthy", integrationAccountId });
  }
  if (row.manifestLifecycle !== "healthy") {
    blockers.push({ code: "webhook_unhealthy", integrationAccountId });
  }
}

async function accountReadinessRows(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<AccountReadinessRow[]> {
  const result = await db
    .prepare(
      `SELECT a.integration_account_id AS integrationAccountId, a.provider, a.lifecycle,
            c.credential_ref AS credentialRef,
            COALESCE((
              SELECT observation.lifecycle
              FROM provider_manifest_observation AS observation
              WHERE observation.integration_account_id = a.integration_account_id
              ORDER BY observation.observed_at DESC, observation.observation_id DESC
              LIMIT 1
            ), 'blocked') AS manifestLifecycle,
            CASE WHEN s.integration_account_id IS NULL THEN 0 ELSE 1 END AS surfaceCount,
            CASE WHEN EXISTS (
              SELECT 1 FROM provider_webhook w
              WHERE w.integration_account_id = a.integration_account_id AND w.lifecycle = 'live'
            ) THEN 1 ELSE 0 END AS liveWebhookCount,
            (
              SELECT COUNT(*)
              FROM provider_credential_generation AS generation
              WHERE generation.provider_connection_id = c.provider_connection_id
                AND generation.credential_generation = c.credential_generation
                AND generation.environment = a.environment
                AND generation.lifecycle = 'active'
            ) AS activeCredentialGenerationCount
     FROM integration_account a
     JOIN provider_connection c ON c.provider_connection_id = a.provider_connection_id
     JOIN organisation_onboarding onboarding ON onboarding.organisation_id = a.organisation_id
     LEFT JOIN surface_installation s ON s.integration_account_id = a.integration_account_id
     WHERE a.organisation_id = ? AND a.lifecycle = 'active'
       AND a.environment = onboarding.environment
       AND c.lifecycle = 'active' AND c.environment = onboarding.environment
       AND a.integration_account_id IN (
         SELECT destination.integration_account_id
         FROM organisation_communication_destination AS destination
         WHERE destination.organisation_id = a.organisation_id
         UNION
         SELECT selected.shopify_integration_account_id
         FROM organisation_commerce_system AS selected
         WHERE selected.organisation_id = a.organisation_id
           AND selected.system_kind = 'shopify'
       )`,
    )
    .bind(organisationId)
    .all<AccountReadinessRow>();
  return result.results ?? [];
}

function isConversationalAccount(row: AccountReadinessRow): boolean {
  return row.provider === "slack" && row.surfaceCount === 1;
}

function isCommerceAccount(row: AccountReadinessRow): boolean {
  return row.provider === "shopify" && row.liveWebhookCount === 1;
}

async function hasReadyCommerceSystem(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
  environment: OrganisationEnvironment,
  accounts: readonly AccountReadinessRow[],
): Promise<boolean> {
  const selected = await db
    .prepare(
      `SELECT system_kind AS systemKind,
            underclerk_binding_id AS underclerkBindingId,
            shopify_integration_account_id AS shopifyIntegrationAccountId
     FROM organisation_commerce_system
     WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      readonly systemKind: unknown;
      readonly underclerkBindingId: unknown;
      readonly shopifyIntegrationAccountId: unknown;
    }>();
  if (
    selected?.systemKind === "satyr_commerce" &&
    typeof selected.underclerkBindingId === "string" &&
    selected.shopifyIntegrationAccountId === null
  ) {
    const binding = await db
      .prepare(
        `SELECT 1 AS present
       FROM underclerk_merchant_binding
       WHERE binding_id = ? AND organisation_id = ? AND environment = ?`,
      )
      .bind(selected.underclerkBindingId, organisationId, environment)
      .first<{ readonly present: unknown }>();
    return binding?.present === 1;
  }
  if (
    selected?.systemKind === "shopify" &&
    selected.underclerkBindingId === null &&
    typeof selected.shopifyIntegrationAccountId === "string"
  ) {
    const binding = await db
      .prepare(
        `SELECT COUNT(*) AS count
       FROM underclerk_merchant_binding
       WHERE organisation_id = ? AND environment = ?`,
      )
      .bind(organisationId, environment)
      .first<{ readonly count: unknown }>();
    return accounts.some(isCommerceAccount) && binding?.count === 1;
  }
  return false;
}

async function latestSetupSnapshots(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<{
  readonly policy: {
    readonly snapshotId: SetupSnapshotId;
    readonly body: unknown;
  } | null;
  readonly cue: { readonly snapshotId: SetupSnapshotId } | null;
}> {
  const rows = await db
    .prepare(
      `SELECT snapshot_id AS snapshotId, snapshot_kind AS snapshotKind,
            template_id AS templateId, template_version AS templateVersion,
            body, created_at AS createdAt
     FROM organisation_setup_snapshot WHERE organisation_id = ?
     ORDER BY created_at DESC, snapshot_id DESC`,
    )
    .bind(organisationId)
    .all<SetupSnapshotRow>();
  let policy: {
    readonly snapshotId: SetupSnapshotId;
    readonly body: unknown;
  } | null = null;
  let cue: { readonly snapshotId: SetupSnapshotId } | null = null;
  for (const row of rows.results ?? []) {
    const snapshotId = requireSetupSnapshotId(row.snapshotId);
    if (row.snapshotKind === "policy" && policy === null) {
      policy = {
        snapshotId,
        body:
          typeof row.body === "string"
            ? (JSON.parse(row.body) as unknown)
            : null,
      };
    }
    if (row.snapshotKind === "cue" && cue === null) {
      cue = { snapshotId };
    }
  }
  return { policy, cue };
}

/**
 * Reports the readiness of any non-default approval-authentication branch a
 * organisation policy selects for an action class. The default Google OIDC step-up
 * produces no report and a non-default selection never blocks ordinary organisation
 * readiness; the report is informational until the selected branch's
 * verifier can be satisfied.
 */
function resolveApprovalAuthenticationReadiness(
  policyBody: unknown,
): readonly ApprovalAuthenticationReadiness[] {
  if (!isRecord(policyBody) || !isRecord(policyBody.approvalAuthentication)) {
    return [];
  }
  const selected = policyBody.approvalAuthentication.highStakes;
  switch (selected) {
    case "webauthn_step_up":
      return [
        {
          action_class: "high_stakes",
          branch: "webauthn_step_up",
          ready: false,
          reason: "webauthn_credential_missing",
        },
      ];
    case "seams_nep413":
      return [
        {
          action_class: "high_stakes",
          branch: "seams_nep413",
          ready: false,
          reason: "seams_identity_unlinked",
        },
      ];
    default:
      return [];
  }
}

async function loadOrganisationCapabilityProfile(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
}): Promise<CapabilityProfile> {
  const row = await input.db
    .prepare(
      `SELECT capability_profile AS capabilityProfile FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(input.organisationId)
    .first<{ capabilityProfile: unknown }>();
  if (row === null) {
    throw new Error("organisation onboarding record missing");
  }
  return requireCapabilityProfile(row.capabilityProfile);
}

async function resolveCapabilityProfile(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<CapabilityProfile> {
  return loadOrganisationCapabilityProfile({ db, organisationId });
}

async function readSetupMutationState(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<{
  readonly environment: OrganisationEnvironment;
  readonly lifecycle: OrganisationLifecycleState;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
} | null> {
  const row = await db
    .prepare(
      `SELECT environment, lifecycle, configuration_version AS configurationVersion,
            projection_revision AS projectionRevision
     FROM organisation_onboarding
     WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      readonly environment: unknown;
      readonly lifecycle: unknown;
      readonly configurationVersion: unknown;
      readonly projectionRevision: unknown;
    }>();
  if (row === null) {
    return null;
  }
  return {
    environment: requireOrganisationEnvironment(row.environment),
    lifecycle: requireOrganisationLifecycleKind(row.lifecycle),
    configurationVersion: requirePositiveInteger(
      row.configurationVersion,
      "organisation onboarding configuration version",
    ),
    projectionRevision: requirePositiveInteger(
      row.projectionRevision,
      "organisation onboarding projection revision",
    ),
  };
}

async function resolveOnboardingConfiguration(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<{
  readonly configurationVersion: number;
  readonly environment: OrganisationEnvironment;
  readonly projectionRevision: number;
}> {
  const row = await db
    .prepare(
      `SELECT configuration_version AS configurationVersion, environment,
            projection_revision AS projectionRevision
     FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      configurationVersion: unknown;
      environment: unknown;
      projectionRevision: unknown;
    }>();
  if (row === null) {
    throw new Error("organisation onboarding record missing");
  }
  return {
    configurationVersion: requirePositiveInteger(
      row.configurationVersion,
      "organisation onboarding configuration version",
    ),
    environment: requireOrganisationEnvironment(row.environment),
    projectionRevision: requirePositiveInteger(
      row.projectionRevision,
      "organisation onboarding projection revision",
    ),
  };
}

function readinessEventIdentity(now: number): ControlMutationIdentity {
  return {
    receiptId: `readiness_receipt_${crypto.randomUUID()}`,
    auditEventId: `event_${crypto.randomUUID()}`,
    correlationId: `readiness_${crypto.randomUUID()}`,
    causationId: `readiness_recompute_${crypto.randomUUID()}`,
    portalSubjectHash: "system:readiness",
    createdAt: now,
  };
}

async function nextReadinessVersion(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(readiness_version), 0) AS version
     FROM organisation_readiness_assessment WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{ version: unknown }>();
  return typeof row?.version === "number" ? row.version + 1 : 1;
}

async function readinessDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), hexByte).join("");
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function readinessAssessmentInsert(
  db: OrganisationQuerySource,
  assessment: {
    readonly organisationId: OrganisationId;
    readonly readinessVersion: number;
    readonly readinessHash: string;
    readonly configurationVersion: number;
    readonly environment: OrganisationEnvironment;
    readonly capabilityProfile: CapabilityProfile;
    readonly policySnapshotId: SetupSnapshotId | null;
    readonly cueSnapshotId: SetupSnapshotId | null;
    readonly blockers: readonly ReadinessBlocker[];
    readonly approvalAuthentication: readonly ApprovalAuthenticationReadiness[];
    readonly assessedAt: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO organisation_readiness_assessment (
       organisation_id, readiness_version, readiness_hash, configuration_version,
       capability_profile, policy_snapshot_id, cue_snapshot_id, blockers, assessed_at,
       environment, approval_authentication_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      assessment.organisationId,
      assessment.readinessVersion,
      assessment.readinessHash,
      assessment.configurationVersion,
      assessment.capabilityProfile,
      assessment.policySnapshotId,
      assessment.cueSnapshotId,
      JSON.stringify(assessment.blockers),
      assessment.assessedAt,
      assessment.environment,
      assessment.approvalAuthentication.length > 0
        ? JSON.stringify(assessment.approvalAuthentication)
        : null,
    );
}

function parsePersistedApprovalAuthentication(
  raw: unknown,
): readonly ApprovalAuthenticationReadiness[] {
  if (typeof raw !== "string") {
    return [];
  }
  const decoded: unknown = JSON.parse(raw);
  if (!Array.isArray(decoded)) {
    return [];
  }
  const reports: ApprovalAuthenticationReadiness[] = [];
  for (const entry of decoded) {
    if (
      !isRecord(entry) ||
      entry.action_class !== "high_stakes" ||
      (entry.branch !== "webauthn_step_up" &&
        entry.branch !== "seams_nep413" &&
        entry.branch !== "google_oidc_step_up") ||
      typeof entry.ready !== "boolean" ||
      (entry.reason !== null &&
        entry.reason !== "webauthn_credential_missing" &&
        entry.reason !== "seams_identity_unlinked")
    ) {
      continue;
    }
    reports.push({
      action_class: entry.action_class,
      branch: entry.branch,
      ready: entry.ready,
      reason: entry.reason,
    });
  }
  return reports;
}

function setConfiguringStatement(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
  fence: LifecycleFence,
  capabilityProfile: CapabilityProfile,
  now: number,
): D1PreparedStatement {
  // A new assessment keeps a configuring Organisation configuring; it never
  // moves an Organisation that left configuring meanwhile (Refactor 15).
  return prepareOrganisationLifecycleMove(db, {
    organisationId,
    event: "assess_readiness",
    from: ["configuring"],
    fence,
    set: {
      sql: `capability_profile = ?, readiness_version = NULL,
       activation_attempt_id = NULL, activated_at = NULL,
       activation_receipt_id = NULL, suspension_reason_code = NULL,
       suspended_at = NULL, archived_at = NULL, purge_after = NULL,
       projection_revision = projection_revision + 1`,
      bindings: [capabilityProfile],
    },
    now,
  });
}

function parsePersistedReadinessBlockers(
  raw: unknown,
): readonly ReadinessBlocker[] {
  if (typeof raw !== "string") {
    throw new Error("readiness blockers are invalid");
  }
  const decoded: unknown = JSON.parse(raw);
  if (!Array.isArray(decoded)) {
    throw new Error("readiness blockers are invalid");
  }
  return decoded.map(parsePersistedReadinessBlocker);
}

function parsePersistedReadinessBlocker(raw: unknown): ReadinessBlocker {
  if (!isRecord(raw) || typeof raw.code !== "string") {
    throw new Error("readiness blocker is invalid");
  }
  switch (raw.code) {
    case "owner_missing":
    case "placement_missing":
    case "communication_connection_missing":
    case "communication_destination_missing":
    case "commerce_system_missing":
    case "policy_snapshot_missing":
    case "cue_snapshot_missing":
    case "environment_conflict":
    case "runtime_admission_unavailable":
      return { code: raw.code };
    case "credential_unresolved":
    case "webhook_unhealthy":
      return {
        code: raw.code,
        integrationAccountId: requireIntegrationAccountId(
          raw.integrationAccountId,
        ),
      };
    default:
      throw new Error("readiness blocker code is invalid");
  }
}

function requireOrganisationEnvironment(raw: unknown): OrganisationEnvironment {
  if (raw !== "development" && raw !== "production") {
    throw new Error("organisation environment is invalid");
  }
  return raw;
}

function requireOrganisationLifecycleKind(
  raw: unknown,
): OrganisationLifecycleState {
  switch (raw) {
    case "configuring":
    case "active":
    case "activating":
    case "archived":
    case "purging":
    case "purged":
      return raw;
    default:
      throw new Error("organisation onboarding lifecycle is invalid");
  }
}

function requirePositiveInteger(raw: unknown, label: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new Error(`${label} is invalid`);
  }
  return raw;
}

function requireInteger(raw: unknown, label: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`${label} is invalid`);
  }
  return raw;
}

function requireString(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${label} is invalid`);
  }
  return raw;
}

function requireCapabilityProfile(raw: unknown): CapabilityProfile {
  if (!isCapabilityProfile(raw)) {
    throw new Error("invalid capability profile");
  }
  return raw;
}

function requirePersistedSetupSelection(
  row: SetupSelectionRow,
  capabilityProfile: CapabilityProfile,
): SetupSelection {
  if (
    row.policyTemplateId !== "commerce_operator" ||
    !isCuePresetId(row.cuePresetId)
  ) {
    throw new Error("persisted onboarding selection has an invalid template");
  }
  if (
    typeof row.workspaceId !== "string" ||
    typeof row.channelId !== "string"
  ) {
    throw new Error(
      "active onboarding selection is missing its cue destination",
    );
  }
  const workspaceId = parseWorkspaceId(row.workspaceId);
  const channelId = parseChannelId(row.channelId);
  if (!workspaceId.ok || !channelId.ok) {
    throw new Error(
      "active onboarding selection is missing a valid cue destination",
    );
  }
  return {
    policyTemplateId: row.policyTemplateId,
    capabilityProfile,
    cuePresetId: row.cuePresetId,
    cueTarget: {
      workspaceId: workspaceId.value,
      channelId: channelId.value,
    },
  };
}

function requireIntegrationAccountId(raw: unknown): IntegrationAccountId {
  if (typeof raw !== "string") {
    throw new Error("invalid integration account id");
  }
  const parsed = parseIntegrationAccountId(raw);
  if (!parsed.ok) {
    throw new Error("invalid integration account id");
  }
  return parsed.value;
}

function requireSetupSnapshotId(raw: unknown): SetupSnapshotId {
  if (typeof raw !== "string") {
    throw new Error("invalid setup snapshot id");
  }
  const parsed = parseSetupSnapshotId(raw);
  if (!parsed.ok) {
    throw new Error("invalid setup snapshot id");
  }
  return parsed.value;
}

function isCapabilityProfile(raw: unknown): raw is CapabilityProfile {
  return raw === "read_and_propose" || raw === "approved_provider_writes";
}

function isCuePresetId(raw: unknown): raw is CuePresetId {
  return (
    raw === "observe_commerce" ||
    raw === "commerce_operator" ||
    raw === "proactive_triage"
  );
}

function invalidSelection(): Result<
  never,
  { readonly code: "invalid_setup_selection" }
> {
  return { ok: false, error: { code: "invalid_setup_selection" } };
}

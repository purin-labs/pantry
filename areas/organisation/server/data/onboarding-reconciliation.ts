import { purgeArchivedOrganisation } from "@purin-labs/tenancy/data/organisation-purge";
import {
  prepareArchiveCleanupAwaitsPurge,
  prepareOrganisationLifecycleMove,
  ARCHIVE_CLEANUP_PLACEMENT_STATUSES,
  type LifecycleFence,
} from "@purin-labs/tenancy/data/organisation-lifecycle-moves";
import { releaseSlackInstallationCredentials } from "@purin-labs/authority/credential-vault/slack-installation-credential";
import type {
  GlobalDatabase,
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "@purin-labs/kernel/database-handles";
import type {
  OrganisationExecutionScope,
  OrganisationPlacementBindings,
} from "@purin-labs/tenancy/organisation-execution-scope";
import {
  newRequestId,
  parseProviderConnectionAttemptId,
  parseSessionId,
  parseOrganisationId,
  type SessionId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  listOrganisationActorRegistryEntries,
  parseActorRegistryId,
  type ActorRegistryEntry,
  type ActorRegistryId,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import {
  resolveActiveOrganisationActor,
} from "@purin-labs/actor-runtime/actors/actor-router";
import { actorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import type { AdmittedOrganisationArchiveCleanup } from "@purin-labs/actor-runtime/actors/organisation-archive-cleanup";
import { resolveActiveOrganisationPlacementRecord } from "@purin-labs/tenancy/data/organisation-placement";
import type { Env } from "@purin-labs/kernel/env";
import type { SessionActorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import { closeOrganisationCommerceMerchants } from "../../../../services/platform/src/commerce/contract/merchant-closure";
import { parseOrganisationPlacement } from "@purin-labs/tenancy/placement";
import type { Result } from "@purin-labs/kernel/result";
import { traceWarn } from "@purin-labs/kernel/observability";
import {
  hashOpaqueSecret,
  type OrganisationEnvironment,
} from "@purin-labs/tenancy/data/control-plane";
import {
  newControlMutationIdentity,
  prepareOnboardingEvent,
  type ControlMutationIdentity,
} from "@purin-labs/tenancy/data/control-mutation";
import {
  ensureCurrentReadiness,
  prepareReadinessAssessmentDeletion,
} from "./onboarding";
import { expireProviderAttemptIfDue } from "@purin-labs/connections/data/provider-attempt";
import { assertNever, isNonNegativeInteger } from "@purin-labs/std";
import {
  prepareInvalidAccountsDegradation,
  prepareMissingAccountDefaults,
} from "@purin-labs/connections/data/integration-account-writes";
import { prepareArchivedOrganisationConnectionsRevocation } from "@purin-labs/connections/data/provider-connection-writes";
import { prepareArchivedOrganisationGenerationsRevocation } from "@purin-labs/connections/data/provider-credential-generation";
import {
  prepareArchivedOrganisationCredentialRefsRevocation,
  prepareArchivedOrganisationSecretsRevocation,
} from "@purin-labs/authority/credential-vault/secret-revocation";
import {
  prepareProjectionRevisionBump,
  prepareRepairConfigurationBump,
} from "@purin-labs/tenancy/data/organisation-onboarding-row";

type OnboardingReconciliationSubject =
  | "open_attempts"
  | "credentials"
  | "accounts"
  | "webhooks"
  | "default_accounts"
  | "setup_snapshots"
  | "readiness"
  | "archived_organisation";

type OnboardingReconciliationSummary = {
  readonly organisationId: OrganisationId;
  readonly repairCount: number;
  readonly runs: readonly OnboardingReconciliationRun[];
};

type OnboardingReconciliationRun =
  | {
      readonly kind: "completed";
      /** Null for a run that repaired nothing: it leaves no record. */
      readonly reconciliationRunId: string | null;
      readonly subject: OnboardingReconciliationSubject;
      readonly repairCount: number;
    }
  | {
      readonly kind: "failed";
      readonly reconciliationRunId: string;
      readonly subject: OnboardingReconciliationSubject;
      readonly reasonCode: string;
    };

type OrganisationReconciliationRow = {
  readonly organisationId: unknown;
  readonly environment: unknown;
  readonly lifecycle: unknown;
  readonly configurationVersion: unknown;
  readonly projectionRevision: unknown;
};

type ExpiredAttemptRow = {
  readonly attemptId: unknown;
};

/** The scheduled pass that the lifecycle's `due` exits name. */
const ARCHIVED_ORGANISATION_PASS = { name: "archived_organisation" } as const;

const RECONCILIATION_SUBJECTS: readonly OnboardingReconciliationSubject[] = [
  "open_attempts",
  "credentials",
  "accounts",
  "webhooks",
  "default_accounts",
  "setup_snapshots",
  "readiness",
  ARCHIVED_ORGANISATION_PASS.name,
];

export async function listOnboardingReconciliationOrganisationIds(
  db: Pick<OrganisationDatabase, "prepare">,
): Promise<readonly OrganisationId[]> {
  const rows = await db
    .prepare(
      // A purged Organisation has nothing left to reconcile. An archived or
      // purging one stays: its cleanup and its purge run from this list.
      `SELECT onboarding.organisation_id AS organisationId
       FROM organisation_onboarding AS onboarding
       WHERE onboarding.lifecycle != 'purged' AND NOT EXISTS (
         SELECT 1 FROM organisation_archive_cleanup AS cleanup
         WHERE cleanup.organisation_id = onboarding.organisation_id
           AND cleanup.status = 'purged'
       )
       ORDER BY onboarding.organisation_id`,
    )
    .all<{ readonly organisationId: unknown }>();
  const organisationIds: OrganisationId[] = [];
  for (const row of rows.results ?? []) {
    if (typeof row.organisationId !== "string") {
      continue;
    }
    const parsed = parseOrganisationId(row.organisationId);
    if (parsed.ok) {
      organisationIds.push(parsed.value);
    }
  }
  return organisationIds;
}

export async function reconcileOrganisationOnboarding(input: {
  readonly env: OrganisationPlacementBindings;
  readonly db: OrganisationDatabase;
  readonly archive: R2Bucket;
  readonly sessionNamespace: Env["SESSION"];
  readonly connectorNamespace: Env["CONNECTOR"];
  readonly organisationNamespace: Env["ORGANISATION"];
  readonly organisationId: OrganisationId;
  readonly now: number;
}): Promise<
  Result<
    OnboardingReconciliationSummary,
    { readonly code: "organisation_not_found" }
  >
> {
  const initial = await readOrganisationReconciliationState(
    input.db,
    input.organisationId,
  );
  if (initial === null) {
    return { ok: false, error: { code: "organisation_not_found" } };
  }
  const portalSubjectHash = await hashOpaqueSecret(
    "pantry:onboarding-reconciler",
  );
  const runs: OnboardingReconciliationRun[] = [];
  let repairCount = 0;
  for (const subject of RECONCILIATION_SUBJECTS) {
    const run = await reconcileSubject({
      env: input.env,
      db: input.db,
      archive: input.archive,
      sessionNamespace: input.sessionNamespace,
      connectorNamespace: input.connectorNamespace,
      organisationNamespace: input.organisationNamespace,
      organisation: initial,
      subject,
      portalSubjectHash,
      now: input.now,
    });
    runs.push(run);
    if (run.kind === "completed") {
      repairCount += run.repairCount;
    }
  }
  return {
    ok: true,
    value: {
      organisationId: input.organisationId,
      repairCount,
      runs,
    },
  };
}

type OrganisationHarnessHistoryInventory = {
  readonly schemaVersion: "organisation_harness_history_inventory.v1";
  readonly organisationId: OrganisationId;
  readonly inspectedAt: number;
  readonly registryFingerprint: string;
  readonly sessions: readonly {
    readonly registryId: ActorRegistryId;
    readonly sessionId: string;
    readonly physicalObjectName: string;
    readonly placement: ActorRegistryEntry["placement"];
    readonly referenceKeys: readonly string[];
    readonly candidateKeys: readonly string[];
  }[];
  readonly candidateObjectKeys: readonly string[];
  readonly retainedObjectKeys: readonly string[];
};

type OrganisationHarnessHistoryInventoryError =
  | { readonly code: "organisation_harness_history_inspection_failed" }
  | { readonly code: "organisation_harness_history_registry_changed" };

/**
 * Builds the organisation-wide NF9 erasure inventory without mutating Actors, D1, or
 * R2. The archived-organisation reconciler consumes the same registry and reachability
 * rules when an approved erasure operation is actually executed.
 */
export async function inspectOrganisationHarnessHistory(input: {
  readonly db: OrganisationDatabase;
  // The global directory, which holds the relocation and restore journals.
  readonly directory: GlobalDatabase;
  readonly sessionNamespace: Env["SESSION"];
  readonly organisationId: OrganisationId;
  readonly inspectedAt: number;
}): Promise<
  Result<
    OrganisationHarnessHistoryInventory,
    OrganisationHarnessHistoryInventoryError
  >
> {
  try {
    const entries = await listOrganisationActorRegistryEntries({
      db: input.db,
      organisationId: input.organisationId,
    });
    if (!entries.ok) {
      return {
        ok: false,
        error: { code: "organisation_harness_history_inspection_failed" },
      };
    }
    const registryInventory =
      await buildOrganisationHarnessErasureRegistryInventory(entries.value);
    const sessions: OrganisationHarnessHistoryInventory["sessions"][number][] =
      [];
    const allReferences: string[] = [];
    for (const entry of registryInventory.entries.filter(
      isErasableSessionRegistryEntry,
    )) {
      const actor = actorStub(
        input.sessionNamespace,
        entry.physicalObjectName,
        entry.placement,
      );
      const referenceKeys = await inspectSessionHarnessReferences(
        actor,
        input.organisationId,
      );
      const candidateKeys = referenceKeys.filter(
        organisationScopedHarnessObjectKeyFilter.bind(
          null,
          input.organisationId,
        ),
      );
      allReferences.push(...referenceKeys);
      sessions.push({
        registryId: entry.registryId,
        sessionId: entry.identity.logicalObjectId,
        physicalObjectName: entry.physicalObjectName,
        placement: entry.placement,
        referenceKeys,
        candidateKeys,
      });
    }
    const latestEntries = await listOrganisationActorRegistryEntries({
      db: input.db,
      organisationId: input.organisationId,
    });
    if (!latestEntries.ok) {
      return {
        ok: false,
        error: { code: "organisation_harness_history_inspection_failed" },
      };
    }
    const latestInventory =
      await buildOrganisationHarnessErasureRegistryInventory(
        latestEntries.value,
      );
    if (
      latestInventory.snapshotJson !== registryInventory.snapshotJson ||
      latestInventory.fingerprint !== registryInventory.fingerprint
    ) {
      return {
        ok: false,
        error: { code: "organisation_harness_history_registry_changed" },
      };
    }
    const retained = await listRetainedHarnessObjectKeys(input.directory);
    const candidateObjectKeys = dedupeObjectKeys(allReferences).filter(
      (objectKey) =>
        isOrganisationScopedHarnessObjectKey(objectKey, input.organisationId) &&
        !retained.has(objectKey),
    );
    const retainedObjectKeys = dedupeObjectKeys(allReferences).filter(
      (objectKey) =>
        !isOrganisationScopedHarnessObjectKey(
          objectKey,
          input.organisationId,
        ) || retained.has(objectKey),
    );
    return {
      ok: true,
      value: {
        schemaVersion: "organisation_harness_history_inventory.v1",
        organisationId: input.organisationId,
        inspectedAt: input.inspectedAt,
        registryFingerprint: registryInventory.fingerprint,
        sessions,
        candidateObjectKeys,
        retainedObjectKeys,
      },
    };
  } catch {
    return {
      ok: false,
      error: { code: "organisation_harness_history_inspection_failed" },
    };
  }
}

type OrganisationHarnessErasureCounts = {
  readonly historyRows: number;
  readonly checkpointRows: number;
  readonly leaseRows: number;
  readonly deliveryRows: number;
};

type OrganisationHarnessErasureSessionReceipt = {
  readonly receiptId: string;
  readonly registryId: ActorRegistryId;
  readonly sessionId: string;
  readonly status: "pending" | "inventoried" | "erased" | "failed";
  readonly erasedAt: number | null;
  readonly erasureCounts: OrganisationHarnessErasureCounts | null;
  readonly candidateKeyCount: number;
  readonly failureCode: string | null;
};

type OrganisationHarnessErasureReceipts = {
  readonly schemaVersion: "organisation_harness_erasure_receipts.v1";
  readonly organisationId: OrganisationId;
  readonly status:
    | "not_started"
    | "retention_window_open"
    | "in_progress"
    | "failed"
    | "completed";
  readonly purgeAfter: number | null;
  readonly registryFingerprint: string | null;
  readonly completedAt: number | null;
  readonly failureCode: string | null;
  readonly sessionReceipts: readonly OrganisationHarnessErasureSessionReceipt[];
  readonly objectAccounting: {
    readonly candidateCount: number;
    readonly deletedCount: number;
    readonly retainedCount: number;
  };
};

type OrganisationHarnessErasureReceiptsError = {
  readonly code: "organisation_harness_erasure_state_invalid";
};

/**
 * Composes the durable operator receipt for an organisation-wide harness erasure.
 * The read is idempotent and remains answerable after the final purge because
 * the erasure ledger, per-session rows, object accounting, and archive
 * cleanup records are excluded from the purge batch.
 */
export async function readOrganisationHarnessErasureReceipts(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  now: number,
): Promise<
  Result<
    OrganisationHarnessErasureReceipts,
    OrganisationHarnessErasureReceiptsError
  >
> {
  try {
    const cleanup = await db
      .prepare(
        `SELECT status, purge_after AS purgeAfter
       FROM organisation_archive_cleanup WHERE organisation_id = ?`,
      )
      .bind(organisationId)
      .first<{ readonly status: unknown; readonly purgeAfter: unknown }>();
    const purgeAfter =
      typeof cleanup?.purgeAfter === "number" ? cleanup.purgeAfter : null;
    const ledger = await readOrganisationHarnessErasureLedger(
      db,
      organisationId,
    );
    const completedAtRow = await db
      .prepare(
        `SELECT completed_at AS completedAt, failure_code AS failureCode
       FROM organisation_harness_erasure WHERE organisation_id = ?`,
      )
      .bind(organisationId)
      .first<{
        readonly completedAt: unknown;
        readonly failureCode: unknown;
      }>();
    const sessionRows = await db
      .prepare(
        `SELECT registry_id AS registryId,
              logical_session_id AS logicalSessionId,
              status, erased_at AS erasedAt,
              erasure_counts_json AS erasureCountsJson,
              candidate_keys_json AS candidateKeysJson,
              failure_code AS failureCode
       FROM organisation_harness_erasure_session
       WHERE organisation_id = ? ORDER BY logical_session_id`,
      )
      .bind(organisationId)
      .all<{
        readonly registryId: unknown;
        readonly logicalSessionId: unknown;
        readonly status: unknown;
        readonly erasedAt: unknown;
        readonly erasureCountsJson: unknown;
        readonly candidateKeysJson: unknown;
        readonly failureCode: unknown;
      }>();
    const sessionReceipts: OrganisationHarnessErasureSessionReceipt[] = [];
    for (const row of sessionRows.results ?? []) {
      const registryId = parseActorRegistryId(row.registryId);
      if (
        !registryId.ok ||
        typeof row.logicalSessionId !== "string" ||
        !isHarnessErasureSessionStatus(row.status) ||
        typeof row.candidateKeysJson !== "string"
      ) {
        return {
          ok: false,
          error: { code: "organisation_harness_erasure_state_invalid" },
        };
      }
      const candidateKeys: unknown = JSON.parse(row.candidateKeysJson);
      if (!Array.isArray(candidateKeys)) {
        return {
          ok: false,
          error: { code: "organisation_harness_erasure_state_invalid" },
        };
      }
      sessionReceipts.push({
        receiptId: `harness_erasure_${registryId.value}`,
        registryId: registryId.value,
        sessionId: row.logicalSessionId,
        status: row.status,
        erasedAt: typeof row.erasedAt === "number" ? row.erasedAt : null,
        erasureCounts: parseOrganisationHarnessErasureCounts(
          row.erasureCountsJson,
        ),
        candidateKeyCount: candidateKeys.length,
        failureCode:
          typeof row.failureCode === "string" ? row.failureCode : null,
      });
    }
    const objectCounts = await db
      .prepare(
        `SELECT COUNT(*) AS candidateCount,
              SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) AS deletedCount,
              SUM(CASE WHEN status = 'retained' THEN 1 ELSE 0 END) AS retainedCount
       FROM organisation_harness_erasure_object WHERE organisation_id = ?`,
      )
      .bind(organisationId)
      .first<{
        readonly candidateCount: unknown;
        readonly deletedCount: unknown;
        readonly retainedCount: unknown;
      }>();
    return {
      ok: true,
      value: {
        schemaVersion: "organisation_harness_erasure_receipts.v1",
        organisationId,
        status: deriveOrganisationHarnessErasureReceiptStatus(
          ledger,
          purgeAfter,
          now,
        ),
        purgeAfter,
        registryFingerprint: ledger?.registryFingerprint ?? null,
        completedAt:
          typeof completedAtRow?.completedAt === "number"
            ? completedAtRow.completedAt
            : null,
        failureCode:
          typeof completedAtRow?.failureCode === "string"
            ? completedAtRow.failureCode
            : null,
        sessionReceipts,
        objectAccounting: {
          candidateCount: isNonNegativeInteger(objectCounts?.candidateCount)
            ? objectCounts.candidateCount
            : 0,
          deletedCount: isNonNegativeInteger(objectCounts?.deletedCount)
            ? objectCounts.deletedCount
            : 0,
          retainedCount: isNonNegativeInteger(objectCounts?.retainedCount)
            ? objectCounts.retainedCount
            : 0,
        },
      },
    };
  } catch {
    return {
      ok: false,
      error: { code: "organisation_harness_erasure_state_invalid" },
    };
  }
}

function deriveOrganisationHarnessErasureReceiptStatus(
  ledger: OrganisationHarnessErasureLedger | null,
  purgeAfter: number | null,
  now: number,
): OrganisationHarnessErasureReceipts["status"] {
  if (ledger !== null) {
    switch (ledger.status) {
      case "completed":
        return "completed";
      case "failed":
        return "failed";
      case "inventorying":
      case "erasing":
      case "deleting":
        return "in_progress";
      default:
        return assertNever(ledger.status);
    }
  }
  if (purgeAfter !== null && purgeAfter > now) {
    return "retention_window_open";
  }
  return "not_started";
}

function parseOrganisationHarnessErasureCounts(
  raw: unknown,
): OrganisationHarnessErasureCounts | null {
  if (typeof raw !== "string") {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const counts = parsed as Record<string, unknown>;
  if (
    !isNonNegativeInteger(counts.historyRows) ||
    !isNonNegativeInteger(counts.checkpointRows) ||
    !isNonNegativeInteger(counts.leaseRows) ||
    !isNonNegativeInteger(counts.deliveryRows)
  ) {
    return null;
  }
  return {
    historyRows: counts.historyRows,
    checkpointRows: counts.checkpointRows,
    leaseRows: counts.leaseRows,
    deliveryRows: counts.deliveryRows,
  };
}

async function reconcileSubject(input: {
  readonly env: OrganisationPlacementBindings;
  readonly db: OrganisationDatabase;
  readonly archive: R2Bucket;
  readonly sessionNamespace: Env["SESSION"];
  readonly connectorNamespace: Env["CONNECTOR"];
  readonly organisationNamespace: Env["ORGANISATION"];
  readonly organisation: RequiredOrganisationReconciliationState;
  readonly subject: OnboardingReconciliationSubject;
  readonly portalSubjectHash: string;
  readonly now: number;
}): Promise<OnboardingReconciliationRun> {
  // A run is recorded only when it repairs something or fails. Every
  // Organisation runs every subject each quarter of an hour, and a record of
  // each run that found nothing was 24 rows a pass that nothing read.
  let repairCount = 0;
  let failure: { readonly cause: unknown } | null = null;
  try {
    repairCount = await executeReconciliationSubject(
      input.env,
      input.db,
      input.archive,
      input.sessionNamespace,
      input.connectorNamespace,
      input.organisationNamespace,
      input.organisation,
      input.subject,
      input.now,
    );
  } catch (cause) {
    failure = { cause };
  }
  if (failure === null && repairCount === 0)
    return {
      kind: "completed",
      reconciliationRunId: null,
      subject: input.subject,
      repairCount,
    };
  const reconciliationRunId = `reconciliation_${crypto.randomUUID()}`;
  const identity = reconciliationEventIdentity(
    input.portalSubjectHash,
    reconciliationRunId,
    input.now,
  );
  await startReconciliationRun(
    input.db,
    input.organisation,
    input.subject,
    reconciliationRunId,
    identity,
    input.now,
  );
  if (failure === null) {
    try {
      const current = await requireOrganisationReconciliationState(
        input.db,
        input.organisation.organisationId,
      );
      await completeReconciliationRun(
        input.db,
        current,
        input.subject,
        reconciliationRunId,
        identity,
        repairCount,
        input.now,
      );
      return {
        kind: "completed",
        reconciliationRunId,
        subject: input.subject,
        repairCount,
      };
    } catch (cause) {
      failure = { cause };
    }
  }
  // The run row keeps one fixed reason. The cause goes to the trace, the
  // only place a failing subject can be diagnosed from.
  traceWarn("onboarding_reconciliation.subject_failed", {
    requestId: newRequestId(),
    organisation_id: input.organisation.organisationId,
    subject: input.subject,
    reconciliation_run_id: reconciliationRunId,
    detail:
      failure.cause instanceof Error
        ? failure.cause.message
        : String(failure.cause),
  });
  const current = await requireOrganisationReconciliationState(
    input.db,
    input.organisation.organisationId,
  );
  await failReconciliationRun(
    input.db,
    current,
    input.subject,
    reconciliationRunId,
    identity,
    "reconciliation_subject_failed",
    input.now,
  );
  return {
    kind: "failed",
    reconciliationRunId,
    subject: input.subject,
    reasonCode: "reconciliation_subject_failed",
  };
}

async function executeReconciliationSubject(
  env: OrganisationPlacementBindings,
  db: OrganisationDatabase,
  archive: R2Bucket,
  sessionNamespace: Env["SESSION"],
  connectorNamespace: Env["CONNECTOR"],
  organisationNamespace: Env["ORGANISATION"],
  organisation: RequiredOrganisationReconciliationState,
  subject: OnboardingReconciliationSubject,
  now: number,
): Promise<number> {
  switch (subject) {
    case "open_attempts":
      return expireOpenAttempts(db, organisation, now);
    case "credentials":
      return reconcileCredentialGenerations(db, organisation, now);
    case "accounts":
      return reconcileAccountConnections(db, organisation, now);
    case "webhooks":
      return reconcileWebhookHealth(db, organisation, now);
    case "default_accounts":
      return reconcileDefaultAccounts(db, organisation, now);
    case "setup_snapshots":
      return reconcileSetupSnapshots(db, organisation, now);
    case "readiness": {
      // The refresh holds the active placement, as every lifecycle move
      // does (Refactor 15, refactor 5).
      const placement = await resolveActiveOrganisationPlacementRecord(
        db.withSession("first-primary"),
        organisation.organisationId,
      );
      if (!placement.ok) return 0;
      await ensureCurrentReadiness({
        db,
        organisationId: organisation.organisationId,
        fence: {
          organisationId: organisation.organisationId,
          placement: placement.value.placement,
          fenceToken: placement.value.fenceToken,
        },
        now,
        runtimeAdmission: "unknown",
        commerceSystemReadiness: "unknown",
      });
      return 0;
    }
    case ARCHIVED_ORGANISATION_PASS.name: {
      if (
        organisation.lifecycle !== "archived" &&
        organisation.lifecycle !== "purging"
      )
        return 0;
      const placement = await resolveActiveOrganisationPlacementRecord(
        db.withSession("first-primary"),
        organisation.organisationId,
      );
      if (!placement.ok) throw new Error(placement.error.code);
      const actor = await resolveActiveOrganisationActor({
        env,
        namespace: organisationNamespace,
        organisationId: organisation.organisationId,
        now,
      });
      if (!actor.ok) throw new Error(actor.error.code);
      const cleanup = await actor.value.reconcileArchiveCleanup({
        organisationId: organisation.organisationId,
        placement: {
          placement: placement.value.placement,
          fenceToken: placement.value.fenceToken,
        },
        now,
      });
      if (!cleanup.ok)
        throw new Error(
          cleanup.error.code === "organisation_archive_cleanup_failed"
            ? `${cleanup.error.code}: ${cleanup.error.detail}`
            : cleanup.error.code,
        );
      return cleanup.value;
    }
    default:
      return assertNever(subject);
  }
}

async function expireOpenAttempts(
  db: OrganisationDatabase,
  organisation: RequiredOrganisationReconciliationState,
  now: number,
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT attempt_id AS attemptId
     FROM provider_connection_attempt
     WHERE organisation_id = ? AND expires_at <= ?
       AND lifecycle IN ('created', 'authorizing', 'callback_received', 'provisioning')`,
    )
    .bind(organisation.organisationId, now)
    .all<ExpiredAttemptRow>();
  const portalSubjectHash = await hashOpaqueSecret(
    "pantry:onboarding-reconciler",
  );
  let expiredCount = 0;
  for (const row of rows.results ?? []) {
    if (typeof row.attemptId !== "string") {
      throw new Error("expired attempt id is invalid");
    }
    const attemptId = parseProviderConnectionAttemptId(row.attemptId);
    if (!attemptId.ok) {
      throw new Error("expired attempt id is invalid");
    }
    const expired = await expireProviderAttemptIfDue({
      db,
      organisationId: organisation.organisationId,
      attemptId: attemptId.value,
      portalSubjectHash,
      now,
    });
    if (expired.ok && expired.value.kind === "expired") {
      expiredCount += 1;
    }
  }
  return expiredCount;
}

async function reconcileCredentialGenerations(
  db: OrganisationDatabase,
  organisation: RequiredOrganisationReconciliationState,
  now: number,
): Promise<number> {
  return degradeInvalidAccounts(
    db,
    organisation,
    `NOT EXISTS (
       SELECT 1 FROM provider_credential_generation AS generation
       WHERE generation.provider_connection_id = integration_account.provider_connection_id
         AND generation.lifecycle = 'active'
     )`,
    "credential_generation_missing",
    now,
  );
}

async function reconcileAccountConnections(
  db: OrganisationDatabase,
  organisation: RequiredOrganisationReconciliationState,
  now: number,
): Promise<number> {
  return degradeInvalidAccounts(
    db,
    organisation,
    `NOT EXISTS (
       SELECT 1 FROM provider_connection AS connection
       WHERE connection.provider_connection_id = integration_account.provider_connection_id
         AND connection.lifecycle = 'active'
         AND connection.environment = integration_account.environment
     )`,
    "provider_connection_unhealthy",
    now,
  );
}

async function reconcileWebhookHealth(
  db: OrganisationDatabase,
  organisation: RequiredOrganisationReconciliationState,
  now: number,
): Promise<number> {
  return degradeInvalidAccounts(
    db,
    organisation,
    `integration_account.is_default_for_provider = 1
     AND integration_account.provider IN ('shopify', 'stripe')
     AND NOT EXISTS (
       SELECT 1 FROM provider_webhook AS webhook
       WHERE webhook.integration_account_id = integration_account.integration_account_id
         AND webhook.lifecycle = 'live'
         AND webhook.environment = integration_account.environment
     )`,
    "provider_webhook_unhealthy",
    now,
  );
}

async function degradeInvalidAccounts(
  db: OrganisationDatabase,
  organisation: RequiredOrganisationReconciliationState,
  predicate: string,
  reasonCode: string,
  now: number,
): Promise<number> {
  const result = await prepareInvalidAccountsDegradation(db, {
    predicate,
    reasonCode,
    now,
    organisationId: organisation.organisationId,
  }).run();
  const changes = result.meta.changes ?? 0;
  if (changes > 0) {
    await bumpConfigurationForRepair(db, organisation.organisationId, now);
  }
  return changes;
}

async function reconcileDefaultAccounts(
  db: OrganisationDatabase,
  organisation: RequiredOrganisationReconciliationState,
  now: number,
): Promise<number> {
  const result = await prepareMissingAccountDefaults(db, {
    now,
    organisationId: organisation.organisationId,
  }).run();
  const changes = result.meta.changes ?? 0;
  if (changes > 0) {
    await bumpConfigurationForRepair(db, organisation.organisationId, now);
  }
  return changes;
}

async function reconcileSetupSnapshots(
  db: OrganisationDatabase,
  organisation: RequiredOrganisationReconciliationState,
  now: number,
): Promise<number> {
  const incomplete = await db
    .prepare(
      `SELECT 1 AS found
     FROM organisation_onboarding_selection AS selection
     WHERE selection.organisation_id = ?
       AND (
         NOT EXISTS (
           SELECT 1 FROM organisation_setup_snapshot
           WHERE organisation_id = selection.organisation_id AND snapshot_kind = 'policy'
         )
         OR NOT EXISTS (
           SELECT 1 FROM organisation_setup_snapshot
           WHERE organisation_id = selection.organisation_id AND snapshot_kind = 'cue'
         )
         OR NOT EXISTS (
           SELECT 1 FROM organisation_commerce_system
           WHERE organisation_id = selection.organisation_id
         )
         OR NOT EXISTS (
           SELECT 1 FROM organisation_communication_destination
           WHERE organisation_id = selection.organisation_id
         )
       )`,
    )
    .bind(organisation.organisationId)
    .first<{ readonly found: unknown }>();
  if (incomplete?.found !== 1) {
    return 0;
  }
  const result = await prepareReadinessAssessmentDeletion(
    db,
    organisation.organisationId,
  ).run();
  await prepareProjectionRevisionBump(db, organisation.organisationId, { updatedAt: now })
    .run();
  return Math.max(result.meta.changes ?? 0, 1);
}

/**
 * The steps of the other areas and the surfaces in the archive cleanup and
 * the purge of an Organisation: the voice Mac names, the Slack connections of
 * the directory, the devices and the WhatsApp Connectors. The Worker gives
 * them, so this module names none of those owners (Refactor 17).
 */
export type ArchiveCleanupParts = Readonly<{
  /** Removes the DNS names of the voice Macs. False when a name stays. */
  removeVoiceMacNames: (
    env: Env,
    db: OrganisationDatabase,
    organisationId: OrganisationId,
  ) => Promise<boolean>;
  revokeSlackConnections: (
    directory: GlobalDatabase,
    input: Readonly<{ organisationId: OrganisationId; now: number }>,
  ) => Promise<number>;
  listSlackCredentialHandles: (
    directory: GlobalDatabase,
    organisationId: OrganisationId,
  ) => Promise<readonly string[]>;
  prepareVoiceMacsRevocation: (
    db: Pick<OrganisationDatabase, "prepare">,
    input: Readonly<{
      now: number;
      organisationId: string;
      guard: Readonly<{ sql: string; bindings: readonly unknown[] }>;
    }>,
  ) => D1PreparedStatement;
  revokeDevicesStatements: (
    session: OrganisationDatabaseSession,
    organisationId: OrganisationId,
    now: number,
  ) => readonly D1PreparedStatement[];
  purgeDeviceFleets: (
    env: Env,
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    placement: OrganisationExecutionScope["placement"],
  ) => Promise<void>;
  purgeWhatsAppConnectors: (
    input: Readonly<{
      db: OrganisationDatabase;
      namespace: Env["CONNECTOR"];
      organisationId: OrganisationId;
      now: number;
    }>,
  ) => Promise<number>;
}>;

export async function reconcileAdmittedOrganisationArchiveCleanup(input: {
  readonly env: Env;
  readonly parts: ArchiveCleanupParts;
  readonly db: OrganisationDatabase;
  // The global directory, which holds the Slack connection records and the
  // relocation and restore journals.
  readonly directory: GlobalDatabase;
  readonly archive: R2Bucket;
  readonly sessionNamespace: Env["SESSION"];
  readonly connectorNamespace: Env["CONNECTOR"];
  readonly request: AdmittedOrganisationArchiveCleanup;
}): Promise<number> {
  const organisation = await requireOrganisationReconciliationState(
    input.db,
    input.request.organisationId,
  );
  const placement = await input.db
    .withSession("first-primary")
    .prepare(
      `SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ?
     AND placement_cell_id = ? AND fence_token = ?
     AND status IN (${ARCHIVE_CLEANUP_PLACEMENT_STATUSES.map(() => "?").join(", ")})`,
    )
    .bind(
      input.request.organisationId,
      input.request.placement.placement.placementEpoch,
      input.request.placement.placement.placementCellId,
      input.request.placement.fenceToken,
      ...ARCHIVE_CLEANUP_PLACEMENT_STATUSES,
    )
    .first();
  if (placement === null)
    throw new Error("organisation_archive_cleanup_conflict");
  // A cleanup that comes again after its purge committed, such as the retry of
  // an Actor that stopped before it removed its pending request, has no work.
  if (organisation.lifecycle === "purged") return 0;
  if (
    organisation.lifecycle !== "archived" &&
    organisation.lifecycle !== "purging"
  )
    throw new Error("organisation_archive_cleanup_conflict");
  return reconcileArchivedOrganisation(
    input.env,
    input.parts,
    input.db,
    input.directory,
    input.archive,
    input.sessionNamespace,
    input.connectorNamespace,
    organisation,
    input.request,
  );
}

async function reconcileArchivedOrganisation(
  env: Env,
  parts: ArchiveCleanupParts,
  db: OrganisationDatabase,
  directory: GlobalDatabase,
  archive: R2Bucket,
  sessionNamespace: Env["SESSION"],
  connectorNamespace: Env["CONNECTOR"],
  organisation: RequiredOrganisationReconciliationState,
  request: AdmittedOrganisationArchiveCleanup,
): Promise<number> {
  const now = request.now;
  if (
    organisation.lifecycle !== "archived" &&
    organisation.lifecycle !== "purging"
  ) {
    return 0;
  }
  // The moves of the cleanup accept the placement that admitted it, so a
  // relocation that drains the Actor ends the purge on the frozen placement.
  const fence: LifecycleFence = {
    organisationId: organisation.organisationId,
    placement: request.placement.placement,
    fenceToken: request.placement.fenceToken,
    placementStatuses: ARCHIVE_CLEANUP_PLACEMENT_STATUSES,
  };
  const cleanup = await db
    .prepare(
      `SELECT status, purge_after AS purgeAfter, archive_receipt_id AS archiveReceiptId
     FROM organisation_archive_cleanup WHERE organisation_id = ?`,
    )
    .bind(organisation.organisationId)
    .first<{
      readonly status: unknown;
      readonly purgeAfter: unknown;
      readonly archiveReceiptId: unknown;
    }>();
  if (
    cleanup === null ||
    typeof cleanup.status !== "string" ||
    typeof cleanup.purgeAfter !== "number" ||
    typeof cleanup.archiveReceiptId !== "string" ||
    cleanup.archiveReceiptId.length === 0
  ) {
    throw new Error("archived organisation cleanup state is missing");
  }
  if (cleanup.status === "pending_provider_cleanup") {
    const providerCleanup = await db
      .prepare(
        `SELECT COUNT(*) AS pending
       FROM provider_account_cleanup
       WHERE organisation_id = ?
         AND lifecycle IN (
           'pending_provider_cleanup', 'running_provider_cleanup', 'retry_scheduled'
         )`,
      )
      .bind(organisation.organisationId)
      .first<{ readonly pending: unknown }>();
    if (
      typeof providerCleanup?.pending === "number" &&
      providerCleanup.pending > 0
    ) {
      return 0;
    }
    // A failed removal here does not hold the revocations. The purge repeats it.
    await parts.removeVoiceMacNames(env, db, organisation.organisationId);
    // The directory records go first. A repeat after a failed regional batch
    // finds them revoked already.
    let repaired = await parts.revokeSlackConnections(directory, {
      organisationId: organisation.organisationId,
      now,
    });
    const sharedCredentials = JSON.stringify(
      await parts.listSlackCredentialHandles(
        directory,
        organisation.organisationId,
      ),
    );
    const session = db.withSession("first-primary");
    // Each revocation holds only while the Organisation is still archived: a
    // restore that commits first keeps what it restored (Refactor 15).
    const archived = `EXISTS (SELECT 1 FROM organisation_onboarding AS onboarding
      WHERE onboarding.organisation_id = ? AND onboarding.lifecycle = 'archived')`;
    const stillArchived = {
      sql: archived,
      bindings: [organisation.organisationId],
    };
    const results = await session.batch([
      prepareArchivedOrganisationGenerationsRevocation(session, {
        now,
        organisationId: organisation.organisationId,
        guard: stillArchived,
      }),
      prepareArchivedOrganisationConnectionsRevocation(session, {
        now,
        organisationId: organisation.organisationId,
        guard: stillArchived,
      }),
      prepareArchivedOrganisationSecretsRevocation(session, {
        now,
        organisationId: organisation.organisationId,
        sharedHandles: sharedCredentials,
        guard: stillArchived,
      }),
      prepareArchivedOrganisationCredentialRefsRevocation(session, {
        now,
        organisationId: organisation.organisationId,
        guard: stillArchived,
      }),
      parts.prepareVoiceMacsRevocation(session, {
        now,
        organisationId: organisation.organisationId,
        guard: stillArchived,
      }),
      ...parts.revokeDevicesStatements(
        session,
        organisation.organisationId,
        now,
      ),
      prepareArchiveCleanupAwaitsPurge(session, {
        now,
        organisationId: organisation.organisationId,
        guard: stillArchived,
      }),
    ]);
    for (const result of results) repaired += result.meta.changes;
    return repaired;
  }
  if (cleanup.status === "pending_purge" && cleanup.purgeAfter <= now) {
    // From here no restore is possible: the purge erases the Actors and
    // closes the merchant before its last batch.
    if (organisation.lifecycle === "archived") {
      const started = await prepareOrganisationLifecycleMove(
        db.withSession("first-primary"),
        {
          organisationId: organisation.organisationId,
          event: "start_purge",
          from: ["archived"],
          fence,
          guard: { sql: "purge_after <= ?", bindings: [now] },
          now,
        },
      ).run();
      if (started.meta.changes !== 1)
        throw new Error("organisation_purge_lifecycle_conflict");
    }
    // The purge deletes the only rows that name these records.
    if (!(await parts.removeVoiceMacNames(env, db, organisation.organisationId)))
      throw new Error("voice_mac_names_not_removed");
    const harnessErasure = await reconcileOrganisationHarnessErasure({
      db,
      directory,
      archive,
      sessionNamespace,
      organisationId: organisation.organisationId,
      placement: request.placement,
      archiveReceiptId: cleanup.archiveReceiptId,
      now,
    });
    if (harnessErasure.status !== "completed") {
      return harnessErasure.repairCount;
    }
    await deleteOrganisationAttachmentObjects(
      archive,
      organisation.organisationId,
    );
    // The WhatsApp Connectors hold the only copy of any still-encrypted
    // customer text and proposal bodies. They are purged before the D1 rows
    // that name them are deleted, so erasure cannot lose track of an actor it
    // still needs to empty.
    await parts.purgeDeviceFleets(
      env,
      db,
      organisation.organisationId,
      request.placement.placement,
    );
    const connectorsPurged = await parts.purgeWhatsAppConnectors({
      db,
      namespace: connectorNamespace,
      organisationId: organisation.organisationId,
      now,
    });
    // The Organisation's commerce credentials, webhooks and payment links
    // end with it (Refactor 15, refactor 11).
    const merchantsClosed = await closeOrganisationCommerceMerchants(
      env,
      db,
      organisation.organisationId,
    );
    // The Slack workspaces that this Organisation's Vault serves keep their
    // bot token in the Vault of an Organisation that still uses them.
    const slackCredentialsMoved = await releaseSlackInstallationCredentials({
      env,
      directory,
      db,
      organisationId: organisation.organisationId,
      now,
    });
    return (
      harnessErasure.repairCount +
      connectorsPurged +
      merchantsClosed +
      slackCredentialsMoved +
      (await purgeArchivedOrganisation({
        db,
        directory,
        organisationId: organisation.organisationId,
        fence,
        now,
      }))
    );
  }
  return 0;
}

type OrganisationHarnessErasureProgress = {
  readonly status: "completed";
  readonly repairCount: number;
};

type OrganisationHarnessErasureLedgerStatus =
  "inventorying" | "erasing" | "deleting" | "completed" | "failed";

type OrganisationHarnessErasureLedger = {
  readonly status: OrganisationHarnessErasureLedgerStatus;
  readonly sessionCount: number;
  readonly candidateCount: number;
  readonly deletedCount: number;
  readonly registrySnapshotJson: string | null;
  readonly registryFingerprint: string | null;
};

type OrganisationHarnessErasureSessionStatus =
  "pending" | "inventoried" | "erased" | "failed";

type OrganisationHarnessErasureSession = {
  readonly registryId: ActorRegistryId;
  readonly logicalSessionId: SessionId;
  readonly physicalObjectName: string;
  readonly lifecycleStatus: "active" | "retired";
  readonly placement: ActorRegistryEntry["placement"];
  readonly status: OrganisationHarnessErasureSessionStatus;
  readonly referenceKeys: readonly string[];
  readonly candidateKeys: readonly string[];
};

type OrganisationHarnessErasureLedgerRow = {
  readonly status: unknown;
  readonly sessionCount: unknown;
  readonly candidateCount: unknown;
  readonly deletedCount: unknown;
  readonly registrySnapshotJson: unknown;
  readonly registryFingerprint: unknown;
};

type OrganisationHarnessErasureRegistryInventory = {
  readonly entries: readonly ActorRegistryEntry[];
  readonly snapshotJson: string;
  readonly fingerprint: string;
};

type OrganisationHarnessErasureRegistrySnapshotEntry = {
  readonly registryId: string;
  readonly logicalSessionId: string;
  readonly physicalObjectName: string;
  readonly lifecycleStatus: ActorRegistryEntry["lifecycleStatus"];
  readonly schemaVersion: number;
  readonly stateVersion: number;
  readonly placement: ActorRegistryEntry["placement"];
};

type OrganisationHarnessErasurePlacementColumns = {
  readonly placementEpoch: number;
  readonly placementCellId: string;
  readonly placementKind: "affinity" | "residency";
  readonly locationHint: string;
  readonly residencyJurisdiction: "eu" | "fedramp" | null;
};

type OrganisationHarnessErasureSessionRow = {
  readonly registryId: unknown;
  readonly logicalSessionId: unknown;
  readonly physicalObjectName: unknown;
  readonly lifecycleStatus: unknown;
  readonly placementEpoch: unknown;
  readonly placementCellId: unknown;
  readonly placementKind: unknown;
  readonly locationHint: unknown;
  readonly residencyJurisdiction: unknown;
  readonly status: unknown;
  readonly referenceKeysJson: unknown;
  readonly candidateKeysJson: unknown;
};

type OrganisationHarnessErasureObjectRow = {
  readonly objectKey: unknown;
  readonly status: unknown;
};

type RetainedHarnessObjectRow = {
  readonly objectKey: unknown;
};

async function reconcileOrganisationHarnessErasure(input: {
  readonly db: OrganisationDatabase;
  readonly directory: GlobalDatabase;
  readonly archive: R2Bucket;
  readonly sessionNamespace: Env["SESSION"];
  readonly organisationId: OrganisationId;
  readonly placement: AdmittedOrganisationArchiveCleanup["placement"];
  readonly archiveReceiptId: string;
  readonly now: number;
}): Promise<OrganisationHarnessErasureProgress> {
  const entries = await listOrganisationActorRegistryEntries({
    db: input.db,
    organisationId: input.organisationId,
  });
  if (!entries.ok) {
    throw new Error(entries.error.code);
  }
  const registryInventory =
    await buildOrganisationHarnessErasureRegistryInventory(entries.value);
  const registrySessionEntries = registryInventory.entries;
  const sessionEntries = registrySessionEntries.filter(
    isErasableSessionRegistryEntry,
  );
  await ensureOrganisationHarnessErasureLedger(
    input.db,
    input.organisationId,
    sessionEntries,
    input.now,
  );
  const ledger = await readOrganisationHarnessErasureLedger(
    input.db,
    input.organisationId,
  );
  if (ledger === null) {
    throw new Error("organisation harness erasure ledger is missing");
  }
  if (
    ledger.status === "completed" &&
    ledger.sessionCount === sessionEntries.length &&
    ledger.registrySnapshotJson === registryInventory.snapshotJson &&
    ledger.registryFingerprint === registryInventory.fingerprint &&
    registrySessionEntries.every(isErasableSessionRegistryEntry)
  ) {
    return { status: "completed", repairCount: ledger.deletedCount };
  }

  try {
    await persistOrganisationHarnessErasureRegistryInventory(
      input.db,
      input.organisationId,
      registryInventory,
      input.now,
    );
    if (!registrySessionEntries.every(isErasableSessionRegistryEntry)) {
      throw new Error("organisation_harness_erasure_registry_not_erasable");
    }
    await setOrganisationHarnessErasureStatus(
      input.db,
      input.organisationId,
      "erasing",
      input.now,
    );
    const sessionRows = await readOrganisationHarnessErasureSessions(
      input.db,
      input.organisationId,
    );
    assertOrganisationHarnessErasureRegistryRowsMatch(
      sessionRows,
      sessionEntries,
    );
    const entriesByRegistryId = new Map<ActorRegistryId, ActorRegistryEntry>(
      sessionEntries.map((entry) => [entry.registryId, entry] as const),
    );
    for (const session of sessionRows) {
      if (session.status === "erased") {
        await insertOrganisationHarnessErasureObjects(
          input.db,
          input.organisationId,
          session.candidateKeys,
          input.now,
        );
        continue;
      }
      const entry = entriesByRegistryId.get(session.registryId);
      if (entry === undefined) {
        throw new Error("organisation_harness_erasure_registry_entry_missing");
      }
      const actor = actorStub(
        input.sessionNamespace,
        entry.physicalObjectName,
        entry.placement,
      );
      const quiescent = await actor.quiescePortalChatCleanup({
        expectedFenceToken: entry.fenceToken,
      });
      if (!quiescent.ok) throw new Error(quiescent.error.code);
      const references =
        session.status === "pending"
          ? await inspectSessionHarnessReferences(actor, input.organisationId)
          : session.referenceKeys;
      const candidateKeys = dedupeObjectKeys([
        ...references,
        ...session.candidateKeys,
      ]);
      await persistSessionHarnessInventory({
        db: input.db,
        organisationId: input.organisationId,
        registryId: session.registryId,
        referenceKeys: references,
        candidateKeys,
        now: input.now,
      });
      const erased = await actor.eraseHarnessHistory({
        requestingOrganisationId: input.organisationId,
        sessionId: session.logicalSessionId,
        expectedActorFenceToken: entry.fenceToken,
        placement: input.placement,
        archiveReceiptId: input.archiveReceiptId,
      });
      if (!erased.ok) {
        await markOrganisationHarnessErasureSessionFailed(
          input.db,
          input.organisationId,
          session.registryId,
          erased.error.code,
          input.now,
        );
        throw new Error(erased.error.code);
      }
      const finalizedCandidates = dedupeObjectKeys([
        ...candidateKeys,
        ...erased.value.objectKeys,
      ]);
      await persistSessionHarnessErasure({
        db: input.db,
        organisationId: input.organisationId,
        registryId: session.registryId,
        candidateKeys: finalizedCandidates,
        erasureCounts: {
          historyRows: erased.value.historyRows,
          checkpointRows: erased.value.checkpointRows,
          leaseRows: erased.value.leaseRows,
          deliveryRows: erased.value.deliveryRows,
        },
        now: input.now,
      });
    }

    await setOrganisationHarnessErasureStatus(
      input.db,
      input.organisationId,
      "deleting",
      input.now,
    );
    const latestEntries = await listOrganisationActorRegistryEntries({
      db: input.db,
      organisationId: input.organisationId,
    });
    if (!latestEntries.ok) {
      throw new Error(latestEntries.error.code);
    }
    const latestRegistryInventory =
      await buildOrganisationHarnessErasureRegistryInventory(
        latestEntries.value,
      );
    const latestSessionEntries = latestRegistryInventory.entries.filter(
      isErasableSessionRegistryEntry,
    );
    if (
      latestRegistryInventory.snapshotJson !== registryInventory.snapshotJson ||
      latestRegistryInventory.fingerprint !== registryInventory.fingerprint ||
      latestRegistryInventory.entries.some(
        (entry) => !isErasableSessionRegistryEntry(entry),
      )
    ) {
      throw new Error("organisation_harness_erasure_registry_not_stable");
    }
    const latestSessionRows = await readOrganisationHarnessErasureSessions(
      input.db,
      input.organisationId,
    );
    assertOrganisationHarnessErasureRegistryRowsMatch(
      latestSessionRows,
      latestSessionEntries,
    );
    const retained = await listRetainedHarnessObjectKeys(input.directory);
    const objects = await readOrganisationHarnessErasureObjects(
      input.db,
      input.organisationId,
    );
    for (const object of objects) {
      if (object.status === "deleted" || object.status === "retained") {
        continue;
      }
      if (
        !isOrganisationScopedHarnessObjectKey(
          object.objectKey,
          input.organisationId,
        ) ||
        retained.has(object.objectKey)
      ) {
        await markOrganisationHarnessErasureObjectRetained(
          input.db,
          input.organisationId,
          object.objectKey,
          input.now,
        );
        continue;
      }
      await input.archive.delete(object.objectKey);
      await markOrganisationHarnessErasureObjectDeleted(
        input.db,
        input.organisationId,
        object.objectKey,
        input.now,
      );
    }
    const totalDeletedCount = await completeOrganisationHarnessErasure(
      input.db,
      input.organisationId,
      sessionEntries.length,
      registryInventory.fingerprint,
      input.now,
    );
    return { status: "completed", repairCount: totalDeletedCount };
  } catch (error) {
    await markOrganisationHarnessErasureFailed(
      input.db,
      input.organisationId,
      errorCode(error),
      input.now,
    );
    throw error;
  }
}

async function ensureOrganisationHarnessErasureLedger(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  entries: readonly ActorRegistryEntry[],
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO organisation_harness_erasure (
       organisation_id, status, failure_code, session_count, candidate_count,
       deleted_count, started_at, updated_at, completed_at
     ) VALUES (?, 'inventorying', NULL, 0, 0, 0, ?, ?, NULL)`,
    )
    .bind(organisationId, now, now)
    .run();
  let added = 0;
  for (const entry of entries) {
    const placement = organisationHarnessErasurePlacementColumns(
      entry.placement,
    );
    const existing = await db
      .prepare(
        `SELECT logical_session_id AS logicalSessionId,
              physical_object_name AS physicalObjectName,
              lifecycle_status AS lifecycleStatus,
              placement_epoch AS placementEpoch,
              placement_cell_id AS placementCellId,
              placement_kind AS placementKind,
              location_hint AS locationHint,
              residency_jurisdiction AS residencyJurisdiction
       FROM organisation_harness_erasure_session
       WHERE organisation_id = ? AND registry_id = ?`,
      )
      .bind(organisationId, entry.registryId)
      .first<{
        readonly logicalSessionId: unknown;
        readonly physicalObjectName: unknown;
        readonly lifecycleStatus: unknown;
        readonly placementEpoch: unknown;
        readonly placementCellId: unknown;
        readonly placementKind: unknown;
        readonly locationHint: unknown;
        readonly residencyJurisdiction: unknown;
      }>();
    if (existing !== null) {
      if (
        existing.logicalSessionId !== entry.identity.logicalObjectId ||
        existing.physicalObjectName !== entry.physicalObjectName ||
        existing.lifecycleStatus !== entry.lifecycleStatus ||
        existing.placementEpoch !== placement.placementEpoch ||
        existing.placementCellId !== placement.placementCellId ||
        existing.placementKind !== placement.placementKind ||
        existing.locationHint !== placement.locationHint ||
        existing.residencyJurisdiction !== placement.residencyJurisdiction
      ) {
        throw new Error("organisation harness erasure registry entry changed");
      }
      continue;
    }
    await db
      .prepare(
        `INSERT INTO organisation_harness_erasure_session (
         organisation_id, registry_id, logical_session_id, physical_object_name,
         lifecycle_status, placement_epoch, placement_cell_id, placement_kind,
         location_hint, residency_jurisdiction,
         status, reference_keys_json, candidate_keys_json, failure_code, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '[]', '[]', NULL, ?)`,
      )
      .bind(
        organisationId,
        entry.registryId,
        entry.identity.logicalObjectId,
        entry.physicalObjectName,
        entry.lifecycleStatus,
        placement.placementEpoch,
        placement.placementCellId,
        placement.placementKind,
        placement.locationHint,
        placement.residencyJurisdiction,
        now,
      )
      .run();
    added += 1;
  }
  const current = await readOrganisationHarnessErasureLedger(
    db,
    organisationId,
  );
  if (current === null || added === 0) {
    return;
  }
  await db
    .prepare(
      `UPDATE organisation_harness_erasure
     SET status = CASE WHEN status IN ('completed', 'failed') THEN 'inventorying' ELSE status END,
         failure_code = CASE WHEN status IN ('completed', 'failed') THEN NULL ELSE failure_code END,
         session_count = ?, updated_at = ?, completed_at = NULL
     WHERE organisation_id = ?`,
    )
    .bind(current.sessionCount + added, now, organisationId)
    .run();
}

async function readOrganisationHarnessErasureLedger(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<OrganisationHarnessErasureLedger | null> {
  const row = await db
    .prepare(
      `SELECT status, session_count AS sessionCount,
            candidate_count AS candidateCount, deleted_count AS deletedCount,
            registry_snapshot_json AS registrySnapshotJson,
            registry_fingerprint AS registryFingerprint
     FROM organisation_harness_erasure WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<OrganisationHarnessErasureLedgerRow>();
  if (
    row === null ||
    !isHarnessErasureLedgerStatus(row.status) ||
    !isNonNegativeInteger(row.sessionCount) ||
    !isNonNegativeInteger(row.candidateCount) ||
    !isNonNegativeInteger(row.deletedCount)
  ) {
    return null;
  }
  return {
    status: row.status,
    sessionCount: row.sessionCount,
    candidateCount: row.candidateCount,
    deletedCount: row.deletedCount,
    registrySnapshotJson:
      typeof row.registrySnapshotJson === "string"
        ? row.registrySnapshotJson
        : null,
    registryFingerprint:
      typeof row.registryFingerprint === "string"
        ? row.registryFingerprint
        : null,
  };
}

async function buildOrganisationHarnessErasureRegistryInventory(
  entries: readonly ActorRegistryEntry[],
): Promise<OrganisationHarnessErasureRegistryInventory> {
  const sessionEntries = entries.filter(isSessionRegistryEntry);
  const snapshotEntries: OrganisationHarnessErasureRegistrySnapshotEntry[] =
    sessionEntries
      .map((entry) => ({
        registryId: entry.registryId,
        logicalSessionId: entry.identity.logicalObjectId,
        physicalObjectName: entry.physicalObjectName,
        lifecycleStatus: entry.lifecycleStatus,
        schemaVersion: entry.schemaVersion,
        stateVersion: entry.stateVersion,
        placement: entry.placement,
      }))
      .sort(compareRegistrySnapshotEntries);
  const snapshotJson = JSON.stringify(snapshotEntries);
  const fingerprint = await hashOpaqueSecret(
    `pantry:nf9:organisation-harness-erasure:${snapshotJson}`,
  );
  return {
    entries: sessionEntries,
    snapshotJson,
    fingerprint,
  };
}

function organisationHarnessErasurePlacementColumns(
  placement: ActorRegistryEntry["placement"],
): OrganisationHarnessErasurePlacementColumns {
  switch (placement.kind) {
    case "affinity":
      return {
        placementEpoch: placement.placementEpoch,
        placementCellId: placement.placementCellId,
        placementKind: placement.kind,
        locationHint: placement.locationHint,
        residencyJurisdiction: null,
      };
    case "residency":
      return {
        placementEpoch: placement.placementEpoch,
        placementCellId: placement.placementCellId,
        placementKind: placement.kind,
        locationHint: placement.locationHint,
        residencyJurisdiction: placement.residencyJurisdiction,
      };
    default:
      return assertNever(placement);
  }
}

function compareRegistrySnapshotEntries(
  left: OrganisationHarnessErasureRegistrySnapshotEntry,
  right: OrganisationHarnessErasureRegistrySnapshotEntry,
): number {
  return left.registryId.localeCompare(right.registryId);
}

async function persistOrganisationHarnessErasureRegistryInventory(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  inventory: OrganisationHarnessErasureRegistryInventory,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE organisation_harness_erasure
     SET registry_snapshot_json = ?, registry_fingerprint = ?, updated_at = ?
     WHERE organisation_id = ?`,
    )
    .bind(inventory.snapshotJson, inventory.fingerprint, now, organisationId)
    .run();
}

function assertOrganisationHarnessErasureRegistryRowsMatch(
  rows: readonly OrganisationHarnessErasureSession[],
  entries: readonly ActorRegistryEntry[],
): void {
  if (rows.length !== entries.length) {
    throw new Error("organisation_harness_erasure_registry_snapshot_mismatch");
  }
  const entriesByRegistryId = new Map<ActorRegistryId, ActorRegistryEntry>(
    entries.map((entry) => [entry.registryId, entry] as const),
  );
  for (const row of rows) {
    const entry = entriesByRegistryId.get(row.registryId);
    const placement =
      entry === undefined
        ? null
        : organisationHarnessErasurePlacementColumns(entry.placement);
    if (
      entry === undefined ||
      row.logicalSessionId !== entry.identity.logicalObjectId ||
      row.physicalObjectName !== entry.physicalObjectName ||
      row.lifecycleStatus !== entry.lifecycleStatus ||
      placement === null ||
      row.placement.placementEpoch !== placement.placementEpoch ||
      row.placement.placementCellId !== placement.placementCellId ||
      row.placement.kind !== placement.placementKind ||
      row.placement.locationHint !== placement.locationHint ||
      (row.placement.kind === "affinity"
        ? placement.residencyJurisdiction !== null
        : row.placement.residencyJurisdiction !==
          placement.residencyJurisdiction)
    ) {
      throw new Error(
        "organisation_harness_erasure_registry_snapshot_mismatch",
      );
    }
  }
}

async function readOrganisationHarnessErasureSessions(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<readonly OrganisationHarnessErasureSession[]> {
  const rows = await db
    .prepare(
      `SELECT registry_id AS registryId,
            logical_session_id AS logicalSessionId,
            physical_object_name AS physicalObjectName,
            lifecycle_status AS lifecycleStatus,
            placement_epoch AS placementEpoch,
            placement_cell_id AS placementCellId,
            placement_kind AS placementKind,
            location_hint AS locationHint,
            residency_jurisdiction AS residencyJurisdiction,
            status, reference_keys_json AS referenceKeysJson,
            candidate_keys_json AS candidateKeysJson
     FROM organisation_harness_erasure_session
     WHERE organisation_id = ? ORDER BY logical_session_id`,
    )
    .bind(organisationId)
    .all<OrganisationHarnessErasureSessionRow>();
  return (rows.results ?? []).map(parseOrganisationHarnessErasureSession);
}

async function inspectSessionHarnessReferences(
  actor: Pick<SessionActorStub, "inspectHarnessHistoryReferences">,
  organisationId: OrganisationId,
): Promise<readonly string[]> {
  const inspected = await actor.inspectHarnessHistoryReferences({
    requestingOrganisationId: organisationId,
  });
  if (!inspected.ok) {
    throw new Error(inspected.error.code);
  }
  return dedupeObjectKeys(inspected.value);
}

async function persistSessionHarnessInventory(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly registryId: string;
  readonly referenceKeys: readonly string[];
  readonly candidateKeys: readonly string[];
  readonly now: number;
}): Promise<void> {
  const session = input.db.withSession("first-primary");
  const statements: D1PreparedStatement[] = [
    session
      .prepare(
        `UPDATE organisation_harness_erasure_session
       SET status = 'inventoried', reference_keys_json = ?,
           candidate_keys_json = ?, failure_code = NULL, updated_at = ?
       WHERE organisation_id = ? AND registry_id = ? AND status != 'erased'`,
      )
      .bind(
        JSON.stringify(input.referenceKeys),
        JSON.stringify(input.candidateKeys),
        input.now,
        input.organisationId,
        input.registryId,
      ),
  ];
  for (const objectKey of input.candidateKeys) {
    const status = isOrganisationScopedHarnessObjectKey(
      objectKey,
      input.organisationId,
    )
      ? "candidate"
      : "retained";
    const retainedAt = status === "retained" ? input.now : null;
    statements.push(
      session
        .prepare(
          `INSERT OR IGNORE INTO organisation_harness_erasure_object (
           organisation_id, object_key, status, discovered_at, retained_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .bind(input.organisationId, objectKey, status, input.now, retainedAt),
    );
  }
  await session.batch(statements);
}

async function persistSessionHarnessErasure(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly registryId: string;
  readonly candidateKeys: readonly string[];
  readonly erasureCounts: OrganisationHarnessErasureCounts;
  readonly now: number;
}): Promise<void> {
  const session = input.db.withSession("first-primary");
  const statements: D1PreparedStatement[] = [
    session
      .prepare(
        `UPDATE organisation_harness_erasure_session
       SET status = 'erased', candidate_keys_json = ?,
           erasure_counts_json = ?, erased_at = ?,
           failure_code = NULL, updated_at = ?
       WHERE organisation_id = ? AND registry_id = ?`,
      )
      .bind(
        JSON.stringify(input.candidateKeys),
        JSON.stringify(input.erasureCounts),
        input.now,
        input.now,
        input.organisationId,
        input.registryId,
      ),
  ];
  for (const objectKey of input.candidateKeys) {
    const status = isOrganisationScopedHarnessObjectKey(
      objectKey,
      input.organisationId,
    )
      ? "candidate"
      : "retained";
    const retainedAt = status === "retained" ? input.now : null;
    statements.push(
      session
        .prepare(
          `INSERT OR IGNORE INTO organisation_harness_erasure_object (
           organisation_id, object_key, status, discovered_at, retained_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .bind(input.organisationId, objectKey, status, input.now, retainedAt),
    );
  }
  await session.batch(statements);
}

async function insertOrganisationHarnessErasureObjects(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  objectKeys: readonly string[],
  now: number,
): Promise<void> {
  for (const objectKey of objectKeys) {
    const status = isOrganisationScopedHarnessObjectKey(
      objectKey,
      organisationId,
    )
      ? "candidate"
      : "retained";
    const retainedAt = status === "retained" ? now : null;
    await db
      .prepare(
        `INSERT OR IGNORE INTO organisation_harness_erasure_object (
         organisation_id, object_key, status, discovered_at, retained_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .bind(organisationId, objectKey, status, now, retainedAt)
      .run();
  }
}

async function readOrganisationHarnessErasureObjects(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<
  readonly {
    readonly objectKey: string;
    readonly status: "candidate" | "retained" | "deleted";
  }[]
> {
  const rows = await db
    .prepare(
      `SELECT object_key AS objectKey, status
     FROM organisation_harness_erasure_object WHERE organisation_id = ? ORDER BY object_key`,
    )
    .bind(organisationId)
    .all<OrganisationHarnessErasureObjectRow>();
  return (rows.results ?? []).map((row) => {
    if (
      typeof row.objectKey !== "string" ||
      !isHarnessErasureObjectStatus(row.status)
    ) {
      throw new Error("organisation harness erasure object row is invalid");
    }
    return { objectKey: row.objectKey, status: row.status };
  });
}

// Exports a relocation or restore journal still names. The journals are in the
// global directory, and an Organisation's erasure ledger is regional.
async function listRetainedHarnessObjectKeys(
  directory: GlobalDatabase,
): Promise<ReadonlySet<string>> {
  const rows = await directory
    .prepare(
      `SELECT export_key AS objectKey
     FROM state_object_relocation_item
     WHERE export_key IS NOT NULL
     UNION
     SELECT export_key AS objectKey
     FROM state_object_restore_item
     WHERE export_key IS NOT NULL`,
    )
    .all<RetainedHarnessObjectRow>();
  const keys = new Set<string>();
  for (const row of rows.results ?? []) {
    if (typeof row.objectKey === "string" && row.objectKey.length > 0) {
      keys.add(row.objectKey);
    }
  }
  return keys;
}

async function markOrganisationHarnessErasureObjectRetained(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  objectKey: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE organisation_harness_erasure_object
     SET status = 'retained', retained_at = ?, deleted_at = NULL
     WHERE organisation_id = ? AND object_key = ? AND status = 'candidate'`,
    )
    .bind(now, organisationId, objectKey)
    .run();
}

async function markOrganisationHarnessErasureObjectDeleted(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  objectKey: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE organisation_harness_erasure_object
     SET status = 'deleted', deleted_at = ?, retained_at = NULL
     WHERE organisation_id = ? AND object_key = ? AND status = 'candidate'`,
    )
    .bind(now, organisationId, objectKey)
    .run();
}

async function setOrganisationHarnessErasureStatus(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  status: Exclude<
    OrganisationHarnessErasureLedgerStatus,
    "completed" | "failed"
  >,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE organisation_harness_erasure
     SET status = ?, failure_code = NULL, updated_at = ?, completed_at = NULL
     WHERE organisation_id = ?`,
    )
    .bind(status, now, organisationId)
    .run();
}

async function completeOrganisationHarnessErasure(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  sessionCount: number,
  registryFingerprint: string,
  now: number,
): Promise<number> {
  const counts = await db
    .prepare(
      `SELECT COUNT(*) AS candidateCount,
            SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) AS deletedCount
     FROM organisation_harness_erasure_object WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      readonly candidateCount: unknown;
      readonly deletedCount: unknown;
    }>();
  const candidateCount =
    typeof counts?.candidateCount === "number" ? counts.candidateCount : 0;
  const totalDeletedCount =
    typeof counts?.deletedCount === "number" ? counts.deletedCount : 0;
  const result = await db
    .prepare(
      `UPDATE organisation_harness_erasure
     SET status = 'completed', failure_code = NULL, session_count = ?,
         candidate_count = ?, deleted_count = ?, updated_at = ?, completed_at = ?
     WHERE organisation_id = ? AND status = 'deleting' AND registry_fingerprint = ?
       AND NOT EXISTS (
         SELECT 1
         FROM durable_object_registry AS registry
         LEFT JOIN organisation_placement AS placement
           ON placement.organisation_id = registry.organisation_id
          AND placement.placement_epoch = registry.placement_epoch
         WHERE registry.organisation_id = ? AND registry.object_kind = 'session'
           AND NOT EXISTS (
             SELECT 1
             FROM organisation_harness_erasure_session AS snapshot
             WHERE snapshot.organisation_id = ?
               AND snapshot.registry_id = registry.registry_id
               AND snapshot.logical_session_id = registry.logical_object_id
               AND snapshot.lifecycle_status = registry.lifecycle_status
               AND snapshot.physical_object_name = registry.physical_object_name
               AND snapshot.placement_epoch = registry.placement_epoch
               AND snapshot.placement_cell_id = registry.placement_cell_id
               AND snapshot.placement_kind = placement.placement_kind
               AND snapshot.location_hint = placement.location_hint
               AND snapshot.residency_jurisdiction IS placement.residency_jurisdiction
           )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM organisation_harness_erasure_session AS snapshot
         WHERE snapshot.organisation_id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM durable_object_registry AS registry
             WHERE registry.organisation_id = ?
               AND registry.object_kind = 'session'
               AND registry.registry_id = snapshot.registry_id
           )
       )`,
    )
    .bind(
      sessionCount,
      candidateCount,
      totalDeletedCount,
      now,
      now,
      organisationId,
      registryFingerprint,
      organisationId,
      organisationId,
      organisationId,
      organisationId,
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new Error("organisation_harness_erasure_registry_changed");
  }
  return totalDeletedCount;
}

async function markOrganisationHarnessErasureFailed(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  failureCode: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE organisation_harness_erasure
     SET status = 'failed', failure_code = ?, updated_at = ?, completed_at = NULL
     WHERE organisation_id = ?`,
    )
    .bind(failureCode, now, organisationId)
    .run();
}

async function markOrganisationHarnessErasureSessionFailed(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  registryId: string,
  failureCode: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE organisation_harness_erasure_session
     SET status = 'failed', failure_code = ?, updated_at = ?
     WHERE organisation_id = ? AND registry_id = ?`,
    )
    .bind(failureCode, now, organisationId, registryId)
    .run();
}

function parseOrganisationHarnessErasureSession(
  row: OrganisationHarnessErasureSessionRow,
): OrganisationHarnessErasureSession {
  const registryId = parseActorRegistryId(row.registryId);
  if (
    !registryId.ok ||
    typeof row.logicalSessionId !== "string" ||
    typeof row.physicalObjectName !== "string" ||
    (row.lifecycleStatus !== "active" && row.lifecycleStatus !== "retired") ||
    !isHarnessErasureSessionStatus(row.status) ||
    typeof row.referenceKeysJson !== "string" ||
    typeof row.candidateKeysJson !== "string"
  ) {
    throw new Error("organisation harness erasure session row is invalid");
  }
  const sessionId = parseSessionId(row.logicalSessionId);
  if (!sessionId.ok)
    throw new Error("organisation harness erasure session row is invalid");
  const placement = parseOrganisationHarnessErasurePlacement(row);
  return {
    registryId: registryId.value,
    logicalSessionId: sessionId.value,
    physicalObjectName: row.physicalObjectName,
    lifecycleStatus: row.lifecycleStatus,
    placement,
    status: row.status,
    referenceKeys: parseObjectKeysJson(row.referenceKeysJson),
    candidateKeys: parseObjectKeysJson(row.candidateKeysJson),
  };
}

function parseOrganisationHarnessErasurePlacement(
  row: OrganisationHarnessErasureSessionRow,
): ActorRegistryEntry["placement"] {
  const raw =
    row.placementKind === "affinity"
      ? {
          kind: row.placementKind,
          placementEpoch: row.placementEpoch,
          placementCellId: row.placementCellId,
          locationHint: row.locationHint,
        }
      : row.placementKind === "residency"
        ? {
            kind: row.placementKind,
            placementEpoch: row.placementEpoch,
            placementCellId: row.placementCellId,
            locationHint: row.locationHint,
            residencyJurisdiction: row.residencyJurisdiction,
          }
        : null;
  if (raw === null) {
    throw new Error("organisation harness erasure placement is invalid");
  }
  const placement = parseOrganisationPlacement(raw);
  if (!placement.ok) {
    throw new Error("organisation harness erasure placement is invalid");
  }
  return placement.value;
}

function parseObjectKeysJson(raw: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("organisation harness erasure object keys are invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((key) => typeof key !== "string" || key.length === 0)
  ) {
    throw new Error("organisation harness erasure object keys are invalid");
  }
  return dedupeObjectKeys(parsed);
}

function dedupeObjectKeys(keys: readonly string[]): readonly string[] {
  return [...new Set(keys)];
}

function isSessionRegistryEntry(entry: ActorRegistryEntry): boolean {
  return entry.identity.objectKind === "session";
}

function isErasableSessionRegistryEntry(entry: ActorRegistryEntry): boolean {
  return (
    isSessionRegistryEntry(entry) &&
    (entry.lifecycleStatus === "active" || entry.lifecycleStatus === "retired")
  );
}

function isOrganisationScopedHarnessObjectKey(
  objectKey: string,
  organisationId: OrganisationId,
): boolean {
  if (!isWellFormedObjectKey(objectKey)) {
    return false;
  }
  const attachmentPrefix = `attachments/${organisationId}/`;
  const checkpointPrefix = `harness-checkpoints/${encodeURIComponent(organisationId)}/`;
  return (
    (objectKey.startsWith(attachmentPrefix) &&
      objectKey.length > attachmentPrefix.length) ||
    (objectKey.startsWith(checkpointPrefix) &&
      objectKey.length > checkpointPrefix.length)
  );
}

function organisationScopedHarnessObjectKeyFilter(
  organisationId: OrganisationId,
  objectKey: string,
): boolean {
  return isOrganisationScopedHarnessObjectKey(objectKey, organisationId);
}

function isWellFormedObjectKey(objectKey: string): boolean {
  return (
    objectKey.length > 0 &&
    !objectKey.startsWith("/") &&
    !objectKey.includes("\u0000") &&
    objectKey
      .split("/")
      .every(
        (segment) => segment.length > 0 && segment !== "." && segment !== "..",
      )
  );
}

function isHarnessErasureLedgerStatus(
  value: unknown,
): value is OrganisationHarnessErasureLedgerStatus {
  return (
    value === "inventorying" ||
    value === "erasing" ||
    value === "deleting" ||
    value === "completed" ||
    value === "failed"
  );
}

function isHarnessErasureSessionStatus(
  value: unknown,
): value is OrganisationHarnessErasureSessionStatus {
  return (
    value === "pending" ||
    value === "inventoried" ||
    value === "erased" ||
    value === "failed"
  );
}

function isHarnessErasureObjectStatus(
  value: unknown,
): value is "candidate" | "retained" | "deleted" {
  return value === "candidate" || value === "retained" || value === "deleted";
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "organisation_harness_erasure_failed";
}

async function deleteOrganisationAttachmentObjects(
  archive: R2Bucket,
  organisationId: OrganisationId,
): Promise<void> {
  const prefix = `attachments/${organisationId}/`;
  let cursor: string | undefined;

  while (true) {
    const page = await archive.list({ prefix, cursor, limit: 1_000 });
    const keys = page.objects.map(attachmentObjectKey);

    if (keys.length > 0) {
      await archive.delete(keys);
    }

    if (!page.truncated) {
      return;
    }

    if (page.cursor === undefined || page.cursor === cursor) {
      throw new Error("attachment purge cursor did not advance");
    }

    cursor = page.cursor;
  }
}

function attachmentObjectKey(object: R2Object): string {
  return object.key;
}

async function bumpConfigurationForRepair(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  now: number,
): Promise<void> {
  await prepareRepairConfigurationBump(db, organisationId, now).run();
}

async function startReconciliationRun(
  db: OrganisationDatabase,
  organisation: RequiredOrganisationReconciliationState,
  subject: OnboardingReconciliationSubject,
  reconciliationRunId: string,
  identity: ControlMutationIdentity,
  now: number,
): Promise<void> {
  const session = db.withSession("first-primary");
  await session.batch([
    session
      .prepare(
        `INSERT INTO onboarding_reconciliation_run (
         reconciliation_run_id, organisation_id, environment, subject_kind,
         lifecycle, repair_count, reason_code, started_at, completed_at
       ) VALUES (?, ?, ?, ?, 'running', 0, NULL, ?, NULL)`,
      )
      .bind(
        reconciliationRunId,
        organisation.organisationId,
        organisation.environment,
        subject,
        now,
      ),
    prepareOnboardingEvent(session, identity, {
      eventId: `${identity.auditEventId}:started`,
      eventType: "provider_reconciliation_started",
      organisationId: organisation.organisationId,
      environment: organisation.environment,
      projectionRevision: organisation.projectionRevision,
      attributes: {
        reconciliation_run_id: reconciliationRunId,
        subject_kind: subject,
      },
    }),
  ]);
}

async function completeReconciliationRun(
  db: OrganisationDatabase,
  organisation: RequiredOrganisationReconciliationState,
  subject: OnboardingReconciliationSubject,
  reconciliationRunId: string,
  identity: ControlMutationIdentity,
  repairCount: number,
  now: number,
): Promise<void> {
  const session = db.withSession("first-primary");
  await session.batch([
    session
      .prepare(
        `UPDATE onboarding_reconciliation_run
       SET lifecycle = 'completed', repair_count = ?, completed_at = ?
       WHERE reconciliation_run_id = ? AND lifecycle = 'running'`,
      )
      .bind(repairCount, now, reconciliationRunId),
    prepareOnboardingEvent(session, identity, {
      eventId: `${identity.auditEventId}:completed`,
      eventType: "provider_reconciliation_completed",
      organisationId: organisation.organisationId,
      environment: organisation.environment,
      projectionRevision: organisation.projectionRevision,
      attributes: {
        reconciliation_run_id: reconciliationRunId,
        subject_kind: subject,
        repair_count: repairCount,
      },
    }),
  ]);
}

async function failReconciliationRun(
  db: OrganisationDatabase,
  organisation: RequiredOrganisationReconciliationState,
  subject: OnboardingReconciliationSubject,
  reconciliationRunId: string,
  identity: ControlMutationIdentity,
  reasonCode: string,
  now: number,
): Promise<void> {
  const session = db.withSession("first-primary");
  await session.batch([
    session
      .prepare(
        `UPDATE onboarding_reconciliation_run
       SET lifecycle = 'failed', reason_code = ?, completed_at = ?
       WHERE reconciliation_run_id = ? AND lifecycle = 'running'`,
      )
      .bind(reasonCode, now, reconciliationRunId),
    prepareOnboardingEvent(session, identity, {
      eventId: `${identity.auditEventId}:failed`,
      eventType: "provider_reconciliation_failed",
      organisationId: organisation.organisationId,
      environment: organisation.environment,
      projectionRevision: organisation.projectionRevision,
      attributes: {
        reconciliation_run_id: reconciliationRunId,
        subject_kind: subject,
        reason_code: reasonCode,
      },
    }),
  ]);
}

type RequiredOrganisationReconciliationState = {
  readonly organisationId: OrganisationId;
  readonly environment: OrganisationEnvironment;
  readonly lifecycle: string;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
};

async function requireOrganisationReconciliationState(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<RequiredOrganisationReconciliationState> {
  const organisation = await readOrganisationReconciliationState(
    db,
    organisationId,
  );
  if (organisation === null) {
    throw new Error("reconciliation organisation disappeared");
  }
  return organisation;
}

async function readOrganisationReconciliationState(
  db: Pick<OrganisationDatabase, "prepare">,
  organisationId: OrganisationId,
): Promise<RequiredOrganisationReconciliationState | null> {
  const row = await db
    .prepare(
      `SELECT organisation_id AS organisationId, environment, lifecycle,
            configuration_version AS configurationVersion,
            projection_revision AS projectionRevision
     FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<OrganisationReconciliationRow>();
  if (
    row === null ||
    typeof row.organisationId !== "string" ||
    typeof row.lifecycle !== "string" ||
    typeof row.configurationVersion !== "number" ||
    typeof row.projectionRevision !== "number" ||
    (row.environment !== "development" && row.environment !== "production")
  ) {
    return null;
  }
  const parsed = parseOrganisationId(row.organisationId);
  return parsed.ok
    ? {
        organisationId: parsed.value,
        environment: row.environment,
        lifecycle: row.lifecycle,
        configurationVersion: row.configurationVersion,
        projectionRevision: row.projectionRevision,
      }
    : null;
}

function reconciliationEventIdentity(
  portalSubjectHash: string,
  reconciliationRunId: string,
  now: number,
): ControlMutationIdentity {
  return newControlMutationIdentity({
    portalSubjectHash,
    causationId: reconciliationRunId,
    now,
  });
}

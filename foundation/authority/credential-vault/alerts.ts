import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { newRequestId, type OrganisationId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { Env } from "@purin-labs/kernel/env";
import { configuredOrganisationDatabases } from "@purin-labs/tenancy/organisation-execution-scope";
import { integrationCredentialReads } from "./integration-reads";
import { loadCredentialVaultKeyRing, type VaultKeyVersion } from "./keyring";

// Plan 12 V3: the provisional benign-policy staleness budget, adopted as
// the explicit delivery-path constants. Restrictions target 3 seconds p95
// from revocation commit to policy activation; anything beyond 5 seconds
// is an operational alert.
const RESTRICTION_LATENCY_TARGET_MS = 3_000;
const RESTRICTION_LATENCY_ALERT_MS = 5_000;

const STUCK_ROTATION_ALERT_MS = 15 * 60 * 1_000;
const STALE_GENERATION_ALERT_MS = 60 * 60 * 1_000;
const DENIAL_WINDOW_MS = 24 * 60 * 60 * 1_000;
/**
 * A failed rotation stays as a record, so the sweep reports only the ones
 * that started within this window: each alert is recent, and an old failure
 * does not alert at every run.
 */
const FAILED_ROTATION_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type CredentialAccessPurpose =
  | "harness"
  | "provider_action"
  | "webhook"
  | "provider_connection"
  | "surface_installation"
  | "account_removal"
  | "model"
  | "control";

export async function recordCredentialAccessDenial(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId | string;
  readonly purpose: CredentialAccessPurpose;
  readonly reasonCode: string;
  readonly handle?: string;
  readonly now: number;
}): Promise<void> {
  try {
    await input.db
      .prepare(
        `INSERT INTO credential_access_denial (
           denial_id, organisation_id, purpose, reason_code, vault_handle, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `denial_${crypto.randomUUID()}`,
        input.organisationId,
        input.purpose,
        input.reasonCode,
        input.handle ?? null,
        input.now,
      )
      .run();
  } catch {
    // A failed receipt write must never change the denial outcome.
  }
  traceWarn("vault.resolution_denied", {
    requestId: newRequestId(),
    organisation_id: input.organisationId,
    purpose: input.purpose,
    reason_code: input.reasonCode,
  });
}

type VaultAlertSweep = {
  readonly sweptAt: number;
  readonly unknownKeyVersionRows: number;
  readonly staleSupersededGenerations: number;
  readonly stuckRotations: number;
  readonly failedRotations: number;
  readonly delayedRestrictions: number;
  readonly latencyBreaches: number;
  readonly denialsByPurpose: Readonly<Record<string, number>>;
};

/**
 * The Vault alert sweep of the 15-minute onboarding run, over the regional
 * database of each cell. It writes nothing.
 */
export async function sweepVaultAlerts(env: Env, now: number): Promise<void> {
  const keyring = await loadCredentialVaultKeyRing(env);
  const readableKeyVersions = keyring.ok
    ? new Set(keyring.value.readable.map((binding) => binding.version))
    : new Set<VaultKeyVersion>();
  for (const database of configuredOrganisationDatabases(env)) {
    await sweepVaultAlertSignals({
      db: database,
      readableKeyVersions,
      now,
    });
  }
}

async function sweepVaultAlertSignals(input: {
  readonly db: OrganisationDatabase;
  readonly readableKeyVersions: ReadonlySet<VaultKeyVersion>;
  readonly now: number;
}): Promise<VaultAlertSweep> {
  const versions = [...input.readableKeyVersions];
  const placeholders = versions.map(() => "?").join(", ");
  const unknownKeyRows = await input.db
    .prepare(
      `SELECT COUNT(*) AS unknownCount FROM vault_secret
       WHERE revoked_at IS NULL
         AND key_version NOT IN (${placeholders.length > 0 ? placeholders : "''"})`,
    )
    .bind(...versions)
    .first<{ readonly unknownCount: number }>();
  const staleGenerations = await input.db
    .prepare(
      `SELECT COUNT(*) AS staleCount FROM provider_credential_generation
       WHERE lifecycle = 'superseded' AND superseded_at IS NOT NULL
         AND superseded_at < ?`,
    )
    .bind(input.now - STALE_GENERATION_ALERT_MS)
    .first<{ readonly staleCount: number }>();
  const rotations = integrationCredentialReads.use();
  const stuckRotations = await rotations.countStuckCredentialRotations(
    input.db,
    input.now - STUCK_ROTATION_ALERT_MS,
  );
  const failedRotations = await rotations.countFailedCredentialRotations(
    input.db,
    input.now - FAILED_ROTATION_WINDOW_MS,
  );
  const delayedRestrictions = await input.db
    .prepare(
      `SELECT COUNT(*) AS delayedCount FROM credential_revocation_operation
       WHERE state = 'committed' AND committed_at < ?`,
    )
    .bind(input.now - RESTRICTION_LATENCY_ALERT_MS)
    .first<{ readonly delayedCount: number }>();
  const latencyBreaches = await input.db
    .prepare(
      `SELECT COUNT(*) AS breachCount FROM credential_revocation_operation
       WHERE state = 'policy_activated' AND restriction_latency_ms > ?`,
    )
    .bind(RESTRICTION_LATENCY_ALERT_MS)
    .first<{ readonly breachCount: number }>();
  const denials = await input.db
    .prepare(
      `SELECT purpose, COUNT(*) AS denialCount FROM credential_access_denial
       WHERE occurred_at >= ? GROUP BY purpose`,
    )
    .bind(input.now - DENIAL_WINDOW_MS)
    .all<{ readonly purpose: string; readonly denialCount: number }>();

  const denialsByPurpose: Record<string, number> = {};
  for (const row of denials.results ?? []) {
    if (
      typeof row.purpose === "string" &&
      typeof row.denialCount === "number"
    ) {
      denialsByPurpose[row.purpose] = row.denialCount;
    }
  }
  const sweep: VaultAlertSweep = {
    sweptAt: input.now,
    unknownKeyVersionRows: unknownKeyRows?.unknownCount ?? 0,
    staleSupersededGenerations: staleGenerations?.staleCount ?? 0,
    stuckRotations,
    failedRotations,
    delayedRestrictions: delayedRestrictions?.delayedCount ?? 0,
    latencyBreaches: latencyBreaches?.breachCount ?? 0,
    denialsByPurpose,
  };

  if (sweep.unknownKeyVersionRows > 0) {
    traceWarn("vault.alert.unknown_key_version_rows", {
      requestId: newRequestId(),
      row_count: sweep.unknownKeyVersionRows,
    });
  }
  if (sweep.staleSupersededGenerations > 0) {
    traceWarn("vault.alert.stale_superseded_generations", {
      requestId: newRequestId(),
      generation_count: sweep.staleSupersededGenerations,
    });
  }
  if (sweep.stuckRotations > 0) {
    traceWarn("vault.alert.stuck_credential_rotations", {
      requestId: newRequestId(),
      rotation_count: sweep.stuckRotations,
    });
  }
  if (sweep.failedRotations > 0) {
    traceWarn("vault.alert.failed_credential_rotations", {
      requestId: newRequestId(),
      rotation_count: sweep.failedRotations,
      window_ms: FAILED_ROTATION_WINDOW_MS,
    });
  }
  if (sweep.delayedRestrictions > 0) {
    traceWarn("vault.alert.delayed_restrictions", {
      requestId: newRequestId(),
      operation_count: sweep.delayedRestrictions,
      alert_threshold_ms: RESTRICTION_LATENCY_ALERT_MS,
    });
  }
  if (sweep.latencyBreaches > 0) {
    traceWarn("vault.alert.restriction_latency_breaches", {
      requestId: newRequestId(),
      operation_count: sweep.latencyBreaches,
      target_ms: RESTRICTION_LATENCY_TARGET_MS,
      alert_threshold_ms: RESTRICTION_LATENCY_ALERT_MS,
    });
  }
  return sweep;
}

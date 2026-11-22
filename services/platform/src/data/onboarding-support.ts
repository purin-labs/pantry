import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
} from "../organisation-execution-scope";
import { parseOrganisationId, type OrganisationId } from "@purin-labs/kernel/ids";
import { type UserId } from "@purin-labs/control-api/ids";
import type { Result } from "@purin-labs/kernel/result";
import type {
  QuerySource,
  OrganisationQuerySource,
  GlobalQuerySource,
} from "./query-source";

type ControlSupportRole =
  | {
      readonly kind: "support_agent";
      readonly userId: UserId;
    }
  | {
      readonly kind: "support_admin";
      readonly userId: UserId;
    };

type MerchantSupportDiagnostics = {
  readonly kind: "support_diagnostics";
  readonly supportReference: string;
  readonly provider: string | null;
  readonly displayAccount: string | null;
  readonly reasonCode: string;
  readonly occurredAt: number;
  readonly retryStatus: "retryable" | "terminal";
  readonly lastSuccessfulPhase: string | null;
  readonly webhookHealth: {
    readonly live: number;
    readonly degraded: number;
    readonly disabled: number;
    readonly revoked: number;
  };
  readonly projectionRevision: number;
};

export type OperatorOnboardingLookup =
  | { readonly kind: "support_reference"; readonly value: string }
  | { readonly kind: "organisation_id"; readonly value: string }
  | { readonly kind: "provider_account"; readonly value: string }
  | { readonly kind: "correlation_id"; readonly value: string };

type OperatorOnboardingCase = {
  readonly organisationId: string;
  readonly environment: "development" | "production";
  readonly lifecycle: string;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
  readonly latestReceipt: {
    readonly operation: string;
    readonly receiptId: string;
    readonly occurredAt: number;
  } | null;
  readonly manifest: {
    readonly provider: string;
    readonly desiredVersion: number;
    readonly observedVersion: number | null;
    readonly health: string | null;
  } | null;
  readonly webhookHealth: MerchantSupportDiagnostics["webhookHealth"];
  readonly timeline: readonly OperatorTimelineEntry[];
};

type OperatorTimelineEntry =
  | {
      readonly kind: "event";
      readonly occurredAt: number;
      readonly eventType: string;
      readonly correlationId: string;
      readonly attributes: unknown;
    }
  | {
      readonly kind: "audit";
      readonly occurredAt: number;
      readonly operation: string;
      readonly reasonCode: string;
      readonly targetKind: string;
      readonly targetId: string;
      readonly correlationId: string;
      readonly receiptId: string;
    };

type SupportDiagnosticRow = {
  readonly supportReference: unknown;
  readonly provider: unknown;
  readonly reasonCode: unknown;
  readonly latestOccurredAt: unknown;
  readonly retryClassification: unknown;
  readonly lastSuccessfulPhase: unknown;
  readonly projectionRevision: unknown;
  readonly displayAccount: unknown;
  readonly webhookLive: unknown;
  readonly webhookDegraded: unknown;
  readonly webhookDisabled: unknown;
  readonly webhookRevoked: unknown;
};

type OrganisationCaseRow = {
  readonly organisationId: unknown;
  readonly environment: unknown;
  readonly lifecycle: unknown;
  readonly configurationVersion: unknown;
  readonly projectionRevision: unknown;
};

type TimelineRow = {
  readonly kind: unknown;
  readonly occurredAt: unknown;
  readonly name: unknown;
  readonly correlationId: unknown;
  readonly attributes: unknown;
  readonly reasonCode: unknown;
  readonly targetKind: unknown;
  readonly targetId: unknown;
  readonly receiptId: unknown;
};

type LatestReceiptRow = {
  readonly operation: unknown;
  readonly receiptId: unknown;
  readonly occurredAt: unknown;
};

type ManifestRow = {
  readonly provider: unknown;
  readonly environment: unknown;
  readonly observedVersion: unknown;
  readonly health: unknown;
};

export async function resolveControlSupportRole(input: {
  readonly db: GlobalQuerySource;
  readonly userId: UserId;
}): Promise<ControlSupportRole | null> {
  const row = await input.db
    .prepare(
      `SELECT role FROM control_support_role
     WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .bind(input.userId)
    .first<{ readonly role: unknown }>();
  switch (row?.role) {
    case "support_agent":
      return {
        kind: "support_agent",
        userId: input.userId,
      };
    case "support_admin":
      return {
        kind: "support_admin",
        userId: input.userId,
      };
    default:
      return null;
  }
}

export async function readMerchantSupportDiagnostics(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly supportReference: string;
}): Promise<
  Result<
    MerchantSupportDiagnostics,
    { readonly code: "support_reference_not_found" }
  >
> {
  const row = await input.db
    .prepare(
      `SELECT
       support.support_reference AS supportReference,
       support.provider,
       support.reason_code AS reasonCode,
       support.latest_occurred_at AS latestOccurredAt,
       support.retry_classification AS retryClassification,
       support.last_successful_phase AS lastSuccessfulPhase,
       onboarding.projection_revision AS projectionRevision,
       (
         SELECT account.display_name
         FROM integration_account AS account
         WHERE account.organisation_id = support.organisation_id
           AND account.provider = support.provider
         ORDER BY account.is_default_for_provider DESC, account.updated_at DESC
         LIMIT 1
       ) AS displayAccount,
       (
         SELECT COUNT(*) FROM provider_webhook
         WHERE organisation_id = support.organisation_id AND lifecycle = 'live'
       ) AS webhookLive,
       (
         SELECT COUNT(*) FROM provider_webhook
         WHERE organisation_id = support.organisation_id AND lifecycle = 'degraded'
       ) AS webhookDegraded,
       (
         SELECT COUNT(*) FROM provider_webhook
         WHERE organisation_id = support.organisation_id AND lifecycle = 'disabled'
       ) AS webhookDisabled,
       (
         SELECT COUNT(*) FROM provider_webhook
         WHERE organisation_id = support.organisation_id AND lifecycle = 'revoked'
       ) AS webhookRevoked
     FROM onboarding_support_reference AS support
     JOIN organisation_onboarding AS onboarding
       ON onboarding.organisation_id = support.organisation_id
     WHERE support.organisation_id = ? AND support.support_reference = ?`,
    )
    .bind(input.organisationId, input.supportReference)
    .first<SupportDiagnosticRow>();
  return row === null
    ? { ok: false, error: { code: "support_reference_not_found" } }
    : { ok: true, value: parseSupportDiagnostics(row) };
}

export async function lookupOperatorOnboardingCases(input: {
  readonly env: OrganisationPlacementBindings;
  readonly lookup: OperatorOnboardingLookup;
}): Promise<readonly OperatorOnboardingCase[]> {
  const cases: OperatorOnboardingCase[] = [];
  for (const database of configuredOrganisationDatabases(input.env)) {
    const organisationIds = await lookupOrganisationIds(database, input.lookup);
    for (const rawOrganisationId of organisationIds) {
      const parsedOrganisationId = parseOrganisationId(rawOrganisationId);
      if (!parsedOrganisationId.ok) throw new Error("operator organisation id is invalid");
      const organisationId = parsedOrganisationId.value;
      const execution = await OrganisationExecutionScope.resolve(input.env, organisationId);
      if (!execution.ok) throw new Error(execution.error.code);
      if (execution.value.database !== database) continue;
      const row = await database
        .prepare(
          `SELECT organisation_id AS organisationId, environment, lifecycle,
              configuration_version AS configurationVersion,
              projection_revision AS projectionRevision
       FROM organisation_onboarding WHERE organisation_id = ?`,
        )
        .bind(organisationId)
        .first<OrganisationCaseRow>();
      if (row !== null) {
        cases.push(
          await buildOperatorCase(database, input.env.DB, parseOrganisationCase(row)),
        );
      }
    }
  }
  return cases;
}

async function lookupOrganisationIds(
  db: QuerySource,
  lookup: OperatorOnboardingLookup,
): Promise<readonly string[]> {
  switch (lookup.kind) {
    case "support_reference":
      return readStringColumn(
        db,
        `SELECT organisation_id AS value FROM onboarding_support_reference
         WHERE support_reference = ?`,
        lookup.value,
      );
    case "organisation_id":
      return readStringColumn(
        db,
        `SELECT organisation_id AS value FROM organisation_onboarding WHERE organisation_id = ?`,
        lookup.value,
      );
    case "provider_account":
      return readStringColumn(
        db,
        `SELECT DISTINCT organisation_id AS value FROM integration_account
         WHERE provider_account_id = ?`,
        lookup.value,
      );
    case "correlation_id":
      return readStringColumn(
        db,
        `SELECT DISTINCT organisation_id AS value FROM (
           SELECT organisation_id FROM onboarding_support_reference WHERE correlation_id = ?
           UNION
           SELECT organisation_id FROM onboarding_event WHERE correlation_id = ?
           UNION
           SELECT organisation_id FROM onboarding_audit_event WHERE correlation_id = ?
         )`,
        lookup.value,
        lookup.value,
        lookup.value,
      );
  }
}

async function readStringColumn(
  db: QuerySource,
  sql: string,
  ...values: readonly string[]
): Promise<readonly string[]> {
  const rows = await db
    .prepare(sql)
    .bind(...values)
    .all<{ readonly value: unknown }>();
  const parsed: string[] = [];
  for (const row of rows.results ?? []) {
    if (typeof row.value === "string") {
      parsed.push(row.value);
    }
  }
  return parsed;
}

async function buildOperatorCase(
  db: OrganisationQuerySource,
  directory: GlobalQuerySource,
  organisation: Omit<
    OperatorOnboardingCase,
    "latestReceipt" | "manifest" | "webhookHealth" | "timeline"
  >,
): Promise<OperatorOnboardingCase> {
  const [latestReceipt, manifest, timeline, diagnostics] = await Promise.all([
    readLatestReceipt(db, organisation.organisationId),
    readLatestManifest(db, directory, organisation.organisationId),
    readTimeline(db, organisation.organisationId),
    readWebhookHealth(db, organisation.organisationId),
  ]);
  return {
    organisationId: organisation.organisationId,
    environment: organisation.environment,
    lifecycle: organisation.lifecycle,
    configurationVersion: organisation.configurationVersion,
    projectionRevision: organisation.projectionRevision,
    latestReceipt,
    manifest,
    webhookHealth: diagnostics,
    timeline,
  };
}

async function readLatestReceipt(
  db: OrganisationQuerySource,
  organisationId: string,
): Promise<OperatorOnboardingCase["latestReceipt"]> {
  const row = await db
    .prepare(
      `SELECT operation, idempotency_receipt_id AS receiptId, occurred_at AS occurredAt
     FROM onboarding_audit_event
     WHERE organisation_id = ?
     ORDER BY occurred_at DESC, audit_event_id DESC
     LIMIT 1`,
    )
    .bind(organisationId)
    .first<LatestReceiptRow>();
  return row === null
    ? null
    : {
        operation: requireString(row.operation, "latest receipt operation"),
        receiptId: requireString(row.receiptId, "latest receipt id"),
        occurredAt: requireNumber(row.occurredAt, "latest receipt time"),
      };
}

async function readLatestManifest(
  db: OrganisationQuerySource,
  directory: GlobalQuerySource,
  organisationId: string,
): Promise<OperatorOnboardingCase["manifest"]> {
  const row = await db
    .prepare(
      `SELECT account.provider,
            account.environment,
            observation.manifest_version AS observedVersion,
            observation.lifecycle AS health
     FROM integration_account AS account
     LEFT JOIN provider_manifest_observation AS observation
       ON observation.observation_id = (
         SELECT latest.observation_id
         FROM provider_manifest_observation AS latest
         WHERE latest.integration_account_id = account.integration_account_id
         ORDER BY latest.observed_at DESC, latest.observation_id DESC
         LIMIT 1
       )
     WHERE account.organisation_id = ?
     ORDER BY account.is_default_for_provider DESC, account.updated_at DESC
     LIMIT 1`,
    )
    .bind(organisationId)
    .first<ManifestRow>();
  if (row === null) return null;
  const provider = requireString(row.provider, "manifest provider");
  const environment = requireString(row.environment, "manifest environment");
  const manifest = await directory
    .prepare(
      `SELECT MAX(manifest_version) AS desiredVersion FROM provider_manifest WHERE provider = ? AND environment = ?`,
    )
    .bind(provider, environment)
    .first<{ readonly desiredVersion: unknown }>();
  return {
    provider,
    desiredVersion: requireNumber(
      manifest?.desiredVersion,
      "desired manifest version",
    ),
    observedVersion:
      row.observedVersion === null
        ? null
        : requireNumber(row.observedVersion, "observed manifest version"),
    health:
      row.health === null ? null : requireString(row.health, "manifest health"),
  };
}

async function readTimeline(
  db: OrganisationQuerySource,
  organisationId: string,
): Promise<readonly OperatorTimelineEntry[]> {
  const rows = await db
    .prepare(
      `SELECT 'event' AS kind, occurred_at AS occurredAt, event_type AS name,
            correlation_id AS correlationId, attributes,
            NULL AS reasonCode, NULL AS targetKind, NULL AS targetId,
            NULL AS receiptId
     FROM onboarding_event WHERE organisation_id = ?
     UNION ALL
     SELECT 'audit' AS kind, occurred_at AS occurredAt, operation AS name,
            correlation_id AS correlationId, NULL AS attributes,
            reason_code AS reasonCode, target_kind AS targetKind,
            target_id AS targetId, idempotency_receipt_id AS receiptId
     FROM onboarding_audit_event WHERE organisation_id = ?
     ORDER BY occurredAt, kind`,
    )
    .bind(organisationId, organisationId)
    .all<TimelineRow>();
  return (rows.results ?? []).map(parseTimelineEntry);
}

async function readWebhookHealth(
  db: OrganisationQuerySource,
  organisationId: string,
): Promise<MerchantSupportDiagnostics["webhookHealth"]> {
  const row = await db
    .prepare(
      `SELECT
       SUM(CASE WHEN lifecycle = 'live' THEN 1 ELSE 0 END) AS live,
       SUM(CASE WHEN lifecycle = 'degraded' THEN 1 ELSE 0 END) AS degraded,
       SUM(CASE WHEN lifecycle = 'disabled' THEN 1 ELSE 0 END) AS disabled,
       SUM(CASE WHEN lifecycle = 'revoked' THEN 1 ELSE 0 END) AS revoked
     FROM provider_webhook WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      readonly live: unknown;
      readonly degraded: unknown;
      readonly disabled: unknown;
      readonly revoked: unknown;
    }>();
  return {
    live: nullableCount(row?.live),
    degraded: nullableCount(row?.degraded),
    disabled: nullableCount(row?.disabled),
    revoked: nullableCount(row?.revoked),
  };
}

function parseSupportDiagnostics(
  row: SupportDiagnosticRow,
): MerchantSupportDiagnostics {
  const retryStatus = row.retryClassification;
  if (retryStatus !== "retryable" && retryStatus !== "terminal") {
    throw new Error("support retry classification is invalid");
  }
  return {
    kind: "support_diagnostics",
    supportReference: requireString(row.supportReference, "support reference"),
    provider:
      row.provider === null
        ? null
        : requireString(row.provider, "support provider"),
    displayAccount:
      row.displayAccount === null
        ? null
        : requireString(row.displayAccount, "support display account"),
    reasonCode: requireString(row.reasonCode, "support reason code"),
    occurredAt: requireNumber(row.latestOccurredAt, "support occurrence time"),
    retryStatus,
    lastSuccessfulPhase:
      row.lastSuccessfulPhase === null
        ? null
        : requireString(row.lastSuccessfulPhase, "support phase"),
    webhookHealth: {
      live: nullableCount(row.webhookLive),
      degraded: nullableCount(row.webhookDegraded),
      disabled: nullableCount(row.webhookDisabled),
      revoked: nullableCount(row.webhookRevoked),
    },
    projectionRevision: requireNumber(
      row.projectionRevision,
      "support projection revision",
    ),
  };
}

function parseOrganisationCase(
  row: OrganisationCaseRow,
): Omit<
  OperatorOnboardingCase,
  "latestReceipt" | "manifest" | "webhookHealth" | "timeline"
> {
  const environment = row.environment;
  if (environment !== "development" && environment !== "production") {
    throw new Error("operator organisation environment is invalid");
  }
  return {
    organisationId: requireString(row.organisationId, "operator organisation id"),
    environment,
    lifecycle: requireString(row.lifecycle, "operator organisation lifecycle"),
    configurationVersion: requireNumber(
      row.configurationVersion,
      "operator configuration version",
    ),
    projectionRevision: requireNumber(
      row.projectionRevision,
      "operator projection revision",
    ),
  };
}

function parseTimelineEntry(row: TimelineRow): OperatorTimelineEntry {
  if (row.kind === "event") {
    return {
      kind: "event",
      occurredAt: requireNumber(row.occurredAt, "event time"),
      eventType: requireString(row.name, "event type"),
      correlationId: requireString(row.correlationId, "event correlation"),
      attributes: requireJson(row.attributes),
    };
  }
  if (row.kind === "audit") {
    return {
      kind: "audit",
      occurredAt: requireNumber(row.occurredAt, "audit time"),
      operation: requireString(row.name, "audit operation"),
      reasonCode: requireString(row.reasonCode, "audit reason"),
      targetKind: requireString(row.targetKind, "audit target kind"),
      targetId: requireString(row.targetId, "audit target id"),
      correlationId: requireString(row.correlationId, "audit correlation"),
      receiptId: requireString(row.receiptId, "audit receipt"),
    };
  }
  throw new Error("operator timeline branch is invalid");
}

function requireJson(raw: unknown): unknown {
  if (typeof raw !== "string") {
    throw new Error("operator timeline attributes are invalid");
  }
  return JSON.parse(raw);
}

function nullableCount(raw: unknown): number {
  return raw === null || raw === undefined
    ? 0
    : requireNumber(raw, "webhook count");
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== "string") {
    throw new Error(`${field} is invalid`);
  }
  return raw;
}

function requireNumber(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
    throw new Error(`${field} is invalid`);
  }
  return raw;
}

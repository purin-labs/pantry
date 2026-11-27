import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { COMMERCE_LAB_CATALOG_VERSION } from "./catalog";
import {
  COMMERCE_LAB_SCENARIO_IDS,
  COMMERCE_LAB_SCENARIO_VERSION,
  type CommerceLabPublicationProposal,
  type ExpectedCommerceProjection,
  type ExpectedCommerceSlackEffect,
  type CommerceLabScenarioId,
} from "./scenarios";
import type { Variant } from "@purin-labs/type-utils";
import type { CommerceLabMetadataError } from "@purin-labs/area-commerce-contract/server/delivery-intake";
import {
  isNonNegativeInteger,
  isRecord,
  isString,
  parseJsonOrNull,
} from "@purin-labs/std";

export const COMMERCE_LAB_INTEGRATION_ACCOUNT_ID =
  requireCommerceLabIntegrationAccountId();

type CommerceLabOrganisationMarker = {
  readonly organisationId: OrganisationId;
  readonly labNamespace: string;
  readonly scenarioCatalogVersion: string;
  readonly markedAt: number;
};

type CommerceLabRunResult = "running" | "completed" | "failed";

export type CommerceLabRunEvidence = {
  readonly runId: string;
  readonly organisationId: OrganisationId;
  readonly labNamespace: string;
  readonly scenarioId: CommerceLabScenarioId;
  readonly scenarioVersion: typeof COMMERCE_LAB_SCENARIO_VERSION;
  readonly catalogVersion: string;
  readonly idempotencyKey: string;
  readonly result: CommerceLabRunResult;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly providerEventIds: readonly string[];
  readonly expectedProjections: readonly ExpectedCommerceProjection[];
  readonly expectedSlackEffect: ExpectedCommerceSlackEffect;
  readonly publicationProposal: CommerceLabPublicationProposal;
  readonly failureStage: string | null;
  readonly failureCode: string | null;
  readonly failureProviderEventId: string | null;
  readonly failureProjectionId: string | null;
  readonly failureSlackEffectId: string | null;
};

export type { CommerceLabMetadataError } from "@purin-labs/area-commerce-contract/server/delivery-intake";

type CommerceLabOrganisationRow = {
  readonly organisationId: unknown;
  readonly labNamespace: unknown;
  readonly scenarioCatalogVersion: unknown;
  readonly markedAt: unknown;
};

type CommerceLabRunRow = {
  readonly runId: unknown;
  readonly organisationId: unknown;
  readonly labNamespace: unknown;
  readonly scenarioId: unknown;
  readonly scenarioVersion: unknown;
  readonly catalogVersion: unknown;
  readonly idempotencyKey: unknown;
  readonly result: unknown;
  readonly providerEventIds: unknown;
  readonly expectedProjections: unknown;
  readonly expectedSlackEffect: unknown;
  readonly publicationProposal: unknown;
  readonly failureStage: unknown;
  readonly failureCode: unknown;
  readonly failureProviderEventId: unknown;
  readonly failureProjectionId: unknown;
  readonly failureSlackEffectId: unknown;
  readonly startedAt: unknown;
  readonly completedAt: unknown;
};

function requireCommerceLabIntegrationAccountId(): IntegrationAccountId {
  const parsed = parseIntegrationAccountId("integration_account_commerce_lab");

  if (!parsed.ok) {
    throw new Error("commerce_lab_integration_account_id_invalid");
  }

  return parsed.value;
}

export async function markCommerceLabOrganisation(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly labNamespace: string;
  readonly markedAt: number;
}): Promise<Result<CommerceLabOrganisationMarker, CommerceLabMetadataError>> {
  if (!isLabNamespace(input.labNamespace)) {
    return { ok: false, error: { code: "commerce_lab_namespace_mismatch" } };
  }
  if (!isNonNegativeInteger(input.markedAt)) {
    return { ok: false, error: { code: "commerce_lab_metadata_corrupt" } };
  }

  await input.db
    .prepare(
      `INSERT INTO commerce_lab_organisation (
         organisation_id, lab_namespace, scenario_catalog_version, marked_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT (organisation_id) DO UPDATE SET
         lab_namespace = excluded.lab_namespace,
         scenario_catalog_version = excluded.scenario_catalog_version,
         marked_at = excluded.marked_at`,
    )
    .bind(
      input.organisationId,
      input.labNamespace,
      COMMERCE_LAB_CATALOG_VERSION,
      input.markedAt,
    )
    .run();

  return {
    ok: true,
    value: {
      organisationId: input.organisationId,
      labNamespace: input.labNamespace,
      scenarioCatalogVersion: COMMERCE_LAB_CATALOG_VERSION,
      markedAt: input.markedAt,
    },
  };
}

export async function requireCommerceLabOrganisationMarker(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly labNamespace: string;
}): Promise<Result<CommerceLabOrganisationMarker, CommerceLabMetadataError>> {
  const session = input.db.withSession("first-primary");
  const row = await session
    .prepare(
      `SELECT organisation_id AS organisationId,
              lab_namespace AS labNamespace,
              scenario_catalog_version AS scenarioCatalogVersion,
              marked_at AS markedAt
       FROM commerce_lab_organisation
       WHERE organisation_id = ?`,
    )
    .bind(input.organisationId)
    .first<CommerceLabOrganisationRow>();

  if (row === null) {
    return { ok: false, error: { code: "commerce_lab_not_marked" } };
  }

  const parsed = parseOrganisationMarker(row);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value.labNamespace !== input.labNamespace) {
    return { ok: false, error: { code: "commerce_lab_namespace_mismatch" } };
  }
  if (parsed.value.scenarioCatalogVersion !== COMMERCE_LAB_CATALOG_VERSION) {
    return {
      ok: false,
      error: { code: "commerce_lab_catalog_version_mismatch" },
    };
  }

  return parsed;
}

export async function beginCommerceLabRun(input: {
  readonly db: OrganisationDatabase;
  readonly run: CommerceLabRunEvidence;
}): Promise<Result<CommerceLabRunEvidence, CommerceLabMetadataError>> {
  const marker = await requireCommerceLabOrganisationMarker({
    db: input.db,
    organisationId: input.run.organisationId,
    labNamespace: input.run.labNamespace,
  });
  if (!marker.ok) {
    return marker;
  }

  const existing = await readCommerceLabRunByIdempotencyKey({
    db: input.db,
    organisationId: input.run.organisationId,
    idempotencyKey: input.run.idempotencyKey,
  });
  if (!existing.ok) {
    return existing;
  }
  if (existing.value !== null) {
    if (
      existing.value.runId !== input.run.runId ||
      existing.value.scenarioId !== input.run.scenarioId
    ) {
      return { ok: false, error: { code: "commerce_lab_run_conflict" } };
    }
    return { ok: true, value: existing.value };
  }

  await input.db
    .prepare(
      `INSERT INTO commerce_lab_run (
         run_id, organisation_id, lab_namespace, scenario_id,
         scenario_version, scenario_catalog_version, idempotency_key, lifecycle,
         provider_event_ids, expected_projection, expected_slack_effect,
         publication_proposal,
         failure_stage, failure_code, failure_provider_event_id,
         failure_projection_id, failure_slack_effect_id, started_at, completed_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?,
         NULL, NULL, NULL, NULL, NULL, ?, NULL
       )`,
    )
    .bind(
      input.run.runId,
      input.run.organisationId,
      input.run.labNamespace,
      input.run.scenarioId,
      input.run.scenarioVersion,
      input.run.catalogVersion,
      input.run.idempotencyKey,
      JSON.stringify(input.run.providerEventIds),
      JSON.stringify(input.run.expectedProjections),
      JSON.stringify(input.run.expectedSlackEffect),
      JSON.stringify(input.run.publicationProposal),
      input.run.startedAt,
    )
    .run();

  return { ok: true, value: input.run };
}

export async function completeCommerceLabRun(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly runId: string;
  readonly completedAt: number;
}): Promise<Result<CommerceLabRunEvidence, CommerceLabMetadataError>> {
  return finishCommerceLabRun({
    db: input.db,
    organisationId: input.organisationId,
    runId: input.runId,
    completedAt: input.completedAt,
    result: "completed",
    failureStage: null,
    failureCode: null,
    failureProviderEventId: null,
    failureProjectionId: null,
    failureSlackEffectId: null,
  });
}

export async function failCommerceLabRun(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly runId: string;
  readonly completedAt: number;
  readonly failureStage: string;
  readonly failureCode: string;
  readonly failureProviderEventId: string | null;
  readonly failureProjectionId: string | null;
  readonly failureSlackEffectId: string | null;
}): Promise<Result<CommerceLabRunEvidence, CommerceLabMetadataError>> {
  if (
    input.failureStage.length === 0 ||
    input.failureCode.length === 0 ||
    !isNullableNonEmptyString(input.failureProviderEventId) ||
    !isNullableNonEmptyString(input.failureProjectionId) ||
    !isNullableNonEmptyString(input.failureSlackEffectId)
  ) {
    return { ok: false, error: { code: "commerce_lab_metadata_corrupt" } };
  }

  return finishCommerceLabRun({
    db: input.db,
    organisationId: input.organisationId,
    runId: input.runId,
    completedAt: input.completedAt,
    result: "failed",
    failureStage: input.failureStage,
    failureCode: input.failureCode,
    failureProviderEventId: input.failureProviderEventId,
    failureProjectionId: input.failureProjectionId,
    failureSlackEffectId: input.failureSlackEffectId,
  });
}

export async function listCommerceLabRuns(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly limit: number;
}): Promise<
  Result<readonly CommerceLabRunEvidence[], CommerceLabMetadataError>
> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 50
  ) {
    return { ok: false, error: { code: "commerce_lab_metadata_corrupt" } };
  }

  const query = await input.db
    .prepare(
      `SELECT run_id AS runId,
              organisation_id AS organisationId,
              lab_namespace AS labNamespace,
              scenario_id AS scenarioId,
              scenario_version AS scenarioVersion,
              scenario_catalog_version AS catalogVersion,
              idempotency_key AS idempotencyKey,
              lifecycle AS result,
              provider_event_ids AS providerEventIds,
              expected_projection AS expectedProjections,
              expected_slack_effect AS expectedSlackEffect,
              publication_proposal AS publicationProposal,
              failure_stage AS failureStage,
              failure_code AS failureCode,
              failure_provider_event_id AS failureProviderEventId,
              failure_projection_id AS failureProjectionId,
              failure_slack_effect_id AS failureSlackEffectId,
              started_at AS startedAt,
              completed_at AS completedAt
       FROM commerce_lab_run
       WHERE organisation_id = ?
       ORDER BY started_at DESC, run_id DESC
       LIMIT ?`,
    )
    .bind(input.organisationId, input.limit)
    .all<CommerceLabRunRow>();

  const runs: CommerceLabRunEvidence[] = [];
  for (const row of query.results) {
    const parsed = parseRunRow(row);
    if (!parsed.ok) {
      return parsed;
    }
    runs.push(parsed.value);
  }

  return { ok: true, value: runs };
}

async function finishCommerceLabRun(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly runId: string;
  readonly completedAt: number;
  readonly result: Exclude<CommerceLabRunResult, "running">;
  readonly failureStage: string | null;
  readonly failureCode: string | null;
  readonly failureProviderEventId: string | null;
  readonly failureProjectionId: string | null;
  readonly failureSlackEffectId: string | null;
}): Promise<Result<CommerceLabRunEvidence, CommerceLabMetadataError>> {
  if (!isNonNegativeInteger(input.completedAt)) {
    return { ok: false, error: { code: "commerce_lab_metadata_corrupt" } };
  }

  const mutation = await input.db
    .prepare(
      `UPDATE commerce_lab_run
       SET lifecycle = ?,
           failure_stage = ?,
           failure_code = ?,
           failure_provider_event_id = ?,
           failure_projection_id = ?,
           failure_slack_effect_id = ?,
           completed_at = ?
       WHERE organisation_id = ? AND run_id = ? AND lifecycle = 'running'`,
    )
    .bind(
      input.result,
      input.failureStage,
      input.failureCode,
      input.failureProviderEventId,
      input.failureProjectionId,
      input.failureSlackEffectId,
      input.completedAt,
      input.organisationId,
      input.runId,
    )
    .run();
  if (!mutation.meta.changed_db) {
    const existing = await readCommerceLabRun({
      db: input.db,
      organisationId: input.organisationId,
      runId: input.runId,
    });
    if (!existing.ok) {
      return existing;
    }
    if (existing.value.result === input.result) {
      return existing;
    }
    return { ok: false, error: { code: "commerce_lab_run_conflict" } };
  }

  return readCommerceLabRun({
    db: input.db,
    organisationId: input.organisationId,
    runId: input.runId,
  });
}

async function readCommerceLabRun(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly runId: string;
}): Promise<Result<CommerceLabRunEvidence, CommerceLabMetadataError>> {
  const row = await input.db
    .prepare(runSelectSql("organisation_id = ? AND run_id = ?"))
    .bind(input.organisationId, input.runId)
    .first<CommerceLabRunRow>();
  if (row === null) {
    return { ok: false, error: { code: "commerce_lab_run_missing" } };
  }
  return parseRunRow(row);
}

async function readCommerceLabRunByIdempotencyKey(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly idempotencyKey: string;
}): Promise<Result<CommerceLabRunEvidence | null, CommerceLabMetadataError>> {
  const row = await input.db
    .prepare(runSelectSql("organisation_id = ? AND idempotency_key = ?"))
    .bind(input.organisationId, input.idempotencyKey)
    .first<CommerceLabRunRow>();
  if (row === null) {
    return { ok: true, value: null };
  }
  return parseRunRow(row);
}

function runSelectSql(predicate: string): string {
  return `SELECT run_id AS runId,
                 organisation_id AS organisationId,
                 lab_namespace AS labNamespace,
                 scenario_id AS scenarioId,
                 scenario_version AS scenarioVersion,
                 scenario_catalog_version AS catalogVersion,
                 idempotency_key AS idempotencyKey,
                 lifecycle AS result,
                 provider_event_ids AS providerEventIds,
                 expected_projection AS expectedProjections,
                 expected_slack_effect AS expectedSlackEffect,
                 publication_proposal AS publicationProposal,
                 failure_stage AS failureStage,
                 failure_code AS failureCode,
                 failure_provider_event_id AS failureProviderEventId,
                 failure_projection_id AS failureProjectionId,
                 failure_slack_effect_id AS failureSlackEffectId,
                 started_at AS startedAt,
                 completed_at AS completedAt
          FROM commerce_lab_run
          WHERE ${predicate}`;
}

function parseOrganisationMarker(
  row: CommerceLabOrganisationRow,
): Result<CommerceLabOrganisationMarker, CommerceLabMetadataError> {
  if (
    typeof row.organisationId !== "string" ||
    typeof row.labNamespace !== "string" ||
    typeof row.scenarioCatalogVersion !== "string" ||
    !isNonNegativeInteger(row.markedAt)
  ) {
    return { ok: false, error: { code: "commerce_lab_metadata_corrupt" } };
  }

  return {
    ok: true,
    value: {
      organisationId: row.organisationId as OrganisationId,
      labNamespace: row.labNamespace,
      scenarioCatalogVersion: row.scenarioCatalogVersion,
      markedAt: row.markedAt,
    },
  };
}

function parseRunRow(
  row: CommerceLabRunRow,
): Result<CommerceLabRunEvidence, CommerceLabMetadataError> {
  const scenarioId = parseScenarioId(row.scenarioId);
  const result = parseRunResult(row.result);
  const providerEventIds = parseStringArray(row.providerEventIds);
  const expectedProjections = parseExpectedProjections(row.expectedProjections);
  const expectedSlackEffect = parseExpectedSlackEffect(row.expectedSlackEffect);
  const publicationProposal = parsePublicationProposal(row.publicationProposal);
  if (
    typeof row.runId !== "string" ||
    typeof row.organisationId !== "string" ||
    typeof row.labNamespace !== "string" ||
    row.scenarioVersion !== COMMERCE_LAB_SCENARIO_VERSION ||
    typeof row.catalogVersion !== "string" ||
    typeof row.idempotencyKey !== "string" ||
    scenarioId === null ||
    result === null ||
    providerEventIds === null ||
    expectedProjections === null ||
    expectedSlackEffect === null ||
    publicationProposal === null ||
    !isNonNegativeInteger(row.startedAt) ||
    !isNullableNonNegativeInteger(row.completedAt) ||
    !isNullableString(row.failureStage) ||
    !isNullableString(row.failureCode) ||
    !isNullableString(row.failureProviderEventId) ||
    !isNullableString(row.failureProjectionId) ||
    !isNullableString(row.failureSlackEffectId)
  ) {
    return { ok: false, error: { code: "commerce_lab_metadata_corrupt" } };
  }

  return {
    ok: true,
    value: {
      runId: row.runId,
      organisationId: row.organisationId as OrganisationId,
      labNamespace: row.labNamespace,
      scenarioId,
      scenarioVersion: row.scenarioVersion,
      catalogVersion: row.catalogVersion,
      idempotencyKey: row.idempotencyKey,
      result,
      providerEventIds,
      expectedProjections,
      expectedSlackEffect,
      publicationProposal,
      failureStage: row.failureStage,
      failureCode: row.failureCode,
      failureProviderEventId: row.failureProviderEventId,
      failureProjectionId: row.failureProjectionId,
      failureSlackEffectId: row.failureSlackEffectId,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    },
  };
}

function parseScenarioId(raw: unknown): CommerceLabScenarioId | null {
  if (typeof raw !== "string") {
    return null;
  }
  for (const scenarioId of COMMERCE_LAB_SCENARIO_IDS) {
    if (raw === scenarioId) {
      return scenarioId;
    }
  }
  return null;
}

function parseRunResult(raw: unknown): CommerceLabRunResult | null {
  if (raw === "running" || raw === "completed" || raw === "failed") {
    return raw;
  }
  return null;
}

function parseStringArray(raw: unknown): readonly string[] | null {
  const parsed = jsonOrNull(raw);
  if (!Array.isArray(parsed) || !parsed.every(isString)) {
    return null;
  }
  return parsed;
}

function parseExpectedProjections(
  raw: unknown,
): readonly ExpectedCommerceProjection[] | null {
  const parsed = jsonOrNull(raw);
  if (!Array.isArray(parsed)) {
    return null;
  }
  const projections: ExpectedCommerceProjection[] = [];
  for (const value of parsed) {
    if (
      !isRecord(value) ||
      !isExpectedProjectionKind(value.kind) ||
      typeof value.canonicalId !== "string" ||
      typeof value.lifecycle !== "string"
    ) {
      return null;
    }
    projections.push({
      kind: value.kind,
      canonicalId: value.canonicalId,
      lifecycle: value.lifecycle,
    });
  }
  return projections;
}

function parseExpectedSlackEffect(
  raw: unknown,
): ExpectedCommerceSlackEffect | null {
  const parsed = jsonOrNull(raw);
  if (
    !isRecord(parsed) ||
    (parsed.kind !== "none" && parsed.kind !== "proposal")
  ) {
    return null;
  }
  if (parsed.kind === "none") {
    return { kind: "none" };
  }
  if (
    !isSlackEffectEventType(parsed.eventType) ||
    typeof parsed.canonicalId !== "string"
  ) {
    return null;
  }
  return {
    kind: "proposal",
    eventType: parsed.eventType,
    canonicalId: parsed.canonicalId,
  };
}

function parsePublicationProposal(
  raw: unknown,
): CommerceLabPublicationProposal | null {
  const parsed = jsonOrNull(raw);
  if (!isRecord(parsed)) {
    return null;
  }
  if (parsed.kind === "none") {
    return { kind: "none" };
  }
  if (
    parsed.kind !== "catalog_publication" ||
    parsed.actionId !== "commerce_lab_publish_offer_field_watch_black_r2" ||
    parsed.provider !== "lab" ||
    parsed.productId !== "product_field_watch" ||
    parsed.productRevision !== 2 ||
    parsed.variantId !== "variant_field_watch_black" ||
    parsed.variantRevision !== 2 ||
    parsed.offerId !== "offer_variant_field_watch_black_lab_online" ||
    parsed.offerRevision !== 2 ||
    parsed.salesChannelId !== "sales_channel_lab_online" ||
    parsed.salesChannelRevision !== 2 ||
    parsed.desiredLifecycle !== "listed" ||
    typeof parsed.providerEventId !== "string" ||
    parsed.providerEventId.length === 0
  ) {
    return null;
  }
  return {
    kind: parsed.kind,
    actionId: parsed.actionId,
    provider: parsed.provider,
    productId: parsed.productId,
    productRevision: parsed.productRevision,
    variantId: parsed.variantId,
    variantRevision: parsed.variantRevision,
    offerId: parsed.offerId,
    offerRevision: parsed.offerRevision,
    salesChannelId: parsed.salesChannelId,
    salesChannelRevision: parsed.salesChannelRevision,
    desiredLifecycle: parsed.desiredLifecycle,
    providerEventId: parsed.providerEventId,
  };
}

function jsonOrNull(raw: unknown): unknown {
  return typeof raw === "string" ? parseJsonOrNull(raw) : null;
}

function isLabNamespace(value: string): boolean {
  return /^lab_[A-Za-z0-9_-]{4,124}$/u.test(value);
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function isExpectedProjectionKind(
  value: unknown,
): value is ExpectedCommerceProjection["kind"] {
  return (
    value === "product" ||
    value === "inventory_position" ||
    value === "commerce_order" ||
    value === "payment" ||
    value === "fulfillment" ||
    value === "shipment"
  );
}

function isSlackEffectEventType(
  value: unknown,
): value is Variant<ExpectedCommerceSlackEffect, "proposal">["eventType"] {
  return (
    value === "payment_failed" ||
    value === "inventory_shortage" ||
    value === "tracking_stalled" ||
    value === "delivery_exception" ||
    value === "cancellation_refund_proposed"
  );
}

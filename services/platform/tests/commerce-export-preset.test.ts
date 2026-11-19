import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
/// <reference types="@cloudflare/workers-types" />

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CommerceAdminClient,
  CommerceEntityPlaneClient,
  commerceExportPresetDigestPayload,
  parseEntityPlaneExportPresetPublishResponse,
} from "@seams/commerce-client";

import {
  parseCommerceExportPresetPublishRequest,
  publishCommerceExportPreset,
} from "../src/data/export-preset";
import { SqliteD1Database } from "./sqlite-d1";
import { startCommerceWorker } from "./commerce-fixture-worker";
import { requireUserId, requireOrganisationId } from "./test-ids";

const ORGANISATION = requireOrganisationId("organisation_export_preset");
const CONTROL_IDENTITY = requireUserId(
  "user_98517ce7-3460-55f4-b3db-52f80c0a8b66",
);
const MERCHANT = "merchant_export_preset";
const NOW = "2026-08-26T00:00:00.000Z";
const BASELINE = singleDatabaseSchema();

describe("Platform export preset publication", () => {
  it("rebuilds the current development baseline and publishes the real Underclerk preset", async () => {
    const platform = createDatabase();
    const commerceEngine = await startCommerceWorker({ now: NOW });
    const config = {
      baseUrl: commerceEngine.baseUrl,
      serviceToken: commerceEngine.serviceToken,
      fetch: commerceEngine.fetch,
    };
    const admin = new CommerceAdminClient(config);
    const provisioned = await admin.provisionMerchant({
      schemaVersion: "underclerk.provision-merchant.v2",
      externalReference: ORGANISATION,
      merchantId: MERCHANT,
      createdAt: NOW,
    });
    expect(provisioned.ok).toBe(true);
    const client = new CommerceEntityPlaneClient(config);

    const first = await publish(platform.db, client);
    const replay = await publish(platform.db, client);

    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(first).toMatchObject({
      ok: true,
      value: {
        kind: "export_preset_published",
        organisationId: ORGANISATION,
        merchantId: MERCHANT,
        configurationVersion: 4,
        projectionRevision: 8,
      },
    });
    expect(replay).toEqual(first);
    expect(
      platform.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM commerce_export_preset_publication WHERE organisation_id = ?",
        )
        .get(ORGANISATION),
    ).toEqual({ count: 1 });

    platform.sqlite.close();
    await commerceEngine.dispose();
  }, 30_000);

  it("publishes exact evidence and all owner records in one fenced batch", async () => {
    const database = createDatabase();
    const client = clientFor(presetResponse());
    const result = await publish(database.db, client);

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "export_preset_published",
        organisationId: ORGANISATION,
        merchantId: MERCHANT,
        configurationVersion: 4,
        projectionRevision: 8,
      },
    });
    expect(
      database.sqlite
        .prepare(
          "SELECT configuration_version, projection_revision FROM organisation_onboarding WHERE organisation_id = ?",
        )
        .get(ORGANISATION),
    ).toEqual({ configuration_version: 4, projection_revision: 8 });
    expect(
      database.sqlite
        .prepare(
          "SELECT preset_id, preset_version, merchant_revision, digest FROM commerce_export_preset_publication WHERE organisation_id = ?",
        )
        .get(ORGANISATION),
    ).toMatchObject({
      preset_id: "export_coordination",
      preset_version: 1,
      merchant_revision: 13,
    });
    expect(
      database.sqlite
        .prepare(
          "SELECT digest FROM commerce_export_preset_publication WHERE organisation_id = ?",
        )
        .get(ORGANISATION),
    ).toMatchObject({ digest: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_responsibility_scope WHERE organisation_id = ?",
        )
        .get(ORGANISATION),
    ).toEqual({ count: 7 });
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM access_grant WHERE organisation_id = ?",
        )
        .get(ORGANISATION),
    ).toEqual({ count: 7 });
    expect(
      database.sqlite
        .prepare(
          "SELECT capability_id, mode FROM organisation_capability_policy WHERE organisation_id = ? ORDER BY capability_id",
        )
        .all(ORGANISATION),
    ).toEqual([
      { capability_id: "commerce.entity.read", mode: "enabled" },
      { capability_id: "commerce.entity_plane.context", mode: "enabled" },
      { capability_id: "commerce.list_entry.patch", mode: "approval_required" },
      { capability_id: "commerce.saved_view.publish", mode: "enabled" },
    ]);
    database.sqlite.close();
  });

  it("replays the same publication without advancing the configuration fence", async () => {
    const database = createDatabase();
    const first = await publish(database.db, clientFor(presetResponse()));
    const replay = await publish(database.db, clientFor(presetResponse()));

    expect(replay).toEqual(first);
    expect(
      database.sqlite
        .prepare(
          "SELECT configuration_version, projection_revision FROM organisation_onboarding WHERE organisation_id = ?",
        )
        .get(ORGANISATION),
    ).toEqual({ configuration_version: 4, projection_revision: 8 });
    database.sqlite.close();
  });

  it("fails closed for Underclerk identity and resource drift", async () => {
    const database = createDatabase();
    const mismatch = await publish(
      database.db,
      clientFor(
        presetResponse({ organisationId: "organisation_other_export" }),
      ),
    );
    expect(mismatch).toEqual({
      ok: false,
      error: {
        code: "commerce_export_preset_underclerk_mismatch",
        field: "organisationId",
      },
    });

    const invalidDigest = await publish(
      database.db,
      clientFor(presetResponse({ digest: "b".repeat(64) })),
    );
    expect(invalidDigest).toEqual({
      ok: false,
      error: {
        code: "commerce_export_preset_underclerk_mismatch",
        field: "digest",
      },
    });

    const first = await publish(database.db, clientFor(presetResponse()));
    expect(first.ok).toBe(true);
    const drift = await publish(
      database.db,
      clientFor(presetResponse({ viewName: "Drifted export board" })),
    );
    expect(drift).toEqual({
      ok: false,
      error: { code: "commerce_export_preset_drift", field: "digest" },
    });
    database.sqlite.close();
  });

  it("leaves no durable rows after a batch failure and retries cleanly", async () => {
    const database = createDatabase();
    const originalBatch = database.wrapper.batch.bind(database.wrapper);
    database.wrapper.batch = async () => {
      throw new Error("injected D1 failure");
    };
    const failed = await publish(database.db, clientFor(presetResponse()));
    expect(failed).toEqual({
      ok: false,
      error: { code: "commerce_export_preset_persistence_failed" },
    });
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM commerce_export_preset_publication WHERE organisation_id = ?",
        )
        .get(ORGANISATION),
    ).toEqual({ count: 0 });
    expect(
      database.sqlite
        .prepare(
          "SELECT configuration_version, projection_revision FROM organisation_onboarding WHERE organisation_id = ?",
        )
        .get(ORGANISATION),
    ).toEqual({ configuration_version: 3, projection_revision: 7 });
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM operational_area WHERE organisation_id = ?",
        )
        .get(ORGANISATION),
    ).toEqual({ count: 0 });

    database.wrapper.batch = originalBatch;
    const retried = await publish(database.db, clientFor(presetResponse()));
    expect(retried.ok).toBe(true);
    database.sqlite.close();
  });

  it("rejects request fields outside the closed preset envelope", () => {
    expect(
      parseCommerceExportPresetPublishRequest({
        presetId: "export_coordination",
        version: 1,
        extra: true,
      }),
    ).toEqual({
      ok: false,
      error: { code: "commerce_export_preset_invalid", field: "request" },
    });
  });
});

async function publish(
  db: SingleDatabase,
  client: Pick<CommerceEntityPlaneClient, "publishExportPreset">,
) {
  const request = parseCommerceExportPresetPublishRequest({
    presetId: "export_coordination",
    version: 1,
  });
  if (!request.ok) throw new Error("preset request fixture is invalid");
  return publishCommerceExportPreset({
    scope: await requireOrganisationExecutionScope(
      {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      ORGANISATION,
    ),

    environment: "development",
    merchantId: MERCHANT,
    request: request.value,
    expectedConfigurationVersion: 3,
    controlMutation: {
      scope: {
        userId: CONTROL_IDENTITY,
        organisationScope: ORGANISATION,
        route:
          "/v1/control/organisations/organisation_export_preset/commerce/export-preset",
        operation: "commerce_export_preset.publish",
      },
      boundary: {
        kind: "configuration_versioned",
        idempotencyKey: "export_preset_1",
        requestHash: "c".repeat(64),
        expectedConfigurationVersion: 3,
      },
      identity: {
        receiptId: "receipt_export_preset_1",
        auditEventId: "audit_export_preset_1",
        correlationId: "correlation_export_preset_1",
        causationId: "causation_export_preset_1",
        portalSubjectHash: "d".repeat(64),
        createdAt: 100,
      },
    },
    client,
  });
}

function clientFor(
  response: ReturnType<typeof presetResponse>,
): Pick<CommerceEntityPlaneClient, "publishExportPreset"> {
  return clientWith(response);
}

function clientWith(
  response: ReturnType<typeof presetResponse>,
): Pick<CommerceEntityPlaneClient, "publishExportPreset"> {
  return {
    publishExportPreset: async () => ({ ok: true, value: response }),
  };
}

function presetResponse(
  overrides: Readonly<{
    organisationId?: string;
    digest?: string;
    viewName?: string;
  }> = {},
) {
  const evidence = presetEvidence(overrides.viewName);
  const digest = createHash("sha256")
    .update(
      commerceExportPresetDigestPayload({
        presetId: "export_coordination",
        presetVersion: 1,
        evidence: parseEntityPlaneExportPresetPublishResponse({
          kind: "published",
          organisationId: overrides.organisationId ?? String(ORGANISATION),
          merchantId: MERCHANT,
          presetId: "export_coordination",
          presetVersion: 1,
          merchantRevision: 13,
          evidence,
          digest: "0".repeat(64),
        }).evidence,
      }),
    )
    .digest("hex");
  return parseEntityPlaneExportPresetPublishResponse({
    kind: "published",
    organisationId: overrides.organisationId ?? String(ORGANISATION),
    merchantId: MERCHANT,
    presetId: "export_coordination",
    presetVersion: 1,
    merchantRevision: 13,
    evidence,
    digest: overrides.digest ?? digest,
  });
}

function presetEvidence(viewName?: string) {
  return {
    customEntityTypes: [
      { origin: "custom", typeId: "trade_partner", publishedRevision: 1 },
      { origin: "custom", typeId: "export_document", publishedRevision: 1 },
    ],
    relationshipDefinitions: [
      {
        origin: "custom",
        definitionId: "trade_partner_order",
        sourceType: { origin: "custom", typeId: "trade_partner" },
        targetType: { origin: "system", typeId: "order" },
        sourceLabel: "Orders",
        inverseLabel: "Trade partner",
        cardinality: "one_to_many",
        deletionBehavior: "detach",
        sensitivity: "internal",
        revision: 1,
      },
      {
        origin: "custom",
        definitionId: "shipment_export_document",
        sourceType: { origin: "system", typeId: "shipment" },
        targetType: { origin: "custom", typeId: "export_document" },
        sourceLabel: "Export documents",
        inverseLabel: "Shipment",
        cardinality: "one_to_many",
        deletionBehavior: "detach",
        sensitivity: "internal",
        revision: 1,
      },
    ],
    lists: [
      {
        listId: "export_coordination",
        entityTypeId: { origin: "system", typeId: "shipment" },
        name: "Export coordination",
        membership: "unique_entity",
        entryAttributeDefinitions: [],
        publishedRevision: 1,
      },
    ],
    views: [
      "export_board",
      "handoff_due",
      "missing_documents",
      "trade_partner_follow_up",
    ].map((viewId) => ({
      viewId,
      name:
        viewId === "export_board" && viewName !== undefined ? viewName : viewId,
      source: { kind: "commerce_list", listId: "export_coordination" },
      filter: { kind: "all" },
      sorts: [],
      visibleAttributeIds: ["stage"],
      relationshipColumns: [],
      grouping: null,
      presentation: {
        kind: "table",
        configuration: { density: "comfortable", showRowNumbers: false },
      },
      revision: 1,
    })),
  };
}

function createDatabase(): Readonly<{
  readonly sqlite: DatabaseSync;
  readonly wrapper: SqliteD1Database;
  readonly db: SingleDatabase;
}> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(BASELINE);
  sqlite.exec(`
    INSERT INTO organisation (organisation_id, name, plan, created_at, status)
      VALUES ('${ORGANISATION}', 'Export preset', 'beta', 1, 'active');
    INSERT INTO organisation_placement (organisation_id, placement_epoch, placement_kind, placement_cell_id, location_hint, status, fence_token, created_at, activated_at)
      VALUES ('${ORGANISATION}', 1, 'affinity', 'multi-region-preview', 'wnam', 'active', 'export_fixture_fence', 1, 1);
    INSERT INTO app_user (
      user_id, issuer, subject, email, display_name,
      email_verified, created_at, last_authenticated_at
    ) VALUES ('${CONTROL_IDENTITY}', 'test', 'export-preset', 'export-preset@example.test', 'Export preset', 1, 1, 1);
    INSERT INTO organisation_onboarding (
      organisation_id, environment, lifecycle, capability_profile,
      configuration_version, projection_revision, updated_at
    ) VALUES ('${ORGANISATION}', 'development', 'configuring', 'read_and_propose', 3, 7, 1);
  `);
  const wrapper = new SqliteD1Database(sqlite);
  return { sqlite, wrapper, db: wrapper as unknown as SingleDatabase };
}

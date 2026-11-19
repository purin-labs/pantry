import { createActiveOrganisationFixture } from "./fixtures/organisation-activation";
import { describe, expect, it } from "vitest";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { startCommerceWorker } from "./commerce-fixture-worker";

import type {
  CommerceCursor,
  CommerceCursorPayload,
  CommerceEntity,
  CommerceGraphQuery,
  CommerceGraphQueryResult,
  CommerceQueryPlan,
  CommerceReadWatermark,
  SystemCommerceEntityKind,
  SourceProvenance,
} from "@seams/contracts";
import {
  CommerceEntityPlaneClient,
  parseCommerceGraphQuery,
  parseCommerceSnapshotRevision,
} from "@seams/commerce-client";

import { createCommerceProjectionSchema } from "../src/actors/commerce-projection";
import { OrganisationDO } from "../src/actors/organisation";
import { materializeCommerceRelationText } from "../src/actors/commerce-query-schema";
import { compileCommerceQuerySql } from "@seams/commerce-query-sqlite";
import {
  NORMALIZED_CONFORMANCE_CASES,
  NORMALIZED_CONFORMANCE_EDGES,
  NORMALIZED_CONFORMANCE_LIFECYCLE_IDS,
  NORMALIZED_CONFORMANCE_ORDER_PAGE_IDS,
  NORMALIZED_CONFORMANCE_ROWS,
  normalizedConformancePlanInput,
  type NormalizedConformanceRow,
} from "@seams/commerce-query-sqlite/normalized-conformance";
import { buildSavedSelectorCommerceReadAuthority } from "../src/commerce/entity-plane/authority";
import {
  BlotterSource,
  type BlotterOrganisationReader,
} from "../src/commerce/entity-plane/blotter-source";
import {
  CommerceGraphReader,
  type CommerceGraphBlotterSource,
} from "../src/commerce/entity-plane/graph-reader";
import { CommerceEngineSource } from "../src/commerce/entity-plane/commerce-source";
import {
  decodeCommerceCursor,
  encodeCommerceCursor,
  planCommerceGraphQuery,
} from "../src/commerce/commerce-wasm";
import {
  parseCommerceSystemRevision,
  parseShopifyShopDomain,
} from "../src/data/organisation-commerce-system";
import {
  parseCommerceBindingId,
  parseCommerceEngineMerchantId,
} from "../src/data/commerce-merchant-binding";
import { parseIntegrationAccountId, parseOrganisationId } from "../src/ids";

const ORGANISATION_ID = "organisation_entity_plane_parity";
const MERCHANT_ID = "merchant_entity_plane_parity";
const INTEGRATION_ID = "integration_entity_plane_parity";
const NOW = "2026-08-26T00:00:00.000Z";
const OBSERVED_AT = "2026-08-25T00:00:00.000Z";

type SourceMode = "underclerk" | "blotter";

describe("commerce entity-plane reader parity evidence", () => {
  // Commerce runs the same cases over its merchant relations in
  // services/commerce/tests/normalized-conformance.test.ts.
  it.each(NORMALIZED_CONFORMANCE_CASES)(
    "returns the conformance ids for the $name case from the commerce projection",
    (conformanceCase) => {
      const blotter = createNormalizedProjectionStore();
      try {
        const plan = normalizedLexiconPlan(
          parseCommerceGraphQuery(conformanceCase.query),
          conformanceCase.sortableAttributeIds,
          conformanceCase.filterableAttributeIds,
        );
        if (conformanceCase.expected.kind === "count") {
          expect(
            executeNormalizedCount(blotter, "integration_normalized_parity", plan),
          ).toBe(conformanceCase.expected.value);
          return;
        }
        const ids = executeNormalizedPlan(
          blotter,
          "integration_normalized_parity",
          plan,
        ).map((row) => String(row.entity_id));
        const { ids: expected, bounded } = conformanceCase.expected;
        if (bounded === true) {
          expect(ids.slice(0, expected.length)).toEqual(expected);
          expect(ids.length).toBeLessThanOrEqual(expected.length + 1);
        } else {
          expect(ids).toEqual(expected);
        }
      } finally {
        blotter.database.close();
      }
    },
  );

  it("executes actual Underclerk and OrganisationDO stores through the Reader, preserves ownership, and rejects mismatched cursors, outside-matrix operators and a mutated continuation", async () => {
    const native = await createActualReaderFixture("underclerk");
    const provider = await createActualReaderFixture("blotter");
    try {
      for (const fixture of [native, provider]) {
        const counts =
          fixture.mode === "underclerk"
            ? fixture.underclerkEntityCounts
            : fixture.blotter.storage
                .exec<Readonly<{ projection_kind: string; count: number }>>(
                  `SELECT entity_type AS projection_kind, COUNT(*) AS count
                 FROM commerce_entity
                 WHERE merchant_id = ?
                GROUP BY projection_kind
                ORDER BY projection_kind`,
                  INTEGRATION_ID,
                )
                .toArray();
        expect(counts).toEqual(
          fixture.mode === "underclerk"
            ? [
                { entityType: "order", count: 4 },
                { entityType: "production_batch", count: 2 },
                { entityType: "shipment", count: 3 },
              ]
            : [
                { projection_kind: "order", count: 4 },
                { projection_kind: "production_batch", count: 2 },
                { projection_kind: "shipment", count: 3 },
              ],
        );
        const first = await read(fixture, pageQuery(2, null));
        expect(first.ok, `${fixture.mode}: ${JSON.stringify(first)}`).toBe(
          true,
        );
        if (!first.ok) continue;
        expect(first.value.entities.map(entityId)).toEqual(
          NORMALIZED_CONFORMANCE_ORDER_PAGE_IDS.slice(0, 2),
        );
        expectSystemHydrationEvidence(first.value, fixture.mode, [
          { entityId: "order_tie_a", displayName: "Café" },
          { entityId: "order_tie_b", displayName: "Café" },
        ]);
        const nextCursor = requiredCursor(first.value.nextCursor);
        const decoded = decodeCommerceCursor(nextCursor);
        expect(decoded.ok).toBe(true);
        if (decoded.ok) {
          expect(decoded.value.organisationId).toBe(ORGANISATION_ID);
          expect(decoded.value.merchantId).toBe(MERCHANT_ID);
          expect(decoded.value.boundary.entityRef.entityId).toBe("order_tie_b");
        }
        await expectCursorMismatches(fixture, nextCursor);
        await expectOutsideMatrixRefusals(fixture);
        const second = await read(fixture, pageQuery(2, nextCursor));
        expect(second.ok).toBe(true);
        if (second.ok) {
          expect(second.value.entities.map(entityId)).toEqual(
            NORMALIZED_CONFORMANCE_ORDER_PAGE_IDS.slice(2),
          );
          expect(second.value.nextCursor).toBeNull();
        }
        const firstScan = await read(fixture, searchQuery("Straße", 1));
        expect(firstScan.ok).toBe(true);
        if (firstScan.ok) {
          expect(firstScan.value.entities.map(entityId)).toEqual([
            "order_export",
          ]);
          const scanCursor = requiredCursor(firstScan.value.nextCursor);
          const secondScan = await read(
            fixture,
            searchQuery("Straße", 1, scanCursor),
          );
          expect(
            secondScan.ok,
            `${fixture.mode}: ${JSON.stringify(secondScan)}`,
          ).toBe(true);
          if (secondScan.ok) {
            expect(secondScan.value.entities.map(entityId)).toEqual([
              "order_missing_attribute",
            ]);
            expect(secondScan.value.nextCursor).toBeNull();
          }
        }
      }

      for (const fixture of [native, provider]) {
        const exact = await read(fixture, exactQuery("order_export"));
        expect(exact.ok).toBe(true);
        if (exact.ok) {
          expect(exact.value.entities.map(entityId)).toEqual(["order_export"]);
          expectSystemHydrationEvidence(exact.value, fixture.mode, [
            { entityId: "order_export", displayName: "Straße" },
          ]);
        }
        expect(await read(fixture, exactQuery("order_absent"))).toMatchObject({
          ok: true,
          value: { entities: [] },
        });
        const internalMissing = await read(
          fixture,
          exactQuery("order_missing_attribute"),
        );
        expect(internalMissing.ok).toBe(true);
        if (internalMissing.ok) {
          expect(
            internalMissing.value.entities[0]?.attributes.some(
              (attribute) => attribute.attributeId === "ext_restricted_note",
            ),
          ).toBe(false);
        }
        const restrictedMissing = await readRestricted(
          fixture,
          exactQuery("order_missing_attribute"),
        );
        expect(restrictedMissing.ok).toBe(true);
        if (restrictedMissing.ok) {
          expect(
            restrictedMissing.value.entities[0]?.attributes,
          ).toContainEqual(
            expect.objectContaining({
              attributeId: "ext_restricted_note",
              sensitivity: "restricted",
              value: { kind: "short_text", value: "private parity note" },
            }),
          );
        }

        const scan = await read(fixture, searchQuery("Café", 4));
        expect(scan.ok).toBe(true);
        if (scan.ok)
          expect(scan.value.entities.map(entityId)).toEqual([
            "order_tie_a",
            "order_tie_b",
          ]);
        const expandedFoldScan = await read(fixture, searchQuery("STRASSE", 4));
        expect(expandedFoldScan.ok).toBe(true);
        if (expandedFoldScan.ok)
          expect(expandedFoldScan.value.entities.map(entityId)).toEqual([
            "order_export",
            "order_missing_attribute",
          ]);
        const nonLatinScan = await read(
          fixture,
          searchQueryForType("東京", "shipment", 4),
        );
        expect(nonLatinScan.ok).toBe(true);
        if (nonLatinScan.ok)
          expect(nonLatinScan.value.entities.map(entityId)).toEqual([
            "shipment_export",
          ]);

        const count = await read(fixture, unfilteredCountQuery());
        expect(count.ok).toBe(true);
        if (count.ok)
          expect(count.value.aggregations).toEqual([
            { kind: "count", value: 4n },
          ]);

        const context = await read(fixture, actualExportContextQuery());
        expect(context.ok, `${fixture.mode}: ${JSON.stringify(context)}`).toBe(
          true,
        );
        if (context.ok) {
          expect(context.value.entities.map(entityIdentity).sort()).toEqual([
            "custom:export_document:export_document_é",
            "custom:trade_partner:trade_partner_東京",
            "system:order:order_export",
            "system:production_batch:production_batch_export",
            "system:shipment:shipment_export",
          ]);
          expect(
            context.value.relationships
              .map((relationship) => relationship.definition.definitionId)
              .sort(),
          ).toEqual([
            "order_shipment",
            "shipment_export_document",
            "shipment_production_batch",
            "trade_partner_order",
          ]);
          expect(context.value.listEntries).toHaveLength(1);
          expect(context.value.listEntries[0]?.entityRef.entityId).toBe(
            "shipment_export",
          );
          expect(
            context.value.listEntries[0]?.attributeValues
              .map((attribute) => attribute.attributeId)
              .sort(),
          ).toEqual([
            "due_at",
            "exception_reason",
            "owner",
            "priority",
            "stage",
          ]);
          expectSystemHydrationEvidence(context.value, fixture.mode, [
            { entityId: "order_export", displayName: "Straße" },
            { entityId: "shipment_export", displayName: "東京" },
            {
              entityId: "production_batch_export",
              displayName: "Production batch production_batch_export",
            },
          ]);
        }
        const list = await read(fixture, listPageQuery());
        expect(list.ok).toBe(true);
        if (list.ok) {
          expect(list.value.entities.map(entityId)).toEqual([
            "shipment_export",
            "shipment_three",
            "shipment_two",
          ]);
          expect(
            list.value.listEntries[0]?.attributeValues
              .map((attribute) => attribute.attributeId)
              .sort(),
          ).toEqual(
            ["stage", "owner", "due_at", "priority", "exception_reason"].sort(),
          );
          expectListEntryTimestamps(list.value, [
            "2026-08-25T00:00:00.000Z",
            "2026-08-27T00:00:00.000Z",
            "2026-08-26T00:00:00.000Z",
          ]);
        }
        const savedView = await read(fixture, savedViewQuery());
        expect(
          savedView.ok,
          `${fixture.mode}: ${JSON.stringify(savedView)}`,
        ).toBe(true);
        if (savedView.ok) {
          expect(savedView.value.entities.map(entityId)).toEqual([
            "shipment_export",
            "shipment_two",
            "shipment_three",
          ]);
          expectListEntryTimestamps(savedView.value, [
            "2026-08-25T00:00:00.000Z",
            "2026-08-26T00:00:00.000Z",
            "2026-08-27T00:00:00.000Z",
          ]);
        }
        const customTraversal = await read(
          fixture,
          actualCustomTraversalQuery(),
        );
        expect(
          customTraversal.ok,
          `${fixture.mode}: ${JSON.stringify(customTraversal)}`,
        ).toBe(true);
        if (customTraversal.ok)
          expect(customTraversal.value.entities.map(entityId)).toEqual([
            "trade_partner_東京",
            "order_export",
          ]);
        const orderShipmentTraversal = await read(
          fixture,
          actualOrderShipmentTraversalQuery(),
        );
        expect(
          orderShipmentTraversal.ok,
          `${fixture.mode}: ${JSON.stringify(orderShipmentTraversal)}`,
        ).toBe(true);
        if (orderShipmentTraversal.ok)
          expect(orderShipmentTraversal.value.entities.map(entityId)).toEqual([
            "order_export",
            "shipment_export",
          ]);
        const shipmentBatchTraversal = await read(
          fixture,
          actualShipmentBatchTraversalQuery(),
        );
        expect(
          shipmentBatchTraversal.ok,
          `${fixture.mode}: ${JSON.stringify(shipmentBatchTraversal)}`,
        ).toBe(true);
        if (shipmentBatchTraversal.ok)
          expect(shipmentBatchTraversal.value.entities.map(entityId)).toEqual([
            "shipment_export",
            "production_batch_export",
          ]);

        const first = await read(fixture, pageQuery(2, null));
        expect(first.ok).toBe(true);
        if (!first.ok) continue;
        const cursor = requiredCursor(first.value.nextCursor);
        const scanFirst = await read(fixture, searchQuery("strasse", 1));
        expect(scanFirst.ok).toBe(true);
        if (!scanFirst.ok) continue;
        const scanCursor = requiredCursor(scanFirst.value.nextCursor);
        if (fixture.mode === "underclerk") await fixture.mutateMerchantRevision();
        else fixture.mutateAcceptedProjectionSequence();
        expect(await read(fixture, pageQuery(2, cursor))).toEqual({
          ok: false,
          error: {
            code: "commerce_results_changed",
            expected: fixture.currentWatermark(),
            received: fixture.initialWatermark,
          },
        });
        expect(
          await read(fixture, searchQuery("strasse", 1, scanCursor)),
        ).toEqual({
          ok: false,
          error: {
            code: "commerce_results_changed",
            expected: fixture.currentWatermark(),
            received: fixture.initialWatermark,
          },
        });
      }
    } finally {
      await native.close();
      await provider.close();
    }
  });
});

function createNormalizedProjectionStore(): ReturnType<typeof emptySqliteFixture> {
  const blotter = emptySqliteFixture();
  const blotterSql = sqlStorage(blotter.storage);
  createCommerceProjectionSchema(blotterSql);
  for (const row of NORMALIZED_CONFORMANCE_ROWS) {
    const projectionKind =
      row.entityType === "order" ? "commerce_order" : row.entityType;
    const projection = projectionForNormalizedRow(row);
    blotterSql.exec(
      `INSERT INTO commerce_projection (
         organisation_id, projection_kind, canonical_id, integration_account_id,
         revision, lifecycle, projection_json, updated_at, lab_run_id
       ) VALUES (?, ?, ?, ?, 1, 'active', ?, ?, NULL)`,
      ORGANISATION_ID,
      projectionKind,
      row.entityId,
      "integration_normalized_parity",
      JSON.stringify(projection),
      row.updatedAt,
    );
    const text = materializeCommerceRelationText(
      row.displayName,
      row.displayName,
    );
    if (!text.ok) throw new Error(text.error.code);
    blotterSql.exec(
      `INSERT INTO commerce_projection_relation_text (
         organisation_id, projection_kind, canonical_id, integration_account_id,
         display_name_folded, search_text_folded
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      ORGANISATION_ID,
      projectionKind,
      row.entityId,
      "integration_normalized_parity",
      text.value.displayNameFolded,
      text.value.searchTextFolded,
    );
  }
  for (const [index, edge] of NORMALIZED_CONFORMANCE_EDGES.entries()) {
    insertNormalizedRelationshipSql(
      blotterSql,
      "integration_normalized_parity",
      "order_shipment",
      `system:order_shipment:${edge[0]}:${edge[1]}`,
      "order",
      edge[0],
      "shipment",
      edge[1],
      index + 1,
    );
  }
  for (const entityId of NORMALIZED_CONFORMANCE_LIFECYCLE_IDS) {
    insertNormalizedAttributeSql(
      blotterSql,
      "integration_normalized_parity",
      entityId,
      "open",
    );
  }
  return blotter;
}

type ActualReaderFixture = Readonly<{
  mode: SourceMode;
  reader: CommerceGraphReader;
  underclerkEntityCounts: readonly Readonly<{ entityType: string; count: number }>[];
  blotter: ReturnType<typeof emptySqliteFixture>;
  initialWatermark: CommerceReadWatermark;
  mutateMerchantRevision: () => Promise<void>;
  mutateAcceptedProjectionSequence: () => void;
  currentWatermark: () => CommerceReadWatermark;
  close: () => Promise<void>;
}>;

async function createActualReaderFixture(
  mode: SourceMode,
): Promise<ActualReaderFixture> {
  const commerceEngine = await startCommerceWorker({ now: NOW });
  const seeded = await commerceEngine.fixture<{
    merchantRevision: number;
    entityCounts: readonly Readonly<{ entityType: string; count: number }>[];
  }>(MERCHANT_ID, {
    kind: "entity_plane_parity_corpus",
    organisationId: ORGANISATION_ID,
  });
  const seededMerchantRevision = seeded.merchantRevision;
  const blotter = await createActualBlotterDatabase();
  const organisationId = required(parseOrganisationId(ORGANISATION_ID));
  const integrationAccountId = required(
    parseIntegrationAccountId(INTEGRATION_ID),
  );
  const client = new CommerceEntityPlaneClient({
    baseUrl: commerceEngine.baseUrl,
    serviceToken: commerceEngine.serviceToken,
    fetch: commerceEngine.fetch,
  });
  const commerceEngineSource = new CommerceEngineSource({
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    integrationAccountId: INTEGRATION_ID,
    client,
  });
  const boundCommerce = {
    source: commerceEngineSource.source,
    query: async () => ({
      ok: false as const,
      error: {
        code: "source_invalid" as const,
        source: "underclerk" as const,
        message: "actual parity uses planned reads",
      },
    }),
    queryPlanned: commerceEngineSource.queryPlanned.bind(commerceEngineSource),
    readCapabilityMetadata:
      commerceEngineSource.readCapabilityMetadata.bind(commerceEngineSource),
    readSnapshotRevision:
      commerceEngineSource.readSnapshotRevision.bind(commerceEngineSource),
    readRelationshipStep:
      commerceEngineSource.readRelationshipStep.bind(commerceEngineSource),
    hydrateEntityExtensions:
      commerceEngineSource.hydrateEntityExtensions.bind(commerceEngineSource),
  };
  const blotterOrganisation = actualBlotterOrganisation(blotter.organisation);
  const blotterSource = new BlotterSource({
    organisationId,
    merchantId: MERCHANT_ID,
    integrationAccountId,
    organisation: blotterOrganisation,
    now: () => Date.parse(NOW),
  });
  const boundBlotter: CommerceGraphBlotterSource = {
    source: blotterSource.source,
    readSnapshotRevision:
      blotterSource.readSnapshotRevision.bind(blotterSource),
    queryPlan: blotterSource.queryPlan.bind(blotterSource),
    readRelationshipStep:
      blotterSource.readRelationshipStep.bind(blotterSource),
    hydrateSystemEntities:
      blotterSource.hydrateSystemEntities.bind(blotterSource),
  };
  const reader =
    mode === "underclerk"
      ? new CommerceGraphReader({
          organisationId: ORGANISATION_ID,
          merchantId: MERCHANT_ID,
          commerceSystem: {
            kind: "satyr_commerce",
            organisationId,
            bindingId: required(
              parseCommerceBindingId("underclerk_binding_actual_parity"),
            ),
            merchantId: required(parseCommerceEngineMerchantId(MERCHANT_ID)),
            revision: required(parseCommerceSystemRevision(1)),
          },
          underclerk: boundCommerce,
        })
      : new CommerceGraphReader({
          organisationId: ORGANISATION_ID,
          merchantId: MERCHANT_ID,
          commerceSystem: {
            kind: "shopify",
            organisationId,
            integrationAccountId,
            shopDomain: required(
              parseShopifyShopDomain("actual-parity.myshopify.com"),
            ),
            revision: required(parseCommerceSystemRevision(1)),
          },
          underclerk: boundCommerce,
          blotter: boundBlotter,
        });
  return {
    mode,
    reader,
    underclerkEntityCounts: seeded.entityCounts,
    blotter,
    initialWatermark:
      mode === "underclerk"
        ? {
            kind: "underclerk_native",
            merchantRevision: parseCommerceSnapshotRevision(
              seededMerchantRevision,
              "merchantRevision",
            ),
          }
        : {
            kind: "provider_backed",
            blotterAcceptedProjectionSequence: parseCommerceSnapshotRevision(
              1,
              "blotterAcceptedProjectionSequence",
            ),
            underclerkExtensionMerchantRevision: parseCommerceSnapshotRevision(
              seededMerchantRevision,
              "underclerkExtensionMerchantRevision",
            ),
          },
    mutateMerchantRevision: async () => {
      await commerceEngine.fixture(MERCHANT_ID, {
        kind: "advance_merchant_revision",
      });
    },
    mutateAcceptedProjectionSequence: () => {
      blotter.storage.exec(
        `UPDATE commerce_projection_watermark
            SET accepted_projection_sequence = 2
          WHERE organisation_id = ? AND integration_account_id = ?`,
        ORGANISATION_ID,
        INTEGRATION_ID,
      );
    },
    currentWatermark: () =>
      mode === "underclerk"
        ? {
            kind: "underclerk_native",
            merchantRevision: parseCommerceSnapshotRevision(
              seededMerchantRevision + 1,
              "merchantRevision",
            ),
          }
        : {
            kind: "provider_backed",
            blotterAcceptedProjectionSequence: parseCommerceSnapshotRevision(
              2,
              "blotterAcceptedProjectionSequence",
            ),
            underclerkExtensionMerchantRevision: parseCommerceSnapshotRevision(
              seededMerchantRevision,
              "underclerkExtensionMerchantRevision",
            ),
          },
    close: async () => {
      await commerceEngine.dispose();
      blotter.database.close();
    },
  };
}

async function createActualBlotterDatabase(): Promise<ReturnType<
  typeof emptySqliteFixture
> & { readonly organisation: OrganisationDO }> {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  const ctx = {
    storage: {
      sql,
      transactionSync: fixture.storage.transactionSync.bind(fixture.storage),
    },
  } as unknown as DurableObjectState;
  const organisation = await createActiveOrganisationFixture(
    ctx,
    required(parseOrganisationId(ORGANISATION_ID)),
  );
  sql.exec(
    `INSERT INTO organisation_meta (organisation_id, name, plan, status, created_at)
     VALUES (?, 'Actual parity', 'beta', 'active', 1)`,
    ORGANISATION_ID,
  );
  for (const row of NORMALIZED_CONFORMANCE_ROWS) {
    const projection = actualBlotterProjection(row);
    const projectionKind =
      row.entityType === "order" ? "commerce_order" : row.entityType;
    const lifecycle =
      row.entityType === "order"
        ? "confirmed"
        : row.entityType === "shipment"
          ? "in_transit"
          : "completed";
    sql.exec(
      `INSERT INTO commerce_projection (
         organisation_id, projection_kind, canonical_id, integration_account_id,
         revision, lifecycle, projection_json, updated_at, validated_at, lab_run_id
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
      ORGANISATION_ID,
      projectionKind,
      row.entityId,
      INTEGRATION_ID,
      lifecycle,
      JSON.stringify(projection),
      row.updatedAt,
      row.updatedAt,
    );
    const relationDisplayName =
      row.entityType === "production_batch"
        ? `Production batch ${row.entityId}`
        : row.displayName;
    const text = materializeCommerceRelationText(
      relationDisplayName,
      relationDisplayName,
    );
    if (!text.ok) throw new Error(text.error.code);
    sql.exec(
      `INSERT INTO commerce_projection_relation_text (
         organisation_id, projection_kind, canonical_id, integration_account_id,
         display_name_folded, search_text_folded
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      ORGANISATION_ID,
      projectionKind,
      row.entityId,
      INTEGRATION_ID,
      text.value.displayNameFolded,
      text.value.searchTextFolded,
    );
  }
  for (const [index, edge] of NORMALIZED_CONFORMANCE_EDGES.entries()) {
    insertNormalizedRelationshipSql(
      sql,
      INTEGRATION_ID,
      "order_shipment",
      `system:order_shipment:${edge[0]}:${edge[1]}`,
      "order",
      edge[0],
      "shipment",
      edge[1],
      index + 1,
      {
        organisationId: ORGANISATION_ID,
        integrationAccountId: INTEGRATION_ID,
        source: "shopify",
        resourceType: "commerce_order",
        resourceId: edge[0],
        revision: 1,
        occurredAt: OBSERVED_AT,
        observedAt: OBSERVED_AT,
      },
    );
  }
  for (const [index, edge] of (
    [
      ["shipment_export", "production_batch_export"],
      ["shipment_two", "production_batch_two"],
    ] as const
  ).entries()) {
    insertNormalizedRelationshipSql(
      sql,
      INTEGRATION_ID,
      "shipment_production_batch",
      `system:shipment_production_batch:${edge[0]}:${edge[1]}`,
      "shipment",
      edge[0],
      "production_batch",
      edge[1],
      NORMALIZED_CONFORMANCE_EDGES.length + index + 1,
      {
        organisationId: ORGANISATION_ID,
        integrationAccountId: INTEGRATION_ID,
        source: "shopify",
        resourceType: "production_batch",
        resourceId: edge[1],
        revision: 1,
        occurredAt: OBSERVED_AT,
        observedAt: OBSERVED_AT,
      },
    );
  }
  sql.exec(
    `INSERT INTO commerce_projection_watermark (organisation_id, integration_account_id, accepted_projection_sequence, updated_at)
     VALUES (?, ?, 1, 1)`,
    ORGANISATION_ID,
    INTEGRATION_ID,
  );
  return { ...fixture, organisation };
}

function actualBlotterOrganisation(organisation: OrganisationDO): BlotterOrganisationReader {
  return {
    readCommerceQueryPlan: (input) => organisation.readCommerceQueryPlan(input),
    readAcceptedCommerceProjectionSequence: (input) =>
      organisation.readAcceptedCommerceProjectionSequence(input),
    readCommerceRelationshipStep: (input) =>
      organisation.readCommerceRelationshipStep(input),
    readExactCommerceProjectionReference: (input) =>
      organisation.readExactCommerceProjectionReference(input),
  };
}

function normalizedLexiconPlan(
  query: CommerceGraphQuery,
  sortableAttributeIds: readonly string[] = [],
  filterableAttributeIds: readonly string[] = [],
): CommerceQueryPlan {
  const planned = planCommerceGraphQuery(
    normalizedConformancePlanInput(
      query,
      { organisationId: ORGANISATION_ID, merchantId: "merchant_normalized_parity" },
      sortableAttributeIds,
      filterableAttributeIds,
    ),
  );
  if (!planned.ok || planned.value.kind !== "planned")
    throw new Error("normalized parity query was not planned");
  return planned.value.plan;
}

function projectionForNormalizedRow(
  row: NormalizedConformanceRow,
): Readonly<Record<string, unknown>> {
  if (row.entityType === "order") {
    return {
      kind: "commerce_order",
      projection: {
        title: row.displayName,
        buyer: { kind: "guest" },
        lifecycle: {
          state:
            row.entityId === "order_missing_attribute" ? "cancelled" : "open",
        },
      },
    };
  }
  if (row.entityType === "shipment") {
    return {
      kind: "shipment",
      projection: {
        name: row.displayName,
        kind: "external",
        trackingNumber: row.entityId,
        orderId: "order_tie_a",
        fulfillmentId: "fulfillment",
        lifecycle: { state: "in_transit" },
        provenance: provenanceFor("shipment", row.entityId),
        events: [],
      },
    };
  }
  return {
    kind: "production_batch",
    projection: {
      name: row.displayName,
      productionBatchId: row.entityId,
      demand: { kind: "shipment", shipmentId: "shipment_export" },
      recipeId: "recipe",
      recipeRevision: 1,
      locationId: "location",
      stationId: "station",
      revision: 1,
      plannedYield: { amount: 1, scale: 0, unit: "each" },
      actualYield: { amount: 1, scale: 0, unit: "each" },
      completedAt: OBSERVED_AT,
      inputMovementIds: [],
      outputMovementId: "movement",
      outputLotId: "lot",
      provenance: provenanceFor("production_batch", row.entityId),
    },
  };
}

function actualBlotterProjection(row: NormalizedConformanceRow): unknown {
  const provenance: SourceProvenance = {
    ...provenanceFor(row.entityType, row.entityId),
    source: "shopify",
  };
  switch (row.entityType) {
    case "order":
      return {
        kind: "commerce_order",
        projection: orderProjection(provenance, row.displayName),
      };
    case "shipment":
      return {
        kind: "shipment",
        projection: shipmentProjection(provenance, row.displayName),
      };
    case "production_batch":
      return {
        kind: "production_batch",
        projection: productionBatchProjection(provenance, row.entityId),
      };
  }
}

function insertNormalizedRelationshipSql(
  storage: ReturnType<typeof sqlStorage>,
  merchantId: string,
  definitionId: string,
  relationshipId: string,
  sourceType: string,
  sourceId: string,
  targetType: string,
  targetId: string,
  revision: number,
  provenance: unknown = {},
): void {
  storage.exec(
    `INSERT INTO commerce_relationship_relation_index (
       merchant_id, relationship_origin, relationship_id, relationship_revision,
       definition_origin, definition_id, definition_revision, sensitivity,
       source_origin, source_type_id, source_entity_id,
       target_origin, target_type_id, target_entity_id, payload_json, provenance_json
     ) VALUES (?, 'system', ?, ?, 'system', ?, 1, 'internal', 'system', ?, ?, 'system', ?, ?, ?, ?)`,
    merchantId,
    relationshipId,
    revision,
    definitionId,
    sourceType,
    sourceId,
    targetType,
    targetId,
    JSON.stringify({ relationshipId, relationshipRevision: revision }),
    JSON.stringify(provenance),
  );
}

function insertNormalizedAttributeSql(
  storage: ReturnType<typeof sqlStorage>,
  merchantId: string,
  entityId: string,
  value: string,
): void {
  storage.exec(
    `INSERT INTO commerce_entity_attribute_relation_index (
       merchant_id, subject_kind, entity_origin, entity_type, entity_id,
       list_id, entry_id, entity_revision, attribute_id, definition_revision,
       value_kind, comparable_text, comparable_integer, comparable_real, comparable_boolean
     ) VALUES (?, 'entity', 'system', 'order', ?, '', '', 1, 'lifecycle', 1, 'status', ?, NULL, NULL, NULL)`,
    merchantId,
    entityId,
    value,
  );
}

function executeNormalizedPlan(
  storage: ReturnType<typeof emptySqliteFixture>,
  ownerId: string,
  plan: CommerceQueryPlan,
): readonly Record<string, SqlStorageValue>[] {
  const compiled = compileCommerceQuerySql({ ownerId, plan });
  if (compiled.kind !== "compiled")
    throw new Error(
      `normalized parity plan unsupported: ${compiled.capability.kind}`,
    );
  return storage.storage
    .exec<Record<string, SqlStorageValue>>(
      compiled.statement.sql,
      ...compiled.statement.bindings.map(normalizedSqlBinding),
    )
    .toArray();
}

function executeNormalizedCount(
  storage: ReturnType<typeof emptySqliteFixture>,
  ownerId: string,
  plan: CommerceQueryPlan,
): number {
  const rows = executeNormalizedPlan(storage, ownerId, plan);
  return Number(rows[0]?.aggregate_count ?? -1);
}

function normalizedSqlBinding(
  value: string | number | bigint | null,
): string | number | null {
  return typeof value === "bigint" ? Number(value) : value;
}

async function read(
  fixture: Pick<ActualReaderFixture, "reader">,
  query: CommerceGraphQuery,
) {
  return readAtSensitivity(
    fixture,
    query,
    query.kind === "aggregation" ? "restricted" : "internal",
  );
}

async function readRestricted(
  fixture: Pick<ActualReaderFixture, "reader">,
  query: CommerceGraphQuery,
) {
  return readAtSensitivity(fixture, query, "restricted");
}

async function readAtSensitivity(
  fixture: Pick<ActualReaderFixture, "reader">,
  query: CommerceGraphQuery,
  sensitivityCeiling: "internal" | "restricted",
) {
  const selectorId =
    query.kind === "underclerk_context" && query.selection.kind === "selector"
      ? query.selection.selector.selectorId
      : "selector_entity_plane_parity";
  const selectorRevision =
    query.kind === "underclerk_context" && query.selection.kind === "selector"
      ? query.selection.selector.revision
      : 1;
  const authorityQuery =
    query.kind === "underclerk_context" && query.selection.kind === "selector"
      ? query.selection.selector.query
      : query;
  const authority = buildSavedSelectorCommerceReadAuthority({
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    principalId: "principal_entity_plane_parity",
    sensitivityCeiling,
    expiresAt: "2026-08-27T00:00:00.000Z",
    commandId: "command_entity_plane_parity",
    selectorId,
    selectorRevision,
    query: authorityQuery,
  });
  if (!authority.ok) throw new Error(authority.error.reason);
  return fixture.reader.query({ query, authority: authority.value, now: NOW });
}

function provenanceFor(
  typeId: SystemCommerceEntityKind,
  entityId: string,
): SourceProvenance {
  const resourceType = typeId === "order" ? "commerce_order" : typeId;
  return {
    organisationId: ORGANISATION_ID,
    integrationAccountId: INTEGRATION_ID,
    source: "underclerk",
    resourceType,
    resourceId: entityId,
    revision: 1,
    occurredAt: OBSERVED_AT,
    observedAt: OBSERVED_AT,
  };
}

function orderProjection(
  provenance: SourceProvenance,
  customerReference: string,
): unknown {
  return {
    provenance,
    origin: {
      kind: "agent",
      salesChannelId: "sales",
      caseId: "case",
      externalReference: "external",
    },
    buyer: { kind: "identified", customerReference },
    lineItems: [],
    totals: moneyTotals(),
    adjustments: [],
    lifecycle: { state: "confirmed", confirmedAt: OBSERVED_AT },
  };
}

function shipmentProjection(
  provenance: SourceProvenance,
  trackingNumber: string,
): unknown {
  return {
    kind: "external",
    provenance,
    orderId: "order_export",
    fulfillmentId: "fulfillment_export",
    carrier: "Carrier",
    trackingNumber,
    estimatedDeliveryAt: OBSERVED_AT,
    lifecycle: { state: "in_transit", since: OBSERVED_AT },
    events: [],
  };
}

function productionBatchProjection(
  provenance: SourceProvenance,
  entityId: string,
): unknown {
  const quantity = { amount: 1, scale: 0, unit: "each" };
  return {
    provenance,
    productionBatchId: entityId,
    demand: { kind: "shipment", shipmentId: "shipment_export" },
    recipeId: "recipe_export",
    recipeRevision: 1,
    locationId: "location_export",
    stationId: "station_export",
    revision: 1,
    plannedYield: quantity,
    actualYield: quantity,
    completedAt: OBSERVED_AT,
    inputMovementIds: [],
    outputMovementId: "movement_export",
    outputLotId: "lot_export",
  };
}

function moneyTotals() {
  const money = { amountMinor: 0, currency: "JPY" };
  return {
    subtotal: money,
    discount: money,
    tax: money,
    duty: money,
    shipping: money,
    serviceFee: money,
    tip: money,
    rounding: money,
    total: money,
  };
}

function pageQuery(
  limit: number,
  cursor: CommerceCursor | null,
): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "entity_type_page",
    entityTypeId: { origin: "system", typeId: "order" },
    filter: { kind: "all" },
    sorts: [],
    pagination: { limit, cursor },
    traversal: { maxDepth: 0, resultLimit: limit },
  });
}

function searchQuery(
  text: string,
  limit = 8,
  cursor: CommerceCursor | null = null,
): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "search",
    text,
    entityTypeId: { origin: "system", typeId: "order" },
    pagination: { limit, cursor },
    traversal: { maxDepth: 0, resultLimit: limit },
  });
}

function searchQueryForType(
  text: string,
  typeId: SystemCommerceEntityKind,
  limit: number,
  cursor: CommerceCursor | null = null,
): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "search",
    text,
    entityTypeId: { origin: "system", typeId },
    pagination: { limit, cursor },
    traversal: { maxDepth: 0, resultLimit: limit },
  });
}

function exactQuery(entityId: string): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "entity_by_ref",
    reference: { origin: "system", typeId: "order", entityId },
    traversal: { maxDepth: 0, resultLimit: 1 },
  });
}

function actualCustomTraversalQuery(): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "relationship_traversal",
    seeds: [
      {
        origin: "custom",
        typeId: "trade_partner",
        entityId: "trade_partner_東京",
      },
    ],
    relationshipDefinition: {
      origin: "custom",
      definitionId: "trade_partner_order",
      revision: 1,
    },
    traversal: { maxDepth: 1, resultLimit: 4 },
    filter: null,
  });
}

function actualOrderShipmentTraversalQuery(): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "relationship_traversal",
    seeds: [{ origin: "system", typeId: "order", entityId: "order_export" }],
    relationshipDefinition: {
      origin: "system",
      definitionId: "order_shipment",
      revision: 1,
    },
    traversal: { maxDepth: 1, resultLimit: 4 },
    filter: null,
  });
}

function actualShipmentBatchTraversalQuery(): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "relationship_traversal",
    seeds: [
      { origin: "system", typeId: "shipment", entityId: "shipment_export" },
    ],
    relationshipDefinition: {
      origin: "system",
      definitionId: "shipment_production_batch",
      revision: 1,
    },
    traversal: { maxDepth: 1, resultLimit: 4 },
    filter: null,
  });
}

function listPageQuery(): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "commerce_list_page",
    listId: "export_coordination",
    filter: { kind: "all" },
    sorts: [],
    pagination: { limit: 20, cursor: null },
  });
}

function savedViewQuery(): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "saved_commerce_view",
    viewId: "export_board",
    pagination: { limit: 20, cursor: null },
  });
}

function unfilteredCountQuery(): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "aggregation",
    source: {
      kind: "entity_type",
      entityTypeId: { origin: "system", typeId: "order" },
    },
    filter: { kind: "all" },
    aggregation: { kind: "count" },
  });
}

function actualExportContextQuery(): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "underclerk_context",
    selection: {
      kind: "selector",
      selector: {
        selectorId: "export_board",
        revision: 1,
        query: {
          kind: "saved_commerce_view",
          viewId: "export_board",
          pagination: { limit: 1, cursor: null },
        },
      },
    },
    traversal: { maxDepth: 2, resultLimit: 20 },
    allowedSensitivity: "internal",
    allowedAttributeIds: [
      "stage",
      "owner",
      "due_at",
      "priority",
      "exception_reason",
    ],
    freshnessRequirement: "any",
  });
}

function ageBucketsQuery(): CommerceGraphQuery {
  return parseCommerceGraphQuery({
    kind: "aggregation",
    source: {
      kind: "entity_type",
      entityTypeId: { origin: "system", typeId: "order" },
    },
    filter: { kind: "all" },
    aggregation: {
      kind: "age_buckets",
      attributeId: "lifecycle",
      bucketDays: [1, 6, 7, 29, 30],
    },
  });
}

function unsupportedMatrixQueries(): readonly CommerceGraphQuery[] {
  const value = { kind: "status" as const, value: "open" };
  const attributeQueries = [
    "less_than",
    "less_than_or_equal",
    "greater_than",
    "greater_than_or_equal",
    "contains",
  ] as const;
  return [
    ...attributeQueries.map((operator) =>
      parseCommerceGraphQuery({
        kind: "entity_type_page",
        entityTypeId: { origin: "system", typeId: "order" },
        filter: {
          kind: "attribute",
          filter: { operator, attributeId: "unsupported_attribute", value },
        },
        sorts: [],
        pagination: { limit: 4, cursor: null },
        traversal: { maxDepth: 0, resultLimit: 4 },
      }),
    ),
    parseCommerceGraphQuery({
      kind: "aggregation",
      source: {
        kind: "entity_type",
        entityTypeId: { origin: "system", typeId: "order" },
      },
      filter: { kind: "all" },
      aggregation: { kind: "grouped_count", attributeId: "lifecycle" },
    }),
    parseCommerceGraphQuery({
      kind: "aggregation",
      source: {
        kind: "entity_type",
        entityTypeId: { origin: "system", typeId: "order" },
      },
      filter: { kind: "all" },
      aggregation: { kind: "sum", attributeId: "lifecycle" },
    }),
    parseCommerceGraphQuery({
      kind: "aggregation",
      source: {
        kind: "entity_type",
        entityTypeId: { origin: "system", typeId: "order" },
      },
      filter: { kind: "all" },
      aggregation: { kind: "minimum", attributeId: "lifecycle" },
    }),
    parseCommerceGraphQuery({
      kind: "aggregation",
      source: {
        kind: "entity_type",
        entityTypeId: { origin: "system", typeId: "order" },
      },
      filter: { kind: "all" },
      aggregation: { kind: "maximum", attributeId: "lifecycle" },
    }),
    parseCommerceGraphQuery({
      kind: "aggregation",
      source: {
        kind: "entity_type",
        entityTypeId: { origin: "system", typeId: "order" },
      },
      filter: { kind: "all" },
      aggregation: { kind: "oldest_due_date", attributeId: "lifecycle" },
    }),
    ageBucketsQuery(),
    parseCommerceGraphQuery({
      kind: "search",
      text: "open",
      entityTypeId: null,
      pagination: { limit: 4, cursor: null },
      traversal: { maxDepth: 0, resultLimit: 4 },
    }),
  ];
}

function required<T>(
  value: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!value.ok)
    throw new Error(
      value.error instanceof Error
        ? value.error.message
        : JSON.stringify(value.error),
    );
  return value.value;
}
function entityId(entity: CommerceEntity): string {
  return String(entity.reference.entityId);
}
function entityIdentity(entity: CommerceEntity): string {
  return `${entity.reference.origin}:${entity.reference.typeId}:${entity.reference.entityId}`;
}

function expectSystemHydrationEvidence(
  result: CommerceGraphQueryResult,
  mode: SourceMode,
  expectedEntities: readonly Readonly<{
    entityId: string;
    displayName: string;
  }>[],
): void {
  const systemEntities: Extract<
    CommerceEntity,
    { reference: { origin: "system" } }
  >[] = [];
  for (const entity of result.entities) {
    if (isSystemCommerceEntity(entity)) systemEntities.push(entity);
  }
  for (const expectedEntity of expectedEntities) {
    let matched:
      Extract<CommerceEntity, { reference: { origin: "system" } }> | undefined;
    for (const entity of systemEntities) {
      if (String(entity.reference.entityId) === expectedEntity.entityId)
        matched = entity;
    }
    expect(
      matched,
      `${mode}: missing exact hydration for ${expectedEntity.entityId}`,
    ).toBeDefined();
    if (matched === undefined) continue;
    expect(matched.revision).toBe(1);
    expect(matched.displayName).toBe(expectedEntity.displayName);
    expect(matched.provenance).toMatchObject({
      organisationId: ORGANISATION_ID,
      integrationAccountId: INTEGRATION_ID,
      source: mode === "blotter" ? "shopify" : "underclerk",
      resourceId: expectedEntity.entityId,
      revision: 1,
    });
    expect(Number.isNaN(Date.parse(matched.provenance.occurredAt))).toBe(false);
    expect(Number.isNaN(Date.parse(matched.provenance.observedAt))).toBe(false);
    expect(["current", "stale"]).toContain(matched.freshness.state);
    if (matched.freshness.state === "unavailable") continue;
    expect(matched.freshness.observedAt).toBe(matched.provenance.observedAt);
    if (matched.freshness.state === "stale") {
      expect(Number.isNaN(Date.parse(matched.freshness.staleSince))).toBe(
        false,
      );
    }
  }
  const entityProvenance: SourceProvenance[] = [];
  const entityFreshness: CommerceGraphQueryResult["freshness"][number][] = [];
  for (const entity of result.entities) {
    if (!isSystemCommerceEntity(entity)) continue;
    entityProvenance.push(entity.provenance);
    entityFreshness.push(entity.freshness);
  }
  expect(result.provenance).toEqual(entityProvenance);
  const uniqueFreshness: CommerceGraphQueryResult["freshness"][number][] = [];
  const freshnessKeys = new Set<string>();
  for (const freshness of entityFreshness) {
    const key = JSON.stringify(freshness);
    if (freshnessKeys.has(key)) continue;
    freshnessKeys.add(key);
    uniqueFreshness.push(freshness);
  }
  const uniqueResultFreshness: CommerceGraphQueryResult["freshness"][number][] =
    [];
  const resultFreshnessKeys = new Set<string>();
  for (const freshness of result.freshness) {
    const key = JSON.stringify(freshness);
    if (resultFreshnessKeys.has(key)) continue;
    resultFreshnessKeys.add(key);
    uniqueResultFreshness.push(freshness);
  }
  expect(uniqueResultFreshness).toEqual(uniqueFreshness);
}

function isSystemCommerceEntity(
  entity: CommerceEntity,
): entity is Extract<CommerceEntity, { reference: { origin: "system" } }> {
  return (
    entity.reference.origin === "system" &&
    "provenance" in entity &&
    "freshness" in entity
  );
}

function expectListEntryTimestamps(
  result: CommerceGraphQueryResult,
  expectedTimestamps: readonly string[],
): void {
  const timestamps: string[] = [];
  for (const entry of result.listEntries) {
    let timestamp: string | undefined;
    for (const attribute of entry.attributeValues) {
      if (
        attribute.attributeId === "due_at" &&
        attribute.value.kind === "timestamp"
      ) {
        timestamp = attribute.value.value;
      }
    }
    if (timestamp === undefined)
      throw new Error(`Commerce List entry ${entry.entryId} is missing due_at`);
    timestamps.push(timestamp);
  }
  expect(timestamps).toEqual(expectedTimestamps);
}
function requiredCursor(cursor: CommerceCursor | null): CommerceCursor {
  if (cursor === null)
    throw new Error("expected an opaque continuation cursor");
  return cursor;
}
function requiredDecodedCursor(cursor: CommerceCursor): CommerceCursorPayload {
  const decoded = decodeCommerceCursor(cursor);
  if (!decoded.ok) throw new Error(decoded.error.code);
  return decoded.value;
}

async function expectCursorMismatches(
  fixture: ActualReaderFixture,
  cursor: CommerceCursor,
): Promise<void> {
  expect(await read(fixture, pageQuery(3, cursor))).toEqual({
    ok: false,
    error: { code: "commerce_cursor_mismatch", reason: "query_fingerprint" },
  });
  const payload = requiredDecodedCursor(cursor);
  expect(encodeCommerceCursor({ ...payload, orderingVersion: "v2" }).ok).toBe(
    false,
  );
  const effectiveOrdering = {
    ...payload.effectiveOrdering,
    leadingKeys: payload.effectiveOrdering.leadingKeys.map((key) => ({
      ...key,
      direction: key.direction === "ascending" ? "descending" : "ascending",
    })),
  };
  const otherWatermark: CommerceReadWatermark =
    fixture.initialWatermark.kind === "underclerk_native"
      ? {
          kind: "provider_backed",
          blotterAcceptedProjectionSequence: parseCommerceSnapshotRevision(
            1,
            "blotterAcceptedProjectionSequence",
          ),
          underclerkExtensionMerchantRevision: parseCommerceSnapshotRevision(
            1,
            "underclerkExtensionMerchantRevision",
          ),
        }
      : {
          kind: "underclerk_native",
          merchantRevision: parseCommerceSnapshotRevision(
            1,
            "merchantRevision",
          ),
        };
  const mismatches: readonly Readonly<{ payload: unknown; reason: string }>[] =
    [
      {
        payload: { ...payload, organisationId: "organisation_other" },
        reason: "organisation",
      },
      {
        payload: { ...payload, merchantId: "merchant_other" },
        reason: "merchant",
      },
      {
        payload: { ...payload, effectiveOrdering },
        reason: "effective_ordering",
      },
      {
        payload: { ...payload, watermark: otherWatermark },
        reason: "watermark_kind",
      },
    ];
  for (const mismatch of mismatches) {
    const changed = encodeCommerceCursor(mismatch.payload);
    if (!changed.ok) throw new Error(changed.error.code);
    expect(
      await read(fixture, pageQuery(2, changed.value)),
      `${fixture.mode}: ${mismatch.reason}`,
    ).toEqual({
      ok: false,
      error: { code: "commerce_cursor_mismatch", reason: mismatch.reason },
    });
  }
}

async function expectOutsideMatrixRefusals(
  fixture: ActualReaderFixture,
): Promise<void> {
  for (const [index, query] of unsupportedMatrixQueries().entries()) {
    expect(
      await read(fixture, query),
      `${fixture.mode}: outside-matrix case ${index}`,
    ).toMatchObject({
      ok: false,
      error: {
        code:
          index < 5
            ? "commerce_query_unsupported"
            : "commerce_query_surface_unsupported",
      },
    });
  }
}

import { createActiveOrganisationFixture } from "./fixtures/organisation-activation";
import { describe, expect, it } from "vitest";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { startCommerceWorker } from "./commerce-fixture-worker";

import type {
  CommerceCursor,
  CommerceCursorPayload,
  CommerceEntity,
  CommerceEntityRef,
  SystemCommerceEntityRef,
  CommerceGraphQuery,
  CommerceGraphQueryResult,
  CommerceListEntry,
  CommerceOrderingValue,
  CommerceProjection,
  CommerceQueryPlan,
  CommerceReadWatermark,
  CommerceRelationship,
  SystemCommerceEntityKind,
  SourceProvenance,
} from "@seams/contracts";
import {
  CommerceEntityPlaneClient,
  parseCustomCommerceRelationshipRef,
  parseCommerceGraphQuery,
  parseCommerceGraphQueryPlanRequest,
  parseCommerceGraphResponse,
  parseEntityPlaneCapabilityMetadataRequest,
  parseEntityPlaneCapabilityMetadataResponse,
  parseCommerceQueryPlanOutcome,
  parseRelationshipId,
  parseCommerceSnapshotRevision,
  parseRelationshipDefinitionRevision,
  parseRelationshipRevision,
  type CommerceEntityPlaneFetch,
} from "@seams/commerce-client";

import type { CommerceProjectionRecord } from "../src/actors/commerce-projection";
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
import type {
  CommerceEntityRelationRow,
  CommerceRelationshipRelationRow,
} from "../src/actors/commerce-query-schema";
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
import type { Variant } from "@seams/type-utils";
import { isRecord } from "@seams/std";

const ORGANISATION_ID = "organisation_entity_plane_parity";
const MERCHANT_ID = "merchant_entity_plane_parity";
const INTEGRATION_ID = "integration_entity_plane_parity";
const NOW = "2026-08-26T00:00:00.000Z";
const OBSERVED_AT = "2026-08-25T00:00:00.000Z";

type SourceMode = "underclerk" | "blotter";
type CorpusEntity = Readonly<{
  entity: CommerceEntity;
  updatedAt: number;
  searchText: string;
  projection: CommerceProjectionRecord | null;
}>;
type Corpus = Readonly<{
  entities: readonly CorpusEntity[];
  relationships: readonly CommerceRelationship[];
  listEntries: readonly CommerceListEntry[];
}>;
type MutableFixture = {
  corpus: Corpus;
  merchantRevision: number;
  blotterRevision: number;
};
type ReaderFixture = Readonly<{
  mode: SourceMode;
  state: MutableFixture;
  reader: CommerceGraphReader;
}>;

const MODES: readonly SourceMode[] = ["underclerk", "blotter"];

describe("commerce entity-plane reader parity evidence", () => {
  it.each(MODES)(
    "%s rejects a changed query and an opaque cursor after a mid-pagination mutation",
    async (mode) => {
      const fixture = createFixture(mode);
      const first = await read(fixture, pageQuery(2, null));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const cursor = requiredCursor(first.value.nextCursor);
      expect(await read(fixture, pageQuery(3, cursor))).toEqual({
        ok: false,
        error: {
          code: "commerce_cursor_mismatch",
          reason: "query_fingerprint",
        },
      });

      mutateCorpus(fixture.state, mode);
      expect(await read(fixture, pageQuery(2, cursor))).toEqual({
        ok: false,
        error: {
          code: "commerce_results_changed",
          expected: mutatedWatermark(mode),
          received: currentWatermark(mode, 1),
        },
      });
    },
  );

  it.each(MODES)(
    "%s rejects cursor organisation, ordering, effective-ordering, and watermark-owner mismatches",
    async (mode) => {
      const fixture = createFixture(mode);
      const first = await read(fixture, pageQuery(2, null));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const cursor = requiredCursor(first.value.nextCursor);
      const payload = requiredDecodedCursor(cursor);

      const organisationCursor = encodeCommerceCursor({
        ...payload,
        organisationId: "organisation_other",
      });
      expect(organisationCursor.ok).toBe(true);
      if (organisationCursor.ok)
        expect(await read(fixture, pageQuery(2, organisationCursor.value))).toEqual({
          ok: false,
          error: { code: "commerce_cursor_mismatch", reason: "organisation" },
        });

      const merchantCursor = encodeCommerceCursor({
        ...payload,
        merchantId: "merchant_other",
      });
      expect(merchantCursor.ok).toBe(true);
      if (merchantCursor.ok)
        expect(await read(fixture, pageQuery(2, merchantCursor.value))).toEqual(
          {
            ok: false,
            error: { code: "commerce_cursor_mismatch", reason: "merchant" },
          },
        );

      const effectiveOrdering = {
        ...payload.effectiveOrdering,
        leadingKeys: payload.effectiveOrdering.leadingKeys.map((key) => ({
          ...key,
          direction: key.direction === "ascending" ? "descending" : "ascending",
        })),
      };
      const effectiveOrderingCursor = encodeCommerceCursor({
        ...payload,
        effectiveOrdering,
      });
      expect(effectiveOrderingCursor.ok).toBe(true);
      if (effectiveOrderingCursor.ok)
        expect(
          await read(fixture, pageQuery(2, effectiveOrderingCursor.value)),
        ).toEqual({
          ok: false,
          error: {
            code: "commerce_cursor_mismatch",
            reason: "effective_ordering",
          },
        });

      const orderingVersionCursor = encodeCommerceCursor({
        ...payload,
        orderingVersion: "v2",
      });
      expect(orderingVersionCursor.ok).toBe(false);

      const ownerCursor = encodeCommerceCursor({
        ...payload,
        watermark:
          mode === "underclerk"
            ? {
                kind: "provider_backed",
                blotterAcceptedProjectionSequence: 1,
                underclerkExtensionMerchantRevision: 1,
              }
            : { kind: "underclerk_native", merchantRevision: 1 },
      });
      expect(ownerCursor.ok).toBe(true);
      if (ownerCursor.ok)
        expect(await read(fixture, pageQuery(2, ownerCursor.value))).toEqual({
          ok: false,
          error: { code: "commerce_cursor_mismatch", reason: "watermark_kind" },
        });
    },
  );

  it.each(MODES)(
    "%s returns typed unsupported outcomes for every outside-matrix operator family",
    async (mode) => {
      const fixture = createFixture(mode);
      for (const [index, query] of unsupportedMatrixQueries().entries()) {
        const result = await read(fixture, query);
        const expectedCode =
          index < 5
            ? "commerce_query_unsupported"
            : "commerce_query_surface_unsupported";
        expect(result, `outside-matrix case ${index}`).toMatchObject({
          ok: false,
          error: { code: expectedCode },
        });
      }
    },
  );

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

  it("executes actual Underclerk and OrganisationDO stores through the Reader, preserves ownership, and rejects a mutated continuation", async () => {
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
  const corpus = buildCorpus();
  for (const row of NORMALIZED_CONFORMANCE_ROWS) {
    const stored = corpus.entities.find(
      ({ entity }) =>
        entity.reference.origin === "system" &&
        entity.reference.entityId === row.entityId,
    )?.projection;
    if (stored === null || stored === undefined)
      throw new Error(`missing actual projection ${row.entityId}`);
    const projection = actualBlotterProjection(row, stored.projection);
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

function actualBlotterProjection(
  row: NormalizedConformanceRow,
  projection: CommerceProjection,
): CommerceProjection {
  switch (row.entityType) {
    case "order":
      if (projection.kind !== "commerce_order")
        throw new Error(
          `actual order projection changed kind: ${projection.kind}`,
        );
      return {
        ...projection,
        projection: {
          ...projection.projection,
          buyer: { kind: "identified", customerReference: row.displayName },
        },
      };
    case "shipment":
      if (
        projection.kind !== "shipment" ||
        projection.projection.kind !== "external"
      ) {
        throw new Error(
          `actual shipment projection changed kind: ${projection.kind}`,
        );
      }
      return {
        ...projection,
        projection: {
          ...projection.projection,
          trackingNumber: row.displayName,
        },
      };
    case "production_batch":
      if (projection.kind !== "production_batch")
        throw new Error(
          `actual production-batch projection changed kind: ${projection.kind}`,
        );
      return projection;
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

function createFixture(mode: SourceMode): ReaderFixture {
  const state: MutableFixture = {
    corpus: buildCorpus(),
    merchantRevision: 1,
    blotterRevision: 1,
  };
  const organisationId = required(parseOrganisationId(ORGANISATION_ID));
  const integrationAccountId = required(
    parseIntegrationAccountId(INTEGRATION_ID),
  );
  const client = new CommerceEntityPlaneClient({
    baseUrl: "https://underclerk.entity-plane.test",
    serviceToken: "parity-test-token",
    fetch: commerceFetch(state, mode),
  });
  const commerceEngine = new CommerceEngineSource({
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    integrationAccountId: INTEGRATION_ID,
    client,
  });
  const boundCommerce = {
    source: commerceEngine.source,
    query: async () => ({
      ok: false as const,
      error: {
        code: "source_invalid" as const,
        source: "underclerk" as const,
        message: "Parity uses planned Underclerk reads",
      },
    }),
    queryPlanned: commerceEngine.queryPlanned.bind(commerceEngine),
    readCapabilityMetadata: commerceEngine.readCapabilityMetadata.bind(commerceEngine),
    readSnapshotRevision: commerceEngine.readSnapshotRevision.bind(commerceEngine),
    readRelationshipStep: commerceEngine.readRelationshipStep.bind(commerceEngine),
    hydrateEntityExtensions:
      commerceEngine.hydrateEntityExtensions.bind(commerceEngine),
  };
  if (mode === "underclerk") {
    const commerceSystem = {
      kind: "satyr_commerce" as const,
      organisationId,
      bindingId: required(
        parseCommerceBindingId("underclerk_binding_entity_plane_parity"),
      ),
      merchantId: required(parseCommerceEngineMerchantId(MERCHANT_ID)),
      revision: required(parseCommerceSystemRevision(1)),
    };
    return {
      mode,
      state,
      reader: new CommerceGraphReader({
        organisationId: ORGANISATION_ID,
        merchantId: MERCHANT_ID,
        commerceSystem,
        underclerk: boundCommerce,
      }),
    };
  }
  const blotter = new BlotterSource({
    organisationId,
    merchantId: MERCHANT_ID,
    integrationAccountId,
    organisation: blotterOrganisation(state),
    now: () => Date.parse(NOW),
  });
  const boundBlotter: CommerceGraphBlotterSource = {
    source: blotter.source,
    readSnapshotRevision: blotter.readSnapshotRevision.bind(blotter),
    queryPlan: blotter.queryPlan.bind(blotter),
    readRelationshipStep: blotter.readRelationshipStep.bind(blotter),
    hydrateSystemEntities: blotter.hydrateSystemEntities.bind(blotter),
  };
  const commerceSystem = {
    kind: "shopify" as const,
    organisationId,
    integrationAccountId,
    shopDomain: required(
      parseShopifyShopDomain("entity-plane-parity.myshopify.com"),
    ),
    revision: required(parseCommerceSystemRevision(1)),
  };
  return {
    mode,
    state,
    reader: new CommerceGraphReader({
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
      commerceSystem,
      underclerk: boundCommerce,
      blotter: boundBlotter,
    }),
  };
}

async function read(
  fixture: Pick<ReaderFixture, "mode" | "reader">,
  query: CommerceGraphQuery,
) {
  return readAtSensitivity(
    fixture,
    query,
    query.kind === "aggregation" ? "restricted" : "internal",
  );
}

async function readRestricted(
  fixture: Pick<ReaderFixture, "mode" | "reader">,
  query: CommerceGraphQuery,
) {
  return readAtSensitivity(fixture, query, "restricted");
}

async function readAtSensitivity(
  fixture: Pick<ReaderFixture, "mode" | "reader">,
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

function commerceFetch(
  state: MutableFixture,
  mode: SourceMode,
): CommerceEntityPlaneFetch {
  return async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body =
      init?.body === undefined
        ? null
        : (JSON.parse(String(init.body)) as unknown);
    try {
      if (path.endsWith("/system-extensions"))
        return jsonResponse(extensionResponse(state, body));
      if (path.endsWith("/capability-metadata")) {
        const response = capabilityMetadataResponse(state, body);
        return response instanceof Response ? response : jsonResponse(response);
      }
      if (path.endsWith("/query-plan"))
        return jsonResponse(commercePlanResponse(state, body));
      if (path.endsWith("/relationship-step"))
        return jsonResponse(commerceRelationshipResponse(state, mode, body));
    } catch (error) {
      return new Response(
        JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
        }),
        { status: 500 },
      );
    }
    return new Response(
      JSON.stringify({ message: `unexpected Underclerk path ${path}` }),
      { status: 404 },
    );
  };
}

function capabilityMetadataResponse(
  state: MutableFixture,
  body: unknown,
): unknown {
  const request = parseEntityPlaneCapabilityMetadataRequest(body);
  const capabilities =
    request.query.kind === "commerce_list_page"
      ? {
          kind: "commerce_list" as const,
          listId: request.query.listId,
          listRevision: 1,
          capability: {
            filterableAttributeIds: [],
            sortableAttributeIds: [],
            aggregation: { kind: "count_only" as const },
          },
        }
      : request.query.kind === "saved_commerce_view"
        ? {
            kind: "saved_commerce_view" as const,
            viewId: request.query.viewId,
            viewRevision: 1,
            source: {
              kind: "commerce_list" as const,
              listId: "export_coordination",
              listRevision: 1,
              capability: {
                filterableAttributeIds: [],
                sortableAttributeIds: [],
                aggregation: { kind: "count_only" as const },
              },
            },
            filter: { kind: "all" as const },
            sorts: [],
          }
        : request.query.kind === "aggregation" &&
            request.query.source.kind === "commerce_list"
          ? {
              kind: "commerce_list" as const,
              listId: request.query.source.listId,
              listRevision: 1,
              capability: {
                filterableAttributeIds: [],
                sortableAttributeIds: [],
                aggregation: { kind: "count_only" as const },
              },
            }
          : request.query.kind === "relationship_traversal" &&
              request.query.seeds[0]?.origin === "custom"
            ? {
                kind: "underclerk_custom" as const,
                entityTypeId: request.query.seeds[0].typeId,
                publishedRevision: 1,
                capability: {
                  filterableAttributeIds: [],
                  sortableAttributeIds: [],
                  aggregation: { kind: "count_only" as const },
                },
              }
            : {
                kind: "system_mapped" as const,
                systemEntityKind: "order" as const,
                systemSchemaRevision: 1,
                capability: {
                  filterableAttributeIds: ["lifecycle"],
                  sortableAttributeIds: ["lifecycle", "optional_all_null"],
                  aggregation: { kind: "count_only" as const },
                },
              };
  const response = parseCommerceGraphQueryPlanRequest({
    query: request.query,
    semantics: {
      semanticsVersion: "v1",
      orderingVersion: "v1",
      textNormalization: "commerce_unicode_v1",
      nullPlacement: "last",
    },
    projection: {
      attributeIds: [],
      relationshipDefinitions: [],
      includeProvenance: true,
      includeFreshness: true,
    },
    organisationId: request.organisationId,
    merchantId: request.merchantId,
    watermark: {
      kind: "underclerk_native",
      merchantRevision: state.merchantRevision,
    },
    capabilities,
  });
  return parseEntityPlaneCapabilityMetadataResponse({
    kind: "capability_metadata",
    organisationId: request.organisationId,
    merchantId: request.merchantId,
    merchantRevision: state.merchantRevision,
    watermark: {
      kind: "underclerk_native",
      merchantRevision: state.merchantRevision,
    },
    capabilities: response.capabilities,
    projection: response.projection,
  });
}

function commercePlanResponse(state: MutableFixture, body: unknown): unknown {
  const request = parseCommerceGraphQueryPlanRequest(body);
  const planned = planCommerceGraphQuery(request);
  if (!planned.ok) throw new Error(planned.error.code);
  if (planned.value.kind !== "planned") return planned.value;
  const plan = planned.value.plan;
  if (plan.operation.kind === "aggregation") {
    return {
      kind: "planned",
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
      merchantRevision: state.merchantRevision,
      plan,
      result: resultForEntities(
        state,
        [],
        null,
        [],
        [],
        [
          {
            kind: "count",
            value: BigInt(
              referenceEntities(state.corpus, request.query).length,
            ),
          },
        ],
      ),
      hasMore: false,
    };
  }
  const listEntries = isListQuery(request.query)
    ? pageListEntries(state.corpus, request.query, plan)
    : [];
  const entities = pageEntities(state.corpus, request.query, plan);
  const limit = Number(plan.limit);
  const retained = entities.slice(0, limit);
  const retainedListEntries = listEntries.slice(0, limit);
  const hasMore = entities.length > retained.length;
  const nextCursor = hasMore ? cursorForEntity(plan, retained.at(-1)) : null;
  return {
    kind: "planned",
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    merchantRevision: state.merchantRevision,
    plan,
    result: resultForEntities(
      state,
      retained,
      nextCursor,
      [],
      retainedListEntries,
    ),
    hasMore,
  };
}

function commerceRelationshipResponse(
  state: MutableFixture,
  mode: SourceMode,
  body: unknown,
): unknown {
  if (!isRecord(body)) throw new Error("relationship request is not an object");
  const plan = parsePlan(body.plan);
  if (plan === null) throw new Error("relationship plan did not parse");
  const frontier = parseRefs(body.frontier);
  const accepted = state.corpus.relationships.filter((relationship) => {
    if (mode === "blotter" && relationship.origin === "system") return false;
    return frontier.some(
      (reference) =>
        sameRef(reference, relationship.source) ||
        sameRef(reference, relationship.target),
    );
  });
  const entities = state.corpus.entities.filter(
    ({ entity }) =>
      (mode === "underclerk" || entity.reference.origin === "custom") &&
      (accepted.some(
        (relationship) =>
          sameRef(entity.reference, relationship.source) ||
          sameRef(entity.reference, relationship.target),
      ) ||
        frontier.some((reference) => sameRef(reference, entity.reference))),
  );
  return {
    kind: "planned",
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    merchantRevision: state.merchantRevision,
    plan,
    result: resultForEntities(state, entities, null, accepted),
    hasMore: false,
  };
}

function extensionResponse(state: MutableFixture, body: unknown): unknown {
  const requested =
    isRecord(body) && Array.isArray(body.entityRefs) ? body.entityRefs : [];
  const sidecars = state.corpus.entities
    .filter(
      ({ entity }) =>
        entity.reference.origin === "system" &&
        requested.some(
          (reference) =>
            isEntityRef(reference) && sameRef(reference, entity.reference),
        ),
    )
    .map(({ entity }) => {
      if (entity.reference.origin !== "system")
        throw new Error("extension sidecar requires a system entity");
      const hasPriority =
        entity.reference.typeId === "order" &&
        entity.reference.entityId === "order_export";
      return {
        entityRef: entity.reference,
        extension: hasPriority
          ? { state: "published", revision: 1 }
          : { state: "absent" },
        attributes: hasPriority
          ? [
              extensionAttribute(
                "ext_priority",
                "high",
                entity.reference.typeId,
              ),
            ]
          : [],
      };
    });
  return {
    merchantId: MERCHANT_ID,
    merchantRevision: state.merchantRevision,
    sidecars,
  };
}

function blotterOrganisation(state: MutableFixture): BlotterOrganisationReader {
  return {
    readAcceptedCommerceProjectionSequence: async () => ({
      ok: true,
      value: state.blotterRevision,
    }),
    readCommerceQueryPlan: async (input) => {
      const parsedPlan = parsePlan(input.plan);
      if (parsedPlan === null)
        throw new Error(
          `blotter plan parser returned null: ${String(input.plan)}`,
        );
      const plan = parsedPlan;
      const query = parseCommerceGraphQueryPlanRequest(input.planRequest).query;
      if (plan.operation.kind === "aggregation") {
        return {
          ok: true,
          value: {
            kind: "count",
            aggregation: {
              kind: "count",
              value: BigInt(referenceEntities(state.corpus, query).length),
            },
          },
        };
      }
      const rows = pageEntities(state.corpus, query, plan)
        .filter(({ entity }) => entity.reference.origin === "system")
        .map((entry) => relationRow(entry, INTEGRATION_ID));
      const retained = rows.slice(0, Number(plan.limit));
      const records = retained.flatMap((row) =>
        projectionFor(state.corpus, row.entity_type, row.entity_id),
      );
      return {
        ok: true,
        value: {
          kind: "rows",
          rows: retained,
          records,
          hasMore: rows.length > retained.length,
        },
      };
    },
    readCommerceRelationshipStep: async (input) => ({
      ok: true,
      value: state.corpus.relationships
        .filter(
          (relationship) =>
            relationship.origin === "system" &&
            input.frontier.some(
              (reference) =>
                sameRef(reference, relationship.source) ||
                sameRef(reference, relationship.target),
            ),
        )
        .map(relationshipRow),
    }),
    readExactCommerceProjectionReference: async (input) => ({
      ok: true,
      value:
        state.corpus.entities.find(
          ({ entity, projection }) =>
            entity.reference.origin === "system" &&
            String(entity.reference.entityId) === input.canonicalId &&
            projection !== null,
        )?.projection ?? null,
    }),
  };
}

function parsePlan(value: unknown): CommerceQueryPlan | null {
  if (!isRecord(value)) return null;
  let outcome;
  try {
    outcome = parseCommerceQueryPlanOutcome({ kind: "planned", plan: value });
  } catch (error) {
    throw new Error(
      `plan parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return outcome.kind === "planned" ? outcome.plan : null;
}

function pageEntities(
  corpus: Corpus,
  query: CommerceGraphQuery,
  plan: CommerceQueryPlan,
): readonly CorpusEntity[] {
  const candidates = referenceEntities(corpus, query);
  const boundary = plan.boundary;
  if (boundary === null) return candidates;
  const index = candidates.findIndex(({ entity }) =>
    sameRef(entity.reference, boundary.entityRef),
  );
  return index < 0 ? [] : candidates.slice(index + 1);
}

function pageListEntries(
  corpus: Corpus,
  query: CommerceGraphQuery,
  plan: CommerceQueryPlan,
): readonly CommerceListEntry[] {
  const entries = corpus.listEntries
    .filter((entry) => {
      if (query.kind === "commerce_list_page")
        return query.listId === entry.listId;
      if (query.kind === "saved_commerce_view")
        return entry.listId === "export_coordination";
      return false;
    })
    .filter(
      (entry) =>
        query.kind !== "commerce_list_page" ||
        entry.entityRef.origin !== "system" ||
        applyRelationshipFilter(
          [
            corpus.entities.find(({ entity }) =>
              sameRef(entity.reference, entry.entityRef),
            ),
          ].filter((entry): entry is CorpusEntity => entry !== undefined),
          query.filter,
          corpus.relationships,
        ).length > 0,
    );
  const boundary = plan.boundary;
  if (boundary === null) return entries;
  const index = entries.findIndex((entry) =>
    sameRef(entry.entityRef, boundary.entityRef),
  );
  return index < 0 ? [] : entries.slice(index + 1);
}

function referenceEntities(
  corpus: Corpus,
  query: CommerceGraphQuery,
): readonly CorpusEntity[] {
  let entities: readonly CorpusEntity[] = corpus.entities.filter(
    ({ entity }) =>
      entity.reference.origin === "system" &&
      entity.reference.typeId === "order",
  );
  switch (query.kind) {
    case "entity_by_ref":
      entities = entities.filter(({ entity }) =>
        sameRef(entity.reference, query.reference),
      );
      break;
    case "search":
      entities = entities.filter(({ searchText }) =>
        fold(searchText).includes(fold(query.text)),
      );
      break;
    case "entity_type_page":
      if (
        query.entityTypeId.origin !== "system" ||
        query.entityTypeId.typeId !== "order"
      )
        return [];
      entities = applyReferenceFilter(entities, query.filter);
      break;
    case "commerce_list_page":
      entities = listEntities(corpus);
      entities = applyRelationshipFilter(
        entities,
        query.filter,
        corpus.relationships,
      );
      break;
    case "saved_commerce_view":
      entities = listEntities(corpus);
      break;
    case "aggregation":
      if (query.source.kind === "commerce_list") {
        entities = listEntities(corpus);
        entities = applyRelationshipFilter(
          entities,
          query.filter,
          corpus.relationships,
        );
      } else if (
        query.source.entityTypeId.origin !== "system" ||
        query.source.entityTypeId.typeId !== "order"
      )
        return [];
      entities = applyReferenceFilter(entities, query.filter);
      break;
    case "underclerk_context": {
      if (query.selection.kind !== "entity_seeds") return [];
      const seeds = query.selection.seeds;
      entities = entities.filter(({ entity }) =>
        seeds.some((seed) => sameRef(seed, entity.reference)),
      );
      break;
    }
    default:
      return [];
  }
  return [...entities].sort((left, right) =>
    compareCorpusEntities(left, right, query),
  );
}

function listEntities(corpus: Corpus): readonly CorpusEntity[] {
  return corpus.listEntries.flatMap(
    (entry) =>
      corpus.entities.find(({ entity }) =>
        sameRef(entity.reference, entry.entityRef),
      ) ?? [],
  );
}

function applyRelationshipFilter(
  entities: readonly CorpusEntity[],
  filter: Variant<CommerceGraphQuery, "commerce_list_page">["filter"],
  relationships: readonly CommerceRelationship[],
): readonly CorpusEntity[] {
  if (filter.kind !== "relationship") return entities;
  return entities.filter(({ entity }) => {
    const exists = relationships.some(
      (relationship) =>
        relationship.definition.origin ===
          filter.filter.relationshipDefinition.origin &&
        relationship.definition.definitionId ===
          filter.filter.relationshipDefinition.definitionId &&
        Number(relationship.definition.revision) ===
          filter.filter.relationshipDefinition.revision &&
        (sameRef(entity.reference, relationship.source) ||
          sameRef(entity.reference, relationship.target)),
    );
    return filter.filter.operator === "exists" ? exists : !exists;
  });
}

function applyReferenceFilter(
  entities: readonly CorpusEntity[],
  filter: Variant<CommerceGraphQuery, "entity_type_page">["filter"],
): readonly CorpusEntity[] {
  if (filter.kind !== "attribute") return entities;
  return entities.filter(({ entity }) => {
    const attribute = entity.attributes.find(
      (entry) => entry.attributeId === filter.filter.attributeId,
    );
    switch (filter.filter.operator) {
      case "is_not_empty":
        return attribute !== undefined;
      case "equals":
        return (
          attribute !== undefined &&
          JSON.stringify(attribute.value) ===
            JSON.stringify(filter.filter.value)
        );
      case "not_equals":
        return (
          attribute === undefined ||
          JSON.stringify(attribute.value) !==
            JSON.stringify(filter.filter.value)
        );
      default:
        return false;
    }
  });
}

function compareCorpusEntities(
  left: CorpusEntity,
  right: CorpusEntity,
  query: CommerceGraphQuery,
): number {
  const sort =
    query.kind === "entity_type_page" || query.kind === "commerce_list_page"
      ? query.sorts[0]
      : undefined;
  if (sort !== undefined) {
    const comparison = compareOrderingValue(
      orderingValue(left, sort.field),
      orderingValue(right, sort.field),
    );
    if (comparison !== 0)
      return sort.direction === "descending" ? -comparison : comparison;
  } else {
    const updated = compareNumber(left.updatedAt, right.updatedAt);
    if (updated !== 0) return -updated;
  }
  return compareUtf8(
    String(left.entity.reference.entityId),
    String(right.entity.reference.entityId),
  );
}

function orderingValue(
  entity: CorpusEntity,
  field: Variant<
    CommerceGraphQuery,
    "entity_type_page"
  >["sorts"][number]["field"],
): CommerceOrderingValue {
  switch (field.kind) {
    case "updated_at":
      return { kind: "integer", value: BigInt(entity.updatedAt) };
    case "display_name":
      return { kind: "text", value: fold(entity.entity.displayName) };
    case "attribute":
      return attributeValueForOrdering(
        entity.entity.attributes.find(
          (entry) => entry.attributeId === field.attributeId,
        )?.value,
      );
    case "created_at":
      return { kind: "null" };
  }
}

function attributeValueForOrdering(
  value: CommerceEntity["attributes"][number]["value"] | undefined,
): CommerceOrderingValue {
  if (value === undefined) return { kind: "null" };
  switch (value.kind) {
    case "short_text":
    case "long_text":
    case "date":
    case "timestamp":
    case "status":
      return { kind: "text", value: value.value };
    case "integer":
      return { kind: "integer", value: value.value };
    case "boolean":
      return { kind: "boolean", value: value.value };
    default:
      return { kind: "null" };
  }
}

function compareOrderingValue(
  left: CommerceOrderingValue,
  right: CommerceOrderingValue,
): number {
  if (left.kind === "null" || right.kind === "null")
    return left.kind === right.kind ? 0 : left.kind === "null" ? 1 : -1;
  if (left.kind !== right.kind) return compareUtf8(left.kind, right.kind);
  switch (left.kind) {
    case "text":
      return compareUtf8(left.value, right.kind === "text" ? right.value : "");
    case "integer":
      return compareBigInt(
        left.value,
        right.kind === "integer" ? right.value : 0n,
      );
    case "boolean":
      return compareNumber(
        left.value ? 1 : 0,
        right.kind === "boolean" && right.value ? 1 : 0,
      );
    default:
      return 0;
  }
}

function resultForEntities(
  state: MutableFixture,
  entries: readonly CorpusEntity[],
  nextCursor: CommerceCursor | null,
  relationships: readonly CommerceRelationship[] = [],
  listEntries: readonly CommerceListEntry[] = [],
  aggregations: CommerceGraphQueryResult["aggregations"] = [],
): CommerceGraphQueryResult {
  const entities = entries.map(({ entity }) => entity);
  return {
    merchantRevision: parseCommerceSnapshotRevision(
      state.merchantRevision,
      "merchantRevision",
    ),
    entities,
    relationships: [...relationships],
    listEntries: [...listEntries],
    aggregations: [...aggregations],
    nextCursor,
    provenance: entities.flatMap(systemEntityProvenance),
    freshness: entities.flatMap(systemEntityFreshness),
  };
}

function systemEntityProvenance(entity: CommerceEntity): SourceProvenance[] {
  const provenance =
    entity.reference.origin === "system" && "provenance" in entity
      ? entity.provenance
      : undefined;
  return provenance === undefined ? [] : [provenance];
}

function systemEntityFreshness(
  entity: CommerceEntity,
): CommerceGraphQueryResult["freshness"] {
  const freshness =
    entity.reference.origin === "system" && "freshness" in entity
      ? entity.freshness
      : undefined;
  return freshness === undefined ? [] : [freshness];
}

function cursorForEntity(
  plan: CommerceQueryPlan,
  entry: CorpusEntity | undefined,
): CommerceCursor {
  if (entry === undefined)
    throw new Error("cannot mint a cursor without a boundary");
  const encoded = encodeCommerceCursor({
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    queryFingerprint: plan.queryFingerprint,
    semanticsVersion: plan.semanticsVersion,
    orderingVersion: plan.orderingVersion,
    effectiveOrdering: plan.effectiveOrdering,
    boundary: {
      entityRef: entry.entity.reference,
      orderingValues: plan.effectiveOrdering.leadingKeys.map((key) =>
        orderingValueForPlan(entry, key.field),
      ),
    },
    watermark: plan.watermark,
  });
  if (!encoded.ok) throw new Error(encoded.error.code);
  return encoded.value;
}

function orderingValueForPlan(
  entry: CorpusEntity,
  field: CommerceQueryPlan["effectiveOrdering"]["leadingKeys"][number]["field"],
): CommerceOrderingValue {
  switch (field.kind) {
    case "updated_at":
      return { kind: "integer", value: BigInt(entry.updatedAt) };
    case "display_name":
      return { kind: "text", value: fold(entry.entity.displayName) };
    case "attribute":
      return attributeValueForOrdering(
        entry.entity.attributes.find(
          (attribute) => attribute.attributeId === field.attributeId,
        )?.value,
      );
    case "created_at":
      return { kind: "null" };
  }
}

function relationRow(
  entry: CorpusEntity,
  owner: string,
): CommerceEntityRelationRow {
  if (entry.entity.reference.origin !== "system")
    throw new Error("Blotter relation rows are system-owned");
  const displayName =
    entry.entity.reference.typeId === "order"
      ? String(entry.entity.reference.entityId)
      : entry.entity.displayName;
  return {
    merchant_id: owner,
    entity_origin: "system",
    entity_type: entry.entity.reference.typeId,
    entity_id: String(entry.entity.reference.entityId),
    revision: Number(entry.entity.revision),
    updated_at: entry.updatedAt,
    display_name: displayName,
    display_name_folded: fold(displayName),
    search_text_folded: fold(displayName),
    payload_json: JSON.stringify(entry.projection?.projection ?? {}),
  };
}

function relationshipRow(
  relationship: CommerceRelationship,
): CommerceRelationshipRelationRow {
  if (
    relationship.origin !== "system" ||
    relationship.source.origin !== "system" ||
    relationship.target.origin !== "system"
  )
    throw new Error("Blotter relationship rows are system-owned");
  return {
    merchant_id: INTEGRATION_ID,
    relationship_origin: "system",
    relationship_id: String(relationship.relationshipId),
    relationship_revision: Number(relationship.revision),
    definition_origin: "system",
    definition_id: relationship.definition.definitionId,
    definition_revision: Number(relationship.definition.revision),
    sensitivity: relationship.sensitivity,
    source_origin: "system",
    source_type_id: relationship.source.typeId,
    source_entity_id: String(relationship.source.entityId),
    target_origin: "system",
    target_type_id: relationship.target.typeId,
    target_entity_id: String(relationship.target.entityId),
    payload_json: JSON.stringify({
      relationshipId: relationship.relationshipId,
      relationshipRevision: relationship.revision,
    }),
    provenance_json: JSON.stringify(relationship.provenance),
  };
}

function projectionFor(
  corpus: Corpus,
  typeId: string,
  entityId: string,
): readonly CommerceProjectionRecord[] {
  return corpus.entities.flatMap(({ entity, projection }) =>
    entity.reference.origin === "system" &&
    String(entity.reference.typeId) === typeId &&
    String(entity.reference.entityId) === entityId &&
    projection !== null
      ? [projection]
      : [],
  );
}

function buildCorpus(): Corpus {
  const orderExport = systemEntity(
    "order",
    "order_export",
    "Straße",
    50,
    "Straße",
    "open",
  );
  const orderTieA = systemEntity(
    "order",
    "order_tie_a",
    "Café",
    80,
    "Café",
    "open",
  );
  const orderTieB = systemEntity(
    "order",
    "order_tie_b",
    "Café",
    80,
    "Café",
    "open",
  );
  const orderMissing = systemEntity(
    "order",
    "order_missing_attribute",
    "STRASSE",
    60,
    "STRASSE",
    null,
  );
  const shipment = systemEntity(
    "shipment",
    "shipment_export",
    "東京",
    40,
    "東京",
    "in_transit",
  );
  const shipmentTwo = systemEntity(
    "shipment",
    "shipment_two",
    "東京 shipment",
    35,
    "東京 shipment",
    "in_transit",
  );
  const shipmentThree = systemEntity(
    "shipment",
    "shipment_three",
    "Straße shipment",
    34,
    "Straße shipment",
    "in_transit",
  );
  const batch = systemEntity(
    "production_batch",
    "production_batch_export",
    "Export batch",
    30,
    "Export batch",
    null,
  );
  const batchTwo = systemEntity(
    "production_batch",
    "production_batch_two",
    "Second batch",
    25,
    "Second batch",
    null,
  );
  const partner = customEntity(
    "trade_partner",
    "trade_partner_東京",
    "東京 Trade Partner",
    "partner",
  );
  const document = customEntity(
    "export_document",
    "export_document_é",
    "Export document é",
    "document",
  );
  const relationships = [
    customRelationship(
      "trade_partner_orders",
      partner.entity.reference,
      orderExport.entity.reference,
      "trade_partner_orders",
    ),
    systemRelationship(
      "order_shipment",
      orderExport.entity.reference,
      shipment.entity.reference,
      "order_shipment",
    ),
    systemRelationship(
      "order_shipment",
      orderTieA.entity.reference,
      shipmentTwo.entity.reference,
      "order_shipment_tie_a",
    ),
    systemRelationship(
      "order_shipment",
      orderTieB.entity.reference,
      shipmentThree.entity.reference,
      "order_shipment_tie_b",
    ),
    customRelationship(
      "shipment_export_documents",
      shipment.entity.reference,
      document.entity.reference,
      "shipment_export_documents",
    ),
    systemRelationship(
      "shipment_production_batch",
      shipment.entity.reference,
      batch.entity.reference,
      "shipment_production_batch",
    ),
    systemRelationship(
      "shipment_production_batch",
      shipmentTwo.entity.reference,
      batchTwo.entity.reference,
      "shipment_production_batch_two",
    ),
  ];
  const listEntries = [
    listEntry("entry_order_tie_a", orderTieA.entity.reference),
    listEntry("entry_order_export", orderExport.entity.reference),
    listEntry("entry_order_missing", orderMissing.entity.reference),
  ];
  return {
    entities: [
      partner,
      orderExport,
      shipment,
      shipmentTwo,
      shipmentThree,
      document,
      batch,
      batchTwo,
      orderTieA,
      orderTieB,
      orderMissing,
    ],
    relationships,
    listEntries,
  };
}

function listEntry(
  entryId: string,
  entityRef: CommerceEntityRef,
): CommerceListEntry {
  const response = parseCommerceGraphResponse({
    merchantRevision: 1,
    entities: [],
    relationships: [],
    listEntries: [
      {
        entryId,
        listId: "export_coordination",
        listRevision: 1,
        entityRef,
        attributeValues: [],
        revision: 1,
      },
    ],
    aggregations: [],
    nextCursor: null,
    provenance: [],
    freshness: [],
  });
  const entry = response.listEntries[0];
  if (entry === undefined) throw new Error("list entry fixture did not parse");
  return entry;
}

function systemEntity(
  typeId: SystemCommerceEntityKind,
  entityId: string,
  displayName: string,
  updatedAt: number,
  searchText: string,
  lifecycle: string | null,
): CorpusEntity {
  const provenance = provenanceFor(typeId, entityId);
  const attributes =
    lifecycle === null ? [] : [systemAttribute(typeId, "lifecycle", lifecycle)];
  if (entityId === "order_missing_attribute")
    attributes.push({
      attributeId: "restricted_note",
      scope: { kind: "system", entityTypeId: typeId, schemaRevision: 1 },
      definitionRevision: 1,
      sensitivity: "restricted",
      value: { kind: "short_text", value: "private" },
    });
  const raw = {
    reference: { origin: "system", typeId, entityId },
    revision: 1,
    displayName,
    attributes,
    provenance,
    freshness: { state: "current", observedAt: OBSERVED_AT },
  };
  return {
    entity: parseEntity(raw),
    updatedAt,
    searchText,
    projection: projectionRecord(typeId, entityId, lifecycle, provenance),
  };
}

function customEntity(
  typeId: string,
  entityId: string,
  displayName: string,
  attributeId: string,
): CorpusEntity {
  const raw = {
    reference: { origin: "custom", typeId, entityId },
    revision: 1,
    displayName,
    attributes: [customAttribute(typeId, attributeId)],
    typeRevision: 1,
    state: { state: "active" },
    sensitivity: "internal",
  };
  return {
    entity: parseEntity(raw),
    updatedAt: 10,
    searchText: displayName,
    projection: null,
  };
}

function parseEntity(raw: unknown): CommerceEntity {
  const response = parseCommerceGraphResponse({
    merchantRevision: 1,
    entities: [raw],
    relationships: [],
    listEntries: [],
    aggregations: [],
    nextCursor: null,
    provenance: [],
    freshness: [],
  });
  const entity = response.entities[0];
  if (entity === undefined) throw new Error("entity fixture did not parse");
  return entity;
}

function systemAttribute(
  typeId: SystemCommerceEntityKind,
  attributeId: string,
  value: string,
) {
  return {
    attributeId,
    scope: { kind: "system", entityTypeId: typeId, schemaRevision: 1 },
    definitionRevision: 1,
    sensitivity: "internal",
    value: { kind: "status", value },
  };
}

function customAttribute(typeId: string, attributeId: string) {
  return {
    attributeId,
    scope: { kind: "custom", entityTypeId: typeId, typeRevision: 1 },
    definitionRevision: 1,
    sensitivity: "internal",
    value: { kind: "short_text", value: "present" },
  };
}

function extensionAttribute(
  attributeId: string,
  value: string,
  typeId: SystemCommerceEntityKind,
) {
  return {
    attributeId,
    scope: {
      kind: "merchant_extension",
      entityTypeId: typeId,
      schemaRevision: 1,
    },
    definitionRevision: 1,
    sensitivity: "internal",
    value: { kind: "short_text", value },
  };
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

function projectionRecord(
  typeId: SystemCommerceEntityKind,
  entityId: string,
  lifecycle: string | null,
  provenance: SourceProvenance,
): CommerceProjectionRecord {
  const kind = typeId === "order" ? "commerce_order" : typeId;
  const providerProvenance: SourceProvenance = {
    ...provenance,
    source: "shopify",
  };
  const projection =
    typeId === "order"
      ? {
          kind: "commerce_order",
          projection: orderProjection(providerProvenance),
        }
      : typeId === "shipment"
        ? {
            kind: "shipment",
            projection: shipmentProjection(providerProvenance, entityId),
          }
        : {
            kind: "production_batch",
            projection: productionBatchProjection(providerProvenance, entityId),
          };
  return {
    organisationId: ORGANISATION_ID,
    kind,
    canonicalId: entityId,
    integrationAccountId: INTEGRATION_ID,
    revision: 1,
    lifecycle: lifecycle ?? "unknown",
    projection,
    updatedAt: 50,
    validatedAt: Date.parse(OBSERVED_AT),
    labRunId: null,
  } as CommerceProjectionRecord;
}

function mutateCorpus(state: MutableFixture, mode: SourceMode): void {
  const inserted = systemEntity(
    "order",
    "order_inserted_mid_page",
    "Inserted mid-page",
    100,
    "Inserted mid-page",
    "open",
  );
  state.corpus = {
    ...state.corpus,
    entities: [...state.corpus.entities, inserted],
  };
  state.merchantRevision = 2;
  if (mode === "blotter") state.blotterRevision = 2;
}

function orderProjection(provenance: SourceProvenance): unknown {
  return {
    provenance,
    origin: {
      kind: "agent",
      salesChannelId: "sales",
      caseId: "case",
      externalReference: "external",
    },
    buyer: { kind: "guest" },
    lineItems: [],
    totals: moneyTotals(),
    adjustments: [],
    lifecycle: { state: "confirmed", confirmedAt: OBSERVED_AT },
  };
}

function shipmentProjection(
  provenance: SourceProvenance,
  entityId: string,
): unknown {
  return {
    kind: "external",
    provenance,
    orderId: "order_export",
    fulfillmentId: "fulfillment_export",
    carrier: "Carrier",
    trackingNumber: `TRACK-${entityId}`,
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

function customRelationship(
  definitionId: string,
  source: CommerceEntityRef,
  target: CommerceEntityRef,
  relationshipId: string,
): CommerceRelationship {
  const reference = parseCustomCommerceRelationshipRef({
    origin: "custom",
    relationshipId,
    definition: { origin: "custom", definitionId, revision: 1 },
    revision: 1,
  });
  return { ...reference, sensitivity: "internal", source, target };
}

function systemRelationship(
  definitionId: string,
  source: CommerceEntityRef,
  target: CommerceEntityRef,
  relationshipId: string,
): CommerceRelationship {
  const systemSource = requireSystemRef(source);
  return {
    origin: "system",
    relationshipId: parseRelationshipId(`system:${relationshipId}`),
    definition: {
      origin: "system",
      definitionId: definitionId as
        "order_shipment" | "shipment_production_batch",
      revision: parseRelationshipDefinitionRevision(1),
    },
    sensitivity: "internal",
    source: systemSource,
    target: requireSystemRef(target),
    revision: parseRelationshipRevision(1),
    provenance: provenanceFor(
      systemSource.typeId,
      String(systemSource.entityId),
    ),
  };
}

function requireSystemRef(
  reference: CommerceEntityRef,
): SystemCommerceEntityRef {
  if (reference.origin !== "system")
    throw new Error("expected a system reference");
  return reference;
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

function isListQuery(query: CommerceGraphQuery): boolean {
  return (
    query.kind === "commerce_list_page" || query.kind === "saved_commerce_view"
  );
}

function currentWatermark(
  mode: SourceMode,
  revision = 1,
): CommerceReadWatermark {
  return mode === "underclerk"
    ? {
        kind: "underclerk_native",
        merchantRevision: parseCommerceSnapshotRevision(
          revision,
          "merchantRevision",
        ),
      }
    : {
        kind: "provider_backed",
        blotterAcceptedProjectionSequence: parseCommerceSnapshotRevision(
          revision,
          "blotterAcceptedProjectionSequence",
        ),
        underclerkExtensionMerchantRevision: parseCommerceSnapshotRevision(
          1,
          "underclerkExtensionMerchantRevision",
        ),
      };
}

function nextWatermark(mode: SourceMode): CommerceReadWatermark {
  return currentWatermark(mode, 2);
}
function mutatedWatermark(mode: SourceMode): CommerceReadWatermark {
  return mode === "underclerk"
    ? nextWatermark(mode)
    : {
        kind: "provider_backed",
        blotterAcceptedProjectionSequence: parseCommerceSnapshotRevision(
          2,
          "blotterAcceptedProjectionSequence",
        ),
        underclerkExtensionMerchantRevision: parseCommerceSnapshotRevision(
          2,
          "underclerkExtensionMerchantRevision",
        ),
      };
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
function jsonResponse(value: unknown): Response {
  return new Response(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === "bigint" ? Number(entry) : entry,
    ),
    { headers: { "content-type": "application/json" } },
  );
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

function parseRefs(value: unknown): CommerceEntityRef[] {
  if (!Array.isArray(value))
    throw new Error("relationship frontier is invalid");
  return value.map((reference) => {
    const response = parseCommerceGraphResponse({
      merchantRevision: 1,
      entities: [
        {
          reference,
          revision: 1,
          displayName: "frontier",
          attributes:
            reference.origin === "system"
              ? [
                  {
                    attributeId: "lifecycle",
                    scope: {
                      kind: "system",
                      entityTypeId: reference.typeId,
                      schemaRevision: 1,
                    },
                    definitionRevision: 1,
                    sensitivity: "internal",
                    value: { kind: "status", value: "open" },
                  },
                ]
              : [],
          ...(reference.origin === "system"
            ? {
                provenance: provenanceFor(
                  reference.typeId,
                  String(reference.entityId),
                ),
                freshness: { state: "current", observedAt: OBSERVED_AT },
              }
            : {
                typeRevision: 1,
                state: { state: "active" },
                sensitivity: "internal",
              }),
        },
      ],
      relationships: [],
      listEntries: [],
      aggregations: [],
      nextCursor: null,
      provenance: [],
      freshness: [],
    });
    const parsed = response.entities[0];
    if (parsed === undefined)
      throw new Error("frontier reference did not parse");
    return parsed.reference;
  });
}

function sameRef(left: CommerceEntityRef, right: CommerceEntityRef): boolean {
  return (
    left.origin === right.origin &&
    left.typeId === right.typeId &&
    left.entityId === right.entityId
  );
}
function fold(value: string): string {
  const normalized = materializeCommerceRelationText(value, value);
  if (!normalized.ok) throw new Error(normalized.error.code);
  return normalized.value.displayNameFolded;
}
function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  for (
    let index = 0;
    index < Math.min(leftBytes.length, rightBytes.length);
    index += 1
  ) {
    const leftByte = leftBytes[index] ?? 0;
    const rightByte = rightBytes[index] ?? 0;
    if (leftByte !== rightByte) return leftByte < rightByte ? -1 : 1;
  }
  return compareNumber(leftBytes.length, rightBytes.length);
}
function compareNumber(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
function compareBigInt(left: bigint, right: bigint): number {
  return left === right ? 0 : left < right ? -1 : 1;
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
function isEntityRef(value: unknown): value is CommerceEntityRef {
  return (
    isRecord(value) &&
    (value.origin === "system" || value.origin === "custom") &&
    typeof value.typeId === "string" &&
    typeof value.entityId === "string"
  );
}

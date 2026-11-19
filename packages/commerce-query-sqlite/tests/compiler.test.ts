import { describe, expect, it } from "vitest";
import type { CommerceQueryPlan } from "@purin-labs/commerce-contracts";
import { planCommerceGraphQuery } from "@purin-labs/commerce-contracts/query-planner";
import type { ContractDecodeResult } from "@purin-labs/commerce-contracts/schema";
import { compileCommerceQuerySql } from "../src/index";
import { parseCommerceQueryPlanOutcome } from "@purin-labs/commerce-client";

describe("commerce SQLite query compiler", () => {
  it("rejects Commerce List count search plans defensively", () => {
    const result = compileCommerceQuerySql({
      ownerId: "merchant_query",
      plan: {
        ...lexiconPlan(
          {
            kind: "aggregation",
            source: { kind: "commerce_list", listId: "export_coordination" },
            aggregation: { kind: "count" },
            filter: { kind: "all" },
          },
          "list",
        ),
        predicate: { kind: "search", foldedText: "urgent" },
      },
    });
    expect(result).toEqual({
      kind: "unsupported",
      capability: { kind: "source_mapping" },
    });
  });

  it("keeps unsupported attribute value operators typed", () => {
    const result = compileCommerceQuerySql({
      ownerId: "merchant_query",
      plan: lexiconPlan(
        {
          kind: "entity_type_page",
          entityTypeId: { origin: "system", typeId: "order" },
          filter: {
            kind: "attribute",
            filter: {
              operator: "contains",
              attributeId: "lifecycle",
              value: { kind: "status", value: "open" },
            },
          },
          sorts: [],
          pagination: { limit: 2, cursor: null },
          traversal: { maxDepth: 0, resultLimit: 25 },
        },
        "system",
        ["lifecycle"],
      ),
    });
    expect(result).toEqual({
      kind: "unsupported",
      capability: { kind: "attribute_filter" },
    });
  });
});

function lexiconPlan(
  query: unknown,
  source: "system" | "custom" | "list" = "system",
  filterableAttributeIds: readonly string[] = [],
  sortableAttributeIds: readonly string[] = [],
): CommerceQueryPlan {
  const capabilities =
    source === "custom"
      ? {
          kind: "underclerk_custom",
          entityTypeId: "trade_partner",
          publishedRevision: 1,
          capability: {
            filterableAttributeIds,
            sortableAttributeIds,
            aggregation: { kind: "count_only" },
          },
        }
      : source === "list"
        ? {
            kind: "commerce_list",
            listId: "export_coordination",
            listRevision: 1,
            capability: {
              filterableAttributeIds: [],
              sortableAttributeIds,
              aggregation: { kind: "count_only" },
            },
          }
        : {
            kind: "system_mapped",
            systemEntityKind: "order",
            systemSchemaRevision: 1,
            capability: {
              filterableAttributeIds,
              sortableAttributeIds,
              aggregation: { kind: "count_only" },
            },
          };
  const response = plannedValue(
    planCommerceGraphQuery(
      jsonValue(
        JSON.stringify({
          query,
          semantics: {
            semanticsVersion: "v1",
            orderingVersion: "v1",
            textNormalization: "commerce_unicode_v1",
            nullPlacement: "last",
          },
          projection: {
            attributeIds: [],
            relationshipDefinitions: [],
            includeProvenance: false,
            includeFreshness: false,
          },
          organisationId: "organisation_query",
          merchantId: "merchant_query",
          watermark: { kind: "underclerk_native", merchantRevision: 1 },
          capabilities,
        }),
      ),
    ),
  );
  const outcome = parseCommerceQueryPlanOutcome(response.value);
  if (outcome.kind !== "planned")
    throw new Error(`Lexicon planner did not produce a plan: ${outcome.kind}`);
  return outcome.plan;
}

function jsonValue(text: string): unknown {
  return JSON.parse(text);
}

function plannedValue(result: ContractDecodeResult<unknown>): {
  value: unknown;
} {
  if (!result.ok)
    throw new Error(`Lexicon planner refused: ${result.error.code}`);
  return { value: result.value };
}

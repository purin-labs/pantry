import type { RequestAuthority } from "@purin-labs/contracts";
import type {
  CommerceGraphQueryResult,
  CommerceSensitivity,
} from "@purin-labs/commerce-contracts";

import type { AccessGrant } from "../../authorization/access-grants/types";
import {
  readNamedCommerceQuery,
  type CommerceContextAssemblyError,
} from "../../context/assembly/commerce";
import { normalizeUntrustedCommerceText } from "../../context/untrusted-commerce-text";
import type { Result } from "../../result";
import type { CommerceGraphReader } from "./graph-reader";
import {
  merchantReportDefinition,
  type MerchantReportName,
  type MerchantReportRecord,
  type MerchantReportResult,
  type MerchantReportUnsupported,
} from "./merchant-reports";

type MerchantReportRunInput = Readonly<{
  organisationId: string;
  merchantId: string;
  grants: readonly AccessGrant[];
  requestAuthority: RequestAuthority;
  causationId: string;
  reader: CommerceGraphReader;
  allowedSensitivity: CommerceSensitivity;
  name: MerchantReportName;
  now: string;
}>;

/**
 * Runs one named report and returns its headline number beside the exact
 * population behind it.
 *
 * The headline and the population are read as two queries over the same
 * filter. When the counted total exceeds what the population lists, the result
 * says so, so a truncated list is never mistaken for the whole set.
 */
export async function runMerchantReport(
  input: MerchantReportRunInput,
): Promise<Result<MerchantReportResult, CommerceContextAssemblyError>> {
  const definition = merchantReportDefinition(input.name);
  if (definition.queries.kind === "unsupported") {
    return {
      ok: true,
      value: {
        kind: "unavailable",
        name: definition.name,
        metric: definition.metric,
        reason: unsupportedReason(definition.queries.reason),
        dependency: definition.queries.dependency,
      },
    };
  }
  const headline = await readNamedCommerceQuery({
    ...input,
    query: definition.queries.headline,
  });
  if (!headline.ok) {
    // A count across a whole entity type is only readable at the restricted
    // ceiling, which scheduled and mailbox authority never carry. Say the
    // number is out of reach for this authority rather than reporting the
    // size of a page as if it were the total.
    if (headline.error.code === "commerce_context_ceiling_denied") {
      return {
        ok: true,
        value: {
          kind: "unavailable",
          name: definition.name,
          metric: definition.metric,
          reason:
            "This authority cannot read a total across this record type. Ask again in an operator conversation, or grant the report its own access.",
          dependency: "commerce_aggregation_restricted_sensitivity_ceiling",
        },
      };
    }
    return headline;
  }
  const value = countFrom(headline.value);
  if (value === null) {
    return {
      ok: true,
      value: {
        kind: "unavailable",
        name: definition.name,
        metric: definition.metric,
        reason: "The read returned no count for this report.",
        dependency: "commerce_named_aggregation_count_result",
      },
    };
  }
  const population = await readNamedCommerceQuery({
    ...input,
    query: definition.queries.population,
  });
  if (!population.ok) return population;
  if (headline.value.merchantRevision !== population.value.merchantRevision) {
    return {
      ok: true,
      value: {
        kind: "unavailable",
        name: definition.name,
        metric: definition.metric,
        reason:
          "Merchant records changed between the headline and supporting-record reads. Run the report again.",
        dependency: "consistent_merchant_snapshot",
      },
    };
  }
  const records = recordsFrom(population.value);
  return {
    ok: true,
    value: {
      kind: "reported",
      name: definition.name,
      metric: definition.metric,
      entityType: definition.entityType,
      window: definition.window,
      unit: definition.unit,
      supportsDecision: definition.supportsDecision,
      value,
      population: records,
      populationTruncated: records.length < value,
      merchantRevision: population.value.merchantRevision,
      provenance: population.value.provenance,
      freshness:
        population.value.freshness.length > 0
          ? population.value.freshness
          : [
              {
                state: "unavailable",
                reason:
                  "The source returned no record freshness metadata for this report.",
              },
            ],
    },
  };
}

function unsupportedReason(
  reason: MerchantReportUnsupported["reason"],
): string {
  switch (reason) {
    case "event_time_window_filter_required":
      return "This report needs an event-time window filter the commerce read surface does not support yet.";
    case "money_sum_aggregation_required":
      return "This report needs a money sum over an operating window; the commerce read surface counts records only.";
    case "authorized_stock_snapshot_route_required":
      return "Stock shortages require the authorized stock snapshot read; a graph count cannot substitute for the stock pages.";
    case "authorized_product_sales_route_required":
      return "Product sales requires the authorized line-level report route; a graph count cannot substitute for merchandise value.";
  }
}

function countFrom(result: CommerceGraphQueryResult): number | null {
  for (const aggregation of result.aggregations) {
    if (aggregation.kind === "count") return Number(aggregation.value);
  }
  return null;
}

function recordsFrom(
  result: CommerceGraphQueryResult,
): readonly MerchantReportRecord[] {
  return result.entities.map((entity) => {
    // A display name is merchant-authored text arriving from the commerce
    // record, so it is normalized before it reaches the agent: what the
    // operator reads has to be what the record holds.
    const displayName = normalizeUntrustedCommerceText(
      entity.displayName,
      "display_name",
    );
    return {
      entityType: entity.reference.typeId,
      entityId: entity.reference.entityId,
      revision: Number(entity.revision),
      displayName: displayName.text.length === 0 ? null : displayName.text,
    };
  });
}

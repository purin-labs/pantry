import { Type, type Static } from "typebox";
import { StructuredToolResult } from "@purin-labs/agent-tools/structured-result";
import { isSystemCommerceEntity } from "@purin-labs/commerce-contracts";
import type { HarnessToolOutput } from "@purin-labs/contracts";
import type { CommerceGraphQueryResult } from "@purin-labs/commerce-contracts";
import type { StrictUnion } from "@purin-labs/type-utils";
import { assertNever, sha256Hex } from "@purin-labs/std";

const revision = Type.Integer({ minimum: 0 });
const integerText = Type.String({ pattern: "^-?[0-9]+$" });
const sensitivity = Type.Union([
  Type.Literal("public"),
  Type.Literal("internal"),
  Type.Literal("confidential"),
  Type.Literal("restricted"),
]);
const origin = Type.Union([Type.Literal("system"), Type.Literal("custom")]);
const reference = Type.Object({
  origin,
  typeId: Type.String(),
  entityId: Type.String(),
});
const provenance = Type.Object({
  organisationId: Type.String(),
  integrationAccountId: Type.String(),
  source: Type.Union([
    Type.Literal("shopify"),
    Type.Literal("stripe"),
    Type.Literal("lab"),
    Type.Literal("commerce"),
  ]),
  resourceType: Type.String(),
  resourceId: Type.String(),
  revision,
  occurredAt: Type.String(),
  observedAt: Type.String(),
});
const freshness = Type.Union([
  Type.Object({ state: Type.Literal("current"), observedAt: Type.String() }),
  Type.Object({
    state: Type.Literal("stale"),
    observedAt: Type.String(),
    staleSince: Type.String(),
  }),
  Type.Object({ state: Type.Literal("unavailable"), reason: Type.String() }),
]);
const attributeValue = Type.Union([
  Type.Object({
    kind: Type.Union([
      Type.Literal("short_text"),
      Type.Literal("long_text"),
      Type.Literal("date"),
      Type.Literal("timestamp"),
      Type.Literal("status"),
    ]),
    value: Type.String(),
  }),
  Type.Object({ kind: Type.Literal("integer"), value: integerText }),
  Type.Object({
    kind: Type.Literal("decimal"),
    value: Type.Object({ unscaled: Type.Number(), scale: Type.Number() }),
  }),
  Type.Object({ kind: Type.Literal("boolean"), value: Type.Boolean() }),
  Type.Object({
    kind: Type.Literal("choice"),
    values: Type.Array(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("money"),
    value: Type.Object({ amountMinor: Type.Number(), currency: Type.String() }),
  }),
  Type.Object({
    kind: Type.Literal("merchant_operator_reference"),
    value: Type.Object({
      principalId: Type.String(),
      displayName: Type.String(),
    }),
  }),
  Type.Object({
    kind: Type.Literal("external_resource_reference"),
    value: Type.Object({
      source: provenance.properties.source,
      resourceId: Type.String(),
      label: Type.Union([Type.String(), Type.Null()]),
    }),
  }),
]);
const attribute = Type.Object({
  attributeId: Type.String(),
  definitionRevision: revision,
  sensitivity,
  scope: Type.Union([
    Type.Object({
      kind: Type.Union([
        Type.Literal("system"),
        Type.Literal("merchant_extension"),
      ]),
      entityTypeId: Type.String(),
      schemaRevision: revision,
    }),
    Type.Object({
      kind: Type.Literal("custom"),
      entityTypeId: Type.String(),
      typeRevision: revision,
    }),
  ]),
  value: attributeValue,
});
const entityFields = {
  reference,
  revision,
  displayName: Type.String(),
  attributes: Type.Array(attribute),
};
const relationshipFields = {
  relationshipId: Type.String(),
  definition: Type.Object({ origin, definitionId: Type.String(), revision }),
  sensitivity,
  source: reference,
  target: reference,
  revision,
};

export const commerceContextOutputSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    result: Type.Object({
      merchantRevision: revision,
      entities: Type.Array(
        Type.Union([
          Type.Object({ ...entityFields, provenance, freshness }),
          Type.Object({
            ...entityFields,
            typeRevision: revision,
            sensitivity,
            state: Type.Union([
              Type.Object({ state: Type.Literal("active") }),
              Type.Object({
                state: Type.Literal("archived"),
                archivedAt: Type.String(),
              }),
            ]),
          }),
        ]),
        { maxItems: 100 },
      ),
      relationships: Type.Array(
        Type.Union([
          Type.Object({
            ...relationshipFields,
            origin: Type.Literal("system"),
            provenance,
          }),
          Type.Object({
            ...relationshipFields,
            origin: Type.Literal("custom"),
          }),
        ]),
      ),
      listEntries: Type.Array(
        Type.Object({
          entryId: Type.String(),
          listId: Type.String(),
          listRevision: revision,
          entityRef: reference,
          attributeValues: Type.Array(attribute),
          revision,
        }),
      ),
      aggregations: Type.Array(
        Type.Union([
          Type.Object({
            kind: Type.Union([Type.Literal("count"), Type.Literal("number")]),
            value: integerText,
          }),
          Type.Object({
            kind: Type.Literal("grouped_count"),
            groups: Type.Array(
              Type.Object({ value: attributeValue, count: integerText }),
            ),
          }),
          Type.Object({
            kind: Type.Literal("date"),
            value: Type.Union([Type.String(), Type.Null()]),
          }),
          Type.Object({
            kind: Type.Literal("age_buckets"),
            buckets: Type.Array(
              Type.Object({
                minimumAgeDays: Type.Number(),
                maximumAgeDays: Type.Union([Type.Number(), Type.Null()]),
                count: integerText,
              }),
            ),
          }),
        ]),
      ),
      nextCursor: Type.Union([Type.String(), Type.Null()]),
      provenance: Type.Array(provenance),
      freshness: Type.Array(freshness),
    }),
    truncated: Type.Literal(false),
  }),
  Type.Object({
    ok: Type.Literal(false),
    error: Type.Object({
      code: Type.Union([
        Type.Literal("read_failed"),
        Type.Literal("result_too_large"),
      ]),
      message: Type.String(),
    }),
  }),
]);

type CommerceGraphJson = Extract<
  Static<typeof commerceContextOutputSchema>,
  { ok: true }
>["result"];

type CommerceContextWire = Static<typeof commerceContextOutputSchema>;
export type CommerceContextValue = StrictUnion<CommerceContextWire>;

/** Live structured projection of the exact bytes covered by the read authority.
 * Accepted history still owns the text projection. No extra persisted protocol is needed.
 */
export class CommerceContextToolResult extends StructuredToolResult {
  readonly kind = "read";
  readonly status: "succeeded" | "failed";
  readonly authority: { readonly kind: "read"; readonly resultDigest: string };
  readonly #structuredContent: CommerceContextWire;

  get structuredContent(): CommerceContextWire {
    return this.#structuredContent;
  }

  private constructor(
    readonly output: HarnessToolOutput,
    value: CommerceContextValue,
  ) {
    super();
    this.status = value.ok ? "succeeded" : "failed";
    this.#structuredContent = value.ok
      ? { ok: true, result: value.result, truncated: false }
      : { ok: false, error: value.error };
    this.authority = { kind: "read", resultDigest: output.digest };
  }

  static async success(
    graph: CommerceGraphQueryResult,
  ): Promise<CommerceContextToolResult> {
    const value: CommerceContextValue = {
      ok: true,
      result: graphJson(graph),
      truncated: false,
    };
    if (
      graph.entities.length > 100 ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength > 24 * 1024
    )
      return CommerceContextToolResult.failure(
        "Result exceeds 100 entities or 24576 bytes. Request a smaller page or fewer attributes.",
        "result_too_large",
      );
    return CommerceContextToolResult.create(value);
  }

  static failure(
    message: string,
    code: "read_failed" | "result_too_large" = "read_failed",
  ): Promise<CommerceContextToolResult> {
    return CommerceContextToolResult.create({
      ok: false,
      error: { code, message },
    });
  }

  private static async create(
    value: CommerceContextValue,
  ): Promise<CommerceContextToolResult> {
    const text = JSON.stringify(value);
    const output: HarnessToolOutput = {
      kind: "inline",
      content: [{ kind: "text", text }],
      digest: await sha256Hex(text),
    };
    return new CommerceContextToolResult(output, value);
  }
}

// The commerce reader already validated these domain values. Convert only bigint
// fields so the sandbox receives exact decimal strings, including large integers.
function graphJson(graph: CommerceGraphQueryResult): CommerceGraphJson {
  return {
    merchantRevision: graph.merchantRevision,
    entities: graph.entities.map(entityJson),
    relationships: graph.relationships,
    listEntries: graph.listEntries.map(listEntryJson),
    aggregations: graph.aggregations.map(aggregationJson),
    nextCursor: graph.nextCursor,
    provenance: graph.provenance,
    freshness: graph.freshness,
  };
}

function entityJson(
  entity: CommerceGraphQueryResult["entities"][number],
): CommerceGraphJson["entities"][number] {
  const attributes = entity.attributes.map(attributeJson);
  if (isSystemCommerceEntity(entity)) {
    return {
      reference: entity.reference,
      revision: entity.revision,
      displayName: entity.displayName,
      attributes,
      provenance: entity.provenance,
      freshness: entity.freshness,
    };
  }
  return {
    reference: entity.reference,
    revision: entity.revision,
    displayName: entity.displayName,
    attributes,
    typeRevision: entity.typeRevision,
    sensitivity: entity.sensitivity,
    state: entity.state,
  };
}

function attributeJson(
  value: import("@purin-labs/commerce-contracts").AttributeValueAssignment,
): Static<typeof attribute> {
  return {
    attributeId: value.attributeId,
    scope: value.scope,
    definitionRevision: value.definitionRevision,
    sensitivity: value.sensitivity,
    value: attributeValueJson(value.value),
  };
}

function attributeValueJson(
  value: import("@purin-labs/commerce-contracts").AttributeValue,
): Static<typeof attributeValue> {
  switch (value.kind) {
    case "integer":
      return { kind: "integer", value: value.value.toString() };
    case "short_text":
    case "long_text":
    case "decimal":
    case "boolean":
    case "date":
    case "timestamp":
    case "status":
    case "choice":
    case "money":
    case "merchant_operator_reference":
    case "external_resource_reference":
      return value;
    default:
      return assertNever(value);
  }
}

function listEntryJson(
  entry: CommerceGraphQueryResult["listEntries"][number],
): CommerceGraphJson["listEntries"][number] {
  return {
    entryId: entry.entryId,
    listId: entry.listId,
    listRevision: entry.listRevision,
    entityRef: entry.entityRef,
    attributeValues: entry.attributeValues.map(attributeJson),
    revision: entry.revision,
  };
}

function aggregationJson(
  value: CommerceGraphQueryResult["aggregations"][number],
): CommerceGraphJson["aggregations"][number] {
  switch (value.kind) {
    case "count":
    case "number":
      return { kind: value.kind, value: value.value.toString() };
    case "date":
      return value;
    case "grouped_count":
      return { kind: "grouped_count", groups: value.groups.map(groupJson) };
    case "age_buckets":
      return { kind: "age_buckets", buckets: value.buckets.map(bucketJson) };
    default:
      return assertNever(value);
  }
}

function groupJson(group: import("@purin-labs/commerce-contracts").CommerceAggregationGroup) {
  return {
    value: attributeValueJson(group.value),
    count: group.count.toString(),
  };
}

function bucketJson(bucket: import("@purin-labs/commerce-contracts").CommerceAgeBucket) {
  return {
    minimumAgeDays: bucket.minimumAgeDays,
    maximumAgeDays: bucket.maximumAgeDays,
    count: bucket.count.toString(),
  };
}

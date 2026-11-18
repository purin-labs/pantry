import type {
  AttributeFilter,
  AttributeValue,
  CommerceEntityRef,
  CommerceEffectiveOrdering,
  CommerceGraphQuery,
  CommerceNormalizedPredicate,
  CommerceQueryPlan,
  CommerceQueryPlanErrorCapability,
  CommerceQueryPlanOperation,
  CommerceOrderingLeadingKey,
  CommerceOrderingValue,
  RelationshipFilter,
} from "@seams/commerce-contracts";
import {
  COMMERCE_ENTITY_ATTRIBUTE_RELATION,
  COMMERCE_ENTITY_RELATION,
  COMMERCE_LIST_ENTRY_RELATION,
  COMMERCE_RELATIONSHIP_RELATION,
} from "./relations.ts";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";

export type CommerceSqliteBinding = string | number | bigint | null;

export type CommerceSqliteStatement = Readonly<{
  sql: string;
  bindings: readonly CommerceSqliteBinding[];
  execution: CommerceSqliteExecution;
}>;

export type CommerceSqliteExecution =
  | Readonly<{
      kind: "exact";
      requestedLimit: 1;
      fetchLimit: 1;
    }>
  | Readonly<{
      kind: "page";
      requestedLimit: number;
      fetchLimit: number;
      effectiveOrdering: CommerceEffectiveOrdering;
    }>
  | Readonly<{
      kind: "count";
    }>
  | Readonly<{
      kind: "list_page";
      requestedLimit: number;
      fetchLimit: number;
      effectiveOrdering: CommerceEffectiveOrdering;
    }>
  | Readonly<{
      kind: "relationship_traversal_step";
      requestedLimit: number;
      fetchLimit: number;
    }>;

export type CommerceSqliteCompileResult =
  | Readonly<{ kind: "compiled"; statement: CommerceSqliteStatement }>
  | Readonly<{
      kind: "unsupported";
      capability: CommerceQueryPlanErrorCapability;
    }>;

type CommerceSqliteUnsupported = Readonly<{
  kind: "unsupported";
  capability: CommerceQueryPlanErrorCapability;
}>;

export type CommerceSqliteCompileInput = Readonly<{
  plan: CommerceQueryPlan;
  ownerId: string;
}>;

export type CommerceSqliteRelationshipTraversalPlan = CommerceQueryPlan &
  Readonly<{
    operation: Variant<CommerceQueryPlanOperation, "relationship_traversal">;
  }>;

export type CommerceSqliteRelationshipTraversalCompileInput = Readonly<{
  ownerId: string;
  plan: CommerceSqliteRelationshipTraversalPlan;
  frontier: readonly CommerceEntityRef[];
  remaining: number;
}>;

export function canonicalCommerceRelationshipId(
  definitionId: string,
  sourceEntityId: string,
  targetEntityId: string,
): string {
  return `system:${definitionId}:${sourceEntityId}:${targetEntityId}`;
}

/**
 * Compiles one bounded, undirected adjacency step. The caller owns BFS state;
 * this statement owns relation-definition filtering, deterministic ordering,
 * and the one-hop bound.
 */
export function compileCommerceRelationshipTraversalStepSql(
  input: CommerceSqliteRelationshipTraversalCompileInput,
): CommerceSqliteCompileResult {
  if (
    input.frontier.length === 0 ||
    !Number.isSafeInteger(input.remaining) ||
    input.remaining < 0
  ) {
    return unsupported("source_mapping");
  }
  if (input.plan.predicate.kind !== "all") return unsupported("source_mapping");
  const bindings: CommerceSqliteBinding[] = [input.ownerId];
  const where = ["merchant_id = ?"];
  const frontierPredicates: string[] = [];
  for (const reference of input.frontier) {
    frontierPredicates.push(
      "((source_origin = ? AND source_type_id = ? AND source_entity_id = ?) OR (target_origin = ? AND target_type_id = ? AND target_entity_id = ?))",
    );
    bindings.push(
      reference.origin,
      reference.typeId,
      reference.entityId,
      reference.origin,
      reference.typeId,
      reference.entityId,
    );
  }
  where.push(`(${frontierPredicates.join(" OR ")})`);
  switch (input.plan.operation.subject.kind) {
    case "all":
      break;
    case "definition":
      where.push(
        "definition_origin = ? AND definition_id = ? AND definition_revision = ?",
      );
      bindings.push(
        input.plan.operation.subject.relationshipDefinition.origin,
        input.plan.operation.subject.relationshipDefinition.definitionId,
        input.plan.operation.subject.relationshipDefinition.revision,
      );
      break;
    default:
      return assertNever(
        input.plan.operation.subject,
        "commerce_query_sql_unhandled",
      );
  }
  bindings.push(input.remaining);
  return {
    kind: "compiled",
    statement: {
      sql: `SELECT merchant_id, relationship_origin, relationship_id,
                    relationship_revision, definition_origin, definition_id,
                    definition_revision, sensitivity, source_origin, source_type_id,
                    source_entity_id, target_origin, target_type_id, target_entity_id,
                    payload_json, provenance_json
             FROM ${COMMERCE_RELATIONSHIP_RELATION}
             WHERE ${where.join(" AND ")}
             ORDER BY relationship_origin ASC, relationship_id ASC,
                      relationship_revision ASC
             LIMIT ?`,
      bindings,
      execution: {
        kind: "relationship_traversal_step",
        requestedLimit: input.remaining,
        fetchLimit: input.remaining,
      },
    },
  };
}

export function compileCommerceQuerySql(
  input: CommerceSqliteCompileInput,
): CommerceSqliteCompileResult {
  if (input.plan.operation.kind === "aggregation") {
    return compileAggregation(input, input.plan.operation);
  }
  if (input.plan.operation.kind === "commerce_list_page") {
    return compileCommerceListMembership(input, input.plan.operation.listId);
  }
  if (
    input.plan.operation.kind === "saved_commerce_view" &&
    input.plan.operation.source.kind === "commerce_list"
  ) {
    return compileCommerceListMembership(
      input,
      input.plan.operation.source.listId,
    );
  }
  const selection = entitySelectionForOperation(input.plan.operation);
  if (selection === null) return unsupported("source_mapping");
  const requestedLimit =
    selection.kind === "exact" ? 1 : Number(input.plan.limit);
  const fetchLimit = selection.kind === "exact" ? 1 : requestedLimit + 1;
  const bindings: CommerceSqliteBinding[] = [
    input.ownerId,
    selection.entityOrigin,
    selection.entityType,
  ];
  const entityAlias = "entity_relation";
  const scope: CommerceSqliteAttributeScope = {
    kind: "entity",
    alias: entityAlias,
  };
  const where = [
    `${entityAlias}.merchant_id = ?`,
    `${entityAlias}.entity_origin = ?`,
    `${entityAlias}.entity_type = ?`,
  ];
  switch (input.plan.predicate.kind) {
    case "all":
      break;
    case "search":
      where.push(`instr(${entityAlias}.search_text_folded, ?) > 0`);
      bindings.push(input.plan.predicate.foldedText);
      break;
    default: {
      const predicate = compileAttributePredicate(
        input.plan.predicate,
        scope,
        bindings,
      );
      if (predicate.kind === "unsupported") return predicate;
      where.push(predicate.sql);
      break;
    }
  }
  let orderBy = "entity_id ASC";
  if (selection.kind === "exact") {
    if (input.plan.boundary !== null) return unsupported("source_mapping");
    where.push(`${entityAlias}.entity_id = ?`);
    bindings.push(selection.entityId);
  } else {
    const boundary = input.plan.boundary;
    if (
      boundary !== null &&
      (boundary.entityRef.origin !== selection.entityOrigin ||
        boundary.entityRef.typeId !== selection.entityType)
    ) {
      return unsupported("source_mapping");
    }
    const boundaryPredicate =
      boundary === null
        ? null
        : compileBoundary(
            input.plan.effectiveOrdering.leadingKeys,
            boundary.entityRef,
            boundary.orderingValues,
            scope,
            bindings,
          );
    if (boundaryPredicate === "unsupported")
      return unsupported("source_mapping");
    if (boundaryPredicate !== null) where.push(boundaryPredicate);
    const ordering = compileOrdering(input.plan, scope, bindings);
    if (ordering.kind === "unsupported") return ordering;
    orderBy = ordering.orderBy;
  }
  bindings.push(fetchLimit);

  return {
    kind: "compiled",
    statement: {
      sql: `SELECT merchant_id, entity_origin, entity_type, entity_id, revision, updated_at,
                    display_name, display_name_folded, search_text_folded, payload_json
             FROM ${COMMERCE_ENTITY_RELATION} AS ${entityAlias}
             WHERE ${where.join(" AND ")}
             ORDER BY ${orderBy}
             LIMIT ?`,
      bindings,
      execution:
        selection.kind === "exact"
          ? { kind: "exact", requestedLimit: 1, fetchLimit: 1 }
          : {
              kind: "page",
              requestedLimit,
              fetchLimit,
              effectiveOrdering: input.plan.effectiveOrdering,
            },
    },
  };
}

function compileCommerceListMembership(
  input: CommerceSqliteCompileInput,
  listId: string,
): CommerceSqliteCompileResult {
  const bindings: CommerceSqliteBinding[] = [input.ownerId, listId];
  const listAlias = "list_entry_relation";
  const scope: CommerceSqliteAttributeScope = {
    kind: "list_entry",
    alias: listAlias,
  };
  const where = [`${listAlias}.merchant_id = ?`, `${listAlias}.list_id = ?`];
  switch (input.plan.predicate.kind) {
    case "all":
      break;
    case "search":
      return unsupported("source_mapping");
    default: {
      const predicate = compileAttributePredicate(
        input.plan.predicate,
        scope,
        bindings,
      );
      if (predicate.kind === "unsupported") return predicate;
      where.push(predicate.sql);
      break;
    }
  }
  const requestedLimit = Number(input.plan.limit);
  const fetchLimit = requestedLimit + 1;
  const boundary = input.plan.boundary;
  const boundaryPredicate =
    boundary === null
      ? null
      : compileBoundary(
          input.plan.effectiveOrdering.leadingKeys,
          boundary.entityRef,
          boundary.orderingValues,
          scope,
          bindings,
        );
  if (boundaryPredicate === "unsupported") return unsupported("source_mapping");
  if (boundaryPredicate !== null) where.push(boundaryPredicate);
  const ordering = compileOrdering(input.plan, scope, bindings);
  if (ordering.kind === "unsupported") return ordering;
  bindings.push(fetchLimit);
  return {
    kind: "compiled",
    statement: {
      sql: `SELECT merchant_id, list_id, entry_id, entry_revision,
                    entity_origin, entity_type, entity_id, updated_at
             FROM ${COMMERCE_LIST_ENTRY_RELATION} AS ${listAlias}
             WHERE ${where.join(" AND ")}
             ORDER BY ${ordering.orderBy}
             LIMIT ?`,
      bindings,
      execution: {
        kind: "list_page",
        requestedLimit,
        fetchLimit,
        effectiveOrdering: input.plan.effectiveOrdering,
      },
    },
  };
}

function compileAggregation(
  input: CommerceSqliteCompileInput,
  operation: Variant<CommerceQueryPlanOperation, "aggregation">,
): CommerceSqliteCompileResult {
  if (operation.aggregation.kind !== "count")
    return unsupportedAggregation(operation.aggregation);
  if (input.plan.boundary !== null) return unsupported("source_mapping");
  if (operation.source.kind === "commerce_list") {
    const bindings: CommerceSqliteBinding[] = [
      input.ownerId,
      operation.source.listId,
    ];
    const scope: CommerceSqliteAttributeScope = {
      kind: "list_entry",
      alias: "list_entry_relation",
    };
    const where = [
      "list_entry_relation.merchant_id = ?",
      "list_entry_relation.list_id = ?",
    ];
    switch (input.plan.predicate.kind) {
      case "all":
        break;
      case "search":
        return unsupported("source_mapping");
      default: {
        const predicate = compileAttributePredicate(
          input.plan.predicate,
          scope,
          bindings,
        );
        if (predicate.kind === "unsupported") return predicate;
        where.push(predicate.sql);
        break;
      }
    }
    return {
      kind: "compiled",
      statement: {
        sql: `SELECT COUNT(*) AS aggregate_count
               FROM ${COMMERCE_LIST_ENTRY_RELATION} AS list_entry_relation
               WHERE ${where.join(" AND ")}`,
        bindings,
        execution: { kind: "count" },
      },
    };
  }
  const selection = entityTypeSelection(operation.source.entityTypeId);
  const bindings: CommerceSqliteBinding[] = [
    input.ownerId,
    selection.entityOrigin,
    selection.entityType,
  ];
  const entityAlias = "entity_relation";
  const scope: CommerceSqliteAttributeScope = {
    kind: "entity",
    alias: entityAlias,
  };
  const where = [
    `${entityAlias}.merchant_id = ?`,
    `${entityAlias}.entity_origin = ?`,
    `${entityAlias}.entity_type = ?`,
  ];
  switch (input.plan.predicate.kind) {
    case "all":
      break;
    case "search":
      where.push(`instr(${entityAlias}.search_text_folded, ?) > 0`);
      bindings.push(input.plan.predicate.foldedText);
      break;
    default: {
      const predicate = compileAttributePredicate(
        input.plan.predicate,
        scope,
        bindings,
      );
      if (predicate.kind === "unsupported") return predicate;
      where.push(predicate.sql);
      break;
    }
  }
  return {
    kind: "compiled",
    statement: {
      sql: `SELECT COUNT(*) AS aggregate_count
             FROM ${COMMERCE_ENTITY_RELATION} AS ${entityAlias}
             WHERE ${where.join(" AND ")}`,
      bindings,
      execution: { kind: "count" },
    },
  };
}

function unsupportedAggregation(
  aggregation: Exclude<
    Variant<CommerceQueryPlanOperation, "aggregation">["aggregation"],
    { kind: "count" }
  >,
): CommerceSqliteCompileResult {
  switch (aggregation.kind) {
    case "grouped_count":
      return unsupported("grouped_aggregation");
    case "sum":
      return unsupported("sum_aggregation");
    case "minimum":
      return unsupported("minimum_aggregation");
    case "maximum":
      return unsupported("maximum_aggregation");
    case "oldest_due_date":
      return unsupported("oldest_due_date_aggregation");
    case "age_buckets":
      return unsupported("age_buckets_aggregation");
    default:
      return assertNever(aggregation, "commerce_query_sql_unhandled");
  }
}

type CommerceEntitySelection =
  | Readonly<{
      kind: "exact";
      entityOrigin: "system" | "custom";
      entityType: string;
      entityId: string;
    }>
  | Readonly<{
      kind: "page";
      entityOrigin: "system" | "custom";
      entityType: string;
    }>;

function entitySelectionForOperation(
  operation: CommerceQueryPlanOperation,
): CommerceEntitySelection | null {
  switch (operation.kind) {
    case "entity_by_ref": {
      return exactSelection(operation.reference);
    }
    case "entity_type_page":
    case "search":
      return { kind: "page", ...entityTypeSelection(operation.entityTypeId) };
    case "relationship_traversal":
    case "commerce_list_page":
    case "aggregation":
    case "underclerk_context":
      return operation.selection === undefined
        ? null
        : entitySelectionForContext(operation.selection);
    case "saved_commerce_view":
      switch (operation.source.kind) {
        case "system_mapped":
          return {
            kind: "page",
            entityOrigin: "system",
            entityType: operation.source.systemEntityKind,
          };
        case "underclerk_custom":
          return {
            kind: "page",
            entityOrigin: "custom",
            entityType: operation.source.entityTypeId,
          };
        case "commerce_list":
          return null;
        default:
          return assertNever(operation.source, "commerce_query_sql_unhandled");
      }
    default:
      return assertNever(operation, "commerce_query_sql_unhandled");
  }
}

function entityTypeSelection(
  entityTypeId: Variant<
    CommerceQueryPlanOperation,
    "entity_type_page"
  >["entityTypeId"],
): Readonly<{ entityOrigin: "system" | "custom"; entityType: string }> {
  return { entityOrigin: entityTypeId.origin, entityType: entityTypeId.typeId };
}

function entitySelectionForContext(
  selection: Variant<
    CommerceQueryPlanOperation,
    "underclerk_context"
  >["selection"],
): CommerceEntitySelection | null {
  switch (selection.kind) {
    case "selector":
      return entitySelectionForQuery(selection.selector.query);
    case "entity_seeds":
      return selection.seeds.length === 1 && selection.seeds[0] !== undefined
        ? exactSelection(selection.seeds[0])
        : null;
    default:
      return assertNever(selection, "commerce_query_sql_unhandled");
  }
}

function entitySelectionForQuery(
  query: CommerceGraphQuery,
): CommerceEntitySelection | null {
  switch (query.kind) {
    case "entity_by_ref":
      return exactSelection(query.reference);
    case "entity_type_page":
      return {
        kind: "page",
        entityOrigin: query.entityTypeId.origin,
        entityType: query.entityTypeId.typeId,
      };
    case "search":
      return query.entityTypeId === null
        ? null
        : {
            kind: "page",
            entityOrigin: query.entityTypeId.origin,
            entityType: query.entityTypeId.typeId,
          };
    case "relationship_traversal":
    case "commerce_list_page":
    case "saved_commerce_view":
    case "aggregation":
    case "underclerk_context":
      return null;
    default:
      return assertNever(query, "commerce_query_sql_unhandled");
  }
}

function exactSelection(reference: CommerceEntityRef): CommerceEntitySelection {
  return {
    kind: "exact",
    entityOrigin: reference.origin,
    entityType: entityTypeForReference(reference),
    entityId: reference.entityId,
  };
}

function entityTypeForReference(reference: CommerceEntityRef): string {
  return reference.typeId;
}

function compileOrdering(
  plan: CommerceQueryPlan,
  scope: CommerceSqliteAttributeScope,
  bindings: CommerceSqliteBinding[],
):
  | Readonly<{ kind: "compiled"; orderBy: string }>
  | Readonly<{
      kind: "unsupported";
      capability: CommerceQueryPlanErrorCapability;
    }> {
  if (plan.effectiveOrdering.tieBreaker.kind !== "entity_id_ascending")
    return unsupportedCapability("source_mapping");
  const keys = plan.effectiveOrdering.leadingKeys;
  if (keys.length === 0) return { kind: "compiled", orderBy: "entity_id ASC" };
  const columns: string[] = [];
  for (const key of keys) {
    const expression = orderingExpression(key, scope, bindings);
    if (expression === null)
      return unsupportedCapability(
        key.field.kind === "attribute" ? "attribute_sort" : "source_mapping",
      );
    columns.push(
      `${expression} ${key.direction === "descending" ? "DESC" : "ASC"} NULLS ${key.nulls === "last" ? "LAST" : "FIRST"}`,
    );
  }
  columns.push(`${scope.alias}.entity_id ASC`);
  return { kind: "compiled", orderBy: columns.join(", ") };
}

function orderingExpression(
  key: CommerceOrderingLeadingKey,
  scope: CommerceSqliteAttributeScope,
  bindings: CommerceSqliteBinding[],
): string | null {
  switch (key.field.kind) {
    case "updated_at":
      return `${scope.alias}.updated_at`;
    case "display_name":
      return scope.kind === "entity"
        ? `${scope.alias}.display_name_folded`
        : `(SELECT entity_order.display_name_folded
          FROM ${COMMERCE_ENTITY_RELATION} AS entity_order
         WHERE entity_order.merchant_id = ${scope.alias}.merchant_id
           AND entity_order.entity_origin = ${scope.alias}.entity_origin
           AND entity_order.entity_type = ${scope.alias}.entity_type
           AND entity_order.entity_id = ${scope.alias}.entity_id)`;
    case "attribute":
      bindings.push(key.field.attributeId);
      return `(SELECT CASE
                 WHEN attribute_order.value_kind IN ('short_text', 'long_text', 'status', 'date', 'timestamp')
                   THEN attribute_order.comparable_text
                 WHEN attribute_order.value_kind = 'integer' THEN attribute_order.comparable_integer
                 WHEN attribute_order.value_kind = 'decimal' THEN attribute_order.comparable_real
                 WHEN attribute_order.value_kind = 'boolean' THEN attribute_order.comparable_boolean
                 ELSE NULL
               END
          FROM ${COMMERCE_ENTITY_ATTRIBUTE_RELATION} AS attribute_order
         WHERE ${attributeCorrelation(scope, "attribute_order")}
           AND attribute_order.attribute_id = ?)`;
    case "created_at":
      return null;
    default:
      return assertNever(key.field, "commerce_query_sql_unhandled");
  }
}

function compileBoundary(
  keys: readonly CommerceOrderingLeadingKey[],
  entityRef: CommerceEntityRef,
  values: readonly CommerceOrderingValue[],
  scope: CommerceSqliteAttributeScope,
  bindings: CommerceSqliteBinding[],
): string | null | "unsupported" {
  if (keys.length === 0) {
    if (values.length !== 0) return "unsupported";
    bindings.push(entityRef.entityId);
    return "entity_id > ?";
  }
  if (keys.length !== values.length) return "unsupported";
  const parsedValues = values.map((value, index) => {
    const key = keys[index];
    return key === undefined ? undefined : orderingValue(value, key.field);
  });
  if (parsedValues.some((value) => value === undefined)) return "unsupported";
  const clauses: string[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const value = parsedValues[index];
    if (key === undefined || value === undefined) return "unsupported";
    const prefix: string[] = [];
    for (let prefixIndex = 0; prefixIndex < index; prefixIndex += 1) {
      const prefixKey = keys[prefixIndex];
      const prefixValue = parsedValues[prefixIndex];
      if (prefixKey === undefined || prefixValue === undefined)
        return "unsupported";
      const prefixExpression = orderingExpression(prefixKey, scope, bindings);
      if (prefixExpression === null) return "unsupported";
      prefix.push(
        prefixValue === null
          ? `${prefixExpression} IS NULL`
          : `${prefixExpression} = ?`,
      );
      if (prefixValue !== null) bindings.push(prefixValue);
    }
    const expression = orderingExpression(key, scope, bindings);
    if (expression === null) return "unsupported";
    if (value !== null) {
      const operator = key.direction === "descending" ? "<" : ">";
      const nullsFirst = String(key.nulls) === "first";
      const comparison = nullsFirst
        ? `${expression} ${operator} ?`
        : `${expression} ${operator} ? OR ${expression} IS NULL`;
      clauses.push(`(${[...prefix, `(${comparison})`].join(" AND ")})`);
      bindings.push(value);
      if (!nullsFirst && key.field.kind === "attribute")
        bindings.push(key.field.attributeId);
    } else if (String(key.nulls) === "first") {
      clauses.push(
        `(${[...prefix, `${expression} IS NOT NULL`].join(" AND ")})`,
      );
    }
  }
  const equality: string[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const value = parsedValues[index];
    if (key === undefined || value === undefined) return "unsupported";
    const expression = orderingExpression(key, scope, bindings);
    if (expression === null) return "unsupported";
    equality.push(
      value === null ? `${expression} IS NULL` : `${expression} = ?`,
    );
    if (value !== null) bindings.push(value);
  }
  clauses.push(`(${equality.join(" AND ")} AND ${scope.alias}.entity_id > ?)`);
  bindings.push(entityRef.entityId);
  return `(${clauses.join(" OR ")})`;
}

function orderingValue(
  value: CommerceOrderingValue,
  field: CommerceOrderingLeadingKey["field"],
): CommerceSqliteBinding | undefined {
  if (value.kind === "null") return null;
  switch (field.kind) {
    case "updated_at":
      return value.kind === "integer" ? value.value : undefined;
    case "display_name":
      return value.kind === "text" ? value.value : undefined;
    case "attribute":
      switch (value.kind) {
        case "text":
        case "integer":
          return value.value;
        case "boolean":
          return value.value ? 1 : 0;
        default:
          return undefined;
      }
    case "created_at":
      return undefined;
    default:
      return assertNever(field, "commerce_query_sql_unhandled");
  }
}

type CommerceSqliteAttributeScope = Readonly<{
  kind: "entity" | "list_entry";
  alias: string;
}>;

type CommerceSqlitePredicate =
  Readonly<{ kind: "compiled"; sql: string }> | CommerceSqliteUnsupported;

function compileAttributePredicate(
  predicate: CommerceNormalizedPredicate,
  scope: CommerceSqliteAttributeScope,
  bindings: CommerceSqliteBinding[],
): CommerceSqlitePredicate {
  switch (predicate.kind) {
    case "all":
      return { kind: "compiled", sql: "1 = 1" };
    case "entity":
      bindings.push(
        predicate.reference.origin,
        predicate.reference.typeId,
        predicate.reference.entityId,
      );
      return {
        kind: "compiled",
        sql: `${scope.alias}.entity_origin = ? AND ${scope.alias}.entity_type = ? AND ${scope.alias}.entity_id = ?`,
      };
    case "search":
      bindings.push(predicate.foldedText);
      return {
        kind: "compiled",
        sql: `instr(${scope.alias}.search_text_folded, ?) > 0`,
      };
    case "any": {
      const predicates: string[] = [];
      for (const child of predicate.predicates) {
        const compiled = compileAttributePredicate(child, scope, bindings);
        if (compiled.kind === "unsupported") return compiled;
        predicates.push(`(${compiled.sql})`);
      }
      if (predicates.length === 0) return { kind: "compiled", sql: "0 = 1" };
      return { kind: "compiled", sql: `(${predicates.join(" OR ")})` };
    }
    case "not": {
      const compiled = compileAttributePredicate(
        predicate.predicate,
        scope,
        bindings,
      );
      return compiled.kind === "unsupported"
        ? compiled
        : { kind: "compiled", sql: `NOT (${compiled.sql})` };
    }
    case "attribute":
      return compileAttributeFilter(predicate.filter, scope, bindings);
    case "relationship":
      return compileRelationshipFilter(predicate.filter, scope, bindings);
    default:
      return assertNever(predicate, "commerce_query_sql_unhandled");
  }
}

function compileRelationshipFilter(
  filter: RelationshipFilter,
  scope: CommerceSqliteAttributeScope,
  bindings: CommerceSqliteBinding[],
): CommerceSqlitePredicate {
  const relationAlias = "relationship_filter";
  const relationReference = `(
       (${relationAlias}.source_origin = ${scope.alias}.entity_origin
        AND ${relationAlias}.source_type_id = ${scope.alias}.entity_type
        AND ${relationAlias}.source_entity_id = ${scope.alias}.entity_id)
       OR
       (${relationAlias}.target_origin = ${scope.alias}.entity_origin
        AND ${relationAlias}.target_type_id = ${scope.alias}.entity_type
        AND ${relationAlias}.target_entity_id = ${scope.alias}.entity_id)
     )`;
  bindings.push(
    filter.relationshipDefinition.origin,
    filter.relationshipDefinition.definitionId,
    filter.relationshipDefinition.revision,
  );
  const exists = `EXISTS (
    SELECT 1
      FROM ${COMMERCE_RELATIONSHIP_RELATION} AS ${relationAlias}
     WHERE ${relationAlias}.merchant_id = ${scope.alias}.merchant_id
       AND ${relationAlias}.definition_origin = ?
       AND ${relationAlias}.definition_id = ?
       AND ${relationAlias}.definition_revision = ?
       AND ${relationReference}
  )`;
  return {
    kind: "compiled",
    sql: filter.operator === "exists" ? exists : `NOT ${exists}`,
  };
}

function compileAttributeFilter(
  filter: AttributeFilter,
  scope: CommerceSqliteAttributeScope,
  bindings: CommerceSqliteBinding[],
): CommerceSqlitePredicate {
  const relation = COMMERCE_ENTITY_ATTRIBUTE_RELATION;
  const correlation = attributeCorrelation(scope, "attribute_filter");
  switch (filter.operator) {
    case "is_empty":
      bindings.push(filter.attributeId);
      return {
        kind: "compiled",
        sql: `NOT EXISTS (SELECT 1 FROM ${relation} AS attribute_filter WHERE ${correlation} AND attribute_filter.attribute_id = ?)`,
      };
    case "is_not_empty":
      bindings.push(filter.attributeId);
      return {
        kind: "compiled",
        sql: `EXISTS (SELECT 1 FROM ${relation} AS attribute_filter WHERE ${correlation} AND attribute_filter.attribute_id = ?)`,
      };
    case "equals":
    case "not_equals": {
      const comparable = attributeComparableValue(filter.value);
      if (comparable === null) return unsupportedCapability("attribute_filter");
      bindings.push(filter.attributeId, comparable.valueKind, comparable.value);
      const exists = `EXISTS (SELECT 1 FROM ${relation} AS attribute_filter WHERE ${correlation} AND attribute_filter.attribute_id = ? AND attribute_filter.value_kind = ? AND ${comparable.column} = ?)`;
      return {
        kind: "compiled",
        sql: filter.operator === "equals" ? exists : `NOT ${exists}`,
      };
    }
    default:
      return unsupportedCapability("attribute_filter");
  }
}

function attributeComparableValue(value: AttributeValue): Readonly<{
  column:
    | "attribute_filter.comparable_text"
    | "attribute_filter.comparable_integer"
    | "attribute_filter.comparable_boolean";
  valueKind: string;
  value: CommerceSqliteBinding;
}> | null {
  switch (value.kind) {
    case "short_text":
    case "long_text":
    case "status":
    case "date":
    case "timestamp":
      return {
        column: "attribute_filter.comparable_text",
        valueKind: value.kind,
        value: value.value,
      };
    case "integer":
      return {
        column: "attribute_filter.comparable_integer",
        valueKind: value.kind,
        value: value.value,
      };
    case "boolean":
      return {
        column: "attribute_filter.comparable_boolean",
        valueKind: value.kind,
        value: value.value ? 1 : 0,
      };
    default:
      return null;
  }
}

function attributeCorrelation(
  scope: CommerceSqliteAttributeScope,
  attributeAlias: string,
): string {
  const relation = scope.alias;
  if (scope.kind === "entity") {
    return `${attributeAlias}.merchant_id = ${relation}.merchant_id
        AND ${attributeAlias}.subject_kind = 'entity'
        AND ${attributeAlias}.entity_origin = ${relation}.entity_origin
        AND ${attributeAlias}.entity_type = ${relation}.entity_type
        AND ${attributeAlias}.entity_id = ${relation}.entity_id
        AND ${attributeAlias}.list_id = ''
        AND ${attributeAlias}.entry_id = ''`;
  }
  return `${attributeAlias}.merchant_id = ${relation}.merchant_id
      AND ${attributeAlias}.subject_kind = 'list_entry'
      AND ${attributeAlias}.list_id = ${relation}.list_id
      AND ${attributeAlias}.entry_id = ${relation}.entry_id`;
}

function unsupportedCapability(
  kind: CommerceQueryPlanErrorCapability["kind"],
): CommerceSqliteUnsupported {
  return { kind: "unsupported", capability: { kind } };
}

function unsupported(
  kind: CommerceQueryPlanErrorCapability["kind"],
): CommerceSqliteCompileResult {
  return unsupportedCapability(kind);
}

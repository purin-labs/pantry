import type { OrganisationDatabase } from "../../database-handles";
import type { OrganisationId } from "../../ids";
import { responsibilityScopeCommerce } from "./scope-commerce";
import type { Variant } from "@purin-labs/type-utils";
import type { AgentOperationCommand } from "../agent-operations";
import { AgentOperationFailure, commitWithTrailing } from "./failure";
import { responsibilityScopeColumns } from "./rows";

export async function createArea(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "create_area">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `INSERT INTO operational_area (
       area_id, organisation_id, name, purpose, lifecycle,
       created_by_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .bind(
          command.operationId,
          organisationId,
          command.name,
          command.purpose,
          command.actorUserId,
          command.now,
          command.now,
        ),
    ],
    trailing,
  );
}

export async function publishResponsibilityScope(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "publish_responsibility_scope">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  const evidence = command.publishedResourceEvidence;
  let validEvidence = false;
  try {
    validEvidence =
      evidence !== undefined &&
      evidence !== null &&
      evidence.kind === "resolved" &&
      evidence.organisationId === organisationId &&
      responsibilityScopeCommerce
        .use()
        .evidenceMatchesScope(command.scope, evidence);
  } catch {
    validEvidence = false;
  }
  if (!validEvidence) {
    throw new AgentOperationFailure({
      code: "agent_operation_invalid",
      field: "publishedResourceEvidence",
    });
  }
  await requireActiveArea(db, organisationId, command.areaId);
  const columns = responsibilityScopeColumns(command.scope);
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `INSERT INTO agent_responsibility_scope (
       scope_id, organisation_id, area_id, scope_kind,
       entity_type_origin, entity_type_id, commerce_list_id,
       relationship_json, list_entry_json,
       selector_id, selector_revision, selector_query_json,
       lifecycle, revision, published_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 1, ?)`,
        )
        .bind(
          command.operationId,
          organisationId,
          command.areaId,
          columns.scopeKind,
          columns.entityTypeOrigin,
          columns.entityTypeId,
          columns.commerceListId,
          columns.relationshipJson,
          columns.listEntryJson,
          columns.selectorId,
          columns.selectorRevision,
          columns.selectorQueryJson,
          command.now,
        ),
    ],
    trailing,
  );
}

export async function requireActiveArea(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  areaId: string,
): Promise<void> {
  const area = await db
    .prepare(
      `SELECT 1 AS present FROM operational_area
     WHERE area_id = ? AND organisation_id = ? AND lifecycle = 'active'`,
    )
    .bind(areaId, organisationId)
    .first<{ present: number }>();
  if (area === null) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "areaId",
    });
  }
}

export async function requirePublishedScopes(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  areaId: string,
  scopeIds: readonly string[],
): Promise<void> {
  if (scopeIds.length === 0) {
    return;
  }
  if (new Set(scopeIds).size !== scopeIds.length) {
    throw new AgentOperationFailure({
      code: "agent_operation_invalid",
      field: "scopeIds",
    });
  }
  const placeholders = scopeIds.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM agent_responsibility_scope
      WHERE organisation_id = ? AND area_id = ? AND lifecycle = 'published'
        AND scope_id IN (${placeholders})`,
    )
    .bind(organisationId, areaId, ...scopeIds)
    .first<{ readonly count: unknown }>();
  if (row === null || row.count !== scopeIds.length) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "scopeIds",
    });
  }
}

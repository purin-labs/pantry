// The rows of the export coordinator that the commerce export preset installs
// (Refactor 17: only the owner of a table writes it). The agent module owns
// these tables. Each statement keeps the text of the export preset, so the
// fixed values of the preset (its names, its budget and its delays) stay in
// the SQL text, and each statement adds a row only while the guard holds.
import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../../database-handles";

type Database =
  Pick<OrganisationDatabase, "prepare"> | OrganisationDatabaseSession;

/** A condition that the statement checks, and its values. */
type Guard = Readonly<{ condition: string; bindings: readonly unknown[] }>;

/** Adds the operational area of the export coordination. */
export function prepareExportCoordinationArea(
  db: Database,
  input: Readonly<{
    guard: Guard;
    areaId: string;
    organisationId: string;
    purpose: string;
    userId: string;
    now: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO operational_area (
         area_id, organisation_id, name, purpose, lifecycle,
         created_by_user_id, created_at, updated_at
       ) SELECT ?, ?, 'Export coordination', ?, 'active', ?, ?, ? WHERE ${input.guard.condition}`,
    )
    .bind(
      input.areaId,
      input.organisationId,
      input.purpose,
      input.userId,
      input.now,
      input.now,
      ...input.guard.bindings,
    );
}

/** Adds one published responsibility scope of the export coordination area. */
export function prepareExportResponsibilityScope(
  db: Database,
  input: Readonly<{
    guard: Guard;
    scopeId: string;
    organisationId: string;
    areaId: string;
    columns: Readonly<{
      scopeKind: string;
      entityTypeOrigin: string | null;
      entityTypeId: string | null;
      commerceListId: string | null;
      relationshipJson: string | null;
      listEntryJson: string | null;
      selectorId: string | null;
      selectorRevision: number | null;
      selectorQueryJson: string | null;
    }>;
    now: number;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO agent_responsibility_scope (
       scope_id, organisation_id, area_id, scope_kind,
       entity_type_origin, entity_type_id, commerce_list_id,
       relationship_json, list_entry_json, selector_id, selector_revision,
       selector_query_json, lifecycle, revision, published_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 1, ? WHERE ${input.guard.condition}`,
    )
    .bind(
      input.scopeId,
      input.organisationId,
      input.areaId,
      input.columns.scopeKind,
      input.columns.entityTypeOrigin,
      input.columns.entityTypeId,
      input.columns.commerceListId,
      input.columns.relationshipJson,
      input.columns.listEntryJson,
      input.columns.selectorId,
      input.columns.selectorRevision,
      input.columns.selectorQueryJson,
      input.now,
      ...input.guard.bindings,
    );
}

/**
 * The skill, the agent definition, the installation and its bindings of the
 * export coordinator, in the order of the batch: skill, skill revision,
 * definition, definition revision, installation, area assignment, skill
 * binding, cue binding, governance and escalation policy.
 */
export function prepareExportCoordinatorInstallation(
  db: Database,
  input: Readonly<{
    guard: Guard;
    organisationId: string;
    userId: string;
    now: number;
    areaId: string;
    skillId: string;
    skillBody: string;
    skillDigest: string;
    agentDefinitionId: string;
    capabilitiesJson: string;
    skillRefsJson: string;
    agentDigest: string;
    installationId: string;
    policyVersion: number;
    scopeIdsJson: string;
    skillBindingId: string;
    cueBindingId: string;
    cueSource: string;
    cueEventType: string;
  }>,
): D1PreparedStatement[] {
  const guard = input.guard.bindings;
  return [
    db
      .prepare(
        `INSERT INTO skill (
         skill_id, organisation_id, title, sensitivity, lifecycle, current_revision,
         created_by_user_id, created_at, updated_at
       ) SELECT ?, ?, 'Export coordination', 'ordinary', 'published', 1, ?, ?, ? WHERE ${input.guard.condition}`,
      )
      .bind(
        input.skillId,
        input.organisationId,
        input.userId,
        input.now,
        input.now,
        ...guard,
      ),
    db
      .prepare(
        `INSERT INTO skill_revision (
         skill_id, organisation_id, revision, markdown_body, content_digest,
         authored_by_user_id, created_at
       ) SELECT ?, ?, 1, ?, ?, ?, ? WHERE ${input.guard.condition}`,
      )
      .bind(
        input.skillId,
        input.organisationId,
        input.skillBody,
        input.skillDigest,
        input.userId,
        input.now,
        ...guard,
      ),
    db
      .prepare(
        `INSERT INTO agent_definition (
         agent_definition_id, organisation_id, display_name, role, purpose, lifecycle,
         current_revision, created_by_user_id, created_at, updated_at
       ) SELECT ?, ?, 'Export coordinator', 'export_coordinator',
         'Coordinate export handoffs and resolve missing documents.', 'active', 1, ?, ?, ? WHERE ${input.guard.condition}`,
      )
      .bind(
        input.agentDefinitionId,
        input.organisationId,
        input.userId,
        input.now,
        input.now,
        ...guard,
      ),
    db
      .prepare(
        `INSERT INTO agent_definition_revision (
         agent_definition_id, organisation_id, revision, instructions,
         requested_capabilities_json, skill_refs_json, content_digest,
         authored_by_user_id, created_at
       ) SELECT ?, ?, 1, ?, ?, ?, ?, ?, ? WHERE ${input.guard.condition}`,
      )
      .bind(
        input.agentDefinitionId,
        input.organisationId,
        input.skillBody,
        input.capabilitiesJson,
        input.skillRefsJson,
        input.agentDigest,
        input.userId,
        input.now,
        ...guard,
      ),
    db
      .prepare(
        `INSERT INTO agent_installation (
         installation_id, organisation_id, agent_definition_id, definition_revision,
         policy_revision, granted_capabilities_json, lifecycle,
         created_by_user_id, created_at, updated_at
       ) SELECT ?, ?, ?, 1, ?, ?, 'active', ?, ?, ? WHERE ${input.guard.condition}`,
      )
      .bind(
        input.installationId,
        input.organisationId,
        input.agentDefinitionId,
        input.policyVersion,
        input.capabilitiesJson,
        input.userId,
        input.now,
        input.now,
        ...guard,
      ),
    db
      .prepare(
        `INSERT INTO agent_area_assignment (
         installation_id, area_id, responsibility, scope_ids_json, assigned_at
       ) SELECT ?, ?, 'Export coordination', ?, ? WHERE ${input.guard.condition}`,
      )
      .bind(
        input.installationId,
        input.areaId,
        input.scopeIdsJson,
        input.now,
        ...guard,
      ),
    db
      .prepare(
        `INSERT INTO skill_binding (
         binding_id, organisation_id, target_kind, target_id, skill_id, skill_revision, created_at
       ) SELECT ?, ?, 'area', ?, ?, 1, ? WHERE ${input.guard.condition}`,
      )
      .bind(
        input.skillBindingId,
        input.organisationId,
        input.areaId,
        input.skillId,
        input.now,
        ...guard,
      ),
    db
      .prepare(
        `INSERT INTO cue_binding (
         binding_id, organisation_id, area_id, scope_ids_json, installation_id,
         cue_source, cue_event_type, enabled, instruction_body, revision,
         updated_by_user_id, created_at, updated_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ? WHERE ${input.guard.condition}`,
      )
      .bind(
        input.cueBindingId,
        input.organisationId,
        input.areaId,
        input.scopeIdsJson,
        input.installationId,
        input.cueSource,
        input.cueEventType,
        input.skillBody,
        input.userId,
        input.now,
        input.now,
        ...guard,
      ),
    db
      .prepare(
        `INSERT INTO agent_installation_governance (
         installation_id, organisation_id, max_session_budget_tokens, revision,
         updated_by_user_id, updated_at
       ) SELECT ?, ?, 500000, 1, ?, ? WHERE ${input.guard.condition}`,
      )
      .bind(
        input.installationId,
        input.organisationId,
        input.userId,
        input.now,
        ...guard,
      ),
    db
      .prepare(
        `INSERT INTO escalation_policy (
         area_id, organisation_id, scope_ids_json, approval_reminder_after_ms,
         escalate_after_ms, escalate_to, revision,
         updated_by_user_id, updated_at
       ) SELECT ?, ?, ?, 900000, 3600000, 'organisation_owner', 1, ?, ? WHERE ${input.guard.condition}`,
      )
      .bind(
        input.areaId,
        input.organisationId,
        input.scopeIdsJson,
        input.userId,
        input.now,
        ...guard,
      ),
  ];
}

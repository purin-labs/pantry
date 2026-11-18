import type { OrganisationDatabase } from "../../database-handles";
import type { OrganisationId } from "../../ids";
import type { Variant } from "@seams/type-utils";
import { sha256Hex } from "@seams/std";
import type { AgentSkillRef } from "@seams/control-api";
import type { AgentOperationCommand } from "../agent-operations";
import { requirePublishedScopes } from "./areas";
import { AgentOperationFailure, commitWithTrailing } from "./failure";
import { positive, text } from "./input";
import { parseStoredSkillRefs, parseStoredStringArray } from "./rows";
import { encodeSkillRefs, requirePublishedSkillRefs } from "./skills";

export async function createDefinition(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "create_agent_definition">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  await requirePublishedSkillRefs(db, organisationId, command.skillRefs);
  const digest = await sha256Hex(
    JSON.stringify({
      displayName: command.displayName,
      role: command.role,
      purpose: command.purpose,
      instructions: command.instructions,
      requestedCapabilities: command.requestedCapabilities,
      skillRefs: command.skillRefs,
    }),
  );
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `INSERT INTO agent_definition (
         agent_definition_id, organisation_id, display_name, role, purpose, lifecycle,
         current_revision, created_by_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
        )
        .bind(
          command.operationId,
          organisationId,
          command.displayName,
          command.role,
          command.purpose,
          command.actorUserId,
          command.now,
          command.now,
        ),
      db
        .prepare(
          `INSERT INTO agent_definition_revision (
         agent_definition_id, organisation_id, revision, instructions,
         requested_capabilities_json, skill_refs_json, content_digest,
         authored_by_user_id, created_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          command.operationId,
          organisationId,
          command.instructions,
          JSON.stringify(command.requestedCapabilities),
          encodeSkillRefs(command.skillRefs),
          digest,
          command.actorUserId,
          command.now,
        ),
    ],
    trailing,
  );
}

export async function publishDefinitionRevision(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "publish_agent_definition_revision">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  const current = await db
    .prepare(
      `SELECT d.display_name AS displayName, d.role, d.purpose,
            d.current_revision AS currentRevision
       FROM agent_definition d
      WHERE d.agent_definition_id = ? AND d.organisation_id = ? AND d.lifecycle = 'active'`,
    )
    .bind(command.agentDefinitionId, organisationId)
    .first<{
      readonly displayName: unknown;
      readonly role: unknown;
      readonly purpose: unknown;
      readonly currentRevision: unknown;
    }>();
  if (current === null) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "agentDefinitionId",
    });
  }
  const currentRevision = positive(current.currentRevision);
  if (currentRevision !== command.expectedRevision) {
    throw new AgentOperationFailure({
      code: "agent_operation_conflict",
      field: "expectedRevision",
    });
  }
  await requirePublishedSkillRefs(db, organisationId, command.skillRefs);
  const nextRevision = currentRevision + 1;
  const digest = await sha256Hex(
    JSON.stringify({
      displayName: text(current.displayName),
      role: text(current.role),
      purpose: text(current.purpose),
      instructions: command.instructions,
      requestedCapabilities: command.requestedCapabilities,
      skillRefs: command.skillRefs,
    }),
  );
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `INSERT INTO agent_definition_revision (
         agent_definition_id, organisation_id, revision, instructions,
         requested_capabilities_json, skill_refs_json, content_digest,
         authored_by_user_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          command.agentDefinitionId,
          organisationId,
          nextRevision,
          command.instructions,
          JSON.stringify(command.requestedCapabilities),
          encodeSkillRefs(command.skillRefs),
          digest,
          command.actorUserId,
          command.now,
        ),
      db
        .prepare(
          `UPDATE agent_definition
          SET current_revision = ?, updated_at = ?
        WHERE agent_definition_id = ? AND organisation_id = ?
          AND lifecycle = 'active' AND current_revision = ?`,
        )
        .bind(
          nextRevision,
          command.now,
          command.agentDefinitionId,
          organisationId,
          currentRevision,
        ),
    ],
    trailing,
  );
}

/** Ordered exact-match comparison of two skill sets. */
export function skillRefsMatch(
  confirmed: readonly AgentSkillRef[],
  published: readonly AgentSkillRef[],
): boolean {
  return (
    confirmed.length === published.length &&
    confirmed.every(
      (ref, index) =>
        ref.skillId === published[index]?.skillId &&
        ref.revision === published[index]?.revision,
    )
  );
}

/**
 * Points one installation at a published definition revision.
 *
 * Publishing a revision never changes what an installed agent runs; this
 * transition does. The granted capability set is re-checked against the
 * revision's requested set so activation cannot widen authority: a revision
 * that asks for a capability the installation was not granted is refused.
 */
export async function activateDefinitionRevision(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "activate_agent_definition_revision">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT installation.definition_revision AS currentRevision,
            installation.granted_capabilities_json AS grantedCapabilities,
            revision.requested_capabilities_json AS requestedCapabilities,
            revision.skill_refs_json AS skillRefs
       FROM agent_installation AS installation
       LEFT JOIN agent_definition_revision AS revision
         ON revision.agent_definition_id = installation.agent_definition_id
        AND revision.organisation_id = installation.organisation_id
        AND revision.revision = ?
      WHERE installation.installation_id = ? AND installation.organisation_id = ?
        AND installation.lifecycle = 'active'`,
    )
    .bind(command.definitionRevision, command.installationId, organisationId)
    .first<{
      readonly currentRevision: unknown;
      readonly grantedCapabilities: unknown;
      readonly requestedCapabilities: unknown;
      readonly skillRefs: unknown;
    }>();
  if (row === null) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "installationId",
    });
  }
  if (row.requestedCapabilities === null) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "definitionRevision",
    });
  }
  const currentRevision = positive(row.currentRevision);
  if (currentRevision !== command.expectedDefinitionRevision) {
    throw new AgentOperationFailure({
      code: "agent_operation_conflict",
      field: "expectedDefinitionRevision",
    });
  }
  const granted = parseStoredStringArray(row.grantedCapabilities);
  const requested = parseStoredStringArray(row.requestedCapabilities);
  const skillRefs = parseStoredSkillRefs(row.skillRefs);
  if (granted === null || requested === null || skillRefs === null) {
    throw new AgentOperationFailure({
      code: "agent_operation_persistence_failed",
    });
  }
  if (!skillRefsMatch(command.skillRefs, skillRefs)) {
    throw new AgentOperationFailure({
      code: "agent_operation_conflict",
      field: "skillRefs",
    });
  }
  const grantedSet = new Set(granted);
  if (requested.some((capability) => !grantedSet.has(capability))) {
    throw new AgentOperationFailure({
      code: "agent_operation_invalid",
      field: "grantedCapabilities",
    });
  }
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `UPDATE agent_installation
        SET definition_revision = ?, updated_at = ?
      WHERE installation_id = ? AND organisation_id = ?
        AND lifecycle = 'active' AND definition_revision = ?`,
        )
        .bind(
          command.definitionRevision,
          command.now,
          command.installationId,
          organisationId,
          command.expectedDefinitionRevision,
        ),
    ],
    trailing,
  );
}

export async function installAgent(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "install_agent">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  const definition = await db
    .prepare(
      `SELECT requested_capabilities_json AS requestedCapabilities
       FROM agent_definition_revision
      WHERE agent_definition_id = ? AND organisation_id = ? AND revision = ?`,
    )
    .bind(command.agentDefinitionId, organisationId, command.definitionRevision)
    .first<{ requestedCapabilities: unknown }>();
  if (definition === null) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "agentDefinitionId",
    });
  }
  const requestedCapabilities = parseStoredStringArray(
    definition.requestedCapabilities,
  );
  if (
    requestedCapabilities === null ||
    command.grantedCapabilities.some(
      (capability) => !requestedCapabilities.includes(capability),
    )
  ) {
    throw new AgentOperationFailure({
      code: "agent_operation_conflict",
      field: "grantedCapabilities",
    });
  }
  const area = await db
    .prepare(
      `SELECT 1 AS present FROM operational_area
     WHERE area_id = ? AND organisation_id = ? AND lifecycle = 'active'`,
    )
    .bind(command.areaId, organisationId)
    .first<{ present: number }>();
  if (area === null) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "areaId",
    });
  }
  await requirePublishedScopes(
    db,
    organisationId,
    command.areaId,
    command.scopeIds,
  );
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `INSERT INTO agent_installation (
         installation_id, organisation_id, agent_definition_id, definition_revision,
         policy_revision, granted_capabilities_json, lifecycle,
         created_by_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .bind(
          command.operationId,
          organisationId,
          command.agentDefinitionId,
          command.definitionRevision,
          command.policyRevision,
          JSON.stringify(command.grantedCapabilities),
          command.actorUserId,
          command.now,
          command.now,
        ),
      db
        .prepare(
          `INSERT INTO agent_area_assignment (
         installation_id, area_id, responsibility, scope_ids_json, assigned_at
       ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          command.operationId,
          command.areaId,
          command.responsibility,
          JSON.stringify(command.scopeIds),
          command.now,
        ),
    ],
    trailing,
  );
}

export async function requireActiveInstallation(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  installationId: string,
): Promise<void> {
  const installation = await db
    .prepare(
      `SELECT 1 AS present FROM agent_installation
     WHERE installation_id = ? AND organisation_id = ? AND lifecycle = 'active'`,
    )
    .bind(installationId, organisationId)
    .first<{ present: number }>();
  if (installation === null) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "installationId",
    });
  }
}

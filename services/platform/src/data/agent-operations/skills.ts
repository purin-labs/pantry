import type { OrganisationDatabase } from "../../database-handles";
import type { OrganisationId } from "../../ids";
import type { Variant } from "@purin-labs/type-utils";
import { sha256Hex } from "@purin-labs/std";
import type { AgentSkillRef } from "@purin-labs/control-api";
import type { AgentOperationCommand } from "../agent-operations";
import { AgentOperationFailure, commitWithTrailing } from "./failure";
import { positive } from "./input";

export async function createSkill(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "create_skill">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  const digest = await sha256Hex(command.markdownBody);
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `INSERT INTO skill (
         skill_id, organisation_id, title, sensitivity, lifecycle, current_revision,
         created_by_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'published', 1, ?, ?, ?)`,
        )
        .bind(
          command.operationId,
          organisationId,
          command.title,
          command.sensitivity,
          command.actorUserId,
          command.now,
          command.now,
        ),
      db
        .prepare(
          `INSERT INTO skill_revision (
         skill_id, organisation_id, revision, markdown_body, content_digest,
         authored_by_user_id, created_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
        )
        .bind(
          command.operationId,
          organisationId,
          command.markdownBody,
          digest,
          command.actorUserId,
          command.now,
        ),
    ],
    trailing,
  );
}

export async function publishSkillRevision(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "publish_skill_revision">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  const current = await db
    .prepare(
      `SELECT current_revision AS currentRevision
       FROM skill
      WHERE skill_id = ? AND organisation_id = ? AND lifecycle = 'published'`,
    )
    .bind(command.skillId, organisationId)
    .first<{ readonly currentRevision: unknown }>();
  if (current === null) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "skillId",
    });
  }
  const currentRevision = positive(current.currentRevision);
  if (currentRevision !== command.expectedRevision) {
    throw new AgentOperationFailure({
      code: "agent_operation_conflict",
      field: "expectedRevision",
    });
  }
  const nextRevision = currentRevision + 1;
  const digest = await sha256Hex(command.markdownBody);
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `INSERT INTO skill_revision (
         skill_id, organisation_id, revision, markdown_body, content_digest,
         authored_by_user_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          command.skillId,
          organisationId,
          nextRevision,
          command.markdownBody,
          digest,
          command.actorUserId,
          command.now,
        ),
      db
        .prepare(
          `UPDATE skill
          SET current_revision = ?, updated_at = ?
        WHERE skill_id = ? AND organisation_id = ?
          AND lifecycle = 'published' AND current_revision = ?`,
        )
        .bind(
          nextRevision,
          command.now,
          command.skillId,
          organisationId,
          currentRevision,
        ),
    ],
    trailing,
  );
}

/**
 * Confirms every attached skill revision exists under this organisation. A definition
 * revision names exact skill revisions, so an unpublished skill or a revision
 * that was never authored must fail before the revision is written.
 */
export async function requirePublishedSkillRefs(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  skillRefs: readonly AgentSkillRef[],
): Promise<void> {
  if (skillRefs.length === 0) {
    return;
  }
  if (new Set(skillRefs.map((ref) => ref.skillId)).size !== skillRefs.length) {
    throw new AgentOperationFailure({
      code: "agent_operation_invalid",
      field: "skillRefs",
    });
  }
  const predicate = skillRefs
    .map(() => "(revision.skill_id = ? AND revision.revision = ?)")
    .join(" OR ");
  const bindings = skillRefs.flatMap((ref) => [ref.skillId, ref.revision]);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM skill_revision AS revision
       JOIN skill
         ON skill.skill_id = revision.skill_id
        AND skill.organisation_id = revision.organisation_id
        AND skill.lifecycle = 'published'
      WHERE revision.organisation_id = ? AND (${predicate})`,
    )
    .bind(organisationId, ...bindings)
    .first<{ count: unknown }>();
  if (row === null || row.count !== skillRefs.length) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "skillRefs",
    });
  }
}

export function encodeSkillRefs(skillRefs: readonly AgentSkillRef[]): string {
  return JSON.stringify(
    skillRefs.map((ref) => ({ skillId: ref.skillId, revision: ref.revision })),
  );
}

export async function bindSkill(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "bind_skill">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  const skill = await db
    .prepare(
      `SELECT 1 AS present FROM skill_revision
     WHERE skill_id = ? AND organisation_id = ? AND revision = ?`,
    )
    .bind(command.skillId, organisationId, command.skillRevision)
    .first<{ present: number }>();
  if (skill === null) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "skillId",
    });
  }
  const target = await db
    .prepare(
      `SELECT 1 AS present FROM operational_area WHERE area_id = ? AND organisation_id = ?`,
    )
    .bind(command.targetId, organisationId)
    .first<{ present: number }>();
  if (target === null) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "targetId",
    });
  }
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `INSERT INTO skill_binding (
       binding_id, organisation_id, target_kind, target_id, skill_id,
       skill_revision, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          command.operationId,
          organisationId,
          command.targetKind,
          command.targetId,
          command.skillId,
          command.skillRevision,
          command.now,
        ),
    ],
    trailing,
  );
}

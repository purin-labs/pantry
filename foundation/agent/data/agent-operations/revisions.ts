import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type {
  AgentDefinitionRevision,
  SkillRevision,
} from "../agent-operations";
import { integer, positive, text } from "./input";
import { jsonSkillRefs, jsonStrings } from "./rows";

const REVISION_HISTORY_LIMIT = 50;

/**
 * Newest-first revision history for one agent definition (plan 30 R6). At
 * most the most recent 50 revisions; a definition always has at least one.
 */
export async function readAgentDefinitionRevisions(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  agentDefinitionId: string,
): Promise<readonly AgentDefinitionRevision[]> {
  const rows = (
    await db
      .prepare(
        `SELECT agent_definition_id AS agentDefinitionId, revision, instructions,
            requested_capabilities_json AS requestedCapabilities,
            skill_refs_json AS skillRefs, content_digest AS contentDigest,
            authored_by_user_id AS authoredBy, created_at AS createdAt
     FROM agent_definition_revision
     WHERE agent_definition_id = ? AND organisation_id = ?
     ORDER BY revision DESC LIMIT ${REVISION_HISTORY_LIMIT}`,
      )
      .bind(agentDefinitionId, organisationId)
      .all<Record<string, unknown>>()
  ).results;
  return rows.map((row) => ({
    agentDefinitionId: text(row.agentDefinitionId),
    revision: positive(row.revision),
    instructions: text(row.instructions),
    requestedCapabilities: jsonStrings(row.requestedCapabilities),
    skillRefs: jsonSkillRefs(row.skillRefs),
    contentDigest: text(row.contentDigest),
    authoredBy: text(row.authoredBy),
    createdAt: integer(row.createdAt),
  }));
}

/** Newest-first revision history for one skill (plan 30 R6). */
export async function readSkillRevisions(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  skillId: string,
): Promise<readonly SkillRevision[]> {
  const rows = (
    await db
      .prepare(
        `SELECT skill_id AS skillId, revision, markdown_body AS markdownBody,
            content_digest AS contentDigest,
            authored_by_user_id AS authoredBy, created_at AS createdAt
     FROM skill_revision
     WHERE skill_id = ? AND organisation_id = ?
     ORDER BY revision DESC LIMIT ${REVISION_HISTORY_LIMIT}`,
      )
      .bind(skillId, organisationId)
      .all<Record<string, unknown>>()
  ).results;
  return rows.map((row) => ({
    skillId: text(row.skillId),
    revision: positive(row.revision),
    markdownBody: text(row.markdownBody),
    contentDigest: text(row.contentDigest),
    authoredBy: text(row.authoredBy),
    createdAt: integer(row.createdAt),
  }));
}

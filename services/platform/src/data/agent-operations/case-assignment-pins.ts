import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { CaseAssignmentPin } from "../agent-operations";
import { type RawCaseAssignmentPin, parseCaseAssignmentPinRow } from "./rows";
import { encodeSkillRefs } from "./skills";

export async function recordCaseAssignmentPin(
  scope: OrganisationExecutionScope,
  pin: CaseAssignmentPin,
): Promise<void> {
  const statement = scope.database
    .prepare(
      `INSERT OR IGNORE INTO case_assignment_pin (
       organisation_id, assignment_id, case_id, installation_id, agent_definition_id,
       definition_revision, policy_revision, skill_refs_json,
       granted_capabilities_json, max_session_budget_tokens, pinned_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      pin.organisationId,
      pin.assignmentId,
      pin.caseId,
      pin.installationId,
      pin.agentDefinitionId,
      pin.definitionRevision,
      pin.policyRevision,
      encodeSkillRefs(pin.skillRefs),
      JSON.stringify(pin.grantedCapabilities),
      pin.maxSessionBudgetTokens,
      pin.pinnedAt,
    );
  await scope.database.batch([statement, scope.prepareMutationFence()]);
}

export async function readCaseAssignmentPin(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  assignmentId: string,
): Promise<CaseAssignmentPin | null> {
  const row = await db
    .prepare(
      `SELECT organisation_id AS organisationId, assignment_id AS assignmentId, case_id AS caseId,
            installation_id AS installationId, agent_definition_id AS agentDefinitionId,
            definition_revision AS definitionRevision, policy_revision AS policyRevision,
            skill_refs_json AS skillRefs,
            granted_capabilities_json AS grantedCapabilities,
            max_session_budget_tokens AS maxSessionBudgetTokens, pinned_at AS pinnedAt
     FROM case_assignment_pin WHERE organisation_id = ? AND assignment_id = ?`,
    )
    .bind(organisationId, assignmentId)
    .first<RawCaseAssignmentPin>();
  return row === null ? null : parseCaseAssignmentPinRow(row);
}

import type { CaseAssignment } from "@purin-labs/contracts";
import {
  COLLABORATION_AGENT_COLOR_KEYS,
  isShortProtocolText,
  type CollaborationAgent,
  type CollaborationAgentColorKey,
} from "@purin-labs/collaboration";
import { merchantAgentAgentId } from "../data/merchant-agent-preset";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";

/** Names come from the admitted assignment, never from a tool argument. */
/** The agent's name, as the label of its command on a page shows it. */
export async function collaborationAgentLabel(
  scope: OrganisationExecutionScope,
  assignment: CaseAssignment,
): Promise<string> {
  return (await resolveCollaborationAgent(scope, assignment)).displayName;
}

export async function resolveCollaborationAgent(
  scope: OrganisationExecutionScope,
  assignment: CaseAssignment,
): Promise<CollaborationAgent> {
  const pinned = await readAgentPin(scope, assignment);
  return { sessionId: assignment.sessionId, displayName: pinned.displayName };
}

/**
 * The agent as a canvas draws it (Plan 40B phase 7): with the colour of its
 * agent definition. Sous Chef, the default agent, has the first colour; another
 * definition takes a colour from its ID, so it keeps it in every room.
 */
export async function resolveCanvasCollaborationAgent(
  scope: OrganisationExecutionScope,
  assignment: CaseAssignment,
): Promise<CollaborationAgent> {
  const pinned = await readAgentPin(scope, assignment);
  return {
    sessionId: assignment.sessionId,
    displayName: pinned.displayName,
    colorKey: agentColorKey(
      pinned.definitionId,
      merchantAgentAgentId(scope.organisationId),
    ),
  };
}

async function readAgentPin(
  scope: OrganisationExecutionScope,
  assignment: CaseAssignment,
): Promise<Readonly<{ displayName: string; definitionId: string | null }>> {
  const row = await scope.database
    .prepare(
      `SELECT definition.display_name AS displayName,
       definition.agent_definition_id AS definitionId
     FROM case_assignment_pin AS pin
     JOIN agent_definition AS definition
       ON definition.organisation_id = pin.organisation_id
       AND definition.agent_definition_id = pin.agent_definition_id
     WHERE pin.organisation_id = ? AND pin.assignment_id = ? AND pin.case_id = ?`,
    )
    .bind(scope.organisationId, assignment.assignmentId, assignment.caseId)
    .first<{ displayName: unknown; definitionId: unknown }>();
  if (!isShortProtocolText(assignment.sessionId))
    throw new Error("collaboration_agent_identity_invalid");
  if (row !== null && !isShortProtocolText(row.displayName))
    throw new Error("collaboration_agent_name_invalid");
  return row === null
    ? { displayName: "Sous Chef", definitionId: null }
    : {
        displayName: String(row.displayName),
        definitionId: String(row.definitionId),
      };
}

function agentColorKey(
  definitionId: string | null,
  defaultDefinitionId: string,
): CollaborationAgentColorKey {
  if (definitionId === null || definitionId === defaultDefinitionId)
    return COLLABORATION_AGENT_COLOR_KEYS[0];
  let hash = 2166136261;
  for (const character of definitionId)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const others = COLLABORATION_AGENT_COLOR_KEYS.slice(1);
  return (
    others[(hash >>> 0) % others.length] ?? COLLABORATION_AGENT_COLOR_KEYS[0]
  );
}

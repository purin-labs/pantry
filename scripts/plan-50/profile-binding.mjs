import { sha256Hex } from "../../packages/std/src/index.ts";
import { applyAgentOperation } from "../../foundation/agent/data/agent-operations.ts";
import {
  composeAgentInstructions,
  resolveCaseTurnAgentProfile,
} from "../../foundation/agent/data/pinned-agent-profile.ts";
import { OrganisationExecutionScope } from "../../foundation/tenancy/organisation-execution-scope.ts";

const installationId = "installation_plan50_native";
const definitionId = "definition_plan50_native";
const skillId = "skill_plan50_native";
const instructions =
  "Propose price changes through the governed commerce tool.";
const skillBody =
  "Keep the original offer revision and wait for operator approval.";

function required(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export async function installProfile(db, organisationId, userId, capabilities) {
  const present = await db
    .prepare(
      "SELECT installation_id FROM agent_installation WHERE installation_id = ? AND organisation_id = ?",
    )
    .bind(installationId, organisationId)
    .first();
  if (present !== null) return;
  const commands = [
    {
      kind: "create_area",
      operationId: "area_plan50_native",
      name: "Native execution",
      purpose: "Governed price proposals",
    },
    {
      kind: "create_skill",
      operationId: skillId,
      title: "Price approval",
      sensitivity: "ordinary",
      markdownBody: skillBody,
    },
    {
      kind: "create_agent_definition",
      operationId: definitionId,
      displayName: "Native proposal agent",
      role: "Merchant assistant",
      purpose: "Prepare governed proposals",
      instructions,
      requestedCapabilities: capabilities,
      skillRefs: [{ skillId, revision: 1 }],
    },
    {
      kind: "install_agent",
      operationId: installationId,
      agentDefinitionId: definitionId,
      definitionRevision: 1,
      areaId: "area_plan50_native",
      responsibility: "Price proposals",
      scopeIds: [],
      policyRevision: 1,
      grantedCapabilities: capabilities,
    },
  ];
  for (const command of commands)
    required(
      await applyAgentOperation(db, organisationId, {
        ...command,
        actorUserId: userId,
        now: Date.now(),
      }),
    );
}

export async function resolveProfileBinding(
  env,
  organisationId,
  assignment,
  implementationVersion,
) {
  const scope = required(
    await OrganisationExecutionScope.resolve(env, organisationId),
  );
  const resolved = await resolveCaseTurnAgentProfile(scope, {
    assignmentId: assignment.assignmentId,
    caseId: assignment.caseId,
    // The trial pins its agent at the first turn; later turns read the pin.
    assignment: "new",
    selection: { kind: "installed", installationId },
    now: Date.now(),
  });
  if (resolved.kind !== "resolved") return resolved;
  const profile = resolved.profile;
  const digest = await sha256Hex(JSON.stringify(profile));
  return {
    kind: "resolved",
    profile,
    extensionName: `pantry-trusted-tools/v${implementationVersion}/${digest}`,
    instructions: composeAgentInstructions(
      "Use only admitted tools. Preserve source restrictions.",
      profile,
    ),
  };
}

export async function publishProfileUpdate(
  db,
  organisationId,
  userId,
  capabilities,
) {
  const commands = [
    {
      kind: "publish_skill_revision",
      operationId: "skill_plan50_update",
      skillId,
      expectedRevision: 1,
      markdownBody: "New assignments use the updated price review skill.",
    },
    {
      kind: "publish_agent_definition_revision",
      operationId: "definition_plan50_update",
      agentDefinitionId: definitionId,
      expectedRevision: 1,
      instructions: "New assignments use updated merchant instructions.",
      requestedCapabilities: capabilities,
      skillRefs: [{ skillId, revision: 2 }],
    },
    {
      kind: "activate_agent_definition_revision",
      operationId: "installation_plan50_update",
      installationId,
      expectedDefinitionRevision: 1,
      definitionRevision: 2,
      skillRefs: [{ skillId, revision: 2 }],
    },
  ];
  for (const command of commands)
    required(
      await applyAgentOperation(db, organisationId, {
        ...command,
        actorUserId: userId,
        now: Date.now(),
      }),
    );
}

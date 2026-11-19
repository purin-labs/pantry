import type { AgentOperationCommand } from "@purin-labs/control-api/portal/agent-operations";

type Activation = Extract<
  AgentOperationCommand,
  { kind: "activate_agent_definition_revision" }
>;

const identity = {
  installationId: "installation_urk",
  expectedDefinitionRevision: 1,
  definitionRevision: 2,
};

// @ts-expect-error Activation must confirm the published skill revisions.
export const missingSkills: Activation = {
  kind: "activate_agent_definition_revision",
  ...identity,
};

export const confirmedSkills: Activation = {
  kind: "activate_agent_definition_revision",
  ...identity,
  skillRefs: [{ skillId: "skill_urk_performance_insights", revision: 1 }],
};

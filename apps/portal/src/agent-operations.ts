import type {
  AgentOperationCommand,
  AgentOperationsSnapshot,
  AgentRevisionTarget,
} from "@purin-labs/commerce-control-api/portal/agent-operations";

export const EMPTY_AGENT_OPERATIONS_SNAPSHOT: AgentOperationsSnapshot = {
  areas: [],
  responsibilityScopes: [],
  definitions: [],
  installations: [],
  skills: [],
  bindings: [],
  cueBindings: [],
  scheduleBindings: [],
  governance: [],
  escalationPolicies: [],
  configurationProposals: [],
  activeCases: [],
  actionLedger: [],
  commerceExceptions: {
    kind: "unavailable",
    reason: "commerce_system_unavailable",
  },
};

export type AgentOperationsTransport = {
  readonly read: (organisationId: string) => Promise<unknown>;
  readonly mutate: (
    organisationId: string,
    command: AgentOperationCommand,
    mutationIntent: string,
  ) => Promise<unknown>;
  readonly readRevisions: (
    organisationId: string,
    target: AgentRevisionTarget,
  ) => Promise<unknown>;
};

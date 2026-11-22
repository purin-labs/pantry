import type {
  AgentProfileSelection,
  CaseTurnAgentProfileResolution,
} from "@purin-labs/agent/data/pinned-agent-profile";

// @ts-expect-error A resolved outcome requires a profile.
const missingProfile: CaseTurnAgentProfileResolution = { kind: "resolved" };

// @ts-expect-error An unavailable outcome requires its failure reason.
const missingError: CaseTurnAgentProfileResolution = { kind: "unavailable" };

void missingProfile;
void missingError;

// @ts-expect-error Explicit selection requires the agent's display name.
export const missingAgentName: AgentProfileSelection = { kind: "named" };

// @ts-expect-error Automatic selection cannot carry an explicit name.
export const conflictingSelection: AgentProfileSelection = {
  kind: "automatic",
  displayName: "Urk",
};

const automaticSelection: AgentProfileSelection = { kind: "automatic" };
// @ts-expect-error Spreading automatic selection cannot create a named branch.
export const conflictingSpread: AgentProfileSelection = {
  ...automaticSelection,
  displayName: "Urk",
};

// @ts-expect-error Bound installations require an exact identity.
export const missingInstallation: AgentProfileSelection = { kind: "installed" };

const conflictingInstallationInput = {
  kind: "installed" as const,
  installationId: "installation_mail",
  displayName: "Urk",
};

// @ts-expect-error An installation selection cannot also select by display name.
export const conflictingInstallation: AgentProfileSelection =
  conflictingInstallationInput;

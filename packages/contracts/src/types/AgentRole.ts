/** The role of an agent's assignment in a Case. */
export type AgentRole = "coordinator" | "specialist";

export function isAgentRole(value: unknown): value is AgentRole {
  return value === "coordinator" || value === "specialist";
}

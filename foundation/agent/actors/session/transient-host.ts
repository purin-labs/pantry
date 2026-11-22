import type { Env } from "@purin-labs/kernel/env";
import type { AgentSessionPersistence } from "../agent-session-schema";
import type { PiToolRules } from "../pi-tool-replay";

/**
 * What the Session gives to a module that runs a transient turn: a turn that
 * keeps no Session history. A product area owns the module, for example the
 * mailbox turn of the Inbox. The class of the Worker gives the module its RPC
 * method and tracks the turn with `trackTransientTurn`.
 */
export interface SessionTransientHost {
  readonly env: Env;
  readonly ctx: DurableObjectState;
  readonly persistence: AgentSessionPersistence;
  /** The goal runs that this process holds. The module adds and removes its own. */
  readonly liveGoalRuns: Set<string>;
  /** The rules of a tool, from the one list of the agent tools. */
  readonly toolRules: (name: string) => PiToolRules;
}

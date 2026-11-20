import { SESSION_TOOL_WIRING } from "../agent-tools/session-wiring";
import { SessionActor } from "./session/session-actor";
import type { SessionToolWiring } from "./session/tool-wiring";

/**
 * The Session Durable Object class of the Worker. It keeps the deployed class
 * name. The Session actor holds the logic and names no product area: this
 * class gives it the one list of the agent tools and the parts of the areas.
 */
export class SessionDO extends SessionActor {
  protected sessionTools(): SessionToolWiring {
    return SESSION_TOOL_WIRING;
  }
}

declare module "../env" {
  interface Env {
    SESSION: DurableObjectNamespace<SessionDO>;
  }
}

import { SESSION_TOOL_WIRING } from "../agent-tools/session-wiring";
import { authorizeChatHarnessLease } from "../chat/turn-access";
import type {
  SessionInboxTurnsRpc,
  TransientEmailTurnRequest,
  TransientEvalTurnRequest,
  TransientMailAssistantRequest,
  TransientWhatsAppTurnRequest,
} from "./inbox-turns/rpc";
import {
  prepareTransientEmailTurn,
  prepareTransientEvalTurn,
  prepareTransientMailAssistant,
  prepareTransientWhatsAppTurn,
} from "./inbox-turns/session-turns";
import { ACTOR_MACHINES } from "./actor-machines";
import { SessionActor } from "./session/session-actor";
import type { SessionToolWiring } from "./session/tool-wiring";
import { registerSessionTurnAccess } from "./session-turn-access";

// The conversation module owns the access rule of a Session turn.
registerSessionTurnAccess(authorizeChatHarnessLease);

/**
 * The Session Durable Object class of the Worker. It keeps the deployed class
 * name and the RPC method names. The Session actor holds the logic and names
 * no product area. This class gives it the one list of the agent tools and
 * the parts of the areas, and it registers the modules of the areas: each
 * RPC method of a module calls one function of that module.
 */
export class SessionDO extends SessionActor implements SessionInboxTurnsRpc {
  protected sessionTools(): SessionToolWiring {
    return SESSION_TOOL_WIRING;
  }

  protected actorMachines() {
    return ACTOR_MACHINES;
  }

  // The transient turns of the Inbox (`actors/inbox-turns/`).

  async runTransientEmailTurn(input: TransientEmailTurnRequest) {
    return this.trackTransientTurn(
      prepareTransientEmailTurn.bind(null, this.transientHost(), input),
    );
  }

  async runTransientEvalTurn(input: TransientEvalTurnRequest) {
    return this.trackTransientTurn(
      prepareTransientEvalTurn.bind(null, this.transientHost(), input),
    );
  }

  async runTransientMailAssistant(input: TransientMailAssistantRequest) {
    return this.trackTransientTurn(
      prepareTransientMailAssistant.bind(null, this.transientHost(), input),
    );
  }

  async runTransientWhatsAppTurn(input: TransientWhatsAppTurnRequest) {
    return this.trackTransientTurn(
      prepareTransientWhatsAppTurn.bind(null, this.transientHost(), input),
    );
  }
}

declare module "@purin-labs/kernel/env" {
  interface Env {
    SESSION: DurableObjectNamespace<SessionDO>;
  }
}

import type { BakeryBrowserContext } from "@purin-labs/bakery-model/bakery-context";
import type { EffectiveGrantSet } from "../../authorization/access-grants";
import type {
  ToolRegistry,
  ToolServiceSet,
} from "../../agent-tools/catalog/tool-registry";
import type { SessionToolContext } from "../../agent-tools/context";
import type { OrganisationId, RequestId } from "../../ids";
import type { HarnessToolArgumentObserver } from "../embedded-harness";

/**
 * One turn of the Session, as the tool families see it: the authority of the
 * turn and the facts that some tools need. The Session builds it once for a
 * turn, after the admission, the lease and the Case assignment are known.
 */
export interface ToolTurnContext extends SessionToolContext {
  /** The request that started the turn. */
  readonly requestId: RequestId;
  /** The Organisation that asked for the turn. */
  readonly organisationId: OrganisationId;
  /** The Session of the turn, from its lifecycle record. */
  readonly sessionId: string;
  /** The words of the person for this turn. */
  readonly turnPrompt: string;
  /** What the person's page gave with the message. */
  readonly browserContext: BakeryBrowserContext;
  /** The grants of the turn's authority partition, for a custom connector. */
  readonly effectiveGrantSet: EffectiveGrantSet;
}

/**
 * What the Worker gives to the Session: the one list of the agent tools and
 * the parts that the product areas give for a turn. The Session names no
 * tool family of an area. It asks this value.
 */
export interface SessionToolWiring {
  /** The tools, in the order of the model definitions. */
  readonly registry: ToolRegistry;
  /** The services of each tool family that an area owns, by family name. */
  areaServices(turn: ToolTurnContext): ToolServiceSet;
  /** Sees the arguments of a tool call while the model writes them. */
  argumentObserver(turn: SessionToolContext): HarnessToolArgumentObserver;
}

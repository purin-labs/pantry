import type { BakeryBrowserContext } from "@purin-labs/bakery-model/bakery-context";
import type {
  BakerySurfaceAttachmentV1,
  BakerySurfaceReceiptV1,
} from "@purin-labs/bakery-model/bakery-surface";
import type { HarnessTurnLease } from "@purin-labs/contracts";
import type { EffectiveGrantSet } from "../../authorization/access-grants";
import type {
  ToolRegistry,
  ToolServiceSet,
  TurnTool,
} from "../../agent-tools/catalog/tool-registry";
import type { SessionToolContext } from "../../agent-tools/context";
import type { OrganisationDatabase } from "../../database-handles";
import type { OrganisationId, RequestId } from "../../ids";
import type { Result } from "../../result";
import type { HarnessToolArgumentObserver } from "../embedded-harness";

/**
 * The wire forms of a person's page: what the page gave with a message, the
 * state of the page, and the receipt of an effect that the page showed.
 * Kitchen owns the forms. This file is the one place where the Session names
 * them: it carries the values and does not read them.
 */
export type TurnPageContext = BakeryBrowserContext;
export type TurnPageState = BakerySurfaceAttachmentV1;
export type PageEffectReceipt = BakerySurfaceReceiptV1;

/** What the Session answers for the receipt of a page effect. */
export type PageEffectSettlement =
  | Readonly<{ ok: true; kind: "accepted" | "duplicate" }>
  | Readonly<{
      ok: false;
      code:
        | "surface_effect_missing"
        | "surface_effect_conflict"
        | "surface_effect_receipt_invalid"
        | "surface_effect_organisation_mismatch"
        | "surface_effect_expired"
        | "surface_effect_authority_invalid";
    }>;

/**
 * The effects that an agent shows on a person's page. The Session stores
 * them in its SQLite, and the area of the page owns their rules.
 */
export interface SessionPageEffects {
  /** The page commands that the authority of a turn may use. */
  authorizedCommands(
    authority: HarnessTurnLease["requestAuthority"],
  ): readonly string[];
  /** Checks the page state that came with a message. */
  normalizeState(
    raw: TurnPageState | null,
  ): Promise<Result<TurnPageState | null, { readonly code: string }>>;
  /** Accepts the receipt that a page sent for one effect. */
  settle(
    input: Readonly<{
      db: OrganisationDatabase;
      storage: DurableObjectStorage;
      organisationId: OrganisationId;
      receipt: PageEffectReceipt;
    }>,
  ): Promise<PageEffectSettlement>;
  /** Repairs the effects that wait, on the Session's alarm. */
  reconcile(
    input: Readonly<{
      db: OrganisationDatabase;
      storage: DurableObjectStorage;
    }>,
  ): Promise<void>;
  /** Moves the receipt collection to the lease of a recovered turn. */
  rebindRecovery(
    sql: SqlStorage,
    previous: HarnessTurnLease,
    next: HarnessTurnLease,
  ): void;
}

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
  readonly browserContext: TurnPageContext;
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
  /**
   * The tools that a turn adds to the list, for example the operations of a
   * custom connector that the grants of the turn select.
   */
  turnTools(
    input: Readonly<{
      database: Pick<OrganisationDatabase, "prepare">;
      effectiveGrants: EffectiveGrantSet;
    }>,
  ): Promise<Result<readonly TurnTool[], Readonly<{ code: string }>>>;
  /** The services of each tool family that an area owns, by family name. */
  areaServices(turn: ToolTurnContext): ToolServiceSet;
  /** The effects on a person's page. Kitchen gives them. */
  readonly pageEffects: SessionPageEffects;
  /** Sees the arguments of a tool call while the model writes them. */
  argumentObserver(turn: SessionToolContext): HarnessToolArgumentObserver;
}

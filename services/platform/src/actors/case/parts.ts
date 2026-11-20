import type { RequestAuthority } from "@purin-labs/contracts";
import type { CommerceProviderReceipt } from "@purin-labs/control-api";
import type { Variant } from "@purin-labs/type-utils";
import type { ConversationExecution } from "../../chat/execution";
import type { Env } from "../../env";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import type { ConversationCaseActor } from "../case-direct-processing";
import type { CaseCommerceProposalBody, CaseEntityPlaneCommand } from "./types";

/**
 * The parts that the product areas and the surfaces give to the Case
 * (Refactor 17, step A1.6 for the Case). A Case stores values of the areas: a commerce proposal, an
 * email reply proposal, a page of Kitchen. It keeps each value as the JSON
 * that it received, and it reads only the fields that its own types name. The
 * area checks the rest of the value through its part.
 *
 * `CaseDO`, the class of the Worker, gives the parts. `CaseActor` provides
 * them in its constructor, before it reads a stored value.
 */
export type CaseParts = Readonly<{
  commerce: CaseCommercePart;
  inbox: CaseInboxPart;
  portalChat: CasePortalChatPart;
}>;

/** The checks of the commerce values in a Case. */
export type CaseCommercePart = Readonly<{
  /**
   * The action, the authority and the source record of a commerce proposal.
   * Null when one of them is not valid, or when they do not agree.
   */
  parseProposalBody(
    value: Readonly<{
      action: unknown;
      authority: unknown;
      provenance: unknown;
    }>,
  ): CaseCommerceProposalBody | null;
  /** The command of an entity plane proposal, or null. */
  parseEntityPlaneCommand(value: unknown): CaseEntityPlaneCommand | null;
  /** The receipt of a commerce provider for an action, or null. */
  parseProviderReceipt(value: unknown): CommerceProviderReceipt | null;
}>;

/** The parts of the Inbox that a Case trigger needs. */
export type CaseInboxPart = Readonly<{
  /** The Connector that admits the work of a mailbox or a WhatsApp number. */
  triggerConnectorId(
    authority: Variant<RequestAuthority, "agent_mailbox" | "whatsapp_support">,
  ): string;
}>;

/** The Portal chat part: a Case runs the turn of a Portal chat. */
type CasePortalChatPart = Readonly<{
  /** Resumes the chat turn that the Case scheduled; "pending" waits for the alarm. */
  resumeExecution(
    env: Env,
    scope: OrganisationExecutionScope,
    execution: ConversationExecution,
    caseActor: ConversationCaseActor,
  ): Promise<"settled" | "pending">;
}>;

let provided: CaseParts | null = null;

/** Gives the parts to the Case modules. The Case actor calls it. */
export function provideCaseParts(parts: CaseParts): void {
  provided = parts;
}

/** The parts that the Worker gave. A read before the Case actor starts is a programmer error. */
export function caseParts(): CaseParts {
  if (provided === null)
    throw new Error("The Case parts are read before the Case actor started.");
  return provided;
}

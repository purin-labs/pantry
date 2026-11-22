import type { RequestableEntityTypeRead } from "@purin-labs/authority/authorization/requestable-capabilities";

/**
 * A tool request that was refused, in words that the agent can act on. The
 * executor gives the message to the model as the failure text of the call. A
 * product area extends this class for its own refusals; the executor knows
 * only the base. Any other error reaches the model as a generic failure.
 */
export class ToolRequestError extends Error {
  constructor(
    message: string,
    /**
     * The record type or types whose read grants would admit the request, when
     * a permission request may ask for them. The executor then asks a person
     * in place of the denial.
     */
    readonly requestableRead:
      | RequestableEntityTypeRead
      | readonly RequestableEntityTypeRead[]
      | null = null,
  ) {
    super(message);
  }
}

/**
 * A tool argument that the agent can correct: the message names the field and
 * reaches the model as the tool's failure text.
 */
export class ProposalArgumentError extends ToolRequestError {}

/** The exit check stopped a tool effect, and Pantry asked a person (Plan 27C). */
export class ExitApprovalRequestedError extends ToolRequestError {}

/**
 * A step of a staff page that was refused, in words that the agent can act on.
 * It names no buyer.
 */
export class StaffPageRequestError extends ToolRequestError {}

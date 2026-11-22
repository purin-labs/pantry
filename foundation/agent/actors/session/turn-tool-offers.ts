import type { HarnessTurnLease } from "@purin-labs/contracts";

/**
 * The rules that say if a turn offers a tool by its origin. The Session
 * reads them for the tool selection, and the handler of each tool checks its
 * rule again when the model calls it.
 */

/** The turn of a Slack message is `turn_` and its Case ingress id. */
export const SLACK_TURN_PREFIX = "turn_ingress_slack_";

/**
 * Whether a turn is offered the follow-up tool: a turn of a message in a
 * Slack thread. The follow-up is Case work of that thread's Connector.
 */
export function turnMayScheduleFollowUp(
  authority: HarnessTurnLease["requestAuthority"],
  turnId: string,
): boolean {
  return (
    (authority.kind === "direct_conversation" ||
      authority.kind === "shared_conversation") &&
    turnId.startsWith(SLACK_TURN_PREFIX)
  );
}

/**
 * Whether a turn is offered the Memory proposal tool. It is the rule of the
 * Memory commands of the Portal: a signed-in owner or admin. The call itself
 * checks that the authority is still live and that the turn started from a
 * message in a Portal conversation.
 */
export function turnMayProposeMemory(
  authority: HarnessTurnLease["requestAuthority"],
): boolean {
  return (
    authority.kind === "control" &&
    (authority.role === "admin" || authority.role === "owner")
  );
}

/**
 * Whether a turn is offered the side Case tool (Plan 74): a step of a Portal
 * chat that a person's message started, or a turn of a Slack thread.
 * `conversationSession` is true when the Session runs the steps of a Portal
 * chat. The call checks the chat or the thread again.
 */
export function turnMayProposeSideCase(
  authority: HarnessTurnLease["requestAuthority"],
  turnId: string,
  conversationSession: boolean,
): boolean {
  return (
    turnMayScheduleFollowUp(authority, turnId) ||
    (authority.kind === "control" &&
      conversationSession &&
      turnId.startsWith("turn_trigger_"))
  );
}

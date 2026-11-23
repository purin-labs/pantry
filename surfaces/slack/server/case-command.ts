import type { RequestAuthority } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";

import type { RequestId } from "@purin-labs/kernel/ids";
import {
  createSlackCaseCommand,
  slackConversationAuthorityKind,
  type SlackCaseCommand,
} from "./case-command-message";
import {
  buildDirectSlackAuthority,
  buildSharedSlackAuthority,
} from "@purin-labs/authority/request-authority/index";
import type { SlackMessageEvent } from "./events";
import type { AuthorizedSlackCaseIngress } from "./ingress-admission";

/**
 * Build the Case command for an admitted Slack message. Returns null when the
 * conversation is one Pantry accepts no commands from.
 */
export function buildAdmittedSlackCaseCommand(input: {
  readonly requestId: RequestId;
  readonly receivedAt: number;
  readonly event: SlackMessageEvent;
  readonly ingress: AuthorizedSlackCaseIngress;
}): SlackCaseCommand | null {
  const authorityKind = slackConversationAuthorityKind(input.event.channelId);
  if (authorityKind === null) return null;
  return createSlackCaseCommand({
    requestId: input.requestId,
    receivedAt: input.receivedAt,
    organisationId: input.ingress.organisationId,
    integrationAccountId: input.ingress.integrationAccountId,
    event: input.event,
    principalId: input.ingress.principalId,
    userId: input.ingress.userId,
    requestAuthority: buildSlackCaseRequestAuthority(authorityKind, {
      organisationId: input.ingress.organisationId,
      requesterPersonId: input.ingress.principalId,
      membershipRevision: input.ingress.membershipRevision,
      role: input.ingress.membershipRole,
      connectorId: input.ingress.connectorId,
      integrationAccountId: input.ingress.integrationAccountId,
      conversationId: input.event.channelId,
    }),
    target: {
      caseId: input.ingress.caseId,
      connectorId: input.ingress.connectorId,
      sessionId: input.ingress.sessionId,
      assignmentId: input.ingress.assignmentId,
      placement: input.ingress.placement,
    },
  });
}

function buildSlackCaseRequestAuthority(
  kind: "direct_conversation" | "shared_conversation",
  input: Parameters<typeof buildDirectSlackAuthority>[0],
): Variant<RequestAuthority, "direct_conversation" | "shared_conversation"> {
  const authority =
    kind === "direct_conversation"
      ? buildDirectSlackAuthority(input).requestAuthority
      : buildSharedSlackAuthority(input).requestAuthority;
  if (
    authority.kind !== "direct_conversation" &&
    authority.kind !== "shared_conversation"
  ) {
    throw new Error("slack_authority_builder_returned_wrong_branch");
  }
  return authority;
}

import { textLimit } from "@purin-labs/contract-schema";
import {
  parseIntegrationAccountReference,
} from "@purin-labs/authority/access-control/integration-discovery";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import type { IntegrationAccountReference } from "@purin-labs/authority/access-control/integration-discovery";
import { defineToolFamily, jsonSchema } from "@purin-labs/agent-tools/define-tool";
import { ToolRequestError } from "@purin-labs/agent-tools/errors";
import type { PreparedEffect } from "@purin-labs/agent-tools/tool-effect";

/**
 * A Slack draft the model can correct, such as one for a channel that is not
 * connected. Its message reaches the model, so it names no channel or account.
 */
export class SlackDraftRequestError extends ToolRequestError {}

export type HarnessSlackMessagePropose = Readonly<{
  readonly accountRef: IntegrationAccountReference;
  /** A connected channel's name or ID; null lets the person choose. */
  readonly channel: string | null;
  readonly text: string;
}>;

export type HarnessSlackMessageProposalReceipt = Readonly<{
  readonly kind: "proposed";
  readonly proposalId: string;
  readonly version: number;
  /** The connected channel the draft points to, or null until a person picks one. */
  readonly channel: string | null;
}>;

type SlackMessagePropose = (
  request: HarnessSlackMessagePropose,
) => Promise<PreparedEffect>;

/** What a turn gives to the Slack message tool. */
export type SlackToolServices = {
  readonly proposeSlackMessage: SlackMessagePropose;
};

const defineSlackTool = defineToolFamily<SlackToolServices>()("slack");

export const slackMessageProposal = defineSlackTool({
  name: "slack_message_propose",
  description:
    "Draft one plain-text Slack message for a person to send, using the exact Slack accountRef returned by integration_list. " +
    "Set channel to a connected channel's name (such as 'general') or ID when the user named one; otherwise set null and the person chooses on the card. " +
    "If the user did not say where the message goes, ask them first. The platform never posts through this tool: the conversation shows the draft on a card, where a person can edit it, send it or discard it. " +
    "After you call it, tell the user that the draft is ready on the card and do not repeat the whole text.",
  input: jsonSchema({
    type: "object",
    properties: {
      accountRef: {
        type: "string",
        pattern: "^integration_ref_[0-9a-f]{64}$",
      },
      channel: textLimit({ type: ["string", "null"], maxLength: 200 }),
      text: textLimit({ type: "string", minLength: 1, maxLength: 8000 }),
    },
    required: ["accountRef", "channel", "text"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseSlackMessageProposeArgs([input]),
  effect: "receipt",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.slackMessagePropose,
  },
  unavailable: "slack message propose is unavailable",
  prepare: ({ proposeSlackMessage }) =>
    proposeSlackMessage === undefined ? undefined : (request) => proposeSlackMessage(request),
  readReceipt: readSlackMessageProposalReceiptId,
});

function parseSlackMessageProposeArgs(
  args: readonly unknown[],
): HarnessSlackMessagePropose {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["accountRef", "channel", "text"]) ||
    typeof args[0].text !== "string" ||
    args[0].text.trim().length === 0 ||
    args[0].text.length > 8000 ||
    (args[0].channel !== null &&
      (typeof args[0].channel !== "string" || args[0].channel.length > 200))
  ) {
    throw new TypeError("slack_message_propose arguments are invalid");
  }
  const accountRef = parseIntegrationAccountReference(args[0].accountRef);
  if (accountRef === null) {
    throw new TypeError("slack_message_propose account is invalid");
  }
  const channel =
    args[0].channel === null ? "" : args[0].channel.trim().replace(/^#/u, "");
  return {
    accountRef,
    channel: channel.length === 0 ? null : channel,
    text: args[0].text.trim(),
  };
}

function readSlackMessageProposalReceiptId(value: unknown): string {
  if (
    !isRecord(value) ||
    value.kind !== "proposed" ||
    typeof value.proposalId !== "string" ||
    value.proposalId.length === 0
  ) {
    throw new TypeError("Slack message proposal receipt is invalid");
  }
  return value.proposalId;
}

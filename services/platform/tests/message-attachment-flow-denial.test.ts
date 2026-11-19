import { defaultDenyPolicy } from "../src/policy-snapshot";
import { describe, expect, it } from "vitest";

import {
  FlowLabel,
  evaluateFlowLabelSink,
  organisationAuthzFromPolicy,
} from "../src/policy/information-flow";
import type { ContextVisibility } from "../src/authorization/access-grants/types";
import type { RequestAuthority } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";

/**
 * A file read through `inspect_message_attachment` becomes part of the
 * session's cumulative flow label. These pin the consequence: the label the
 * read produced is what the final Slack delivery is evaluated against, so an
 * attachment admitted in a private conversation cannot be echoed into a
 * channel its label does not admit.
 *
 * The tool test proves the observation is recorded; this proves the recorded
 * label actually denies. Neither is sufficient alone.
 */

const DM_OWNER: ContextVisibility = {
  kind: "person",
  personId: "person_1",
};

/** The organisation's current policy, with no capability rules. */
const NO_ORGANISATION_RULES = organisationAuthzFromPolicy(
  defaultDenyPolicy({ now: 0 }),
);

describe("message attachment information-flow denial", function attachmentFlowSuite() {
  it("denies delivery to a destination the attachment's label does not admit", async function deniesForeignDestination() {
    const label = await attachmentLabel([DM_OWNER]);

    const decision = evaluateFlowLabelSink({
      organisationAuthz: NO_ORGANISATION_RULES,
      flowLabel: label,
      sink: {
        kind: "conversation_delivery",
        destinationAuthority: sharedConversation("channel_public"),
      },
    });

    // A file from a direct message is private to its owner, so a channel
    // does not receive it.
    expect(decision.kind).toBe("deny");
  });

  it("allows delivery back to the conversation that carried the file", async function allowsOriginatingConversation() {
    const label = await attachmentLabel([
      DM_OWNER,
      {
        kind: "conversation",
        integrationAccountId: "account_1",
        conversationId: "dm_1",
      },
    ]);

    const decision = evaluateFlowLabelSink({
      organisationAuthz: NO_ORGANISATION_RULES,
      flowLabel: label,
      sink: {
        kind: "conversation_delivery",
        destinationAuthority: directConversation("dm_1"),
      },
    });

    // The reply goes where the file came from, which is the whole point of
    // admitting it under the conversation's own authority.
    expect(decision.kind).toBe("allow");
  });

  it("denies a tool effect that would carry the file out of its audience", async function deniesToolEffect() {
    const label = await attachmentLabel([DM_OWNER]);

    // Delivery is not the only way content escapes: a governed provider action
    // is a sink too, and the same label decides it.
    const decision = evaluateFlowLabelSink({
      organisationAuthz: NO_ORGANISATION_RULES,
      flowLabel: label,
      sink: {
        kind: "tool_effect",
        destinationAuthority: sharedConversation("channel_other"),
        capabilityId: "commerce.action.propose",
        integrationAccountId: "account_other",
        resourceScope: "shopify_store:store_1",
        approvalSatisfied: false,
      },
    });

    expect(decision.kind).toBe("deny");
  });
});

/** The label an admitted attachment carries: owned by the organisation, read by an exact audience. */
async function attachmentLabel(
  readers: readonly ContextVisibility[],
): Promise<FlowLabel> {
  const created = await FlowLabel.create([
    {
      owner: { kind: "organisation", organisationId: "organisation_flow" },
      readers,
    },
  ]);

  if (!created.ok) {
    throw new Error(`attachment label fixture invalid: ${created.error.code}`);
  }

  return created.value;
}

function sharedConversation(
  conversationId: string,
): Variant<RequestAuthority, "shared_conversation"> {
  return {
    kind: "shared_conversation",
    organisationId: "organisation_flow",
    requesterPersonId: "person_1",
    membershipRevision: 1,
    role: "operator",
    connectorId: "connector_1",
    integrationAccountId: "account_1",
    conversationId,
  };
}

function directConversation(
  conversationId: string,
): Variant<RequestAuthority, "direct_conversation"> {
  return {
    kind: "direct_conversation",
    organisationId: "organisation_flow",
    requesterPersonId: "person_1",
    membershipRevision: 1,
    role: "operator",
    connectorId: "connector_1",
    integrationAccountId: "account_1",
    conversationId,
  };
}

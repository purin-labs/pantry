import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, HttpResponse } from "msw";
import { expect, it, type TestContext } from "vitest";
import type { RequestAuthority } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";

import { decideStoredFlowConversationSink } from "../../src/actors/case-conversation-sink";
import {
  advanceInformationFlowContext,
  FlowLabel,
  flowBindingForContext,
  InformationFlowContext,
  ObservationEvidence,
} from "@purin-labs/authority/policy/index";
import type { FlowPolicyInput } from "@purin-labs/authority/policy/information-flow/index";
import { network } from "./network";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  OTHER_CHANNEL_ID,
  installSlackActorFixture,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    slackExitLevels?: Record<string, unknown>;
  }
}

/**
 * The exit to a Slack channel follows the privacy level (Plan 27C, step 2).
 *
 * A stored flow leaves for a channel of the workspace, as when a person starts
 * a side Case. The channel's own content goes back to it, internal content
 * from elsewhere goes to it, and a person's private content does not. Then
 * Slack reports the channel as shared with another company. The channel's own
 * content still goes back, and the internal content now stops. A channel that
 * Slack gives no answer about counts as outside, so a Slack failure cannot
 * send internal content out.
 *
 * The journey calls the exit directly, so that it names each level by itself.
 */
it(
  "checks a Slack exit by level and by Slack Connect",
  slackExitLevels,
  60_000,
);

const OWNER = {
  kind: "organisation",
  organisationId: ORGANISATION_ID,
} as const;

async function slackExitLevels({ task }: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const shared = { value: false };
  network.use(
    http.get("https://slack.com/api/conversations.info", ({ request }) =>
      new URL(request.url).searchParams.get("channel") === CHANNEL_ID
        ? HttpResponse.json({
            ok: true,
            channel: { is_private: false, is_ext_shared: shared.value },
          })
        : HttpResponse.json({ ok: false, error: "channel_not_found" }),
    ),
  );
  const authority = (
    channelId: string,
  ): Variant<RequestAuthority, "shared_conversation"> => ({
    kind: "shared_conversation",
    organisationId: ORGANISATION_ID,
    requesterPersonId: "person_exit",
    membershipRevision: 1,
    role: "operator",
    connectorId: fixture.connectorId as never,
    integrationAccountId: fixture.selectedIntegrationAccountId,
    conversationId: channelId,
  });
  const own: FlowPolicyInput = {
    owner: OWNER,
    readers: [
      {
        kind: "conversation",
        integrationAccountId: fixture.selectedIntegrationAccountId,
        conversationId: CHANNEL_ID,
      },
    ],
  };
  const orders: FlowPolicyInput = {
    owner: OWNER,
    readers: [{ kind: "organisation_role", role: "operator" }],
  };
  const direct: FlowPolicyInput = {
    owner: OWNER,
    readers: [{ kind: "person", personId: "person_exit" }],
  };

  const exit = async (
    policies: readonly FlowPolicyInput[],
    channelId: string = CHANNEL_ID,
  ): Promise<string> => {
    const decision = await decideStoredFlowConversationSink(
      authority(channelId),
      await bindingOf(policies),
      channelId,
      env,
    );
    return decision.ok ? "allow" : decision.error.code;
  };

  const inside = {
    own: await exit([own]),
    internal: await exit([orders]),
    private: await exit([direct]),
  };
  expect(inside).toEqual({
    own: "allow",
    internal: "allow",
    private: "case_flow_sink_deny",
  });

  // The stored answer holds for five minutes, as a read in a turn may use it.
  shared.value = true;
  await fixtureDatabase()
    .prepare(
      "UPDATE slack_conversation_fact SET read_at = 0 WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .run();
  const connect = {
    own: await exit([own]),
    internal: await exit([orders]),
    private: await exit([direct]),
  };
  expect(connect).toEqual({
    own: "allow",
    internal: "case_flow_sink_approval_required",
    private: "case_flow_sink_deny",
  });

  const unknown = await exit([orders], OTHER_CHANNEL_ID);
  expect(unknown).toBe("case_flow_sink_approval_required");

  task.meta.slackExitLevels = { inside, connect, unknown };
}

async function bindingOf(policies: readonly FlowPolicyInput[]) {
  const label = await FlowLabel.create(policies);
  if (!label.ok) throw new Error(label.error.code);
  const context = await InformationFlowContext.create({
    organisationId: ORGANISATION_ID,
    sessionId: "session_exit",
    authorityPartitionDigest: "a".repeat(64),
  });
  if (!context.ok) throw new Error(context.error.code);
  const evidence = await ObservationEvidence.create({
    source: { kind: "case_entry", caseId: "case_exit", entryId: "entry_exit" },
    sourceRevision: 1,
    contentDigest: "b".repeat(64),
    inputLabel: label.value,
    observedAt: 1,
  });
  if (!evidence.ok) throw new Error(evidence.error.code);
  const advanced = await advanceInformationFlowContext({
    context: context.value,
    observation: evidence.value,
    inputLabel: label.value,
  });
  if (!advanced.ok) throw new Error(advanced.error.code);
  return flowBindingForContext(advanced.value.context, "turn_exit");
}

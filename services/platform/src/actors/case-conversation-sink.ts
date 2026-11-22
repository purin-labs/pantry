import type { AuthorityPartition, RequestAuthority } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";

import type { Env } from "@purin-labs/kernel/env";
import {
  decideFlowSink,
  type CaseConversationSinkRefusal,
  type FlowBinding,
} from "../policy";
import type { FlowDecision } from "../policy";
import type { Result } from "@purin-labs/kernel/result";
import { slackSurfaceParts } from "../slack/surface-parts";

export type AllowFlowDecision = Variant<FlowDecision, "allow">;

type ConversationDeliveryAuthority = Variant<
  RequestAuthority,
  "direct_conversation" | "shared_conversation" | "workflow"
>;

/** A live request authority with the partition that it has now. */
type CurrentConversationAuthority = {
  readonly requestAuthority: RequestAuthority;
  readonly authorityPartition: Pick<AuthorityPartition, "digest">;
};

/**
 * Decide whether a flow may reach the conversation of a channel.
 *
 * The caller gives an authority that it resolved live. The Connector makes
 * this decision for an output before it posts. The Session makes it for a
 * streamed turn before the turn starts, so no turn starts whose context the
 * conversation may not receive.
 */
export async function decideCaseConversationSink(
  currentAuthority: CurrentConversationAuthority,
  binding: FlowBinding,
  channelId: string,
  env: Env,
): Promise<Result<AllowFlowDecision, CaseConversationSinkRefusal>> {
  if (
    binding.authorityPartitionDigest !==
    currentAuthority.authorityPartition.digest
  )
    return refusal("case_flow_authority_partition_changed");
  return decideStoredFlowConversationSink(
    currentAuthority.requestAuthority,
    binding,
    channelId,
    env,
  );
}

/**
 * Decide whether a stored flow may reach the conversation of a channel now.
 *
 * The binding was made under an earlier authority, such as the binding of a
 * side Case proposal (Plan 74), so no partition is compared. The label must
 * allow the destination's audience, as for a live output. The caller gives
 * an authority that it resolved live.
 */
export async function decideStoredFlowConversationSink(
  requestAuthority: RequestAuthority,
  binding: FlowBinding,
  channelId: string,
  env: Env,
): Promise<Result<AllowFlowDecision, CaseConversationSinkRefusal>> {
  const destinationAuthority = conversationDestinationAuthority(
    requestAuthority,
  );
  if (destinationAuthority === null)
    return refusal("case_flow_destination_invalid");
  if (
    destinationAuthority.kind !== "workflow" &&
    destinationAuthority.conversationId !== channelId
  )
    return refusal("case_flow_destination_mismatch");
  const decision = await decideFlowSink({
    binding,
    organisationAuthz: null,
    sink: {
      kind: "conversation_delivery",
      destinationAuthority,
      ...(destinationAuthority.kind !== "direct_conversation" &&
      (await slackSurfaceParts
        .use()
        .conversationReachesOutside(
          env,
          destinationAuthority,
          binding.flowLabel,
          channelId,
        ))
        ? { reachesOutside: true as const }
        : {}),
    },
  });
  return decision.kind === "allow"
    ? { ok: true, value: decision }
    : refusal(`case_flow_sink_${decision.kind}`);
}

function refusal(
  code: CaseConversationSinkRefusal["code"],
): Result<never, CaseConversationSinkRefusal> {
  return { ok: false, error: { code } };
}

function conversationDestinationAuthority(
  authority: RequestAuthority,
): ConversationDeliveryAuthority | null {
  switch (authority.kind) {
    case "direct_conversation":
    case "shared_conversation":
    case "workflow":
      return authority;
    case "agent_mailbox":
    case "whatsapp_support":
    case "control":
      return null;
  }
}

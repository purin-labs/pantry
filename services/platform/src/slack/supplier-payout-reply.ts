import type { Env } from "@purin-labs/kernel/env";
import type { RequestAuthority } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";

import type { OrganisationUserAuthority } from "@purin-labs/tenancy/organisation-access/access";
import { decideCaseConversationSink } from "@purin-labs/conversation/actors/case-conversation-sink";
import {
  compileTurnAuthority,
  type CompiledTurnAuthority,
} from "@purin-labs/authority/authorization/access-grants/turn-authority";
import {
  listSupplierPayoutsForSupplier,
  listUnresolvedSupplierPayouts,
  type SupplierPayoutRow,
} from "@purin-labs/area-commerce/server/data/supplier-payout-store";
import type { OrganisationId, SessionId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  advanceInformationFlowContext,
  digestCanonical,
  flowBindingForContext,
  InformationFlowContext,
  ObservationEvidence,
  type FlowBinding,
  type FlowLabel,
} from "@purin-labs/authority/policy/index";
import { readCurrentOrganisationPolicySnapshot } from "@purin-labs/authority/policy-snapshot";
import { supplierPayoutLabel } from "@purin-labs/area-commerce/server/payouts/supplier-payout-access";
import {
  renderOutgoingPayouts,
  renderPayoutOutcome,
} from "./supplier-payout-cards";
import type { SupplierPayoutQuery } from "./supplier-payout-command";
import type { SlackCommandRole } from "./ingress-admission";

/**
 * Answering a supplier-payout question in Slack.
 *
 * Reads only. A Slack channel has people in it who are not necessarily the
 * people who may see what a merchant pays its suppliers, so the figures reach
 * the thread only when a payout read grant names that audience: a channel
 * needs a grant to the channel, as every other commerce read in a channel
 * does. The organisation must also have enabled payout reads.
 */
type SupplierPayoutReply =
  | Readonly<{ kind: "answer"; text: string }>
  /** No grant, policy or audience admits the figures; say so rather than answering. */
  | Readonly<{ kind: "not_permitted" }>;

/**
 * Roles that may see what a merchant pays its suppliers.
 *
 * A viewer of a Slack channel is not necessarily someone entitled to the
 * merchant's outgoing payments, so membership is required on top of the
 * grants and the organisation's capability policy. All of them, not either.
 */
const PAYOUT_READ_ROLES: readonly SlackCommandRole[] = [
  "owner",
  "admin",
  "operator",
];

const NOT_PERMITTED: SupplierPayoutReply = { kind: "not_permitted" };

export async function replyToSupplierPayoutQuery(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    /** The requester's organisation membership, from the ingress admission. */
    membershipRole: SlackCommandRole;
    /** The authority of the conversation that asked, where the reply goes. */
    requestAuthority: Variant<
      RequestAuthority,
      "direct_conversation" | "shared_conversation"
    >;
    /** The verified Slack event that asked. */
    userAuthority: OrganisationUserAuthority;
    /** The channel that the reply is posted to. */
    channelId: string;
    /** The thread's Case Session, which the reply's flow is bound to. */
    sessionId: SessionId;
    /** Names the reply's flow binding. */
    replyId: string;
    query: SupplierPayoutQuery;
    now: number;
  }>,
): Promise<SupplierPayoutReply> {
  if (!PAYOUT_READ_ROLES.includes(input.membershipRole)) return NOT_PERMITTED;
  const db = input.scope.database;
  const organisationId = input.scope.organisationId;
  const policy = await readCurrentOrganisationPolicySnapshot(
    db,
    organisationId,
  );
  if (!policy.ok) return NOT_PERMITTED;
  // The authority is checked live again, because the figures leave Pantry
  // here. It also selects the grants that apply to this conversation.
  const authority = await compileTurnAuthority({
    db,
    accountAccess: input.scope.accountAccess,
    userAuthority: input.userAuthority,
    action: "execute",
    organisationId,
    requestAuthority: input.requestAuthority,
    policy: { version: policy.value.version },
  });
  if (!authority.ok) return NOT_PERMITTED;
  const label = await supplierPayoutLabel({
    db,
    organisationId,
    grants: authority.value.effectiveGrantSet.selectedGrants,
  });
  if (label === null) return NOT_PERMITTED;

  const payouts =
    input.query.kind === "supplier"
      ? await listSupplierPayoutsForSupplier(
          db,
          organisationId,
          input.query.supplierId,
        )
      : await listUnresolvedSupplierPayouts(db, organisationId);
  const text = answerText(input.query, payouts);
  const binding = await payoutReplyBinding({
    authority: authority.value,
    organisationId,
    sessionId: input.sessionId,
    replyId: input.replyId,
    label,
    payouts,
    text,
    observedAt: input.now,
  });
  if (binding === null) return NOT_PERMITTED;
  const decision = await decideCaseConversationSink(
    authority.value,
    binding,
    input.channelId,
    input.env,
  );
  return decision.ok ? { kind: "answer", text } : NOT_PERMITTED;
}

/** The flow of one answer: the payout read that it shows, and nothing else. */
async function payoutReplyBinding(
  input: Readonly<{
    authority: CompiledTurnAuthority;
    organisationId: OrganisationId;
    sessionId: SessionId;
    replyId: string;
    label: FlowLabel;
    payouts: readonly SupplierPayoutRow[];
    text: string;
    observedAt: number;
  }>,
): Promise<FlowBinding | null> {
  const context = await InformationFlowContext.create({
    organisationId: input.organisationId,
    sessionId: input.sessionId,
    authorityPartitionDigest: input.authority.authorityPartition.digest,
  });
  if (!context.ok) return null;
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "organisation_record",
      organisationId: input.organisationId,
      recordId: "supplier-payouts",
    },
    sourceRevision: newestRevision(input.payouts),
    contentDigest: await digestCanonical(input.text),
    inputLabel: input.label,
    observedAt: input.observedAt,
  });
  if (!evidence.ok) return null;
  const advanced = await advanceInformationFlowContext({
    context: context.value,
    observation: evidence.value,
    inputLabel: input.label,
  });
  return advanced.ok
    ? flowBindingForContext(advanced.value.context, input.replyId)
    : null;
}

/** The newest revision that the answer shows; an empty answer is revision one. */
function newestRevision(payouts: readonly SupplierPayoutRow[]): number {
  let newest = 1;
  for (const payout of payouts)
    if (payout.revision > newest) newest = payout.revision;
  return newest;
}

function answerText(
  query: SupplierPayoutQuery,
  payouts: readonly SupplierPayoutRow[],
): string {
  if (query.kind !== "supplier") return renderOutgoingPayouts(payouts);
  return payouts.length === 0
    ? `Nothing has been paid to ${query.supplierId}.`
    : payouts.map(renderPayoutOutcome).join("\n");
}

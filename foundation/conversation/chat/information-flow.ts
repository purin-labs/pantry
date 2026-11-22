import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationAccess } from "@purin-labs/tenancy/organisation-access/access";
import type { DisclosureDestination } from "./disclosure-evidence";
import {
  ConversationAudienceProposal,
  ProjectAudienceProposal,
} from "./disclosure-evidence";
import { readProject } from "../projects/records";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import type { RequestAuthority } from "@purin-labs/contracts";
import { isUserId } from "@purin-labs/control-api";
import {
  listOrganisationMembers,
  readActiveOrganisationMembershipRevision,
} from "@purin-labs/tenancy/data/control-plane";
import {
  buildControlAuthority,
  validateLiveRequestAuthority,
} from "@purin-labs/authority/request-authority/index";
import {
  audiencesForDestination,
  createCurrentObservedSourceFlowLabel,
  currentFlowSinkCheck,
  evaluateFlowLabelSink,
  type FlowBinding,
  type FlowSinkCheck,
  type FlowLabel,
  type FlowAudience,
} from "@purin-labs/authority/policy/information-flow/index";
import { decideFlowSink } from "@purin-labs/authority/policy/index";
import { authorizeProject } from "../projects/access";
import { authorizeConversation } from "./conversation-access";
import type { ConversationScope } from "./store";
import type { Variant } from "@purin-labs/type-utils";
import {
  createNativeChatAudience,
  type NativeChatAudience,
} from "@purin-labs/authority/policy/information-flow/native-audience";
export type { NativeChatAudience } from "@purin-labs/authority/policy/information-flow/native-audience";
import type {
  ConversationDeliverySink,
  ToolEffectSink,
  FlowLabelDecision,
} from "@purin-labs/authority/policy/information-flow/index";

export async function readChatControlAuthority(
  db: OrganisationDatabase,
  scope: ConversationScope,
): Promise<Variant<RequestAuthority, "control"> | null> {
  const [members, revision] = await Promise.all([
    listOrganisationMembers({ db, organisationId: scope.organisationId }),
    readActiveOrganisationMembershipRevision({
      db,
      organisationId: scope.organisationId,
    }),
  ]);
  const member = members.find(memberForUser.bind(null, scope.userId));
  if (member === undefined || revision === null) return null;
  return buildControlAuthority({
    organisationId: scope.organisationId,
    userId: scope.userId,
    requesterPersonId: member.personId,
    membershipRevision: revision,
    role: member.role,
  }).requestAuthority;
}
function memberForUser(userId: string, member: { userId: string }): boolean {
  return member.userId === userId;
}

export async function resolveNativeChatAudience(
  db: OrganisationDatabase,
  accountAccess: OrganisationAccess,
  authority: Variant<RequestAuthority, "control">,
  label: FlowLabel,
  destination: DisclosureDestination,
): Promise<NativeChatAudience | null> {
  const live = await validateLiveRequestAuthority({
    db,
    authority,
    accountAccess,
    action: "disclose",
    userAuthority: {
      kind: "disclosure_recipient",
      disclosureEvidenceId: label.digest,
    },
  });
  if (!live.ok || !isUserId(authority.userId)) return null;
  const organisation = parseOrganisationId(authority.organisationId);
  if (!organisation.ok) return null;
  const scope = {
    organisationId: organisation.value,
    userId: authority.userId,
  };
  if (
    destination.kind === "project_admission" &&
    (!ProjectAudienceProposal.is(destination.proposal) ||
      destination.proposal.scope.organisationId !== scope.organisationId ||
      !destination.proposal.recipients.includes(scope.userId))
  )
    return null;
  if (
    destination.kind === "conversation_admission" &&
    (!ConversationAudienceProposal.is(destination.proposal) ||
      destination.proposal.scope.organisationId !== scope.organisationId ||
      !destination.proposal.recipients.includes(scope.userId))
  )
    return null;
  const readers: FlowAudience[] = [...audiencesForDestination(authority)];
  const revisions: { identity: string; revision: number }[] = [];
  for (const policy of label.policies) {
    for (const reader of policy.readers) {
      if (
        reader.kind === "project" &&
        reader.organisationId === scope.organisationId
      ) {
        const project = await authorizeProject(
          db,
          scope,
          reader.projectId,
          "read",
        );
        if (project === null) {
          if (
            destination.kind === "project_admission" &&
            destination.proposal.scope.organisationId ===
              scope.organisationId &&
            destination.proposal.projectId === reader.projectId &&
            destination.proposal.recipients.includes(scope.userId)
          ) {
            const managing = await authorizeProject(
              db,
              destination.proposal.scope,
              reader.projectId,
              "manage_members",
            );
            const content = await readProject(
              db,
              destination.proposal.scope,
              reader.projectId,
            );
            if (
              managing !== null &&
              managing.access.accessRevision ===
                destination.proposal.accessRevision &&
              content?.contentRevision === destination.proposal.contentRevision
            ) {
              readers.push(reader);
              revisions.push({
                identity: reader.projectId,
                revision: managing.access.accessRevision,
              });
            }
          }
          continue;
        }
        readers.push(reader);
        revisions.push({
          identity: reader.projectId,
          revision: project.access.accessRevision,
        });
      }
      if (
        reader.kind === "chat_conversation" &&
        reader.organisationId === scope.organisationId
      ) {
        const conversation = await authorizeConversation(
          db,
          scope,
          reader.conversationId,
        );
        if (conversation === null) {
          if (
            destination.kind === "conversation_admission" &&
            destination.proposal.conversationId === reader.conversationId
          ) {
            const source = await authorizeConversation(
              db,
              destination.proposal.scope,
              reader.conversationId,
            );
            const target = await authorizeProject(
              db,
              destination.proposal.scope,
              destination.proposal.projectId,
              "read",
            );
            const content = await readProject(
              db,
              destination.proposal.scope,
              destination.proposal.projectId,
            );
            const row = await db
              .prepare(
                "SELECT revision FROM portal_conversation WHERE organisation_id = ? AND conversation_id = ?",
              )
              .bind(scope.organisationId, reader.conversationId)
              .first<{ revision: unknown }>();
            if (
              source?.role === "owner" &&
              source.accessRevision ===
                destination.proposal.sourceAccessRevision &&
              row?.revision === destination.proposal.sourceRevision &&
              target?.access.accessRevision ===
                destination.proposal.destinationAccessRevision &&
              content?.contentRevision === destination.proposal.contentRevision
            ) {
              readers.push(reader);
              revisions.push({
                identity: reader.conversationId,
                revision: source.accessRevision,
              });
            }
          }
          if (
            destination.kind === "project_admission" &&
            destination.proposal.recipients.includes(scope.userId)
          ) {
            const source = await authorizeConversation(
              db,
              destination.proposal.scope,
              reader.conversationId,
            );
            if (
              source?.access.kind === "shared" &&
              source.access.sharedProjectId === destination.proposal.projectId
            ) {
              readers.push(reader);
              revisions.push({
                identity: reader.conversationId,
                revision: source.accessRevision,
              });
            }
          }
          continue;
        }
        readers.push(reader);
        revisions.push({
          identity: reader.conversationId,
          revision: conversation.accessRevision,
        });
      }
    }
  }
  return createNativeChatAudience(
    scope.organisationId,
    authority,
    readers,
    revisions,
  );
}

export async function decideChatFlowDelivery(
  db: OrganisationDatabase,
  accountAccess: OrganisationAccess,
  binding: FlowBinding,
  authority: Variant<RequestAuthority, "control">,
  destination: DisclosureDestination = { kind: "current" },
) {
  return decideChatFlowSink(
    db,
    accountAccess,
    binding,
    authority,
    { kind: "conversation_delivery", destinationAuthority: authority },
    destination,
  );
}
export async function decideCurrentAuthorityFlowSink(
  db: OrganisationDatabase,
  accountAccess: OrganisationAccess,
  input: {
    binding: FlowBinding;
    sink: ConversationDeliverySink | ToolEffectSink;
  },
) {
  const authority = input.sink.destinationAuthority;
  if (authority.kind === "control")
    return decideChatFlowSink(
      db,
      accountAccess,
      input.binding,
      authority,
      input.sink,
    );
  const current = await validateLiveRequestAuthority({
    db,
    authority,
    accountAccess,
    action: input.sink.kind === "tool_effect" ? "execute" : "disclose",
    userAuthority: {
      kind: "accepted_execution",
      acceptedExecutionId: JSON.stringify([
        input.binding.sessionId,
        input.binding.turnId,
      ]),
    },
  });
  if (!current.ok) return { kind: "unavailable" as const };
  const check = await currentFlowSinkCheck({
    db,
    flowLabel: input.binding.flowLabel,
    sink: input.sink,
  });
  if (!check.ok) return { kind: "unavailable" as const };
  return decideFlowSink({ ...check.value, binding: input.binding });
}
export async function decideChatFlowSink(
  db: OrganisationDatabase,
  accountAccess: OrganisationAccess,
  binding: FlowBinding,
  authority: Variant<RequestAuthority, "control">,
  sink:
    | import("@purin-labs/authority/policy/information-flow/index").ConversationDeliverySink
    | import("@purin-labs/authority/policy/information-flow/index").ToolEffectSink,
  destination: DisclosureDestination = { kind: "current" },
) {
  const audience = await resolveNativeChatAudience(
    db,
    accountAccess,
    authority,
    binding.flowLabel,
    destination,
  );
  if (audience === null) return { kind: "unavailable" as const };
  const check = await nativeChatSinkCheck(
    db,
    binding.flowLabel,
    audience,
    sink,
  );
  if (check === null) return { kind: "unavailable" as const };
  const decision = await decideFlowSink({ ...check, binding });
  if (decision.kind !== "allow") return decision;
  const current = await evaluateCurrentChatSourceLabels(db, check);
  if (current.kind === "unavailable") return current;
  if (current.kind !== "allow")
    return { kind: "source_policy_denied" as const };
  return decision;
}

export async function evaluateChatFlowLabelSink(
  db: OrganisationDatabase,
  accountAccess: OrganisationAccess,
  label: FlowLabel,
  authority: Variant<RequestAuthority, "control">,
  sink: ConversationDeliverySink | ToolEffectSink,
  destination: DisclosureDestination = { kind: "current" },
) {
  const audience = await resolveNativeChatAudience(
    db,
    accountAccess,
    authority,
    label,
    destination,
  );
  if (audience === null) return { kind: "unavailable" as const };
  const check = await nativeChatSinkCheck(db, label, audience, sink);
  if (check === null) return { kind: "unavailable" as const };
  const current = await evaluateCurrentChatSourceLabels(db, check);
  if (current.kind !== "allow") return current;
  return evaluateFlowLabelSink(check);
}

/**
 * The sink check of a Portal chat. A tool effect is judged by the
 * organisation's current capability rules.
 */
async function nativeChatSinkCheck(
  db: OrganisationDatabase,
  flowLabel: FlowLabel,
  audience: NativeChatAudience,
  sink: ConversationDeliverySink | ToolEffectSink,
): Promise<FlowSinkCheck | null> {
  const check = await currentFlowSinkCheck({
    db,
    flowLabel,
    sink: { kind: "native_chat", audience, sink },
  });
  return check.ok ? check.value : null;
}

async function evaluateCurrentChatSourceLabels(
  db: OrganisationDatabase,
  check: FlowSinkCheck,
): Promise<
  FlowLabelDecision | { kind: "unavailable" } | { kind: "source_policy_denied" }
> {
  const evaluated = evaluateFlowLabelSink(check);
  if (evaluated.kind !== "allow") return evaluated;
  for (const policy of check.flowLabel.policies) {
    if (policy.owner.kind !== "integration_resource") continue;
    const current = await createCurrentObservedSourceFlowLabel(
      db,
      policy.owner,
    );
    if (
      !current.ok ||
      evaluateFlowLabelSink({ ...check, flowLabel: current.value }).kind !==
        "allow"
    )
      return { kind: "source_policy_denied" as const };
  }
  return { kind: "allow" };
}

import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { assertNever, canonicalJson, sha256Hex } from "@purin-labs/std";
import {
  readDisclosureState,
  sameDisclosureState,
  createDisclosureProof,
  type DisclosureProof,
  type DisclosureDestination,
} from "./disclosure-evidence";
import type { ChatDisclosureFailure } from "@purin-labs/control-api";
import {
  decideChatFlowDelivery,
  evaluateChatFlowLabelSink,
} from "./information-flow";
import { resolveActiveSessionActor } from "@purin-labs/actor-runtime/actors/actor-router";
import {
  FlowBinding,
  labelAllowsAudiences,
  type FlowLabel,
} from "@purin-labs/authority/policy/information-flow/index";
import type { ConversationId, UserId } from "@purin-labs/control-api";
import { listProjectMembers } from "../projects/access";
import { deriveDirectCaseIdentities } from "../actors/case-direct-processing";
import {
  listOrganisationMembers,
  readActiveOrganisationMembershipRevision,
} from "@purin-labs/tenancy/data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import { buildControlAuthority } from "@purin-labs/authority/request-authority/index";
import { authorizeProjectContextDisclosure } from "../projects/context";
import { projectSnapshotFromParts } from "./project-context-binding";
import type { ChatTimelineEvent } from "./timeline";
import type { Conversation, ConversationStream } from "./conversation";
import {
  authorizeConversation,
  conversationCaseIdentity,
} from "./conversation-access";
import {
  materializeForkHistory,
  readChatForkHistoryForCase,
  authorizeForkHistoryAccess,
  verifyForkAttachments,
  ForkHistoryAccessError,
} from "./forks";
import type { ConversationScope } from "./store";
import {
  authorizeSideCaseAccess,
  readSideCaseOriginForCase,
} from "./side-cases";
import type { Variant } from "@purin-labs/type-utils";

/**
 * Whether every current reader of a conversation may be shown content under
 * `label`. A turn's reply reaches that whole audience, so optional context is
 * offered to the turn only when this allows it. `unavailable` means a lookup
 * could not decide, which is not a denial. The completed step still passes
 * `checkConversationDisclosure` with its cumulative binding.
 */
export async function conversationAudienceMayReceive(
  db: OrganisationDatabase,
  accountAccess: import("@purin-labs/tenancy/organisation-access/access").OrganisationAccess,
  scope: ConversationScope,
  conversationId: ConversationId,
  label: FlowLabel,
): Promise<"allow" | "deny" | "unavailable"> {
  const access = await authorizeConversation(db, scope, conversationId);
  if (access === null) return "deny";
  const members = await listOrganisationMembers({
    db,
    organisationId: scope.organisationId,
  });
  const revision = await readActiveOrganisationMembershipRevision({
    db,
    organisationId: scope.organisationId,
  });
  if (revision === null) return "unavailable";
  let audience: readonly UserId[];
  switch (access.access.kind) {
    case "private":
      audience = [scope.userId];
      break;
    case "workspace_canvas":
      audience = members.map(memberUserId);
      break;
    case "shared": {
      const shared = await listProjectMembers(
        db,
        scope,
        access.access.sharedProjectId,
      );
      if (shared === null) return "deny";
      audience = shared.map(memberUserId);
      break;
    }
    default:
      return assertNever(access.access);
  }
  for (const userId of audience) {
    const member = members.find(memberHasId.bind(null, userId));
    if (member === undefined) return "deny";
    const authority = buildControlAuthority({
      organisationId: scope.organisationId,
      userId,
      requesterPersonId: member.personId,
      membershipRevision: revision,
      role: member.role,
    }).requestAuthority;
    const delivery = await evaluateChatFlowLabelSink(
      db,
      accountAccess,
      label,
      authority,
      {
        kind: "conversation_delivery",
        destinationAuthority: authority,
      },
    );
    if (delivery.kind === "unavailable") return "unavailable";
    if (delivery.kind !== "allow") return "deny";
  }
  return "allow";
}

function memberUserId(member: { userId: UserId }): UserId {
  return member.userId;
}

type ConversationDisclosure =
  Readonly<{ kind: "allowed"; proof: DisclosureProof }> | ChatDisclosureFailure;

export async function checkConversationDisclosure(
  env: Env,
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  conversation: Conversation,
  audience: readonly UserId[],
  purpose: "sharing" | "viewing" | "completed_step" = "sharing",
  destination: DisclosureDestination = { kind: "current" },
): Promise<ConversationDisclosure> {
  if (
    purpose === "sharing" &&
    ((conversation.work.kind !== "ready" &&
      conversation.work.kind !== "failed") ||
      conversation.pendingInputs.length > 0)
  )
    return { kind: "rejected", code: "chat_running", reason: "execution_busy" };
  const state = await readDisclosureState(placement.database, scope);
  if (state === null)
    return {
      kind: "rejected",
      code: "chat_history_unavailable",
      reason: "evidence_unavailable",
    };
  const decisions: string[] = [];
  try {
    const stream =
      purpose === "viewing" ? disclosureStream(conversation.work) : null;
    const requests = new Set(
      conversation.historyBindings.map(historyRequestId),
    );
    const terminalInputs: Variant<ChatTimelineEvent, "user">[] = [];
    for (const event of conversation.timeline) {
      if (
        event.kind === "user" &&
        !requests.has(event.requestId) &&
        !(
          stream !== null &&
          conversation.work.kind !== "ready" &&
          event.requestId === conversation.work.requestId
        )
      ) {
        if (
          purpose === "sharing" ||
          !conversation.timeline.some(
            terminalEventForRequest.bind(null, event.requestId),
          )
        )
          return {
            kind: "rejected",
            code: "chat_history_unavailable",
            reason: "evidence_unavailable",
          };
        terminalInputs.push(event);
      }
    }
    if (
      conversation.timeline.length === 0 &&
      conversation.lineage.kind === "original"
    )
      return {
        kind: "allowed",
        proof: await createDisclosureProof(
          state,
          conversation.id,
          await sha256Hex(canonicalJson(conversation.historyBindings)),
          audience,
          decisions,
        ),
      };
    const identity = await deriveDirectCaseIdentities(
      await conversationCaseIdentity(
        placement.database,
        scope,
        conversation.id,
      ),
    );
    if (!identity.ok)
      return {
        kind: "rejected",
        code: "chat_history_unavailable",
        reason: "evidence_unavailable",
      };
    const [inherited, sideCase] = await Promise.all([
      readChatForkHistoryForCase(env, placement, identity.value.caseId),
      conversation.lineage.kind === "side_case"
        ? readSideCaseOriginForCase(placement, identity.value.caseId)
        : null,
    ]);
    // A side Case's brief carries its proposing turn's restrictions (Plan 74).
    if (
      conversation.lineage.kind === "side_case" &&
      sideCase?.proposalId !== conversation.lineage.proposalId
    )
      return {
        kind: "rejected",
        code: "chat_history_unavailable",
        reason: "evidence_unavailable",
      };
    const history =
      conversation.historyBindings.length === 0 &&
      inherited.entries.length === 0 &&
      inherited.bindings.length === 0
        ? inherited
        : await materializeForkHistory(
            env,
            scope,
            conversation.historyBindings,
            inherited,
          );
    await verifyForkAttachments(env, scope.organisationId, history);
    const [access, members, revision] = await Promise.all([
      authorizeConversation(placement.database, scope, conversation.id),
      listOrganisationMembers({
        db: placement.database,
        organisationId: scope.organisationId,
      }),
      readActiveOrganisationMembershipRevision({
        db: placement.database,
        organisationId: scope.organisationId,
      }),
    ]);
    if (access?.access.kind === "workspace_canvas") {
      for (const serialized of history.bindings) {
        const binding = await FlowBinding.restore(serialized);
        if (
          !binding.ok ||
          !workspaceCanvasLabelAllowsReaders(binding.value.flowLabel)
        )
          return {
            kind: "rejected",
            code: "chat_history_forbidden",
            reason: "source_policy_denied",
          };
      }
    }
    if (revision === null)
      return {
        kind: "rejected",
        code: "chat_history_forbidden",
        reason: "source_policy_denied",
      };
    for (const userId of audience) {
      const member = members.find(memberHasId.bind(null, userId));
      if (member === undefined)
        return {
          kind: "rejected",
          code: "chat_history_forbidden",
          reason: "source_policy_denied",
        };
      const authority = buildControlAuthority({
        organisationId: scope.organisationId,
        userId,
        requesterPersonId: member.personId,
        membershipRevision: revision,
        role: member.role,
      }).requestAuthority;
      for (const input of terminalInputs) {
        const project = await authorizeProjectContextDisclosure(
          placement.database,
          placement.accountAccess,
          authority,
          identity.value.caseId,
          projectSnapshotFromParts(input.parts),
        );
        if (!project.ok) {
          if (project.error.code === "project_evidence_unavailable")
            return {
              kind: "rejected",
              code: "chat_history_unavailable",
              reason: "evidence_unavailable",
            };
          return {
            kind: "rejected",
            code: "chat_history_forbidden",
            reason: "source_policy_denied",
          };
        }
      }
      if (access?.access.kind === "workspace_canvas") {
        for (const serialized of history.bindings) {
          const binding = await FlowBinding.restore(serialized);
          if (!binding.ok)
            return {
              kind: "rejected",
              code: "chat_history_unavailable",
              reason: "evidence_unavailable",
            };
          const decision = await decideChatFlowDelivery(
            placement.database,
            placement.accountAccess,
            binding.value,
            authority,
            destination,
          );
          if (decision.kind !== "allow")
            return {
              kind: "rejected",
              code: "chat_history_forbidden",
              reason: "source_policy_denied",
            };
          decisions.push(decision.decisionDigest);
        }
      } else if (history.entries.length > 0)
        decisions.push(
          ...(await authorizeForkHistoryAccess(
            placement,
            history,
            authority,
            destination,
            // The person's own private chat, with no inherited history.
            access?.access.kind === "private" &&
              userId === scope.userId &&
              conversation.lineage.kind === "original" &&
              inherited.entries.length === 0 &&
              inherited.bindings.length === 0
              ? "own_private_chat"
              : "grant",
          )),
        );
      if (sideCase !== null)
        decisions.push(
          ...(await authorizeSideCaseAccess(
            placement,
            sideCase,
            authority,
            destination,
          )),
        );
      if (stream !== null) {
        const actor = await resolveActiveSessionActor({
          env: env,
          namespace: env.SESSION,
          organisationId: scope.organisationId,
          sessionId: stream.sessionId,
          now: Date.now(),
        });
        if (!actor.ok)
          return {
            kind: "rejected",
            code: "chat_history_unavailable",
            reason: "evidence_unavailable",
          };
        const serialized = await actor.value.readSessionTurnFlowBinding({
          requestingOrganisationId: scope.organisationId,
          sessionId: stream.sessionId,
          turnId: stream.turnId,
        });
        // A turn that the Actor has not recorded yet has no output to disclose.
        if (
          !serialized.ok &&
          (serialized.error.code === "session_turn_not_found" ||
            serialized.error.code === "session_not_initialized")
        )
          continue;
        if (!serialized.ok)
          return {
            kind: "rejected",
            code: "chat_history_unavailable",
            reason: "evidence_unavailable",
          };
        const binding = await FlowBinding.restore(serialized.value);
        if (!binding.ok)
          return {
            kind: "rejected",
            code: "chat_history_unavailable",
            reason: "evidence_unavailable",
          };
        if (
          access?.access.kind === "workspace_canvas" &&
          !workspaceCanvasLabelAllowsReaders(binding.value.flowLabel)
        )
          return {
            kind: "rejected",
            code: "chat_history_forbidden",
            reason: "source_policy_denied",
          };
        const decision = await decideChatFlowDelivery(
          placement.database,
          placement.accountAccess,
          binding.value,
          authority,
          destination,
        );
        if (decision.kind !== "allow")
          return {
            kind: "rejected",
            code: "chat_history_forbidden",
            reason: "source_policy_denied",
          };
      }
    }
    if (
      !sameDisclosureState(
        state,
        await readDisclosureState(placement.database, scope),
      )
    )
      return {
        kind: "rejected",
        code: "chat_history_forbidden",
        reason: "access_changed",
      };
    return {
      kind: "allowed",
      proof: await createDisclosureProof(
        state,
        conversation.id,
        await sha256Hex(canonicalJson(history)),
        audience,
        decisions,
      ),
    };
  } catch (error) {
    if (
      error instanceof ForkHistoryAccessError &&
      error.reason === "source_policy_denied"
    )
      return {
        kind: "rejected",
        code: "chat_history_forbidden",
        reason: error.reason,
      };
    return {
      kind: "rejected",
      code: "chat_history_unavailable",
      reason: "evidence_unavailable",
    };
  }
}

function historyRequestId(
  binding: Conversation["historyBindings"][number],
): string {
  return binding.requestId;
}
function memberHasId(userId: UserId, member: { userId: UserId }): boolean {
  return userId === member.userId;
}

function terminalEventForRequest(
  requestId: string,
  event: ChatTimelineEvent,
): boolean {
  return (
    event.requestId === requestId &&
    (event.kind === "run_cancelled" || event.kind === "run_failed")
  );
}

function disclosureStream(
  work: Conversation["work"],
): ConversationStream | null {
  switch (work.kind) {
    case "running":
    case "cancelling":
    case "awaiting_permission":
      return work.stream;
    case "failed":
      return work.recovery?.stream ?? null;
    case "ready":
      return null;
    default:
      return assertNever(work);
  }
}

export function workspaceCanvasLabelAllowsReaders(
  label: import("@purin-labs/authority/policy/information-flow/index").FlowLabel,
): boolean {
  for (const role of ["owner", "admin", "operator", "viewer"] as const) {
    if (!labelAllowsAudiences(label, [{ kind: "organisation_role", role }]))
      return false;
  }
  return true;
}

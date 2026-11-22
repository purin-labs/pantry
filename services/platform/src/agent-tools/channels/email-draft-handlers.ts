import { resolveCollaborationAgent } from "@purin-labs/collaboration/worker/collaboration-agent";
import { sessionTurnExecution } from "@purin-labs/conversation/chat/turn-access";
import type {
  EmailDraftEditRequest,
  EmailDraftRead,
} from "../../actors/email-draft";
import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "@purin-labs/kernel/env";
import { requireActiveOrganisationActorAtPlacement } from "@purin-labs/actor-runtime/actors/actor-router";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
} from "@purin-labs/agent/actors/session-execution-admission";
import type { CatalogExecutionContext } from "@purin-labs/agent-tools/catalog/execute";
import { readSessionTurnFlowBinding as readPersistedSessionTurnFlowBinding } from "@purin-labs/agent/actors/agent-session-information-flow";
import {
  listOrganisationMembers,
  type OrganisationMember,
} from "@purin-labs/tenancy/data/control-plane";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import {
  type DraftThreadLink,
  collaborationEditDeadline,
  type ToolEffect,
} from "@purin-labs/tool-handlers/agent-tools/session-support";
import type { SessionToolContext } from "@purin-labs/agent/agent-tools/context";

export async function readEmailDraftForEmbeddedHarness(
  context: SessionToolContext,
): Promise<EmailDraftRead> {
  const { env, storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  await authorizeEmailDraftThreadAccess(
    env,
    storage,
    execution,
    lease,
    assignment,
    "read",
  );
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const result = await organisation.readEmailDraft({ organisationId });
  await requireSessionExecution(execution, lease);
  if (!result.ok) {
    throw new Error(`Email draft unavailable: ${result.error.code}`);
  }
  return result.value;
}

export async function editEmailDraftForEmbeddedHarness(
  context: SessionToolContext,
  request: EmailDraftEditRequest,
  operationId: string,
  boundary: CatalogExecutionContext,
): Promise<ToolEffect<EmailDraftRead>> {
  const { env, storage, execution, lease, assignment } = context;
  const deadlineAt = collaborationEditDeadline(
    storage,
    lease,
    boundary,
    Date.now(),
  );
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const access = await authorizeEmailDraftThreadAccess(
    env,
    storage,
    execution,
    lease,
    assignment,
    "edit",
  );
  return {
    kind: "shared_draft",
    member: access.member,
    unavailable: "Email draft information-flow authority unavailable",
    draft: {
      shared: "lookup",
      edit: {
        draft: "Email draft",
        caseId: assignment.caseId,
        capabilityId: CAPABILITY_KEYS.marketingEmailDraftEdit,
        integrationAccountId: "platform",
        resourceScope: "email-draft",
        readSharedThread: checkedDraftThread.bind(null, access.sharing),
        notConnected:
          "Connect this Slack thread from the email draft before reading or editing it",
      },
    },
    run: async () => {
      const organisation = await requireActiveOrganisationActorAtPlacement({
        env,
        organisationId,
        placement: execution.scope.placement,
        now: Date.now(),
      });
      await requireSessionExecution(execution, lease);
      const result = await organisation.editEmailDraft({
        agent: await resolveCollaborationAgent(execution.scope, assignment),
        organisationId,
        execution: sessionTurnExecution(lease),
        request,
        operationId: JSON.stringify([
          lease.session.sessionId,
          lease.turn.turnId,
          operationId,
        ]),
        userId: access.member.userId,
        deadlineAt,
      });
      await requireSessionExecution(execution, lease);
      if (!result.ok) {
        throw new Error(
          `Email draft edit failed: ${result.error.code}. Read the draft again before choosing a new edit.`,
        );
      }
      return result.value;
    },
  };
}

/** A thread link that the caller has already read and checked. */
function checkedDraftThread(link: DraftThreadLink): Promise<DraftThreadLink> {
  return Promise.resolve(link);
}

async function authorizeEmailDraftThreadAccess(
  env: Env,
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  access: "read" | "edit",
): Promise<Readonly<{ member: OrganisationMember; sharing: DraftThreadLink }>> {
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  if (assignment.sessionId !== lease.session.sessionId) {
    throw new Error(`Email draft ${access} authority unavailable`);
  }
  const authority = lease.requestAuthority;
  if (
    authority.kind !== "shared_conversation" ||
    (access === "edit" && authority.role === "viewer")
  ) {
    throw new Error(
      `Email draft ${access} requires its connected Slack thread`,
    );
  }
  const members = await listOrganisationMembers({
    db: execution.scope.database,
    organisationId,
  });
  let member: OrganisationMember | null = null;
  for (const candidate of members) {
    if (
      candidate.personId === authority.requesterPersonId &&
      candidate.role === authority.role
    ) {
      member = candidate;
    }
  }
  if (member === null) {
    throw new Error(
      `Email draft ${access} requester is no longer an organisation member`,
    );
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const sharing = await organisation.readEmailDraftThread({
    organisationId,
    caseId: assignment.caseId,
  });
  if (
    sharing === null ||
    sharing.caseId !== assignment.caseId ||
    sharing.integrationAccountId !== authority.integrationAccountId ||
    sharing.conversationId !== authority.conversationId
  ) {
    throw new Error(
      "Connect this Slack thread from the email draft before reading or editing it",
    );
  }
  const current = await readPersistedSessionTurnFlowBinding(storage.sql, {
    organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
  });
  if (
    !current.ok ||
    current.value === null ||
    current.value.authorityPartitionDigest !== lease.authorityPartitionDigest
  ) {
    throw new Error("Email draft information-flow authority unavailable");
  }
  await requireSessionExecution(execution, lease);
  return { member, sharing };
}

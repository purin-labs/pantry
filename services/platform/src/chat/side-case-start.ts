/**
 * Starting a side Case (Plan 74): a person turns an open proposal into a new
 * chat. The new chat is private to that person, starts in the source chat's
 * Project when they may work there, and runs the proposal's brief as their
 * first message. It gets no history of the source chat.
 */
import {
  parseConversationId,
  type ConversationId,
  type UserId,
} from "@purin-labs/control-api";
import type { RequestAuthority } from "@purin-labs/contracts";
import { canonicalJson, sha256Hex } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";
import { deriveDirectCaseIdentities } from "../actors/case-direct-processing";
import type { Env } from "../env";
import type { ControlSessionId } from "../ids";
import { resolveOrganisationModelRoute } from "../models/route";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { prepareProjectSnapshot } from "../projects/context";
import { admitTurn } from "./turn/admission";
import { scheduleConversationExecution } from "./application";
import { selectStoredConversationModel } from "./turn/model";
import type { ChatCommand, Conversation } from "./conversation";
import { initialConversationCaseIdentity } from "./conversation-actor-identity";
import { ForkHistoryAccessError } from "./forks";
import {
  bindAdmittedProjectContext,
  bindConversationProjectSnapshot,
  projectSnapshotFromParts,
  storedProjectPlacement,
} from "./project-context-binding";
import {
  continuesOwnClaim,
  sideCasePhase,
  writeSideCaseTransition,
} from "./side-case-transition";
import {
  authorizeSideCaseAccess,
  readSideCaseProposal,
  type SideCaseProposal,
} from "./side-cases";
import { signalChat } from "./signals";
import {
  readConversation,
  saveConversation,
  type ConversationScope,
  type StoredConversation,
} from "./store";

type SideCaseStartResult =
  | Readonly<{
      kind: "started";
      proposal: SideCaseProposal;
      conversationId: ConversationId;
    }>
  | Readonly<{ kind: "rejected"; code: SideCaseStartRefusal }>;

export type SideCaseStartRefusal =
  /** The person may not receive the proposal: it answers as a missing one. */
  | "side_case_not_found"
  /** Another person started it, or a person dismissed it. */
  | "side_case_closed"
  | "side_case_expired"
  | "side_case_model_unavailable"
  | "side_case_capacity"
  /** The start met a concurrent change; the same start may run again. */
  | "side_case_conflict";

/**
 * Starts the proposal as a new chat of this person. A repeated start by the
 * same person finishes or returns the first start: the new chat's identity
 * is named by the Organisation, the person and the proposal.
 */
export async function startSideCase(
  env: Env,
  input: Readonly<{
    placement: OrganisationExecutionScope;
    scope: ConversationScope;
    authority: Variant<RequestAuthority, "control">;
    controlSessionId: ControlSessionId;
    source: StoredConversation;
    proposal: SideCaseProposal;
    now: number;
  }>,
): Promise<SideCaseStartResult> {
  const { placement, scope, source, proposal } = input;
  const refusal = startRefusal(proposal, scope.userId, input.now);
  if (refusal !== null) return { kind: "rejected", code: refusal };
  try {
    await authorizeSideCaseAccess(placement, proposal, input.authority);
  } catch (error) {
    if (error instanceof ForkHistoryAccessError)
      return { kind: "rejected", code: "side_case_not_found" };
    throw error;
  }
  const destinationId = await sideCaseConversationId(
    scope,
    proposal.proposalId,
  );
  const identities = await deriveDirectCaseIdentities(
    initialConversationCaseIdentity(scope, destinationId),
  );
  if (!identities.ok) throw new Error(identities.error.code);
  if (
    sideCasePhase(proposal, input.now) === "open" &&
    !continuesOwnClaim(proposal, scope.userId)
  ) {
    const moved = await writeSideCaseTransition(
      placement,
      "portal_chat",
      proposal,
      {
        event: "claim",
        userId: scope.userId,
        slackUserId: null,
        destination: {
          conversationId: destinationId,
          caseId: identities.value.caseId,
        },
      },
      input.now,
    );
    if (!moved.ok && moved.error === "side_case_placement_conflict")
      return { kind: "rejected", code: "side_case_conflict" };
  }
  const claimed = await readSideCaseProposal(
    placement.database,
    placement.organisationId,
    proposal.proposalId,
  );
  if (
    claimed === null ||
    (claimed.status !== "starting" && claimed.status !== "started") ||
    claimed.decidedByUserId !== scope.userId
  )
    return {
      kind: "rejected",
      code:
        claimed !== null && claimed.status === "open"
          ? "side_case_conflict"
          : "side_case_closed",
    };
  if (
    claimed.destinationConversationId !== destinationId ||
    claimed.destinationCaseId !== identities.value.caseId
  )
    throw new Error("side_case_identity_conflict");
  let destination = await readConversation(
    placement.database,
    scope,
    destinationId,
  );
  if (destination === null) {
    const written = await writeSideCaseConversation(env, {
      placement,
      scope,
      source,
      proposal: claimed,
      destinationId,
      now: input.now,
    });
    if (written !== null) return { kind: "rejected", code: written };
    destination = await readConversation(
      placement.database,
      scope,
      destinationId,
    );
    if (destination === null)
      return { kind: "rejected", code: "side_case_conflict" };
  }
  if (claimed.status === "starting") {
    const moved = await writeSideCaseTransition(
      placement,
      "portal_chat",
      claimed,
      { event: "start" },
      input.now,
    );
    if (!moved.ok && moved.error === "side_case_placement_conflict")
      return { kind: "rejected", code: "side_case_conflict" };
  }
  // The brief runs as the first turn. A repeated start schedules the same
  // turn, which runs once.
  await scheduleConversationExecution(env, {
    placement,
    scope,
    controlSessionId: input.controlSessionId,
    conversation: destination.conversation,
  });
  const settled = await readSideCaseProposal(
    placement.database,
    placement.organisationId,
    claimed.proposalId,
  );
  if (settled?.status !== "started")
    return { kind: "rejected", code: "side_case_conflict" };
  // The card shows on every page that has the source chat open.
  signalChat(placement, {
    kind: "conversation",
    conversationId: source.conversation.id,
  });
  return { kind: "started", proposal: settled, conversationId: destinationId };
}

function startRefusal(
  proposal: SideCaseProposal,
  userId: UserId,
  now: number,
): SideCaseStartRefusal | null {
  switch (sideCasePhase(proposal, now)) {
    case "open":
      return null;
    case "expired":
      return "side_case_expired";
    case "starting":
    case "started":
      return proposal.decidedByUserId === userId ? null : "side_case_closed";
    case "dismissed":
      return "side_case_closed";
  }
}

/**
 * Writes the new chat with the brief as the person's first message. The chat
 * is filed in the source chat's Project when the person may read it there,
 * and in the Organisation's default Project otherwise.
 */
async function writeSideCaseConversation(
  env: Env,
  input: Readonly<{
    placement: OrganisationExecutionScope;
    scope: ConversationScope;
    source: StoredConversation;
    proposal: SideCaseProposal;
    destinationId: ConversationId;
    now: number;
  }>,
): Promise<SideCaseStartRefusal | null> {
  const { placement, scope, source, proposal } = input;
  const route = await resolveOrganisationModelRoute({
    env,
    organisationId: scope.organisationId,
    now: input.now,
  });
  if (!route.ok) return "side_case_model_unavailable";
  const selected = selectStoredConversationModel(
    route.value,
    source.conversation,
  );
  const model = selected.ok ? selected.value : route.value;
  // The source chat's effort fits only the source chat's model.
  const effort =
    model.model === source.conversation.modelRoute.model
      ? source.conversation.effort
      : null;
  const requestId = `side_case_${proposal.proposalId}`;
  const command: ChatCommand = {
    kind: "message",
    conversationId: input.destinationId,
    requestId,
    model: model.model,
    text: proposal.brief,
    ...(effort === null ? {} : { effort }),
    browserContext: { kind: "unavailable" },
    surfaceContext: null,
    attachments: [],
  };
  const admitted = await admitTurn(null, command, model, scope);
  if (!admitted.ok || admitted.kind === "queued")
    throw new Error(
      `side_case_admission_failed:${admitted.ok ? admitted.kind : admitted.code}`,
    );
  const conversation: Conversation = {
    ...admitted.conversation,
    lineage: {
      kind: "side_case",
      sourceConversationId: source.conversation.id,
      proposalId: proposal.proposalId,
    },
    title: proposal.title,
  };
  const inSource = bindConversationProjectSnapshot(
    conversation,
    requestId,
    await prepareProjectSnapshot(
      env,
      placement,
      scope,
      storedProjectPlacement(source),
    ),
  );
  // A Project that this person cannot read takes no new chat of theirs.
  const bound = inSourceProject(inSource)
    ? inSource
    : await bindAdmittedProjectContext(
        env,
        placement,
        scope,
        null,
        conversation,
        requestId,
      );
  const saved = await saveConversation(placement, scope.userId, bound, 0);
  if (saved.kind === "capacity") return "side_case_capacity";
  return null;
}

function inSourceProject(conversation: Conversation): boolean {
  for (const event of conversation.timeline)
    if (event.kind === "user")
      return projectSnapshotFromParts(event.parts)?.layer.kind === "project";
  return false;
}

/** The new chat of one person for one proposal. */
async function sideCaseConversationId(
  scope: ConversationScope,
  proposalId: string,
): Promise<ConversationId> {
  const suffix = await sha256Hex(
    canonicalJson([
      scope.organisationId,
      scope.userId,
      "side_case",
      proposalId,
    ]),
  );
  const parsed = parseConversationId(
    `conv_${suffix.slice(0, 8)}-${suffix.slice(8, 12)}-${suffix.slice(12, 16)}-${suffix.slice(16, 20)}-${suffix.slice(20, 32)}`,
  );
  if (!parsed.ok) throw new Error("side_case_id_invalid");
  return parsed.value;
}

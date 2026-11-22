import type { SessionToolContext } from "../../agent-tools/context";
import { resolveCurrentOrganisationCommerceMerchantBinding } from "@purin-labs/connections/data/commerce-merchant-binding";
import {
  listOrganisationMembers,
  parseControlRole,
} from "@purin-labs/tenancy/data/control-plane";
import { requireSessionExecution } from "../session-execution-admission";

/**
 * How long a staged change stays confirmable.
 *
 * Long enough for someone to read it and reply, short enough that a preview
 * nobody answered cannot be confirmed days later against state that moved.
 */
export const OPERATOR_DRAFT_TTL_MS = 60 * 60 * 1000;

/** The turn of a proposal: its admission, its lease and its Case assignment. */
export type ProposalTurn = Pick<
  SessionToolContext,
  "execution" | "lease" | "assignment"
>;

/** Who stages a proposal, and for which Case. */
export type ProposalStaging = Readonly<{
  caseId: string;
  merchantId: string | null;
  actorPersonId: string;
  actorUserId: string;
  now: number;
}>;

/**
 * Writes one configuration draft for a person to confirm, and returns the
 * words that the model gets. The Organisation area owns the draft. The Worker
 * gives this function to each tool family that stages one.
 */
export type StageConfigurationDraft = (
  staging: Pick<
    ProposalStaging,
    "caseId" | "actorPersonId" | "actorUserId" | "now"
  >,
  rawCommand: unknown,
  extra: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

/**
 * The identity and lease checks every proposal shares.
 *
 * Proposing is a write, so it needs a live turn lease and a requester the
 * organisation currently recognises — not the identity the Case was opened with.
 */
export async function beginProposalStaging(
  input: ProposalTurn,
  label: string,
  surfaces: Readonly<{ portalChat: boolean }> = { portalChat: false },
): Promise<ProposalStaging> {
  await requireSessionExecution(input.execution, input.lease);
  const now = Date.now();
  if (
    String(input.assignment.sessionId) !== String(input.lease.session.sessionId)
  ) {
    throw new Error(`${label} session identity is invalid`);
  }
  const authority = input.lease.requestAuthority;
  if (
    authority.kind !== "direct_conversation" &&
    authority.kind !== "shared_conversation" &&
    (authority.kind !== "control" || !surfaces.portalChat)
  ) {
    throw new Error(`${label} requester is not a person`);
  }
  // Staging a change an admin will be shown is itself an operator act; the
  // rank that may confirm it is checked again at confirmation.
  if (!parseControlRole(authority.role).ok) {
    throw new Error(`${label} requester role is unrecognised`);
  }
  const members = await listOrganisationMembers({
    db: input.execution.scope.database,
    organisationId: input.execution.scope.organisationId,
  });
  const member = members.find(
    (candidate) =>
      candidate.personId === authority.requesterPersonId &&
      candidate.role === authority.role,
  );
  if (member === undefined)
    throw new Error(`${label} requester is not a current member`);
  const binding = await resolveCurrentOrganisationCommerceMerchantBinding({
    db: input.execution.scope.database,
    organisationId: input.execution.scope.organisationId,
  });
  await requireSessionExecution(input.execution, input.lease);
  return {
    caseId: String(input.assignment.caseId),
    merchantId: binding.ok ? String(binding.value.merchantId) : null,
    actorPersonId: authority.requesterPersonId,
    actorUserId: member.userId,
    now,
  };
}

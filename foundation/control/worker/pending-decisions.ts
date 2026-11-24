import type {
  PendingDecision,
  PendingDecisionList,
  PendingEmailReview,
  PendingGovernedAction,
  PendingHeldOutput,
  PendingPermissionRequest,
} from "@purin-labs/control-api";
import type { OrganisationReader } from "./authorization";

/**
 * The stores of the decisions that wait for a person. Each store gives the
 * decisions that this reader may see today, with the checks of its own read.
 * The Worker gives the readers, so this file names no area.
 */
export type PendingDecisionSources = Readonly<{
  /** The action ledger of the Organisation actor. Null when it does not answer. */
  governedActions(
    authorized: OrganisationReader,
  ): Promise<readonly PendingGovernedAction[] | null>;
  /** The held outputs in regional D1. */
  heldOutputs(
    authorized: OrganisationReader,
  ): Promise<readonly PendingHeldOutput[]>;
  /** The permission requests in regional D1. */
  permissionRequests(
    authorized: OrganisationReader,
  ): Promise<readonly PendingPermissionRequest[]>;
  /** The email proposals that wait for an approval. */
  emailReviews(
    authorized: OrganisationReader,
  ): Promise<readonly PendingEmailReview[]>;
}>;

/**
 * The decisions that wait for one person in an Organisation: one read over
 * the stores (Refactor 17, step A2.1). It reads each store one time, copies
 * no record and writes nothing. A Case approval wait is the Case's view of a
 * ledger action, so that action is one entry and not two. Null when the
 * ledger does not answer: an empty list would say that nothing waits.
 */
export async function listPendingDecisions(
  sources: PendingDecisionSources,
  authorized: OrganisationReader,
): Promise<PendingDecisionList | null> {
  const [actions, held, permissions, emails] = await Promise.all([
    sources.governedActions(authorized),
    sources.heldOutputs(authorized),
    sources.permissionRequests(authorized),
    sources.emailReviews(authorized),
  ]);
  if (actions === null) return null;
  const decisions: PendingDecision[] = [
    ...actions,
    ...held,
    ...permissions,
    ...emails,
  ];
  decisions.sort(newestFirst);
  return { decisions };
}

function newestFirst(left: PendingDecision, right: PendingDecision): number {
  return (
    decisionCreatedAt(right) - decisionCreatedAt(left) ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
}

function decisionCreatedAt(decision: PendingDecision): number {
  switch (decision.kind) {
    case "governed_action":
    case "email_review":
      return decision.createdAt;
    case "held_output":
    case "permission_request":
      return decision.summary.createdAt;
  }
}

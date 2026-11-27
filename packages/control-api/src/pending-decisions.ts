import type {
  AgentPermissionRequestSummary,
  HeldOutputSummary,
} from "./agent-permission-requests.ts";

/**
 * One decision that waits for a person, as one union over the stores that
 * hold such decisions (Refactor 17, step A2.1). Each variant names its store
 * by its kind and carries the id that the store knows. The stores stay where
 * they are; this type copies no record.
 */
export type PendingDecision =
  | PendingGovernedAction
  | PendingHeldOutput
  | PendingPermissionRequest
  | PendingEmailReview;

/**
 * An action of the action ledger that waits for an approval: a commerce
 * action or a write of a custom connector. A Case that waits for it is the
 * same decision, so the Case approval wait gives no second entry.
 */
export type PendingGovernedAction = Readonly<{
  kind: "governed_action";
  /** The nonce of the ledger entry. */
  id: string;
  host: string;
  verb: string;
  resourceKey: string;
  /** The Case that waits for this action. */
  caseId: string;
  state: "proposed" | "approval_requested";
  createdAt: number;
}>;

/** An answer or a step that an exit check stopped. */
export type PendingHeldOutput = Readonly<{
  kind: "held_output";
  /** The request id of the held output. */
  id: string;
  summary: HeldOutputSummary;
}>;

/** A permission that an agent asked for. */
export type PendingPermissionRequest = Readonly<{
  kind: "permission_request";
  /** The request id of the permission request. */
  id: string;
  summary: AgentPermissionRequestSummary;
  /** Whether the reader may allow or deny it. Another member only reads it. */
  mayDecide: boolean;
}>;

/** An email that waits for a person before the mailbox sends it. */
export type PendingEmailReview = Readonly<{
  kind: "email_review";
  /** The proposal id. */
  id: string;
  message: "gmail_reply" | "operational_new_message";
  integrationAccountId: string;
  caseId: string;
  version: number;
  createdAt: number;
}>;

/** The decisions that wait for the reader, newest first. */
export type PendingDecisionList = Readonly<{
  decisions: readonly PendingDecision[];
}>;

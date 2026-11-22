import { assertNever } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";

/** The answer of a person to a decision that waits. */
export type PendingDecisionAnswer = "allow" | "refuse";

/** One decision that a person answers. The id is the id of the entry in the one read. */
export type PendingDecisionCall = Readonly<
  | { kind: "held_output"; id: string; answer: PendingDecisionAnswer }
  | { kind: "permission_request"; id: string; answer: PendingDecisionAnswer }
  | {
      kind: "governed_action";
      surface: "commerce";
      id: string;
      answer: PendingDecisionAnswer;
    }
  | {
      kind: "governed_action";
      surface: "custom_connector";
      connectorIdRaw: string;
      id: string;
      answer: PendingDecisionAnswer;
    }
  | {
      kind: "email_review";
      message: "gmail_reply" | "operational_new_message";
      id: string;
      answer: PendingDecisionAnswer;
    }
>;

/**
 * The proof that a person gives with an answer. The request holds it: the
 * Portal session, the step-up grant of an approval, the mutation boundary
 * and the challenge of an email proposal. The store of the decision checks
 * the parts that it needs.
 */
export type PendingDecisionProof = Readonly<{
  request: Request;
  organisationIdRaw: string;
}>;

type CallOf<Kind extends PendingDecisionCall["kind"]> = Variant<
  PendingDecisionCall,
  Kind
>;

/**
 * The stores that record an answer. Each one makes its own checks, writes
 * its own receipt and starts its own effect. The Worker gives them, so this
 * file names no area.
 */
export type PendingDecisionDeciders = Readonly<{
  heldOutput(
    proof: PendingDecisionProof,
    call: CallOf<"held_output">,
  ): Promise<Response>;
  permissionRequest(
    proof: PendingDecisionProof,
    call: CallOf<"permission_request">,
  ): Promise<Response>;
  governedAction(
    proof: PendingDecisionProof,
    call: CallOf<"governed_action">,
  ): Promise<Response>;
  emailReview(
    proof: PendingDecisionProof,
    call: CallOf<"email_review">,
  ): Promise<Response>;
}>;

/** The decide call as a route gets it from the Worker. */
export type DecidePendingDecision = (
  proof: PendingDecisionProof,
  call: PendingDecisionCall,
) => Promise<Response>;

/**
 * Records the answer of a person to one decision that waits (Refactor 17,
 * step A2.1). It is the one entry of every decide route: it gives the call
 * to the store that owns the decision.
 */
export function decidePendingDecision(
  deciders: PendingDecisionDeciders,
  proof: PendingDecisionProof,
  call: PendingDecisionCall,
): Promise<Response> {
  switch (call.kind) {
    case "held_output":
      return deciders.heldOutput(proof, call);
    case "permission_request":
      return deciders.permissionRequest(proof, call);
    case "governed_action":
      return deciders.governedAction(proof, call);
    case "email_review":
      return deciders.emailReview(proof, call);
    default:
      return assertNever(call);
  }
}

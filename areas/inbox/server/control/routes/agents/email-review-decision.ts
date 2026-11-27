import type {
  PendingDecisionCall,
  PendingDecisionProof,
} from "@purin-labs/control/worker/decide-pending-decision";
import type { Env } from "@purin-labs/kernel/env";
import type { Variant } from "@purin-labs/type-utils";
import { handleEmailOperational } from "./email-operational";
import { handleEmailReply } from "./email-reply";

/**
 * Records the answer of a person to an email proposal, for the one decide
 * call: a Gmail reply or an operational email. Each store keeps its checks,
 * its receipt and its effect.
 */
export function decideEmailReview(
  env: Env,
  { request, organisationIdRaw }: PendingDecisionProof,
  call: Variant<PendingDecisionCall, "email_review">,
): Promise<Response> {
  const action = call.answer === "allow" ? "approve" : "reject";
  return call.message === "gmail_reply"
    ? handleEmailReply(request, env, organisationIdRaw, call.id, action)
    : handleEmailOperational(request, env, organisationIdRaw, call.id, action);
}

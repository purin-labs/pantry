import type { Env } from "@purin-labs/kernel/env";
import {
  decidePendingDecision,
  type DecidePendingDecision,
  type PendingDecisionDeciders,
} from "@purin-labs/control/worker/decide-pending-decision";
import type { PendingDecisionSources } from "@purin-labs/control/worker/pending-decisions";
import { readPendingGovernedActions } from "@purin-labs/control/worker/pending-governed-actions";
import { pendingEmailReviews } from "@purin-labs/area-inbox/server/control/pending-email-reviews";
import { decideEmailReview } from "@purin-labs/area-inbox/server/control/routes/agents/email-review-decision";
import { decideCommerceAction } from "@purin-labs/area-commerce/server/control/routes/commerce/actions";
import { decideCustomConnectorWriteAction } from "@purin-labs/area-integrations/server/control/routes/custom-connectors/write-actions";
import {
  decideAgentPermission,
  pendingPermissionRequests,
} from "@purin-labs/conversation/control/routes/agent-permission-requests";
import {
  decideHeldOutput,
  pendingHeldOutputs,
} from "@purin-labs/conversation/control/routes/held-output-requests";

/**
 * The readers of the stores of the decisions that wait for a person. The
 * Worker router gives this value to the route. Each reader uses the read
 * that the page of its store uses today.
 */
export function pendingDecisionSources(env: Env): PendingDecisionSources {
  return {
    governedActions: (authorized) =>
      readPendingGovernedActions(env, authorized),
    heldOutputs: (authorized) => pendingHeldOutputs(env, authorized),
    permissionRequests: pendingPermissionRequests,
    emailReviews: pendingEmailReviews,
  };
}

/**
 * The stores that record an answer, as the routes of each store did before
 * the one decide call. Each store keeps its checks, its receipt and its
 * effect.
 */
function pendingDecisionDeciders(env: Env): PendingDecisionDeciders {
  return {
    heldOutput: (proof, call) => decideHeldOutput(env, proof, call),
    permissionRequest: (proof, call) => decideAgentPermission(env, proof, call),
    commerceAction: (proof, call) => decideCommerceAction(env, proof, call),
    customConnectorAction: (proof, call) =>
      decideCustomConnectorWriteAction(env, proof, call),
    emailReview: (proof, call) => decideEmailReview(env, proof, call),
  };
}

/** The one decide call, with the stores of this Worker. */
export function decidePendingDecisionWith(env: Env): DecidePendingDecision {
  return (proof, call) =>
    decidePendingDecision(pendingDecisionDeciders(env), proof, call);
}

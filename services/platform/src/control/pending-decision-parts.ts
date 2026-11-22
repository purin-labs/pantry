import type {
  PendingEmailReview,
  PendingGovernedAction,
} from "@purin-labs/control-api";
import { isCommerceLedgerAction } from "@purin-labs/authority/actors/action-ledger";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { listEmailReviewProjections } from "@purin-labs/area-inbox/server/data/email-review";
import type { Env } from "@purin-labs/kernel/env";
import {
  decidePendingDecision,
  type DecidePendingDecision,
  type PendingDecisionDeciders,
} from "@purin-labs/control/worker/decide-pending-decision";
import type { PendingDecisionSources } from "@purin-labs/control/worker/pending-decisions";
import { handleEmailOperational } from "@purin-labs/area-inbox/server/control/routes/agents/email-operational";
import { handleEmailReply } from "@purin-labs/area-inbox/server/control/routes/agents/email-reply";
import {
  handleCommerceActionApproval,
  handleCommerceActionRejection,
} from "./routes/commerce/actions";
import {
  approveCustomConnectorWriteAction,
  rejectCustomConnectorWriteAction,
} from "@purin-labs/area-integrations/server/control/routes/custom-connectors/write-actions";
import {
  agentPermissionRequestSummaries,
  decideAgentPermission,
  mayDecideAgentPermissionRequests,
} from "@purin-labs/conversation/control/routes/agent-permission-requests";
import {
  decideHeldOutput,
  heldOutputSummaries,
} from "@purin-labs/conversation/control/routes/held-output-requests";

/** The most ledger entries and email proposals that one read looks at. */
const ACTION_READ_LIMIT = 50;
const EMAIL_REVIEW_READ_LIMIT = 100;

/**
 * The readers of the stores of the decisions that wait for a person. The
 * Worker router gives this value to the route. Each reader uses the read
 * that the page of its store uses today.
 */
export function pendingDecisionSources(env: Env): PendingDecisionSources {
  return {
    // The Operations page reads the same 50 newest entries of the ledger.
    // Each entry follows the rule of its own read: a commerce action shows as
    // on the Operations page, and a custom connector write shows only to an
    // owner or an admin, who decide it. An entry of another kind has no read
    // here. A ledger that does not answer gives null, so the route answers
    // 503 and not an empty list.
    async governedActions(authorized) {
      let activity;
      try {
        const organisation = await requireActiveOrganisationActor({
          env,
          organisationId: authorized.organisationId,
          now: Date.now(),
        });
        activity = await organisation.readActionActivity({
          organisationId: authorized.organisationId,
          resourceKey: null,
          limit: ACTION_READ_LIMIT,
        });
      } catch {
        return null;
      }
      if (!activity.ok) return null;
      const decides =
        authorized.membership.role === "owner" ||
        authorized.membership.role === "admin";
      const waiting: PendingGovernedAction[] = [];
      for (const item of activity.value) {
        if (item.state !== "proposed" && item.state !== "approval_requested")
          continue;
        const visible =
          item.action.authority.kind === "custom_connector"
            ? decides
            : isCommerceLedgerAction(item.action);
        if (!visible) continue;
        waiting.push({
          kind: "governed_action",
          id: item.action.nonce.value,
          host: item.action.host,
          verb: item.action.verb,
          resourceKey: item.action.resourceKey,
          caseId: String(item.caseId),
          state: item.state,
          createdAt: item.createdAt,
        });
      }
      return waiting;
    },
    async heldOutputs(authorized) {
      const summaries = await heldOutputSummaries(env, authorized);
      return summaries.map((summary) => ({
        kind: "held_output",
        id: summary.requestId,
        summary,
      }));
    },
    async permissionRequests(authorized) {
      const mayDecide = mayDecideAgentPermissionRequests(authorized);
      const summaries = await agentPermissionRequestSummaries(authorized);
      return summaries.map((summary) => ({
        kind: "permission_request",
        id: summary.requestId,
        summary,
        mayDecide,
      }));
    },
    // The mailbox page reads the same projection rows.
    async emailReviews(authorized) {
      const reviews = await listEmailReviewProjections({
        db: authorized.executionScope.database,
        organisationId: authorized.organisationId,
        limit: EMAIL_REVIEW_READ_LIMIT,
      });
      const waiting: PendingEmailReview[] = [];
      for (const review of reviews) {
        if (review.lifecycleKind !== "awaiting_approval") continue;
        waiting.push({
          kind: "email_review",
          id: review.proposalId,
          message: review.kind,
          integrationAccountId: review.integrationAccountId,
          caseId: review.caseId,
          version: review.version,
          createdAt: review.createdAt,
        });
      }
      return waiting;
    },
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
    governedAction({ request, organisationIdRaw }, call) {
      if (call.surface === "custom_connector") {
        const route = {
          organisationIdRaw,
          connectorIdRaw: call.connectorIdRaw,
          actionNonceRaw: call.id,
        };
        return call.answer === "allow"
          ? approveCustomConnectorWriteAction(request, env, route)
          : rejectCustomConnectorWriteAction(request, env, route);
      }
      return call.answer === "allow"
        ? handleCommerceActionApproval(request, env, organisationIdRaw, call.id)
        : handleCommerceActionRejection(
            request,
            env,
            organisationIdRaw,
            call.id,
          );
    },
    emailReview({ request, organisationIdRaw }, call) {
      const action = call.answer === "allow" ? "approve" : "reject";
      return call.message === "gmail_reply"
        ? handleEmailReply(request, env, organisationIdRaw, call.id, action)
        : handleEmailOperational(
            request,
            env,
            organisationIdRaw,
            call.id,
            action,
          );
    },
  };
}

/** The one decide call, with the stores of this Worker. */
export function decidePendingDecisionWith(env: Env): DecidePendingDecision {
  return (proof, call) =>
    decidePendingDecision(pendingDecisionDeciders(env), proof, call);
}

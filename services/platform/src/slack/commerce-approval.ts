import { errorMessage } from "@seams/std";

import {
  requireActiveOrganisationActor,
  resolveActiveCaseActor,
} from "../actors/actor-router";
import type { ActionLedgerEntry } from "../actors/action-ledger";
import { resolveSlackApprover } from "../actors/action-mutation-execution";
import {
  digestApprovalAction,
  type ApprovalEvidence,
  type MerchantActionRejectionEvidence,
} from "../approval-authentication";
import { slackMayApproveAction } from "../commerce/action-model";
import { syncCaseApprovalWait } from "../commerce/case-approval-sync";
import { acceptAndDeliverCommerceOutcome, executeCommerceAction } from "../commerce/actions";
import { readOrganisationDefaultWorkspacePortalAddress } from "../data/organisation-workspace";
import { parsePersonId } from "../data/person-authz";
import type { Env } from "../env";
import type { OrganisationId, RequestId } from "../ids";
import { traceLog, traceWarn } from "../observability";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { RequestDeadline } from "../request-deadline";
import {
  commerceActionCardText,
  commerceActionPortalUrl,
  commerceActionSummary,
  commerceCardBlocks,
  commerceCardControlsAfterDecision,
  commerceCardSummary,
} from "./commerce-approval-card";

/** A click on Approve or Decline, with the thread's Organisation and account. */
type CommerceApprovalClick = Readonly<{
  decision: "approve" | "decline";
  organisationId: OrganisationId;
  integrationAccountId: string;
  workspaceId: string;
  channelId: string;
  approverSlackUserId: string;
  actionNonce: string;
  responseUrl: string;
  requestId: RequestId;
}>;

/** A Slack approval proves who clicked only for this long. */
const SLACK_APPROVAL_WINDOW_MS = 60_000;

/**
 * Decide a commerce change from its Slack card (Plan 56). Approve makes the
 * change, and Decline stops it.
 *
 * Only an owner or admin whose Slack user has a verified link may decide, and
 * only a change that moves no money: the ledger checks both again when it
 * signs. The commands are the Portal's own, with the Slack click as the proof
 * of who decided. The card then shows the state of the change in place of its
 * buttons; a refusal goes only to the person who clicked.
 */
export async function decideCommerceActionFromSlack(
  env: Env,
  click: CommerceApprovalClick,
): Promise<void> {
  const requestId = click.requestId;
  try {
    const scope = await OrganisationExecutionScope.resolve(
      env,
      click.organisationId,
    );
    if (!scope.ok) return await tellApprover(click, DECISION_FAILED);
    const outcome = await decide(env, click, scope.value);
    traceLog("integration_gateway.slack.commerce_approval", {
      requestId,
      organisation_id: click.organisationId,
      action_nonce: click.actionNonce,
      decision: click.decision,
      outcome: outcome.kind === "refused" ? "refused" : outcome.entry.state,
    });
    if (outcome.kind === "refused") await tellApprover(click, outcome.text);
    else await replaceCard(env, click, scope.value, outcome.entry);
  } catch (error) {
    traceWarn("integration_gateway.slack.commerce_approval_failed", {
      requestId,
      organisation_id: click.organisationId,
      action_nonce: click.actionNonce,
      detail: errorMessage(error),
    });
    await tellApprover(click, DECISION_FAILED);
  }
}

type DecisionOutcome =
  | Readonly<{ kind: "decided"; entry: ActionLedgerEntry }>
  | Readonly<{ kind: "refused"; text: string }>;

const DECISION_FAILED =
  "The server could not record your decision. Click again, or decide under Operations in the Portal.";

async function decide(
  env: Env,
  click: CommerceApprovalClick,
  scope: OrganisationExecutionScope,
): Promise<DecisionOutcome> {
  const approver = await resolveSlackApprover(scope.database, {
    organisationId: click.organisationId,
    integrationAccountId: click.integrationAccountId,
    workspaceId: click.workspaceId,
    slackUserId: click.approverSlackUserId,
  });
  const personId = parsePersonId(approver?.personId);
  if (approver === null || personId === null)
    return {
      kind: "refused",
      text: "Only an owner or admin whose Slack account is linked to Seams Pantry can decide this change.",
    };
  const now = Date.now();
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: click.organisationId,
    now,
  });
  const existing = await organisation.getAction({
    organisationId: click.organisationId,
    nonce: click.actionNonce,
    now,
  });
  if (!existing.ok) return { kind: "refused", text: DECISION_FAILED };
  if (!slackMayApproveAction(existing.value.action))
    return {
      kind: "refused",
      text: "This change moves money, so an owner or admin decides it under Operations in the Portal.",
    };
  const principal = {
    kind: "app_user" as const,
    userId: approver.userId,
    personId,
    role: approver.role,
  };
  if (click.decision === "decline")
    return declineAction(env, click, existing.value, principal, now);
  let action = existing.value;
  if (action.state === "proposed" || action.state === "approval_requested") {
    const challenge = {
      stepUpId: `slack_${crypto.randomUUID()}`,
      organisationId: click.organisationId,
      actionNonce: click.actionNonce,
      actionDigest: await digestApprovalAction(action.action),
      policy: { kind: "unversioned_default" as const },
      issuedAt: now,
      expiresAt: now + SLACK_APPROVAL_WINDOW_MS,
    };
    const approval: ApprovalEvidence = {
      kind: "app_user",
      principal,
      authentication: {
        kind: "slack_verified_link",
        integrationAccountId: click.integrationAccountId,
        workspaceId: click.workspaceId,
        slackUserId: click.approverSlackUserId,
        authenticatedAt: now,
        challenge,
      },
    };
    if (action.state === "proposed") {
      const requested = await organisation.requestActionApproval({
        execution: {
          kind: "slack_approver",
          organisationId: click.organisationId,
          placement: scope.placement,
          fenceToken: scope.fenceToken,
          deadlineAt: now + SLACK_APPROVAL_WINDOW_MS,
          userId: approver.userId,
          integrationAccountId: click.integrationAccountId,
          workspaceId: click.workspaceId,
          slackUserId: click.approverSlackUserId,
        },
        organisationId: click.organisationId,
        nonce: click.actionNonce,
        now,
      });
      if (!requested.ok) return { kind: "refused", text: DECISION_FAILED };
    }
    const signed = await organisation.signAction({
      organisationId: click.organisationId,
      nonce: click.actionNonce,
      approval,
      now,
    });
    if (!signed.ok) return { kind: "refused", text: DECISION_FAILED };
    const caseActor = await resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId: click.organisationId,
      caseId: signed.value.caseId,
      now,
    });
    if (!caseActor.ok) return { kind: "refused", text: DECISION_FAILED };
    // The Case reads the decision from the ledger (Refactor 15).
    const synced = await caseActor.value.syncCommerceApprovalWait({
      caseId: signed.value.caseId,
      actionNonce: click.actionNonce,
    });
    if (!synced.ok) return { kind: "refused", text: DECISION_FAILED };
    action = signed.value;
  } else {
    // A second click on a decided change: a Case whose earlier update was
    // lost reads the decision now, so it does not stay waiting.
    await syncCaseApprovalWait(env, {
      organisationId: click.organisationId,
      caseId: action.caseId,
      actionNonce: click.actionNonce,
      now,
    });
  }
  // A second click on a signed or unknown change finishes it, as the
  // Portal's execute does; a decided change only reports its state.
  if (action.state !== "signed" && action.state !== "indeterminate")
    return { kind: "decided", entry: action };
  await executeCommerceAction({
    env,
    executionScope: scope,
    organisation,
    action,
    actionNonce: click.actionNonce,
    now: Date.now(),
  });
  const current = await organisation.getAction({
    organisationId: click.organisationId,
    nonce: click.actionNonce,
    now: Date.now(),
  });
  return { kind: "decided", entry: current.ok ? current.value : action };
}

/** Records the decline as the Portal does, with the click as its proof. */
async function declineAction(
  env: Env,
  click: CommerceApprovalClick,
  existing: ActionLedgerEntry,
  principal: MerchantActionRejectionEvidence["principal"],
  now: number,
): Promise<DecisionOutcome> {
  // A change that someone decided first keeps that decision. A Case whose
  // earlier update was lost reads that decision now.
  if (existing.state !== "proposed" && existing.state !== "approval_requested") {
    await syncCaseApprovalWait(env, {
      organisationId: click.organisationId,
      caseId: existing.caseId,
      actionNonce: click.actionNonce,
      now,
    });
    return { kind: "decided", entry: existing };
  }
  const rejection: MerchantActionRejectionEvidence = {
    kind: "merchant_rejection",
    principal,
    authentication: {
      kind: "slack_verified_link",
      integrationAccountId: click.integrationAccountId,
      workspaceId: click.workspaceId,
      slackUserId: click.approverSlackUserId,
      authenticatedAt: now,
    },
    decision: {
      kind: "rejected",
      reason: "merchant_declined",
      action: {
        organisationId: click.organisationId,
        actionNonce: click.actionNonce,
        actionDigest: await digestApprovalAction(existing.action),
      },
    },
  };
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: click.organisationId,
    now,
  });
  const rejected = await organisation.rejectAction({
    organisationId: click.organisationId,
    nonce: click.actionNonce,
    rejection,
    now,
  });
  if (!rejected.ok || rejected.value.state !== "rejected")
    return { kind: "refused", text: DECISION_FAILED };
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: click.organisationId,
    caseId: rejected.value.caseId,
    now,
  });
  if (!caseActor.ok) return { kind: "refused", text: DECISION_FAILED };
  const synced = await caseActor.value.syncCommerceApprovalWait({
    caseId: rejected.value.caseId,
    actionNonce: click.actionNonce,
  });
  if (!synced.ok) return { kind: "refused", text: DECISION_FAILED };
  // The decision stands even if its delivery waits: the click's answer below
  // updates the card.
  await acceptAndDeliverCommerceOutcome({
    kind: "merchant_rejection",
    env,
    entry: rejected.value,
    rejection,
    now,
  });
  return { kind: "decided", entry: rejected.value };
}

/** Update the card for everyone in the thread: the state, and its controls. */
async function replaceCard(
  env: Env,
  click: CommerceApprovalClick,
  scope: OrganisationExecutionScope,
  entry: ActionLedgerEntry,
): Promise<void> {
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: click.organisationId,
    caseId: entry.caseId,
    now: Date.now(),
  });
  const notice = caseActor.ok
    ? await caseActor.value.readCommerceApprovalNotice({
        caseId: entry.caseId,
        actionNonce: click.actionNonce,
      })
    : null;
  const summary =
    notice === null
      ? commerceActionSummary(entry.action)
      : commerceCardSummary(notice);
  const address = await readOrganisationDefaultWorkspacePortalAddress({
    db: scope.database,
    organisationId: click.organisationId,
  });
  const text = commerceActionCardText(summary, entry);
  await respond(click, {
    replace_original: true,
    text,
    blocks: commerceCardBlocks(
      text,
      commerceCardControlsAfterDecision(
        entry,
        address.ok
          ? commerceActionPortalUrl(env, address.value, click.actionNonce)
          : null,
      ),
    ),
  });
}

/** A message that only the person who clicked sees. */
async function tellApprover(
  click: CommerceApprovalClick,
  text: string,
): Promise<void> {
  await respond(click, {
    response_type: "ephemeral",
    replace_original: false,
    text,
  });
}

async function respond(
  click: CommerceApprovalClick,
  body: Record<string, unknown>,
): Promise<void> {
  const deadline = new RequestDeadline(5_000);
  try {
    const response = await fetch(click.responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      signal: deadline.signal,
      body: JSON.stringify(body),
    });
    await response.body?.cancel();
  } catch (error) {
    traceWarn("integration_gateway.slack.commerce_approval_reply_failed", {
      requestId: click.requestId,
      organisation_id: click.organisationId,
      action_nonce: click.actionNonce,
      detail: errorMessage(error),
    });
  } finally {
    deadline.end();
  }
}

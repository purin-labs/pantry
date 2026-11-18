import { authenticatedAccountConversationScope } from "../../../account-platform/access";
import { OrganisationExecutionScope } from "../../../organisation-execution-scope";
import type { Env } from "../../../env";
import { mailControlAuthority } from "../mail-inbox";
import { readReplySourceViews } from "../../../mail-inbox/reply-source-views";
import { authorizeMailSource } from "../../../mail-inbox/authorization";
import {
  parseMailReplyEdit,
  parseMailReplyCorrection,
  parseMailRelationshipLookup,
} from "@seams/control-api";
import { readEmailReplyProposalProjection } from "../../../data/email-mailbox";
import { listEmailReviewProjections } from "../../../data/email-review";
import { emailReviewQueueItemWire } from "../../email-review";
import { readEmailReplyHeadlines } from "../../email-review-headlines";
import { parseIntegrationAccountId } from "../../../ids";
import { admitUserMutation } from "../../admission/control-mutation";
import { authorizeOrganisationRequest } from "../../authorization";
import {
  controlError,
  controlJson,
  noStoreJson,
  readBoundedJsonRecord,
} from "../../http";
import { recordCommerceMutationReceipt } from "../../mutation-receipt";
import { hasExactKeys, isPositiveInteger } from "@seams/std";
import { agentMailboxConnector } from "../../../mail-inbox/agent-mailbox-connector";
import {
  emailApprovalChallenge,
  emailApprovalSecret,
  relationshipChallengeDigest,
  verifyEmailApprovalChallenge,
} from "../../../mail-inbox/email-approval-challenge";
import {
  recordEmailReplyRevision,
  replyMemoryViews,
  syncEmailProposalLifecycle,
} from "../../../mail-inbox/email-reply-lifecycle";
import {
  closeMailReplyDraft,
  mailReplyDraftActor,
  saveMailReplyDraft,
} from "../../../mail-inbox/mail-reply-drafts";

const EMAIL_REVIEW_QUEUE_LIMIT = 100;

/**
 * The approval queue stores identifiers and lifecycle only. Recipients,
 * subjects, and bodies stay in Gmail, so the queue never becomes a durable
 * copy of message content. The single-proposal preview fetches the draft just
 * in time. For a reply that waits, the queue fetches the sender, subject and
 * time of the mail that it answers, as far as the person may read the mailbox.
 */
export async function handleEmailReviewQueue(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const reviews = await listEmailReviewProjections({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    limit: EMAIL_REVIEW_QUEUE_LIMIT,
  });
  const headlines = await readEmailReplyHeadlines(
    request,
    env,
    authorized,
    reviews,
  );
  return noStoreJson({
    ok: true,
    reviews: reviews.map(emailReviewQueueItemWire.bind(null, headlines)),
  });
}

export async function handleEmailReply(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  proposalIdRaw: string,
  action:
    | "approve"
    | "reject"
    | "resolve"
    | "edit"
    | "relationship"
    | "correct"
    | "draft-save"
    | "draft-reload"
    | null,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    action === null ? "viewer" : "admin",
    action !== null,
  );
  if (!authorized.ok) return authorized.response;
  const executionScope = await OrganisationExecutionScope.resolve(
    env,
    authorized.organisationId,
  );
  if (!executionScope.ok) return controlError(executionScope.error.code, 409);
  const projection = await readEmailReplyProposalProjection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    proposalId: proposalIdRaw,
  });
  if (projection === null) return controlError("email_reply_not_found", 404);
  const accountId = parseIntegrationAccountId(projection.integrationAccountId);
  if (!accountId.ok) return controlError("email_reply_not_found", 404);
  const authority = await mailControlAuthority(authorized);
  if (
    authority === null ||
    (await authorizeMailSource(env, authority, accountId.value)) === null
  )
    return controlError("email_reply_not_found", 404);
  const secret = emailApprovalSecret(env);
  if (secret === null) return controlError("email_reply_secret_missing", 500);
  const connector = await agentMailboxConnector(
    env,
    authorized.organisationId,
    accountId.value,
  );
  if (!connector.ok)
    return controlError("email_reply_connector_unavailable", 502);
  const now = Date.now();

  if (action === null) {
    if (request.method !== "GET")
      return controlError("method_not_allowed", 405);
    const preview = await connector.value.stub.previewEmailProposal({
      identity: connector.value.identity,
      proposalId: projection.proposalId,
      now,
    });
    if (!preview.ok) return controlError(preview.error.code, 502);
    switch (preview.value.kind) {
      case "current": {
        const delivery =
          await connector.value.stub.authorizeEmailProposalDelivery({
            identity: connector.value.identity,
            proposalId: projection.proposalId,
            authority,
            now: Date.now(),
          });
        if (!delivery.ok) return controlError(delivery.error.code, 403);
        const current = preview.value.preview;
        const memoryViewer = authenticatedAccountConversationScope(
          authorized.organisationId,
          authorized.authenticated.session,
        );
        return noStoreJson({
          ok: true,
          kind: "current",
          proposal: {
            proposal_id: current.proposalId,
            version: current.currentVersion,
            body_edited: current.bodyEdited,
            to: current.to,
            subject: current.subject,
            gmail_thread_id: current.threadId,
            body: current.body,
            snapshot_digest: current.snapshotDigest,
            expires_at: current.expiresAt,
          },
          memory: await replyMemoryViews(env, memoryViewer, current.memory),
          sources: await readReplySourceViews(env, {
            viewer: authority,
            memoryViewer,
            caseId: projection.caseId,
            sources: current.sources,
            memory: current.memory,
          }),
          challenge: await emailApprovalChallenge({
            secret,
            proposalId: current.proposalId,
            version: current.currentVersion,
            snapshotDigest: current.snapshotDigest,
            userId: authorized.authenticated.session.userId,
          }),
        });
      }
      case "proposal_missing":
        await syncEmailProposalLifecycle({
          scope: executionScope.value,
          env,
          organisationId: authorized.organisationId,
          projection,
          lifecycle: { kind: "proposal_missing" },
          now,
        });
        await closeMailReplyDraft(
          env,
          authorized.organisationId,
          projection.proposalId,
        );
        return noStoreJson({ ok: true, kind: "proposal_missing" });
      case "invalidated":
        await syncEmailProposalLifecycle({
          scope: executionScope.value,
          env,
          organisationId: authorized.organisationId,
          projection,
          lifecycle: {
            kind: "invalidated",
            reason: preview.value.reason,
            disposal: { kind: "cleanup_pending" },
          },
          now,
        });
        await closeMailReplyDraft(
          env,
          authorized.organisationId,
          projection.proposalId,
        );
        return noStoreJson({
          ok: true,
          kind: "invalidated",
          reason: preview.value.reason,
        });
      case "expired":
        await syncEmailProposalLifecycle({
          scope: executionScope.value,
          env,
          organisationId: authorized.organisationId,
          projection,
          lifecycle: {
            kind: "expired",
            expiredAt: now,
            disposal: { kind: "cleanup_pending" },
          },
          now,
        });
        await closeMailReplyDraft(
          env,
          authorized.organisationId,
          projection.proposalId,
        );
        return noStoreJson({ ok: true, kind: "expired" });
    }
  }
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const body = await readBoundedJsonRecord(request, 128_000);
  if (body === null) return controlError("email_reply_request_invalid", 422);
  if (action === "relationship") {
    const lookup = parseMailRelationshipLookup(body);
    if (lookup === null)
      return controlError("email_reply_request_invalid", 422);
    const preview = await connector.value.stub.previewEmailRelationship({
      identity: connector.value.identity,
      proposalId: projection.proposalId,
      authority,
      lookup,
      now,
    });
    if (!preview.ok) return controlError(preview.error.code, 409);
    if (preview.value.kind === "suppliers")
      return noStoreJson({
        ok: true,
        kind: "suppliers",
        suppliers: preview.value.suppliers,
      });
    const selected = preview.value;
    const challenge = await emailApprovalChallenge({
      secret,
      proposalId: projection.proposalId,
      version: selected.version,
      snapshotDigest: await relationshipChallengeDigest(
        selected.snapshotDigest,
        selected.relationshipDigest,
      ),
      userId: authority.userId,
    });
    return noStoreJson({
      ok: true,
      kind: "purchase_request",
      supplierEntryId: selected.supplierEntryId,
      supplierId: selected.supplierId,
      supplierName: selected.supplierName,
      purchaseRequestEntryId: selected.purchaseRequestEntryId,
      purchaseRequestId: selected.purchaseRequestId,
      merchantRevision: selected.merchantRevision,
      facts: selected.facts,
      version: selected.version,
      snapshotDigest: selected.snapshotDigest,
      relationshipDigest: selected.relationshipDigest,
      challenge,
    });
  }
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body,
    boundary: "unversioned",
    user: "after_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/email-replies/${projection.proposalId}/${action}`,
    operation: `email_reply.${action}`,
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  let responseBody: Record<string, unknown>;

  if (action === "correct") {
    const correction = parseMailReplyCorrection(body);
    if (correction === null)
      return controlError("email_reply_request_invalid", 422);
    const valid = await verifyEmailApprovalChallenge({
      secret,
      proposalId: projection.proposalId,
      version: correction.version,
      snapshotDigest: await relationshipChallengeDigest(
        correction.snapshotDigest,
        correction.relationshipDigest,
      ),
      userId: authority.userId,
      challenge: correction.challenge,
    });
    if (!valid) return controlError("email_reply_challenge_stale", 409);
    const corrected = await connector.value.stub.correctEmailRelationship({
      identity: connector.value.identity,
      proposalId: projection.proposalId,
      authority,
      correction,
      now,
    });
    if (!corrected.ok) return controlError(corrected.error.code, 409);
    await recordEmailReplyRevision({
      scope: executionScope.value,
      env,
      organisationId: authorized.organisationId,
      projection,
      revision: {
        kind: "edit",
        version: corrected.value.version,
        bodyDigest: corrected.value.bodyDigest,
        snapshotDigest: corrected.value.snapshotDigest,
        draftMessageId: corrected.value.draftMessageId,
      },
      now,
    });
    responseBody = {
      ok: true,
      kind: "corrected",
      version: corrected.value.version,
    };
  } else if (action === "edit") {
    const edit = parseMailReplyEdit(body);
    if (edit === null) return controlError("email_reply_request_invalid", 422);
    const challengeValid = await verifyEmailApprovalChallenge({
      secret,
      proposalId: projection.proposalId,
      version: edit.version,
      snapshotDigest: edit.snapshotDigest,
      userId: authorized.authenticated.session.userId,
      challenge: edit.challenge,
    });
    if (!challengeValid)
      return controlError("email_reply_challenge_stale", 409);
    const edited = await connector.value.stub.editReviewedEmailReply({
      identity: connector.value.identity,
      proposalId: projection.proposalId,
      authority,
      edit,
      now,
    });
    if (!edited.ok)
      return controlError(
        edited.error.code,
        edited.error.code === "email_reply_edit_stale" ? 409 : 502,
      );
    await recordEmailReplyRevision({
      scope: executionScope.value,
      env,
      organisationId: authorized.organisationId,
      projection,
      revision: {
        kind: "edit",
        version: edited.value.version,
        bodyDigest: edited.value.bodyDigest,
        snapshotDigest: edited.value.snapshotDigest,
        draftMessageId: edited.value.draftMessageId,
      },
      now,
    });
    responseBody = { ok: true, kind: "edited", version: edited.value.version };
  } else if (action === "approve") {
    if (
      !hasExactKeys(body, ["version", "snapshotDigest", "challenge"]) ||
      !isPositiveInteger(body.version) ||
      typeof body.snapshotDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(body.snapshotDigest) ||
      typeof body.challenge !== "string"
    ) {
      return controlError("email_reply_request_invalid", 422);
    }
    const challengeValid = await verifyEmailApprovalChallenge({
      secret,
      proposalId: projection.proposalId,
      version: body.version,
      snapshotDigest: body.snapshotDigest,
      userId: authorized.authenticated.session.userId,
      challenge: body.challenge,
    });
    if (!challengeValid)
      return controlError("email_reply_challenge_stale", 409);
    // Plan 40D: a send sends the saved Gmail version, so a shared draft with
    // unsaved text, or saved as another version, must be saved first.
    const draftActor = await mailReplyDraftActor(
      env,
      authorized.organisationId,
    );
    if (draftActor === null)
      return controlError("mail_reply_draft_unavailable", 503);
    const draftCheck = await draftActor.mailReplyDraftApproval({
      organisationId: authorized.organisationId,
      proposalId: projection.proposalId,
      version: body.version,
    });
    // An Organisation whose Actor holds no state has no shared draft.
    if (
      !draftCheck.ok &&
      draftCheck.error.code !== "organisation_not_initialized"
    )
      return controlError(draftCheck.error.code, 409);
    const delivery = await connector.value.stub.authorizeEmailProposalDelivery({
      identity: connector.value.identity,
      proposalId: projection.proposalId,
      authority,
      now: Date.now(),
    });
    if (!delivery.ok) return controlError(delivery.error.code, 403);
    const dispatched = await connector.value.stub.dispatchReviewedEmailReply({
      identity: connector.value.identity,
      proposalId: projection.proposalId,
      authority,
      approvedVersion: body.version,
      approvedSnapshotDigest: body.snapshotDigest,
      now,
    });
    if (!dispatched.ok) return controlError(dispatched.error.code, 502);
    switch (dispatched.value.kind) {
      case "sent": {
        await recordEmailReplyRevision({
          scope: executionScope.value,
          env,
          organisationId: authorized.organisationId,
          projection,
          revision: {
            kind: "dispatch",
            version: dispatched.value.version,
            bodyDigest: dispatched.value.bodyDigest,
            snapshotDigest: dispatched.value.snapshotDigest,
            lifecycle: {
              kind: "sent",
              providerMessageId: dispatched.value.providerMessageId,
              sentAt: now,
            },
          },
          now,
        });
        responseBody = {
          ok: true,
          kind: "sent",
          provider_message_id: dispatched.value.providerMessageId,
          version: dispatched.value.version,
        };
        await closeMailReplyDraft(
          env,
          authorized.organisationId,
          projection.proposalId,
        );
        break;
      }
      case "stale_approval":
        return controlError("email_reply_approval_stale", 409);
      case "invalidated":
        await syncEmailProposalLifecycle({
          scope: executionScope.value,
          env,
          organisationId: authorized.organisationId,
          projection,
          lifecycle: {
            kind: "invalidated",
            reason: dispatched.value.reason,
            disposal: { kind: "cleanup_pending" },
          },
          now,
        });
        await closeMailReplyDraft(
          env,
          authorized.organisationId,
          projection.proposalId,
        );
        return controlError("email_reply_invalidated", 409);
      case "proposal_missing":
        await syncEmailProposalLifecycle({
          scope: executionScope.value,
          env,
          organisationId: authorized.organisationId,
          projection,
          lifecycle: { kind: "proposal_missing" },
          now,
        });
        await closeMailReplyDraft(
          env,
          authorized.organisationId,
          projection.proposalId,
        );
        return controlError("email_reply_proposal_missing", 410);
      case "expired":
        await syncEmailProposalLifecycle({
          scope: executionScope.value,
          env,
          organisationId: authorized.organisationId,
          projection,
          lifecycle: {
            kind: "expired",
            expiredAt: now,
            disposal: { kind: "cleanup_pending" },
          },
          now,
        });
        await closeMailReplyDraft(
          env,
          authorized.organisationId,
          projection.proposalId,
        );
        return controlError("email_reply_expired", 410);
      case "send_indeterminate":
        await recordEmailReplyRevision({
          scope: executionScope.value,
          env,
          organisationId: authorized.organisationId,
          projection,
          revision: {
            kind: "dispatch",
            version: dispatched.value.version,
            bodyDigest: dispatched.value.bodyDigest,
            snapshotDigest: dispatched.value.snapshotDigest,
            lifecycle: {
              kind: "send_indeterminate",
              rfcMessageId: dispatched.value.rfcMessageId,
            },
          },
          now,
        });
        responseBody = { ok: true, kind: "send_indeterminate" };
        await closeMailReplyDraft(
          env,
          authorized.organisationId,
          projection.proposalId,
        );
        break;
    }
  } else if (action === "reject") {
    if (Object.keys(body).length > 0) {
      return controlError("email_reply_request_invalid", 422);
    }
    const disposed = await connector.value.stub.disposeEmailProposal({
      identity: connector.value.identity,
      proposalId: projection.proposalId,
      now,
    });
    if (!disposed.ok) return controlError(disposed.error.code, 502);
    const disposal =
      disposed.value.kind === "deleted"
        ? { kind: "cleaned" as const, deletedAt: now }
        : disposed.value.kind === "cleanup_unreachable"
          ? {
              kind: "cleanup_unreachable" as const,
              reason: "provider_rejected_cleanup",
            }
          : { kind: "cleanup_pending" as const };
    await syncEmailProposalLifecycle({
      scope: executionScope.value,
      env,
      organisationId: authorized.organisationId,
      projection,
      lifecycle: {
        kind: "rejected",
        rejectedBy: authorized.authenticated.session.userId,
        rejectedAt: now,
        disposal,
      },
      now,
    });
    responseBody = { ok: true, kind: "rejected", cleanup: disposed.value.kind };
    await closeMailReplyDraft(
      env,
      authorized.organisationId,
      projection.proposalId,
    );
  } else if (action === "draft-save") {
    if (Object.keys(body).length > 0)
      return controlError("email_reply_request_invalid", 422);
    const saved = await saveMailReplyDraft({
      env,
      scope: executionScope.value,
      organisationId: authorized.organisationId,
      userId: authorized.authenticated.session.userId,
      authority,
      projection,
      connector: connector.value,
      secret,
      now,
    });
    if (!saved.ok) return controlError(saved.error.code, saved.error.status);
    responseBody = saved.value;
  } else if (action === "draft-reload") {
    if (Object.keys(body).length > 0)
      return controlError("email_reply_request_invalid", 422);
    const draftActor = await mailReplyDraftActor(
      env,
      authorized.organisationId,
    );
    if (draftActor === null)
      return controlError("mail_reply_draft_unavailable", 503);
    const reloaded = await draftActor.reloadMailReplyDraft({
      organisationId: authorized.organisationId,
      proposalId: projection.proposalId,
      userId: authorized.authenticated.session.userId,
      controlSessionId: authorized.authenticated.session.controlSessionId,
    });
    if (!reloaded.ok) return controlError(reloaded.error.code, 409);
    responseBody = { ok: true, kind: "reloaded" };
  } else {
    if (
      !hasExactKeys(body, ["dispatchVersion"]) ||
      !isPositiveInteger(body.dispatchVersion)
    ) {
      return controlError("email_reply_request_invalid", 422);
    }
    const resolved = await connector.value.stub.resolveEmailProposal({
      identity: connector.value.identity,
      proposalId: projection.proposalId,
      dispatchVersion: body.dispatchVersion,
      now,
    });
    if (!resolved.ok) return controlError(resolved.error.code, 502);
    if (resolved.value.kind === "sent") {
      await recordEmailReplyRevision({
        scope: executionScope.value,
        env,
        organisationId: authorized.organisationId,
        projection,
        revision: {
          kind: "dispatch",
          version: resolved.value.version,
          bodyDigest: resolved.value.bodyDigest,
          snapshotDigest: resolved.value.snapshotDigest,
          lifecycle: {
            kind: "sent",
            providerMessageId: resolved.value.providerMessageId,
            sentAt: now,
          },
        },
        now,
      });
    }
    responseBody = { ok: true, kind: resolved.value.kind };
  }
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

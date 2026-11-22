import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Env } from "@purin-labs/kernel/env";
import { parseMailReplyEdit } from "@purin-labs/control-api";
import type { Result } from "@purin-labs/kernel/result";
import type { EmailReplyProposalProjection } from "../data/email-mailbox";
import { newRequestId, type OrganisationId } from "@purin-labs/kernel/ids";
import { type UserId } from "@purin-labs/control-api/ids";
import type { RequestAuthority } from "@purin-labs/contracts";
import { traceWarn } from "@purin-labs/kernel/observability";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { AgentMailboxConnectorHandle } from "./agent-mailbox-connector";
import { emailApprovalChallenge } from "./email-approval-challenge";
import { recordEmailReplyRevision } from "./email-reply-lifecycle";
import type { Variant } from "@purin-labs/type-utils";

/** Plan 40D: the Organisation Actor that holds a reply's shared draft. */
export async function mailReplyDraftActor(
  env: Env,
  organisationId: OrganisationId,
) {
  try {
    return await requireActiveOrganisationActor({
      env,
      organisationId,
      now: Date.now(),
    });
  } catch {
    return null;
  }
}

/**
 * Deletes a reply's shared draft after the reply closed. A failure leaves
 * the text until the draft's next read closes it or the reply expires.
 */
export async function closeMailReplyDraft(
  env: Env,
  organisationId: OrganisationId,
  proposalId: string,
): Promise<void> {
  const actor = await mailReplyDraftActor(env, organisationId);
  const closed = await actor?.closeMailReplyDraft({
    organisationId,
    proposalId,
  });
  if (closed === undefined || !closed.ok)
    traceWarn("email_reply.draft_close_deferred", {
      requestId: newRequestId(),
      proposalId,
    });
}

/**
 * Plan 40D: saves the shared draft as the next Gmail version through the
 * reviewed edit path. The draft must start from the current version; a newer
 * version written in Gmail makes the save stale.
 */
export async function saveMailReplyDraft(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    organisationId: OrganisationId;
    userId: UserId;
    authority: Variant<RequestAuthority, "control">;
    projection: EmailReplyProposalProjection;
    connector: AgentMailboxConnectorHandle;
    secret: string;
    now: number;
  }>,
): Promise<
  Result<Record<string, unknown>, Readonly<{ code: string; status: number }>>
> {
  const proposalId = input.projection.proposalId;
  const actor = await mailReplyDraftActor(input.env, input.organisationId);
  if (actor === null)
    return {
      ok: false,
      error: { code: "mail_reply_draft_unavailable", status: 503 },
    };
  const draft = await actor.mailReplyDraftForSave({
    organisationId: input.organisationId,
    proposalId,
    saver: input.userId,
  });
  if (!draft.ok)
    return { ok: false, error: { code: draft.error.code, status: 409 } };
  if (draft.value.kind === "none")
    return {
      ok: false,
      error: { code: "email_reply_draft_missing", status: 409 },
    };
  const preview = await input.connector.stub.previewEmailProposal({
    identity: input.connector.identity,
    proposalId,
    now: input.now,
  });
  if (!preview.ok)
    return { ok: false, error: { code: preview.error.code, status: 502 } };
  if (preview.value.kind !== "current") {
    await closeMailReplyDraft(input.env, input.organisationId, proposalId);
    return {
      ok: false,
      error: { code: "email_reply_draft_closed", status: 410 },
    };
  }
  const current = preview.value.preview;
  if (current.currentVersion !== draft.value.savedVersion)
    return {
      ok: false,
      error: { code: "email_reply_draft_stale", status: 409 },
    };
  if (!draft.value.unsaved)
    return {
      ok: true,
      value: { ok: true, kind: "unchanged", version: current.currentVersion },
    };
  const edit = parseMailReplyEdit({
    version: current.currentVersion,
    snapshotDigest: current.snapshotDigest,
    challenge: await emailApprovalChallenge({
      secret: input.secret,
      proposalId,
      version: current.currentVersion,
      snapshotDigest: current.snapshotDigest,
      userId: input.userId,
    }),
    body: draft.value.body,
  });
  if (edit === null)
    return {
      ok: false,
      error: { code: "email_reply_request_invalid", status: 422 },
    };
  const edited = await input.connector.stub.editReviewedEmailReply({
    identity: input.connector.identity,
    proposalId,
    authority: input.authority,
    edit,
    attribution: draft.value.singleAuthor ? "single_editor" : "shared",
    now: input.now,
  });
  if (!edited.ok)
    return {
      ok: false,
      error: {
        code: edited.error.code,
        status: edited.error.code === "email_reply_edit_stale" ? 409 : 502,
      },
    };
  await recordEmailReplyRevision({
    scope: input.scope,
    env: input.env,
    organisationId: input.organisationId,
    projection: input.projection,
    revision: {
      kind: "edit",
      version: edited.value.version,
      bodyDigest: edited.value.bodyDigest,
      snapshotDigest: edited.value.snapshotDigest,
      draftMessageId: edited.value.draftMessageId,
    },
    now: input.now,
  });
  const marked = await actor.markMailReplyDraftSaved({
    organisationId: input.organisationId,
    proposalId,
    version: edited.value.version,
    body: draft.value.body,
  });
  // Gmail holds the new version. A draft that missed the mark shows its text
  // as unsaved, and a reload from Gmail repairs it.
  if (!marked.ok)
    traceWarn("email_reply.draft_save_mark_failed", {
      requestId: newRequestId(),
      proposalId,
      code: marked.error.code,
    });
  return {
    ok: true,
    value: { ok: true, kind: "saved", version: edited.value.version },
  };
}

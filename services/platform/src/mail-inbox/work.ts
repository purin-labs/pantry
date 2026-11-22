import { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  mailWorkReplyCanPreview,
  type MailInboxResult,
  type MailInboxWork,
} from "@purin-labs/control-api";
import {
  resolveActiveCaseActorAtPlacement,
  resolveActiveConnectorActorAtPlacement,
} from "../actors/actor-router";
import {
  readEmailThreadCase,
  readEmailReplyProposalProjection,
} from "../data/email-mailbox";
import { gmailConnectorId } from "./contract/connector-ids";
import type { Env } from "@purin-labs/kernel/env";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { RequestAuthority } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";

type ThreadWorkInput = Readonly<{
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  threadId: string;
}>;
type WorkError = Readonly<{
  code:
    "mail_inbox_not_found" | "mail_inbox_unavailable" | "mail_reply_changed";
}>;

export async function readMailThreadWork(
  env: Env,
  input: ThreadWorkInput,
): Promise<Result<MailInboxWork, WorkError>> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    input.organisationId,
  );
  if (!execution.ok)
    return { ok: false, error: { code: "mail_inbox_unavailable" } };
  const caseId = await readEmailThreadCase({
    db: execution.value.database,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    gmailThreadId: input.threadId,
  });
  if (caseId === null) return { ok: true, value: { kind: "unlinked" } };
  const actor = await resolveActiveCaseActorAtPlacement({
    env: env,
    namespace: env.CASE,
    organisationId: input.organisationId,
    caseId,
    placement: execution.value.placement,
    now: Date.now(),
  });
  if (!actor.ok)
    return { ok: false, error: { code: "mail_inbox_unavailable" } };
  const work = await actor.value.readMailWork({
    organisationId: input.organisationId,
    caseId,
    threadId: input.threadId,
  });
  if (!work.ok) return { ok: false, error: { code: "mail_inbox_unavailable" } };
  const replies: (typeof work.value.replies)[number][] = [];
  for (const reply of work.value.replies) {
    const projection = await readEmailReplyProposalProjection({
      db: execution.value.database,
      organisationId: input.organisationId,
      proposalId: reply.proposalId,
    });
    if (
      projection !== null &&
      projection.integrationAccountId === input.integrationAccountId &&
      projection.caseId === caseId &&
      projection.gmailThreadId === input.threadId &&
      projection.currentVersion === reply.version
    )
      replies.push(reply);
  }
  const currentCase = await readEmailThreadCase({
    db: execution.value.database,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    gmailThreadId: input.threadId,
  });
  if (currentCase !== caseId)
    return { ok: false, error: { code: "mail_inbox_not_found" } };
  return {
    ok: true,
    value: {
      kind: "linked",
      caseId: work.value.caseId,
      revision: work.value.revision,
      state: work.value.state,
      assignments: work.value.assignments,
      replies,
      moreAssignments: work.value.moreAssignments,
      moreReplies: work.value.moreReplies,
    },
  };
}

export async function readMailThreadReply(
  env: Env,
  input: ThreadWorkInput &
    Readonly<{
      proposalId: string;
      authority: Variant<RequestAuthority, "control">;
    }>,
): Promise<Result<Variant<MailInboxResult, "reply">, WorkError>> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    input.organisationId,
  );
  if (!execution.ok)
    return { ok: false, error: { code: "mail_inbox_unavailable" } };
  const work = await readMailThreadWork(env, input);
  if (!work.ok) return work;
  if (work.value.kind !== "linked")
    return { ok: false, error: { code: "mail_inbox_not_found" } };
  const proposal = work.value.replies.find(
    replyWithId.bind(null, input.proposalId),
  );
  if (proposal === undefined)
    return { ok: false, error: { code: "mail_inbox_not_found" } };
  if (!mailWorkReplyCanPreview(proposal.state))
    return { ok: false, error: { code: "mail_reply_changed" } };
  const connectorId = gmailConnectorId(input.integrationAccountId);
  if (!connectorId.ok)
    return { ok: false, error: { code: "mail_inbox_not_found" } };
  const connector = await resolveActiveConnectorActorAtPlacement({
    env: env,
    namespace: env.CONNECTOR,
    organisationId: input.organisationId,
    connectorId: connectorId.value,
    placement: execution.value.placement,
    now: Date.now(),
  });
  if (!connector.ok)
    return { ok: false, error: { code: "mail_inbox_unavailable" } };
  const preview = await connector.value.previewEmailProposal({
    identity: {
      organisationId: input.organisationId,
      connectorId: connectorId.value,
    },
    proposalId: input.proposalId,
    now: Date.now(),
  });
  if (!preview.ok) return { ok: false, error: { code: "mail_reply_changed" } };
  const live = await readMailThreadWork(env, input);
  if (!live.ok) return live;
  if (live.value.kind !== "linked" || live.value.caseId !== work.value.caseId)
    return { ok: false, error: { code: "mail_inbox_not_found" } };
  const current = live.value.replies.find(
    replyWithId.bind(null, input.proposalId),
  );
  if (
    current === undefined ||
    current.version !== proposal.version ||
    !mailWorkReplyCanPreview(current.state)
  )
    return { ok: false, error: { code: "mail_reply_changed" } };
  const value = preview.value;
  if (value.kind !== "current")
    return {
      ok: true,
      value: {
        kind: "reply",
        proposalId: input.proposalId,
        threadId: input.threadId,
        preview: value,
      },
    };
  const delivery = await connector.value.authorizeEmailProposalDelivery({
    identity: {
      organisationId: input.organisationId,
      connectorId: connectorId.value,
    },
    proposalId: input.proposalId,
    authority: input.authority,
    now: Date.now(),
  });
  if (!delivery.ok)
    return {
      ok: false,
      error: {
        code:
          delivery.error.code === "email_reply_unavailable"
            ? "mail_inbox_not_found"
            : "mail_reply_changed",
      },
    };
  if (
    value.preview.threadId !== input.threadId ||
    value.preview.baseVersion !== proposal.version
  )
    return { ok: false, error: { code: "mail_reply_changed" } };
  return {
    ok: true,
    value: {
      kind: "reply",
      proposalId: input.proposalId,
      threadId: input.threadId,
      preview: {
        kind: "current",
        version: value.preview.currentVersion,
        bodyEdited: value.preview.bodyEdited,
        to: value.preview.to,
        subject: value.preview.subject,
        body: value.preview.body,
        expiresAt: value.preview.expiresAt,
      },
    },
  };
}

function replyWithId(
  proposalId: string,
  reply: Readonly<{ proposalId: string }>,
): boolean {
  return reply.proposalId === proposalId;
}

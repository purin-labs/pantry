import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";

import type { Env } from "@purin-labs/kernel/env";
import type { ControlRole } from "../data/control-plane";

import type { OrganisationId } from "@purin-labs/kernel/ids";
import {
  cancelOperatorConfigurationDraft,
  confirmOperatorConfigurationDraft,
  readLatestDecidedOperatorDraft,
  readPendingOperatorDraft,
  type OperatorConfigurationDraft,
} from "../data/operator-configuration-draft";
import {
  renderConfigurationReceipt,
  replyAcceptsDraft,
  previewCode,
  replyCancelsDraft,
  replyPreviewCode,
  type SlackConfigurationMessage,
} from "./configuration-presentation";

/**
 * Who is speaking, resolved from the verified Slack account rather than the
 * message body.
 *
 * Slack ingress already links a verified account to a control identity and a
 * current organisation membership. A confirmation uses that link and nothing the
 * message claims about itself.
 */
export type SlackOperatorIdentity = Readonly<{
  userId: string;
  personId: string;
  /** Whether this membership may change configuration at all. */
  commandPermitted: boolean;
  /** The role behind commandPermitted, for the authority a run opens under. */
  role: ControlRole;
}>;

type SlackConfigurationOutcome =
  /** Not a reply to a pending change; the ordinary agent turn should run. */
  | Readonly<{ kind: "not_a_configuration_reply" }>
  | Readonly<{ kind: "applied"; message: SlackConfigurationMessage }>
  | Readonly<{ kind: "cancelled"; message: SlackConfigurationMessage }>
  | Readonly<{ kind: "refused"; message: SlackConfigurationMessage }>;

type ResolveSlackConfigurationReplyInput = Readonly<{
  db: OrganisationDatabase;
  /** Carrying out a confirmed command may reach past D1. */
  env: Env;
  organisationId: OrganisationId;
  caseId: string;
  operator: SlackOperatorIdentity;
  /** The message text, used only to match the action words shown. */
  text: string;
  portalUrl: string;
  now: number;
}>;

/**
 * Decides whether an incoming Slack message accepts or withdraws the change
 * awaiting confirmation in this Case.
 *
 * A message only reaches the configuration path when it repeats the action
 * words the preview displayed, so ordinary conversation is never mistaken for
 * a confirmation and the agent turn runs as usual. Authority is checked here
 * again rather than trusted from when the preview was written: a membership
 * can be withdrawn between seeing a change and accepting it.
 */
export async function resolveSlackConfigurationReply(
  input: ResolveSlackConfigurationReplyInput,
): Promise<SlackConfigurationOutcome> {
  const draft = await readPendingOperatorDraft({
    db: input.db,
    organisationId: input.organisationId,
    caseId: input.caseId,
    now: input.now,
  });
  if (draft === null) return replayDecidedDraft(input);

  const cancels = replyCancelsDraft(input.text);
  const accepts = replyAcceptsDraft(input.text, draft);
  const code = replyPreviewCode(input.text);
  if (!cancels && !accepts) {
    // A reply naming this change's action but a different preview's code is a
    // confirmation of something else, not ordinary conversation. Saying so
    // beats silently handing it to the agent as a chat message.
    return code === null
      ? { kind: "not_a_configuration_reply" }
      : refusal(
          "The change moved on since that message. Ask again and I will show the current one.",
        );
  }

  if (draft.state === "expired") {
    return refusal(
      "That change timed out before it was confirmed. Ask again and I will set it up fresh.",
    );
  }
  // Only the person who asked can accept or withdraw their own request.
  if (draft.actorUserId !== input.operator.userId) {
    return refusal(
      `That change is waiting on <@${draft.actorPersonId}>, who asked for it.`,
    );
  }
  if (!input.operator.commandPermitted) {
    return refusal(
      "You can see this setup but not change it. An owner or admin can.",
    );
  }

  if (cancels) {
    const cancelled = await cancelOperatorConfigurationDraft({
      db: input.db,
      organisationId: input.organisationId,
      draftId: draft.draftId,
      actorUserId: input.operator.userId,
      now: input.now,
    });
    return cancelled.ok
      ? {
          kind: "cancelled",
          message: { kind: "receipt", text: "Dropped it. Nothing changed." },
        }
      : refusal("That change is no longer waiting for an answer.");
  }

  const confirmed = await confirmOperatorConfigurationDraft({
    db: input.db,
    env: input.env,
    organisationId: input.organisationId,
    draftId: draft.draftId,
    actorUserId: input.operator.userId,
    actorRole: input.operator.role,
    previewCode: code ?? "",
    now: input.now,
  });
  if (confirmed.ok) {
    return {
      kind: "applied",
      message: renderConfigurationReceipt({
        draft: confirmed.value.draft,
        portalUrl: input.portalUrl,
        at: input.now,
      }),
    };
  }
  return refusal(refusalText(confirmed.error, draft, input.portalUrl));
}

/**
 * Answers a reply that names a change already decided.
 *
 * Reached when a confirmation is repeated because the first reply's answer was
 * lost. Reporting what was recorded is the whole point of keeping the
 * settled row; treating the repeat as ordinary chat would leave the operator
 * unsure whether their change happened.
 */
async function replayDecidedDraft(
  input: ResolveSlackConfigurationReplyInput,
): Promise<SlackConfigurationOutcome> {
  const code = replyPreviewCode(input.text);
  if (code === null) return { kind: "not_a_configuration_reply" };
  const decided = await readLatestDecidedOperatorDraft({
    db: input.db,
    organisationId: input.organisationId,
    caseId: input.caseId,
  });
  if (decided === null || previewCode(decided.commandDigest) !== code) {
    return { kind: "not_a_configuration_reply" };
  }
  if (decided.actorUserId !== input.operator.userId) {
    return refusal(
      `That change is waiting on <@${decided.actorPersonId}>, who asked for it.`,
    );
  }
  if (decided.state === "settled" && decided.receiptCode === "accepted") {
    return {
      kind: "applied",
      message: renderConfigurationReceipt({
        draft: decided,
        portalUrl: input.portalUrl,
        at: decided.decidedAt ?? input.now,
      }),
    };
  }
  // Claimed but unsettled, or settled with a failure: re-drive it under the
  // same mutation identity rather than reporting a success nothing recorded.
  const confirmed = await confirmOperatorConfigurationDraft({
    db: input.db,
    env: input.env,
    organisationId: input.organisationId,
    draftId: decided.draftId,
    actorUserId: input.operator.userId,
    actorRole: input.operator.role,
    previewCode: code,
    now: input.now,
  });
  return confirmed.ok
    ? {
        kind: "applied",
        message: renderConfigurationReceipt({
          draft: confirmed.value.draft,
          portalUrl: input.portalUrl,
          at: input.now,
        }),
      }
    : refusal(refusalText(confirmed.error, decided, input.portalUrl));
}

function refusalText(
  error: Readonly<{ code: string; field?: string; state?: string }>,
  draft: OperatorConfigurationDraft,
  portalUrl: string,
): string {
  switch (error.code) {
    case "operator_draft_expired":
      return "That change timed out before it was confirmed. Ask again and I will set it up fresh.";
    case "operator_draft_not_pending":
      // Most often a second confirmation of something already done.
      return error.state === "settled"
        ? `That change was already made. ${portalUrl}`
        : "That change is no longer waiting for an answer.";
    case "operator_draft_actor_mismatch":
      return `That change is waiting on <@${draft.actorPersonId}>, who asked for it.`;
    case "operator_draft_digest_mismatch":
      return "The change moved on since that message. Ask again and I will show the current one.";
    case "agent_operation_conflict":
      return "Something else changed first, so I did not apply this. Ask again to see where it stands now.";
    case "agent_operation_not_found":
      return "What that change pointed at is no longer there.";
    default:
      return `I could not make that change. ${portalUrl}`;
  }
}

function refusal(text: string): SlackConfigurationOutcome {
  return { kind: "refused", message: { kind: "receipt", text } };
}

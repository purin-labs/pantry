import { VoiceApprovalLine } from "../voice/approvals";
import { Select } from "../../ui/select";
/**
 * Messages the agent drafted in this conversation for another app. Each one
 * shows as a card in the timeline at the moment it was drafted, and nothing
 * is sent until a person selects Send on it.
 */
import React from "react";
import { assertNever } from "@purin-labs/std";
import { ProviderTile } from "../../page-components";
import type { EmailOperationalPreviewResult, EmailOperationalQueueItem, EmailReplyPreviewResult, EmailReplyQueueItem } from "@purin-labs/control-api/portal/agent-mailbox";
import {
  DraftMessageCard,
  type DraftMessageField,
  type DraftMessageReview,
  type DraftMessageStatus,
} from "../../ui";
import {
  EMAIL_REPLY_DECISION,
  SELF_TEST_SEND_LABEL,
} from "../email-review/decision-labels";
import type { EmailReviewActions } from "../email-review/api";
import type { EmailReviewQueue } from "@purin-labs/control-api/portal/email-review";
import {
  ClaimSummary,
  ClaimTrace,
  draftClaims,
  focusNumber,
  relocateSources,
  type ClaimFocus,
} from "../mail-inbox/claim-trace";
import {
  DraftBodyMarks,
  type MailSourceLinks,
} from "../mail-inbox/draft-sources";
import type { ChatTimelineInsert } from "./activity";
import type { SlackChannelView, SlackDraftView } from "@purin-labs/control-api/portal/slack-drafts";
import type { SlackDraftActions } from "./slack-drafts";
import type { Variant } from "@purin-labs/type-utils";

type EmailDraft =
  | { readonly kind: "reply"; readonly item: EmailReplyQueueItem }
  | { readonly kind: "operational"; readonly item: EmailOperationalQueueItem };

type EmailDraftContext = Readonly<{
  actions: EmailReviewActions;
  canManage: boolean;
  onChanged: () => Promise<void>;
  /** The pages that a reply's sources open; null where there are none. */
  sourceLinks: MailSourceLinks | null;
}>;

/** Claim Trace on a reply draft: open or closed, and the claim in focus. */
type TraceState = Readonly<{
  id: string;
  open: boolean;
  focus: ClaimFocus | null;
  toggle: () => void;
  onFocus: (focus: ClaimFocus | null) => void;
}>;

/** A draft that a newer version replaced has no card of its own. */
export function emailDraftInserts(
  queue: EmailReviewQueue,
  context: EmailDraftContext,
): readonly ChatTimelineInsert[] {
  const drafts: EmailDraft[] = [
    ...queue.replies.map((item) => ({ kind: "reply" as const, item })),
    ...queue.operational.map((item) => ({
      kind: "operational" as const,
      item,
    })),
  ];
  return drafts
    .filter((draft) => draft.item.lifecycleKind !== "superseded")
    .map((draft) => ({
      key: `email:${draft.item.proposalId}`,
      createdAt: draft.item.createdAt,
      node: (
        <ChatEmailDraftCard
          key={`email:${draft.item.proposalId}`}
          draft={draft}
          context={context}
        />
      ),
    }));
}

type Preview =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "reply";
      readonly result: EmailReplyPreviewResult;
    }
  | {
      readonly kind: "operational";
      readonly result: EmailOperationalPreviewResult;
    }
  | { readonly kind: "failed"; readonly message: string };

function ChatEmailDraftCard(
  props: Readonly<{ draft: EmailDraft; context: EmailDraftContext }>,
): React.ReactNode {
  const { draft, context } = props;
  const [preview, setPreview] = React.useState<Preview>({ kind: "idle" });
  const [reloads, setReloads] = React.useState(0);
  const [traceOpen, setTraceOpen] = React.useState(false);
  const [claimFocus, setClaimFocus] = React.useState<ClaimFocus | null>(null);
  const trace: TraceState = {
    id: `chat-claim-trace-${React.useId()}`,
    open: traceOpen,
    focus: claimFocus,
    toggle: () => {
      setTraceOpen(!traceOpen);
      setClaimFocus(null);
    },
    onFocus: setClaimFocus,
  };
  const awaiting = draft.item.lifecycleKind === "awaiting_approval";
  const loadKey = `${draft.item.proposalId}:${draft.item.version}:${draft.item.lifecycleKind}`;
  // After a save, the draft is read again even when its version is the same.
  const cardContext: EmailDraftContext = {
    ...context,
    onChanged: async () => {
      await context.onChanged();
      setReloads((count) => count + 1);
    },
  };
  React.useEffect(() => {
    // A settled draft keeps the text that was last shown, so a sent message
    // stays readable on its card. Only an owner or admin may read a draft
    // that is waiting.
    if (!awaiting || !context.canManage) return;
    let current = true;
    setPreview({ kind: "loading" });
    const load =
      draft.kind === "reply"
        ? context.actions
            .loadEmailReply(draft.item.proposalId)
            .then((result): Preview => ({ kind: "reply", result }))
        : context.actions
            .loadEmailOperational(draft.item.proposalId)
            .then((result): Preview => ({ kind: "operational", result }));
    load
      .catch((error: unknown): Preview => ({
        kind: "failed",
        message:
          error instanceof Error
            ? error.message
            : "The draft could not be read. Refresh to try again.",
      }))
      .then((loaded) => {
        if (current) setPreview(loaded);
      });
    return () => {
      current = false;
    };
  }, [loadKey, reloads]);
  const view = emailDraftView(draft, preview, cardContext, trace);
  return (
    <DraftMessageCard
      icon={<ProviderTile provider="gmail" label="" />}
      title="Email"
      status={view.status}
      fields={view.fields}
      body={view.body}
      edit={view.edit}
      decision={view.decision}
      review={view.review}
      footer={
        preview.kind === "failed" && awaiting && context.canManage ? (
          <DraftReadRetry retry={setReloads.bind(null, incrementDraftReload)} />
        ) : view.decision === null || view.decision === undefined ? (
          view.footer
        ) : (
          <>
            {view.footer}
            <VoiceApprovalLine
              target={{ kind: "email_draft", id: draft.item.proposalId }}
              approve={view.decision.onSend}
            />
          </>
        )
      }
    />
  );
}

type DraftView = Pick<
  React.ComponentProps<typeof DraftMessageCard>,
  "status" | "fields" | "body" | "edit" | "decision" | "footer" | "review"
>;

function emailDraftView(
  draft: EmailDraft,
  preview: Preview,
  context: EmailDraftContext,
  trace: TraceState,
): DraftView {
  const settled = settledEmailStatus(draft);
  if (settled !== null) {
    const shown = currentProposal(preview);
    return {
      status: settled,
      fields: shown === null ? targetFields(draft) : shown.fields,
      body: shown?.body ?? null,
      edit: null,
      decision: null,
      footer:
        draft.kind === "operational" &&
        draft.item.lifecycleKind === "send_indeterminate" &&
        context.canManage ? (
          <AttestActions proposalId={draft.item.proposalId} context={context} />
        ) : undefined,
    };
  }
  if (!context.canManage)
    return {
      status: {
        kind: "waiting",
        message:
          "An owner or admin with edit access to this chat must review and send this draft.",
      },
      fields: targetFields(draft),
      body: null,
      edit: null,
      decision: null,
    };
  switch (preview.kind) {
    case "idle":
    case "loading":
      return {
        status: { kind: "loading" },
        fields: targetFields(draft),
        body: null,
        edit: null,
        decision: null,
      };
    case "failed":
      return {
        status: { kind: "unavailable", message: preview.message },
        fields: targetFields(draft),
        body: null,
        edit: null,
        decision: null,
      };
    case "reply":
      return replyView(draft, preview.result, context, trace);
    case "operational":
      return operationalView(draft, preview.result, context);
    default:
      return assertNever(preview, "Unknown email draft preview");
  }
}

function DraftReadRetry(
  props: Readonly<{ retry: () => void | Promise<void> }>,
): React.ReactNode {
  return (
    <div className="draft-message-actions">
      <button
        type="button"
        className="draft-message-button"
        data-tone="secondary"
        onClick={props.retry}
      >
        Try again
      </button>
    </div>
  );
}

function replyView(
  draft: EmailDraft,
  result: EmailReplyPreviewResult,
  context: EmailDraftContext,
  trace: TraceState,
): DraftView {
  if (result.kind !== "current")
    return {
      status: {
        kind: "unavailable",
        message:
          result.kind === "expired"
            ? "This draft expired before anyone sent it."
            : result.kind === "invalidated"
              ? "The draft changed in Gmail, so it can no longer be sent from here."
              : "The draft is gone from Gmail.",
      },
      fields: targetFields(draft),
      body: null,
      edit: null,
      decision: null,
    };
  const proposal = result.proposal;
  return {
    status: { kind: "ready" },
    fields: [
      { label: "To", value: proposal.to },
      { label: "Subject", value: proposal.subject },
    ],
    body: proposal.body,
    review: replyReview(result, trace, context.sourceLinks),
    edit: context.canManage
      ? {
          maxLength: 20_000,
          revision: proposal.version,
          onSave: async (body) => {
            await context.actions.editEmailReply(proposal.proposalId, {
              version: proposal.version,
              snapshotDigest: proposal.snapshotDigest,
              challenge: result.challenge,
              body,
            });
            await context.onChanged();
            return null;
          },
        }
      : null,
    decision: context.canManage
      ? {
          ...EMAIL_REPLY_DECISION,
          onSend: async () => {
            await context.actions.approveEmailReply(proposal.proposalId, {
              version: proposal.version,
              snapshotDigest: proposal.snapshotDigest,
              challenge: result.challenge,
            });
            await context.onChanged();
            return null;
          },
          onDiscard: async () => {
            await context.actions.rejectEmailReply(proposal.proposalId);
            await context.onChanged();
            return null;
          },
        }
      : null,
  };
}

/**
 * The claims of a reply draft and the records behind them. While the person
 * edits, the claims follow the text in the editor.
 */
function replyReview(
  result: Variant<EmailReplyPreviewResult, "current">,
  trace: TraceState,
  links: MailSourceLinks | null,
): DraftMessageReview {
  const claimsOf = (body: string) => {
    const sources = relocateSources(result.proposal.body, result.sources, body);
    return { sources, claims: draftClaims(body, sources) };
  };
  return {
    renderBody: (body) => {
      const { sources, claims } = claimsOf(body);
      return (
        <DraftBodyMarks
          body={body}
          sources={sources}
          active={focusNumber(trace.focus, claims)}
          showNumbers={trace.open}
          unsourced={claims.filter((claim) => claim.numbers.length === 0)}
          activeUnsourced={
            trace.focus?.kind === "claim" ? trace.focus.key : null
          }
        />
      );
    },
    renderPanel: (draft) => {
      const { sources, claims } = claimsOf(draft.body);
      const select = draft.select;
      return (
        <>
          <ClaimSummary
            claims={claims}
            open={trace.open}
            controls={trace.id}
            onToggle={trace.toggle}
          />
          {trace.open && claims.length > 0 ? (
            <ClaimTrace
              id={trace.id}
              claims={claims}
              sources={sources}
              links={links}
              focus={trace.focus}
              onFocus={trace.onFocus}
              unsourcedAction={
                select === null
                  ? null
                  : {
                      label: draft.editing ? "Select it" : "Change it",
                      run: (claim) => select(claim.text),
                    }
              }
            />
          ) : null}
        </>
      );
    },
  };
}

function operationalView(
  draft: EmailDraft,
  result: EmailOperationalPreviewResult,
  context: EmailDraftContext,
): DraftView {
  if (result.kind !== "current")
    return {
      status: {
        kind: "unavailable",
        message:
          result.kind === "expired"
            ? "This draft expired before anyone sent it."
            : result.kind === "target_changed"
              ? "The contact changed or is no longer allowed, so this draft cannot be sent."
              : "This draft is no longer available.",
      },
      fields: targetFields(draft),
      body: null,
      edit: null,
      decision: null,
    };
  const proposal = result.proposal;
  const selfTest = proposal.target.kind === "self_test";
  return {
    status: { kind: "ready" },
    fields: operationalFields(proposal),
    body: proposal.body,
    edit:
      context.canManage && !selfTest
        ? {
            maxLength: 20_000,
            revision: proposal.version,
            onSave: async (body) => {
              await context.actions.editEmailOperational(
                proposal.proposalId,
                proposal.subject,
                body,
                proposal.version,
              );
              await context.onChanged();
              return null;
            },
          }
        : null,
    decision: context.canManage
      ? {
          ...EMAIL_REPLY_DECISION,
          ...(selfTest ? { sendLabel: SELF_TEST_SEND_LABEL } : {}),
          onSend: async () => {
            await context.actions.approveEmailOperational(proposal.proposalId, {
              version: proposal.version,
              snapshotDigest: proposal.snapshotDigest,
              challenge: result.challenge,
              ...(selfTest
                ? { selfTestOwnershipConfirmed: true as const }
                : {}),
            });
            await context.onChanged();
            return null;
          },
          onDiscard: async () => {
            await context.actions.rejectEmailOperational(proposal.proposalId);
            await context.onChanged();
            return null;
          },
        }
      : null,
  };
}

function operationalFields(
  proposal: Variant<EmailOperationalPreviewResult, "current">["proposal"],
): readonly DraftMessageField[] {
  return [
    { label: "From", value: proposal.from },
    {
      label: "To",
      value:
        proposal.recipientDisplayName === null
          ? proposal.to
          : `${proposal.recipientDisplayName} <${proposal.to}>`,
    },
    { label: "Subject", value: proposal.subject },
  ];
}

/** The text that was last shown for a draft that is now settled. */
function currentProposal(preview: Preview): {
  readonly fields: readonly DraftMessageField[];
  readonly body: string;
} | null {
  if (preview.kind === "operational" && preview.result.kind === "current")
    return {
      fields: operationalFields(preview.result.proposal),
      body: preview.result.proposal.body,
    };
  if (preview.kind === "reply" && preview.result.kind === "current")
    return {
      fields: [
        { label: "To", value: preview.result.proposal.to },
        { label: "Subject", value: preview.result.proposal.subject },
      ],
      body: preview.result.proposal.body,
    };
  return null;
}

/** What the queue says about the recipient before the draft text loads. */
function targetFields(draft: EmailDraft): readonly DraftMessageField[] {
  if (draft.kind === "reply")
    return [{ label: "Thread", value: "Reply in Gmail" }];
  const target = draft.item.target;
  switch (target.kind) {
    case "self_test":
      return [{ label: "To", value: "Your own address (test)" }];
    case "customer_contact":
      return [{ label: "To", value: "A customer contact" }];
    case "supplier_contact":
      return [{ label: "To", value: "A supplier contact" }];
    default:
      return assertNever(target, "Unknown email target");
  }
}

function settledEmailStatus(draft: EmailDraft): DraftMessageStatus | null {
  switch (draft.item.lifecycleKind) {
    case "awaiting_approval":
      return null;
    case "sent":
    case "operator_attested_present":
      return { kind: "sent" };
    case "rejected":
      return { kind: "discarded" };
    case "expired":
      return { kind: "expired" };
    case "send_indeterminate":
      return {
        kind: "unconfirmed",
        message:
          draft.kind === "operational" &&
          draft.item.indeterminateRfcMessageId !== null
            ? `Gmail did not confirm this send, and Purin Pantry will not try again. Look in Sent Mail for Message-ID ${draft.item.indeterminateRfcMessageId}.`
            : "Gmail did not confirm this send, and Purin Pantry will not try again. Look in Sent Mail before you act.",
      };
    case "operator_attested_absent":
      return {
        kind: "unavailable",
        message: "This message was not sent. Ask the agent for a new draft.",
      };
    case "invalidated":
    case "proposal_missing":
      return {
        kind: "unavailable",
        message: "The draft changed or is gone in Gmail, so it was not sent.",
      };
    case "revoked":
      return {
        kind: "unavailable",
        message:
          "Access to this mailbox was removed, so the draft was not sent.",
      };
    default:
      return { kind: "unavailable", message: "This draft is closed." };
  }
}

function AttestActions(
  props: Readonly<{ proposalId: string; context: EmailDraftContext }>,
): React.ReactNode {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function attest(attestation: "present" | "absent"): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await props.context.actions.attestEmailOperational(
        props.proposalId,
        attestation,
      );
      await props.context.onChanged();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="draft-message-actions">
      <button
        type="button"
        className="draft-message-button"
        data-tone="secondary"
        aria-disabled={busy}
        onClick={() => void (busy ? undefined : attest("present"))}
      >
        Found in Sent Mail
      </button>
      <button
        type="button"
        className="draft-message-button"
        data-tone="secondary"
        aria-disabled={busy}
        onClick={() => void (busy ? undefined : attest("absent"))}
      >
        Not in Sent Mail
      </button>
      {error === null ? null : (
        <p className="draft-message-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

type SlackDraftContext = Readonly<{
  actions: SlackDraftActions;
  canManage: boolean;
  onChanged: () => Promise<void>;
}>;

export function slackDraftInserts(
  drafts: readonly SlackDraftView[],
  context: SlackDraftContext,
): readonly ChatTimelineInsert[] {
  return drafts.map((draft) => ({
    key: `slack:${draft.proposalId}`,
    createdAt: draft.createdAt,
    node: (
      <ChatSlackDraftCard
        key={`slack:${draft.proposalId}`}
        draft={draft}
        context={context}
      />
    ),
  }));
}

function ChatSlackDraftCard(
  props: Readonly<{ draft: SlackDraftView; context: SlackDraftContext }>,
): React.ReactNode {
  const { context } = props;
  // The answer of the last action shows at once; the next chat read replaces it.
  const [answered, setAnswered] = React.useState<SlackDraftView | null>(null);
  const draft =
    answered !== null && answered.version >= props.draft.version
      ? answered
      : props.draft;
  const [channels, setChannels] = React.useState<SlackChannelsState>({
    kind: "loading",
  });
  const [reloads, setReloads] = React.useState(0);
  const [chosen, setChosen] = React.useState<string | null>(null);
  const open =
    draft.lifecycle === "awaiting_approval" ||
    draft.lifecycle === "send_failed";
  React.useEffect(() => {
    if (!open || !context.canManage) return;
    setChannels({ kind: "loading" });
    let current = true;
    context.actions
      .read(draft.proposalId)
      .then((read) => {
        if (current) setChannels({ kind: "ready", channels: read.channels });
      })
      .catch(() => {
        if (current) setChannels({ kind: "failed" });
      });
    return () => {
      current = false;
    };
  }, [draft.proposalId, open, context.canManage, reloads]);
  const knownChannels = channels.kind === "ready" ? channels.channels : null;
  const channelId = chosen ?? draft.channelId;
  async function settle(next: Promise<SlackDraftView>): Promise<string | null> {
    setAnswered(await next);
    await context.onChanged();
    return null;
  }
  const fields: DraftMessageField[] = [];
  if (draft.workspaceName !== null)
    fields.push({ label: "Workspace", value: draft.workspaceName });
  fields.push({
    label: "To",
    value:
      open &&
      context.canManage &&
      knownChannels !== null &&
      knownChannels.length > 0 ? (
        <ChannelPicker
          channels={knownChannels}
          value={channelId}
          onChange={setChosen}
        />
      ) : (
        channelLabel(draft, channelId, knownChannels)
      ),
  });
  return (
    <DraftMessageCard
      icon={<ProviderTile provider="slack" label="" />}
      title="Slack message"
      status={slackCardStatus(draft, context.canManage, channels)}
      footer={
        open && context.canManage && channels.kind === "failed" ? (
          <DraftReadRetry retry={setReloads.bind(null, incrementDraftReload)} />
        ) : open && context.canManage && channels.kind === "ready" ? (
          <VoiceApprovalLine
            target={{ kind: "slack_draft", id: draft.proposalId }}
            approve={async () =>
              channelId === null
                ? "Choose a channel first."
                : settle(context.actions.send(draft, channelId))
            }
          />
        ) : undefined
      }
      notice={
        draft.lifecycle === "send_failed" && context.canManage
          ? draft.failureMessage
          : null
      }
      fields={fields}
      body={draft.body}
      edit={
        open && context.canManage && channels.kind === "ready"
          ? {
              maxLength: 8000,
              revision: draft.version,
              onSave: (text) =>
                settle(context.actions.edit(draft, text, channelId)),
            }
          : null
      }
      decision={
        open && context.canManage && channels.kind === "ready"
          ? {
              onSend: async () =>
                channelId === null
                  ? "Choose a channel first."
                  : settle(context.actions.send(draft, channelId)),
              onDiscard: () => settle(context.actions.discard(draft)),
            }
          : null
      }
    />
  );
}

type SlackChannelsState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "ready"; channels: readonly SlackChannelView[] }>;

function slackCardStatus(
  draft: SlackDraftView,
  canManage: boolean,
  channels: SlackChannelsState,
): DraftMessageStatus {
  const editable =
    draft.lifecycle === "awaiting_approval" ||
    draft.lifecycle === "send_failed";
  if (!editable || !canManage) return slackStatus(draft, canManage);
  switch (channels.kind) {
    case "loading":
      return { kind: "loading" };
    case "failed":
      return {
        kind: "unavailable",
        message: "Slack channels could not be loaded. Try again.",
      };
    case "ready":
      return slackStatus(draft, canManage);
    default:
      return assertNever(channels, "Unknown Slack channel read");
  }
}

function incrementDraftReload(value: number): number {
  return value + 1;
}

function ChannelPicker(
  props: Readonly<{
    channels: readonly SlackChannelView[];
    value: string | null;
    onChange: (channelId: string) => void;
  }>,
): React.ReactNode {
  const items = props.channels.map((channel) => ({
    value: channel.channelId,
    label: `#${channel.name ?? channel.channelId}`,
  }));
  return (
    <Select.Root
      items={items}
      value={props.value}
      onValueChange={(value) => {
        if (value !== null) props.onChange(value);
      }}
    >
      <Select.Trigger className="draft-message-select" aria-label="Channel">
        <Select.Value placeholder="Choose a channel" />
      </Select.Trigger>
      <Select.Popup>
        {items.map((item) => (
          <Select.Item key={item.value} value={item.value}>
            {item.label}
          </Select.Item>
        ))}
      </Select.Popup>
    </Select.Root>
  );
}

function channelLabel(
  draft: SlackDraftView,
  channelId: string | null,
  channels: readonly SlackChannelView[] | null,
): string {
  if (channelId === null)
    return draft.channelHint === null
      ? "No channel chosen"
      : `#${draft.channelHint}`;
  const known =
    channels?.find((channel) => channel.channelId === channelId)?.name ??
    (channelId === draft.channelId ? draft.channelName : null);
  return `#${known ?? channelId}`;
}

function slackStatus(
  draft: SlackDraftView,
  canManage: boolean,
): DraftMessageStatus {
  switch (draft.lifecycle) {
    case "awaiting_approval":
      return canManage
        ? { kind: "ready" }
        : {
            kind: "waiting",
            message:
              "An owner or admin with edit access to this chat must review and send this message.",
          };
    case "sending":
      return { kind: "sending" };
    case "send_failed":
      return canManage
        ? { kind: "ready" }
        : {
            kind: "unavailable",
            message: draft.failureMessage ?? "Slack did not post this message.",
          };
    case "sent":
      return { kind: "sent" };
    case "rejected":
      return { kind: "discarded" };
    case "expired":
      return { kind: "expired" };
    default:
      return assertNever(draft.lifecycle, "Unknown Slack draft state");
  }
}

import {
  isNonNegativeInteger,
  isRecord,
  positiveIntegerOrNull,
} from "@purin-labs/std";

/** A Slack message that the agent drafted in this conversation. */
export type SlackDraftView = Readonly<{
  proposalId: string;
  version: number;
  workspaceName: string | null;
  channelId: string | null;
  /** The channel name without "#", when the workspace's discovery knows it. */
  channelName: string | null;
  /** What the agent named, such as "general", before a person chose. */
  channelHint: string | null;
  body: string;
  bodyDigest: string;
  lifecycle:
    | "awaiting_approval"
    | "sending"
    | "sent"
    | "send_failed"
    | "rejected"
    | "expired";
  failureMessage: string | null;
  createdAt: number;
}>;

export type SlackChannelView = Readonly<{
  channelId: string;
  name: string | null;
}>;

export function parseSlackDrafts(raw: unknown): readonly SlackDraftView[] {
  // A server without Slack drafts sends none.
  if (raw === undefined) return [];
  if (!Array.isArray(raw))
    throw new Error("The server returned an invalid list of Slack drafts.");
  return raw.map(parseSlackDraft);
}

const LIFECYCLES: Readonly<Record<SlackDraftView["lifecycle"], true>> = {
  awaiting_approval: true,
  sending: true,
  sent: true,
  send_failed: true,
  rejected: true,
  expired: true,
};

function isLifecycle(value: unknown): value is SlackDraftView["lifecycle"] {
  return typeof value === "string" && Object.hasOwn(LIFECYCLES, value);
}

export function parseSlackDraft(raw: unknown): SlackDraftView {
  const version = isRecord(raw) ? positiveIntegerOrNull(raw.version) : null;
  if (
    !isRecord(raw) ||
    typeof raw.proposalId !== "string" ||
    version === null ||
    !nullableString(raw.workspaceName) ||
    !nullableString(raw.channelId) ||
    !nullableString(raw.channelName) ||
    !nullableString(raw.channelHint) ||
    typeof raw.body !== "string" ||
    typeof raw.bodyDigest !== "string" ||
    !isLifecycle(raw.lifecycle) ||
    !nullableString(raw.failureMessage) ||
    !isNonNegativeInteger(raw.createdAt)
  )
    throw new Error("The server returned an invalid Slack draft.");
  return {
    proposalId: raw.proposalId,
    version,
    workspaceName: raw.workspaceName,
    channelId: raw.channelId,
    channelName: raw.channelName,
    channelHint: raw.channelHint,
    body: raw.body,
    bodyDigest: raw.bodyDigest,
    lifecycle: raw.lifecycle,
    failureMessage: raw.failureMessage,
    createdAt: raw.createdAt,
  };
}

export function parseChannel(raw: unknown): SlackChannelView {
  if (
    !isRecord(raw) ||
    typeof raw.channelId !== "string" ||
    !nullableString(raw.name)
  )
    throw new Error("The server returned an invalid Slack channel.");
  return { channelId: raw.channelId, name: raw.name };
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

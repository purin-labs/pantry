import type { ConversationId } from "@seams/control-api";
import {
  ControlApiError,
  controlRead,
  controlWrite,
  readCookie,
} from "../../control-client";
import { isRecord } from "@seams/std";
import { type SlackChannelView, type SlackDraftView, parseChannel, parseSlackDraft } from "@seams/control-api/portal/slack-drafts";

export type SlackDraftActions = Readonly<{
  read: (
    proposalId: string,
  ) => Promise<
    Readonly<{ draft: SlackDraftView; channels: readonly SlackChannelView[] }>
  >;
  send: (draft: SlackDraftView, channelId: string) => Promise<SlackDraftView>;
  edit: (
    draft: SlackDraftView,
    text: string,
    channelId: string | null,
  ) => Promise<SlackDraftView>;
  discard: (draft: SlackDraftView) => Promise<SlackDraftView>;
}>;

export function createSlackDraftActions(
  organisationId: string,
  conversationId: ConversationId,
): SlackDraftActions {
  const base = `/v1/control/organisations/${encodeURIComponent(organisationId)}/chat/conversations/${encodeURIComponent(conversationId)}/slack-messages`;
  const path = (proposalId: string): string =>
    `${base}/${encodeURIComponent(proposalId)}`;
  return {
    read: async (proposalId) => {
      const raw = await slackDraftResult(controlRead(path(proposalId)));
      if (!Array.isArray(raw.channels))
        throw new Error("The server returned an invalid Slack draft.");
      return {
        draft: parseSlackDraft(raw.draft),
        channels: raw.channels.map(parseChannel),
      };
    },
    send: async (draft, channelId) =>
      parseSlackDraft(
        (
          await slackDraftMutation(`${path(draft.proposalId)}/send`, {
            version: draft.version,
            bodyDigest: draft.bodyDigest,
            channelId,
          })
        ).draft,
      ),
    edit: async (draft, text, channelId) =>
      parseSlackDraft(
        (
          await slackDraftMutation(`${path(draft.proposalId)}/edit`, {
            version: draft.version,
            text,
            channelId,
          })
        ).draft,
      ),
    discard: async (draft) =>
      parseSlackDraft(
        (
          await slackDraftMutation(`${path(draft.proposalId)}/discard`, {
            version: draft.version,
          })
        ).draft,
      ),
  };
}

export async function slackDraftMutation(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const csrf = readCookie("satyr_control_csrf");
  if (csrf === null) throw new Error("Sign in again to act on this draft.");
  return slackDraftResult(controlWrite(path, "POST", body));
}

export async function slackDraftResult(
  request: Promise<unknown>,
): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await request;
  } catch (error) {
    if (!(error instanceof ControlApiError)) throw error;
    if (error.status === 409)
      throw new Error(
        "This draft changed or the channel is no longer connected. Refresh the chat and try again.",
      );
    raw = null;
  }
  if (!isRecord(raw) || raw.ok !== true)
    throw new Error("Pantry could not update this draft. Try again.");
  return raw;
}

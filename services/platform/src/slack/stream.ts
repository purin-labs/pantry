import type { ChannelId, WorkspaceId } from "../ids";
import type { Result } from "../result";
import { isAmbiguousSlackOutcome, slackRetryAt } from "./messages";
import { errorMessage, isRecord } from "@purin-labs/std";

/**
 * Slack's streaming methods for an answer in a thread: start a message, append
 * text to it, and stop it. An appended text cannot be taken back, and Slack
 * does not deduplicate an append, so a caller records each append before it
 * sends it. Each call carries at most `SLACK_STREAM_TEXT_LIMIT` characters.
 */

export const SLACK_STREAM_TEXT_LIMIT = 12_000;

type SlackStreamTarget = Readonly<{
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  threadTs: string;
  recipientUserId: string;
}>;

export type SlackStreamMethod =
  "chat.startStream" | "chat.appendStream" | "chat.stopStream";

export type SlackStreamError =
  | {
      readonly code: "rate_limited";
      readonly detail: string;
      readonly retryAt: number;
      readonly operation?: never;
    }
  | {
      // Slack may have applied the call: the request failed in transit or
      // Slack answered with an internal error.
      readonly code: "ambiguous";
      readonly detail: string;
      readonly retryAt: null;
      readonly operation: SlackStreamMethod;
    }
  | {
      // The message is no longer streaming: the person stopped it, or Slack
      // ended it. Nothing more can be appended.
      readonly code: "ended";
      readonly detail: string;
      readonly retryAt: null;
      readonly operation?: never;
    }
  | {
      readonly code: "slack_stream_failed";
      readonly detail: string;
      readonly retryAt: null;
      readonly operation?: never;
    };

export async function startSlackStream(input: {
  readonly token: string;
  readonly target: SlackStreamTarget;
  readonly markdownText: string;
  readonly now: number;
}): Promise<Result<{ readonly slackTs: string }, SlackStreamError>> {
  const response = await callSlackStreamMethod(
    "chat.startStream",
    input.token,
    {
      channel: input.target.channelId,
      thread_ts: input.target.threadTs,
      recipient_user_id: input.target.recipientUserId,
      recipient_team_id: input.target.workspaceId,
      markdown_text: input.markdownText,
    },
    input.now,
  );
  if (!response.ok) return response;
  const slackTs = response.value.ts;
  // A start that names no message may still have made one.
  return typeof slackTs === "string" && slackTs.length > 0
    ? { ok: true, value: { slackTs } }
    : ambiguous("chat.startStream", "chat.startStream answered without ts");
}

export async function appendSlackStream(input: {
  readonly token: string;
  readonly channelId: ChannelId;
  readonly slackTs: string;
  readonly markdownText: string;
  readonly now: number;
}): Promise<Result<null, SlackStreamError>> {
  const response = await callSlackStreamMethod(
    "chat.appendStream",
    input.token,
    {
      channel: input.channelId,
      ts: input.slackTs,
      markdown_text: input.markdownText,
    },
    input.now,
  );
  return response.ok ? { ok: true, value: null } : response;
}

export async function stopSlackStream(input: {
  readonly token: string;
  readonly channelId: ChannelId;
  readonly slackTs: string;
  /** Text appended as the stream stops, for a closing notice. */
  readonly markdownText: string | null;
  readonly now: number;
}): Promise<Result<null, SlackStreamError>> {
  const response = await callSlackStreamMethod(
    "chat.stopStream",
    input.token,
    input.markdownText === null
      ? { channel: input.channelId, ts: input.slackTs }
      : {
          channel: input.channelId,
          ts: input.slackTs,
          markdown_text: input.markdownText,
        },
    input.now,
  );
  return response.ok ? { ok: true, value: null } : response;
}

async function callSlackStreamMethod(
  method: SlackStreamMethod,
  token: string,
  payload: Record<string, unknown>,
  now: number,
): Promise<Result<Record<string, unknown>, SlackStreamError>> {
  let response: Response;
  try {
    response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return ambiguous(method, errorMessage(error));
  }
  if (response.status === 429) {
    return {
      ok: false,
      error: {
        code: "rate_limited",
        detail: "slack_http_429",
        retryAt: slackRetryAt(response.headers.get("retry-after"), now),
      },
    };
  }
  if (response.status >= 500)
    return ambiguous(method, `slack_http_${response.status}`);
  // An answer that cannot be read may follow a call that Slack applied.
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return ambiguous(method, errorMessage(error));
  }
  if (!isRecord(body)) return ambiguous(method, "slack_response_not_object");
  if (body.ok !== true) {
    const detail =
      typeof body.error === "string" ? body.error : `Slack ${method} failed`;
    if (isAmbiguousSlackOutcome(detail)) return ambiguous(method, detail);
    if (detail === "ratelimited")
      return {
        ok: false,
        error: { code: "rate_limited", detail, retryAt: now + 1_000 },
      };
    return {
      ok: false,
      error: {
        code:
          detail === "message_not_in_streaming_state"
            ? "ended"
            : "slack_stream_failed",
        detail,
        retryAt: null,
      },
    };
  }
  return { ok: true, value: body };
}

function ambiguous(
  operation: SlackStreamMethod,
  detail: string,
): Result<never, SlackStreamError> {
  return {
    ok: false,
    error: { code: "ambiguous", detail, retryAt: null, operation },
  };
}

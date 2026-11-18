import { SLACK_NO_LINK_PREVIEW } from "./messages";
import { errorMessage, isRecord } from "@seams/std";

import { RequestDeadline } from "../request-deadline";
import type { Result } from "../result";
import type { SlackSideCaseMessage } from "./side-cases";

/**
 * The Slack calls of a side Case (Plan 74): a post with a Start button, the
 * root of a new thread, the link line, and the change of the proposal after
 * a start. Each call has its own deadline. A failed call is reported, not
 * retried: the caller keeps what it posted and repeats only the rest.
 */

const SLACK_SIDE_CASE_CALL_TIMEOUT_MS = 5_000;

type SlackSideCaseCallError = Readonly<{ code: string }>;

/** Post a message, in a thread or as a new root. It returns its timestamp. */
export async function postSlackSideCaseMessage(
  input: Readonly<{
    token: string;
    channelId: string;
    /** Null posts a new top-level message, which starts a thread. */
    threadTs: string | null;
    message: SlackSideCaseMessage;
  }>,
): Promise<Result<string, SlackSideCaseCallError>> {
  const body = await callSlack(input.token, "chat.postMessage", {
    channel: input.channelId,
    ...(input.threadTs === null ? {} : { thread_ts: input.threadTs }),
    text: input.message.text,
    blocks: input.message.blocks,
    ...SLACK_NO_LINK_PREVIEW,
  });
  if (!body.ok) return body;
  return typeof body.value.ts === "string"
    ? { ok: true, value: body.value.ts }
    : { ok: false, error: { code: "slack_side_case_post_invalid" } };
}

/** Replace a message that Pantry posted. */
export async function updateSlackSideCaseMessage(
  input: Readonly<{
    token: string;
    channelId: string;
    ts: string;
    message: SlackSideCaseMessage;
  }>,
): Promise<Result<null, SlackSideCaseCallError>> {
  const body = await callSlack(input.token, "chat.update", {
    channel: input.channelId,
    ts: input.ts,
    text: input.message.text,
    blocks: input.message.blocks,
  });
  return body.ok ? { ok: true, value: null } : body;
}

/** The link that opens one message, and its thread. */
export async function readSlackPermalink(
  input: Readonly<{ token: string; channelId: string; messageTs: string }>,
): Promise<Result<string, SlackSideCaseCallError>> {
  const query = new URLSearchParams({
    channel: input.channelId,
    message_ts: input.messageTs,
  });
  const body = await callSlack(
    input.token,
    `chat.getPermalink?${query.toString()}`,
    null,
  );
  if (!body.ok) return body;
  const permalink = body.value.permalink;
  return typeof permalink === "string" && permalink.startsWith("https://")
    ? { ok: true, value: permalink }
    : { ok: false, error: { code: "slack_side_case_permalink_invalid" } };
}

/** A read uses GET with its query; a write sends a JSON body. */
async function callSlack(
  token: string,
  method: string,
  payload: Record<string, unknown> | null,
): Promise<Result<Record<string, unknown>, SlackSideCaseCallError>> {
  const deadline = new RequestDeadline(SLACK_SIDE_CASE_CALL_TIMEOUT_MS);
  let body: unknown;
  try {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: payload === null ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload === null
          ? {}
          : { "content-type": "application/json; charset=utf-8" }),
      },
      signal: deadline.signal,
      ...(payload === null ? {} : { body: JSON.stringify(payload) }),
    });
    if (response.status === 429) return failure("slack_http_429");
    if (!response.ok) return failure(`slack_http_${response.status}`);
    body = await response.json();
  } catch (error) {
    return failure(`slack_side_case_call_failed:${errorMessage(error)}`);
  } finally {
    deadline.end();
  }
  if (!isRecord(body)) return failure("slack_side_case_response_invalid");
  if (body.ok !== true)
    return failure(
      typeof body.error === "string"
        ? `slack_${body.error}`
        : "slack_side_case_call_failed",
    );
  return { ok: true, value: body };
}

function failure(code: string): Result<never, SlackSideCaseCallError> {
  return { ok: false, error: { code } };
}

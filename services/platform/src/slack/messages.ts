import { RequestDeadline } from "../request-deadline";
import type { ChannelId } from "../ids";
import type { Result } from "../result";
import { errorMessage, isRecord } from "@purin-labs/std";

const SLACK_THREAD_STATUS_TIMEOUT_MS = 2_000;

export type SlackMessageError =
  | {
      code: "rate_limited";
      detail: string;
      retryAt: number;
      operation?: never;
    }
  | {
      code: "ambiguous";
      detail: string;
      retryAt: null;
      operation: "chat.postMessage";
    }
  | {
      code: "slack_message_failed" | "slack_message_invalid";
      detail: string;
      retryAt: null;
      operation?: never;
    };

type SlackThreadStatusError = {
  readonly code: "slack_thread_status_failed";
  readonly detail: string;
};

export async function setSlackThreadStatus(input: {
  readonly token: string;
  readonly channelId: ChannelId;
  readonly threadTs: string;
  readonly status: string;
}): Promise<Result<null, SlackThreadStatusError>> {
  const deadline = new RequestDeadline(SLACK_THREAD_STATUS_TIMEOUT_MS);
  try {
    return await postSlackThreadStatus(input, deadline.signal);
  } finally {
    deadline.end();
  }
}

async function postSlackThreadStatus(
  input: Readonly<{
    token: string;
    channelId: ChannelId;
    threadTs: string;
    status: string;
  }>,
  signal: AbortSignal,
): Promise<Result<null, SlackThreadStatusError>> {
  let response: Response;
  try {
    response = await fetch(
      "https://slack.com/api/assistant.threads.setStatus",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        signal,
        body: JSON.stringify({
          channel_id: input.channelId,
          thread_ts: input.threadTs,
          status: input.status,
        }),
      },
    );
  } catch (error) {
    return slackThreadStatusFailure(errorMessage(error));
  }
  if (response.status === 429)
    return slackThreadStatusFailure("slack_http_429");
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return slackThreadStatusFailure(errorMessage(error));
  }
  if (!isRecord(body))
    return slackThreadStatusFailure("Slack status response was not an object");
  if (body.ok !== true) {
    return slackThreadStatusFailure(
      typeof body.error === "string"
        ? body.error
        : "Slack assistant.threads.setStatus failed",
    );
  }
  return { ok: true, value: null };
}

export async function slackClientMessageId(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Slack fetches each link of a posted message to make a preview, unless the
 * post refuses it. An answer can hold a link that outside text put there, and
 * that fetch would carry data to the link's server with no click (Plan 89
 * step 6). Each `chat.postMessage` of Pantry spreads this. A streamed message
 * has no preview.
 */
export const SLACK_NO_LINK_PREVIEW = {
  unfurl_links: false,
  unfurl_media: false,
} as const;

export async function postSlackThreadMessage(input: {
  token: string;
  channelId: ChannelId;
  threadTs: string;
  text: string;
  clientMessageId: string;
  now: number;
}): Promise<Result<null, SlackMessageError>> {
  let response: Response;

  try {
    response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: input.text,
        client_msg_id: input.clientMessageId,
        ...SLACK_NO_LINK_PREVIEW,
      }),
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "ambiguous",
        detail: errorMessage(error),
        retryAt: null,
        operation: "chat.postMessage",
      },
    };
  }

  if (response.status === 429) {
    return {
      ok: false,
      error: {
        code: "rate_limited",
        detail: "slack_http_429",
        retryAt: slackRetryAt(response.headers.get("retry-after"), input.now),
      },
    };
  }

  if (response.status >= 500) {
    return {
      ok: false,
      error: {
        code: "ambiguous",
        detail: `slack_http_${response.status}`,
        retryAt: null,
        operation: "chat.postMessage",
      },
    };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "slack_message_invalid",
        detail: errorMessage(error),
        retryAt: null,
      },
    };
  }

  if (!isRecord(body)) {
    return {
      ok: false,
      error: {
        code: "slack_message_invalid",
        detail: "Slack response was not an object",
        retryAt: null,
      },
    };
  }

  if (body.ok !== true) {
    const detail =
      typeof body.error === "string"
        ? body.error
        : "Slack chat.postMessage failed";

    if (isAmbiguousSlackOutcome(detail)) {
      return {
        ok: false,
        error: {
          code: "ambiguous",
          detail,
          retryAt: null,
          operation: "chat.postMessage",
        },
      };
    }

    const code = slackMessageErrorCode(detail);

    return code === "rate_limited"
      ? { ok: false, error: { code, detail, retryAt: input.now + 1_000 } }
      : { ok: false, error: { code, detail, retryAt: null } };
  }

  return { ok: true, value: null };
}

export function isAmbiguousSlackOutcome(detail: string): boolean {
  return (
    detail === "fatal_error" ||
    detail === "internal_error" ||
    detail === "service_unavailable"
  );
}

function slackMessageErrorCode(
  detail: string,
): Exclude<SlackMessageError["code"], "ambiguous"> {
  if (detail === "ratelimited") {
    return "rate_limited";
  }

  return "slack_message_failed";
}

function slackThreadStatusFailure(
  detail: string,
): Result<never, SlackThreadStatusError> {
  return { ok: false, error: { code: "slack_thread_status_failed", detail } };
}

/** The time that Slack's Retry-After header names, or `fallbackMs` from now. */
export function slackRetryAt(
  raw: string | null,
  now: number,
  fallbackMs = 1_000,
): number {
  if (raw === null) {
    return now + fallbackMs;
  }

  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0
    ? now + Math.ceil(seconds * 1_000)
    : now + fallbackMs;
}

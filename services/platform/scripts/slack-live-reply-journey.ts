/**
 * Live Slack reply journey.
 *
 * The E2E journeys answer Slack and the model with fakes. This journey proves
 * the integration that the fakes cannot: a person mentions the deployed Pantry
 * app in a real channel, Slack delivers the event, the pinned model route
 * answers, and exactly one reply appears in the thread.
 *
 * It posts one root message as a human user, because Pantry ignores messages
 * that a bot writes. It waits for the app's reply that contains a fresh nonce,
 * then waits a quiet period and checks that no second app message arrived. It
 * writes an evidence file with the timestamps and the reply text.
 *
 * It refuses to run without real credentials. There is no simulated fallback.
 *
 *   SLACK_LIVE_USER_TOKEN=xoxp-... \
 *   SLACK_LIVE_CHANNEL=C0123456789 \
 *   SLACK_APP_USER_ID=U0SATYRBOT \
 *   pnpm --filter @seams/platform slack:live-reply
 */

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isRecord } from "@seams/std";

const SLACK_API = "https://slack.com/api";
const REPLY_TIMEOUT_MS = 180_000;
const QUIET_PERIOD_MS = 30_000;
const POLL_MS = 3_000;

type Config = Readonly<{
  token: string;
  channel: string;
  appUserId: string;
  evidencePath: string;
}>;

type AppMessage = Readonly<{ ts: string; text: string }>;

async function main(): Promise<void> {
  const config = readConfig();
  const identity = await slackJson(config.token, "auth.test", {});
  if (
    typeof identity.user_id !== "string" ||
    identity.bot_id !== undefined ||
    identity.user_id === config.appUserId
  )
    throw new Error(
      "The live journey needs a human user token; Satyr ignores bot messages.",
    );

  const nonce = `live-${randomUUID().slice(0, 8)}`;
  const text = `<@${config.appUserId}> Reply with one short sentence that contains the code ${nonce}.`;
  const startedAt = Date.now();
  const posted = await slackJson(config.token, "chat.postMessage", {
    channel: config.channel,
    text,
  });
  if (typeof posted.ts !== "string")
    throw new Error("chat.postMessage returned no message timestamp.");
  const threadTs = posted.ts;

  const reply = await awaitReply(config, threadTs, nonce, startedAt);
  const firstReplyMs = reply === null ? null : Date.now() - startedAt;
  if (reply !== null) await delay(QUIET_PERIOD_MS);
  const appMessages = await readAppMessages(config, threadTs);

  const failures: string[] = [];
  if (reply === null) failures.push("no_reply_with_nonce");
  if (appMessages.length !== 1)
    failures.push(`app_messages_${appMessages.length}`);

  const evidence = {
    kind: "satyr.slack.live-reply-journey.v1",
    channel: config.channel,
    sentAt: new Date(startedAt).toISOString(),
    threadTs,
    nonce,
    firstReplyMs,
    quietPeriodMs: QUIET_PERIOD_MS,
    appMessages,
    status: failures.length === 0 ? "passed" : "failed",
    failures,
  };
  await writeFile(
    config.evidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  process.stdout.write(
    `${evidence.status}: ${appMessages.length} app message(s), first reply ${firstReplyMs ?? "none"} ms, evidence ${config.evidencePath}\n`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

function readConfig(): Config {
  const token = process.env.SLACK_LIVE_USER_TOKEN;
  const channel = process.env.SLACK_LIVE_CHANNEL;
  const appUserId = process.env.SLACK_APP_USER_ID;
  if (!token || !channel || !appUserId)
    throw new Error(
      "The live journey requires SLACK_LIVE_USER_TOKEN, SLACK_LIVE_CHANNEL and SLACK_APP_USER_ID.",
    );
  return {
    token,
    channel,
    appUserId,
    evidencePath:
      process.env.SLACK_LIVE_EVIDENCE ?? "slack-live-reply-evidence.json",
  };
}

/** A streamed answer is one message that grows, so wait for the nonce. */
async function awaitReply(
  config: Config,
  threadTs: string,
  nonce: string,
  startedAt: number,
): Promise<AppMessage | null> {
  while (Date.now() - startedAt < REPLY_TIMEOUT_MS) {
    await delay(POLL_MS);
    const messages = await readAppMessages(config, threadTs);
    const reply = messages.find((message) => message.text.includes(nonce));
    if (reply !== undefined) return reply;
  }
  return null;
}

async function readAppMessages(
  config: Config,
  threadTs: string,
): Promise<AppMessage[]> {
  const replies = await slackJson(
    config.token,
    "conversations.replies",
    { channel: config.channel, ts: threadTs },
    "GET",
  );
  const messages = Array.isArray(replies.messages) ? replies.messages : [];
  const app: AppMessage[] = [];
  for (const message of messages) {
    if (
      isRecord(message) &&
      message.ts !== threadTs &&
      message.user === config.appUserId &&
      typeof message.ts === "string" &&
      typeof message.text === "string"
    )
      app.push({ ts: message.ts, text: message.text });
  }
  return app;
}

async function slackJson(
  token: string,
  method: string,
  body: Record<string, unknown>,
  verb: "GET" | "POST" = "POST",
): Promise<Record<string, unknown>> {
  const url = new URL(`${SLACK_API}/${method}`);
  let response: Response;
  if (verb === "GET") {
    for (const [key, value] of Object.entries(body))
      url.searchParams.set(key, String(value));
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
  } else {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
  }
  const parsed: unknown = await response.json();
  if (!isRecord(parsed) || parsed.ok !== true) {
    const detail = isRecord(parsed) ? String(parsed.error) : "unparseable";
    throw new Error(`${method} failed: ${detail}`);
  }
  return parsed;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

await main();

// The Slack workspace, model and requests of the streamed-answer journeys.
import { fixtureDatabase } from "./organisation-database";
import { expect } from "vitest";
import { exports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { isRecord } from "@seams/std";

import { createAccessGrant } from "../../src/data/access-grants";
import {
  ROOT_TS,
  ORGANISATION_ID,
  inspectSlackActors,
  signedSlackRequest,
  slackEnvelope,
} from "./slack-journey-support";

// Six parts of a long answer. They arrive 400 ms apart, so the Connector
// releases them in several parts of about one second each.
export const ANSWER_PARTS = [
  "The morning bake starts with the laminated doughs, because they need the longest proof and the coolest room. ",
  "Croissants and pain au chocolat go into the proofer first, at twenty six degrees with high humidity. ",
  "While they proof, the team weighs the financier batter and pipes the moulds for the first tray of the day. ",
  "The deck oven heats to the higher setting for the bread, then drops for the viennoiserie once the loaves come out. ",
  "Glazing and the last decoration happen after the trays cool on the racks near the back door of the shop. ",
  "The counter opens when the first trays are cool enough to pack, and the gift boxes follow later in the morning.",
];
export const ANSWER = ANSWER_PARTS.join("");
export const PART_GAP_MS = 400;
// The Connector checks the requester's live authority again 10 s after its
// last check. This answer lasts longer, so the check falls inside it.
export const SLOW_PART_GAP_MS = 2_500;

export async function grantOperatorOneMoreCapability(
  grantId: string,
): Promise<void> {
  const granted = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID as never,
    grantId,
    subject: { kind: "organisation_role", role: "operator" },
    target: {
      kind: "platform_capability",
      capabilityId: "workspace.query",
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: `receipt_${grantId}`,
    },
    now: Date.now(),
  });
  if (!granted.ok) throw new Error("The stream journey grant failed");
}

export async function caseSnapshot(connectorId: string) {
  const actors = await inspectSlackActors(connectorId);
  if (!actors.case.ok) throw new Error("The Slack Case is unreadable");
  return actors.case.value;
}

export async function askInSlack(eventId: string): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId,
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: "<@U0PANTRY> how does the morning bake run?",
      }),
    ),
  );
  expect(response.status).toBe(200);
}

type SlackCall = Readonly<{
  method: string;
  body: Record<string, unknown>;
}>;

/** A Slack workspace that accepts streamed answers and records every call. */
export function slackStreamSimulator(
  options: Readonly<{
    loseFirstAppend?: boolean;
    stopAtFirstAppend?: boolean;
  }> = {},
) {
  const calls: SlackCall[] = [];
  let lostAppend = false;
  const streamTs = "1787500002.000001";
  return {
    calls,
    methods: (): string[] => calls.map((call) => call.method),
    streamTs: (): string => streamTs,
    /** The text that the thread shows in the streamed message. */
    streamedText: (): string =>
      calls
        .filter(
          (call, index) =>
            (call.method === "chat.startStream" ||
              call.method === "chat.appendStream") &&
            !(options.loseFirstAppend === true && isFirstAppend(index)),
        )
        .map((call) => String(call.body.markdown_text ?? ""))
        .join(""),
    handler: http.post(
      "https://slack.com/api/:method",
      async ({ params, request }) => {
        const method = String(params.method);
        const raw: unknown = await request.json();
        const body = isRecord(raw) ? raw : {};
        if (method === "assistant.threads.setStatus")
          return HttpResponse.json({ ok: true });
        calls.push({ method, body });
        switch (method) {
          case "chat.startStream":
            return HttpResponse.json({ ok: true, ts: streamTs });
          case "chat.appendStream":
            if (options.stopAtFirstAppend === true)
              // The person pressed Stop: the message no longer streams.
              return HttpResponse.json({
                ok: false,
                error: "message_not_in_streaming_state",
              });
            if (options.loseFirstAppend === true && !lostAppend) {
              // Slack applied the append, and its answer is lost on the way.
              lostAppend = true;
              return new HttpResponse("upstream failed", { status: 502 });
            }
            return HttpResponse.json({ ok: true, ts: streamTs });
          case "chat.stopStream":
            return HttpResponse.json({ ok: true, ts: streamTs });
          case "chat.postMessage":
            return HttpResponse.json({
              ok: true,
              ts: "1787500003.000001",
              channel: body.channel,
            });
          case "chat.update":
            return HttpResponse.json({ ok: true, ts: body.ts });
          default:
            throw new Error(`Unexpected Slack method: ${method}`);
        }
      },
    ),
  };

  function isFirstAppend(index: number): boolean {
    return (
      calls.findIndex((call) => call.method === "chat.appendStream") === index
    );
  }
}

/** A model that sends its answer in parts with a pause between them. */
export function slowModel(parts: readonly string[], gapMs = PART_GAP_MS) {
  let requests = 0;
  let done = false;
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  return {
    started,
    finished,
    done: (): boolean => done,
    handler: http.post("https://openrouter.ai/api/v1/chat/completions", () => {
      started.resolve();
      requests += 1;
      if (requests > 1) throw new Error("Unexpected additional model request");
      const encoder = new TextEncoder();
      const id = "chatcmpl_e2e_stream";
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const part of parts) {
            controller.enqueue(encoder.encode(sse(textChunk(id, part))));
            await new Promise((resolve) => setTimeout(resolve, gapMs));
          }
          controller.enqueue(encoder.encode(sse(stopChunk(id))));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          done = true;
          finished.resolve();
        },
      });
      return new HttpResponse(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }),
  };
}

export function sse(chunk: Record<string, unknown>): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function textChunk(id: string, text: string): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1_787_500_000,
    model: "moonshotai/kimi-k3",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      },
    ],
  };
}

export function stopChunk(id: string): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1_787_500_000,
    model: "moonshotai/kimi-k3",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 120, total_tokens: 140 },
  };
}

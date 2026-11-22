import { exports } from "cloudflare:workers";
import { isRecord } from "@purin-labs/std";

import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import { commerceHeaders } from "./commerce-support";
import { ORGANISATION_ID } from "./slack-journey-support";

/** The Portal chat requests of the model-choice journeys, as Portal sends them. */

export function modelIds(menu: Record<string, unknown>): unknown[] {
  const options = Array.isArray(menu.options) ? menu.options : [];
  return options.map((option: unknown) =>
    isRecord(option) ? option.id : null,
  );
}

export async function readChat(
  session: IssuedControlSession,
  conversationId: string | null,
): Promise<{
  readonly model: Record<string, unknown>;
  readonly conversation: Record<string, unknown>;
}> {
  const query =
    conversationId === null ? "" : `?conversation=${conversationId}`;
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat${query}`,
    { headers: commerceHeaders(session) },
  );
  const raw: unknown = await response.json();
  if (response.status !== 200 || !isRecord(raw) || !isRecord(raw.model))
    throw new Error(`Chat read failed: ${JSON.stringify(raw)}`);
  return {
    model: raw.model,
    conversation: isRecord(raw.conversation) ? raw.conversation : {},
  };
}

export async function readWork(
  session: IssuedControlSession,
  conversationId: string,
): Promise<unknown> {
  const { conversation } = await readChat(session, conversationId);
  return isRecord(conversation.work) ? conversation.work.kind : "missing";
}

export async function sendMessage(
  session: IssuedControlSession,
  message: {
    readonly conversationId: string;
    readonly requestId: string;
    readonly model: string;
    readonly effort?: "low" | "medium" | "high";
    readonly text: string;
  },
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat`,
    {
      method: "POST",
      headers: commerceHeaders(session),
      body: JSON.stringify({
        kind: "message",
        ...message,
      }),
    },
  );
  return { status: response.status, body: await response.json() };
}

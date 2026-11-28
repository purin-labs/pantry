import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";

import { createEmbeddedHarnessModelRouteLease } from "@purin-labs/agent/actors/session/model-route";
import { resolveOrganisationModelRouteAtScope } from "@purin-labs/agent/models/route";
import { resolveCurrentOrganisationModelCredential } from "@purin-labs/authority/credential-vault/index";
import { parseVaultHandle } from "@purin-labs/authority/credential-vault/domain";
import { resolveVaultHandle } from "@purin-labs/authority/credential-vault/service";
import { parseSessionId } from "@purin-labs/kernel/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { changeAiAccount } from "./ai-account-support";
import { preparePortalChatJourney } from "./chat-journey-support";
import { readChat, readWork, sendMessage } from "./chat-model-choice-support";
import { FakeGemini, type GeminiAnswer } from "./gemini-support";
import { joinMember } from "./memory-support";
import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";
import { connectorOf, readReceipt } from "./slack-follow-up-support";
import {
  ORGANISATION_ID,
  ROOT_TS,
  openRouterText,
  postMention,
  slackSimulator,
} from "./slack-journey-support";

/**
 * An admin removes the organisation's Gemini API key from Pantry with a
 * change of the AI account (spec FND-04, spec FND-08).
 *
 * The admin saves a Gemini key, and a Slack thread and a Portal chat answer
 * on it. An operator cannot change the AI account, so the key stays. The
 * admin then changes the AI account to Purin AI. Pantry holds the key no
 * more: the key read of a turn on the old key route fails, the Vault gives
 * the secret to nobody, the open Slack thread gets its next answer from
 * Purin AI, and the Portal chat tells the person to start a new chat. No
 * request reaches Gemini after the change. When the admin saves a new Gemini
 * key, the chat and the thread answer on the new key.
 */
it(
  "removes the organisation's Gemini key with a change of the AI account, and a new key works after it",
  modelKeyRemovalJourney,
  180_000,
);

const FIRST_KEY = "AIzaE2EModelKeyRemovalJourney00000000001";
const SECOND_KEY = "AIzaE2EModelKeyRemovalJourney00000000002";
const CHAT = "conv_9d4a6f5b-2e7a-4b0d-9f8c-4a5b6c7d8e04";
const GEMINI_SOURCE = { kind: "organisation_google_api_key" };
const CHAT_MODEL_CHANGED =
  "This conversation's AI connection has changed. Restore its connection or start a new chat.";
const PURIN_AI_ANSWER = "Purin AI: the oven is at 190 degrees.";

async function modelKeyRemovalJourney(test: TestContext): Promise<void> {
  const { session: admin, fixture } = await preparePortalChatJourney();
  const gemini = new FakeGemini(FIRST_KEY);
  gemini.issue(SECOND_KEY);
  gemini.install();
  const slack = slackSimulator();
  const purinAi: unknown[] = [];
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      answerOnPurinAi.bind(null, purinAi),
    ),
  );
  const connectorId = fixture.connectorId;
  /** One mention in the thread, and the texts of the thread after it. */
  async function askInThread(
    step: number,
    question: string,
    answer: string | null,
  ): Promise<(string | undefined)[]> {
    if (answer !== null) gemini.answers.push(threadAnswer(answer));
    const eventId = `Ev_MODEL_KEY_REMOVAL_${String(step)}`;
    await postMention(
      eventId,
      `1787500000.00000${String(step)}`,
      question,
      ROOT_TS,
    );
    const connector = await connectorOf(connectorId);
    await expect
      .poll(
        () => runInDurableObject(connector, readReceipt.bind(null, eventId)),
        { timeout: 40_000 },
      )
      .toBe("completed");
    await expect
      .poll(slack.visibleMessageCount, { timeout: 15_000 })
      .toBe(step);
    return slack.messages.map(textOf);
  }
  /** One message in the Portal chat, and the answer that the chat then shows. */
  async function askInChat(
    requestId: string,
    question: string,
    answer: string,
  ): Promise<void> {
    gemini.answers.push(chatAnswer(answer));
    expect(
      await sendMessage(admin, {
        conversationId: CHAT,
        requestId,
        model: "gemini-4-hydrogen",
        text: question,
      }),
    ).toMatchObject({ status: 200 });
    await expect
      .poll(readWork.bind(null, admin, CHAT), { timeout: 30_000 })
      .toBe("ready");
    expect(
      JSON.stringify((await readChat(admin, CHAT)).conversation),
    ).toContain(answer);
  }

  // The admin saves the key. A thread and a chat answer on it.
  expect(
    await changeAiAccount(admin, ORGANISATION_ID, "key-removal-save-first", {
      selection: GEMINI_SOURCE,
      apiKey: FIRST_KEY,
    }),
  ).toMatchObject({ status: 200 });
  expect(
    await askInThread(1, "how many croissants are left?", "Twelve croissants."),
  ).toEqual(["Twelve croissants."]);
  await askInChat("request_key_removal_1", "How many baguettes?", "Six.");
  expect(gemini.requestKeys).toEqual([FIRST_KEY, FIRST_KEY]);
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const keyRoute = await resolveOrganisationModelRouteAtScope({
    env,
    scope,
    now: Date.now(),
  });
  if (!keyRoute.ok || keyRoute.value.keySource !== "organisation_byo")
    throw new Error("The organisation is not on its key route");

  // An operator cannot change the AI account, so the key stays in use.
  const operator = await joinMember(
    ORGANISATION_ID,
    "e2e-model-key-removal-operator",
    "operator",
  );
  const refused = await changeAiAccount(
    operator.session,
    ORGANISATION_ID,
    "key-removal-operator",
    { selection: { kind: "pantry_platform" } },
  );
  expect(refused.status).toBe(404);
  expect(await askInThread(2, "and baguettes?", "Six baguettes.")).toEqual([
    "Twelve croissants.",
    "Six baguettes.",
  ]);
  expect(gemini.requestKeys).toEqual([FIRST_KEY, FIRST_KEY, FIRST_KEY]);

  // The admin changes the AI account to Purin AI. Pantry removes the key.
  expect(
    await changeAiAccount(admin, ORGANISATION_ID, "key-removal-to-purin-ai", {
      selection: { kind: "pantry_platform" },
    }),
  ).toMatchObject({
    status: 200,
    body: { selection: { kind: "pantry_platform" } },
  });
  // A turn that still pins the key route reads no key, so it sends nothing.
  const sessionId = parseSessionId("session_e2e_model_key_removal");
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const lease = await createEmbeddedHarnessModelRouteLease({
    env,
    scope,
    sessionId: sessionId.value,
    modelRoute: keyRoute.value,
  });
  if (!lease.ok) throw new Error(lease.error.code);
  await expect(lease.value.resolveModelApiKey()).rejects.toThrow(
    "embedded_harness_model_credential_unavailable",
  );
  // The Vault gives the secret to nobody, and no key is the current one.
  const removedHandle = parseVaultHandle(keyRoute.value.byoKeyRef);
  if (!removedHandle.ok) throw new Error(removedHandle.error.code);
  const vault = {
    db: fixtureDatabase(),
    keys: env,
    organisationId: ORGANISATION_ID,
  };
  const removedSecret = await resolveVaultHandle({
    ...vault,
    handle: removedHandle.value,
  });
  expect(removedSecret).toMatchObject({
    ok: false,
    error: { code: "vault_secret_revoked" },
  });
  expect(
    await resolveCurrentOrganisationModelCredential({
      ...vault,
      provider: "google",
    }),
  ).toEqual({
    ok: false,
    error: { code: "organisation_google_credential_unavailable" },
  });
  // The open thread gets its next answer from Purin AI.
  expect(await askInThread(3, "how hot is the oven?", null)).toEqual([
    "Twelve croissants.",
    "Six baguettes.",
    PURIN_AI_ANSWER,
  ]);
  expect(purinAi).toHaveLength(1);
  // The chat that started on the key tells the person what to do.
  const menu = (await readChat(admin, CHAT)).model;
  const afterRemoval = await sendMessage(admin, {
    conversationId: CHAT,
    requestId: "request_key_removal_2",
    model: String(menu.selected),
    text: "And croissants?",
  });
  expect(afterRemoval).toEqual({
    status: 409,
    body: {
      ok: false,
      error: "chat_model_changed",
      message: CHAT_MODEL_CHANGED,
    },
  });
  // Gemini got no request after the change.
  expect(gemini.requestKeys).toEqual([FIRST_KEY, FIRST_KEY, FIRST_KEY]);

  // The admin saves a new key. The chat and the thread answer on it.
  expect(
    await changeAiAccount(admin, ORGANISATION_ID, "key-removal-save-second", {
      selection: GEMINI_SOURCE,
      apiKey: SECOND_KEY,
    }),
  ).toMatchObject({ status: 200 });
  await askInChat("request_key_removal_3", "And croissants?", "Twelve.");
  expect(
    await askInThread(4, "should we bake more?", "Yes, one more tray."),
  ).toEqual([
    "Twelve croissants.",
    "Six baguettes.",
    PURIN_AI_ANSWER,
    "Yes, one more tray.",
  ]);
  expect(gemini.requestKeys.slice(3)).toEqual([SECOND_KEY, SECOND_KEY]);
  expect(purinAi).toHaveLength(1);

  Object.assign(test.task.meta, {
    modelKeyRemoval: {
      operatorChange: refused,
      keyReadOnOldRoute: "embedded_harness_model_credential_unavailable",
      removedSecret: removedSecret.ok ? "readable" : removedSecret.error.code,
      chatAfterRemoval: afterRemoval,
      slackThread: slack.messages.map(textOf),
      geminiRequestsByKey: gemini.requestKeys.map(keyName),
      purinAiRequests: purinAi.length,
    },
  });
}

function threadAnswer(text: string): GeminiAnswer {
  return () => [{ text }];
}

function chatAnswer(text: string): GeminiAnswer {
  return () => [{ text: JSON.stringify({ kind: "reply", text }) }];
}

function textOf(post: Record<string, string>): string | undefined {
  return post.text;
}

function keyName(apiKey: string): string {
  return apiKey === FIRST_KEY ? "first key" : "second key";
}

async function answerOnPurinAi(
  requests: unknown[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  requests.push(await request.json());
  return openRouterText(
    PURIN_AI_ANSWER,
    `model_key_removal_${String(requests.length)}`,
  );
}

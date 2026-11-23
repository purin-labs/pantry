import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { afterEach, beforeEach, expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  VOICE_DEVICE_HEADER,
  VOICE_REQUEST_LIMIT,
} from "@purin-labs/control-api";
import { encodeBase64Url, isRecord } from "@purin-labs/std";

import { CommerceAdminClient } from "@purin-labs/commerce-client";

import { ensureCreatedOrganisationActor } from "@purin-labs/agent/control/organisation-runtime";
import { newControlMutationIdentity } from "@purin-labs/tenancy/data/control-mutation";
import {
  archiveOrganisation,
  deleteArchivedOrganisation,
} from "@purin-labs/tenancy/data/organisation-lifecycle";
import { runScheduledOnboardingReconciliation } from "../../src/onboarding-reconciliation-runner";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import {
  accessControlPath,
  mutationHeaders,
  readAccess,
} from "./access-route-support";
import {
  commerceClient,
  commerceHeaders,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import {
  controlPaths,
  createConversation,
  installMemoryFixture,
  post,
  storedConversation,
  workKind,
  type Member,
} from "./memory-support";
import {
  connectGateway,
  controlBase,
  credentialOf,
  enrollGateway,
  found,
  helloAndWait,
  readDeviceList,
  requireKitchenDevice,
  send,
  startGateway,
} from "./device-fleet-support";
import { network } from "./network";
import { voiceMacRequest } from "./voice-mac-support";
import { activateOrganisation } from "./organisation-fixture";
import { openRouterText } from "./slack-journey-support";

/**
 * Plan 82 Phase 1: the Platform side of Portal voice control, with a real
 * chat turn. A manager enrolls a shop Mac, and the Mac places its private
 * address in DNS. A member's device gets a grant that the Mac can check alone.
 * When the Mac does not answer, the device posts the command to the fallback,
 * and Whisper on Workers AI returns the text. The text enters the chat as a
 * spoken command, and the agent receives one message. The Organisation then
 * turns voice off: while a grant is still valid, nothing reaches the agent or
 * Workers AI. Revocation removes the Mac's names and stops its credential.
 *
 * The fake Workers AI and the fake DNS API only record and answer.
 */
it(
  "enrolls a Mac, sends a fallback command to one chat turn, and stops at the off switch",
  voiceControlJourney,
  180_000,
);

it(
  "confirms one approval card with the exact phrase and refuses each near miss",
  voiceConfirmationJourney,
  120_000,
);

it(
  "removes a Mac's names and the voice rows when its Organisation ends, and waits for a DNS outage",
  organisationEndJourney,
  180_000,
);

const ZONE_ID = "zone_e2e";
const ZONE_NAME = "voice-e2e.test";
const DEVICE = "device_baker_tablet_0001";
const SPOKEN = "Run the financier shift.";
const ANSWER = "The financier shift is running.";

type AiCall = Readonly<{
  audio: string;
  language: string;
  vad_filter: boolean;
  initial_prompt?: string;
}>;

type FakeAi = {
  calls: AiCall[];
  answer: () => Promise<Readonly<{ text?: unknown; segments?: unknown }>>;
};

type DnsRecord = Readonly<{
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
}>;

const installed = [
  "AI",
  "VOICE_DNS_API_TOKEN",
  "VOICE_DNS_ZONE_ID",
  "VOICE_DNS_ZONE_NAME",
];

let ai: FakeAi;
let records: DnsRecord[];
let dnsDown: boolean;

beforeEach(() => {
  dnsDown = false;
  ai = {
    calls: [],
    answer: () => Promise.resolve({ text: ` ${SPOKEN} ` }),
  };
  records = [];
  const define = (name: string, value: unknown) =>
    Object.defineProperty(env, name, { configurable: true, value });
  define("AI", {
    run(_model: string, inputs: AiCall) {
      ai.calls.push(inputs);
      return ai.answer();
    },
  });
  define("VOICE_DNS_API_TOKEN", "dns-e2e-token");
  define("VOICE_DNS_ZONE_ID", ZONE_ID);
  define("VOICE_DNS_ZONE_NAME", ZONE_NAME);
  const base = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records`;
  network.use(
    http.get(base, listRecords),
    http.post(base, createRecord),
    http.put(`${base}/:id`, replaceRecord),
    http.delete(`${base}/:id`, deleteRecord),
  );
});

afterEach(() => {
  for (const name of installed) Reflect.deleteProperty(env, name);
});

function listRecords({
  request,
}: Parameters<HttpResponseResolver>[0]): Response {
  const query = new URL(request.url).searchParams;
  return HttpResponse.json({
    result: records.filter(
      (record) =>
        record.type === query.get("type") && record.name === query.get("name"),
    ),
  });
}

async function createRecord({
  request,
}: Parameters<HttpResponseResolver>[0]): Promise<Response> {
  const body = (await request.json()) as Omit<DnsRecord, "id">;
  records.push({ ...body, id: crypto.randomUUID() });
  return HttpResponse.json({ success: true });
}

async function replaceRecord({
  request,
  params,
}: Parameters<HttpResponseResolver>[0]): Promise<Response> {
  const body = (await request.json()) as Omit<DnsRecord, "id">;
  records = records.map((record) =>
    record.id === params.id ? { ...body, id: record.id } : record,
  );
  return HttpResponse.json({ success: true });
}

function deleteRecord({
  params,
}: Parameters<HttpResponseResolver>[0]): Response {
  if (dnsDown) return HttpResponse.json({ success: false }, { status: 503 });
  records = records.filter((record) => record.id !== params.id);
  return HttpResponse.json({ success: true });
}

function wav(seconds: number): Uint8Array {
  const size = Math.round(seconds * 32_000);
  const bytes = new Uint8Array(44 + size);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) =>
    bytes.set(new TextEncoder().encode(text), at);
  tag(0, "RIFF");
  view.setUint32(4, 36 + size, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, size, true);
  for (let at = 44; at < bytes.length; at += 1) bytes[at] = at % 251;
  return bytes;
}

function voicePath(user: Member, tail: string): string {
  return `/v1/control/organisations/${user.organisationId}/voice/${tail}`;
}

function sendAudio(
  user: Member,
  audio: Uint8Array,
  device: string = DEVICE,
): Promise<Response> {
  const headers = commerceHeaders(user.session);
  headers.set("content-type", "audio/wav");
  headers.set(VOICE_DEVICE_HEADER, device);
  return exports.default.fetch(
    `https://localhost${voicePath(user, "transcriptions")}`,
    {
      method: "POST",
      headers,
      body: audio,
    },
  );
}

function heartbeat(
  credential: string,
  privateAddress: string,
): Promise<Response> {
  return voiceMacRequest(credential, "heartbeat", "POST", {
    privateAddress,
    serviceVersion: "0.1.0",
    modelState: "loaded",
  });
}

/**
 * Plan 82C Phase 2: a manager chooses the Mac's speech engine among the ones
 * that its service reports, and the Mac reads the choice in its heartbeat
 * answer. A viewer cannot choose. The Mac ends on Whisper.
 */
async function engineChoiceSteps(
  fixture: Awaited<ReturnType<typeof installMemoryFixture>>,
  macId: string,
  credential: string,
): Promise<void> {
  const owner = fixture.author;
  const enginePath = (member: Member) =>
    voicePath(member, `macs/${macId}/engine`);
  const listMac = async () => {
    const listed = await json(
      await exports.default.fetch(
        `https://localhost${voicePath(owner, "macs")}`,
        { headers: mutationHeaders(owner.session) },
      ),
    );
    return (listed.macs as Record<string, unknown>[]).find(
      (mac) => mac.macId === macId,
    );
  };
  const beat = async (engine: string, engines?: readonly string[]) => {
    const answer = await voiceMacRequest(credential, "heartbeat", "POST", {
      privateAddress: "192.168.1.31",
      serviceVersion: "0.5.0",
      modelState: "loaded",
      engine,
      ...(engines === undefined ? {} : { engines }),
    });
    expect(answer.status, await answer.clone().text()).toBe(200);
    return (await json(answer)).engineChoice;
  };
  const QWEN3 = "qwen3-asr-1.7b";
  const WHISPER = "whisper-large-v3-turbo";

  // A service from before Phase 2 runs only its engine, so it has no choice.
  expect(await listMac()).toMatchObject({
    engines: [WHISPER],
    engineChoice: WHISPER,
  });
  await expectError(
    post(owner, enginePath(owner), { engine: QWEN3 }),
    409,
    "voice_engine_unsupported",
  );
  expect(await beat(WHISPER, [WHISPER, QWEN3])).toBe(WHISPER);
  expect(await listMac()).toMatchObject({ engines: [WHISPER, QWEN3] });

  // Only an owner or an admin chooses. An engine that Pantry does not know is
  // refused.
  await expectError(
    post(fixture.viewer, enginePath(fixture.viewer), { engine: QWEN3 }),
    404,
    "organisation_role_insufficient",
  );
  await expectError(
    post(owner, enginePath(owner), { engine: "whisper-tiny" }),
    400,
    "voice_engine_invalid",
  );
  const chosen = await post(owner, enginePath(owner), { engine: QWEN3 });
  expect(chosen.status, await chosen.clone().text()).toBe(200);

  // The Mac reads the choice, keeps Whisper while its files come, then changes.
  expect(await beat(WHISPER, [WHISPER, QWEN3])).toBe(QWEN3);
  expect(await listMac()).toMatchObject({
    engine: WHISPER,
    engineChoice: QWEN3,
  });
  expect(await beat(QWEN3, [WHISPER, QWEN3])).toBe(QWEN3);
  expect(await listMac()).toMatchObject({ engine: QWEN3, engineChoice: QWEN3 });

  // The manager changes back. The steps after this one use Whisper.
  expect(
    (await post(owner, enginePath(owner), { engine: WHISPER })).status,
  ).toBe(200);
  expect(await beat(QWEN3, [WHISPER, QWEN3])).toBe(WHISPER);
  expect(await beat(WHISPER, [WHISPER, QWEN3])).toBe(WHISPER);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Expected an object");
  return body;
}

async function expectError(
  response: Promise<Response> | Response,
  status: number,
  code: string,
): Promise<void> {
  const settled = await response;
  const text = await settled.text();
  expect(settled.status, text).toBe(status);
  expect(text).toContain(code);
}

async function setVoicePolicy(
  owner: Member,
  mode: "enabled" | "disabled",
): Promise<void> {
  const view = await readAccess(owner.organisationId, owner.session);
  const capability = (view.capabilities as unknown[]).find(
    (candidate) =>
      isRecord(candidate) &&
      isRecord(candidate.definition) &&
      candidate.definition.capabilityId === CAPABILITY_KEYS.voiceTranscription,
  );
  if (!isRecord(capability)) throw new Error("Capability missing in Access");
  const changed = await exports.default.fetch(
    `${accessControlPath(owner.organisationId)}/capabilities/${CAPABILITY_KEYS.voiceTranscription}`,
    {
      method: "POST",
      headers: mutationHeaders(owner.session),
      body: JSON.stringify({
        expectedRevision: view.revision,
        capabilityRevision: capability.revision,
        capabilityVersion: 1,
        mode,
      }),
    },
  );
  expect(changed.status, await changed.clone().text()).toBe(200);
}

async function verifyGrant(
  grant: string,
  grantKey: string,
): Promise<Record<string, unknown>> {
  const [prefix, payload, signature] = grant.split(".");
  const decode = (text: string) =>
    Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
  const key = await crypto.subtle.importKey(
    "raw",
    decode(grantKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    decode(signature ?? ""),
    new TextEncoder().encode(`${prefix}.${payload}`),
  );
  expect(valid).toBe(true);
  return JSON.parse(new TextDecoder().decode(decode(payload ?? ""))) as Record<
    string,
    unknown
  >;
}

/**
 * Spoken confirmation (Plan 82 Phase 3): only the exact words confirm one
 * card, one time, for the member who holds the phrase.
 */
async function voiceConfirmationJourney(_test: TestContext): Promise<void> {
  const fixture = await installMemoryFixture();
  const owner = fixture.author;
  const other = fixture.reviewer;
  await setVoicePolicy(owner, "enabled");
  const conversationId = `conv_${crypto.randomUUID()}`;
  const target = { kind: "configuration_draft", id: "draft_voice" };
  const issue = async (member: Member) => {
    const issued = await post(member, voicePath(member, "confirmations"), {
      conversationId,
      target,
    });
    expect(issued.status, await issued.clone().text()).toBe(200);
    return (await issued.json()) as { phrase: string };
  };
  const check = async (
    member: Member,
    transcript: string,
  ): Promise<Record<string, unknown>> => {
    const checked = await post(
      member,
      voicePath(member, "confirmations/check"),
      {
        conversationId,
        transcript,
        transcriptionPath: "shop_mac",
        transcriptionEngine: "whisper-large-v3-turbo",
      },
    );
    expect(checked.status, await checked.clone().text()).toBe(200);
    return json(checked);
  };

  const { phrase } = await issue(owner);
  expect(phrase).toMatch(
    /^confirm change (three|five|six|seven|nine)( (three|five|six|seven|nine)){2}$/u,
  );
  expect((await issue(owner)).phrase).toBe(phrase);

  // Whisper's other ways to write the same words are the same phrase. These
  // near misses, in the bench's four kinds, are not.
  const words = phrase.split(" ");
  const digit = (word: string) =>
    ({ three: "3", five: "5", six: "6", seven: "7", nine: "9" })[word];
  const otherDigit = words[4] === "nine" ? "three" : "nine";
  for (const nearMiss of [
    `do not ${phrase}`,
    `hold change ${words.slice(2).join(" ")}`,
    `confirm change ${words[2]} ${words[3]} ${otherDigit}`,
    `confirm change ${words[2]} ${words[4]}`,
  ])
    expect(await check(owner, nearMiss)).toEqual({ outcome: "refused" });
  const written = `Confirm change, ${digit(words[2] ?? "")}${digit(words[3] ?? "")}${digit(words[4] ?? "")}.`;
  expect(await check(owner, written)).toEqual({ outcome: "matched", target });
  expect(await check(owner, written)).toEqual({ outcome: "refused" });
  const read = await exports.default.fetch(
    `https://localhost${voicePath(owner, `confirmations?conversationId=${conversationId}`)}`,
    { headers: mutationHeaders(owner.session) },
  );
  expect(await read.json()).toMatchObject({
    receipts: [
      {
        target,
        phrase,
        transcriptionPath: "shop_mac",
        transcriptionEngine: "whisper-large-v3-turbo",
      },
    ],
  });

  // Five refusals spend a phrase, so a guess cannot go on against one phrase.
  const again = { kind: "slack_draft", id: "draft_spent" };
  const issueAgain = async () => {
    const issued = await post(owner, voicePath(owner, "confirmations"), {
      conversationId,
      target: again,
    });
    return ((await issued.json()) as { phrase: string }).phrase;
  };
  const first = await issueAgain();
  // Another member's phrase is theirs alone.
  const otherPhrase = await issue(other);
  expect(await check(owner, otherPhrase.phrase)).toEqual({
    outcome: "refused",
  });

  for (let attempt = 0; attempt < 4; attempt += 1)
    await check(owner, "send message");
  expect(await check(owner, first)).toEqual({ outcome: "refused" });

  // The off switch also stops a spoken confirmation.
  await setVoicePolicy(owner, "disabled");
  await expectError(
    post(owner, voicePath(owner, "confirmations/check"), {
      conversationId,
      transcript: phrase,
      transcriptionPath: "workers_ai",
    }),
    403,
    "voice_disabled",
  );
}

async function voiceControlJourney(_test: TestContext): Promise<void> {
  const fixture = await installMemoryFixture();
  const owner = fixture.author;
  const modelRequests: Record<string, unknown>[] = [];
  let hold: PromiseWithResolvers<void> | null = null;
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async function replyToModel({ request }) {
        modelRequests.push((await request.json()) as Record<string, unknown>);
        await hold?.promise;
        return openRouterText(
          JSON.stringify({ kind: "reply", text: ANSWER }),
          "completion_voice",
        );
      },
    ),
  );
  await setVoicePolicy(owner, "enabled");

  // 1. A manager starts the enrollment. A viewer cannot.
  await expectError(
    post(fixture.viewer, voicePath(fixture.viewer, "macs"), {}),
    404,
    "organisation_role_insufficient",
  );
  const started = await post(owner, voicePath(owner, "macs"), {});
  expect(started.status, await started.clone().text()).toBe(201);
  const enrollment = await json(started);
  const macId = String(enrollment.macId);

  // 2. The code works one time, and only the right code works.
  const attempt = {
    organisationId: owner.organisationId,
    macId,
    code: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
  };
  await expectError(
    voiceMacRequest(null, "enroll", "POST", attempt),
    401,
    "voice_mac_refused",
  );
  const enrolled = await voiceMacRequest(null, "enroll", "POST", {
    ...attempt,
    code: enrollment.code,
  });
  expect(enrolled.status, await enrolled.clone().text()).toBe(200);
  const mac = await json(enrolled);
  const credential = String(mac.credential);
  const hostname = String(mac.hostname);
  expect(hostname).toMatch(
    new RegExp(`^[a-f0-9]{12}\\.voice\\.${ZONE_NAME}$`, "u"),
  );
  await expectError(
    voiceMacRequest(null, "enroll", "POST", {
      ...attempt,
      code: enrollment.code,
    }),
    401,
    "voice_mac_refused",
  );

  // 3. A shop with no heartbeat has no Mac that answers: the device falls back.
  const before = await post(owner, voicePath(owner, "grants"), {
    deviceId: DEVICE,
  });
  expect(await json(before)).toEqual({ mac: null });

  // 4. The credential cannot place a public address under a Pantry name.
  await expectError(
    heartbeat(credential, "93.184.216.34"),
    400,
    "voice_mac_address_refused",
  );
  expect(records).toEqual([]);
  expect((await heartbeat(credential, "192.168.1.20")).status).toBe(200);
  expect(records).toMatchObject([
    {
      type: "A",
      name: hostname,
      content: "192.168.1.20",
      ttl: 60,
      proxied: false,
    },
  ]);
  // A Mac from before Plan 82C reports no engine. It runs Whisper.
  const listed = await json(
    await exports.default.fetch(
      `https://localhost${voicePath(owner, "macs")}`,
      {
        headers: mutationHeaders(owner.session),
      },
    ),
  );
  expect(listed.macs).toMatchObject([
    { macId, engine: "whisper-large-v3-turbo" },
  ]);
  // A new address moves the same record.
  expect((await heartbeat(credential, "192.168.1.31")).status).toBe(200);
  expect(records.filter((record) => record.type === "A")).toMatchObject([
    { content: "192.168.1.31" },
  ]);
  await engineChoiceSteps(fixture, macId, credential);

  // 5. The certificate challenge is one TXT record that the Mac can remove.
  const value = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  expect(
    (
      await voiceMacRequest(credential, "certificate-challenge", "PUT", {
        value,
      })
    ).status,
  ).toBe(200);
  expect(
    records.filter((record) => record.name === `_acme-challenge.${hostname}`),
  ).toMatchObject([{ type: "TXT", content: `"${value}"` }]);
  expect(
    (await voiceMacRequest(credential, "certificate-challenge", "DELETE"))
      .status,
  ).toBe(200);
  expect(records.filter((record) => record.type === "TXT")).toEqual([]);

  // 6. The Mac can check the grant with its own key, and only for this member.
  await expectError(
    post(fixture.viewer, voicePath(fixture.viewer, "grants"), {
      deviceId: DEVICE,
    }),
    404,
    "organisation_role_insufficient",
  );
  // The names of the Portal's text check go to members who may use voice.
  await expectError(
    exports.default.fetch(
      `https://localhost${voicePath(fixture.viewer, "vocabulary")}`,
      { headers: mutationHeaders(fixture.viewer.session) },
    ),
    404,
    "organisation_role_insufficient",
  );
  // This shop has no Commerce merchant yet. The Mac and the Portal still get
  // the agent's names, so the Mac does not ask again at each heartbeat.
  const macVocabulary = await voiceMacRequest(credential, "vocabulary", "GET");
  expect(macVocabulary.status, await macVocabulary.clone().text()).toBe(200);
  expect(await json(macVocabulary)).toEqual({ terms: ["Sous Chef", "Pantry"] });
  const portalVocabulary = await exports.default.fetch(
    `https://localhost${voicePath(owner, "vocabulary")}`,
    { headers: mutationHeaders(owner.session) },
  );
  expect(await json(portalVocabulary)).toEqual({
    terms: ["Sous Chef", "Pantry"],
  });
  const granted = await json(
    await post(owner, voicePath(owner, "grants"), { deviceId: DEVICE }),
  );
  if (!isRecord(granted.mac)) throw new Error("No Mac in the grant");
  expect(granted.mac.origin).toBe(`https://${hostname}`);
  const claims = await verifyGrant(
    String(granted.mac.grant),
    String(mac.grantKey),
  );
  expect(claims).toMatchObject({
    organisationId: owner.organisationId,
    userId: owner.userId,
    deviceId: DEVICE,
    macId,
  });
  // The grant and the Mac's credential have no authority at the Platform.
  for (const token of [String(granted.mac.grant), credential])
    expect(
      (
        await exports.default.fetch(
          `https://localhost${voicePath(owner, "macs")}`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        )
      ).status,
    ).toBe(401);

  // 7. The fallback: exact audio to Whisper in English, and no bad audio.
  const audio = wav(3);
  const heard = await sendAudio(owner, audio);
  expect(heard.status, await heard.clone().text()).toBe(200);
  expect(await json(heard)).toEqual({ text: SPOKEN, audioSeconds: 3 });
  expect(ai.calls).toHaveLength(1);
  expect(ai.calls[0]).toMatchObject({ language: "en", vad_filter: true });
  expect(
    Uint8Array.from(atob(ai.calls[0]?.audio ?? ""), (c) => c.charCodeAt(0)),
  ).toEqual(audio);
  await expectError(sendAudio(owner, wav(15.5)), 413, "too_long");
  await expectError(
    sendAudio(owner, new TextEncoder().encode("not audio at all".repeat(4))),
    400,
    "voice_audio_invalid",
  );
  expect(ai.calls).toHaveLength(1);

  // 8. Workers AI fails: a typed refusal, and the member's next call still runs.
  ai.answer = () => Promise.reject(new Error("provider down"));
  await expectError(sendAudio(owner, wav(1)), 503, "transcription_unavailable");
  ai.answer = () => Promise.resolve({ text: SPOKEN });
  expect((await sendAudio(owner, wav(1))).status).toBe(200);

  // 9. One request at a time on one device. Another device is not held.
  const release = Promise.withResolvers<Readonly<{ text: string }>>();
  ai.answer = () => release.promise;
  const held = sendAudio(owner, wav(1));
  await expect.poll(() => ai.calls.length).toBe(4);
  await expectError(sendAudio(owner, wav(1)), 429, "rate_limited");
  ai.answer = () => Promise.resolve({ text: SPOKEN });
  expect(
    (await sendAudio(owner, wav(1), "device_baker_phone_0002")).status,
  ).toBe(200);
  release.resolve({ text: SPOKEN });
  expect((await held).status).toBe(200);

  // 10. Each billed second is recorded, with no audio and no transcript.
  const database = (
    await requireOrganisationExecutionScope(env, owner.organisationId)
  ).database;
  const usage = await database
    .prepare(
      `SELECT count(*) AS calls, sum(audio_milliseconds) AS billed
         FROM voice_transcription_use WHERE organisation_id = ?`,
    )
    .bind(owner.organisationId)
    .first<{ calls: number; billed: number }>();
  expect(usage).toEqual({ calls: 5, billed: 6000 });

  // 11. The sixty-first command in ten minutes is refused before Workers AI.
  for (let sent = usage?.calls ?? 0; sent < VOICE_REQUEST_LIMIT; sent += 1)
    expect((await sendAudio(owner, wav(0.1))).status).toBe(200);
  const calls = ai.calls.length;
  await expectError(sendAudio(owner, wav(1)), 429, "rate_limited");
  expect(ai.calls).toHaveLength(calls);

  // 12. The transcript enters the chat as one spoken command.
  const conversationId = newConversationId();
  await createConversation(owner, conversationId, fixture.route);
  const chatPath = controlPaths(owner.organisationId).chat;
  const command = (requestId: string, inputMode?: unknown) => ({
    kind: "message",
    conversationId,
    requestId,
    model: fixture.route.model,
    text: SPOKEN,
    browserContext: {
      kind: "available",
      binding: { browserInstanceId: "browser_voice_e2e", conversationId },
    },
    ...(inputMode === undefined ? {} : { inputMode }),
  });
  await expectError(
    post(
      owner,
      chatPath,
      command("request_bad_mode", {
        kind: "voice",
        transcriptionPath: "guess",
      }),
    ),
    422,
    "chat_message_invalid",
  );
  const spoken = await post(
    owner,
    chatPath,
    command("request_voice_command", {
      kind: "voice",
      transcriptionPath: "workers_ai",
      transcriptionEngine: "whisper-large-v3-turbo",
    }),
  );
  expect(spoken.status, await spoken.clone().text()).toBe(200);
  await expect
    .poll(() => workKind(owner, conversationId), { timeout: 60_000 })
    .toBe("ready");
  expect(modelRequests).toHaveLength(1);
  expect(JSON.stringify(modelRequests[0])).toContain(SPOKEN);
  const stored = await storedConversation(owner, conversationId);
  const users = (stored?.conversation.timeline ?? []).filter(
    (event) => event.kind === "user",
  );
  expect(users).toHaveLength(1);
  expect(users[0]).toMatchObject({
    text: SPOKEN,
    parts: expect.arrayContaining([
      {
        kind: "voice",
        transcriptionPath: "workers_ai",
        transcriptionEngine: "whisper-large-v3-turbo",
      },
    ]),
  });

  // 13. The off switch: the grant stays valid at the Mac, and nothing else runs.
  await setVoicePolicy(owner, "disabled");
  const aiCalls = ai.calls.length;
  await expectError(
    post(owner, voicePath(owner, "grants"), { deviceId: DEVICE }),
    403,
    "voice_disabled",
  );
  await expectError(sendAudio(owner, wav(1)), 403, "voice_disabled");
  expect(ai.calls).toHaveLength(aiCalls);
  await expectError(
    post(
      owner,
      chatPath,
      command("request_after_off", {
        kind: "voice",
        transcriptionPath: "shop_mac",
      }),
    ),
    403,
    "voice_disabled",
  );
  expect(modelRequests).toHaveLength(1);
  const afterOff = await storedConversation(owner, conversationId);
  expect(
    (afterOff?.conversation.timeline ?? []).filter(
      (event) => event.kind === "user",
    ),
  ).toHaveLength(1);

  // 14. Typed text does not depend on the voice capability.
  const typed = await post(owner, chatPath, command("request_typed"));
  expect(typed.status, await typed.clone().text()).toBe(200);
  await expect
    .poll(() => workKind(owner, conversationId), { timeout: 60_000 })
    .toBe("ready");
  expect(modelRequests).toHaveLength(2);

  // A spoken command that arrives during a turn keeps its mark in the chat.
  await setVoicePolicy(owner, "enabled");
  hold = Promise.withResolvers<void>();
  const running = await post(owner, chatPath, command("request_running"));
  expect(running.status, await running.clone().text()).toBe(200);
  await expect.poll(() => modelRequests.length).toBe(3);
  const next = await post(owner, chatPath, {
    ...command("request_spoken_next", {
      kind: "voice",
      transcriptionPath: "shop_mac",
    }),
    kind: "next",
    inputId: "input_spoken_next",
    text: "Then check the butter.",
  });
  expect(next.status, await next.clone().text()).toBe(200);
  hold.resolve();
  hold = null;
  await expect
    .poll(() => workKind(owner, conversationId), { timeout: 60_000 })
    .toBe("ready");
  const withNext = await storedConversation(owner, conversationId);
  const spokenNext = (withNext?.conversation.timeline ?? []).filter(
    (event) => event.kind === "user" && event.text === "Then check the butter.",
  );
  expect(spokenNext).toHaveLength(1);
  expect(spokenNext[0]).toMatchObject({
    parts: expect.arrayContaining([
      { kind: "voice", transcriptionPath: "shop_mac" },
    ]),
  });

  // 15. Revocation removes the Mac's names and stops its credential.
  const revoked = await post(
    owner,
    voicePath(owner, `macs/${macId}/revoke`),
    {},
  );
  expect(await json(revoked)).toEqual({ ok: true, dnsRemoved: true });
  expect(records).toEqual([]);
  await expectError(
    heartbeat(credential, "192.168.1.20"),
    401,
    "voice_mac_refused",
  );
  await expectError(
    voiceMacRequest(credential, "vocabulary", "GET"),
    401,
    "voice_mac_refused",
  );
  expect(
    await json(
      await post(owner, voicePath(owner, "grants"), { deviceId: DEVICE }),
    ),
  ).toEqual({ mac: null });
}

/**
 * The vocabulary holds the names that a baker says and every member may read:
 * the menu, the recipes, the stock items and the confirmed devices. The Mac,
 * the fallback and the Portal's text check read the same list, and the
 * fallback's engine rule drops the segments that Whisper invents on noise, as
 * the Mac's does. The Portal journey (`scripts/shop-voice/portal-browser.cjs`)
 * proves that the text check drops the names read back (Plan 82C D1).
 */
it(
  "gives the Mac, the fallback and the Portal the same shop names, and drops noise on the fallback",
  vocabularyJourney,
  180_000,
);

/**
 * An Organisation ends with DNS down. Its Mac stops at once, and the purge waits
 * for the names, because it deletes the only rows that name them.
 */
async function organisationEndJourney(_test: TestContext): Promise<void> {
  const fixture = await installMemoryFixture();
  const owner = fixture.author;
  await setVoicePolicy(owner, "enabled");
  const started = await json(await post(owner, voicePath(owner, "macs"), {}));
  const enrolled = await json(
    await voiceMacRequest(null, "enroll", "POST", {
      organisationId: owner.organisationId,
      macId: started.macId,
      code: started.code,
    }),
  );
  const credential = String(enrolled.credential);
  expect((await heartbeat(credential, "192.168.1.20")).status).toBe(200);
  expect(records).toHaveLength(1);
  const spoken = await sendAudio(owner, wav(2));
  expect(spoken.status, await spoken.clone().text()).toBe(200);
  const voiceRows = async () => {
    const counts = await Promise.all(
      ["voice_mac", "voice_transcription_use"].map((table) =>
        fixtureDatabase()
          .prepare(
            `SELECT COUNT(*) AS count FROM ${table} WHERE organisation_id = ?`,
          )
          .bind(owner.organisationId)
          .first<number>("count"),
      ),
    );
    return counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
  };
  const rowsBefore = await voiceRows();
  expect(rowsBefore).toBeGreaterThanOrEqual(2);
  const cleanupStatus = () =>
    fixtureDatabase()
      .prepare(
        "SELECT status FROM organisation_archive_cleanup WHERE organisation_id = ?",
      )
      .bind(owner.organisationId)
      .first<string>("status");
  const mutation = async (operation: "archive" | "delete") => {
    const version = await fixtureDatabase()
      .prepare(
        "SELECT configuration_version FROM organisation_onboarding WHERE organisation_id = ?",
      )
      .bind(owner.organisationId)
      .first<number>("configuration_version");
    if (version === null) throw new Error("Missing configuration version");
    return {
      boundary: {
        kind: "configuration_versioned" as const,
        idempotencyKey: `voice-end-${operation}`,
        requestHash: `voice-end-${operation}-request`,
        expectedConfigurationVersion: version,
      },
      scope: {
        userId: owner.userId,
        organisationScope: owner.organisationId,
        route: `/v1/control/organisations/${owner.organisationId}${operation === "archive" ? "/archive" : ""}`,
        operation: `organisation.${operation}`,
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "voice-end-owner",
        causationId: `voice-end-${operation}`,
        now: Date.now(),
      }),
    };
  };

  // 1. The owner archives the Organisation while DNS is down. The Mac stops anyway.
  dnsDown = true;
  const archived = await archiveOrganisation({
    identityDatabase: env.DB,
    execution: await requireOrganisationExecutionScope(
      env,
      owner.organisationId,
    ),
    actorUserId: owner.userId,
    authority: { kind: "organisation_owner" },
    reasonCode: "merchant_archived",
    now: Date.now(),
    mutation: await mutation("archive"),
  });
  if (!archived.ok) throw new Error(archived.error.code);
  await runScheduledOnboardingReconciliation(env, Date.now());
  expect(await cleanupStatus()).toBe("pending_purge");
  expect((await heartbeat(credential, "192.168.1.21")).status).toBe(401);
  expect(records).toHaveLength(1);

  // 2. The purge cannot remove the name, so it keeps the rows that name it.
  const deleted = await deleteArchivedOrganisation({
    directory: env.DB,
    execution: await requireOrganisationExecutionScope(
      env,
      owner.organisationId,
    ),
    actorUserId: owner.userId,
    now: Date.now(),
    mutation: await mutation("delete"),
  });
  if (!deleted.ok) throw new Error(deleted.error.code);
  const blockedAt = Date.now() + 1_000;
  await runScheduledOnboardingReconciliation(env, blockedAt);
  expect(await cleanupStatus()).toBe("pending_purge");
  expect(await voiceRows()).toBe(rowsBefore);
  expect(records).toHaveLength(1);

  // 3. DNS returns. The next run removes the name and purges the voice rows.
  dnsDown = false;
  await runScheduledOnboardingReconciliation(env, blockedAt + 15 * 60_000);
  expect(records).toEqual([]);
  expect(await cleanupStatus()).toBe("purged");
  expect(await voiceRows()).toBe(0);
}

async function vocabularyJourney(): Promise<void> {
  const owner = await commerceClient(`voice-owner-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Voice café");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_voice_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  const admin = new CommerceAdminClient({
    baseUrl: "http://commerce.test",
    serviceToken: "commerce-e2e-token",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  const provisioned = await admin.provisionDemo({
    schemaVersion: "commerce.provision-demo.v2",
    externalReference: organisationId,
    merchantId,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  if (!provisioned.ok) throw new Error("The demo merchant was not provisioned");
  await activateOrganisation(organisationId);
  // A gateway finds two devices. A person confirms one, and the other waits.
  const gatewayStart = await startGateway(
    organisationId,
    owner.session,
    "Bakery gateway",
  );
  const gateway = await connectGateway(
    await credentialOf(
      await enrollGateway(
        organisationId,
        gatewayStart.gatewayId,
        gatewayStart.code,
      ),
    ),
  );
  await helloAndWait(gateway, [
    found("oven-2", "Deck oven 2"),
    found("proofer-1", "Retarder proofer"),
  ]);
  const oven = requireKitchenDevice(
    await readDeviceList(organisationId, owner.session),
    "Deck oven 2",
  );
  const confirmed = await send(
    `${controlBase(organisationId)}/devices/${oven.deviceId}/confirm`,
    owner.session,
    "POST",
    { name: "Deck oven 2", stationId: "station_bakery" },
  );
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  await gateway.close();
  const member = {
    organisationId,
    session: owner.session,
  } as unknown as Member;
  const start = await post(member, voicePath(member, "macs"), {});
  expect(start.status, await start.clone().text()).toBe(201);
  const started = await json(start);
  const enroll = await voiceMacRequest(null, "enroll", "POST", {
    organisationId,
    macId: started.macId,
    code: started.code,
  });
  expect(enroll.status, await enroll.clone().text()).toBe(200);
  const enrolled = await json(enroll);
  const read = await voiceMacRequest(
    String(enrolled.credential),
    "vocabulary",
    "GET",
  );
  expect(read.status, await read.clone().text()).toBe(200);
  const { terms } = await json(read);
  if (!Array.isArray(terms)) throw new Error("No terms");
  expect(terms.length).toBeLessThanOrEqual(60);
  expect(terms[0]).toBe("Sous Chef");
  // A menu item, a recipe, a stock item and the confirmed device.
  expect(terms).toEqual(
    expect.arrayContaining([
      "Taro Milk Tea",
      "Ginger cookie batch",
      "Glutinous rice flour",
      "Deck oven 2",
    ]),
  );
  expect(terms).not.toContain("Retarder proofer");
  expect(
    new Set(terms.map((term) => term.toLowerCase())).size,
    "one term for each name",
  ).toBe(terms.length);
  const portalRead = await exports.default.fetch(
    `https://localhost${voicePath(member, "vocabulary")}`,
    { headers: mutationHeaders(owner.session) },
  );
  expect(portalRead.status, await portalRead.clone().text()).toBe(200);
  expect(await json(portalRead)).toEqual({ terms });
  ai.answer = () => Promise.resolve({ text: SPOKEN });
  const heard = await sendAudio(member, wav(1));
  expect(heard.status, await heard.clone().text()).toBe(200);
  expect(ai.calls[0]?.initial_prompt).toBe(terms.join(", "));

  // Whisper returns the command and words that it invented on the noise after
  // it. Only the command reaches the person.
  ai.answer = () =>
    Promise.resolve({
      text: ` ${SPOKEN} Matcha Tea, Matcha Tea.`,
      segments: [
        { text: ` ${SPOKEN}`, avg_logprob: -0.21, compression_ratio: 0.9 },
        {
          text: " Matcha Tea, Matcha Tea.",
          avg_logprob: -1.83,
          compression_ratio: 1.2,
        },
      ],
    });
  const mixed = await sendAudio(member, wav(4));
  expect(mixed.status, await mixed.clone().text()).toBe(200);
  expect((await json(mixed)).text).toBe(SPOKEN);

  // Noise alone gives an empty text, so the Portal sends nothing.
  ai.answer = () =>
    Promise.resolve({
      text: " Black sesame, black sesame, black sesame, black sesame.",
      segments: [
        {
          text: " Black sesame, black sesame, black sesame, black sesame.",
          avg_logprob: -0.62,
          compression_ratio: 3.4,
        },
      ],
    });
  const noise = await sendAudio(member, wav(6));
  expect(noise.status, await noise.clone().text()).toBe(200);
  expect((await json(noise)).text).toBe("");
}

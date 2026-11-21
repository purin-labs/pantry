import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { VOICE_VOCABULARY_LIMITS, voiceEngineIdSchema } from "./voice-engines.ts";

/**
 * Portal voice control (Plan 82): the shapes of the grant and fallback routes
 * that the Portal calls, of the Mac enrollment that a member manages, and of
 * the routes that the shop Mac calls with its own credential.
 */

/** A command holds at most this much audio, as 16-bit PCM at 16 kHz in mono. */
export const VOICE_AUDIO_SECONDS_LIMIT = 15;
/** One member sends at most this many commands in one window. */
export const VOICE_REQUEST_LIMIT = 60;
export const VOICE_REQUEST_WINDOW_MS = 10 * 60_000;
/** The smallest term limit of the speech engines (`voice-engines.ts`). */
export const VOICE_VOCABULARY_TERM_LIMIT = VOICE_VOCABULARY_LIMITS.terms;
export const VOICE_GRANT_TTL_MS = 10 * 60_000;
/** The request header that names the member's device on a fallback call. */
export const VOICE_DEVICE_HEADER = "x-pantry-voice-device";

const strict = { additionalProperties: false } as const;
const timestamp = Type.Integer({ minimum: 0 });
const deviceId = Type.String({ pattern: "^[A-Za-z0-9_-]{16,64}$" });
const macId = Type.String({ pattern: "^vmac_[a-f0-9]{24}$" });
const shortText = Type.String({ minLength: 1, maxLength: 64 });

export const chatTranscriptionPathSchema = Type.Union([
  Type.Literal("shop_mac"),
  Type.Literal("workers_ai"),
]);
export type ChatTranscriptionPath = Static<typeof chatTranscriptionPathSchema>;

export const isChatTranscriptionPath = (
  raw: unknown,
): raw is ChatTranscriptionPath =>
  Value.Check(chatTranscriptionPathSchema, raw);

/**
 * A spoken command's mark on a chat message. A typed message has none. A
 * message from before Plan 82C has no engine.
 */
export const chatInputModeSchema = Type.Object(
  {
    kind: Type.Literal("voice"),
    transcriptionPath: chatTranscriptionPathSchema,
    transcriptionEngine: Type.Optional(voiceEngineIdSchema),
  },
  strict,
);
export type ChatInputMode = Static<typeof chatInputModeSchema>;

export type VoiceRefusalCode =
  "voice_disabled" | "too_long" | "rate_limited" | "transcription_unavailable";

export const voiceGrantRequestSchema = Type.Object({ deviceId }, strict);
export type VoiceGrantRequest = Static<typeof voiceGrantRequestSchema>;

/** `mac` is null when the shop has no Mac that answers: use the fallback. */
export const voiceGrantSchema = Type.Object(
  {
    mac: Type.Union([
      Type.Null(),
      Type.Object(
        {
          macId,
          origin: Type.String({ minLength: 1, maxLength: 300 }),
          grant: Type.String({ minLength: 1, maxLength: 2000 }),
          expiresAt: timestamp,
        },
        strict,
      ),
    ]),
  },
  strict,
);
export type VoiceGrant = Static<typeof voiceGrantSchema>;

/** A Mac from before Plan 82C and the fallback name no engine. */
export const voiceTranscriptionSchema = Type.Object(
  {
    text: Type.String({ maxLength: 8000 }),
    audioSeconds: Type.Number({ minimum: 0 }),
    engine: Type.Optional(voiceEngineIdSchema),
  },
  strict,
);
export type VoiceTranscription = Static<typeof voiceTranscriptionSchema>;

/** What the signed grant tells the Mac. It has no authority at the Platform. */
export type VoiceGrantClaims = Readonly<{
  version: 1;
  organisationId: string;
  userId: string;
  deviceId: string;
  macId: string;
  expiresAt: number;
}>;

export const voiceMacModelStateSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("downloading"),
  Type.Literal("unloaded"),
  Type.Literal("loading"),
  Type.Literal("loaded"),
]);

export const voiceMacViewSchema = Type.Object(
  {
    macId,
    hostname: Type.String({ minLength: 1, maxLength: 253 }),
    state: Type.Union([
      Type.Literal("pending"),
      Type.Literal("enrolled"),
      Type.Literal("revoked"),
    ]),
    createdAt: timestamp,
    lastHeartbeatAt: Type.Union([Type.Null(), timestamp]),
    privateAddress: Type.Union([Type.Null(), shortText]),
    serviceVersion: Type.Union([Type.Null(), shortText]),
    modelState: Type.Union([Type.Null(), voiceMacModelStateSchema]),
    /** The engine that the Mac runs now. */
    engine: Type.Union([Type.Null(), voiceEngineIdSchema]),
    /** The engines that the Mac's service can run. A manager chooses one of them. */
    engines: Type.Array(voiceEngineIdSchema),
    /**
     * The engine that a manager chose (Plan 82C D2). While it is not `engine`,
     * the Mac downloads its files and then changes engine.
     */
    engineChoice: voiceEngineIdSchema,
  },
  strict,
);
export type VoiceMacView = Static<typeof voiceMacViewSchema>;

/** A manager's choice of a Mac's engine. */
export const voiceMacEngineChoiceSchema = Type.Object(
  { engine: voiceEngineIdSchema },
  strict,
);
export type VoiceMacEngineChoice = Static<typeof voiceMacEngineChoiceSchema>;

export const voiceMacListSchema = Type.Object(
  { macs: Type.Array(voiceMacViewSchema) },
  strict,
);
export type VoiceMacList = Static<typeof voiceMacListSchema>;

/** The one-time code appears here once. The Platform keeps only its digest. */
export const voiceMacEnrollmentStartSchema = Type.Object(
  {
    organisationId: shortText,
    macId,
    code: Type.String({ pattern: "^[A-Za-z0-9_-]{32,64}$" }),
    expiresAt: timestamp,
  },
  strict,
);
export type VoiceMacEnrollmentStart = Static<
  typeof voiceMacEnrollmentStartSchema
>;

export const voiceMacEnrollRequestSchema = Type.Object(
  {
    organisationId: shortText,
    macId,
    code: Type.String({ pattern: "^[A-Za-z0-9_-]{32,64}$" }),
  },
  strict,
);
export type VoiceMacEnrollRequest = Static<typeof voiceMacEnrollRequestSchema>;

/** The credential and the grant key appear here once, for the Mac alone. */
export const voiceMacEnrollResponseSchema = Type.Object(
  {
    credential: Type.String({ minLength: 1, maxLength: 400 }),
    grantKey: Type.String({ minLength: 1, maxLength: 100 }),
    hostname: Type.String({ minLength: 1, maxLength: 253 }),
  },
  strict,
);
export type VoiceMacEnrollResponse = Static<
  typeof voiceMacEnrollResponseSchema
>;

export const voiceMacHeartbeatSchema = Type.Object(
  {
    privateAddress: Type.String({ minLength: 7, maxLength: 15 }),
    serviceVersion: shortText,
    modelState: voiceMacModelStateSchema,
    /** A service from before Plan 82C reports none, and it runs Whisper. */
    engine: Type.Optional(voiceEngineIdSchema),
    /**
     * The engines that the service can run. A service from before Plan 82C
     * Phase 2 reports none, and it runs only its `engine`.
     */
    engines: Type.Optional(
      Type.Array(voiceEngineIdSchema, {
        minItems: 1,
        maxItems: 8,
        uniqueItems: true,
      }),
    ),
  },
  strict,
);
export type VoiceMacHeartbeat = Static<typeof voiceMacHeartbeatSchema>;

/**
 * The Platform's answer to a heartbeat. The Mac changes to `engineChoice`
 * after it has the engine's files. The Platform never calls the Mac.
 */
export const voiceMacHeartbeatAnswerSchema = Type.Object(
  {
    ok: Type.Literal(true),
    hostname: Type.String({ minLength: 1, maxLength: 253 }),
    engineChoice: voiceEngineIdSchema,
  },
  strict,
);
export type VoiceMacHeartbeatAnswer = Static<
  typeof voiceMacHeartbeatAnswerSchema
>;

/**
 * The shop vocabulary. The Mac reads it for its engine's prompt, and the
 * Portal reads it for the text check (`voice-text-check.ts`).
 */
export const voiceVocabularySchema = Type.Object(
  {
    terms: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
      maxItems: VOICE_VOCABULARY_TERM_LIMIT,
    }),
  },
  strict,
);
export type VoiceVocabulary = Static<typeof voiceVocabularySchema>;

/** The DNS-01 value that the certificate authority asks for. */
export const voiceMacChallengeSchema = Type.Object(
  { value: Type.String({ pattern: "^[A-Za-z0-9_-]{32,128}$" }) },
  strict,
);
export type VoiceMacChallenge = Static<typeof voiceMacChallengeSchema>;

/** The shop Mac's answer to the Portal's check. It also starts the model load. */
export const voiceMacHealthSchema = Type.Object(
  {
    ok: Type.Literal(true),
    modelState: voiceMacModelStateSchema,
    busy: Type.Boolean(),
    serviceVersion: shortText,
    /** A service from before Plan 82C reports none, and it runs Whisper. */
    engine: Type.Optional(voiceEngineIdSchema),
  },
  strict,
);
export type VoiceMacHealth = Static<typeof voiceMacHealthSchema>;

/**
 * The shop Mac's refusal. On `busy` and `model_not_ready`, the Portal uses the
 * fallback at once (Plan 82 D1b). A success has `voiceTranscriptionSchema`.
 */
export const voiceMacRefusalSchema = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.Union([
      Type.Literal("origin_refused"),
      Type.Literal("grant_refused"),
      Type.Literal("rate_limited"),
      Type.Literal("too_long"),
      Type.Literal("audio_invalid"),
      Type.Literal("speech_invalid"),
      Type.Literal("busy"),
      Type.Literal("model_not_ready"),
      Type.Literal("not_found"),
    ]),
  },
  strict,
);
export type VoiceMacRefusal = Static<typeof voiceMacRefusalSchema>;

/** The approval cards that a phrase can confirm, as a click on the card does. */
export const voiceConfirmationTargetSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("configuration_draft"),
      Type.Literal("slack_draft"),
      Type.Literal("email_draft"),
    ]),
    id: Type.String({ minLength: 1, maxLength: 200 }),
  },
  strict,
);
export type VoiceConfirmationTarget = Static<
  typeof voiceConfirmationTargetSchema
>;

const conversationId = Type.String({ minLength: 1, maxLength: 200 });

export const voiceConfirmationRequestSchema = Type.Object(
  { conversationId, target: voiceConfirmationTargetSchema },
  strict,
);
export type VoiceConfirmationRequest = Static<
  typeof voiceConfirmationRequestSchema
>;

export const voiceConfirmationSchema = Type.Object(
  {
    confirmationId: shortText,
    phrase: Type.String({ minLength: 1, maxLength: 100 }),
    expiresAt: timestamp,
  },
  strict,
);
export type VoiceConfirmation = Static<typeof voiceConfirmationSchema>;

export const voiceConfirmationCheckRequestSchema = Type.Object(
  {
    conversationId,
    transcript: Type.String({ maxLength: 8000 }),
    transcriptionPath: chatTranscriptionPathSchema,
    transcriptionEngine: Type.Optional(voiceEngineIdSchema),
  },
  strict,
);
export type VoiceConfirmationCheckRequest = Static<
  typeof voiceConfirmationCheckRequestSchema
>;

export const voiceConfirmationCheckSchema = Type.Union([
  Type.Object(
    {
      outcome: Type.Literal("matched"),
      target: voiceConfirmationTargetSchema,
    },
    strict,
  ),
  Type.Object({ outcome: Type.Literal("refused") }, strict),
]);
export type VoiceConfirmationCheck = Static<
  typeof voiceConfirmationCheckSchema
>;

/** The receipts of a chat: each phrase that confirmed a card, its path and its engine. */
export const voiceConfirmationReceiptsSchema = Type.Object(
  {
    receipts: Type.Array(
      Type.Object(
        {
          target: voiceConfirmationTargetSchema,
          phrase: Type.String({ minLength: 1, maxLength: 100 }),
          transcriptionPath: chatTranscriptionPathSchema,
          /** Null for a phrase that matched before Plan 82C. */
          transcriptionEngine: Type.Union([Type.Null(), voiceEngineIdSchema]),
          matchedAt: timestamp,
        },
        strict,
      ),
    ),
  },
  strict,
);
export type VoiceConfirmationReceipts = Static<
  typeof voiceConfirmationReceiptsSchema
>;

const DIGIT_WORDS: Readonly<Record<string, string>> = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/**
 * The words of a transcript for an exact match. Case, punctuation and the
 * spacing of digits never refuse: Whisper writes "three five nine" as "359".
 * Each other word must stay as it is.
 */
export function normalizeVoicePhrase(text: string): string {
  const words: string[] = [];
  for (const raw of text
    .toLowerCase()
    .replaceAll("-", " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/u)) {
    if (raw.length === 0) continue;
    const word = DIGIT_WORDS[raw] ?? raw;
    const last = words.at(-1);
    if (/^\d+$/u.test(word) && last !== undefined && /^\d+$/u.test(last))
      words[words.length - 1] = last + word;
    else words.push(word);
  }
  return words.join(" ");
}

function parseWith<S extends TSchema>(
  schema: S,
  raw: unknown,
): Static<S> | null {
  return Value.Check(schema, raw) ? (raw as Static<S>) : null;
}

export const parseChatInputMode = (raw: unknown) =>
  parseWith(chatInputModeSchema, raw);
export const parseVoiceGrantRequest = (raw: unknown) =>
  parseWith(voiceGrantRequestSchema, raw);
export const parseVoiceGrant = (raw: unknown) =>
  parseWith(voiceGrantSchema, raw);
export const parseVoiceTranscription = (raw: unknown) =>
  parseWith(voiceTranscriptionSchema, raw);
export const parseVoiceMacList = (raw: unknown) =>
  parseWith(voiceMacListSchema, raw);
export const parseVoiceMacEnrollmentStart = (raw: unknown) =>
  parseWith(voiceMacEnrollmentStartSchema, raw);
export const parseVoiceMacEnrollRequest = (raw: unknown) =>
  parseWith(voiceMacEnrollRequestSchema, raw);
export const parseVoiceMacEnrollResponse = (raw: unknown) =>
  parseWith(voiceMacEnrollResponseSchema, raw);
export const parseVoiceMacHeartbeat = (raw: unknown) =>
  parseWith(voiceMacHeartbeatSchema, raw);
export const parseVoiceMacHeartbeatAnswer = (raw: unknown) =>
  parseWith(voiceMacHeartbeatAnswerSchema, raw);
export const parseVoiceMacEngineChoice = (raw: unknown) =>
  parseWith(voiceMacEngineChoiceSchema, raw);
export const parseVoiceVocabulary = (raw: unknown) =>
  parseWith(voiceVocabularySchema, raw);
export const parseVoiceMacChallenge = (raw: unknown) =>
  parseWith(voiceMacChallengeSchema, raw);
export const parseVoiceMacHealth = (raw: unknown) =>
  parseWith(voiceMacHealthSchema, raw);
export const parseVoiceMacRefusal = (raw: unknown) =>
  parseWith(voiceMacRefusalSchema, raw);
export const parseVoiceConfirmationRequest = (raw: unknown) =>
  parseWith(voiceConfirmationRequestSchema, raw);
export const parseVoiceConfirmation = (raw: unknown) =>
  parseWith(voiceConfirmationSchema, raw);
export const parseVoiceConfirmationCheckRequest = (raw: unknown) =>
  parseWith(voiceConfirmationCheckRequestSchema, raw);
export const parseVoiceConfirmationCheck = (raw: unknown) =>
  parseWith(voiceConfirmationCheckSchema, raw);
export const parseVoiceConfirmationReceipts = (raw: unknown) =>
  parseWith(voiceConfirmationReceiptsSchema, raw);

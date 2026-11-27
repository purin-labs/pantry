import { Type, type Static, type TSchema } from "typebox";
import { NonNegativeInteger, textLimit } from "@purin-labs/contract-schema";
import { Value } from "typebox/value";

import {
  VOICE_VOCABULARY_LIMITS,
  voiceEngineIdSchema,
} from "./voice-engines.ts";

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
/**
 * A shop Mac counts as answering for this long after its last recorded
 * heartbeat. The Mac beats every 60 s, and the Platform records a beat that
 * changes nothing at most every five minutes, so this covers one recording
 * interval and three missed beats.
 */
export const VOICE_MAC_HEARTBEAT_FRESH_MS = 8 * 60_000;
/** The request header that names the member's device on a fallback call. */
export const VOICE_DEVICE_HEADER = "x-pantry-voice-device";

const strict = { additionalProperties: false } as const;
const timestamp = NonNegativeInteger;
const deviceId = Type.String({ pattern: "^[A-Za-z0-9_-]{16,64}$" });
const macId = Type.String({ pattern: "^vmac_[a-f0-9]{24}$" });
const shortText = textLimit(Type.String({ minLength: 1, maxLength: 64 }));

const chatTranscriptionPathSchema = Type.Union([
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
const chatInputModeSchema = Type.Object(
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

const voiceGrantRequestSchema = Type.Object({ deviceId }, strict);

/** `mac` is null when the shop has no Mac that answers: use the fallback. */
const voiceGrantSchema = Type.Object(
  {
    mac: Type.Union([
      Type.Null(),
      Type.Object(
        {
          macId,
          origin: textLimit(Type.String({ minLength: 1, maxLength: 300 })),
          grant: textLimit(Type.String({ minLength: 1, maxLength: 2000 })),
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
const voiceTranscriptionSchema = Type.Object(
  {
    text: textLimit(Type.String({ maxLength: 8000 })),
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

const voiceMacViewSchema = Type.Object(
  {
    macId,
    hostname: textLimit(Type.String({ minLength: 1, maxLength: 253 })),
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
const voiceMacEngineChoiceSchema = Type.Object(
  { engine: voiceEngineIdSchema },
  strict,
);

const voiceMacListSchema = Type.Object(
  { macs: Type.Array(voiceMacViewSchema) },
  strict,
);
export type VoiceMacList = Static<typeof voiceMacListSchema>;

/** The one-time code appears here once. The Platform keeps only its digest. */
const voiceMacEnrollmentStartSchema = Type.Object(
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

const voiceMacEnrollRequestSchema = Type.Object(
  {
    organisationId: shortText,
    macId,
    code: Type.String({ pattern: "^[A-Za-z0-9_-]{32,64}$" }),
  },
  strict,
);

/** The credential and the grant key appear here once, for the Mac alone. */
const voiceMacEnrollResponseSchema = Type.Object(
  {
    credential: textLimit(Type.String({ minLength: 1, maxLength: 400 })),
    grantKey: textLimit(Type.String({ minLength: 1, maxLength: 100 })),
    hostname: textLimit(Type.String({ minLength: 1, maxLength: 253 })),
  },
  strict,
);
export type VoiceMacEnrollResponse = Static<
  typeof voiceMacEnrollResponseSchema
>;

const voiceMacHeartbeatSchema = Type.Object(
  {
    privateAddress: textLimit(Type.String({ minLength: 7, maxLength: 15 })),
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
const voiceMacHeartbeatAnswerSchema = Type.Object(
  {
    ok: Type.Literal(true),
    hostname: textLimit(Type.String({ minLength: 1, maxLength: 253 })),
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
const voiceVocabularySchema = Type.Object(
  {
    terms: Type.Array(textLimit(Type.String({ minLength: 1, maxLength: 80 })), {
      maxItems: VOICE_VOCABULARY_TERM_LIMIT,
    }),
  },
  strict,
);
export type VoiceVocabulary = Static<typeof voiceVocabularySchema>;

/** The DNS-01 value that the certificate authority asks for. */
const voiceMacChallengeSchema = Type.Object(
  { value: Type.String({ pattern: "^[A-Za-z0-9_-]{32,128}$" }) },
  strict,
);

/** The shop Mac's answer to the Portal's check. It also starts the model load. */
const voiceMacHealthSchema = Type.Object(
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

/**
 * The shop Mac's refusal. On `busy` and `model_not_ready`, the Portal uses the
 * fallback at once (Plan 82 D1b). A success has `voiceTranscriptionSchema`.
 */
const voiceMacRefusalSchema = Type.Object(
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

/** The approval cards that a phrase can confirm, as a click on the card does. */
const voiceConfirmationTargetSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("configuration_draft"),
      Type.Literal("slack_draft"),
      Type.Literal("email_draft"),
    ]),
    id: textLimit(Type.String({ minLength: 1, maxLength: 200 })),
  },
  strict,
);
export type VoiceConfirmationTarget = Static<
  typeof voiceConfirmationTargetSchema
>;

const conversationId = textLimit(Type.String({ minLength: 1, maxLength: 200 }));

const voiceConfirmationRequestSchema = Type.Object(
  { conversationId, target: voiceConfirmationTargetSchema },
  strict,
);

const voiceConfirmationSchema = Type.Object(
  {
    confirmationId: shortText,
    phrase: textLimit(Type.String({ minLength: 1, maxLength: 100 })),
    expiresAt: timestamp,
  },
  strict,
);
export type VoiceConfirmation = Static<typeof voiceConfirmationSchema>;

const voiceConfirmationCheckRequestSchema = Type.Object(
  {
    conversationId,
    transcript: textLimit(Type.String({ maxLength: 8000 })),
    transcriptionPath: chatTranscriptionPathSchema,
    transcriptionEngine: Type.Optional(voiceEngineIdSchema),
  },
  strict,
);

const voiceConfirmationCheckSchema = Type.Union([
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
const voiceConfirmationReceiptsSchema = Type.Object(
  {
    receipts: Type.Array(
      Type.Object(
        {
          target: voiceConfirmationTargetSchema,
          phrase: textLimit(Type.String({ minLength: 1, maxLength: 100 })),
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
export const parseVoiceMacHeartbeat = (raw: unknown) =>
  parseWith(voiceMacHeartbeatSchema, raw);
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

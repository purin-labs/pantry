import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { ChatTranscriptionPath } from "./voice.ts";

/**
 * The speech engines of voice control (Plan 82C). An engine is one model with
 * its own settings and its own noise rule. A host runs an engine: the shop Mac
 * (`shop_mac`) or Workers AI (`workers_ai`). The Portal and the Platform read
 * these facts. The Mac keeps each engine's file pins in its own engine module
 * (`services/shop-voice/shop_voice/engines/`), because only the Mac uses them.
 */
export const voiceEngineIdSchema = Type.Union([
  Type.Literal("whisper-large-v3-turbo"),
  Type.Literal("qwen3-asr-1.7b"),
]);
export type VoiceEngineId = Static<typeof voiceEngineIdSchema>;

export type VoiceEngineFacts = Readonly<{
  label: string;
  licence: string;
  hosts: readonly ChatTranscriptionPath[];
  /** What a Mac downloads. A change to the engine's file pins changes it in the same commit. */
  macDownloadBytes: number;
  /** The MLX memory at its peak while the engine hears a command (Plan 82C Phase 0). */
  macMemoryBytes: number;
  /** The most vocabulary that the engine's prompt takes. */
  vocabulary: Readonly<{ terms: number; characters: number }>;
  /** The Portal's wait for the Mac before it uses the fallback (Plan 82 D1b). */
  macDeadline: Readonly<{ baseMs: number; perAudioSecondMs: number }>;
  /**
   * What the engine wrote for a one-word "Stop." or "Cancel." on the bench:
   * each form that came two times or more and that is no command
   * (`scripts/shop-voice/phrase-bench.py`). While a turn runs, such a word
   * stops the turn.
   */
  heardAsStop: readonly string[];
}>;

export const VOICE_ENGINES = {
  "whisper-large-v3-turbo": {
    label: "Whisper large-v3-turbo",
    licence: "MIT",
    hosts: ["shop_mac", "workers_ai"],
    macDownloadBytes: 1_613_977_880,
    macMemoryBytes: 2_480_000_000,
    vocabulary: { terms: 60, characters: 600 },
    macDeadline: { baseMs: 1000, perAudioSecondMs: 300 },
    heardAsStop: [
      "stock",
      "stopped",
      "pencil",
      "canceled",
      "cancelled",
      "cousel",
      "casual",
      "curso",
    ],
  },
  "qwen3-asr-1.7b": {
    label: "Qwen3-ASR 1.7B",
    licence: "Apache-2.0",
    hosts: ["shop_mac"],
    macDownloadBytes: 4_080_707_826,
    macMemoryBytes: 4_980_000_000,
    vocabulary: { terms: 60, characters: 600 },
    macDeadline: { baseMs: 1000, perAudioSecondMs: 300 },
    heardAsStop: ["capsule", "candle", "kazil", "canzil", "castle"],
  },
} as const satisfies Readonly<Record<VoiceEngineId, VoiceEngineFacts>>;

/** A Mac that reports no engine runs an older service, which has only Whisper. */
export const DEFAULT_MAC_VOICE_ENGINE: VoiceEngineId = "whisper-large-v3-turbo";
/** The engine of the fallback on Workers AI. The Portal and the Platform release together. */
export const CLOUD_VOICE_ENGINE =
  "whisper-large-v3-turbo" satisfies VoiceEngineId;

/** Which host heard a command, and with which engine. */
export type VoiceHeard = Readonly<{
  path: ChatTranscriptionPath;
  engine: VoiceEngineId;
}>;

const ENGINE_FACTS: readonly VoiceEngineFacts[] = Object.values(VOICE_ENGINES);

/**
 * One vocabulary serves every engine, so it keeps to the smallest limits. Each
 * Mac and the fallback read the same list (Plan 82, Vocabulary).
 */
export const VOICE_VOCABULARY_LIMITS: VoiceEngineFacts["vocabulary"] = {
  terms: Math.min(...ENGINE_FACTS.map((facts) => facts.vocabulary.terms)),
  characters: Math.min(
    ...ENGINE_FACTS.map((facts) => facts.vocabulary.characters),
  ),
};

export function isVoiceEngineId(raw: unknown): raw is VoiceEngineId {
  return Value.Check(voiceEngineIdSchema, raw);
}

/** The Portal's wait for one command on the Mac, before it uses the fallback. */
export function voiceMacDeadlineMs(
  engine: VoiceEngineId,
  audioSeconds: number,
): number {
  const { baseMs, perAudioSecondMs } = VOICE_ENGINES[engine].macDeadline;
  return baseMs + perAudioSecondMs * audioSeconds;
}

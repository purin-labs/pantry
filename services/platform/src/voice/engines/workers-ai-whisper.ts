import type { Env } from "../../env";

/**
 * Whisper large-v3-turbo on Workers AI: the fallback's engine (Plan 82C). It
 * takes the shop vocabulary as `initial_prompt` and keeps the segments that
 * pass its engine rule. The Portal's text check (`keptVoiceText`) drops the
 * rest of the invented text, for every engine.
 */
const WORKERS_AI_WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
/**
 * Whisper invents words on room noise when its prompt holds the shop's
 * vocabulary. The shop Mac drops such segments with the same two numbers
 * (`services/shop-voice/shop_voice/engines/whisper_mlx.py`, Plan 82 D11), and
 * `scripts/shop-voice/confidence-bench.py` measures both hosts.
 */
const LOW_CONFIDENCE_LOGPROB = -1.4;
const REPEATED_TEXT_COMPRESSION = 2.4;

/** The text after the engine rule. Null when the answer holds no text. */
export async function hearWithWorkersAiWhisper(
  ai: NonNullable<Env["AI"]>,
  audio: Uint8Array,
  vocabulary: readonly string[],
): Promise<string | null> {
  const result = await ai.run(WORKERS_AI_WHISPER_MODEL, {
    audio: base64(audio),
    language: "en",
    vad_filter: true,
    ...(vocabulary.length === 0
      ? {}
      : { initial_prompt: vocabulary.join(", ") }),
  });
  if (typeof result.text !== "string") return null;
  // An answer with no segment list keeps its whole text, because no rule can judge it.
  if (!Array.isArray(result.segments)) return result.text.trim();
  return result.segments
    .filter(isSpeech)
    .map((segment) => segment.text)
    .join("")
    .trim();
}

/** A segment with a value missing counts as noise, as a NaN value does on the Mac. */
function isSpeech(segment: unknown): segment is Readonly<{ text: string }> {
  if (typeof segment !== "object" || segment === null) return false;
  const { text, avg_logprob, compression_ratio } = segment as Readonly<{
    text?: unknown;
    avg_logprob?: unknown;
    compression_ratio?: unknown;
  }>;
  return (
    typeof text === "string" &&
    typeof avg_logprob === "number" &&
    avg_logprob >= LOW_CONFIDENCE_LOGPROB &&
    !(
      typeof compression_ratio === "number" &&
      compression_ratio > REPEATED_TEXT_COMPRESSION
    )
  );
}

function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let at = 0; at < bytes.length; at += 0x8000)
    parts.push(String.fromCharCode(...bytes.subarray(at, at + 0x8000)));
  return btoa(parts.join(""));
}

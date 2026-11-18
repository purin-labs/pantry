/**
 * The text check of voice control (Plan 82C D1). A speech engine invents text
 * on room noise when its prompt holds the shop's vocabulary: subtitle credits
 * from its training data, the vocabulary read back as a list, a phrase
 * repeated until the audio ends, or "Thank you". The engine rule on each host
 * drops what the engine's own values can judge; this check drops the rest, for
 * every engine and host. The Portal runs it on each transcript, and the bench
 * scores with it (`scripts/shop-voice/portal-voice.mjs`), so no copy can drift.
 */

/** Lines that Whisper writes on room noise with high confidence (Plan 82 D11). */
const INVENTED_LINES = [
  "sous-titrage",
  "sous-titres",
  "amara.org",
  "subtitles by",
  "thank you for watching",
];
const NOISE_PHRASE_WORDS = 4;
/** A person does not say a phrase five times. */
const NOISE_REPEATS = 5;

/**
 * The transcript without its invented sentences, or "" when no word of it is
 * speech. `names` is the shop's vocabulary, as the engines read it.
 */
export function keptVoiceText(text: string, names: readonly string[]): string {
  const known = new Set(names.map((name) => name.trim().toLowerCase()));
  const kept = text
    .trim()
    .split(/(?<=[.!?])\s+/u)
    .filter((sentence) => !isInventedSentence(sentence, known))
    .join(" ")
    .trim();
  const spoken = plainWords(kept);
  return spoken.length === 0 || spoken === "thank you" || repeatsAPhrase(spoken)
    ? ""
    : kept;
}

/** Lower case, with no punctuation: the words that the Portal reads a command from. */
export function plainWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

/**
 * A subtitle credit, or the vocabulary read back: a list in which at least two
 * names, and at least half of the parts, are the shop's own names.
 */
function isInventedSentence(
  sentence: string,
  names: ReadonlySet<string>,
): boolean {
  const lower = sentence.toLowerCase();
  if (INVENTED_LINES.some((line) => lower.includes(line))) return true;
  const parts = lower
    .split(",")
    .map((part) => part.replace(/^[\s.!?]+|[\s.!?]+$/gu, ""))
    .filter((part) => part.length > 0);
  const named = parts.filter((part) => names.has(part)).length;
  return parts.length >= 2 && named >= 2 && named * 2 >= parts.length;
}

function repeatsAPhrase(spoken: string): boolean {
  const all = spoken.split(/\s+/u);
  for (let size = 1; size <= NOISE_PHRASE_WORDS; size += 1) {
    let same = 0;
    for (let at = size; at < all.length; at += 1) {
      same = all[at] === all[at - size] ? same + 1 : 0;
      if (same >= size * (NOISE_REPEATS - 1)) return true;
    }
  }
  return false;
}

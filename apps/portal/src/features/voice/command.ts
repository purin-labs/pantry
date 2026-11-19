import {
  keptVoiceText,
  normalizeVoicePhrase,
  plainWords,
  VOICE_ENGINES,
  type VoiceEngineId,
  type VoiceRefusalCode,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

const SAMPLE_RATE = 16_000;

export type VoiceCommand =
  | Readonly<{ kind: "stop" }>
  | Readonly<{ kind: "steer"; text: string }>
  | Readonly<{ kind: "send"; text: string }>
  | Readonly<{ kind: "empty" }>;

/**
 * The spoken forms of the stop button and the steer key (Plan 82, One command).
 * The text check drops what an engine invented on noise, for every engine and
 * host (Plan 82C D1); `names` is the shop vocabulary that the engines read.
 */
export function readVoiceCommand(
  transcript: string,
  names: readonly string[],
): VoiceCommand {
  const text = keptVoiceText(transcript, names);
  const spoken = plainWords(text);
  if (spoken.length === 0) return { kind: "empty" };
  if (spoken === "stop" || spoken === "cancel") return { kind: "stop" };
  if (/^(change|instead)\b/u.test(spoken)) return { kind: "steer", text };
  return { kind: "send", text };
}

/**
 * While a card waits for a phrase, speech that is close to one is an attempt
 * to confirm it, and it never goes to the agent. A negation or a changed word
 * keeps the card's noun and digits. The Platform then checks the exact words.
 */
export function isVoiceConfirmationAttempt(
  transcript: string,
  phrases: readonly string[],
): boolean {
  const spoken = normalizeVoicePhrase(transcript).split(" ");
  return phrases.some((phrase) => {
    const words = normalizeVoicePhrase(phrase).split(" ");
    const noun = words[1];
    return spoken.some(
      (word, index) =>
        word === noun &&
        (index === spoken.length - 1 || /^\d+$/u.test(spoken[index + 1] ?? "")),
    );
  });
}

/**
 * What the engine wrote for "stop" and "cancel" on the bench (`heardAsStop` in
 * the engine catalogue). One such word is no request to the agent, so it counts
 * as the word while a turn runs.
 */
export function soundsLikeStop(text: string, engine: VoiceEngineId): boolean {
  const word = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+$/u, "");
  return (VOICE_ENGINES[engine].heardAsStop as readonly string[]).includes(
    word,
  );
}

const SPOKEN_SENTENCES = 2;

/** A point inside a number or a file name does not end a sentence. */
function sentencesOf(text: string): readonly string[] {
  const plain = text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`#>|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const sentences =
    plain.match(/(?:[^.!?]|[.!?](?=\S))+(?:[.!?]+(?=\s|$)|$)/gu) ?? [];
  return sentences.map((sentence) => sentence.trim());
}

/** The sentences to speak now from an answer that is still coming. */
export function finishedSentences(partial: string): readonly string[] {
  const beforeCode = partial.split("```", 1)[0] ?? "";
  const sentences = sentencesOf(beforeCode);
  const finished = /[.!?]\s+$/u.test(beforeCode)
    ? sentences
    : sentences.slice(0, -1);
  return finished.slice(0, SPOKEN_SENTENCES);
}

/**
 * The part of the answer's first two sentences that is not yet spoken. The rest
 * is on the screen. If the answer changed after its start, it is spoken in full.
 */
export function spokenAnswer(
  answer: string,
  spoken: readonly string[] = [],
): string {
  const sentences = sentencesOf(answer);
  const continues = spoken.every((part, index) => sentences[index] === part);
  const parts = sentences
    .slice(0, SPOKEN_SENTENCES)
    .slice(continues ? spoken.length : 0);
  if (sentences.length > SPOKEN_SENTENCES) parts.push("More on screen.");
  return parts.join(" ");
}

export function refusalSentence(code: VoiceRefusalCode): string {
  switch (code) {
    case "voice_disabled":
      return "Voice control is off for this workspace.";
    case "too_long":
      return "That was too long. Say it in a shorter way.";
    case "rate_limited":
      return "That is too many commands. Wait a few minutes.";
    case "transcription_unavailable":
      return "I could not hear that. Type it, or try again.";
    default:
      return assertNever(code);
  }
}

/** A WAV file with 16-bit PCM, 16 kHz and one channel: the Mac and the fallback both read it. */
export function encodeVoiceWav(pcm: Float32Array): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const text = (at: number, value: string) => {
    for (let index = 0; index < value.length; index += 1)
      header.setUint8(at + index, value.charCodeAt(index));
  };
  const size = pcm.length * 2;
  text(0, "RIFF");
  header.setUint32(4, 36 + size, true);
  text(8, "WAVEfmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, SAMPLE_RATE, true);
  header.setUint32(28, SAMPLE_RATE * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, "data");
  header.setUint32(40, size, true);
  const samples = new Int16Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1)
    samples[index] = Math.max(-1, Math.min(1, pcm[index] ?? 0)) * 32767;
  return new Blob([header.buffer, samples.buffer], { type: "audio/wav" });
}

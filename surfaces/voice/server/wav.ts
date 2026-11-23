import { VOICE_AUDIO_SECONDS_LIMIT } from "@purin-labs/control-api";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** Room for a header with a few extra chunks around the longest command. */
export const VOICE_BODY_BYTE_LIMIT =
  VOICE_AUDIO_SECONDS_LIMIT * BYTES_PER_SECOND + 1024;

type VoiceWav =
  | Readonly<{ kind: "valid"; audioMilliseconds: number }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "too_long" }>;

/** A command is a RIFF WAV file with 16-bit PCM, 16 kHz and one channel. */
export function readVoiceWav(bytes: Uint8Array): VoiceWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) =>
    String.fromCharCode(
      bytes[at]!,
      bytes[at + 1]!,
      bytes[at + 2]!,
      bytes[at + 3]!,
    );
  if (bytes.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE")
    return { kind: "invalid" };
  let format = false;
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const name = tag(at);
    const size = view.getUint32(at + 4, true);
    if (name === "fmt ") {
      if (
        size < 16 ||
        at + 24 > bytes.byteLength ||
        view.getUint16(at + 8, true) !== 1 ||
        view.getUint16(at + 10, true) !== 1 ||
        view.getUint32(at + 12, true) !== SAMPLE_RATE ||
        view.getUint16(at + 22, true) !== 16
      )
        return { kind: "invalid" };
      format = true;
    }
    if (name === "data") {
      if (!format || size === 0 || at + 8 + size > bytes.byteLength)
        return { kind: "invalid" };
      const audioMilliseconds = Math.round((size / BYTES_PER_SECOND) * 1000);
      return audioMilliseconds > VOICE_AUDIO_SECONDS_LIMIT * 1000
        ? { kind: "too_long" }
        : { kind: "valid", audioMilliseconds };
    }
    at += 8 + size + (size % 2);
  }
  return { kind: "invalid" };
}

import { CLOUD_VOICE_ENGINE } from "@purin-labs/control-api";

import type { Env } from "../env";
import { hearWithWorkersAiWhisper } from "./engines/workers-ai-whisper";

/** The Portal's own limit is 6 s at p95; this only ends a call that hangs. */
const CALL_DEADLINE_MS = 20_000;

type CloudEngine = (
  ai: NonNullable<Env["AI"]>,
  audio: Uint8Array,
  vocabulary: readonly string[],
) => Promise<string | null>;

/** A cloud engine is one module in `engines/` and one entry here (Plan 82C). */
const CLOUD_ENGINES: Readonly<Record<typeof CLOUD_VOICE_ENGINE, CloudEngine>> =
  { "whisper-large-v3-turbo": hearWithWorkersAiWhisper };

/**
 * One command through the catalogue's cloud engine on Workers AI, never
 * through AI Gateway (G0.5). Null when the service fails. The text is the one
 * after the engine rule: the Portal's text check judges the rest, as it does
 * for the Mac. An empty text means noise: the Portal plays its low tones and
 * sends nothing. No audio or transcript is stored or logged.
 */
export async function transcribeWithWorkersAi(
  env: Env,
  audio: Uint8Array,
  vocabulary: readonly string[],
): Promise<string | null> {
  if (env.AI === undefined) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CALL_DEADLINE_MS);
    });
    return await Promise.race([
      CLOUD_ENGINES[CLOUD_VOICE_ENGINE](env.AI, audio, vocabulary),
      deadline,
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

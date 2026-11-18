/**
 * What happened on this device each day. It holds numbers only, and it stays
 * in this browser. Real voices in a real room say what the synthetic measures
 * cannot (Plan 82), and Plan 82C Phase 3 compares the engines with a week of
 * these counts.
 */
import {
  isChatTranscriptionPath,
  isVoiceEngineId,
  type ChatTranscriptionPath,
  type VoiceEngineId,
  type VoiceHeard,
} from "@seams/control-api";
import { isRecord, parseJsonOrNull } from "@seams/std";

import { readStored, writeStored } from "./setting";

const COUNTS_KEY = "satyr.voice.counts";
const COUNT_DAYS = 14;

/** What one engine on one host heard: the texts that the Portal kept, and the texts that it dropped. */
export type VoiceHeardCount = Readonly<{ commands: number; noise: number }>;

/** The key of `heardBy`: the host and the engine, as `shop_mac:qwen3-asr-1.7b`. */
type HeardKey = `${ChatTranscriptionPath}:${VoiceEngineId}`;

export type VoiceCounts = Readonly<{
  wakes: number;
  nearWakes: number;
  holds: number;
  noCommand: number;
  heardBy: Readonly<Partial<Record<HeardKey, VoiceHeardCount>>>;
}>;
type CountName = Exclude<keyof VoiceCounts, "heardBy">;

const NO_COUNTS: VoiceCounts = {
  wakes: 0,
  nearWakes: 0,
  holds: 0,
  noCommand: 0,
  heardBy: {},
};

function day(at: Date): string {
  return at.toLocaleDateString("en-CA");
}

function readCounts(): Record<string, VoiceCounts> {
  const stored = parseJsonOrNull(readStored(COUNTS_KEY) ?? "");
  return isRecord(stored) ? (stored as Record<string, VoiceCounts>) : {};
}

function changeToday(change: (current: VoiceCounts) => VoiceCounts): void {
  const counts = readCounts();
  const key = day(new Date());
  counts[key] = change({ ...NO_COUNTS, ...counts[key] });
  const kept = Object.keys(counts).sort().slice(-COUNT_DAYS);
  writeStored(
    COUNTS_KEY,
    JSON.stringify(
      Object.fromEntries(kept.map((name) => [name, counts[name]])),
    ),
  );
}

export function addVoiceCount(name: CountName): void {
  changeToday((current) => ({ ...current, [name]: current[name] + 1 }));
}

/** One transcript of a host and an engine, which the Portal kept as a command or dropped as noise. */
export function addVoiceHeard(heard: VoiceHeard, kept: boolean): void {
  const key: HeardKey = `${heard.path}:${heard.engine}`;
  changeToday((current) => {
    const count = current.heardBy[key] ?? { commands: 0, noise: 0 };
    return {
      ...current,
      heardBy: {
        ...current.heardBy,
        [key]: kept
          ? { ...count, commands: count.commands + 1 }
          : { ...count, noise: count.noise + 1 },
      },
    };
  });
}

export function voiceCountsToday(): VoiceCounts {
  return { ...NO_COUNTS, ...readCounts()[day(new Date())] };
}

export type VoiceHeardTotal = VoiceHeard & VoiceHeardCount;

/** Each host and engine that heard a transcript on this device in the last `days` days, today included. */
export function voiceHeardLastDays(days: number): VoiceHeardTotal[] {
  const counts = readCounts();
  const totals = new Map<HeardKey, VoiceHeardTotal>();
  for (let back = 0; back < days; back += 1) {
    const at = new Date();
    at.setDate(at.getDate() - back);
    const heardBy = counts[day(at)]?.heardBy;
    if (!isRecord(heardBy)) continue;
    for (const [key, count] of Object.entries(heardBy) as [
      HeardKey,
      VoiceHeardCount,
    ][]) {
      // A count from an engine that this Portal does not know stays out.
      const [path, engine] = key.split(":");
      if (!isChatTranscriptionPath(path) || !isVoiceEngineId(engine)) continue;
      const total = totals.get(key) ?? { path, engine, commands: 0, noise: 0 };
      totals.set(key, {
        ...total,
        commands: total.commands + count.commands,
        noise: total.noise + count.noise,
      });
    }
  }
  return [...totals.values()];
}

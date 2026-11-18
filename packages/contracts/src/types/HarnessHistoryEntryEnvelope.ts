import type { HarnessHistoryEntry } from "./HarnessHistoryEntry";

export type HarnessHistoryEntryEnvelope = {
  version: number;
  entry: HarnessHistoryEntry;
};

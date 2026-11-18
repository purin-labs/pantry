import type { HarnessEventSequence } from "./HarnessEventSequence";
import type { Sha256Digest } from "./Sha256Digest";

export type HarnessHistoryCursor = {
  lastSequence: HarnessEventSequence;
  lastEntryDigest: Sha256Digest;
};

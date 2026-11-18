import type { HarnessEventSequence } from "./HarnessEventSequence";
import type { Sha256Digest } from "./Sha256Digest";
import type { TurnIdentity } from "./TurnIdentity";

export type AcceptedHarnessEventCursor = {
  turn: TurnIdentity;
  lastSequence: HarnessEventSequence;
  lastEventDigest: Sha256Digest;
};

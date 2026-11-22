import type { proposeEvalFromCorrection } from "../../evals/access";
import type {
  createTurnMemoryReader,
  proposeMemoryFromCorrection,
  readMemoryViews,
  readShownMemoryStanding,
} from "../access";
import { definePort } from "@purin-labs/kernel/port";

export type { TurnMemoryDestination } from "../access";

/**
 * The Memory service of Brain, as a service interface of its contract. The
 * Inbox reads the Memory that a person may see, the standing of the Memory
 * that a turn was shown and the Memory of a mailbox turn, and it proposes a
 * Memory and an Eval from a correction. The Memory store stays private: only
 * Brain makes a Memory revision. The Worker registers the implementation
 * (`worker-ports.ts`).
 */
export type MemoryService = Readonly<{
  /** Every Memory that a person may inspect in full. */
  readMemoryViews: typeof readMemoryViews;
  /** Whether the Memory that a turn was shown still stands. */
  readShownMemoryStanding: typeof readShownMemoryStanding;
  /** The Memory reader of one turn, for the destination of the turn. */
  createTurnMemoryReader: typeof createTurnMemoryReader;
  /** Proposes a Memory candidate from a corrected reply. */
  proposeMemoryFromCorrection: typeof proposeMemoryFromCorrection;
  /** Proposes an Eval candidate from a corrected reply. */
  proposeEvalFromCorrection: typeof proposeEvalFromCorrection;
}>;

/** The person and the conversation of a Memory read. */
export type MemoryReadScope = Parameters<MemoryService["readMemoryViews"]>[1];

export const memoryService = definePort<MemoryService>("memory_service");

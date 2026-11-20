import type { TurnMemoryRead, TurnMemoryReader } from "../../context/assembly";

/** One Memory revision a turn's model was shown. */
export type ShownMemoryRevision = Readonly<{
  memoryId: string;
  revision: number;
}>;

/**
 * The reader for a turn with no verified subject that a Memory scope could
 * match. Nothing applies to such a turn, so it reads nothing.
 */
export function turnMemoryReaderWithoutSubjects(): TurnMemoryReader {
  return { read: readNoTurnMemory };
}

export async function readNoTurnMemory(): Promise<TurnMemoryRead> {
  return { kind: "read", candidates: [], more: false };
}

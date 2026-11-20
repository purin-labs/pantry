/** One Memory revision a turn's model was shown. */
export type ShownMemoryRevision = Readonly<{
  memoryId: string;
  revision: number;
}>;

// The empty reader is a value of the port of the context assembly. Brain
// gives it to the turns of its area from here.
export {
  readNoTurnMemory,
  turnMemoryReaderWithoutSubjects,
} from "../../context/assembly";

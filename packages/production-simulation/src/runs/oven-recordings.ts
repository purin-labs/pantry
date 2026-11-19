import {
  readRecordingPack,
  readCellRecordingDocument,
  type ArtifactEntry,
  type ResumableDocument,
  type PhysicsView,
} from "../index.ts";
import { nativeIdentity } from "../native/cell-adapter.ts";
import {
  isNonNegativeInteger,
  isRecord,
  parseJsonOrNull,
  sha256Hex,
} from "@seams/std";
import type { PersistentPhysicsScene } from "@seams/bakery-model/bakery-physics";
import {
  ovenOperation,
  readOvenLiveFrame,
  type OvenLiveFrame,
} from "./oven-live-physics.ts";
import { readOvenPlayback, type OvenPlayback } from "./oven-playback.ts";
import type { OvenSave } from "./oven-run-file.ts";
import type { Variant } from "@seams/type-utils";

/** Bounds resident record metadata, independently of the total archive size. */
export const MAX_OVEN_RECORDING_INDEX_ENTRIES = 65_536;
export const MAX_OVEN_OPERATION_BYTES = 64 * 1024 * 1024;

/** The caller owns file access or live storage authorization for this snapshot. */
export type RecordingArchive = Readonly<{
  document: ResumableDocument;
  readArtifact(digest: string): Promise<string>;
}>;

/** Adapt the current workspace save at its artifact-access boundary. */
export function ovenRecordingArchive(save: OvenSave): RecordingArchive {
  return {
    document: save.document,
    readArtifact: readSavedArtifact.bind(null, save),
  };
}
async function readSavedArtifact(
  save: OvenSave,
  digest: string,
): Promise<string> {
  for (const artifact of save.artifacts)
    if (artifact.digest === digest) return artifact.read();
  throw new Error("A saved recording pack is missing.");
}

type Observation =
  | Omit<Variant<PhysicsView, "cell-recorded">, "content">
  | Omit<Variant<PhysicsView, "recorded">, "content">;
type Reference = Readonly<{
  offset: number;
  byteLength: number;
  observation: Observation;
}>;
type TimeRange = Readonly<{ first: number; last: number }>;
type PackSummary = Readonly<{
  entry: ArtifactEntry;
  cells: ReadonlyMap<string, TimeRange>;
  tasks: ReadonlySet<string>;
}>;
type PackPage = Readonly<{
  digest: string;
  body: string;
  records: readonly Reference[];
}>;
type OperationStart = Readonly<{
  task: string;
  attempt: string;
  purpose: "operation" | "recovery";
  time: number;
  cell: string;
  skill: string;
}>;
type SnapshotIndex = Readonly<{
  archive: RecordingArchive;
  starts: ReadonlyMap<string, OperationStart>;
  packs: readonly PackSummary[];
}>;
type Candidate = Readonly<{
  pack: PackSummary;
  order: number;
  through: number;
}>;

export type OvenRecordingStats = Readonly<{
  indexedPacks: number;
  indexedRecords: number;
  summaryEntries: number;
  decodedBytes: number;
  /** Initial summary scans; loadedPacks also counts later page reads. */
  scannedPacks: number;
  scannedRecords: number;
  loadedPacks: number;
  selectedRecords: number;
  selectedBytes: number;
}>;

/** Retain pack summaries and one decoded page. Never index the whole trajectory. */
export class OvenRecordings {
  private current: SnapshotIndex | null = null;
  private page: PackPage | null = null;
  private scannedPacks = 0;
  private scannedRecords = 0;
  private loadedPacks = 0;
  private selectedRecords = 0;
  private selectedBytes = 0;

  stats(): OvenRecordingStats {
    let summaryEntries = 0;
    for (const pack of this.current?.packs ?? [])
      summaryEntries += pack.cells.size + pack.tasks.size;
    return {
      indexedPacks: this.current?.packs.length ?? 0,
      indexedRecords: this.page?.records.length ?? 0,
      summaryEntries,
      decodedBytes: this.page?.body.length ?? 0,
      scannedPacks: this.scannedPacks,
      scannedRecords: this.scannedRecords,
      loadedPacks: this.loadedPacks,
      selectedRecords: this.selectedRecords,
      selectedBytes: this.selectedBytes,
    };
  }

  async latest(
    archive: RecordingArchive,
    scene: PersistentPhysicsScene,
    through: number,
  ): Promise<OvenLiveFrame | null> {
    const observation = await this.observation(
      archive,
      scene.cell.cellId,
      through,
    );
    return observation === null
      ? null
      : readOvenLiveFrame(
          scene,
          observation,
          archive.document.state.position.time,
        );
  }

  /** Exact accepted bytes at or before the cursor, shared by all cell views. */
  async observation(
    archive: RecordingArchive,
    cell: string,
    through: number,
  ): Promise<Exclude<PhysicsView, { kind: "unavailable" }> | null> {
    if (
      !isNonNegativeInteger(through) ||
      through > archive.document.state.position.time
    )
      throw new Error("Inspection time exceeds the committed run.");
    if (!archive.document.state.cells.some(matchesCell.bind(null, cell)))
      throw new Error("The selected cell does not belong to this run.");
    const index = await this.index(archive);
    const candidates: Candidate[] = [];
    for (const [order, pack] of index.packs.entries()) {
      const range = pack.cells.get(cell);
      if (range !== undefined && range.first <= through)
        candidates.push({
          pack,
          order,
          through: Math.min(range.last, through),
        });
    }
    candidates.sort(compareCandidates);
    let selected: Readonly<{
      reference: Reference;
      order: number;
      content: string;
    }> | null = null;
    for (const candidate of candidates) {
      if (
        selected !== null &&
        candidate.through < selected.reference.observation.at
      )
        break;
      const page = await this.load(index, candidate.pack.entry);
      for (const reference of page.records) {
        const observation = reference.observation;
        if (observation.cell !== cell || observation.at > through) continue;
        if (
          selected !== null &&
          (observation.at < selected.reference.observation.at ||
            (observation.at === selected.reference.observation.at &&
              candidate.order < selected.order))
        )
          continue;
        selected = {
          reference,
          order: candidate.order,
          content: sliceRecord(page, reference),
        };
      }
    }
    if (selected === null) return null;
    this.selectedRecords++;
    this.selectedBytes += selected.reference.byteLength;
    return { ...selected.reference.observation, content: selected.content };
  }

  async operation(
    archive: RecordingArchive,
    scene: PersistentPhysicsScene,
    task: string,
  ): Promise<OvenPlayback> {
    const records = await this.operationRecords(
      archive,
      scene.cell.cellId,
      task,
    );
    return readOvenPlayback(archive, scene, task, records);
  }

  /** Read only the packs that contain this operation, in accepted pack order. */
  async operationRecords(
    archive: RecordingArchive,
    cell: string,
    task: string,
  ): Promise<readonly Readonly<{ digest: string; content: string }>[]> {
    if (ovenOperation(archive.document.state, task).cell !== cell)
      throw new Error("The task belongs to another cell.");
    const index = await this.index(archive);
    const records = [];
    let bytes = 0;
    for (const pack of index.packs) {
      if (!pack.tasks.has(task)) continue;
      const page = await this.load(index, pack.entry);
      for (const reference of page.records) {
        const observation = reference.observation;
        if (
          observation.kind !== "recorded" ||
          observation.purpose !== "operation" ||
          observation.task !== task
        )
          continue;
        bytes += reference.byteLength;
        if (
          bytes > MAX_OVEN_OPERATION_BYTES ||
          records.length >= MAX_OVEN_RECORDING_INDEX_ENTRIES
        )
          throw new Error(
            "This operation exceeds the recording selection limit. Inspect a cell timestamp instead.",
          );
        records.push({
          digest: observation.digest,
          content: sliceRecord(page, reference),
        });
        this.selectedRecords++;
        this.selectedBytes += reference.byteLength;
      }
    }
    return records;
  }

  private async load(
    index: SnapshotIndex,
    entry: ArtifactEntry,
  ): Promise<PackPage> {
    if (this.page?.digest === entry.digest) return this.page;
    // Release the old decoded body before fetching or inflating the next page.
    this.page = null;
    const content = await index.archive.readArtifact(entry.digest);
    if (
      new TextEncoder().encode(content).byteLength !== entry.byteLength ||
      (await sha256Hex(content)) !== entry.digest
    )
      throw new Error("A saved recording pack failed its integrity check.");
    const parsed = readRecordingPack(content);
    if (!parsed.ok)
      throw new Error("A saved recording pack has an invalid index.");
    if (parsed.value.records.length > MAX_OVEN_RECORDING_INDEX_ENTRIES)
      throw new Error("A recording pack exceeds the resident index limit.");
    const records: Reference[] = [];
    for (const record of parsed.value.records) {
      const raw = parseJsonOrNull(
        parsed.value.body.slice(
          record.offset,
          record.offset + record.byteLength,
        ),
      );
      const observation = readObservation(index, raw, record.digest);
      if (observation !== null)
        records.push({
          offset: record.offset,
          byteLength: record.byteLength,
          observation,
        });
    }
    this.loadedPacks++;
    this.page = { digest: entry.digest, body: parsed.value.body, records };
    return this.page;
  }

  private async index(archive: RecordingArchive): Promise<SnapshotIndex> {
    const previous = this.current;
    if (previous !== null) {
      if (
        previous.archive.document.state.identity.runId !==
          archive.document.state.identity.runId ||
        previous.archive.document.bundle.id !== archive.document.bundle.id
      )
        throw new Error(
          "This recording index belongs to another run or build.",
        );
      if (previous.archive.document === archive.document) return previous;
    }
    const retained = new Map<string, PackSummary>();
    for (const pack of previous?.packs ?? [])
      retained.set(pack.entry.digest, pack);
    const packs: PackSummary[] = [];
    const index: SnapshotIndex = {
      archive,
      starts: operationStarts(archive),
      packs,
    };
    try {
      for (const entry of archive.document.artifacts) {
        if (entry.role !== "recording-segment") continue;
        const cached = retained.get(entry.digest);
        if (cached !== undefined) {
          packs.push(cached);
          continue;
        }
        const page = await this.load(index, entry);
        packs.push(summarizePack(entry, page));
        this.scannedPacks++;
        this.scannedRecords += page.records.length;
      }
    } catch (error) {
      this.page = null;
      throw error;
    }
    this.current = index;
    return index;
  }
}

function matchesCell(id: string, cell: Readonly<{ id: string }>): boolean {
  return cell.id === id;
}
function sliceRecord(page: PackPage, reference: Reference): string {
  return page.body.slice(
    reference.offset,
    reference.offset + reference.byteLength,
  );
}
function compareCandidates(left: Candidate, right: Candidate): number {
  return right.through - left.through || right.order - left.order;
}
function operationStarts(
  archive: RecordingArchive,
): ReadonlyMap<string, OperationStart> {
  const starts = new Map<string, OperationStart>();
  const run = archive.document.state;
  for (const event of run.events) {
    if (
      (event.kind !== "task-started" && event.kind !== "recovery-started") ||
      event.attempt === null
    )
      continue;
    const operation = ovenOperation(run, event.task);
    starts.set(nativeIdentity(event.attempt), {
      task: event.task,
      attempt: event.attempt,
      purpose: event.kind === "recovery-started" ? "recovery" : "operation",
      time: event.time,
      cell: operation.cell,
      skill: operation.skill,
    });
  }
  return starts;
}
function readObservation(
  index: SnapshotIndex,
  raw: unknown,
  digest: string,
): Observation | null {
  if (isRecord(raw) && raw.kind === "accepted-cell-recording") {
    const document = readCellRecordingDocument(raw);
    if (
      document.runId !== index.archive.document.state.identity.runId ||
      document.bundle !== index.archive.document.bundle.id
    )
      throw new Error(
        "A saved cell recording belongs to another run or build.",
      );
    return {
      kind: "cell-recorded",
      version: 1,
      cell: document.cellId,
      at:
        document.time.kind === "idle"
          ? document.time.through
          : document.time.at,
      digest,
    };
  }
  if (
    !isRecord(raw) ||
    typeof raw.attemptId !== "string" ||
    !isNonNegativeInteger(raw.endStep)
  )
    throw new Error("A saved recording segment is invalid.");
  const start = index.starts.get(raw.attemptId);
  if (start === undefined) return null;
  return {
    kind: "recorded",
    version: 1,
    cell: start.cell,
    at: start.time + raw.endStep * 2000,
    task: start.task,
    attempt: start.attempt,
    purpose: start.purpose,
    skill: start.skill,
    startedAt: start.time,
    digest,
  };
}
function summarizePack(entry: ArtifactEntry, page: PackPage): PackSummary {
  const cells = new Map<string, TimeRange>();
  const tasks = new Set<string>();
  for (const reference of page.records) {
    const observation = reference.observation;
    const previous = cells.get(observation.cell);
    cells.set(observation.cell, {
      first: Math.min(previous?.first ?? observation.at, observation.at),
      last: Math.max(previous?.last ?? observation.at, observation.at),
    });
    if (observation.kind === "recorded" && observation.purpose === "operation")
      tasks.add(observation.task);
  }
  return { entry, cells, tasks };
}

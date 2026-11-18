import { readEspressoRun } from "@seams/bakery-model/espresso-rehearsal-file";
import {
  isRunSnapshotId,
  parseRunSnapshot,
  parseRunSnapshotSummary,
  parseRunSnapshotPage,
  type RunSnapshot,
  type RunSnapshotPage,
  type RunSnapshotKind,
  type RunSnapshotSummary,
} from "@seams/bakery-model/bakery-run-snapshot";
import type { CommerceMutationTransport } from "../commerce/entity-plane/api";
import { ControlApiError } from "../../control-client.ts";
import {
  exportProductionWorkcells,
  exportRehearsalWorkcells,
  parseProductionWorkcells,
  parseRehearsalWorkcells,
  type ProductionWorkcells,
} from "@seams/production-simulation/recipes/bakery/production-workcells";
import {
  openRehearsalDocument,
  type RehearsalConversion,
} from "@seams/production-simulation/simulator/rehearsal-conversion";
import type { Settings } from "@seams/bakery-model/bakery";
import type { ProductionScenarioRead } from "./production-scenario-api";
import type { CompiledProcedure } from "@seams/bakery-model/bakery-procedure";
import { assertNever, isRecord, parseJsonOrNull, sha256Hex } from "@seams/std";
import {
  readOvenSave,
  savedCellDefinitions,
  type OvenSave,
  type OvenRunSource,
} from "@seams/production-simulation/runs/oven-run-file";
import { RunArtifactFile } from "@seams/production-simulation/runs/run-artifact-file";
import {
  openResumable,
  parseExecutionBundle,
  type ResumableDocument,
} from "@seams/production-simulation";
import type { StrictUnion, Variant } from "@seams/type-utils";
import { visitSharedArtifacts } from "@seams/production-simulation/simulator/shared-artifact-batches";
import { parseApplianceWorkflow } from "@seams/bakery-model/bakery-appliance-workflow";

type Read = (path: string) => Promise<unknown>;

export type WorkspaceRunSave =
  | Readonly<{ kind: "verified"; snapshot: RunSnapshotSummary }>
  | Readonly<{
      kind: "saved-readback-failed";
      snapshot: RunSnapshotSummary;
      message: string;
    }>
  | Readonly<{
      kind: "outcome-unknown";
      id: string;
      message: string;
    }>;

export type PreparedWorkspaceRun = Readonly<{
  snapshot: RunSnapshot;
  id: string;
  bytes: number;
}> &
  StrictUnion<
    | Readonly<{ kind: "inline" }>
    | Readonly<{ kind: "artifacts"; files: readonly RunArtifactFile[] }>
  >;

type WorkspaceRunSaveOrigin =
  | Readonly<{ kind: "manual" }>
  | Readonly<{ kind: "agent_effect"; effectId: string }>;

export async function prepareRehearsalRunWorkspace(
  name: string,
  plan: ProductionWorkcells,
): Promise<PreparedWorkspaceRun> {
  const document: unknown = JSON.parse(exportRehearsalWorkcells(plan));
  const snapshot = parseRunSnapshot({ name, document });
  if (snapshot === null || snapshot.kind !== "rehearsal")
    throw new Error("Enter a run name from 1 to 80 characters.");
  await checkRehearsal(snapshot.file);
  return prepareSnapshot(snapshot);
}

// Earlier rehearsal snapshots convert at this boundary; see rehearsal-conversion.
export async function openRehearsalRunWorkspace(
  organisationId: string,
  id: string,
  read: Read,
  settings: Settings,
): Promise<RehearsalConversion & Readonly<{ savedRun: SavedWorkspaceRun }>> {
  const snapshot = await readExactWorkspaceRun(organisationId, id, read);
  if (snapshot.kind !== "rehearsal")
    throw new Error(
      "This saved rehearsal is invalid. Your current run is unchanged.",
    );
  const opened = await openRehearsalDocument(snapshot.file, settings);
  if (opened.kind === "rejected") throw new Error(opened.message);
  return {
    ...opened.conversion,
    savedRun: { id, name: snapshot.name, kind: snapshot.kind },
  };
}

export async function prepareProductionWorkspaceRun(
  organisationId: string,
  name: string,
  plan: ProductionWorkcells,
  readDefinition: (
    organisationId: string,
    scenarioId: string,
  ) => Promise<ProductionScenarioRead>,
): Promise<PreparedWorkspaceRun> {
  const document: unknown = JSON.parse(exportProductionWorkcells(plan));
  const snapshot = parseRunSnapshot({ name, document });
  if (snapshot === null || snapshot.kind !== "production")
    throw new Error("Enter a production run name from 1 to 80 characters.");
  await checkProduction(snapshot.file);
  await verifyProductionSource(plan, organisationId, readDefinition);
  return prepareSnapshot(snapshot);
}

export async function savePreparedWorkspaceRun(
  organisationId: string,
  mutate: CommerceMutationTransport,
  prepared: PreparedWorkspaceRun,
  read: Read,
): Promise<WorkspaceRunSave> {
  const check = snapshotCheck(prepared.snapshot.kind);
  return persistSnapshot(
    organisationId,
    mutate,
    prepared,
    read,
    prepared.snapshot.kind === "production" ||
      prepared.snapshot.kind === "persistent-production"
      ? "Save production to workspace"
      : prepared.snapshot.kind === "appliance"
        ? "Save appliance run to workspace"
        : "Save rehearsal to workspace",
    check,
    { kind: "manual" },
  );
}

export async function savePreparedAgentWorkspaceRun(
  organisationId: string,
  mutate: CommerceMutationTransport,
  prepared: PreparedWorkspaceRun,
  effectId: string,
  read: Read,
): Promise<WorkspaceRunSave> {
  if (prepared.snapshot.kind !== "rehearsal")
    throw new Error("Agent save proposals require a rehearsal snapshot.");
  return persistSnapshot(
    organisationId,
    mutate,
    prepared,
    read,
    "Approve agent-prepared rehearsal save",
    checkRehearsal,
    { kind: "agent_effect", effectId },
  );
}

export async function saveProductionWorkspaceRun(
  organisationId: string,
  mutate: CommerceMutationTransport,
  name: string,
  plan: ProductionWorkcells,
  read: Read,
  readDefinition: (
    organisationId: string,
    scenarioId: string,
  ) => Promise<ProductionScenarioRead>,
): Promise<WorkspaceRunSave> {
  return savePreparedWorkspaceRun(
    organisationId,
    mutate,
    await prepareProductionWorkspaceRun(
      organisationId,
      name,
      plan,
      readDefinition,
    ),
    read,
  );
}

async function prepareSnapshot(
  snapshot: RunSnapshot,
): Promise<PreparedWorkspaceRun> {
  const content = new TextEncoder().encode(snapshot.content);
  const id = await sha256Hex(content);
  return Object.freeze({ kind: "inline", snapshot, id, bytes: content.length });
}

type CheckSavedFile = (file: string) => Promise<void>;
async function persistSnapshot(
  organisationId: string,
  mutate: CommerceMutationTransport,
  prepared: PreparedWorkspaceRun,
  read: Read,
  intent: string,
  check: CheckSavedFile,
  origin: WorkspaceRunSaveOrigin,
): Promise<WorkspaceRunSave> {
  const snapshot = prepared.snapshot;
  const document: unknown = JSON.parse(snapshot.file);
  let response: unknown;
  try {
    if (prepared.kind === "artifacts")
      await stageWorkspaceArtifacts(organisationId, mutate, prepared);
    response = await mutate(
      workspaceRunPath(organisationId),
      origin.kind === "agent_effect"
        ? {
            expectedId: prepared.id,
            name: snapshot.name,
            document,
            agentEffectId: origin.effectId,
          }
        : { expectedId: prepared.id, name: snapshot.name, document },
      intent,
    );
  } catch {
    return {
      kind: "outcome-unknown",
      id: prepared.id,
      message: `The save response is uncertain. Check saved run ${prepared.id} before trying again.`,
    };
  }
  const result =
    isRecord(response) && response.ok === true
      ? parseRunSnapshotSummary(response.snapshot)
      : null;
  if (
    result === null ||
    result.id !== prepared.id ||
    result.name !== snapshot.name ||
    result.kind !== snapshot.kind ||
    result.bytes !== prepared.bytes
  )
    return {
      kind: "outcome-unknown",
      id: prepared.id,
      message: `The save receipt could not be verified. Check saved run ${prepared.id} before trying again.`,
    };
  try {
    const saved = parseRunSnapshot(
      await read(`${workspaceRunPath(organisationId)}/${result.id}`),
    );
    if (saved === null || saved.content !== snapshot.content)
      throw new Error("The saved copy differs from the submitted run.");
    if (saved.kind === "persistent-production")
      await verifyPersistentArtifacts(organisationId, result.id, saved, read);
    else await check(saved.file);
    return { kind: "verified", snapshot: result };
  } catch (error) {
    return {
      kind: "saved-readback-failed",
      snapshot: result,
      message:
        error instanceof Error
          ? error.message
          : "Unable to read the saved copy.",
    };
  }
}

// Rehearsal saves store the current format; earlier formats only open.
async function checkRehearsal(file: string): Promise<void> {
  const parsed = await parseRehearsalWorkcells(file);
  if (parsed.kind === "rejected") throw new Error(parsed.message);
}
async function checkProduction(file: string): Promise<void> {
  const parsed = await parseProductionWorkcells(file);
  if (parsed.kind === "rejected") throw new Error(parsed.message);
}

export async function readWorkspaceRuns(
  organisationId: string,
  kind: RunSnapshotKind,
  cursor: string | null,
  read: Read,
): Promise<RunSnapshotPage> {
  const path =
    workspaceRunPath(organisationId) +
    (cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`);
  const response = await read(path);
  const page =
    isRecord(response) && response.ok === true
      ? parseRunSnapshotPage({
          snapshots: response.snapshots,
          nextCursor: response.nextCursor,
        })
      : null;
  if (page === null)
    throw new Error(
      "Unable to read saved runs. Refresh the list to try again.",
    );
  const snapshots: RunSnapshotSummary[] = [];
  for (const snapshot of page.snapshots) {
    if (snapshot.kind === kind) snapshots.push(snapshot);
  }
  return { snapshots, nextCursor: page.nextCursor };
}

export async function verifyStoredWorkspaceRun(
  organisationId: string,
  kind: RunSnapshotKind,
  id: string,
  name: string,
  read: Read,
): Promise<Readonly<{ kind: "verified" }> | Readonly<{ kind: "not-found" }>> {
  let stored: RunSnapshot;
  try {
    stored = await readExactWorkspaceRun(organisationId, id, read);
  } catch (error) {
    if (
      error instanceof ControlApiError &&
      error.kind === "bakery_run_not_found"
    )
      return { kind: "not-found" };
    throw error;
  }
  if (stored.kind !== kind || stored.name !== name)
    throw new Error("The saved run does not match the reviewed copy.");
  if (kind === "persistent-production")
    await verifyPersistentArtifacts(organisationId, id, stored, read);
  else await snapshotCheck(kind)(stored.file);
  return { kind: "verified" };
}

function snapshotCheck(kind: RunSnapshotKind): CheckSavedFile {
  switch (kind) {
    case "persistent-production":
      return checkPersistentProduction;
    case "production":
      return checkProduction;
    case "rehearsal":
      return checkRehearsal;
    case "appliance":
      return checkAppliance;
    case "linea":
    case "eagle":
      return checkEspresso;
    default:
      return assertNever(kind);
  }
}
async function checkPersistentProduction(file: string): Promise<void> {
  const opened = await readOvenSave(parseJsonOrNull(file), new Map());
  if (!opened.ok) throw new Error(opened.error);
}

export async function preparePersistentWorkspaceRun(
  name: string,
  save: OvenSave,
): Promise<PreparedWorkspaceRun> {
  const snapshot = parseRunSnapshot({
    name,
    document: { kind: "saved", document: save.document, artifacts: [] },
  });
  if (snapshot === null || snapshot.kind !== "persistent-production")
    throw new Error(
      "Use a name from 1 to 80 characters and a bounded run document.",
    );
  const artifacts = new Map<string, RunArtifactFile>();
  for (const artifact of save.artifacts)
    artifacts.set(artifact.digest, artifact);
  const checked = await readOvenSave(parseJsonOrNull(snapshot.file), artifacts);
  if (!checked.ok) throw new Error(checked.error);
  const prepared = await prepareSnapshot(snapshot);
  return {
    kind: "artifacts",
    snapshot,
    id: prepared.id,
    bytes: prepared.bytes,
    files: save.artifacts,
  };
}

async function stageWorkspaceArtifacts(
  organisationId: string,
  mutate: CommerceMutationTransport,
  prepared: Variant<PreparedWorkspaceRun, "artifacts">,
): Promise<void> {
  const path = `${workspaceRunPath(organisationId)}/prepared/${prepared.id}`;
  const response = await mutate(
    path,
    {
      expectedId: prepared.id,
      name: prepared.snapshot.name,
      document: parseJsonOrNull(prepared.snapshot.file),
    },
    "Prepare reviewed production save",
  );
  if (
    !isRecord(response) ||
    response.ok !== true ||
    response.id !== prepared.id ||
    !Array.isArray(response.missing)
  )
    throw new Error("The prepared save returned an invalid artifact index.");
  const files = new Map<string, RunArtifactFile>();
  for (const file of prepared.files) files.set(file.digest, file);
  const requested = new Set<string>();
  const pending: RunArtifactFile[] = [];
  for (const digest of response.missing) {
    if (typeof digest !== "string" || requested.has(digest))
      throw new Error(
        "The prepared save returned a duplicate or invalid artifact.",
      );
    const file = files.get(digest);
    if (file === undefined)
      throw new Error("The prepared save requested an unknown artifact.");
    requested.add(digest);
    pending.push(file);
  }
  await visitSharedArtifacts(
    pending,
    uploadSharedArtifact.bind(null, path, mutate),
  );
}

async function uploadSharedArtifact(
  path: string,
  mutate: CommerceMutationTransport,
  file: RunArtifactFile,
): Promise<void> {
  const reply = await mutate(
    `${path}/artifacts/${file.digest}`,
    { content: await file.read() },
    "Upload reviewed production artifact",
  );
  if (
    !isRecord(reply) ||
    reply.ok !== true ||
    reply.digest !== file.digest ||
    reply.byteLength !== file.byteLength
  )
    throw new Error("The artifact upload returned an invalid receipt.");
}

export type PersistentSnapshot = StrictUnion<
  | Readonly<{
      kind: "embedded";
      source: Variant<OvenRunSource, "snapshot">;
    }>
  | Readonly<{ kind: "artifacts"; document: ResumableDocument }>
>;

/** Normalize earlier embedded files only at the persistence boundary. */
export async function parsePersistentSnapshot(
  snapshot: RunSnapshot,
): Promise<PersistentSnapshot> {
  const raw = parseJsonOrNull(snapshot.file);
  if (
    !isRecord(raw) ||
    raw.kind !== "saved" ||
    !isRecord(raw.document) ||
    !Array.isArray(raw.artifacts)
  )
    throw new Error("The saved production envelope is invalid.");
  if (raw.artifacts.length > 0) {
    const opened = await readOvenSave(raw, new Map(), snapshot.name);
    if (!opened.ok) throw new Error(opened.error);
    return { kind: "embedded", source: opened.value };
  }
  const bundle = parseExecutionBundle(raw.document.bundle);
  if (bundle === null)
    throw new Error("The saved production bundle is invalid.");
  const document = await openResumable(raw.document, bundle.backend, [bundle]);
  if (!document.ok)
    throw new Error("The saved production document is invalid.");
  return { kind: "artifacts", document: document.value };
}

/** Verify readback one bounded file at a time. Only current checkpoints stay resident. */
async function verifyPersistentArtifacts(
  organisationId: string,
  id: string,
  snapshot: RunSnapshot,
  read: Read,
): Promise<void> {
  const parsed = await parsePersistentSnapshot(snapshot);
  if (parsed.kind === "embedded") return;
  const checkpoints: RunArtifactFile[] = [];
  const needed = new Set<string>();
  for (const cell of parsed.document.state.cells)
    needed.add(cell.committed.checkpoint.digest);
  await visitSharedArtifacts(
    parsed.document.artifacts,
    verifySharedArtifact.bind(
      null,
      organisationId,
      id,
      read,
      needed,
      checkpoints,
    ),
  );
  const cells = await savedCellDefinitions(
    parsed.document.state.cells,
    checkpoints,
  );
  if (!cells.ok) throw new Error(cells.error);
}

async function verifySharedArtifact(
  organisationId: string,
  id: string,
  read: Read,
  needed: ReadonlySet<string>,
  checkpoints: RunArtifactFile[],
  entry: ResumableDocument["artifacts"][number],
): Promise<void> {
  const artifact = await readSharedRunArtifact(organisationId, id, entry, read);
  if (needed.has(entry.digest)) checkpoints.push(artifact);
}

export async function readSharedRunArtifact(
  organisationId: string,
  id: string,
  entry: ResumableDocument["artifacts"][number],
  read: Read,
): Promise<RunArtifactFile> {
  const raw = await read(
    `${workspaceRunPath(organisationId)}/${id}/artifacts/${entry.digest}`,
  );
  if (
    !isRecord(raw) ||
    typeof raw.digest !== "string" ||
    raw.digest !== entry.digest ||
    typeof raw.content !== "string"
  )
    throw new Error("The shared artifact response is invalid.");
  const artifact = await RunArtifactFile.fromContent(raw.digest, raw.content);
  if (artifact.byteLength !== entry.byteLength)
    throw new Error("The shared artifact length differs.");
  return artifact;
}

async function checkAppliance(file: string): Promise<void> {
  parseApplianceWorkflow(file);
}

export async function openProductionWorkspaceRun(
  organisationId: string,
  id: string,
  read: Read,
  readDefinition: (
    organisationId: string,
    scenarioId: string,
  ) => Promise<ProductionScenarioRead>,
): Promise<
  Readonly<{
    plan: ProductionWorkcells;
    procedure: CompiledProcedure | null;
    savedRun: SavedWorkspaceRun;
  }>
> {
  const snapshot = await readExactWorkspaceRun(organisationId, id, read);
  if (snapshot.kind !== "production")
    throw new Error(
      "This saved production run is invalid. Your current run is unchanged.",
    );
  const parsed = await parseProductionWorkcells(snapshot.file);
  if (parsed.kind === "rejected") throw new Error(parsed.message);
  const procedure = await verifyProductionSource(
    parsed.plan,
    organisationId,
    readDefinition,
  );
  return {
    plan: parsed.plan,
    procedure,
    savedRun: { id, name: snapshot.name, kind: snapshot.kind },
  };
}

export type SavedWorkspaceRun = Readonly<{
  id: string;
  name: string;
  kind: RunSnapshotKind;
}>;

export async function readExactWorkspaceRun(
  organisationId: string,
  id: string,
  read: Read,
): Promise<RunSnapshot> {
  if (!isRunSnapshotId(id)) throw new Error("Choose an exact saved run ID.");
  const snapshot = parseRunSnapshot(
    await read(`${workspaceRunPath(organisationId)}/${id}`),
  );
  if (snapshot === null) throw new Error("The saved run document is invalid.");
  const prepared = await prepareSnapshot(snapshot);
  if (prepared.id !== id)
    throw new Error(
      "The saved run content differs from the requested ID. Your current run is unchanged.",
    );
  return snapshot;
}

export async function verifyProductionSource(
  plan: ProductionWorkcells,
  organisationId: string,
  readDefinition: (
    organisationId: string,
    scenarioId: string,
  ) => Promise<ProductionScenarioRead>,
): Promise<CompiledProcedure | null> {
  const source = plan.source;
  if (source.kind === "shared") {
    const opened: ProductionScenarioRead = await readDefinition(
      organisationId,
      source.definition.id,
    );
    if (
      opened.kind !== "ready" ||
      opened.definition.definitionFingerprint !==
        source.definition.definitionFingerprint ||
      opened.definition.id !== source.definition.id
    )
      throw new Error(
        "The saved production scenario is stale or unavailable. Your current run is unchanged.",
      );
    return opened.procedure;
  }
  return null;
}

export function workspaceRunPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/bakery/runs`;
}

async function checkEspresso(file: string): Promise<void> {
  readEspressoRun(file);
}
export async function prepareEspressoWorkspaceRun(
  name: string,
  file: string,
): Promise<PreparedWorkspaceRun> {
  const document: unknown = JSON.parse(file);
  const snapshot = parseRunSnapshot({ name, document });
  if (
    snapshot === null ||
    (snapshot.kind !== "linea" && snapshot.kind !== "eagle")
  )
    throw new Error("Enter a run name from 1 to 80 characters.");
  return prepareSnapshot(snapshot);
}

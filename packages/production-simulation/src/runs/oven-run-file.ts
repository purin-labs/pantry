import {
  MAX_ARTIFACTS,
  openResumable,
  parseExecutionBundle,
  err,
  ok,
  type Result,
  type ExecutionBundle,
  type CompiledScenario,
  type ResumableDocument,
} from "../index.ts";
import {
  compileSavedOvenFinancier,
  compileFinancierRecipe,
} from "../recipes/bakery/financier.ts";
import { isRecord, parseJsonOrNull } from "@seams/std";
import { RunArtifactFile } from "./run-artifact-file";
import { compileBlackSesameRecipe } from "../recipes/bakery/black-sesame.ts";
import { compileGingerBlackTeaRecipe } from "../recipes/bakery/ginger-black-tea.ts";
import type { StrictUnion, Variant, VariantBy } from "@seams/type-utils";
import {
  parsePersistentCell,
  type PersistentCell,
  type PersistentPanCell,
  type PersistentEspressoCell,
  type PersistentPourOverCell,
  type PersistentRackCell,
} from "@seams/bakery-model/bakery-physics";
import { type ProductionScenario } from "@seams/bakery-model/bakery-production-scenario";
import { checkpointBody } from "@seams/bakery-model/bakery-checkpoint";

export type OvenDefinition = VariantBy<
  ProductionScenario,
  "route",
  "oven-rack"
>;
export type ArtifactContent = RunArtifactFile;
export type OvenSave = Readonly<{
  kind: "saved";
  document: ResumableDocument;
  artifacts: readonly ArtifactContent[];
}>;
export type OvenRunSource = StrictUnion<
  | Readonly<{ kind: "recipe"; name: string; scenario: CompiledScenario }>
  | Readonly<{
      kind: "native-recipe";
      name: string;
      scenario: CompiledScenario;
      cell:
        | PersistentPanCell
        | PersistentEspressoCell
        | PersistentPourOverCell
        | PersistentRackCell;
      executionBundleId: string;
    }>
  | Readonly<{
      kind: "definition";
      definition: OvenDefinition;
      scenario: CompiledScenario;
    }>
  | Readonly<{
      kind: "logistics";
      name: string;
      scenario: CompiledScenario;
      cells: readonly [PersistentRackCell, PersistentRackCell];
      bundle: ExecutionBundle;
    }>
  | Readonly<{
      kind: "snapshot";
      name: string;
      save: OvenSave;
      cells: readonly PersistentCell[];
    }>
>;

/** JSON is assembled from file slices, without one archive-sized string. */
export function exportOvenSave(save: OvenSave): Blob {
  const parts: (Blob | string)[] = [
    '{"kind":"saved","document":',
    JSON.stringify(save.document),
    ',"artifacts":[',
  ];
  for (const [index, artifact] of save.artifacts.entries()) {
    if (index > 0) parts.push(",");
    parts.push(artifact.file);
  }
  parts.push("]}");
  return new Blob(parts, { type: "application/json" });
}

/** Only native checkpoints cross back into a fresh worker. */
export async function ovenCheckpointContents(
  save: OvenSave,
): Promise<readonly Readonly<{ digest: string; content: string }>[]> {
  const contents = [];
  for (const entry of save.document.artifacts) {
    if (entry.role !== "cell-checkpoint" && entry.role !== "pending-checkpoint")
      continue;
    for (const artifact of save.artifacts)
      if (artifact.digest === entry.digest)
        contents.push({
          digest: artifact.digest,
          content: await artifact.read(),
        });
  }
  return contents;
}

export async function prepareOvenDefinition(
  definition: OvenDefinition,
): Promise<Result<VariantBy<OvenRunSource, "kind", "definition">, string>> {
  const compiled = await compileSavedOvenFinancier(definition);
  if (!compiled.ok) return err(compiled.error.subject);
  return ok({ kind: "definition", definition, scenario: compiled.value });
}

/** Check all referenced bytes, including recordings from earlier workers. */
export async function readOvenSave(
  raw: unknown,
  retained: ReadonlyMap<string, ArtifactContent>,
  name = "Saved factory",
): Promise<Result<VariantBy<OvenRunSource, "kind", "snapshot">, string>> {
  if (!isRecord(raw) || raw.kind !== "saved" || !isRecord(raw.document))
    return err("Choose a saved production run or a recipe definition.");
  const bundle = parseExecutionBundle(raw.document.bundle);
  if (bundle === null) return err("The run has no execution bundle.");
  const opened = await openResumable(raw.document, "browser", [bundle]);
  if (!opened.ok) return err(`Cannot open this run: ${opened.error.code}.`);
  if (!Array.isArray(raw.artifacts) || raw.artifacts.length > MAX_ARTIFACTS)
    return err("The run has an invalid artifact list.");
  const contents = new Map(retained);
  for (const artifact of raw.artifacts) {
    if (
      !isRecord(artifact) ||
      typeof artifact.digest !== "string" ||
      typeof artifact.content !== "string"
    )
      return err("The run contains an invalid artifact.");
    try {
      contents.set(
        artifact.digest,
        await RunArtifactFile.fromContent(artifact.digest, artifact.content),
      );
    } catch (error) {
      return err(
        error instanceof Error ? error.message : "The artifact cannot be read.",
      );
    }
  }
  const artifacts: ArtifactContent[] = [];
  for (const entry of opened.value.artifacts) {
    const artifact = contents.get(entry.digest);
    if (artifact === undefined)
      return err(`The run is missing an artifact: ${entry.digest}.`);
    if (artifact.byteLength !== entry.byteLength)
      return err(`An artifact failed its integrity check: ${entry.digest}.`);
    artifacts.push(artifact);
  }
  const save: OvenSave = { kind: "saved", document: opened.value, artifacts };
  const cells = await savedCellDefinitions(
    save.document.state.cells,
    save.artifacts,
  );
  if (!cells.ok) return cells;
  return ok({ kind: "snapshot", name, save, cells: cells.value });
}

export async function prepareFinancierRecipe(
  raw: unknown,
): Promise<Result<Variant<OvenRunSource, "recipe">, string>> {
  const compiled = await compileFinancierRecipe(raw);
  if (!compiled.ok)
    return err(`Cannot prepare this recipe: ${compiled.error.code}.`);
  return ok({
    kind: "recipe",
    name: "Hazelnut financiers: preparation to packing",
    scenario: compiled.value,
  });
}

export async function savedCellDefinitions(
  savedCells: ResumableDocument["state"]["cells"],
  artifacts: readonly ArtifactContent[],
): Promise<Result<readonly PersistentCell[], string>> {
  const cells: PersistentCell[] = [];
  for (const savedCell of savedCells) {
    const digest = savedCell.committed.checkpoint.digest;
    let checkpoint: unknown = null;
    for (const artifact of artifacts)
      if (artifact.digest === digest)
        checkpoint = parseJsonOrNull(await artifact.read());
    const body = checkpointBody(checkpoint);
    const cell = body === null ? null : parsePersistentCell(body.definition);
    if (cell === null || cell.cellId !== savedCell.id)
      return err("The checkpoint does not contain the saved cell.");
    cells.push(cell);
  }
  return ok(cells);
}

export async function prepareBlackSesameRecipe(
  raw: unknown,
): Promise<Result<Variant<OvenRunSource, "recipe">, string>> {
  const compiled = await compileBlackSesameRecipe(raw);
  if (!compiled.ok)
    return err(`Cannot prepare black sesame milk: ${compiled.error.code}.`);
  return ok({
    kind: "recipe",
    name: "Black sesame milk: concentrate to service",
    scenario: compiled.value,
  });
}

export async function prepareGingerBlackTeaRecipe(
  raw: unknown,
): Promise<Result<Variant<OvenRunSource, "recipe">, string>> {
  const compiled = await compileGingerBlackTeaRecipe(raw);
  if (!compiled.ok)
    return err(`Cannot prepare ginger black tea: ${compiled.error.code}.`);
  return ok({
    kind: "recipe",
    name: "Ginger black tea: extraction to service",
    scenario: compiled.value,
  });
}

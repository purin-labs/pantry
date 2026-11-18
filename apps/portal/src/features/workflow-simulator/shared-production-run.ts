import {
  readOvenSave,
  type OvenRunSource,
} from "@seams/production-simulation/runs/oven-run-file";
import { RunArtifactStore } from "../production-run/run-artifact-store";
import { visitSharedArtifacts } from "@seams/production-simulation/simulator/shared-artifact-batches";
import type { ResumableDocument } from "@seams/production-simulation";
import {
  readExactWorkspaceRun,
  parsePersistentSnapshot,
  readSharedRunArtifact,
} from "./workspace-runs-api";
import type { Variant } from "@seams/type-utils";

/** Opening a shared run retains verified files in browser storage for a fresh worker. */
export async function openPersistentWorkspaceRun(
  organisationId: string,
  id: string,
  read: (path: string) => Promise<unknown>,
): Promise<Variant<OvenRunSource, "snapshot">> {
  const snapshot = await readExactWorkspaceRun(organisationId, id, read);
  if (snapshot.kind !== "persistent-production")
    throw new Error("Choose a persistent production run.");
  const parsed = await parsePersistentSnapshot(snapshot);
  if (parsed.kind === "embedded") return parsed.source;
  const store = await RunArtifactStore.create();
  await visitSharedArtifacts(
    parsed.document.artifacts,
    retainSharedArtifact.bind(null, organisationId, id, read, store),
  );
  const opened = await readOvenSave(
    { kind: "saved", document: parsed.document, artifacts: [] },
    store.files,
    snapshot.name,
  );
  if (!opened.ok) throw new Error(opened.error);
  return opened.value;
}

async function retainSharedArtifact(
  organisationId: string,
  id: string,
  read: (path: string) => Promise<unknown>,
  store: RunArtifactStore,
  entry: ResumableDocument["artifacts"][number],
): Promise<void> {
  const artifact = await readSharedRunArtifact(organisationId, id, entry, read);
  await store.retain(artifact.digest, artifact.file);
}

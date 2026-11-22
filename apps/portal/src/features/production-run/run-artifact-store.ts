import {
  MAX_ARTIFACTS,
  MAX_REFERENCED_BYTES,
  type Sha256Hex,
} from "@purin-labs/production-simulation";
import {
  MAX_ENCODED_ARTIFACT_BYTES,
  RunArtifactFile,
} from "@purin-labs/production-simulation/runs/run-artifact-file";
import { releasePhysicsResultCache } from "./physics-result-directory";

// The browser releases this lock when the page closes or crashes. A later page
// removes abandoned staging directories without touching another active tab.
let pageDirectory: Promise<FileSystemDirectoryHandle> | null = null;

declare global {
  interface FileSystemDirectoryHandle {
    keys(): AsyncIterableIterator<string>;
  }
}

function openPageDirectory(): Promise<FileSystemDirectoryHandle> {
  return new Promise<FileSystemDirectoryHandle>(acquirePageDirectory);
}

function acquirePageDirectory(
  resolve: (directory: FileSystemDirectoryHandle) => void,
  reject: (error: unknown) => void,
): void {
  const id = crypto.randomUUID();
  void navigator.locks
    .request(`pantry-artifacts:${id}`, holdPageDirectory.bind(null, id, resolve))
    .catch(reject);
}

async function holdPageDirectory(
  id: string,
  resolve: (directory: FileSystemDirectoryHandle) => void,
): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const runs = await root.getDirectoryHandle("pantry-production-runs", {
    create: true,
  });
  for await (const name of runs.keys()) {
    await navigator.locks.request(
      `pantry-artifacts:${name}`,
      { ifAvailable: true },
      removeAbandonedDirectory.bind(null, runs, name),
    );
  }
  resolve(await runs.getDirectoryHandle(id, { create: true }));
  await new Promise<void>(holdUntilPageCloses);
}

async function removeAbandonedDirectory(
  root: FileSystemDirectoryHandle,
  name: string,
  lock: Lock | null,
): Promise<void> {
  if (lock === null) return;
  try {
    await root.removeEntry(name, { recursive: true });
  } catch (error) {
    // Another page can finish cleanup after this page enumerates the directory.
    if (!(error instanceof DOMException) || error.name !== "NotFoundError")
      throw error;
  }
}

function holdUntilPageCloses(): void {}

function retryPageDirectory(error: unknown): never {
  pageDirectory = null;
  throw error;
}

/** Local staging belongs to one worker. A complete exported save remains the recovery boundary. */
export class RunArtifactStore {
  private readonly retained = new Map<string, RunArtifactFile>();
  private bytes = 0;
  get files(): ReadonlyMap<string, RunArtifactFile> {
    return this.retained;
  }
  private constructor(private readonly directory: FileSystemDirectoryHandle) {}

  static async create(): Promise<RunArtifactStore> {
    pageDirectory ??= openPageDirectory().catch(retryPageDirectory);
    const runs = await pageDirectory;
    const directory = await runs.getDirectoryHandle(crypto.randomUUID(), {
      create: true,
    });
    return new RunArtifactStore(directory);
  }

  async retain(digest: Sha256Hex, encoded: Blob): Promise<void> {
    const previous = this.files.get(digest);
    if (previous !== undefined) return;
    if (
      encoded.size > MAX_ENCODED_ARTIFACT_BYTES ||
      this.bytes + encoded.size > MAX_REFERENCED_BYTES * 2 ||
      this.retained.size >= MAX_ARTIFACTS * 2
    )
      throw new Error(
        "The run exceeds the local artifact limit. Keep the last complete save.",
      );
    const file = await this.directory.getFileHandle(digest, {
      create: true,
    });
    try {
      await writeArtifact(file, encoded);
    } catch (error) {
      // The optional physics result cache can fill the quota; the save cannot wait.
      if (!isQuotaExceeded(error) || !(await releasePhysicsResultCache()))
        throw error;
      await writeArtifact(file, encoded);
    }
    const artifact = await RunArtifactFile.open(await file.getFile());
    if (artifact.digest !== digest)
      throw new Error("The stored artifact differs from the worker's receipt.");
    this.retained.set(artifact.digest, artifact);
    this.bytes += encoded.size;
  }
}

async function writeArtifact(
  file: FileSystemFileHandle,
  encoded: Blob,
): Promise<void> {
  const writer = await file.createWritable();
  try {
    await writer.write(encoded);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(discardCleanupFailure);
    throw error;
  }
}

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DOMException && error.name === "QuotaExceededError";
}

function discardCleanupFailure(): void {}

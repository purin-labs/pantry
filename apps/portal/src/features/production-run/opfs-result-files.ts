import {
  memoryResultStore,
  packedResultStore,
  tieredResultStore,
  type PhysicsResultStore,
  type ResultFiles,
} from "@seams/production-simulation/execution-entry";

/**
 * The physics result cache of one execution worker (Refactor 16, step 4):
 * memory for the session, then packs in the origin's private file system,
 * which every worker of this Portal shares. Keys name the engine build, so
 * all builds share one directory and one limit. A browser without OPFS keeps
 * the memory level only.
 */
const DIRECTORY = "satyr-physics-results";
const MEMORY_BYTES = 256 * 1024 * 1024;
const DISK_BYTES = 1024 * 1024 * 1024;

async function opfsResultFiles(): Promise<ResultFiles | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory)
    return null;
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(DIRECTORY, { create: true });
  async function file(name: string): Promise<File> {
    return (await directory.getFileHandle(name)).getFile();
  }
  return {
    async list() {
      const names: string[] = [];
      for await (const name of directory.keys()) names.push(name);
      return names;
    },
    async read(name, start, end) {
      return new Uint8Array(
        await (await file(name)).slice(start, end).arrayBuffer(),
      );
    },
    async readAll(name) {
      return new Uint8Array(await (await file(name)).arrayBuffer());
    },
    async write(name, bytes) {
      const handle = await directory.getFileHandle(name, { create: true });
      const writer = await handle.createWritable();
      try {
        await writer.write(bytes);
        await writer.close();
      } catch (error) {
        await writer.abort().catch(discardCleanupFailure);
        throw error;
      }
    },
    async remove(name) {
      await directory.removeEntry(name);
    },
  };
}

function discardCleanupFailure(): void {}

export async function workerResultStore(): Promise<PhysicsResultStore> {
  const memory = memoryResultStore(MEMORY_BYTES);
  try {
    const files = await opfsResultFiles();
    if (files === null) return memory;
    return tieredResultStore([
      memory,
      await packedResultStore(files, DISK_BYTES),
    ]);
  } catch {
    // A file system that does not open leaves the memory level.
    return memory;
  }
}

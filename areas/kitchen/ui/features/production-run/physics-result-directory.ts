/**
 * The OPFS directory of the physics result cache. The cache is optional: a
 * run that misses it computes the result again. A run artifact is not, so a
 * save that meets the storage quota takes the cache's space first.
 *
 * The name must equal `DIRECTORY` in `opfs-result-files.ts`. That file is a
 * source of the pinned execution bundle, so it cannot import this module
 * without a new bundle (`pnpm lint:physics-bundle`).
 */
const PHYSICS_RESULT_DIRECTORY = "satyr-physics-results";

/**
 * Removes every pack of the physics result cache. The directory stays, so
 * the open stores of other workers keep a valid handle; a pack that they no
 * longer find is a miss. Returns false when there was nothing to remove.
 */
export async function releasePhysicsResultCache(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory)
    return false;
  let directory: FileSystemDirectoryHandle;
  try {
    const root = await navigator.storage.getDirectory();
    directory = await root.getDirectoryHandle(PHYSICS_RESULT_DIRECTORY);
  } catch {
    return false;
  }
  const names: string[] = [];
  for await (const name of directory.keys()) names.push(name);
  for (const name of names)
    await directory.removeEntry(name).catch(discardRemovedEntry);
  return names.length > 0;
}

// Another worker can remove or replace the same pack at the same time.
function discardRemovedEntry(): void {}

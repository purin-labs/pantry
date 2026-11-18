const MAX_PARALLEL_FILES = 2;
const MAX_PARALLEL_BYTES = 4 * 1024 * 1024;

/** Bound concurrent encoding, fetch and hash work. A larger file runs alone. */
export async function visitSharedArtifacts<
  T extends Readonly<{ byteLength: number }>,
>(files: readonly T[], visit: (file: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  while (cursor < files.length) {
    const batch: Promise<void>[] = [];
    let bytes = 0;
    while (cursor < files.length && batch.length < MAX_PARALLEL_FILES) {
      const file = files[cursor];
      if (file === undefined)
        throw new Error("The shared artifact index is incomplete.");
      if (batch.length > 0 && bytes + file.byteLength > MAX_PARALLEL_BYTES)
        break;
      batch.push(visit(file));
      bytes += file.byteLength;
      cursor++;
    }
    // Settle every upload before exposing an uncertain outcome and permitting retry.
    const settled = await Promise.allSettled(batch);
    for (const result of settled)
      if (result.status === "rejected") throw result.reason;
  }
}

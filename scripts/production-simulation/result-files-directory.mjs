// A directory on disk as the files of the physics result store
// (packages/production-simulation/src/native/result-store.ts). A headless
// Node host uses it as the level after memory; the Portal uses OPFS.
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export async function directoryResultFiles(directory) {
  await mkdir(directory, { recursive: true });
  return {
    async list() {
      return (await readdir(directory)).filter(
        (name) => !name.endsWith(".tmp"),
      );
    },
    async read(name, start, end) {
      const handle = await open(join(directory, name), "r");
      try {
        const bytes = new Uint8Array(end - start);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
        return bytes.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    async readAll(name) {
      return new Uint8Array(await readFile(join(directory, name)));
    },
    async write(name, bytes) {
      // A reader never sees a part of a file.
      const temporary = join(directory, `${name}.tmp`);
      await writeFile(temporary, bytes);
      await rename(temporary, join(directory, name));
    },
    async remove(name) {
      await rm(join(directory, name), { force: true });
    },
  };
}

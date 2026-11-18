import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_STATIC_ASSET_BYTES = 25 * 1024 * 1024;

export function checkAssetSizes(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      checkAssetSizes(path);
      continue;
    }
    const bytes = statSync(path).size;
    if (bytes > MAX_STATIC_ASSET_BYTES) {
      throw new Error(
        `${path} is ${bytes} bytes; Cloudflare permits ${MAX_STATIC_ASSET_BYTES} bytes per static asset.`,
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3)
    throw new Error("Provide the asset directory to check.");
  checkAssetSizes(resolve(process.argv[2]));
}

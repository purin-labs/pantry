// Refactor 16 step 11: the model packs of a runtime bundle. The pack format
// and the index belong to packages/production-simulation/src/native/model-packs.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, posix, resolve, sep } from "node:path";
import { writePack } from "../../packages/production-simulation/src/native/model-packs.ts";

/**
 * The model files of assets.json, and the grinder models that the espresso
 * and pour-over cells read, in packs (Refactor 16, step 11): one pack for
 * each robot folder and one for each appliance with meshes, with every file
 * that its models name, and a core pack for the rest. A file that models of
 * two packs name goes to the core pack. Visuals stay out: Three.js fetches
 * and checks each GLB itself.
 */
export function modelPacks(root) {
  const manifest = JSON.parse(
    readFileSync(
      join(root, "assets/bakery-mujoco/fr10-workcell/native/assets.json"),
      "utf8",
    ),
  );
  const paths = new Set(
    Object.keys(manifest).filter((asset) => !asset.endsWith(".glb")),
  );
  paths.add("assets/bakery-mujoco/fr10-workcell/native/assets.json");
  const contents = new Map();
  for (const path of paths) {
    const sourcePath = resolve(root, path);
    if (!sourcePath.startsWith(`${root}${sep}`))
      throw new Error("Asset manifest contains a path outside the repository.");
    contents.set(path, readFileSync(sourcePath));
  }
  contents.set(
    "assets/bakery-mujoco/victoria-arduino-e1-prima/visual.sha256",
    Buffer.from(
      `${digest(
        readFileSync(
          resolve(
            root,
            "assets/bakery-mujoco/victoria-arduino-e1-prima/victoria-arduino-e1-prima.glb",
          ),
        ),
      )}\n`,
    ),
  );
  const own = (path) => {
    const robot =
      /^assets\/bakery-mujoco\/fr10-workcell\/native\/([a-z0-9-]+)\//u.exec(
        path,
      );
    if (robot) return robot[1];
    const appliance =
      /^assets\/bakery-mujoco\/([a-z0-9-]+)\/native\.xml$/u.exec(path);
    return appliance ? appliance[1] : null;
  };
  // Each model and the files that it names, relative to its folder, go to
  // the model's pack. A file that two packs claim goes to the core pack.
  const owner = new Map();
  const claim = (path, name) => {
    const known = owner.get(path);
    owner.set(path, known === undefined || known === name ? name : "core");
  };
  for (const [path, bytes] of contents) {
    const name = path.endsWith(".xml") ? own(path) : null;
    if (name === null) continue;
    const names = [...bytes.toString("utf8").matchAll(/\bfile="([^"]+)"/gu)];
    if (!path.includes("/fr10-workcell/") && names.length === 0) continue;
    claim(path, name);
    for (const [, file] of names) {
      const referenced = posix.normalize(posix.join(posix.dirname(path), file));
      if (!contents.has(referenced))
        throw new Error(`${path} names ${file}, which no pack holds.`);
      claim(referenced, name);
    }
  }
  for (const path of contents.keys()) {
    if (owner.has(path)) continue;
    // The setup files beside a robot's models belong to its pack.
    owner.set(
      path,
      path.includes("/fr10-workcell/native/") && own(path) !== null
        ? own(path)
        : "core",
    );
  }
  const groups = new Map();
  for (const [path, name] of [...owner].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ path, bytes: contents.get(path) });
  }
  return [...groups].map(([name, files]) => ({
    name,
    file: `models-${name}.pack`,
    paths: files.map(({ path }) => path),
    bytes: writePack(files),
  }));
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Extend the existing browser asset descriptor with verified, retained appliance builds.
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  runAppliance,
  runtimeModule,
} from "../production-simulation/build-execution-bundle.mjs";
import { applianceTable } from "./appliance-registry.mjs";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
export async function retainApplianceBuilds(root, current) {
  // The espresso machines of the appliance table, each with its visual.
  const machines = applianceTable(root)
    .rows.filter((row) => row.family === "espresso")
    .map((row) => row.name);
  const archive = join(root, "apps/portal/public/bakery-physics");
  const visuals = join(archive, "visuals");
  mkdirSync(visuals, { recursive: true });
  for (const machine of machines) {
    const source = join(
      root,
      "assets/bakery-mujoco",
      machine,
      `${machine}.glb`,
    );
    const destination = join(visuals, `${hash(readFileSync(source))}.glb`);
    if (!existsSync(destination)) copyFileSync(source, destination);
  }
  const builds = [];
  for (const id of readdirSync(join(archive, "bundles")).sort()) {
    const directory = join(archive, "bundles", id);
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      !existsSync(join(directory, "bundle.json"))
    )
      continue;
    const bundle = JSON.parse(
      readFileSync(join(directory, "bundle.json"), "utf8"),
    );
    if (
      bundle.id !== id ||
      hash(
        JSON.stringify({
          schemaVersion: bundle.schemaVersion,
          files: bundle.files,
        }),
      ) !== id
    )
      throw new Error("Retained bundle identity differs");
    for (const file of Object.values(bundle.files)) {
      const bytes = readFileSync(join(directory, file.file));
      if (bytes.length !== file.byteLength || hash(bytes) !== file.sha256)
        throw new Error("Retained runtime file differs");
    }
    // A bundle of descriptor schema 2 keeps its models in packs and has no
    // command line (Refactor 16, step 11); runtimeModule mounts the packs.
    const module = await runtimeModule(directory);
    const manifest = JSON.parse(
      module.FS.readFile(
        "/assets/bakery-mujoco/fr10-workcell/native/assets.json",
        { encoding: "utf8" },
      ),
    );
    for (const machine of machines) {
      const visualHash =
        manifest[`assets/bakery-mujoco/${machine}/${machine}.glb`] ??
        readPreloadedVisualHash(module, machine);
      if (!visualHash || !existsSync(join(visuals, `${visualHash}.glb`)))
        continue;
      const request = {
        schema_version: 1,
        run_id: "retain",
        attempt_id: "retain",
        initial: {
          kind: "fresh",
          appliance: machine,
          contents: { kind: "empty" },
        },
        actions: [{ kind: "inspect" }],
      };
      const result = JSON.parse(
        typeof module.callMain === "function"
          ? legacyAppliance(module, machine, request)
          : runAppliance(module, JSON.stringify(request)),
      );
      const bytes = readFileSync(join(visuals, `${visualHash}.glb`));
      if (hash(bytes) !== visualHash)
        throw new Error("Retained visual differs");
      builds.push({
        appliance: machine,
        // A continuation is an envelope since Refactor 16 step 6D.
        modelHash: (result.continuation.payload ?? result.continuation)
          .model_hash,
        execution: result.execution,
        bundle,
        visual: {
          file: `${visualHash}.glb`,
          sha256: visualHash,
          byteLength: bytes.length,
        },
      });
    }
  }
  for (const machine of machines)
    if (
      !builds.some(
        (build) =>
          build.appliance === machine && build.bundle.id === current.id,
      )
    )
      throw new Error(`Missing current ${machine} build`);
  const destination = join(
    root,
    "packages/production-simulation/src/simulator/browser-physics-asset.ts",
  );
  const bundlesById = new Map();
  bundlesById.set(current.id, current);
  for (const build of builds) bundlesById.set(build.bundle.id, build.bundle);
  const filesByKey = new Map();
  const fileKey = (descriptor) => {
    const base = `f_${descriptor.sha256.slice(0, 12)}`;
    for (let index = 0; ; index += 1) {
      const key = index === 0 ? base : `${base}_${index}`;
      const existing = filesByKey.get(key);
      if (existing === undefined) {
        filesByKey.set(key, descriptor);
        return key;
      }
      if (
        existing.file === descriptor.file &&
        existing.sha256 === descriptor.sha256 &&
        existing.byteLength === descriptor.byteLength
      )
        return key;
    }
  };
  const executionsByKey = new Map();
  const executionKey = (execution) => {
    const base = `e_${execution.runtimeHash.slice(0, 12)}`;
    for (let index = 0; ; index += 1) {
      const key = index === 0 ? base : `${base}_${index}`;
      const existing = executionsByKey.get(key);
      if (existing === undefined) {
        executionsByKey.set(key, execution);
        return key;
      }
      if (JSON.stringify(existing) === JSON.stringify(execution)) return key;
    }
  };
  const sortedBundles = [...bundlesById.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const packSetsByKey = new Map();
  const packSetKey = (packEntries) => {
    const mapped = packEntries.map(([slot, descriptor]) => [
      slot,
      fileKey(descriptor),
    ]);
    const sig = JSON.stringify(mapped);
    const base = `p_${hash(sig).slice(0, 12)}`;
    for (let index = 0; ; index += 1) {
      const key = index === 0 ? base : `${base}_${index}`;
      const existing = packSetsByKey.get(key);
      if (existing === undefined) {
        packSetsByKey.set(key, mapped);
        return key;
      }
      if (JSON.stringify(existing) === sig) return key;
    }
  };
  const bundleLines = sortedBundles.map(([id, bundle]) => {
    const entries = Object.entries(bundle.files);
    const packEntries = entries.filter(
      ([slot]) => slot === "models" || slot.startsWith("pack:"),
    );
    const headEntries = entries.filter(
      ([slot]) => slot !== "models" && !slot.startsWith("pack:"),
    );
    const fileLines = headEntries.map(
      ([slot, descriptor]) =>
        `      ${JSON.stringify(slot)}: FILES.${fileKey(descriptor)},`,
    );
    if (packEntries.length > 0) {
      fileLines.push(`      ...PACK_SETS.${packSetKey(packEntries)},`);
    }
    return [
      `  ${JSON.stringify(id)}: {`,
      `    id: ${JSON.stringify(bundle.id)},`,
      `    schemaVersion: ${JSON.stringify(bundle.schemaVersion)},`,
      "    files: {",
      ...fileLines,
      "    },",
      "  },",
    ].join("\n");
  });
  const packSetLines = [...packSetsByKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, mapped]) => {
      const entries = mapped.map(
        ([slot, fKey]) => `    ${JSON.stringify(slot)}: FILES.${fKey},`,
      );
      return [`  ${key}: {`, ...entries, "  },"].join("\n");
    });
  const buildLines = builds.map((build) =>
    [
      "  {",
      `    appliance: ${JSON.stringify(build.appliance)},`,
      `    modelHash: ${JSON.stringify(build.modelHash)},`,
      `    execution: EXECUTIONS.${executionKey(build.execution)},`,
      `    visual: FILES.${fileKey(build.visual)},`,
      `    bundle: BUNDLES[${JSON.stringify(build.bundle.id)}],`,
      "  }",
    ].join("\n"),
  );
  const filesTable = Object.fromEntries(
    [...filesByKey.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  const executionsTable = Object.fromEntries(
    [...executionsByKey.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(
    destination,
    [
      "// Generated by build-browser.mjs. Retain all referenced runtime and visual files.",
      `const FILES = ${JSON.stringify(filesTable, null, 2)} as const;`,
      `const EXECUTIONS = ${JSON.stringify(executionsTable, null, 2)} as const;`,
      ...(packSetLines.length > 0
        ? [`const PACK_SETS = {\n${packSetLines.join("\n")}\n} as const;`]
        : []),
      `const BUNDLES = {\n${bundleLines.join("\n")}\n} as const;`,
      `export const BAKERY_BROWSER_BUNDLE = BUNDLES[${JSON.stringify(current.id)}];`,
      `export const BAKERY_APPLIANCE_BUILDS = [\n${buildLines.join(",\n")}\n] as const;`,
      "",
    ].join("\n"),
  );
  return builds;
}
function readPreloadedVisualHash(module, machine) {
  try {
    return module.FS.readFile(
      `/assets/bakery-mujoco/${machine}/visual.sha256`,
      {
        encoding: "utf8",
      },
    ).trim();
  } catch {
    return undefined;
  }
}
/** One appliance request through the command line of a bundle before step 11. */
function legacyAppliance(module, machine, request) {
  module.FS.writeFile("/retain-request.json", JSON.stringify(request));
  const destination = `/retain-${machine}.json`;
  if (
    module.callMain([
      "--root",
      "/",
      "--output",
      destination,
      "appliance",
      "/retain-request.json",
    ]) !== 0
  )
    throw new Error(`Cannot inspect retained ${machine}`);
  return module.FS.readFile(destination, { encoding: "utf8" });
}

#!/usr/bin/env node
// Checks that a Portal build holds each Kitchen physics bundle that a manifest
// names, with the bytes of its hash (Refactor 16, step 9B). A production
// upload without them ships a Portal with no engine, and no saved run can
// resume, so scripts/run-worker.mjs refuses it.
//
// The bundles that the build must hold:
// - the pins: the runtime bundle of browser-physics-asset.ts, the runtime
//   bundles of its retained appliance builds, and the execution bundle of
//   execution-manifest.generated.ts;
// - each bundle folder in apps/portal/public/bakery-physics (the files in
//   git and the fetched files), and each folder or file under it that
//   repo-binaries.json names (the files in R2);
// - the runtime bundle that each of those execution bundles names.
// A runtime bundle's id is the SHA-256 of its descriptor, and the descriptor
// gives the SHA-256 of each file. An execution manifest gives the SHA-256 of
// its engine and of its runtime's files. A visual is named by its SHA-256.
//
// Usage: node scripts/check-physics-dist.mjs [--binaries <repo-binaries.json>] <Portal dist>
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { manifestEntries, readManifest } from "./repo-binaries.mjs";

const root = resolve(import.meta.dirname, "..");
const PUBLIC = "apps/portal/public/";
const PHYSICS = "bakery-physics";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const folders = (path) =>
  existsSync(path)
    ? readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];

/** The problems of the Kitchen physics files of a Portal build; none when it can ship. */
export async function physicsDistProblems(
  dist,
  { binaries = join(root, "repo-binaries.json") } = {},
) {
  const { BAKERY_BROWSER_BUNDLE, BAKERY_APPLIANCE_BUILDS } = await import(
    pathToFileURL(
      join(
        root,
        "packages/production-simulation/src/simulator/browser-physics-asset.ts",
      ),
    ).href
  );
  const { PRODUCTION_EXECUTION_MANIFEST } = await import(
    pathToFileURL(
      join(
        root,
        "packages/production-simulation/src/execution-manifest.generated.ts",
      ),
    ).href
  );
  const problems = [];
  // Each expected file (path under dist) with its SHA-256, and who names it.
  const expected = new Map();
  const expect = (path, sha, byteLength, source) => {
    const known = expected.get(path);
    if (known !== undefined && known.sha256 !== sha)
      problems.push(
        `${path}: ${source} gives SHA-256 ${sha}, and ${known.source} gives ${known.sha256}.`,
      );
    else if (known === undefined)
      expected.set(path, { sha256: sha, byteLength, source });
  };
  const runtimes = new Map(); // id -> who names it
  const executions = new Map();
  const name = (map, id, source) => {
    if (!map.has(id)) map.set(id, source);
  };

  const pins = "browser-physics-asset.ts";
  name(runtimes, BAKERY_BROWSER_BUNDLE.id, pins);
  for (const file of Object.values(BAKERY_BROWSER_BUNDLE.files))
    expect(
      `${PHYSICS}/bundles/${BAKERY_BROWSER_BUNDLE.id}/${file.file}`,
      file.sha256,
      file.byteLength,
      pins,
    );
  for (const build of BAKERY_APPLIANCE_BUILDS) {
    name(runtimes, build.bundle.id, `${pins} (${build.appliance})`);
    for (const file of Object.values(build.bundle.files))
      expect(
        `${PHYSICS}/bundles/${build.bundle.id}/${file.file}`,
        file.sha256,
        file.byteLength,
        pins,
      );
  }
  name(
    executions,
    PRODUCTION_EXECUTION_MANIFEST.bundle.id,
    "execution-manifest.generated.ts",
  );

  const source = join(root, PUBLIC, PHYSICS);
  for (const id of folders(join(source, "bundles")))
    name(runtimes, id, `${PUBLIC}${PHYSICS}/bundles`);
  for (const id of folders(join(source, "executions")))
    name(executions, id, `${PUBLIC}${PHYSICS}/executions`);
  for (const [path, entry] of manifestEntries(readManifest(binaries))) {
    if (!path.startsWith(`${PUBLIC}${PHYSICS}/`)) continue;
    const served = path.slice(PUBLIC.length);
    expect(served, entry.sha256, entry.bytes, "repo-binaries.json");
    const [, kind, id] = served.split("/");
    if (kind === "bundles") name(runtimes, id, "repo-binaries.json");
    if (kind === "executions") name(executions, id, "repo-binaries.json");
  }

  for (const [id, by] of executions) {
    const path = `${PHYSICS}/executions/${id}/execution.json`;
    if (!existsSync(join(dist, path))) {
      problems.push(`${path} is missing (${by} names execution bundle ${id}).`);
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(dist, path), "utf8"));
    if (manifest.bundle?.id !== id)
      problems.push(`${path} names bundle ${manifest.bundle?.id}, not ${id}.`);
    expect(
      `${PHYSICS}/executions/${id}/${manifest.engine.file}`,
      manifest.engine.sha256,
      manifest.engine.byteLength,
      path,
    );
    name(runtimes, manifest.runtime.id, path);
    for (const file of manifest.runtime.files)
      expect(
        `${PHYSICS}/bundles/${manifest.runtime.id}/${file.file}`,
        file.sha256,
        file.byteLength,
        path,
      );
  }
  for (const [id, by] of runtimes) {
    const path = `${PHYSICS}/bundles/${id}/bundle.json`;
    if (!existsSync(join(dist, path))) {
      problems.push(`${path} is missing (${by} names runtime bundle ${id}).`);
      continue;
    }
    const { id: named, ...identity } = JSON.parse(
      readFileSync(join(dist, path), "utf8"),
    );
    if (named !== id || sha256(JSON.stringify(identity)) !== id)
      problems.push(`${path} is not the descriptor of bundle ${id}.`);
    for (const file of Object.values(identity.files ?? {}))
      expect(
        `${PHYSICS}/bundles/${id}/${file.file}`,
        file.sha256,
        file.byteLength,
        path,
      );
  }
  for (const file of readdirSync(join(source, "visuals")))
    expect(
      `${PHYSICS}/visuals/${file}`,
      file.replace(/\.[a-z]+$/u, ""),
      undefined,
      `${PUBLIC}${PHYSICS}/visuals`,
    );

  for (const [path, { sha256: want, byteLength, source: by }] of expected) {
    const absolute = join(dist, path);
    if (!existsSync(absolute)) {
      problems.push(`${path} is missing (${by} names it).`);
      continue;
    }
    const bytes = readFileSync(absolute);
    if (
      sha256(bytes) !== want ||
      (byteLength !== undefined && bytes.length !== byteLength)
    )
      problems.push(`${path} differs from its SHA-256 in ${by}.`);
  }
  return {
    problems,
    runtimes: runtimes.size,
    executions: executions.size,
    files: expected.size,
  };
}

export async function requirePhysicsBundles(dist, options) {
  const { problems } = await physicsDistProblems(dist, options);
  if (problems.length > 0)
    throw new Error(
      `The Portal build lacks Kitchen physics files or holds changed ones, so no saved run could resume on them:\n  ${problems.join("\n  ")}\nRun \`node scripts/repo-binaries.mjs fetch ${PUBLIC}${PHYSICS}\`, then \`pnpm portal:build\`, and deploy again.`,
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--binaries");
  const binaries = flag >= 0 ? resolve(args[flag + 1]) : undefined;
  const rest =
    flag < 0
      ? args
      : args.filter((_, index) => index !== flag && index !== flag + 1);
  if (rest.length !== 1)
    throw new Error(
      "Usage: node scripts/check-physics-dist.mjs [--binaries <repo-binaries.json>] <Portal dist>",
    );
  const result = await physicsDistProblems(resolve(rest[0]), { binaries });
  for (const problem of result.problems) console.error(`refused ${problem}`);
  if (result.problems.length > 0) process.exit(1);
  console.log(
    `ok      ${result.runtimes} runtime bundles, ${result.executions} execution bundles and ${result.files} files match their hashes`,
  );
}

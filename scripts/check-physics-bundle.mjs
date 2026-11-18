#!/usr/bin/env node
// Fails when the engine source and the pinned physics bundle disagree
// (Refactor 16, step 1).
//
// crates/bakery-native/build.rs hashes the controller files, in the order of
// its `controller_files` list, into BAKERY_CONTROLLER_SOURCE_HASH. A browser
// build records that hash in each execution bundle. The Portal starts a new run
// on the execution bundle that execution-manifest.generated.ts pins, and that
// bundle drives the runtime bundle that browser-physics-asset.ts pins. A Rust
// edit without a rebuild leaves the pinned bundle on old code, and no other
// check sees it. This check needs no MuJoCo and no Rust toolchain.
//
// It also checks that each runtime bundle that an execution manifest names is
// present, with each file at its recorded byte length. It hashes the files of
// the pinned runtime bundle only: all retained bundles together are too large.
//
// Last, it builds the execution bundle again from the TypeScript sources of the
// execution worker and compares it with the pin (build-execution-bundle.mjs
// --check, about 0.3 s). A TypeScript edit after the build leaves a stale pin,
// and before this check only the bakery CI job saw it.
//
// It also keeps in git each bundle that a Platform test fixture names, because
// CI cannot fetch the bundles that repo-binaries.json keeps in R2.
//
//   node scripts/check-physics-bundle.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE = "crates/bakery-native";
const PHYSICS = "apps/portal/public/bakery-physics";
const EXECUTION_PIN =
  "packages/production-simulation/src/execution-manifest.generated.ts";
const RUNTIME_PIN =
  "packages/production-simulation/src/simulator/browser-physics-asset.ts";
const REBUILD = [
  "Rebuild the bundles from the current source:",
  "  node scripts/bakery-robots/build-browser.mjs <MuJoCo source> <new dir> --install-portal",
  `  node scripts/production-simulation/build-execution-bundle.mjs ${PHYSICS}/bundles/<new runtime id> --install-portal`,
  "Then commit the new bundle directories and pins (docs/evidence/bakery-browser-asset-bundles.md).",
].join("\n");

const errors = [];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message) {
  console.error(`physics bundle: ${message}`);
  process.exit(1);
}

/** The controller files in build.rs order. The order is part of the hash. */
function controllerFiles() {
  const source = readFileSync(join(root, CRATE, "build.rs"), "utf8");
  const list = /let\s+controller_files\s*=\s*\[([^\]]*)\]/u.exec(source);
  if (list === null)
    fail(
      `cannot find "let controller_files = [...]" in ${CRATE}/build.rs. Update this check to read the new list.`,
    );
  const files = [...list[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  const rest = list[1].replace(/"[^"]*"/gu, "").replace(/\/\/[^\n]*/gu, "");
  if (files.length === 0 || /[^\s,]/u.test(rest))
    fail(
      `cannot parse the controller_files list in ${CRATE}/build.rs: it must hold only string literals.`,
    );
  return files;
}

/** Every `.rs` file under `directory`, as a path relative to the crate. */
function rustSources(directory, relative) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }))
    if (entry.isDirectory())
      found.push(
        ...rustSources(
          join(directory, entry.name),
          `${relative}/${entry.name}`,
        ),
      );
    else if (entry.name.endsWith(".rs"))
      found.push(`${relative}/${entry.name}`);
  return found;
}

function sourceHash(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    const path = join(root, CRATE, file);
    if (!existsSync(path))
      fail(
        `${CRATE}/build.rs names ${file}, but ${CRATE}/${file} does not exist.`,
      );
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

const { PRODUCTION_EXECUTION_MANIFEST: pinned } = await import(
  pathToFileURL(join(root, EXECUTION_PIN)).href
);
const { BAKERY_BROWSER_BUNDLE: runtimePin } = await import(
  pathToFileURL(join(root, RUNTIME_PIN)).href
);

// 1. The pinned execution bundle drives the pinned runtime bundle.
if (pinned.runtime.id !== runtimePin.id)
  errors.push(
    `${EXECUTION_PIN} names runtime bundle ${pinned.runtime.id}, but ${RUNTIME_PIN} pins ${runtimePin.id}.`,
  );

// 2. The pinned execution bundle is the retained one that the Portal serves.
const pinnedPath = join(
  PHYSICS,
  "executions",
  pinned.bundle.id,
  "execution.json",
);
if (!existsSync(join(root, pinnedPath)))
  errors.push(`${pinnedPath} is missing. The Portal cannot start a new run.`);
else if (
  JSON.stringify(JSON.parse(readFileSync(join(root, pinnedPath), "utf8"))) !==
  JSON.stringify(pinned)
)
  errors.push(`${pinnedPath} differs from ${EXECUTION_PIN}.`);

// 3. The engine source is the source that the pinned bundle was built from.
const files = controllerFiles();
// build.rs hashes the command line and the browser interface apart from the
// controller. Every other source file must be in the list, or an edit to it
// makes no new engine identity.
const OUTSIDE_CONTROLLER = new Set(["src/main.rs", "src/browser.rs"]);
for (const file of rustSources(join(root, CRATE, "src"), "src"))
  if (!OUTSIDE_CONTROLLER.has(file) && !files.includes(file))
    errors.push(
      `${CRATE}/${file} is not in the controller_files list of ${CRATE}/build.rs. Add it, so that an edit to it changes the engine identity.`,
    );
// Refactor 16 step 6: `unsafe` lives in the MuJoCo boundary (`mj`) and the
// browser's C interface. The crate roots deny it; only these two may allow it.
const UNSAFE_MODULES = new Set(["mj", "browser"]);
for (const file of [...files, ...OUTSIDE_CONTROLLER]) {
  const text = readFileSync(join(root, CRATE, file), "utf8");
  for (const match of text.matchAll(
    /#\[allow\([^)]*unsafe_code[^)]*\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?mod\s+(\w+)|#!?\[allow\([^)]*unsafe_code/gu,
  ))
    if (match[1] === undefined || !UNSAFE_MODULES.has(match[1]))
      errors.push(
        `${CRATE}/${file} allows unsafe_code outside the modules mj and browser. Move the unsafe code into src/mj.rs.`,
      );
}
const source = sourceHash(files);
if (source !== pinned.bundle.controllerSourceHash)
  errors.push(
    [
      `the engine source does not match the pinned execution bundle ${pinned.bundle.id.slice(0, 12)}.`,
      `  source hash of the ${files.length} controller files in ${CRATE}/build.rs: ${source}`,
      `  controllerSourceHash in ${EXECUTION_PIN}: ${pinned.bundle.controllerSourceHash}`,
      "A controller file changed with no rebuild of the browser bundle.",
    ].join("\n"),
  );

// 4. Each runtime bundle that an execution manifest names is present and whole.
const executions = readdirSync(join(root, PHYSICS, "executions"));
const named = new Map();
for (const id of executions) {
  const path = join(PHYSICS, "executions", id, "execution.json");
  if (!existsSync(join(root, path))) {
    errors.push(`${path} is missing.`);
    continue;
  }
  const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
  if (manifest.bundle?.id !== id)
    errors.push(
      `${path} names bundle ${manifest.bundle?.id}, not its directory ${id}.`,
    );
  const runtime = manifest.runtime;
  if (!named.has(runtime.id))
    named.set(runtime.id, { files: runtime.files, by: path });
}
let hashed = 0;
for (const [id, { files: recorded, by }] of named) {
  const directory = join(PHYSICS, "bundles", id);
  if (!existsSync(join(root, directory))) {
    errors.push(
      `${by} names runtime bundle ${id}, but ${directory} is missing.`,
    );
    continue;
  }
  for (const { file, sha256: digest, byteLength } of recorded) {
    const path = join(directory, file);
    if (!existsSync(join(root, path))) {
      errors.push(`${path} is missing (named by ${by}).`);
      continue;
    }
    const size = statSync(join(root, path)).size;
    if (size !== byteLength) {
      errors.push(`${path} has ${size} bytes; ${by} records ${byteLength}.`);
      continue;
    }
    if (id === runtimePin.id) {
      hashed += 1;
      const actual = sha256(readFileSync(join(root, path)));
      if (actual !== digest)
        errors.push(`${path} has SHA-256 ${actual}; ${by} records ${digest}.`);
    }
  }
}
if (!named.has(runtimePin.id))
  errors.push(
    `no execution manifest names the pinned runtime bundle ${runtimePin.id}.`,
  );

// 5. The pinned execution bundle is the one that the current sources build.
if (errors.length === 0)
  try {
    execFileSync(
      process.execPath,
      [
        join(root, "scripts/production-simulation/build-execution-bundle.mjs"),
        join(root, PHYSICS, "bundles", runtimePin.id),
        "--check",
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const detail = String(error.stderr ?? error.message)
      .split("\n")
      .find((line) => line.startsWith("Error:"));
    errors.push(
      `the execution worker sources do not build the pinned execution bundle ${pinned.bundle.id.slice(0, 12)}. ${detail ?? "build-execution-bundle.mjs --check failed."}`,
    );
  }

// 6. A bundle that a Platform test fixture names stays in git. The edge
// journeys read it from the Portal build, and CI has no copy of the bundles
// that repo-binaries.json keeps in R2.
const FIXTURES = "services/platform/tests/fixtures";
const inR2 = new Set(
  Object.keys(
    JSON.parse(readFileSync(join(root, "repo-binaries.json"), "utf8"))
      .folders ?? {},
  ).map((folder) => folder.replace(/\/$/u, "")),
);
const executionIds = new Set(executions);
for (const folder of inR2)
  if (folder.startsWith(`${PHYSICS}/executions/`))
    executionIds.add(folder.slice(`${PHYSICS}/executions/`.length));
const fixtureErrors = [];
let fixtureBundles = 0;
for (const file of readdirSync(join(root, FIXTURES), { recursive: true })) {
  if (!file.endsWith(".json")) continue;
  const text = readFileSync(join(root, FIXTURES, file), "utf8");
  for (const id of new Set(text.match(/[0-9a-f]{64}/gu) ?? [])) {
    if (!executionIds.has(id)) continue;
    fixtureBundles += 1;
    const execution = `${PHYSICS}/executions/${id}`;
    if (inR2.has(execution)) {
      fixtureErrors.push(
        `${FIXTURES}/${file} names execution bundle ${id.slice(0, 12)}, which repo-binaries.json keeps in R2. Keep it in git.`,
      );
      continue;
    }
    const runtime = JSON.parse(
      readFileSync(join(root, execution, "execution.json"), "utf8"),
    ).runtime.id;
    if (inR2.has(`${PHYSICS}/bundles/${runtime}`))
      fixtureErrors.push(
        `${FIXTURES}/${file} names execution bundle ${id.slice(0, 12)}; its runtime bundle ${runtime.slice(0, 12)} is kept in R2. Keep it in git.`,
      );
  }
}

if (errors.length > 0 || fixtureErrors.length > 0) {
  for (const error of [...errors, ...fixtureErrors])
    console.error(`physics bundle: ${error}`);
  if (errors.length > 0) console.error(REBUILD);
  process.exit(1);
}
console.log(
  `physics bundle: source ${source.slice(0, 12)} matches execution bundle ${pinned.bundle.id.slice(0, 12)} on runtime ${runtimePin.id.slice(0, 12)}; ${named.size} named runtime bundles present, ${hashed} pinned files hashed, ${fixtureBundles} fixture bundles in git`,
);

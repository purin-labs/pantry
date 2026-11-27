// Plan 70B: builds a retained execution bundle for the browser backend. The
// worker, engine, host loop, adapter and the controller's loader are compiled
// into one module and named, together with the controller runtime bundle
// they drive, by one identity.
//
//   node build-execution-bundle.mjs RUNTIME_BUNDLE RETAINED_DIRECTORY
//   node build-execution-bundle.mjs RUNTIME_BUNDLE --install-portal
//   node build-execution-bundle.mjs RUNTIME_BUNDLE --check
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CELL_CHECKPOINT_SCHEMA_VERSION,
  HOST_PROTOCOL_VERSION,
  executionManifest,
} from "../../packages/production-simulation/src/index.ts";
import { mountPack } from "../../packages/production-simulation/src/native/model-packs.ts";
import { exchangeNow } from "../../packages/production-simulation/src/native/wasm-transport.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const ENGINE_FILE = "production-engine.mjs";
export const MANIFEST_FILE = "execution.json";
const PORTAL_RETAINED = join(
  root,
  "apps/portal/public/bakery-physics/executions",
);
const PORTAL_PIN = join(
  root,
  "packages/production-simulation/src/execution-manifest.generated.ts",
);

// The Portal's own bundler compiles the engine, so both use one toolchain.
const portal = createRequire(join(root, "apps/portal/package.json"));
const { build } = createRequire(portal.resolve("vite"))("esbuild");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A fresh instance of a runtime bundle's module: one worker's worth. A
 * bundle of descriptor schema 2 keeps its models in packs (model-packs.ts);
 * a Node host checks and mounts every pack before the first command. An
 * earlier bundle loads its one data file itself.
 */
export async function runtimeModule(directory) {
  const descriptor = JSON.parse(
    readFileSync(join(directory, "bundle.json"), "utf8"),
  );
  const { default: createBakeryModule } = await import(
    pathToFileURL(join(directory, "bakery-native.js")).href
  );
  const module = await createBakeryModule({
    locateFile(file) {
      return join(directory, file);
    },
  });
  if (descriptor.schemaVersion >= 2)
    for (const [key, file] of Object.entries(descriptor.files))
      if (key.startsWith("pack:"))
        mountPack(module.FS, checkedFile(directory, file));
  return module;
}

/** The bytes of a bundle file, when they are what its descriptor names. */
function checkedFile(directory, { file, sha256: digest, byteLength }) {
  const bytes = readFileSync(join(directory, file));
  if (bytes.length !== byteLength || sha256(bytes) !== digest)
    throw new Error(`Runtime file ${file} is not what its bundle names`);
  return bytes;
}

/** One host command on a runtime module; its reply. */
export function hostCommand(module, command) {
  const encoder = new TextEncoder();
  return JSON.parse(
    exchangeNow(
      module,
      { encode: encoder.encode.bind(encoder), decode: decodeText },
      JSON.stringify(command),
    ),
  );
}

function legacyDefinition(module, cell, definition) {
  const { fixture = "rack", ...options } = definition;
  const flag = (name) =>
    `--${name.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}`;
  const mode =
    fixture === "espresso"
      ? "prepare-espresso-cell"
      : fixture === "pour-over"
        ? "prepare-pour-over-cell"
        : "prepare-cell";
  const args = [mode, "--cell", cell];
  if (mode === "prepare-cell") args.push("--fixture", fixture);
  for (const [name, value] of Object.entries(options))
    args.push(flag(name), String(value));
  if (module.callMain(["--root", "/", "--output", "/cell.json", ...args]) !== 0)
    throw new Error(`The bundle refused the definition ${args.join(" ")}`);
  const text = module.FS.readFile("/cell.json", { encoding: "utf8" });
  module.FS.unlink("/cell.json");
  return JSON.parse(text);
}

/** One appliance request on a runtime module: the recording file. */
export function runAppliance(module, file) {
  const reply = hostCommand(module, {
    op: "appliance",
    request: JSON.parse(file),
  });
  if (reply.kind !== "appliance")
    throw new Error(`The appliance run failed: ${JSON.stringify(reply)}`);
  return reply.file;
}

function decodeText(bytes) {
  return new TextDecoder().decode(bytes);
}

/** The runtime's files as its own bundle descriptor lists them, verified. */
export function runtimeFiles(directory) {
  const descriptor = JSON.parse(
    readFileSync(join(directory, "bundle.json"), "utf8"),
  );
  const files = [];
  for (const file of Object.values(descriptor.files)) {
    checkedFile(directory, file);
    files.push({
      file: file.file,
      sha256: file.sha256,
      byteLength: file.byteLength,
    });
  }
  return { id: descriptor.id, files };
}

/** The UR5e oven-and-rack cell of the oven journeys. */
export const OVEN_CELL = Object.freeze({
  fixture: "oven-rack",
  robot: "universal-robots-ur5e",
});

/** The Plan 24 MBCO-4ME spanner-oven-and-rack cell. */
export const SPANNER_OVEN_CELL = Object.freeze({
  fixture: "spanner-oven-rack",
  robot: "fairino-fr10",
});

/**
 * A cell definition as this runtime pins it to its own build, through the
 * host's `define` command. `definition` holds the fixture and its options
 * (`{ fixture: "oven-rack", robot: "universal-robots-ur5e" }`); the default
 * is the FR10 rack cell.
 */
export async function prepareCell(directory, cell, definition = {}) {
  return defineCell(await runtimeModule(directory), cell, definition);
}

/**
 * A cell definition from a module that is already open. A bundle from
 * before Refactor 16 step 11 keeps its own command line (`callMain`), and
 * one from before step 5 has no `define` command, so an old bundle defines
 * its cell through its command line.
 */
export function defineCell(module, cell, definition = {}) {
  if (typeof module.callMain === "function")
    return legacyDefinition(module, cell, definition);
  const fixture = definition.fixture ?? "rack";
  const reply = hostCommand(module, {
    op: "define",
    definition:
      fixture === "rack" ||
      fixture === "oven-rack" ||
      fixture === "spanner-oven-rack" ||
      fixture === "pan-staging"
        ? { fixture, cell, robot: "fairino-fr10", ...definition }
        : { fixture, cell, ...definition },
  });
  if (reply.kind !== "defined")
    throw new Error(
      `The host refused the definition: ${JSON.stringify(reply)}`,
    );
  return reply.definition;
}

/**
 * Builds the bundle into `retained/<bundle id>/`. `banner` stands for any
 * change to the engine build: it yields another engine and another identity.
 */
async function compile(runtimeDirectory, banner) {
  const compiled = await build({
    absWorkingDir: root,
    entryPoints: [
      "areas/kitchen/ui/features/production-run/execution-worker.ts",
    ],
    // The worker carries the loader of the runtime it is built against.
    alias: {
      "bakery-runtime-module": join(runtimeDirectory, "bakery-native.js"),
    },
    // The loader's Node branch never runs in a worker.
    external: ["module", "node:*", "fs", "path", "url", "crypto"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
    legalComments: "none",
    // Source-path comments must not make identical runtime bytes name a
    // different engine when built from a staging directory or Portal assets.
    minifyWhitespace: true,
    banner: banner === undefined ? {} : { js: banner },
    write: false,
    logLevel: "warning",
  });
  return Buffer.from(compiled.outputFiles[0].contents);
}

async function describe(runtimeDirectory, banner) {
  const engineBytes = await compile(runtimeDirectory, banner);
  const definition = await prepareCell(runtimeDirectory, "identity");
  const manifest = await executionManifest(
    {
      backend: "browser",
      protocolVersion: HOST_PROTOCOL_VERSION,
      checkpointSchemaVersion: CELL_CHECKPOINT_SCHEMA_VERSION,
      controllerSourceHash: definition.execution.controllerSourceHash,
      controllerHash: definition.execution.controllerHash,
      runtimeHash: definition.execution.runtimeHash,
    },
    {
      file: ENGINE_FILE,
      sha256: sha256(engineBytes),
      byteLength: engineBytes.length,
    },
    runtimeFiles(runtimeDirectory),
  );
  return { manifest, engineBytes };
}

export async function buildExecutionBundle(runtimeDirectory, retained, banner) {
  const { manifest, engineBytes } = await describe(
    resolve(runtimeDirectory),
    banner,
  );
  const directory = join(retained, manifest.bundle.id);
  // A retained bundle is immutable: the same build writes the same bytes.
  mkdirSync(directory, { recursive: true });
  for (const [file, bytes] of [
    [ENGINE_FILE, engineBytes],
    [MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`],
  ]) {
    const path = join(directory, file);
    if (!existsSync(path)) writeFileSync(path, bytes);
    else if (sha256(readFileSync(path)) !== sha256(bytes))
      throw new Error(`Retained file ${path} differs from this build`);
  }
  return { manifest, directory };
}

function pinned() {
  const source = existsSync(PORTAL_PIN) ? readFileSync(PORTAL_PIN, "utf8") : "";
  // The first identity in the file is the bundle's, formatted or not.
  return /"?id"?: "([a-f0-9]{64})"/u.exec(source)?.[1] ?? null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4)
    throw new Error(
      "Provide the runtime bundle directory, then the retained bundles directory, --install-portal or --check.",
    );
  const runtimeDirectory = resolve(process.argv[2]);
  const mode = process.argv[3];
  if (mode === "--check") {
    // The Portal's pinned bundle must be this source built on this runtime.
    const { manifest } = await describe(runtimeDirectory);
    if (pinned() !== manifest.bundle.id)
      throw new Error(
        `The Portal pins ${pinned()}, and this source builds ${manifest.bundle.id}. Rebuild with --install-portal.`,
      );
    console.log(`Execution bundle is current: ${manifest.bundle.id}`);
  } else {
    const built = await buildExecutionBundle(
      runtimeDirectory,
      mode === "--install-portal" ? PORTAL_RETAINED : resolve(mode),
    );
    if (mode === "--install-portal")
      writeFileSync(
        PORTAL_PIN,
        `// Generated by build-execution-bundle.mjs from the engine source and the\n// runtime bundle named below. Rebuild it when either changes.\nexport const PRODUCTION_EXECUTION_MANIFEST = ${JSON.stringify(built.manifest, null, 2)} as const;\n`,
      );
    console.log(`Execution bundle: ${built.directory}`);
  }
}

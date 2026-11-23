import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { retainApplianceBuilds } from "./retain-appliance-builds.mjs";
import { checkAssetSizes } from "./check-asset-sizes.mjs";
import { modelPacks } from "./model-packs.mjs";
import {
  cPrefixMapFlags,
  localFolders,
  refuseLocalPaths,
  rustRemapFlags,
} from "./build-paths.mjs";
import {
  MODEL_INDEX_FILE,
  MODEL_INDEX_FORMAT,
} from "../../packages/production-simulation/src/native/model-packs.ts";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const manifestPath = join(
  root,
  "assets/bakery-mujoco/fr10-workcell/native/assets.json",
);
const source = resolve(process.argv[2] ?? "");
const output = resolve(process.argv[3] ?? "");
const installPortal = process.argv[4] === "--install-portal";
const emsdk = process.env.EMSDK;

if (
  (process.argv.length !== 4 && process.argv.length !== 5) ||
  (process.argv.length === 5 && !installPortal) ||
  !emsdk ||
  existsSync(output)
) {
  throw new Error(
    "Activate Emscripten 4.0.10, then run: node build-browser.mjs MUJOCO_SOURCE NEW_OUTPUT_DIRECTORY [--install-portal]",
  );
}

const revision = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (revision !== "ac60eae30fa7e0d31315c38d9476752fb81be67e") {
  throw new Error("MuJoCo source must be pinned to 4.0.0.");
}
const compilerVersion = execFileSync("emcc", ["--version"], {
  encoding: "utf8",
});
if (!compilerVersion.includes("4.0.10")) {
  throw new Error("The browser build requires Emscripten 4.0.10.");
}

const staging = mkdtempSync(join(tmpdir(), "bakery-browser-build-"));
try {
  const build = join(staging, "build");
  // `__FILE__` in the MuJoCo sources and in the libraries that CMake fetches
  // names a fixed folder, not this machine's (Refactor 16, step 9A).
  const prefixMap = cPrefixMapFlags({ mujoco: source, "mujoco-build": build });
  execFileSync(
    "emcmake",
    [
      "cmake",
      "-S",
      source,
      "-B",
      build,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DMUJOCO_ENABLE_LTO=ON",
      "-DMUJOCO_WASM_THREADS=OFF",
      "-DMUJOCO_BUILD_TESTS=OFF",
      "-DMUJOCO_BUILD_EXAMPLES=OFF",
      "-DMUJOCO_BUILD_SIMULATE=OFF",
      `-DCMAKE_C_FLAGS=-fwasm-exceptions -msimd128 ${prefixMap}`,
      `-DCMAKE_CXX_FLAGS=-fwasm-exceptions -msimd128 ${prefixMap}`,
    ],
    { stdio: "inherit" },
  );
  execFileSync("cmake", ["--build", build, "--target", "mujoco", "-j", "8"], {
    stdio: "inherit",
  });

  const packs = modelPacks(root);
  const linkFlags = [
    "-sALLOW_MEMORY_GROWTH=1",
    "-sINITIAL_MEMORY=33554432",
    "-sMAXIMUM_MEMORY=536870912",
    // Emscripten's default stack is 64 KiB; the native main thread has
    // 8 MiB. A rack cycle program (loading, retrieval and racking in one
    // host call chain) overflowed 64 KiB after Refactor 16 step 7 added the
    // limit measurements to each operation, so the module gets 1 MiB.
    "-sSTACK_SIZE=1048576",
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sINVOKE_RUN=0",
    // Every host speaks only the protocol of crates/bakery-native/src/browser.rs.
    // The module has no command line and exports no `callMain` (Refactor 16,
    // step 11). The host writes the model packs into `FS`.
    "-sEXPORTED_RUNTIME_METHODS=FS,HEAPU8",
    "-sEXPORTED_FUNCTIONS=_bakery_alloc,_bakery_free,_bakery_cell_command,_bakery_response_pointer,_bakery_response_length",
    "-sEXPORT_NAME=createBakeryModule",
  ];
  // SIMD and link-time optimization: 12-17 % less time for each step and the
  // same samples (docs/evidence/refactor-16/step-2.md). Rust LTO is in
  // crates/bakery-native/Cargo.toml, so the engine identity includes it.
  // The path remaps write the home folder (the Cargo registry and the Rust
  // toolchain) as "~" and the workspace as "." (Refactor 16, step 9A). The
  // flags go one by one, so that a path with a space stays one flag.
  const rustFlags = [
    ...["target-feature=+simd128", "link-arg=-msimd128", "link-arg=-flto"],
    ...linkFlags.map((flag) => `link-arg=${flag}`),
  ]
    .flatMap((flag) => ["-C", flag])
    .concat(rustRemapFlags(root))
    .join("\x1f");
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--target",
      "wasm32-unknown-emscripten",
      "--manifest-path",
      "crates/bakery-native/Cargo.toml",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        MUJOCO_DIR: source,
        MUJOCO_STATIC_DIR: join(build, "lib"),
        CARGO_TARGET_WASM32_UNKNOWN_EMSCRIPTEN_LINKER: "emcc",
        CARGO_ENCODED_RUSTFLAGS: rustFlags,
      },
      stdio: "inherit",
    },
  );

  const compiled = join(
    root,
    "crates/bakery-native/target/wasm32-unknown-emscripten/release",
  );
  mkdirSync(output);
  writeFileSync(
    join(output, "bakery-native.js"),
    readFileSync(join(compiled, "bakery-native.js"), "utf8").replace(
      /[ \t]+$/gm,
      "",
    ),
  );
  copyFileSync(
    join(compiled, "bakery_native.wasm"),
    join(output, "bakery_native.wasm"),
  );
  const files = {
    module: describeAsset(output, "bakery-native.js"),
    wasm: describeAsset(output, "bakery_native.wasm"),
  };
  writeFileSync(
    join(output, MODEL_INDEX_FILE),
    `${JSON.stringify(
      {
        format: MODEL_INDEX_FORMAT,
        core: "core",
        packs: packs.map(({ name, file, paths }) => ({ name, file, paths })),
      },
      null,
      2,
    )}\n`,
  );
  files.models = describeAsset(output, MODEL_INDEX_FILE);
  for (const pack of packs) {
    writeFileSync(join(output, pack.file), pack.bytes);
    files[`pack:${pack.name}`] = describeAsset(output, pack.file);
  }
  // Schema 2: the models are packs that the index names (model-packs.ts).
  const identity = { schemaVersion: 2, files };
  const bundle = { id: digest(JSON.stringify(identity)), ...identity };
  writeFileSync(
    join(output, "bundle.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
  );
  writeFileSync(join(output, "package.json"), '{"type":"module"}\n');
  copyFileSync(join(source, "LICENSE"), join(output, "LICENSE"));
  copyFileSync(
    join(root, "scripts/bakery-robots/THIRD_PARTY_NOTICES"),
    join(output, "THIRD_PARTY_NOTICES"),
  );
  checkAssetSizes(output);
  // The Portal serves the bundle with no sign-in: refuse any file whose
  // bytes name the home folder, the workspace or a build folder.
  const checked = refuseLocalPaths(
    output,
    localFolders(root, [source, staging, emsdk, output]),
  );
  console.log(`Browser controller: ${checked} files hold no local path.`);
  if (installPortal) {
    // A bundle directory is immutable. It stays while a supported saved run,
    // an active deployment or a supported rollback needs it.
    // The ID binds the glue module, solver and model data as one native bundle.
    const portalPackage = join(
      root,
      "apps/portal/public/bakery-physics/bundles",
      bundle.id,
    );
    mkdirSync(portalPackage, { recursive: true });
    for (const file of [
      ...Object.values(files).map(({ file }) => file),
      "bundle.json",
      "package.json",
      "LICENSE",
      "THIRD_PARTY_NOTICES",
    ]) {
      installImmutable(join(output, file), join(portalPackage, file));
    }
    const descriptorPath = join(
      root,
      "packages/production-simulation/src/simulator/browser-physics-asset.ts",
    );
    await retainApplianceBuilds(root, bundle);
    execFileSync("pnpm", ["exec", "prettier", "--write", descriptorPath], {
      cwd: root,
      stdio: "inherit",
    });
  }
  console.log(`Browser controller: ${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function describeAsset(directory, file) {
  const bytes = readFileSync(join(directory, file));
  return { file, sha256: digest(bytes), byteLength: bytes.length };
}

function installImmutable(source, destination) {
  if (existsSync(destination)) {
    if (!readFileSync(source).equals(readFileSync(destination))) {
      throw new Error(
        `Refusing to replace retained bundle file: ${destination}`,
      );
    }
    return;
  }
  copyFileSync(source, destination);
}

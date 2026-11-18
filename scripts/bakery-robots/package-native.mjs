import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rustRemapFlags } from "./build-paths.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const destination = resolve(process.argv[2] ?? "");
const sdk = process.env.MUJOCO_DIR;
if (process.argv.length !== 3 || !sdk)
  throw new Error(
    "Usage: MUJOCO_DIR=SDK node package-native.mjs NEW_PACKAGE_DIRECTORY",
  );
if (existsSync(destination)) throw new Error("Choose a new package directory.");
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    "crates/bakery-native/Cargo.toml",
  ],
  {
    cwd: root,
    stdio: "inherit",
    // The panic locations name "~" and ".", not the builder's folders
    // (Refactor 16, step 9A). The rpaths to the MuJoCo library stay: the
    // runner needs them.
    env: {
      ...process.env,
      CARGO_ENCODED_RUSTFLAGS: rustRemapFlags(root).join("\x1f"),
    },
  },
);
mkdirSync(join(destination, "bin"), { recursive: true });
cpSync(
  join(root, "crates/bakery-native/target/release/bakery-native"),
  join(destination, "bin/bakery-native"),
);
const library =
  process.platform === "darwin"
    ? "libmujoco.4.0.0.dylib"
    : "libmujoco.so.4.0.0";
const libraryDirectory =
  process.platform === "darwin" ? "lib/mujoco.framework/Versions/A" : "lib";
mkdirSync(join(destination, libraryDirectory), { recursive: true });
cpSync(join(sdk, library), join(destination, libraryDirectory, library));
for (const license of ["LICENSE", "THIRD_PARTY_NOTICES"])
  cpSync(join(sdk, license), join(destination, "lib", license));
cpSync(
  join(root, "scripts/bakery-robots/THIRD_PARTY_NOTICES"),
  join(destination, "THIRD_PARTY_NOTICES"),
);
const manifest = "assets/bakery-mujoco/fr10-workcell/native/assets.json";
const files = Object.keys(
  JSON.parse(readFileSync(join(root, manifest), "utf8")),
);
for (const file of [manifest, ...files]) {
  mkdirSync(dirname(join(destination, file)), { recursive: true });
  cpSync(join(root, file), join(destination, file));
}
writeFileSync(
  join(destination, "bakery-native"),
  `#!/bin/sh\nset -eu\npackage_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$package_root/bin/bakery-native" --root "$package_root" "$@"\n`,
  { mode: 0o755 },
);
console.log(`Native package: ${destination}`);

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const releases = {
  "darwin-arm64": [
    "macos-universal2.dmg",
    "6b3bd6650aff3e6681a1f5a62d596980f0f693b7a91a66c4966313836a5f2a6c",
  ],
  "darwin-x64": [
    "macos-universal2.dmg",
    "6b3bd6650aff3e6681a1f5a62d596980f0f693b7a91a66c4966313836a5f2a6c",
  ],
  "linux-x64": [
    "linux-x86_64.tar.gz",
    "3d5d2d96b6d286b758c75198aa7862590c960256626d3aac53ac5721b0a697f3",
  ],
  "linux-arm64": [
    "linux-aarch64.tar.gz",
    "479cc07d8a8d1cc77a64dbc477a0e3b08b2caefcee293f137a050e71717163b2",
  ],
};

async function install(destination) {
  const release = releases[`${process.platform}-${process.arch}`];
  if (!release)
    throw new Error("Supported SDK hosts: macOS and Linux, arm64/x64.");
  if (existsSync(destination)) throw new Error("Choose a new SDK directory.");
  const [file, expected] = release;
  const staging = mkdtempSync(join(tmpdir(), "bakery-sdk-"));
  try {
    const response = await fetch(
      `https://github.com/google-deepmind/mujoco/releases/download/4.0.0/mujoco-4.0.0-${file}`,
    );
    if (!response.ok)
      throw new Error(`MuJoCo download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error("MuJoCo release checksum mismatch.");
    const archive = join(staging, file);
    writeFileSync(archive, bytes);
    mkdirSync(destination, { recursive: true });
    if (process.platform === "darwin")
      installMac(archive, staging, destination);
    else installLinux(archive, staging, destination);
    console.log(`MuJoCo 4.0.0 SDK: ${destination}`);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function installMac(archive, staging, destination) {
  const mount = join(staging, "volume");
  execFileSync("hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-mountpoint",
    mount,
    archive,
  ]);
  try {
    const framework = join(mount, "mujoco.framework/Versions/A");
    cpSync(join(framework, "Headers"), join(destination, "include/mujoco"), {
      recursive: true,
    });
    cpSync(
      join(framework, "libmujoco.4.0.0.dylib"),
      join(destination, "libmujoco.4.0.0.dylib"),
    );
    copyLicenses(mount, destination);
  } finally {
    execFileSync("hdiutil", ["detach", mount]);
  }
}

function installLinux(archive, staging, destination) {
  execFileSync("tar", ["-xzf", archive, "-C", staging]);
  const source = join(staging, "mujoco-4.0.0");
  cpSync(join(source, "include"), join(destination, "include"), {
    recursive: true,
  });
  cpSync(
    join(source, "lib/libmujoco.so.4.0.0"),
    join(destination, "libmujoco.so.4.0.0"),
  );
  copyLicenses(source, destination);
}

function copyLicenses(source, destination) {
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES"])
    writeFileSync(join(destination, file), readFileSync(join(source, file)));
}

if (process.argv.length !== 3)
  throw new Error("Usage: node install-native-sdk.mjs NEW_SDK_DIRECTORY");
await install(resolve(process.argv[2]));

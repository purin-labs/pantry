// Refactor 16 step 9A: an engine build names no folder of the machine that
// made it. The Portal serves the browser bundle with no sign-in, so a local
// path in it would show the builder's home folder and workspace to anyone.
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

/** A path and the path with its links resolved (macOS: /tmp is /private/tmp). */
function spellings(path) {
  const absolute = resolve(path);
  const real = existsSync(absolute) ? realpathSync(absolute) : absolute;
  return [...new Set([absolute, real])];
}

/**
 * The rustc flags that write the home folder as "~" and the workspace as ".".
 * When two prefixes match, rustc applies the last one, so the workspace,
 * which can be inside the home folder, comes last. The Cargo registry and
 * the rustup toolchains are inside the home folder, or inside CARGO_HOME and
 * RUSTUP_HOME when those are set. build.rs keeps only the right side of each
 * flag in the engine identity, so the identity does not name the machine.
 */
export function rustRemapFlags(workspace) {
  const map = (from, to) =>
    spellings(from).map((path) => `--remap-path-prefix=${path}=${to}`);
  return [
    ...map(homedir(), "~"),
    ...["CARGO_HOME", "RUSTUP_HOME"]
      .filter((name) => process.env[name])
      .flatMap((name) => map(process.env[name], `~/${name.toLowerCase()}`)),
    ...map(workspace, "."),
  ];
}

/** The C and C++ flags that write each source folder by a fixed name in `__FILE__`. */
export function cPrefixMapFlags(folders) {
  return Object.entries(folders)
    .flatMap(([to, from]) =>
      spellings(from).map((path) => `-ffile-prefix-map=${path}=${to}`),
    )
    .join(" ");
}

/** The local folders that no file of a build may name. */
export function localFolders(workspace, extra = []) {
  return [
    ...new Set(
      [homedir(), workspace, tmpdir(), ...extra].flatMap((path) =>
        spellings(path),
      ),
    ),
  ];
}

/**
 * Throws when a file of `directory` contains one of `folders` in its bytes.
 * Returns the count of the files that it read.
 */
export function refuseLocalPaths(directory, folders) {
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  const found = [];
  for (const file of files) {
    const bytes = readFileSync(file);
    for (const folder of folders)
      if (bytes.includes(Buffer.from(folder)))
        found.push(`${relative(directory, file)} names ${folder}`);
  }
  if (found.length > 0)
    throw new Error(
      `The build holds local paths, so it cannot be a bundle:\n  ${found.join("\n  ")}`,
    );
  return files.length;
}

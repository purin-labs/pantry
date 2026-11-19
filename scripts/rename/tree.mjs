// The tracked files that a rename pass may read, and the paths that every
// pass leaves alone: plans, evidence, recorded data and lock files.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const COMMON_EXCLUDED_PATHS = [
  /^docs\//,
  /^assets\//,
  /^output\//,
  /^crates\/bakery-native\//,
  /(^|\/)evidence\//,
  /(^|\/)migrations[^/]*\//,
  /\.sql$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
];

export const isExcluded = (file) =>
  COMMON_EXCLUDED_PATHS.some((pattern) => pattern.test(file));

export const isBinary = (file) =>
  /\.(png|jpe?g|gif|webp|ico|glb|gltf|bin|data|wasm|onnx|pdf|zip|gz|mp3|mp4|wav|woff2?|ttf|otf|mjb|stl|obj|npz|npy)$/i.test(
    file,
  );

/** Each tracked file that exists in the working tree. */
export function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter(Boolean)
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
}

export const trackedTextFiles = () =>
  trackedFiles().filter((file) => !isBinary(file));

// The parts that the two path scripts of Refactor 17 share:
// scripts/refactor-17/move-module.mjs (a module becomes a package) and
// scripts/refactor-17/rename-folder.mjs (a folder gets a new name). Both
// change paths across the tracked tree and keep each ratchet as it was.
import { getFileInfo, format, resolveConfig } from "prettier";
import { join, posix } from "node:path";

import { clonePairKey, clonesBaselineText } from "./clones-ratchet.mjs";

// Plans, refactor documents, evidence and handovers keep the old paths
// (AGENTS.md, "Old and new names"). The scripts and the plans of
// scripts/refactor-17/ name the old paths on purpose.
export const FROZEN = [
  /^docs\/(plan-|refactor-|evidence\/|handoffs\/|history\/)/,
  /(^|\/)docs\/plan[^/]*\.md$/,
  /^scripts\/refactor-17\//,
];
// Bundles, vendored code and files that a tool writes.
export const UNREAD = [
  /(^|\/)(node_modules|dist|vendor|wasm-pkg|media-wasm-pkg|generated)\//,
  /^apps\/portal\/public\//,
  /^pnpm-lock\.yaml$/,
];
export const SOURCE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|vue)$/;
export const TEXT =
  /(\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|vue|json|jsonc|md|yml|yaml|toml|sh|css|html|py|rs)|(^|\/)(Dockerfile[^/]*|\.dockerignore|Caddyfile))$/;

/** A relative path in a text: `./x`, `../x`, `../..`. */
export const RELATIVE_PATH = /(?<![\w/@.-])(\.{1,2}\/[\w@./-]+)/g;
/** The Markdown link of a document: `](target)`. */
export const MARKDOWN_LINK = /(\]\()([^)\s#]+)(?=[)#\s])/g;

/**
 * The relative path from `fromFolder` to `target`, in the style of the path
 * that it replaces: "exact", "bare" (no extension), "js" (`.js` for a `.ts`
 * file) or "folder" (no `/index.*`).
 */
export function relativeSpecifier(fromFolder, target, style) {
  const path =
    style === "bare"
      ? target.replace(/\.(d\.ts|tsx?|mts|mjs|js)$/, "")
      : style === "js"
        ? target.replace(/\.tsx?$/, ".js")
        : style === "folder"
          ? target.replace(/\/index\.(tsx?|mjs|js)$/, "")
          : target;
  const relative = posix.relative(fromFolder, path);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

const inOrder = (keys) =>
  keys.every((key, at) => at === 0 || keys[at - 1] < key);

/**
 * `after` with each object and each list of strings that was in the order of
 * its keys in `before` put in that order again. A ratchet keeps its order
 * when a path in it changes; its counts do not change.
 */
export function keepOrder(before, after) {
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    return after;
  }
  if (Array.isArray(after)) {
    const sorted =
      before.every((item) => typeof item === "string") &&
      inOrder(before) &&
      !inOrder(after);
    return sorted ? [...after].sort() : after;
  }
  const beforeValues = Object.values(before);
  const entries = Object.entries(after).map(([key, value], at) => [
    key,
    keepOrder(beforeValues[at], value),
  ]);
  if (inOrder(Object.keys(before)) && !inOrder(Object.keys(after))) {
    entries.sort(([a], [b]) => (a < b ? -1 : 1));
  }
  return Object.fromEntries(entries);
}

/**
 * The text of scripts/clones-ratchet.json after a change of paths: the key of
 * a pair names its two files in order, so a renamed file can change the
 * order. `twice` gets each key that two old pairs give.
 */
export function clonesBaselineAfterRename(baseline, twice) {
  const pairs = {};
  for (const [pair, entry] of Object.entries(baseline.pairs)) {
    const [first, second] = pair.split(" = ");
    const key = clonePairKey(first, second);
    if (pairs[key] !== undefined) twice(key);
    pairs[key] = entry;
  }
  return clonesBaselineText(baseline.total, pairs);
}

/**
 * Prettier for a file that a run changed, only if the file was clean before
 * the run. Returns "ignored", "unclean" (it keeps its form), "same" or
 * "formatted", with the text to write.
 */
export async function formatWhenClean(root, path, before, text) {
  const filepath = join(root, path);
  const info = await getFileInfo(filepath, {
    ignorePath: join(root, ".prettierignore"),
  });
  if (info.ignored || info.inferredParser === null) {
    return { state: "ignored", text };
  }
  const options = { ...(await resolveConfig(filepath)), filepath };
  let clean;
  try {
    clean = (await format(before, options)) === before;
  } catch {
    clean = false;
  }
  if (!clean) return { state: "unclean", text };
  const next = await format(text, options);
  return next === text
    ? { state: "same", text }
    : { state: "formatted", text: next };
}

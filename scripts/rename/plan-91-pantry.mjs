#!/usr/bin/env node
// Plan 91, 18 November 2026: the owner renamed Seams Atelier to Seams Pantry.
// This pass renames Atelier to Pantry in every layer that the first pass
// (plan-91-codemod.mjs) named Atelier: identifiers, comments, file and folder
// names, CSS classes, package names and display text.
//
// A token rename is enough. Every "atelier" in the tree came from the first
// pass, which kept stored and sent values as "satyr". The exceptions are the
// plain French word in design and recipe data; PROTECTED_TEXT lists them.
//
//   node scripts/rename/plan-91-pantry.mjs              # dry run: report only
//   node scripts/rename/plan-91-pantry.mjs --write      # change the tree
//   node scripts/rename/plan-91-pantry.mjs --report out.md
//
// Run it from the repository root on a clean tree. After --write, run
// `pnpm install --prefer-offline` and the Plan 91 checks.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const reportArg = args.indexOf("--report");
const REPORT_PATH = reportArg >= 0 ? args[reportArg + 1] : null;
const SELF = "scripts/rename/plan-91-pantry.mjs";

/** Paths that keep their "atelier" text and their names: plans, evidence and recorded data. */
const EXCLUDED_PATHS = [
  /^docs\//,
  /^assets\//,
  /^output\//,
  /^crates\/bakery-native\//,
  /(^|\/)evidence\//,
  /(^|\/)migrations[^/]*\//,
  /\.sql$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  new RegExp(`^${SELF.replace(/[.]/g, "\\.")}$`),
];

/** Paths excluded even from the SATYR_* -> PANTRY_* environment variable pass. */
const ENV_EXCLUDED_PATHS = [
  /^docs\/(?:plan-|refactor-|equipment\/)/,
  /^assets\//,
  /^output\//,
  /^crates\/bakery-native\//,
  /(^|\/)evidence\//,
  /(^|\/)migrations[^/]*\//,
  /\.sql$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  new RegExp(`^${SELF.replace(/[.]/g, "\\.")}$`),
];

/** Uses of "atelier" that are not the product name. They keep their text. */
const PROTECTED_TEXT = [
  // Design and recipe data: a lighting style, a gift box, a demo location.
  /\batelier-track\b/g,
  /\batelier-15\b/g,
  /\blocation_atelier\b/g,
  /\b15-Piece Atelier Coffret\b/g,
  /\bAtelier · Tokyo\b/g,
  /\batelier floor\b/g,
  // A demo organisation and its workspace, named Atelier before Plan 91.
  /\b(?:workspace|org)_preview_atelier\b/g,
  /workspaceHandle: "atelier"/g,
  /name: "Atelier",/g,
  /\bAtelier Lowerarchy\b/g,
  // Names outside the tree: the Plan 91 file and the local clone folder.
  /plan-91-seams-atelier-rename/g,
  /lowerarchy\/seams-atelier\b/g,
  /-Users-pta-Dev-lowerarchy-seams-atelier\b/g,
  // plan-91-port.sh names the code names of the first pass.
  /\bAtelier names\b/g,
  // The AGENTS.md row that maps the first new name, so that a second run
  // changes nothing.
  /\bAtelier, the first new name\b/g,
  /\bpeitalin\/seams-atelier\b/g,
];

const WORDS = [
  ["ATELIER", "PANTRY"],
  ["Atelier", "Pantry"],
  ["atelier", "pantry"],
];

/**
 * Environment variables and Wrangler `vars` renamed from SATYR_* to PANTRY_*.
 * The 10 SATYR_* Console pairing keys in scripts/init-local-commerce-env.mjs
 * stay until seams-monorepo renames its Console Worker environment variables.
 */
const ENV_VAR_RENAMES = [
  ["SATYR_ACCOUNT_WORKER_ARTIFACT", "PANTRY_ACCOUNT_WORKER_ARTIFACT"],
  ["SATYR_CAFE_LIVE_SLACK", "PANTRY_CAFE_LIVE_SLACK"],
  ["SATYR_CAFE_MERCHANT_ID", "PANTRY_CAFE_MERCHANT_ID"],
  ["SATYR_CAFE_ORGANISATION_ID", "PANTRY_CAFE_ORGANISATION_ID"],
  ["SATYR_CAFE_RECEIPT_EVIDENCE", "PANTRY_CAFE_RECEIPT_EVIDENCE"],
  ["SATYR_CAFE_SLACK_CHANNEL_ID", "PANTRY_CAFE_SLACK_CHANNEL_ID"],
  ["SATYR_CAFE_STOREFRONT_ID", "PANTRY_CAFE_STOREFRONT_ID"],
  ["SATYR_CAFE_STRIPE_TEST_ACCESS_TOKEN", "PANTRY_CAFE_STRIPE_TEST_ACCESS_TOKEN"],
  ["SATYR_CAFE_STRIPE_TEST_ACCOUNT_ID", "PANTRY_CAFE_STRIPE_TEST_ACCOUNT_ID"],
  ["SATYR_CAFE_STRIPE_TEST_PUBLISHABLE_KEY", "PANTRY_CAFE_STRIPE_TEST_PUBLISHABLE_KEY"],
  ["SATYR_COMMERCE_LAB_NAMESPACE", "PANTRY_COMMERCE_LAB_NAMESPACE"],
  ["SATYR_COMMERCE_LAB_SIGNING_SECRET", "PANTRY_COMMERCE_LAB_SIGNING_SECRET"],
  ["SATYR_DEPLOYMENT_PROFILE", "PANTRY_DEPLOYMENT_PROFILE"],
  ["SATYR_FAULT_INJECTION_TOKEN", "PANTRY_FAULT_INJECTION_TOKEN"],
  ["SATYR_GATEWAY_HOME", "PANTRY_GATEWAY_HOME"],
  ["SATYR_LAB_ORGANISATION_ID", "PANTRY_LAB_ORGANISATION_ID"],
  ["SATYR_OAUTH_CALLBACK_ORIGIN", "PANTRY_OAUTH_CALLBACK_ORIGIN"],
  [
    "SATYR_ORGANISATION_PLACEMENT_PROFILE",
    "PANTRY_ORGANISATION_PLACEMENT_PROFILE",
  ],
  ["SATYR_PI_ACCEPTANCE_API_KEY", "PANTRY_PI_ACCEPTANCE_API_KEY"],
  ["SATYR_PLATFORM_MODEL", "PANTRY_PLATFORM_MODEL"],
  ["SATYR_PLATFORM_PI_MODEL", "PANTRY_PLATFORM_PI_MODEL"],
  ["SATYR_PORTAL_URL", "PANTRY_PORTAL_URL"],
  ["SATYR_PROVIDER_INGRESS_ORIGIN", "PANTRY_PROVIDER_INGRESS_ORIGIN"],
  ["SATYR_PUBLIC_ORIGIN", "PANTRY_PUBLIC_ORIGIN"],
  ["SATYR_SLACK_CHANNEL_ID", "PANTRY_SLACK_CHANNEL_ID"],
  ["SATYR_STOREFRONT_URL", "PANTRY_STOREFRONT_URL"],
  ["SATYR_THREAD_KEY", "PANTRY_THREAD_KEY"],
  ["SATYR_VAULT_ACTIVE_KEY_VERSION", "PANTRY_VAULT_ACTIVE_KEY_VERSION"],
  ["SATYR_VOICE_HOME", "PANTRY_VOICE_HOME"],
  ["SATYR_VOICE_LABEL", "PANTRY_VOICE_LABEL"],
  ["SATYR_WORKER_URL", "PANTRY_WORKER_URL"],
];

const isExcluded = (file) => EXCLUDED_PATHS.some((pattern) => pattern.test(file));
const isEnvExcluded = (file) =>
  ENV_EXCLUDED_PATHS.some((pattern) => pattern.test(file));
const isBinary = (file) => /\.(png|jpe?g|gif|webp|ico|glb|gltf|bin|data|wasm|onnx|pdf|zip|gz|mp3|mp4|wav|woff2?|ttf|otf|mjb|stl|obj|npz|npy)$/i.test(file);

function renameText(text, envOnly = false) {
  const masks = [];
  let masked = text;
  if (!envOnly) {
    for (const pattern of PROTECTED_TEXT) {
      masked = masked.replace(pattern, (match) => {
        masks.push(match);
        return `\u0000${masks.length - 1}\u0000`;
      });
    }
    for (const [from, to] of WORDS) masked = masked.replaceAll(from, to);
  }
  for (const [from, to] of ENV_VAR_RENAMES) {
    masked = masked.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  return masked.replace(/\u0000(\d+)\u0000/g, (_, index) => masks[Number(index)]);
}

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());

const changes = [];
const moves = [];
for (const file of tracked) {
  if (isEnvExcluded(file)) continue;
  const envOnly = isExcluded(file);
  if (!envOnly) {
    const next = renameText(file);
    if (next !== file) moves.push([file, next]);
  }
  if (isBinary(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  if (
    text.includes("\u0000") ||
    ((envOnly || !/atelier/i.test(text)) && !text.includes("SATYR_"))
  )
    continue;
  const rewritten = renameText(text, envOnly);
  if (rewritten === text) continue;
  const before = text.split("\n");
  const after = rewritten.split("\n");
  const lines = before.filter((line, index) => line !== after[index]).length;
  changes.push({ file, text: rewritten, lines });
}

// What is left: each remaining "atelier" outside the excluded paths must be a protected use.
const residue = [];
for (const file of tracked) {
  if (isExcluded(file) || isBinary(file)) continue;
  const text = changes.find((change) => change.file === file)?.text ?? fs.readFileSync(file, "utf8");
  text.split("\n").forEach((line, index) => {
    if (/atelier/i.test(line)) residue.push(`${file}:${index + 1}: ${line.trim().slice(0, 140)}`);
  });
}

// A string that names a moved file by its old base name is a reference that
// no import resolver follows (a test list, a config path, a fetch URL).
const staleReferences = [];
const movedBaseNames = new Map(
  moves
    .map(([from, to]) => [path.posix.basename(from), path.posix.basename(to)])
    .filter(([from, to]) => from !== to),
);
for (const file of tracked) {
  if (isExcluded(file) || isBinary(file)) continue;
  const text = changes.find((change) => change.file === file)?.text ?? fs.readFileSync(file, "utf8");
  for (const [from, to] of movedBaseNames) {
    if (text.includes(from)) staleReferences.push(`${file}: ${from} (now ${to})`);
  }
}

const report = [
  `# Plan 91 Pantry pass ${WRITE ? "write" : "dry run"}`,
  "",
  `- Files changed: ${changes.length}; lines changed: ${changes.reduce((sum, change) => sum + change.lines, 0)}`,
  `- Files moved: ${moves.length}`,
  `- Remaining "atelier" lines (each must be a protected use): ${residue.length}`,
  `- References to an old file name (should be empty): ${staleReferences.length}`,
  "",
  "## Moves",
  "",
  ...moves.map(([from, to]) => `- ${from} → ${to}`),
  "",
  "## Remaining atelier lines",
  "",
  ...residue.map((line) => `- ${line}`),
  "",
  "## References to an old file name",
  "",
  ...staleReferences.map((line) => `- ${line}`),
  "",
].join("\n");

if (REPORT_PATH) fs.writeFileSync(REPORT_PATH, report);
console.log(report.split("\n").slice(0, 7).join("\n"));

if (WRITE) {
  for (const change of changes) fs.writeFileSync(change.file, change.text);
  for (const [from, to] of moves) {
    fs.mkdirSync(path.posix.dirname(to), { recursive: true });
    execFileSync("git", ["mv", from, to]);
  }
  console.log("Written. Next: pnpm install --prefer-offline, then the Plan 91 checks.");
}
if (staleReferences.length > 0) process.exitCode = 1;

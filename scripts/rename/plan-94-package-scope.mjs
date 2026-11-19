#!/usr/bin/env node
// Plan 94: rename the 27 Pantry workspace packages from `@seams/*` to
// `@purin-labs/*`. External Seams packages (`@seams-internal/console-shared`,
// `@seams/wallet`, `@seams/checkout`, `@seams/voiceid`) stay in `@seams`.
//
//   node scripts/rename/plan-94-package-scope.mjs          # dry run: report only
//   node scripts/rename/plan-94-package-scope.mjs --write  # change the tree
//
// Run it from the repository root on a clean tree. After --write, run
// `pnpm install` to regenerate `pnpm-lock.yaml` and run the verification checks.
import fs from "node:fs";
import { isExcluded, trackedTextFiles } from "./tree.mjs";

const WRITE = process.argv.includes("--write");
const SELF = "scripts/rename/plan-94-package-scope.mjs";

const WORKSPACE_PACKAGES = [
  "async-control",
  "bakery-model",
  "bakery-workflow",
  "collaboration",
  "commerce-client",
  "commerce-contracts",
  "commerce-query-sqlite",
  "commerce-worker",
  "contracts",
  "control-api",
  "costs-sheet-crdt",
  "docs",
  "email-draft-crdt",
  "mail-reply-crdt",
  "menu-board-crdt",
  "menu-draft-crdt",
  "plan50-experiment",
  "platform",
  "portal",
  "product-description-crdt",
  "production-plan-crdt",
  "production-simulation",
  "punter",
  "std",
  "storefront",
  "type-utils",
  "workflow-canvas-crdt",
];

// Operational docs under docs/ whose runnable commands use `pnpm --filter`.
// Plans, handoffs, evidence and inspection reports keep their historical text.
const INCLUDED_DOCS = [
  /^docs\/runbooks\//,
  /^docs\/architecture\//,
  /^docs\/deployment\//,
];

const EXCLUDED_PATHS = [
  /^scripts\/rename\//,
  /^apps\/portal\/public\/bakery-physics\//,
  /^repo-binaries\.json$/,
];

const SCOPE_PATTERN = new RegExp(
  `@seams/(${WORKSPACE_PACKAGES.join("|")})(?![A-Za-z0-9_-])`,
  "g",
);

const shouldProcess = (file) => {
  if (file === SELF) return false;
  if (EXCLUDED_PATHS.some((pattern) => pattern.test(file))) return false;
  if (INCLUDED_DOCS.some((pattern) => pattern.test(file))) return true;
  return !isExcluded(file);
};

let changedFiles = 0;
let replacements = 0;

for (const file of trackedTextFiles()) {
  if (!shouldProcess(file)) continue;
  const before = fs.readFileSync(file, "utf8");
  let fileHits = 0;
  const after = before.replace(SCOPE_PATTERN, (_, pkg) => {
    fileHits += 1;
    return `@purin-labs/${pkg}`;
  });
  if (fileHits === 0) continue;
  changedFiles += 1;
  replacements += fileHits;
  if (WRITE) fs.writeFileSync(file, after, "utf8");
}

console.log(
  `${WRITE ? "Updated" : "Would update"} ${changedFiles} files (${replacements} replacements).`,
);

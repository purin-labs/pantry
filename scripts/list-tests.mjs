#!/usr/bin/env node
// Lists the test files with their kind (Refactor 17, step A0.8). A step of the
// refactor uses this list to decide what to do with each test of the code that
// it changes: see "Prune with each step" in docs/refactor-17.md.
//
// Kinds:
//   journey   a file under tests/e2e, or a *-journey.test.ts of the engine: it
//             runs the Worker
//   test      another *.test.ts or *.test.tsx
//   types     a file that only the type check reads: *.type-fixtures.ts,
//             *.types.ts, *.typecheck.ts, *.fixtures.ts
//   support   another file under a tests folder: a helper, a fake, a fixture
//
// For each file: its lines, its count of vi.mock calls, the count of product
// source files that it imports by a relative path, and the module that has
// most of them (scripts/layers.json).
//
//   node scripts/list-tests.mjs                 totals by kind and by module
//   node scripts/list-tests.mjs --list          one line for each file
//   node scripts/list-tests.mjs --of <file>     the test files that import one source file
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  importsOf,
  moduleOrPackageOf,
  relativeResolver,
  root,
  trackedFiles,
} from "./lib/layers.mjs";
import { SOURCE_ROOTS } from "./lib/source-roots.mjs";

const mode = process.argv[2] ?? "totals";
if (!["totals", "--list", "--of"].includes(mode)) {
  console.error(`Unknown argument ${mode}.`);
  process.exit(2);
}

const all = trackedFiles(...SOURCE_ROOTS).filter((path) =>
  /\.(ts|tsx)$/.test(path),
);
const resolve = relativeResolver(new Set(all));
function kindOf(path) {
  if (/\.(type-fixtures|types|typecheck|fixtures)\.ts$/.test(path)) {
    return "types";
  }
  if (/\.test\.tsx?$/.test(path)) {
    return /\/tests\/e2e\//.test(path) || /-journey\.test\.ts$/.test(path)
      ? "journey"
      : "test";
  }
  return /\/tests?\//.test(path) ? "support" : null;
}

const tests = [];
for (const path of all) {
  const kind = kindOf(path);
  if (kind === null) continue;
  const text = readFileSync(join(root, path), "utf8");
  const sources = new Set();
  for (const specifier of importsOf(text)) {
    if (!specifier.startsWith(".")) continue;
    const target = resolve(path, specifier);
    if (target !== null && kindOf(target) === null) sources.add(target);
  }
  const modules = {};
  for (const source of sources) {
    const module = moduleOrPackageOf(source) ?? "no module";
    modules[module] = (modules[module] ?? 0) + 1;
  }
  tests.push({
    path,
    kind,
    lines: text.split("\n").length,
    mocks: (text.match(/\bvi\.mock\(/g) ?? []).length,
    sources,
    module:
      Object.entries(modules).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none",
  });
}

if (mode === "--of") {
  const wanted = process.argv[3];
  for (const test of tests) {
    if (test.sources.has(wanted)) {
      console.log(`${test.kind.padEnd(8)} ${test.path}`);
    }
  }
  process.exit(0);
}

if (mode === "--list") {
  for (const test of tests) {
    console.log(
      [
        test.kind,
        test.lines,
        test.mocks,
        test.sources.size,
        test.module,
        test.path,
      ].join("\t"),
    );
  }
  process.exit(0);
}

function table(title, keyOf) {
  const rows = new Map();
  for (const test of tests) {
    const key = keyOf(test);
    const row = rows.get(key) ?? {
      files: 0,
      lines: 0,
      mocked: 0,
      inside: 0,
    };
    row.files += 1;
    row.lines += test.lines;
    if (test.mocks > 0) row.mocked += 1;
    if (test.sources.size > 0) row.inside += 1;
    rows.set(key, row);
  }
  console.log(
    `${title.padEnd(26)} files   lines  with vi.mock  import the source`,
  );
  for (const [key, row] of [...rows].sort((a, b) => b[1].lines - a[1].lines)) {
    console.log(
      `${key.padEnd(26)} ${String(row.files).padStart(5)} ${String(row.lines).padStart(7)} ${String(row.mocked).padStart(13)} ${String(row.inside).padStart(18)}`,
    );
  }
  console.log("");
}

table("kind", (test) => test.kind);
table("journeys by module", (test) =>
  test.kind === "journey" ? test.module : "(not a journey)",
);
table("tests by module", (test) =>
  test.kind === "test" ? test.module : "(not a test)",
);

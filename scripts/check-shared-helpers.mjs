#!/usr/bin/env node
// Fails when a module defines its own copy of a helper that @seams/std exports.
// One name keeps one meaning: a local function with the same name as a shared
// helper is either a copy (import it instead) or behaves differently (rename it).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const STD = "packages/std/src/index.ts";

// Packages that must not depend on the shared helpers: std itself and async-control
// (ships a standalone dist).
const EXEMPT = [/^packages\/std\//, /^packages\/async-control\//];

// Local definitions that still differ from the shared helper, with the reason.
// Delete an entry when its definition is renamed or replaced.
const ALLOWED = new Map([]);

const parse = (file, text) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const std = parse(STD, readFileSync(join(root, STD), "utf8"));
const shared = new Set(
  std.statements
    .filter((s) => ts.isFunctionDeclaration(s) && s.name && (s.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
    .map((s) => s.name.text),
);

const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !EXEMPT.some((pattern) => pattern.test(f)) && !/(^|\/)(bindings|generated)\//.test(f));

const violations = [];
const seen = new Set();
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    continue; // listed by git but deleted in the working tree
  }
  if (![...shared].some((name) => text.includes(name))) continue;
  const source = parse(file, text);
  for (const statement of source.statements) {
    const names = [];
    if (ts.isFunctionDeclaration(statement) && statement.name) names.push(statement.name);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name);
    for (const name of names) {
      if (!shared.has(name.text)) continue;
      const key = `${file}#${name.text}`;
      seen.add(key);
      if (ALLOWED.has(key)) continue;
      const line = source.getLineAndCharacterOfPosition(name.getStart(source)).line + 1;
      violations.push(`${file}:${line} defines ${name.text}; import it from @seams/std or give a different behaviour a different name`);
    }
  }
}
const stale = [...ALLOWED.keys()].filter((key) => !seen.has(key));

for (const v of violations) console.error(v);
for (const key of stale) console.error(`${key} is allowed in scripts/check-shared-helpers.mjs but no longer defined; remove the entry`);
if (violations.length || stale.length) process.exit(1);
console.log(`shared helpers: ${shared.size} names checked across ${files.length} files`);

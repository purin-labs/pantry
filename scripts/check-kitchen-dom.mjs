#!/usr/bin/env node
// Fails when the Kitchen engine or model adds a browser name
// (Refactor 17, step A2.4, fault F4).
//
// The Kitchen engine and model packages (packages/bakery-model,
// packages/bakery-workflow, packages/production-simulation) must stay able to
// run on the server: in a Worker, a Durable Object or Node. So their source
// names no `window` or `document`, and no other global that only a browser
// page has: a name that TypeScript's lib.dom.d.ts declares and its
// lib.webworker.d.ts does not, for example `HTMLElement`, `MouseEvent` or
// `CanvasRenderingContext2D`. A name that a worker also has, such as `fetch`,
// `URL`, `performance` or `OffscreenCanvas`, is allowed.
//
// The check parses each file with TypeScript. A comment, a string, a property
// name (`run.document`, `{ window: 3 }`) and a name that the file declares
// itself do not count. Test files do not count.
//
// No file names one today (2026-11-21), so the check has no ratchet: one use
// fails. Put browser code in the Portal files of the Kitchen area
// (areas/kitchen/ui/features/workflow-simulator or production-run), and give
// the package a port.
//
//   node scripts/check-kitchen-dom.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const PACKAGES = [
  "packages/bakery-model/",
  "packages/bakery-workflow/",
  "packages/production-simulation/",
];
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const EXCLUDED = [/\.test\.[a-z]+$/, /\.d\.ts$/, /\/node_modules\//];

const BROWSER_GLOBALS = browserGlobals();

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync("git", ["ls-files", "--", ...PACKAGES], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter(
    (file) =>
      SOURCE.test(file) && !EXCLUDED.some((pattern) => pattern.test(file)),
  );
const errors = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") continue; // listed by git, deleted in the tree
    throw error;
  }
  const names = browserNames(file, text);
  if (names.length > 0)
    errors.push(
      `${file} names the browser globals ${[...new Set(names)].join(", ")}. The Kitchen engine and model must run on the server: put browser code in the Portal and give the package a port.`,
    );
}
for (const error of errors) console.error(error);
if (errors.length > 0) process.exit(1);
console.log(
  `kitchen DOM check: ${files.length} files in ${PACKAGES.length} packages name no browser global`,
);

/** The globals of lib.dom.d.ts that lib.webworker.d.ts does not have. */
function browserGlobals() {
  const lib = dirname(require.resolve("typescript/lib/lib.dom.d.ts"));
  const dom = declaredGlobals(join(lib, "lib.dom.d.ts"));
  const worker = declaredGlobals(join(lib, "lib.webworker.d.ts"));
  const names = new Set([...dom].filter((name) => !worker.has(name)));
  names.add("window");
  names.add("document");
  return names;
}

function declaredGlobals(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    false,
  );
  const names = new Set();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    else if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name !== undefined &&
      ts.isIdentifier(statement.name)
    )
      names.add(statement.name.text);
  }
  return names;
}

/** Each use of a browser global in one file, in source order. */
function browserNames(file, text) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : undefined,
  );
  const declared = new Set();
  const used = [];
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      if (isDeclarationName(node)) declared.add(node.text);
      else if (BROWSER_GLOBALS.has(node.text) && !isPropertyName(node))
        used.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return used.filter((name) => !declared.has(name));
}

function isDeclarationName(node) {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent)) &&
    parent.name === node
  );
}

function isPropertyName(node) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isQualifiedName(parent)) return parent.right === node;
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isJsxAttribute(parent)) &&
    parent.name === node
  );
}

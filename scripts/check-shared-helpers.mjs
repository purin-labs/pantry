#!/usr/bin/env node
// Fails when a module keeps its own copy of a shared helper:
// - a local function or const with the name of an @purin-labs/std export. One name
//   keeps one meaning: a local definition with a shared name is either a copy
//   (import it instead) or behaves differently (rename it);
// - a renamed copy: a local function with the form of a shared helper under
//   another name (see FORMS), or an inline backoff formula;
// - `Extract<U, { kind: K }>`, which @purin-labs/type-utils names `Variant<U, K>`.
// It reads TypeScript and JavaScript. The name rule covers tests too; the
// other rules cover product code (TESTS lists the test paths).
// `--list` prints every finding and the count for each helper, and exits 0.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const STD = "packages/std/src/index.ts";
const listOnly = process.argv.includes("--list");

// Packages that must not depend on the shared helpers: std itself, type-utils
// (defines Variant) and async-control (ships a standalone dist).
const EXEMPT = [
  /^packages\/std\//,
  /^packages\/type-utils\//,
  /^packages\/async-control\//,
];
// Vendored code, built bundles and type declarations. Generated sources are
// checked: fix a finding there in its generator.
const SKIP = [
  /(^|\/)(bindings|vendor|dist|node_modules)\//,
  /^apps\/portal\/public\//,
  /\.d\.ts$/,
  /\.min\.js$/,
];
const TESTS = /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

// Local definitions that still differ from the shared helper, with the reason.
// The key is `file#name` (`file#Extract@line` is not allowed: use Variant).
// Delete an entry when its definition is renamed or replaced.
const ALLOWED = new Map([
  [
    "packages/collaboration/src/sync-protocol.ts#Extract",
    "Message<Kind> picks from the factory's generic Server union, where Variant's `K extends U[\"kind\"]` resolves to never",
  ],
]);

const parse = (file, text) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));

function scriptKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (/\.(mjs|js|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const std = parse(STD, readFileSync(join(root, STD), "utf8"));
const shared = new Set(
  std.statements
    .filter((s) => ts.isFunctionDeclaration(s) && s.name && (s.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
    .map((s) => s.name.text),
);

// The forms of a shared helper under another name. Each test gets a function
// (a declaration, or a const set to an arrow or function expression) and its
// first parameter name, and says whether the function is a copy.
const FORMS = [
  { helper: "assertNever", test: isAssertNeverForm },
  { helper: "isRecord", test: isRecordForm },
  { helper: "sha256Hex", test: isSha256HexForm },
  { helper: "isSha256Hex", test: isSha256HexCheckForm },
  { helper: "decodeBase64Url", test: isDecodeBase64UrlForm },
  { helper: "sleep", test: isSleepForm },
];
for (const { helper } of FORMS)
  if (!shared.has(helper)) throw new Error(`${helper} is not exported by ${STD}`);
if (!shared.has("backoffDelay")) throw new Error(`backoffDelay is not exported by ${STD}`);

const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx", "*.mts", "*.mjs", "*.js", "*.cjs"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !EXEMPT.some((pattern) => pattern.test(f)) && !SKIP.some((pattern) => pattern.test(f)));

const findings = [];
const seen = new Set();
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    continue; // listed by git but deleted in the working tree
  }
  const source = parse(file, text);
  const product = !TESTS.test(file);
  const report = (node, key, helper, message) => {
    seen.add(key);
    if (ALLOWED.has(key)) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    findings.push({ helper, text: `${file}:${line} ${message}` });
  };

  for (const statement of source.statements) {
    for (const { name, fn } of definitions(statement)) {
      const key = `${file}#${name.text}`;
      if (shared.has(name.text)) {
        report(name, key, name.text, `defines ${name.text}; import it from @purin-labs/std or give a different behaviour a different name`);
        continue;
      }
      if (!fn || !product) continue;
      const form = FORMS.find(({ test }) => test(fn));
      if (form) report(name, key, form.helper, `${name.text} is a copy of ${form.helper}; import it from @purin-labs/std`);
    }
  }
  if (!product) continue;
  visit(source, (node) => {
    if (isBackoffFormula(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      report(node, `${file}#backoff@${line}`, "backoffDelay", "is a backoff formula; use backoffDelay from @purin-labs/std");
    } else if (isExtractByKind(node)) {
      report(node, `${file}#Extract`, "Variant", "uses Extract<U, { kind: K }>; use Variant<U, K> from @purin-labs/type-utils");
    }
  });
}
const stale = [...ALLOWED.keys()].filter((key) => !seen.has(key));

if (listOnly) {
  for (const finding of findings) console.log(finding.text);
  const counts = new Map();
  for (const { helper } of findings) counts.set(helper, (counts.get(helper) ?? 0) + 1);
  console.log([...counts].map(([helper, count]) => `${helper} ${count}`).join(", ") || "no findings");
  process.exit(0);
}
for (const finding of findings) console.error(finding.text);
for (const key of stale) console.error(`${key} is allowed in scripts/check-shared-helpers.mjs but no longer found; remove the entry`);
if (findings.length || stale.length) process.exit(1);
console.log(`shared helpers: ${shared.size} names and ${FORMS.length} forms checked across ${files.length} files`);

// The top-level functions of a statement, with their names.
function definitions(statement) {
  if (ts.isFunctionDeclaration(statement) && statement.name)
    return [{ name: statement.name, fn: statement.body ? statement : null }];
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations
    .filter((declaration) => ts.isIdentifier(declaration.name))
    .map((declaration) => {
      const init = declaration.initializer && unwrap(declaration.initializer);
      const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : null;
      return { name: declaration.name, fn };
    });
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function unwrap(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node)) node = node.expression;
  return node;
}

function firstParameter(fn) {
  const parameter = fn.parameters[0];
  return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : null;
}

/** The single returned expression of a function, or null. */
function returnedExpression(fn) {
  if (!fn.body) return null;
  if (!ts.isBlock(fn.body)) return unwrap(fn.body);
  const statements = fn.body.statements;
  if (statements.length !== 1 || !ts.isReturnStatement(statements[0]) || !statements[0].expression) return null;
  return unwrap(statements[0].expression);
}

function textOf(node) {
  return node.getText().replace(/\s+/g, "");
}

/** Whether a function is small: an expression body or at most four statements. */
function isSmall(fn) {
  return !!fn.body && (!ts.isBlock(fn.body) || fn.body.statements.length <= 4);
}

/** The callee and argument texts of every call in a function body (strings stay out). */
function callsIn(fn) {
  const calls = [];
  visit(fn.body, (node) => {
    if (ts.isCallExpression(node)) calls.push({ callee: textOf(node.expression), args: node.arguments.map(textOf) });
  });
  return calls;
}

/** `throw` as the whole body of a function whose parameter has the type `never`. */
function isAssertNeverForm(fn) {
  if (!fn.parameters.some((parameter) => parameter.type?.kind === ts.SyntaxKind.NeverKeyword)) return false;
  if (!fn.body || !ts.isBlock(fn.body)) return false;
  const statements = fn.body.statements;
  return statements.length > 0 && ts.isThrowStatement(statements[statements.length - 1]) && statements.every((s) => !ts.isReturnStatement(s));
}

/** `typeof v === "object" && v !== null && !Array.isArray(v)`, in any order. */
function isRecordForm(fn) {
  const value = firstParameter(fn);
  const expression = returnedExpression(fn);
  if (!value || !expression) return false;
  const terms = andTerms(expression).map(textOf).sort();
  const expected = [`typeof${value}==="object"`, `${value}!==null`, `!Array.isArray(${value})`].sort();
  return terms.length === 3 && terms.every((term, index) => term === expected[index]);
}

function andTerms(node) {
  node = unwrap(node);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return [...andTerms(node.left), ...andTerms(node.right)];
  return [node];
}

/** A small function that writes a SHA-256 WebCrypto digest out as hex. */
function isSha256HexForm(fn) {
  if (!isSmall(fn)) return false;
  const calls = callsIn(fn);
  return (
    calls.some(({ callee, args }) => callee.endsWith("subtle.digest") && /^["']SHA-256["']$/.test(args[0] ?? "")) &&
    calls.some(({ callee, args }) => callee.endsWith("bytesToHex") || (callee.endsWith(".toString") && args[0] === "16"))
  );
}

/** `typeof v === "string" && /^[0-9a-f]{64}$/.test(v)`. */
function isSha256HexCheckForm(fn) {
  const value = firstParameter(fn);
  const expression = returnedExpression(fn);
  if (!value || !expression) return false;
  const terms = andTerms(expression).map(textOf);
  return (
    terms.length === 2 &&
    terms.includes(`typeof${value}==="string"`) &&
    terms.some((term) => /^\/\^\[0-9a-f\]\{64\}\$\/u?\.test\(/.test(term) && term.endsWith(`(${value})`))
  );
}

/** A small function that turns URL-safe base64 into standard base64 and decodes it. */
function isDecodeBase64UrlForm(fn) {
  if (!isSmall(fn)) return false;
  const calls = callsIn(fn);
  return (
    calls.some(({ callee, args }) => /\.replace(All)?$/.test(callee) && (args[0] === '"-"' || args[0] === "/-/g") && args[1] === '"+"') &&
    calls.some(({ callee }) => callee === "atob" || callee === "decodeBase64")
  );
}

/** `new Promise((resolve) => setTimeout(resolve, ms))`. */
function isSleepForm(fn) {
  const expression = returnedExpression(fn);
  if (!expression || !ts.isNewExpression(expression) || textOf(expression.expression) !== "Promise") return false;
  const executor = expression.arguments?.[0] && unwrap(expression.arguments[0]);
  if (!executor || !(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor))) return false;
  const resolve = firstParameter(executor);
  const body = executor.body && textOf(executor.body);
  return !!resolve && !!body && new RegExp(`^\\{?setTimeout\\(${resolve},[^,]+\\);?\\}?$`).test(body);
}

/** `Math.min(base * 2 ** n, max)`. */
function isBackoffFormula(node) {
  if (!ts.isCallExpression(node) || textOf(node.expression) !== "Math.min" || node.arguments.length !== 2) return false;
  const product = unwrap(node.arguments[0]);
  if (!ts.isBinaryExpression(product) || product.operatorToken.kind !== ts.SyntaxKind.AsteriskToken) return false;
  const power = unwrap(product.right);
  return ts.isBinaryExpression(power) && power.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken && textOf(power.left) === "2";
}

/** `Extract<U, { kind: K }>` or `Extract<U, { readonly kind: K }>`. */
function isExtractByKind(node) {
  if (!ts.isTypeReferenceNode(node) || textOf(node.typeName) !== "Extract" || node.typeArguments?.length !== 2) return false;
  const shape = node.typeArguments[1];
  return (
    ts.isTypeLiteralNode(shape) &&
    shape.members.length === 1 &&
    ts.isPropertySignature(shape.members[0]) &&
    !shape.members[0].questionToken &&
    shape.members[0].name.getText() === "kind"
  );
}

#!/usr/bin/env node
// Plan 91 phase 1: rename the code layer from Satyr, Underclerk and Urk to
// Pantry, commerce and the merchant agent. It changes identifiers, comments,
// package names, file and folder names, import paths and CSS classes. It keeps
// every string value except module paths, repository paths and CSS classes, so
// stored and wire values stay as they are.
//
//   node scripts/rename/plan-91-codemod.mjs              # dry run: report only
//   node scripts/rename/plan-91-codemod.mjs --write      # change the tree
//   node scripts/rename/plan-91-codemod.mjs --report out.md
//
// Run it from the repository root on a clean tree. After --write, run
// `pnpm install --offline` and the checks in Plan 91 phase 1.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  DIRECTORY_RENAMES,
  EXCLUDED_PATHS,
  IDENTIFIER_WORDS,
  LINT_RENAMES,
  MARKDOWN_PATHS,
  DEVELOPER_PROSE_PATHS,
  PACKAGE_RENAMES,
  PATH_WORDS,
  PROTECTED_IDENTIFIERS,
  PROTECTED_TEXT,
  UNSCOPED_PACKAGE_RENAMES,
} from "./plan-91-map.mjs";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const reportArg = args.indexOf("--report");
const REPORT_PATH = reportArg >= 0 ? args[reportArg + 1] : null;
const ROOT = process.cwd();

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".jsx", ".d.ts", ".json", ".css", ".vue"];
const PATH_TEXT_EXTENSIONS = new Set([".sh", ".py", ".toml", ".rs", ".yml", ".yaml", ".vue", ".html", ".txt", ".env.example"]);

// ---------------------------------------------------------------- the tree

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
const trackedSet = new Set(tracked);
const trackedDirs = new Set();
for (const file of tracked) {
  let dir = path.posix.dirname(file);
  while (dir !== "." && !trackedDirs.has(dir)) {
    trackedDirs.add(dir);
    dir = path.posix.dirname(dir);
  }
}

const isExcluded = (file) => EXCLUDED_PATHS.some((pattern) => pattern.test(file));
const isBinary = (file) => /\.(png|jpe?g|gif|webp|ico|glb|gltf|bin|data|wasm|onnx|pdf|zip|gz|mp3|mp4|wav|woff2?|ttf|otf|mjb|stl|obj|npz|npy)$/i.test(file);

// ---------------------------------------------------------------- words

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);
const screaming = (text) => text.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toUpperCase();

/** Fallback names for a word whose first new name collides with a name in use. */
const WORD_FALLBACKS = new Map([
  ["Underclerk", ["Commerce", "CommerceEngine"]],
  ["Urk", ["MerchantAgent", "SousChef"]],
  ["Satyr", ["Pantry", "SeamsPantry"]],
  ["BakeryOS", ["Kitchen", "KitchenArea"]],
  ["CafeOS", ["Cafe", "CafeArea"]],
  ["AgentCommerce", ["Commerce", "CommerceArea"]],
]);

/** Replace one Pascal word inside an identifier, in its three cases. */
function replaceWord(name, fromPascal, toPascal) {
  const variants = [
    // PascalCase word: it starts with a capital, so it may follow any letter;
    // it must not run on into a lowercase letter.
    [new RegExp(`${escapeRegExp(fromPascal)}(?![a-z])`, "g"), toPascal],
    // camelCase start: the identifier starts with the lower word.
    [new RegExp(`^${escapeRegExp(lowerFirst(fromPascal))}(?![a-z])`, "g"), lowerFirst(toPascal)],
    // SCREAMING_CASE word.
    [new RegExp(`(?<![A-Za-z])${escapeRegExp(screaming(fromPascal))}(?![A-Za-z])`, "g"), screaming(toPascal)],
  ];
  let result = name;
  for (const [pattern, replacement] of variants) result = result.replace(pattern, replacement);
  return result;
}

function renameIdentifierAt(name, levels) {
  if (PROTECTED_IDENTIFIERS.has(name)) return name;
  // Env names stay: they are deployed names.
  if (/^SATYR_[A-Z0-9_]+$/.test(name)) return name;
  let result = name;
  for (const rule of IDENTIFIER_WORDS) {
    const level = levels.get(rule.from) ?? 0;
    const target = WORD_FALLBACKS.get(rule.from)?.[level] ?? rule.to;
    for (const from of [rule.from, ...(rule.alsoFrom ?? [])]) result = replaceWord(result, from, target);
  }
  return result
    .replace(/CommerceEngineCommerce/g, "CommerceEngine")
    .replace(/^commerceEngineCommerce/g, "commerceEngine")
    .replace(/COMMERCE_ENGINE_COMMERCE/g, "COMMERCE_ENGINE")
    .replace(/CommerceCommerce/g, "Commerce")
    .replace(/^commerceCommerce/g, "commerce")
    .replace(/COMMERCE_COMMERCE/g, "COMMERCE");
}

const matchesOldWord = (name) =>
  IDENTIFIER_WORDS.some((rule) => [rule.from, ...(rule.alsoFrom ?? [])].some((from) => replaceWord(name, from, "\u0001") !== name));

// ---------------------------------------------------------------- paths

function renamePathSegment(segment) {
  const dot = segment.indexOf(".", 1);
  const stem = dot > 0 ? segment.slice(0, dot) : segment;
  const ext = dot > 0 ? segment.slice(dot) : "";
  let next;
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(stem)) {
    const separator = stem.includes("_") && !stem.includes("-") ? "_" : "-";
    const parts = stem.split(/[-_]/).map((part) => {
      const rule = PATH_WORDS.find((word) => word.from === part);
      if (!rule) return part;
      return separator === "_" ? (rule.snake ?? rule.to.replace(/-/g, "_")) : rule.to;
    });
    next = parts.join(separator).replace(/commerce([-_])commerce/g, "commerce");
  } else {
    next = renameIdentifierAt(stem, new Map());
  }
  return next + ext;
}

const moves = new Map(); // old path -> new path, or null for a delete
for (const file of tracked) {
  let next = file;
  for (const [from, to] of DIRECTORY_RENAMES) {
    if (file === from || file.startsWith(`${from}/`)) {
      next = to === null ? null : to + file.slice(from.length);
      break;
    }
  }
  if (next !== null && !isExcluded(file)) next = next.split("/").map(renamePathSegment).join("/");
  if (next !== file) moves.set(file, next);
}
const newPathOf = (file) => (moves.has(file) ? moves.get(file) : file);

const moveTargets = new Map();
const moveCollisions = [];
for (const [from, to] of moves) {
  if (to === null) continue;
  if ((trackedSet.has(to) && !moves.has(to)) || moveTargets.has(to)) moveCollisions.push({ from, to });
  moveTargets.set(to, from);
}
for (const collision of moveCollisions) moves.delete(collision.from);

/** The new path of a file if only the folder renames applied. */
function folderMoveOnly(file) {
  for (const [from, to] of DIRECTORY_RENAMES) {
    if (file.startsWith(`${from}/`)) return to === null ? null : to + file.slice(from.length);
  }
  return file;
}

/** Old repository path -> new path, also without the extension. */
const movedPathText = [...moves]
  .filter(([from, to]) => to !== null && folderMoveOnly(from) !== to)
  .flatMap(([from, to]) => {
    const pairs = [[from, to]];
    const fromStem = from.replace(/\.[^./]+$/, "");
    const toStem = to.replace(/\.[^./]+$/, "");
    if (fromStem !== from) pairs.push([fromStem, toStem]);
    return pairs;
  });
for (const [from, to] of DIRECTORY_RENAMES) if (to) movedPathText.push([from, to]);
movedPathText.sort((a, b) => b[0].length - a[0].length);

function rewriteRepoPaths(text) {
  let result = text;
  for (const [from, to] of movedPathText) {
    if (!result.includes(from)) continue;
    result = result.replace(new RegExp(`(?<![\\w./-])${escapeRegExp(from)}(?![\\w-])`, "g"), to);
    // A relative form inside a longer string, such as "--dir ../../services/underclerk".
    result = result.replace(new RegExp(`(?<=(?:^|[^\\w.-])(?:\\.\\.?/)+)${escapeRegExp(from)}(?![\\w-])`, "g"), to);
  }
  return result;
}

function resolveOld(fromFile, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  if (trackedSet.has(base)) return { file: base, suffix: "" };
  const jsToTs = base.replace(/\.(m?)js$/, ".$1ts").replace(/\.jsx$/, ".tsx");
  if (jsToTs !== base && trackedSet.has(jsToTs)) return { file: jsToTs, suffix: "jsToTs" };
  for (const ext of RESOLVE_EXTENSIONS) if (trackedSet.has(base + ext)) return { file: base + ext, suffix: ext };
  for (const ext of RESOLVE_EXTENSIONS) if (trackedSet.has(`${base}/index${ext}`)) return { file: `${base}/index${ext}`, suffix: `/index${ext}` };
  if (trackedDirs.has(base)) return { dir: base };
  return null;
}

function newDirOf(dir) {
  for (const [from, to] of DIRECTORY_RENAMES) {
    if (dir === from || dir.startsWith(`${from}/`)) return to === null ? null : to + dir.slice(from.length);
  }
  return dir.split("/").map(renamePathSegment).join("/");
}

/** A relative path inside a string: a module specifier or a file path. */
function rewriteRelative(fromFile, specifier) {
  if (!/^\.\.?\//.test(specifier)) return specifier;
  const [pathPart, query = ""] = specifier.split(/(?=[?#])/);
  const resolved = resolveOld(fromFile, pathPart.replace(/\/$/, ""));
  if (!resolved) return specifier;
  const newFrom = newPathOf(fromFile);
  if (newFrom === null) return specifier;
  // A path whose two ends stay where they are keeps its exact text.
  if (resolved.dir ? newDirOf(resolved.dir) === resolved.dir && !moves.has(fromFile) : !moves.has(fromFile) && !moves.has(resolved.file)) {
    return specifier;
  }
  let next;
  if (resolved.dir) {
    const target = newDirOf(resolved.dir);
    if (target === null) return specifier;
    next = path.posix.relative(path.posix.dirname(newFrom), target) || ".";
  } else {
    const newFile = newPathOf(resolved.file);
    if (newFile === null) return specifier;
    // Relative to the file itself, then drop what the specifier left out.
    let full = path.posix.relative(path.posix.dirname(newFrom), newFile);
    if (resolved.suffix === "jsToTs") full = full.replace(/\.(m?)ts$/, ".$1js").replace(/\.tsx$/, ".jsx");
    else if (resolved.suffix.startsWith("/index")) full = full === resolved.suffix.slice(1) ? "." : full.slice(0, full.length - resolved.suffix.length);
    else if (resolved.suffix !== "") full = full.slice(0, full.length - resolved.suffix.length);
    next = full;
  }
  if (!next.startsWith(".")) next = `./${next}`;
  if (pathPart.endsWith("/") && !next.endsWith("/")) next += "/";
  return next === pathPart ? specifier : next + query;
}

// ---------------------------------------------------------------- packages

const packageEntries = [...PACKAGE_RENAMES].sort((a, b) => b[0].length - a[0].length);
function rewritePackageNames(text) {
  let result = text;
  for (const [from, to] of packageEntries) {
    if (!result.includes(from)) continue;
    // A "/" may come first: Vite serves a package as "/@id/@satyr/std".
    result = result.replace(new RegExp(`(?<![\\w@-])${escapeRegExp(from)}(?![\\w-])`, "g"), to);
  }
  // Wildcards such as "@satyr/*" in tsconfig paths.
  return result
    .replace(/(?<![\w@/-])@satyr\/\*/g, "@seams/*")
    .replace(/(?<![\w@/-])@lowerarchy\/\*/g, "@seams/*");
}

function rewriteFilters(text) {
  let result = text;
  for (const [from, to] of UNSCOPED_PACKAGE_RENAMES) {
    // A filter is an argument (`--filter satyr-edge`) or two items of an
    // argument list (`"--filter", "satyr-edge"` in Python or JavaScript).
    result = result.replace(new RegExp(`((?:--filter|-F)(?:=|\\s+|["']\\s*,\\s*["']))${escapeRegExp(from)}(?![\\w-])`, "g"), `$1${to}`);
  }
  for (const [from, to] of LINT_RENAMES) result = result.replace(new RegExp(`(?<![\\w:-])${escapeRegExp(from)}(?![\\w-])`, "g"), to);
  return result;
}

// ---------------------------------------------------------------- CSS classes

const cssClasses = new Set();
const cssProperties = new Set();
for (const file of tracked) {
  if (isExcluded(file) || !/\.(css|scss|vue)$/.test(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  const css = file.endsWith(".vue") ? [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join("\n") : source;
  for (const match of css.matchAll(/\.(satyr-[a-z0-9_-]+)/g)) cssClasses.add(match[1]);
  for (const match of css.matchAll(/(--satyr-[a-z0-9-]+)\s*:/g)) cssProperties.add(match[1]);
}
const cssPropertyList = [...cssProperties].sort((a, b) => b.length - a.length);
const cssClassList = [...cssClasses].sort((a, b) => b.length - a.length);
function rewriteCssClasses(text) {
  let result = text;
  for (const name of cssClassList) {
    if (!result.includes(name)) continue;
    result = result.replace(new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`, "g"), name.replace(/^satyr-/, "pantry-"));
  }
  for (const name of cssPropertyList) {
    if (!result.includes(name)) continue;
    result = result.replace(new RegExp(`${escapeRegExp(name)}(?![\\w-])`, "g"), name.replace(/^--satyr-/, "--pantry-"));
  }
  return result.replace(/data-satyr-theme/g, "data-pantry-theme");
}

// ---------------------------------------------------------------- masks

function withMasks(text, transform) {
  const saved = [];
  let masked = text;
  for (const pattern of PROTECTED_TEXT) {
    masked = masked.replace(pattern, (match) => {
      saved.push(match);
      return `\u0000${saved.length - 1}\u0000`;
    });
  }
  const next = transform(masked);
  return next.replace(/\u0000(\d+)\u0000/g, (_, index) => saved[Number(index)]);
}

const OLD_WORD = /satyr|underclerk|urk|lowerarchy/i;

/** Names of packages, paths, lints and classes, with the protected text kept. */
function rewriteNames(text) {
  if (!OLD_WORD.test(text)) return text;
  // Filters first: `--filter satyr-edge` names a package, not the Worker.
  return withMasks(rewriteFilters(text), (masked) => rewriteCssClasses(rewriteRepoPaths(rewritePackageNames(masked))));
}

/** Text that is a value: only module paths, repository paths and classes change. */
function rewriteValueText(text, fromFile) {
  if (!OLD_WORD.test(text)) return text;
  if (/^\.\.?\//.test(text) && fromFile) return rewriteRelative(fromFile, text);
  return rewriteNames(text);
}

let identifierMap = new Map(); // filled before the rewrite
/**
 * Code names in prose. A plain lowercase word such as "underclerk" is prose,
 * not a code name, so only names with a capital, an underscore or a $ count.
 */
const renamedIdentifierPattern = () => {
  // A name that is also a member somewhere may be a stored or sent field, so
  // prose keeps it: the member keeps its old name in the code too.
  const names = [...identifierMap.keys()].filter((name) => /[A-Z_$]/.test(name) && !memberOldNames.has(name));
  return names.length === 0 ? null : new RegExp(`(?<![\\w$-])(${names.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})(?![\\w$-])`, "g");
};
let identifierTextPattern = null;

/** Prose in a comment: code names change as words. */
function rewriteProse(text) {
  if (!OLD_WORD.test(text) && !/BakeryO|CafeO|AgentCommerce/.test(text)) return text;
  return withMasks(rewriteFilters(text), (masked) => {
    let result = rewriteCssClasses(rewriteRepoPaths(rewritePackageNames(masked)));
    if (identifierTextPattern) result = result.replace(identifierTextPattern, (name) => identifierMap.get(name) ?? name);
    return result
      .replace(/\bSatyr Kitchen\b/g, "Kitchen")
      .replace(/\bSatyr\b/g, "Pantry")
      .replace(/\bsatyr\b/g, "pantry")
      .replace(/\bUnderclerk\b/g, "Commerce")
      .replace(/\bunderclerk\b/g, "commerce")
      .replace(/\bUrk\b/g, "Sous Chef");
  });
}

/** Markdown: names of packages, paths, lints, classes and code spans. */
function rewriteMarkdown(text) {
  return withMasks(rewriteFilters(text), (masked) => {
    let result = rewriteCssClasses(rewriteRepoPaths(rewritePackageNames(masked)));
    if (identifierTextPattern) {
      result = result.replace(/`([^`\n]+)`/g, (span, inner) => `\`${inner.replace(identifierTextPattern, (name) => identifierMap.get(name) ?? name)}\``);
    }
    return result;
  });
}

// ---------------------------------------------------------------- TypeScript

function scriptKindOf(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(m|c)?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** A module inside this repository: relative, or a workspace package. */
function isWorkspaceModule(specifier) {
  if (/^\.\.?\//.test(specifier)) return true;
  if (/^@seams\//.test(specifier)) return true;
  for (const [from] of PACKAGE_RENAMES) if (specifier === from || specifier.startsWith(`${from}/`)) return true;
  return false;
}

/** The module of an import or export specifier, or null. */
function specifierModule(node) {
  let current = node.parent;
  while (current && !ts.isImportDeclaration(current) && !ts.isExportDeclaration(current)) current = current.parent;
  return current?.moduleSpecifier && ts.isStringLiteral(current.moduleSpecifier) ? current.moduleSpecifier.text : null;
}

function namespaceImports(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      isWorkspaceModule(statement.moduleSpecifier.text) &&
      statement.importClause?.namedBindings &&
      ts.isNamespaceImport(statement.importClause.namedBindings)
    ) {
      names.add(statement.importClause.namedBindings.name.text);
    }
    if (ts.isImportEqualsDeclaration(statement)) names.add(statement.name.text);
  }
  return names;
}

function identifierRole(id, namespaces) {
  const parent = id.parent;
  if (!parent) return "binding";
  const isNamespace = (expression) => ts.isIdentifier(expression) && namespaces.has(expression.text);
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
    if (isNamespace(parent.expression)) return "binding";
    if (id.text === "satyrTheme" && ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "dataset") return "dataset";
    return "member";
  }
  if (ts.isQualifiedName(parent) && parent.right === id) return isNamespace(parent.left) ? "binding" : "member";
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isJsxAttribute(parent)) &&
    parent.name === id
  ) {
    return "member";
  }
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === id) return "shorthand";
  // A name that another repository exports keeps its text; the local name may change.
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) {
    const module = specifierModule(parent);
    if (module && !isWorkspaceModule(module)) {
      if (parent.propertyName === id) return "member";
      if (!parent.propertyName && parent.name === id) return ts.isImportSpecifier(parent) ? "external-import" : "member";
    }
  }
  if (ts.isBindingElement(parent)) {
    if (parent.propertyName === id) return "member";
    if (parent.name === id && !parent.propertyName && ts.isObjectBindingPattern(parent.parent)) return "shorthand";
  }
  return "binding";
}

function parse(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function isModuleSpecifierString(node) {
  const parent = node.parent;
  if (!parent) return false;
  if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) return true;
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) return true;
  if (ts.isModuleDeclaration(parent) && parent.name === node) return true;
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    const callee = parent.expression;
    const name = callee.kind === ts.SyntaxKind.ImportKeyword ? "import" : callee.getText();
    return /^(import|require|require\.resolve|vi\.mock|vi\.doMock|vi\.importActual|vi\.importMock|jest\.mock)$/.test(name);
  }
  return false;
}

/** Census: every identifier text in a binding role, for collision checks. */
function bindingIdentifiers(file, text) {
  const names = new Set();
  const sourceFile = parse(file, text);
  const namespaces = namespaceImports(sourceFile);
  walk(sourceFile, (node) => {
    if (ts.isIdentifier(node)) {
      const role = identifierRole(node, namespaces);
      if (role === "member" && /^[A-Z][A-Z0-9_]*$/.test(node.text)) memberScreamingNames.add(node.text);
      if (role === "member" && matchesOldWord(node.text)) memberOldNames.add(node.text);
      if (role === "binding" || role === "shorthand" || role === "external-import") names.add(node.text);
    }
  });
  return names;
}

function rewriteTypeScript(file, text) {
  const sourceFile = parse(file, text);
  const namespaces = namespaceImports(sourceFile);
  const edits = [];
  const commentStarts = new Set();
  const addComments = (ranges) => {
    for (const range of ranges ?? []) {
      if (commentStarts.has(range.pos)) continue;
      commentStarts.add(range.pos);
      const original = text.slice(range.pos, range.end);
      const next = rewriteProse(original);
      if (next !== original) edits.push({ start: range.pos, end: range.end, text: next });
    }
  };
  walk(sourceFile, (node) => {
    addComments(ts.getLeadingCommentRanges(text, node.pos));
    addComments(ts.getTrailingCommentRanges(text, node.end));
    if (ts.isIdentifier(node)) {
      const role = identifierRole(node, namespaces);
      if (role === "dataset") {
        edits.push({ start: node.getStart(sourceFile), end: node.end, text: "pantryTheme" });
        return;
      }
      if (role === "member") return;
      const next = identifierMap.get(node.text);
      if (!next) return;
      const replacement = role === "shorthand" ? `${node.text}: ${next}` : role === "external-import" ? `${node.text} as ${next}` : next;
      edits.push({ start: node.getStart(sourceFile), end: node.end, text: replacement });
      return;
    }
    if (ts.isRegularExpressionLiteral(node)) {
      const start = node.getStart(sourceFile);
      const raw = text.slice(start, node.end);
      const next = rewriteRegexLiteral(raw);
      if (next !== raw) edits.push({ start, end: node.end, text: next });
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const start = node.getStart(sourceFile);
      const raw = text.slice(start, node.end);
      const open = ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? 1 : 1;
      const close = ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ? 2 : 1;
      const inner = raw.slice(open, raw.length - close);
      let next;
      if (!isModuleSpecifierString(node) && exactStringRenames.has(inner)) {
        next = exactStringRenames.get(inner);
        exactStringHits.set(inner, [...(exactStringHits.get(inner) ?? []), file]);
      } else if (isModuleSpecifierString(node)) {
        next = /^\.\.?\//.test(inner) ? rewriteRelative(file, inner) : rewritePackageNames(inner);
      } else {
        next = rewriteValueText(inner, file);
      }
      if (next !== inner) edits.push({ start: start + open, end: node.end - close, text: next });
    }
  });
  addComments(ts.getLeadingCommentRanges(text, sourceFile.endOfFileToken.pos));
  return applyEdits(text, edits);
}

function applyEdits(text, edits) {
  edits.sort((a, b) => b.start - a.start);
  let result = text;
  let lastStart = Infinity;
  for (const edit of edits) {
    if (edit.end > lastStart) continue; // an overlap: keep the first edit
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    lastStart = edit.start;
  }
  return result;
}

// ---------------------------------------------------------------- other files

function rewriteCss(file, text) {
  const withComments = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => rewriteProse(comment));
  return withMasks(withComments, (masked) => rewriteCssClasses(masked)).replace(
    /(@import\s+(?:url\()?["'])(\.\.?\/[^"']+)/g,
    (all, head, spec) => head + rewriteRelative(file, spec),
  );
}

function rewriteJson(file, text) {
  if (file.endsWith(".jsonc")) text = text.replace(/(^|[^:"])(\/\/[^\n]*)/g, (all, head, comment) => head + rewriteProse(comment));
  let result = text.replace(/"((?:[^"\\\n]|\\.)*)"/g, (all, inner) => {
    let next = /^\.\.?\//.test(inner) ? rewriteRelative(file, inner) : rewriteValueText(inner, file);
    return `"${next}"`;
  });
  if (path.posix.basename(file) === "package.json") {
    const parsed = JSON.parse(text);
    const nextName = UNSCOPED_PACKAGE_RENAMES.get(parsed.name);
    if (nextName) result = result.replace(new RegExp(`("name"\\s*:\\s*)"${escapeRegExp(parsed.name)}"`), `$1"${nextName}"`);
    for (const [from, to] of UNSCOPED_PACKAGE_RENAMES) {
      result = result.replace(new RegExp(`"${escapeRegExp(from)}"(\\s*:\\s*"workspace:)`, "g"), `"${to}"$1`);
    }
  }
  return result;
}

function rewriteYaml(text) {
  const named = text.replace(/^(\s*-?\s*name:\s*)(.*)$/gm, (all, head, value) => head + rewriteProse(value));
  return rewriteNames(named.replace(/(group:\s*)satyr-/g, "$1pantry-"));
}

function rewriteVueOrHtml(file, text) {
  let result = withMasks(rewriteFilters(text), (masked) => {
    let next = rewriteCssClasses(rewriteRepoPaths(rewritePackageNames(masked)));
    if (identifierTextPattern) next = next.replace(identifierTextPattern, (name) => identifierMap.get(name) ?? name);
    return next.replace(/dataset\.satyrTheme/g, "dataset.pantryTheme");
  });
  result = result.replace(/((?:from|import|src|href)\s*=?\s*["'])(\.\.?\/[^"']+)/g, (all, head, spec) => head + rewriteRelative(file, spec));
  return result;
}

function rewritePlainPaths(text) {
  if (!OLD_WORD.test(text)) return text;
  return withMasks(rewriteFilters(text), (masked) => rewriteRepoPaths(rewritePackageNames(masked)));
}

// ---------------------------------------------------------------- plan

const processable = tracked.filter((file) => !isExcluded(file) && !isBinary(file) && moves.get(file) !== null);
const extOf = (file) => {
  if (file.endsWith(".d.ts")) return ".ts";
  if (/\.jsonc?$/.test(file)) return ".json";
  return path.posix.extname(file);
};

// Collision check for identifiers.
const allOldNames = new Map(); // old -> count
const otherNames = new Set();
/** SCREAMING names read as members (env.X, interface Env): deployed names. */
const memberScreamingNames = new Set();
/** Old-word names that code also uses as members: they may be wire fields. */
const memberOldNames = new Set();
for (const file of processable) {
  if (!TS_EXTENSIONS.has(extOf(file))) continue;
  const text = fs.readFileSync(file, "utf8");
  if (!/Satyr|satyr|SATYR|Underclerk|underclerk|UNDERCLERK|Urk|urk|URK|BakeryO|bakeryO|BAKERY_OS|CafeO|cafeO|CAFE_OS|AgentCommerce|agentCommerce|AGENT_COMMERCE/.test(text)) {
    // Still collect names for collisions.
  }
  for (const name of bindingIdentifiers(file, text)) {
    if (matchesOldWord(name) && !PROTECTED_IDENTIFIERS.has(name) && !/^SATYR_[A-Z0-9_]+$/.test(name)) {
      allOldNames.set(name, (allOldNames.get(name) ?? 0) + 1);
    } else {
      otherNames.add(name);
    }
  }
}

const conflicts = [];
const levelsByName = new Map([...allOldNames.keys()].map((name) => [name, new Map()]));
for (let round = 0; round < 3; round += 1) {
  const targets = new Map();
  for (const name of allOldNames.keys()) {
    const next = renameIdentifierAt(name, levelsByName.get(name));
    if (!targets.has(next)) targets.set(next, []);
    targets.get(next).push(name);
  }
  let changed = false;
  for (const [next, olds] of targets) {
    if (!otherNames.has(next) && olds.length === 1) continue;
    for (const old of olds) {
      if (next === old) continue;
      const levels = levelsByName.get(old);
      const rule = IDENTIFIER_WORDS.find((word) => [word.from, ...(word.alsoFrom ?? [])].some((from) => replaceWord(old, from, "\u0001") !== old));
      const current = levels.get(rule.from) ?? 0;
      if (current < (WORD_FALLBACKS.get(rule.from)?.length ?? 1) - 1) {
        levels.set(rule.from, current + 1);
        changed = true;
      } else {
        levels.set("__keep", 1);
      }
    }
  }
  if (!changed) break;
}
identifierMap = new Map();
for (const name of allOldNames.keys()) {
  const levels = levelsByName.get(name);
  if (levels.has("__keep")) {
    conflicts.push({ name, wanted: renameIdentifierAt(name, levels) });
    continue;
  }
  const next = renameIdentifierAt(name, levels);
  if (next !== name) identifierMap.set(name, next);
}
// A final pass: two names that still meet are kept.
const finalTargets = new Map();
for (const [old, next] of identifierMap) finalTargets.set(next, [...(finalTargets.get(next) ?? []), old]);
for (const [next, olds] of finalTargets) {
  if (olds.length > 1 || otherNames.has(next)) {
    for (const old of olds) {
      identifierMap.delete(old);
      conflicts.push({ name: old, wanted: next });
    }
  }
}
identifierTextPattern = renamedIdentifierPattern();

/**
 * A string that is exactly a renamed code name, such as a lint that looks up
 * "UNDERCLERK_API_SCOPES" by text. Only names with a capital letter qualify,
 * and never a SCREAMING name that code also reads as a member (an env name).
 */
const exactStringRenames = new Map(
  [...identifierMap].filter(
    // A name that code also reads as a member may be a stored or sent field
    // name, such as "satyrLocationId" in a parser: it keeps its text.
    ([from]) => /[A-Z]/.test(from) && !memberScreamingNames.has(from) && !memberOldNames.has(from),
  ),
);
const exactStringHits = new Map(); // old name -> files
const exactNamePattern =
  exactStringRenames.size === 0
    ? null
    : new RegExp(`(?<![\\w$])(${[...exactStringRenames.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})(?![\\w$])`, "g");

/** A regular expression literal: escaped paths and exact code names. */
function rewriteRegexLiteral(text) {
  if (!OLD_WORD.test(text)) return text;
  let result = text;
  for (const [from, to] of movedPathText) {
    const escape = (value) => value.replace(/[.]/g, "\\.").replace(/\//g, "\\/");
    if (result.includes(escape(from))) result = result.split(escape(from)).join(escape(to));
  }
  if (exactNamePattern) result = result.replace(exactNamePattern, (name) => exactStringRenames.get(name) ?? name);
  return result;
}

// ---------------------------------------------------------------- rewrite

const changes = [];
for (const file of processable) {
  const text = fs.readFileSync(file, "utf8");
  const ext = extOf(file);
  let next = text;
  if (TS_EXTENSIONS.has(ext)) next = rewriteTypeScript(file, text);
  else if (ext === ".css" || ext === ".scss") next = rewriteCss(file, text);
  else if (ext === ".json") next = rewriteJson(file, text);
  else if (ext === ".yml" || ext === ".yaml") next = rewriteYaml(text);
  else if (ext === ".vue" || ext === ".html") next = rewriteVueOrHtml(file, text);
  else if (ext === ".md" && DEVELOPER_PROSE_PATHS.some((pattern) => pattern.test(file))) next = rewriteMarkdown(rewriteProse(text));
  else if (ext === ".md" && MARKDOWN_PATHS.some((pattern) => pattern.test(file))) next = rewriteMarkdown(text);
  else if (PATH_TEXT_EXTENSIONS.has(ext) || /(^|\/)(Dockerfile|\.dockerignore|\.gitignore)$/.test(file)) next = rewritePlainPaths(text);
  if (next !== text) changes.push({ file, text: next, lines: countChangedLines(text, next) });
}

function countChangedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let changed = 0;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) if (a[index] !== b[index]) changed += 1;
  return changed;
}

// Residue: what still names an old word in a file that the codemod owns.
// A TypeScript file splits it by kind: string values and member names stay
// by design (wire and stored values); bindings and comments should be empty.
const changedByFile = new Map(changes.map((change) => [change.file, change.text]));
const residuePattern = /satyr|underclerk|(?<![A-Za-z])urk(?![a-z])|Urk(?![a-z])|(?<![A-Za-z])URK(?![A-Za-z])/i;
const stripProtected = (text) => PROTECTED_TEXT.reduce((acc, pattern) => acc.replace(pattern, ""), text);
const residue = { binding: [], comment: [], string: [], member: [], other: [] };
const residueTokens = { binding: new Map(), comment: new Map(), string: new Map(), member: new Map(), other: new Map() };
function noteResidue(kind, file, text, position, sample) {
  const visible = stripProtected(text);
  if (!residuePattern.test(visible)) return;
  for (const token of visible.match(/[A-Za-z0-9_$.:@/-]*(?:satyr|underclerk|urk)[A-Za-z0-9_$.:@/-]*/gi) ?? []) {
    residueTokens[kind].set(token, (residueTokens[kind].get(token) ?? 0) + 1);
  }
  residue[kind].push(`${newPathOf(file)}:${position}: ${sample.trim().slice(0, 160)}`);
}
for (const file of processable) {
  const text = changedByFile.get(file) ?? fs.readFileSync(file, "utf8");
  if (!residuePattern.test(stripProtected(text))) continue;
  if (TS_EXTENSIONS.has(extOf(file))) {
    const sourceFile = parse(file, text);
    const namespaces = namespaceImports(sourceFile);
    const seenComments = new Set();
    const lineOf = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
    const comments = (ranges) => {
      for (const range of ranges ?? []) {
        if (seenComments.has(range.pos)) continue;
        seenComments.add(range.pos);
        const comment = text.slice(range.pos, range.end);
        noteResidue("comment", file, comment, lineOf(range.pos), comment.split("\n").find((line) => residuePattern.test(stripProtected(line))) ?? comment);
      }
    };
    walk(sourceFile, (node) => {
      comments(ts.getLeadingCommentRanges(text, node.pos));
      comments(ts.getTrailingCommentRanges(text, node.end));
      if (ts.isIdentifier(node)) {
        const role = identifierRole(node, namespaces);
        if (PROTECTED_IDENTIFIERS.has(node.text) || /^SATYR_[A-Z0-9_]+$/.test(node.text)) return;
        noteResidue(role === "member" ? "member" : "binding", file, node.text, lineOf(node.getStart(sourceFile)), node.text);
      } else if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
        noteResidue("string", file, node.getText(sourceFile), lineOf(node.getStart(sourceFile)), node.getText(sourceFile));
      }
    });
  } else {
    text.split("\n").forEach((line, index) => noteResidue("other", file, line, index + 1, line));
  }
}
const topTokens = (kind) =>
  [...residueTokens[kind]].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([token, count]) => `  - ${count} \`${token}\``);

// ---------------------------------------------------------------- report

const movedFiles = [...moves].filter(([, to]) => to !== null);
const deletedFiles = [...moves].filter(([, to]) => to === null).map(([from]) => from);
const report = [
  `# Plan 91 codemod ${WRITE ? "write" : "dry run"}`,
  "",
  `- Files changed: ${changes.length}; lines changed: ${changes.reduce((sum, change) => sum + change.lines, 0)}`,
  `- Files moved: ${movedFiles.length}; files deleted: ${deletedFiles.length}; move collisions: ${moveCollisions.length}`,
  `- Identifiers renamed: ${identifierMap.size}; kept because of a collision: ${conflicts.length}`,
  `- CSS classes renamed: ${cssClasses.size}; CSS custom properties renamed: ${cssProperties.size}`,
  `- Residue in bindings: ${residue.binding.length}; comments: ${residue.comment.length}; other files: ${residue.other.length}`,
  `- Kept by design: string values ${residue.string.length}; member names ${residue.member.length}`,
  "",
  "## Identifier renames",
  "",
  ...[...identifierMap].sort().map(([from, to]) => `- \`${from}\` → \`${to}\``),
  "",
  "## Exact strings renamed (review: each must be a code name, not a wire value)",
  "",
  ...[...exactStringHits].sort().map(([from, files]) => `- \`${from}\` → \`${exactStringRenames.get(from)}\` in ${[...new Set(files)].join(", ")}`),
  "",
  "## Kept because of a collision",
  "",
  ...conflicts.map((conflict) => `- \`${conflict.name}\` (wanted \`${conflict.wanted}\`)`),
  "",
  "## Moves",
  "",
  ...movedFiles.map(([from, to]) => `- ${from} → ${to}`),
  ...deletedFiles.map((from) => `- ${from} → deleted`),
  ...moveCollisions.map((collision) => `- COLLISION ${collision.from} → ${collision.to}`),
  "",
  "## Residue: bindings (should be empty)",
  "",
  ...topTokens("binding"),
  ...residue.binding.map((line) => `- ${line}`),
  "",
  "## Residue: comments",
  "",
  ...topTokens("comment"),
  ...residue.comment.slice(0, 400).map((line) => `- ${line}`),
  "",
  "## Residue: other files",
  "",
  ...topTokens("other"),
  ...residue.other.slice(0, 600).map((line) => `- ${line}`),
  "",
  "## Kept by design: top string values",
  "",
  ...topTokens("string"),
  "",
  "## Kept by design: top member names",
  "",
  ...topTokens("member"),
  "",
].join("\n");

if (REPORT_PATH) fs.writeFileSync(REPORT_PATH, report);
console.log(report.split("\n").slice(0, 8).join("\n"));

if (WRITE) {
  for (const change of changes) fs.writeFileSync(change.file, change.text);
  for (const from of deletedFiles) execFileSync("git", ["rm", "-q", "-r", "--cached", from]), fs.rmSync(from, { force: true });
  for (const [from, to] of movedFiles) {
    fs.mkdirSync(path.posix.dirname(to), { recursive: true });
    execFileSync("git", ["mv", from, to]);
  }
  for (const [from] of DIRECTORY_RENAMES) {
    if (fs.existsSync(from) && fs.readdirSync(from).length === 0) fs.rmSync(from, { recursive: true });
  }
  console.log("Written. Next: pnpm install --offline, then the Plan 91 phase 1 checks.");
}

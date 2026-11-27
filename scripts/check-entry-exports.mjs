#!/usr/bin/env node
// The ratchet of the dead exports of package entry files (Refactor 17, the
// exit row "No public export without a user in another module").
//
// knip (scripts/check-unused.mjs) judges the export of a file that an entry
// file reaches. It does not judge an export of an entry file itself. This
// check does. An entry file is:
//   - a file that the `exports` map of a workspace package.json names. A
//     target with `*` names each file of its folder that matches, not the
//     files of a deeper folder (the reading of knip);
//   - a file that an `entry` pattern of knip.json names.
//
// An export of an entry file is dead when no other file of the repository
// imports it. The check reads each tracked source file with the parser of
// TypeScript (syntax only, no type check) and follows each import to the
// file that declares the name:
//   - `export { a as b } from "x"`, `import { a } from "x"; export { a }` and
//     `export * from "x"` are links of a chain, so an import of the end file
//     through the entry marks the name of the entry;
//   - `import * as ns from "x"` marks each `ns.name` that the file reads, and
//     each name of x when the file uses `ns` in another way;
//   - `import("x")` marks the names that the file reads from the result
//     (`(await import("x")).a`, `const { a } = await import("x")`), and each
//     name of x in another form; `typeof import("x")` and `require("x")` mark
//     each name; `import("x").A` in a type or a JSDoc comment marks A.
// A use inside the entry file itself is not an import: the export keyword is
// then dead, but the declaration stays.
//
// scripts/entry-exports-ratchet.json holds one count for each package, and
// the groups of exports that stay with no importer, each with its reason (a
// Worker entry that the runtime reads, a wire shape of an outside client).
// A count may not grow, and a new package is refused. An export with a
// `@public` tag in its doc comment is in no count: the tag names its reader.
//
//   node scripts/check-entry-exports.mjs                    check
//   node scripts/check-entry-exports.mjs --update           lower the counts
//   node scripts/check-entry-exports.mjs --report           print the counts and the kept groups
//   node scripts/check-entry-exports.mjs --report <package> print the dead exports of one package
//                                                           ("all" for each), with the file that
//                                                           declares a re-exported name
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "scripts/entry-exports-ratchet.json";
const SCRIPT = "scripts/check-entry-exports.mjs";
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const ALL = "*";

const mode = process.argv[2] ?? "check";
const reportPackage = process.argv[3];
if (!["check", "--update", "--report"].includes(mode)) {
  console.error(`Unknown argument ${mode}.`);
  process.exit(2);
}

// --- The files and the packages ----------------------------------------

const tracked = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter(
    (file) =>
      SOURCE.test(file) &&
      !file.split("/").includes("node_modules") &&
      existsSync(join(root, file)),
  );
const known = new Set(tracked);

/** The workspace packages: folder, name and `exports`, deepest folder first. */
const packages = workspaceFolders()
  .map((folder) => {
    const manifest = JSON.parse(
      readFileSync(join(root, folder, "package.json"), "utf8"),
    );
    return { folder, name: manifest.name ?? folder, exports: manifest.exports };
  })
  .sort((a, b) => b.folder.length - a.folder.length);
const packagesByName = new Map(packages.map((entry) => [entry.name, entry]));

function workspaceFolders() {
  const text = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const block = text.split(/^packages:\s*$/mu)[1].split(/^\S/mu)[0];
  const patterns = [...block.matchAll(/^\s+-\s+["']?([^"'\s]+)/gmu)].map(
    (match) => match[1],
  );
  return patterns
    .flatMap((pattern) => globSync(pattern, { cwd: root }))
    .filter(
      (folder) =>
        known.has(`${folder}/package.json`) ||
        existsSync(join(root, folder, "package.json")),
    )
    .filter((folder) => !folder.includes("/public/"));
}

function packageOf(file) {
  return (
    packages.find((entry) => file.startsWith(`${entry.folder}/`))?.name ??
    "(root)"
  );
}

/** Each file that an `exports` map or a knip.json `entry` names. */
function entryFiles() {
  const entries = new Set();
  for (const entry of packages) {
    for (const target of exportTargets(entry.exports)) {
      for (const file of expandTarget(entry.folder, target)) entries.add(file);
    }
  }
  const knip = JSON.parse(readFileSync(join(root, "knip.json"), "utf8"));
  for (const [workspace, config] of Object.entries(knip.workspaces ?? {})) {
    for (const folder of globSync(workspace, { cwd: root })) {
      for (const pattern of config.entry ?? []) {
        for (const file of globSync(posix.join(folder, pattern), {
          cwd: root,
        })) {
          if (known.has(file)) entries.add(file);
        }
      }
    }
  }
  return entries;
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

function expandTarget(folder, target) {
  if (!SOURCE.test(target) || target.endsWith(".d.ts")) return [];
  const path = posix.join(folder, target);
  if (!path.includes("*")) return known.has(path) ? [path] : [];
  const [prefix, suffix] = path.split("*");
  return tracked.filter(
    (file) =>
      file.startsWith(prefix) &&
      file.endsWith(suffix) &&
      file.length >= prefix.length + suffix.length &&
      !file.slice(prefix.length, file.length - suffix.length).includes("/"),
  );
}

// --- Resolution ----------------------------------------------------------

const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".d.ts",
  ".js",
  ".mjs",
  ".jsx",
  ".cjs",
];

function fileAt(base) {
  const candidates = [base];
  const bare = base.replace(/\.(m?js|jsx|cjs)$/u, "");
  for (const extension of EXTENSIONS) candidates.push(`${bare}${extension}`);
  for (const extension of EXTENSIONS)
    candidates.push(`${base}/index${extension}`);
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

const WORKSPACE = /^(@[a-z0-9-]+\/[a-z0-9-]+)(\/.*)?$/u;

function resolve(from, specifier) {
  if (specifier.startsWith(".")) {
    return fileAt(posix.normalize(posix.join(posix.dirname(from), specifier)));
  }
  const match = WORKSPACE.exec(specifier);
  const entry = match === null ? undefined : packagesByName.get(match[1]);
  if (entry === undefined) return null;
  const subpath = `.${match[2] ?? ""}`;
  for (const target of exportMapTargets(entry.exports, subpath)) {
    const found = fileAt(posix.join(entry.folder, target));
    if (found !== null) return found;
    // A built target (dist/x.js) of a source file (src/x.ts).
    const source = fileAt(
      posix.join(
        entry.folder,
        target.replace(/^\.\/dist\//u, "./src/").replace(/\.d\.ts$/u, ""),
      ),
    );
    if (source !== null) return source;
  }
  return entry.exports === undefined
    ? fileAt(posix.join(entry.folder, subpath))
    : null;
}

/** The targets of a subpath in an `exports` map, by Node's rules. */
function exportMapTargets(exportsMap, subpath) {
  if (exportsMap === undefined || exportsMap === null) return [];
  const map =
    typeof exportsMap === "string" ||
    !Object.keys(exportsMap)[0]?.startsWith(".")
      ? { ".": exportsMap }
      : exportsMap;
  if (map[subpath] !== undefined) return exportTargets(map[subpath]);
  let best = null;
  for (const key of Object.keys(map)) {
    if (!key.includes("*")) continue;
    const [head, tail] = key.split("*");
    if (
      subpath.startsWith(head) &&
      subpath.endsWith(tail) &&
      subpath.length >= head.length + tail.length &&
      (best === null || head.length > best.head.length)
    ) {
      best = { key, head, tail };
    }
  }
  if (best === null) return [];
  const middle = subpath.slice(
    best.head.length,
    subpath.length - best.tail.length,
  );
  return exportTargets(map[best.key]).map((target) =>
    target.replaceAll("*", middle),
  );
}

// --- The parse of one file -----------------------------------------------

/**
 * The exports and the uses of one file.
 *   local:   export name -> true (a declaration of this file)
 *   links:   export name -> { file, name } (a re-export; name ALL = namespace)
 *   stars:   files of `export * from`
 *   uses:    [{ file, name }] the names that this file imports (ALL = each)
 *   publics: the export names with a `@public` tag
 */
function readFile(file) {
  const text = readFileSync(join(root, file), "utf8");
  const kind = /\.(tsx|jsx)$/u.test(file)
    ? ts.ScriptKind.TSX
    : /\.(m?js|cjs)$/u.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const info = {
    local: new Map(),
    links: new Map(),
    stars: [],
    uses: [],
    publics: new Set(),
  };
  const bindings = new Map(); // local name -> { file, name }
  const namespaces = new Map(); // local name -> file
  const target = (specifier) => resolve(file, specifier);
  const use = (resolved, name) => {
    if (resolved !== null) info.uses.push({ file: resolved, name });
  };
  const isPublic = (node) =>
    ts.getJSDocTags(node).some((tag) => tag.tagName.text === "public");
  const addLocal = (name, node) => {
    info.local.set(name, true);
    if (isPublic(node)) info.publics.add(name);
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const resolved = target(statement.moduleSpecifier.text);
      const clause = statement.importClause;
      if (resolved === null || clause === undefined) continue;
      if (clause.name)
        bindings.set(clause.name.text, { file: resolved, name: "default" });
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named))
        namespaces.set(named.name.text, resolved);
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          bindings.set(element.name.text, {
            file: resolved,
            name: (element.propertyName ?? element.name).text,
          });
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const resolved = statement.moduleSpecifier
        ? target(statement.moduleSpecifier.text)
        : undefined;
      const clause = statement.exportClause;
      if (resolved === null) {
        // A re-export of an outside package: a declaration of this file.
        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements)
            addLocal(element.name.text, statement);
        }
        if (clause && ts.isNamespaceExport(clause))
          addLocal(clause.name.text, statement);
        continue;
      }
      if (clause === undefined) {
        info.stars.push(resolved);
      } else if (ts.isNamespaceExport(clause)) {
        info.links.set(clause.name.text, { file: resolved, name: ALL });
        if (isPublic(statement)) info.publics.add(clause.name.text);
      } else {
        for (const element of clause.elements) {
          const exported = element.name.text;
          const inner = (element.propertyName ?? element.name).text;
          if (isPublic(statement)) info.publics.add(exported);
          if (resolved !== undefined) {
            info.links.set(exported, { file: resolved, name: inner });
          } else {
            info.links.set(exported, { local: inner });
          }
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      addLocal("default", statement);
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)
      : undefined;
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
      continue;
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      addLocal("default", statement);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name))
          addLocal(name, statement);
      }
    } else if (statement.name && ts.isIdentifier(statement.name)) {
      addLocal(statement.name.text, statement);
    }
  }

  // `export { a }` of an imported binding is a link of a chain.
  for (const [exported, link] of info.links) {
    if (link.local === undefined) continue;
    if (bindings.has(link.local))
      info.links.set(exported, bindings.get(link.local));
    else if (namespaces.has(link.local)) {
      info.links.set(exported, { file: namespaces.get(link.local), name: ALL });
    } else {
      info.links.delete(exported);
      info.local.set(exported, true);
    }
  }
  // An imported binding is a use, but for one that only an `export { a }`
  // names: that one is a link, and its export decides.
  const referenced = new Set();
  const reexported = new Set(
    [...info.links.values()].filter((link) => link.file !== undefined),
  );
  const collect = (node) => {
    if (ts.isIdentifier(node) && !isBindingName(node))
      referenced.add(node.text);
    ts.forEachChild(node, collect);
  };
  collect(source);
  for (const [local, binding] of bindings) {
    if (!reexported.has(binding) || referenced.has(local)) {
      use(binding.file, binding.name);
    }
  }

  const visit = (node) => {
    if (
      ts.isIdentifier(node) &&
      namespaces.has(node.text) &&
      !isDeclarationName(node)
    ) {
      const parent = node.parent;
      const resolved = namespaces.get(node.text);
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        use(resolved, parent.name.text);
      } else if (ts.isQualifiedName(parent) && parent.left === node) {
        use(resolved, parent.right.text);
      } else if (
        !ts.isNamespaceImport(parent) &&
        !ts.isExportSpecifier(parent)
      ) {
        use(resolved, ALL);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const argument = node.arguments[0];
      const literal =
        argument && ts.isStringLiteralLike(argument) ? argument.text : null;
      if (literal !== null && callee.kind === ts.SyntaxKind.ImportKeyword) {
        for (const name of dynamicNames(node)) use(target(literal), name);
      } else if (
        literal !== null &&
        ts.isIdentifier(callee) &&
        callee.text === "require"
      ) {
        use(target(literal), ALL);
      }
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal;
      if (ts.isStringLiteral(literal)) {
        const qualifier = node.qualifier;
        const first =
          qualifier === undefined
            ? null
            : ts.isIdentifier(qualifier)
              ? qualifier.text
              : leftmost(qualifier);
        use(target(literal.text), first ?? ALL);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // JSDoc types of a script: `{import("x").Name}`.
  if (kind === ts.ScriptKind.JS) {
    for (const match of text.matchAll(
      /import\(\s*["']([^"']+)["']\s*\)(?:\.(\w+))?/gu,
    )) {
      use(target(match[1]), match[2] ?? ALL);
    }
  }
  return info;
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function leftmost(name) {
  return ts.isIdentifier(name) ? name.text : leftmost(name.left);
}

/** A name in an import or an export list, which is not a reference. */
function isBindingName(node) {
  const parent = node.parent;
  return (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node)
  );
}

function isDeclarationName(node) {
  const parent = node.parent;
  return (
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node)
  );
}

/** The names that the code reads from the module of `import("x")`. */
function dynamicNames(call) {
  let node = call;
  if (ts.isAwaitExpression(node.parent)) node = node.parent;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    if (parent.name.text !== "then") return [parent.name.text];
    return thenNames(parent.parent);
  }
  if (
    ts.isVariableDeclaration(parent) &&
    ts.isObjectBindingPattern(parent.name)
  ) {
    return objectPatternNames(parent.name);
  }
  return [ALL];
}

/** `import("x").then((m) => m.a)` and `.then(({ a }) => …)`. */
function thenNames(call) {
  const callback = ts.isCallExpression(call) ? call.arguments[0] : undefined;
  if (
    !callback ||
    !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
  ) {
    return [ALL];
  }
  const parameter = callback.parameters[0]?.name;
  if (parameter === undefined) return [];
  if (ts.isObjectBindingPattern(parameter))
    return objectPatternNames(parameter);
  if (!ts.isIdentifier(parameter)) return [ALL];
  const names = [];
  let other = false;
  const visit = (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === parameter.text &&
      node !== parameter
    ) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        names.push(parent.name.text);
      } else if (!(
        ts.isPropertyAccessExpression(parent) && parent.name === node
      )) {
        other = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return other ? [ALL] : names;
}

function objectPatternNames(pattern) {
  const names = [];
  for (const element of pattern.elements) {
    if (element.dotDotDotToken) return [ALL];
    const key = element.propertyName ?? element.name;
    if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return [ALL];
    names.push(key.text);
  }
  return names;
}

// --- The graph -----------------------------------------------------------

const files = new Map(tracked.map((file) => [file, readFile(file)]));

/** Each export name of a file, through its `export *` chains. */
const namesCache = new Map();
function exportNames(file, seen = new Set()) {
  if (namesCache.has(file)) return namesCache.get(file);
  const info = files.get(file);
  if (info === undefined || seen.has(file)) return new Set();
  seen.add(file);
  const names = new Set([...info.local.keys(), ...info.links.keys()]);
  for (const star of info.stars) {
    for (const name of exportNames(star, seen)) {
      if (name !== "default") names.add(name);
    }
  }
  namesCache.set(file, names);
  return names;
}

/** file -> the export names that another file imports. */
const used = new Map();
function mark(file, name) {
  const info = files.get(file);
  if (info === undefined) return;
  if (name === ALL) {
    for (const each of exportNames(file)) mark(file, each);
    return;
  }
  const names = used.get(file) ?? new Set();
  if (names.has(name)) return;
  names.add(name);
  used.set(file, names);
  const link = info.links.get(name);
  if (link !== undefined) {
    mark(link.file, link.name);
    return;
  }
  if (info.local.has(name)) return;
  for (const star of info.stars) {
    if (exportNames(star).has(name)) mark(star, name);
  }
}
for (const [file, info] of files) {
  for (const { file: imported, name } of info.uses) {
    if (imported !== file) mark(imported, name);
  }
}

/**
 * The file that declares an export name, at the end of its re-export chain,
 * or null for a namespace or a name of an outside package.
 */
function declaration(file, name, seen = new Set()) {
  const info = files.get(file);
  if (info === undefined || seen.has(file)) return null;
  seen.add(file);
  const link = info.links.get(name);
  if (link !== undefined) {
    return link.name === ALL ? null : declaration(link.file, link.name, seen);
  }
  if (info.local.has(name)) return file;
  for (const star of info.stars) {
    if (exportNames(star).has(name)) return declaration(star, name, seen);
  }
  return null;
}

// --- The dead exports ----------------------------------------------------

const baseline = existsSync(join(root, BASELINE))
  ? JSON.parse(readFileSync(join(root, BASELINE), "utf8"))
  : { keep: {}, counts: {} };
const keepGroups = Object.entries(baseline.keep ?? {}).map(
  ([group, value]) => ({
    group,
    ...value,
  }),
);

function keptBy(entry) {
  const [file, name] = entry.split("#");
  return (
    keepGroups.find(
      (group) =>
        (group.files ?? []).some((pattern) =>
          posix.matchesGlob(file, pattern),
        ) &&
        (group.names === undefined || group.names.includes(name)),
    ) ?? null
  );
}

// A kept export and a `@public` one have a reader outside the import
// graph, so the names at the end of their chains are in use too.
const entries = [...entryFiles()].sort();
const kept = new Map(); // group -> count
for (const file of entries) {
  const info = files.get(file);
  if (info === undefined) continue;
  const usedNames = new Set(used.get(file));
  for (const name of [...exportNames(file)].sort()) {
    if (usedNames.has(name)) continue;
    const group = keptBy(`${file}#${name}`);
    if (group !== null) {
      kept.set(group.group, (kept.get(group.group) ?? 0) + 1);
    }
    if (group !== null || info.publics.has(name)) mark(file, name);
  }
}
const dead = new Map(); // package -> [entry]
for (const file of entries) {
  const usedNames = used.get(file) ?? new Set();
  for (const name of [...exportNames(file)].sort()) {
    if (usedNames.has(name)) continue;
    const owner = packageOf(file);
    dead.set(owner, [...(dead.get(owner) ?? []), `${file}#${name}`]);
  }
}
const counts = Object.fromEntries(
  [...dead]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => [name, list.length]),
);
const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

if (mode === "--report") {
  if (reportPackage !== undefined) {
    const lists =
      reportPackage === "all"
        ? [...dead.values()]
        : [dead.get(reportPackage) ?? []];
    // A name that an `export *` forwards cannot leave the entry file
    // alone: the line names the file that declares it, and if another file
    // imports it from there.
    for (const entry of lists.flat()) {
      const [file, name] = entry.split("#");
      const info = files.get(file);
      const forwarded = !info.local.has(name) && !info.links.has(name);
      const declared = forwarded ? declaration(file, name) : null;
      if (declared === null) console.log(entry);
      else {
        const usedThere = used.get(declared)?.has(name) ? " (used there)" : "";
        console.log(`${entry} <- ${declared}${usedThere}`);
      }
    }
    process.exit(0);
  }
  for (const [name, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`${String(n).padStart(5)}  ${name}`);
  }
  console.log(`${total} dead exports of package entry files.`);
  for (const group of keepGroups) {
    console.log(`kept: ${kept.get(group.group) ?? 0}  ${group.group}`);
  }
  process.exit(0);
}

let failed = false;
const noReason = keepGroups.filter(
  (group) => typeof group.reason !== "string" || group.reason.trim() === "",
);
for (const group of noReason) {
  failed = true;
  console.error(
    `The kept group "${group.group}" has no reason in ${BASELINE}.`,
  );
}
const grown = Object.entries(counts).filter(
  ([name, n]) => n > (baseline.counts?.[name] ?? 0),
);
for (const [name, n] of grown) {
  failed = true;
  console.error(
    `${name}: ${n} exports of entry files have no importer; ${BASELINE} allows ${baseline.counts?.[name] ?? 0}.`,
  );
  console.error(`  node ${SCRIPT} --report ${name} lists them.`);
}
if (grown.length > 0) {
  console.error(
    "Import the new export where it is used, or remove the `export`. If a reader outside the import graph needs it, give it a `@public` tag with the reader.",
  );
}

if (mode === "--update") {
  const next = Object.fromEntries(
    Object.entries(counts).map(([name, n]) => [
      name,
      Math.min(n, baseline.counts?.[name] ?? n),
    ]),
  );
  const text = JSON.stringify({ keep: baseline.keep ?? {}, counts: next });
  writeFileSync(join(root, BASELINE), await format(text, { parser: "json" }));
  console.log(
    `${BASELINE}: ${Object.values(next).reduce((a, b) => a + b, 0)} dead entry exports.`,
  );
  process.exit(failed ? 1 : 0);
}

const fell = Object.entries(baseline.counts ?? {}).filter(
  ([name, n]) => (counts[name] ?? 0) < n,
);
if (fell.length > 0) {
  failed = true;
  console.error(
    `The count of ${fell.map(([name]) => name).join(", ")} fell. Run node ${SCRIPT} --update.`,
  );
}
if (failed) process.exit(1);
console.log(`${total} known dead exports of package entry files. No new one.`);

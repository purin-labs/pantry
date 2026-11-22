#!/usr/bin/env node
// Fails when code crosses the boundary between Commerce and the rest of the
// monorepo (Plan 76 phase 1).
//
// - Commerce code imports only Commerce packages, the neutral shared
//   packages and npm packages. It never imports a Pantry package or a file in
//   another workspace directory.
// - Code outside Commerce uses Commerce only through its public packages
//   (@purin-labs/commerce-contracts, @purin-labs/commerce-client,
//   @purin-labs/commerce-query-sqlite) or the built Worker. It never imports
//   the Worker's or the storefront's source.
// - A built-in plugin keeps its code in services/commerce/src/plugins/<id>/
//   (Plan 77 step 3). Code outside that directory, tests included, imports
//   the plugin only through its index.ts.
// - A built-in plugin declares its tables in its schema.ts (Plan 77 step 6).
//   No other Commerce source file names one of them in SQL; other code
//   reads a plugin's data through the plugin's index.ts.
// - Commerce's source names no Cloudflare runtime API outside its adapter
//   files (Plan 77 step 0), so that another host stays possible: Durable
//   Objects, R2, KV, D1, Queues, the Cache API and `cloudflare:` modules
//   appear only in CLOUDFLARE_ADAPTERS.
// - Platform actors, Slack code and chat code import no route file in
//   services/platform/src/control/routes/ (Refactor 10 step 3), by a relative
//   path or by a package name. A route parses, authorizes and calls domain
//   code; domain code does not call back. A route file runs no D1 query
//   either: the query lives in a data/ module. A foundation package keeps the
//   folders of the Worker source (Refactor 17): its control/routes/ holds
//   route files and its actors/, slack/ and chat/ hold no import of one. The
//   Worker side of foundation/control keeps its route files in worker/routes/.
//   An area package keeps the folders of the Worker source in server/.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Directories whose code belongs to Commerce.
const COMMERCE_DIRECTORIES = [
  "services/commerce",
  "apps/storefront",
  "packages/commerce-contracts",
  "packages/commerce-client",
  "packages/commerce-query-sqlite",
];
// Commerce's runtime source. Other code reaches it only as a built Worker.
const COMMERCE_RUNTIME_DIRECTORIES = ["services/commerce", "apps/storefront"];
// Shared helpers that both runtimes may use. They depend on no workspace package
// outside this list.
const NEUTRAL_DIRECTORIES = ["packages/std", "packages/type-utils", "packages/contract-schema"];

// Crossings that may stay for now, as file -> { count, reason }: each file
// keeps its exact count and cannot gain one. A count that is too high or a
// file without crossings fails the check. Plan 76 phase 1 removed the last.
// The entity plane reads the food service plugin's entity types through the
// plugin's index (Plan 77 step 6), so no crossing is left.
const ALLOWED = new Map();

const COMMERCE_CORE = "services/commerce/src";
// The only Commerce files that may name a Cloudflare runtime API.
const CLOUDFLARE_ADAPTERS = new Set([
  "services/commerce/src/worker.ts",
  "services/commerce/src/durable-object-database.ts",
  "services/commerce/src/catalog-snapshots.ts",
]);
const CLOUDFLARE_NAMES = new Set([
  "DurableObject", "DurableObjectState", "DurableObjectStorage", "DurableObjectNamespace",
  "DurableObjectStub", "DurableObjectId", "DurableObjectTransaction", "R2Bucket", "R2Object",
  "R2ObjectBody", "KVNamespace", "D1Database", "Queue", "MessageBatch", "ExecutionContext",
  "ScheduledController", "Hyperdrive", "Fetcher", "HTMLRewriter", "WebSocketPair", "caches",
]);
const COMMERCE_PLUGINS = "services/commerce/src/plugins";
// The plugin directory that a path lies in, or null.
const pluginDirectory = (path) => {
  const match = path.match(/^services\/commerce\/src\/plugins\/([^/]+)\//);
  return match === null ? null : `${COMMERCE_PLUGINS}/${match[1]}`;
};

// Platform route files, and the Platform directories whose code may not import
// one: in the Worker source, in each foundation package and in the server/
// folder of each area package.
const PLATFORM_ROUTES = /^(?:services\/platform\/src|foundation\/[^/]+|areas\/[^/]+\/server)\/control\/routes\/|^foundation\/control\/worker\/routes\//;
const PLATFORM_ROUTE_FREE = /^(?:services\/platform\/src|foundation\/[^/]+|areas\/[^/]+\/server)\/(?:actors|slack|chat)\//;

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIPPED = /(^|\/)(node_modules|dist|public|wasm-pkg|generated|output|\.artifacts)\//;

const within = (path, directories) => directories.some((directory) => path === directory || path.startsWith(`${directory}/`));
const isCommerce = (path) => within(path, COMMERCE_DIRECTORIES);
const isNeutral = (path) => within(path, NEUTRAL_DIRECTORIES);

const packages = workspacePackages();
/** package name -> its exports map, for packageFile. */
const exportMaps = new Map();
const commercePackages = new Set([...packages].filter(([, directory]) => isCommerce(directory)).map(([name]) => name));
const neutralPackages = new Set([...packages].filter(([, directory]) => isNeutral(directory)).map(([name]) => name));
const runtimePackages = new Set([...packages].filter(([, directory]) => within(directory, COMMERCE_RUNTIME_DIRECTORIES)).map(([name]) => name));

const crossings = new Map();
const report = (file, line, _target, message) => {
  const list = crossings.get(file) ?? [];
  list.push(`${file}:${line} ${message}`);
  crossings.set(file, list);
};

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  .split("\n")
  .filter((file) => file && !SKIPPED.test(file) && !file.startsWith("docs/") && existsSync(join(root, file)));

// Each plugin table and the plugin directory that declares it.
const pluginTables = new Map();
for (const file of files) {
  const plugin = pluginDirectory(file);
  if (plugin === null || file !== `${plugin}/schema.ts`) continue;
  for (const [, table] of readFileSync(join(root, file), "utf8").matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g))
    pluginTables.set(table, plugin);
}
const pluginTableReference =
  pluginTables.size === 0
    ? null
    : new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|EXISTS)\\s+(${[...pluginTables.keys()].sort((a, b) => b.length - a.length).join("|")})\\b`, "g");

let checkedSources = 0;
for (const file of files) {
  if (SOURCE.test(file)) {
    checkedSources += 1;
    checkSource(file);
  } else if (file.endsWith("package.json")) {
    checkManifest(file);
  } else if (file.endsWith("Cargo.toml") && isCommerce(file)) {
    checkCargoManifest(file);
  }
}

const failures = [];
for (const [file, list] of crossings) {
  const allowed = ALLOWED.get(file)?.count ?? 0;
  if (list.length > allowed) failures.push(...list);
  else if (list.length < allowed)
    failures.push(`${file} has ${list.length} crossings; lower its count in scripts/check-runtime-boundary.mjs from ${allowed}`);
}
for (const file of ALLOWED.keys())
  if (!crossings.has(file)) failures.push(`${file} no longer crosses; remove its entry from scripts/check-runtime-boundary.mjs`);
for (const failure of failures) console.error(failure);
if (failures.length) process.exit(1);
const allowedCount = [...ALLOWED.values()].reduce((sum, entry) => sum + entry.count, 0);
console.log(
  `runtime boundary: ${checkedSources} source files checked; ${commercePackages.size} Commerce packages depend on no Pantry package; ${allowedCount} existing crossings in ${ALLOWED.size} files, no new one`,
);

function checkSource(file) {
  const text = readFileSync(join(root, file), "utf8");
  const lineOf = (position) => text.slice(0, position).split("\n").length;
  const { importedFiles } = ts.preProcessFile(text, true, true);
  const commerceEngine = isCommerce(file);
  const neutral = isNeutral(file);
  for (const { fileName: specifier, pos } of importedFiles) {
    const line = lineOf(pos);
    if (specifier.startsWith(".")) {
      const target = repositoryPath(file, specifier);
      if (target === null) continue;
      const plugin = pluginDirectory(target);
      if (PLATFORM_ROUTE_FREE.test(file) && PLATFORM_ROUTES.test(target))
        report(file, line, specifier, `imports the route file ${target}; move the shared code out of control/routes/`);
      if (plugin !== null && !within(file, [plugin]) && target !== `${plugin}/index.ts`)
        report(file, line, specifier, `imports ${target}; take the plugin through ${plugin}/index.ts`);
      if (commerceEngine || neutral) {
        if (!allowedFromCommerce(target, neutral))
          report(file, line, specifier, `imports ${target}, outside ${commerceEngine ? "Commerce" : "the neutral packages"}`);
      } else if (within(target, COMMERCE_RUNTIME_DIRECTORIES)) {
        report(file, line, specifier, `imports Commerce source ${target}; use @purin-labs/commerce-client or the built Worker`);
      }
      continue;
    }
    const name = packageName(specifier);
    if (!packages.has(name)) continue; // an npm package or a runtime module
    if (PLATFORM_ROUTE_FREE.test(file)) {
      const target = packageFile(specifier);
      if (target !== null && PLATFORM_ROUTES.test(target))
        report(file, line, specifier, `imports the route file ${target}; move the shared code out of control/routes/`);
    }
    if (commerceEngine && !commercePackages.has(name) && !neutralPackages.has(name))
      report(file, line, specifier, `imports ${name}, a package outside Commerce`);
    else if (neutral && !neutralPackages.has(name)) report(file, line, specifier, `imports ${name} from a neutral package`);
    else if (!commerceEngine && runtimePackages.has(name))
      report(file, line, specifier, `imports ${name}, Commerce's runtime source; use @purin-labs/commerce-client or the built Worker`);
  }
  if (PLATFORM_ROUTES.test(file))
    for (const match of text.matchAll(/\.prepare\(/g))
      report(file, lineOf(match.index), "prepare", "runs a D1 query in a route file; move the query to a data/ module");
  if (within(file, [COMMERCE_CORE]) && !CLOUDFLARE_ADAPTERS.has(file)) checkCloudflareNames(file, text, lineOf, importedFiles);
  if (within(file, [COMMERCE_CORE]) && pluginTableReference !== null)
    for (const match of text.matchAll(pluginTableReference)) {
      const owner = pluginTables.get(match[1]);
      if (owner !== undefined && !within(file, [owner]))
        report(file, lineOf(match.index), match[1], `names ${match[1]}, a table of ${owner}; read it through ${owner}/index.ts`);
    }
  if (!commerceEngine && !neutral) return;
  // File references such as Wasm paths and fixtures must stay inside too.
  for (const match of text.matchAll(/["'`](\.\.\/[^"'`\s$]+)["'`]/g)) {
    const target = repositoryPath(file, match[1]);
    if (target !== null && !allowedFromCommerce(target, neutral))
      report(file, lineOf(match.index), match[1], `refers to ${target}, outside ${commerceEngine ? "Commerce" : "the neutral packages"}`);
  }
}

function checkCloudflareNames(file, text, lineOf, importedFiles) {
  for (const { fileName: specifier, pos } of importedFiles)
    if (specifier.startsWith("cloudflare:"))
      report(file, lineOf(pos), specifier, `imports ${specifier}; only a Cloudflare adapter may (CLOUDFLARE_ADAPTERS)`);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isIdentifier(node) && CLOUDFLARE_NAMES.has(node.text) && !isMemberName(node))
      report(file, lineOf(node.getStart(source)), node.text, `names ${node.text}, a Cloudflare runtime API; only a Cloudflare adapter may (CLOUDFLARE_ADAPTERS)`);
    node.forEachChild(visit);
  };
  visit(source);
}

// `x.Queue`, `{ Queue: … }` and a member named `caches` are not the runtime API.
function isMemberName(node) {
  const parent = node.parent;
  return (
    ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node) ||
    ((ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
  );
}

function checkManifest(file) {
  const directory = dirname(file);
  const manifest = JSON.parse(readFileSync(join(root, file), "utf8"));
  const commerceEngine = isCommerce(directory);
  const neutral = isNeutral(directory);
  const line = (name) => readFileSync(join(root, file), "utf8").split("\n").findIndex((text) => text.includes(`"${name}"`)) + 1;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (!packages.has(name)) continue;
      if (commerceEngine && !commercePackages.has(name) && !neutralPackages.has(name))
        report(file, line(name), name, `depends on ${name}, a package outside Commerce`);
      else if (neutral && !neutralPackages.has(name)) report(file, line(name), name, `depends on ${name} from a neutral package`);
      else if (!commerceEngine && !neutral && runtimePackages.has(name))
        report(file, line(name), name, `depends on ${name}, Commerce's runtime source; use the built Worker`);
    }
  }
}

function checkCargoManifest(file) {
  const text = readFileSync(join(root, file), "utf8");
  for (const match of text.matchAll(/path\s*=\s*"([^"]+)"/g)) {
    const target = normalize(join(dirname(file), match[1]));
    if (!isCommerce(target))
      report(file, text.slice(0, match.index).split("\n").length, match[1], `depends on the crate at ${target}, outside Commerce`);
  }
}

// Commerce code may refer to its own directories, the neutral packages and
// files at the repository root, such as tsconfig.base.json.
function allowedFromCommerce(target, fromNeutral) {
  if (!target.includes("/")) return true;
  if (target.startsWith("node_modules/")) return true;
  return fromNeutral ? isNeutral(target) : isCommerce(target) || isNeutral(target);
}

function repositoryPath(file, specifier) {
  const absolute = resolve(root, dirname(file), specifier.replace(/[?#].*$/, ""));
  const path = relative(root, absolute);
  return path.startsWith("..") ? null : path;
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// The repository path of a file that a workspace package specifier names
// through the exports map of the package, or null.
function packageFile(specifier) {
  const name = packageName(specifier);
  const directory = packages.get(name);
  if (!exportMaps.has(name)) exportMaps.set(name, JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")).exports ?? {});
  const subpath = `.${specifier.slice(name.length)}`;
  for (const [key, value] of Object.entries(exportMaps.get(name))) {
    const target = typeof value === "string" ? value : value?.default;
    if (typeof target !== "string") continue;
    const [head, tail] = key.split("*");
    if (tail === undefined) {
      if (key === subpath) return normalize(join(directory, target));
    } else if (subpath.startsWith(head) && subpath.endsWith(tail) && subpath.length >= key.length - 1) {
      return normalize(join(directory, target.replace("*", subpath.slice(head.length, subpath.length - tail.length))));
    }
  }
  return null;
}

function workspacePackages() {
  const globs = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
    .split("\n")
    .map((line) => line.match(/^\s+-\s+(\S+)\s*$/)?.[1])
    .filter((glob) => glob !== undefined && !glob.includes("@"));
  const directories = globs.flatMap((glob) =>
    glob.endsWith("/*")
      ? readdirSync(join(root, glob.slice(0, -2)), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${glob.slice(0, -2)}/${entry.name}`)
      : [glob],
  );
  const result = new Map();
  for (const directory of directories) {
    const manifest = join(root, directory, "package.json");
    if (existsSync(manifest)) result.set(JSON.parse(readFileSync(manifest, "utf8")).name, directory);
  }
  return result;
}

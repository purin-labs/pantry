// Refactor 16 step 11: serves a built Portal (`pnpm portal:build`) as the
// Workers static assets of the Platform Worker serve it, for the visit
// journey (verify-engine-visits-browser.js).
//
//   node scripts/production-simulation/serve-portal-assets.mjs DIST PORT
//
// PORT 0 takes a free port; the first line names the origin.
//
// It applies the `_headers` file of DIST as the Workers static assets rules
// say: every rule whose path pattern matches the request adds its headers,
// and a header that a rule names replaces the default of the same name. The
// default is `Cache-Control: public, max-age=0, must-revalidate` and a
// strong ETag, so a cached file is revalidated (304) unless a rule makes it
// fresh. `/bakery-physics/*` comes from `apps/portal/public/bakery-physics`
// when DIST has no copy of it, because the build copies that folder as it is.
//
// The server counts what it sends. `GET /__served` returns the requests,
// the 304 answers and the body bytes, in all and under /bakery-physics/ (with
// each file there), since the last `POST /__served`, which sets them to zero.
// This is a model of the asset server, not the asset server: it proves what
// the browser fetches under the rules, not that Cloudflare applies them.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [distArgument, portArgument] = process.argv.slice(2);
if (distArgument === undefined || portArgument === undefined)
  throw new Error("Usage: serve-portal-assets.mjs DIST PORT");
const dist = resolve(distArgument);
const port = Number(portArgument);
const physics = existsSync(join(dist, "bakery-physics"))
  ? join(dist, "bakery-physics")
  : join(root, "apps/portal/public/bakery-physics");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".glb": "model/gltf-binary",
  ".woff2": "font/woff2",
};

/** The `_headers` rules: a path pattern and the headers that it adds. */
function readRules(path) {
  if (!existsSync(path)) return [];
  const rules = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^\s/u.test(line)) {
      const pattern = line.trim();
      const source = pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*");
      rules.push({ pattern, match: new RegExp(`^${source}$`, "u"), set: [] });
      continue;
    }
    const separator = line.indexOf(":");
    rules
      .at(-1)
      .set.push([
        line.slice(0, separator).trim().toLowerCase(),
        line.slice(separator + 1).trim(),
      ]);
  }
  return rules;
}

const rules = readRules(join(dist, "_headers"));
const etags = new Map();
const empty = () => ({
  requests: 0,
  notModified: 0,
  bytes: 0,
  physicsRequests: 0,
  physicsBytes: 0,
  /** Each file under /bakery-physics/ that a request named: its body bytes. */
  physicsFiles: {},
});
let served = empty();

function file(pathname) {
  const relative = decodeURIComponent(pathname);
  const base = relative.startsWith("/bakery-physics/") ? physics : dist;
  const inner = relative.startsWith("/bakery-physics/")
    ? relative.slice("/bakery-physics".length)
    : relative;
  const path = normalize(join(base, inner));
  if (!path.startsWith(`${base}${sep}`) && path !== base) return null;
  if (existsSync(path) && statSync(path).isFile()) return path;
  if (existsSync(`${path}.html`)) return `${path}.html`;
  // `not_found_handling: "single-page-application"`.
  return extname(path) === "" ? join(dist, "index.html") : null;
}

function etag(path) {
  const stamp = statSync(path).mtimeMs;
  const known = etags.get(path);
  if (known?.stamp === stamp) return known.tag;
  const tag = `"${createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 32)}"`;
  etags.set(path, { stamp, tag });
  return tag;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/__served") {
    if (request.method === "POST") served = empty();
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(served));
    return;
  }
  const path = file(url.pathname);
  served.requests += 1;
  if (url.pathname.startsWith("/bakery-physics/")) served.physicsRequests += 1;
  if (path === null) {
    response.writeHead(404);
    response.end();
    return;
  }
  const headers = new Map([
    ["content-type", TYPES[extname(path)] ?? "application/octet-stream"],
    ["cache-control", "public, max-age=0, must-revalidate"],
    ["etag", etag(path)],
  ]);
  for (const rule of rules)
    if (rule.match.test(url.pathname))
      for (const [name, value] of rule.set) headers.set(name, value);
  if (request.headers["if-none-match"] === headers.get("etag")) {
    served.notModified += 1;
    if (url.pathname.startsWith("/bakery-physics/"))
      served.physicsFiles[url.pathname] ??= 0;
    response.writeHead(304, Object.fromEntries(headers));
    response.end();
    return;
  }
  const body = readFileSync(path);
  served.bytes += body.length;
  if (url.pathname.startsWith("/bakery-physics/")) {
    served.physicsBytes += body.length;
    served.physicsFiles[url.pathname] =
      (served.physicsFiles[url.pathname] ?? 0) + body.length;
  }
  headers.set("content-length", String(body.length));
  response.writeHead(200, Object.fromEntries(headers));
  response.end(body);
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Serving ${dist} on http://127.0.0.1:${server.address().port}`),
);

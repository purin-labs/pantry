#!/usr/bin/env node

/**
 * The release server of the Portal stale release journey, in its own process:
 * the journey drives the browser through synchronous CLI calls.
 * Usage: node server.mjs <release a directory> <release b directory>
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import process from "node:process";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

/** Serves one release at a time with the Worker's single-page-application fallback. */
function ReleaseServer(directories) {
  this.current = "a";
  this.keep = null;
  this.documentLoads = 0;
  this.entry = (name) =>
    readFileSync(join(directories[name], "index.html"), "utf8").match(
      /<script type="module"[^>]*src="([^"]+)"/u,
    )[1];
  this.http = createServer((request, response) => {
    const url = new URL(request.url, "http://journey.invalid");
    if (url.pathname.startsWith("/__journey/"))
      return this.control(url, response);
    if (url.pathname.startsWith("/v1/")) {
      response.writeHead(404, { "content-type": "application/json" });
      return response.end('{"error":"not_found"}');
    }
    if (request.headers["sec-fetch-mode"] === "navigate")
      this.documentLoads += 1;
    const directory = directories[this.current];
    const path = join(directory, decodeURIComponent(url.pathname));
    const missing =
      !path.startsWith(directory) ||
      !existsSync(path) ||
      statSync(path).isDirectory() ||
      (this.keep !== null &&
        url.pathname.endsWith(".js") &&
        !this.keep.has(url.pathname));
    const file = missing ? join(directory, "index.html") : path;
    response.writeHead(200, {
      "content-type":
        CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "public, max-age=0, must-revalidate",
    });
    response.end(readFileSync(file));
  });
  this.control = (url, response) => {
    if (url.pathname === "/__journey/release") {
      this.current = url.searchParams.get("name");
      this.keep = null;
    } else if (url.pathname === "/__journey/keep-only") {
      this.keep = new Set(url.searchParams.getAll("path"));
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        current: this.current,
        documentLoads: this.documentLoads,
      }),
    );
  };
}

const server = new ReleaseServer({ a: process.argv[2], b: process.argv[3] });
server.http.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${server.http.address().port}\n`);
});

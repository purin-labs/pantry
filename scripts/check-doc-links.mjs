#!/usr/bin/env node
// Fails when a Markdown link names a file that does not exist (Refactor 17,
// step A0.5).
//
// The check reads each tracked Markdown file and each relative link in it. A
// link to a file that is not in the tree is a fault. Links to a web address
// and links inside one page are not checked. Text in a code block or in code
// marks is not a link. A file of repo-binaries.json is in R2 and counts as in
// the tree. A link that starts with "/" in apps/docs is a route of that site.
//
// scripts/doc-links-ratchet.json lists the links that were broken when the
// check started. A new broken link is refused. Correct a listed link, then run
// --update.
//
//   node scripts/check-doc-links.mjs            check
//   node scripts/check-doc-links.mjs --update   drop the listed links that are correct now
//   node scripts/check-doc-links.mjs --init     write the list from the current tree
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const pages = execFileSync("git", ["ls-files", "--", "*.md"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter(
    (path) =>
      path !== "" &&
      !path.startsWith("vendor/") &&
      existsSync(join(root, path)),
  );

const BASELINE = "scripts/doc-links-ratchet.json";
const mode = process.argv[2] ?? "check";
if (!["check", "--update", "--init"].includes(mode)) {
  console.error(`unknown argument ${mode}`);
  process.exit(2);
}

const binaries = JSON.parse(
  readFileSync(join(root, "repo-binaries.json"), "utf8"),
);
const binaryFiles = new Set(Object.keys(binaries.files));
// A folder key ends with "/".
const binaryFolders = Object.keys(binaries.folders);
const DOCS_SITE = "apps/docs/src/";

function exists(path) {
  if (existsSync(join(root, path)) || binaryFiles.has(path)) return true;
  return binaryFolders.some((folder) => path.startsWith(folder));
}

const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const faults = [];
let checked = 0;

for (const page of pages) {
  const lines = readFileSync(join(root, page), "utf8").split("\n");
  let fenced = false;
  lines.forEach((raw, index) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const line = raw.replace(/`[^`]*`/g, "");
    LINK.lastIndex = 0;
    let match;
    while ((match = LINK.exec(line)) !== null) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
      const path = decodeURIComponent(target.split("#")[0].split("?")[0]);
      if (path === "") continue;
      checked += 1;
      let found;
      if (path.startsWith("/") && page.startsWith(DOCS_SITE)) {
        const route = DOCS_SITE + path.slice(1).replace(/\/$/, "");
        found = [route, `${route}.md`, `${route}/index.md`].some(exists);
      } else {
        const resolved = path.startsWith("/")
          ? path.slice(1)
          : posix.normalize(posix.join(posix.dirname(page), path));
        found = exists(resolved);
      }
      if (!found) faults.push({ page, line: index + 1, target });
    }
  });
}

// "<page> -> <target>" with the count of that link in the page.
const current = {};
for (const { page, target } of faults) {
  const key = `${page} -> ${target}`;
  current[key] = (current[key] ?? 0) + 1;
}
const sortedCurrent = Object.fromEntries(
  Object.entries(current).sort(([a], [b]) => (a < b ? -1 : 1)),
);

if (mode === "--init") {
  writeFileSync(
    join(root, BASELINE),
    `${JSON.stringify(sortedCurrent, null, 2)}\n`,
  );
  console.log(`wrote ${BASELINE}: ${faults.length} broken links`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(join(root, BASELINE), "utf8"));
const fresh = faults.filter(
  ({ page, target }) => baseline[`${page} -> ${target}`] === undefined,
);
if (fresh.length > 0) {
  console.error(
    fresh
      .map(
        ({ page, line, target }) => `${page}:${line}: ${target} does not exist`,
      )
      .join("\n"),
  );
  console.error(
    `${fresh.length} new broken links. Correct each link, or remove it.`,
  );
  process.exit(1);
}
const listed = Object.keys(baseline).length;
const still = Object.keys(current).length;
if (mode === "--update") {
  writeFileSync(
    join(root, BASELINE),
    `${JSON.stringify(sortedCurrent, null, 2)}\n`,
  );
  console.log(`wrote ${BASELINE}: ${still} broken links`);
  process.exit(0);
}
console.log(
  `${checked} relative links in ${pages.length} pages. ${still} known broken links stay in ${BASELINE}.`,
);
if (still < listed) {
  console.log(
    "Some listed links are correct now. Run node scripts/check-doc-links.mjs --update.",
  );
}

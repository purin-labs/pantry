#!/usr/bin/env node
// Large files that live in R2 instead of git (Refactor 10, step 0B).
//
// repo-binaries.json names each file with its SHA-256 and size. A folder entry
// (a path that ends with "/") names each file of an immutable folder, such as a
// Kitchen physics bundle (Refactor 16, step 9B). The bucket keeps each file
// under sha256/<hash>, so a key never changes its content.
//
//   node scripts/repo-binaries.mjs fetch [--jobs N] [path-prefix]
//                                                        download missing or changed files
//   node scripts/repo-binaries.mjs check                 report files that are missing or changed
//   node scripts/repo-binaries.mjs upload [--dry-run] [--jobs N] <path>...
//                                                        upload files or folders and add them to the manifest;
//                                                        --dry-run lists what an upload sends and contacts nothing
//   node scripts/repo-binaries.mjs ignore                write the .gitignore block from the manifest
//
// Upload uses Wrangler with the Cloudflare sign-in of this machine. Fetch uses the
// R2 S3 API when R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_ENDPOINT are set
// (CI, or `node --env-file=.env.local.production ...`), and Wrangler otherwise.
//
// Upload and fetch run N transfers at the same time (default 8). Each file that
// passes through this machine also goes into a local cache under its SHA-256
// (REPO_BINARIES_CACHE, default ~/.cache/repo-binaries). A fetch copies a cached
// file (a copy-on-write clone where the disk supports it), so a new worktree on
// the same machine downloads nothing again.
import { execFile, execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(root, "repo-binaries.json");
const BUCKET = "satyr-repo-binaries-apac";

/** The manifest: `files` maps a path to its entry, `folders` maps a folder ("…/") to the entries of its files. */
export function readManifest(path = MANIFEST) {
  if (!existsSync(path)) return { bucket: BUCKET, files: {}, folders: {} };
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  return { ...manifest, folders: manifest.folders ?? {} };
}

/** Every file that the manifest names, with its folder files flattened: [path, { sha256, bytes }]. */
export function manifestEntries(manifest) {
  return [
    ...Object.entries(manifest.files),
    ...Object.entries(manifest.folders).flatMap(([folder, { files }]) =>
      Object.entries(files).map(([file, entry]) => [`${folder}${file}`, entry]),
    ),
  ];
}

const IGNORE = join(root, ".gitignore");
const IGNORE_START =
  "# Large files in R2 (written by scripts/repo-binaries.mjs; fetch them with its fetch command)";
const IGNORE_END = "# End of large files in R2";

const sorted = (object) =>
  Object.fromEntries(
    Object.entries(object).sort(([a], [b]) => a.localeCompare(b)),
  );

function writeManifest(manifest) {
  const files = sorted(manifest.files);
  const folders = sorted(manifest.folders);
  writeFileSync(
    MANIFEST,
    `${JSON.stringify({ bucket: manifest.bucket, files, ...(Object.keys(folders).length > 0 ? { folders } : {}) }, null, 2)}\n`,
  );
  // Git ignores each file and folder in the manifest, so a fetched file is never committed again.
  const text = readFileSync(IGNORE, "utf8");
  const start = text.indexOf(IGNORE_START);
  const end = text.indexOf(IGNORE_END);
  const kept =
    start === -1
      ? text.trimEnd()
      : `${text.slice(0, start).trimEnd()}${text.slice(end + IGNORE_END.length).trimEnd()}`;
  const block = [
    IGNORE_START,
    ...[...Object.keys(files), ...Object.keys(folders)].map(
      (path) => `/${path}`,
    ),
    IGNORE_END,
  ].join("\n");
  writeFileSync(IGNORE, `${kept}\n\n${block}\n`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The files of a folder, relative to it, with "/" separators, in sorted order. */
function folderFiles(absolute) {
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(absolute, join(entry.parentPath, entry.name))
        .split(sep)
        .join("/"),
    )
    .sort();
}

/** One manifest entry for each path argument: a file, or a folder with each of its files. */
function describe(arg) {
  const absolute = resolve(arg);
  const path = relative(root, absolute).split(sep).join("/");
  if (path.startsWith("..") || !existsSync(absolute))
    throw new Error(`${arg}: no such file or folder in the repository`);
  if (!statSync(absolute).isDirectory())
    return {
      path,
      folder: false,
      files: [
        {
          path,
          sha256: sha256(absolute),
          bytes: statSync(absolute).size,
        },
      ],
    };
  const files = folderFiles(absolute).map((file) => ({
    path: `${path}/${file}`,
    file,
    sha256: sha256(join(absolute, file)),
    bytes: statSync(join(absolute, file)).size,
  }));
  if (files.length === 0) throw new Error(`${arg}: the folder is empty`);
  return { path: `${path}/`, folder: true, files };
}

function wrangler(args) {
  execFileSync("pnpm", ["-s", "exec", "wrangler", ...args], {
    cwd: join(root, "services/platform"),
    stdio: ["ignore", "ignore", "inherit"],
  });
}

const execFileAsync = promisify(execFile);

/** One Wrangler command that runs beside others. Its error carries Wrangler's own message. */
async function wranglerAsync(args) {
  try {
    await execFileAsync("pnpm", ["-s", "exec", "wrangler", ...args], {
      cwd: join(root, "services/platform"),
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`wrangler ${args.slice(0, 4).join(" ")}: ${error.stderr || error.message}`);
  }
}

/** Runs task(item) for each item, with at most `jobs` tasks at the same time. */
async function inPool(items, jobs, task) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, worker));
}

const CACHE = process.env.REPO_BINARIES_CACHE ?? join(homedir(), ".cache", "repo-binaries");

/** The cached copy of an entry, or null. A wrong size means a broken copy: it is not used. */
function cachedCopy(entry) {
  const path = join(CACHE, entry.sha256);
  return existsSync(path) && statSync(path).size === entry.bytes ? path : null;
}

/** Copies a file into place, as a copy-on-write clone where the disk supports it. */
function copyInto(source, absolute) {
  mkdirSync(dirname(absolute), { recursive: true });
  copyFileSync(source, absolute, constants.COPYFILE_FICLONE);
}

/** Puts a checked file into the local cache under its SHA-256. */
function remember(absolute, hash) {
  const path = join(CACHE, hash);
  if (existsSync(path)) return;
  mkdirSync(CACHE, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  copyFileSync(absolute, temporary, constants.COPYFILE_FICLONE);
  renameSync(temporary, path);
}

const s3 =
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_ENDPOINT
    ? {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        endpoint: process.env.R2_ENDPOINT,
      }
    : null;

function hmac(key, text) {
  return createHmac("sha256", key).update(text).digest();
}

/** One request to the R2 S3 API, signed with AWS Signature Version 4 (region auto). */
async function s3Request(manifest, method, key, body = new Uint8Array()) {
  const url = new URL(
    `${s3.endpoint.replace(/\/$/, "")}/${manifest.bucket}/${key}`,
  );
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = now.slice(0, 8);
  const payloadHash = createHash("sha256").update(body).digest("hex");
  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": now,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonical = [
    method,
    url.pathname,
    "",
    ...Object.keys(headers)
      .sort()
      .map((name) => `${name}:${headers[name]}`),
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    now,
    scope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  let signingKey = hmac(`AWS4${s3.secretAccessKey}`, day);
  for (const part of ["auto", "s3", "aws4_request"])
    signingKey = hmac(signingKey, part);
  const signature = createHmac("sha256", signingKey)
    .update(toSign)
    .digest("hex");
  return fetch(url, {
    method,
    body: method === "GET" ? undefined : body,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${s3.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
}

/** A download fault that a later try can pass: no connection, or an HTTP 429 or 5xx answer. */
class TransientDownloadError extends Error {}

/**
 * The waits before the second, third and fourth try. A GitHub runner lost its
 * connection to R2 for minutes on 19 November 2026, and the CI job failed at
 * the first file.
 */
const DOWNLOAD_RETRY_DELAYS_MS = [2_000, 8_000, 30_000];

async function downloadOnce(manifest, entry, absolute) {
  if (s3 === null) {
    try {
      await wranglerAsync([
        "r2",
        "object",
        "get",
        `${manifest.bucket}/sha256/${entry.sha256}`,
        "--file",
        absolute,
        "--remote",
      ]);
    } catch (error) {
      // A missing object or a refused sign-in does not change on a later try.
      if (/not found|does not exist|\b40[134]\b|authenticat|unauthori[sz]ed/i.test(error.message)) throw error;
      throw new TransientDownloadError(error.message);
    }
    return;
  }
  let response;
  let body;
  try {
    response = await s3Request(manifest, "GET", `sha256/${entry.sha256}`);
    // The body can break in the middle too, so it is read inside the try.
    if (response.ok) body = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new TransientDownloadError(
      `R2 GET sha256/${entry.sha256}: ${error.cause?.code ?? error.cause?.message ?? error.message}`,
    );
  }
  if (!response.ok) {
    const message = `R2 GET sha256/${entry.sha256}: HTTP ${response.status}`;
    throw response.status === 429 || response.status >= 500
      ? new TransientDownloadError(message)
      : new Error(message);
  }
  writeFileSync(absolute, body);
}

/** Downloads one file. A transient fault gets three more tries; any other fault stops at once. */
async function download(manifest, entry, absolute) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await downloadOnce(manifest, entry, absolute);
      return;
    } catch (error) {
      const wait = DOWNLOAD_RETRY_DELAYS_MS[attempt];
      if (!(error instanceof TransientDownloadError) || wait === undefined) throw error;
      console.warn(`${error.message}; try ${attempt + 2} of ${DOWNLOAD_RETRY_DELAYS_MS.length + 1} in ${wait / 1000} s`);
      await new Promise((settle) => setTimeout(settle, wait));
    }
  }
}

function state(path, entry) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return "missing";
  if (
    statSync(absolute).size !== entry.bytes ||
    sha256(absolute) !== entry.sha256
  )
    return "changed";
  return "ok";
}

/**
 * Uploads each file whose key the bucket may not hold yet: a hash that the
 * manifest already names, or that an earlier file of this upload had, is sent
 * one time only. A dry run prints the same list and sends nothing.
 */
async function upload(manifest, args, dryRun, jobs) {
  if (args.length === 0) throw new Error("name at least one file or folder");
  const described = args.map(describe);
  const known = new Set(manifestEntries(manifest).map(([, e]) => e.sha256));
  let sent = 0;
  let bytes = 0;
  let files = 0;
  for (const item of described) {
    const sends = [];
    for (const file of item.files) {
      files += 1;
      if (known.has(file.sha256)) {
        if (dryRun)
          console.log(`same key   sha256/${file.sha256} ${file.path}`);
        continue;
      }
      known.add(file.sha256);
      sent += 1;
      bytes += file.bytes;
      if (dryRun) {
        console.log(
          `would send sha256/${file.sha256} ${String(file.bytes).padStart(10)} ${file.path}`,
        );
        continue;
      }
      sends.push(file);
    }
    if (dryRun) continue;
    await inPool(sends, jobs, (file) =>
      wranglerAsync([
        "r2",
        "object",
        "put",
        `${manifest.bucket}/sha256/${file.sha256}`,
        "--file",
        join(root, file.path),
        "--remote",
      ]),
    );
    for (const file of item.files) remember(join(root, file.path), file.sha256);
    if (item.folder)
      manifest.folders[item.path] = {
        files: Object.fromEntries(
          item.files.map(({ file, sha256, bytes }) => [
            file,
            { sha256, bytes },
          ]),
        ),
      };
    else
      manifest.files[item.path] = {
        sha256: item.files[0].sha256,
        bytes: item.files[0].bytes,
      };
    writeManifest(manifest);
    console.log(`uploaded ${item.path}`);
  }
  const folders = described.filter((item) => item.folder).length;
  console.log(
    `repo binaries: ${dryRun ? "a dry run; nothing was sent. An upload would send" : "sent"} ${sent} of ${files} files, ${bytes} bytes (${(bytes / 1048576).toFixed(1)} MiB), in ${folders} folders and ${described.length - folders} files`,
  );
}

async function main() {
  const [command, ...options] = process.argv.slice(2);
  const jobsAt = options.indexOf("--jobs");
  const jobs = jobsAt >= 0 ? Number(options[jobsAt + 1]) : 8;
  if (!Number.isInteger(jobs) || jobs < 1)
    throw new Error("--jobs needs a whole number of 1 or more");
  const rest = options.filter((_, index) => jobsAt < 0 || (index !== jobsAt && index !== jobsAt + 1));
  const manifest = readManifest();
  if (command === "upload") {
    const dryRun = rest.includes("--dry-run");
    await upload(
      manifest,
      rest.filter((arg) => arg !== "--dry-run"),
      dryRun,
      jobs,
    );
  } else if (command === "fetch") {
    const prefix = rest[0] ?? "";
    const missing = manifestEntries(manifest).filter(
      ([path, entry]) => path.startsWith(prefix) && state(path, entry) !== "ok",
    );
    let fetched = 0;
    let copied = 0;
    await inPool(missing, jobs, async ([path, entry]) => {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      const cached = cachedCopy(entry);
      if (cached === null) await download(manifest, entry, absolute);
      else copyInto(cached, absolute);
      if (state(path, entry) !== "ok")
        throw new Error(
          `${path}: the ${cached === null ? "downloaded" : "cached"} file does not match its SHA-256`,
        );
      remember(absolute, entry.sha256);
      if (cached === null) fetched += 1;
      else copied += 1;
      console.log(`${cached === null ? "fetched" : "copied "} ${path}`);
    });
    console.log(`repo binaries: ${fetched} fetched, ${copied} copied from the local cache`);
  } else if (command === "ignore") {
    writeManifest(manifest);
    console.log(
      `repo binaries: .gitignore lists ${Object.keys(manifest.files).length} files and ${Object.keys(manifest.folders).length} folders`,
    );
  } else if (command === "probe-write") {
    // Proves that the S3 credentials cannot write: exits 1 when a PUT succeeds.
    if (s3 === null)
      throw new Error(
        "set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_ENDPOINT",
      );
    const response = await s3Request(
      manifest,
      "PUT",
      "probe/write-refused",
      new TextEncoder().encode("probe"),
    );
    console.log(
      `repo binaries: a PUT with these credentials answered HTTP ${response.status}`,
    );
    if (response.ok) process.exit(1);
  } else if (command === "check") {
    const entries = manifestEntries(manifest);
    const bad = entries
      .map(([path, entry]) => [path, state(path, entry)])
      .filter(([, result]) => result !== "ok");
    for (const [path, result] of bad) console.log(`${result}: ${path}`);
    console.log(
      `repo binaries: ${entries.length} files, ${bad.length} missing or changed`,
    );
    if (bad.some(([, result]) => result === "changed")) process.exit(1);
  } else {
    console.error(
      "usage: node scripts/repo-binaries.mjs fetch [prefix] | check | ignore | upload [--dry-run] <path>...",
    );
    process.exit(2);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();

#!/usr/bin/env node
// Runs the Kitchen physics journeys from their index (Refactor 16, step 14).
//
// scripts/production-simulation/journeys.json lists every journey in
// scripts/production-simulation and scripts/bakery-robots: its tier, backend,
// owner plan, exact command and last measured time. This runner takes a tier,
// a named set or journey ids, runs the journeys in the index order (a set in
// its own order), gives each one a fresh output directory, and writes
// journeys-summary.json with the result and the time of each journey.
//
//   node scripts/production-simulation/run-journeys.mjs --set ci
//   node scripts/production-simulation/run-journeys.mjs --tier fast --output output/journeys/fast
//   node scripts/production-simulation/run-journeys.mjs --id two-cell,batch-cycles
//   node scripts/production-simulation/run-journeys.mjs --tier browser --base-url http://127.0.0.1:5194
//   node scripts/production-simulation/run-journeys.mjs --list --tier slow
//   node scripts/production-simulation/run-journeys.mjs --check      pnpm lint:journey-index
//
// Options:
//   --output DIR     root of the run; each journey writes DIR/<its dir>.
//                    Default output/journeys/<UTC time>. A later run in the
//                    same DIR reuses the passed journeys that it reads.
//   --tsx PATH       the tsx command (default $BAKERY_TSX, node_modules/.bin/tsx, tsx).
//   --python PATH    the Python command (default $BAKERY_PYTHON, python3).
//   --base-url URL   the Portal dev server of browser journeys (default http://127.0.0.1:5194).
//   --record         write the time of each passed journey into the index.
//   --stop           stop at the first failed journey.
//
// Placeholders in a command: {out} is the journey's directory, {out:ID} the
// directory of journey ID (which then runs first), {abs:ID} its absolute path
// (for a /@fs/ evidence URL), {runtime} the pinned browser runtime directory.
//
// A browser journey with run.portal "built" runs on the built Portal, as the
// Workers static assets serve it, and not on --base-url: the first such
// journey of a run builds the Portal (pnpm portal:build) and serves
// apps/portal/dist with serve-portal-assets.mjs on a free port.
//
// CI runs its journeys through this index: set ci in the headless step and
// set ci-browser in the browser step of .github/workflows/pantry.yml, so the
// commands and their time limits have one source. run.timeoutMs of a browser
// journey (default 600000) limits its one browser call. --check refuses a
// limit under 4 times the journey's recorded time on a Mac (lastRun): the
// 2-vCPU runner draws with SwiftShader up to about 3 times slower (CI run
// 44091735277 stopped the presets journey at 600 s; it takes 194 s on a Mac).
import { spawn, execFileSync } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INDEX = "scripts/production-simulation/journeys.json";
const WORKFLOW = ".github/workflows/pantry.yml";
const BROWSER_LIMIT_MS = 600000;
// The CI runner is up to about 3 times slower than a Mac; see the header.
const BROWSER_LIMIT_FACTOR = 4;
const JOURNEY_FOLDERS = [
  "scripts/production-simulation",
  "scripts/bakery-robots",
];
// A file with one of these names is a journey and needs a row in the index.
const JOURNEY_FILE =
  /^(verify[-_]|measure-|test_)|^ur5e_(payload_envelope|mass_check)\.py$/;
const TIERS = ["fast", "slow", "browser"];
const BACKENDS = ["native", "wasm", "both", "browser", "none"];
const TOOLS = ["node", "tsx", "python", "browser"];
const STATUSES = [
  "passes",
  "fails",
  "repaired on branch ci-browser",
  "not run",
];

const { values } = parseArgs({
  options: {
    tier: { type: "string" },
    set: { type: "string" },
    id: { type: "string" },
    output: { type: "string" },
    tsx: { type: "string" },
    python: { type: "string" },
    "base-url": { type: "string", default: "http://127.0.0.1:5194" },
    record: { type: "boolean", default: false },
    stop: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    check: { type: "boolean", default: false },
  },
});

const index = JSON.parse(readFileSync(join(root, INDEX), "utf8"));
const byId = new Map(index.journeys.map((journey) => [journey.id, journey]));

// A run needs a sound index; --check also needs a status for each journey.
const problems = checkIndex(values.check);
if (values.check || problems.length > 0) {
  for (const problem of problems) console.error(`journey index: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(
    `journey index: ${index.journeys.length} journeys, ${new Set(index.journeys.map((j) => j.file)).size} files; every journey file has a row.`,
  );
  process.exit(0);
}

const chosen = select();
const selected = withDependencies(chosen);
if (values.list) {
  for (const journey of selected)
    console.log(
      `${journey.id}\t${journey.tier}\t${journey.status}\t${journey.file}`,
    );
  process.exit(0);
}

const output = resolve(
  root,
  values.output ??
    join("output/journeys", new Date().toISOString().replace(/[:.]/gu, "-")),
);
const logs = join(output, "journey-logs");
mkdirSync(logs, { recursive: true });
// A later run in the same --output (for example the browser tier after the
// headless set) reuses the passed journeys of the earlier runs that it reads.
const summaryPath = join(output, "journeys-summary.json");
const earlier = existsSync(summaryPath)
  ? JSON.parse(readFileSync(summaryPath, "utf8")).results
  : [];
const reusable = new Set(
  earlier.filter((r) => r.result === "passed").map((r) => r.id),
);
const chosenIds = new Set(chosen.map((journey) => journey.id));
const tools = {
  tsx:
    values.tsx ??
    process.env.BAKERY_TSX ??
    (existsSync(join(root, "node_modules/.bin/tsx"))
      ? join(root, "node_modules/.bin/tsx")
      : "tsx"),
  python: values.python ?? process.env.BAKERY_PYTHON ?? "python3",
};
const runtime = await pinnedRuntime();
const commit = git(["rev-parse", "--short=9", "HEAD"]);
const started = new Date();
const results = [];
const failed = new Set();
// A promise of the built Portal's origin, from the first journey that needs it.
let builtPortalOrigin;

for (const journey of selected) {
  if (
    !chosenIds.has(journey.id) &&
    reusable.has(journey.id) &&
    existsSync(directoryOf(journey))
  ) {
    console.log(
      `journeys: reuse ${journey.id} from the earlier run in ${relative(root, output)}`,
    );
    continue;
  }
  const blocker = dependencies(journey).find((id) => failed.has(id));
  if (blocker !== undefined) {
    failed.add(journey.id);
    results.push({
      id: journey.id,
      file: journey.file,
      result: "skipped",
      reason: `${blocker} did not pass`,
    });
    console.log(`journeys: skip ${journey.id}: ${blocker} did not pass`);
    continue;
  }
  const result = await runJourney(journey);
  results.push(result);
  if (result.result !== "passed") {
    failed.add(journey.id);
    if (values.stop) break;
  }
}

const summary = {
  commit,
  started: started.toISOString(),
  seconds: round((Date.now() - started.getTime()) / 1000),
  selection: { tier: values.tier, set: values.set, id: values.id },
  passed: results.filter((r) => r.result === "passed").length,
  failed: results.filter((r) => r.result === "failed").length,
  skipped: results.filter((r) => r.result === "skipped").length,
  results: [
    ...earlier.filter((r) => !results.some((now) => now.id === r.id)),
    ...results,
  ],
};
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
if (values.record) record(results);
console.log(
  `journeys: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped in ${summary.seconds} s; summary ${relative(root, summaryPath)}`,
);
for (const r of results)
  if (r.result !== "passed")
    console.log(
      `journeys: ${r.result} ${r.id}${r.reason ? `: ${r.reason}` : ""}`,
    );
process.exit(summary.failed + summary.skipped > 0 ? 1 : 0);

function select() {
  const chosen = [values.tier, values.set, values.id].filter(
    (value) => value !== undefined,
  );
  if (chosen.length !== 1) fail("Give one of --tier, --set or --id.");
  if (values.tier !== undefined) {
    if (!TIERS.includes(values.tier))
      fail(`--tier is one of ${TIERS.join(", ")}.`);
    return index.journeys.filter((journey) => journey.tier === values.tier);
  }
  const ids =
    values.set !== undefined ? index.sets[values.set] : values.id.split(",");
  if (ids === undefined)
    fail(
      `The index has no set ${values.set}. Sets: ${Object.keys(index.sets).join(", ")}.`,
    );
  return ids.map(
    (id) => byId.get(id) ?? fail(`The index has no journey ${id}.`),
  );
}

// A journey that reads another's directory runs after it, in the same run.
function withDependencies(journeys) {
  const order = [];
  const seen = new Set();
  const visit = (journey) => {
    if (seen.has(journey.id)) return;
    seen.add(journey.id);
    for (const id of dependencies(journey)) visit(byId.get(id));
    order.push(journey);
  };
  for (const journey of journeys) visit(journey);
  return order;
}

function dependencies(journey) {
  const text = JSON.stringify(journey.run) + (journey.sharesOutputOf ?? "");
  const ids = [...text.matchAll(/\{(?:out|abs):([a-z0-9-]+)\}/gu)].map(
    (match) => match[1],
  );
  if (journey.sharesOutputOf !== undefined) ids.push(journey.sharesOutputOf);
  return [...new Set(ids)];
}

function directoryOf(journey) {
  if (journey.sharesOutputOf !== undefined)
    return directoryOf(byId.get(journey.sharesOutputOf));
  return join(output, journey.dir ?? journey.id);
}

function expand(text, journey) {
  return text
    .replaceAll("{out}", relative(root, directoryOf(journey)))
    .replaceAll("{runtime}", runtime)
    .replace(/\{out:([a-z0-9-]+)\}/gu, (_, id) =>
      relative(root, directoryOf(byId.get(id))),
    )
    .replace(/\{abs:([a-z0-9-]+)\}/gu, (_, id) => directoryOf(byId.get(id)));
}

function command(journey, origin) {
  const run = journey.run;
  const args = (run.args ?? []).map((arg) => expand(arg, journey));
  if (run.tool === "browser")
    return [
      process.execPath,
      [
        "scripts/bakery-robots/browser-acceptance.mjs",
        "--url",
        `${origin}${expand(run.url, journey)}`,
        "--journey",
        journey.file,
        "--output",
        relative(root, directoryOf(journey)),
        "--timeout",
        String(run.timeoutMs ?? BROWSER_LIMIT_MS),
        ...(run.prerequisites ?? []).flatMap((path) => [
          "--prerequisite",
          expand(path, journey),
        ]),
        ...args,
      ],
    ];
  if (run.tool === "python") return [tools.python, [journey.file, ...args]];
  if (run.tool === "tsx")
    return [tools.tsx, [...(run.nodeOptions ?? []), journey.file, ...args]];
  return [
    process.execPath,
    [...(run.nodeOptions ?? []), journey.file, ...args],
  ];
}

async function runJourney(journey) {
  const directory = directoryOf(journey);
  if (journey.sharesOutputOf === undefined && existsSync(directory)) {
    console.error(
      `journeys: ${relative(root, directory)} exists; give a fresh --output.`,
    );
    return {
      id: journey.id,
      file: journey.file,
      result: "failed",
      reason: "the output directory exists",
    };
  }
  let origin = values["base-url"];
  if (journey.run.portal === "built") {
    try {
      origin = await builtPortal();
    } catch (error) {
      console.error(`journeys: ${journey.id}: ${error.message}`);
      return {
        id: journey.id,
        file: journey.file,
        result: "failed",
        reason: error.message,
      };
    }
  }
  if (journey.run.mkdir === true) mkdirSync(directory, { recursive: true });
  const [program, args] = command(journey, origin);
  const env = { ...process.env };
  for (const [name, value] of Object.entries(journey.run.env ?? {}))
    env[name] = expand(value, journey);
  const shown = [
    ...Object.entries(journey.run.env ?? {}).map(
      ([name, value]) => `${name}=${expand(value, journey)}`,
    ),
    program === process.execPath
      ? "node"
      : relative(root, program).startsWith("..")
        ? program
        : relative(root, program),
    ...args,
  ].join(" ");
  const stdout =
    journey.run.stdout === undefined
      ? undefined
      : resolve(root, expand(journey.run.stdout, journey));
  console.log(
    `\njourneys: run ${journey.id}: ${shown}${stdout ? ` > ${relative(root, stdout)}` : ""}`,
  );
  const log = createWriteStream(join(logs, `${journey.id}.log`));
  const sink = stdout === undefined ? undefined : createWriteStream(stdout);
  // A full disk fails this journey; it does not stop the run.
  let writeError;
  for (const stream of [log, sink].filter(Boolean))
    stream.on("error", (error) => (writeError ??= error.message));
  const startedAt = performance.now();
  const exitCode = await new Promise((done) => {
    const child = spawn(program, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      log.write(chunk);
      if (sink !== undefined) sink.write(chunk);
      else process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      log.write(chunk);
      process.stderr.write(chunk);
    });
    const timer =
      journey.run.timeoutMs === undefined || journey.run.tool === "browser"
        ? undefined
        : setTimeout(
            () => child.kill("SIGKILL"),
            journey.run.timeoutMs + 60000,
          );
    child.on("error", (error) => {
      log.write(`${error.message}\n`);
      done(127);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done(code ?? (signal === null ? 1 : 128));
    });
  });
  await Promise.all(
    [log, sink]
      .filter(Boolean)
      .map((stream) => new Promise((done) => stream.end(done))),
  );
  const seconds = round((performance.now() - startedAt) / 1000);
  const result =
    exitCode === 0 && writeError === undefined ? "passed" : "failed";
  console.log(
    `journeys: ${result} ${journey.id} in ${seconds} s${exitCode === 0 ? "" : ` (exit ${exitCode})`}${writeError === undefined ? "" : ` (${writeError})`}`,
  );
  return {
    id: journey.id,
    file: journey.file,
    result,
    seconds,
    exitCode,
    command: shown,
    ...(writeError === undefined ? {} : { reason: writeError }),
  };
}

// The origin of the built Portal; see run.portal in the header. One build and
// one server serve every such journey of the run, and the server stops when
// the run exits.
function builtPortal() {
  builtPortalOrigin ??= serveBuiltPortal();
  return builtPortalOrigin;
}

async function serveBuiltPortal() {
  const buildLog = join(logs, "portal-build.log");
  console.log(
    `\njourneys: build the Portal: pnpm portal:build > ${relative(root, buildLog)}`,
  );
  const fd = openSync(buildLog, "w");
  const built = await new Promise((done) => {
    const build = spawn("pnpm", ["portal:build"], {
      cwd: root,
      stdio: ["ignore", fd, fd],
    });
    build.on("error", () => done(127));
    build.on("close", (code) => done(code ?? 1));
  });
  closeSync(fd);
  if (built !== 0)
    throw new Error(
      `pnpm portal:build failed (exit ${built}); read ${relative(root, buildLog)}`,
    );
  const server = spawn(
    process.execPath,
    [
      "scripts/production-simulation/serve-portal-assets.mjs",
      "apps/portal/dist",
      "0",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
  );
  process.on("exit", () => server.kill());
  return new Promise((ready, refuse) => {
    let text = "";
    server.stdout.on("data", (chunk) => {
      text += chunk;
      const origin = /on (http:\/\/\S+)/u.exec(text)?.[1];
      if (origin !== undefined) ready(origin);
    });
    server.on("exit", (code) =>
      refuse(new Error(`serve-portal-assets.mjs stopped (exit ${code})`)),
    );
  });
}

// Read the index again: another run can have recorded its times meanwhile.
function record(results) {
  const date = started.toLocaleDateString("sv-SE"); // YYYY-MM-DD, local time
  const current = JSON.parse(readFileSync(join(root, INDEX), "utf8"));
  for (const result of results) {
    if (result.result !== "passed") continue;
    const journey = current.journeys.find((row) => row.id === result.id);
    if (journey === undefined) continue;
    journey.status = "passes";
    journey.lastRun = { seconds: result.seconds, date, commit };
    delete journey.failure;
  }
  writeFileSync(join(root, INDEX), `${JSON.stringify(current, null, 2)}\n`);
  const prettier = join(root, "node_modules/.bin/prettier");
  if (existsSync(prettier))
    execFileSync(prettier, ["--write", INDEX], { cwd: root, stdio: "ignore" });
  console.log(
    `journeys: recorded the times of ${results.filter((r) => r.result === "passed").length} journeys in ${INDEX}`,
  );
}

function checkIndex(strict) {
  const found = [];
  const ids = new Set();
  for (const journey of index.journeys) {
    const where = journey.id ?? journey.file;
    if (ids.has(journey.id)) found.push(`${where}: the id is not unique`);
    ids.add(journey.id);
    if (!/^[a-z0-9-]+$/u.test(journey.id ?? ""))
      found.push(`${where}: an id has only a-z, 0-9 and -`);
    if (!existsSync(join(root, journey.file ?? "")))
      found.push(`${where}: ${journey.file} does not exist`);
    if (!TIERS.includes(journey.tier))
      found.push(`${where}: tier is one of ${TIERS.join(", ")}`);
    if (!BACKENDS.includes(journey.backend))
      found.push(`${where}: backend is one of ${BACKENDS.join(", ")}`);
    if (typeof journey.owner !== "string")
      found.push(`${where}: give the owner plan`);
    if (!TOOLS.includes(journey.run?.tool))
      found.push(`${where}: run.tool is one of ${TOOLS.join(", ")}`);
    if (journey.run?.tool === "browser" && typeof journey.run.url !== "string")
      found.push(`${where}: a browser journey gives run.url`);
    if (
      journey.run?.portal !== undefined &&
      (journey.run.tool !== "browser" || journey.run.portal !== "built")
    )
      found.push(`${where}: run.portal is "built", for a browser journey`);
    if (!STATUSES.includes(journey.status))
      found.push(`${where}: status is one of ${STATUSES.join(", ")}`);
    if (!strict) continue;
    if (
      journey.status === "passes" &&
      typeof journey.lastRun?.seconds !== "number"
    )
      found.push(
        `${where}: a passing journey gives lastRun.seconds, date and commit`,
      );
    const limit = journey.run?.timeoutMs ?? BROWSER_LIMIT_MS;
    const needed =
      BROWSER_LIMIT_FACTOR * 1000 * (journey.lastRun?.seconds ?? 0);
    if (journey.run?.tool === "browser" && limit < needed)
      found.push(
        `${where}: run.timeoutMs ${limit} is under ${BROWSER_LIMIT_FACTOR} times its last time (${journey.lastRun.seconds} s); give at least ${Math.ceil(needed / 300000) * 300000}`,
      );
    if (
      journey.status !== "passes" &&
      typeof journey.failure?.reason !== "string"
    )
      found.push(`${where}: a journey that does not pass gives failure.reason`);
    else if (
      journey.status !== "passes" &&
      journey.failure.reason === "not measured yet"
    )
      found.push(
        `${where}: run the journey and record its time or its failure`,
      );
  }
  const position = new Map(
    index.journeys.map((journey, at) => [journey.id, at]),
  );
  for (const journey of index.journeys)
    for (const id of dependencies(journey)) {
      if (!position.has(id))
        found.push(
          `${journey.id}: it reads the output of ${id}, which the index does not have`,
        );
      else if (position.get(id) > position.get(journey.id))
        found.push(`${journey.id}: ${id} comes later in the index`);
    }
  for (const [name, members] of Object.entries(index.sets ?? {}))
    for (const id of members) {
      const journey = byId.get(id);
      if (journey === undefined) found.push(`set ${name}: no journey ${id}`);
      else if (strict && journey.status !== "passes")
        found.push(
          `set ${name}: ${id} does not pass today (${journey.status})`,
        );
    }
  const listed = new Set(index.journeys.map((journey) => journey.file));
  for (const folder of JOURNEY_FOLDERS)
    for (const name of readdirSync(join(root, folder)))
      if (JOURNEY_FILE.test(name) && !listed.has(`${folder}/${name}`))
        found.push(
          `${folder}/${name} is a journey with no row; add it to ${INDEX}`,
        );
  const workflow = readFileSync(join(root, WORKFLOW), "utf8");
  if (workflow.includes("browser-acceptance.mjs"))
    found.push(
      `${WORKFLOW} runs browser-acceptance.mjs itself; run the journey through a set of ${INDEX}`,
    );
  for (const [, name] of workflow.matchAll(
    /run-journeys\.mjs[^\n]*--set (\S+)/gu,
  ))
    if (index.sets?.[name] === undefined)
      found.push(`${WORKFLOW} runs set ${name}, which ${INDEX} does not have`);
  return found;
}

async function pinnedRuntime() {
  const asset = join(
    root,
    "packages/production-simulation/src/simulator/browser-physics-asset.ts",
  );
  const { BAKERY_BROWSER_BUNDLE } = await import(pathToFileURL(asset).href);
  return `apps/portal/public/bakery-physics/bundles/${BAKERY_BROWSER_BUNDLE.id}`;
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function fail(message) {
  console.error(`journeys: ${message}`);
  process.exit(2);
}

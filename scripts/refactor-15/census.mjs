#!/usr/bin/env node
// The census of stuck states (Refactor 15, S5). For each machine that a
// `*.machine.ts` file defines, it counts the rows in each state that is not
// terminal, and the age of the oldest row when the table has a time column.
// It reads counts only, never content.
//
// D1 machines are read with `wrangler d1 execute`. Actor machines live in
// each Actor's SQLite and need an admin read route that returns counts; the
// census lists them as not read until that route exists.
//
//   node scripts/refactor-15/census.mjs                 # local databases
//   node scripts/refactor-15/census.mjs --env production --remote
//   node --env-file=.env.local scripts/refactor-15/census.mjs \
//     --env production --remote --admin-origin https://<worker host>
//
// With --admin-origin it also reads the Actor machines through
// GET /v1/admin/machine-census, with ORGANISATION_ADMIN_TOKEN from the
// environment. The token is never printed. For each Actor state that holds a
// row, the route also gives the oldest age, the rows past their exit (and how
// many of them sit in an Actor with no alarm) and the rows with no time.
//
// It writes docs/evidence/refactor-15/census-<date>-<env>.json.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../..", import.meta.url).pathname;
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const environment = argument("--env") ?? "local";
const remote = process.argv.includes("--remote");
const wrangler = join(root, "services/platform/node_modules/.bin/wrangler");
const config = join(root, "services/platform/wrangler.jsonc");
const regionalBindings = {
  local: ["ORGANISATION_DB_WNAM", "ORGANISATION_DB_EU"],
  production: ["ORGANISATION_DB_APAC"],
};

function machineFiles(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    if (["node_modules", "dist", ".wrangler"].includes(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...machineFiles(path));
    else if (name.endsWith(".machine.ts")) found.push(path);
  }
  return found;
}

function d1(binding, command) {
  const args = ["d1", "execute", binding, "--config", config, "--json"];
  args.push("--env", environment);
  // The local databases live where `pnpm --filter @seams/platform dev` keeps
  // them (scripts/run-worker.mjs).
  if (remote) args.push("--remote");
  else args.push("--local", "--persist-to", ".wrangler/square-acceptance");
  args.push("--command", command);
  const result = spawnSync(wrangler, args, {
    cwd: join(root, "services/platform"),
    encoding: "utf8",
  });
  if (result.status !== 0)
    return {
      error: (result.stderr || result.stdout).trim().split("\n").at(-1),
    };
  try {
    return { rows: JSON.parse(result.stdout)[0]?.results ?? [] };
  } catch {
    return { error: "wrangler_output_unreadable" };
  }
}

function censusOfD1(machine, binding) {
  const { table, column } = machine.store;
  const columns = d1(binding, `PRAGMA table_info(${table})`);
  if (columns.error !== undefined) return { binding, error: columns.error };
  if (columns.rows.length === 0) return { binding, error: "table_missing" };
  const names = new Set(columns.rows.map((row) => row.name));
  const timeColumn = ["created_at", "updated_at"].find((name) =>
    names.has(name),
  );
  const open = Object.entries(machine.states)
    .filter(
      ([, state]) => state.kind !== "terminal" && state.kind !== "external",
    )
    .map(([name]) => name);
  const counted = d1(
    binding,
    `SELECT ${column} AS state, COUNT(*) AS count${
      timeColumn === undefined ? "" : `, MIN(${timeColumn}) AS oldest`
    } FROM ${table} WHERE ${column} IN (${open.map((state) => `'${state}'`).join(", ")}) GROUP BY ${column}`,
  );
  if (counted.error !== undefined) return { binding, error: counted.error };
  const now = Date.now();
  return {
    binding,
    states: Object.fromEntries(
      open.map((state) => {
        const row = counted.rows.find((entry) => entry.state === state);
        const exit = machine.states[state].exit;
        const oldestAgeMs =
          typeof row?.oldest === "number" ? now - row.oldest : null;
        return [
          state,
          {
            count: row?.count ?? 0,
            oldestAgeMs,
            pastExit:
              exit?.kind === "due" && oldestAgeMs !== null
                ? oldestAgeMs > exit.afterMs
                : null,
          },
        ];
      }),
    ),
  };
}

const machines = [];
for (const path of ["services", "packages"].flatMap((folder) =>
  machineFiles(join(root, folder)),
)) {
  const module = await import(pathToFileURL(path).href);
  for (const machine of Object.values(module))
    if (machine?.store !== undefined && typeof machine.owner === "string")
      machines.push({ ...machine, file: relative(root, path) });
}

const adminOrigin = argument("--admin-origin");
let actorCensus = null;
if (adminOrigin !== undefined) {
  const token = process.env.ORGANISATION_ADMIN_TOKEN ?? "";
  if (token.length === 0)
    throw new Error("ORGANISATION_ADMIN_TOKEN is required");
  const response = await fetch(`${adminOrigin}/v1/admin/machine-census`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok)
    throw new Error(`The census route answered HTTP ${response.status}`);
  actorCensus = await response.json();
}

const census = machines.map((machine) => {
  const inActor =
    machine.owner.startsWith("services/platform/src/actors/") ||
    machine.owner.startsWith("services/commerce/");
  return inActor
    ? actorCensus === null
      ? {
          machine: machine.name,
          store: "actor",
          table: machine.store.table,
          read: false,
          reason: "run with --admin-origin to read the Actor census route",
        }
      : {
          machine: machine.name,
          store: "actor",
          table: machine.store.table,
          read: true,
          actors: actorCensus.actors,
          states: actorCensus.machines?.[machine.name] ?? {},
          ages: actorCensus.ages?.[machine.name] ?? {},
        }
    : {
        machine: machine.name,
        store: "d1_regional",
        table: machine.store.table,
        read: true,
        databases: (regionalBindings[environment] ?? []).map((binding) =>
          censusOfD1(machine, binding),
        ),
      };
});

const date = new Date().toISOString().slice(0, 10);
const directory = join(root, "docs/evidence/refactor-15");
mkdirSync(directory, { recursive: true });
const output = join(directory, `census-${date}-${environment}.json`);
writeFileSync(
  output,
  `${JSON.stringify({ environment, remote, takenAt: new Date().toISOString(), census }, null, 2)}\n`,
);
const stuckD1 = census
  .flatMap((entry) => entry.databases ?? [])
  .flatMap((database) => Object.values(database.states ?? {}))
  .filter((state) => state.pastExit === true).length;
// Each Actor state with a row past its exit or a row with no time.
const actorAges = census.flatMap((entry) =>
  Object.entries(entry.ages ?? {})
    .filter(([, age]) => age.pastExit > 0 || age.untimed > 0)
    .map(([state, age]) => ({ name: `${entry.machine}.${state}`, ...age })),
);
const stuck = stuckD1 + actorAges.filter((age) => age.pastExit > 0).length;
for (const age of actorAges)
  console.log(
    `  ${age.name}: ${age.pastExit} past exit (${age.pastExitNoAlarm} in an Actor with no alarm), ${age.untimed} with no time, oldest ${
      age.oldestAgeMs === null
        ? "unknown"
        : `${(age.oldestAgeMs / 3_600_000).toFixed(1)} h`
    }`,
  );
console.log(
  `census: ${census.length} machine(s), ${census.filter((entry) => entry.read).length} read, ${stuck} state(s) past their exit; wrote ${relative(root, output)}`,
);

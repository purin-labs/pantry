// Checks every machine that a `*.machine.ts` file defines (Refactor 15, S1):
// the table rules of `machineProblems`, an exit on every state that is not
// terminal, an owner module that exists, and an alarm reconciler with the
// name that each `due` exit gives.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { machineProblems } from "../packages/std/src/state-machine.ts";
import { COMMERCE_MACHINES } from "../packages/commerce-contracts/src/commerce-machines.ts";

const root = new URL("..", import.meta.url).pathname;
const searched = ["services", "packages", "apps"];
const skipped = new Set(["node_modules", "dist", ".wrangler", "target"]);

function filesUnder(directory, test) {
  const found = [];
  for (const name of readdirSync(directory)) {
    if (skipped.has(name) || name.startsWith(".")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path, test));
    else if (test(name)) found.push(path);
  }
  return found;
}

const sources = searched.flatMap((folder) =>
  filesUnder(join(root, folder), (name) => /\.(ts|tsx)$/u.test(name)),
);
const machineFiles = sources.filter((path) => path.endsWith(".machine.ts"));
const reconcilerNames = new Set();
for (const path of sources)
  for (const match of readFileSync(path, "utf8").matchAll(
    /\bname:\s*"([a-z0-9_]+)"/gu,
  ))
    reconcilerNames.add(match[1]);

const problems = [];
const names = new Set();
for (const path of machineFiles) {
  const module = await import(pathToFileURL(path).href);
  for (const [exported, machine] of Object.entries(module)) {
    if (
      typeof machine !== "object" ||
      machine === null ||
      !("states" in machine) ||
      !("transitions" in machine)
    )
      continue;
    const where = `${relative(root, path)} ${exported}`;
    if (names.has(machine.name))
      problems.push(`${where}: a second machine is named ${machine.name}`);
    names.add(machine.name);
    for (const problem of machineProblems(machine, { requireExits: true }))
      problems.push(`${where}: ${problem}`);
    if (machine.owner !== undefined) {
      try {
        statSync(join(root, machine.owner));
      } catch {
        problems.push(`${where}: owner ${machine.owner} does not exist`);
      }
    }
    for (const [state, definition] of Object.entries(machine.states))
      if (
        definition.exit?.kind === "due" &&
        !reconcilerNames.has(definition.exit.reconciler)
      )
        problems.push(
          `${where}: ${state} names reconciler ${definition.exit.reconciler}, which no alarm defines`,
        );
  }
}

// Commerce's commerce machines keep their own table rules
// (`pnpm --filter @seams/commerce-contracts commerce-data:check`); a due exit
// there must still name a pass that the alarm runs.
for (const machine of Object.values(COMMERCE_MACHINES))
  for (const [state, definition] of Object.entries(machine.states))
    if (
      definition.exit?.kind === "due" &&
      !reconcilerNames.has(definition.exit.reconciler)
    )
      problems.push(
        `commerce-machines.ts ${machine.name}: ${state} names reconciler ${definition.exit.reconciler}, which no alarm defines`,
      );

if (problems.length > 0) {
  console.error(`state machines: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(`state machines: ${names.size} machine(s) pass`);

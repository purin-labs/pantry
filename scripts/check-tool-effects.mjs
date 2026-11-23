#!/usr/bin/env node
// Fails when an agent tool with an effect has no `prepare` (Refactor 17,
// step A1.4).
//
// A `draft`, `receipt` or `scheduled` tool has two parts. `prepare` does the
// live checks and the reads, and it returns the effect with its exit checks.
// The executor's host, `settleToolEffect` in
// foundation/tool-handlers/agent-tools/session-support.ts, reads the label, runs
// the checks and calls `run`. So the exit check of every effect tool runs at
// one place. A tool of this kind that defines `handler` runs its effect with
// no such check, and this lint refuses it.
//
// A `read`, `proposal` or `surface` tool defines `handler`: it changes
// nothing, or a person confirms the change, or the page runs the command.
//
//   node scripts/check-tool-effects.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE =
  /^(services\/platform\/src\/(agent-tools|custom-connectors)|foundation\/agent-tools)\/.+\.ts$/;
// An area package and a surface package keep the folders of the Worker source
// in server/ (Refactor 17, Stage B), with their tool families.
const AREA_SOURCE =
  /^(areas|surfaces)\/[^/]+\/server\/(agent-tools|custom-connectors)\/.+\.ts$/;
const DEFINITION = /define\w+Tool\(\{\n([\s\S]*?)\n\}\);/g;
const EFFECTS_WITH_PREPARE = new Set(["draft", "receipt", "scheduled"]);

const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((path) => SOURCE.test(path) || AREA_SOURCE.test(path));

const faults = [];
let tools = 0;
let withPrepare = 0;
for (const path of files) {
  const text = readFileSync(join(root, path), "utf8");
  for (const [, body] of text.matchAll(DEFINITION)) {
    const name = /^ {2}name: "([^"]+)"/m.exec(body)?.[1] ?? "(a computed name)";
    const effect = /^ {2,}effect: "([a-z]+)"/m.exec(body)?.[1];
    if (effect === undefined) {
      faults.push(`${path}: ${name} has no effect that this lint can read`);
      continue;
    }
    tools += 1;
    const prepare = /^ {2}prepare:/m.test(body);
    const handler = /^ {2,}handler:/m.test(body);
    if (EFFECTS_WITH_PREPARE.has(effect)) {
      withPrepare += 1;
      if (!prepare || handler) {
        faults.push(
          `${path}: ${name} is a ${effect} tool, so it defines prepare and no handler`,
        );
      }
    } else if (prepare) {
      faults.push(
        `${path}: ${name} is a ${effect} tool, so it defines handler and no prepare`,
      );
    }
  }
}

if (tools === 0) faults.push("no tool definition found: the pattern is wrong");

if (faults.length > 0) {
  console.error(faults.join("\n"));
  console.error(
    "An effect tool gives its effect to the executor, which runs the exit check. See docs/refactor-17.md, step A1.4.",
  );
  process.exit(1);
}
console.log(
  `tool effects: ${tools} tool definitions, ${withPrepare} with an effect, each with prepare`,
);

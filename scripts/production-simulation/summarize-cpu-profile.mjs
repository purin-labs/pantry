// Summarizes a V8 CPU profile (`node --cpu-prof`): the self time of the
// busiest functions and the inclusive time of named functions.
//
//   node scripts/production-simulation/summarize-cpu-profile.mjs PROFILE.cpuprofile
//     [--top 25] [--inclusive thaw,freeze,advanceRun]
//
// Wasm frames without names count as one `(wasm)` entry, so the report also
// gives the share of the profile inside the controller module.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
let file = null;
let top = 25;
let inclusive = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--top") top = Number(args[++index]);
  else if (args[index] === "--inclusive") inclusive = args[++index].split(",");
  else if (file === null) file = args[index];
  else throw new Error(`Unknown argument ${args[index]}`);
}
assert.ok(file !== null, "Provide a .cpuprofile file");

const profile = JSON.parse(readFileSync(file, "utf8"));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes)
  for (const child of node.children ?? []) parent.set(child, node.id);

// Microseconds of each sample, given to the node it hit.
const selfTime = new Map();
for (let index = 0; index < profile.samples.length; index++) {
  const id = profile.samples[index];
  const delta = profile.timeDeltas[index] ?? 0;
  selfTime.set(id, (selfTime.get(id) ?? 0) + delta);
}

function label(node) {
  const frame = node.callFrame;
  if (
    frame.url.startsWith("wasm://") ||
    /^wasm-function/.test(frame.functionName)
  )
    return "(wasm)";
  const name = frame.functionName || "(anonymous)";
  return frame.url === ""
    ? name
    : `${name} ${basename(frame.url)}:${frame.lineNumber + 1}`;
}

const total = [...selfTime.values()].reduce((sum, value) => sum + value, 0);
const bySelf = new Map();
for (const [id, time] of selfTime) {
  const key = label(nodes.get(id));
  bySelf.set(key, (bySelf.get(key) ?? 0) + time);
}
const idle = (bySelf.get("(idle)") ?? 0) + (bySelf.get("(program)") ?? 0);
console.log(
  `profile ${(total / 1e6).toFixed(2)} s, idle and program ${((idle / total) * 100).toFixed(1)} %`,
);
console.log("self time, percent of the profile:");
for (const [key, time] of [...bySelf].sort((a, b) => b[1] - a[1]).slice(0, top))
  console.log(`  ${((time / total) * 100).toFixed(2).padStart(6)}  ${key}`);

// Inclusive time: a sample counts once for a name on its stack.
if (inclusive.length > 0) {
  console.log("inclusive time, percent of the profile:");
  for (const name of inclusive) {
    let time = 0;
    for (const [id, delta] of selfTime) {
      for (let at = id; at !== undefined; at = parent.get(at))
        if (nodes.get(at).callFrame.functionName === name) {
          time += delta;
          break;
        }
    }
    console.log(`  ${((time / total) * 100).toFixed(2).padStart(6)}  ${name}`);
  }
}

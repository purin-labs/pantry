// Checks the commerce data that TypeScript owns (Plan 78): the state machines
// in src/commerce-machines.ts and the built-in plugins in
// src/commerce-plugins.ts.
import { COMMERCE_MACHINES } from "../src/commerce-machines.ts";
import {
  BUILT_IN_PLUGINS,
  BUILT_IN_PLUGIN_RECEIPT_KINDS,
} from "../src/commerce-plugins.ts";
import { pluginSetProblems } from "../src/plugin-definitions.ts";
import { commerceMachineProblems } from "../src/state-machine.ts";

const machines = Object.values(COMMERCE_MACHINES);
// Each receipt kind belongs to one built-in plugin.
const claimed = new Map();
const kindProblems = [];
for (const [pluginId, kinds] of Object.entries(BUILT_IN_PLUGIN_RECEIPT_KINDS))
  for (const kind of [...kinds.commands, ...kinds.resources]) {
    const owner = claimed.get(kind);
    if (owner !== undefined)
      kindProblems.push(`${kind} belongs to ${owner} and ${pluginId}`);
    claimed.set(kind, pluginId);
  }
const problems = [
  ...machines.flatMap(commerceMachineProblems),
  ...pluginSetProblems(BUILT_IN_PLUGINS),
  ...kindProblems,
];
if (problems.length > 0) {
  console.error(`underclerk commerce data: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(
  `underclerk commerce data: ${machines.length} machines and ${BUILT_IN_PLUGINS.length} built-in plugins pass`,
);


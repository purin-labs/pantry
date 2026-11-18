import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sampleSettings,
  parseSettings,
} from "../../packages/bakery-model/src/bakery.ts";
import { parsePhysicsRequest } from "../../packages/bakery-model/src/bakery-physics.ts";
import { compileWorkcellInput } from "../../packages/production-simulation/src/recipes/bakery/workcell-input.ts";
import {
  compileProductionWorkcells,
  exportProductionWorkcells,
} from "../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";

// Writes an unexecuted production run whose batch B tray requests the native
// slip case. The browser journey opens it and executes every request itself.
const root = fileURLToPath(new URL("../../", import.meta.url));
if (process.argv.length !== 3)
  throw new Error("Provide a new acceptance output directory.");
const output = resolve(process.argv[2]);
if (existsSync(output)) throw new Error("Choose a new output directory.");
mkdirSync(output, { recursive: true });

const template = JSON.parse(
  readFileSync(
    join(root, "assets/bakery-mujoco/fr10-workcell/recordings/nominal.json"),
    "utf8",
  ),
);
const settings = parseSettings({
  ...sampleSettings(),
  batchCount: 3,
  traysPerBatch: 1,
});
if (settings.kind !== "valid") throw new Error(settings.message);
const assignments = [];
for (const batchId of ["A", "B", "C"]) {
  const request = parsePhysicsRequest(
    JSON.stringify({
      ...template.request,
      runId: `browser-acceptance-${batchId}`,
      attemptId: `attempt-browser-acceptance-${batchId}`,
      case: batchId === "B" ? "slip" : "nominal",
    }),
  );
  if (request.kind !== "accepted") throw new Error(request.message);
  const input = compileWorkcellInput(request.request, "0");
  if (input.kind !== "ready") throw new Error(input.message);
  assignments.push({
    batchId,
    tray: 1,
    workerId: "human-1",
    dependsOn: [],
    earliestStartSeconds: 0,
    input: input.input,
  });
}
const compiled = await compileProductionWorkcells(
  settings.settings,
  "normal",
  assignments,
  { manualTasks: [], procedureFingerprint: null },
);
if (compiled.kind !== "ready") throw new Error(compiled.message);
writeFileSync(
  join(output, "pending-slip.json"),
  exportProductionWorkcells(compiled.plan),
);
console.log(
  JSON.stringify({
    file: join(output, "pending-slip.json"),
    fingerprint: compiled.plan.fingerprint,
    operations: compiled.plan.operations.map(
      (operation) => `${operation.id}:${operation.attempt.input.request.case}`,
    ),
  }),
);

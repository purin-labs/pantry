import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exportPhysicsRequest,
  parsePhysicsReplay,
} from "../../packages/bakery-model/src/bakery-physics.ts";

// Writes the native files a rehearsal imports for one chain: the loading
// request, each step's result with the handoff its successor resumes from,
// and the racked result. They come from the recorded native chain.
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = resolve(
  process.argv[2] ?? join(root, "output/playwright/plan42f-native-import"),
);
const sequence = JSON.parse(
  readFileSync(
    join(
      root,
      "assets/bakery-mujoco/fr10-workcell/recordings/oven-rack-cycle.json",
    ),
    "utf8",
  ),
);
mkdirSync(out, { recursive: true });
const parsed = parsePhysicsReplay(JSON.stringify(sequence));
if (parsed.kind === "rejected") throw new Error(parsed.message);
writeFileSync(
  join(out, "loading-request.json"),
  exportPhysicsRequest(parsed.recording.loading.request),
);
writeFileSync(
  join(out, "loading-handoff.json"),
  JSON.stringify({
    kind: "bakery-physics-handoff",
    schemaVersion: 3,
    digest: sequence.loadingHandoffDigest,
    recording: sequence.loading,
  }),
);
writeFileSync(
  join(out, "retrieval-handoff.json"),
  JSON.stringify({
    kind: "bakery-native-rack-handoff",
    handoff: {
      schemaVersion: 2,
      digest: sequence.handoffDigest,
      recording: sequence.unloading,
      loading: {
        schemaVersion: 3,
        digest: sequence.loadingHandoffDigest,
        recording: sequence.loading,
      },
    },
  }),
);
writeFileSync(join(out, "racked.json"), JSON.stringify(sequence));
console.log(out);

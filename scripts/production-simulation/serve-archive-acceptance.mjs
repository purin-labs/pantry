// The isolated runtime of the shared archive journeys (Plan 70 J3):
// archive-browser-worker.ts on http://127.0.0.1:8840 with production routing,
// local D1 and R2, and the built account Worker as its account authority.
//
//   PANTRY_ACCOUNT_WORKER_ARTIFACT=<built account Worker> \
//     node scripts/production-simulation/serve-archive-acceptance.mjs DIR PORTAL_ORIGIN
//
// DIR is a fresh directory for the state of one run, so that no file of an
// earlier run shortens an upload. PORTAL_ORIGIN is the origin of the Portal
// page that the journey opens (default http://127.0.0.1:3110); the journey
// sends its /v1 requests here with that origin. The first line of output
// names the origin when GET /fixture/setup can answer. SIGTERM stops it.
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountArtifact,
  prepareFixtureState,
  runKeys,
  startAccountWorker,
  startFixtureWorker,
  stopOnSignal,
  text,
} from "../lib/fixture-worker.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [directory, browserOrigin = "http://127.0.0.1:3110"] =
  process.argv.slice(2);
if (directory === undefined)
  throw new Error("Usage: serve-archive-acceptance.mjs DIR [PORTAL_ORIGIN]");
const output = resolve(directory);
const persistence = join(output, "state");
mkdirSync(persistence, { recursive: true });
const config = join(
  root,
  "scripts/production-simulation/archive-wrangler.jsonc",
);
const artifact = accountArtifact();
prepareFixtureState({
  config,
  persistence,
  log: join(output, "state.log"),
});
const keys = runKeys();
const account = await startAccountWorker({
  artifact,
  name: "satyr-archive-account-authority",
  database: {
    name: "archive-account-authority",
    id: "00000000-0000-0000-0000-000000000841",
  },
  persistence,
  port: 8841,
  keys,
});
const worker = await startFixtureWorker({
  config,
  persistence,
  port: 8840,
  keys,
  account: (request) => account.fetch(request),
  bindings: {
    PANTRY_PUBLIC_ORIGIN: text(browserOrigin),
    ASSETS: { type: "fetcher", fetcher: asset },
  },
  respond: (request) => {
    throw new Error(`Unexpected external request: ${request.url}`);
  },
});
stopOnSignal(worker, account);
writeFileSync(
  join(output, "runtime.json"),
  `${JSON.stringify(
    {
      origin: "http://127.0.0.1:8840",
      browserOrigin,
      storage: output,
      kind: "local-workerd-d1-r2",
      routes: "production handlers and authorization",
      account: "built account Worker",
    },
    null,
    2,
  )}\n`,
);
console.log("Archive acceptance ready at http://127.0.0.1:8840");

// The Portal's static files, as the Workers static assets serve them: a save
// checks its retained engine bundle under /bakery-physics/ here.
async function asset(request) {
  const directory = join(root, "apps/portal/public");
  const path = resolve(directory, "." + new URL(request.url).pathname);
  if (!path.startsWith(directory + sep))
    return new Response(null, { status: 404 });
  try {
    return new Response(await readFile(path));
  } catch {
    return new Response(null, { status: 404 });
  }
}

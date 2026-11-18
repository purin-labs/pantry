import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "../../services/platform/node_modules/@cloudflare/vitest-plugin/dist/pool/index.mjs";
import { singleDatabaseMigrations } from "../../services/platform/scripts/single-database-schema.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.argv[2]);
const browserOrigin = process.argv[3] ?? "http://127.0.0.1:3110";
const require = createRequire(join(root, "services/platform/package.json"));
const runtimeRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare } = runtimeRequire("miniflare");
const { build } = runtimeRequire("esbuild");
await mkdir(output, { recursive: true });
const worker = join(output, "archive-worker.mjs");
await build({
  entryPoints: [
    join(root, "scripts/production-simulation/archive-browser-worker.mjs"),
  ],
  outfile: worker,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers", "node:*"],
});
const runtime = new Miniflare({
  host: "127.0.0.1",
  port: 8840,
  modules: [{ type: "ESModule", path: worker }],
  compatibilityDate: "2026-07-07",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["DB"],
  d1Persist: join(output, "d1"),
  r2Buckets: ["ARCHIVE"],
  r2Persist: join(output, "r2"),
  serviceBindings: { ASSETS: asset },
  bindings: {
    SATYR_PUBLIC_ORIGIN: browserOrigin,
    SATYR_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
      kind: "affinity",
      placementCellId: "archive-browser",
      locationHint: "wnam",
      databaseBinding: "DB",
    }),
  },
});
try {
  const db = await runtime.getD1Database("DB");
  const migrations = await readD1Migrations(singleDatabaseMigrations());
  // Each run owns a fresh output directory. Never mutate the developer's local DB.
  for (const migration of migrations)
    await db.batch(migration.queries.map(prepare.bind(null, db)));
  await runtime.ready;
  await writeFile(
    join(output, "runtime.json"),
    JSON.stringify(
      {
        origin: "http://127.0.0.1:8840",
        browserOrigin,
        storage: output,
        kind: "local-workerd-d1-r2",
        routes: "production handlers and authorization",
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Archive acceptance ready at http://127.0.0.1:8840");
  await new Promise(waitForStop);
} finally {
  await runtime.dispose();
}

function prepare(db, query) {
  return db.prepare(query);
}
function waitForStop(resolve) {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
}
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

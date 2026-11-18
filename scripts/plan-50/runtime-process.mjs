import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readWorkspaceFixture } from "./workspace-files.mjs";
import { accountAuthorityRuntime } from "./account-worker.mjs";
import { singleDatabaseMigrations } from "../../services/platform/scripts/single-database-schema.mjs";

const [runtimeDirectory, workerPath, persistenceDirectory, providerUrl, group] =
  process.argv.slice(2);
const require = createRequire(resolve(runtimeDirectory, "package.json"));
const { Miniflare } = require("miniflare");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const draftBrowser = group === "draft-browser";
// The draft trial runs the draft collaboration Worker without a browser.
const usesDraftCollaboration = draftBrowser || group === "draft";
const usesCodeMode =
  group === "codemode" || group === "workspace" || usesDraftCollaboration;
const usesProvider = group === "provider" || usesCodeMode;
const usesProposal = group === "proposal" || usesProvider;
// The canonical trials seed one linked Organisation for billing admission.
const seedsWorkflowAccount = group === "default";
const usesAuthority = usesProposal || seedsWorkflowAccount;
const fixtureQueries = usesAuthority ? await readFixtureQueries() : [];
const modules = [{ type: "ESModule", path: workerPath }];
for (const name of await readdir(dirname(workerPath))) {
  if (name.endsWith(".wasm"))
    modules.push({
      type: "CompiledWasm",
      path: join(dirname(workerPath), name),
    });
}
const SANDBOX_WORKER = "plan50-code-mode-sandbox";
const sandboxDirectory = join(dirname(workerPath), "code-mode-sandbox");
// The Code Mode sandbox Worker, which evaluate-pi-durable.mjs builds.
const sandbox = usesCodeMode
  ? {
      name: SANDBOX_WORKER,
      modulesRoot: sandboxDirectory,
      modules: [
        { type: "ESModule", path: join(sandboxDirectory, "worker.mjs") },
        { type: "CompiledWasm", path: join(sandboxDirectory, "quickjs.wasm") },
      ],
      compatibilityDate: "2026-07-07",
      durableObjects: {
        SANDBOX: { className: "CodeModeSandbox", useSQLite: true },
      },
    }
  : null;
const account = usesAuthority
  ? await accountAuthorityRuntime(persistenceDirectory)
  : null;
const worker = {
  name: "plan50-candidate",
  ...(usesProvider ? { outboundService: forwardOutboundRequest } : {}),
  modules,
  modulesRoot: dirname(workerPath),
  compatibilityDate: "2026-07-01",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: {
    CANDIDATE: { className: "CandidateActor", useSQLite: true },
    ...(group === "workspace"
      ? {
          WORKSPACE_EXECUTOR: {
            className: "WorkspaceExecutor",
            useSQLite: true,
          },
        }
      : {}),
    ...(usesCodeMode
      ? {
          CODE_MODE_PLATFORM_GOVERNOR_ACTOR: {
            className: "CodeModePlatformGovernorActor",
            useSQLite: true,
          },
          CODE_MODE_SANDBOX: {
            className: "CodeModeSandbox",
            scriptName: SANDBOX_WORKER,
            useSQLite: true,
          },
        }
      : {}),
    ...(usesProposal
      ? {
          ORGANISATION: { className: "ProposalOrganisation", useSQLite: true },
          CASE: { className: "ProposalCase", useSQLite: true },
        }
      : {}),
  },
  r2Buckets: ["ARCHIVE"],
  d1Databases: usesAuthority ? ["DB"] : [],
  kvNamespaces: usesDraftCollaboration ? ["POLICY_KV"] : [],
  queueProducers: usesProposal ? { EVENT_Q: "trial-context" } : {},
  serviceBindings: {
    ...account?.serviceBindings,
    // A price proposal reads the offer's price allowance from Commerce.
    ...(usesProposal ? { UNDERCLERK: forwardCommerceRequest } : {}),
  },
  bindings: {
    PROVIDER_URL: providerUrl,
    TRIAL_SCENARIO: basename(persistenceDirectory),
    // Platform's paid route, on the cheaper model that tests run.
    OPENROUTER_API_KEY: "native-model-fixture-key",
    SATYR_PLATFORM_PI_MODEL: "qwen/qwen3.7-flash",
    ...(group === "workspace"
      ? {
          WORKSPACE_FIXTURE: JSON.stringify(
            await readWorkspaceFixture(repository),
          ),
        }
      : {}),
    ...(usesDraftCollaboration
      ? {
          DRAFT_SCENARIO: basename(persistenceDirectory),
          SATYR_DEPLOYMENT_PROFILE: "local",
          SLACK_APP_ID: "A12345678",
        }
      : {}),
    ...(draftBrowser
      ? {
          FIXTURE_BROWSER_ENTRY: await readFile(
            join(dirname(workerPath), "browser.js"),
            "utf8",
          ),
          FIXTURE_BROWSER_STYLE: await readFile(
            join(dirname(workerPath), "browser.css"),
            "utf8",
          ),
        }
      : {}),
    ...(usesProvider
      ? {
          SATYR_PUBLIC_ORIGIN: draftBrowser
            ? "http://127.0.0.1:8836"
            : "https://fixture.test",
          GOOGLE_OIDC_CLIENT_ID: "native-provider-fixture",
          GOOGLE_OIDC_CLIENT_SECRET: "native-provider-fixture-secret",
        }
      : {}),
    ...(usesProposal
      ? {
          UNDERCLERK_BASE_URL: "http://underclerk.test",
          UNDERCLERK_SERVICE_TOKEN: "underclerk-e2e-token",
        }
      : {}),
    ...(usesAuthority
      ? {
          FIXTURE_QUERIES: JSON.stringify(fixtureQueries),
          SATYR_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
            databaseBinding: "DB",
            kind: "affinity",
            placementCellId: "cell-trial",
            locationHint: "wnam",
          }),
        }
      : {}),
    ...(seedsWorkflowAccount ? { TRIAL_WORKFLOW_ACCOUNT: "seed" } : {}),
    // Last, so that the account fixture's Google client is the one in use.
    ...account?.bindings,
  },
};
const runtime = new Miniflare({
  ...(draftBrowser ? { host: "127.0.0.1", port: 8836 } : {}),
  durableObjectsPersist: persistenceDirectory,
  r2Persist: join(persistenceDirectory, "r2"),
  kvPersist: join(persistenceDirectory, "kv"),
  d1Persist: join(persistenceDirectory, "d1"),
  workers: [worker, account?.worker, sandbox].filter(Boolean),
});

const address = await runtime.ready;
process.send({ ready: String(address) });
process.on("message", shutdown);

async function shutdown(message) {
  if (message !== "close") return;
  await runtime.dispose();
  process.exit(0);
}

async function readFixtureQueries() {
  const plugin = pathToFileURL(
    join(
      repository,
      "services/platform/node_modules/@cloudflare/vitest-plugin/dist/pool/index.mjs",
    ),
  );
  const { readD1Migrations } = await import(plugin.href);
  const migrations = await readD1Migrations(singleDatabaseMigrations());
  return migrations.flatMap(migrationQueries);
}

function migrationQueries(migration) {
  return migration.queries;
}

// Platform reaches OpenRouter with the Worker's own fetch, so a trial turn's
// model request leaves here and goes to the fixture provider.
async function forwardOutboundRequest(request) {
  let target = request.url;
  if (target === "https://openrouter.ai/api/v1/chat/completions") {
    target = new URL("/openrouter", providerUrl);
    target.searchParams.set("scenario", basename(persistenceDirectory));
  }
  return fetch(target, {
    method: request.method,
    headers: request.headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
    signal: request.signal,
  });
}

async function forwardCommerceRequest(request) {
  const original = new URL(request.url);
  const target = new URL(
    `/underclerk${original.pathname}${original.search}`,
    providerUrl,
  );
  target.searchParams.set("scenario", basename(persistenceDirectory));
  return fetch(target, {
    method: request.method,
    headers: request.headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
  });
}

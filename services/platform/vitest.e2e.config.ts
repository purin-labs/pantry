import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL as NodeUrl } from "node:url";
import { builtinModules } from "node:module";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { unstable_readConfig } from "wrangler";

import { commerceFixtureWorkerArtifact } from "./tests/commerce-fixture-worker";
import { shopGatewayAdapters } from "./tests/shop-gateway-adapters";
import { writeJourneyArtifact } from "./tests/journey-artifacts";

const TEST_SECRET_BINDINGS = {
  AIRTABLE_OAUTH_CLIENT_SECRET: "airtable-e2e-secret",
  COMMERCE_LAB_SIGNING_SECRET: "commerce-lab-e2e-secret",
  GMAIL_OAUTH_CLIENT_SECRET: "gmail-e2e-secret",
  GOOGLE_OIDC_CLIENT_SECRET: "google-oidc-e2e-secret",
  NOTION_OAUTH_CLIENT_SECRET: "notion-e2e-secret",
  OPENROUTER_API_KEY: "openrouter-e2e-key",
  TYPESAFE_API_KEY: "typesafe-pantry-e2e-key-0000000000",
  SESSION_TOKEN_SECRET: "session-token-e2e-secret",
  SHOPIFY_CLIENT_ID: "shopify-e2e-client",
  SHOPIFY_CLIENT_SECRET: "shopify-e2e-secret",
  SLACK_CLIENT_ID: "slack-e2e-client",
  SLACK_CLIENT_SECRET: "slack-e2e-secret",
  SLACK_OAUTH_STATE_SECRET: "slack-oauth-state-e2e-secret",
  SLACK_SIGNING_SECRET: "slack-signing-e2e-secret",
  SQUARE_OAUTH_CLIENT_SECRET: "square-e2e-secret",
  STRIPE_CONNECT_CLIENT_ID: "stripe-e2e-client",
  STRIPE_CONNECT_CLIENT_SECRET: "sk_test_pantry_platform_e2e",
  STRIPE_CONNECT_WEBHOOK_ID: "we_e2e",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_e2e",
  ORGANISATION_ADMIN_TOKEN: "organisation-admin-e2e-token-000000000000",
  COMMERCE_SERVICE_TOKEN: "commerce-e2e-token",
  PANTRY_FAULT_INJECTION_TOKEN: "fault-injection-e2e-token",
  WHATSAPP_APP_SECRET: "whatsapp-e2e-app-secret",
} as const;

const TEST_VALUE_BINDINGS = {
  AIRTABLE_OAUTH_CLIENT_ID: "airtable-e2e-client",
  GMAIL_OAUTH_CLIENT_ID: "gmail-e2e-client",
  GMAIL_PUBSUB_TOPIC: "projects/mail-e2e/topics/mail-e2e",
  GOOGLE_OIDC_CLIENT_ID: "google-oidc-e2e-client",
  NOTION_OAUTH_CLIENT_ID: "notion-e2e-client",
  PANTRY_DEPLOYMENT_PROFILE: "local",
  PANTRY_PUBLIC_ORIGIN: "https://localhost",
  PANTRY_TEST_ORGANISATION_OWNERS: "Test-Owner@pantry.test, second@pantry.test",
  SQUARE_OAUTH_CLIENT_ID: "sandbox-sq0idb-e2e",
  SQUARE_OAUTH_ENVIRONMENT: "development",
  PANTRY_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
    kind: "affinity",
    placementCellId: "e2e",
    locationHint: "wnam",
    databaseBinding: "DB",
    cells: [
      {
        kind: "affinity",
        placementCellId: "e2e-policy-snapshot",
        locationHint: "wnam",
        databaseBinding: "DB",
      },
      {
        kind: "affinity",
        placementCellId: "e2e-policy-activation",
        locationHint: "wnam",
        databaseBinding: "DB",
      },
      {
        kind: "affinity",
        placementCellId: "e2e-policy-kv",
        locationHint: "wnam",
        databaseBinding: "DB",
      },
      {
        kind: "affinity",
        placementCellId: "e2e-cleanup-live",
        locationHint: "wnam",
        databaseBinding: "DB",
      },
      {
        kind: "affinity",
        placementCellId: "e2e-cleanup-recovery",
        locationHint: "wnam",
        databaseBinding: "DB",
      },
      {
        kind: "affinity",
        placementCellId: "e2e-archive-cleanup",
        locationHint: "wnam",
        databaseBinding: "DB",
      },
      {
        kind: "affinity",
        placementCellId: "e2e-fork-admission",
        locationHint: "wnam",
        databaseBinding: "DB",
      },
      {
        kind: "affinity",
        placementCellId: "e2e-fork-preparation",
        locationHint: "wnam",
        databaseBinding: "DB",
      },
      {
        kind: "affinity",
        placementCellId: "e2e-fork-publication",
        locationHint: "wnam",
        databaseBinding: "DB",
      },
      {
        kind: "affinity",
        placementCellId: "e2e-fork-failure",
        locationHint: "wnam",
        databaseBinding: "DB",
      },
    ],
  }),
  PANTRY_VAULT_ACTIVE_KEY_VERSION: "v1",
  SLACK_APP_ID: "A12345678",
  COMMERCE_BASE_URL: "http://commerce.test",
  SHOP_ORDER_PAGE_ORIGIN: "https://{name}.menu.test",
  WHATSAPP_APP_ID: "1000000000000001",
  WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: "3000000000000003",
} as const;

export default defineConfig({
  plugins: [cloudflareTest(cloudflareOptions)],
  ssr: {
    resolve: {
      // Native journeys must select the same package exports as Wrangler.
      conditions: [
        "workerd",
        "worker",
        "module",
        "browser",
        "development|production",
      ],
    },
  },
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    setupFiles: ["./tests/e2e/setup.ts"],
    fileParallelism: false,
    retry: 0,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["@earendil-works/pi-durable"],
          rolldownOptions: {
            external: [...builtinModules, /^node:/u],
          },
        },
      },
    },
  },
});

/** The cells of the fixture profile, each bound to a regional database. */
function regionalFixtureCells(): readonly Record<string, unknown>[] {
  const profile = JSON.parse(
    TEST_VALUE_BINDINGS.PANTRY_ORGANISATION_PLACEMENT_PROFILE,
  ) as Record<string, unknown> & { cells: Record<string, unknown>[] };
  const { cells, ...root } = profile;
  return [root, ...cells].map((cell) => ({
    ...cell,
    databaseBinding: "ORGANISATION_DB_WNAM",
  }));
}

async function cloudflareOptions() {
  // Global records and each Organisation's records live in two databases, as
  // in production.
  const migrations = await readD1Migrations(
    fileURLToPath(new NodeUrl("./migrations-global", import.meta.url)),
  );
  const regionalMigrations = await readD1Migrations(
    fileURLToPath(new NodeUrl("./migrations-regional", import.meta.url)),
  );
  return {
    remoteBindings: false,
    wrangler: {
      configPath: fileURLToPath(
        new NodeUrl("./tests/e2e/wrangler.jsonc", import.meta.url),
      ),
    },
    miniflare: {
      durableObjects: {
        CODE_MODE_SANDBOX: {
          className: "CodeModeSandbox",
          scriptName: CODE_MODE_SANDBOX_WORKER,
        },
      },
      workers: [
        codeModeSandboxWorker(),
        modelExitWorker(),
        commerceFixtureWorker(),
      ],
      bindings: {
        ...TEST_SECRET_BINDINGS,
        OPENROUTER_API_KEY:
          process.env.PANTRY_PI_ACCEPTANCE_API_KEY ??
          TEST_SECRET_BINDINGS.OPENROUTER_API_KEY,
        ...TEST_VALUE_BINDINGS,
        TEST_MIGRATIONS: migrations,
        TEST_REGIONAL_MIGRATIONS: regionalMigrations,
        TEST_PRODUCTION_CRONS: productionCrons(),
        PANTRY_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
          kind: "affinity",
          placementCellId: "regional-wnam",
          locationHint: "wnam",
          databaseBinding: "ORGANISATION_DB_WNAM",
          cells: [
            {
              kind: "affinity",
              placementCellId: "regional-apac",
              locationHint: "apac",
              databaseBinding: "ORGANISATION_DB_APAC",
            },
            // The fixtures name the cells of the value bindings profile;
            // here each of them keeps its data in the WNAM database.
            ...regionalFixtureCells(),
          ],
        }),
      },
      serviceBindings: {
        COMMERCE: { name: COMMERCE_FIXTURE_WORKER },
        MODEL_EXIT: { name: MODEL_EXIT_WORKER },
        // The E2E runtime cannot run the ChatGPT exit container (Plan 75); an
        // entrypoint of the runner runs its steps instead.
        CHATGPT_EXIT: { name: RUNNER_WORKER, entrypoint: "ChatGptExitNetwork" },
        VAULT_ONEPASSWORD: {
          name: RUNNER_WORKER,
          entrypoint: "OnePasswordNetwork",
        },
        // The real shop gateway's printer and terminal adapters (Plan 90).
        SHOP_GATEWAY_ADAPTERS: shopGatewayAdapters,
        // The writer of a journey's artifact under output/.
        JOURNEY_ARTIFACTS: writeJourneyArtifact,
      },
    },
  };
}

/**
 * The cron triggers of the production Worker. The idle-cost journey runs
 * every one of them, so that a new trigger is measured without a test change.
 */
function productionCrons(): string[] {
  const config = unstable_readConfig({
    config: fileURLToPath(new NodeUrl("./wrangler.jsonc", import.meta.url)),
    env: "production",
  });
  return [...(config.triggers.crons ?? [])];
}

const COMMERCE_FIXTURE_WORKER = "commerce-fixture-e2e";

/**
 * Commerce's built fixture Worker (Plan 76 phase 1). This test runtime never
 * imports Commerce source; the journeys seed it through its scenarios. The
 * deterministic Ed25519 key (32 bytes of 7) lets the delivery verifier run.
 */
function commerceFixtureWorker() {
  const artifact = commerceFixtureWorkerArtifact();
  const settings = JSON.parse(
    readFileSync(join(artifact, "fixture-worker.json"), "utf8"),
  ) as { compatibilityDate: string; compatibilityFlags: string[] };
  const signingKey = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, 7),
  ]).toString("base64url");
  const files = readdirSync(artifact).filter(
    (file) => file.endsWith(".js") || file.endsWith(".wasm"),
  );
  return {
    name: COMMERCE_FIXTURE_WORKER,
    modulesRoot: artifact,
    compatibilityDate: settings.compatibilityDate,
    compatibilityFlags: settings.compatibilityFlags,
    modules: ["worker.js", ...files.filter((file) => file !== "worker.js")].map(
      (file) => ({
        type: file.endsWith(".wasm")
          ? ("CompiledWasm" as const)
          : ("ESModule" as const),
        path: join(artifact, file),
      }),
    ),
    durableObjects: {
      COMMERCE_MERCHANT: {
        className: "CommerceFixtureMerchantDO",
        useSQLite: true,
      },
      COMMERCE_SHOP_NAME: {
        className: "CommerceShopNameDO",
        useSQLite: true,
      },
    },
    // Product photos live in R2, as in production.
    r2Buckets: ["BUCKET"],
    bindings: {
      PANTRY_DEPLOYMENT_PROFILE: "local",
      COMMERCE_SERVICE_TOKEN: TEST_SECRET_BINDINGS.COMMERCE_SERVICE_TOKEN,
      COMMERCE_BUYER_SESSION_SECRET: "bakery-e2e-buyer-secret-00000001",
      COMMERCE_SIGNING_KEY_ID: "key_bakery_e2e",
      COMMERCE_SIGNING_PRIVATE_KEY_PKCS8_B64: signingKey,
      JAPAN_CARRIER_SIGNING_KEY: "bakery-e2e-shipping",
      // Commerce holds Pantry merchants' Square connections (Plan 80 step 4).
      SQUARE_OAUTH_CLIENT_ID: TEST_VALUE_BINDINGS.SQUARE_OAUTH_CLIENT_ID,
      SQUARE_OAUTH_CLIENT_SECRET:
        TEST_SECRET_BINDINGS.SQUARE_OAUTH_CLIENT_SECRET,
      // Commerce links Pantry merchants' Stripe accounts (Plan 80 step 5).
      STRIPE_SECRET_KEY: "sk_test_commerce_e2e",
    },
    // Webhook posts to the platform's origin reach the platform Worker.
    outboundService: { name: RUNNER_WORKER, entrypoint: "CommerceNetwork" },
  };
}

const CODE_MODE_SANDBOX_WORKER = "pantry-code-sandbox-e2e";

let sandboxWorker: ReturnType<typeof buildCodeModeSandboxWorker> | null = null;

/** The sandbox Worker of this Vitest process: one build serves every file. */
function codeModeSandboxWorker() {
  sandboxWorker ??= buildCodeModeSandboxWorker();
  return sandboxWorker;
}

/**
 * Builds the Code Mode sandbox Worker with Wrangler, as a deployment does, and
 * returns it as a second Worker of the test runtime. The platform Worker
 * reaches its class through a `script_name` binding, as in production.
 */
function buildCodeModeSandboxWorker() {
  return {
    name: CODE_MODE_SANDBOX_WORKER,
    compatibilityDate: "2026-07-07",
    ...buildWorkerModules(
      "wrangler.code-mode-sandbox.jsonc",
      "code-mode-sandbox",
    ),
    durableObjects: {
      SANDBOX: { className: "CodeModeSandbox", useSQLite: true },
    },
  };
}

const MODEL_EXIT_WORKER = "pantry-model-exit-e2e";
/**
 * The Worker that runs the test files. The Cloudflare Vitest plugin names it
 * after the Vitest project, and this project has no name.
 */
const RUNNER_WORKER = "vitest-plugin-runner-";

let exitWorker: ReturnType<typeof buildModelExitWorker> | null = null;

/** The model exit Worker of this Vitest process (Plan 73). */
function modelExitWorker() {
  exitWorker ??= buildModelExitWorker();
  return exitWorker;
}

/**
 * Builds the model exit Worker with Wrangler, as a deployment does. The
 * platform Worker reaches it through its `MODEL_EXIT` service binding, as in
 * production. Its outbound requests go to the `ModelExitNetwork` entrypoint
 * of the runner Worker, which sends them on through the test network with a
 * mark. A fake provider can then tell a request that left through it.
 */
function buildModelExitWorker() {
  return {
    name: MODEL_EXIT_WORKER,
    compatibilityDate: "2026-07-07",
    ...buildWorkerModules("wrangler.model-exit.jsonc", "model-exit"),
    bindings: { PANTRY_DEPLOYMENT_PROFILE: "local" },
    outboundService: { name: RUNNER_WORKER, entrypoint: "ModelExitNetwork" },
  };
}

/**
 * Builds a Worker of this package with Wrangler from its local profile.
 *
 * The build has a directory for each Vitest process. The runtime reads the
 * modules from that directory when it starts a test file, so two runs in one
 * checkout must not share it.
 */
function buildWorkerModules(config: string, label: string) {
  const root = fileURLToPath(new NodeUrl("./", import.meta.url));
  const directory = join(root, `.wrangler/${label}-e2e-${process.pid}`);
  rmSync(directory, { recursive: true, force: true });
  process.once(
    "exit",
    rmSync.bind(null, directory, { recursive: true, force: true }),
  );
  const built = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "deploy",
      "--config",
      config,
      "--env",
      "local",
      "--dry-run",
      "--outdir",
      directory,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
    },
  );
  if (built.status !== 0)
    throw new Error(`${label} Worker build failed: ${built.stderr}`);
  return {
    modulesRoot: directory,
    // The main module comes first.
    modules: readdirSync(directory)
      .sort(mainModuleFirst)
      .flatMap(workerModule.bind(null, directory)),
  };
}

function workerModule(
  directory: string,
  name: string,
): { type: "ESModule" | "CompiledWasm"; path: string }[] {
  const path = join(directory, name);
  if (name.endsWith(".js")) return [{ type: "ESModule", path }];
  if (name.endsWith(".wasm")) return [{ type: "CompiledWasm", path }];
  return [];
}

function mainModuleFirst(left: string, right: string) {
  return Number(right === "worker.js") - Number(left === "worker.js");
}

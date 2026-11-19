// The local fixture Worker of a browser journey (Plans 42J, 74, 81 and the
// shop Mac journeys), started by the journey's provider process.
//
// The account authority is not simulated. The provider process starts the
// built account Worker of the acceptance tests (PANTRY_ACCOUNT_WORKER_ARTIFACT)
// as a second local Worker with its own database, and binds it to the fixture
// Worker as `ACCOUNT_PLATFORM`. The account Worker has no public address.
import { unstable_startWorker } from "../../services/platform/node_modules/wrangler/wrangler-dist/cli.js";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, openSync, closeSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Prepares the empty local state `persistence` of the fixture Worker of
 * `config`: the one-database schema in its D1 database, and the two fixture
 * secrets of its secrets store. Wrangler writes its output to `log`. The
 * Python runners of Plans 42J, 74 and 81 do the same before they start the
 * provider process.
 */
export function prepareFixtureState({ config, persistence, log }) {
  const schema = join(persistence, "schema.sql");
  execFileSync("node", [
    join(root, "services/platform/scripts/single-database-schema.mjs"),
    schema,
  ]);
  const fd = openSync(log, "w");
  const wrangler = (args) =>
    execFileSync(
      "pnpm",
      ["--filter", "@seams/platform", "exec", "wrangler", ...args],
      { cwd: root, stdio: ["ignore", fd, fd] },
    );
  try {
    wrangler([
      "d1",
      "execute",
      "DB",
      "--config",
      config,
      "--local",
      "--persist-to",
      persistence,
      "--file",
      schema,
    ]);
    for (const name of ["checkpoint-root", "vault-root"])
      wrangler([
        "secrets-store",
        "secret",
        "create",
        "browser-fixture",
        "--config",
        config,
        "--persist-to",
        persistence,
        "--name",
        name,
        "--scopes",
        "workers",
        "--value",
        "ERERERERERERERERERERERERERERERERERERERERERE=",
      ]);
  } finally {
    closeSync(fd);
  }
}

// The Platform source imports two workspace packages that a build makes. A
// fresh clone or worktree has neither; Wrangler then writes its bundle error
// to the provider log and waits, and the journey stops at its readiness wait.
const BUILT_PACKAGES = [
  ["packages/async-control/dist/deadline.js", "pnpm async-control:build"],
  [
    "packages/contracts/media-wasm-pkg/media_inspect.js",
    "pnpm --filter @seams/contracts media:build",
  ],
];

export function text(value) {
  return { type: "plain_text", value };
}

function jwk(key) {
  return text(JSON.stringify(key.export({ format: "jwk" })));
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A model provider's server-sent event stream of `chunks`. */
export function stream(chunks) {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** The path of the built account Worker. */
export function accountArtifact() {
  const artifact = process.env.PANTRY_ACCOUNT_WORKER_ARTIFACT;
  if (!artifact) {
    throw new Error(
      "Set PANTRY_ACCOUNT_WORKER_ARTIFACT to the built shared account Worker.",
    );
  }
  return artifact;
}

export function artifactSha256(artifact) {
  return createHash("sha256")
    .update(readFileSync(resolve(artifact)))
    .digest("hex");
}

// The keys of one run. The fixture Worker signs each user assertion and the
// account Worker checks it. The account Worker signs the provision of the
// Organisation and the fixture Worker checks it.
export function runKeys() {
  return {
    assertion: generateKeyPairSync("ed25519"),
    provision: generateKeyPairSync("ed25519"),
    google: generateKeyPairSync("rsa", { modulusLength: 2048 }),
  };
}

function unexpectedAccountRequest(request) {
  throw new Error(`Unexpected request of the account Worker: ${request.url}`);
}

/**
 * Starts the account Worker `name` on `port`, with its D1 database
 * `database` ({ name, id }).
 */
export async function startAccountWorker({
  artifact,
  name,
  database,
  persistence,
  port,
  keys,
}) {
  const account = await unstable_startWorker({
    name,
    entrypoint: resolve(artifact),
    compatibilityDate: "2026-07-07",
    compatibilityFlags: ["nodejs_compat"],
    build: { nodejsCompatMode: "v2" },
    bindings: {
      ACCOUNT_DB: {
        type: "d1",
        database_name: database.name,
        database_id: database.id,
      },
      FIXTURE_ASSERTION_PUBLIC_JWK: jwk(keys.assertion.publicKey),
      FIXTURE_GOOGLE_PRIVATE_JWK: jwk(keys.google.privateKey),
      FIXTURE_GOOGLE_PUBLIC_JWK: jwk(keys.google.publicKey),
      FIXTURE_GOOGLE_CLIENT_ID: text("shared-account-satyr-e2e"),
      FIXTURE_PROVISION_PRIVATE_JWK: jwk(keys.provision.privateKey),
    },
    dev: {
      remote: false,
      persist: persistence,
      server: { hostname: "127.0.0.1", port },
      inspector: false,
      watch: false,
      outboundService: unexpectedAccountRequest,
    },
  });
  await account.ready;
  return account;
}

/**
 * Every chat turn binds the Commerce service when it starts (the Costs
 * tools). A fixture shop has no commerce backend, so a call is refused, as
 * in a shop with Commerce down.
 */
function unavailableCommerce(request) {
  return Response.json(
    { error: "underclerk_unavailable", url: request.url },
    { status: 503 },
  );
}

/**
 * Starts the fixture Worker of `config` on `port`. `account` answers its
 * ACCOUNT_PLATFORM binding, UNDERCLERK refuses each call, `bindings` adds
 * others or replaces these, and `respond` answers every request that it
 * sends out.
 */
export async function startFixtureWorker({
  config,
  persistence,
  port,
  keys,
  account,
  bindings = {},
  respond,
}) {
  const unbuilt = BUILT_PACKAGES.filter(
    ([path]) => !existsSync(join(root, path)),
  );
  if (unbuilt.length > 0)
    throw new Error(
      `The fixture Worker needs the built workspace packages. Run ${unbuilt.map(([, command]) => command).join(", then ")}.`,
    );
  const worker = await unstable_startWorker({
    config,
    build: { nodejsCompatMode: "v2" },
    bindings: {
      ACCOUNT_PLATFORM: { type: "fetcher", fetcher: account },
      UNDERCLERK: { type: "fetcher", fetcher: unavailableCommerce },
      ...bindings,
      ACCOUNT_PLATFORM_USER_ASSERTION_PKCS8_B64U: text(
        keys.assertion.privateKey
          .export({ format: "der", type: "pkcs8" })
          .toString("base64url"),
      ),
      ACCOUNT_PLATFORM_PROVISION_ASSERTION_JWK: jwk(keys.provision.publicKey),
    },
    dev: {
      remote: false,
      persist: persistence,
      server: { hostname: "127.0.0.1", port },
      inspector: false,
      watch: false,
      outboundService: respond,
    },
  });
  await worker.ready;
  return worker;
}

/** On SIGTERM or SIGINT, disposes of both Workers and exits. */
export function stopOnSignal(worker, account) {
  async function stop() {
    await worker.dispose();
    await account.dispose();
    process.exit(0);
  }

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

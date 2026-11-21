// The local fixture Worker of a browser journey (Plans 42J, 74, 81 and the
// shop Mac journeys), started by the journey's provider process. Pantry keeps
// its own members (Plan 95), so the Worker needs no outside account authority.
import { unstable_startWorker } from "../../services/platform/node_modules/wrangler/wrangler-dist/cli.js";
import { execFileSync } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
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
      ["--filter", "@purin-labs/platform", "exec", "wrangler", ...args],
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
    "pnpm --filter @purin-labs/contracts media:build",
  ],
];

export function text(value) {
  return { type: "plain_text", value };
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

/**
 * Every chat turn binds the Commerce service when it starts (the Costs
 * tools). A fixture shop has no commerce backend, so a call is refused, as
 * in a shop with Commerce down.
 */
function unavailableCommerce(request) {
  return Response.json(
    { error: "commerce_unavailable", url: request.url },
    { status: 503 },
  );
}

/**
 * Starts the fixture Worker of `config` on `port`. COMMERCE refuses each
 * call, `bindings` adds others or replaces it, and `respond` answers every
 * request that the Worker sends out.
 */
export async function startFixtureWorker({
  config,
  persistence,
  port,
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
      COMMERCE: { type: "fetcher", fetcher: unavailableCommerce },
      ...bindings,
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

/** On SIGTERM or SIGINT, disposes of the Worker and exits. */
export function stopOnSignal(worker) {
  async function stop() {
    await worker.dispose();
    process.exit(0);
  }

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

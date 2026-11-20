import { env } from "cloudflare:workers";
import {
  adminSecretsStore,
  applyD1Migrations,
  listDurableObjectIds,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

import { network } from "./network";
import "../provide-organisation-lifecycle-parts";
// Pi loads each model API module on its first request. In the test runner the
// first load takes about a second, and a second Session that asks for the same
// module during that load never gets it. A Worker bundle has no such load, so
// the suite loads the module that the OpenRouter route uses here, once.
import "@earendil-works/pi-ai/api/openai-completions";

const DATA_ROOT = "ERERERERERERERERERERERERERERERERERERERERERE=";
const VAULT_ROOT_V1 = "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=";
const VAULT_ROOT_V2 = "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM=";

beforeAll(enableNetwork);
beforeEach(resetRuntimeState);
afterEach(resetNetworkHandlers);
afterAll(tearDownNetwork);

async function enableNetwork(): Promise<void> {
  network.configure({ onUnhandledFrame: "error" });
  await network.enable();
}

async function resetRuntimeState(): Promise<void> {
  // Workerd resets resident Actor databases; load idle fixture Actors first.
  await loadFixtureNamespace(env.ORGANISATION);
  await loadFixtureNamespace(env.CASE);
  await loadFixtureNamespace(env.SESSION);
  await loadFixtureNamespace(env.CONNECTOR);
  await loadFixtureNamespace(env.CODE_MODE_PLATFORM_GOVERNOR_ACTOR);
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  if (!env.ORGANISATION_DB_WNAM || !env.ORGANISATION_DB_APAC)
    throw new Error("Regional test databases missing");
  await applyD1Migrations(
    env.ORGANISATION_DB_WNAM,
    env.TEST_REGIONAL_MIGRATIONS,
  );
  await applyD1Migrations(
    env.ORGANISATION_DB_APAC,
    env.TEST_REGIONAL_MIGRATIONS,
  );
  await Promise.all([
    adminSecretsStore(env.DATA_ENCRYPTION_ROOT).create(DATA_ROOT),
    adminSecretsStore(env.VAULT_ROOT_V1).create(VAULT_ROOT_V1),
    adminSecretsStore(env.VAULT_ROOT_V2).create(VAULT_ROOT_V2),
  ]);
}

async function loadFixtureNamespace<
  T extends Rpc.DurableObjectBranded | undefined,
>(namespace: DurableObjectNamespace<T>): Promise<void> {
  for (const id of await listDurableObjectIds(namespace)) {
    await runInDurableObject(namespace.get(id), loadFixtureActor);
  }
}

function loadFixtureActor(_actor: unknown): void {}

function resetNetworkHandlers(): void {
  network.resetHandlers();
}

async function tearDownNetwork(): Promise<void> {
  await network.disable();
}

import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import {
  parseVaultHandle,
  revokeVaultSecret,
  storeVaultSecret,
  type VaultHandle,
} from "@purin-labs/authority/credential-vault/index";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import {
  onboardFixtureOrganisation,
  organisationDatabase,
} from "./organisation-database";

/**
 * The retained-root check that the Vault runbook requires before an
 * operator removes a Vault root, on a Vault with more than 1,000 rows.
 *
 * Two Organisations in two regional databases keep 1,050 secrets, and 50 of
 * them are revoked. The operator's check reads every row of both databases,
 * revoked rows too, and passes. Then one stored secret is damaged, in the
 * last rows that the check reads: the check fails and names that one row.
 * The artifact is `output/vault/root-closure.json`.
 */
it(
  "checks every retained Vault row before a root removal, also above 1,000 rows, and finds one damaged row in the last rows",
  { timeout: 180_000 },
  rootClosureJourney,
);

const WNAM_SECRETS = 600;
const APAC_SECRETS = 450;
const REVOKED = 50;

type Closure = Readonly<{
  status: string;
  auditedRowCount: number;
  revokedRowCount: number;
  versions: readonly Readonly<{
    keyVersion: string;
    rowCount: number;
    decryptedCount: number;
  }>[];
  findings: readonly unknown[];
}>;

async function rootClosureJourney({ task }: TestContext): Promise<void> {
  const before = await inspect();
  expect(before.status).toBe("passed");

  const west = await onboardFixtureOrganisation("Root closure west", "e2e");
  const east = await onboardFixtureOrganisation(
    "Root closure east",
    "regional-apac",
  );
  const westDb = organisationDatabase(west.organisationId);
  const eastDb = organisationDatabase(east.organisationId, "regional-apac");
  const westHandles = await storeSecrets(
    westDb,
    west.organisationId,
    WNAM_SECRETS,
  );
  const eastHandles = await storeSecrets(
    eastDb,
    east.organisationId,
    APAC_SECRETS,
  );
  for (const handle of westHandles.slice(0, REVOKED))
    await revokeVaultSecret({
      db: westDb,
      organisationId: west.organisationId,
      handle,
      now: Date.now(),
    });

  // 1. More than 1,000 rows: the check reads each one and passes.
  const full = await inspect();
  const added = WNAM_SECRETS + APAC_SECRETS;
  expect(full).toMatchObject({
    status: "passed",
    auditedRowCount: before.auditedRowCount + added,
    revokedRowCount: before.revokedRowCount + REVOKED,
    findings: [],
  });
  expect(full.versions).toEqual([
    {
      keyVersion: "v1",
      rowCount: before.auditedRowCount + added,
      decryptedCount: before.auditedRowCount + added,
    },
  ]);

  // 2. One damaged secret in the last rows of the last database: the check
  // fails and names that one row. An operator must not remove a root now.
  const damaged = eastHandles.at(-1);
  if (damaged === undefined) throw new Error("No secret to damage");
  await eastDb
    .prepare(
      "UPDATE vault_secret SET ciphertext_b64 = ? WHERE organisation_id = ? AND vault_handle = ?",
    )
    .bind(
      btoa("damaged ciphertext of a retained secret"),
      east.organisationId,
      damaged,
    )
    .run();
  const failed = await inspect();
  expect(failed).toMatchObject({
    status: "failed",
    auditedRowCount: before.auditedRowCount + added,
    findings: [
      {
        kind: "retained_vault_ciphertext_invalid",
        keyVersion: "v1",
        affectedRows: 1,
      },
    ],
  });

  const artifact = { before, full, failed };
  task.meta.vaultRootClosure = artifact;
  const written = await env.JOURNEY_ARTIFACTS.fetch(
    "http://artifacts/vault/root-closure.json",
    { method: "PUT", body: JSON.stringify(artifact) },
  );
  expect(written.status, await written.text()).toBe(200);
}

/** `GET /v1/admin/vault-root-closure`, as the runbook has the operator call it. */
async function inspect(): Promise<Closure> {
  const response = await exports.default.fetch(
    "https://localhost/v1/admin/vault-root-closure",
    { headers: { authorization: `Bearer ${env.ORGANISATION_ADMIN_TOKEN}` } },
  );
  const body: unknown = await response.json();
  expect({ status: response.status, body }).toMatchObject({
    status: 200,
    body: { ok: true },
  });
  if (!isRecord(body) || !isRecord(body.closure))
    throw new Error(`No closure in ${JSON.stringify(body)}`);
  return body.closure as Closure;
}

async function storeSecrets(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  count: number,
): Promise<readonly VaultHandle[]> {
  const handles: VaultHandle[] = [];
  for (let index = 0; index < count; index += 1) {
    const handle = parseVaultHandle(
      `vault:root-closure:${String(index).padStart(4, "0")}`,
    );
    if (!handle.ok) throw new Error(handle.error.code);
    const stored = await storeVaultSecret({
      db,
      keys: env,
      organisationId,
      handle: handle.value,
      secret: { kind: "bearer", value: `retained-token-${index}` },
      now: Date.now(),
    });
    if (!stored.ok) throw new Error(stored.error.code);
    handles.push(handle.value);
  }
  return handles;
}

declare module "vitest" {
  interface TaskMeta {
    vaultRootClosure?: Record<string, unknown>;
  }
}

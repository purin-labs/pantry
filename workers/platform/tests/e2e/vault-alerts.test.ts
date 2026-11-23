import { env, exports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { expect, it, vi, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import {
  parseVaultHandle,
  storeVaultSecret,
} from "@purin-labs/authority/credential-vault/index";
import { createActiveConnectedIntegration } from "@purin-labs/connections/data/integration-account";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { runScheduledOnboardingReconciliation } from "../../src/onboarding-reconciliation-runner";
import { commerceHeaders } from "./commerce-support";
import { installMemoryFixture, type Member } from "./memory-support";
import { network } from "./network";

/**
 * The operator's alert for a failed credential rotation.
 *
 * An owner replaces the key of a connected Airtable account, and Airtable
 * refuses the new key. The owner sees the rotation fail. The next scheduled
 * run of the Vault alert sweep sends the operator one
 * `vault.alert.failed_credential_rotations` trace, as the Vault runbook says.
 * A day later the failure is old, and the sweep sends no such alert again.
 * The artifact is `output/vault/failed-rotation-alert.json`.
 */
it(
  "alerts the operator to a failed credential rotation once it is recent, and not a day later",
  { timeout: 120_000 },
  failedRotationAlertJourney,
);

const ACCOUNT_ID = "usrRotationAlert";
const DAY_MS = 24 * 60 * 60 * 1_000;

async function failedRotationAlertJourney({
  onTestFinished,
}: TestContext): Promise<void> {
  const { organisationId, author: owner } = await installMemoryFixture();
  const integrationAccountId = await connectAirtable(owner);
  network.use(
    http.get("https://api.airtable.com/v0/meta/whoami", () =>
      HttpResponse.json(
        { error: { type: "AUTHENTICATION_REQUIRED" } },
        { status: 401 },
      ),
    ),
  );

  // The owner's new key is refused, and the owner sees the failure.
  const rotation = await rotateKey(
    owner,
    organisationId,
    integrationAccountId,
    "patRefusedReplacementKey.0123456789",
  );
  expect(rotation).toMatchObject({
    status: 422,
    body: { ok: false, error: "replacement_validation_failed" },
  });

  const warnings = vi.spyOn(console, "warn");
  onTestFinished(() => warnings.mockRestore());
  const now = Date.now();

  // The next scheduled run alerts the operator.
  await runScheduledOnboardingReconciliation(env, now);
  const recent = failedRotationAlerts(warnings.mock.calls);
  expect(recent).toEqual([{ rotation_count: 1 }]);

  // A day later the failure is old: the sweep stays quiet about it.
  warnings.mockClear();
  await runScheduledOnboardingReconciliation(env, now + DAY_MS + 60_000);
  const later = failedRotationAlerts(warnings.mock.calls);
  expect(later).toEqual([]);

  const artifact = { rotation, recent, later };
  const written = await env.JOURNEY_ARTIFACTS.fetch(
    "http://artifacts/vault/failed-rotation-alert.json",
    { method: "PUT", body: JSON.stringify(artifact) },
  );
  expect(written.status, await written.text()).toBe(200);
}

/** The fields of each failed-rotation alert among the warnings. */
function failedRotationAlerts(
  calls: readonly (readonly unknown[])[],
): readonly Record<string, unknown>[] {
  const alerts: Record<string, unknown>[] = [];
  for (const [line] of calls) {
    if (typeof line !== "string" || !line.startsWith("{")) continue;
    const record: unknown = JSON.parse(line);
    if (
      isRecord(record) &&
      record.event === "vault.alert.failed_credential_rotations"
    )
      alerts.push({ rotation_count: record.rotation_count });
  }
  return alerts;
}

/** A connected Airtable account whose key the Vault holds. */
async function connectAirtable(owner: Member): Promise<string> {
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  const handle = parseVaultHandle("vault:airtable:rotation-alert");
  if (!handle.ok) throw new Error(handle.error.code);
  const now = Date.now();
  const stored = await storeVaultSecret({
    db: scope.database,
    keys: env,
    organisationId: owner.organisationId,
    handle: handle.value,
    secret: { kind: "bearer", value: "patCurrentKey.0123456789" },
    now,
  });
  if (!stored.ok) throw new Error(stored.error.code);
  const connected = await createActiveConnectedIntegration(scope.database, {
    organisationId: owner.organisationId,
    provider: "airtable",
    providerSubjectId: ACCOUNT_ID,
    environment: "development",
    authMode: "api_key",
    authority: { kind: "connection_credential", credentialRef: handle.value },
    grantedScopes: ["data.records:read"],
    createdByUserId: owner.userId,
    providerAccountId: ACCOUNT_ID,
    accountKind: "user_grant",
    displayName: "Order base",
    capabilities: [CAPABILITY_KEYS.airtableApiRead],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  return connected.account.integrationAccountId;
}

/** The key replacement of the Integrations page. */
async function rotateKey(
  owner: Member,
  organisationId: OrganisationId,
  integrationAccountId: string,
  replacementSecret: string,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const current = await scope.database
    .prepare(
      "SELECT configuration_version AS configurationVersion FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ configurationVersion: number }>();
  if (current === null) throw new Error("The organisation has no onboarding");
  const headers = commerceHeaders(owner.session);
  headers.set("idempotency-key", crypto.randomUUID());
  headers.set(
    "x-pantry-configuration-version",
    String(current.configurationVersion),
  );
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisationId}/accounts/${integrationAccountId}/credential-rotations`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ replacementSecret }),
    },
  );
  return { status: response.status, body: await response.json() };
}

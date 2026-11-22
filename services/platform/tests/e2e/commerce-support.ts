import { requireOrganisationBootstrap } from "../organisation-execution-fixture";
import { organisationDatabase } from "./organisation-database";
import { isRecord } from "@purin-labs/std";
import { COMMERCE_API_SCOPES } from "@purin-labs/commerce-client";
import { env } from "cloudflare:workers";
import {
  issueControlSession,
  upsertUser,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { parseIntegrationAccountId, parseOrganisationId } from "@purin-labs/kernel/ids";
import { parseInitialOrganisationPlacement } from "../../src/placement";
import { newControlMutationIdentity } from "../../src/data/control-mutation";
import { expect } from "vitest";

export async function connectCommerceFixture(
  organisationId: string,
  userId: string,
  merchantId: string,
  // Platform installs Pantry when it provisions a merchant (Plan 76 phase 2).
  options: Readonly<{
    installPantry?: boolean;
    environment?: "development" | "production";
  }> = {},
): Promise<void> {
  const provision = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${merchantId}`,
    {
      method: "PUT",
      headers: {
        authorization: "Bearer commerce-e2e-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: "commerce.provision-merchant.v2",
        externalReference: organisationId,
        merchantId,
        createdAt: new Date().toISOString(),
      }),
    },
  );
  expect(provision.status, await provision.text()).toBe(200);
  if (options.installPantry !== false) {
    const installed = await env.COMMERCE.fetch(
      `http://commerce.test/v1/admin/merchants/${merchantId}/app-installations/pantry`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer commerce-e2e-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          scopes: COMMERCE_API_SCOPES,
          externalReference: organisationId,
          label: "Pantry",
        }),
      },
    );
    expect(installed.status, await installed.text()).toBe(200);
  }
  const signing = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${merchantId}/test-signing-key`,
    {
      headers: { authorization: "Bearer commerce-e2e-token" },
    },
  );
  const signingKey: unknown = await signing.json();
  if (!isRecord(signingKey) || typeof signingKey.publicKeyB64 !== "string")
    throw new Error("Fixture signing key missing");
  const now = Date.now();
  const accountId = `integration_${crypto.randomUUID()}`;
  const bindingId = `commerce_binding_${crypto.randomUUID()}`;
  const organisationDb = organisationDatabase(organisationId);
  await organisationDb.batch([
    organisationDb.prepare(
      `INSERT INTO commerce_merchant_binding (
      binding_id, organisation_id, integration_account_id, merchant_id, environment,
      delivery_signing_key_id, delivery_signing_public_key_b64, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'key_bakery_e2e', ?, 1, ?, ?)`,
    ).bind(
      bindingId,
      organisationId,
      accountId,
      merchantId,
      options.environment ?? "development",
      signingKey.publicKeyB64,
      now,
      now,
    ),
    organisationDb.prepare(
      `INSERT INTO organisation_commerce_system (
      organisation_id, system_kind, commerce_binding_id, shopify_integration_account_id,
      revision, selected_at, selected_by_user_id
    ) VALUES (?, 'builtin_commerce', ?, NULL, 1, ?, ?)`,
    ).bind(organisationId, bindingId, now, userId),
  ]);
}

/** The Organisation's own Actor, by its registered name. */
export async function commerceOrganisationActor(organisationId: string) {
  const registry = await organisationDatabase(organisationId)
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'organisation' AND lifecycle_status = 'active'",
    )
    .bind(organisationId)
    .first<{ name: string }>();
  if (registry === null) throw new Error("Organisation Actor missing");
  return env.ORGANISATION.getByName(registry.name);
}

/** The time of the shop's last check with Commerce; zero before the first one. */
export function lastSyncedAt(
  status: Awaited<ReturnType<typeof commerceSyncStatus>>,
): number {
  return status.ok && status.value.kind !== "syncing"
    ? status.value.lastSyncedAt
    : 0;
}

/** If the shop reads as in sync with Commerce at `now`, as the Portal shows it. */
export async function commerceSyncStatus(
  organisationId: string,
  now = Date.now(),
) {
  const binding = await organisationDatabase(organisationId)
    .prepare(
      "SELECT integration_account_id AS integrationAccountId FROM commerce_merchant_binding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ integrationAccountId: string }>();
  const organisation = parseOrganisationId(organisationId);
  const account = parseIntegrationAccountId(
    binding?.integrationAccountId ?? "",
  );
  if (!organisation.ok || !account.ok) throw new Error("Invalid sync scope");
  return (
    await commerceOrganisationActor(organisationId)
  ).readCommerceSystemSyncStatus({
    organisationId: organisation.value,
    integrationAccountId: account.value,
    now,
  });
}

export async function commerceClient(subject: string) {
  const now = Date.now();
  const identity = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject,
      email: `${subject}@example.test`,
      displayName: subject,
      emailVerified: true,
    },
    now,
  });
  const session = await issueControlSession({
    db: env.DB,
    userId: identity.userId,
    now,
    ttlMs: 1800000,
  });
  return { identity, session };
}

export async function commerceWorkspace(
  owner: Awaited<ReturnType<typeof commerceClient>>,
  name: string,
  environment: "development" | "production" = "development",
) {
  const now = Date.now();
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!placement.ok) throw new Error(placement.error.path);
  const created = await requireOrganisationBootstrap({
    env,
    owner: owner.identity,
    organisationName: name,
    environment,
    placement: placement.value,
    now,
    mutation: {
      scope: {
        userId: owner.identity.userId,
        organisationScope: "organisation:create",
        route: "/v1/control/organisations",
        operation: "organisation.create",
      },
      boundary: {
        kind: "unversioned",
        idempotencyKey: crypto.randomUUID(),
        requestHash: "bakery-run-test",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "bakery-run-test",
        causationId: crypto.randomUUID(),
        now,
      }),
    },
  });
  return created.organisationId;
}

export function commerceHeaders(session: IssuedControlSession): Headers {
  return new Headers({
    "content-type": "application/json",
    origin: "https://localhost",
    cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
    "x-pantry-csrf": session.csrfToken,
  });
}

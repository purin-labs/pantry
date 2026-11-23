import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { commerceAppInstallationToken } from "@purin-labs/commerce-client";

import { newControlMutationIdentity } from "@purin-labs/tenancy/data/control-mutation";
import type { UserId } from "@purin-labs/control-api/ids";
import {
  archiveOrganisation,
  deleteArchivedOrganisation,
} from "@purin-labs/tenancy/data/organisation-lifecycle";
import { runScheduledOnboardingReconciliation } from "../../src/onboarding-reconciliation-runner";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  commerceClient,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";

declare module "vitest" {
  interface TaskMeta {
    purgedOrganisationCommerce?: Record<string, unknown>;
  }
}

const OPERATOR = "commerce-e2e-token";
const HOOK = "https://hooks.cafe-till.example/commerce";

it(
  "closes the Commerce merchant of a purged Organisation: its keys stop and its webhooks are gone",
  { timeout: 180_000 },
  purgedOrganisationCommerceJourney,
);

/**
 * Refactor 15, refactor 11. A café gave its till system a Commerce key and
 * a webhook for its orders. The café's Organisation is archived and then
 * deleted. The purge closes the café's merchant on Commerce: the till's key
 * and Pantry's own installation are refused, and no webhook subscription is
 * left to post to the till. Before the fix the key worked after the purge.
 */
async function purgedOrganisationCommerceJourney({
  task,
}: TestContext): Promise<void> {
  const owner = await commerceClient(`purge-commerce-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Purged café");
  const merchantId = `merchant_purge_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  const issued = await commerceEngine("POST", `${merchantId}/api-keys`, OPERATOR, {
    label: "Café till",
    scopes: ["orders:read", "webhooks:write"],
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  const tillKey = isRecord(issued.body) ? String(issued.body.key) : "";
  const subscribed = await commerceEngine(
    "POST",
    `${merchantId}/webhook-subscriptions`,
    tillKey,
    {
      subscriptionId: "till_orders",
      url: HOOK,
      topics: ["order.*"],
    },
    "purge-commerce-subscribe",
  );
  expect(subscribed.status, JSON.stringify(subscribed.body)).toBe(200);
  const pantryToken = await commerceAppInstallationToken(OPERATOR, {
    appId: "pantry",
    merchantId,
    externalReference: organisationId,
  });
  const live = {
    tillKey: (await commerceEngine("GET", `${merchantId}/snapshot`, tillKey))
      .status,
    pantry: (await commerceEngine("GET", `${merchantId}/snapshot`, pantryToken))
      .status,
    subscriptions: await subscriptions(merchantId),
  };
  expect(live).toEqual({ tillKey: 200, pantry: 200, subscriptions: 1 });

  // The owner archives the café, then deletes it; the purge runs.
  const execution = () =>
    requireOrganisationExecutionScope(env, organisationId);
  const archived = await archiveOrganisation({
    identityDatabase: env.DB,
    execution: await execution(),
    actorUserId: owner.identity.userId,
    authority: { kind: "organisation_owner" },
    reasonCode: "merchant_archived",
    now: Date.now(),
    mutation: await mutation(organisationId, owner.identity.userId, "archive"),
  });
  if (!archived.ok) throw new Error(archived.error.code);
  await runScheduledOnboardingReconciliation(env, Date.now());
  const deleted = await deleteArchivedOrganisation({
    directory: env.DB,
    execution: await execution(),
    actorUserId: owner.identity.userId,
    now: Date.now(),
    mutation: await mutation(organisationId, owner.identity.userId, "delete"),
  });
  if (!deleted.ok) throw new Error(deleted.error.code);
  await runScheduledOnboardingReconciliation(env, Date.now() + 1_000);
  expect(await cleanupStatus(organisationId)).toBe("purged");

  // The café's merchant is closed: nothing that the café set up still works.
  const after = {
    tillKey: (await commerceEngine("GET", `${merchantId}/snapshot`, tillKey))
      .status,
    pantry: (await commerceEngine("GET", `${merchantId}/snapshot`, pantryToken))
      .status,
    subscriptions: await subscriptions(merchantId),
    newKey: (
      await commerceEngine("POST", `${merchantId}/api-keys`, OPERATOR, {
        label: "Late till",
        scopes: ["orders:read"],
      })
    ).status,
  };
  expect(after).toEqual({
    tillKey: 401,
    pantry: 401,
    subscriptions: 0,
    newKey: 409,
  });
  task.meta.purgedOrganisationCommerce = {
    beforePurge: live,
    afterPurge: after,
  };
}

async function commerceEngine(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey === undefined
          ? {}
          : { "idempotency-key": idempotencyKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return { status: response.status, body: await response.json() };
}

async function subscriptions(merchantId: string): Promise<number> {
  const listed = await commerceEngine(
    "GET",
    `${merchantId}/webhook-subscriptions`,
    OPERATOR,
  );
  if (
    listed.status !== 200 ||
    !isRecord(listed.body) ||
    !Array.isArray(listed.body.subscriptions)
  )
    throw new Error(`Subscriptions unreadable: ${JSON.stringify(listed)}`);
  return listed.body.subscriptions.length;
}

async function mutation(
  organisationId: string,
  userId: UserId,
  operation: "archive" | "delete",
) {
  const version = await fixtureDatabase()
    .prepare(
      "SELECT configuration_version FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<number>("configuration_version");
  if (version === null) throw new Error("Missing configuration version");
  return {
    boundary: {
      kind: "configuration_versioned" as const,
      idempotencyKey: `purge-commerce-${operation}`,
      requestHash: `purge-commerce-${operation}-request`,
      expectedConfigurationVersion: version,
    },
    scope: {
      userId,
      organisationScope: organisationId,
      route: `/v1/control/organisations/${organisationId}${operation === "archive" ? "/archive" : ""}`,
      operation: `organisation.${operation}`,
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "purge-commerce-owner",
      causationId: `purge-commerce-${operation}`,
      now: Date.now(),
    }),
  };
}

function cleanupStatus(organisationId: string): Promise<unknown> {
  return fixtureDatabase()
    .prepare(
      "SELECT status FROM organisation_archive_cleanup WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first("status");
}

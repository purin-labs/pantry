import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import {
  bootstrapOrganisation,
  upsertUser,
  type User,
} from "../../src/data/control-plane";
import { newControlMutationIdentity } from "../../src/data/control-mutation";
import {
  archiveOrganisation,
  deleteArchivedOrganisation,
  renameOrganisation,
  restoreOrganisation,
  type ArchiveOrganisationMutation,
} from "../../src/data/organisation-lifecycle";
import type { OrganisationId } from "../../src/ids";
import { runScheduledOnboardingReconciliation } from "../../src/onboarding-reconciliation-runner";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import { parseInitialOrganisationPlacement } from "../../src/placement";
import {
  commerceClient,
  commerceHeaders,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import { organisationDatabase } from "./organisation-database";

declare module "vitest" {
  interface TaskMeta {
    sharedOrganisationRows?: Record<string, unknown>;
  }
}

const PUBLIC_ORIGIN = "https://localhost";

// Refactor 12, part 2: one module owns the rows that are in both databases.
// Each case drives the product paths and reads both copies of the rows.
it(
  "publishes an Organisation whose onboarding stopped before the global activation, and keeps the directory row in step through rename, archive, restore and deletion",
  sharedOrganisationRowsJourney,
  120_000,
);

it(
  "replays a checkout profile mutation from the receipt in the Organisation's database instead of running it again",
  checkoutProfileReplayJourney,
  120_000,
);

async function sharedOrganisationRowsJourney({
  task,
}: TestContext): Promise<void> {
  const now = Date.now();
  const owner = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "shared-rows-owner",
      email: "shared-rows@example.test",
      displayName: "Shared rows owner",
      emailVerified: true,
    },
    now,
  });
  const create = bootstrapInput(owner, now);

  // C2: the request stops after the regional commit, before the global
  // activation. The Organisation does not route.
  await env.DB.prepare(
    `CREATE TRIGGER stop_global_activation BEFORE UPDATE OF status ON organisation_placement
     WHEN NEW.status = 'active' BEGIN SELECT RAISE(ABORT, 'global_activation_stopped'); END`,
  ).run();
  await expect(bootstrapOrganisation(create)).rejects.toThrow(
    "global_activation_stopped",
  );
  await env.DB.prepare("DROP TRIGGER stop_global_activation").run();
  const organisationId = await stoppedOrganisationId();
  const stopped = {
    global: await placementStatus(env.DB, organisationId),
    regional: await placementStatus(
      organisationDatabase(organisationId),
      organisationId,
    ),
    routable: (await OrganisationExecutionScope.resolve(env, organisationId))
      .ok,
  };
  expect(stopped).toEqual({
    global: "reserved",
    regional: "active",
    routable: false,
  });

  // The scheduled onboarding run publishes it, and the repeat of the same
  // request answers with the same Organisation.
  await runScheduledOnboardingReconciliation(env, Date.now());
  const repaired = {
    global: await placementStatus(env.DB, organisationId),
    routable: (await OrganisationExecutionScope.resolve(env, organisationId))
      .ok,
  };
  expect(repaired).toEqual({ global: "active", routable: true });
  const repeated = await bootstrapOrganisation(create);
  if (!repeated.ok) throw new Error(repeated.error.code);
  expect(repeated.value.organisationId).toBe(organisationId);
  await ensureCreatedOrganisationActor({ env, organisationId, now });

  // C1: each lifecycle change reaches the directory in the same request.
  const renamed = await renameOrganisation({
    directory: env.DB,
    execution: await scopeOf(organisationId),
    actorUserId: owner.userId,
    name: "Shared Rows Bakery",
    mutation: await lifecycleMutation(owner, organisationId, "rename"),
    now: Date.now(),
  });
  if (!renamed.ok) throw new Error(renamed.error.code);
  const afterRename = await bothRows(organisationId);

  const archived = await archiveOrganisation({
    identityDatabase: env.DB,
    execution: await scopeOf(organisationId),
    actorUserId: owner.userId,
    authority: { kind: "organisation_owner" },
    reasonCode: "merchant_archived",
    mutation: await lifecycleMutation(owner, organisationId, "archive"),
    now: Date.now(),
  });
  if (!archived.ok) throw new Error(archived.error.code);
  const afterArchive = await bothRows(organisationId);

  const restored = await restoreOrganisation({
    directory: env.DB,
    execution: await scopeOf(organisationId),
    actorUserId: owner.userId,
    mutation: await lifecycleMutation(owner, organisationId, "restore"),
    now: Date.now(),
  });
  if (!restored.ok) throw new Error(restored.error.code);
  const afterRestore = await bothRows(organisationId);

  // A failed directory copy does not fail the request; the scheduled run
  // copies the row.
  await env.DB.prepare(
    `CREATE TRIGGER stop_directory_copy BEFORE UPDATE OF name ON organisation
     BEGIN SELECT RAISE(ABORT, 'directory_copy_stopped'); END`,
  ).run();
  const renamedAgain = await renameOrganisation({
    directory: env.DB,
    execution: await scopeOf(organisationId),
    actorUserId: owner.userId,
    name: "Shared Rows Café",
    mutation: await lifecycleMutation(owner, organisationId, "rename again"),
    now: Date.now(),
  });
  await env.DB.prepare("DROP TRIGGER stop_directory_copy").run();
  if (!renamedAgain.ok) throw new Error(renamedAgain.error.code);
  const afterFailedCopy = await bothRows(organisationId);
  await runScheduledOnboardingReconciliation(env, Date.now());
  const afterScheduledCopy = await bothRows(organisationId);

  const archivedAgain = await archiveOrganisation({
    identityDatabase: env.DB,
    execution: await scopeOf(organisationId),
    actorUserId: owner.userId,
    authority: { kind: "organisation_owner" },
    reasonCode: "merchant_archived",
    mutation: await lifecycleMutation(owner, organisationId, "archive again"),
    now: Date.now(),
  });
  if (!archivedAgain.ok) throw new Error(archivedAgain.error.code);
  const deleted = await deleteArchivedOrganisation({
    directory: env.DB,
    execution: await scopeOf(organisationId),
    actorUserId: owner.userId,
    mutation: await lifecycleMutation(owner, organisationId, "delete"),
    now: Date.now(),
  });
  if (!deleted.ok) throw new Error(deleted.error.code);
  const afterDelete = await bothRows(organisationId);

  const rows = {
    afterRename,
    afterArchive,
    afterRestore,
    afterFailedCopy,
    afterScheduledCopy,
    afterDelete,
  };
  expect(rows).toEqual({
    afterRename: same({ name: "Shared Rows Bakery", status: "active" }),
    afterArchive: same({ name: "Shared Rows Bakery", status: "deleted" }),
    afterRestore: same({ name: "Shared Rows Bakery", status: "active" }),
    afterFailedCopy: {
      global: { name: "Shared Rows Bakery", status: "active" },
      regional: { name: "Shared Rows Café", status: "active" },
    },
    afterScheduledCopy: same({ name: "Shared Rows Café", status: "active" }),
    afterDelete: same({ name: "Deleted organisation", status: "deleted" }),
  });
  task.meta.sharedOrganisationRows = { stopped, repaired, rows };
}

async function checkoutProfileReplayJourney({
  task,
}: TestContext): Promise<void> {
  const owner = await commerceClient(`checkout-owner-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Checkout bakery");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_checkout_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  const idempotencyKey = `checkout-${crypto.randomUUID()}`;
  const body = JSON.stringify({
    checkoutProfileId: "checkout_domestic",
    name: "Domestic shipping",
    configuration: checkoutConfiguration(),
  });
  const send = async () => {
    const headers = commerceHeaders(owner.session);
    headers.set("idempotency-key", idempotencyKey);
    const response = await exports.default.fetch(
      `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/commerce/checkout-profiles`,
      { method: "POST", headers, body },
    );
    return { status: response.status, body: await response.json() };
  };
  const first = await send();
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  const repeated = await send();
  const list = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/commerce/checkout-profiles`,
    { headers: commerceHeaders(owner.session) },
  );
  const listed: unknown = await list.json();
  const profileCount =
    typeof listed === "object" &&
    listed !== null &&
    "profiles" in listed &&
    Array.isArray(listed.profiles)
      ? listed.profiles.length
      : null;
  const outcome = {
    repeatedStatus: repeated.status,
    repeatedBodyEqualsFirst:
      JSON.stringify(repeated.body) === JSON.stringify(first.body),
    profileCount,
  };
  expect(outcome).toEqual({
    repeatedStatus: 200,
    repeatedBodyEqualsFirst: true,
    profileCount: 1,
  });
  task.meta.sharedOrganisationRows = outcome;
}

function bootstrapInput(owner: User, now: number) {
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!placement.ok) throw new Error(placement.error.path);
  return {
    env,
    owner,
    organisationName: "Shared Rows",
    environment: "development" as const,
    placement: placement.value,
    now,
    mutation: {
      scope: {
        userId: owner.userId,
        organisationScope: "organisation:create",
        route: "/v1/control/organisations",
        operation: "organisation.create",
      },
      boundary: {
        kind: "unversioned" as const,
        idempotencyKey: "shared-rows-create",
        requestHash: "shared-rows-create",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "shared-rows-owner",
        causationId: "shared-rows-create",
        now,
      }),
    },
  };
}

async function stoppedOrganisationId(): Promise<OrganisationId> {
  const row = await env.DB.prepare(
    "SELECT organisation_id AS organisationId FROM organisation WHERE name = 'Shared Rows'",
  ).first<{ organisationId: OrganisationId }>();
  if (row === null) throw new Error("The reservation wrote no row");
  return row.organisationId;
}

async function placementStatus(
  database: D1Database,
  organisationId: OrganisationId,
): Promise<unknown> {
  return database
    .prepare(
      "SELECT status FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = 1",
    )
    .bind(organisationId)
    .first("status");
}

async function scopeOf(
  organisationId: OrganisationId,
): Promise<OrganisationExecutionScope> {
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!scope.ok) throw new Error(scope.error.code);
  return scope.value;
}

type NameAndStatus = Readonly<{ name: unknown; status: unknown }>;

async function bothRows(organisationId: OrganisationId): Promise<
  Readonly<{
    global: NameAndStatus | null;
    regional: NameAndStatus | null;
  }>
> {
  const read = (database: D1Database) =>
    database
      .prepare(
        "SELECT name, status FROM organisation WHERE organisation_id = ?",
      )
      .bind(organisationId)
      .first<NameAndStatus>();
  return {
    global: await read(env.DB),
    regional: await read(organisationDatabase(organisationId)),
  };
}

function same(row: NameAndStatus) {
  return { global: row, regional: row };
}

async function lifecycleMutation(
  owner: User,
  organisationId: OrganisationId,
  operation: string,
): Promise<ArchiveOrganisationMutation> {
  const version = await organisationDatabase(organisationId)
    .prepare(
      "SELECT configuration_version FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<number>("configuration_version");
  if (version === null) throw new Error("Missing configuration version");
  const key = `shared-rows-${operation.replaceAll(" ", "-")}`;
  return {
    boundary: {
      kind: "configuration_versioned",
      idempotencyKey: key,
      requestHash: `${key}-request`,
      expectedConfigurationVersion: version,
    },
    scope: {
      userId: owner.userId,
      organisationScope: organisationId,
      route: `/v1/control/organisations/${organisationId}`,
      operation: `organisation.${operation}`,
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "shared-rows-owner",
      causationId: key,
      now: Date.now(),
    }),
  };
}

function checkoutConfiguration() {
  return {
    currencyPolicy: { kind: "fixed", currency: "JPY" },
    buyerPolicy: { kind: "guest", requiredContact: "email_required" },
    cartPolicy: {
      kind: "single_fulfillment",
      minimumLines: 1,
      maximumLines: 20,
      maximumTotalQuantity: 50,
    },
    pricingPolicy: {
      kind: "published_offers",
      salesChannelId: "sales_channel_web",
    },
    fulfillmentPolicy: {
      kind: "shipping_only",
      shippingPolicyId: "shipping_domestic",
    },
    taxPolicy: {
      kind: "merchant_inclusive",
      jurisdictionPolicyId: "tax_japan",
    },
    paymentPolicy: {
      kind: "external_provider",
      paymentProviderBindingId: "payment_binding_primary_online",
    },
    afterSalePolicy: {
      cancellationPolicyId: "cancellation_standard",
      refundPolicyId: "refunds_standard",
      refundGovernance: { kind: "approval_required" },
    },
    presentationPolicy: {
      locale: "ja-JP",
      merchantDisplayName: "Cafe Central",
      termsPolicyId: "terms_standard",
      privacyPolicyId: "privacy_standard",
      supportContact: "support@example.test",
    },
  };
}

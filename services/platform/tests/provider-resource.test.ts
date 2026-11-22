// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import { upsertUser, type User } from "../src/data/control-plane";
import {
  newControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "../src/data/control-mutation";
import {
  createConnectedIntegration,
  finalizeConnectedIntegrationAccount,
} from "../src/data/integration-account";
import {
  listProviderResourcePage,
  persistProviderResourceSnapshot,
  refreshProviderResourceSnapshot,
  type DiscoveredProviderResource,
} from "../src/data/provider-resource";
import { parseVaultHandle } from "../src/credential-vault";
import type { IntegrationAccountId, OrganisationId } from "@purin-labs/kernel/ids";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { createMigratedDatabase } from "./sqlite-d1";

const NOW = 1_784_200_000_000;

describe("provider resource discovery", () => {
  it("paginates one immutable account-bound snapshot without duplicates", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "resource-owner",
        email: "resource@example.com",
        displayName: "Resource Owner",
        emailVerified: true,
      },
      now: NOW,
    });
    const organisation = await requireOrganisationBootstrap({
      env: {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      owner,
      organisationName: "Resource Merchant",
      environment: "development",
      mutation: organisationBootstrapMutation(owner, NOW),
      placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
      now: NOW,
    });
    const credential = parseVaultHandle("vault:resource:slack:g1");
    if (!credential.ok) {
      throw new Error("resource test vault handle is invalid");
    }
    const connected = await createConnectedIntegration(db, {
      organisationId: organisation.organisationId,
      provider: "slack",
      providerSubjectId: "resource-workspace",
      environment: "development",
      authMode: "shared_pantry_app",
      authority: {
        kind: "connection_credential",
        credentialRef: credential.value,
      },
      grantedScopes: ["channels:history"],
      createdByUserId: owner.userId,
      providerAccountId: "resource-workspace",
      accountKind: "workspace",
      displayName: "Resource workspace",
      capabilities: ["conversation.ingress"],
      audiencePolicy: { kind: "operator" },
      retentionPolicy: { kind: "organisation_default" },
      now: NOW + 1,
    });
    await finalizeConnectedIntegrationAccount({
      db,
      organisationId: organisation.organisationId,
      integrationAccountId: connected.account.integrationAccountId,
      now: NOW + 2,
    });
    const resources = buildResources(55);
    const snapshotRevision = await persistProviderResourceSnapshot({
      db,
      organisationId: organisation.organisationId,
      integrationAccountId: connected.account.integrationAccountId,
      provider: "slack",
      environment: "development",
      resources,
      now: NOW + 3,
    });

    const first = await listProviderResourcePage({
      db,
      organisationId: organisation.organisationId,
      integrationAccountId: connected.account.integrationAccountId,
      query: "",
      cursor: null,
      now: NOW + 4,
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        snapshot_revision: snapshotRevision,
        resources: { length: 50 },
      },
    });
    if (!first.ok || first.value.next_cursor === "end") {
      throw new Error("resource test expected a continuation cursor");
    }
    const second = await listProviderResourcePage({
      db,
      organisationId: organisation.organisationId,
      integrationAccountId: connected.account.integrationAccountId,
      query: "",
      cursor: first.value.next_cursor,
      now: NOW + 5,
    });
    if (!second.ok) {
      throw new Error(`resource continuation failed: ${second.error.code}`);
    }
    expect(second.value.resources).toHaveLength(5);
    expect(second.value.next_cursor).toBe("end");
    const ids = [
      ...first.value.resources.map(readCanonicalResourceId),
      ...second.value.resources.map(readCanonicalResourceId),
    ];
    expect(new Set(ids).size).toBe(55);

    await expect(
      listProviderResourcePage({
        db,
        organisationId: organisation.organisationId,
        integrationAccountId: connected.account.integrationAccountId,
        query: "different query",
        cursor: first.value.next_cursor,
        now: NOW + 5,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "provider_resource_cursor_invalid" },
    });
  });

  it("refreshes a snapshot with a version-fenced receipt and projection bump", async () => {
    const db = createMigratedDatabase();
    const fixture = await createResourceFixture(db);
    const before = await readOrganisationState(db, fixture.organisationId);
    const resources = buildResources(2);
    const result = await refreshProviderResourceSnapshot({
      db,
      organisationId: fixture.organisationId,
      integrationAccountId: fixture.integrationAccountId,
      provider: "slack",
      environment: "development",
      resources,
      mutation: resourceRefreshMutation(
        fixture.owner,
        fixture.organisationId,
        fixture.integrationAccountId,
        before.configurationVersion,
        NOW + 3,
      ),
      now: NOW + 3,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        resourceCount: resources.length,
        configurationVersion: before.configurationVersion,
        projectionRevision: before.projectionRevision + 1,
        receiptId: expect.any(String),
      },
    });
    if (!result.ok) {
      throw new Error(`resource refresh failed: ${result.error.code}`);
    }
    const after = await readOrganisationState(db, fixture.organisationId);
    expect(after).toEqual({
      configurationVersion: before.configurationVersion,
      projectionRevision: before.projectionRevision + 1,
    });

    const page = await listProviderResourcePage({
      db,
      organisationId: fixture.organisationId,
      integrationAccountId: fixture.integrationAccountId,
      query: "",
      cursor: null,
      now: NOW + 4,
    });
    expect(page).toMatchObject({
      ok: true,
      value: {
        snapshot_revision: result.value.snapshotRevision,
        resources: { length: resources.length },
      },
    });

    const receipt = await db
      .prepare(
        `SELECT response_body AS responseBody
       FROM control_mutation_receipt
       WHERE receipt_id = ? AND operation = 'provider.resource.refresh'`,
      )
      .bind(result.value.receiptId)
      .first<{ readonly responseBody: unknown }>();
    if (receipt === null || typeof receipt.responseBody !== "string") {
      throw new Error("resource refresh receipt was not persisted");
    }
    expect(JSON.parse(receipt.responseBody)).toEqual({
      receipt_id: result.value.receiptId,
      organisation_id: fixture.organisationId,
      integration_account_id: fixture.integrationAccountId,
      snapshot_revision: result.value.snapshotRevision,
      resource_count: resources.length,
      configuration_version: before.configurationVersion,
      projection_revision: before.projectionRevision + 1,
    });
  });

  it("rejects a stale configuration version before writing a snapshot or receipt", async () => {
    const db = createMigratedDatabase();
    const fixture = await createResourceFixture(db);
    const before = await readOrganisationState(db, fixture.organisationId);
    await db
      .prepare(
        `UPDATE organisation_onboarding SET configuration_version = ? WHERE organisation_id = ?`,
      )
      .bind(before.configurationVersion + 1, fixture.organisationId)
      .run();

    const result = await refreshProviderResourceSnapshot({
      db,
      organisationId: fixture.organisationId,
      integrationAccountId: fixture.integrationAccountId,
      provider: "slack",
      environment: "development",
      resources: buildResources(1),
      mutation: resourceRefreshMutation(
        fixture.owner,
        fixture.organisationId,
        fixture.integrationAccountId,
        before.configurationVersion,
        NOW + 3,
      ),
      now: NOW + 3,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "configuration_version_conflict" },
    });
    const state = await readOrganisationState(db, fixture.organisationId);
    expect(state).toEqual({
      configurationVersion: before.configurationVersion + 1,
      projectionRevision: before.projectionRevision,
    });
    const snapshotCount = await db
      .prepare(
        `SELECT COUNT(*) AS count
       FROM provider_resource_snapshot WHERE organisation_id = ?`,
      )
      .bind(fixture.organisationId)
      .first<{ readonly count: unknown }>();
    expect(snapshotCount?.count).toBe(0);
    const receiptCount = await db
      .prepare(
        `SELECT COUNT(*) AS count
       FROM control_mutation_receipt
       WHERE organisation_scope = ? AND operation = 'provider.resource.refresh'`,
      )
      .bind(fixture.organisationId)
      .first<{ readonly count: unknown }>();
    expect(receiptCount?.count).toBe(0);
  });
});

function buildResources(count: number): readonly DiscoveredProviderResource[] {
  const resources: DiscoveredProviderResource[] = [];
  for (let index = 0; index < count; index += 1) {
    const padded = String(index).padStart(3, "0");
    resources.push({
      canonicalResourceId: `channel_${padded}`,
      providerResourceId: `C${padded}`,
      providerAccountId: "resource-workspace",
      displayLabel: `#channel-${padded}`,
      accessState: "accessible",
      providerRevision: `revision-${padded}`,
      resourceKind: "public_channel",
    });
  }
  return resources;
}

function readCanonicalResourceId(resource: {
  readonly canonical_resource_id: string;
}): string {
  return resource.canonical_resource_id;
}

async function createResourceFixture(db: SingleDatabase): Promise<{
  readonly owner: User;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
}> {
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "resource-refresh-owner",
      email: "resource-refresh@example.com",
      displayName: "Resource Refresh Owner",
      emailVerified: true,
    },
    now: NOW,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Resource Refresh Merchant",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  const credential = parseVaultHandle("vault:resource-refresh:slack:g1");
  if (!credential.ok) {
    throw new Error("resource refresh test vault handle is invalid");
  }
  const connected = await createConnectedIntegration(db, {
    organisationId: organisation.organisationId,
    provider: "slack",
    providerSubjectId: "resource-refresh-workspace",
    environment: "development",
    authMode: "shared_pantry_app",
    authority: {
      kind: "connection_credential",
      credentialRef: credential.value,
    },
    grantedScopes: ["channels:history"],
    createdByUserId: owner.userId,
    providerAccountId: "resource-refresh-workspace",
    accountKind: "workspace",
    displayName: "Resource Refresh workspace",
    capabilities: ["conversation.ingress"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: NOW + 1,
  });
  await finalizeConnectedIntegrationAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    now: NOW + 2,
  });
  return {
    owner,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
  };
}

async function readOrganisationState(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<{
  readonly configurationVersion: number;
  readonly projectionRevision: number;
}> {
  const row = await db
    .prepare(
      `SELECT configuration_version AS configurationVersion,
            projection_revision AS projectionRevision
     FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      readonly configurationVersion: unknown;
      readonly projectionRevision: unknown;
    }>();
  if (
    row === null ||
    typeof row.configurationVersion !== "number" ||
    typeof row.projectionRevision !== "number"
  ) {
    throw new Error("resource test organisation state is invalid");
  }
  return {
    configurationVersion: row.configurationVersion,
    projectionRevision: row.projectionRevision,
  };
}

function resourceRefreshMutation(
  owner: User,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  expectedConfigurationVersion: number,
  now: number,
): {
  readonly boundary: {
    readonly kind: "configuration_versioned";
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly expectedConfigurationVersion: number;
  };
  readonly scope: ControlMutationReceiptScope;
  readonly identity: ReturnType<typeof newControlMutationIdentity>;
} {
  return {
    boundary: {
      kind: "configuration_versioned",
      idempotencyKey: `resource-refresh-${crypto.randomUUID()}`,
      requestHash: "a".repeat(64),
      expectedConfigurationVersion,
    },
    scope: {
      userId: owner.userId,
      organisationScope: organisationId,
      route: `/v1/control/organisations/${organisationId}/accounts/${integrationAccountId}/resources/refresh`,
      operation: "provider.resource.refresh",
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "resource-refresh-portal-subject",
      causationId: `resource-refresh-${crypto.randomUUID()}`,
      now,
    }),
  };
}

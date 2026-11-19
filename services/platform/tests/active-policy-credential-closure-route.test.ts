import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
/// <reference types="@cloudflare/workers-types" />

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  activateActorRegistryEntry,
  reserveActor,
  type ActorIdentity,
} from "../src/actors/actor-registry";
import { ORGANISATION_ACTOR_SCHEMA_VERSION } from "../src/actors/actor-schema-versions";
import type { OrganisationDO } from "../src/actors/organisation";
import gateway from "../src/integration-gateway";
import { type OrganisationId } from "../src/ids";
import {
  parseOrganisationPlacement,
  type OrganisationPlacement,
} from "../src/placement";

import { requireOrganisationId } from "./test-ids";
import {
  readMigration,
  d1Database,
  requireActorExecutionAdmission,
  requireActorRegistryAdmission,
} from "./sqlite-d1";
import {
  platformEnv,
  testExecutionContext,
  type UnitTestEnv,
} from "./worker-fakes";

describe("active policy credential closure route", function closureRouteSuite() {
  it(
    "is authenticated, GET-only, and resolves the exact active Organisation Actor",
    protectsAndInspectsRoute,
  );
});

async function protectsAndInspectsRoute(): Promise<void> {
  const fixture = await routeFixture();
  const route = `https://pantry.test/v1/admin/active-policy-credential-closure?organisationId=${fixture.organisationId}`;
  const unauthorized = await gateway.fetch(
    new Request(route),
    fixture.env,
    fakeExecutionContext(),
  );
  const wrongMethod = await gateway.fetch(
    new Request(route, {
      method: "POST",
      headers: { authorization: `Bearer ${fixture.adminToken}` },
    }),
    fixture.env,
    fakeExecutionContext(),
  );
  const invalidOrganisation = await gateway.fetch(
    new Request(
      "https://pantry.test/v1/admin/active-policy-credential-closure?organisationId=",
      {
        headers: { authorization: `Bearer ${fixture.adminToken}` },
      },
    ),
    fixture.env,
    fakeExecutionContext(),
  );
  const before = registryRows(fixture.sqlite);
  const failed = await gateway.fetch(
    new Request(route, {
      headers: { authorization: `Bearer ${fixture.adminToken}` },
    }),
    fixture.env,
    fakeExecutionContext(),
  );

  expect(unauthorized.status).toBe(404);
  expect(wrongMethod.status).toBe(405);
  expect(wrongMethod.headers.get("allow")).toBe("GET");
  expect(invalidOrganisation.status).toBe(422);
  expect(failed.status).toBe(200);
  await expect(failed.json()).resolves.toMatchObject({
    ok: true,
    closure: {
      status: "failed",
      organisationId: fixture.organisationId,
      activePolicyVersion: 4,
      findings: [
        {
          kind: "active_policy_ref_without_live_vault",
          ruleId: "provider.read",
          vaultIssue: "missing",
        },
      ],
    },
  });
  expect(registryRows(fixture.sqlite)).toEqual(before);
  expect(fixture.namespace.inspectedNames).toEqual([
    fixture.physicalObjectName,
  ]);

  insertVaultSecret(fixture.sqlite, fixture.organisationId);
  const passed = await gateway.fetch(
    new Request(route, {
      headers: { authorization: `Bearer ${fixture.adminToken}` },
    }),
    fixture.env,
    fakeExecutionContext(),
  );

  expect(passed.status).toBe(200);
  await expect(passed.json()).resolves.toEqual({
    ok: true,
    closure: {
      status: "passed",
      organisationId: fixture.organisationId,
      activePolicyVersion: 4,
      findings: [],
    },
  });
  expect(registryRows(fixture.sqlite)).toEqual(before);
}

type RouteFixture = {
  readonly sqlite: DatabaseSync;
  readonly organisationId: OrganisationId;
  readonly physicalObjectName: string;
  readonly namespace: FakeOrganisationActorNamespace;
  readonly adminToken: string;
  readonly env: UnitTestEnv;
};

async function routeFixture(): Promise<RouteFixture> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readMigration("0001_current_schema.sql"));
  const organisationId = requireOrganisationId(
    "organisation_active_policy_closure_route",
  );
  const actorPlacement = placement();
  const db = d1Database(sqlite);
  const identity = {
    objectKind: "organisation",
    organisationId,
    logicalObjectId: organisationId,
  } satisfies ActorIdentity;
  const adminToken = "active-policy-closure-admin-token";

  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Active Policy Closure Route', 'beta', 1, 'active')`,
    )
    .run(organisationId);
  insertPlacement(sqlite, organisationId, actorPlacement);
  const reserved = await reserveActor({
    db,
    identity,
    admission: await requireActorExecutionAdmission(
      db,
      identity.organisationId,
      actorPlacement,
    ),
    schemaVersion: ORGANISATION_ACTOR_SCHEMA_VERSION,
    now: 10,
  });
  if (!reserved.ok) throw new Error("Actor reservation fixture failed");
  const activated = await activateActorRegistryEntry({
    db,
    admission: await requireActorRegistryAdmission(
      db,
      reserved.value.registryId,
    ),
    registryId: reserved.value.registryId,
    activationToken: reserved.value.activationToken,
    stateVersion: 1,
    now: 11,
  });
  if (!activated.ok) throw new Error("Actor activation fixture failed");

  const namespace = new FakeOrganisationActorNamespace(organisationId);
  return {
    sqlite,
    organisationId,
    physicalObjectName: reserved.value.physicalObjectName,
    namespace,
    adminToken,
    env: platformEnv({
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
      ORGANISATION:
        namespace as unknown as DurableObjectNamespace<OrganisationDO>,
      ORGANISATION_ADMIN_TOKEN: adminToken,
    }),
  };
}

class FakeOrganisationActorNamespace {
  readonly inspectedNames: string[] = [];

  constructor(private readonly organisationId: OrganisationId) {}

  idFromName(name: string): DurableObjectId {
    return new FakeDurableObjectId(name) as unknown as DurableObjectId;
  }

  get(id: DurableObjectId): FakeOrganisationActorStub {
    return new FakeOrganisationActorStub(
      id.toString(),
      this.organisationId,
      this.inspectedNames,
    );
  }

  jurisdiction(): FakeOrganisationActorNamespace {
    return this;
  }
}

class FakeOrganisationActorStub {
  constructor(
    private readonly physicalObjectName: string,
    private readonly organisationId: OrganisationId,
    private readonly inspectedNames: string[],
  ) {}

  inspectActivePolicyCredentials(): Promise<{
    readonly ok: true;
    readonly value: {
      readonly kind: "active_policy";
      readonly organisationId: OrganisationId;
      readonly activeVersion: number;
      readonly credentialRefs: readonly [
        {
          readonly ruleId: string;
          readonly credentialRef: "vault:test:active-policy-route";
        },
      ];
    };
  }> {
    this.inspectedNames.push(this.physicalObjectName);
    return Promise.resolve({
      ok: true,
      value: {
        kind: "active_policy",
        organisationId: this.organisationId,
        activeVersion: 4,
        credentialRefs: [
          {
            ruleId: "provider.read",
            credentialRef: "vault:test:active-policy-route",
          },
        ],
      },
    });
  }
}

class FakeDurableObjectId {
  constructor(private readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

function placement(): OrganisationPlacement {
  const parsed = parseOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "multi-region-preview",
    locationHint: "wnam",
  });
  if (!parsed.ok) throw new Error("placement fixture invalid");
  return parsed.value;
}

function insertPlacement(
  sqlite: DatabaseSync,
  organisationId: OrganisationId,
  actorPlacement: OrganisationPlacement,
): void {
  sqlite
    .prepare(
      `INSERT INTO organisation_placement (
       organisation_id, placement_epoch, placement_kind, placement_cell_id,
       location_hint, residency_jurisdiction, status, fence_token,
       created_at, activated_at
     ) VALUES (?, ?, 'affinity', ?, ?, NULL, 'active', 'placement-fence', 1, 1)`,
    )
    .run(
      organisationId,
      actorPlacement.placementEpoch,
      actorPlacement.placementCellId,
      actorPlacement.locationHint,
    );
}

function insertVaultSecret(
  sqlite: DatabaseSync,
  organisationId: OrganisationId,
): void {
  sqlite
    .prepare(
      `INSERT INTO vault_secret (
       organisation_id, vault_handle, key_version, algorithm, nonce_b64,
       ciphertext_b64, created_at, revoked_at
     ) VALUES (?, 'vault:test:active-policy-route', 'root-v1',
       'AES-GCM-256', 'AA==', 'AA==', 1, NULL)`,
    )
    .run(organisationId);
}

function registryRows(sqlite: DatabaseSync): readonly unknown[] {
  return sqlite
    .prepare("SELECT * FROM durable_object_registry ORDER BY registry_id")
    .all();
}

function fakeExecutionContext(): ExecutionContext {
  return testExecutionContext({ waitUntil: vi.fn() });
}

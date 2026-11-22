import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
/// <reference types="@cloudflare/workers-types" />

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  activateActorRegistryEntry,
  advanceActiveActorRegistrySchema,
  beginActorExport,
  listRecentActiveCaseRegistryEntries,
  listOrganisationActorRegistryEntries,
  quarantineActorRegistryEntry,
  readExactActiveActorRegistryEntry,
  actorActivationRequest,
  reserveActor,
  retireActorRegistryEntry,
  actorPhysicalName,
  type ActorActivationRequest,
  type ActorActivationResult,
  type ActorRegistryEntry,
  type ActorIdentity,
} from "../src/actors/actor-registry";
import {
  parseCaseId,
  parseConnectorId,
  parseSessionId,
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseOrganisationPlacement } from "@purin-labs/tenancy/placement";
import { CASE_ACTOR_SCHEMA_VERSION } from "../src/actors/actor-schema-versions";
import { reconcileOrganisationActorRegistry } from "../src/actors/actor-registry-reconciliation";
import {
  resolveActiveCaseSessionActorsAtPlacement,
  publishActorRegistryActivation,
  resolveActiveSessionActor,
  type ActorNamespaces,
} from "../src/actors/actor-router";
import type { SessionDO } from "../src/actors/agent-session";
import type { CaseDO } from "../src/actors/case";
import { CANONICAL_SESSION_SCHEMA_VERSION } from "../src/actors/actor-schema-versions";
import {
  d1Database,
  readMigration,
  requireActorExecutionAdmission,
  requireActorRegistryAdmission,
} from "./sqlite-d1";

describe("actor registry", function actorRegistrySuite() {
  it("reserves once, publishes activation, and returns the active entry", async function publishesActivation() {
    const fixture = await registryFixture();
    const first = await reserveActor(fixture.reservation);
    const duplicate = await reserveActor({
      ...fixture.reservation,
      now: fixture.reservation.now + 1,
    });

    expect(first.ok).toBe(true);
    expect(duplicate).toEqual(first);

    if (!first.ok) {
      throw new Error("registry reservation fixture failed");
    }

    expect(first.value).toMatchObject({
      lifecycleStatus: "reserved",
      physicalObjectName: "organisation_registry_test",
      stateVersion: 0,
    });

    const activated = await activateActorRegistryEntry({
      db: fixture.db,
      admission: await requireActorRegistryAdmission(
        fixture.db,
        first.value.registryId,
      ),
      registryId: first.value.registryId,
      activationToken: first.value.activationToken,
      stateVersion: 1,
      now: 110,
    });
    const activeRead = await reserveActor({
      ...fixture.reservation,
      now: 120,
    });

    expect(activated.ok).toBe(true);
    expect(activeRead).toEqual(activated);
    expect(activeRead).toMatchObject({
      ok: true,
      value: {
        lifecycleStatus: "active",
        stateVersion: 1,
        activatedAt: 110,
      },
    });
  });

  it("reuses an active object after its local schema advances", async function reusesActiveObject() {
    const fixture = await registryFixture();
    const reserved = await reserveActor(fixture.reservation);

    if (!reserved.ok) {
      throw new Error("registry schema advancement fixture failed");
    }

    const active = await activateActorRegistryEntry({
      db: fixture.db,
      admission: await requireActorRegistryAdmission(
        fixture.db,
        reserved.value.registryId,
      ),
      registryId: reserved.value.registryId,
      activationToken: reserved.value.activationToken,
      stateVersion: 1,
      now: 110,
    });
    const resolved = await reserveActor({
      ...fixture.reservation,
      schemaVersion: fixture.reservation.schemaVersion + 1,
      now: 120,
    });

    expect(active.ok).toBe(true);
    expect(resolved).toEqual(active);
  });

  it("reads only an existing active Actor at the exact schema", async function readsExactActive() {
    const fixture = await registryFixture();
    const missing = await readExactActiveActorRegistryEntry({
      db: fixture.db,
      identity: fixture.reservation.identity,
      placement: fixture.reservation.admission.placement,
      schemaVersion: fixture.reservation.schemaVersion,
    });
    expect(missing).toEqual({
      ok: false,
      error: { code: "registry_entry_missing" },
    });
    expect(registryEntryCount(fixture.database)).toBe(0);

    const reserved = await reserveActor(fixture.reservation);
    if (!reserved.ok) throw new Error("registry exact-read fixture failed");
    await expect(
      readExactActiveActorRegistryEntry({
        db: fixture.db,
        identity: fixture.reservation.identity,
        placement: fixture.reservation.admission.placement,
        schemaVersion: fixture.reservation.schemaVersion,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "registry_entry_not_active" },
    });

    const activated = await activateActorRegistryEntry({
      db: fixture.db,
      admission: await requireActorRegistryAdmission(
        fixture.db,
        reserved.value.registryId,
      ),
      registryId: reserved.value.registryId,
      activationToken: reserved.value.activationToken,
      stateVersion: 1,
      now: 110,
    });
    const exact = await readExactActiveActorRegistryEntry({
      db: fixture.db,
      identity: fixture.reservation.identity,
      placement: fixture.reservation.admission.placement,
      schemaVersion: fixture.reservation.schemaVersion,
    });
    const wrongSchema = await readExactActiveActorRegistryEntry({
      db: fixture.db,
      identity: fixture.reservation.identity,
      placement: fixture.reservation.admission.placement,
      schemaVersion: fixture.reservation.schemaVersion + 1,
    });

    expect(exact).toEqual(activated);
    expect(wrongSchema).toEqual({
      ok: false,
      error: {
        code: "registry_schema_mismatch",
        expected: fixture.reservation.schemaVersion + 1,
        received: fixture.reservation.schemaVersion,
      },
    });
    expect(registryEntryCount(fixture.database)).toBe(1);
  });

  it("advances one active schema generation under its fence", async function advancesSchema() {
    const fixture = await registryFixture();
    const reserved = await reserveActor({
      ...fixture.reservation,
      schemaVersion: 22,
    });
    if (!reserved.ok) throw new Error("registry schema fixture failed");
    const active = await activateActorRegistryEntry({
      db: fixture.db,
      admission: await requireActorRegistryAdmission(
        fixture.db,
        reserved.value.registryId,
      ),
      registryId: reserved.value.registryId,
      activationToken: reserved.value.activationToken,
      stateVersion: 1,
      now: 110,
    });
    if (!active.ok || active.value.lifecycleStatus !== "active") {
      throw new Error("registry schema activation failed");
    }

    const request = {
      db: fixture.db,
      registryId: active.value.registryId,
      expectedFenceToken: active.value.fenceToken,
      sourceSchemaVersion: 22,
      targetSchemaVersion: 23,
      expectedStateVersion: 1,
    } as const;
    const advanced = await advanceActiveActorRegistrySchema(request);
    const retry = await advanceActiveActorRegistrySchema(request);

    expect(advanced).toMatchObject({
      ok: true,
      value: { lifecycleStatus: "active", schemaVersion: 23, stateVersion: 2 },
    });
    expect(retry).toEqual(advanced);
  });

  it("reserves canonical schema for a fresh embedded harness session", async function reservesEmbeddedSession() {
    const fixture = await registryFixture();
    const sessionId = parseSessionId("session_registry_embedded");
    if (!sessionId.ok) throw new Error(sessionId.error.code);
    const identity: ActorIdentity = {
      objectKind: "session",
      organisationId: fixture.reservation.identity.organisationId,
      logicalObjectId: sessionId.value,
    };
    const plan = new FakeActivationPlan();
    plan.activate(
      actorPhysicalName(identity, fixture.reservation.admission.placement),
    );
    const namespace = new FakeActorNamespace(plan);

    const resolved = await resolveActiveSessionActor({
      env: {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      namespace: namespace as unknown as DurableObjectNamespace<SessionDO>,
      organisationId: fixture.reservation.identity.organisationId,
      sessionId: sessionId.value,
      now: 120,
    });

    expect(resolved.ok).toBe(true);
    expect(plan.requests).toHaveLength(1);
    await expect(
      readExactActiveActorRegistryEntry({
        db: fixture.db,
        identity,
        placement: fixture.reservation.admission.placement,
        schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        lifecycleStatus: "active",
        schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
      },
    });
  });

  it("activates a Case and Session together before publishing their registry state", async function activatesCaseSessionPair() {
    const fixture = await registryFixture();
    const caseId = parseCaseId("case_registry_pair");
    const sessionId = parseSessionId("session_registry_pair");
    if (!caseId.ok || !sessionId.ok)
      throw new Error("registry pair fixture failed");
    const caseIdentity: ActorIdentity = {
      objectKind: "case",
      organisationId: fixture.reservation.identity.organisationId,
      logicalObjectId: caseId.value,
    };
    const sessionIdentity: ActorIdentity = {
      objectKind: "session",
      organisationId: fixture.reservation.identity.organisationId,
      logicalObjectId: sessionId.value,
    };
    const plan = new FakeActivationPlan();
    plan.activate(
      actorPhysicalName(caseIdentity, fixture.reservation.admission.placement),
    );
    plan.activate(
      actorPhysicalName(
        sessionIdentity,
        fixture.reservation.admission.placement,
      ),
    );
    const namespace = new FakeActorNamespace(plan);

    const resolved = await resolveActiveCaseSessionActorsAtPlacement({
      env: {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      caseNamespace: namespace as unknown as DurableObjectNamespace<CaseDO>,
      sessionNamespace:
        namespace as unknown as DurableObjectNamespace<SessionDO>,
      organisationId: fixture.reservation.identity.organisationId,
      caseId: caseId.value,
      sessionId: sessionId.value,
      placement: fixture.reservation.admission.placement,
      now: 120,
    });

    expect(resolved.ok).toBe(true);
    expect(plan.requests).toHaveLength(2);
    if (!resolved.ok) throw new Error(resolved.error.code);
    await expect(
      publishActorRegistryActivation({
        env: {
          DB: fixture.db,
          PANTRY_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        publication: resolved.value.registryActivation,
      }),
    ).resolves.toEqual({ ok: true, value: null });
    await expect(
      readExactActiveActorRegistryEntry({
        db: fixture.db,
        identity: caseIdentity,
        placement: fixture.reservation.admission.placement,
        schemaVersion: CASE_ACTOR_SCHEMA_VERSION,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { lifecycleStatus: "active" },
    });
    await expect(
      readExactActiveActorRegistryEntry({
        db: fixture.db,
        identity: sessionIdentity,
        placement: fixture.reservation.admission.placement,
        schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { lifecycleStatus: "active" },
    });
    const retry = await resolveActiveCaseSessionActorsAtPlacement({
      env: {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      caseNamespace: namespace as unknown as DurableObjectNamespace<CaseDO>,
      sessionNamespace:
        namespace as unknown as DurableObjectNamespace<SessionDO>,
      organisationId: fixture.reservation.identity.organisationId,
      caseId: caseId.value,
      sessionId: sessionId.value,
      placement: fixture.reservation.admission.placement,
      now: 121,
    });
    expect(retry.ok).toBe(true);
    expect(plan.requests).toHaveLength(2);
  });

  it("fences export before retiring the active epoch", async function retiresExportedEpoch() {
    const fixture = await registryFixture();
    const reserved = await reserveActor(fixture.reservation);

    if (!reserved.ok || reserved.value.lifecycleStatus !== "reserved") {
      throw new Error("registry retirement fixture failed");
    }

    const active = await activateActorRegistryEntry({
      db: fixture.db,
      admission: await requireActorRegistryAdmission(
        fixture.db,
        reserved.value.registryId,
      ),
      registryId: reserved.value.registryId,
      activationToken: reserved.value.activationToken,
      stateVersion: 1,
      now: 110,
    });

    if (!active.ok || active.value.lifecycleStatus !== "active") {
      throw new Error("registry retirement activation failed");
    }

    const exporting = await beginActorExport({
      db: fixture.db,
      registryId: active.value.registryId,
      expectedFenceToken: active.value.fenceToken,
      now: 120,
    });
    const retired = await retireActorRegistryEntry({
      db: fixture.db,
      registryId: active.value.registryId,
      expectedFenceToken: active.value.fenceToken,
      now: 130,
    });

    expect(exporting).toMatchObject({
      ok: true,
      value: { lifecycleStatus: "exporting", exportingAt: 120 },
    });
    expect(retired).toMatchObject({
      ok: true,
      value: { lifecycleStatus: "retired", retiredAt: 130 },
    });
  });

  it("quarantines an incomplete target and preserves its lifecycle evidence", async function quarantinesTarget() {
    const fixture = await registryFixture();
    const reserved = await reserveActor(fixture.reservation);

    if (!reserved.ok || reserved.value.lifecycleStatus !== "reserved") {
      throw new Error("registry quarantine fixture failed");
    }

    const quarantined = await quarantineActorRegistryEntry({
      db: fixture.db,
      registryId: reserved.value.registryId,
      expectedFenceToken: reserved.value.fenceToken,
      reason: "import_checksum_mismatch",
      now: 115,
    });

    expect(quarantined).toMatchObject({
      ok: true,
      value: {
        lifecycleStatus: "quarantined",
        activatedAt: null,
        exportingAt: null,
        quarantinedAt: 115,
        quarantineReason: "import_checksum_mismatch",
      },
    });
  });

  it("adopts initial objects in place and qualifies relocation targets", function namesPlacementEpochs() {
    const identities = registryIdentities();
    const initial = placementForEpoch(1);
    const relocated = placementForEpoch(2);

    expect(physicalNames(identities, initial)).toEqual([
      "organisation_registry_names",
      "organisation_registry_names:session_registry_names",
    ]);
    expect(physicalNames(identities, relocated)).toEqual([
      "organisation_registry_names:p2",
      "organisation_registry_names:session_registry_names:p2",
    ]);
  });

  it("discovers every placement epoch for organisation offboarding", async function discoversAllEpochs() {
    const fixture = await registryFixture();
    const first = await reserveActor(fixture.reservation);
    const secondPlacement = placementForEpoch(2);
    fixture.database
      .prepare(
        "UPDATE organisation_placement SET status = 'retired', frozen_at = 150, retired_at = 200 WHERE placement_epoch = 1",
      )
      .run();

    fixture.database
      .prepare(
        `INSERT INTO organisation_placement (
         organisation_id,
         placement_epoch,
         placement_kind,
         placement_cell_id,
         location_hint,
         residency_jurisdiction,
         status,
         fence_token,
         created_at,
         activated_at
       )
       VALUES (?, 2, 'affinity', 'multi-region-preview', 'wnam', NULL,
               'active', ?, 2, 2)`,
      )
      .run(
        fixture.reservation.identity.organisationId,
        "placement-fence-epoch-two",
      );

    const second = await reserveActor({
      ...fixture.reservation,
      admission: await requireActorExecutionAdmission(
        fixture.db,
        fixture.reservation.identity.organisationId,
        secondPlacement,
      ),
      now: 200,
    });
    const inventory = await listOrganisationActorRegistryEntries({
      db: fixture.db,
      organisationId: fixture.reservation.identity.organisationId,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(inventory).toMatchObject({
      ok: true,
      value: [
        { placement: { placementEpoch: 1 } },
        { placement: { placementEpoch: 2 } },
      ],
    });
  });

  it("returns only the most recently activated Cases for operational reads", async function readsRecentCases() {
    const fixture = await registryFixture();
    const olderCaseId = parseCaseId("case_registry_recent_older");
    const newerCaseId = parseCaseId("case_registry_recent_newer");
    const newestCaseId = parseCaseId("case_registry_recent_newest");
    if (!olderCaseId.ok || !newerCaseId.ok || !newestCaseId.ok) {
      throw new Error("recent Case registry fixture failed");
    }
    const identities: readonly ActorIdentity[] = [
      {
        objectKind: "case",
        organisationId: fixture.reservation.identity.organisationId,
        logicalObjectId: olderCaseId.value,
      },
      {
        objectKind: "case",
        organisationId: fixture.reservation.identity.organisationId,
        logicalObjectId: newerCaseId.value,
      },
      {
        objectKind: "case",
        organisationId: fixture.reservation.identity.organisationId,
        logicalObjectId: newestCaseId.value,
      },
    ];
    for (let index = 0; index < identities.length; index += 1) {
      const reserved = await reserveRegistryIdentity(
        fixture,
        identities[index]!,
        100 + index,
      );
      if (reserved.lifecycleStatus !== "reserved")
        throw new Error("recent Case reservation failed");
      const activated = await activateActorRegistryEntry({
        db: fixture.db,
        admission: await requireActorRegistryAdmission(
          fixture.db,
          reserved.registryId,
        ),
        registryId: reserved.registryId,
        activationToken: reserved.activationToken,
        stateVersion: 1,
        now: 200 + index,
      });
      if (!activated.ok) throw new Error("recent Case activation failed");
    }

    const recent = await listRecentActiveCaseRegistryEntries({
      db: fixture.db,
      organisationId: fixture.reservation.identity.organisationId,
      limit: 2,
    });

    expect(recent).toMatchObject({
      ok: true,
      value: [
        { identity: { logicalObjectId: newestCaseId.value }, activatedAt: 202 },
        { identity: { logicalObjectId: newerCaseId.value }, activatedAt: 201 },
      ],
    });
  });

  it("repairs stale reservations and quarantines proven activation conflicts", async function reconcilesOrphans() {
    const fixture = await registryFixture();
    const identities = reconciliationIdentities(
      fixture.reservation.identity.organisationId,
    );
    const organisation = await reserveRegistryIdentity(
      fixture,
      identities.organisation,
      100,
    );
    const caseActor = await reserveRegistryIdentity(
      fixture,
      identities.caseActor,
      110,
    );
    const session = await reserveRegistryIdentity(
      fixture,
      identities.session,
      950,
    );
    const connector = await reserveRegistryIdentity(
      fixture,
      identities.connector,
      120,
    );

    if (
      organisation.lifecycleStatus !== "reserved" ||
      caseActor.lifecycleStatus !== "reserved" ||
      session.lifecycleStatus !== "reserved" ||
      connector.lifecycleStatus !== "reserved"
    ) {
      throw new Error("registry reconciliation reservation invariant failed");
    }

    const activeConnector = await activateActorRegistryEntry({
      db: fixture.db,
      admission: await requireActorRegistryAdmission(
        fixture.db,
        connector.registryId,
      ),
      registryId: connector.registryId,
      activationToken: connector.activationToken,
      stateVersion: 1,
      now: 130,
    });

    if (!activeConnector.ok) {
      throw new Error("registry reconciliation activation invariant failed");
    }

    const activationPlan = new FakeActivationPlan();
    activationPlan.activate(organisation.physicalObjectName);
    activationPlan.conflict(caseActor.physicalObjectName);
    const report = await reconcileOrganisationActorRegistry({
      db: fixture.db,
      namespaces: fakeActorNamespaces(activationPlan),
      organisationId: fixture.reservation.identity.organisationId,
      now: 1_000,
      staleReservationAgeMs: 100,
    });

    expect(report.ok).toBe(true);
    if (!report.ok)
      throw new Error(`registry reconciliation failed: ${report.error.code}`);

    expect(report.value.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "activated",
          registryId: organisation.registryId,
          stateVersion: 1,
        }),
        expect.objectContaining({
          kind: "quarantined",
          registryId: caseActor.registryId,
          reason: "activation_conflict_during_orphan_repair",
        }),
        expect.objectContaining({
          kind: "skipped",
          registryId: session.registryId,
          lifecycleStatus: "reserved",
          reason: "reservation_fresh",
        }),
        expect.objectContaining({
          kind: "skipped",
          registryId: connector.registryId,
          lifecycleStatus: "active",
          reason: "terminal_or_active",
        }),
      ]),
    );
    expect(report.value.inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          registryId: organisation.registryId,
          lifecycleStatus: "active",
        }),
        expect.objectContaining({
          registryId: caseActor.registryId,
          lifecycleStatus: "quarantined",
          quarantineReason: "activation_conflict_during_orphan_repair",
        }),
        expect.objectContaining({
          registryId: session.registryId,
          lifecycleStatus: "reserved",
        }),
        expect.objectContaining({
          registryId: connector.registryId,
          lifecycleStatus: "active",
        }),
      ]),
    );
    expect(activationPlan.requests).toHaveLength(2);
    expect(activationPlan.requests).toEqual(
      expect.arrayContaining([
        actorActivationRequest(
          organisation,
          1_000,
          fixture.reservation.admission,
        ),
        actorActivationRequest(caseActor, 1_000, fixture.reservation.admission),
      ]),
    );
  });
});

type ReconciliationIdentities = {
  readonly organisation: ActorIdentity;
  readonly caseActor: ActorIdentity;
  readonly session: ActorIdentity;
  readonly connector: ActorIdentity;
};

function reconciliationIdentities(
  organisationId: OrganisationId,
): ReconciliationIdentities {
  const caseId = parseCaseId("case_registry_reconcile");
  const sessionId = parseSessionId("session_registry_reconcile");
  const connectorId = parseConnectorId("connector_registry_reconcile");

  if (!caseId.ok || !sessionId.ok || !connectorId.ok) {
    throw new Error("registry reconciliation identity invariant failed");
  }

  return {
    organisation: {
      objectKind: "organisation",
      organisationId,
      logicalObjectId: organisationId,
    },
    caseActor: {
      objectKind: "case",
      organisationId,
      logicalObjectId: caseId.value,
    },
    session: {
      objectKind: "session",
      organisationId,
      logicalObjectId: sessionId.value,
    },
    connector: {
      objectKind: "connector",
      organisationId,
      logicalObjectId: connectorId.value,
    },
  };
}

async function reserveRegistryIdentity(
  fixture: RegistryFixture,
  identity: ActorIdentity,
  now: number,
): Promise<ActorRegistryEntry> {
  const reserved = await reserveActor({
    ...fixture.reservation,
    identity,
    now,
  });

  if (!reserved.ok) {
    throw new Error(`registry reservation failed: ${reserved.error.code}`);
  }

  return reserved.value;
}

type FakeActivationMode = "activate" | "conflict";

class FakeActivationPlan {
  readonly requests: ActorActivationRequest[] = [];
  private readonly modes = new Map<string, FakeActivationMode>();

  activate(physicalObjectName: string): void {
    this.modes.set(physicalObjectName, "activate");
  }

  conflict(physicalObjectName: string): void {
    this.modes.set(physicalObjectName, "conflict");
  }

  async execute(
    physicalObjectName: string,
    request: ActorActivationRequest,
  ): Promise<ActorActivationResult> {
    this.requests.push(request);
    const mode = this.modes.get(physicalObjectName);

    if (mode === "activate") {
      return {
        ok: true,
        value: {
          kind: "activated",
          registryId: request.registryId,
          stateVersion: 1,
        },
      };
    }

    if (mode === "conflict") {
      return { ok: false, error: { code: "activation_conflict" } };
    }

    throw new Error(`missing activation plan for ${physicalObjectName}`);
  }
}

class FakeActorStub {
  constructor(
    private readonly physicalObjectName: string,
    private readonly plan: FakeActivationPlan,
  ) {}

  activate(request: ActorActivationRequest): Promise<ActorActivationResult> {
    return this.plan.execute(this.physicalObjectName, request);
  }
}

class FakeActorNamespace {
  constructor(private readonly plan: FakeActivationPlan) {}

  idFromName(name: string): DurableObjectId {
    return new FakeDurableObjectId(name) as unknown as DurableObjectId;
  }

  get(id: DurableObjectId): FakeActorStub {
    return new FakeActorStub(id.toString(), this.plan);
  }

  jurisdiction(): FakeActorNamespace {
    return this;
  }
}

class FakeDurableObjectId {
  constructor(private readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

function fakeActorNamespaces(plan: FakeActivationPlan): ActorNamespaces {
  const namespace = new FakeActorNamespace(plan);

  return {
    organisation: namespace as unknown as ActorNamespaces["organisation"],
    session: namespace as unknown as ActorNamespaces["session"],
    case: namespace as unknown as ActorNamespaces["case"],
    connector: namespace as unknown as ActorNamespaces["connector"],
  };
}

function physicalNames(
  identities: readonly ActorIdentity[],
  placement: ReturnType<typeof placementForEpoch>,
): readonly string[] {
  const names: string[] = [];

  for (const identity of identities) {
    names.push(actorPhysicalName(identity, placement));
  }

  return names;
}

function registryIdentities(): readonly ActorIdentity[] {
  const organisationId = parseOrganisationId("organisation_registry_names");
  const sessionId = parseSessionId("session_registry_names");

  if (!organisationId.ok || !sessionId.ok) {
    throw new Error("registry naming fixture invariant failed");
  }

  return [
    {
      objectKind: "organisation",
      organisationId: organisationId.value,
      logicalObjectId: organisationId.value,
    },
    {
      objectKind: "session",
      organisationId: organisationId.value,
      logicalObjectId: sessionId.value,
    },
  ];
}

function placementForEpoch(epoch: number) {
  const placement = parseOrganisationPlacement({
    kind: "affinity",
    placementEpoch: epoch,
    placementCellId: "multi-region-preview",
    locationHint: "wnam",
  });

  if (!placement.ok) {
    throw new Error("registry placement fixture invariant failed");
  }

  return placement.value;
}

type RegistryFixture = {
  readonly database: DatabaseSync;
  readonly db: SingleDatabase;
  readonly reservation: Parameters<typeof reserveActor>[0];
};

async function registryFixture(): Promise<RegistryFixture> {
  const database = new DatabaseSync(":memory:");
  database.exec(readMigration("0001_current_schema.sql"));

  const organisationId = parseOrganisationId("organisation_registry_test");
  const placement = parseOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "multi-region-preview",
    locationHint: "wnam",
  });

  if (!organisationId.ok || !placement.ok) {
    throw new Error("registry fixture identity invariant failed");
  }

  database
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Registry Test', 'beta', 1, 'active')`,
    )
    .run(organisationId.value);
  database
    .prepare(
      `INSERT INTO organisation_placement (
       organisation_id,
       placement_epoch,
       placement_kind,
       placement_cell_id,
       location_hint,
       residency_jurisdiction,
       status,
       fence_token,
       created_at,
       activated_at
     )
     VALUES (?, 1, 'affinity', 'multi-region-preview', 'wnam', NULL, 'active', ?, 1, 1)`,
    )
    .run(organisationId.value, "placement-fence-test");

  const identity: ActorIdentity = {
    objectKind: "organisation",
    organisationId: organisationId.value,
    logicalObjectId: organisationId.value,
  };
  const db = d1Database(database);

  return {
    database,
    db,
    reservation: {
      db,
      identity,
      admission: await requireActorExecutionAdmission(
        db,
        organisationId.value,
        placement.value,
      ),
      schemaVersion: 1,
      now: 100,
    },
  };
}

function registryEntryCount(database: DatabaseSync): number {
  const value = database
    .prepare("SELECT COUNT(*) AS count FROM durable_object_registry")
    .get()?.count;
  if (typeof value !== "number")
    throw new Error("registry count fixture failed");
  return value;
}

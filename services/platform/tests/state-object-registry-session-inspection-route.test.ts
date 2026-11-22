import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
/// <reference types="@cloudflare/workers-types" />

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  activateActorRegistryEntry,
  quarantineActorRegistryEntry,
  reserveActor,
  type ActorActivationRequest,
  type ActorFenceToken,
  type ActorIdentity,
  type ActorRegistryId,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import type { ActorActivationInspection } from "@purin-labs/actor-runtime/actors/actor-activation";
import { CANONICAL_SESSION_SCHEMA_VERSION } from "@purin-labs/actor-runtime/actors/actor-schema-versions";
import {
  CASE_ACTOR_SCHEMA_VERSION,
  CONNECTOR_ACTOR_SCHEMA_VERSION,
} from "@purin-labs/actor-runtime/actors/actor-schema-versions";
import gateway from "../src/integration-gateway";
import {
  type CaseId,
  type ConnectorId,
  type SessionId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  parseOrganisationPlacement,
  type OrganisationPlacement,
} from "@purin-labs/tenancy/placement";
import type { SessionDO } from "../src/actors/agent-session";
import type { CaseDO } from "../src/actors/case";
import type { ConnectorDO } from "../src/actors/connector";

import {
  requireCaseId,
  requireConnectorId,
  requireSessionId,
  requireOrganisationId,
} from "./test-ids";
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

const ADMIN_TOKEN = "state-registry-session-inspection-admin";

describe("state object registry session inspection route", function registryRouteSuite() {
  it(
    "refuses an unauthenticated read and inspects active sessions for the admin",
    inspectsActiveSession,
  );
  it(
    "inspects one exact active session without an organisation-wide session scan",
    inspectsScopedActiveSession,
  );
  it(
    "rejects invalid or conflicting session inspection selectors",
    rejectsInvalidSessionInspectionSelector,
  );
  it(
    "exposes sanitized Case delivery settlement evidence",
    inspectsCaseSettlement,
  );
  it(
    "reports quarantined Case activation evidence without mutation",
    inspectsQuarantinedCaseActivation,
  );
  it(
    "discards only the exact authorized quarantined Case",
    discardsQuarantinedCase,
  );
  it(
    "interrupts one exact active session through the authenticated admin boundary",
    interruptsActiveSession,
  );
  it(
    "schedules recovery for one exact active Connector",
    recoversConnectorCaseWork,
  );
});

async function discardsQuarantinedCase(): Promise<void> {
  const fixture = await routeFixture({
    caseSchemaVersion: 1,
    activateCase: false,
  });
  const reason = "activation_conflict_during_orphan_repair";
  const quarantined = await quarantineActorRegistryEntry({
    db: fixture.env.DB,
    registryId: fixture.caseRegistryId,
    expectedFenceToken: fixture.caseFenceToken,
    reason,
    now: 20,
  });
  if (!quarantined.ok) throw new Error("case quarantine fixture failed");
  const requestBody = {
    command: "discard_quarantined_case",
    organisationId: fixture.organisationId,
    caseId: fixture.caseId,
    registryId: fixture.caseRegistryId,
    expectedQuarantinedAt: 20,
    expectedQuarantineReason: reason,
  };

  const stale = await gateway.fetch(
    new Request("https://pantry.test/v1/admin/state-object-registry", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...requestBody, expectedQuarantinedAt: 19 }),
    }),
    fixture.env,
    fakeExecutionContext(),
  );
  expect(stale.status).toBe(409);
  await expect(readCaseRegistryState(fixture)).resolves.toMatchObject({
    lifecycleStatus: "quarantined",
  });

  const response = await gateway.fetch(
    new Request("https://pantry.test/v1/admin/state-object-registry", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    }),
    fixture.env,
    fakeExecutionContext(),
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    report: {
      kind: "quarantined_case_discarded",
      identity: { objectKind: "case", logicalObjectId: fixture.caseId },
      registryId: fixture.caseRegistryId,
      actorState: "discarded",
    },
  });
  await expect(readCaseRegistryState(fixture)).resolves.toBeNull();
  expect(fixture.caseStub.discardCalls).toBe(1);
}

async function recoversConnectorCaseWork(): Promise<void> {
  const fixture = await routeFixture();
  const response = await gateway.fetch(
    new Request("https://pantry.test/v1/admin/state-object-registry", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "recover_connector_case_work",
        organisationId: fixture.organisationId,
        connectorId: fixture.connectorId,
      }),
    }),
    fixture.env,
    fakeExecutionContext(),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    result: { kind: "scheduled" },
  });
  expect(fixture.connectorStub.recoveryCalls).toBe(1);
}

async function interruptsActiveSession(): Promise<void> {
  const fixture = await routeFixture();
  const response = await gateway.fetch(
    new Request("https://pantry.test/v1/admin/state-object-registry", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "interrupt_session",
        organisationId: fixture.organisationId,
        sessionId: fixture.sessionId,
      }),
    }),
    fixture.env,
    fakeExecutionContext(),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    result: { kind: "interrupted", turnId: "turn_state_registry_inspection" },
  });
  expect(fixture.stub.interruptCalls).toBe(1);
}

async function inspectsCaseSettlement(): Promise<void> {
  const fixture = await routeFixture();
  const route = `https://pantry.test/v1/admin/state-object-registry?organisationId=${fixture.organisationId}&caseId=${fixture.caseId}`;
  const response = await gateway.fetch(
    new Request(route, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
    fixture.env,
    fakeExecutionContext(),
  );

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    ok: true,
    case: {
      outputs: [
        {
          kind: "settled",
          receipt: { nativeReceiptId: "slack.123", deliveredAt: 50 },
        },
      ],
    },
  });
  expect(JSON.stringify(body)).not.toContain("private output text");
}

async function inspectsQuarantinedCaseActivation(): Promise<void> {
  const activationInspection = {
    kind: "mismatch",
    reason: "identity",
    schemaVersion: 1,
    stateVersion: 1,
    mismatchedFields: ["activationToken"],
  } satisfies ActorActivationInspection;
  const fixture = await routeFixture({
    caseSchemaVersion: 1,
    activateCase: false,
  });
  const quarantined = await quarantineActorRegistryEntry({
    db: fixture.env.DB,
    registryId: fixture.caseRegistryId,
    expectedFenceToken: fixture.caseFenceToken,
    reason: "activation_conflict_during_orphan_repair",
    now: 20,
  });
  if (!quarantined.ok) throw new Error("case quarantine fixture failed");

  fixture.caseStub.activationInspection = activationInspection;
  const before = await readCaseRegistryState(fixture);
  const response = await gateway.fetch(
    new Request(
      `https://pantry.test/v1/admin/state-object-registry?organisationId=${fixture.organisationId}&caseId=${fixture.caseId}`,
      { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    ),
    fixture.env,
    fakeExecutionContext(),
  );

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    caseActivation: { activationVerification: activationInspection },
  });
  expect(JSON.stringify(body)).not.toContain(fixture.caseActivationToken);
  expect(JSON.stringify(body)).not.toContain(fixture.caseFenceToken);
  await expect(readCaseRegistryState(fixture)).resolves.toEqual(before);
}

async function inspectsActiveSession(): Promise<void> {
  const fixture = await routeFixture();
  const route = `https://pantry.test/v1/admin/state-object-registry?organisationId=${fixture.organisationId}`;
  const unauthorized = await gateway.fetch(
    new Request(route),
    fixture.env,
    fakeExecutionContext(),
  );
  expect(unauthorized.status).toBe(404);
  expect(fixture.stub.inspectCalls).toBe(0);

  const response = await gateway.fetch(
    new Request(route, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
    fixture.env,
    fakeExecutionContext(),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    sessions: [{ kind: "inspected", lifecycleKind: "sleeping" }],
  });
  expect(fixture.stub.inspectCalls).toBe(1);
}

async function inspectsScopedActiveSession(): Promise<void> {
  const fixture = await routeFixture();
  const secondSessionId = requireSessionId("session_state_registry_other");
  const secondReserved = await reserveActor({
    db: fixture.env.DB,
    identity: {
      objectKind: "session",
      organisationId: fixture.organisationId,
      logicalObjectId: secondSessionId,
    },
    admission: await requireActorExecutionAdmission(
      fixture.env.DB,
      fixture.organisationId,
      placement(),
    ),
    schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
    now: 20,
  });
  if (!secondReserved.ok)
    throw new Error("second session actor reservation fixture failed");
  const secondActivated = await activateActorRegistryEntry({
    db: fixture.env.DB,
    admission: await requireActorRegistryAdmission(
      fixture.env.DB,
      secondReserved.value.registryId,
    ),
    registryId: secondReserved.value.registryId,
    activationToken: secondReserved.value.activationToken,
    stateVersion: 2,
    now: 21,
  });
  if (!secondActivated.ok)
    throw new Error("second session actor activation fixture failed");

  const route = `https://pantry.test/v1/admin/state-object-registry?organisationId=${fixture.organisationId}&sessionId=${fixture.sessionId}`;
  const response = await gateway.fetch(
    new Request(route, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
    fixture.env,
    fakeExecutionContext(),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(
    expect.objectContaining({
      sessions: [
        expect.objectContaining({
          identity: expect.objectContaining({
            logicalObjectId: fixture.sessionId,
          }),
        }),
      ],
    }),
  );
  expect(fixture.stub.inspectCalls).toBe(1);
}

async function rejectsInvalidSessionInspectionSelector(): Promise<void> {
  const fixture = await routeFixture();
  const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const malformed = await gateway.fetch(
    new Request(
      `https://pantry.test/v1/admin/state-object-registry?organisationId=${fixture.organisationId}&sessionId=!invalid`,
      { headers },
    ),
    fixture.env,
    fakeExecutionContext(),
  );
  expect(malformed.status).toBe(422);

  const conflicting = await gateway.fetch(
    new Request(
      `https://pantry.test/v1/admin/state-object-registry?organisationId=${fixture.organisationId}&caseId=${fixture.caseId}&sessionId=${fixture.sessionId}`,
      { headers },
    ),
    fixture.env,
    fakeExecutionContext(),
  );
  expect(conflicting.status).toBe(422);

  const absent = await gateway.fetch(
    new Request(
      `https://pantry.test/v1/admin/state-object-registry?organisationId=${fixture.organisationId}&sessionId=session_missing`,
      { headers },
    ),
    fixture.env,
    fakeExecutionContext(),
  );
  expect(absent.status).toBe(404);
  expect(fixture.stub.inspectCalls).toBe(0);
}

type RouteFixture = {
  readonly organisationId: OrganisationId;
  readonly sessionId: SessionId;
  readonly caseId: CaseId;
  readonly connectorId: ConnectorId;
  readonly caseRegistryId: ActorRegistryId;
  readonly caseFenceToken: ActorFenceToken;
  readonly caseActivationToken: string;
  readonly stub: FakeSessionActorStub;
  readonly caseStub: FakeCaseActorStub;
  readonly connectorStub: FakeConnectorActorStub;
  readonly env: UnitTestEnv;
};

async function routeFixture(
  input: {
    readonly caseSchemaVersion?: number;
    readonly activateCase?: boolean;
  } = {},
): Promise<RouteFixture> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readMigration("0001_current_schema.sql"));
  const organisationId = requireOrganisationId(
    "organisation_state_registry_inspection",
  );
  const sessionId = requireSessionId("session_state_registry_inspection");
  const caseId = requireCaseId("case_registry_inspection");
  const connectorId = requireConnectorId("connector_registry_inspection");
  const actorPlacement = placement();
  const db = d1Database(sqlite);
  const identity = {
    objectKind: "session",
    organisationId,
    logicalObjectId: sessionId,
  } satisfies ActorIdentity;

  sqlite
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'State Registry Inspection', 'beta', 1, 'active')`,
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
    schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
    now: 10,
  });
  if (!reserved.ok) throw new Error("session actor reservation fixture failed");
  const activated = await activateActorRegistryEntry({
    db,
    admission: await requireActorRegistryAdmission(
      db,
      reserved.value.registryId,
    ),
    registryId: reserved.value.registryId,
    activationToken: reserved.value.activationToken,
    stateVersion: 2,
    now: 11,
  });
  if (!activated.ok) throw new Error("session actor activation fixture failed");
  const caseReserved = await reserveActor({
    db,
    identity: { objectKind: "case", organisationId, logicalObjectId: caseId },
    admission: await requireActorExecutionAdmission(
      db,
      organisationId,
      actorPlacement,
    ),
    schemaVersion: input.caseSchemaVersion ?? CASE_ACTOR_SCHEMA_VERSION,
    now: 12,
  });
  if (!caseReserved.ok)
    throw new Error("case actor reservation fixture failed");
  if (input.activateCase !== false) {
    const caseActivated = await activateActorRegistryEntry({
      db,
      admission: await requireActorRegistryAdmission(
        db,
        caseReserved.value.registryId,
      ),
      registryId: caseReserved.value.registryId,
      activationToken: caseReserved.value.activationToken,
      stateVersion: 1,
      now: 13,
    });
    if (!caseActivated.ok)
      throw new Error("case actor activation fixture failed");
  }
  const connectorReserved = await reserveActor({
    db,
    identity: {
      objectKind: "connector",
      organisationId,
      logicalObjectId: connectorId,
    },
    admission: await requireActorExecutionAdmission(
      db,
      organisationId,
      actorPlacement,
    ),
    schemaVersion: CONNECTOR_ACTOR_SCHEMA_VERSION,
    now: 14,
  });
  if (!connectorReserved.ok)
    throw new Error("connector actor reservation fixture failed");
  const connectorActivated = await activateActorRegistryEntry({
    db,
    admission: await requireActorRegistryAdmission(
      db,
      connectorReserved.value.registryId,
    ),
    registryId: connectorReserved.value.registryId,
    activationToken: connectorReserved.value.activationToken,
    stateVersion: 1,
    now: 15,
  });
  if (!connectorActivated.ok)
    throw new Error("connector actor activation fixture failed");
  const stub = new FakeSessionActorStub(organisationId, sessionId);
  const namespace = new FakeSessionActorNamespace(stub);
  const caseStub = new FakeCaseActorStub(organisationId, caseId);
  const caseNamespace = new FakeCaseActorNamespace(caseStub);
  const connectorStub = new FakeConnectorActorStub(organisationId, connectorId);
  const connectorNamespace = new FakeConnectorActorNamespace(connectorStub);
  return {
    organisationId,
    sessionId,
    caseId,
    connectorId,
    caseRegistryId: caseReserved.value.registryId,
    caseFenceToken: caseReserved.value.fenceToken,
    caseActivationToken: caseReserved.value.activationToken,
    stub,
    caseStub,
    connectorStub,
    env: platformEnv({
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
      SESSION: namespace as unknown as DurableObjectNamespace<SessionDO>,
      CASE: caseNamespace as unknown as DurableObjectNamespace<CaseDO>,
      CONNECTOR:
        connectorNamespace as unknown as DurableObjectNamespace<ConnectorDO>,
      ORGANISATION_ADMIN_TOKEN: ADMIN_TOKEN,
    }),
  };
}

class FakeConnectorActorNamespace {
  constructor(private readonly stub: FakeConnectorActorStub) {}

  idFromName(name: string): DurableObjectId {
    return new FakeDurableObjectId(name) as unknown as DurableObjectId;
  }

  get(): FakeConnectorActorStub {
    return this.stub;
  }

  jurisdiction(): FakeConnectorActorNamespace {
    return this;
  }
}

class FakeConnectorActorStub {
  recoveryCalls = 0;

  constructor(
    private readonly organisationId: OrganisationId,
    private readonly connectorId: ConnectorId,
  ) {}

  recoverCaseWork(input: {
    readonly identity: {
      readonly organisationId: OrganisationId;
      readonly connectorId: ConnectorId;
    };
  }): Promise<unknown> {
    this.recoveryCalls += 1;
    expect(input.identity).toEqual({
      organisationId: this.organisationId,
      connectorId: this.connectorId,
    });
    return Promise.resolve({ ok: true, value: { kind: "scheduled" } });
  }
}

class FakeSessionActorNamespace {
  constructor(private readonly stub: FakeSessionActorStub) {}

  idFromName(name: string): DurableObjectId {
    return new FakeDurableObjectId(name) as unknown as DurableObjectId;
  }

  get(): FakeSessionActorStub {
    return this.stub;
  }

  jurisdiction(): FakeSessionActorNamespace {
    return this;
  }
}

class FakeSessionActorStub {
  inspectCalls = 0;
  interruptCalls = 0;

  constructor(
    private readonly organisationId: OrganisationId,
    private readonly sessionId: SessionId,
  ) {}

  inspectCanonicalSessionState(): Promise<unknown> {
    this.inspectCalls += 1;
    return Promise.resolve({
      ok: true,
      value: {
        identity: {
          organisationId: this.organisationId,
          sessionId: this.sessionId,
        },
        lifecycleKind: "sleeping",
        quiescence: { kind: "ready", blockers: [] },
        checkpoint: {
          kind: "current",
          classification: "compatible",
          runtimeGeneration: 3,
          sha256: "a".repeat(64),
          budgetAccountDigest: "b".repeat(64),
        },
        budget: {
          kind: "open",
          usage: { tokens: 12, activeWallMs: 40, capabilityCalls: 1 },
          usageCursor: 7,
        },
        reservation: {
          kind: "active",
          reservationId: "reservation_test",
          runId: "run_test",
          turnId: "turn_test",
          deadlineAt: 500,
        },
        preparation: { kind: "none" },
        latestMessageLinkReceipt: { kind: "none" },
      },
    });
  }

  interruptCanonicalEmbeddedHarnessTurn(input: {
    readonly organisationId: OrganisationId;
    readonly sessionId: SessionId;
  }): Promise<unknown> {
    this.interruptCalls += 1;
    expect(input.organisationId).toBe(this.organisationId);
    expect(input.sessionId).toBe(this.sessionId);
    return Promise.resolve({
      ok: true,
      value: { kind: "interrupted", turnId: "turn_state_registry_inspection" },
    });
  }
}

class FakeCaseActorNamespace {
  constructor(private readonly stub: FakeCaseActorStub) {}

  idFromName(name: string): DurableObjectId {
    return new FakeDurableObjectId(name) as unknown as DurableObjectId;
  }

  get(): FakeCaseActorStub {
    return this.stub;
  }

  jurisdiction(): FakeCaseActorNamespace {
    return this;
  }
}

class FakeCaseActorStub {
  discardCalls = 0;
  activationInspection: ActorActivationInspection = {
    kind: "match",
    schemaVersion: CASE_ACTOR_SCHEMA_VERSION,
    stateVersion: 1,
  };

  constructor(
    private readonly organisationId: OrganisationId,
    private readonly caseId: CaseId,
  ) {}

  inspectActivation(
    input: ActorActivationRequest,
  ): Promise<ActorActivationInspection> {
    expect(input.identity).toEqual({
      objectKind: "case",
      organisationId: this.organisationId,
      logicalObjectId: this.caseId,
    });
    return Promise.resolve(this.activationInspection);
  }

  discardQuarantinedState(input: ActorActivationRequest): Promise<unknown> {
    this.discardCalls += 1;
    expect(input.identity).toEqual({
      objectKind: "case",
      organisationId: this.organisationId,
      logicalObjectId: this.caseId,
    });
    return Promise.resolve({
      ok: true,
      value: {
        kind: "discarded",
        stateVersion: 1,
        reachableAttachmentCount: 0,
      },
    });
  }

  inspect(): Promise<unknown> {
    return Promise.resolve({
      ok: true,
      value: {
        identity: { organisationId: this.organisationId, caseId: this.caseId },
        purpose: "private output text",
        workspaceRevision: "workspace_private",
        revision: 4,
        lifecycle: { kind: "open", openedAt: 1 },
        journalCursor: { kind: "before_first" },
        bindings: [],
        assignmentLifecycles: [
          {
            kind: "running",
            assignment: {
              assignmentId: "assignment_case_inspection",
              caseId: this.caseId,
              caseRevision: 1,
              sessionId: "session_case_inspection",
            },
            start: {
              startId: "start_case_inspection",
              sessionId: "session_case_inspection",
              acceptedAt: 10,
            },
          },
        ],
        acceptedProposalIds: ["proposal_case_inspection"],
        entries: [
          {
            kind: "inline_preview",
            entryId: "entry_private",
            digest: "a".repeat(64),
            preview: "private output text",
          },
        ],
        outputs: [
          {
            kind: "settled",
            output: {
              outputId: "output_case_inspection",
              source: {
                kind: "agent_turn",
                proposalId: "proposal_case_inspection",
                assignmentId: "assignment_case_inspection",
                sessionId: "session_case_inspection",
                turnId: "turn_case_inspection",
              },
              entryId: "entry_private",
              connectorId: "connector_case_inspection",
              delivery: {
                deliveryId: "delivery_case_inspection",
                bindingId: "binding_case_inspection",
                address: {
                  kind: "slack",
                  workspaceId: "T1",
                  channelId: "C1",
                  threadTs: "1.0",
                },
                caseId: this.caseId,
                caseRevision: 4,
                idempotencyKey: "idempotency_case_inspection",
                addressedAt: 40,
              },
            },
            receipt: {
              deliveryId: "delivery_case_inspection",
              connectorId: "connector_case_inspection",
              idempotencyKey: "idempotency_case_inspection",
              nativeReceiptId: "slack.123",
              deliveredAt: 50,
            },
          },
        ],
      },
    });
  }
}

async function readCaseRegistryState(
  fixture: RouteFixture,
): Promise<Record<string, unknown> | null> {
  return fixture.env.DB.prepare(
    `SELECT lifecycle_status AS lifecycleStatus,
            schema_version AS schemaVersion,
            state_version AS stateVersion,
            retired_at AS retiredAt,
            quarantined_at AS quarantinedAt,
            quarantine_reason AS quarantineReason
     FROM durable_object_registry
     WHERE registry_id = ?`,
  )
    .bind(fixture.caseRegistryId)
    .first<Record<string, unknown>>();
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

function fakeExecutionContext(): ExecutionContext {
  return testExecutionContext({ waitUntil: vi.fn() });
}

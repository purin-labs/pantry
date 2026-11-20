import { env, exports } from "cloudflare:workers";
import {
  organisationDatabase,
  fixtureDatabase,
  publishGlobalOrganisation,
} from "./organisation-database";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";

import { CONTEXT_CASE_READ_CAPABILITY } from "../../src/authorization/access-grants/turn-authority";
import { SessionDO } from "../../src/actors/agent-session";
import type { SessionCheckpointInspection } from "../../src/actors/session/types";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import type { CaseDO } from "../../src/actors/case";
import type { ConnectorDO } from "../../src/actors/connector";
import type { OrganisationDO } from "../../src/actors/organisation";
import {
  resumeActorRelocation,
  startActorRelocation,
} from "../../src/actors/actor-relocation";
import { parseOrganisationPlacementMoveTarget } from "../../src/data/organisation-placement";
import { freezePlacement, type PlacementRace } from "./placement-race-support";
import { storeVaultSecret } from "../../src/credential-vault";
import { createAccessGrant } from "../../src/data/access-grants";
import { createOrganisationInstall } from "../../src/data/organisation";
import { type SessionId } from "../../src/ids";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { network } from "./network";
import {
  attachSlackActorToAccountAuthority,
  isStringRecord,
  requiredPlacement,
  signedSlackRequest,
  slackPostFields,
} from "./slack-journey-support";
import { isRecord, parseJsonOrNull } from "@purin-labs/std";
import {
  requireSessionId,
  requireOrganisationId,
  requireVaultHandle,
  requireWorkspaceId,
} from "../test-ids";
import { PLATFORM_DEFAULT_PI_MODEL } from "../../src/actors/pi-model-transport";

const ORGANISATION_ID = requireOrganisationId(
  "organisation_e2e_actor_recovery",
);
const WORKSPACE_ID = requireWorkspaceId("T0E2ERECOVER");
const CHANNEL_ID = "C0E2ERECOVER";
const USER_ID = "U0E2ERECOVER";
const ROOT_TS = "1787500100.000001";
const MODEL_TEXT = "Recovery completed once.";

type HttpResolverInfo = Parameters<HttpResponseResolver>[0];

type ModelSimulator = {
  readonly handler: ReturnType<typeof http.post>;
  readonly requests: Record<string, unknown>[];
};

type SlackSimulator = {
  readonly handler: ReturnType<typeof http.post>;
  readonly statusBodies: Record<string, string>[];
  readonly deliveryAttempts: Record<string, string>[];
  readonly visibleMessages: Record<string, string>[];
};

type ActorRegistryRow = {
  readonly objectKind: string;
  readonly logicalObjectId: string;
  readonly physicalObjectName: string;
};

type ActorReference = {
  readonly logicalObjectId: string;
  readonly physicalObjectName: string;
};

type RecoveryActorReferences = {
  readonly connector: ActorReference;
  readonly case: ActorReference;
  readonly session: ActorReference;
};

type RecoveryActorStubs = {
  readonly connector: DurableObjectStub<ConnectorDO>;
  readonly case: DurableObjectStub<CaseDO>;
  readonly session: DurableObjectStub<SessionDO>;
  readonly sessionId: SessionId;
};

type AlarmActor = OrganisationDO | ConnectorDO | CaseDO | SessionDO;

async function armRecoveryAlarm(
  _instance: unknown,
  ctx: DurableObjectState,
): Promise<void> {
  await ctx.storage.setAlarm(Date.now() + 1_000);
}

function readRecoveryAlarm(
  _instance: unknown,
  ctx: DurableObjectState,
): Promise<number | null> {
  return ctx.storage.getAlarm();
}

type ConnectorStorageState = {
  readonly caseWorkState: string;
  readonly deliveryState: string;
};

type RecoveryState = {
  readonly identities: {
    readonly connector: {
      readonly organisationId: string;
      readonly connectorId: string;
    };
    readonly case: { readonly organisationId: string; readonly caseId: string };
    readonly session: {
      readonly organisationId: string;
      readonly sessionId: string;
    };
  };
  readonly connector: {
    readonly ingressCount: number;
    readonly deliveryCount: number;
    readonly deliveryReceiptCount: number;
    readonly activeCaseWork: number;
    readonly caseWorkReceipts: number;
    readonly caseWorkState: string;
    readonly deliveryState: string;
  };
  readonly caseOutputKinds: readonly string[];
  readonly session: {
    readonly lifecycleKind: string;
    readonly checkpoint: SessionCheckpointInspection;
  };
};

it(
  "recovers retryable Slack delivery after Session, Case and Connector eviction",
  recoverEvictedActorDelivery,
  100_000,
);
it(
  "defers four Actor alarms across frozen relocation and resumes pending delivery without repeating inference",
  recoverRelocatedActorDelivery,
  100_000,
);

it(
  "drains a sent Slack receipt before relocation copies Case and Connector state",
  relocateOutstandingSlackReceipt,
  70_000,
);

class SuccessfulSlack {
  phase: "ready" | "paused" | "released";
  readonly attempts: Record<string, string>[] = [];
  readonly visible: Record<string, string>[] = [];

  constructor(pauseResponse: boolean) {
    this.phase = pauseResponse ? "ready" : "released";
  }

  async respond(input: HttpResolverInfo): Promise<Response> {
    const method = String(input.params.method);
    const body: unknown = slackPostFields(await input.request.json());
    if (!isStringRecord(body)) throw new Error("Invalid Slack body");
    if (method === "assistant.threads.setStatus")
      return HttpResponse.json({ ok: true });
    if (method !== "chat.postMessage")
      throw new Error(`Unexpected Slack method: ${method}`);
    this.attempts.push(body);
    if (this.phase === "ready") {
      this.phase = "paused";
      while (this.phase === "paused") await scheduler.wait(5);
    }
    this.visible.push(body);
    return HttpResponse.json({
      ok: true,
      channel: body.channel,
      ts: `1787500101.00000${this.attempts.length}`,
    });
  }
}

async function startSuccessfulRecovery(slack: SuccessfulSlack): Promise<{
  readonly connectorId: string;
  readonly model: ModelSimulator;
  readonly stubs: RecoveryActorStubs;
}> {
  const fixture = await installRecoveryFixture();
  const model = createModelSimulator();
  network.use(
    model.handler,
    http.post("https://slack.com/api/:method", slack.respond.bind(slack)),
  );
  const response = await exports.default.fetch(
    await signedSlackRequest(slackEnvelope()),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  await expect
    .poll(successfulSlackAttemptCount.bind(null, slack), { timeout: 15_000 })
    .toBe(1);
  const references = await readRequiredRecoveryActorReferences(
    fixture.connectorId,
  );
  return {
    connectorId: fixture.connectorId,
    model,
    stubs: recoveryActorStubs(references),
  };
}

async function startRecoveryRelocation() {
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!target.ok) throw new Error(target.error.code);
  const started = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target: target.value,
    now: Date.now(),
  });
  if (!started.ok) throw new Error(started.error.code);
  return started.value.relocationId;
}

async function relocateOutstandingSlackReceipt({
  task,
}: TestContext): Promise<void> {
  const slack = new SuccessfulSlack(true);
  const fixture = await startSuccessfulRecovery(slack);
  await expect
    .poll(successfulSlackPhase.bind(null, slack), { timeout: 15_000 })
    .toBe("paused");
  const relocationId = await startRecoveryRelocation();
  const marker = { completed: false };
  const completion = resumeActorRelocation({
    env,
    relocationId,
    now: Date.now(),
  });
  void completion.then(markRecoveryRelocationComplete.bind(null, marker));
  try {
    await expect
      .poll(readConnectorExecutionBarrier.bind(null, fixture.stubs.connector), {
        timeout: 10_000,
      })
      .toBe(1);
    expect(marker.completed).toBe(false);
    expect(await recoveryExportedItemCount(relocationId)).toBe(0);
    expect(slack.visible).toHaveLength(0);
    expect(fixture.model.requests).toHaveLength(1);
    slack.phase = "released";
    expect(await completion).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    await assertSettledRecovery(fixture.stubs);
    const source = await fixture.stubs.connector.inspect();
    if (!source.ok) throw new Error(source.error.code);
    const delivery = source.value.deliveries[0];
    if (delivery === undefined) throw new Error("Missing sent delivery");
    const request = {
      identity: source.value.identity,
      delivery,
      requestedAt: Date.now(),
    };
    await evictRecoveryActors(fixture.stubs);
    expect(await fixture.stubs.connector.deliver(request)).toMatchObject({
      ok: false,
      error: { code: "connector_placement_conflict" },
    });
    const target = recoveryActorStubs(
      await readRequiredRecoveryActorReferences(fixture.connectorId),
    );
    await evictRecoveryActors(target);
    await assertSettledRecovery(target);
    const imported = await target.connector.inspect();
    if (!imported.ok) throw new Error(imported.error.code);
    expect(imported.value.receipts).toEqual(source.value.receipts);
    expect(await target.connector.deliver(request)).toMatchObject({
      ok: true,
      value: { kind: "already_delivered" },
    });
    expect(
      (await exports.default.fetch(await signedSlackRequest(slackEnvelope())))
        .status,
    ).toBe(200);
    await assertSettledRecovery(target);
    expect(slack.attempts).toHaveLength(1);
    expect(slack.visible).toHaveLength(1);
    expect(fixture.model.requests).toHaveLength(1);
    Object.assign(task.meta, {
      connectorReceiptPlacement: {
        relocationId,
        exportedItemsWhileSendPending: 0,
        sentReceiptsPreserved: 1,
        caseOutboxSettled: true,
        retiredSourceRejectedAfterEviction: true,
        targetReceiptReplayAfterEviction: "already_delivered",
        modelCalls: 1,
        providerAttempts: 1,
        visibleMessages: 1,
      },
    });
  } finally {
    slack.phase = "released";
    await completion;
  }
}

function successfulSlackPhase(
  slack: SuccessfulSlack,
): SuccessfulSlack["phase"] {
  return slack.phase;
}
function successfulSlackAttemptCount(slack: SuccessfulSlack): number {
  return slack.attempts.length;
}
function markRecoveryRelocationComplete(marker: { completed: boolean }): void {
  marker.completed = true;
}

function connectorExecutionBarrier(
  _actor: unknown,
  ctx: DurableObjectState,
): number {
  return ctx.storage.sql
    .exec("SELECT 1 FROM state_object_cleanup_export_barrier")
    .toArray().length;
}
function readConnectorExecutionBarrier(
  actor: DurableObjectStub<ConnectorDO>,
): Promise<number> {
  return runInDurableObject(actor, connectorExecutionBarrier);
}
async function recoveryExportedItemCount(
  relocationId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
  )
    .bind(relocationId)
    .first<{ count: number }>();
  if (row === null) throw new Error("Missing recovery relocation inventory");
  return row.count;
}

async function evictRecoveryActors(stubs: RecoveryActorStubs): Promise<void> {
  await evictDurableObject(stubs.session);
  await evictDurableObject(stubs.case);
  await evictDurableObject(stubs.connector);
}

async function assertSettledRecovery(stubs: RecoveryActorStubs): Promise<void> {
  await expect
    .poll(readRecoveryMilestone.bind(null, stubs), { timeout: 15_000 })
    .toEqual({
      activeCaseWork: 0,
      caseWorkReceipts: 1,
      caseWorkState: "missing",
      deliveryReceiptCount: 1,
      deliveryState: "delivered",
      caseOutputKinds: ["settled"],
      sessionLifecycleKind: "sleeping",
      sessionCheckpointKind: "current",
    });
}

function recoverEvictedActorDelivery(context: TestContext): Promise<void> {
  return recoversActorDelivery("eviction", context);
}

function recoverRelocatedActorDelivery(context: TestContext): Promise<void> {
  return recoversActorDelivery("relocation", context);
}

async function recoversActorDelivery(
  mode: "eviction" | "relocation",
  { task }: TestContext,
): Promise<void> {
  const fixture = await installRecoveryFixture();
  const model = createModelSimulator();
  const slack = createSlackSimulator();
  network.use(model.handler, slack.handler);
  const envelope = slackEnvelope();

  const root = await exports.default.fetch(await signedSlackRequest(envelope));
  expect(root.status).toBe(200);
  await expect(root.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "case_accepted",
  });

  await expect
    .poll(modelRequestCount.bind(null, model), { timeout: 15_000 })
    .toBe(1);
  await expect
    .poll(slackStatusCount.bind(null, slack), { timeout: 15_000 })
    .toBe(1);
  await expect
    .poll(slackDeliveryAttemptCount.bind(null, slack), { timeout: 15_000 })
    .toBe(1);
  await expect
    .poll(activeRecoveryActorCount.bind(null, fixture.connectorId), {
      timeout: 15_000,
    })
    .toBe(3);

  const references = await readRequiredRecoveryActorReferences(
    fixture.connectorId,
  );
  let stubs = recoveryActorStubs(references);
  await expect
    .poll(readRecoveryMilestone.bind(null, stubs), { timeout: 15_000 })
    .toEqual({
      activeCaseWork: 1,
      caseWorkReceipts: 0,
      caseWorkState: "retryable",
      deliveryReceiptCount: 0,
      deliveryState: "retryable",
      caseOutputKinds: ["pending"],
      sessionLifecycleKind: "sleeping",
      sessionCheckpointKind: "current",
    });
  const beforeEviction = await readRecoveryState(stubs);

  expect(slack.statusBodies).toEqual([
    {
      channel_id: CHANNEL_ID,
      thread_ts: ROOT_TS,
      status: "is thinking…",
    },
  ]);
  expect(slack.visibleMessages).toEqual([]);
  expect(beforeEviction.identities).toEqual({
    connector: {
      organisationId: ORGANISATION_ID,
      connectorId: fixture.connectorId,
    },
    case: {
      organisationId: ORGANISATION_ID,
      caseId: references.case.logicalObjectId,
    },
    session: {
      organisationId: ORGANISATION_ID,
      sessionId: references.session.logicalObjectId,
    },
  });

  await evictDurableObject(stubs.session);
  await evictDurableObject(stubs.case);
  await evictDurableObject(stubs.connector);

  if (mode === "relocation") {
    const sourceOrganisation = await requireActiveOrganisationActor({
      env,
      organisationId: ORGANISATION_ID,
      now: Date.now(),
    });
    const sourceActors: readonly DurableObjectStub<AlarmActor>[] = [
      sourceOrganisation,
      stubs.connector,
      stubs.case,
      stubs.session,
    ];
    const race: PlacementRace = {
      organisationId: ORGANISATION_ID,
      phase: { kind: "waiting" },
    };
    try {
      await freezePlacement(race);
    } finally {
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS lifecycle_interrupt_publication",
      ).run();
    }
    if (race.phase.kind !== "frozen")
      throw new Error("Relocation did not freeze");
    const targetReferences = await readRequiredRecoveryActorReferences(
      fixture.connectorId,
    );
    const targetStubs = recoveryActorStubs(targetReferences);
    const targetOrganisationRow = await fixtureDatabase()
      .prepare(
        "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'organisation' AND lifecycle_status = 'active'",
      )
      .bind(ORGANISATION_ID)
      .first<{ name: string }>();
    if (targetOrganisationRow === null)
      throw new Error("Missing imported Organisation Actor");
    const targetOrganisation = env.ORGANISATION.get(
      env.ORGANISATION.idFromName(targetOrganisationRow.name),
    );
    const targetActors: readonly DurableObjectStub<AlarmActor>[] = [
      targetOrganisation,
      targetStubs.connector,
      targetStubs.case,
      targetStubs.session,
    ];
    for (const actor of [...sourceActors, ...targetActors]) {
      await evictDurableObject(actor);
      await runInDurableObject(actor, armRecoveryAlarm);
      await runDurableObjectAlarm(actor);
      expect(
        await runInDurableObject(actor, readRecoveryAlarm),
      ).toBeGreaterThan(Date.now());
    }
    expect(await readRecoveryMilestone(stubs)).toEqual(
      await readRecoveryMilestone(targetStubs),
    );
    expect(model.requests).toHaveLength(1);
    expect(slack.deliveryAttempts).toHaveLength(1);
    expect(slack.visibleMessages).toEqual([]);
    expect(
      await resumeActorRelocation({
        env,
        relocationId: race.phase.relocationId,
        now: Date.now(),
      }),
    ).toMatchObject({ ok: true, value: { status: "retained" } });
    for (const actor of sourceActors) {
      await runInDurableObject(actor, armRecoveryAlarm);
      await runDurableObjectAlarm(actor);
      expect(await runInDurableObject(actor, readRecoveryAlarm)).toBeNull();
    }
    expect(slack.deliveryAttempts).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
    stubs = targetStubs;
    Object.assign(task.meta, {
      placementRecovery: {
        relocationId: race.phase.relocationId,
        frozenSourceAlarms: 4,
        stagedTargetAlarms: 4,
        retiredSourceAlarms: 4,
        inferenceCallsDuringFreeze: 0,
        deliveryAttemptsDuringFreeze: 0,
      },
    });
  }

  await runInDurableObject(stubs.connector, makeConnectorRecoveryDue);
  // Miniflare may dispatch the past-due alarm as the storage callback exits.
  await runDurableObjectAlarm(stubs.connector);
  await expect
    .poll(readRecoveryMilestone.bind(null, stubs), { timeout: 15_000 })
    .toEqual({
      activeCaseWork: 0,
      caseWorkReceipts: 1,
      caseWorkState: "missing",
      deliveryReceiptCount: 1,
      deliveryState: "delivered",
      caseOutputKinds: ["settled"],
      sessionLifecycleKind: "sleeping",
      sessionCheckpointKind: "current",
    });

  const afterRecovery = await readRecoveryState(stubs);
  const referencesAfterRecovery = await readRequiredRecoveryActorReferences(
    fixture.connectorId,
  );
  if (mode === "eviction") expect(referencesAfterRecovery).toEqual(references);
  else {
    expect(referencesAfterRecovery.connector.logicalObjectId).toBe(
      references.connector.logicalObjectId,
    );
    expect(referencesAfterRecovery.case.logicalObjectId).toBe(
      references.case.logicalObjectId,
    );
    expect(referencesAfterRecovery.session.logicalObjectId).toBe(
      references.session.logicalObjectId,
    );
  }
  expect(afterRecovery.identities).toEqual(beforeEviction.identities);
  expect(afterRecovery.session.checkpoint).toEqual(
    beforeEviction.session.checkpoint,
  );
  expect(afterRecovery).toMatchObject({
    connector: {
      ingressCount: 1,
      deliveryCount: 1,
      deliveryReceiptCount: 1,
      activeCaseWork: 0,
      caseWorkReceipts: 1,
      caseWorkState: "missing",
      deliveryState: "delivered",
    },
    caseOutputKinds: ["settled"],
    session: {
      lifecycleKind: "sleeping",
      checkpoint: { kind: "current" },
    },
  });
  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]).toMatchObject({
    model: PLATFORM_DEFAULT_PI_MODEL,
    stream: true,
  });
  expect(slack.deliveryAttempts).toHaveLength(2);
  expect(slack.deliveryAttempts[0]).toEqual(slack.deliveryAttempts[1]);
  expect(slack.deliveryAttempts[0]).toMatchObject({
    channel: CHANNEL_ID,
    thread_ts: ROOT_TS,
    markdown_text: MODEL_TEXT,
    client_msg_id: expect.any(String),
  });
  expect(slack.visibleMessages).toEqual([slack.deliveryAttempts[1]]);

  const caseState = await stubs.case.inspect();
  if (!caseState.ok) throw new Error(caseState.error.code);
  const connectorState = await stubs.connector.inspect();
  if (!connectorState.ok) throw new Error(connectorState.error.code);
  const settledOutput = caseState.value.outputs[0];
  if (
    settledOutput === undefined ||
    settledOutput.kind !== "settled" ||
    caseState.value.outputs.length !== 1
  ) {
    throw new Error("Recovered Case output is not exactly settled");
  }
  expect(connectorState.value.receipts.map(deliveryReceiptIdentity)).toEqual([
    deliveryReceiptIdentity(settledOutput.receipt),
  ]);
  const receiptReplay = await stubs.case.acceptDeliveryReceipt({
    outputId: settledOutput.output.outputId,
    receipt: settledOutput.receipt,
  });
  expect(receiptReplay).toMatchObject({
    ok: true,
    value: { kind: "already_settled" },
  });

  const replay = await exports.default.fetch(
    await signedSlackRequest(envelope),
  );
  expect(replay.status, await replay.clone().text()).toBe(200);
  await expect(replay.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "case_accepted",
  });
  const afterReplay = await stubs.connector.inspect();
  expect(afterReplay).toMatchObject({
    ok: true,
    value: {
      ingressCount: 1,
      deliveryCount: 1,
      caseWork: { activeRows: 0, receiptRows: 1 },
      receipts: [{}],
    },
  });
  const caseAfterReplay = await stubs.case.inspect();
  if (!caseAfterReplay.ok) throw new Error(caseAfterReplay.error.code);
  expect(caseAfterReplay.value.outputs).toEqual(caseState.value.outputs);
  expect(model.requests).toHaveLength(1);
  expect(slack.deliveryAttempts).toHaveLength(2);
  expect(slack.visibleMessages).toHaveLength(1);
}

async function installRecoveryFixture(): Promise<{
  readonly connectorId: string;
}> {
  const now = Date.now();
  const tokenHandle = requireVaultHandle("vault:slack:bot:e2e-actor-recovery");
  const install = await createOrganisationInstall(
    organisationDatabase(ORGANISATION_ID),
    env.DB,
    {
      organisationId: ORGANISATION_ID,
      name: "E2E actor recovery",
      surfaceKind: "slack",
      workspaceId: WORKSPACE_ID,
      installModel: "unlisted",
      botTokenRef: tokenHandle,
      scopes: [
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "channels:read",
        "chat:write",
      ],
      placement: requiredPlacement(),
      createdAt: now - 2_000,
      installedAt: now - 1_000,
    },
  );
  const connection = await fixtureDatabase()
    .prepare(
      `SELECT provider_connection_id AS providerConnectionId
     FROM integration_account
     WHERE integration_account_id = ?`,
    )
    .bind(install.integrationAccountId)
    .first<{ readonly providerConnectionId: string }>();
  if (connection === null)
    throw new Error("E2E recovery Slack connection missing");

  const stored = await storeVaultSecret({
    db: fixtureDatabase(),
    keys: env,
    organisationId: ORGANISATION_ID,
    handle: tokenHandle,
    secret: { kind: "bearer", value: "xoxb-e2e-actor-recovery" },
    now,
  });
  if (!stored.ok) throw new Error(stored.error.code);

  await publishGlobalOrganisation(ORGANISATION_ID);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO app_user (
         user_id, issuer, subject, email, display_name,
         email_verified, created_at, last_authenticated_at
       ) VALUES (
         'user_78d52121-40d5-53ad-83cd-ef528ba5f3f2', 'https://accounts.google.com',
         'e2e-actor-recovery', 'e2e-actor-recovery@example.invalid',
         'E2E Actor Recovery', 1, ?, ?
       )`,
    ).bind(now - 1_000, now - 1_000),
  ]);
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        `INSERT INTO person (organisation_id, person_id, display_name)
       VALUES (?, 'person_e2e-actor-recovery', 'E2E Actor Recovery')`,
      )
      .bind(ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        `INSERT INTO service_role_grant (
         organisation_id, user_id, person_id, role, status, created_at, revoked_at
       ) VALUES (
         ?, 'user_78d52121-40d5-53ad-83cd-ef528ba5f3f2', 'person_e2e-actor-recovery',
         'operator', 'active', ?, NULL
       )`,
      )
      .bind(ORGANISATION_ID, now - 1_000),
    fixtureDatabase()
      .prepare(
        `INSERT INTO external_identity_link (
         organisation_id, workspace_connection_id, workspace_id, external_user_id,
         user_id, verified_at, verified_by
       ) VALUES (
         ?, ?, ?, ?, 'user_78d52121-40d5-53ad-83cd-ef528ba5f3f2', ?, 'google'
       )`,
      )
      .bind(
        ORGANISATION_ID,
        connection.providerConnectionId,
        WORKSPACE_ID,
        USER_ID,
        now - 900,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_communication_destination (
         organisation_id, integration_account_id, workspace_id, channel_id,
         provider_revision, selected_at
       ) VALUES (?, ?, ?, ?, 'channel-e2e-recovery-1', ?)`,
      )
      .bind(
        ORGANISATION_ID,
        install.integrationAccountId,
        WORKSPACE_ID,
        CHANNEL_ID,
        now - 800,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_slack_channel (
         organisation_id, integration_account_id, workspace_id, channel_id,
         provider_revision, connected_at
       ) VALUES (?, ?, ?, ?, 'channel-e2e-recovery-1', ?)`,
      )
      .bind(
        ORGANISATION_ID,
        install.integrationAccountId,
        WORKSPACE_ID,
        CHANNEL_ID,
        now - 800,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_inference_selection (
         organisation_id, selection_kind, selected_by_user_id, selected_at
       ) VALUES (?, 'satyr_platform', 'user_78d52121-40d5-53ad-83cd-ef528ba5f3f2', ?)`,
      )
      .bind(ORGANISATION_ID, now - 700),
  ]);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO slack_installation (
      installation_id, environment, app_id, workspace_id, credential_organisation_id,
      bot_token_ref, install_model, scopes_json, lifecycle, installed_at, updated_at,
      disabled_at, revoked_at
    ) VALUES ('installation_e2e_recovery', 'development', 'A12345678', ?, ?, ?,
      'unlisted', '["chat:write"]', 'active', ?, ?, NULL, NULL)`,
    ).bind(WORKSPACE_ID, ORGANISATION_ID, tokenHandle, now, now),
    env.DB.prepare(
      `INSERT INTO slack_organisation_connection (
      connection_id, installation_id, organisation_id, integration_account_id,
      lifecycle, revision, connected_at, updated_at, disabled_at, revoked_at
    ) VALUES ('connection_e2e_recovery_org', 'installation_e2e_recovery', ?, ?,
      'active', 1, ?, ?, NULL, NULL)`,
    ).bind(ORGANISATION_ID, install.integrationAccountId, now, now),
    env.DB.prepare(
      `INSERT INTO slack_channel_default (
      installation_id, channel_id, connection_id, revision, bound_by_user_id, bound_at
    ) VALUES ('installation_e2e_recovery', ?, 'connection_e2e_recovery_org', 1, 'user_78d52121-40d5-53ad-83cd-ef528ba5f3f2', ?)`,
    ).bind(CHANNEL_ID, now),
  ]);

  const contextGrant = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: "grant_e2e_actor_recovery_context",
    subject: { kind: "organisation_role", role: "operator" },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_e2e_recovery",
    },
    now: now - 500,
  });
  if (!contextGrant.ok) throw new Error(contextGrant.error.code);

  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now,
  });
  await organisation.ensureOrganisation({
    organisationId: ORGANISATION_ID,
    name: "E2E actor recovery",
    plan: "beta",
    status: "active",
    createdAt: now - 2_000,
  });
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now,
  });
  if (!published.ok) throw new Error(published.error.code);
  await attachSlackActorToAccountAuthority({
    organisationId: ORGANISATION_ID,
    owner: { subject: "e2e-actor-recovery-owner", name: "E2E Recovery Owner" },
    actor: { subject: "e2e-actor-recovery", name: "E2E Actor Recovery" },
    now,
  });

  return { connectorId: `connector_slack_${install.integrationAccountId}` };
}

function createModelSimulator(): ModelSimulator {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    handler: http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToModel.bind(null, requests),
    ),
  };
}

async function respondToModel(
  requests: Record<string, unknown>[],
  input: HttpResolverInfo,
): Promise<Response> {
  const body = await input.request.json();
  if (!isRecord(body))
    throw new Error("OpenRouter recovery request body is invalid");
  requests.push(body);
  if (requests.length !== 1)
    throw new Error("Unexpected additional OpenRouter recovery request");
  return openRouterText(MODEL_TEXT);
}

function createSlackSimulator(): SlackSimulator {
  const state: Omit<SlackSimulator, "handler"> = {
    statusBodies: [],
    deliveryAttempts: [],
    visibleMessages: [],
  };
  return {
    ...state,
    handler: http.post(
      "https://slack.com/api/:method",
      respondToSlack.bind(null, state),
    ),
  };
}

async function respondToSlack(
  state: Omit<SlackSimulator, "handler">,
  input: HttpResolverInfo,
): Promise<Response> {
  const method = String(input.params.method);
  const body = slackPostFields(await input.request.json());
  if (!isStringRecord(body)) throw new Error("Slack recovery body is invalid");
  if (method === "assistant.threads.setStatus") {
    state.statusBodies.push(body);
    return HttpResponse.json({ ok: true });
  }
  if (method !== "chat.postMessage")
    throw new Error(`Unexpected Slack recovery method: ${method}`);
  state.deliveryAttempts.push(body);
  if (state.deliveryAttempts.length === 1) {
    return HttpResponse.json(
      { ok: false, error: "ratelimited" },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }
  if (state.deliveryAttempts.length !== 2)
    throw new Error("Unexpected additional Slack delivery attempt");
  state.visibleMessages.push(body);
  return HttpResponse.json({
    ok: true,
    channel: body.channel,
    ts: "1787500101.000001",
  });
}

function modelRequestCount(model: ModelSimulator): number {
  return model.requests.length;
}

function slackStatusCount(slack: SlackSimulator): number {
  return slack.statusBodies.length;
}

function slackDeliveryAttemptCount(slack: SlackSimulator): number {
  return slack.deliveryAttempts.length;
}

async function activeRecoveryActorCount(connectorId: string): Promise<number> {
  const rows = await readRecoveryActorRegistryRows();
  let count = 0;
  for (const row of rows) {
    if (row.objectKind === "connector" && row.logicalObjectId === connectorId)
      count += 1;
    if (row.objectKind === "case" || row.objectKind === "session") count += 1;
  }
  return count;
}

async function readRecoveryActorRegistryRows(): Promise<
  readonly ActorRegistryRow[]
> {
  const result = await fixtureDatabase()
    .prepare(
      `SELECT object_kind AS objectKind,
            logical_object_id AS logicalObjectId,
            physical_object_name AS physicalObjectName
     FROM durable_object_registry
     WHERE organisation_id = ?
       AND lifecycle_status = 'active'
       AND object_kind IN ('connector', 'case', 'session')
     ORDER BY object_kind`,
    )
    .bind(ORGANISATION_ID)
    .all<ActorRegistryRow>();
  return result.results;
}

async function readRequiredRecoveryActorReferences(
  connectorId: string,
): Promise<RecoveryActorReferences> {
  const rows = await readRecoveryActorRegistryRows();
  let connector: ActorReference | null = null;
  let caseActor: ActorReference | null = null;
  let session: ActorReference | null = null;
  for (const row of rows) {
    const reference = {
      logicalObjectId: row.logicalObjectId,
      physicalObjectName: row.physicalObjectName,
    };
    switch (row.objectKind) {
      case "connector":
        if (row.logicalObjectId === connectorId) connector = reference;
        break;
      case "case":
        if (caseActor !== null)
          throw new Error("Multiple recovery Case actors found");
        caseActor = reference;
        break;
      case "session":
        if (session !== null)
          throw new Error("Multiple recovery Session actors found");
        session = reference;
        break;
      default:
        throw new Error(`Unexpected recovery actor kind: ${row.objectKind}`);
    }
  }
  if (connector === null || caseActor === null || session === null) {
    throw new Error("Recovery actor registry is incomplete");
  }
  return { connector, case: caseActor, session };
}

function recoveryActorStubs(
  references: RecoveryActorReferences,
): RecoveryActorStubs {
  return {
    connector: env.CONNECTOR.getByName(references.connector.physicalObjectName),
    case: env.CASE.getByName(references.case.physicalObjectName),
    session: env.SESSION.getByName(references.session.physicalObjectName),
    sessionId: requireSessionId(references.session.logicalObjectId),
  };
}

async function readRecoveryMilestone(stubs: RecoveryActorStubs): Promise<{
  readonly activeCaseWork: number;
  readonly caseWorkReceipts: number;
  readonly caseWorkState: string;
  readonly deliveryReceiptCount: number;
  readonly deliveryState: string;
  readonly caseOutputKinds: readonly string[];
  readonly sessionLifecycleKind: string;
  readonly sessionCheckpointKind: string;
}> {
  const state = await readRecoveryState(stubs);
  return {
    activeCaseWork: state.connector.activeCaseWork,
    caseWorkReceipts: state.connector.caseWorkReceipts,
    caseWorkState: state.connector.caseWorkState,
    deliveryReceiptCount: state.connector.deliveryReceiptCount,
    deliveryState: state.connector.deliveryState,
    caseOutputKinds: state.caseOutputKinds,
    sessionLifecycleKind: state.session.lifecycleKind,
    sessionCheckpointKind: state.session.checkpoint.kind,
  };
}

async function readRecoveryState(
  stubs: RecoveryActorStubs,
): Promise<RecoveryState> {
  const connectorPromise = stubs.connector.inspect();
  const casePromise = stubs.case.inspect();
  const sessionPromise = stubs.session.inspectCanonicalSessionState({
    organisationId: ORGANISATION_ID,
    sessionId: stubs.sessionId,
  });
  const storagePromise = runInDurableObject(
    stubs.connector,
    inspectConnectorRecoveryStorage,
  );
  const [connector, caseState, session, storage] = await Promise.all([
    connectorPromise,
    casePromise,
    sessionPromise,
    storagePromise,
  ]);
  if (!connector.ok) throw new Error(connector.error.code);
  if (!caseState.ok) throw new Error(caseState.error.code);
  if (!session.ok) throw new Error(session.error.code);
  const outputKinds: string[] = [];
  for (const output of caseState.value.outputs) outputKinds.push(output.kind);
  return {
    identities: {
      connector: connector.value.identity,
      case: caseState.value.identity,
      session: session.value.identity,
    },
    connector: {
      ingressCount: connector.value.ingressCount,
      deliveryCount: connector.value.deliveryCount,
      deliveryReceiptCount: connector.value.receipts.length,
      activeCaseWork: connector.value.caseWork.activeRows,
      caseWorkReceipts: connector.value.caseWork.receiptRows,
      caseWorkState: storage.caseWorkState,
      deliveryState: storage.deliveryState,
    },
    caseOutputKinds: outputKinds,
    session: {
      lifecycleKind: session.value.lifecycleKind,
      checkpoint: session.value.checkpoint,
    },
  };
}

async function inspectConnectorRecoveryStorage(
  _actor: unknown,
  state: DurableObjectState,
): Promise<ConnectorStorageState> {
  const caseWorkRows = state.storage.sql
    .exec<{ readonly state_kind: string }>(
      "SELECT state_kind FROM connector_case_work ORDER BY created_at",
    )
    .toArray();
  const deliveryRows = state.storage.sql
    .exec<{ readonly state_json: string }>(
      "SELECT state_json FROM connector_delivery ORDER BY rowid",
    )
    .toArray();
  return {
    caseWorkState:
      caseWorkRows.length === 0
        ? "missing"
        : caseWorkRows.length === 1 && caseWorkRows[0] !== undefined
          ? caseWorkRows[0].state_kind
          : "ambiguous",
    deliveryState:
      deliveryRows.length === 1 && deliveryRows[0] !== undefined
        ? jsonKind(deliveryRows[0].state_json)
        : deliveryRows.length === 0
          ? "missing"
          : "ambiguous",
  };
}

async function makeConnectorRecoveryDue(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  const dueAt = Date.now() - 1_000;
  state.storage.transactionSync(
    rewriteConnectorRecoveryRows.bind(null, state.storage.sql, dueAt),
  );
  await state.storage.setAlarm(dueAt);
}

function rewriteConnectorRecoveryRows(sql: SqlStorage, dueAt: number): void {
  const workRows = sql
    .exec<{
      readonly event_id: string;
      readonly state_kind: string;
    }>(
      "SELECT event_id, state_kind FROM connector_case_work ORDER BY created_at",
    )
    .toArray();
  if (workRows.length !== 1 || workRows[0]?.state_kind !== "retryable") {
    throw new Error("Connector Case work is not exactly retryable");
  }
  const deliveryRows = sql
    .exec<{
      readonly delivery_id: string;
      readonly state_json: string;
    }>("SELECT delivery_id, state_json FROM connector_delivery ORDER BY rowid")
    .toArray();
  const delivery = deliveryRows[0];
  if (deliveryRows.length !== 1 || delivery === undefined) {
    throw new Error("Connector delivery is not unique");
  }
  const retryable = parseRetryableDeliveryState(delivery.state_json);
  if (retryable === null)
    throw new Error("Connector delivery is not retryable");
  sql.exec(
    "UPDATE connector_case_work SET due_at = ? WHERE event_id = ?",
    dueAt,
    workRows[0].event_id,
  );
  sql.exec(
    "UPDATE connector_delivery SET state_json = ? WHERE delivery_id = ?",
    JSON.stringify({
      kind: "retryable",
      attempt: retryable.attempt,
      reason: retryable.reason,
      retryAt: dueAt,
    }),
    delivery.delivery_id,
  );
}

function parseRetryableDeliveryState(value: string): {
  readonly attempt: number;
  readonly reason: string;
} | null {
  const parsed = parseJsonOrNull(value);
  return isRecord(parsed) &&
    parsed.kind === "retryable" &&
    typeof parsed.attempt === "number" &&
    Number.isSafeInteger(parsed.attempt) &&
    parsed.attempt > 0 &&
    typeof parsed.reason === "string" &&
    parsed.reason.length > 0 &&
    typeof parsed.retryAt === "number" &&
    Number.isSafeInteger(parsed.retryAt)
    ? { attempt: parsed.attempt, reason: parsed.reason }
    : null;
}

function jsonKind(value: string): string {
  const parsed = parseJsonOrNull(value);
  return isRecord(parsed) && typeof parsed.kind === "string"
    ? parsed.kind
    : "corrupt";
}

function openRouterText(text: string): Response {
  return openRouterStream([
    {
      id: "chatcmpl_e2e_actor_recovery",
      object: "chat.completion.chunk",
      created: 1_787_500_100,
      model: PLATFORM_DEFAULT_PI_MODEL,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl_e2e_actor_recovery",
      object: "chat.completion.chunk",
      created: 1_787_500_100,
      model: PLATFORM_DEFAULT_PI_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ]);
}

function openRouterStream(
  chunks: readonly Record<string, unknown>[],
): Response {
  let body = "";
  for (const chunk of chunks) body += `data: ${JSON.stringify(chunk)}\n\n`;
  body += "data: [DONE]\n\n";
  return new HttpResponse(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function slackEnvelope(): Record<string, unknown> {
  return {
    type: "event_callback",
    api_app_id: "A12345678",
    event_id: "Ev0E2ERECOVERY",
    team_id: WORKSPACE_ID,
    event: {
      type: "app_mention",
      channel: CHANNEL_ID,
      user: USER_ID,
      text: "<@U0PANTRY> prove actor recovery",
      ts: ROOT_TS,
      thread_ts: ROOT_TS,
      event_ts: ROOT_TS,
    },
  };
}

function deliveryReceiptIdentity(receipt: {
  readonly deliveryId: string;
  readonly connectorId: string;
  readonly idempotencyKey: string;
  readonly nativeReceiptId: string;
  readonly deliveredAt: number;
}) {
  return {
    deliveryId: receipt.deliveryId,
    connectorId: receipt.connectorId,
    idempotencyKey: receipt.idempotencyKey,
    nativeReceiptId: receipt.nativeReceiptId,
    deliveredAt: receipt.deliveredAt,
  };
}

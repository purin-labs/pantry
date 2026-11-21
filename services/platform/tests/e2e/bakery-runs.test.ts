import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { fixtureDatabase } from "./organisation-database";
import { requireConversationId } from "../test-ids";
import {
  initialSimulatorState,
  applyBakeryWorkspaceAction,
} from "../../../../apps/portal/src/features/workflow-simulator/simulator-state";
import {
  prepareBakerySurfaceCommand,
  validatePreparedBakerySurfaceRead,
  bakerySurfaceCommandSucceeded,
} from "../../../../apps/portal/src/features/workflow-simulator/bakery-surface";
import { readScenario } from "../../../../apps/portal/src/features/workflow-simulator/scenario-api";
import { readProductionScenario } from "../../../../apps/portal/src/features/workflow-simulator/production-scenario-api";
import { sha256Hex } from "@purin-labs/std";
import {
  editRehearsalWorkcells,
  type ProductionWorkcells,
} from "../../../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import {
  rehearsalFromRecording,
  rehearsalSettings,
} from "@purin-labs/production-simulation/simulator/rehearsal-presets";
import ovenCycle from "../../../../assets/bakery-mujoco/fr10-workcell/recordings/oven-cycle.json";
import { parsePhysicsReplay } from "@purin-labs/bakery-model/bakery-physics";
import {
  savePreparedAgentWorkspaceRun,
  savePreparedWorkspaceRun,
  prepareRehearsalRunWorkspace,
  openRehearsalRunWorkspace,
  preparePersistentWorkspaceRun,
  readExactWorkspaceRun,
  verifyStoredWorkspaceRun,
} from "../../../../apps/portal/src/features/workflow-simulator/workspace-runs-api";
import {
  compileFinancierRecipe,
  financierRecipeInput,
} from "../../../../packages/production-simulation/src/recipes/bakery/financier";
import { createExecutionHost } from "../../../../packages/production-simulation/src/execution-host";
import { readOvenSave } from "@purin-labs/production-simulation/runs/oven-run-file";
import { PRODUCTION_EXECUTION_MANIFEST } from "@purin-labs/production-simulation/execution-manifest";
import {
  parseBakerySurfaceReceipt,
  createBakerySurfaceAttachment,
  createBakerySurfaceEffect,
  createBakerySurfaceReceipt,
  type BakerySurfaceContextV1,
} from "@purin-labs/bakery-model/bakery-surface";
import { env, exports } from "cloudflare:workers";
import {
  connectCommerceFixture,
  commerceClient as client,
  commerceWorkspace as workspace,
  commerceHeaders as headers,
} from "./commerce-support";
import { expect, it, vi } from "vitest";
import { responseJson } from "../../../../apps/portal/src/control-client";
import { savePreparedScenarioCopy } from "../../../../apps/portal/src/features/workflow-simulator/workspace-commands";
import { savePreparedProductionScenario } from "../../../../apps/portal/src/features/workflow-simulator/production-scenario-api";
import { type IssuedControlSession } from "../../src/data/control-plane";
import { readLatestAgentRunSave } from "../../src/commerce/bakery/agent-run-save";
import { listBakerySurfaceTimelineEvents } from "../../src/actors/bakery-surface-effect";
import { admitTurn } from "../../src/chat/turn/admission";
import { reconcileStoredBakerySurfaceTimeline } from "../../src/chat/turn/timeline";
import { readConversation, saveConversation } from "../../src/chat/store";
import { resolvePantryPlatformModelRoute } from "../../src/models/route";
import { readLatestAgentScenarioSave } from "../../src/commerce/bakery/agent-scenario-save";
import {
  agentScenarioSaveManifest,
  type AgentScenarioSavePayload,
} from "@purin-labs/bakery-model/bakery-agent-scenario-save";
import {
  bakeryFingerprint,
  sampleSettings,
} from "@purin-labs/bakery-model/bakery";
import {
  readBakeryProcedure,
  type ProcedureOperation,
} from "@purin-labs/bakery-model/bakery-procedure";
import {
  parseCommerceGraphQuery,
  CommerceEntityPlaneClient,
} from "@purin-labs/commerce-client";
import type { CommerceGraphQuery } from "@purin-labs/commerce-contracts";
import { FINANCIER_SAMPLE_ID } from "../../src/commerce/bakery/sample";
import { customEntityRef } from "../../../../apps/portal/src/features/commerce/entity-plane/api";
import { parseScenarioCopy } from "@purin-labs/bakery-model/bakery-scenario";
import {
  parseProductionScenario,
  productionAssignmentId,
  productionDefinitionFingerprint,
  type ProductionAssignment,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import {
  parseRunSnapshot,
  parseRunSnapshotSummary,
  MAX_RUN_SNAPSHOT_BYTES,
} from "@purin-labs/bakery-model/bakery-run-snapshot";

it(
  "saves immutable private snapshots with real organisation authorization, CSRF, pagination and retry safety",
  sharedRuns,
);

async function sharedRuns(): Promise<void> {
  const owner = await client("bakery-owner");
  const viewer = await client("bakery-viewer");
  const foreignOwner = await client("bakery-foreign");
  const organisation = await workspace(owner, "Bakery shared runs");
  const foreign = await workspace(foreignOwner, "Foreign bakery");
  await fixtureDatabase().batch([
    fixtureDatabase().prepare(
      "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
    ).bind(organisation, "person_bakery_viewer", "Viewer"),
    fixtureDatabase().prepare(
      "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'viewer', 'active', ?, NULL)",
    ).bind(
      organisation,
      viewer.identity.userId,
      "person_bakery_viewer",
      Date.now(),
    ),
  ]);
  // The foreign Organisation stays native: it only answers cross-Organisation
  // reads, which are refused either way.
  const path = `/v1/control/organisations/${organisation}/bakery/runs`;
  const body = {
    name: "冷たいトレー",
    document: {
      schemaVersion: 3,
      kind: "bakery-workcell-experiment",
      input: {},
      evidence: null,
      presentation: { workcell: { x: 134, y: 284 } },
    },
  };
  // Storage owns file integrity; semantic validation still occurs on portal open.
  const saved = await send(path, owner.session, body);
  expect(saved.status).toBe(201);
  const result = await saved.json<{ snapshot: unknown }>();
  const summary = parseRunSnapshotSummary(result.snapshot);
  if (summary === null) throw new Error("Missing snapshot summary");
  expect(summary.kind).toBe("rehearsal");
  expect(
    (await send(path, owner.session, { ...body, expectedId: "0".repeat(64) }))
      .status,
  ).toBe(409);
  expect((await send(`${path}/${"0".repeat(64)}`, owner.session)).status).toBe(
    404,
  );
  const duplicate = await send(path, owner.session, body);
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toEqual({ ok: true, snapshot: summary });
  const opened = await send(`${path}/${summary.id}`, viewer.session);
  expect(opened.status).toBe(200);
  expect(opened.headers.get("cache-control")).toBe("no-store");
  expect(await opened.json()).toEqual(body);
  expect((await send(path, viewer.session, body)).status).toBe(404);
  expect(
    (await send(`${path}/${summary.id}`, foreignOwner.session)).status,
  ).toBe(404);
  expect(
    (
      await send(
        `/v1/control/organisations/${foreign}/bakery/runs/${summary.id}`,
        foreignOwner.session,
      )
    ).status,
  ).toBe(404);
  expect((await exports.default.fetch(`https://localhost${path}`)).status).toBe(
    401,
  );
  const badCsrf = headers(owner.session);
  badCsrf.delete("x-pantry-csrf");
  expect(
    (
      await exports.default.fetch(`https://localhost${path}`, {
        method: "POST",
        headers: badCsrf,
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(403);
  const badOrigin = headers(owner.session);
  badOrigin.set("origin", "https://foreign.example");
  expect(
    (
      await exports.default.fetch(`https://localhost${path}`, {
        method: "POST",
        headers: badOrigin,
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(403);
  expect((await send(path, owner.session, { ...body, name: "" })).status).toBe(
    422,
  );
  expect(
    (
      await send(path, owner.session, {
        ...body,
        document: { ...body.document, schemaVersion: 99 },
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await send(path, owner.session, {
        ...body,
        name: "x".repeat(MAX_RUN_SNAPSHOT_BYTES),
      })
    ).status,
  ).toBe(422);
  for (let index = 0; index < 25; index++) {
    expect(
      (await send(path, owner.session, { ...body, name: `Run ${index}` }))
        .status,
    ).toBe(201);
  }
  const page = await (
    await send(path, viewer.session)
  ).json<{ snapshots: unknown[]; nextCursor: string }>();
  expect(page.snapshots).toHaveLength(25);
  expect(typeof page.nextCursor).toBe("string");
  const next = await (
    await send(
      `${path}?cursor=${encodeURIComponent(page.nextCursor)}`,
      viewer.session,
    )
  ).json<{ snapshots: unknown[]; nextCursor: null }>();
  expect(next.snapshots).toHaveLength(1);
  expect(next.nextCursor).toBeNull();
  const productionBody = {
    name: "Morning production",
    document: {
      schemaVersion: 6,
      kind: "bakery-production-workcells",
      manualTasks: [],
      procedureFingerprint: null,
      fingerprint: "a".repeat(64),
      settings: {},
      variant: "normal",
      source: { kind: "local" },
      operations: [{}],
    },
  };
  const productionSave = await send(path, owner.session, productionBody);
  expect(productionSave.status).toBe(201);
  const productionResult = await productionSave.json<{ snapshot: unknown }>();
  const productionSummary = parseRunSnapshotSummary(productionResult.snapshot);
  if (productionSummary === null) throw new Error("Missing production summary");
  expect(productionSummary.kind).toBe("production");
  expect(
    await (
      await send(`${path}/${productionSummary.id}`, viewer.session)
    ).json(),
  ).toEqual(productionBody);
  expect((await send(path, owner.session, productionBody)).status).toBe(200);
  const persistentId = await sharedPersistentRun(
    organisation,
    owner.session,
    viewer.session,
    foreignOwner.session,
  );
  expect((await send(`${path}?cursor=`, viewer.session)).status).toBe(422);
  await fixtureDatabase().prepare(
    "UPDATE service_role_grant SET status = 'revoked', revoked_at = ? WHERE organisation_id = ? AND user_id = ?",
  )
    .bind(Date.now(), organisation, viewer.identity.userId)
    .run();
  expect((await send(`${path}/${summary.id}`, viewer.session)).status).toBe(
    404,
  );
  expect((await send(`${path}/${persistentId}`, viewer.session)).status).toBe(
    404,
  );
}

async function sharedPersistentRun(
  organisationId: string,
  owner: IssuedControlSession,
  viewer: IssuedControlSession,
  outsider: IssuedControlSession,
): Promise<string> {
  const compiled = await compileFinancierRecipe(
    financierRecipeInput(3, 1, 900),
  );
  if (!compiled.ok) throw new Error("Recipe compilation failed");
  const host = createExecutionHost({ send: refuseRecipePhysics });
  const began = await host.handle({
    kind: "begin",
    bundle: PRODUCTION_EXECUTION_MANIFEST.bundle,
    cells: [],
    identity: {
      runId: "shared-recipe",
      executionId: "original",
      hostSession: "original-host",
      parent: null,
    },
    origin: { kind: "scenario", scenario: compiled.value },
  });
  expect(began.kind).toBe("began");
  const held = await host.handle({
    kind: "drive",
    turns: 128,
    until: 21_600_000_000,
  });
  if (held.kind !== "drove") throw new Error("Recipe did not advance");
  expect(held.view.status.kind).toBe("awaiting-inspection");
  const checked = await readOvenSave(
    await host.handle({ kind: "save" }),
    new Map(),
  );
  if (!checked.ok) throw new Error(checked.error);
  const prepared = await preparePersistentWorkspaceRun(
    "Shared financier inspection",
    checked.value.save,
  );
  const lost = await savePreparedWorkspaceRun(
    organisationId,
    loseRecipeSaveReply.bind(null, owner),
    prepared,
    readRunAs.bind(null, owner),
  );
  expect(lost.kind).toBe("outcome-unknown");
  expect(
    await verifyStoredWorkspaceRun(
      organisationId,
      "persistent-production",
      prepared.id,
      prepared.snapshot.name,
      readRunAs.bind(null, owner),
    ),
  ).toEqual({ kind: "verified" });
  const path = `/v1/control/organisations/${organisationId}/bakery/runs`;
  const body = {
    expectedId: prepared.id,
    name: prepared.snapshot.name,
    document: checked.value.save,
  };
  expect((await send(path, owner, body)).status).toBe(200);
  expect((await send(path, viewer, body)).status).toBe(404);
  expect((await send(`${path}/${prepared.id}`, outsider)).status).toBe(404);
  const opened = await openInlinePersistentRun(
    organisationId,
    prepared.id,
    readRunAs.bind(null, viewer),
  );
  expect(opened.save.document).toEqual(checked.value.save.document);
  await host.handle({ kind: "dispose" });
  const continued = createExecutionHost({ send: refuseRecipePhysics });
  const resumed = await continued.handle({
    kind: "begin",
    bundle: opened.save.document.bundle,
    cells: [],
    identity: {
      runId: "shared-recipe",
      executionId: "continued",
      hostSession: "viewer-host",
      parent: {
        snapshot: opened.save.document.snapshot,
        execution: "original",
      },
    },
    origin: {
      kind: "snapshot",
      document: opened.save.document,
      checkpoints: opened.save.artifacts,
    },
  });
  if (resumed.kind !== "began") throw new Error("Shared recipe did not reopen");
  expect(resumed.view.status.kind).toBe("awaiting-inspection");
  const pending = resumed.view.inspections[0];
  if (pending?.kind !== "pending")
    throw new Error("The held inspection was lost");
  const decision = await continued.handle({
    kind: "inspect",
    commandId: "continued-inspection",
    expectedControlRevision: resumed.view.controlRevision,
    task: pending.task,
    definition: pending.definition,
    lots: pending.lots,
    outcome: "reject",
    note: "Synthetic inspection after shared reopen.",
  });
  expect(decision.kind).toBe("commanded");
  const next = await continued.handle({
    kind: "drive",
    turns: 128,
    until: 21_600_000_000,
  });
  if (next.kind !== "drove")
    throw new Error("Continued recipe did not advance");
  expect(next.view.inspections).toContainEqual({
    ...pending,
    kind: "recorded",
    outcome: "reject",
    note: "Synthetic inspection after shared reopen.",
  });
  // Continuing creates another execution. The shared immutable copy remains held.
  const unchanged = await openInlinePersistentRun(
    organisationId,
    prepared.id,
    readRunAs.bind(null, viewer),
  );
  expect(unchanged.save.document.state.commands).toEqual(
    checked.value.save.document.state.commands,
  );
  await continued.handle({ kind: "dispose" });
  return prepared.id;
}

async function openInlinePersistentRun(
  organisationId: string,
  id: string,
  read: (path: string) => Promise<unknown>,
) {
  const snapshot = await readExactWorkspaceRun(organisationId, id, read);
  const opened = await readOvenSave(JSON.parse(snapshot.file), new Map());
  if (!opened.ok) throw new Error(opened.error);
  return opened.value;
}

async function refuseRecipePhysics(): Promise<never> {
  throw new Error("This manual recipe must not issue native commands.");
}
async function readRunAs(
  session: IssuedControlSession,
  path: string,
): Promise<unknown> {
  return responseJson(await send(path, session));
}
async function loseRecipeSaveReply(
  session: IssuedControlSession,
  path: string,
  body: unknown,
): Promise<unknown> {
  const response = await send(path, session, body);
  if (!path.endsWith("/bakery/runs")) return responseJson(response);
  expect(response.status).toBe(201);
  throw new Error("Acceptance fault: committed save reply lost");
}

async function send(
  path: string,
  session: IssuedControlSession,
  body?: unknown,
): Promise<Response> {
  const sealed = await sealRunWrite(path, body);
  return exports.default.fetch(`https://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: headers(session),
    ...(body === undefined ? {} : { body: JSON.stringify(sealed) }),
  });
}

async function sealRunWrite(path: string, body: unknown): Promise<unknown> {
  if (!path.endsWith("/bakery/runs") || body === undefined) return body;
  if (typeof body !== "object" || body === null || "expectedId" in body)
    return body;
  const snapshot = parseRunSnapshot(body);
  if (snapshot === null) return body;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(snapshot.content),
  );
  const expectedId = Array.from(new Uint8Array(digest), hexByte).join("");
  return { ...body, expectedId };
}

function hexByte(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}

// A one-tray rehearsal of the cold oven cycle with its recorded result, and
// the same tray with its results cleared.
async function ovenCycleRehearsals(): Promise<
  Readonly<{ recorded: ProductionWorkcells; pending: ProductionWorkcells }>
> {
  const replay = parsePhysicsReplay(JSON.stringify(ovenCycle));
  if (replay.kind === "rejected") throw new Error("Invalid cycle fixture");
  const recorded = await rehearsalFromRecording(
    rehearsalSettings(sampleSettings()),
    replay.recording,
  );
  if (recorded.kind === "rejected") throw new Error(recorded.message);
  const cleared = await editRehearsalWorkcells(recorded.plan, {
    kind: "reset",
    batchId: "A",
  });
  if (cleared.kind === "rejected") throw new Error(cleared.message);
  return { recorded: recorded.plan, pending: cleared.plan };
}

it(
  "prepares a chat rehearsal save, retains frozen bytes across a newer edit, and verifies the authorized copy",
  chatRehearsalSave,
);

async function chatRehearsalSave(): Promise<void> {
  const owner = await client("bakery-chat-save");
  const otherAdmin = await client("bakery-chat-save-other-admin");
  const organisation = await workspace(owner, "Chat save acceptance");
  const scope = {
    organisationId: organisation,
    userId: owner.identity.userId,
  };
  const model = resolvePantryPlatformModelRoute(env);
  if (!model.ok) throw new Error(model.error.code);
  const conversationId = requireConversationId(
    "conv_a3e0d39b-1d2c-4c38-8d5f-c51b774dd153",
  );
  const browserBinding = {
    browserInstanceId: crypto.randomUUID(),
    conversationId,
  };
  const admitted = await admitTurn(
    null,
    {
      kind: "message",
      conversationId,
      requestId: "operator-save-request",
      model: model.value.model,
      text: "Prepare the accepted rehearsal for saving.",
      browserContext: { kind: "available", binding: browserBinding },
      surfaceContext: null,
      attachments: [],
    },
    model.value,
    scope,
  );
  if (!admitted.ok || admitted.conversation.work.kind !== "running")
    throw new Error("Save conversation was not admitted");
  expect(
    await saveConversation(
      await requireOrganisationExecutionScope(env, scope.organisationId),
      scope.userId,
      admitted.conversation,
      0,
    ),
  ).toEqual({ kind: "saved" });
  const backendRequestId = admitted.conversation.work.requestId;
  await fixtureDatabase().batch([
    fixtureDatabase().prepare(
      "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
    ).bind(organisation, "person_bakery_chat_other_admin", "Other admin"),
    fixtureDatabase().prepare(
      "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'admin', 'active', ?, NULL)",
    ).bind(
      organisation,
      otherAdmin.identity.userId,
      "person_bakery_chat_other_admin",
      Date.now(),
    ),
  ]);
  const rehearsals = await ovenCycleRehearsals();
  const prepared = await prepareRehearsalRunWorkspace(
    "Reviewed chat cycle",
    rehearsals.pending,
  );
  const surfaceSessionId = crypto.randomUUID();
  const command = {
    schemaVersion: 1 as const,
    kind: "prepare_run_save" as const,
    target: {
      surfaceSessionId,
      surfaceEpoch: 0,
    },
    name: "Reviewed chat cycle",
  };
  const effectId = `surface_effect_${crypto.randomUUID().replaceAll("-", "")}aaaaaaaa`;
  const manifest = {
    kind: "rehearsal" as const,
    id: prepared.id,
    name: prepared.snapshot.name,
    bytes: prepared.bytes,
  };
  const context = {
    schemaVersion: 1,
    kind: "bakery-workspace",
    runOpenReview: null,
    surfaceSessionId,
    surfaceEpoch: 0,
    capturedAt: Date.now(),
    comparison: null,
    simulation: null,
    supportedCommands: ["inspect_surface", "prepare_run_save"],
    active: {
      kind: "rehearsal",
      view: { camera: "perspective" },
      rehearsalKind: "scheduled",
      panel: "files",
      faults: { outage: null, failure: null, recovery: null },
      editReview: null,
      rackLayout: null,
      readiness: "ready",
      selection: null,
      playback: { cursorSeconds: 0, playback: "paused", speed: 120 },
      runId: null,
      attemptId: null,
      planFingerprint: rehearsals.pending.fingerprint,
      pendingOperation: null,
      tasks: [],
      resources: [],
      trays: [],
      bakerCount: 2,
      candidate: null,
      runSaveProposal: manifest,
    },
  } satisfies BakerySurfaceContextV1;
  const effect = await createBakerySurfaceEffect({
    effectId,
    dispatchId: "chat_save_dispatch",
    deadlineAt: Date.now() + 20_000,
    command,
  });
  const receipt = await createBakerySurfaceReceipt(effect, {
    kind: "completed",
    result: {
      kind: "succeeded",
      command: "prepare_run_save",
      surface: await createBakerySurfaceAttachment(context),
      output: { kind: "run_save_proposal", manifest },
    },
  });
  const preparation = await createBakerySurfaceEffect({
    effectId: `surface_effect_${crypto.randomUUID().replaceAll("-", "")}aaaaaaaa`,
    dispatchId: "chat_save_preparation",
    deadlineAt: effect.deadlineAt,
    command: {
      schemaVersion: 1,
      kind: "prepare_context",
      binding: browserBinding,
      requiredCommand: "prepare_run_save",
    },
  });
  const preparedReceipt = await createBakerySurfaceReceipt(preparation, {
    kind: "prepared",
    binding: browserBinding,
    surface: await createBakerySurfaceAttachment(context),
  });
  expect(parseBakerySurfaceReceipt(receipt).kind).toBe("valid");
  expect(parseBakerySurfaceReceipt(preparedReceipt).kind).toBe("valid");
  const settledAt = Date.now();
  const deliveryInsert = fixtureDatabase().prepare(
    `INSERT INTO bakery_surface_effect_delivery (
      effect_id, organisation_id, user_id, session_id, turn_id,
      request_id, surface_session_id, surface_epoch, command_digest,
      effect_json, state_kind, receipt_json, deadline_at, created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?, ?, ?)`,
  );
  await fixtureDatabase().batch([
    deliveryInsert.bind(
      effectId,
      organisation,
      owner.identity.userId,
      admitted.conversation.work.stream.sessionId,
      admitted.conversation.work.stream.turnId,
      backendRequestId,
      surfaceSessionId,
      0,
      effect.commandDigest,
      JSON.stringify(effect),
      JSON.stringify(receipt),
      effect.deadlineAt,
      settledAt,
      settledAt,
    ),
    deliveryInsert.bind(
      preparation.effectId,
      organisation,
      owner.identity.userId,
      admitted.conversation.work.stream.sessionId,
      admitted.conversation.work.stream.turnId,
      backendRequestId,
      `browser:${browserBinding.browserInstanceId}`,
      0,
      preparation.commandDigest,
      JSON.stringify(preparation),
      JSON.stringify(preparedReceipt),
      preparation.deadlineAt,
      settledAt,
      settledAt,
    ),
  ]);

  const proposedBody = {
    expectedId: prepared.id,
    name: prepared.snapshot.name,
    document: JSON.parse(prepared.snapshot.file),
    agentEffectId: effectId,
  };
  expect(
    (
      await send(
        `/v1/control/organisations/${organisation}/bakery/runs`,
        otherAdmin.session,
        proposedBody,
      )
    ).status,
  ).toBe(409);

  const edited = await prepareRehearsalRunWorkspace(
    "Reviewed chat cycle",
    rehearsals.recorded,
  );
  expect(edited.id).not.toBe(prepared.id);
  const savePath = `/v1/control/organisations/${organisation}/bakery/runs`;
  const unapproved = await send(savePath, owner.session, {
    expectedId: prepared.id,
    name: prepared.snapshot.name,
    document: JSON.parse(prepared.snapshot.file),
    agentEffectId: `surface_effect_${"0".repeat(40)}`,
  });
  expect(unapproved.status).toBe(409);
  await fixtureDatabase().prepare(
    "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ? AND user_id = ?",
  )
    .bind(organisation, otherAdmin.identity.userId)
    .run();
  // Deliver first, then revoke: a cached browser effect must not settle or
  // grant a save after its creator loses workspace access.
  await fixtureDatabase().prepare(
    "UPDATE bakery_surface_effect_delivery SET state_kind = 'dispatching', receipt_json = NULL WHERE effect_id = ?",
  )
    .bind(effectId)
    .run();
  const effectsPath = `/v1/control/organisations/${organisation}/chat/surface-effects`;
  const pendingPath = `${effectsPath}?browserInstanceId=${browserBinding.browserInstanceId}&conversationId=${conversationId}`;
  const delivered = await send(pendingPath, owner.session);
  expect(delivered.status).toBe(200);
  expect(await delivered.json()).toEqual({ ok: true, effects: [{ effect }] });
  await fixtureDatabase().prepare(
    "UPDATE service_role_grant SET status = 'revoked', revoked_at = ? WHERE organisation_id = ? AND user_id = ?",
  )
    .bind(Date.now(), organisation, owner.identity.userId)
    .run();
  expect((await send(pendingPath, owner.session)).status).toBe(404);
  expect(
    (
      await send(`${effectsPath}/${effectId}/receipt`, owner.session, {
        receipt,
      })
    ).status,
  ).toBe(404);
  expect(await (await send(pendingPath, otherAdmin.session)).json()).toEqual({
    ok: true,
    effects: [],
  });
  expect(
    await fixtureDatabase().prepare(
      "SELECT state_kind, receipt_json FROM bakery_surface_effect_delivery WHERE effect_id = ?",
    )
      .bind(effectId)
      .first(),
  ).toEqual({ state_kind: "dispatching", receipt_json: null });
  expect((await send(savePath, owner.session, proposedBody)).status).toBe(404);
  expect(
    (await send(`${savePath}/${prepared.id}`, otherAdmin.session)).status,
  ).toBe(404);
  expect(
    await fixtureDatabase().prepare(
      "SELECT effect_id FROM bakery_agent_run_save WHERE effect_id = ?",
    )
      .bind(effectId)
      .first(),
  ).toBeNull();
  await fixtureDatabase().prepare(
    "UPDATE service_role_grant SET status = 'active', revoked_at = NULL WHERE organisation_id = ? AND user_id = ?",
  )
    .bind(organisation, owner.identity.userId)
    .run();
  await fixtureDatabase().prepare(
    "UPDATE bakery_surface_effect_delivery SET state_kind = 'settled', receipt_json = ? WHERE effect_id = ?",
  )
    .bind(JSON.stringify(receipt), effectId)
    .run();
  const saved = await savePreparedAgentWorkspaceRun(
    organisation,
    mutateAs.bind(null, owner.session),
    prepared,
    effectId,
    readAs.bind(null, owner.session),
  );
  expect(saved.kind).toBe("verified");
  expect(
    await readLatestAgentRunSave({
      db: fixtureDatabase(),
      archive: env.ARCHIVE,
      organisationId: organisation,
      userId: owner.identity.userId,
      surfaceSessionId,
    }),
  ).toEqual({
    kind: "verified",
    effectId,
    snapshot: saved.kind === "verified" ? saved.snapshot : null,
  });
  expect(
    await readLatestAgentRunSave({
      db: fixtureDatabase(),
      archive: env.ARCHIVE,
      organisationId: organisation,
      userId: otherAdmin.identity.userId,
      surfaceSessionId,
    }),
  ).toEqual({ kind: "none" });
  const approval = await fixtureDatabase().prepare(
    `SELECT state_kind AS stateKind, content_id AS contentId,
            summary_json AS summaryJson
     FROM bakery_agent_run_save WHERE effect_id = ?`,
  )
    .bind(effectId)
    .first<{ stateKind: string; contentId: string; summaryJson: string }>();
  expect(approval?.stateKind).toBe("saved");
  expect(approval?.contentId).toBe(prepared.id);
  expect(
    parseRunSnapshotSummary(JSON.parse(approval?.summaryJson ?? "null")),
  ).toEqual(saved.kind === "verified" ? saved.snapshot : null);
  await fixtureDatabase().prepare(
    "UPDATE bakery_agent_run_save SET state_kind = 'approved', summary_json = NULL WHERE effect_id = ?",
  )
    .bind(effectId)
    .run();
  expect(
    await readLatestAgentRunSave({
      db: fixtureDatabase(),
      archive: env.ARCHIVE,
      organisationId: organisation,
      userId: owner.identity.userId,
      surfaceSessionId,
    }),
  ).toEqual({ kind: "none" });
  const repaired = await savePreparedAgentWorkspaceRun(
    organisation,
    mutateAs.bind(null, owner.session),
    prepared,
    effectId,
    readAs.bind(null, owner.session),
  );
  expect(repaired).toEqual(saved);
  const mismatched = await send(savePath, owner.session, {
    expectedId: edited.id,
    name: edited.snapshot.name,
    document: JSON.parse(edited.snapshot.file),
    agentEffectId: effectId,
  });
  expect(mismatched.status).toBe(409);
  const retried = await savePreparedAgentWorkspaceRun(
    organisation,
    mutateAs.bind(null, owner.session),
    prepared,
    effectId,
    readAs.bind(null, owner.session),
  );
  expect(retried).toEqual(saved);
  const reopened = await openRehearsalRunWorkspace(
    organisation,
    prepared.id,
    readAs.bind(null, owner.session),
    rehearsalSettings(sampleSettings()),
  );
  expect(reopened.plan.fingerprint).toBe(rehearsals.pending.fingerprint);

  // A previous conversation's unreadable receipt must not block this save's timeline.
  const historicalEffectId = `historical_${effectId}`;
  await fixtureDatabase().prepare(
    `INSERT INTO bakery_surface_effect_delivery (
       effect_id, organisation_id, user_id, session_id, turn_id,
       request_id, surface_session_id, surface_epoch, command_digest,
       effect_json, state_kind, receipt_json, deadline_at, created_at, updated_at
     ) SELECT ?, organisation_id, user_id, session_id, turn_id,
       'historical-chat-request', surface_session_id, surface_epoch, command_digest,
       effect_json, state_kind, '{}', deadline_at, created_at, updated_at
       FROM bakery_surface_effect_delivery WHERE effect_id = ?`,
  )
    .bind(historicalEffectId, effectId)
    .run();
  await fixtureDatabase().prepare(
    `INSERT INTO bakery_surface_timeline_event (
       organisation_id, user_id, session_id, turn_id, request_id,
       effect_id, event_kind, created_at
     ) SELECT organisation_id, user_id, session_id, turn_id, request_id,
       effect_id, 'settled', updated_at FROM bakery_surface_effect_delivery
       WHERE effect_id IN (?, ?)`,
  )
    .bind(historicalEffectId, effectId)
    .run();
  const timelineScope = {
    db: fixtureDatabase(),
    organisationId: organisation,
    userId: owner.identity.userId,
    requestIds: [backendRequestId],
    afterSequence: 0,
  };
  const events = await listBakerySurfaceTimelineEvents(timelineScope);
  expect(events).toHaveLength(1);
  expect(events[0]?.effect.effectId).toBe(effectId);
  expect(events[0]?.terminal.kind).toBe("settled");
  const stored = await readConversation(
    fixtureDatabase(),
    scope,
    admitted.conversation.id,
  );
  if (stored === null) throw new Error("Missing save conversation");
  const projected = await reconcileStoredBakerySurfaceTimeline(
    await requireOrganisationExecutionScope(env, scope.organisationId),
    scope.userId,
    stored,
  );
  expect(projected.conversation.timeline.at(-1)).toMatchObject({
    kind: "tool_settled",
    requestId: "operator-save-request",
    outcome: "succeeded",
    tool: { toolCallId: effectId },
  });
  expect(
    await reconcileStoredBakerySurfaceTimeline(
      await requireOrganisationExecutionScope(env, scope.organisationId),
      scope.userId,
      projected,
    ),
  ).toEqual(projected);
  await expect(
    listBakerySurfaceTimelineEvents({
      ...timelineScope,
      requestIds: ["historical-chat-request"],
    }),
  ).rejects.toThrow("surface_effect_timeline_invalid");
}

async function readAs(
  session: IssuedControlSession,
  path: string,
): Promise<unknown> {
  const response = await send(path, session);
  if (!response.ok) throw new Error(`Read failed: ${response.status}`);
  return response.json();
}

async function mutateAs(
  session: IssuedControlSession,
  path: string,
  body: unknown,
): Promise<unknown> {
  const response = await send(path, session, body);
  if (!response.ok) throw new Error(`Save failed: ${response.status}`);
  return response.json();
}

it(
  "binds shift and production scenario approvals to settled chat payloads and preserves pending recovery",
  scenarioApprovalJourney,
  60_000,
);

async function scenarioApprovalJourney(): Promise<void> {
  const owner = await client("bakery-chat-scenario");
  const otherAdmin = await client("bakery-chat-scenario-other-admin");
  const organisation = await workspace(owner, "Chat scenario approval");
  await fixtureDatabase().batch([
    fixtureDatabase().prepare(
      "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
    ).bind(organisation, "person_bakery_scenario_other_admin", "Other admin"),
    fixtureDatabase().prepare(
      "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'admin', 'active', ?, NULL)",
    ).bind(
      organisation,
      otherAdmin.identity.userId,
      "person_bakery_scenario_other_admin",
      Date.now(),
    ),
  ]);
  const merchantId = `merchant_bakery_c3_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(organisation, owner.identity.userId, merchantId);
  const sample = await sendScenario(
    `/v1/control/organisations/${organisation}/commerce/bakery/sample`,
    owner.session,
    {},
  );
  expect(sample.status, await sample.text()).toBe(200);
  const entityPlane = new CommerceEntityPlaneClient({
    baseUrl: "http://commerce.test",
    serviceToken: "commerce-e2e-token",
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  const source = await readBakeryProcedure(
    readBakeryGraph.bind(null, entityPlane, merchantId),
    customEntityRef("bakery_procedure", FINANCIER_SAMPLE_ID),
    sampleSettings(),
  );
  if (source.kind !== "ready") throw new Error(source.message);
  const sourceFingerprint = await bakeryFingerprint(
    source.procedure.revisionKey,
  );
  const settings = source.procedure.settings;
  const scenario = parseScenarioCopy({
    id: "scenario-chat-approved",
    name: "Reviewed shift",
    note: "Measured after the morning run",
    procedureId: FINANCIER_SAMPLE_ID,
    fingerprint: sourceFingerprint,
    settings,
  });
  if (scenario === null) throw new Error("Scenario fixture invalid");
  const assignment: ProductionAssignment = {
    batchId: "A",
    tray: 1,
    workerId: "human-1",
    dependsOn: ["batch:B:process:portion"],
    earliestStartSeconds: 0,
  };
  const assignments = [assignment];
  const manualTasks = [
    {
      bakeryTaskId: "batch:B:process:pack",
      workerId: "human-1" as const,
      dependsOn: ["batch:A:native:1"],
      earliestStartSeconds: 3600,
    },
  ];
  const production = parseProductionScenario({
    id: "production-chat-approved",
    name: "Reviewed production",
    note: "Measured oven assignment",
    procedureId: FINANCIER_SAMPLE_ID,
    sourceFingerprint,
    definitionFingerprint: await productionDefinitionFingerprint(
      sourceFingerprint,
      settings,
      "normal",
      assignments,
      manualTasks,
      { route: "cold-racking" },
    ),
    settings,
    variant: "normal",
    assignments,
    manualTasks,
    presentation: { [productionAssignmentId(assignment)]: { x: 94, y: 54 } },
  });
  if (production === null) throw new Error("Production fixture invalid");
  const payloads: readonly AgentScenarioSavePayload[] = [
    { kind: "scenario", copy: scenario },
    { kind: "production-scenario", copy: production },
  ];
  const completedSaves: {
    payload: AgentScenarioSavePayload;
    effectId: string;
  }[] = [];
  for (const payload of payloads) {
    const expired = await stageScenarioProposal(
      organisation,
      owner.identity.userId,
      payload,
    );
    await fixtureDatabase().prepare(
      "UPDATE bakery_surface_effect_delivery SET created_at = created_at - ?, updated_at = updated_at - ? WHERE effect_id = ?",
    )
      .bind(16 * 60_000, 16 * 60_000, expired.effectId)
      .run();
    const expiredJourney = new ScenarioSaveJourney(
      organisation,
      owner.session,
      expired.effectId,
    );
    expect((await expiredJourney.save(payload)).kind).toBe(
      "failed-before-save",
    );
    expect(expiredJourney.readCount).toBe(0);
    const staged = await stageScenarioProposal(
      organisation,
      owner.identity.userId,
      payload,
    );
    const path = `/v1/control/organisations/${organisation}/commerce/bakery/${payload.kind}`;
    const body = { ...payload.copy, agentEffectId: staged.effectId };
    const otherAdminResponse = await sendScenario(
      path,
      otherAdmin.session,
      body,
    );
    expect(otherAdminResponse.status).toBe(409);
    const changedResponse = await sendScenario(path, owner.session, {
      ...body,
      note: "Changed after approval",
    });
    expect(changedResponse.status).toBe(409);
    const unknownEffect = await sendScenario(path, owner.session, {
      ...body,
      agentEffectId: `surface_effect_${"0".repeat(40)}`,
    });
    expect(unknownEffect.status).toBe(409);
    const journey = new ScenarioSaveJourney(
      organisation,
      owner.session,
      staged.effectId,
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(journey.fetch.bind(journey));
    try {
      journey.loseSaveResponse = true;
      expect((await journey.save(payload)).kind).toBe("outcome-unknown");
      // Model interruption after Commerce commits and before the Actor's result settles.
      await fixtureDatabase().prepare(
        "UPDATE bakery_agent_scenario_save SET state_kind = 'approved', result_json = NULL WHERE effect_id = ?",
      )
        .bind(staged.effectId)
        .run();
      await verifyScenarioInspection(
        organisation,
        staged.effectId,
        payload,
        journey,
      );
      journey.failRead = true;
      expect((await journey.save(payload)).kind).toBe("saved-readback-failed");
      journey.failRead = false;
      const verified = await journey.save(payload);
      expect(verified.kind).toBe("verified");
      if (verified.kind !== "verified") throw new Error(verified.message);
      if ("scenario" in verified)
        expect(verified.scenario.copy).toEqual(payload.copy);
      else expect(verified.definition).toEqual(payload.copy);
    } finally {
      fetchSpy.mockRestore();
    }
    const persisted = await readBakeryGraph(
      entityPlane,
      merchantId,
      parseCommerceGraphQuery({
        kind: "entity_by_ref",
        reference: {
          origin: "custom",
          typeId:
            payload.kind === "scenario"
              ? "bakery_scenario"
              : "bakery_production_scenario",
          entityId: payload.copy.id,
        },
        traversal: { maxDepth: 2, resultLimit: 100 },
        filter: null,
      }),
    );
    expect(
      persisted.entities.some(entityHasId.bind(null, payload.copy.id)),
    ).toBe(true);
    const retry = await sendScenario(path, owner.session, body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      ok: true,
      scenarioId: payload.copy.id,
    });
    expect(
      await readLatestAgentScenarioSave({
        db: fixtureDatabase(),
        organisationId: organisation,
        userId: owner.identity.userId,
        surfaceSessionId: staged.surfaceSessionId,
      }),
    ).toEqual({
      kind: "saved",
      effectId: staged.effectId,
      manifest: staged.manifest,
      scenarioId: payload.copy.id,
    });
    expect(
      await readLatestAgentScenarioSave({
        db: fixtureDatabase(),
        organisationId: organisation,
        userId: otherAdmin.identity.userId,
        surfaceSessionId: staged.surfaceSessionId,
      }),
    ).toEqual({ kind: "none" });
    completedSaves.push({ payload, effectId: staged.effectId });
  }
  const current = await readBakeryProcedure(
    readBakeryGraph.bind(null, entityPlane, merchantId),
    customEntityRef("bakery_procedure", FINANCIER_SAMPLE_ID),
    settings,
  );
  if (current.kind !== "ready") throw new Error(current.message);
  const bake = current.procedure.operations.find(isBakeOperation);
  if (bake === undefined) throw new Error("Missing bake operation");
  const changedSource = await sendScenario(
    `/v1/control/organisations/${organisation}/commerce/bakery/operation`,
    owner.session,
    {
      entityId: bake.reference.entityId,
      expectedRevision: bake.revision,
      snapshot: current.procedure.snapshotRevision,
      minutes: 16,
    },
  );
  expect(changedSource.status, await changedSource.text()).toBe(200);
  for (const completed of completedSaves) {
    const path = `/v1/control/organisations/${organisation}/commerce/bakery/${completed.payload.kind}`;
    const retry = await sendScenario(path, owner.session, {
      ...completed.payload.copy,
      agentEffectId: completed.effectId,
    });
    expect(retry.status).toBe(200);
    const stale = await stageScenarioProposal(
      organisation,
      owner.identity.userId,
      completed.payload,
    );
    const staleJourney = new ScenarioSaveJourney(
      organisation,
      owner.session,
      stale.effectId,
    );
    expect((await staleJourney.save(completed.payload)).kind).toBe(
      "failed-before-save",
    );
    expect(staleJourney.readCount).toBe(0);
  }
}

function isBakeOperation(operation: ProcedureOperation): boolean {
  return operation.operation === "bake";
}

async function stageScenarioProposal(
  organisationId: string,
  userId: string,
  payload: AgentScenarioSavePayload,
) {
  const surfaceSessionId = crypto.randomUUID();
  const effectId = `surface_effect_${crypto.randomUUID().replaceAll("-", "")}${"a".repeat(8)}`;
  const manifest = await agentScenarioSaveManifest(payload);
  const command = {
    schemaVersion: 1 as const,
    kind: "prepare_scenario_save" as const,
    target: { surfaceSessionId, surfaceEpoch: 0 },
    name: payload.copy.name,
    note: payload.copy.note,
  };
  const active: BakerySurfaceContextV1["active"] =
    payload.kind === "scenario"
      ? {
          kind: "shift",
          source: "procedure",
          view: {
            dock: "closed",
            camera: "perspective",
            labels: "auto",
            minimap: false,
            chrome: "shown",
          },
          sourceIdentity: {
            kind: "procedure",
            id: payload.copy.procedureId,
            revision: "revision-1",
            snapshotRevision: "1",
          },
          variant: "normal",
          selection: { kind: "batch", id: "A", label: "Batch A" },
          selectedTask: null,
          playback: { cursorSeconds: 0, playback: "paused", speed: 1 },
          draft: { revision: 0, digest: "a".repeat(64) },
          pendingEdit: null,
          scenarioSaveProposal: manifest,
          run: {
            state: "complete",
            endSeconds: 0,
            lateBatches: 0,
            unfinishedBatches: 0,
          },
        }
      : {
          kind: "production",
          view: { camera: "perspective" },
          pendingOperation: null,
          panel: "files",
          readiness: "loading",
          planFingerprint: null,
          variant: null,
          operationCount: 0,
          operations: [],
          selection: null,
          playback: null,
          candidate: null,
          scenarioSaveProposal: manifest,
          draft: null,
        };
  const context: BakerySurfaceContextV1 = {
    schemaVersion: 1,
    kind: "bakery-workspace",
    runOpenReview: null,
    surfaceSessionId,
    surfaceEpoch: 0,
    capturedAt: Date.now(),
    comparison: null,
    simulation: null,
    supportedCommands: ["inspect_surface", "prepare_scenario_save"],
    active,
  };
  const effect = await createBakerySurfaceEffect({
    effectId,
    dispatchId: `surface_dispatch_${crypto.randomUUID().replaceAll("-", "")}`,
    deadlineAt: Date.now() + 20_000,
    command,
  });
  const receipt = await createBakerySurfaceReceipt(effect, {
    kind: "completed",
    result: {
      kind: "succeeded",
      command: "prepare_scenario_save",
      surface: await createBakerySurfaceAttachment(context),
      output: { kind: "scenario_save_proposal", manifest },
    },
  });
  const now = Date.now();
  await fixtureDatabase().prepare(
    `INSERT INTO bakery_surface_effect_delivery (
      effect_id, organisation_id, user_id, session_id, turn_id,
      request_id, surface_session_id, surface_epoch, command_digest,
      effect_json, state_kind, receipt_json, deadline_at, created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?, ?, ?)`,
  )
    .bind(
      effectId,
      organisationId,
      userId,
      "chat-scenario-session",
      "chat-scenario-turn",
      "chat-scenario-request",
      surfaceSessionId,
      0,
      effect.commandDigest,
      JSON.stringify(effect),
      JSON.stringify(receipt),
      effect.deadlineAt,
      now,
      now,
    )
    .run();
  return { effectId, surfaceSessionId, manifest };
}

async function sendScenario(
  path: string,
  session: IssuedControlSession,
  body: unknown,
): Promise<Response> {
  const requestHeaders = headers(session);
  requestHeaders.set("idempotency-key", crypto.randomUUID());
  return exports.default.fetch(`https://localhost${path}`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

function entityHasId(
  id: string,
  entity: Awaited<ReturnType<typeof readBakeryGraph>>["entities"][number],
): boolean {
  return entity.reference.entityId === id;
}

async function readBakeryGraph(
  client: CommerceEntityPlaneClient,
  merchantId: string,
  query: CommerceGraphQuery,
) {
  const result = await client.query(merchantId, query);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

class ScenarioSaveJourney {
  loseSaveResponse = false;
  failRead = false;
  readCount = 0;

  constructor(
    private readonly organisationId: string,
    private readonly session: IssuedControlSession,
    private readonly effectId: string,
  ) {}

  async save(payload: AgentScenarioSavePayload) {
    const origin = { kind: "agent_effect", effectId: this.effectId } as const;
    const mutate = this.mutate.bind(this);
    switch (payload.kind) {
      case "scenario":
        return savePreparedScenarioCopy(
          { organisationId: this.organisationId, mutate },
          payload.copy,
          origin,
        );
      case "production-scenario":
        return savePreparedProductionScenario(
          this.organisationId,
          mutate,
          payload.copy,
          origin,
        );
    }
  }

  async mutate(path: string, body: unknown): Promise<unknown> {
    const response = await sendScenario(path, this.session, body);
    if (response.ok && this.loseSaveResponse) {
      this.loseSaveResponse = false;
      throw new Error("Acceptance fault: committed save response lost");
    }
    return responseJson(response);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.readCount++;
    if (this.failRead)
      return Response.json({ error: "unavailable" }, { status: 503 });
    const path = input instanceof Request ? input.url : String(input);
    const url = new URL(path, "https://localhost");
    if (url.origin !== "https://localhost")
      throw new Error("Unexpected acceptance origin");
    const request = new Request(url, init);
    const authenticatedHeaders = headers(this.session);
    for (const [key, value] of request.headers)
      authenticatedHeaders.set(key, value);
    return exports.default.fetch(
      new Request(request, { headers: authenticatedHeaders }),
    );
  }
}

async function verifyScenarioInspection(
  organisationId: string,
  effectId: string,
  payload: AgentScenarioSavePayload,
  journey: ScenarioSaveJourney,
): Promise<void> {
  let state = initialSimulatorState("closed");
  if (payload.kind === "production-scenario")
    state = applyBakeryWorkspaceAction(
      { kind: "openProduction" },
      applyBakeryWorkspaceAction({ kind: "openRehearsal" }, state),
    );
  state = applyBakeryWorkspaceAction(
    {
      kind: "scenarioSaveProposed",
      payload,
      manifest: await agentScenarioSaveManifest(payload),
      effectId,
    },
    state,
  );
  state = applyBakeryWorkspaceAction(
    { kind: "scenarioSaveStarted", effectId },
    state,
  );
  state = applyBakeryWorkspaceAction(
    {
      kind: "scenarioSaveSettled",
      effectId,
      outcome: { kind: "outcome-unknown", message: "Lost acknowledgement" },
    },
    state,
  );
  const command = {
    schemaVersion: 1,
    kind: "inspect_scenario_save",
    target: {
      surfaceSessionId: state.workspace.surfaceSessionId,
      surfaceEpoch: state.workspace.surfaceEpoch,
    },
  } as const;
  const workspace = {
    organisationId,
    readAttachment: unavailableScenarioFile,
    read: unavailableInspectionRead,
    readDefinition: readProductionScenario,
    readScenario,
  };
  const inspection = await prepareBakerySurfaceCommand(
    state,
    command,
    sha256Hex,
    workspace,
  );
  if (inspection.kind !== "scenario_inspection")
    throw new Error("Scenario inspection unavailable");
  expect(inspection.inspection).toEqual({
    kind: "outcome-unknown",
    manifest: await agentScenarioSaveManifest(payload),
    readback: "verified",
  });
  expect(validatePreparedBakerySurfaceRead(state, inspection)).toBeNull();
  const receipt = await createBakerySurfaceReceipt(
    await createBakerySurfaceEffect({
      effectId: `inspect_${effectId}`,
      dispatchId: `dispatch_${effectId}`,
      deadlineAt: Date.now() + 30_000,
      command,
    }),
    {
      kind: "completed",
      result: await bakerySurfaceCommandSucceeded(state, inspection),
    },
  );
  expect(parseBakerySurfaceReceipt(receipt).kind).toBe("valid");
  expect(
    await fixtureDatabase().prepare(
      "SELECT state_kind FROM bakery_agent_scenario_save WHERE effect_id = ?",
    )
      .bind(effectId)
      .first(),
  ).toEqual({ state_kind: "approved" });
  journey.failRead = true;
  const failed = await prepareBakerySurfaceCommand(
    state,
    command,
    sha256Hex,
    workspace,
  );
  if (failed.kind !== "scenario_inspection")
    throw new Error("Scenario inspection unavailable");
  expect(failed.inspection).toMatchObject({
    kind: "outcome-unknown",
    readback: "unavailable",
  });
  journey.failRead = false;
  const retrying = applyBakeryWorkspaceAction(
    { kind: "scenarioSaveStarted", effectId },
    state,
  );
  expect(validatePreparedBakerySurfaceRead(retrying, inspection)?.code).toBe(
    "stale_surface",
  );
  const verified = applyBakeryWorkspaceAction(
    {
      kind: "scenarioSaveSettled",
      effectId,
      outcome: { kind: "verified", message: "Recovered" },
    },
    retrying,
  );
  const completed = await prepareBakerySurfaceCommand(
    verified,
    command,
    sha256Hex,
    workspace,
  );
  if (completed.kind !== "scenario_inspection")
    throw new Error("Scenario inspection unavailable");
  expect(completed.inspection.kind).toBe("verified");
}

async function unavailableInspectionRead(): Promise<never> {
  throw new Error("Scenario inspection cannot read run snapshots");
}

function unavailableScenarioFile(): never {
  throw new Error("No file in scenario inspection");
}

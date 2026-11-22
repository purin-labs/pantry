import { evictDurableObject } from "cloudflare:test";
import { fixtureDatabase } from "./organisation-database";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import {
  parseCanvasServerMessage,
  encodeCanvasClientMessage,
  type CanvasServerMessage,
} from "@purin-labs/workflow-canvas-crdt/protocol";
import { WorkflowCanvasDoc, CanvasEncoding } from "@purin-labs/workflow-canvas-crdt";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { isRecord, sha256Hex } from "@purin-labs/std";
import { parseApplianceWorkflow } from "@purin-labs/bakery-model/bakery-appliance-workflow";
import { parseRunSnapshot } from "@purin-labs/bakery-model/bakery-run-snapshot";
import interrupted from "../../../../assets/bakery-mujoco/combined-bakery/rust-evidence/shared-run-interrupted.json";
import {
  commerceClient,
  commerceWorkspace,
  commerceHeaders,
} from "./commerce-support";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";

it(
  "saves an appliance run and shares its canvas positions with organisation-scoped access",
  savedApplianceJourney,
);
async function savedApplianceJourney(): Promise<void> {
  const owner = await commerceClient("appliance-owner");
  const viewer = await commerceClient("appliance-viewer");
  const foreign = await commerceClient("appliance-foreign");
  const organisation = await commerceWorkspace(owner, "Shared appliance acceptance");
  const foreignOrganisation = await commerceWorkspace(
    foreign,
    "Foreign appliance workspace",
  );
  await ensureCreatedOrganisationActor({ env, organisationId: organisation, now: Date.now() });
  await ensureCreatedOrganisationActor({
    env,
    organisationId: foreignOrganisation,
    now: Date.now(),
  });
  await fixtureDatabase().batch([
    fixtureDatabase().prepare(
      "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
    ).bind(organisation, "person_appliance_viewer", "Viewer"),
    fixtureDatabase().prepare(
      "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'viewer', 'active', ?, NULL)",
    ).bind(
      organisation,
      viewer.identity.userId,
      "person_appliance_viewer",
      Date.now(),
    ),
  ]);
  const snapshot = parseRunSnapshot({
    name: "Interrupted financier",
    document: interrupted,
  });
  if (snapshot === null) throw new Error("Invalid appliance fixture");
  const id = await sha256Hex(snapshot.content);
  const runs = `/v1/control/organisations/${organisation}/bakery/runs`;
  const save = { expectedId: id, name: snapshot.name, document: interrupted };
  expect((await send(owner.session, runs, save)).status).toBe(201);
  expect((await send(owner.session, runs, save)).status).toBe(200);
  const stored = parseRunSnapshot(await read(viewer.session, `${runs}/${id}`));
  if (stored === null || stored.content !== snapshot.content)
    throw new Error("The saved copy differs from the submitted run.");
  const plan = parseApplianceWorkflow(stored.file);
  const documentId = `run:${id}`;
  const path = `/v1/control/organisations/${organisation}/collaboration/workflow-canvas/${encodeURIComponent(documentId)}`;
  const before = await read(owner.session, path);
  if (!isRecord(before) || !isRecord(before.value))
    throw new Error("Missing canvas snapshot.");
  const move = {
    documentId,
    operationId: crypto.randomUUID(),
    expectedRevision: before.value.documentRevision,
    objectId: interrupted.layout[1]?.objectId,
    x: 500,
    y: 220,
  };
  const ownerSocket = await openSocket(owner.session, path);
  const viewerSocket = await openSocket(viewer.session, path);
  const vector = CanvasEncoding.parse("state_vector", new Uint8Array([0]));
  if (!vector.ok) throw new Error("Missing canvas state vector.");
  const sync = new CanvasMessageWaiter(viewerSocket, "sync_response");
  viewerSocket.send(
    encodeCanvasClientMessage({
      kind: "sync_request",
      stateVector: vector.value,
    }),
  );
  const synced = await sync.promise;
  if (synced.kind !== "sync_response")
    throw new Error("Missing synchronization.");
  expect(synced.access).toBe("read");
  const encoding = CanvasEncoding.parse("state", synced.missingUpdate.encode());
  if (!encoding.ok) throw new Error("Missing synchronized canvas state.");
  const restored = WorkflowCanvasDoc.restore(encoding.value, plan.layout);
  if (!restored.ok) throw new Error("Invalid synchronized canvas membership.");
  const replica = restored.value;
  const broadcast = new CanvasMessageWaiter(viewerSocket, "update_broadcast");
  const moved = await mutate(owner.session, `${path}/move`, move);
  expect(moved).toMatchObject({ ok: true, value: { kind: "accepted" } });
  const update = await broadcast.promise;
  if (update.kind !== "update_broadcast")
    throw new Error("Missing peer update.");
  expect(replica.apply(update.update).ok).toBe(true);
  expect(replica.snapshot().objects.map(canvasPoint)).toContainEqual({
    objectId: move.objectId,
    x: 500,
    y: 220,
  });
  replica.destroy();
  ownerSocket.close();
  viewerSocket.close();
  await evictDurableObject(
    await requireActiveOrganisationActor({ env, organisationId: organisation, now: Date.now() }),
  );
  const peer = await read(viewer.session, path);
  expect(peer).toMatchObject({
    ok: true,
    value: {
      objects: expect.arrayContaining([
        {
          objectId: move.objectId,
          label: "Heat ingredient fixture",
          x: 500,
          y: 220,
        },
      ]),
    },
  });
  expect((await send(viewer.session, `${path}/move`, move)).status).toBe(404);
  expect((await send(foreign.session, path)).status).toBe(404);
  // A saved-run canvas whose run this Organisation never saved has no source.
  expect((await send(owner.session, path.replace(id, "f".repeat(64)))).status).toBe(503);
  const invalidMove = await mutate(owner.session, `${path}/move`, {
    ...move,
    operationId: crypto.randomUUID(),
    objectId: "unlisted-appliance",
    expectedRevision: 2,
  });
  expect(invalidMove).toMatchObject({
    ok: true,
    value: { kind: "object_conflict" },
  });
  const tampered = structuredClone(interrupted);
  tampered.initialBatch.mass_kg = 0.6;
  expect(
    (
      await send(owner.session, runs, {
        name: "Invalid custody",
        document: tampered,
        expectedId: "0".repeat(64),
      })
    ).status,
  ).toBe(422);
  await fixtureDatabase().prepare(
    "UPDATE service_role_grant SET status = 'revoked', revoked_at = ? WHERE organisation_id = ? AND user_id = ?",
  )
    .bind(Date.now(), organisation, viewer.identity.userId)
    .run();
  expect((await send(viewer.session, path)).status).toBe(404);
  console.log(
    JSON.stringify({
      journey: "appliance-saved-run-shared-canvas",
      passed: true,
      snapshotId: id,
      canvas: peer,
      denied: [
        "viewer-write",
        "foreign-organisation",
        "missing-source",
        "tampered-custody",
        "unlisted-node",
        "revoked-viewer",
      ],
    }),
  );
}
async function send(
  session: IssuedControlSession,
  path: string,
  body?: unknown,
): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: commerceHeaders(session),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function read(
  session: IssuedControlSession,
  path: string,
): Promise<unknown> {
  const response = await send(session, path);
  if (!response.ok)
    throw new Error(`Read failed: ${response.status} ${await response.text()}`);
  return response.json();
}
async function mutate(
  session: IssuedControlSession,
  path: string,
  body: unknown,
): Promise<unknown> {
  const response = await send(session, path, body);
  if (!response.ok)
    throw new Error(
      `Write failed: ${response.status} ${await response.text()}`,
    );
  return response.json();
}

async function openSocket(
  session: IssuedControlSession,
  path: string,
): Promise<WebSocket> {
  const headers = new Headers(commerceHeaders(session));
  headers.set("Upgrade", "websocket");
  headers.set("Origin", "https://localhost");
  const response = await exports.default.fetch(
    `https://localhost${path}/socket`,
    { headers },
  );
  if (response.status !== 101 || response.webSocket === null)
    throw new Error(`Socket failed: ${response.status}`);
  response.webSocket.accept();
  return response.webSocket;
}
class CanvasMessageWaiter {
  readonly promise: Promise<CanvasServerMessage>;
  private resolve: (message: CanvasServerMessage) => void = ignoreMessage;
  constructor(
    private readonly socket: WebSocket,
    private readonly kind: CanvasServerMessage["kind"],
  ) {
    this.promise = new Promise(this.initialize.bind(this));
    this.socket.addEventListener("message", this.received);
  }
  private initialize(resolve: (message: CanvasServerMessage) => void): void {
    this.resolve = resolve;
  }
  private received = (event: MessageEvent): void => {
    const parsed = parseCanvasServerMessage(event.data);
    if (!parsed.ok || parsed.value.kind !== this.kind) return;
    this.socket.removeEventListener("message", this.received);
    this.resolve(parsed.value);
  };
}
function ignoreMessage(_message: CanvasServerMessage): void {}

function canvasPoint(point: {
  toJSON(): Readonly<{ objectId: string; x: number; y: number }>;
}): Readonly<{ objectId: string; x: number; y: number }> {
  return point.toJSON();
}

import { setTimeout as delay } from "node:timers/promises";
import { fixtureDatabase } from "./organisation-database";
import { CODE_MODE_PILOT_BUDGET } from "@purin-labs/agent/actors/code-mode-budget";
import { measureCanvasRefresh } from "./canvas-refresh-support";
import {
  parseCanvasServerMessage,
  type CanvasServerMessage,
} from "@purin-labs/workflow-canvas-crdt/protocol";
import { parseChat } from "@purin-labs/control-api/portal/chat";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { writeOrganisationCapabilityPolicy } from "@purin-labs/authority/data/capability-policy";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { OrganisationDO } from "../../src/actors/organisation";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord, sha256Hex } from "@purin-labs/std";
import { parseRunSnapshot } from "@purin-labs/bakery-model/bakery-run-snapshot";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import {
  issueControlSession,
  type IssuedControlSession,
} from "@purin-labs/tenancy/data/control-plane";
import { parseUserId } from "@purin-labs/control-api/ids";
import { compilePublishAndActivateOrganisationPolicy } from "@purin-labs/authority/policy-snapshot";
import { bakeryRunSnapshotPrefix } from "@purin-labs/area-kitchen/server/bakery/saved-runs";
import { CONTEXT_CASE_READ_CAPABILITY } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import { encodeContextVisibility } from "@purin-labs/authority/authorization/access-grants/index";
import { FlowLabel } from "@purin-labs/authority/policy/information-flow/index";
import { network } from "./network";
import { commerceClient, commerceHeaders } from "./commerce-support";
import {
  ORGANISATION_ID,
  createRequiredGrant,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
} from "./slack-journey-support";
import interrupted from "../../../../assets/bakery-mujoco/combined-bakery/rust-evidence/shared-run-interrupted.json";
import { PLATFORM_DEFAULT_PI_MODEL } from "@purin-labs/agent/actors/pi-model-transport";

const CONVERSATION_ID = "conv_c55af3e2-19c2-446a-9f44-e00000000060";
const RETIRED_CANVAS_CONTEXT =
  "Retired shared canvas chat: old canvas moves were disabled.";

class CanvasModel {
  requests = 0;
  results: Record<string, unknown>[] = [];
  retiredContextRead = false;
  constructor(
    readonly documentId: string,
    readonly objectId: string,
    readonly otherDocumentId: string,
    readonly intervention:
      { kind: "none" } | { kind: "human"; session: IssuedControlSession },
  ) {}
  async respond(info: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const body: unknown = await info.request.json();
    if (!isRecord(body) || !Array.isArray(body.messages))
      throw new Error("Invalid model request");
    if (JSON.stringify(body.messages).includes(RETIRED_CANVAS_CONTEXT))
      this.retiredContextRead = true;
    this.results = body.messages.flatMap(toolResult);
    this.requests += 1;
    if (this.intervention.kind === "human" && this.requests === 5) {
      const undo = await exports.default.fetch(
        `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/workflow-canvas/${encodeURIComponent(this.documentId)}/undo`,
        {
          method: "POST",
          headers: commerceHeaders(this.intervention.session),
          body: JSON.stringify({
            expectedRevision: 2,
            operationId: "undo_agent_move",
          }),
        },
      );
      expect(await undo.json()).toMatchObject({
        ok: true,
        value: {
          kind: "accepted",
          receipt: { x: 20, y: 30, documentRevision: 3 },
        },
      });
      const moved = await exports.default.fetch(
        `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/workflow-canvas/${encodeURIComponent(this.documentId)}/move`,
        {
          method: "POST",
          headers: commerceHeaders(this.intervention.session),
          body: JSON.stringify({
            documentId: this.documentId,
            operationId: "human_canvas_intervention",
            objectId: this.objectId,
            expectedRevision: 3,
            x: 300,
            y: 180,
          }),
        },
      );
      expect(await moved.json()).toMatchObject({
        ok: true,
        value: { kind: "accepted" },
      });
      const blockedUndo = await exports.default.fetch(
        `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/workflow-canvas/${encodeURIComponent(this.documentId)}/undo`,
        {
          method: "POST",
          headers: commerceHeaders(this.intervention.session),
          body: JSON.stringify({
            expectedRevision: 4,
            operationId: "undo_after_human",
          }),
        },
      );
      expect(await blockedUndo.json()).toMatchObject({
        ok: true,
        value: { kind: "operation_conflict" },
      });
      return this.retryMove(3);
    }
    if (this.intervention.kind === "human" && this.requests === 6)
      return this.retryMove(4);
    const phase =
      this.intervention.kind === "human" && this.requests > 6
        ? this.requests - 2
        : this.requests;
    switch (phase) {
      case 1:
        return openRouterToolCall(
          "tool_search",
          {
            query: "workflow_canvas_read move_object bakery_saved_run_read",
            limit: 20,
          },
          "discover_canvas",
        );
      case 2:
        return openRouterToolCall(
          "bakery_saved_run_read",
          { id: this.documentId.slice(4), cursor: null },
          "read_saved",
        );
      case 3:
        return openRouterToolCall(
          "workflow_canvas_read",
          { documentId: this.documentId },
          "read_canvas",
        );
      case 4:
        if (this.intervention.kind === "human")
          await delay(CODE_MODE_PILOT_BUDGET.maxDurationMs + 1_000);
        return openRouterToolCall(
          "move_object",
          {
            documentId: this.documentId,
            objectId: namedCanvasObjectId(this.results[1]),
            expectedRevision: 1,
            x: 450,
            y: 220,
          },
          "move_canvas",
        );
      case 5:
        if (this.intervention.kind === "human")
          return openRouterToolCall(
            "move_object",
            {
              documentId: this.otherDocumentId,
              objectId: this.objectId,
              expectedRevision: 1,
              x: 450,
              y: 220,
            },
            "outside_canvas_move",
          );
        return openRouterToolCall(
          "workflow_canvas_read",
          { documentId: `run:${"0".repeat(64)}` },
          "missing_canvas",
        );
      case 6:
        if (this.intervention.kind === "human")
          return openRouterToolCall(
            "workflow_canvas_read",
            { documentId: this.otherDocumentId },
            "outside_canvas_read",
          );
        return this.reply();
      case 7:
        return openRouterToolCall(
          "workflow_canvas_read",
          { documentId: `run:${"0".repeat(64)}` },
          "missing_canvas",
        );
      default:
        return this.reply();
    }
  }
  private reply(): Response {
    return openRouterText(
      JSON.stringify({
        kind: "reply",
        text:
          this.intervention.kind === "human"
            ? "I moved the first step. Your later change remains in place."
            : "Canvas read complete; the shared edit was denied.",
      }),
      "canvas_done",
    );
  }
  private retryMove(expectedRevision: number): Response {
    return openRouterToolCall(
      "move_object",
      {
        documentId: this.documentId,
        objectId: this.objectId,
        expectedRevision,
        x: 450,
        y: 220,
      },
      `retry_move_${expectedRevision}`,
    );
  }
}

it(
  "reads a saved appliance canvas through the Tool Host and blocks private-context edits and missing sources",
  agentCanvasJourney.bind(null, false),
);
it(
  "applies shared-chat agent edits after slow inference and preserves the later human edit",
  agentCanvasJourney.bind(null, true),
  60_000,
);
it(
  "ends a script's canvas move with the script, also when the script starts late in its turn",
  scriptCanvasJourney,
  150_000,
);
async function agentCanvasJourney(
  shared: boolean,
  { task }: TestContext,
): Promise<void> {
  const session = await fixture(shared ? "operator" : "admin");
  const snapshot = parseRunSnapshot({
    name: "Agent canvas acceptance",
    document: interrupted,
  });
  if (snapshot === null) throw new Error("Invalid appliance fixture");
  const id = await sha256Hex(snapshot.content);
  await env.ARCHIVE.put(
    `${bakeryRunSnapshotPrefix(ORGANISATION_ID)}${id}`,
    snapshot.content,
    { customMetadata: { name: snapshot.name, kind: "appliance" } },
  );
  const other = parseRunSnapshot({
    name: "Other canvas",
    document: interrupted,
  });
  if (other === null) throw new Error("Invalid second fixture");
  const otherId = await sha256Hex(other.content);
  await env.ARCHIVE.put(
    `${bakeryRunSnapshotPrefix(ORGANISATION_ID)}${otherId}`,
    other.content,
    { customMetadata: { name: other.name, kind: "appliance" } },
  );
  const objectId = interrupted.layout[0]?.objectId;
  if (objectId === undefined) throw new Error("Missing fixture node");
  let conversationId = CONVERSATION_ID;
  if (shared) {
    await seedRetiredCanvasContext();
    const opened = await exports.default.fetch(
      `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/workflow-canvas/${encodeURIComponent(`run:${id}`)}/chat`,
      { method: "POST", headers: commerceHeaders(session) },
    );
    const chat: unknown = await opened.json();
    expect(opened.status, JSON.stringify(chat)).toBe(200);
    if (!isRecord(chat) || typeof chat.conversationId !== "string")
      throw new Error("Missing canvas chat");
    conversationId = chat.conversationId;
  }
  const model = new CanvasModel(
    `run:${id}`,
    objectId,
    `run:${otherId}`,
    shared ? { kind: "human", session } : { kind: "none" },
  );
  const peerWindow = await watchCanvas(session, model.documentId);
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
  );
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat${shared ? `?canvas=${encodeURIComponent(model.documentId)}` : ""}`,
    {
      method: "POST",
      headers: commerceHeaders(session),
      body: JSON.stringify({
        kind: "message",
        conversationId,
        requestId: "request_agent_canvas",
        model: PLATFORM_DEFAULT_PI_MODEL,
        text: "Move the first saved appliance canvas node to 450,220.",
        browserContext: {
          kind: "available",
          binding: {
            browserInstanceId: "browser_agent_canvas",
            conversationId,
          },
        },
      }),
    },
  );
  expect(response.status).toBe(200);
  await response.body?.cancel();
  await expect
    .poll(requestCount.bind(null, model), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1);
  if (shared) expect(model.retiredContextRead).toBe(false);
  await expect
    .poll(requestCount.bind(null, model), { timeout: 50_000 })
    .toBeGreaterThanOrEqual(shared ? 10 : 6);
  expect(model.results).toHaveLength(shared ? 8 : 4);
  expect(model.results[0]).toMatchObject({
    success: true,
    code_mode_value: { kind: "saved_bakery_run" },
  });
  expect(model.results[1]).toMatchObject({
    success: true,
    code_mode_value: {
      documentId: model.documentId,
      documentRevision: 1,
      objects: expect.arrayContaining([
        expect.objectContaining({ objectId, label: "Weigh ingredients" }),
      ]),
    },
  });
  expect(model.results[2]).toMatchObject({ success: shared });
  if (shared) {
    expect(model.results[3]).toMatchObject({
      success: true,
      code_mode_value: { kind: "human_intervention" },
    });
    expect(model.results[4]).toMatchObject({
      success: true,
      code_mode_value: { kind: "human_intervention" },
    });
  }
  expect(model.results[shared ? 7 : 3]).toMatchObject({ success: false });
  const canvas = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/workflow-canvas/${encodeURIComponent(model.documentId)}`,
    { headers: commerceHeaders(session) },
  );
  const result: unknown = await canvas.json();
  expect(result).toMatchObject({
    ok: true,
    value: {
      documentRevision: shared ? 4 : 1,
      objects: expect.arrayContaining([
        {
          objectId,
          label: "Weigh ingredients",
          x: shared ? 300 : 20,
          y: shared ? 180 : 30,
        },
      ]),
    },
  });
  if (shared) {
    expect(peerWindow.events).toContainEqual(
      expect.objectContaining({
        kind: "presence_changed",
        agents: expect.arrayContaining([
          expect.objectContaining({
            target: objectId,
            agent: expect.objectContaining({ displayName: "Sous Chef" }),
          }),
        ]),
      }),
    );
    expect(peerWindow.events.filter(isCanvasUpdate)).toHaveLength(3);
    // The shared chat signals this canvas's room sockets among the edits.
    expect(peerWindow.events.filter(isChatChanged).length).toBeGreaterThan(0);
  } else {
    expect(peerWindow.events.filter(isCanvasUpdate)).toHaveLength(0);
    expect(peerWindow.events.flatMap(canvasActivity).flat()).toHaveLength(0);
  }
  if (shared)
    await expect
      .poll(() => peerWindow.events.flatMap(canvasActivity).at(-1), {
        timeout: 15_000,
      })
      .toEqual([]);
  const activities = peerWindow.events.flatMap(canvasActivity);
  Object.assign(task.meta, {
    cursorActivity: {
      source: "authorized room WebSocket",
      target: objectId,
      activities,
      terminal: shared ? "idle" : "no agent activity",
      chatChangedFrames: peerWindow.events.filter(isChatChanged).length,
    },
  });
  peerWindow.socket.close();
  if (shared) {
    expect(model.results[5]).toMatchObject({ success: false });
    expect(model.results[6]).toMatchObject({ success: false });
    const otherCanvas = await exports.default.fetch(
      `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/workflow-canvas/${encodeURIComponent(model.otherDocumentId)}`,
      { headers: commerceHeaders(session) },
    );
    expect(await otherCanvas.json()).toMatchObject({
      ok: true,
      value: { documentRevision: 1 },
    });
    const continuation = await verifyContinuation(
      session,
      conversationId,
      model.documentId,
    );
    await verifyPeerAccess(continuation.conversationId, model.documentId);
    Object.assign(task.meta, {
      canvasRefresh: continuation.refresh,
    });
  }
  Object.assign(task.meta, {
    agentCanvas: {
      snapshotId: id,
      read: "accepted",
      agentMove: shared
        ? "accepted; human intervention preserved"
        : "private context denied",
      missingSource: "denied",
      retiredContextRead: model.retiredContextRead,
      unchangedCanvas: result,
    },
  });
}
/**
 * Moves two canvas objects from one Code Mode script. The script starts after
 * the first 30 seconds of its turn, so a deadline taken from the turn lease has
 * passed before the script begins.
 */
class ScriptCanvasModel {
  requests = 0;
  scriptStartedAt: number | null = null;
  scriptResult = "";
  constructor(
    readonly documentId: string,
    readonly first: string,
    readonly second: string,
  ) {}
  async respond(info: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const body: unknown = await info.request.json();
    if (!isRecord(body) || !Array.isArray(body.messages))
      throw new Error("Invalid model request");
    this.requests += 1;
    switch (this.requests) {
      case 1:
        return openRouterToolCall(
          "tool_search",
          { query: "workflow_canvas_read move_object", limit: 20 },
          "discover_canvas",
        );
      case 2:
        await delay(CODE_MODE_PILOT_BUDGET.maxDurationMs + 1_000);
        this.scriptStartedAt = Date.now();
        return openRouterToolCall(
          "codemode",
          {
            code: [
              scriptMove(this.documentId, this.first, 1, 450, 220),
              scriptMove(this.documentId, this.second, 2, 460, 240),
              'text("both moves returned");',
            ].join("\n"),
          },
          "move_in_script",
        );
      default:
        this.scriptResult = JSON.stringify(body.messages.at(-1));
        return openRouterText(
          JSON.stringify({
            kind: "reply",
            text: "The script ran out of time after the first move.",
          }),
          "script_done",
        );
    }
  }
}
function scriptMove(
  documentId: string,
  objectId: string,
  expectedRevision: number,
  x: number,
  y: number,
): string {
  const move = { documentId, objectId, expectedRevision, x, y };
  return `await tools.move_object(${JSON.stringify(move)});`;
}
async function scriptCanvasJourney({ task, onTestFinished }: TestContext) {
  const session = await fixture("operator");
  const snapshot = parseRunSnapshot({
    name: "Script canvas acceptance",
    document: interrupted,
  });
  if (snapshot === null) throw new Error("Invalid appliance fixture");
  const id = await sha256Hex(snapshot.content);
  await env.ARCHIVE.put(
    `${bakeryRunSnapshotPrefix(ORGANISATION_ID)}${id}`,
    snapshot.content,
    { customMetadata: { name: snapshot.name, kind: "appliance" } },
  );
  const [first, second] = interrupted.layout;
  if (first === undefined || second === undefined)
    throw new Error("Missing fixture nodes");
  const documentId = `run:${id}`;
  const opened = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/workflow-canvas/${encodeURIComponent(documentId)}/chat`,
    { method: "POST", headers: commerceHeaders(session) },
  );
  const chat: unknown = await opened.json();
  if (!isRecord(chat) || typeof chat.conversationId !== "string")
    throw new Error("Missing canvas chat");
  const model = new ScriptCanvasModel(
    documentId,
    first.objectId,
    second.objectId,
  );
  const moves = await holdScriptMoves(onTestFinished, model);
  const peerWindow = await watchCanvas(session, documentId);
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
  );
  const response = await submitCanvasRequest(session, documentId, {
    kind: "message",
    conversationId: chat.conversationId,
    requestId: "request_script_canvas",
    model: PLATFORM_DEFAULT_PI_MODEL,
    text: "Move the first two canvas steps in one script.",
    browserContext: {
      kind: "available",
      binding: {
        browserInstanceId: "browser_script_canvas",
        conversationId: chat.conversationId,
      },
    },
  });
  expect(response.status).toBe(200);
  await response.body?.cancel();
  await expect
    .poll(requestCount.bind(null, model), { timeout: 120_000 })
    .toBeGreaterThanOrEqual(3);
  // The script stopped at its deadline, with the second move still held, so
  // its last line never ran.
  expect(model.scriptResult).not.toContain("both moves returned");
  const canvas = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/workflow-canvas/${encodeURIComponent(documentId)}`,
    { headers: commerceHeaders(session) },
  );
  const result: unknown = await canvas.json();
  // The first move ran inside the script's window, although the script
  // started more than 30 seconds into its turn. The second move reached the
  // canvas after the script had ended, and it changed nothing.
  expect(result).toMatchObject({
    ok: true,
    value: {
      documentRevision: 2,
      objects: expect.arrayContaining([
        expect.objectContaining({ objectId: first.objectId, x: 450, y: 220 }),
        expect.objectContaining({
          objectId: second.objectId,
          x: second.x,
          y: second.y,
        }),
      ]),
    },
  });
  expect(peerWindow.events.filter(isCanvasUpdate)).toHaveLength(1);
  peerWindow.socket.close();
  Object.assign(task.meta, {
    scriptCanvas: {
      snapshotId: id,
      scriptStartedAfterTurnMs: CODE_MODE_PILOT_BUDGET.maxDurationMs + 1_000,
      organisationMoves: moves,
      scriptResult: model.scriptResult,
      canvasUpdates: 1,
      canvas: result,
    },
  });
}
/**
 * Holds each canvas move of the script at the Organisation Actor. The first
 * move commits well inside the script's window, so the second move starts
 * late in it. The second move reaches the room only after the script's
 * deadline, and before the edit deadline that a direct call would have.
 */
async function holdScriptMoves(
  onTestFinished: TestContext["onTestFinished"],
  model: ScriptCanvasModel,
): Promise<string[]> {
  const outcomes: string[] = [];
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  await runInDurableObject(
    organisation,
    holdMoves.bind(null, onTestFinished, model, outcomes),
  );
  return outcomes;
}
function holdMoves(
  onTestFinished: TestContext["onTestFinished"],
  model: ScriptCanvasModel,
  outcomes: string[],
  actor: unknown,
): void {
  if (!(actor instanceof OrganisationDO))
    throw new Error("Unexpected Organisation Actor");
  const prototype: unknown = Object.getPrototypeOf(actor);
  if (!isRecord(prototype)) throw new Error("Unexpected Organisation Actor");
  const original = actor.moveWorkflowCanvasObject;
  let arrivals = 0;
  Object.defineProperty(prototype, "moveWorkflowCanvasObject", {
    value: async function heldMove(
      this: OrganisationDO,
      input: Parameters<OrganisationDO["moveWorkflowCanvasObject"]>[0],
    ) {
      arrivals += 1;
      const releaseAt =
        arrivals === 1
          ? Date.now() + 20_000
          : (model.scriptStartedAt ?? Date.now()) +
            CODE_MODE_PILOT_BUDGET.maxDurationMs +
            1_500;
      await delay(Math.max(0, releaseAt - Date.now()));
      const moved = await original.call(this, input);
      outcomes.push(moveOutcome(moved));
      return moved;
    },
    configurable: true,
    writable: true,
  });
  onTestFinished(restoreMove.bind(null, prototype, original));
}
function restoreMove(prototype: object, original: unknown): void {
  Object.defineProperty(prototype, "moveWorkflowCanvasObject", {
    value: original,
    configurable: true,
    writable: true,
  });
}
function moveOutcome(result: unknown): string {
  if (!isRecord(result)) return "unknown";
  if (isRecord(result.value) && typeof result.value.kind === "string")
    return result.value.kind;
  if (isRecord(result.error) && typeof result.error.code === "string")
    return result.error.code;
  return "unknown";
}
function canvasActivity(message: CanvasServerMessage) {
  return message.kind === "presence_changed" ? [message.agents] : [];
}
function namedCanvasObjectId(result: unknown): string {
  if (!isRecord(result) || !isRecord(result.code_mode_value))
    throw new Error("Canvas tool did not return its layout");
  const objects = result.code_mode_value.objects;
  if (!Array.isArray(objects))
    throw new Error("Canvas tool did not return its objects");
  for (const object of objects) {
    if (
      isRecord(object) &&
      object.label === "Weigh ingredients" &&
      typeof object.objectId === "string"
    )
      return object.objectId;
  }
  throw new Error("Canvas tool did not identify the named step");
}
async function seedRetiredCanvasContext(): Promise<void> {
  const label = await FlowLabel.create([
    {
      owner: { kind: "organisation", organisationId: ORGANISATION_ID },
      readers: [
        { kind: "organisation_role", role: "owner" },
        { kind: "organisation_role", role: "admin" },
        { kind: "organisation_role", role: "operator" },
        { kind: "organisation_role", role: "viewer" },
      ],
    },
  ]);
  if (!label.ok) throw new Error(label.error.code);
  const source = {
    kind: "case_entry",
    caseId: "case_11111111111111111111111111111111",
    entryId: "retired_canvas_request",
  };
  const visibility = { kind: "organisation_role", role: "operator" } as const;
  const now = Date.now();
  await fixtureDatabase()
    .prepare(
      `INSERT INTO context_projection
    (organisation_id, source_kind, source_key, source_json, source_revision,
     source_revision_json, lifecycle, content_digest, visibility_json,
     visibility_key, flow_label_json, indexed_at, bounded_text, model_text,
     provenance_json, created_at, updated_at)
    VALUES (?, 'case_entry', ?, ?, 1, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      ORGANISATION_ID,
      `${source.caseId}\u0000${source.entryId}`,
      JSON.stringify(source),
      JSON.stringify({ kind: "case_entry", sequence: 1 }),
      await sha256Hex(RETIRED_CANVAS_CONTEXT),
      JSON.stringify(visibility),
      encodeContextVisibility(visibility),
      JSON.stringify(label.value),
      now,
      RETIRED_CANVAS_CONTEXT,
      RETIRED_CANVAS_CONTEXT,
      JSON.stringify({
        kind: "case_entry",
        replayAuthority: { kind: "partition_independent" },
      }),
      now,
      now,
    )
    .run();
}
function toolResult(message: unknown): Record<string, unknown>[] {
  if (
    !isRecord(message) ||
    message.role !== "tool" ||
    typeof message.content !== "string" ||
    !message.content.startsWith("{")
  )
    return [];
  const result: unknown = JSON.parse(message.content);
  return isRecord(result) ? [result] : [];
}
function requestCount(model: { readonly requests: number }): number {
  return model.requests;
}
async function fixture(
  role: "operator" | "admin",
): Promise<IssuedControlSession> {
  // The Slack fixture makes the one account attach of the Organisation. It
  // admits the Slack actor and the canvas peer, who becomes a viewer below.
  const peer = await commerceClient("canvas-peer");
  await installSlackActorFixture();
  const operator = await commerceClient("e2e-slack-actor");
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id,person_id,display_name) VALUES (?, 'person_canvas_peer', 'Canvas peer')",
      )
      .bind(ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id,user_id,person_id,role,status,created_at,revoked_at) VALUES (?,?,'person_canvas_peer','viewer','active',?,NULL)",
      )
      .bind(ORGANISATION_ID, peer.identity.userId, Date.now()),
    fixtureDatabase()
      .prepare(
        "UPDATE service_role_grant SET role = ? WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(role, ORGANISATION_ID, operator.identity.userId),
    fixtureDatabase()
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_canvas', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(Date.now(), ORGANISATION_ID),
  ]);
  for (const capabilityId of [
    CONTEXT_CASE_READ_CAPABILITY,
    "commerce.entity_plane.context",
    "commerce.workflow_canvas.move",
    "workspace.query",
  ]) {
    await createRequiredGrant({
      grantId: `grant_canvas_${capabilityId}`,
      subject: { kind: "organisation_role", role },
      target: {
        kind: "platform_capability",
        capabilityId,
        capabilityVersion: 1,
      },
      now: Date.now(),
    });
  }
  const userId = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!userId.ok) throw new Error(userId.error.code);
  for (const capabilityId of [
    "commerce.entity_plane.context",
    "commerce.workflow_canvas.move",
    "workspace.query",
  ] as const) {
    const changed = await writeOrganisationCapabilityPolicy({
      scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
      write: {
        kind: "change",
        capabilityId,
        expectedRevision: 1,
        mode: "enabled",
        provenance: {
          kind: "operator",
          userId: userId.value,
          mutationReceiptId: "receipt_canvas_capabilities",
        },
        now: Date.now(),
      },
    });
    if (!changed.ok) throw new Error(changed.error.code);
  }
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now: Date.now(),
  });
  if (!policy.ok) throw new Error(policy.error.code);
  return issueControlSession({
    db: env.DB,
    userId: userId.value,
    now: Date.now(),
    ttlMs: 1_800_000,
  });
}

async function verifyPeerAccess(
  conversationId: string,
  documentId: string,
): Promise<void> {
  const peer = await commerceClient("e2e-slack-actor");
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'viewer' WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, peer.identity.userId)
    .run();
  const url = `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/workflow-canvas/${encodeURIComponent(documentId)}/chat`;
  await expect
    .poll(readPeerConversation.bind(null, peer.session, url), {
      timeout: 10_000,
    })
    .toMatchObject({
      conversation: { id: conversationId, work: { kind: "ready" } },
    });
  const preview = await readPeerConversation(peer.session, url);
  if (!isRecord(preview)) throw new Error("Missing public chat");
  expect(parseChat(preview.conversation).messages.length).toBeGreaterThan(0);
  const opened = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/workflow-canvas/${encodeURIComponent(documentId)}/chat`,
    { method: "POST", headers: commerceHeaders(peer.session) },
  );
  expect(await opened.json()).toEqual({ conversationId });
  const denied = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat?canvas=${encodeURIComponent(documentId)}`,
    {
      method: "POST",
      headers: commerceHeaders(peer.session),
      body: JSON.stringify({
        kind: "message",
        conversationId,
        requestId: "request_viewer_canvas",
        model: PLATFORM_DEFAULT_PI_MODEL,
        text: "Move a node",
        browserContext: { kind: "unavailable" },
      }),
    },
  );
  expect(denied.status).toBe(404);
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET status='revoked',revoked_at=? WHERE organisation_id=? AND user_id=?",
    )
    .bind(Date.now(), ORGANISATION_ID, peer.identity.userId)
    .run();
  expect(
    (
      await exports.default.fetch(`${url}?after=${preview.cursor}`, {
        headers: commerceHeaders(peer.session),
      })
    ).status,
  ).toBe(404);
}
async function verifyContinuation(
  session: IssuedControlSession,
  conversationId: string,
  documentId: string,
) {
  const url = `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/workflow-canvas/${encodeURIComponent(documentId)}/chat`;
  const before = await readPeerConversation(session, url);
  if (!isRecord(before) || typeof before.cursor !== "string")
    throw new Error("Missing chat cursor");
  expect(
    await readPeerConversation(session, `${url}?after=${before.cursor}`),
  ).toEqual({ kind: "unchanged" });
  const replay = await submitCanvasRequest(session, documentId, {
    kind: "message",
    conversationId,
    requestId: "request_agent_canvas",
    model: PLATFORM_DEFAULT_PI_MODEL,
    text: "Move the first saved appliance canvas node to 450,220.",
    browserContext: {
      kind: "available",
      binding: { browserInstanceId: "browser_agent_canvas", conversationId },
    },
  });
  expect(replay.status).toBe(200);
  const replayBody: unknown = await replay.json();
  expect(replayBody).toMatchObject({
    conversation: { id: conversationId, work: { kind: "ready" } },
  });
  const continuations = await Promise.all([
    postCanvasContinuation(session, url, conversationId),
    postCanvasContinuation(session, url, conversationId),
  ]);
  expect(continuations[1]).toEqual(continuations[0]);
  const next = continuations[0];
  if (!isRecord(next) || typeof next.conversationId !== "string")
    throw new Error("Missing next conversation");
  expect(next.conversationId).not.toBe(conversationId);
  expect(await readPeerConversation(session, url)).toMatchObject({
    kind: "ready",
    currentConversationId: next.conversationId,
    conversation: { id: next.conversationId, messages: [] },
    conversations: expect.arrayContaining([
      { id: conversationId, generation: 1 },
      { id: next.conversationId, generation: 2 },
    ]),
  });
  const previous = await readPeerConversation(
    session,
    `${url}?conversation=${conversationId}`,
  );
  expect(previous).toMatchObject({ conversation: { id: conversationId } });
  if (!isRecord(previous)) throw new Error("Missing earlier history");
  expect(parseChat(previous.conversation).messages.length).toBeGreaterThan(0);
  const denied = await submitCanvasRequest(session, documentId, {
    kind: "message",
    conversationId,
    requestId: "retired_request",
    model: PLATFORM_DEFAULT_PI_MODEL,
    text: "Do not edit from an earlier conversation",
    browserContext: { kind: "unavailable" },
  });
  expect(denied.status).toBe(409);
  const sent = await submitCanvasRequest(session, documentId, {
    kind: "message",
    conversationId: next.conversationId,
    requestId: "next_canvas_request",
    model: PLATFORM_DEFAULT_PI_MODEL,
    text: "Inspect the current canvas",
    browserContext: { kind: "unavailable" },
  });
  expect(sent.status).toBe(200);
  await sent.body?.cancel();
  await expect
    .poll(readPeerConversation.bind(null, session, url), { timeout: 15000 })
    .toMatchObject({
      conversation: { id: next.conversationId, work: { kind: "ready" } },
    });
  await verifyInterruptedCanvasRequest(
    session,
    documentId,
    next.conversationId,
    url,
  );
  const viewer = await commerceClient("e2e-slack-actor");
  const refresh = await measureCanvasRefresh(
    session,
    documentId,
    next.conversationId,
    viewer.identity.userId,
  );
  console.log(
    "CANVAS_CONTINUATION_EVIDENCE",
    JSON.stringify({
      prior: conversationId,
      current: next.conversationId,
      concurrentCreation: "one next conversation",
      priorHistory: "readable",
      priorWrites: "denied",
      idleCursor: "unchanged",
      replay: "accepted once",
    }),
  );
  return { refresh, conversationId: next.conversationId };
}
class InterruptedCanvasModel {
  fail = true;
  calls = 0;
  respond(): Response {
    this.calls += 1;
    if (this.fail)
      return Response.json(
        {
          error: {
            message: "Temporary fixture failure",
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      );
    return openRouterText(
      JSON.stringify({
        kind: "reply",
        text: "The interrupted canvas request recovered.",
      }),
      "recovered_canvas",
    );
  }
}
async function verifyInterruptedCanvasRequest(
  session: IssuedControlSession,
  documentId: string,
  conversationId: string,
  url: string,
): Promise<void> {
  const provider = new InterruptedCanvasModel();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
  );
  const requestId = "interrupted_canvas_request";
  const started = await submitCanvasRequest(session, documentId, {
    kind: "message",
    conversationId,
    requestId,
    model: PLATFORM_DEFAULT_PI_MODEL,
    text: "Recover this request",
    browserContext: { kind: "unavailable" },
  });
  expect(started.status).toBe(200);
  await started.body?.cancel();
  await expect
    .poll(readPeerConversation.bind(null, session, url), { timeout: 20000 })
    .toMatchObject({ conversation: { work: { kind: "failed", requestId } } });
  provider.fail = false;
  const retried = await submitCanvasRequest(session, documentId, {
    kind: "retry",
    conversationId,
    requestId,
    model: PLATFORM_DEFAULT_PI_MODEL,
  });
  expect(retried.status).toBe(200);
  await retried.body?.cancel();
  await expect
    .poll(readPeerConversation.bind(null, session, url), { timeout: 20000 })
    .toMatchObject({ conversation: { work: { kind: "ready" } } });
  console.log(
    "CANVAS_RECOVERY_EVIDENCE",
    JSON.stringify({
      requestId,
      providerCalls: provider.calls,
      retry: "recovered original request",
    }),
  );
}
async function postCanvasContinuation(
  session: IssuedControlSession,
  url: string,
  conversationId: string,
): Promise<unknown> {
  const response = await exports.default.fetch(`${url}/continue`, {
    method: "POST",
    headers: commerceHeaders(session),
    body: JSON.stringify({ conversationId }),
  });
  expect(response.status).toBe(200);
  return response.json();
}
async function submitCanvasRequest(
  session: IssuedControlSession,
  documentId: string,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat?canvas=${encodeURIComponent(documentId)}`,
    {
      method: "POST",
      headers: commerceHeaders(session),
      body: JSON.stringify(body),
    },
  );
}
async function readPeerConversation(
  session: IssuedControlSession,
  url: string,
): Promise<unknown> {
  const response = await exports.default.fetch(url, {
    headers: commerceHeaders(session),
  });
  return response.json();
}

class CanvasObserver {
  readonly events: CanvasServerMessage[] = [];
  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", this.receive.bind(this));
  }
  private receive(event: MessageEvent): void {
    const parsed = parseCanvasServerMessage(event.data);
    if (parsed.ok) this.events.push(parsed.value);
  }
}
async function watchCanvas(
  session: IssuedControlSession,
  documentId: string,
): Promise<CanvasObserver> {
  const headers = new Headers(commerceHeaders(session));
  headers.set("Upgrade", "websocket");
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/workflow-canvas/${encodeURIComponent(documentId)}/socket`,
    { headers },
  );
  if (response.webSocket === null) throw new Error("Canvas socket unavailable");
  response.webSocket.accept();
  return new CanvasObserver(response.webSocket);
}
function isCanvasUpdate(event: CanvasServerMessage): boolean {
  return event.kind === "update_broadcast";
}
function isChatChanged(event: CanvasServerMessage): boolean {
  return event.kind === "chat_changed";
}

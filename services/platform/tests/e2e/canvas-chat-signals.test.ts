import interrupted from "../../../../assets/bakery-mujoco/combined-bakery/rust-evidence/shared-run-interrupted.json";
import { fixtureDatabase } from "./organisation-database";
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { http } from "msw";
import { expect, it, type TestContext } from "vitest";
import { COLLABORATION_PONG } from "@purin-labs/collaboration";
import { parseChatSignal } from "@purin-labs/control-api";
import { isRecord, sha256Hex } from "@purin-labs/std";
import { parseRunSnapshot } from "@purin-labs/bakery-model/bakery-run-snapshot";
import { parseCanvasServerMessage } from "@purin-labs/workflow-canvas-crdt/protocol";

import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import type { OrganisationDO } from "../../src/actors/organisation";
import { bakeryRunSnapshotPrefix } from "../../src/commerce/bakery/saved-runs";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import { createAccessGrant } from "../../src/data/access-grants";
import type { IssuedControlSession } from "../../src/data/control-plane";
import type { OrganisationId } from "../../src/ids";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { organisationBootstrapMutation } from "../control-mutation-fixture";
import { requireOrganisationBootstrap } from "../organisation-execution-fixture";
import {
  PUBLIC_ORIGIN,
  closeSocket,
  createControlClient,
  expectPong,
  openSocket,
  type ControlClient,
} from "./hibernatable-socket-support";
import { control } from "./chat-journey-support";
import { network } from "./network";
import { openRouterText, requiredPlacement } from "./slack-journey-support";
import { PLATFORM_DEFAULT_PI_MODEL } from "../../src/actors/pi-model-transport";

// A frame that has not come within this time does not come.
const QUIET_MS = 750;
const REQUEST_TEXT = "Arrange the proofing steps before the bake.";
const REPLY_TEXT = "The proofing steps now come before the bake.";

it(
  "signals a teammate's canvas chat message on the open canvas page while the Organisation sleeps, and sends no frame to a page without canvas access",
  canvasChatSignalJourney,
);

async function canvasChatSignalJourney({ task }: TestContext): Promise<void> {
  const scenario = await installCanvasScenario();
  const { organisationId, owner, teammate, leaver, canvas, otherCanvas } =
    scenario;
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", canvasReply),
  );
  const conversationId = await openCanvasChat(
    organisationId,
    owner.session,
    canvas,
  );
  const ownerPage = await openCanvasPage(organisationId, owner, canvas);
  const otherCanvasPage = await openCanvasPage(
    organisationId,
    owner,
    otherCanvas,
  );
  const leaverPage = await openCanvasPage(organisationId, leaver, canvas);
  const ownerChatPage = new FrameLog(
    await openSocket(
      `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/chat/signals`,
      owner.session,
    ),
  );
  try {
    const opened = await readCanvasChat(organisationId, owner.session, canvas);
    if (opened.kind !== "ready")
      throw new Error("the canvas chat did not open");
    let read: ReadyCanvasChat = opened;

    // The leaver's role ends while the leaver's canvas page stays open.
    await fixtureDatabase()
      .prepare(
        `UPDATE service_role_grant SET status = 'revoked', revoked_at = ?
        WHERE organisation_id = ? AND user_id = ?`,
      )
      .bind(Date.now(), organisationId, leaver.identity.userId)
      .run();

    // The Organisation leaves memory and the canvas pages stay connected.
    await evictDurableObject(scenario.organisation);
    await expectPong(ownerPage.socket);

    // The teammate asks the canvas agent. The owner's page reads on each
    // frame, as the canvas chat does, until it shows the settled answer.
    const turnFrom = ownerPage.chatFrames();
    const sent = await control(
      organisationId,
      teammate.session,
      `chat?canvas=${encodeURIComponent(canvas)}`,
      "POST",
      {
        kind: "message",
        conversationId,
        requestId: "canvas_signal_request",
        model: PLATFORM_DEFAULT_PI_MODEL,
        text: REQUEST_TEXT,
        browserContext: { kind: "unavailable" },
      },
    );
    expect(sent.status, await sent.clone().text()).toBe(200);
    await sent.body?.cancel();
    let reads = 0;
    let frame = turnFrom;
    while (read.work !== "ready" || !read.text.includes(REPLY_TEXT)) {
      frame = await ownerPage.nextChatFrame(frame);
      reads += 1;
      const next = await readCanvasChat(
        organisationId,
        owner.session,
        canvas,
        read.cursor,
      );
      if (next.kind === "ready") read = next;
    }
    expect(read.text).toContain(REQUEST_TEXT);
    const turnFrames = ownerPage.chatFrames() - turnFrom;

    // The Organisation leaves memory again. The teammate starts the next
    // conversation, and the owner's open page reads it as the current one.
    await evictDurableObject(scenario.organisation);
    await expectPong(ownerPage.socket);
    const continueFrom = ownerPage.chatFrames();
    const continued = await control(
      organisationId,
      teammate.session,
      `collaboration/workflow-canvas/${encodeURIComponent(canvas)}/chat/continue`,
      "POST",
      { conversationId },
    );
    expect(continued.status).toBe(200);
    const next: unknown = await continued.json();
    if (!isRecord(next) || typeof next.conversationId !== "string")
      throw new Error("the next canvas conversation is missing");
    await ownerPage.nextChatFrame(continueFrom);
    const current = await readCanvasChat(
      organisationId,
      owner.session,
      canvas,
      read.cursor,
    );
    expect(current).toMatchObject({
      kind: "ready",
      currentConversationId: next.conversationId,
    });

    // No frame reached the other canvas, the leaver's open page or the chat
    // page. The leaver's read through the checked route is refused.
    await quiet();
    expect(otherCanvasPage.chatFrames()).toBe(0);
    expect(leaverPage.chatFrames()).toBe(0);
    expect(ownerChatPage.chatSignals()).toBe(0);
    expect(
      (
        await control(
          organisationId,
          leaver.session,
          `collaboration/workflow-canvas/${encodeURIComponent(canvas)}/chat`,
          "GET",
          null,
        )
      ).status,
    ).toBe(404);
    await expectPong(ownerPage.socket);

    Object.assign(task.meta, {
      canvasChatSignals: {
        turn: { frames: turnFrames, reads, settled: "answer shown" },
        continuation: { frames: ownerPage.chatFrames() - continueFrom },
        evictions: 2,
        ownerSocket: "open after each eviction",
        otherCanvasFrames: otherCanvasPage.chatFrames(),
        revokedPageFrames: leaverPage.chatFrames(),
        chatPageSignals: ownerChatPage.chatSignals(),
        revokedRead: 404,
      },
    });
  } finally {
    await Promise.all(
      [ownerPage, otherCanvasPage, leaverPage, ownerChatPage].map(
        closeLoggedSocket,
      ),
    );
  }
}

type CanvasScenario = Readonly<{
  organisationId: OrganisationId;
  owner: ControlClient;
  teammate: ControlClient;
  leaver: ControlClient;
  organisation: DurableObjectStub<OrganisationDO>;
  canvas: string;
  otherCanvas: string;
}>;

async function installCanvasScenario(): Promise<CanvasScenario> {
  const now = Date.now() - 1_000;
  const owner = await createControlClient("canvas-signals-owner", "Owner");
  const teammate = await createControlClient(
    "canvas-signals-teammate",
    "Teammate",
  );
  const leaver = await createControlClient("canvas-signals-leaver", "Leaver");
  const created = await requireOrganisationBootstrap({
    env,
    owner: owner.identity,
    organisationName: "Canvas chat signals",
    environment: "development",
    placement: requiredPlacement(),
    mutation: organisationBootstrapMutation(owner.identity, now),
    now,
  });
  const organisationId = created.organisationId;
  await fixtureDatabase().batch([
    ...memberRows(organisationId, "teammate", teammate, "admin", now),
    ...memberRows(organisationId, "leaver", leaver, "operator", now),
    fixtureDatabase()
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'receipt_canvas_signals', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(now, organisationId),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_inference_selection
        (organisation_id, selection_kind, selected_by_user_id, selected_at)
       VALUES (?, 'satyr_platform', ?, ?)
       ON CONFLICT (organisation_id) DO UPDATE SET selection_kind = 'satyr_platform'`,
      )
      .bind(organisationId, owner.identity.userId, now),
  ]);
  await ensureCreatedOrganisationActor({ env, organisationId, now });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now,
  });
  for (const role of ["owner", "admin"] as const) {
    const grant = await createAccessGrant({
      db: fixtureDatabase(),
      organisationId,
      grantId: `grant_canvas_signals_${role}`,
      subject: { kind: "organisation_role", role },
      target: {
        kind: "platform_capability",
        capabilityId: "context.case.read",
        capabilityVersion: 1,
      },
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: "receipt_canvas_signals",
      },
      now,
    });
    if (!grant.ok) throw new Error(grant.error.code);
  }
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId,
    organisation,
    now: Date.now(),
  });
  if (!policy.ok) throw new Error(policy.error.code);
  return {
    organisationId,
    owner,
    teammate,
    leaver,
    organisation,
    canvas: await archiveCanvas(organisationId, "Proofing canvas"),
    otherCanvas: await archiveCanvas(organisationId, "Lamination canvas"),
  };
}

function memberRows(
  organisationId: OrganisationId,
  name: string,
  client: ControlClient,
  role: "admin" | "operator",
  now: number,
): D1PreparedStatement[] {
  const personId = `person_canvas_signals_${name}`;
  return [
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(organisationId, personId, client.identity.displayName),
    fixtureDatabase()
      .prepare(
        `INSERT INTO service_role_grant
        (organisation_id, user_id, person_id, role, status, created_at, revoked_at)
       VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
      )
      .bind(organisationId, client.identity.userId, personId, role, now),
  ];
}

/** Saves an appliance run, whose canvas is `run:<snapshot>`. */
async function archiveCanvas(
  organisationId: OrganisationId,
  name: string,
): Promise<string> {
  const snapshot = parseRunSnapshot({ name, document: interrupted });
  if (snapshot === null) throw new Error("invalid appliance fixture");
  const id = await sha256Hex(snapshot.content);
  await env.ARCHIVE.put(
    `${bakeryRunSnapshotPrefix(organisationId)}${id}`,
    snapshot.content,
    { customMetadata: { name: snapshot.name, kind: snapshot.kind } },
  );
  return `run:${id}`;
}

function canvasReply(): Response {
  return openRouterText(
    JSON.stringify({ kind: "reply", text: REPLY_TEXT }),
    "canvas_signal_reply",
  );
}

async function openCanvasChat(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  canvas: string,
): Promise<string> {
  const response = await control(
    organisationId,
    session,
    `collaboration/workflow-canvas/${encodeURIComponent(canvas)}/chat`,
    "POST",
    null,
  );
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  if (!isRecord(body) || typeof body.conversationId !== "string")
    throw new Error("the canvas chat is missing");
  return body.conversationId;
}

/** A canvas page's room socket, as the canvas page opens it. */
async function openCanvasPage(
  organisationId: OrganisationId,
  client: ControlClient,
  canvas: string,
): Promise<FrameLog> {
  const page = new FrameLog(
    await openSocket(
      `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/collaboration/workflow-canvas/${encodeURIComponent(canvas)}/socket`,
      client.session,
    ),
  );
  // A refused socket closes after its failure frame; an accepted one answers.
  await expectPong(page.socket);
  return page;
}

type ReadyCanvasChat = Readonly<{
  kind: "ready";
  cursor: string;
  currentConversationId: string;
  work: string;
  text: string;
}>;
type CanvasChatRead =
  Readonly<{ kind: "pending" | "unchanged" | "restricted" }> | ReadyCanvasChat;

async function readCanvasChat(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  canvas: string,
  after: string | null = null,
): Promise<CanvasChatRead> {
  const query = after === null ? "" : `?after=${after}`;
  const response = await control(
    organisationId,
    session,
    `collaboration/workflow-canvas/${encodeURIComponent(canvas)}/chat${query}`,
    "GET",
    null,
  );
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  if (
    isRecord(body) &&
    (body.kind === "pending" ||
      body.kind === "unchanged" ||
      body.kind === "restricted")
  )
    return { kind: body.kind };
  if (
    !isRecord(body) ||
    body.kind !== "ready" ||
    typeof body.cursor !== "string" ||
    typeof body.currentConversationId !== "string" ||
    !isRecord(body.conversation) ||
    !isRecord(body.conversation.work) ||
    typeof body.conversation.work.kind !== "string"
  )
    throw new Error(`invalid canvas chat read: ${JSON.stringify(body)}`);
  return {
    kind: "ready",
    cursor: body.cursor,
    currentConversationId: body.currentConversationId,
    work: body.conversation.work.kind,
    text: JSON.stringify(body.conversation),
  };
}

/**
 * The frames that a page's socket received: canvas `chat_changed` frames on
 * a canvas room socket, chat signals on a chat page's socket.
 */
type FrameWaiter = Readonly<{
  seen: number;
  resolve: (count: number) => void;
  timer: ReturnType<typeof setTimeout>;
}>;

class FrameLog {
  #chatFrames = 0;
  #chatSignals = 0;
  readonly #waiters = new Set<FrameWaiter>();

  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", this.#received.bind(this));
  }

  chatFrames(): number {
    return this.#chatFrames;
  }

  chatSignals(): number {
    return this.#chatSignals;
  }

  /** Waits until the socket has more than `seen` chat frames. */
  nextChatFrame(seen: number): Promise<number> {
    if (this.#chatFrames > seen) return Promise.resolve(this.#chatFrames);
    return new Promise((resolve, reject) => {
      const waiter: FrameWaiter = {
        seen,
        resolve,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error("the canvas chat frame did not arrive"));
        }, 20_000),
      };
      this.#waiters.add(waiter);
    });
  }

  #received(event: MessageEvent): void {
    if (event.data === COLLABORATION_PONG) return;
    const canvas = parseCanvasServerMessage(event.data);
    if (canvas.ok) {
      if (canvas.value.kind === "chat_changed") this.#chatFrames += 1;
    } else if (parseChatSignal(event.data) !== null) this.#chatSignals += 1;
    for (const waiter of this.#waiters)
      if (this.#chatFrames > waiter.seen) {
        this.#waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(this.#chatFrames);
      }
  }
}

function quiet(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, QUIET_MS));
}

function closeLoggedSocket(page: FrameLog): Promise<void> {
  return closeSocket(page.socket);
}

// Shared steps of the Plan 40B board journeys: open board editors on the
// board room, publish a board, pair a TV and read its feed, and approve a
// price card from Slack.
import { fixtureDatabase } from "./organisation-database";
import { exports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  parseMenuScreenFeed,
  parseMenuScreenPairing,
  parseMenuScreenPairingState,
  parseMenuScreenSignal,
  type MenuScreenFeed,
} from "@purin-labs/cafe-control-api";
import {
  MenuBoardDoc,
  type MenuBoardCrdtResult,
  type MenuBoardSnapshot,
  type MenuBoardUpdate,
} from "@purin-labs/menu-board-crdt";
import {
  encodeMenuBoardClientMessage,
  parseMenuBoardServerMessage,
  type MenuBoardServerMessage,
} from "@purin-labs/menu-board-crdt/protocol";
import { MenuDraftDoc } from "@purin-labs/menu-draft-crdt";
import {
  encodeMenuDraftClientMessage,
  parseMenuDraftServerMessage,
} from "@purin-labs/menu-draft-crdt/protocol";
import { isRecord } from "@purin-labs/std";
import { http, HttpResponse } from "msw";
import { enableCapability } from "./access-route-support";
import { commerceClient } from "./commerce-support";
import { network } from "./network";
import { givePortalHandles } from "./permission-request-support";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { closeSocket, openSocket } from "./hibernatable-socket-support";
import {
  MERCHANT,
  installEffectAuthority,
  lastListingToolText,
  providerClient,
} from "./pi-sdk-effect-support";
import { signedButtonClick } from "./slack-side-case-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  USER_ID,
  createRequiredGrant,
  discoverSlackChannel,
  installSlackActorFixture,
  slackSimulator,
} from "./slack-journey-support";

export const ORIGIN = "https://localhost";
export const BASE = `${ORIGIN}/v1/control/organisations/${ORGANISATION_ID}`;

/**
 * One open board editor: a replica that applies every broadcast, as the
 * Portal's client does, and submits one update at a time.
 */
export class BoardPeer {
  readonly doc = MenuBoardDoc.createReplica();
  access: "read" | "edit" = "read";
  #listeners = new Set<(message: MenuBoardServerMessage) => void>();

  private constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event: MessageEvent) => {
      const parsed = parseMenuBoardServerMessage(event.data);
      if (!parsed.ok) return;
      const message = parsed.value;
      if (message.kind === "update_broadcast")
        applied(this.doc.apply(message.update));
      for (const listener of this.#listeners) listener(message);
    });
  }

  static async open(
    url: string,
    session: IssuedControlSession,
  ): Promise<BoardPeer> {
    const peer = new BoardPeer(await openSocket(url, session));
    const sync = await peer.#next("sync_response", () => {
      const vector = peer.doc.stateVector();
      if (!vector.ok) throw new Error(vector.error.code);
      peer.socket.send(
        encodeMenuBoardClientMessage({
          kind: "sync_request",
          stateVector: vector.value,
        }),
      );
    });
    if (sync.kind !== "sync_response") throw new Error("No board sync");
    peer.access = sync.access;
    applied(peer.doc.apply(sync.missingUpdate));
    return peer;
  }

  read(): MenuBoardSnapshot {
    return this.doc.read();
  }

  submit(
    updateId: string,
    result: MenuBoardCrdtResult<MenuBoardUpdate>,
  ): Promise<MenuBoardServerMessage> {
    if (!result.ok) throw new Error(result.error.code);
    const update = result.value;
    return this.#next("update_accepted", () =>
      this.socket.send(
        encodeMenuBoardClientMessage({
          kind: "submit_update",
          updateId,
          update,
        }),
      ),
    );
  }

  /** An edit made on a copy of the replica, which the room must refuse. */
  submitRefused(
    edit:
      string | ((copy: MenuBoardDoc) => MenuBoardCrdtResult<MenuBoardUpdate>),
  ): Promise<MenuBoardServerMessage> {
    const state = this.doc.state();
    if (!state.ok) throw new Error(state.error.code);
    const copy = MenuBoardDoc.restore(state.value);
    if (!copy.ok) throw new Error(copy.error.code);
    const result =
      typeof edit === "string"
        ? copy.value.updateElement(edit, { label: "Viewer pick" })
        : edit(copy.value);
    copy.value.destroy();
    if (!result.ok) throw new Error(result.error.code);
    const update = result.value;
    return this.#next(
      "failure",
      () =>
        this.socket.send(
          encodeMenuBoardClientMessage({
            kind: "submit_update",
            updateId: crypto.randomUUID(),
            update,
          }),
        ),
      true,
    );
  }

  #next(
    kind: MenuBoardServerMessage["kind"],
    send: () => void,
    expectFailure = false,
  ): Promise<MenuBoardServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#listeners.delete(listener);
        reject(new Error(`No ${kind} message`));
      }, 10_000);
      const listener = (message: MenuBoardServerMessage): void => {
        if (message.kind === "failure" && !expectFailure) {
          clearTimeout(timer);
          this.#listeners.delete(listener);
          reject(new Error(`Room failure: ${JSON.stringify(message)}`));
          return;
        }
        if (message.kind !== kind) return;
        clearTimeout(timer);
        this.#listeners.delete(listener);
        resolve(message);
      };
      this.#listeners.add(listener);
      send();
    });
  }
}

export function redactIds(text: string): string {
  return text
    .replace(/element_[0-9a-f]{16}/gu, "element_…")
    .replace(/comment_[0-9a-f]{20}/gu, "comment_…")
    .replace(/(item|board|section)_[0-9a-f]{20,32}/gu, "$1_…")
    .replace(/_[0-9a-f]{24}_[0-9a-f]{24}/gu, "_…")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu,
      "…",
    )
    .replace(
      /"(observedAt|publishedAt|expiresAt|createdAt|updatedAt|resolvedAt)":\s*\d+/gu,
      '"$1":0',
    );
}

export async function dropFromDraft(
  session: IssuedControlSession,
  itemId: string,
): Promise<void> {
  const socket = await openSocket(
    `${BASE}/collaboration/menu-draft/socket`,
    session,
  );
  const draft = MenuDraftDoc.createReplica();
  try {
    const sync = await nextDraftMessage(socket, "sync_response", () => {
      const vector = draft.stateVector();
      if (!vector.ok) throw new Error(vector.error.code);
      socket.send(
        encodeMenuDraftClientMessage({
          kind: "sync_request",
          stateVector: vector.value,
        }),
      );
    });
    if (sync.kind !== "sync_response") throw new Error("No menu sync");
    applied(draft.apply(sync.missingUpdate));
    const removed = draft.deleteItem(itemId);
    if (!removed.ok) throw new Error(removed.error.code);
    const update = removed.value;
    await nextDraftMessage(socket, "update_accepted", () =>
      socket.send(
        encodeMenuDraftClientMessage({
          kind: "submit_update",
          updateId: "drop-matcha",
          update,
        }),
      ),
    );
  } finally {
    draft.destroy();
    await closeSocket(socket);
  }
}

export function nextDraftMessage(
  socket: WebSocket,
  kind: string,
  send: () => void,
): Promise<
  ReturnType<typeof parseMenuDraftServerMessage> extends infer R
    ? R extends Readonly<{ ok: true; value: infer M }>
      ? M
      : never
    : never
> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`No ${kind} message`));
    }, 10_000);
    const onMessage = (event: MessageEvent): void => {
      const parsed = parseMenuDraftServerMessage(event.data);
      if (!parsed.ok) return;
      if (parsed.value.kind === "failure") {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        reject(new Error(`Draft failure: ${JSON.stringify(parsed.value)}`));
        return;
      }
      if (parsed.value.kind !== kind) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(parsed.value);
    };
    socket.addEventListener("message", onMessage);
    send();
  });
}

export function applied(
  result:
    Readonly<{ ok: true }> | Readonly<{ ok: false; error: { code: string } }>,
): void {
  if (!result.ok) throw new Error(result.error.code);
}

export function member(
  userId: string,
  personId: string,
  role: "operator" | "viewer",
): D1PreparedStatement[] {
  return [
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(
        ORGANISATION_ID,
        personId,
        role === "operator" ? "Staff" : "Viewer",
      ),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, ?, 'active', ?, NULL)",
      )
      .bind(ORGANISATION_ID, userId, personId, role, Date.now()),
  ];
}

/** The text that the tool returned, without the model request's wrapper. */
export function toolOutput(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.some((item) => isRecord(item) && item.role === "tool"))
    return "";
  const text = lastListingToolText(body);
  let wrapped: unknown;
  try {
    wrapped = JSON.parse(text);
  } catch {
    // A refused call answers in words, not JSON.
    return text;
  }
  return isRecord(wrapped) && typeof wrapped.output === "string"
    ? wrapped.output
    : JSON.stringify(wrapped);
}

export function draftItemId(toolText: string, displayName: string): string {
  const parsed: unknown = JSON.parse(toolText);
  const items =
    isRecord(parsed) &&
    isRecord(parsed.draft) &&
    Array.isArray(parsed.draft.items)
      ? (parsed.draft.items as unknown[])
      : [];
  for (const item of items)
    if (
      isRecord(item) &&
      item.displayName === displayName &&
      typeof item.id === "string"
    )
      return item.id;
  throw new Error(`No item ${displayName} in ${toolText}`);
}

export function delivered(slack: ReturnType<typeof slackSimulator>): string {
  return slack.messages.map((message) => message.text).join("\n");
}

export function readHeaders(
  session: IssuedControlSession,
): Record<string, string> {
  return {
    origin: ORIGIN,
    cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
    "x-satyr-csrf": session.csrfToken,
  };
}

export async function send(
  url: string,
  session: IssuedControlSession,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const headers: Record<string, string> = readHeaders(session);
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = crypto.randomUUID();
    headers["x-satyr-configuration-version"] = "1";
  }
  const response = await exports.default.fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

export async function menuRevision(
  session: IssuedControlSession,
): Promise<number> {
  const read = await send(`${BASE}/collaboration/menu-draft`, session, "GET");
  if (
    !isRecord(read.body) ||
    !isRecord(read.body.value) ||
    typeof read.body.value.revision !== "number"
  )
    throw new Error(`No draft revision: ${JSON.stringify(read.body)}`);
  return read.body.value.revision;
}

export function boardIdOf(body: unknown): string {
  if (
    !isRecord(body) ||
    !isRecord(body.board) ||
    typeof body.board.boardId !== "string"
  )
    throw new Error(`No board: ${JSON.stringify(body)}`);
  return body.board.boardId;
}

export async function publishBoard(
  session: IssuedControlSession,
  boardId: string,
  expectedReleaseRevision: number | null,
): Promise<number> {
  const list = await send(`${BASE}/menu-boards`, session, "GET");
  const boards =
    isRecord(list.body) && Array.isArray(list.body.boards)
      ? list.body.boards
      : [];
  const board: unknown = boards.find(
    (candidate: unknown) =>
      isRecord(candidate) && candidate.boardId === boardId,
  );
  if (!isRecord(board) || typeof board.documentRevision !== "number")
    throw new Error(`No board ${boardId}: ${JSON.stringify(list.body)}`);
  const release = await send(
    `${BASE}/menu-boards/${boardId}/releases`,
    session,
    "POST",
    {
      documentRevision: board.documentRevision,
      expectedReleaseRevision,
    },
  );
  expect(release.status, JSON.stringify(release.body)).toBe(201);
  if (
    !isRecord(release.body) ||
    !isRecord(release.body.release) ||
    typeof release.body.release.releaseRevision !== "number"
  )
    throw new Error(`No release: ${JSON.stringify(release.body)}`);
  return release.body.release.releaseRevision;
}

export async function pairScreen(
  session: IssuedControlSession,
  boardId: string,
): Promise<string> {
  const started = await exports.default.fetch(`${ORIGIN}/v1/screens/pairings`, {
    method: "POST",
  });
  expect(started.status).toBe(201);
  const pairing = parseMenuScreenPairing(await started.json());
  if (pairing === null) throw new Error("No pairing");
  const paired = await send(`${BASE}/menu-screens`, session, "POST", {
    code: pairing.code,
    name: "Counter TV",
    boardId,
  });
  expect(paired.status, JSON.stringify(paired.body)).toBe(201);
  const state = await exports.default.fetch(
    `${ORIGIN}/v1/screens/pairings/${pairing.pairingId}`,
    {
      headers: { Authorization: `Bearer ${pairing.secret}` },
    },
  );
  const collected = parseMenuScreenPairingState(await state.json());
  if (collected?.state !== "paired") throw new Error("Screen not paired");
  return collected.token;
}

export async function feed(token: string): Promise<MenuScreenFeed> {
  const response = await exports.default.fetch(`${ORIGIN}/v1/screens/feed`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const parsed = parseMenuScreenFeed(await response.json());
  if (parsed === null) throw new Error("The screen feed did not parse");
  return parsed;
}

export function entryOf(screen: MenuScreenFeed, itemId: string) {
  return screen.facts?.entries.find(
    (candidate) => candidate.menuEntryId === itemId,
  );
}

export async function offer(itemId: string) {
  const stock = await providerClient().readStockSnapshot(MERCHANT);
  if (!stock.ok) throw new Error(JSON.stringify(stock.error));
  const entry = stock.value.foodService.resources.menus
    .flatMap((menu) => menu.entries)
    .find((candidate) => candidate.menuEntryId === itemId);
  const found = stock.value.commerce.resources.offers.find(
    (candidate) => candidate.id === entry?.offerId,
  );
  if (found === undefined) throw new Error(`No offer for ${itemId}`);
  return found;
}

export async function click(nonce: string, noticeTs: string): Promise<void> {
  const response = await exports.default.fetch(
    await signedButtonClick({
      actionId: "commerce_action_approve",
      value: nonce,
      user: USER_ID,
      channel: CHANNEL_ID,
      threadTs: ROOT_TS,
      proposalTs: noticeTs,
    }),
  );
  expect(response.status).toBe(200);
}

export async function actionState(nonce: string): Promise<unknown> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const action = await organisation.getAction({
    organisationId: ORGANISATION_ID,
    nonce,
    now: Date.now(),
  });
  if (!action.ok) throw new Error(action.error.code);
  return action.value.state;
}

/** Slack's answer to a click on a card, at its response URL. */
export type ClickAnswer = Readonly<{
  ephemeral: boolean;
  replaceOriginal: boolean;
  text: string;
}>;

export type BoardJourney = Readonly<{
  owner: IssuedControlSession;
  staff: IssuedControlSession;
  viewer: IssuedControlSession;
  slack: ReturnType<typeof slackSimulator>;
  /** The Slack answers to card clicks, in order. */
  answers: ClickAnswer[];
  products: ReadonlyMap<string, string>;
}>;

/**
 * An Organisation with an owner, a member of staff and a viewer, Slack, the
 * board capabilities, and the café demo shop. `respond` answers each model
 * request, as a deterministic model would.
 */
export async function installBoardJourney(
  name: string,
  respond: (body: Record<string, unknown>) => Response | Promise<Response>,
): Promise<BoardJourney> {
  const staffClient = await commerceClient(`board-${name}-staff`);
  const viewerClient = await commerceClient(`board-${name}-viewer`);
  const fixture = await installSlackActorFixture({
    privateMember: {
      client: staffClient,
      laterPersonId: `person_${name}_staff`,
    },
    extraMembers: [
      { client: viewerClient, laterPersonId: `person_${name}_viewer` },
    ],
  });
  await fixtureDatabase().batch([
    ...member(staffClient.identity.userId, `person_${name}_staff`, "operator"),
    ...member(viewerClient.identity.userId, `person_${name}_viewer`, "viewer"),
  ]);
  const slack = slackSimulator();
  const answers: ClickAnswer[] = [];
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async function answerModel({ request }) {
        const body: unknown = await request.json();
        if (!isRecord(body)) throw new Error("Invalid model request");
        return respond(body);
      },
    ),
    http.post(
      "https://hooks.slack.com/actions/:team/:id/:token",
      async function recordAnswer({ request }) {
        const body: unknown = await request.json();
        if (!isRecord(body)) throw new Error("Invalid click answer");
        answers.push({
          ephemeral: body.response_type === "ephemeral",
          replaceOriginal: body.replace_original === true,
          text: String(body.text),
        });
        return HttpResponse.text("ok");
      },
    ),
  );
  const owner = await installEffectAuthority(
    fixture.selectedIntegrationAccountId,
    "plugin",
  );
  await givePortalHandles(ORGANISATION_ID);
  await discoverSlackChannel("public_channel", Date.now() - 60_000);
  for (const capabilityId of [
    "commerce.menu_draft.read",
    "commerce.menu_draft.edit",
  ] as const) {
    await enableCapability(ORGANISATION_ID, owner, capabilityId);
    await createRequiredGrant({
      grantId: `grant_${name}_${capabilityId.replaceAll(".", "_")}`,
      subject: { kind: "organisation_role", role: "owner" },
      target: {
        kind: "platform_capability",
        capabilityId,
        capabilityVersion: 1,
      },
      now: Date.now(),
    });
  }
  const shop = await providerClient().provisionDemo({
    schemaVersion: "underclerk.provision-demo.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  if (!shop.ok) throw new Error(JSON.stringify(shop.error));
  return {
    owner,
    staff: staffClient.session,
    viewer: viewerClient.session,
    slack,
    answers,
    products: new Map(
      shop.value.resources.products.map((product) => [
        product.title,
        product.id,
      ]),
    ),
  };
}

/** Resolves with the time of the next screen signal on a TV's socket. */
export function nextSignal(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("The screen got no signal"));
    }, 30_000);
    const onMessage = (event: MessageEvent): void => {
      if (!parseMenuScreenSignal(event.data)) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(Date.now());
    };
    socket.addEventListener("message", onMessage);
  });
}

/** The raw feed JSON, to check which keys a TV player from before receives. */
export async function rawFeed(token: string): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch(`${ORIGIN}/v1/screens/feed`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("The feed is not an object");
  return body;
}

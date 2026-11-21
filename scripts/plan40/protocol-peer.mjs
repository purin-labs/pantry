import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { createServer as createViteServer } from "../../apps/portal/node_modules/vite/dist/node/index.js";
import ws from "../../node_modules/.pnpm/ws@8.21.0/node_modules/ws/index.js";
import esbuild from "../../node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/lib/main.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const fixtureRoot = join(scriptDir, "fixture");
const { WebSocketServer } = ws;
const generatedRoot = await mkdtemp(join("/private/tmp", "pantry-plan40-peer-"));
await esbuild.build({
  entryPoints: [join(repoRoot, "packages/product-description-crdt/src/index.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: join(generatedRoot, "index.mjs"),
});
await esbuild.build({
  entryPoints: [join(repoRoot, "packages/product-description-crdt/src/protocol.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: join(generatedRoot, "protocol.mjs"),
});
const { ProductDescriptionDoc } = await import(pathToFileURL(join(generatedRoot, "index.mjs")));
const {
  encodeDraftServerMessage,
  parseDraftClientMessage,
  PRESENCE_EXPIRY_MS,
  SOCKET_LIMIT,
} = await import(pathToFileURL(join(generatedRoot, "protocol.mjs")));

const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
const port = Number(portArgument?.slice("--port=".length) ?? 4193);
const rooms = new Map();
let nextSocketId = 1;

const vite = await createViteServer({
  root: fixtureRoot,
  appType: "spa",
  resolve: {
    alias: {
      react: join(repoRoot, "apps/portal/node_modules/react"),
      "react-dom": join(repoRoot, "apps/portal/node_modules/react-dom"),
      "react-router": join(repoRoot, "apps/portal/node_modules/react-router"),
    },
  },
  server: { middlewareMode: true, hmr: false },
});
const server = http.createServer((request, response) => {
  if (handleControlRequest(request, response)) return;
  vite.middlewares(request, response, () => {
    response.statusCode = 404;
    response.end("Not found");
  });
});
const webSockets = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (!request.url?.includes("/v1/control/organisations/organisation-browser/commerce/products/")) {
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit("connection", client, request));
});

webSockets.on("connection", (socket, request) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const productId = decodeURIComponent(pathname.split("/").at(-3) ?? "browser-verification");
  const room = getRoom(productId);
  if (room.sockets.size >= SOCKET_LIMIT) {
    send(socket, { kind: "failure", code: "room_full" });
    socket.close();
    return;
  }
  const participant = {
    socket,
    id: `browser-${nextSocketId++}`,
    displayName: `Browser ${room.sockets.size + 1}`,
    state: "viewing",
    selection: null,
    activeAt: 0,
    pointer: null,
    touchedAt: Date.now(),
  };
  room.sockets.add(participant);
  socket.on("message", (frame) => receive(room, participant, frame.toString()));
  socket.on("close", () => {
    room.sockets.delete(participant);
    broadcastPresence(room);
  });
  broadcastPresence(room);
});

server.listen(port, "127.0.0.1", () => console.log(`plan40 protocol peer listening on http://127.0.0.1:${port}`));

function getRoom(name) {
  const existing = rooms.get(name);
  if (existing) return existing;
  const created = ProductDescriptionDoc.create("Shared pastry description");
  if (!created.ok) throw new Error(created.error.code);
  const room = { document: created.value, initializedRevision: 5, currentRevision: 5, access: "edit", failure: null, pauseAcks: false, pauseBroadcasts: false, sockets: new Set(), heldAcks: new Map(), heldBroadcasts: [] };
  rooms.set(name, room);
  return room;
}

function receive(room, participant, frame) {
  const parsed = parseDraftClientMessage(frame);
  if (!parsed.ok) {
    send(participant.socket, { kind: "failure", code: parsed.error.code });
    return;
  }
  participant.touchedAt = Date.now();
  switch (parsed.value.kind) {
    case "sync_request": {
      if (room.failure !== null) {
        send(participant.socket, { kind: "failure", code: room.failure });
        return;
      }
      const vector = room.document.stateVector();
      const missing = room.document.syncUpdate(parsed.value.stateVector);
      if (!vector.ok || !missing.ok) throw new Error("peer failed to encode sync state");
      send(participant.socket, {
        kind: "sync_response",
        serverStateVector: vector.value,
        missingUpdate: missing.value,
        initializedFromProductRevision: room.initializedRevision,
        currentProductRevision: room.currentRevision,
        access: room.access,
        sessionId: participant.id,
      });
      return;
    }
    case "presence_update":
      if (participant.state !== parsed.value.state || JSON.stringify(participant.selection) !== JSON.stringify(parsed.value.selection)) {
        participant.activeAt = Date.now();
      }
      participant.state = room.access === "read" ? "viewing" : parsed.value.state;
      participant.selection = participant.state === "editing" ? parsed.value.selection : null;
      broadcastPresence(room);
      return;
    case "pointer_update":
      participant.pointer = parsed.value.position === null
        ? null
        : { position: parsed.value.position, updatedAt: Date.now() };
      broadcastPresence(room);
      return;
    case "submit_update": {
      if (room.access !== "edit") {
        send(participant.socket, { kind: "failure", code: "access_revoked" });
        return;
      }
      const applied = room.document.apply(parsed.value.update);
      if (!applied.ok) {
        send(participant.socket, { kind: "failure", code: applied.error.code });
        return;
      }
      if (room.pauseAcks) room.heldAcks.set(parsed.value.updateId, participant);
      else send(participant.socket, { kind: "update_accepted", updateId: parsed.value.updateId });
      if (room.pauseBroadcasts) room.heldBroadcasts.push({ participant, update: parsed.value.update });
      else broadcastUpdate(room, participant, parsed.value.update);
      return;
    }
    default: throw new Error(`Unexpected protocol message: ${parsed.value.kind}`);
  }
}

function broadcastPresence(room) {
  const now = Date.now();
  for (const participant of room.sockets) {
    if (now - participant.touchedAt > PRESENCE_EXPIRY_MS) room.sockets.delete(participant);
  }
  const participants = [...room.sockets].map(participantPresence);
  for (const participant of room.sockets) send(participant.socket, { kind: "presence_changed", participants });
}

function participantPresence(participant) {
  return {
    sessionId: participant.id,
    userId: participant.id,
    displayName: participant.displayName,
    state: participant.state,
    selection: participant.selection,
    activeAt: participant.activeAt,
    pointer: participant.pointer,
  };
}

function broadcastUpdate(room, sender, update) {
  for (const peer of room.sockets) {
    if (peer !== sender) send(peer.socket, { kind: "update_broadcast", update });
  }
}

function send(socket, message) {
  if (socket.readyState === socket.OPEN) socket.send(encodeDraftServerMessage(message));
}

function handleControlRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/__plan40__/")) return false;
  const room = getRoom(url.searchParams.get("room") ?? "browser-verification");
  if (url.pathname === "/__plan40__/state" && request.method === "GET") {
    const state = room.document.state();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ text: room.document.read(), access: room.access, pauseAcks: room.pauseAcks, pauseBroadcasts: room.pauseBroadcasts, state: state.ok }));
    return true;
  }
  if (request.method !== "POST") {
    response.statusCode = 405;
    response.end();
    return true;
  }
  if (url.pathname === "/__plan40__/reset") {
    for (const participant of room.sockets) participant.socket.close();
    room.document.destroy();
    rooms.delete(url.searchParams.get("room") ?? "browser-verification");
    response.end("ok");
    return true;
  }
  if (url.pathname === "/__plan40__/mode") {
    const mode = url.searchParams.get("mode");
    if (mode === "read" || mode === "edit") room.access = mode;
    if (mode === "failure") room.failure = url.searchParams.get("code") ?? "storage_unavailable";
    if (mode === "clear-failure") room.failure = null;
    response.end("ok");
    return true;
  }
  if (url.pathname === "/__plan40__/pause-acks") {
    room.pauseAcks = url.searchParams.get("value") === "true";
    if (!room.pauseAcks) {
      for (const [updateId, participant] of room.heldAcks) send(participant.socket, { kind: "update_accepted", updateId });
      room.heldAcks.clear();
    }
    response.end("ok");
    return true;
  }
  if (url.pathname === "/__plan40__/pause-broadcasts") {
    room.pauseBroadcasts = url.searchParams.get("value") === "true";
    if (!room.pauseBroadcasts) {
      for (const held of room.heldBroadcasts) broadcastUpdate(room, held.participant, held.update);
      room.heldBroadcasts = [];
    }
    response.end("ok");
    return true;
  }
  if (url.pathname === "/__plan40__/close") {
    for (const participant of room.sockets) participant.socket.close();
    response.end("ok");
    return true;
  }
  response.statusCode = 404;
  response.end();
  return true;
}

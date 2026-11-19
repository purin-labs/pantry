import { exports } from "cloudflare:workers";
import {
  DraftEncoding,
  WorkflowDraftDoc,
  type DraftSnapshot,
} from "@purin-labs/workflow-canvas-crdt/draft";
import {
  encodeDraftClientMessage,
  parseDraftServerMessage,
  type DraftServerMessage,
} from "@purin-labs/workflow-canvas-crdt/draft-protocol";
import { commerceHeaders } from "./commerce-support";
import type { SharedAccountNativeClient } from "./shared-account-platform-fixture";

/** One browser's replica over one socket. It uses only the room's protocol. */
export class WorkflowDraftPeer {
  readonly events: DraftServerMessage[] = [];
  doc = WorkflowDraftDoc.createReplica();
  access: "read" | "edit" | null = null;
  serverVector: DraftEncoding<"state_vector"> | null = null;
  private socket: WebSocket | null = null;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly session: SharedAccountNativeClient["session"],
    private readonly organisation: string,
    private readonly workflow: string,
  ) {}

  async connect(): Promise<void> {
    const headers = new Headers(commerceHeaders(this.session));
    headers.set("Upgrade", "websocket");
    const response = await exports.default.fetch(
      `https://localhost/v1/control/organisations/${this.organisation}/bakery/workflows/${this.workflow}/socket`,
      { headers },
    );
    if (response.webSocket === null)
      throw new Error(
        `Socket refused: ${response.status} ${await response.text()}`,
      );
    const socket = response.webSocket;
    socket.accept();
    socket.addEventListener("message", this.receive.bind(this));
    this.socket = socket;
    const vector = this.doc.stateVector();
    if (!vector.ok) throw new Error(vector.error.code);
    const before = this.events.length;
    socket.send(
      encodeDraftClientMessage({
        kind: "sync_request",
        stateVector: vector.value,
      }),
    );
    await this.until((event) => event.kind === "sync_response", before);
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
  }

  private receive(event: MessageEvent): void {
    const parsed = parseDraftServerMessage(event.data);
    if (!parsed.ok) throw new Error(parsed.error.code);
    const message = parsed.value;
    this.events.push(message);
    if (message.kind === "sync_response") {
      const applied = this.doc.apply(message.missingUpdate);
      if (!applied.ok) throw new Error(applied.error.code);
      this.access = message.access;
      this.serverVector = message.serverStateVector;
    }
    if (message.kind === "update_broadcast") {
      const applied = this.doc.apply(message.update);
      if (!applied.ok) throw new Error(applied.error.code);
    }
    for (const wake of this.waiters.splice(0)) wake();
  }

  async until(
    match: (event: DraftServerMessage) => boolean,
    from = 0,
  ): Promise<DraftServerMessage> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const found = this.events.slice(from).find(match);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error("No such draft message");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  /** Sends an update, and waits for its receipt or the room's failure. */
  async submit(update: DraftEncoding<"update">): Promise<DraftServerMessage> {
    const updateId = `update-${crypto.randomUUID()}`;
    const from = this.events.length;
    this.socket?.send(
      encodeDraftClientMessage({ kind: "submit_update", updateId, update }),
    );
    return this.until(
      (event) =>
        (event.kind === "update_accepted" && event.updateId === updateId) ||
        event.kind === "failure",
      from,
    );
  }

  /** What a reconnected browser sends: all that the room has not seen. */
  async submitMissing(): Promise<DraftServerMessage> {
    if (this.serverVector === null) throw new Error("Not synced");
    const update = this.doc.syncUpdate(this.serverVector);
    if (!update.ok) throw new Error(update.error.code);
    return this.submit(update.value);
  }

  snapshot(): DraftSnapshot {
    return this.doc.snapshot();
  }
}

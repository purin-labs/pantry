import type { CollaborationPointerPosition } from "@seams/collaboration";
import {
  CostsSheetDoc,
  type CostsSheetCellChange,
  type CostsSheetSelection,
  type CostsSheetUpdate,
} from "@seams/costs-sheet-crdt";
import {
  encodeCostsSheetClientMessage,
  parseCostsSheetServerMessage,
  type CostsSheetParticipant,
  type CostsSheetServerMessage,
} from "@seams/costs-sheet-crdt/protocol";
import { closeSocket } from "./hibernatable-socket-support";

/**
 * One member's hibernatable WebSocket replica on an Organisation's shared
 * Costs & margins workbook (`@seams/costs-sheet-crdt`).
 */
export class CostsSheetRoomClient {
  readonly doc = CostsSheetDoc.create();
  readonly failures: string[] = [];
  participants: readonly CostsSheetParticipant[] = [];
  sessionId: string | null = null;
  private readonly receive = this.onMessage.bind(this);

  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", this.receive);
  }

  async sync(): Promise<
    Readonly<{ access: "read" | "edit"; generation: number; sessionId: string }>
  > {
    const vector = this.doc.stateVector();
    if (!vector.ok) {
      throw new Error(vector.error.code);
    }
    const response = this.next((message) => message.kind === "sync_response");
    this.socket.send(
      encodeCostsSheetClientMessage({
        kind: "sync_request",
        stateVector: vector.value,
      }),
    );
    const synced = await response;
    if (synced.kind !== "sync_response") {
      throw new Error("Expected sync_response");
    }
    this.sessionId = synced.sessionId;
    return {
      access: synced.access,
      generation: synced.generation,
      sessionId: synced.sessionId,
    };
  }

  setCells(changes: readonly CostsSheetCellChange[]): CostsSheetUpdate {
    const result = this.doc.setCells(changes);
    if (!result.ok) {
      throw new Error(result.error.code);
    }
    if (result.value === null) {
      throw new Error("Expected non-empty CostsSheetUpdate");
    }
    return result.value;
  }

  async submit(updateId: string, update: CostsSheetUpdate): Promise<void> {
    const accepted = this.next(
      (message) =>
        message.kind === "update_accepted" && message.updateId === updateId,
    );
    this.socket.send(
      encodeCostsSheetClientMessage({
        kind: "submit_update",
        updateId,
        update,
      }),
    );
    await accepted;
  }

  async refused(updateId: string, update: CostsSheetUpdate): Promise<string> {
    const failure = this.next((message) => message.kind === "failure");
    this.socket.send(
      encodeCostsSheetClientMessage({
        kind: "submit_update",
        updateId,
        update,
      }),
    );
    const message = await failure;
    if (message.kind !== "failure") {
      throw new Error("Expected failure frame");
    }
    return message.code;
  }

  sendPresence(
    state: "viewing" | "editing",
    selection: CostsSheetSelection | null,
  ): void {
    this.socket.send(
      encodeCostsSheetClientMessage({
        kind: "presence_update",
        state,
        selection,
      }),
    );
  }

  sendPointer(position: CollaborationPointerPosition | null): void {
    this.socket.send(
      encodeCostsSheetClientMessage({
        kind: "pointer_update",
        position,
      }),
    );
  }

  cells(): Readonly<Record<string, string>> {
    return this.doc.cellsRecord();
  }

  async close(): Promise<void> {
    this.socket.removeEventListener("message", this.receive);
    await closeSocket(this.socket);
  }

  private onMessage(event: MessageEvent): void {
    const parsed = parseCostsSheetServerMessage(event.data);
    if (!parsed.ok) {
      return;
    }
    const message = parsed.value;
    switch (message.kind) {
      case "sync_response":
        requireApplied(this.doc.apply(message.missingUpdate));
        return;
      case "update_broadcast":
        requireApplied(this.doc.apply(message.update));
        return;
      case "failure":
        this.failures.push(message.code);
        return;
      case "presence_changed":
        this.participants = message.participants;
        return;
      case "update_accepted":
        return;
    }
  }

  private next(
    accept: (message: CostsSheetServerMessage) => boolean,
  ): Promise<CostsSheetServerMessage> {
    return new Promise((resolve, reject) => {
      const handler = (event: MessageEvent): void => {
        const parsed = parseCostsSheetServerMessage(event.data);
        if (!parsed.ok || !accept(parsed.value)) {
          return;
        }
        this.socket.removeEventListener("message", handler);
        resolve(parsed.value);
      };
      this.socket.addEventListener("message", handler);
      this.socket.addEventListener(
        "close",
        () => reject(new Error("Costs sheet socket closed unexpectedly")),
        { once: true },
      );
    });
  }
}

function requireApplied(result: ReturnType<CostsSheetDoc["apply"]>): void {
  if (!result.ok) {
    throw new Error(result.error.code);
  }
}

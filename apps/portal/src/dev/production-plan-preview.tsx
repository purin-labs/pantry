import React from "react";
import { createRoot } from "react-dom/client";
import {
  COLLABORATION_PING,
  COLLABORATION_PONG,
  type CollaborationParticipant,
} from "@purin-labs/collaboration";
import type { InventoryProductionRequest } from "@purin-labs/kitchen-control-api";
import {
  ProductionPlanDoc,
  type ProductionPlanSelection,
} from "@purin-labs/production-plan-crdt";
import {
  encodePlanServerMessage,
  parsePlanClientMessage,
  type PlanServerMessage,
} from "@purin-labs/production-plan-crdt/protocol";
import { isRecord } from "@purin-labs/std";
import { ProductionPlanPanel } from "../features/commerce/production-plan";
import { usePortalTheme } from "@purin-labs/ui/use-portal-theme";
import "../styles.css";

/**
 * Plan 40D preview: two people on one location's plan. The page answers the
 * plan socket itself with the real document and protocol, so each panel is
 * the real client and the two panels merge as two browsers would.
 */
const REQUESTS: readonly InventoryProductionRequest[] = [
  previewRequest("production_request_sesame", "Sesame cookie", 24),
  previewRequest("production_request_financier", "Ginger financier", 36),
  previewRequest("production_request_canele", "Canelé", 18),
  previewRequest("production_request_sable", "Sablé breton", 30),
];
const PEOPLE = ["Aiko", "Ben"] as const;

class PreviewRoom {
  readonly doc = ProductionPlanDoc.create();
  #fault: "none" | "next_save" | "sync_unavailable" = "none";
  readonly sockets = new Map<
    PreviewSocket,
    CollaborationParticipant<ProductionPlanSelection>
  >();

  join(socket: PreviewSocket): void {
    const index = this.sockets.size % PEOPLE.length;
    this.sockets.set(socket, {
      sessionId: crypto.randomUUID(),
      userId: `user_${index}`,
      displayName: PEOPLE[index] ?? "Person",
      state: "viewing",
      selection: null,
      activeAt: Date.now(),
      pointer: null,
    });
  }

  leave(socket: PreviewSocket): void {
    this.sockets.delete(socket);
    this.presence();
  }

  interruptNextSave(): void {
    this.#fault = "next_save";
  }

  interruptConnections(): void {
    for (const socket of [...this.sockets.keys()]) socket.close();
  }

  refuseSynchronization(): void {
    this.#fault = "sync_unavailable";
    for (const socket of this.sockets.keys())
      this.send(socket, { kind: "failure", code: "storage_unavailable" });
  }

  allowSynchronization(): void {
    this.#fault = "none";
  }

  revokeAccess(): void {
    for (const socket of this.sockets.keys())
      this.send(socket, { kind: "failure", code: "access_revoked" });
  }

  receive(socket: PreviewSocket, frame: string): void {
    if (frame === COLLABORATION_PING) return socket.deliver(COLLABORATION_PONG);
    const parsed = parsePlanClientMessage(frame);
    const participant = this.sockets.get(socket);
    if (!parsed.ok || participant === undefined) return;
    const message = parsed.value;
    switch (message.kind) {
      case "sync_request": {
        if (this.#fault === "sync_unavailable") {
          this.send(socket, { kind: "failure", code: "storage_unavailable" });
          return;
        }
        const vector = this.doc.stateVector();
        const update = this.doc.syncUpdate(message.stateVector);
        if (!vector.ok || !update.ok) return;
        this.send(socket, {
          kind: "sync_response",
          serverStateVector: vector.value,
          missingUpdate: update.value,
          documentRevision: 1,
          generation: 1,
          access: "edit",
          sessionId: participant.sessionId,
        });
        this.presence();
        return;
      }
      case "submit_update": {
        if (this.#fault === "next_save") {
          this.#fault = "none";
          // The server did not receive this edit. The real client must keep
          // its local copy and submit it after a fresh synchronization.
          socket.deliver("interrupted plan frame");
          return;
        }
        if (!this.doc.apply(message.update).ok) return;
        this.send(socket, {
          kind: "update_accepted",
          updateId: message.updateId,
        });
        for (const peer of this.sockets.keys())
          if (peer !== socket)
            this.send(peer, {
              kind: "update_broadcast",
              update: message.update,
            });
        return;
      }
      case "presence_update":
        this.sockets.set(socket, {
          ...participant,
          state: message.state,
          selection: message.selection,
          activeAt: Date.now(),
        });
        this.presence();
        return;
      case "pointer_update":
        return;
    }
  }

  presence(): void {
    const participants = [...this.sockets.values()];
    for (const socket of this.sockets.keys())
      this.send(socket, { kind: "presence_changed", participants, agents: [] });
  }

  send(socket: PreviewSocket, message: PlanServerMessage): void {
    socket.deliver(encodePlanServerMessage(message));
  }
}

const room = new PreviewRoom();

/** A socket that the page's room answers, in place of the platform. */
class PreviewSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = PreviewSocket.CONNECTING;

  constructor(_url: string) {
    super();
    room.join(this);
    setTimeout(this.#open.bind(this), 80);
  }

  send(data: string): void {
    setTimeout(room.receive.bind(room, this, data), 60);
  }

  close(): void {
    if (this.readyState === PreviewSocket.CLOSED) return;
    this.readyState = PreviewSocket.CLOSED;
    room.leave(this);
    this.dispatchEvent(new Event("close"));
  }

  deliver(data: string): void {
    if (this.readyState !== PreviewSocket.OPEN) return;
    setTimeout(this.#message.bind(this, data), 40);
  }

  #open(): void {
    this.readyState = PreviewSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  #message(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
Object.defineProperty(window, "WebSocket", { value: PreviewSocket });

async function acceptPreview(_path: string, body: unknown): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  const lines = isRecord(body) && Array.isArray(body.lines) ? body.lines : [];
  return {
    ok: true,
    lines: lines.filter(isRecord).map((line) => {
      const request = REQUESTS.find((item) => item.id === line.requestId);
      return {
        requestId: line.requestId,
        revised:
          request !== undefined &&
          String(request.quantity.amount) !== line.quantity,
        outcome: "accepted",
        quantity: { amount: Number(line.quantity), scale: 0, unit: "each" },
      };
    }),
  };
}

function Preview(): React.ReactNode {
  const { theme, toggleTheme } = usePortalTheme();
  return (
    <main
      className="stock-page"
      data-theme={theme}
      style={{ padding: "1.5rem", display: "grid", gap: "1.5rem" }}
    >
      <header>
        <h1>Production plan preview</h1>
        <p>
          Each panel is one person's page. Change a quantity in one panel and
          watch the other panel.
        </p>
        <button type="button" onClick={toggleTheme}>
          Switch theme
        </button>
      </header>
      <section aria-label="Connection faults">
        <h2>Connection faults</h2>
        <p>
          Interrupt a save before it reaches the room, or refuse synchronization
          until automatic retries stop. Allow synchronization before retrying.
        </p>
        <div className="stock-operation-actions">
          <button type="button" onClick={room.interruptNextSave.bind(room)}>
            Interrupt next save
          </button>
          <button type="button" onClick={room.interruptConnections.bind(room)}>
            Disconnect pages
          </button>
          <button type="button" onClick={room.refuseSynchronization.bind(room)}>
            Refuse synchronization
          </button>
          <button type="button" onClick={room.allowSynchronization.bind(room)}>
            Allow synchronization
          </button>
          <button type="button" onClick={room.revokeAccess.bind(room)}>
            Revoke access
          </button>
        </div>
      </section>
      {PEOPLE.map((person) => (
        <section key={person} aria-label={`${person}'s page`}>
          <h2>{person}'s page</h2>
          <ProductionPlanPanel
            organisationId="organisation_preview"
            locationId="location_cafe"
            requests={REQUESTS}
            settledRequestIds={[]}
            canOperate
            canManage
            mutate={acceptPreview}
            onAccepted={() => undefined}
          />
        </section>
      ))}
    </main>
  );
}

function previewRequest(
  id: string,
  name: string,
  amount: number,
): InventoryProductionRequest {
  return {
    id,
    revision: 1,
    itemId: `item_${id}`,
    name,
    locationId: "location_cafe",
    recipeId: `recipe_${id}`,
    recipeRevision: 1,
    quantity: { amount, scale: 0, unit: "each" },
    neededBy: "2026-10-20T06:00:00.000Z",
    status: "requested",
    batches: [],
  };
}

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<Preview />);

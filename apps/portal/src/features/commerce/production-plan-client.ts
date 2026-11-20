import {
  ProductionPlanDoc,
  type ProductionPlanSelection,
  type ProductionPlanStateVector,
  type ProductionPlanUpdate,
} from "@purin-labs/production-plan-crdt";
import {
  encodePlanClientMessage,
  parsePlanServerMessage,
  type PlanFailureCode,
  type PlanRoomMetadata,
} from "@purin-labs/production-plan-crdt/protocol";
import type { CollaborationAgentActivity } from "@purin-labs/collaboration";
import { assertNever } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";
import {
  DocumentClient,
  webSocketUrl,
  type DocumentParticipant,
  type DocumentState,
} from "../collaboration/document-client";

const SYNC_RETRY_LIMIT = 3;

type ProductionPlanPresence = DocumentParticipant<ProductionPlanSelection>;

export type ProductionPlanView = Readonly<{
  /** Draft quantity by request id. */
  lines: ReadonlyMap<string, string>;
  participants: readonly ProductionPlanPresence[];
  agents: readonly CollaborationAgentActivity[];
  access: "read" | "edit";
}> &
  StrictUnion<
    | Readonly<{ kind: "connecting" | "syncing" | "synced" | "reconnecting" }>
    | Readonly<{ kind: "failed"; message: string; recovery: "retry" | "none" }>
  >;

/**
 * Plan 40D: the shared production plan of one location. Each person's
 * quantity change reaches the other open pages; "Accept plan" applies them.
 */
export class ProductionPlanClient {
  readonly #client: DocumentClient<
    ProductionPlanDoc,
    ProductionPlanUpdate,
    ProductionPlanStateVector,
    ProductionPlanSelection,
    PlanFailureCode,
    PlanRoomMetadata
  >;
  readonly #notify: (view: ProductionPlanView) => void;
  #selection: ProductionPlanSelection | null = null;

  constructor(
    organisationId: string,
    locationId: string,
    surface: HTMLElement,
    notify: (view: ProductionPlanView) => void,
  ) {
    this.#notify = notify;
    this.#client = new DocumentClient({
      url: webSocketUrl(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/inventory/production-plan/${encodeURIComponent(locationId)}/socket`,
      ),
      surface,
      create: () => ProductionPlanDoc.create(),
      parse: parsePlanServerMessage,
      encode: encodePlanClientMessage,
      invalidMessage: "invalid_message",
      ignoredEditFailures: ["collection_limit", "record_conflict"],
      retry: { limit: SYNC_RETRY_LIMIT, recovery: failureRecovery },
      presence: () => this.#selection,
      generation: (message) => message.generation,
      emit: this.#emit.bind(this),
    });
    this.#client.connect();
  }

  dispose(): void {
    this.#client.dispose();
  }

  hasUnsyncedEdits(): boolean {
    return this.#client.hasUnsyncedEdits();
  }

  isSynced(): boolean {
    return this.#client.isSynced();
  }

  retry(): void {
    this.#client.retry();
  }

  /** The line that this person works on, shown to the others. */
  select(requestId: string | null): void {
    this.#selection = requestId === null ? null : { requestId };
    this.#client.sendPresence(this.#selection);
  }

  /** Returns false when the quantity is not a valid plan quantity. */
  setQuantity(requestId: string, quantity: string): boolean {
    const result = this.#client.replica.setQuantity(requestId, quantity);
    if (!result.ok && result.error.code === "quantity_invalid") {
      return false;
    }
    this.#client.edit(result);
    return true;
  }

  /** Removes lines whose requests left `requested`. */
  clear(requestIds: readonly string[]): void {
    this.#client.edit(this.#client.replica.clear(requestIds));
  }

  #emit(
    state: DocumentState<
      ProductionPlanDoc,
      ProductionPlanSelection,
      PlanFailureCode
    >,
  ): void {
    const lines = new Map<string, string>();
    for (const line of state.replica.read().lines) {
      lines.set(line.requestId, line.quantity);
    }
    const base = {
      lines,
      participants: state.participants,
      agents: state.agents,
      access: state.access,
    };
    if (state.status === "failed") {
      this.#notify({
        ...base,
        kind: "failed",
        message: failureMessage(state.code),
        recovery: failureRecovery(state.code),
      });
      return;
    }
    this.#notify({ ...base, kind: state.status });
  }
}

function failureRecovery(code: PlanFailureCode): "retry" | "none" {
  switch (code) {
    case "storage_unavailable":
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_document_shape":
    case "invalid_message":
      return "retry";
    case "quantity_invalid":
    case "record_conflict":
    case "update_too_large":
    case "state_too_large":
    case "state_vector_too_large":
    case "access_revoked":
    case "collection_limit":
    case "room_full":
      return "none";
    default:
      return assertNever(code, "Unexpected production plan branch");
  }
}

function failureMessage(code: PlanFailureCode): string {
  switch (code) {
    case "access_revoked":
      return "Your access to this plan has ended.";
    case "collection_limit":
      return "This location's plan is full. Accept or clear lines before adding more.";
    case "quantity_invalid":
    case "record_conflict":
      return "That plan change could not be applied. Reload the page and try again.";
    case "room_full":
      return "This plan already has 20 connected sessions.";
    case "storage_unavailable":
      return "The plan is temporarily unavailable. Your changes remain on this page. Retry the connection.";
    case "invalid_state":
    case "invalid_update":
    case "invalid_state_vector":
    case "invalid_document_shape":
    case "invalid_message":
      return "The shared plan could not be synchronized. Your changes remain on this page. Retry the connection.";
    case "update_too_large":
    case "state_too_large":
    case "state_vector_too_large":
      return "The shared plan could not be synchronized. Reload the page.";
    default:
      return assertNever(code, "Unexpected production plan branch");
  }
}

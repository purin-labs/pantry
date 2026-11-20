// The café plan journeys: production requests in Commerce through the
// Portal's routes, and one person's socket on a location's shared plan.
import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { isRecord } from "@purin-labs/std";
import type { CollaborationAgentActivity } from "@purin-labs/collaboration";
import {
  parseInventoryProductionContext,
  parseProductionDemand,
  type InventoryProductionRequest,
} from "@purin-labs/kitchen-control-api";
import {
  ProductionPlanDoc,
  type ProductionPlanUpdate,
} from "@purin-labs/production-plan-crdt";
import {
  encodePlanClientMessage,
  parsePlanServerMessage,
  type PlanServerMessage,
} from "@purin-labs/production-plan-crdt/protocol";
import {
  CommerceAdminClient,
  CommerceEntityPlaneClient,
  parseEntityPlaneCommand,
  parseListEntryReadRequest,
  parseProductionRequestFields,
  productionRequestAttributes,
  type CommerceStockSnapshot,
} from "@purin-labs/commerce-client";
import { commerceClient, commerceHeaders } from "./commerce-support";
import { closeSocket } from "./hibernatable-socket-support";
import { openRouterToolCall } from "./slack-journey-support";

export const LOCATION = "location_cafe";
export const PRODUCTION = "/inventory/production-requests";

export function planPath(action: "accept"): string {
  return `/inventory/production-plan/${LOCATION}/${action}`;
}

/** The model's call that reads the plan of the café's location. */
export function readPlan(id: string): Promise<Response> | Response {
  return openRouterToolCall(
    "production_plan_read",
    { locationId: LOCATION },
    `call_${id}`,
  );
}

export class PlanJourney {
  readonly entities = new CommerceEntityPlaneClient({
    baseUrl: "http://underclerk.test",
    serviceToken: "underclerk-e2e-token",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });
  readonly native = new CommerceAdminClient({
    baseUrl: "http://underclerk.test",
    serviceToken: "underclerk-e2e-token",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });

  constructor(
    readonly organisationId: string,
    readonly merchantId: string,
    readonly session: Awaited<ReturnType<typeof commerceClient>>["session"],
  ) {}

  async stock(): Promise<CommerceStockSnapshot> {
    const stock = await this.native.readStockSnapshot(this.merchantId);
    if (!stock.ok) throw new Error(JSON.stringify(stock.error));
    return stock.value;
  }

  async merchantRevision(): Promise<number> {
    return (await this.stock()).commerce.merchantRevision;
  }

  /** A staff description change, straight to Commerce. */
  async describeProduct(slug: string): Promise<void> {
    const snapshot = await this.native.readSnapshot(this.merchantId);
    if (!snapshot.ok) throw new Error("Snapshot read failed");
    const product = snapshot.value.resources.products.find(
      (item) => item.id === `product_${slug}`,
    );
    if (product === undefined) throw new Error(`Product ${slug} missing`);
    const key = `describe_${slug}_${crypto.randomUUID()}`;
    const result = await this.native.updateProductDescription({
      merchantId: this.merchantId,
      expectedMerchantRevision: snapshot.value.merchantRevision,
      productId: product.id,
      expectedProductRevision: product.revision,
      description: `Now with ${slug.replace("_", " ")} from batch ${key.slice(-4)}.`,
      idempotencyKey: key,
    });
    expect(result.ok && result.value.outcome, JSON.stringify(result)).toBe(
      "applied",
    );
  }

  /** Creates `count` requests at the café for a stocked recipe's product. */
  async createRequests(count: number): Promise<string[]> {
    const stock = await this.stock();
    const recipe = stock.foodService.resources.recipeRevisions.find(
      (candidate) =>
        candidate.recipeId === "recipe_sesame_cookie_stocked" &&
        candidate.output.kind === "stocked",
    );
    if (recipe === undefined || recipe.output.kind !== "stocked")
      throw new Error("Stocked recipe missing");
    const position = stock.commerce.resources.inventoryPositions.find(
      (candidate) =>
        recipe.output.kind === "stocked" &&
        candidate.inventoryItemId === recipe.output.inventoryItemId &&
        candidate.locationId === LOCATION,
    );
    if (position === undefined) throw new Error("Café position missing");
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const context = parseInventoryProductionContext(
        await this.read(`${PRODUCTION}?position=${position.id}`),
      );
      const option = context.recipes[0];
      if (option === undefined || context.demand.kind !== "ready")
        throw new Error("Production context missing");
      const key = `production:plan-${index}-${crypto.randomUUID()}`;
      await this.write(
        PRODUCTION,
        {
          kind: "create",
          listRevision: context.demand.listRevision,
          inventoryItemId: context.inventoryItemId,
          locationId: context.locationId,
          merchantRevision: context.merchantRevision,
          positionId: context.inventoryPositionId,
          positionRevision: context.inventoryPositionRevision,
          recipeId: option.id,
          recipeRevision: option.revision,
          quantity: option.yield,
          neededBy: new Date(Date.now() + 86_400_000).toISOString(),
          requestedAt: new Date().toISOString(),
        },
        key,
      );
      ids.push(`production_request_${key}`);
    }
    return ids;
  }

  /** The café's requests that wait for acceptance, as the page reads them. */
  async requested(): Promise<InventoryProductionRequest[]> {
    const raw = await this.read(`${PRODUCTION}?location=${LOCATION}`);
    if (!isRecord(raw)) throw new Error("Production page missing");
    const demand = parseProductionDemand(raw.demand);
    if (demand.kind !== "ready") throw new Error("Production page missing");
    return demand.requests.filter((request) => request.status === "requested");
  }

  /** Another writer changes a request's quantity directly in Commerce. */
  async reviseInUnderclerk(requestId: string, whole: number) {
    const read = await this.entities.readListEntry(
      parseListEntryReadRequest({
        merchantId: this.merchantId,
        listId: "production_requests",
        entryId: requestId,
      }),
    );
    if (!read.ok || read.value.kind !== "found")
      throw new Error("Request read failed");
    const fields = parseProductionRequestFields(
      read.value.entry.attributeValues,
    );
    const revision = Number(read.value.entry.revision);
    const commandId = `other-writer-${crypto.randomUUID()}`;
    const target = {
      entry: {
        entryId: requestId,
        listId: "production_requests",
        revision,
      },
      expectedRevision: revision,
    };
    const quantity = {
      ...fields.quantity,
      amount: whole * 10 ** fields.quantity.scale,
    };
    const result = await this.entities.command(
      parseEntityPlaneCommand({
        organisationId: this.organisationId,
        merchantId: this.merchantId,
        expectedMerchantRevision: Number(read.value.merchantRevision),
        commandId,
        authority: {
          kind: "commerce_list_entry_command",
          context: {
            organisationId: this.organisationId,
            merchantId: this.merchantId,
            principalId: "another-writer",
            sensitivityCeiling: "restricted",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            causation: { kind: "command", commandId },
          },
          scope: { kind: "commerce_list_entry", entry: target.entry },
          target,
        },
        command: {
          kind: "patch_commerce_list_entry",
          command: {
            target,
            expectedListRevision: Number(read.value.listRevision),
            attributeValues: productionRequestAttributes({
              ...fields,
              quantity,
            }),
          },
        },
      }),
    );
    if (!result.ok || result.value.status !== "accepted")
      throw new Error(`Other writer refused: ${JSON.stringify(result)}`);
    return { requestId, fromRevision: revision, quantity };
  }

  async requestFields(ids: readonly string[]) {
    const fields = new Map<
      string,
      ReturnType<typeof parseProductionRequestFields>
    >();
    for (const id of ids) {
      const read = await this.entities.readListEntry(
        parseListEntryReadRequest({
          merchantId: this.merchantId,
          listId: "production_requests",
          entryId: id,
        }),
      );
      if (!read.ok || read.value.kind !== "found")
        throw new Error(`Request missing: ${id}`);
      fields.set(
        id,
        parseProductionRequestFields(read.value.entry.attributeValues),
      );
    }
    return fields;
  }

  async send(
    suffix: string,
    body?: unknown,
    session = this.session,
    key = crypto.randomUUID(),
  ): Promise<Response> {
    const headers = commerceHeaders(session);
    headers.set("idempotency-key", key);
    return exports.default.fetch(
      `https://localhost/v1/control/organisations/${this.organisationId}/commerce${suffix}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  }

  async read(suffix: string): Promise<unknown> {
    const response = await this.send(suffix);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }

  async write(
    suffix: string,
    body: unknown,
    key = crypto.randomUUID(),
  ): Promise<unknown> {
    const response = await this.send(suffix, body, this.session, key);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }
}

/** One person's socket on the location's plan, with a local replica. */
export class PlanRoomClient {
  readonly doc = ProductionPlanDoc.create();
  readonly failures: string[] = [];
  /** The agents that each presence frame showed, in order. */
  readonly agentFrames: (readonly CollaborationAgentActivity[])[] = [];
  private readonly receive = this.message.bind(this);

  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", this.receive);
  }

  async sync(): Promise<Readonly<{ access: string; generation: number }>> {
    const vector = this.doc.stateVector();
    if (!vector.ok) throw new Error(vector.error.code);
    const response = this.next((message) => message.kind === "sync_response");
    this.socket.send(
      encodePlanClientMessage({
        kind: "sync_request",
        stateVector: vector.value,
      }),
    );
    const synced = await response;
    if (synced.kind !== "sync_response") throw new Error("No sync response");
    return { access: synced.access, generation: synced.generation };
  }

  set(requestId: string, quantity: string): ProductionPlanUpdate {
    const update = this.doc.setQuantity(requestId, quantity);
    if (!update.ok) throw new Error(update.error.code);
    return update.value;
  }

  async submit(updateId: string, update: ProductionPlanUpdate): Promise<void> {
    const accepted = this.next(
      (message) =>
        message.kind === "update_accepted" && message.updateId === updateId,
    );
    this.socket.send(
      encodePlanClientMessage({ kind: "submit_update", updateId, update }),
    );
    await accepted;
  }

  /** Sends a change that the room must refuse; returns the refusal. */
  async refused(
    updateId: string,
    update: ProductionPlanUpdate,
  ): Promise<string> {
    const failure = this.next((message) => message.kind === "failure");
    this.socket.send(
      encodePlanClientMessage({ kind: "submit_update", updateId, update }),
    );
    const message = await failure;
    if (message.kind !== "failure") throw new Error("No refusal");
    return message.code;
  }

  lines(): Record<string, string> {
    return Object.fromEntries(
      this.doc.read().lines.map((line) => [line.requestId, line.quantity]),
    );
  }

  async close(): Promise<void> {
    this.socket.removeEventListener("message", this.receive);
    await closeSocket(this.socket);
  }

  private message(event: MessageEvent): void {
    const parsed = parsePlanServerMessage(event.data);
    if (!parsed.ok)
      throw new Error(`Invalid plan frame: ${String(event.data)}`);
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
        this.agentFrames.push(message.agents);
        return;
      case "update_accepted":
        return;
    }
  }

  private next(
    accept: (message: PlanServerMessage) => boolean,
  ): Promise<PlanServerMessage> {
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent): void => {
        const parsed = parsePlanServerMessage(event.data);
        if (!parsed.ok || !accept(parsed.value)) return;
        this.socket.removeEventListener("message", onMessage);
        resolve(parsed.value);
      };
      this.socket.addEventListener("message", onMessage);
      this.socket.addEventListener(
        "close",
        () => reject(new Error("The plan socket closed")),
        { once: true },
      );
    });
  }
}

function requireApplied(result: ReturnType<ProductionPlanDoc["apply"]>): void {
  if (!result.ok) throw new Error(result.error.code);
}

import { env } from "cloudflare:workers";
import type { HttpResponseResolver } from "msw";
import { expect } from "vitest";
import { importScenario } from "@purin-labs/bakery-workflow";
import { CommerceAdminClient } from "@purin-labs/commerce-client";
import {
  parseBakeBoard,
  type BakeBoard,
  type BakeProposalView,
} from "@purin-labs/kitchen-control-api";
import { isRecord } from "@purin-labs/std";

import {
  compileFinancierRecipe,
  financierRecipeInput,
} from "../../../../packages/production-simulation/src/recipes/bakery/financier-production";
import counterDay from "../../../../scripts/plan-24/counter-day.json";
import { runScheduledCommerceOutboxReconciliation } from "../../src/commerce/outbox-worker";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { placePickupOrder, required } from "./cafe-order-support";
import { finished, messageWord, startChat } from "./chat-journey-support";
import {
  lastCalledTool,
  pausedRequest,
  resumeChat,
} from "./chat-permission-support";
import { connectCommerceFixture } from "./commerce-support";
import { controlBase, send } from "./device-fleet-support";
import type { Member, MemoryFixture } from "./memory-support";
import { allowAsPortal } from "./permission-request-support";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
} from "./slack-journey-support";

/**
 * Plan 24: the café counter of the bake journeys. The café sells financiers
 * through its real QR order path, from the declared morning of
 * scripts/plan-24/counter-day.json, and Commerce restocks the counter. The
 * Bakes page reads and writes through the Portal's routes.
 */

export const day = counterDay;

type DayEvent = Readonly<{
  at: string;
  kind: "sale" | "restock" | "checkpoint";
  quantity?: number;
  name?: string;
}>;

const EVENTS = day.events as readonly DayEvent[];

export type Artifact = Record<string, unknown>;

/** The café of a demo shop, with a counted financier on its menu. */
export async function openCounterShop(
  organisationId: string,
  ownerUserId: string,
  /** The merchant that the shop's fixture already connected, if any. */
  connected: string | null = null,
) {
  const merchantId =
    connected ?? `merchant_bakes_${crypto.randomUUID().replaceAll("-", "")}`;
  if (connected === null)
    await connectCommerceFixture(organisationId, ownerUserId, merchantId);
  const admin = new CommerceAdminClient({
    baseUrl: "http://underclerk.test",
    serviceToken: "underclerk-e2e-token",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });
  await required(
    admin.provisionDemo({
      schemaVersion: "underclerk.provision-demo.v2",
      externalReference: organisationId,
      merchantId,
      profile: "cafe_patisserie",
      createdAt: new Date().toISOString(),
    }),
  );
  const base = async (key: string) => ({
    merchantId,
    expectedMerchantRevision: (
      await required(admin.readStockSnapshot(merchantId))
    ).commerce.merchantRevision,
    idempotencyKey: `bakes_${key}`,
  });
  const snapshot = await required(admin.readStockSnapshot(merchantId));
  const salesChannel = snapshot.commerce.resources.salesChannels.find(
    (channel) => channel.id === "sales_channel_cafe",
  );
  if (salesChannel === undefined) throw new Error("No café sales channel");
  const at = new Date().toISOString();
  const { product } = day;
  await applied(
    admin.createInventoryItem({
      ...(await base("item")),
      inventoryItemId: product.inventoryItemId,
      merchantCode: "COUNTER-FINANCIER",
      name: product.name,
      baseUnit: "each",
      category: "finished_good",
      tracking: { kind: "aggregate" },
    }),
  );
  await applied(
    admin.openInventoryPosition({
      ...(await base("position")),
      inventoryPositionId: product.positionId,
      inventoryItemId: product.inventoryItemId,
      inventoryItemRevision: 1,
      locationId: "location_cafe",
      locationRevision: 1,
    }),
  );
  await applied(
    admin.prepareCatalogListing({
      ...(await base("listing")),
      salesChannel,
      product: {
        id: product.productId,
        revision: 1,
        title: product.name,
        description: "A brown-butter financier, baked each morning.",
        handle: null,
        productType: "Pastry",
        vendor: "",
        tags: [],
        status: "active",
        occurredAt: at,
      },
      variant: {
        id: product.variantId,
        revision: 1,
        productId: product.productId,
        sku: "COUNTER-FINANCIER",
        title: product.name,
        options: [],
        media: [],
        barcode: null,
        status: "active",
        occurredAt: at,
      },
      offer: {
        id: "offer_counter_financier_cafe",
        revision: 1,
        variantId: product.variantId,
        salesChannelId: salesChannel.id,
        price: { amountMinor: product.priceMinor, currency: "JPY" },
        compareAtPrice: null,
        availability: { state: "available" },
        lifecycle: { state: "prepared", preparedAt: at },
        occurredAt: at,
      },
      consumptionPlan: {
        consumptionPlanId: "consumption_plan_counter_financier",
        variantId: product.variantId,
        revision: 1,
        scope: { kind: "location", locationId: "location_cafe" },
        mode: {
          kind: "direct",
          components: [
            {
              inventoryItemId: product.inventoryItemId,
              quantity: { amount: 1, scale: 0, unit: "each" },
            },
          ],
          commitOn: "fulfillment_completed",
        },
        lifecycle: "active",
      },
    }),
  );
  await applied(
    admin.publishCatalogListing({
      merchantId,
      idempotencyKey: "bakes_publish",
      productId: product.productId,
      productRevision: 1,
      variantId: product.variantId,
      variantRevision: 1,
      offerId: "offer_counter_financier_cafe",
      offerRevision: 1,
      salesChannelId: salesChannel.id,
      salesChannelRevision: salesChannel.revision,
    }),
  );
  const change = async (
    key: string,
    change:
      | Readonly<{ kind: "count"; pieces: number }>
      | Readonly<{ kind: "add"; pieces: number }>,
  ) => {
    const stock = await required(admin.readStockSnapshot(merchantId));
    const position = stock.commerce.resources.inventoryPositions.find(
      (candidate) => candidate.id === product.positionId,
    );
    if (position === undefined) throw new Error("No financier position");
    const quantity = { amount: change.pieces, scale: 0, unit: "each" } as const;
    await applied(
      admin.reconcileInventory({
        merchantId,
        expectedMerchantRevision: stock.commerce.merchantRevision,
        idempotencyKey: `bakes_${key}`,
        inventoryPositionId: product.positionId,
        inventoryPositionRevision: position.revision,
        target: { kind: "aggregate" },
        change:
          change.kind === "count"
            ? {
                kind: "count",
                observedQuantity: quantity,
                explanation: "Opening count of the counter.",
              }
            : {
                kind: "adjustment",
                direction: "increase",
                quantity,
                reason: "correction",
                explanation: "Fresh financiers reached the counter.",
              },
      }),
    );
  };
  await change("opening", { kind: "count", pieces: day.openingStock });
  await reconcileFeed();
  let next = 0;
  return {
    merchantId,
    /** Runs the declared day's events up to the named checkpoint. */
    async runUntil(checkpoint: string): Promise<void> {
      for (; next < EVENTS.length; next += 1) {
        const event = EVENTS[next];
        if (event === undefined) break;
        if (event.kind === "checkpoint") {
          if (event.name === checkpoint) {
            next += 1;
            return;
          }
          continue;
        }
        const key = `${event.kind}_${String(next)}`;
        if (event.kind === "sale")
          await placePickupOrder(
            merchantId,
            "storefront_cafe",
            [
              {
                kind: "catalog",
                variantId: product.variantId,
                quantity: event.quantity ?? 1,
              },
            ],
            { key, email: "counter@example.test" },
          );
        else await change(key, { kind: "add", pieces: event.quantity ?? 0 });
        await reconcileFeed();
      }
      throw new Error(`No checkpoint ${checkpoint}`);
    },
  };
}

export async function reconcileFeed(): Promise<void> {
  const results = await runScheduledCommerceOutboxReconciliation(
    env,
    Date.now(),
  );
  for (const result of results)
    expect(result).toMatchObject({ kind: "drained", rejected: 0 });
}

async function applied(
  result: ReturnType<CommerceAdminClient["createInventoryItem"]>,
): Promise<void> {
  const value = await required(result);
  if (value.outcome === "rejected")
    throw new Error(JSON.stringify(value.error));
}

/**
 * The financier recipe in Kitchen, with one applied revision (Plan 84). Its
 * bake step gives a bake run its oven program, in seconds.
 */
export async function applyFinancierWorkflow(
  organisationId: string,
  session: IssuedControlSession,
  bakeSeconds = 900,
): Promise<void> {
  const compiled = await compileFinancierRecipe(
    financierRecipeInput(1, 2, bakeSeconds),
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  const response = await send(
    `${controlBase(organisationId)}/bakery/workflows/${day.level.workflowId}/apply`,
    session,
    "POST",
    {
      document: importScenario(compiled.value, {
        title: "Financier",
        recipe: "financier",
      }),
      baseDigest: null,
    },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

export function levelOf(inventoryItemId: string) {
  return {
    inventoryItemId,
    productName: day.product.name,
    levelPieces: day.level.levelPieces,
    piecesPerGroup: day.level.piecesPerGroup,
    workflowId: day.level.workflowId,
    kitchenLocation: day.level.kitchenLocation,
    expectedRevision: null as number | null,
  };
}

export function putLevel(
  organisationId: string,
  session: IssuedControlSession,
  level: ReturnType<typeof levelOf>,
) {
  return send(
    `${controlBase(organisationId)}/bakes/levels`,
    session,
    "PUT",
    level,
  );
}

export function decide(
  organisationId: string,
  session: IssuedControlSession,
  proposal: Pick<BakeProposalView, "proposalId">,
  body: Readonly<
    { decision: "approve" } | { decision: "reject"; reason: string }
  >,
) {
  return send(
    `${controlBase(organisationId)}/bakes/proposals/${proposal.proposalId}/decision`,
    session,
    "POST",
    body,
  );
}

export async function readBoard(
  organisationId: string,
  session: IssuedControlSession,
): Promise<BakeBoard> {
  const read = await send(
    `${controlBase(organisationId)}/bakes`,
    session,
    "GET",
  );
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return parseBakeBoard(read.body);
}

export function productOf(board: BakeBoard): BakeBoard["products"][number] {
  const product = board.products.find((item) => item.name === day.product.name);
  if (product === undefined) throw new Error("No counted financier");
  return product;
}

export async function onlyProposal(
  organisationId: string,
  session: IssuedControlSession,
): Promise<BakeProposalView> {
  const { proposals } = await readBoard(organisationId, session);
  expect(proposals).toHaveLength(1);
  const proposal = proposals[0];
  if (proposal === undefined) throw new Error("No proposal");
  return proposal;
}

export async function proposalOf(
  organisationId: string,
  session: IssuedControlSession,
  wanted: Pick<BakeProposalView, "proposalId">,
): Promise<BakeProposalView> {
  const proposal = (await readBoard(organisationId, session)).proposals.find(
    (item) => item.proposalId === wanted.proposalId,
  );
  if (proposal === undefined) throw new Error("No such proposal");
  return proposal;
}

export async function writeArtifact(
  path: string,
  value: Artifact,
): Promise<void> {
  const response = await env.JOURNEY_ARTIFACTS.fetch(
    `http://artifacts/${path}`,
    {
      method: "PUT",
      body: JSON.stringify({ status: "passed", ...value }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

export type Journey = {
  readonly outputs: Record<string, string[]>;
  readonly offered: Set<string>;
  inventoryItemId: string;
  proposalId: string;
};

export type Script = Readonly<{
  tool: string;
  args: () => Record<string, unknown>;
  ask?: readonly string[];
}>;

export function toolValue(raw: string): Record<string, unknown> {
  const message = JSON.parse(JSON.parse(raw) as string) as { output: string };
  const value: unknown = JSON.parse(message.output);
  if (!isRecord(value)) throw new Error("The tool gave no record");
  return value;
}

export function lastOutput(journey: Journey, word: string): string {
  const output = journey.outputs[word]?.at(-1);
  if (output === undefined) throw new Error(`No output for ${word}`);
  return output;
}

export async function chatThrough(
  fixture: MemoryFixture,
  person: Member,
  word: string,
): Promise<void> {
  const conversationId = await startChat(fixture, person, word);
  const pause = await pausedRequest(person, fixture.paths.chat, conversationId);
  const allowed = await allowAsPortal(
    person.organisationId,
    person.session,
    pause.id,
  );
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  const resumed = await resumeChat(
    person,
    fixture.paths.chat,
    conversationId,
    pause.id,
  );
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  await finished(person, conversationId);
}

export async function chatDirect(
  fixture: MemoryFixture,
  person: Member,
  word: string,
) {
  const conversationId = await startChat(fixture, person, word);
  await finished(person, conversationId);
  return conversationId;
}

let replies = 0;

/**
 * The fake model of a bake agent journey: it calls each word's tool, asks
 * for the tool's capability when the turn does not offer it, and keeps each
 * tool output. It only answers; the tools produce every outcome.
 */
export async function replyToModel(
  journey: Journey,
  scripts: (journey: Journey) => Readonly<Record<string, Script>>,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  replies += 1;
  const id = `bake_${String(replies)}`;
  const reply = (text: string): Response =>
    openRouterText(JSON.stringify({ kind: "reply", text }), id);
  for (const name of offeredToolNames(body)) journey.offered.add(name);
  const all = scripts(journey);
  const word = messageWord(body, Object.keys(all));
  const script = all[word];
  if (script === undefined) throw new Error(`No script for ${word}`);
  const called = lastCalledTool(body);
  const callTool = (): Response =>
    openRouterToolCall(script.tool, script.args(), `call_${id}`);
  if (called === null)
    return offeredToolNames(body).includes(script.tool)
      ? callTool()
      : openRouterToolCall(
          "tool_search",
          { query: script.tool, limit: 1 },
          `call_${id}`,
        );
  const output = requireLastToolOutput(body);
  switch (called) {
    case "tool_search":
      if (offeredToolNames(body).includes(script.tool)) return callTool();
      if (script.ask === undefined)
        throw new Error(`${word} found no ${script.tool}: ${output}`);
      return openRouterToolCall(
        "request_permission",
        { capabilityIds: script.ask, entityTypeReads: [] },
        `call_${id}`,
      );
    case "request_permission":
      expect(output).toContain("Allow prompt");
      return reply("I asked for permission.");
    case script.tool:
      if (output.includes("Allow prompt"))
        return reply("I asked for permission.");
      journey.outputs[word] = [...(journey.outputs[word] ?? []), output];
      return reply(`Finished ${word}.`);
    default:
      throw new Error(`Unexpected tool ${called} for ${word}`);
  }
}

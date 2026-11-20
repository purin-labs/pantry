// Plan 24 S1: the counter stock level of a fresh product and its bake
// proposals. The café sells financiers through its real QR order path, from
// a declared morning of orders (scripts/plan-24/counter-day.json), and Commerce
// restocks the counter. A fall of the counter stock below its level opens one
// proposal on a real Case, with one Slack card in the operations channel whose
// thread resolves to that Case. People decide the proposals in the Portal and
// on the card through the same decision; the Portal chat agent proposes and
// cannot approve. Slack, the gateway and the model are fakes that only record
// or answer; every asserted outcome comes from product code.
import { env, exports } from "cloudflare:workers";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it } from "vitest";
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
import day from "../../../../scripts/plan-24/counter-day.json";
import { runScheduledCommerceOutboxReconciliation } from "../../src/commerce/outbox-worker";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { parseUserId } from "../../src/ids";
import { placePickupOrder, required } from "./cafe-order-support";
import {
  draftAction,
  finished,
  messageWord,
  onlyDraft,
  startChat,
} from "./chat-journey-support";
import {
  lastCalledTool,
  pausedRequest,
  resumeChat,
} from "./chat-permission-support";
import { connectCommerceFixture } from "./commerce-support";
import {
  connectGateway,
  controlBase,
  credentialOf,
  enrollGateway,
  found,
  helloAndWait,
  readDeviceList,
  requireKitchenDevice,
  send,
  startGateway,
  type SimulatedGateway,
} from "./device-fleet-support";
import {
  installMemoryFixture,
  type Member,
  type MemoryFixture,
} from "./memory-support";
import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";
import { allowAsPortal } from "./permission-request-support";
import { signedButtonClick } from "./slack-side-case-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
  USER_ID,
  installSlackActorFixture,
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
  slackSimulator,
} from "./slack-journey-support";

type DayEvent = Readonly<{
  at: string;
  kind: "sale" | "restock" | "checkpoint";
  quantity?: number;
  name?: string;
}>;

const EVENTS = day.events as readonly DayEvent[];
const OVEN = "Deck oven";
const REJECT_IN_PORTAL = "The counter closes early today.";
const REJECT_IN_SLACK = "The moulds are still in the cooling rack.";

type Artifact = Record<string, unknown>;

it(
  "S1: a fall below the level opens one proposal and one Slack card, a viewer is refused, a rejection keeps its reason, a fall while one is open waits, and one Slack approval decides",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const fixture = await installSlackActorFixture();
    const slack = slackSimulator();
    const answers: string[] = [];
    network.use(
      slack.handler,
      http.post(
        "https://hooks.slack.com/actions/:team/:id/:token",
        async function recordAnswer({ request }) {
          const body: unknown = await request.json();
          answers.push(isRecord(body) ? String(body.text) : "");
          return HttpResponse.text("ok");
        },
      ),
    );
    const owner = fixture.ownerSession;
    const operator = await sessionOf(SLACK_ACTOR_USER_ID);
    const shop = await openCounterShop(ORGANISATION_ID, owner.session.userId);
    await applyFinancierWorkflow(ORGANISATION_ID, owner);
    const artifact: Artifact = { day: EVENTS };

    // 1. An admin sets the level. An operator cannot, and a viewer sees no
    //    edit control and is refused the write.
    const opening = await readBoard(ORGANISATION_ID, owner);
    const financier = productOf(opening);
    expect(financier.counterPieces).toBe(day.openingStock);
    const level = levelOf(financier.inventoryItemId);
    const byOperator = await putLevel(ORGANISATION_ID, operator, level);
    expect(byOperator.body).toMatchObject({
      error: "organisation_role_insufficient",
    });
    await setActorRole("viewer");
    const viewerBoard = await readBoard(ORGANISATION_ID, operator);
    expect(viewerBoard.access).toEqual({
      mayEditLevels: false,
      mayDecide: false,
    });
    expect(
      (await putLevel(ORGANISATION_ID, operator, level)).body,
    ).toMatchObject({ ok: false });
    await setActorRole("operator");
    expect((await readBoard(ORGANISATION_ID, operator)).access).toEqual({
      mayEditLevels: false,
      mayDecide: true,
    });
    const set = await putLevel(ORGANISATION_ID, owner, level);
    expect(set.status, JSON.stringify(set.body)).toBe(200);

    // 2. The morning runs. The first sale below the level opens exactly one
    //    proposal on a Case; the sales after it open none.
    await shop.runUntil("first_fall");
    const first = await onlyProposal(ORGANISATION_ID, owner);
    expect(first).toMatchObject({
      state: "open",
      origin: "stock",
      productName: day.product.name,
      workflowId: day.level.workflowId,
      workflowRevision: 1,
      quantityPieces: day.level.piecesPerGroup,
      mouldGroups: 1,
      oven: null,
      stockAvailable: 11,
      stockLevel: day.level.levelPieces,
    });
    expect((await readBoard(ORGANISATION_ID, owner)).levels[0]).toMatchObject({
      counterPieces: 8,
    });

    // 3. One Slack card, in a thread that resolves to the proposal's Case.
    const cards = (): Record<string, string>[] =>
      slack.messages.filter((message) =>
        String(message.text).startsWith("Bake proposal:"),
      );
    expect(cards()).toHaveLength(1);
    const firstCard = cards()[0] ?? {};
    expect(buttonsOf(firstCard)).toEqual(
      expect.arrayContaining(["bake_proposal_approve", "bake_proposal_reject"]),
    );
    expect(firstCard.text).toContain("Oven: none.");
    expect(await threadCase(String(firstCard.ts))).toBe(first.caseId);

    // A Slack Reject by a viewer's link is refused, and nothing changes.
    await setActorRole("viewer");
    await clickCard(firstCard, "bake_proposal_reject", first, "Not today");
    await expect.poll(() => answers.length).toBe(1);
    expect(answers[0]).toContain("operator");
    await setActorRole("operator");
    expect((await proposalOf(ORGANISATION_ID, owner, first)).state).toBe(
      "open",
    );

    // With no oven enrolled at the kitchen, the Portal refuses an approval
    // with the reason. A Portal rejection keeps its reason.
    const noOven = await decide(ORGANISATION_ID, owner, first, {
      decision: "approve",
    });
    expect(noOven.status).toBe(409);
    expect(noOven.body).toMatchObject({ error: "bake_oven_missing" });
    const rejected = await decide(ORGANISATION_ID, owner, first, {
      decision: "reject",
      reason: REJECT_IN_PORTAL,
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const firstEnd = await proposalOf(ORGANISATION_ID, owner, first);
    expect(firstEnd).toMatchObject({
      state: "rejected",
      decision: { via: "portal", role: "owner", reason: REJECT_IN_PORTAL },
    });
    await expect
      .poll(() => cards()[0]?.text ?? "")
      .toContain("Rejected in the Portal");
    expect(buttonsOf(cards()[0] ?? {})).not.toContain("bake_proposal_approve");

    // The kitchen's oven is enrolled on the Devices page.
    const gateway = await enrollOven(ORGANISATION_ID, owner);

    // The stock recovers through Commerce and falls again: a new proposal,
    // with the oven, and its own card.
    await shop.runUntil("second_fall");
    const proposals = await readBoard(ORGANISATION_ID, owner);
    const second = proposals.proposals.find(
      (proposal) => proposal.state === "open",
    );
    if (second === undefined) throw new Error("No second proposal");
    expect(second.oven?.name).toBe(OVEN);
    expect(cards()).toHaveLength(2);

    // 4. A fall while that proposal is open waits, with no card. When the
    //    open one ends, the waiting one opens with its own card.
    await shop.runUntil("fall_while_open");
    const waiting = (await readBoard(ORGANISATION_ID, owner)).proposals.find(
      (proposal) => proposal.state === "waiting",
    );
    if (waiting === undefined) throw new Error("No waiting proposal");
    expect(cards()).toHaveLength(2);
    const secondCard = await cardOf(cards(), second);
    await clickCard(
      secondCard,
      "bake_proposal_reject",
      second,
      REJECT_IN_SLACK,
    );
    await expect
      .poll(
        async () => (await proposalOf(ORGANISATION_ID, owner, second)).state,
      )
      .toBe("rejected");
    expect(await proposalOf(ORGANISATION_ID, owner, second)).toMatchObject({
      decision: { via: "slack", role: "operator", reason: REJECT_IN_SLACK },
    });
    await expect
      .poll(
        async () => (await proposalOf(ORGANISATION_ID, owner, waiting)).state,
      )
      .toBe("open");
    await expect.poll(() => cards().length).toBe(3);

    // 5. A Slack Approve by an operator's link approves it. A second click
    //    changes nothing and tells only the clicker.
    const third = await proposalOf(ORGANISATION_ID, owner, waiting);
    const thirdCard = await cardOf(cards(), third);
    expect(await threadCase(String(thirdCard.ts))).toBe(third.caseId);
    await clickCard(thirdCard, "bake_proposal_approve", third, null);
    await expect
      .poll(async () => (await proposalOf(ORGANISATION_ID, owner, third)).state)
      .toBe("approved");
    const approved = await proposalOf(ORGANISATION_ID, owner, third);
    expect(approved.decision).toMatchObject({
      via: "slack",
      role: "operator",
      reason: null,
    });
    await expect
      .poll(async () => (await cardOf(cards(), third)).text)
      .toContain("Approved in Slack");
    const answered = answers.length;
    await clickCard(thirdCard, "bake_proposal_approve", third, null);
    await expect.poll(() => answers.length).toBe(answered + 1);
    expect(answers.at(-1)).toContain("already approved");
    expect(await proposalOf(ORGANISATION_ID, owner, third)).toEqual(approved);
    expect(cards()).toHaveLength(3);
    await gateway.close();

    // 7. The artifact: each proposal, each card's text and each answer.
    const final = await readBoard(ORGANISATION_ID, owner);
    expect(final.proposals.map((proposal) => proposal.state).sort()).toEqual([
      "approved",
      "rejected",
      "rejected",
    ]);
    Object.assign(artifact, {
      proposals: final.proposals,
      cards: cards().map((card) => ({
        ts: card.ts,
        text: card.text,
        buttons: buttonsOf(card),
      })),
      slackAnswers: answers,
      refusals: {
        operatorLevelWrite: byOperator.body,
        approvalWithoutOven: noOven.body,
      },
    });
    await writeArtifact("plan-24/bake-proposal-slack.json", artifact);
  },
);

it(
  "S1: the Portal chat agent proposes a bake and a stock level for a person, cannot approve, and a person without the role stays refused",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const fixture = await installMemoryFixture();
    const { author, reviewer, viewer, organisationId } = fixture;
    const journey: Journey = {
      outputs: {},
      offered: new Set(),
      inventoryItemId: "",
    };
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        replyToModel.bind(null, journey),
      ),
    );
    const shop = await openCounterShop(organisationId, author.userId);
    await applyFinancierWorkflow(organisationId, author.session);
    const gateway = await enrollOven(organisationId, author.session);
    journey.inventoryItemId = productOf(
      await readBoard(organisationId, author.session),
    ).inventoryItemId;
    const set = await putLevel(
      organisationId,
      author.session,
      levelOf(journey.inventoryItemId),
    );
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    await shop.runUntil("first_fall");
    const fromStock = await onlyProposal(organisationId, author.session);
    expect(
      (
        await decide(organisationId, reviewer.session, fromStock, {
          decision: "approve",
        })
      ).status,
    ).toBe(200);

    // 6. The person asks the agent for a bake. The read is not in the
    //    catalogue: a prompt asks, and after the allow the agent proposes.
    //    The stock proposal is approved, so the new one waits.
    await chatThrough(fixture, author, "PROPOSEBAKE");
    const proposed = toolValue(lastOutput(journey, "PROPOSEBAKE"));
    expect(proposed).toMatchObject({
      kind: "bake_proposed",
      state: "waiting",
      quantityPieces: 2 * day.level.piecesPerGroup,
      mouldGroups: 2,
      oven: { name: OVEN },
    });
    for (const name of journey.offered)
      expect(name).not.toMatch(/bake.*(approve|reject|decide|end)/u);

    // The approved bake run ends (Plan 24 S4 calls this), and the agent's
    // proposal opens. A viewer is refused its decision; the person who asked
    // approves it in the Portal.
    const ended = await fixture.organisation.runBakeCommand({
      organisationId,
      command: {
        kind: "end",
        proposalId: fromStock.proposalId,
        reason: "The bake run ended.",
      },
    });
    expect(ended.ok && ended.value.kind).toBe("ended");
    const agents = await proposalOf(organisationId, author.session, {
      proposalId: String(proposed.proposalId),
    });
    expect(agents).toMatchObject({ state: "open", origin: "agent" });
    const byViewer = await decide(organisationId, viewer.session, agents, {
      decision: "approve",
    });
    expect(byViewer.body).toMatchObject({ ok: false });
    expect(
      (await proposalOf(organisationId, author.session, agents)).state,
    ).toBe("open");
    const approved = await decide(organisationId, author.session, agents, {
      decision: "approve",
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(
      await proposalOf(organisationId, author.session, agents),
    ).toMatchObject({
      state: "approved",
      decision: { via: "portal", role: "owner" },
    });

    // The agent proposes a new level. It changes nothing until the admin who
    // asked confirms the card; a viewer cannot set a level.
    const conversation = await chatDirect(fixture, author, "PROPOSELEVEL");
    expect(
      (await readBoard(organisationId, author.session)).levels[0]?.levelPieces,
    ).toBe(day.level.levelPieces);
    const draft = await onlyDraft(fixture, author, conversation);
    const confirmed = await draftAction(
      fixture,
      author,
      conversation,
      draft,
      "confirm",
    );
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect(
      (await readBoard(organisationId, author.session)).levels[0],
    ).toMatchObject({ levelPieces: 14, revision: 2 });
    expect(
      (
        await putLevel(organisationId, viewer.session, {
          ...levelOf(journey.inventoryItemId),
          expectedRevision: 2,
        })
      ).body,
    ).toMatchObject({ ok: false });
    await gateway.close();
    await writeArtifact("plan-24/bake-proposal-agent.json", {
      proposals: (await readBoard(organisationId, author.session)).proposals,
      agentProposal: proposed,
      offeredTools: [...journey.offered].sort(),
      viewerDecision: byViewer.body,
    });
  },
);

/** The café of a demo shop, with a counted financier on its menu. */
async function openCounterShop(organisationId: string, ownerUserId: string) {
  const merchantId = `merchant_bakes_${crypto.randomUUID().replaceAll("-", "")}`;
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

async function reconcileFeed(): Promise<void> {
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

/** The financier recipe in Kitchen, with one applied revision (Plan 84). */
async function applyFinancierWorkflow(
  organisationId: string,
  session: IssuedControlSession,
): Promise<void> {
  const compiled = await compileFinancierRecipe(
    financierRecipeInput(1, 2, 900),
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

/** A gateway at the kitchen reports an oven, and the owner confirms it. */
async function enrollOven(
  organisationId: string,
  session: IssuedControlSession,
): Promise<SimulatedGateway> {
  const started = await startGateway(
    organisationId,
    session,
    "Kitchen gateway",
  );
  const gateway = await connectGateway(
    await credentialOf(
      await enrollGateway(organisationId, started.gatewayId, started.code),
    ),
  );
  await helloAndWait(gateway, [
    found("oven-1", OVEN, {
      kind: "appliance",
      capabilities: [{ id: "bake", label: "Bake", revision: 1 }],
    }),
  ]);
  const oven = requireKitchenDevice(
    await readDeviceList(organisationId, session),
    OVEN,
  );
  const confirmed = await send(
    `${controlBase(organisationId)}/devices/${oven.deviceId}/confirm`,
    session,
    "POST",
    { name: OVEN, stationId: "station_bakery" },
  );
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return gateway;
}

async function sessionOf(userId: string): Promise<IssuedControlSession> {
  const parsed = parseUserId(userId);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return issueControlSession({
    db: env.DB,
    userId: parsed.value,
    now: Date.now(),
    ttlMs: 1_800_000,
  });
}

/** The Slack actor's role: the same linked Slack user as a viewer or operator. */
async function setActorRole(role: "operator" | "viewer"): Promise<void> {
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = ? WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(role, ORGANISATION_ID, SLACK_ACTOR_USER_ID)
    .run();
}

function levelOf(inventoryItemId: string) {
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

function putLevel(
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

function decide(
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

async function readBoard(
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

function productOf(board: BakeBoard): BakeBoard["products"][number] {
  const product = board.products.find((item) => item.name === day.product.name);
  if (product === undefined) throw new Error("No counted financier");
  return product;
}

async function onlyProposal(
  organisationId: string,
  session: IssuedControlSession,
): Promise<BakeProposalView> {
  const { proposals } = await readBoard(organisationId, session);
  expect(proposals).toHaveLength(1);
  const proposal = proposals[0];
  if (proposal === undefined) throw new Error("No proposal");
  return proposal;
}

async function proposalOf(
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

function buttonsOf(message: Record<string, string>): string[] {
  const blocks: unknown = JSON.parse(message.blocks ?? "[]");
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: unknown) =>
    isRecord(block) && block.type === "actions" && Array.isArray(block.elements)
      ? block.elements.flatMap((element: unknown) =>
          isRecord(element) ? [String(element.action_id)] : [],
        )
      : [],
  );
}

/** The card whose thread resolves to the proposal's Case. */
async function cardOf(
  cards: readonly Record<string, string>[],
  proposal: Pick<BakeProposalView, "caseId">,
): Promise<Record<string, string>> {
  for (const card of cards)
    if ((await threadCase(String(card.ts))) === proposal.caseId) return card;
  throw new Error("No card for the proposal");
}

/** The Case that the thread of a card's message resolves to. */
async function threadCase(ts: string): Promise<string | null> {
  const pin = await env.DB.prepare(
    "SELECT case_id AS caseId FROM slack_thread_case_pin WHERE channel_id = ? AND root_message_ts = ?",
  )
    .bind(CHANNEL_ID, ts)
    .first<{ caseId: string }>();
  return pin?.caseId ?? null;
}

/** A click on the card, as Slack signs it, with the text of its reason field. */
async function clickCard(
  card: Record<string, string>,
  actionId: string,
  proposal: Pick<BakeProposalView, "proposalId">,
  reason: string | null,
): Promise<void> {
  const response = await exports.default.fetch(
    await signedButtonClick({
      actionId,
      value: proposal.proposalId,
      user: USER_ID,
      channel: CHANNEL_ID,
      threadTs: null,
      proposalTs: String(card.ts),
      state: {
        bake_proposal_reason: {
          bake_proposal_reason_text: {
            type: "plain_text_input",
            value: reason,
          },
        },
      },
    }),
  );
  expect(response.status).toBe(200);
}

async function writeArtifact(path: string, value: Artifact): Promise<void> {
  const response = await env.JOURNEY_ARTIFACTS.fetch(
    `http://artifacts/${path}`,
    {
      method: "PUT",
      body: JSON.stringify({ status: "passed", ...value }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

type Journey = {
  readonly outputs: Record<string, string[]>;
  readonly offered: Set<string>;
  inventoryItemId: string;
};

type Script = Readonly<{
  tool: string;
  args: () => Record<string, unknown>;
  ask?: readonly string[];
}>;

function scripts(journey: Journey): Readonly<Record<string, Script>> {
  return {
    PROPOSEBAKE: {
      tool: "bake_propose",
      args: () => ({ inventoryItemId: journey.inventoryItemId, pieces: 10 }),
      ask: ["kitchen.bake.propose"],
    },
    PROPOSELEVEL: {
      tool: "bake_stock_level_propose",
      args: () => ({
        ...levelOf(journey.inventoryItemId),
        levelPieces: 14,
        expectedRevision: 1,
      }),
    },
  };
}

function toolValue(raw: string): Record<string, unknown> {
  const message = JSON.parse(JSON.parse(raw) as string) as { output: string };
  const value: unknown = JSON.parse(message.output);
  if (!isRecord(value)) throw new Error("The tool gave no record");
  return value;
}

function lastOutput(journey: Journey, word: string): string {
  const output = journey.outputs[word]?.at(-1);
  if (output === undefined) throw new Error(`No output for ${word}`);
  return output;
}

async function chatThrough(
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

async function chatDirect(
  fixture: MemoryFixture,
  person: Member,
  word: string,
) {
  const conversationId = await startChat(fixture, person, word);
  await finished(person, conversationId);
  return conversationId;
}

let replies = 0;

async function replyToModel(
  journey: Journey,
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

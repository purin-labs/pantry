// Plan 24 S1: the counter stock level of a fresh product and its bake
// proposals. The café sells financiers through its real QR order path, from
// a declared morning of orders (scripts/plan-24/counter-day.json), and Commerce
// restocks the counter. A fall of the counter stock below its level opens one
// proposal on a real Case, with one Slack card in the operations channel whose
// thread resolves to that Case. People decide the proposals in the Portal and
// on the card through the same decision; the Portal chat agent proposes and
// cannot approve. Slack, the gateway and the model are fakes that only record
// or answer; every asserted outcome comes from product code.
import { http, HttpResponse } from "msw";
import { expect, it } from "vitest";
import { isRecord } from "@purin-labs/std";

import type { IssuedControlSession } from "../../src/data/control-plane";
import {
  buttonsOf,
  cardOf,
  clickCard,
  sessionOf,
  setActorRole,
  threadCase,
} from "./bake-slack-support";
import {
  applyFinancierWorkflow,
  chatDirect,
  chatThrough,
  day,
  decide,
  lastOutput,
  levelOf,
  onlyProposal,
  openCounterShop,
  productOf,
  proposalOf,
  putLevel,
  readBoard,
  replyToModel,
  toolValue,
  writeArtifact,
  type Artifact,
  type Journey,
  type Script,
} from "./bake-support";
import { draftAction, onlyDraft } from "./chat-journey-support";
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
import { installMemoryFixture } from "./memory-support";
import { network } from "./network";
import {
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
  installSlackActorFixture,
  slackSimulator,
} from "./slack-journey-support";

const EVENTS = day.events;
const OVEN = "Deck oven";
const REJECT_IN_PORTAL = "The counter closes early today.";
const REJECT_IN_SLACK = "The moulds are still in the cooling rack.";

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
      proposalId: "",
    };
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        replyToModel.bind(null, journey, scripts),
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

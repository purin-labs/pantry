// Plan 24, exit gate of the simulation phase: one declared café day
// (scripts/plan-24/cafe-day.json) runs two times in approval mode. The E2E
// suite empties every store before each test, so each day starts with a new
// Organisation from the Slack fixture (whose ids are fixed), a new gateway
// with its own credential, new devices, proposals, Cases and dispatch
// identities. Each fall of the counter stock below
// its level opens one proposal; a person approves it in the Portal or on its
// Slack card; two cobots load and unload the oven through the real gateway
// relay and the controller simulator; a person checks the pieces and the
// counter stock rises through Commerce. At the end the Portal read and the
// Slack record hold every proposal, approval, dispatch, receipt and check,
// and the two days give the same outcomes. Slack is a fake that only records
// and answers; every outcome comes from product code.
import { http, HttpResponse } from "msw";
import { expect, it } from "vitest";
import type { BakeRunRead } from "@purin-labs/kitchen-control-api";

import cafeDay from "../../../../scripts/plan-24/cafe-day.json";
import {
  closeCobotKitchen,
  controllerState,
  equipCobotKitchen,
  readRun,
  runAction,
  runUntil,
  sentTasks,
} from "./bake-run-support";
import { cardOf, clickCard, sessionOf } from "./bake-slack-support";
import { controllerControl } from "./cobot-gateway-support";
import {
  decide,
  productOf,
  proposalOf,
  readBoard,
  reconcileFeed,
  writeArtifact,
  type DayEvent,
} from "./bake-support";
import { network } from "./network";
import {
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
  installSlackActorFixture,
  slackSimulator,
} from "./slack-journey-support";

type Bake = Readonly<{
  checkpoint: string;
  approveIn: "portal" | "slack";
  goodPieces: number;
}>;

const BAKES = cafeDay.bakes as readonly Bake[];
const DAY = {
  openingStock: cafeDay.openingStock,
  events: cafeDay.events as readonly DayEvent[],
};

/** The outcome of each day, to compare the two days. */
const days: Record<string, unknown>[] = [];

/** The record without what each fresh day names differently. */
function outcomeOf(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replace(/dsp_[a-f0-9]{24}/gu, "dsp_*")
      .replace(/bake_[a-f0-9]{24}/gu, "bake_*")
      .replace(/receipt [A-Za-z0-9_:-]+\)/gu, "receipt *)"),
  ) as unknown;
}

async function cafeDayJourney(label: string): Promise<void> {
  const fixture = await installSlackActorFixture();
  const slack = slackSimulator();
  network.use(
    slack.handler,
    http.post("https://hooks.slack.com/actions/:team/:id/:token", () =>
      HttpResponse.text("ok"),
    ),
  );
  const owner = fixture.ownerSession;
  const operator = await sessionOf(SLACK_ACTOR_USER_ID);
  const kitchen = await equipCobotKitchen({
    organisationId: ORGANISATION_ID,
    owner,
    ownerUserId: owner.session.userId,
    merchantId: null,
    home: `bake-cafe-day-${label}`,
    timeScale: 10,
    mode: "approval",
    bakeSeconds: 120,
    level: cafeDay.level,
    day: DAY,
  });
  const cards = () =>
    slack.messages.filter((message) =>
      String(message.text).startsWith("Bake proposal:"),
    );
  const stock: (number | null)[] = [
    productOf(await readBoard(ORGANISATION_ID, owner)).counterPieces,
  ];
  const runs: BakeRunRead["run"][] = [];
  /** The moves that the controller started for each bake's tasks. */
  const moves: number[] = [];

  // Each checkpoint of the day: the fall opened one proposal, a person
  // approves it, the run bakes with both cobots, a person checks the pieces.
  for (const [index, bake] of BAKES.entries()) {
    await kitchen.shop.runUntil(bake.checkpoint);
    const board = await readBoard(ORGANISATION_ID, owner);
    expect(board.proposals).toHaveLength(index + 1);
    const proposal = board.proposals.find((item) => item.state === "open");
    if (proposal === undefined)
      throw new Error(`No proposal at ${bake.checkpoint}`);
    expect(proposal).toMatchObject({ origin: "stock", mouldGroups: 1 });
    if (bake.approveIn === "portal") {
      const approved = await decide(ORGANISATION_ID, operator, proposal, {
        decision: "approve",
      });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    } else {
      await expect.poll(() => cards().length).toBe(index + 1);
      await clickCard(
        await cardOf(cards(), proposal),
        "bake_proposal_approve",
        proposal,
        null,
      );
      // Pantry answers Slack at once and decides after the answer.
      await expect
        .poll(
          async () =>
            (await proposalOf(ORGANISATION_ID, owner, proposal)).state,
          { timeout: 20_000 },
        )
        .toBe("approved");
    }
    const done = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.state === "completed",
      180_000,
    );
    expect(done.run.hold).toBeNull();
    expect(
      done.run.view?.tasks.map((task) => [
        task.key,
        task.sourceKey,
        task.state,
      ]),
    ).toEqual([
      ["load-1", "cobot-1", "completed"],
      ["bake", "oven-1", "completed"],
      ["unload-1", "cobot-2", "completed"],
    ]);
    const before = productOf(
      await readBoard(ORGANISATION_ID, owner),
    ).counterPieces;
    const checked = await runAction(
      ORGANISATION_ID,
      operator,
      proposal.proposalId,
      {
        action: "check",
        goodPieces: bake.goodPieces,
      },
    );
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    await reconcileFeed();
    const after = productOf(
      await readBoard(ORGANISATION_ID, owner),
    ).counterPieces;
    expect(after).toBe((before ?? 0) + bake.goodPieces);
    stock.push(before, after);
    expect((await proposalOf(ORGANISATION_ID, owner, proposal)).state).toBe(
      "ended",
    );
    runs.push((await readRun(ORGANISATION_ID, owner, proposal.proposalId)).run);
    moves.push((await controllerState(kitchen.home)).submitted.length);
    // A person releases the pieces and returns the mould group to the cold
    // rack: the simulator's world is its first layout again.
    expect(
      await controllerControl(kitchen.home, { op: "reset" }),
    ).toMatchObject({ ok: true });
  }
  await kitchen.shop.runUntil("close");
  stock.push(productOf(await readBoard(ORGANISATION_ID, owner)).counterPieces);

  // The Portal holds the full record: each proposal with its approval, and
  // each run with its dispatches, receipts and check.
  const board = await readBoard(ORGANISATION_ID, owner);
  expect(board.proposals.map((item) => item.state)).toEqual(
    BAKES.map(() => "ended"),
  );
  expect(
    [...board.proposals]
      .sort((left, right) => left.proposedAt - right.proposedAt)
      .map((item) => item.decision?.via),
  ).toEqual(BAKES.map((bake) => bake.approveIn));
  for (const [index, run] of runs.entries()) {
    expect(run).toMatchObject({
      state: "checked",
      check: { goodPieces: BAKES[index]?.goodPieces, role: "operator" },
    });
    expect(run.dispatches.map((item) => [item.step, item.state])).toEqual([
      ["load-1", "sent"],
      ["bake", "sent"],
      ["unload-1", "sent"],
    ]);
    for (const task of run.view?.tasks ?? [])
      expect(task.observed.observedSeconds).not.toBeNull();
  }

  // The Slack record holds the same: each proposal's card with its approval
  // and its check, and each run's card in that card's thread with its
  // dispatches and receipts.
  const record = cards().map((card) => {
    const thread = slack.messages.filter(
      (message) => message.thread_ts === card.ts,
    );
    return {
      card: card.text,
      runCard: thread.find((message) =>
        String(message.text).startsWith("Bake run of"),
      )?.text,
    };
  });
  expect(record).toHaveLength(BAKES.length);
  for (const [index, entry] of record.entries()) {
    const bake = BAKES[index];
    expect(entry.card).toContain(
      bake?.approveIn === "slack"
        ? "Approved in Slack"
        : "Approved in the Portal",
    );
    expect(entry.card).toContain(
      `Checked: ${String(bake?.goodPieces)} good pieces`,
    );
    for (const step of ["load-1", "bake", "unload-1"])
      expect(entry.runCard).toMatch(
        new RegExp(
          `- ${step} on [a-z0-9-]+: done\\. Dispatch dsp_[a-f0-9]{24}: sent\\. The controller's receipt: [0-9.]+ s\\.`,
          "u",
        ),
      );
  }
  expect(moves).toEqual(BAKES.map(() => 3));
  expect(sentTasks(kitchen.sentToGateway)).toHaveLength(3 * BAKES.length);
  await closeCobotKitchen(kitchen);
  days.push(
    outcomeOf({
      stock,
      proposals: [...board.proposals]
        .sort((left, right) => left.proposedAt - right.proposedAt)
        .map((item) => ({
          state: item.state,
          quantityPieces: item.quantityPieces,
          mouldGroups: item.mouldGroups,
          stockAvailable: item.stockAvailable,
          via: item.decision?.via,
          role: item.decision?.role,
          endReason: item.endReason,
        })),
      moves,
      runs: runs.map((run) => ({
        state: run.state,
        goodPieces: run.check?.goodPieces,
        tasks: run.view?.tasks.map((task) => ({
          key: task.key,
          sourceKey: task.sourceKey,
          state: task.state,
          requestId: task.requestId,
          observedSeconds: task.observed.observedSeconds,
        })),
        dispatches: run.dispatches.map((item) => ({
          step: item.step,
          state: item.state,
          requestId: item.requestId,
        })),
      })),
      slack: record,
    }) as Record<string, unknown>,
  );
}

it(
  "Exit gate, day 1: the declared café day bakes each fall's proposal with two cobots through the real gateway, and the Portal and Slack hold every proposal, approval, dispatch, receipt and check",
  { timeout: 600_000 },
  () => cafeDayJourney("one"),
);

it(
  "Exit gate, day 2: the same café day again, from empty stores with a new gateway, devices and identities, gives the same outcomes",
  { timeout: 600_000 },
  async (): Promise<void> => {
    await cafeDayJourney("two");
    expect(days).toHaveLength(2);
    expect(days[1]).toEqual(days[0]);
    await writeArtifact("plan-24/cafe-day.json", {
      day: cafeDay,
      same: true,
      days,
    });
  },
);

// Plan 24 S6: a pause of an approved bake run from the Portal, from Slack
// and from the agent, and the late unload, through the real gateway relay and
// the controller simulator. A pause stops the next dispatch and pauses the
// run's cobots with the controller's `ack`; only a person resumes. The run's
// card in the proposal's Slack thread has a Pause button with the Portal's
// check. When the bake ends and no unload starts within the recipe's grace
// time, the run shows the over-bake risk and posts one message in the thread.
// Slack and the model are fakes that only record or answer; the relay and the
// simulator decide every receipt.
import { http, HttpResponse } from "msw";
import { expect, it } from "vitest";
import { newConversationId } from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import {
  DEVICES,
  closeCobotKitchen,
  controllerState,
  equipCobotKitchen,
  firstProposal,
  readRun,
  runAction,
  runUntil,
  sentTasks,
  taskOf,
  type CobotKitchen,
} from "./bake-run-support";
import {
  buttonsOf,
  clickCard,
  sessionOf,
  setActorRole,
} from "./bake-slack-support";
import {
  chatThrough,
  decide,
  replyToModel,
  toolValue,
  writeArtifact,
  type Journey,
  type Script,
} from "./bake-support";
import { installMemoryFixture, post } from "./memory-support";
import { network } from "./network";
import {
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
  installSlackActorFixture,
  slackSimulator,
} from "./slack-journey-support";

const TIME_SCALE = 10;
/** A bake long enough for the pauses and the chat turns: 30 s of wall. */
const LONG_BAKE_SECONDS = 300;
/** The late unload case: 12 s of wall. */
const SHORT_BAKE_SECONDS = 120;
/** The financier recipe's `examine-bake` step. */
const GRACE_SECONDS = 30;

type SlackShop = Readonly<{
  kitchen: CobotKitchen;
  slack: ReturnType<typeof slackSimulator>;
  answers: string[];
  operator: Awaited<ReturnType<typeof sessionOf>>;
}>;

async function slackKitchen(
  home: string,
  bakeSeconds: number,
): Promise<SlackShop> {
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
  const kitchen = await equipCobotKitchen({
    organisationId: ORGANISATION_ID,
    owner,
    ownerUserId: owner.session.userId,
    merchantId: null,
    home,
    timeScale: TIME_SCALE,
    mode: "approval",
    bakeSeconds,
  });
  return {
    kitchen,
    slack,
    answers,
    operator: await sessionOf(SLACK_ACTOR_USER_ID),
  };
}

function pausesOf(kitchen: CobotKitchen) {
  return kitchen.sentToGateway.filter((message) => message.type === "pause");
}

/** The Slack messages of one thread, by the root's ts. */
function threadOf(shop: SlackShop, rootTs: string) {
  return shop.slack.messages.filter((message) => message.thread_ts === rootTs);
}

it(
  "S6.5: a pause from the Portal and from the run's Slack card stops the next dispatch and pauses the cobots with their ack; a viewer's Slack click is refused; a person resumes and each task moves once",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const shop = await slackKitchen("bake-pause-slack", LONG_BAKE_SECONDS);
    const { kitchen, operator } = shop;
    const proposal = await firstProposal(kitchen);
    const approved = await decide(ORGANISATION_ID, operator, proposal, {
      decision: "approve",
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await runUntil(kitchen, proposal.proposalId, (read) =>
      ["running", "completed"].includes(taskOf(read, "load-1").state),
    );

    // 1. The Portal: the run pauses, the cobots get the Devices page's pause
    //    and answer it, and no next task goes while it is paused.
    const portalPause = await runAction(
      ORGANISATION_ID,
      operator,
      proposal.proposalId,
      { action: "pause" },
    );
    expect(portalPause.status, JSON.stringify(portalPause.body)).toBe(200);
    expect(
      (await readRun(ORGANISATION_ID, operator, proposal.proposalId)).run.state,
    ).toBe("paused");
    expect(
      pausesOf(kitchen)
        .map((m) => m.sourceKey)
        .sort(),
    ).toEqual(["cobot-1", "cobot-2"]);
    await expect
      .poll(
        async () =>
          (await controllerState(kitchen.home)).device("cobot-1").state,
      )
      .toBe("paused");
    const tasksWhilePaused = sentTasks(kitchen.sentToGateway).length;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(sentTasks(kitchen.sentToGateway)).toHaveLength(tasksWhilePaused);
    expect(
      (
        await runAction(ORGANISATION_ID, operator, proposal.proposalId, {
          action: "resume",
        })
      ).status,
    ).toBe(200);

    // 2. Slack: the run's card in the proposal's thread has Pause. A viewer's
    //    click is refused; an operator's click pauses the run.
    const root = shop.slack.messages.find((message) =>
      String(message.text).startsWith("Bake proposal:"),
    );
    if (root === undefined) throw new Error("No proposal card");
    const runCard = () =>
      threadOf(shop, String(root.ts)).find((message) =>
        String(message.text).startsWith("Bake run of"),
      );
    await expect
      .poll(() => buttonsOf(runCard() ?? {}))
      .toContain("bake_run_pause");
    const card = runCard();
    if (card === undefined) throw new Error("No run card");
    await setActorRole("viewer");
    await clickCard(card, "bake_run_pause", proposal, null, String(root.ts));
    await expect.poll(() => shop.answers.length).toBe(1);
    expect(shop.answers[0]).toContain("operator");
    await setActorRole("operator");
    expect(
      (await readRun(ORGANISATION_ID, operator, proposal.proposalId)).run.state,
    ).not.toBe("paused");
    const pausesBefore = pausesOf(kitchen).length;
    await clickCard(card, "bake_run_pause", proposal, null, String(root.ts));
    await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.state === "paused",
    );
    expect(pausesOf(kitchen).length).toBe(pausesBefore + 2);
    await expect.poll(() => runCard()?.text ?? "").toContain(": paused.");
    expect(buttonsOf(runCard() ?? {})).not.toContain("bake_run_pause");

    // 3. A person resumes in the Portal; the run ends with one move for
    //    each task.
    expect(
      (
        await runAction(ORGANISATION_ID, operator, proposal.proposalId, {
          action: "resume",
        })
      ).status,
    ).toBe(200);
    const done = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.state === "completed",
    );
    const controller = await controllerState(kitchen.home);
    for (const sourceKey of DEVICES)
      expect(controller.device(sourceKey).tasksStarted).toBe(1);
    expect(controller.submitted).toHaveLength(3);
    await expect
      .poll(() => runCard()?.text ?? "")
      .toContain("baked. A person checks the pieces");
    await closeCobotKitchen(kitchen);
    await writeArtifact("plan-24/bake-pause-slack.json", {
      pausesSent: pausesOf(kitchen),
      viewerAnswer: shop.answers[0],
      runCard: runCard(),
      run: done.run,
      controller: controller.state,
    });
  },
);

it(
  "S6.8: the unload is late after the bake: the run shows the over-bake risk to the person on shift in the Portal and posts one message in the proposal's Slack thread",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const shop = await slackKitchen("bake-late-unload", SHORT_BAKE_SECONDS);
    const { kitchen, operator } = shop;
    const proposal = await firstProposal(kitchen);
    expect(
      (
        await decide(ORGANISATION_ID, operator, proposal, {
          decision: "approve",
        })
      ).status,
    ).toBe(200);
    // The person on shift pauses the run during the bake. The oven keeps
    // its program, so the bake ends while the cobots wait.
    await runUntil(kitchen, proposal.proposalId, (read) =>
      ["accepted", "running"].includes(taskOf(read, "bake").state),
    );
    expect(
      (
        await runAction(ORGANISATION_ID, operator, proposal.proposalId, {
          action: "pause",
        })
      ).status,
    ).toBe(200);
    await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => taskOf(read, "bake").state === "completed",
    );
    const risky = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.unloadRisk !== null,
      60_000,
    );
    expect(risky.run.unloadRisk).toMatchObject({
      step: "unload-1",
      graceSeconds: GRACE_SECONDS,
    });
    expect(risky.run.unloadRisk?.notifiedAt).not.toBeNull();
    expect(risky.run.unloadRisk?.lateSeconds).toBeGreaterThan(0);
    const root = shop.slack.messages.find((message) =>
      String(message.text).startsWith("Bake proposal:"),
    );
    if (root === undefined) throw new Error("No proposal card");
    const warnings = () =>
      threadOf(shop, String(root.ts)).filter((message) =>
        String(message.text).startsWith("Over-bake risk:"),
      );
    await expect.poll(() => warnings().length).toBe(1);
    expect(warnings()[0]?.text).toContain(`within ${GRACE_SECONDS} s`);
    // The person resumes; the unload goes, and no second message comes.
    expect(
      (
        await runAction(ORGANISATION_ID, operator, proposal.proposalId, {
          action: "resume",
        })
      ).status,
    ).toBe(200);
    const done = await runUntil(
      kitchen,
      proposal.proposalId,
      (read) => read.run.state === "completed",
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(warnings()).toHaveLength(1);
    expect(done.run.unloadRisk).toMatchObject({ step: "unload-1" });
    await closeCobotKitchen(kitchen);
    await writeArtifact("plan-24/bake-late-unload.json", {
      risk: risky.run.unloadRisk,
      slackMessage: warnings()[0],
      run: done.run,
    });
  },
);

function agentScripts(journey: Journey): Readonly<Record<string, Script>> {
  return {
    READRUN: {
      tool: "bake_run_read",
      args: () => ({ proposalId: journey.proposalId }),
      ask: ["kitchen.bake.read"],
    },
    PAUSERUN: {
      tool: "bake_run_pause",
      args: () => ({ proposalId: journey.proposalId }),
      ask: ["kitchen.bake_run.pause"],
    },
  };
}

it(
  "S6.5: the Portal chat agent reads a run and pauses it for the person who asked, through the real gateway; a viewer cannot; only a person resumes, and each task moves once",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const fixture = await installMemoryFixture();
    const { author, viewer, organisationId } = fixture;
    const journey: Journey = {
      outputs: {},
      offered: new Set(),
      inventoryItemId: "",
      proposalId: "",
    };
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        replyToModel.bind(null, journey, agentScripts),
      ),
    );
    const kitchen = await equipCobotKitchen({
      organisationId,
      owner: author.session,
      ownerUserId: author.userId,
      merchantId: null,
      home: "bake-pause-agent",
      timeScale: TIME_SCALE,
      mode: "approval",
      bakeSeconds: LONG_BAKE_SECONDS,
    });
    const proposal = await firstProposal(kitchen);
    journey.proposalId = proposal.proposalId;
    expect(
      (
        await decide(organisationId, author.session, proposal, {
          decision: "approve",
        })
      ).status,
    ).toBe(200);

    // 1. The agent reads the run for the person.
    await chatThrough(fixture, author, "READRUN");
    const read = toolValue(journey.outputs.READRUN?.at(-1) ?? "");
    expect(read).toMatchObject({
      mode: "approval",
      proposalId: proposal.proposalId,
    });

    // 2. A viewer has no Portal chat, and the Bakes page refuses the
    //    viewer's own pause. The run goes on.
    const viewerChat = await post(viewer, fixture.paths.chat, {
      kind: "message",
      conversationId: newConversationId(),
      requestId: "request_viewer_pause",
      model: fixture.route.model,
      text: "PAUSERUN now.",
      surfaceContext: null,
      browserContext: { kind: "unavailable" },
    });
    expect(viewerChat.status).toBeGreaterThanOrEqual(403);
    const viewerPause = await runAction(
      organisationId,
      viewer.session,
      proposal.proposalId,
      { action: "pause" },
    );
    expect(viewerPause.status).toBeGreaterThanOrEqual(403);
    expect(pausesOf(kitchen)).toEqual([]);

    // 3. The owner asks the agent for a pause: the cobots pause, and no
    //    next task goes.
    await chatThrough(fixture, author, "PAUSERUN");
    const paused = toolValue(journey.outputs.PAUSERUN?.at(-1) ?? "");
    expect(JSON.stringify(paused)).toContain("bakepause_");
    const after = await readRun(
      organisationId,
      author.session,
      proposal.proposalId,
    );
    expect(after.run.state).toBe("paused");
    expect(
      pausesOf(kitchen)
        .map((m) => m.sourceKey)
        .sort(),
    ).toEqual(["cobot-1", "cobot-2"]);
    const tasksWhilePaused = sentTasks(kitchen.sentToGateway).length;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(sentTasks(kitchen.sentToGateway)).toHaveLength(tasksWhilePaused);
    for (const name of journey.offered)
      expect(name).not.toMatch(/bake.*(approve|dispatch|settle|resume|stop)/u);

    // 4. Only a person resumes; the run ends with one move for each task.
    expect(
      (
        await runAction(organisationId, author.session, proposal.proposalId, {
          action: "resume",
        })
      ).status,
    ).toBe(200);
    const done = await runUntil(
      kitchen,
      proposal.proposalId,
      (item) => item.run.state === "completed",
    );
    const controller = await controllerState(kitchen.home);
    for (const sourceKey of DEVICES)
      expect(controller.device(sourceKey).tasksStarted).toBe(1);
    await closeCobotKitchen(kitchen);
    await writeArtifact("plan-24/bake-pause-agent.json", {
      agentRead: read,
      viewerPause: { chat: await viewerChat.json(), portal: viewerPause.body },
      ownerPause: paused,
      pausesSent: pausesOf(kitchen),
      run: done.run,
      offeredTools: [...journey.offered].sort(),
    });
  },
);

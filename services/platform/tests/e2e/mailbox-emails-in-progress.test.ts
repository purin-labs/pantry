import { exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { http, type HttpResponseResolver } from "msw";
import { isRecord } from "@purin-labs/std";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { setUpMailbox } from "@purin-labs/area-inbox/ui/features/mail-setup/turn-on";
import { modelToolResults } from "./chat-journey-support";
import { commerceHeaders } from "./commerce-support";
import { installMemoryFixture, type Member } from "./memory-support";
import { network } from "./network";
import {
  acceptMailboxModel,
  connectGmailMailbox,
  draftReplyTurn,
  evaluateAt,
  FakeGmailMailbox,
  mailboxConnector,
  mailProcessing,
  portalSetupTransport,
  readReplyTurns,
  runDueMailWork,
  scheduledAt,
  sendAs,
  type MailboxConnector,
} from "./gmail-mailbox-support";

const ADDRESS = "hello@example.test";
const DRAFT = "Thank you. We can bake a birthday cake for Saturday.";

it(
  "answers more new email threads than the in-progress limit, one after another, and clears a pause at that limit with Resume",
  { timeout: 240_000 },
  emailsInProgressJourney,
);

async function emailsInProgressJourney({ task }: TestContext): Promise<void> {
  const {
    organisationId,
    author: owner,
    viewer,
  } = await installMemoryFixture();
  const gmail = new FakeGmailMailbox({
    address: ADDRESS,
    sender: "Customer <customer@example.test>",
    subject: "A birthday cake",
    text: "Can I order a birthday cake for Saturday?",
  });
  gmail.serve();
  const model = new DraftingAgent();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.answer.bind(model),
    ),
  );
  const account = await connectGmailMailbox(organisationId, owner, {
    label: "inprogress",
    address: ADDRESS,
  });
  const mailboxPath = `/v1/control/organisations/${organisationId}/agent-mailboxes/${account}`;
  await acceptMailboxModel(organisationId, owner);

  // The owner presses Turn on: the Portal's own press, which names no
  // limits. The owner accepted the model's terms above, so the press needs
  // no checkbox. The mailbox takes the server's limits: three emails in
  // progress.
  await setUpMailbox(
    portalSetupTransport(owner),
    { organisationId, integrationAccountId: account },
    { kind: "automatic" },
    true,
    null,
  );
  const policy = await mailboxPolicy(owner, mailboxPath);
  expect(policy).toMatchObject({ kind: "enabled", maxActiveCases: 3 });
  const connector = await mailboxConnector(organisationId, account);
  await runDueMailWork(connector);
  const arrive = (threads: readonly string[]) =>
    arriveAndEvaluate(
      gmail,
      owner,
      organisationId,
      mailboxPath,
      connector,
      threads,
    );

  // 1. Five new threads arrive one after another. Each is admitted, its
  //    reply turn drafts a reply for approval, and that ends its work: the
  //    thread gives its place back. The fourth and the fifth thread find a
  //    free place, so the mailbox never pauses.
  const inARow: unknown[] = [];
  for (let thread = 1; thread <= 5; thread += 1) {
    const evaluated = await arrive([`row_${String(thread)}`]);
    expect(evaluated, JSON.stringify(evaluated)).toMatchObject({
      kind: "evaluated",
      admitted: 1,
    });
    await finishReplyTurns(connector);
    const processing = await mailProcessing(connector);
    expect(processing.kind).not.toBe("paused");
    inARow.push({
      thread,
      evaluated: evaluated.kind,
      processing: processing.kind,
    });
  }
  expect(gmail.drafts.size).toBe(5);
  expect(model.replyTurns).toBe(5);

  // 2. Four new threads arrive at once. Three are admitted, and the fourth
  //    pauses the mailbox: three emails are in progress, the most at one
  //    time. A paused mailbox runs no reply turn, so the three wait.
  const burst = await arrive(["burst_1", "burst_2", "burst_3", "burst_4"]);
  expect(burst).toEqual({ kind: "paused", reason: "active_case_limit" });
  const paused = await mailProcessing(connector);
  expect(paused).toMatchObject({
    kind: "paused",
    reason: { kind: "active_case_limit", observed: 3, limit: 3 },
  });
  await runDueMailWork(connector);
  expect(await runInDurableObject(connector, readReplyTurns)).toHaveLength(3);
  expect(gmail.drafts.size).toBe(5);

  // 3. A member without the right cannot resume the mailbox. The owner
  //    presses Resume: the three waiting replies finish first, which frees
  //    their places, and then the fourth thread is admitted and answered.
  const refused = await sendAs(viewer, `${mailboxPath}/resume`, {});
  expect(refused.status).toBe(404);
  expect((await mailProcessing(connector)).kind).toBe("paused");
  const resumed = await sendAs(owner, `${mailboxPath}/resume`, {});
  expect(resumed).toMatchObject({ status: 200, body: { ok: true } });
  await expect
    .poll(
      async () => {
        await runDueMailWork(connector);
        return gmail.drafts.size;
      },
      { timeout: 60_000, interval: 200 },
    )
    .toBe(9);
  await finishReplyTurns(connector);
  expect((await mailProcessing(connector)).kind).not.toBe("paused");
  expect(model.replyTurns).toBe(9);
  expect(gmail.unexpected).toEqual([]);

  Object.assign(task.meta, {
    emailsInProgress: {
      defaultLimit: policy.maxActiveCases,
      threadsInARow: inARow,
      burstOfFour: { evaluation: burst, pause: paused },
      viewerResume: refused,
      ownerResume: resumed.body,
      draftsAfterResume: gmail.drafts.size,
      replyTurns: model.replyTurns,
    },
  });
}

/**
 * New mail arrives in Gmail, the owner checks the mailbox, and the
 * Connector's evaluation runs at the time that the check scheduled.
 */
async function arriveAndEvaluate(
  gmail: FakeGmailMailbox,
  owner: Member,
  organisationId: OrganisationId,
  mailboxPath: string,
  connector: MailboxConnector,
  threads: readonly string[],
) {
  for (const thread of threads) gmail.arrive(`${thread}_message`, thread);
  const checked = await sendAs(owner, `${mailboxPath}/check`, {});
  return runInDurableObject(
    connector,
    evaluateAt.bind(null, organisationId, scheduledAt(checked)),
  );
}

/** Runs the Connector's due work until no reply turn waits. */
async function finishReplyTurns(connector: MailboxConnector): Promise<void> {
  await expect
    .poll(
      async () => {
        await runDueMailWork(connector);
        return (await runInDurableObject(connector, readReplyTurns)).length;
      },
      { timeout: 60_000, interval: 200 },
    )
    .toBe(0);
}

/** The mailbox's policy as the Portal reads it. */
async function mailboxPolicy(
  person: Member,
  mailboxPath: string,
): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch(
    `https://localhost${mailboxPath}`,
    { headers: commerceHeaders(person.session) },
  );
  const body: unknown = await response.json();
  if (
    !response.ok ||
    !isRecord(body) ||
    !isRecord(body.mailbox) ||
    !isRecord(body.mailbox.policy)
  )
    throw new Error(JSON.stringify(body));
  return body.mailbox.policy;
}

/** The mailbox agent: each reply turn reads its Case and drafts a reply. */
class DraftingAgent {
  replyTurns = 0;
  async answer({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const results = modelToolResults(await request.json());
    if (results === 0) this.replyTurns += 1;
    return draftReplyTurn(results, DRAFT);
  }
}

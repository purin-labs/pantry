import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { http, HttpResponse } from "msw";
import { isRecord } from "@seams/std";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { installMemoryFixture, type Member } from "./memory-support";
import { network } from "./network";
import {
  connectGmailMailbox,
  sendAs,
  setUpMailbox,
  evaluateAt,
  mailboxConnector,
  mailProcessing,
  mailRuntime,
  readReplyTurns,
} from "./gmail-mailbox-support";
import { readAlarm } from "./case-execution-support";

const ADDRESS = "orders@example.test";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const COALESCE_MS = 30_000;

it(
  "finds new mail on request when no push comes, and admits it as a push would",
  { timeout: 120_000 },
  mailboxCheckJourney,
);

/** The mailbox as Gmail holds it. Nothing here sends a push. */
type GmailMailbox = {
  historyId: number;
  arrivals: {
    readonly id: string;
    readonly threadId: string;
    readonly historyId: number;
  }[];
  profileReads: number;
};

async function mailboxCheckJourney({ task }: TestContext): Promise<void> {
  const {
    organisationId,
    author: owner,
    reviewer: admin,
    viewer,
  } = await installMemoryFixture();
  const gmail: GmailMailbox = {
    historyId: 1000,
    arrivals: [],
    profileReads: 0,
  };
  serveGmail(gmail);
  const account = await connectGmailMailbox(organisationId, owner, {
    label: "check",
    address: ADDRESS,
  });
  const base = `/v1/control/organisations/${organisationId}`;
  const mailboxPath = `${base}/agent-mailboxes/${account}`;
  const check = (person: Member, path = `${mailboxPath}/check`) =>
    sendAs(person, path, {});

  // 1. A connected mailbox that is not on has no mail processing to start.
  const beforeOn = await check(owner);
  expect(beforeOn).toEqual({
    status: 409,
    body: { ok: false, error: "agent_mailbox_not_processing" },
  });

  // 2. The owner sets the mailbox up and turns it on. The evaluation that
  //    the activation schedules finds no mail, and then nothing is
  //    scheduled: without a push, the mailbox waits.
  await setUpMailbox(owner, organisationId, account);
  const on = await sendAs(owner, `${mailboxPath}/policy`, {
    policy: {
      kind: "enabled",
      // One open Case at most, so a second thread pauses processing.
      maxActiveCases: 1,
      maxMessagesPerHour: 20,
      dailyTokenBudget: 200_000,
      maxMessageBytes: 262_144,
      maxAttachmentBytes: 5_242_880,
      debounce: { kind: "push_triggered", coalesceSeconds: 30 },
      overflow: "pause_and_notify",
    },
  });
  expect(on).toMatchObject({ status: 200, body: { ok: true } });
  const connector = await mailboxConnector(organisationId, account);
  await runDurableObjectAlarm(connector);
  await expect
    .poll(mailProcessing.bind(null, connector), { timeout: 10_000 })
    .toEqual({ kind: "waiting" });
  const profileReadsWhenOn = gmail.profileReads;

  // 3. Mail arrives in Gmail. Google sends no push, as on a local backend.
  gmail.historyId = 1005;
  gmail.arrivals.push({
    id: "check_message",
    threadId: "check_thread",
    historyId: 1005,
  });
  expect(await mailProcessing(connector)).toEqual({ kind: "waiting" });

  // 4. A member below the admin role, and a mailbox that does not exist, are
  //    refused. Neither asks Gmail anything or changes the mailbox.
  const refusedViewer = await check(viewer);
  expect(refusedViewer).toEqual({
    status: 404,
    body: { ok: false, error: "organisation_role_insufficient" },
  });
  const unknown = await check(
    owner,
    `${base}/agent-mailboxes/integration_account_unknown/check`,
  );
  expect(unknown).toEqual({
    status: 404,
    body: { ok: false, error: "agent_mailbox_missing" },
  });
  expect(gmail.profileReads).toBe(profileReadsWhenOn);
  expect(await mailProcessing(connector)).toEqual({ kind: "waiting" });

  // 5. The owner checks. The Connector reads the history id from the
  //    profile with the mailbox's credential and admits it as a push: the
  //    evaluation is scheduled one coalescing interval later.
  const requestedAt = Date.now();
  const first = await check(owner);
  const answeredAt = Date.now();
  expect(first.status).toBe(200);
  const at = scheduledAt(first.body);
  expect(at).toBeGreaterThanOrEqual(requestedAt + COALESCE_MS);
  expect(at).toBeLessThanOrEqual(answeredAt + COALESCE_MS);
  expect(gmail.profileReads).toBe(profileReadsWhenOn + 1);
  const observed = await mailRuntime(connector);
  expect(observed).toMatchObject({
    highestObservedHistoryId: "1005",
    acceptedHistoryId: "1000",
    processing: { kind: "scheduled", at },
  });
  // The Connector's alarm wakes it for that evaluation.
  const alarm = await runInDurableObject(connector, readAlarm);
  expect(alarm).not.toBeNull();
  expect(alarm).toBeLessThanOrEqual(at);

  // 6. A second check while the evaluation is scheduled keeps its time, as a
  //    second push does. A retry of one request answers from its receipt and
  //    does not ask Gmail again.
  const second = await check(admin);
  expect(second).toEqual({ status: 200, body: { kind: "scheduled", at } });
  const key = crypto.randomUUID();
  const sent = await sendAs(owner, `${mailboxPath}/check`, {}, key);
  const retried = await sendAs(owner, `${mailboxPath}/check`, {}, key);
  expect(sent).toEqual({ status: 200, body: { kind: "scheduled", at } });
  expect(retried).toEqual(sent);
  expect(gmail.profileReads).toBe(profileReadsWhenOn + 3);
  // Each check was one admitted notification, with an identifier that no
  // Pub/Sub message has.
  const notifications = await runInDurableObject(
    connector,
    readNotificationIds,
  );
  expect(notifications).toHaveLength(3);
  expect(notifications.every(isCheckNotification)).toBe(true);

  // 7. Before its time the evaluation does nothing. At its time it reads
  //    the history from the accepted cursor and admits the new message to
  //    the thread's Case, the same way the push journeys admit mail.
  const early = await runInDurableObject(
    connector,
    evaluateAt.bind(null, organisationId, at - 1),
  );
  expect(early).toEqual({ kind: "idle" });
  const evaluated = await runInDurableObject(
    connector,
    evaluateAt.bind(null, organisationId, at),
  );
  const caseId = `case_gmail_${account}_check_thread`;
  expect(evaluated).toEqual({
    kind: "evaluated",
    admitted: 1,
    deduplicated: 0,
    threads: [
      { threadId: "check_thread", caseId, messageIds: ["check_message"] },
    ],
  });
  expect(await mailRuntime(connector)).toMatchObject({
    acceptedHistoryId: "1005",
    processing: { kind: "waiting" },
  });
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const receipts = await scope.database
    .prepare(
      `SELECT provider_message_id AS messageId, case_id AS caseId
       FROM email_message_receipt
       WHERE organisation_id = ? AND integration_account_id = ?`,
    )
    .bind(organisationId, account)
    .all<{ messageId: string; caseId: string }>();
  expect(receipts.results).toEqual([{ messageId: "check_message", caseId }]);
  // The admitted message is owed a reply turn, as pushed mail is.
  expect(await runInDurableObject(connector, readReplyTurns)).toEqual([
    { messageId: "check_message", caseId },
  ]);

  // 8. A second thread arrives. The check schedules its evaluation, which
  //    pauses processing at the open-Case limit before the message is
  //    admitted. A check then only records the history and answers
  //    "observed": no evaluation is scheduled while processing is paused.
  gmail.historyId = 1010;
  gmail.arrivals.push({
    id: "second_message",
    threadId: "second_thread",
    historyId: 1010,
  });
  const next = await check(owner);
  expect(next.status).toBe(200);
  const nextAt = scheduledAt(next.body);
  expect(nextAt).toBeGreaterThanOrEqual(at + COALESCE_MS);
  const paused = await runInDurableObject(
    connector,
    evaluateAt.bind(null, organisationId, nextAt),
  );
  expect(paused).toEqual({ kind: "paused", reason: "active_case_limit" });
  gmail.historyId = 1012;
  const whilePaused = await check(owner);
  expect(whilePaused).toEqual({ status: 200, body: { kind: "observed" } });
  expect(await mailRuntime(connector)).toMatchObject({
    acceptedHistoryId: "1005",
    highestObservedHistoryId: "1012",
    processing: { kind: "paused", reason: { kind: "active_case_limit" } },
  });

  // 9. The owner turns the mailbox off. A check is refused and asks Gmail
  //    nothing.
  const off = await sendAs(owner, `${mailboxPath}/disable`, {});
  expect(off).toMatchObject({ status: 200, body: { ok: true } });
  const readsWhenOff = gmail.profileReads;
  const afterOff = await check(owner);
  expect(afterOff).toEqual({
    status: 409,
    body: { ok: false, error: "agent_mailbox_not_processing" },
  });
  expect(gmail.profileReads).toBe(readsWhenOff);

  // The record names the account by a placeholder, so two runs compare.
  const record = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value).replaceAll(account, "<account>"));
  Object.assign(task.meta, {
    mailboxCheck: {
      route:
        "POST /v1/control/organisations/:organisationId/agent-mailboxes/:integrationAccountId/check",
      beforeOn: beforeOn.body,
      waitingWithoutPush: true,
      viewer: refusedViewer,
      unknownMailbox: unknown,
      firstCheck: {
        kind: "scheduled",
        delayAtLeastMs: COALESCE_MS,
        historyObserved: "1005",
      },
      secondCheckKeptTime: true,
      retryAnsweredFromReceipt: true,
      notificationsAdmitted: notifications.length,
      evaluation: record(evaluated),
      receipts: record(receipts.results),
      pausedEvaluation: paused,
      checkWhilePaused: whilePaused.body,
      afterOff: afterOff.body,
    },
  });
}

/**
 * Gmail for this mailbox: its profile, its watch, the history of its Inbox
 * and the metadata of each message in it.
 */
function serveGmail(gmail: GmailMailbox): void {
  network.use(
    http.get(`${GMAIL}/profile`, () => {
      gmail.profileReads += 1;
      return HttpResponse.json({
        emailAddress: ADDRESS,
        historyId: String(gmail.historyId),
      });
    }),
    http.post(`${GMAIL}/watch`, () =>
      HttpResponse.json({
        historyId: String(gmail.historyId),
        expiration: String(Date.now() + 2 * 86_400_000),
      }),
    ),
    http.post(`${GMAIL}/stop`, () => new HttpResponse(null, { status: 204 })),
    http.get(`${GMAIL}/history`, ({ request }) => {
      const start = Number(
        new URL(request.url).searchParams.get("startHistoryId"),
      );
      return HttpResponse.json({
        historyId: String(gmail.historyId),
        history: gmail.arrivals
          .filter((arrival) => arrival.historyId > start)
          .map((arrival) => ({
            id: String(arrival.historyId),
            messagesAdded: [
              {
                message: {
                  id: arrival.id,
                  threadId: arrival.threadId,
                  labelIds: ["INBOX"],
                },
              },
            ],
          })),
      });
    }),
    http.get(`${GMAIL}/messages/:messageId`, ({ params }) => {
      const arrival = gmail.arrivals.find(
        (candidate) => candidate.id === params.messageId,
      );
      if (arrival === undefined)
        return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
      return HttpResponse.json({
        id: arrival.id,
        threadId: arrival.threadId,
        labelIds: ["INBOX"],
        sizeEstimate: 2_048,
        internalDate: String(1_790_000_000_000 + arrival.historyId),
        payload: {
          headers: [
            { name: "From", value: "Supplier <supplier@example.test>" },
          ],
        },
      });
    }),
  );
}

function scheduledAt(body: unknown): number {
  if (
    !isRecord(body) ||
    body.kind !== "scheduled" ||
    typeof body.at !== "number" ||
    Object.keys(body).length !== 2
  )
    throw new Error(`Not a scheduled check: ${JSON.stringify(body)}`);
  return body.at;
}

function readNotificationIds(_actor: unknown, state: DurableObjectState) {
  return state.storage.sql
    .exec<{ id: string }>(
      "SELECT notification_id AS id FROM connector_email_notification ORDER BY observed_at",
    )
    .toArray()
    .map((row) => row.id);
}

function isCheckNotification(id: string): boolean {
  return /^check:[0-9a-f-]{36}$/u.test(id);
}

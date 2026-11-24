import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { http, HttpResponse } from "msw";
import {
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { installMemoryFixture } from "./memory-support";
import { network } from "./network";
import {
  connectGmailMailbox,
  sendAs,
  setUpMailbox,
  evaluateAt,
  mailboxConnector,
  mailRuntime,
  readReplyTurns,
  scheduledAt,
  mailProcessing,
} from "./gmail-mailbox-support";
import { runAlarmHandler } from "./durable-object-alarm-support";

const ADDRESS = "orders@example.test";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const COALESCE_MS = 30_000;
const HOUR_MS = 3_600_000;
/** Gmail may return fewer records than asked. This mailbox returns two. */
const HISTORY_PAGE_RECORDS = 2;
/** The pages that one evaluation reads at most (MAX_HISTORY_PAGES). */
const HISTORY_PAGES_PER_READ = 10;

it(
  "answers a mail that a person moves from Spam to the Inbox once, and no mail moved from elsewhere",
  { timeout: 120_000 },
  spamRescueJourney,
);

type GmailMessage = {
  readonly id: string;
  readonly threadId: string;
  readonly internalDate: number;
  labels: string[];
};

/** One change that Gmail recorded, with the labels the message had after it. */
type GmailChange = {
  readonly id: number;
  readonly messageId: string;
  readonly delivered: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly labelsAfter: readonly string[];
};

/** The mailbox as Gmail holds it. Nothing here sends a push. */
type GmailMailbox = {
  historyId: number;
  readonly messages: Map<string, GmailMessage>;
  readonly changes: GmailChange[];
  readonly historyQueries: string[];
  readonly metadataReads: string[];
};

async function spamRescueJourney({ task }: TestContext): Promise<void> {
  const { organisationId, author: owner } = await installMemoryFixture();
  const startedAt = Date.now();
  const gmail: GmailMailbox = {
    historyId: 900,
    messages: new Map(),
    changes: [],
    historyQueries: [],
    metadataReads: [],
  };
  // Before the mailbox is on. Two dozen read Inbox mails wait unread. One
  // Inbox mail of five hours ago is archived. Three mails land in Spam: one
  // of two hours ago, one of five days ago, and one that the person rescues
  // at once, before the mailbox is on.
  for (let index = 0; index < 24; index += 1)
    deliver(
      gmail,
      `inbox_${index}`,
      ["INBOX", "UNREAD"],
      startedAt - 6 * HOUR_MS,
    );
  deliver(gmail, "archived_message", ["INBOX"], startedAt - 5 * HOUR_MS);
  relabel(gmail, "archived_message", { remove: ["INBOX"] });
  deliver(gmail, "early_spam", ["SPAM", "UNREAD"], startedAt - 2 * HOUR_MS);
  deliver(
    gmail,
    "stale_spam",
    ["SPAM", "UNREAD"],
    startedAt - 5 * 24 * HOUR_MS,
  );
  deliver(gmail, "rescued_before_on", ["SPAM"], startedAt - 3 * HOUR_MS);
  notSpam(gmail, "rescued_before_on");
  gmail.historyId = 1000;
  serveGmail(gmail);

  // 1. The owner connects the mailbox, sets it up and turns it on. The
  //    activation floor is the history id 1000. The first evaluation finds
  //    nothing.
  const account = await connectGmailMailbox(organisationId, owner, {
    label: "rescue",
    address: ADDRESS,
  });
  const mailboxPath = `/v1/control/organisations/${organisationId}/agent-mailboxes/${account}`;
  await setUpMailbox(owner, organisationId, account);
  const on = await sendAs(owner, `${mailboxPath}/policy`, {
    policy: {
      kind: "enabled",
      maxActiveCases: 5,
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
  await runAlarmHandler(connector);
  await expect
    .poll(mailProcessing.bind(null, connector), { timeout: 10_000 })
    .toEqual({ kind: "waiting" });
  expect(await mailRuntime(connector)).toMatchObject({
    activationFloor: "1000",
    acceptedHistoryId: "1000",
  });
  const evaluate = async (): Promise<
    Readonly<{ at: number; outcome: unknown }>
  > => {
    const checked = await sendAs(owner, `${mailboxPath}/check`, {});
    const at = scheduledAt(checked);
    const outcome = await runInDurableObject(
      connector,
      evaluateAt.bind(null, organisationId, at),
    );
    return { at, outcome };
  };

  // 2. A mail lands in Spam. The evaluation reads the history and admits
  //    nothing.
  deliver(gmail, "spam_message", ["SPAM", "UNREAD"], startedAt - 60_000);
  const inSpam = await evaluate();
  expect(inSpam.outcome).toEqual({
    kind: "evaluated",
    admitted: 0,
    deduplicated: 0,
    threads: [],
  });
  expect(await mailRuntime(connector)).toMatchObject({
    acceptedHistoryId: String(gmail.historyId),
  });
  expect(gmail.historyQueries.at(-1)).toBe(
    "historyTypes=messageAdded,labelAdded,labelRemoved labelId=INBOX",
  );
  expect(await threadCases(organisationId, account)).toEqual([]);

  // 3. The person presses "Not spam" on that mail and on the mail of two
  //    hours ago, which came into Spam before the mailbox was on. Gmail may
  //    write a press as two records; here the second press is written so,
  //    and its records fall on two history pages. The person also presses
  //    "Not spam" on the mail of five days ago, and moves the archived mail
  //    back to the Inbox. One evaluation reads all of it.
  notSpam(gmail, "spam_message");
  relabel(gmail, "archived_message", { add: ["INBOX"] });
  notSpam(gmail, "stale_spam");
  relabel(gmail, "early_spam", { add: ["INBOX"] });
  relabel(gmail, "early_spam", { remove: ["SPAM"] });
  const metadataReadsBefore = gmail.metadataReads.length;
  const rescued = await evaluate();
  const spamCase = `case_gmail_${account}_spam_message_thread`;
  const earlyCase = `case_gmail_${account}_early_spam_thread`;
  // The older mail comes first, as in every evaluation.
  expect(rescued.outcome).toEqual({
    kind: "evaluated",
    admitted: 2,
    deduplicated: 0,
    threads: [
      {
        threadId: "early_spam_thread",
        caseId: earlyCase,
        messageIds: ["early_spam"],
      },
      {
        threadId: "spam_message_thread",
        caseId: spamCase,
        messageIds: ["spam_message"],
      },
    ],
  });
  const afterRescue = await mailRuntime(connector);
  expect(afterRescue).toMatchObject({
    acceptedHistoryId: String(gmail.historyId),
    processing: { kind: "waiting" },
  });
  // The archived mail is not a candidate: its metadata is never read. The
  // mail of five days ago is read and passed over.
  const readsInRescue = gmail.metadataReads.slice(metadataReadsBefore).sort();
  expect(readsInRescue).toEqual(["early_spam", "spam_message", "stale_spam"]);
  const expectedCases = [
    { threadId: "early_spam_thread", caseId: earlyCase },
    { threadId: "spam_message_thread", caseId: spamCase },
  ];
  expect(await threadCases(organisationId, account)).toEqual(expectedCases);
  const expectedReceipts = [
    { messageId: "early_spam", caseId: earlyCase },
    { messageId: "spam_message", caseId: spamCase },
  ];
  expect(await receipts(organisationId, account)).toEqual(expectedReceipts);
  // Each admitted mail is owed a reply turn, as a delivered mail is.
  expect(await runInDurableObject(connector, readReplyTurns)).toEqual(
    expectedReceipts,
  );

  // 4. The person reports the rescued mail as spam and presses "Not spam"
  //    again. The next history read names the same mail as a rescue. It is
  //    not admitted a second time.
  relabel(gmail, "spam_message", { add: ["SPAM"], remove: ["INBOX"] });
  notSpam(gmail, "spam_message");
  const again = await evaluate();
  expect(again.outcome).toEqual({
    kind: "evaluated",
    admitted: 0,
    deduplicated: 1,
    threads: [],
  });
  expect(await receipts(organisationId, account)).toEqual(expectedReceipts);
  expect(await runInDurableObject(connector, readReplyTurns)).toEqual(
    expectedReceipts,
  );

  // 5. The person marks the two dozen Inbox mails read. Then a new mail
  //    lands in Spam and the person presses "Not spam" on it. The read
  //    changes fill more history pages than one evaluation reads. The first
  //    evaluation stops at its page limit and moves the cursor to the last
  //    record it read. The evaluation scheduled after it reads the rest and
  //    admits the mail.
  const cursorBeforeNoise = gmail.historyId;
  for (let index = 0; index < 24; index += 1)
    relabel(gmail, `inbox_${index}`, { remove: ["UNREAD"] });
  deliver(gmail, "late_spam", ["SPAM", "UNREAD"], startedAt - 60_000);
  notSpam(gmail, "late_spam");
  const stopped = await evaluate();
  expect(stopped.outcome).toEqual({
    kind: "evaluated",
    admitted: 0,
    deduplicated: 0,
    threads: [],
  });
  const lastRecordRead =
    cursorBeforeNoise + HISTORY_PAGE_RECORDS * HISTORY_PAGES_PER_READ;
  const afterStop = await mailRuntime(connector);
  expect(afterStop).toMatchObject({
    acceptedHistoryId: String(lastRecordRead),
    processing: { kind: "scheduled", at: stopped.at + COALESCE_MS },
  });
  const resumed = await runInDurableObject(
    connector,
    evaluateAt.bind(null, organisationId, stopped.at + COALESCE_MS),
  );
  const lateCase = `case_gmail_${account}_late_spam_thread`;
  expect(resumed).toEqual({
    kind: "evaluated",
    admitted: 1,
    deduplicated: 0,
    threads: [
      {
        threadId: "late_spam_thread",
        caseId: lateCase,
        messageIds: ["late_spam"],
      },
    ],
  });
  expect(await mailRuntime(connector)).toMatchObject({
    acceptedHistoryId: String(gmail.historyId),
    processing: { kind: "waiting" },
  });
  const finalCases = await threadCases(organisationId, account);
  expect(finalCases).toEqual([
    { threadId: "early_spam_thread", caseId: earlyCase },
    { threadId: "late_spam_thread", caseId: lateCase },
    { threadId: "spam_message_thread", caseId: spamCase },
  ]);
  // Neither the archived mail, the mail of five days ago, the mail rescued
  // before the mailbox was on, nor a read Inbox mail has a Case.
  const finalReceipts = await receipts(organisationId, account);
  expect(finalReceipts.map((receipt) => receipt.messageId)).toEqual([
    "early_spam",
    "late_spam",
    "spam_message",
  ]);

  // The record names the account by a placeholder, so two runs compare.
  const record = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value).replaceAll(account, "<account>"));
  Object.assign(task.meta, {
    mailboxSpamRescue: {
      historyQuery: gmail.historyQueries.at(-1),
      activationFloor: "1000",
      spamArrival: inSpam.outcome,
      rescueEvaluation: record(rescued.outcome),
      metadataReadInRescue: readsInRescue,
      notAdmitted: {
        archivedMovedToInbox: "no metadata read, no Case",
        rescuedFiveDaysOld: "metadata read, older than 72 hours, no Case",
        rescuedBeforeActivation: "behind the activation floor, never read",
      },
      rescueAfterActivationOfSpamMailFromBeforeActivation: "admitted",
      secondRescueOfSameMail: again.outcome,
      pageLimitStop: {
        outcome: stopped.outcome,
        cursorAdvancedTo: afterStop.acceptedHistoryId,
        recordsPerRead: HISTORY_PAGE_RECORDS * HISTORY_PAGES_PER_READ,
      },
      resumedEvaluation: record(resumed),
      threadCases: record(finalCases),
      receipts: record(finalReceipts),
      replyTurns: record(await runInDurableObject(connector, readReplyTurns)),
    },
  });
}

/** Gmail delivers a message with these labels. */
function deliver(
  gmail: GmailMailbox,
  id: string,
  labels: readonly string[],
  internalDate: number,
): void {
  gmail.messages.set(id, {
    id,
    threadId: `${id}_thread`,
    internalDate,
    labels: [...labels],
  });
  gmail.historyId += 1;
  gmail.changes.push({
    id: gmail.historyId,
    messageId: id,
    delivered: true,
    added: [],
    removed: [],
    labelsAfter: [...labels],
  });
}

/** One label change, recorded as one history record. */
function relabel(
  gmail: GmailMailbox,
  id: string,
  change: Readonly<{ add?: readonly string[]; remove?: readonly string[] }>,
): void {
  const message = gmail.messages.get(id);
  if (message === undefined) throw new Error(`No message ${id}`);
  const added = change.add ?? [];
  const removed = change.remove ?? [];
  message.labels = [
    ...message.labels.filter((label) => !removed.includes(label)),
    ...added.filter((label) => !message.labels.includes(label)),
  ];
  gmail.historyId += 1;
  gmail.changes.push({
    id: gmail.historyId,
    messageId: id,
    delivered: false,
    added,
    removed,
    labelsAfter: [...message.labels],
  });
}

/** The "Not spam" press: INBOX added and SPAM removed in one record. */
function notSpam(gmail: GmailMailbox, id: string): void {
  relabel(gmail, id, { add: ["INBOX"], remove: ["SPAM"] });
}

/**
 * Gmail for this mailbox: its profile, its watch, its history and the
 * metadata of each message. The history keeps the change types asked for,
 * and a record whose changes were not asked for stays as its id and messages.
 * A label filter keeps a record when the message has the label after the
 * change, or when the change adds or removes it.
 */
function serveGmail(gmail: GmailMailbox): void {
  network.use(
    http.get(`${GMAIL}/profile`, () =>
      HttpResponse.json({
        emailAddress: ADDRESS,
        historyId: String(gmail.historyId),
      }),
    ),
    http.post(`${GMAIL}/watch`, () =>
      HttpResponse.json({
        historyId: String(gmail.historyId),
        expiration: String(Date.now() + 2 * 86_400_000),
      }),
    ),
    http.post(`${GMAIL}/stop`, () => new HttpResponse(null, { status: 204 })),
    http.get(`${GMAIL}/history`, ({ request }) => {
      const url = new URL(request.url);
      const start = Number(url.searchParams.get("startHistoryId"));
      const types = url.searchParams.getAll("historyTypes");
      const labelId = url.searchParams.get("labelId");
      gmail.historyQueries.push(
        `historyTypes=${types.join(",")} labelId=${labelId ?? ""}`,
      );
      const pageSize = Math.min(
        Number(url.searchParams.get("maxResults") ?? "100"),
        HISTORY_PAGE_RECORDS,
      );
      const offset = Number(url.searchParams.get("pageToken") ?? "0");
      const records = gmail.changes
        .filter(
          (change) =>
            change.id > start &&
            (labelId === null ||
              change.labelsAfter.includes(labelId) ||
              change.added.includes(labelId) ||
              change.removed.includes(labelId)),
        )
        .map(historyRecord.bind(null, gmail, types));
      const next = offset + pageSize;
      return HttpResponse.json({
        historyId: String(gmail.historyId),
        history: records.slice(offset, next),
        ...(next < records.length ? { nextPageToken: String(next) } : {}),
      });
    }),
    http.get(`${GMAIL}/messages/:messageId`, ({ params }) => {
      const message = gmail.messages.get(String(params.messageId));
      if (message === undefined)
        return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
      gmail.metadataReads.push(message.id);
      return HttpResponse.json({
        id: message.id,
        threadId: message.threadId,
        labelIds: message.labels,
        sizeEstimate: 2_048,
        internalDate: String(message.internalDate),
        payload: {
          headers: [
            { name: "From", value: "Supplier <supplier@example.test>" },
          ],
        },
      });
    }),
  );
}

function historyRecord(
  gmail: GmailMailbox,
  types: readonly string[],
  change: GmailChange,
): Record<string, unknown> {
  const message = gmail.messages.get(change.messageId);
  const reference = {
    id: change.messageId,
    threadId: message?.threadId ?? change.messageId,
    labelIds: change.labelsAfter,
  };
  return {
    id: String(change.id),
    messages: [{ id: reference.id, threadId: reference.threadId }],
    ...(change.delivered && types.includes("messageAdded")
      ? { messagesAdded: [{ message: reference }] }
      : {}),
    ...(change.added.length > 0 && types.includes("labelAdded")
      ? { labelsAdded: [{ message: reference, labelIds: change.added }] }
      : {}),
    ...(change.removed.length > 0 && types.includes("labelRemoved")
      ? { labelsRemoved: [{ message: reference, labelIds: change.removed }] }
      : {}),
  };
}

async function threadCases(
  organisationId: OrganisationId,
  account: IntegrationAccountId,
) {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const rows = await scope.database
    .prepare(
      `SELECT gmail_thread_id AS threadId, case_id AS caseId
       FROM email_thread_case
       WHERE organisation_id = ? AND integration_account_id = ?
       ORDER BY gmail_thread_id`,
    )
    .bind(organisationId, account)
    .all<{ threadId: string; caseId: string }>();
  return rows.results;
}

async function receipts(
  organisationId: OrganisationId,
  account: IntegrationAccountId,
) {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const rows = await scope.database
    .prepare(
      `SELECT provider_message_id AS messageId, case_id AS caseId
       FROM email_message_receipt
       WHERE organisation_id = ? AND integration_account_id = ?
       ORDER BY provider_message_id`,
    )
    .bind(organisationId, account)
    .all<{ messageId: string; caseId: string }>();
  return rows.results;
}

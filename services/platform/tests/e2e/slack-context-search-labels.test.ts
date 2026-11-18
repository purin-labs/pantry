import { env, exports } from "cloudflare:workers";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, vi, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import { restoreSessionTurnContext } from "../../src/actors/actor-journal";
import { SessionDO } from "../../src/actors/agent-session";
import { selectOrganisationPlacementDatabase } from "../../src/organisation-execution-scope";
import { FlowLabel } from "../../src/policy/information-flow";
import { network } from "./network";
import {
  ORGANISATION_ID,
  ROOT_TS,
  SLACK_BOT_TOKEN,
  installSlackActorFixture,
  isStringRecord,
  slackPostFields,
  openRouterText,
  requiredPlacement,
  signedSlackRequest,
  slackEnvelope,
} from "./slack-journey-support";

/**
 * A context search reads each distinct stored label one time. Every candidate
 * row names the row of the read that carries its label text.
 *
 * The journey fills one Slack thread and stores a second valid label on two
 * of its rows, so one search reads two labels. Then it opens a second thread
 * in the same channel. The turns of the second thread get the entries of the
 * first thread only from the search. Each of those context items must carry
 * the label that its own row stores.
 *
 * Then the journey changes the stored label of one row and keeps the digest
 * that the label claims. The row must leave the context of the next turn. It
 * must not take the label of a row that claims the same digest.
 */
it(
  "gives each searched context item the label that its own row stores",
  searchedLabels,
  120_000,
);

const OTHER_ROOT_TS = "1787500900.000001";

type SearchedItem = {
  readonly caseId: string;
  readonly entryId: string;
  readonly labelDigest: string;
};

type StoredRow = {
  readonly rowid: number;
  readonly caseId: string;
  readonly entryId: string;
  readonly labelDigest: string;
  readonly labelText: string;
};

const originalStart = SessionDO.prototype.startCanonicalEmbeddedHarnessTextTurn;
const bundles: SearchedItem[][] = [];

async function searchedLabels(test: TestContext): Promise<void> {
  bundles.length = 0;
  await installSlackActorFixture();
  const posts: number[] = [];
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, { count: 0 }),
    ),
    http.post(
      "https://slack.com/api/:method",
      respondToSlack.bind(null, posts),
    ),
  );
  const startSpy = vi
    .spyOn(SessionDO.prototype, "startCanonicalEmbeddedHarnessTextTurn")
    .mockImplementation(captureBundle);
  try {
    // The first thread stores six entries: three messages and three answers.
    await turn(posts, {
      eventType: "app_mention",
      eventId: "Ev55E_LABEL_A1",
      messageTs: ROOT_TS,
      threadTs: ROOT_TS,
      text: "<@U0SATYR> the pastry collection code is AMBER-OTTER-7391",
    });
    await turn(posts, {
      eventType: "message",
      eventId: "Ev55E_LABEL_A2",
      messageTs: "1787500000.000002",
      threadTs: ROOT_TS,
      text: "the pastry collection shelf is the north shelf",
    });
    await turn(posts, {
      eventType: "message",
      eventId: "Ev55E_LABEL_A3",
      messageTs: "1787500000.000003",
      threadTs: ROOT_TS,
      text: "the pastry collection closes at noon",
    });
    await expect
      .poll(async () => (await storedRows()).length, { timeout: 30_000 })
      .toBe(6);
    await storeSecondLabel(await storedRows());
    const firstThread = await storedRows();
    const firstCaseId = firstThread[0]?.caseId;
    if (firstCaseId === undefined) throw new Error("The first Case is missing");
    const storedLabels = new Set(firstThread.map(labelText));
    expect(storedLabels.size).toBe(2);

    // The second thread is another Case. It gets the first thread's entries
    // from the search only.
    await turn(posts, {
      eventType: "app_mention",
      eventId: "Ev55E_LABEL_B1",
      messageTs: OTHER_ROOT_TS,
      threadTs: OTHER_ROOT_TS,
      text: "<@U0SATYR> what is the pastry collection code?",
    });
    const before = searchedFrom(firstCaseId, bundles.at(-1));
    expect(before.length).toBe(firstThread.length);
    expectOwnLabels(before, firstThread);
    expect(new Set(before.map(labelDigest)).size).toBeGreaterThan(1);

    // One searched row gets other label content under the same digest. It is
    // not the first row of its label, so another row carries that label.
    const damaged = laterRowOfSharedLabel(before, firstThread);
    await damageStoredLabel(damaged);
    const afterDamage = await storedRows();
    expect(afterDamage.find(sameEntry.bind(null, damaged))?.labelDigest).toBe(
      damaged.labelDigest,
    );

    await turn(posts, {
      eventType: "message",
      eventId: "Ev55E_LABEL_B2",
      messageTs: "1787500900.000002",
      threadTs: OTHER_ROOT_TS,
      text: "tell me the pastry collection code again",
    });
    const after = searchedFrom(firstCaseId, bundles.at(-1));
    expect(after.some(sameEntry.bind(null, damaged))).toBe(false);
    expect(after.length).toBe(before.length - 1);
    expectOwnLabels(after, firstThread);

    Object.assign(test.task.meta, {
      contextSearchLabels: {
        storedRowsOfFirstThread: firstThread.length,
        storedLabels: storedLabels.size,
        storedLabelBytes: [...storedLabels].map(textLength),
        searchedItemsBeforeDamage: before.length,
        searchedLabelsBeforeDamage: new Set(before.map(labelDigest)).size,
        damagedEntry: damaged.entryId,
        searchedItemsAfterDamage: after.length,
        damagedEntrySearchedAfterDamage: after.some(
          sameEntry.bind(null, damaged),
        ),
      },
    });
  } finally {
    startSpy.mockRestore();
  }
}

/** Each searched item carries the label digest that its own row stores. */
function expectOwnLabels(
  items: readonly SearchedItem[],
  rows: readonly StoredRow[],
): void {
  for (const item of items) {
    const row = rows.find(sameEntry.bind(null, item));
    expect(row?.labelDigest).toBe(item.labelDigest);
  }
}

/**
 * A searched row that is not the first row of its label, where another
 * searched row stores the same label.
 */
function laterRowOfSharedLabel(
  items: readonly SearchedItem[],
  rows: readonly StoredRow[],
): StoredRow {
  const searched = rows
    .filter((row) => items.some(sameEntry.bind(null, row)))
    .sort((left, right) => right.rowid - left.rowid);
  for (const row of searched) {
    const first = rows
      .filter((other) => other.labelText === row.labelText)
      .sort((left, right) => left.rowid - right.rowid)[0];
    if (first !== undefined && first.rowid !== row.rowid) return row;
  }
  throw new Error("No searched row shares its label with an earlier row");
}

function sameEntry(
  left: Pick<SearchedItem, "caseId" | "entryId">,
  right: Pick<SearchedItem, "caseId" | "entryId">,
): boolean {
  return left.caseId === right.caseId && left.entryId === right.entryId;
}

function labelDigest(item: SearchedItem): string {
  return item.labelDigest;
}

function labelText(row: StoredRow): string {
  return row.labelText;
}

function textLength(text: string): number {
  return text.length;
}

function searchedFrom(
  caseId: string,
  bundle: readonly SearchedItem[] | undefined,
): SearchedItem[] {
  if (bundle === undefined) throw new Error("No turn started");
  return bundle.filter((item) => item.caseId === caseId);
}

async function captureBundle(
  this: SessionDO,
  input: Parameters<SessionDO["startCanonicalEmbeddedHarnessTextTurn"]>[0],
) {
  const context = await restoreSessionTurnContext(input.context);
  if (context === null) throw new Error("Invalid harness context");
  const items: SearchedItem[] = [];
  for (const item of context.bundle.items) {
    if (item.source.kind !== "case_entry") continue;
    items.push({
      caseId: item.source.caseId,
      entryId: item.source.entryId,
      labelDigest: item.inputLabel.digest,
    });
  }
  bundles.push(items);
  return originalStart.call(this, input);
}

function organisationDatabase(): D1Database {
  const database = selectOrganisationPlacementDatabase(
    env,
    ORGANISATION_ID,
    requiredPlacement(),
  );
  if (!database.ok) throw new Error(database.error.code);
  return database.value;
}

/** The ready rows of the organisation, in the order they were written. */
async function storedRows(): Promise<StoredRow[]> {
  const result = await organisationDatabase()
    .prepare(
      `SELECT rowid AS rowid, source_json AS source, flow_label_json AS label
         FROM context_projection
        WHERE organisation_id = ? AND lifecycle = 'ready'
          AND source_kind = 'case_entry'
        ORDER BY rowid`,
    )
    .bind(ORGANISATION_ID)
    .all<{ rowid: number; source: string; label: string }>();
  const rows: StoredRow[] = [];
  for (const row of result.results) {
    const source: unknown = JSON.parse(row.source);
    const label: unknown = JSON.parse(row.label);
    if (
      !isRecord(source) ||
      typeof source.caseId !== "string" ||
      typeof source.entryId !== "string" ||
      !isRecord(label) ||
      typeof label.digest !== "string"
    )
      throw new Error("A stored row is invalid");
    rows.push({
      rowid: row.rowid,
      caseId: source.caseId,
      entryId: source.entryId,
      labelDigest: label.digest,
      labelText: row.label,
    });
  }
  return rows;
}

/**
 * Give the third and the fourth row a valid label with one more reader than
 * the label that every row stores. The first label keeps four rows.
 */
async function storeSecondLabel(rows: readonly StoredRow[]): Promise<void> {
  const stored = rows[0];
  if (stored === undefined) throw new Error("No stored row");
  const restored = await FlowLabel.restore(JSON.parse(stored.labelText));
  if (!restored.ok) throw new Error(restored.error.code);
  const second = await FlowLabel.create(
    restored.value.policies.map(withExtraReader),
  );
  if (!second.ok) throw new Error(second.error.code);
  expect(second.value.digest).not.toBe(restored.value.digest);
  const database = organisationDatabase();
  for (const row of rows.slice(2, 4)) {
    await database
      .prepare(
        "UPDATE context_projection SET flow_label_json = ? WHERE rowid = ?",
      )
      .bind(JSON.stringify(second.value.toJSON()), row.rowid)
      .run();
  }
}

const EXTRA_READER = {
  kind: "person",
  personId: "person_label_variant",
} as const;

function withExtraReader(policy: FlowLabel["policies"][number]) {
  return { owner: policy.owner, readers: [...policy.readers, EXTRA_READER] };
}

/** Add one reader to the stored label and keep the digest that it claims. */
async function damageStoredLabel(row: StoredRow): Promise<void> {
  const label: unknown = JSON.parse(row.labelText);
  if (!isRecord(label) || !Array.isArray(label.policies))
    throw new Error("The stored label is invalid");
  const policies: unknown[] = label.policies;
  const policy = policies[0];
  if (!isRecord(policy) || !Array.isArray(policy.readers))
    throw new Error("The stored label has no policy to change");
  const damaged = {
    ...label,
    policies: policies.with(0, {
      ...policy,
      readers: [...policy.readers, EXTRA_READER],
    }),
  };
  await organisationDatabase()
    .prepare(
      "UPDATE context_projection SET flow_label_json = ? WHERE rowid = ?",
    )
    .bind(JSON.stringify(damaged), row.rowid)
    .run();
}

async function turn(
  posts: number[],
  message: Parameters<typeof slackEnvelope>[0],
): Promise<void> {
  const expected = posts.length + 1;
  const response = await exports.default.fetch(
    await signedSlackRequest(slackEnvelope(message)),
  );
  expect(response.status).toBe(200);
  await expect.poll(() => posts.length, { timeout: 30_000 }).toBe(expected);
}

/**
 * Each answer has its own text. The context keeps one entry for each text,
 * so equal answers would hide all rows but one.
 */
async function replyToModel(
  answers: { count: number },
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  await request.json();
  answers.count += 1;
  return openRouterText(
    `The pastry collection code is noted in answer ${String(answers.count)}.`,
    `chatcmpl_55e_search_labels_${String(answers.count)}`,
  );
}

async function respondToSlack(
  posts: number[],
  { params, request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${SLACK_BOT_TOKEN}`)
    return HttpResponse.json({ ok: false, error: "invalid_auth" });
  const body: unknown = slackPostFields(await request.json());
  if (!isStringRecord(body)) throw new Error("Slack request body is invalid");
  if (params.method === "chat.postMessage") {
    posts.push(Date.now());
    return HttpResponse.json({
      ok: true,
      channel: body.channel,
      ts: `1787501000.${String(posts.length).padStart(6, "0")}`,
    });
  }
  return HttpResponse.json({ ok: true });
}

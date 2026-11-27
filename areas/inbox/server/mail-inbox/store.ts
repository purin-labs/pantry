import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  mailIdentifier,
  mailRevision,
  type MailClassification,
  type MailMatch,
} from "@purin-labs/control-api";
import type { MailOrganizationHead, MailWork } from "./types";
import { parseMailOrganizationHead } from "./types";
import { isRecord } from "@purin-labs/std";
import type { IntegrationAccountId } from "@purin-labs/kernel/ids";
import {
  createMailResponseSchema,
  closeSupersededInboxResponses,
  failedInboxResponseCount,
} from "./response-store";
import { prepareMailClassificationEligibilityErase } from "@purin-labs/area-integrations-contract/server/mail-classification-eligibility";

export function createMailOrganizationSchema(sql: SqlStorage): void {
  createMailResponseSchema(sql);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS mail_organization (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), body TEXT NOT NULL, observe_at INTEGER NOT NULL)`,
  );
  sql.exec(`CREATE TABLE IF NOT EXISTS mail_classification_work (
    work_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    revision INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','evaluating','budget_paused','done','blocked')),
    due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL CHECK (origin IN ('arrival','historical')),
    UNIQUE (revision, message_id)
  )`);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS mail_classification_due ON mail_classification_work (state, due_at)`,
  );
}
export function eraseMailOrganization(sql: SqlStorage): void {
  sql.exec("DELETE FROM mail_organization");
  sql.exec("DELETE FROM mail_classification_work");
  sql.exec("DELETE FROM mail_response_owner");
}
export async function eraseMailClassificationRecords(
  scope: OrganisationExecutionScope,
  integrationAccountId: IntegrationAccountId,
): Promise<void> {
  const where = `WHERE organisation_id = ? AND integration_account_id = ?
           AND EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
             AND placement_epoch = ? AND placement_cell_id = ?
             AND fence_token = ? AND status = 'active')`;
  const inboxRecord = (sql: string): D1PreparedStatement =>
    scope.database
      .prepare(sql)
      .bind(
        scope.organisationId,
        integrationAccountId,
        scope.organisationId,
        scope.placement.placementEpoch,
        scope.placement.placementCellId,
        scope.fenceToken,
      );
  await scope.database.batch([
    inboxRecord(`DELETE FROM mail_classification ${where}`),
    prepareMailClassificationEligibilityErase(scope, integrationAccountId),
    inboxRecord(`DELETE FROM mail_assistant_eligibility ${where}`),
  ]);
}
export function readMailHead(sql: SqlStorage): MailOrganizationHead | null {
  const row = sql
    .exec<{ body: string }>(
      "SELECT body FROM mail_organization WHERE singleton = 1",
    )
    .toArray()[0];
  if (row === undefined) return null;
  const head = parseMailOrganizationHead(JSON.parse(row.body));
  if (head === null) throw new Error("mail_organization_corrupt");
  return head;
}
export function writeMailHead(
  sql: SqlStorage,
  head: MailOrganizationHead,
  now: number,
): void {
  sql.exec(
    "INSERT INTO mail_organization (singleton, body, observe_at) VALUES (1, ?, ?) ON CONFLICT (singleton) DO UPDATE SET body = excluded.body, observe_at = excluded.observe_at",
    JSON.stringify(head),
    now + 30_000,
  );
  closeSupersededInboxResponses(sql, head);
  sql.exec(
    "UPDATE mail_classification_work SET state = 'blocked' WHERE revision <> ? AND state IN ('pending','evaluating','budget_paused')",
    head.view.revision,
  );
  if (head.view.kind === "paused")
    sql.exec(
      "UPDATE mail_classification_work SET state = 'blocked' WHERE state IN ('pending','evaluating','budget_paused')",
    );
}
export function mailPendingCount(sql: SqlStorage): number {
  return (
    sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM mail_classification_work WHERE state IN ('pending','evaluating','budget_paused')",
      )
      .toArray()[0]?.count ?? 0
  );
}
export function mailFailedCount(
  sql: SqlStorage,
  classificationRevision: number,
): number {
  return (
    (sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM mail_classification_work WHERE revision >= ? AND state = 'blocked'",
        classificationRevision,
      )
      .toArray()[0]?.count ?? 0) +
    failedInboxResponseCount(sql, classificationRevision)
  );
}
export function mailBudgetPausedCount(sql: SqlStorage): number {
  return (
    sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM mail_classification_work WHERE state = 'budget_paused'",
      )
      .toArray()[0]?.count ?? 0
  );
}
export function pauseMailWorkBudget(
  sql: SqlStorage,
  work: MailWork,
  now: number,
): void {
  const day = 86_400_000;
  sql.exec(
    "UPDATE mail_classification_work SET state = 'budget_paused', due_at = ? WHERE work_id = ?",
    (Math.floor(now / day) + 1) * day,
    work.workId,
  );
}
/** Plan 88: the free Jev use of the month is used; the work waits for the next month. */
export function pauseMailWorkUntil(
  sql: SqlStorage,
  work: MailWork,
  at: number,
): void {
  sql.exec(
    "UPDATE mail_classification_work SET state = 'budget_paused', due_at = ? WHERE work_id = ?",
    at,
    work.workId,
  );
}
export function nextMailOrganizationAt(sql: SqlStorage): number | null {
  const interruptedAt =
    sql
      .exec<{ at: number | null }>(
        "SELECT MIN(json_extract(body, '$.state.startedAt') + 360000) AS at FROM mail_response_owner WHERE phase = 'processing'",
      )
      .toArray()[0]?.at ?? null;
  const head = readMailHead(sql);
  if (
    head === null ||
    head.view.kind !== "published" ||
    head.observation.kind === "history_expired"
  )
    return interruptedAt;
  const row = sql
    .exec<{ at: number }>(
      `SELECT MIN(at) AS at FROM (
    SELECT observe_at AS at FROM mail_organization UNION ALL
    SELECT due_at AS at FROM mail_classification_work WHERE state IN ('pending','evaluating','budget_paused')
  )`,
    )
    .toArray()[0];
  const organizationAt = row?.at ?? null;
  if (organizationAt === null) return interruptedAt;
  return interruptedAt === null
    ? organizationAt
    : Math.min(organizationAt, interruptedAt);
}
export function acceptMailClassificationHint(
  sql: SqlStorage,
  now: number,
): void {
  sql.exec(
    "UPDATE mail_organization SET observe_at = MIN(observe_at, ?)",
    now + 30_000,
  );
}
export function mailObservationDue(sql: SqlStorage, now: number): boolean {
  const row = sql
    .exec<{ observe_at: number }>("SELECT observe_at FROM mail_organization")
    .toArray()[0];
  return row !== undefined && row.observe_at <= now;
}
export function deferMailObservation(sql: SqlStorage, now: number): void {
  sql.exec("UPDATE mail_organization SET observe_at = ?", now + 60_000);
}
export function queueMailWork(
  sql: SqlStorage,
  work: MailWork,
  now: number,
): void {
  sql.exec(
    "INSERT OR IGNORE INTO mail_classification_work (work_id, message_id, thread_id, revision, origin, state, due_at) VALUES (?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT (revision, message_id) DO UPDATE SET work_id = excluded.work_id, origin = 'historical', state = 'pending', due_at = excluded.due_at, attempts = 0 WHERE mail_classification_work.state = 'blocked'",
    work.workId,
    work.messageId,
    work.threadId,
    work.revision,
    work.origin,
    now,
  );
}
export function claimMailWork(sql: SqlStorage, now: number): MailWork | null {
  const raw = sql
    .exec<Record<string, SqlStorageValue>>(
      "SELECT work_id, message_id, thread_id, revision, origin FROM mail_classification_work WHERE state IN ('pending','evaluating','budget_paused') AND due_at <= ? ORDER BY due_at, work_id LIMIT 1",
      now,
    )
    .toArray()[0];
  if (raw === undefined) return null;
  if (
    !mailIdentifier(raw.work_id) ||
    !mailIdentifier(raw.message_id) ||
    !mailIdentifier(raw.thread_id) ||
    !mailRevision(raw.revision) ||
    (raw.origin !== "arrival" && raw.origin !== "historical")
  )
    throw new Error("mail_classification_work_corrupt");
  sql.exec(
    "UPDATE mail_classification_work SET state = 'evaluating', due_at = ?, attempts = attempts + 1 WHERE work_id = ?",
    now + 30_000,
    raw.work_id,
  );
  return {
    workId: raw.work_id,
    messageId: raw.message_id,
    threadId: raw.thread_id,
    revision: raw.revision,
    origin: raw.origin,
  };
}
export function deferDueMailWork(sql: SqlStorage, now: number): void {
  sql.exec(
    "UPDATE mail_classification_work SET due_at = ? WHERE state IN ('pending','evaluating','budget_paused') AND due_at <= ?",
    now + 60_000,
    now,
  );
}
export function finishMailWork(
  sql: SqlStorage,
  work: MailWork,
  state: "done" | "blocked",
): void {
  sql.exec(
    "UPDATE mail_classification_work SET state = ? WHERE work_id = ?",
    state,
    work.workId,
  );
}
/** The work tries again after `waitMs` (a minute by default), at most 5 times. */
export function retryMailWork(
  sql: SqlStorage,
  work: MailWork,
  now: number,
  waitMs = 60_000,
): void {
  sql.exec(
    "UPDATE mail_classification_work SET state = CASE WHEN attempts >= 5 THEN 'blocked' ELSE 'pending' END, due_at = ? WHERE work_id = ? AND state = 'evaluating'",
    now + waitMs,
    work.workId,
  );
}
export async function projectMailClassifications(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    head: MailOrganizationHead;
    work: MailWork;
    classifications: readonly MailClassification[];
    contentDigest: string;
  }>,
): Promise<void> {
  if (input.scope.organisationId !== input.head.organisationId)
    throw new Error("connector_placement_conflict");
  // Pause/resume advances the control revision while keeping the same rules.
  const statements: D1PreparedStatement[] = [];
  for (const classification of input.classifications) {
    statements.push(
      input.scope.database
        .prepare(
          `INSERT INTO mail_classification
      (organisation_id, integration_account_id, rule_revision, message_id, thread_id, rule_id, outcome, source, evaluated_at, evaluation_id, content_digest)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
        AND placement_epoch = ? AND placement_cell_id = ?
        AND fence_token = ? AND status = 'active')
      ON CONFLICT (organisation_id, integration_account_id, rule_revision, message_id, rule_id)
      DO UPDATE SET outcome = excluded.outcome, source = excluded.source, evaluated_at = excluded.evaluated_at
      WHERE mail_classification.source <> 'operator'`,
        )
        .bind(
          input.head.organisationId,
          input.head.integrationAccountId,
          input.head.classificationRevision,
          classification.messageId,
          classification.threadId,
          classification.ruleId,
          classification.outcome,
          classification.source,
          classification.evaluatedAt,
          input.work.workId,
          input.contentDigest,
          input.scope.organisationId,
          input.scope.placement.placementEpoch,
          input.scope.placement.placementCellId,
          input.scope.fenceToken,
        ),
    );
  }
  if (statements.length > 0) await input.scope.database.batch(statements);
}
export async function listMailClassifications(
  db: OrganisationDatabase,
  head: MailOrganizationHead,
  messageIds: readonly string[],
): Promise<readonly MailClassification[]> {
  if (messageIds.length === 0) return [];
  const rows = await db
    .prepare(
      `SELECT message_id, thread_id, rule_id, outcome, source, evaluated_at FROM mail_classification WHERE organisation_id = ? AND integration_account_id = ? AND rule_revision = ? AND message_id IN (${messageIds.map(sqlPlaceholder).join(",")}) ORDER BY message_id, rule_id`,
    )
    .bind(
      head.organisationId,
      head.integrationAccountId,
      head.classificationRevision,
      ...messageIds,
    )
    .all<Record<string, unknown>>();
  const results: MailClassification[] = [];
  for (const raw of rows.results) {
    if (
      !isRecord(raw) ||
      !mailIdentifier(raw.message_id) ||
      !mailIdentifier(raw.thread_id) ||
      !mailIdentifier(raw.rule_id) ||
      !isMatch(raw.outcome) ||
      (raw.source !== "jev" && raw.source !== "operator") ||
      !mailRevision(raw.evaluated_at)
    )
      throw new Error("mail_classification_projection_corrupt");
    results.push({
      messageId: raw.message_id,
      threadId: raw.thread_id,
      ruleId: raw.rule_id,
      outcome: raw.outcome,
      source: raw.source,
      evaluatedAt: raw.evaluated_at,
    });
  }
  return results;
}
function sqlPlaceholder(): string {
  return "?";
}

export type MailClassifiedReferences = Readonly<{
  references: readonly Readonly<{ messageId: string; threadId: string }>[];
  nextAfter: string | null;
}>;

export async function listMailClassifiedReferences(
  db: OrganisationDatabase,
  head: MailOrganizationHead,
  ruleIds: readonly string[],
  after: string | null,
): Promise<MailClassifiedReferences> {
  if (ruleIds.length === 0) return { references: [], nextAfter: null };
  const rows = await db
    .prepare(
      `SELECT message_id, thread_id FROM mail_classification
    WHERE organisation_id = ? AND integration_account_id = ? AND rule_revision = ?
    AND outcome = 'matched' AND rule_id IN (${ruleIds.map(sqlPlaceholder).join(",")})
    AND (? IS NULL OR message_id < ?) GROUP BY message_id, thread_id
    ORDER BY message_id DESC LIMIT 21`,
    )
    .bind(
      head.organisationId,
      head.integrationAccountId,
      head.classificationRevision,
      ...ruleIds,
      after,
      after,
    )
    .all<Record<string, unknown>>();
  const references: { messageId: string; threadId: string }[] = [];
  for (const row of rows.results) {
    if (!mailIdentifier(row.message_id) || !mailIdentifier(row.thread_id))
      throw new Error("mail_classification_projection_corrupt");
    references.push({ messageId: row.message_id, threadId: row.thread_id });
  }
  const page = references.slice(0, 20);
  return {
    references: page,
    nextAfter: references.length > 20 ? (page.at(-1)?.messageId ?? null) : null,
  };
}

export async function readMailClassificationDigest(
  db: OrganisationDatabase,
  head: MailOrganizationHead,
  messageId: string,
  ruleId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT content_digest FROM mail_classification
    WHERE organisation_id = ? AND integration_account_id = ? AND rule_revision = ? AND message_id = ? AND rule_id = ?`,
    )
    .bind(
      head.organisationId,
      head.integrationAccountId,
      head.classificationRevision,
      messageId,
      ruleId,
    )
    .first<Record<string, unknown>>();
  if (row === null) return null;
  if (
    typeof row.content_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.content_digest)
  )
    throw new Error("mail_classification_projection_corrupt");
  return row.content_digest;
}
function isMatch(raw: unknown): raw is MailMatch {
  return raw === "matched" || raw === "not_matched" || raw === "needs_review";
}

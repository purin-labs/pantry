import type {
  ScreenRelevanceBand,
  ScreenRelevanceChoice,
} from "@seams/control-api";
import type { OrganisationId } from "../ids";

/**
 * The Screen relevance switch (Plan 88 section 2, Plan 87 section 3A). It is the
 * only record of that feature, so it lives in the Organisation Actor.
 */
export function createJevScreenRelevanceSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS jev_screen_relevance_switch (
    organisation_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  // Plan 87 section 3A: one row for each hint or question that a person saw.
  // It holds the scores, the band, the model and the choice, and no draft
  // text and no page content. No view reads it yet (Plan 87 section 3A).
  sql.exec(`CREATE TABLE IF NOT EXISTS jev_screen_relevance_record (
    organisation_id TEXT NOT NULL,
    check_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    surface TEXT NOT NULL,
    about_screen REAL NOT NULL CHECK (about_screen >= 0 AND about_screen <= 1),
    fits_chat REAL NOT NULL CHECK (fits_chat >= 0 AND fits_chat <= 1),
    band TEXT NOT NULL CHECK (band IN ('hint', 'ask')),
    offer_new_chat INTEGER NOT NULL CHECK (offer_new_chat IN (0, 1)),
    model TEXT NOT NULL,
    choice TEXT NOT NULL CHECK (choice IN ('attached', 'sent_without', 'new_chat', 'no_action')),
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    PRIMARY KEY (organisation_id, check_id)
  )`);
}

/** The switch and its revision, which pins each relevance check. */
export function readJevScreenRelevanceSwitch(
  sql: SqlStorage,
  organisationId: OrganisationId,
): Readonly<{ enabled: boolean; revision: number }> {
  const row = sql
    .exec<{ enabled: number; revision: number }>(
      "SELECT enabled, revision FROM jev_screen_relevance_switch WHERE organisation_id = ?",
      organisationId,
    )
    .toArray()[0];
  return row === undefined
    ? { enabled: false, revision: 0 }
    : { enabled: row.enabled === 1, revision: row.revision };
}

export type ScreenRelevanceRecord = Readonly<{
  organisationId: OrganisationId;
  checkId: string;
  userId: string;
  conversationId: string;
  surface: string;
  aboutScreen: number;
  fitsChat: number;
  band: Exclude<ScreenRelevanceBand, "quiet">;
  offerNewChat: boolean;
  model: string;
  now: number;
}>;

export function insertScreenRelevanceRecord(
  sql: SqlStorage,
  record: ScreenRelevanceRecord,
): void {
  sql.exec(
    `INSERT INTO jev_screen_relevance_record (organisation_id, check_id, user_id, conversation_id, surface,
      about_screen, fits_chat, band, offer_new_chat, model, choice, created_at, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'no_action', ?, NULL)
    ON CONFLICT (organisation_id, check_id) DO NOTHING`,
    record.organisationId,
    record.checkId,
    record.userId,
    record.conversationId,
    record.surface,
    record.aboutScreen,
    record.fitsChat,
    record.band,
    record.offerNewChat ? 1 : 0,
    record.model,
    record.now,
  );
}

/**
 * The person's choice for a hint or a question that they saw. Only the person
 * who saw it decides, and the first decision stays.
 */
export function decideScreenRelevanceRecord(
  sql: SqlStorage,
  input: Readonly<{
    organisationId: OrganisationId;
    checkId: string;
    userId: string;
    choice: ScreenRelevanceChoice;
    now: number;
  }>,
): boolean {
  const row = sql
    .exec<{ choice: string }>(
      "SELECT choice FROM jev_screen_relevance_record WHERE organisation_id = ? AND check_id = ? AND user_id = ?",
      input.organisationId,
      input.checkId,
      input.userId,
    )
    .toArray()[0];
  if (row === undefined) return false;
  if (row.choice !== "no_action" || input.choice === "no_action") return true;
  sql.exec(
    `UPDATE jev_screen_relevance_record SET choice = ?, decided_at = ?
    WHERE organisation_id = ? AND check_id = ? AND user_id = ? AND choice = 'no_action'`,
    input.choice,
    input.now,
    input.organisationId,
    input.checkId,
    input.userId,
  );
  return true;
}

/** The records of an Organisation, newest first, for a later view and the evidence. */
export function listScreenRelevanceRecords(
  sql: SqlStorage,
  organisationId: OrganisationId,
  limit: number,
): readonly Readonly<Record<string, SqlStorageValue>>[] {
  return sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT check_id, user_id, conversation_id, surface, about_screen, fits_chat, band, offer_new_chat,
        model, choice, created_at, decided_at
      FROM jev_screen_relevance_record WHERE organisation_id = ?
      ORDER BY created_at DESC LIMIT ?`,
      organisationId,
      limit,
    )
    .toArray();
}

export function readJevScreenRelevance(
  sql: SqlStorage,
  organisationId: OrganisationId,
): boolean {
  const row = sql
    .exec<{ enabled: number }>(
      "SELECT enabled FROM jev_screen_relevance_switch WHERE organisation_id = ?",
      organisationId,
    )
    .toArray()[0];
  return row?.enabled === 1;
}

export function writeJevScreenRelevance(
  sql: SqlStorage,
  input: Readonly<{
    organisationId: OrganisationId;
    enabled: boolean;
    actorId: string;
    now: number;
  }>,
): void {
  sql.exec(
    `INSERT INTO jev_screen_relevance_switch (organisation_id, enabled, revision, updated_by, updated_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT (organisation_id) DO UPDATE SET enabled = excluded.enabled,
      revision = revision + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    input.organisationId,
    input.enabled ? 1 : 0,
    input.actorId,
    input.now,
  );
}

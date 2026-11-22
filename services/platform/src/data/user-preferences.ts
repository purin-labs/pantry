import type { GlobalDatabase } from "@purin-labs/kernel/database-handles";
import {
  applyPreferenceEdit,
  defaultPreferenceDocument,
  parseUserPreferenceDocument,
  type PreferenceArea,
  type PreferenceSaveResult,
  type UserId,
  type UserPreferenceDocument,
  type UserPreferenceEdit,
} from "@purin-labs/control-api";
import { canonicalJson } from "@purin-labs/std";

export class PreferenceStorageError extends Error {
  constructor(
    readonly code: "preferences_invalid" | "preferences_version_unsupported",
  ) {
    super(code);
  }
}
type PreferenceRow = Readonly<{
  schema_version: unknown;
  revision: unknown;
  updated_at: unknown;
  values_json: unknown;
}>;

export async function readUserPreferences(
  db: GlobalDatabase,
  userId: UserId,
  area: PreferenceArea,
): Promise<UserPreferenceDocument> {
  const defaults = defaultPreferenceDocument(userId, area, Date.now());
  // One batch: the read follows the insert of the defaults in one round trip.
  const session = db.withSession("first-primary");
  const [, read] = await session.batch<PreferenceRow>([
    session
      .prepare(
        `INSERT OR IGNORE INTO user_preferences
    (user_id, area, schema_version, revision, values_json, updated_at) VALUES (?, ?, 1, 1, ?, ?)`,
      )
      .bind(userId, area, JSON.stringify(defaults.values), defaults.updatedAt),
    session
      .prepare(
        "SELECT schema_version, revision, values_json, updated_at FROM user_preferences WHERE user_id = ? AND area = ?",
      )
      .bind(userId, area),
  ]);
  const row = read?.results[0] ?? null;
  if (row === null || typeof row.values_json !== "string")
    throw new PreferenceStorageError("preferences_invalid");
  let values: unknown;
  try {
    values = JSON.parse(row.values_json);
  } catch {
    throw new PreferenceStorageError("preferences_invalid");
  }
  const parsed = parseUserPreferenceDocument({
    userId,
    area,
    schemaVersion: row.schema_version,
    revision: row.revision,
    updatedAt: row.updated_at,
    values,
  });
  if (!parsed.ok) throw new PreferenceStorageError(parsed.code);
  return parsed.value;
}

export async function updateUserPreferences(
  db: GlobalDatabase,
  userId: UserId,
  edit: UserPreferenceEdit,
  expectedRevision: number,
): Promise<PreferenceSaveResult> {
  const current = await readUserPreferences(db, userId, edit.area);
  if (current.revision !== expectedRevision)
    return { kind: "conflict", document: current };
  const next = applyPreferenceEdit(current, edit);
  if (canonicalJson(next.values) === canonicalJson(current.values))
    return { kind: "saved", document: current };
  const result = await db
    .prepare(
      `UPDATE user_preferences SET values_json = ?, revision = revision + 1, updated_at = ?
    WHERE user_id = ? AND area = ? AND revision = ? AND schema_version = 1`,
    )
    .bind(
      JSON.stringify(next.values),
      Date.now(),
      userId,
      edit.area,
      expectedRevision,
    )
    .run();
  const document = await readUserPreferences(db, userId, edit.area);
  return result.meta.changes === 1
    ? { kind: "saved", document }
    : { kind: "conflict", document };
}

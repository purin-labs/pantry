import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  DEFAULT_MAC_VOICE_ENGINE,
  isVoiceEngineId,
  VOICE_ENGINES,
  VOICE_REQUEST_LIMIT,
  type VoiceEngineId,
  VOICE_REQUEST_WINDOW_MS,
  VOICE_MAC_HEARTBEAT_FRESH_MS,
  type VoiceMacHeartbeat,
  type VoiceMacView,
} from "@purin-labs/control-api";
import { encodeBase64Url, sha256Hex } from "@purin-labs/std";

import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { readOrganisationCapabilityPolicy } from "@purin-labs/authority/data/capability-policy";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";

const CODE_TTL_MS = 15 * 60_000;
/**
 * A heartbeat that changes no reported field writes the row at most this
 * often (`VOICE_MAC_HEARTBEAT_FRESH_MS` allows for it).
 */
const MAC_HEARTBEAT_WRITE_MS = 5 * 60_000;
/** A call that never finished does not hold the member's one request forever. */
const IN_FLIGHT_MS = 60_000;
const USE_RETENTION_MS = 90 * 24 * 60 * 60_000;

type MacRow = Readonly<{
  mac_id: string;
  name_id: string;
  state: VoiceMacView["state"];
  created_at: number;
  last_heartbeat_at: number | null;
  private_address: string | null;
  service_version: string | null;
  model_state: VoiceMacView["modelState"];
  engine: string | null;
  engines: string | null;
  engine_choice: string | null;
}>;

const MAC_COLUMNS = `mac_id, name_id, state, created_at, last_heartbeat_at,
  private_address, service_version, model_state, engine, engines, engine_choice`;

export type VoiceMac = Omit<VoiceMacView, "hostname"> &
  Readonly<{ nameId: string }>;

/**
 * The engines that a Mac's service reported and that a Mac can run. A service
 * from before Plan 82C Phase 2 reports only the engine that it runs.
 */
function reportedEngines(row: MacRow): VoiceEngineId[] {
  let raw: unknown = null;
  try {
    raw = row.engines === null ? null : JSON.parse(row.engines);
  } catch {
    raw = null;
  }
  const listed = Array.isArray(raw) ? raw : [row.engine];
  return listed.filter(
    (engine): engine is VoiceEngineId =>
      isVoiceEngineId(engine) &&
      VOICE_ENGINES[engine].hosts.some((host) => host === "shop_mac"),
  );
}

function macFromRow(row: MacRow): VoiceMac {
  return {
    macId: row.mac_id,
    nameId: row.name_id,
    state: row.state,
    createdAt: row.created_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    privateAddress: row.private_address,
    serviceVersion: row.service_version,
    modelState: row.model_state,
    engine: isVoiceEngineId(row.engine) ? row.engine : null,
    engines: reportedEngines(row),
    engineChoice: isVoiceEngineId(row.engine_choice)
      ? row.engine_choice
      : DEFAULT_MAC_VOICE_ENGINE,
  };
}

function randomSecret(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function isVoiceTranscriptionEnabled(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<boolean> {
  const policy = await readOrganisationCapabilityPolicy({
    db,
    organisationId,
    capabilityId: CAPABILITY_KEYS.voiceTranscription,
  });
  return policy.ok && policy.value.mode === "enabled";
}

export async function beginVoiceTranscription(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    userId: UserId;
    deviceId: string;
    useId: string;
    now: number;
  }>,
): Promise<boolean> {
  const inserted = await db
    .prepare(
      `INSERT INTO voice_transcription_use (
         use_id, organisation_id, user_id, device_id, started_at
       )
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE (SELECT count(*) FROM voice_transcription_use
                WHERE organisation_id = ?2 AND user_id = ?3 AND started_at > ?6) < ?7
          AND NOT EXISTS (SELECT 1 FROM voice_transcription_use
                WHERE organisation_id = ?2 AND user_id = ?3 AND device_id = ?4
                  AND finished_at IS NULL AND started_at > ?8)`,
    )
    .bind(
      input.useId,
      input.organisationId,
      input.userId,
      input.deviceId,
      input.now,
      input.now - VOICE_REQUEST_WINDOW_MS,
      VOICE_REQUEST_LIMIT,
      input.now - IN_FLIGHT_MS,
    )
    .run();
  return inserted.meta.changes === 1;
}

/** `audioMilliseconds` is what the provider bills; a failed call records 0. */
export async function finishVoiceTranscription(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    useId: string;
    audioMilliseconds: number;
    now: number;
  }>,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE voice_transcription_use
            SET finished_at = ?, audio_milliseconds = ?
          WHERE use_id = ? AND organisation_id = ?`,
      )
      .bind(
        input.now,
        input.audioMilliseconds,
        input.useId,
        input.organisationId,
      ),
    db
      .prepare(
        `DELETE FROM voice_transcription_use
          WHERE organisation_id = ? AND started_at < ?`,
      )
      .bind(input.organisationId, input.now - USE_RETENTION_MS),
  ]);
}

export async function listVoiceMacs(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<readonly VoiceMac[]> {
  const rows = await db
    .prepare(
      `SELECT ${MAC_COLUMNS} FROM voice_mac
        WHERE organisation_id = ?
        ORDER BY created_at DESC, mac_id`,
    )
    .bind(organisationId)
    .all<MacRow>();
  return (rows.results ?? []).map(macFromRow);
}

/** The Mac with the latest heartbeat, if one is enrolled and fresh. */
export async function readAnsweringVoiceMac(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  now: number,
): Promise<VoiceMac | null> {
  const row = await db
    .prepare(
      `SELECT ${MAC_COLUMNS} FROM voice_mac
        WHERE organisation_id = ? AND state = 'enrolled'
          AND private_address IS NOT NULL AND last_heartbeat_at > ?
        ORDER BY last_heartbeat_at DESC, mac_id LIMIT 1`,
    )
    .bind(organisationId, now - VOICE_MAC_HEARTBEAT_FRESH_MS)
    .first<MacRow>();
  return row === null ? null : macFromRow(row);
}

export async function startVoiceMacEnrollment(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    userId: UserId;
    now: number;
  }>,
): Promise<Readonly<{ macId: string; code: string; expiresAt: number }>> {
  const macId = `vmac_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const nameId = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const code = randomSecret();
  const expiresAt = input.now + CODE_TTL_MS;
  await db
    .prepare(
      `INSERT INTO voice_mac (
         mac_id, organisation_id, name_id, state, code_sha256, code_expires_at,
         created_by_user_id, created_at
       ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .bind(
      macId,
      input.organisationId,
      nameId,
      await sha256Hex(code),
      expiresAt,
      input.userId,
      input.now,
    )
    .run();
  return { macId, code, expiresAt };
}

/** The code works one time. It returns the credential's secret. */
export async function completeVoiceMacEnrollment(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    macId: string;
    code: string;
    now: number;
  }>,
): Promise<Readonly<{ nameId: string; secret: string }> | null> {
  const secret = randomSecret();
  const row = await db
    .prepare(
      `UPDATE voice_mac
          SET state = 'enrolled', credential_sha256 = ?, enrolled_at = ?,
              code_sha256 = NULL, code_expires_at = NULL
        WHERE mac_id = ? AND organisation_id = ? AND state = 'pending'
          AND code_sha256 = ? AND code_expires_at > ?
        RETURNING name_id`,
    )
    .bind(
      await sha256Hex(secret),
      input.now,
      input.macId,
      input.organisationId,
      await sha256Hex(input.code),
      input.now,
    )
    .first<{ name_id: string }>();
  return row === null ? null : { nameId: row.name_id, secret };
}

export async function readVoiceMacByCredential(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    macId: string;
    secret: string;
  }>,
): Promise<VoiceMac | null> {
  const row = await db
    .prepare(
      `SELECT ${MAC_COLUMNS} FROM voice_mac
        WHERE mac_id = ? AND organisation_id = ? AND state = 'enrolled'
          AND credential_sha256 = ?`,
    )
    .bind(input.macId, input.organisationId, await sha256Hex(input.secret))
    .first<MacRow>();
  return row === null ? null : macFromRow(row);
}

/**
 * It writes the row when a reported field changed, else at most every
 * `MAC_HEARTBEAT_WRITE_MS`, so an idle Mac writes one row in five minutes.
 * It returns the engine that a manager chose for the Mac.
 */
export async function recordVoiceMacHeartbeat(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    /** The row that the Mac's credential read for this request. */
    mac: VoiceMac;
    heartbeat: VoiceMacHeartbeat;
    /** Null while the DNS record does not yet hold the new address. */
    privateAddress: string | null;
    now: number;
  }>,
): Promise<VoiceEngineId> {
  // A service from before Plan 82C reports no engine, and it runs Whisper.
  const engine = input.heartbeat.engine ?? DEFAULT_MAC_VOICE_ENGINE;
  const row = await db
    .prepare(
      `UPDATE voice_mac
          SET last_heartbeat_at = ?1, service_version = ?2, model_state = ?3,
              engine = ?4, engines = ?5,
              private_address = coalesce(?6, private_address)
        WHERE mac_id = ?7 AND organisation_id = ?8 AND state = 'enrolled'
          AND (last_heartbeat_at IS NULL OR last_heartbeat_at <= ?9
               OR service_version IS NOT ?2 OR model_state IS NOT ?3
               OR engine IS NOT ?4 OR engines IS NOT ?5
               OR (?6 IS NOT NULL AND private_address IS NOT ?6))
        RETURNING engine_choice`,
    )
    .bind(
      input.now,
      input.heartbeat.serviceVersion,
      input.heartbeat.modelState,
      engine,
      JSON.stringify(input.heartbeat.engines ?? [engine]),
      input.privateAddress,
      input.mac.macId,
      input.organisationId,
      input.now - MAC_HEARTBEAT_WRITE_MS,
    )
    .first<{ engine_choice: string | null }>();
  // No write: the row that the credential read holds the current choice.
  if (row === null) return input.mac.engineChoice;
  return isVoiceEngineId(row.engine_choice)
    ? row.engine_choice
    : DEFAULT_MAC_VOICE_ENGINE;
}

type VoiceEngineChoiceResult = "chosen" | "not_found" | "unsupported";

/**
 * A manager chooses the engine of an enrolled Mac. The Mac takes the choice
 * with its next heartbeat, so it must be an engine that its service reported.
 */
export async function chooseVoiceMacEngine(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    macId: string;
    engine: VoiceEngineId;
  }>,
): Promise<VoiceEngineChoiceResult> {
  const row = await db
    .prepare(
      `SELECT ${MAC_COLUMNS} FROM voice_mac
        WHERE mac_id = ? AND organisation_id = ? AND state = 'enrolled'`,
    )
    .bind(input.macId, input.organisationId)
    .first<MacRow>();
  if (row === null) return "not_found";
  if (!reportedEngines(row).includes(input.engine)) return "unsupported";
  const updated = await db
    .prepare(
      `UPDATE voice_mac SET engine_choice = ?
        WHERE mac_id = ? AND organisation_id = ? AND state = 'enrolled'`,
    )
    .bind(input.engine, input.macId, input.organisationId)
    .run();
  return updated.meta.changes === 1 ? "chosen" : "not_found";
}

/** Every name that this Organisation's Macs ever used, for its end. */
export async function listVoiceMacNameIds(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<readonly string[]> {
  const rows = await db
    .prepare("SELECT name_id FROM voice_mac WHERE organisation_id = ?")
    .bind(organisationId)
    .all<{ name_id: string }>();
  return rows.results.map((row) => row.name_id);
}

/**
 * Revokes a Mac and clears its secrets at once. It keeps the private address
 * while the Mac's public name still holds it: `forgetRevokedVoiceMacAddress`
 * clears it when the name is gone from DNS.
 */
export async function revokeVoiceMac(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: OrganisationId;
    macId: string;
    userId: UserId;
    now: number;
  }>,
): Promise<Readonly<{ nameId: string }> | null> {
  const row = await db
    .prepare(
      `UPDATE voice_mac
          SET state = 'revoked', credential_sha256 = NULL, code_sha256 = NULL,
              code_expires_at = NULL, revoked_at = ?, revoked_by_user_id = ?
        WHERE mac_id = ? AND organisation_id = ? AND state <> 'revoked'
        RETURNING name_id`,
    )
    .bind(input.now, input.userId, input.macId, input.organisationId)
    .first<{ name_id: string }>();
  return row === null ? null : { nameId: row.name_id };
}

/** A revoked Mac whose public name may still hold its private address. */
export type RevokedVoiceMacName = Readonly<{
  organisationId: OrganisationId;
  macId: string;
  nameId: string;
}>;

/** A run that tries again finds at most this many names. */
const REVOKED_NAME_BATCH = 50;

/**
 * The revoked Macs whose names a revoke could not remove from DNS, in every
 * Organisation of this database, the oldest revoke first.
 */
export async function listRevokedVoiceMacNames(
  db: OrganisationDatabase,
): Promise<readonly RevokedVoiceMacName[]> {
  const rows = await db
    .prepare(
      `SELECT organisation_id AS organisationId, mac_id AS macId,
              name_id AS nameId
         FROM voice_mac
        WHERE state = 'revoked' AND private_address IS NOT NULL
        ORDER BY revoked_at, mac_id
        LIMIT ?`,
    )
    .bind(REVOKED_NAME_BATCH)
    .all<Readonly<{ organisationId: string; macId: string; nameId: string }>>();
  return rows.results.flatMap((row) => {
    const organisationId = parseOrganisationId(row.organisationId);
    return organisationId.ok
      ? [
          {
            organisationId: organisationId.value,
            macId: row.macId,
            nameId: row.nameId,
          },
        ]
      : [];
  });
}

/** The name of a revoked Mac is gone from DNS, so its row keeps no address. */
export async function forgetRevokedVoiceMacAddress(
  db: OrganisationDatabase,
  mac: Pick<RevokedVoiceMacName, "organisationId" | "macId">,
): Promise<void> {
  await db
    .prepare(
      `UPDATE voice_mac SET private_address = NULL
        WHERE mac_id = ? AND organisation_id = ? AND state = 'revoked'
          AND private_address IS NOT NULL`,
    )
    .bind(mac.macId, mac.organisationId)
    .run();
}

/**
 * Revokes each Mac of an archived Organisation and clears its secrets and
 * its address, while the guard holds.
 */
export function prepareArchivedOrganisationVoiceMacsRevocation(
  db: Pick<OrganisationDatabase, "prepare">,
  input: Readonly<{
    now: number;
    organisationId: string;
    guard: Readonly<{ sql: string; bindings: readonly unknown[] }>;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE voice_mac
         SET state = 'revoked', credential_sha256 = NULL, code_sha256 = NULL,
             code_expires_at = NULL, private_address = NULL, revoked_at = ?
         WHERE organisation_id = ? AND state != 'revoked' AND ${input.guard.sql}`,
    )
    .bind(input.now, input.organisationId, ...input.guard.bindings);
}

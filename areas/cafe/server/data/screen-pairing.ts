// The pairing codes that a menu screen shows before an operator claims it.

type Database = Pick<D1Database, "prepare">;

/** The unexpired pairing for the code, or null. */
export function readOpenScreenPairing(
  db: Database,
  code: string,
  now: number,
): Promise<{ pairing_id: string; claimed_at: number | null } | null> {
  return db
    .prepare(
      `SELECT pairing_id, claimed_at FROM screen_pairing
     WHERE code = ? AND expires_at > ?`,
    )
    .bind(code, now)
    .first<{ pairing_id: string; claimed_at: number | null }>();
}

/** Claims the pairing for the organisation; false when another claim won. */
export async function claimScreenPairing(
  db: Database,
  input: Readonly<{
    pairingId: string;
    organisationId: string;
    screenToken: string;
    now: number;
  }>,
): Promise<boolean> {
  const claimed = await db
    .prepare(
      `UPDATE screen_pairing
     SET organisation_id = ?, screen_token = ?, claimed_at = ?
     WHERE pairing_id = ? AND claimed_at IS NULL AND expires_at > ?`,
    )
    .bind(
      input.organisationId,
      input.screenToken,
      input.now,
      input.pairingId,
      input.now,
    )
    .run();
  return claimed.meta.changes !== 0;
}

/** Removes the pairings whose codes have expired. */
export async function deleteExpiredScreenPairings(
  db: Database,
  now: number,
): Promise<void> {
  await db
    .prepare("DELETE FROM screen_pairing WHERE expires_at <= ?")
    .bind(now)
    .run();
}

/** How many codes are open, and how many of them the client asked for. */
export function countOpenScreenPairings(
  db: Database,
  clientKey: string,
): Promise<{ total: number; mine: number } | null> {
  return db
    .prepare(
      `SELECT count(*) AS total, count(*) FILTER (WHERE client_key = ?) AS mine
     FROM screen_pairing`,
    )
    .bind(clientKey)
    .first<{ total: number; mine: number }>();
}

/** Stores a new code; false when another screen shows the same code now. */
export async function insertScreenPairing(
  db: Database,
  input: Readonly<{
    pairingId: string;
    code: string;
    secretHash: string;
    clientKey: string;
    createdAt: number;
    expiresAt: number;
  }>,
): Promise<boolean> {
  const inserted = await db
    .prepare(
      `INSERT INTO screen_pairing (pairing_id, code, secret_hash, client_key, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (code) DO NOTHING`,
    )
    .bind(
      input.pairingId,
      input.code,
      input.secretHash,
      input.clientKey,
      input.createdAt,
      input.expiresAt,
    )
    .run();
  return inserted.meta.changes === 1;
}

/** The secret hash, expiry and token of a pairing, or null. */
export function readScreenPairingState(
  db: Database,
  pairingId: string,
): Promise<{
  secret_hash: string;
  expires_at: number;
  screen_token: string | null;
} | null> {
  return db
    .prepare(
      `SELECT secret_hash, expires_at, screen_token FROM screen_pairing
     WHERE pairing_id = ?`,
    )
    .bind(pairingId)
    .first<{
      secret_hash: string;
      expires_at: number;
      screen_token: string | null;
    }>();
}

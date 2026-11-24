import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { CredentialVaultBindings } from "@purin-labs/authority/credential-vault/keyring";
import { newRequestId, type OrganisationId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import { backoffDelay, errorMessage } from "@purin-labs/std";
import type { TypeSafeAuthority } from "@purin-labs/authority/policy/information-flow/types";
import type { TypeSafeCredential } from "./credential";
import {
  readTypeSafeConnection,
  resolveTypeSafeConnectionKey,
} from "./connection";
import { validJevApiKey } from "./system-one-client";

/**
 * Who funds one TypeSafe call (Plan 88 section 1). An Organisation with its own
 * connected key keeps it; every other Organisation uses Pantry's key.
 */
export type { TypeSafeAuthority };

const PANTRY_TYPESAFE_AUTHORITY: TypeSafeAuthority = Object.freeze({
  kind: "pantry_platform",
});

type TypeSafePlatformBindings = Readonly<{
  TYPESAFE_API_KEY?: string;
}>;

/** The authority that a new call or a new pin uses now. */
export function currentTypeSafeAuthority(
  sql: SqlStorage,
  organisationId: OrganisationId,
): TypeSafeAuthority {
  const connection = readTypeSafeConnection(sql, organisationId);
  return connection.kind === "connected"
    ? { kind: "organisation_byo", connectionRevision: connection.revision }
    : PANTRY_TYPESAFE_AUTHORITY;
}

/** A pinned authority stays current until the Organisation's key changes. */
export function typeSafeAuthorityIsCurrent(
  sql: SqlStorage,
  organisationId: OrganisationId,
  authority: TypeSafeAuthority,
): boolean {
  return sameTypeSafeAuthority(
    currentTypeSafeAuthority(sql, organisationId),
    authority,
  );
}

export function sameTypeSafeAuthority(
  left: TypeSafeAuthority,
  right: TypeSafeAuthority,
): boolean {
  if (left.kind === "pantry_platform") return right.kind === "pantry_platform";
  return (
    right.kind === "organisation_byo" &&
    right.connectionRevision === left.connectionRevision
  );
}

/** The stored revision: 0 for Pantry's key, the connection revision otherwise. */
export function typeSafeAuthorityRevision(
  authority: TypeSafeAuthority,
): number {
  return authority.kind === "pantry_platform" ? 0 : authority.connectionRevision;
}

export function typeSafeAuthorityFromStored(
  funding: unknown,
  revision: unknown,
): TypeSafeAuthority | null {
  if (funding === "pantry_platform")
    return revision === 0 || revision === null || revision === undefined
      ? PANTRY_TYPESAFE_AUTHORITY
      : null;
  if (
    funding === "organisation_byo" &&
    typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision >= 1
  )
    return { kind: "organisation_byo", connectionRevision: revision };
  return null;
}

/**
 * Resolves the key for the current authority. Pantry's key is the Wrangler
 * secret `TYPESAFE_API_KEY`; the Organisation's key comes from the Vault and is
 * read only when the Organisation connected one.
 */
export async function resolveTypeSafeCredential(
  input: Readonly<{
    sql: SqlStorage;
    db: OrganisationDatabase;
    keys: CredentialVaultBindings & TypeSafePlatformBindings;
    organisationId: OrganisationId;
  }>,
): Promise<TypeSafeCredential | null> {
  const authority = currentTypeSafeAuthority(input.sql, input.organisationId);
  if (authority.kind === "organisation_byo") {
    const key = await resolveTypeSafeConnectionKey(input);
    if (key === null || key.revision !== authority.connectionRevision)
      return null;
    return { provider: "typesafe", apiKey: key.apiKey, authority };
  }
  const apiKey = resolvePantryTypeSafeKey(input.keys);
  if (apiKey === null) return null;
  return { provider: "typesafe", apiKey, authority };
}

/** Pantry's own key, or null when the Worker has no valid `TYPESAFE_API_KEY`. */
export function resolvePantryTypeSafeKey(
  keys: TypeSafePlatformBindings,
): string | null {
  const apiKey = keys.TYPESAFE_API_KEY;
  return apiKey !== undefined && validJevApiKey(apiKey) ? apiKey : null;
}

/**
 * Plan 88: a mailbox that is on for mail classification is pinned to the
 * TypeSafe authority that funds it. When the Organisation's key changes, each
 * such mailbox moves to the new authority, in a D1 write. A move that fails
 * waits here, with the authority that the mailboxes are still pinned to, and
 * the Organisation's alarm tries it again: a minute later, then a wait that
 * doubles to an hour, at most 24 times. After that the move waits for the
 * next change of the key, which starts from the same authority.
 */
const REPIN_RETRY_BASE_MS = 60_000;
const REPIN_RETRY_CEILING_MS = 3_600_000;
const REPIN_MAX_ATTEMPTS = 24;

/** The D1 write that moves the mailboxes from one authority to another. */
export type MailRepin = (
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    from: TypeSafeAuthority;
    to: TypeSafeAuthority;
    now: number;
  }>,
) => Promise<unknown>;

/**
 * Moves the mailboxes to the current authority. `previous` is the authority
 * before a change of the key, or null for a retry of a waiting move.
 */
export async function moveMailSwitch(
  input: Readonly<{
    sql: SqlStorage;
    transaction: <T>(run: () => T) => T;
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    previous: TypeSafeAuthority | null;
    repin: MailRepin;
    now: number;
  }>,
): Promise<void> {
  const waiting = readWaitingMove(input.sql, input.organisationId);
  const from = waiting?.from ?? input.previous;
  if (from === null) return;
  const to = currentTypeSafeAuthority(input.sql, input.organisationId);
  if (!sameTypeSafeAuthority(from, to)) {
    try {
      await input.repin({
        db: input.db,
        organisationId: input.organisationId,
        from,
        to,
        now: input.now,
      });
    } catch (error) {
      traceWarn("organisation.jev_mail_repin_failed", {
        requestId: newRequestId(),
        organisationId: input.organisationId,
        attempt: (waiting?.attempts ?? 0) + 1,
        detail: errorMessage(error),
      });
      input.transaction(
        recordFailedMove.bind(null, input.sql, input.organisationId, {
          from,
          attempts: (waiting?.attempts ?? 0) + 1,
          now: input.now,
        }),
      );
      return;
    }
  }
  if (waiting !== null)
    input.sql.exec(
      "DELETE FROM jev_mail_repin WHERE organisation_id = ?",
      input.organisationId,
    );
}

/** True when a waiting move is due now. */
export function mailSwitchMoveDue(sql: SqlStorage, now: number): boolean {
  const due = nextMailSwitchMoveAt(sql);
  return due !== null && due <= now;
}

/** When the alarm must run next for a waiting move, or null. */
export function nextMailSwitchMoveAt(sql: SqlStorage): number | null {
  const at = sql
    .exec<{ at: number | null }>(
      "SELECT MIN(next_attempt_at) AS at FROM jev_mail_repin",
    )
    .toArray()[0]?.at;
  return at === null || at === undefined ? null : at;
}

function readWaitingMove(
  sql: SqlStorage,
  organisationId: OrganisationId,
): Readonly<{ from: TypeSafeAuthority; attempts: number }> | null {
  const row = sql
    .exec<{ from_funding: string; from_revision: number; attempts: number }>(
      "SELECT from_funding, from_revision, attempts FROM jev_mail_repin WHERE organisation_id = ?",
      organisationId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const from = typeSafeAuthorityFromStored(row.from_funding, row.from_revision);
  if (from === null) throw new Error("jev_mail_repin_corrupt");
  return { from, attempts: row.attempts };
}

function recordFailedMove(
  sql: SqlStorage,
  organisationId: OrganisationId,
  move: Readonly<{ from: TypeSafeAuthority; attempts: number; now: number }>,
): void {
  const nextAttemptAt =
    move.attempts >= REPIN_MAX_ATTEMPTS
      ? null
      : move.now +
        backoffDelay(
          move.attempts - 1,
          REPIN_RETRY_BASE_MS,
          REPIN_RETRY_CEILING_MS,
        );
  sql.exec(
    `INSERT INTO jev_mail_repin (organisation_id, from_funding, from_revision, attempts, next_attempt_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (organisation_id) DO UPDATE SET
      attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at`,
    organisationId,
    move.from.kind,
    typeSafeAuthorityRevision(move.from),
    move.attempts,
    nextAttemptAt,
  );
}

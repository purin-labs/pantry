import type {
  BakeAuthorityInput,
  BakeAuthorityMode,
  BakeAuthorityView,
} from "@purin-labs/kitchen-control-api";
import type { OrganisationDatabase } from "../../database-handles";
import type { OrganisationId } from "../../ids";
import type { Result } from "../../result";

/**
 * The authority of the bake runs at each kitchen location (Plan 24 S5). The
 * plan's rule is "shadow mode first, then approval mode": a location with no
 * row is in shadow mode, so an approved proposal starts a run that only
 * watches the cobots and sends nothing. An admin or the owner sets approval
 * mode on the Bakes page. This module is the one writer of `bake_authority`.
 *
 * The Portal chat agent reads the mode with the board, and it cannot change
 * it: approval mode lifts the restriction that keeps a cobot still, and the
 * agent lifts no restriction (Plan 81, Plan 24 rules).
 */

const DEFAULT_BAKE_AUTHORITY: BakeAuthorityMode = "shadow";

type AuthorityRow = Readonly<{
  kitchen_location: string;
  mode: BakeAuthorityMode;
  revision: number;
  set_by: string;
  set_at: number;
}>;

export type BakeAuthorityError = Readonly<{
  code: "bake_authority_stale";
  message: string;
}>;

function viewOf(row: AuthorityRow): BakeAuthorityView {
  return {
    kitchenLocation: row.kitchen_location,
    mode: row.mode,
    revision: row.revision,
    setBy: row.set_by,
    setAt: row.set_at,
  };
}

function defaultOf(kitchenLocation: string): BakeAuthorityView {
  return {
    kitchenLocation,
    mode: DEFAULT_BAKE_AUTHORITY,
    revision: null,
    setBy: null,
    setAt: null,
  };
}

/** The authority of each named location, with the default where none is set. */
export async function listBakeAuthority(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  locations: readonly string[],
): Promise<readonly BakeAuthorityView[]> {
  const rows = await db
    .prepare(
      `SELECT kitchen_location, mode, revision, set_by, set_at
         FROM bake_authority WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .all<AuthorityRow>();
  const set = new Map(
    rows.results.map((row) => [row.kitchen_location, viewOf(row)]),
  );
  const names = [...new Set([...locations, ...set.keys()])].sort();
  return names.map((name) => set.get(name) ?? defaultOf(name));
}

export async function readBakeAuthority(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  kitchenLocation: string,
): Promise<BakeAuthorityMode> {
  const row = await db
    .prepare(
      `SELECT mode FROM bake_authority
        WHERE organisation_id = ? AND kitchen_location = ?`,
    )
    .bind(organisationId, kitchenLocation)
    .first<{ mode: BakeAuthorityMode }>();
  return row?.mode ?? DEFAULT_BAKE_AUTHORITY;
}

/**
 * Sets the mode of one location. The caller checks that the person is an
 * admin or the owner. The revision that the person saw must be the current
 * one, so two admins never overwrite each other. The same mode writes
 * nothing. A run keeps the mode that it started with.
 */
export async function setBakeAuthority(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  input: BakeAuthorityInput,
  setBy: string,
  now: number,
): Promise<
  Result<
    Readonly<{ kind: "written" | "unchanged"; authority: BakeAuthorityView }>,
    BakeAuthorityError
  >
> {
  const kitchenLocation = input.kitchenLocation.trim();
  const current = await db
    .prepare(
      `SELECT kitchen_location, mode, revision, set_by, set_at
         FROM bake_authority
        WHERE organisation_id = ? AND kitchen_location = ?`,
    )
    .bind(organisationId, kitchenLocation)
    .first<AuthorityRow>();
  const stale: Result<never, BakeAuthorityError> = {
    ok: false,
    error: {
      code: "bake_authority_stale",
      message:
        "Someone changed the authority of this kitchen after you read it. Read it again.",
    },
  };
  if ((current?.revision ?? null) !== input.expectedRevision) return stale;
  if (current !== null && current.mode === input.mode)
    return {
      ok: true,
      value: { kind: "unchanged", authority: viewOf(current) },
    };
  if (current === null && input.mode === DEFAULT_BAKE_AUTHORITY)
    return {
      ok: true,
      value: { kind: "unchanged", authority: defaultOf(kitchenLocation) },
    };
  const revision = (current?.revision ?? 0) + 1;
  const written = await db
    .prepare(
      `INSERT INTO bake_authority (organisation_id, kitchen_location, mode,
         revision, set_by, set_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (organisation_id, kitchen_location) DO UPDATE SET
         mode = excluded.mode, revision = excluded.revision,
         set_by = excluded.set_by, set_at = excluded.set_at
       WHERE bake_authority.revision = ?`,
    )
    .bind(
      organisationId,
      kitchenLocation,
      input.mode,
      revision,
      setBy,
      now,
      revision - 1,
    )
    .run();
  if ((written.meta.changes ?? 0) === 0) return stale;
  return {
    ok: true,
    value: {
      kind: "written",
      authority: {
        kitchenLocation,
        mode: input.mode,
        revision,
        setBy,
        setAt: now,
      },
    },
  };
}

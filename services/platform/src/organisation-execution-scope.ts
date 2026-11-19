import type { AccountPlatformBindings } from "./account-platform/config";
import {
  accountAccessOfOneRead,
  createAccountPlatformAccess,
  type AccountPlatformAccess,
} from "./account-platform/access";
import type { VariantBy } from "@purin-labs/type-utils";
import {
  resolveActiveOrganisationPlacementRecord,
  samePlacement,
  type OrganisationPlacementError,
  type OrganisationPlacementRecord,
} from "./data/organisation-placement";
import {
  organisationDatabase,
  sameBinding,
  type OrganisationDatabase,
} from "./database-handles";
import type { Env } from "./env";
import type { OrganisationId } from "./ids";
import {
  parseOrganisationPlacementCells,
  type PlacementBoundaryError,
  type OrganisationPlacement,
} from "./placement";
import type { Result } from "./result";

export type OrganisationPlacementBindings = Pick<
  Env,
  | "DB"
  | "PANTRY_ORGANISATION_PLACEMENT_PROFILE"
  | "ORGANISATION_DB_WNAM"
  | "ORGANISATION_DB_APAC"
  | "ORGANISATION_DB_EU"
> &
  AccountPlatformBindings;

function organisationActorsOf(
  env: OrganisationPlacementBindings,
): Env["ORGANISATION"] | null {
  // The runtime passes the whole environment; a narrow test binding may not.
  return "ORGANISATION" in env
    ? (env as Pick<Env, "ORGANISATION">).ORGANISATION
    : null;
}

type ActivePlacement = VariantBy<
  OrganisationPlacementRecord,
  "status",
  "active"
>;

export type OrganisationExecutionScopeError =
  | { readonly code: "organisation_placement_conflict" }
  | OrganisationPlacementError
  | PlacementBoundaryError
  | {
      readonly code: "organisation_cell_unavailable";
      readonly organisationId: OrganisationId;
    };

/**
 * One read that is joined to the placement row, which the statement names
 * `placement`. `join` is the table and its condition; `columns` are read from
 * it and are null when it matches nothing. `binds` are the values of `join`.
 */
export type FencedRead = Readonly<{
  columns: string;
  join: string;
  binds: readonly (string | number)[];
}>;

export class OrganisationExecutionScope {
  readonly #database: OrganisationDatabase;
  readonly #organisationActors: Env["ORGANISATION"] | null;

  private constructor(
    database: OrganisationDatabase,
    readonly organisationId: OrganisationId,
    readonly placement: ActivePlacement["placement"],
    readonly fenceToken: ActivePlacement["fenceToken"],
    readonly accountAccess: AccountPlatformAccess,
    organisationActors: Env["ORGANISATION"] | null,
  ) {
    this.#database = database;
    this.#organisationActors = organisationActors;
    Object.freeze(this.placement);
    Object.freeze(this);
  }

  get database(): OrganisationDatabase {
    return this.#database;
  }

  /**
   * This scope for one read of one request. See `accountAccessOfOneRead`: the
   * read asks the account each question one time. A write keeps this scope.
   */
  ofOneRead(): OrganisationExecutionScope {
    return new OrganisationExecutionScope(
      this.#database,
      this.organisationId,
      this.placement,
      this.fenceToken,
      accountAccessOfOneRead(this.accountAccess),
      this.#organisationActors,
    );
  }

  /**
   * The Organisation Actors' binding, so that a write under this scope can
   * signal open chat pages. Null where the environment has no such binding.
   */
  get organisationActors(): Env["ORGANISATION"] | null {
    return this.#organisationActors;
  }

  static async resolve(
    env: OrganisationPlacementBindings,
    organisationId: OrganisationId,
  ): Promise<
    Result<OrganisationExecutionScope, OrganisationExecutionScopeError>
  > {
    const active = await resolveActiveOrganisationPlacementRecord(
      env.DB.withSession("first-primary"),
      organisationId,
    );
    if (!active.ok) return active;
    const placement = active.value.placement;
    const selected = selectOrganisationPlacementDatabase(
      env,
      organisationId,
      placement,
    );
    if (!selected.ok) return selected;
    const database = selected.value;
    const scope = new OrganisationExecutionScope(
      database,
      organisationId,
      placement,
      active.value.fenceToken,
      createAccountPlatformAccess(env, organisationId, database, {
        placementEpoch: placement.placementEpoch,
        placementCellId: placement.placementCellId,
        fenceToken: active.value.fenceToken,
      }),
      organisationActorsOf(env),
    );
    if (
      !sameBinding(database, env.DB) &&
      !(await scope.matchesActivePlacement(database))
    ) {
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    }
    return { ok: true, value: scope };
  }

  /**
   * Resolve the scope and make one read under it in one step. The read and
   * the regional fence are one statement, so the row comes from the state of
   * the database in which the published placement is active. A placement
   * that is not active there gives a conflict and no row.
   *
   * `read` may wait for work that began before this call; that work and the
   * placement read then share one wait. A null read withdraws the request,
   * and the result carries no scope.
   */
  static async resolveWithRead<Row>(
    env: OrganisationPlacementBindings,
    organisationId: OrganisationId,
    read: () => Promise<FencedRead | null>,
  ): Promise<
    Result<
      Readonly<{ scope: OrganisationExecutionScope; row: Row }> | null,
      OrganisationExecutionScopeError
    >
  > {
    const active = await resolveActiveOrganisationPlacementRecord(
      env.DB.withSession("first-primary"),
      organisationId,
    );
    if (!active.ok) return active;
    const selected = selectOrganisationPlacementDatabase(
      env,
      organisationId,
      active.value.placement,
    );
    if (!selected.ok) return selected;
    const scope = new OrganisationExecutionScope(
      selected.value,
      organisationId,
      active.value.placement,
      active.value.fenceToken,
      createAccountPlatformAccess(env, organisationId, selected.value, {
        placementEpoch: active.value.placement.placementEpoch,
        placementCellId: active.value.placement.placementCellId,
        fenceToken: active.value.fenceToken,
      }),
      organisationActorsOf(env),
    );
    const fenced = await read();
    if (fenced === null) return { ok: true, value: null };
    const row = await selected.value
      .withSession("first-primary")
      .prepare(
        `SELECT ${fenced.columns}
       FROM organisation_placement AS placement
       LEFT JOIN ${fenced.join}
       WHERE placement.organisation_id = ?
         AND placement.placement_epoch = ? AND placement.placement_cell_id = ?
         AND placement.fence_token = ? AND placement.status = 'active'`,
      )
      .bind(
        ...fenced.binds,
        organisationId,
        scope.placement.placementEpoch,
        scope.placement.placementCellId,
        scope.fenceToken,
      )
      .first<Row>();
    return row === null
      ? { ok: false, error: { code: "organisation_placement_conflict" } }
      : { ok: true, value: { scope, row } };
  }

  static async resolveAtPlacement(
    env: OrganisationPlacementBindings,
    organisationId: OrganisationId,
    placement: OrganisationPlacement,
  ): Promise<
    Result<OrganisationExecutionScope, OrganisationExecutionScopeError>
  > {
    const selected = selectOrganisationPlacementDatabase(
      env,
      organisationId,
      placement,
    );
    if (!selected.ok) return selected;
    const directoryRead = resolveActiveOrganisationPlacementRecord(
      env.DB.withSession("first-primary"),
      organisationId,
    );
    const regionalRead =
      sameBinding(selected.value, env.DB)
        ? directoryRead
        : resolveActiveOrganisationPlacementRecord(
            selected.value.withSession("first-primary"),
            organisationId,
          );
    const [directory, regional] = await Promise.all([
      directoryRead,
      regionalRead,
    ]);
    if (!directory.ok) return directory;
    if (
      !regional.ok ||
      !samePlacement(directory.value.placement, placement) ||
      !samePlacement(regional.value.placement, directory.value.placement) ||
      regional.value.fenceToken !== directory.value.fenceToken
    )
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    return {
      ok: true,
      value: new OrganisationExecutionScope(
        selected.value,
        organisationId,
        directory.value.placement,
        directory.value.fenceToken,
        createAccountPlatformAccess(env, organisationId, selected.value, {
          placementEpoch: directory.value.placement.placementEpoch,
          placementCellId: directory.value.placement.placementCellId,
          fenceToken: directory.value.fenceToken,
        }),
        organisationActorsOf(env),
      ),
    };
  }

  /** Include in the same D1 batch as effects so a frozen placement rolls back the batch. */
  prepareMutationFence(): D1PreparedStatement {
    return this.#database
      .prepare(
        `SELECT CASE WHEN EXISTS (
      SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = ?
        AND placement_cell_id = ? AND fence_token = ? AND status = 'active'
    ) THEN 1 ELSE json_extract('organisation_placement_conflict', '$') END`,
      )
      .bind(
        this.organisationId,
        this.placement.placementEpoch,
        this.placement.placementCellId,
        this.fenceToken,
      );
  }

  async isActive(): Promise<boolean> {
    // Routing observes global publication when the scope is resolved. Execution
    // uses the regional fence, which freezes before source export and resumes
    // the target only after publication. Global session authority stays live.
    return this.matchesActivePlacement(this.#database);
  }

  private async matchesActivePlacement(database: D1Database): Promise<boolean> {
    const row = await database
      .withSession("first-primary")
      .prepare(
        `SELECT 1 FROM organisation_placement WHERE organisation_id = ?
       AND placement_epoch = ? AND placement_cell_id = ?
       AND fence_token = ? AND status = 'active'`,
      )
      .bind(
        this.organisationId,
        this.placement.placementEpoch,
        this.placement.placementCellId,
        this.fenceToken,
      )
      .first();
    return row !== null;
  }
}

/** Select resources only; callers must separately establish execution authority. */
export function selectOrganisationPlacementDatabase(
  env: OrganisationPlacementBindings,
  organisationId: OrganisationId,
  placement: OrganisationPlacement,
): Result<OrganisationDatabase, OrganisationExecutionScopeError> {
  const configured = parseOrganisationPlacementCells(
    env.PANTRY_ORGANISATION_PLACEMENT_PROFILE,
  );
  if (!configured.ok) return configured;
  for (const cell of configured.value) {
    if (
      placement.placementCellId !== cell.placement.placementCellId ||
      placement.locationHint !== cell.placement.locationHint ||
      placement.kind !== cell.placement.kind ||
      placement.residencyJurisdiction !== cell.placement.residencyJurisdiction
    )
      continue;
    const database = env[cell.databaseBinding];
    if (database !== undefined)
      return { ok: true, value: organisationDatabase(database) };
    break;
  }
  return {
    ok: false,
    error: { code: "organisation_cell_unavailable", organisationId },
  };
}

/** Enumerate stores for ingress that has a provider identity but no organisation identity. */
export function configuredOrganisationDatabases(
  env: OrganisationPlacementBindings,
): readonly OrganisationDatabase[] {
  const configured = parseOrganisationPlacementCells(
    env.PANTRY_ORGANISATION_PLACEMENT_PROFILE,
  );
  if (!configured.ok) throw new Error(configured.error.code);
  const databases = new Set<OrganisationDatabase>();
  for (const cell of configured.value) {
    const database = env[cell.databaseBinding];
    if (database === undefined)
      throw new Error("organisation_cell_unavailable");
    databases.add(organisationDatabase(database));
  }
  return [...databases];
}

/** Recheck captured placement for every provider request, including retries. */
export async function fetchWithOrganisationPlacement(
  scope: OrganisationExecutionScope,
  fetcher: typeof fetch,
  request: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  if (!(await scope.isActive()))
    throw new Error("organisation_execution_authority_inactive");
  const response = await fetcher(request, init);
  if (!(await scope.isActive())) {
    await response.body?.cancel();
    throw new Error("organisation_execution_authority_inactive");
  }
  return response;
}

/** Check admission before dispatch; callers must persist issued provider receipts before release. */
export async function dispatchWithOrganisationPlacement(
  scope: OrganisationExecutionScope,
  fetcher: typeof fetch,
  request: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  if (!(await scope.isActive()))
    throw new Error("organisation_execution_authority_inactive");
  return fetcher(request, init);
}

export function organisationPlacementPredicate(
  scope: OrganisationExecutionScope,
): Readonly<{
  sql: string;
  bindings: readonly (string | number)[];
}> {
  return {
    sql: `EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
      AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ?
      AND status = 'active')`,
    bindings: [
      scope.organisationId,
      scope.placement.placementEpoch,
      scope.placement.placementCellId,
      scope.fenceToken,
    ],
  };
}

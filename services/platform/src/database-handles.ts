/**
 * Refactor 12: each D1 handle says which database it is.
 *
 * The Worker binds two kinds of database. `env.DB` holds the global records
 * (`migrations-global`): identity, the ingress directory and placement. Each
 * Organisation's records live in the regional database of its placement cell
 * (`migrations-regional`). A function that reads only global tables takes a
 * `GlobalDatabase`; one that reads only regional tables takes an
 * `OrganisationDatabase`. A function that names only the tables in both
 * databases (`organisation`, `organisation_placement`,
 * `control_mutation_receipt`) keeps a plain `D1Database`, and both handles
 * are assignable to it.
 *
 * The brand exists only for the type checker; at run time a handle is the
 * binding itself. The brand rides on `prepare`'s result too, so that
 * `Pick<GlobalDatabase, "prepare">` still names its database. Statements are
 * not branded beyond `prepare`: `bind` returns a plain `D1PreparedStatement`.
 *
 * Only this module makes a handle. `Env.DB` is declared a `GlobalDatabase`;
 * `OrganisationExecutionScope` and `selectOrganisationPlacementDatabase`
 * brand the regional binding. `pnpm lint:database-handles` refuses a cast to
 * either type outside this module.
 */

declare const globalRole: unique symbol;
declare const organisationRole: unique symbol;

/** Two keys, so that one handle can carry both roles in a one-database test. */
interface GlobalRole {
  readonly [globalRole]: true;
}
interface OrganisationRole {
  readonly [organisationRole]: true;
}

type GlobalStatement = D1PreparedStatement & GlobalRole;
export type OrganisationStatement = D1PreparedStatement & OrganisationRole;

/** `env.DB`: global identity, the ingress directory and placement. */
export interface GlobalDatabase extends D1Database, GlobalRole {
  prepare(query: string): GlobalStatement;
  withSession(
    constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint,
  ): GlobalDatabaseSession;
}
export interface GlobalDatabaseSession extends D1DatabaseSession, GlobalRole {
  prepare(query: string): GlobalStatement;
}

/** The regional database of one Organisation's placement cell. */
export interface OrganisationDatabase extends D1Database, OrganisationRole {
  prepare(query: string): OrganisationStatement;
  withSession(
    constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint,
  ): OrganisationDatabaseSession;
}
export interface OrganisationDatabaseSession
  extends D1DatabaseSession,
    OrganisationRole {
  prepare(query: string): OrganisationStatement;
}

/**
 * A regional binding that the placement profile selected for an
 * Organisation. Production code reaches it through
 * `OrganisationExecutionScope.database` or
 * `selectOrganisationPlacementDatabase`; in a one-database profile the
 * selected binding is `env.DB` itself.
 */
export function organisationDatabase(
  binding: D1Database,
): OrganisationDatabase {
  return binding as OrganisationDatabase;
}

/**
 * One database that holds both schemas, as in a unit test that loads the
 * combined schema. Production never makes one: a one-database placement
 * profile still gives each caller one role.
 */
export interface SingleDatabase
  extends GlobalDatabase,
    OrganisationDatabase {
  prepare(query: string): GlobalStatement & OrganisationStatement;
  withSession(
    constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint,
  ): SingleDatabaseSession;
}
interface SingleDatabaseSession
  extends GlobalDatabaseSession,
    OrganisationDatabaseSession {
  prepare(query: string): GlobalStatement & OrganisationStatement;
}

export function singleDatabase(binding: D1Database): SingleDatabase {
  return binding as SingleDatabase;
}

/**
 * True when two handles are one binding, as in a one-database placement
 * profile where the selected cell is `env.DB` itself.
 */
export function sameBinding(a: D1Database, b: D1Database): boolean {
  return a === b;
}

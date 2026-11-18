import type {
  GlobalDatabase,
  GlobalDatabaseSession,
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";

/** Anything that can prepare a D1 statement: the database or one of its sessions. */
export type QuerySource =
  Pick<D1Database, "prepare"> | Pick<D1DatabaseSession, "prepare">;

/** The global database or one of its sessions. */
export type GlobalQuerySource =
  Pick<GlobalDatabase, "prepare"> | Pick<GlobalDatabaseSession, "prepare">;

/** An Organisation's database or one of its sessions. */
export type OrganisationQuerySource =
  | Pick<OrganisationDatabase, "prepare">
  | Pick<OrganisationDatabaseSession, "prepare">;

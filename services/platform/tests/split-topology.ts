import type { SingleDatabase } from "../src/database-handles";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  bootstrapOrganisation,
  issueControlSession,
  upsertUser,
  type User,
} from "../src/data/control-plane";
import type { OrganisationId } from "../src/ids";
import { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import { parseInitialOrganisationPlacement } from "../src/placement";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { d1Database } from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

export type DeployedSchema = "migrations-global" | "migrations-regional";

export type SchemaDatabase = {
  readonly sqlite: DatabaseSync;
  readonly db: SingleDatabase;
};

export type SplitTopology = {
  readonly env: UnitTestEnv;
  readonly global: SchemaDatabase;
  readonly regional: SchemaDatabase;
};

export type SplitOrganisation = {
  readonly owner: User;
  readonly organisationId: OrganisationId;
  readonly scope: OrganisationExecutionScope;
  /** A signed-in portal request for the owner carries this header. */
  readonly cookie: string;
};

const SPLIT_PUBLIC_ORIGIN = "https://pantry.example";
const SPLIT_CELL = {
  kind: "affinity",
  placementCellId: "split-wnam",
  locationHint: "wnam",
} as const;

/** One SQLite database holding only the tables of one deployed schema. */
export function schemaDatabase(directory: DeployedSchema): SchemaDatabase {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(
      fileURLToPath(
        new URL(`../${directory}/0001_current_schema.sql`, import.meta.url)
          .href,
      ),
      "utf8",
    ),
  );
  return { sqlite, db: d1Database(sqlite) };
}

/**
 * The deployed topology: the global database behind `DB` and one Organisation
 * database behind a regional binding, each with only its own schema. The other
 * unit suites run on one database with both schemas, where a statement sent to the wrong
 * database still finds its table.
 */
export function createSplitTopology(): SplitTopology {
  const global = schemaDatabase("migrations-global");
  const regional = schemaDatabase("migrations-regional");
  return {
    global,
    regional,
    env: platformEnv({
      DB: global.db,
      ORGANISATION_DB_WNAM: regional.db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
        ...SPLIT_CELL,
        databaseBinding: "ORGANISATION_DB_WNAM",
      }),
      PANTRY_PUBLIC_ORIGIN: SPLIT_PUBLIC_ORIGIN,
    }),
  };
}

/** A user who signs in through the global database. */
export async function splitUser(
  topology: SplitTopology,
  name: string,
  now: number,
): Promise<User> {
  return upsertUser({
    db: topology.env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject: `split-${name}`,
      email: `${name}@example.test`,
      displayName: name,
      emailVerified: true,
    },
    now,
  });
}

/** An Organisation created the way the portal creates one, across both databases. */
export async function onboardSplitOrganisation(
  topology: SplitTopology,
  now: number,
): Promise<SplitOrganisation> {
  const owner = await splitUser(topology, "owner", now);
  const placement = parseInitialOrganisationPlacement({
    ...SPLIT_CELL,
    placementEpoch: 1,
  });
  if (!placement.ok) throw new Error(placement.error.path);
  const created = await bootstrapOrganisation({
    env: topology.env,
    owner,
    organisationName: "Split Merchant",
    environment: "production",
    placement: placement.value,
    mutation: organisationBootstrapMutation(owner, now),
    now,
  });
  if (!created.ok) throw new Error(created.error.code);
  const scope = await OrganisationExecutionScope.resolve(
    topology.env,
    created.value.organisationId,
  );
  if (!scope.ok) throw new Error(scope.error.code);
  const session = await issueControlSession({
    db: topology.env.DB,
    userId: owner.userId,
    now,
    ttlMs: 60 * 60 * 1000,
  });
  return {
    owner,
    organisationId: created.value.organisationId,
    scope: scope.value,
    cookie: `satyr_control_session=${session.token}`,
  };
}

/** A portal read by the signed-in owner. */
export function splitControlRequest(
  organisation: SplitOrganisation,
  suffix: string,
): Request {
  return new Request(
    `${SPLIT_PUBLIC_ORIGIN}/v1/control/organisations/${organisation.organisationId}/${suffix}`,
    { headers: { cookie: organisation.cookie } },
  );
}

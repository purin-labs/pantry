import { env } from "cloudflare:workers";
import {
  organisationDatabase as organisationHandle,
  type OrganisationDatabase,
} from "@purin-labs/kernel/database-handles";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { upsertUser, type User } from "@purin-labs/tenancy/data/control-plane";
import { organisationBootstrapMutation } from "../control-mutation-fixture";
import { requireOrganisationBootstrap } from "../organisation-execution-fixture";
import { selectOrganisationPlacementDatabase } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  parseInitialOrganisationPlacement,
  parseOrganisationPlacementCells,
  type InitialOrganisationPlacement,
} from "@purin-labs/tenancy/placement";

/**
 * The database that holds an Organisation's own records, as production picks
 * it from the placement profile. It is a regional database; `env.DB` holds
 * only the global records, as in production.
 */
export function organisationDatabase(
  rawOrganisationId: string,
  placementCellId = "e2e",
): OrganisationDatabase {
  const organisationId = parseOrganisationId(rawOrganisationId);
  if (!organisationId.ok) throw new Error("invalid organisation id");
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId,
    locationHint: "wnam",
  });
  if (!placement.ok) throw new Error(placement.error.path);
  const database = selectOrganisationPlacementDatabase(
    env,
    organisationId.value,
    placement.value,
  );
  if (!database.ok) throw new Error(database.error.code);
  return database.value;
}

/**
 * The root cell of the placement profile, where onboarding places a new
 * Organisation.
 */
export function rootPlacement(): InitialOrganisationPlacement {
  const cells = parseOrganisationPlacementCells(
    env.PANTRY_ORGANISATION_PLACEMENT_PROFILE,
  );
  if (!cells.ok) throw new Error(cells.error.path);
  const root = cells.value[0];
  if (root === undefined) throw new Error("placement profile has no cell");
  return root.placement;
}

/**
 * The database of the fixture placement cell `e2e`, where the fixtures keep
 * their Organisations.
 */
export function fixtureDatabase(placementCellId = "e2e"): OrganisationDatabase {
  const cells = parseOrganisationPlacementCells(
    env.PANTRY_ORGANISATION_PLACEMENT_PROFILE,
  );
  if (!cells.ok) throw new Error(cells.error.path);
  const cell = cells.value.find(
    (candidate) => candidate.placement.placementCellId === placementCellId,
  );
  const database = cell === undefined ? undefined : env[cell.databaseBinding];
  if (database === undefined)
    throw new Error(`placement cell ${placementCellId} has no database`);
  return organisationHandle(database);
}

/**
 * Creates an Organisation through production onboarding, as the Portal does:
 * `bootstrapOrganisation` writes the global and the regional rows with one
 * placement and one fence token. Its owner is a new Pantry user. Use it for an
 * Organisation whose id the journey does not fix in advance.
 */
export async function onboardFixtureOrganisation(
  name: string,
  placementCellId = "e2e",
): Promise<
  Readonly<{
    organisationId: OrganisationId;
    owner: User;
    ownerPersonId: string;
  }>
> {
  const now = Date.now();
  const subject = `onboarded-${crypto.randomUUID()}`;
  const owner = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject,
      email: `${subject}@example.invalid`,
      displayName: `${name} owner`,
      emailVerified: true,
    },
    now,
  });
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId,
    locationHint: "wnam",
  });
  if (!placement.ok) throw new Error(placement.error.path);
  const created = await requireOrganisationBootstrap({
    env,
    owner,
    organisationName: name,
    environment: "development",
    placement: placement.value,
    mutation: organisationBootstrapMutation(owner, now),
    now,
  });
  return {
    organisationId: created.organisationId,
    owner,
    ownerPersonId: created.personId,
  };
}

/**
 * Publishes an Organisation that a fixture wrote to its own database to the
 * global database, as onboarding does before an install: the same
 * Organisation row and the same placement rows, with their fence tokens.
 */
export async function publishGlobalOrganisation(
  rawOrganisationId: string,
  placementCellId = "e2e",
): Promise<void> {
  const database = organisationDatabase(rawOrganisationId, placementCellId);
  const statements: D1PreparedStatement[] = [];
  for (const table of ["organisation", "organisation_placement"]) {
    const rows = await database
      .prepare(`SELECT * FROM ${table} WHERE organisation_id = ?`)
      .bind(rawOrganisationId)
      .all<Record<string, unknown>>();
    for (const row of rows.results) {
      const columns = Object.keys(row);
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        ).bind(...columns.map((column) => row[column])),
      );
    }
  }
  if (statements.length === 0)
    throw new Error(`organisation ${rawOrganisationId} has no fixture rows`);
  await env.DB.batch(statements);
}

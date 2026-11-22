import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { ensureOrganisationDefaultWorkspace } from "../data/organisation-workspace";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { requireActiveOrganisationActorAtPlacement } from "../actors/actor-router";
import type { OrganisationEnvironment } from "../data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";

export async function readOrganisationEnvironment(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<OrganisationEnvironment | null> {
  const row = await db
    .prepare(
      `SELECT environment FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{ readonly environment: unknown }>();
  return row?.environment === "development" || row?.environment === "production"
    ? row.environment
    : null;
}

export async function ensureCreatedOrganisationActor(
  input: Readonly<{
    env: Env;
    organisationId: OrganisationId;
    now: number;
  }>,
): Promise<void> {
  const scope = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!scope.ok) throw new Error(scope.error.code);
  const workspace = await ensureOrganisationDefaultWorkspace({
    scope: scope.value,
    archive: input.env.ARCHIVE,
    now: input.now,
  });
  if (!workspace.ok) throw new Error(workspace.error.code);
  const row = await scope.value.database
    .prepare(
      `SELECT name, created_at AS createdAt
     FROM organisation
     WHERE organisation_id = ? AND status = 'active'`,
    )
    .bind(input.organisationId)
    .first<{
      readonly name: unknown;
      readonly createdAt: unknown;
    }>();
  if (
    row === null ||
    typeof row.name !== "string" ||
    row.name.length === 0 ||
    typeof row.createdAt !== "number" ||
    !Number.isSafeInteger(row.createdAt)
  ) {
    throw new Error("created organisation metadata is invalid");
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env: input.env,
    organisationId: input.organisationId,
    placement: scope.value.placement,
    now: input.now,
  });
  await organisation.ensureOrganisation({
    organisationId: input.organisationId,
    name: row.name,
    plan: "beta",
    status: "active",
    createdAt: row.createdAt,
  });
}

import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { readOrganisationEnvironment } from "../../control/organisation-runtime";
import {
  resolveOrganisationProvisioningActor,
  type OrganisationEnvironment,
} from "../../data/control-plane";
import {
  createActiveConnectedIntegration,
  type ActiveProviderAccountContext,
  type ConnectedIntegrationSeed,
} from "../../data/integration-account";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";

type AdminConnectedIntegrationSeed = Omit<
  ConnectedIntegrationSeed,
  | "organisationId"
  | "createdByUserId"
  | "now"
  | "environment"
  | "providerSubjectId"
>;

export async function createActiveAdminIntegration(input: {
  readonly scope: OrganisationExecutionScope;
  readonly seed: AdminConnectedIntegrationSeed;
  readonly now: number;
}): Promise<ActiveProviderAccountContext | null> {
  const provisioningPrincipalId = await resolveOrganisationProvisioningActor({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
  });

  if (provisioningPrincipalId === null) {
    return null;
  }
  const environment = await requireOrganisationEnvironment(
    input.scope.database,
    input.scope.organisationId,
  );

  const connected = await createActiveConnectedIntegration(
    input.scope.database,
    {
      organisationId: input.scope.organisationId,
      createdByUserId: provisioningPrincipalId,
      providerSubjectId: input.seed.providerAccountId,
      environment,
      now: input.now,
      ...input.seed,
    },
  );
  return {
    account: connected.account,
    connection: connected.connection,
  };
}

/** The environment of an onboarded Organisation. It throws when the row is not valid. */
export async function requireOrganisationEnvironment(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<OrganisationEnvironment> {
  const environment = await readOrganisationEnvironment(db, organisationId);
  if (environment === null) {
    throw new Error("organisation onboarding environment is invalid");
  }
  return environment;
}

import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  typeSafeAuthorityRevision,
  type TypeSafeAuthority,
} from "@purin-labs/agent/integrations/typesafe/authority";
import { mailClassificationEligible } from "@purin-labs/area-integrations-contract/server/mail-classification-eligibility";

export async function mailInferenceEligible(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    sourcePin: string;
    typesafe: TypeSafeAuthority;
    now: number;
  }>,
): Promise<boolean> {
  return mailClassificationEligible({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    sourcePin: input.sourcePin,
    funding: input.typesafe.kind,
    connectionRevision: typeSafeAuthorityRevision(input.typesafe),
    now: input.now,
  });
}

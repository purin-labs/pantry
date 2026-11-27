import type { IntegrationAccountReference } from "@purin-labs/authority/access-control/integration-discovery";
import {
  resolveAccountCapability,
  type AccountCapability,
} from "@purin-labs/authority/authorization/access-grants/account-capability";
import {
  CAPABILITY_KEYS,
  EMAIL_OPERATIONAL_RESOURCE_SCOPE,
} from "@purin-labs/authority/authorization/capability-catalogue";
import type { OrganisationId } from "@purin-labs/kernel/ids";

export async function resolveEmailOperationalCapability(
  organisationId: OrganisationId,
  capabilityKeys: readonly string[],
  accountRef: IntegrationAccountReference,
): Promise<AccountCapability | null> {
  return resolveAccountCapability(
    organisationId,
    capabilityKeys,
    accountRef,
    CAPABILITY_KEYS.emailOperationalPropose,
    EMAIL_OPERATIONAL_RESOURCE_SCOPE,
  );
}

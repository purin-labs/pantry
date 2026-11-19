import {
  parseCapabilityKey,
  type CapabilityDefinition,
} from "../authorization/access-grants/capability-key";
import {
  integrationAccountReference,
  type IntegrationAccountReference,
} from "../access-control/integration-discovery";
import {
  CAPABILITY_KEYS,
  EMAIL_OPERATIONAL_RESOURCE_SCOPE,
  SLACK_MESSAGE_RESOURCE_SCOPE,
} from "../authorization/capability-catalogue";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../ids";
import type { Variant } from "@purin-labs/type-utils";

type AccountCapability = Variant<CapabilityDefinition, "provider_resource"> & {
  readonly integrationAccountId: IntegrationAccountId;
};

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

export async function resolveSlackMessageCapability(
  organisationId: OrganisationId,
  capabilityKeys: readonly string[],
  accountRef: IntegrationAccountReference,
): Promise<AccountCapability | null> {
  return resolveAccountCapability(
    organisationId,
    capabilityKeys,
    accountRef,
    CAPABILITY_KEYS.slackMessagePropose,
    SLACK_MESSAGE_RESOURCE_SCOPE,
  );
}

/**
 * The granted capability on the exact account that the model named by its
 * reference. The model never sees an account ID, only the reference that
 * integration_list returned.
 */
async function resolveAccountCapability(
  organisationId: OrganisationId,
  capabilityKeys: readonly string[],
  accountRef: IntegrationAccountReference,
  capabilityId: string,
  resourceScope: string,
): Promise<AccountCapability | null> {
  for (const key of capabilityKeys) {
    const parsed = parseCapabilityKey(key);
    if (
      !parsed.ok ||
      parsed.value.kind !== "provider_resource" ||
      parsed.value.capabilityId !== capabilityId ||
      parsed.value.resourceScope !== resourceScope
    ) {
      continue;
    }
    const accountId = parseIntegrationAccountId(
      parsed.value.integrationAccountId,
    );
    if (!accountId.ok) continue;
    const reference = await integrationAccountReference(
      organisationId,
      accountId.value,
      "integration_account",
    );
    if (reference === accountRef) {
      return {
        kind: "provider_resource",
        capabilityId: parsed.value.capabilityId,
        capabilityVersion: parsed.value.capabilityVersion,
        integrationAccountId: accountId.value,
        resourceScope: parsed.value.resourceScope,
      };
    }
  }
  return null;
}

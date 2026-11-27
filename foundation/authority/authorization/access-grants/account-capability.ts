import {
  parseCapabilityKey,
  type CapabilityDefinition,
} from "./capability-key";
import {
  integrationAccountReference,
  type IntegrationAccountReference,
} from "../../access-control/integration-discovery";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Variant } from "@purin-labs/type-utils";

export type AccountCapability = Variant<
  CapabilityDefinition,
  "provider_resource"
> & {
  readonly integrationAccountId: IntegrationAccountId;
};

/**
 * The granted capability on the exact account that the model named by its
 * reference. The model never sees an account ID, only the reference that
 * integration_list returned.
 */
export async function resolveAccountCapability(
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

import { describe, expect, it } from "vitest";
import {
  integrationAccountReference,
  parseIntegrationAccountReference,
} from "@purin-labs/authority/access-control/integration-discovery";
import { resolveEmailOperationalCapability } from "@purin-labs/area-inbox/server/actors/email-operational-capability";
import { encodeCapabilityKey } from "@purin-labs/authority/authorization/access-grants/capability-key";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";

describe("operational email account resolution", operationalEmailSuite);

function operationalEmailSuite(): void {
  it(
    "resolves discovery references only within the granted organisation and scope",
    resolvesGrantedReference,
  );
}

async function resolvesGrantedReference(): Promise<void> {
  const organisation = parseOrganisationId("organisation_email_test");
  const otherOrganisation = parseOrganisationId("organisation_other");
  const account = parseIntegrationAccountId("integration_account_email_test");
  if (!organisation.ok || !otherOrganisation.ok || !account.ok)
    throw new Error("Invalid fixture");
  const reference = await integrationAccountReference(
    organisation.value,
    account.value,
    "integration_account",
  );
  const capability = {
    kind: "provider_resource" as const,
    capabilityId: "email.operational.propose",
    capabilityVersion: 1,
    integrationAccountId: account.value,
    resourceScope: "operational",
  };
  const keys = [encodeCapabilityKey(capability)];
  expect(parseIntegrationAccountReference(reference)).toBe(reference);
  expect(parseIntegrationAccountReference(account.value)).toBeNull();
  expect(parseIntegrationAccountReference(`${reference}extra`)).toBeNull();
  expect(
    await resolveEmailOperationalCapability(
      organisation.value,
      keys,
      reference,
    ),
  ).toEqual(capability);
  expect(
    await resolveEmailOperationalCapability(
      otherOrganisation.value,
      keys,
      reference,
    ),
  ).toBeNull();
  expect(
    await resolveEmailOperationalCapability(organisation.value, [], reference),
  ).toBeNull();
  const mailboxKey = encodeCapabilityKey({
    ...capability,
    resourceScope: "mailbox",
  });
  expect(
    await resolveEmailOperationalCapability(
      organisation.value,
      [mailboxKey],
      reference,
    ),
  ).toBeNull();
}

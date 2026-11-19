import type { UnitTestEnv } from "./worker-fakes";
import type { EmailCommerceEvidence } from "../src/mail-inbox/supplier-context";
import { EmailSupplierContext } from "../src/mail-inbox/supplier-context";
import type { RequestAuthority } from "@purin-labs/contracts";

const receipt = {
  integrationAccountId: "integration_purchasing",
  merchantId: "merchant_purchasing",
  merchantRevision: 1,
  grantId: "grant_purchasing",
  resourceScope: "commerce_read:list",
  labelDigest: "a".repeat(64),
  mailboxAuthority: {
    kind: "agent_mailbox",
    organisationId: "organisation_mail",
    integrationAccountId: "integration_mail",
    mailboxBindingId: "binding_mail",
    bindingRevision: 1,
    mailboxPolicyVersion: 1,
  },
} as const;

export const evidencedDraft: EmailCommerceEvidence = receipt;

export const missingSnapshot: EmailCommerceEvidence = {
  ...receipt,
  // @ts-expect-error A broad spread cannot remove the required merchant snapshot.
  merchantRevision: undefined,
};

export const invalidMailbox: EmailCommerceEvidence = {
  ...receipt,
  // @ts-expect-error Publishing operator authority cannot fund a mailbox investigation.
  mailboxAuthority: { kind: "control", organisationId: "organisation_mail" },
};

export const incompleteMailbox: EmailCommerceEvidence = {
  ...receipt,
  // @ts-expect-error Mailbox authority requires its policy fence.
  mailboxAuthority: {
    kind: "agent_mailbox",
    organisationId: "organisation_mail",
    integrationAccountId: "integration_mail",
    mailboxBindingId: "binding_mail",
    bindingRevision: 1,
  },
};

export function operatorCannotInvestigate(
  env: UnitTestEnv,
  authority: Extract<RequestAuthority, { kind: "control" }>,
) {
  // @ts-expect-error Core purchasing reads accept only mailbox authority.
  return new EmailSupplierContext(env, authority, "case_mail");
}

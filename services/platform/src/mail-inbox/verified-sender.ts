import type { OrganisationDatabase } from "../database-handles";
import {
  readContactVerificationStanding,
  type ContactEndpoint,
  type VerifiedContactEndpoint,
} from "../data/contact-verification";
import { readEmailMessageReceiptContact } from "../data/email-mailbox";
import type { OperationalEmailTarget } from "../data/email-operational";
import type { CaseId, IntegrationAccountId, OrganisationId } from "../ids";
import { digestCanonical } from "../policy/information-flow/digest";
import type { FlowRecipient } from "../policy/information-flow/types";
import type { Variant } from "@purin-labs/type-utils";

type VerifiedSupplierEndpoint = Omit<
  VerifiedContactEndpoint,
  "target" | "endpoint"
> &
  Readonly<{
    target: Variant<OperationalEmailTarget, "supplier_contact">;
    endpoint: Extract<ContactEndpoint, { channel: "gmail" }>;
  }>;

/**
 * The verified supplier contact one admitted message is from.
 *
 * It is established only by the message receipt's binding to a verification
 * that is still current for this mailbox, organisation and merchant. Mail
 * admission makes that binding when a reply to the message goes to the
 * sender's own verified address. A missing, superseded or revoked
 * verification, an ambiguous endpoint, or a contact that is not a supplier's
 * is a known absence. A record the verification rests on that cannot be
 * interpreted is not: it leaves the sender unknown.
 */
type VerifiedMessageSender =
  | Readonly<{ kind: "supplier"; endpoint: VerifiedSupplierEndpoint }>
  | Readonly<{ kind: "none" | "unreadable"; endpoint?: never }>;

export async function readVerifiedMessageSender(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    caseId: CaseId;
    messageId: string;
  }>,
): Promise<VerifiedMessageSender> {
  const bound = await readEmailMessageReceiptContact({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    providerMessageId: input.messageId,
    caseId: input.caseId,
  });
  if (bound === null) return { kind: "none" };
  const standing = await readContactVerificationStanding({
    db: input.db,
    organisationId: input.organisationId,
    verificationId: bound.verificationId,
    expectedRevision: bound.verificationRevision,
  });
  if (standing.kind === "unreadable") return { kind: "unreadable" };
  if (standing.kind !== "verified") return { kind: "none" };
  const verified = standing.endpoint;
  const { target, endpoint } = verified;
  if (
    verified.integrationAccountId !== input.integrationAccountId ||
    endpoint.channel !== "gmail" ||
    target.kind !== "supplier_contact"
  )
    return { kind: "none" };
  return { kind: "supplier", endpoint: { ...verified, target, endpoint } };
}

/**
 * The recipient a reply to a verified supplier contact is bound to. It names
 * the exact verification revision, so a later revision is another recipient.
 */
export async function supplierReplyRecipient(
  endpoint: VerifiedSupplierEndpoint,
): Promise<FlowRecipient> {
  return {
    organisationId: endpoint.organisationId,
    merchantId: endpoint.merchantId,
    integrationAccountId: endpoint.integrationAccountId,
    partyKind: "supplier",
    partyId: endpoint.target.supplierId,
    contactId: endpoint.target.contactId,
    contactRevision: endpoint.target.contactRevision,
    verificationId: endpoint.verificationId,
    verificationRevision: endpoint.revision,
    endpointDigest: await digestCanonical(endpoint.endpoint.address),
    purpose: "supplier_reply",
  };
}

/**
 * The verified recipient a plain reply to one admitted message is bound to,
 * or null when the message has no verified supplier sender. An unreadable
 * verification binds nothing: a reply is never bound on an unknown.
 */
export async function readEmailReplyRecipient(
  input: Parameters<typeof readVerifiedMessageSender>[0],
): Promise<FlowRecipient | null> {
  const sender = await readVerifiedMessageSender(input);
  return sender.kind === "supplier"
    ? supplierReplyRecipient(sender.endpoint)
    : null;
}

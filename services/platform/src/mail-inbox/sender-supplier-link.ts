import type { OrganisationDatabase } from "../database-handles";
import { sha256Hex } from "@purin-labs/std";

import {
  listCurrentEndpointVerificationIds,
  publishContactVerification,
  readContactVerificationStanding,
  readEndpointVerificationStanding,
  readLatestContactVerification,
} from "../data/contact-verification";
import {
  registerOperationalEmailContact,
  type OperationalEmailTarget,
} from "../data/email-operational";
import type { IntegrationAccountId, OrganisationId } from "../ids";
import type { Result } from "../result";
import type { Variant } from "@purin-labs/type-utils";

/**
 * A sender of one mailbox that a person links to a supplier from the Inbox.
 *
 * The link is the two records that mail admission already reads: an active
 * supplier contact with the sender's address, and a verification of that
 * address for the mailbox. Admission binds each message it admits from the
 * address to the verification as it stands then, so a link applies to mail
 * that arrives after it. Mail admitted before keeps the binding it got.
 *
 * The Inbox keeps one verification for each mailbox and address. A link to
 * another supplier is a new revision of it, which supersedes the earlier one.
 */
type SenderSupplierLinkState = Readonly<{
  /** The supplier that new mail from the address is bound to, or null. */
  supplierId: string | null;
  /** The revision of the Inbox's verification for the address, 0 if none. */
  revision: number;
}>;

type SenderSupplierLinkError = Readonly<{
  code:
    | "mailbox_sender_link_changed"
    | "mailbox_sender_link_conflict"
    | "mailbox_sender_link_unavailable";
}>;

/** What the Portal Inbox action names as the evidence of each link. */
const SENDER_LINK_EVIDENCE = "portal:inbox:link_sender_to_supplier";

/** A sender address as a link names it, or null when it is not one. */
export function senderLinkAddress(raw: string): string | null {
  const address = raw.trim().toLowerCase();
  return address.length >= 3 &&
    address.length <= 320 &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(address)
    ? address
    : null;
}

/** The verification that the Inbox keeps for one sender of one mailbox. */
async function senderLinkVerificationId(
  integrationAccountId: IntegrationAccountId,
  address: string,
): Promise<string> {
  return `mailbox_sender:${await sha256Hex(`${integrationAccountId}\u0000${address}`)}`;
}

/**
 * The supplier contact that a link makes for an address. It is the same for
 * each supplier, so a link back to an earlier supplier finds its contact.
 */
async function senderContactTarget(
  supplierId: string,
  address: string,
): Promise<Variant<OperationalEmailTarget, "supplier_contact">> {
  return {
    kind: "supplier_contact",
    supplierId,
    contactId: `mailbox_sender_${await sha256Hex(address)}`,
    contactRevision: 1,
  };
}

/**
 * The supplier that mail admitted now from the address would be bound to:
 * the one current verification of the address for this mailbox, whoever made
 * it.
 */
export async function readSenderSupplierLink(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    address: string;
  }>,
): Promise<Result<SenderSupplierLinkState, SenderSupplierLinkError>> {
  try {
    const [standing, own] = await Promise.all([
      readEndpointVerificationStanding({
        db: input.db,
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        endpoint: { channel: "gmail", address: input.address },
      }),
      readLatestContactVerification({
        db: input.db,
        organisationId: input.organisationId,
        verificationId: await senderLinkVerificationId(
          input.integrationAccountId,
          input.address,
        ),
      }),
    ]);
    if (standing.kind === "unreadable") return unavailable();
    const target = standing.endpoint?.target;
    return {
      ok: true,
      value: {
        supplierId:
          target?.kind === "supplier_contact" ? target.supplierId : null,
        revision: own?.revision ?? 0,
      },
    };
  } catch {
    return unavailable();
  }
}

/**
 * Links the address to the supplier for this mailbox. The supplier and the
 * mailbox are checked by the caller.
 *
 * The contact is written first and the verification second. A contact with
 * no verification binds no mail, so a failure between the two leaves nothing
 * that admission reads, and the same command again completes the link: the
 * contact write is idempotent and the verification answers a repeated
 * command from its first result.
 */
export async function linkSenderToSupplier(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    actorId: string;
    address: string;
    supplierId: string;
    expectedRevision: number;
    /** Stable for one request, so that a retry is the same command. */
    commandId: string;
    now: number;
  }>,
): Promise<
  Result<
    Readonly<{ verificationId: string; revision: number }>,
    SenderSupplierLinkError
  >
> {
  const endpoint = { channel: "gmail" as const, address: input.address };
  const verificationId = await senderLinkVerificationId(
    input.integrationAccountId,
    input.address,
  );
  const target = await senderContactTarget(input.supplierId, input.address);
  try {
    // A verification that the Inbox did not make would leave the address
    // with two current verifications, which binds no mail at all.
    const current = await listCurrentEndpointVerificationIds({
      db: input.db,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      endpoint,
    });
    if (current.some((id) => id !== verificationId))
      return failure("mailbox_sender_link_conflict");
    const latest = await readLatestContactVerification({
      db: input.db,
      organisationId: input.organisationId,
      verificationId,
    });
    if (
      latest !== null &&
      latest.state === "verified" &&
      latest.integrationAccountId === input.integrationAccountId &&
      sameTarget(latest.target, target)
    ) {
      const standing = await readContactVerificationStanding({
        db: input.db,
        organisationId: input.organisationId,
        verificationId,
        expectedRevision: latest.revision,
      });
      // The address is linked to this supplier already.
      if (standing.kind === "verified")
        return {
          ok: true,
          value: { verificationId, revision: latest.revision },
        };
    }
    const contact = await registerOperationalEmailContact({
      db: input.db,
      organisationId: input.organisationId,
      target,
      address: input.address,
      displayName: null,
      state: "active",
      relationshipState: "active",
      now: input.now,
    });
    if (!contact.ok)
      return failure(
        contact.error.code === "email_operational_directory_write_failed"
          ? "mailbox_sender_link_unavailable"
          : "mailbox_sender_link_conflict",
      );
    const verified = await publishContactVerification({
      db: input.db,
      organisationId: input.organisationId,
      actorId: input.actorId,
      now: input.now,
      command: {
        kind: "verify",
        commandId: input.commandId,
        verificationId,
        expectedRevision: input.expectedRevision,
        integrationAccountId: input.integrationAccountId,
        target,
        endpoint,
        evidenceRef: SENDER_LINK_EVIDENCE,
      },
    });
    if (!verified.ok)
      return failure(
        verified.error.code === "contact_verification_conflict"
          ? "mailbox_sender_link_changed"
          : "mailbox_sender_link_unavailable",
      );
    return {
      ok: true,
      value: { verificationId, revision: verified.value.revision },
    };
  } catch {
    return failure("mailbox_sender_link_unavailable");
  }
}

function sameTarget(
  left: OperationalEmailTarget,
  right: Variant<OperationalEmailTarget, "supplier_contact">,
): boolean {
  return (
    left.kind === "supplier_contact" &&
    left.supplierId === right.supplierId &&
    left.contactId === right.contactId &&
    left.contactRevision === right.contactRevision
  );
}

function unavailable(): Result<never, SenderSupplierLinkError> {
  return failure("mailbox_sender_link_unavailable");
}

function failure(
  code: SenderSupplierLinkError["code"],
): Result<never, SenderSupplierLinkError> {
  return { ok: false, error: { code } };
}

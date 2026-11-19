import { hasExactKeys, isNonBlankString, isRecord } from "@purin-labs/std";

/**
 * The supplier that one sender address of one mailbox is linked to.
 *
 * A link makes the address a verified supplier contact of the mailbox. Mail
 * admission binds each new message from the address to that contact, so the
 * link applies to mail that arrives after it.
 */
export type MailSenderLink = Readonly<{
  /** The supplier that new mail from the address is bound to, or null. */
  supplier: Readonly<{
    supplierId: string;
    /** Null when the supplier record cannot be read now. */
    name: string | null;
  }> | null;
  /**
   * The revision of the link that the Inbox keeps for this address, 0 when
   * there is none. A change names it as its expected revision.
   */
  revision: number;
}>;

/** `POST …/agent-mailboxes/{account}/sender-links`. */
export type MailSenderLinkRequest = Readonly<{
  address: string;
  supplierId: string;
  expectedRevision: number;
}>;

export function parseMailSenderLinkRequest(
  raw: unknown,
): MailSenderLinkRequest | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["address", "supplierId", "expectedRevision"]) ||
    typeof raw.address !== "string" ||
    raw.address.length > 320 ||
    !isNonBlankString(raw.supplierId) ||
    raw.supplierId.length > 200 ||
    typeof raw.expectedRevision !== "number" ||
    !Number.isSafeInteger(raw.expectedRevision) ||
    raw.expectedRevision < 0
  )
    return null;
  return {
    address: raw.address,
    supplierId: raw.supplierId,
    expectedRevision: raw.expectedRevision,
  };
}

export function parseMailSenderLinkResponse(raw: unknown): MailSenderLink {
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    !isRecord(raw.link) ||
    !hasExactKeys(raw.link, ["supplier", "revision"])
  )
    throw new Error("The sender link returned an unexpected response.");
  const { supplier, revision } = raw.link;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    throw new Error("The sender link returned an unexpected response.");
  if (supplier === null) return { supplier: null, revision };
  if (
    !isRecord(supplier) ||
    !hasExactKeys(supplier, ["supplierId", "name"]) ||
    !isNonBlankString(supplier.supplierId) ||
    (supplier.name !== null && typeof supplier.name !== "string")
  )
    throw new Error("The sender link returned an unexpected response.");
  return {
    supplier: { supplierId: supplier.supplierId, name: supplier.name },
    revision,
  };
}

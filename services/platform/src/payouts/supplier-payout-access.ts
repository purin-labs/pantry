import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { AccessGrant } from "@purin-labs/authority/authorization/access-grants/types";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import {
  createCurrentSourceFlowLabel,
  type FlowLabel,
} from "@purin-labs/authority/policy/index";

/**
 * Who may read what a merchant pays its suppliers.
 *
 * Payout figures are Pantry's own records. Their label comes from the
 * `commerce.supplier_payout.read` grants that the reader's authority
 * selects: each grant's subject is a reader, and the organisation must have
 * enabled payout reads. Each surface checks the label against where its
 * answer goes, so a grant to a person or a role admits that person's own
 * read, and only a grant to a channel admits an answer in that channel.
 */
export async function supplierPayoutLabel(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    /** The active grants that the reader's request authority selects. */
    grants: readonly AccessGrant[];
  }>,
): Promise<FlowLabel | null> {
  const grantIds: string[] = [];
  for (const grant of input.grants)
    if (
      grant.target.kind === "platform_capability" &&
      grant.target.capabilityId ===
        CAPABILITY_KEYS.commerceSupplierPayoutRead &&
      grant.target.capabilityVersion === 1
    )
      grantIds.push(grant.grantId);
  if (grantIds.length === 0) return null;
  const label = await createCurrentSourceFlowLabel({
    kind: "supplier_payouts",
    db: input.db,
    organisationId: input.organisationId,
    grantIds,
  });
  return label.ok ? label.value : null;
}

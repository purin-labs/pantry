import type { AccessGrant } from "@purin-labs/authority/authorization/access-grants/types";
import type { FlowLabel } from "@purin-labs/authority/policy/index";
import type { SupplierPayoutStateKind } from "@purin-labs/control-api";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";

/** One supplier payout as the store keeps it, at its current revision. */
export type SupplierPayoutRow = Readonly<{
  payoutId: string;
  payableId: string;
  supplierId: string;
  purchaseRequestId: string;
  rail: "gmo_aozora_private" | "wise_enterprise_payouts";
  integrationAccountId: string;
  destinationRevisionId: string;
  currency: string;
  recipientAmountMinor: number;
  feeCeilingMinor: number;
  idempotencyKey: string;
  stateKind: SupplierPayoutStateKind;
  /** Null only before approval, or after cancellation without one. */
  approvalDigest: string | null;
  payoutJson: string;
  revision: number;
}>;

/**
 * The supplier payout reads that a Slack reply shows: the label of a
 * reader's payout read grants, and the payouts of one supplier or the ones
 * that need an operator. Commerce owns the payouts and their read rule, and
 * the Worker registers the implementation (`worker-ports.ts`).
 */
export type SupplierPayoutReads = Readonly<{
  /** The label of the payout figures, or null when no grant admits them. */
  supplierPayoutLabel(
    input: Readonly<{
      db: OrganisationDatabase;
      organisationId: OrganisationId;
      /** The active grants that the reader's request authority selects. */
      grants: readonly AccessGrant[];
    }>,
  ): Promise<FlowLabel | null>;
  listSupplierPayoutsForSupplier(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    supplierId: string,
  ): Promise<readonly SupplierPayoutRow[]>;
  /** The payouts whose outcome is not yet known. */
  listUnresolvedSupplierPayouts(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
  ): Promise<readonly SupplierPayoutRow[]>;
}>;

export const supplierPayoutReads = definePort<SupplierPayoutReads>(
  "supplier_payout_reads",
);

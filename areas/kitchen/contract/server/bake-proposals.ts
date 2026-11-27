import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";

export type BakeProposalState =
  "waiting" | "open" | "approved" | "rejected" | "ended";

export type BakeDecidedVia = "portal" | "slack";
export type BakeDeciderRole = "owner" | "admin" | "operator";

/** One bake proposal of Plan 24 S1: a batch of one fresh product. */
export type BakeProposal = Readonly<{
  proposalId: string;
  inventoryItemId: string;
  productName: string;
  state: BakeProposalState;
  origin: "stock" | "agent";
  caseId: string;
  workflowId: string;
  workflowRevision: number;
  workflowDigest: string;
  quantityPieces: number;
  mouldGroups: number;
  piecesPerGroup: number;
  kitchenLocation: string;
  oven: Readonly<{ deviceId: string; name: string }> | null;
  stockLocationId: string | null;
  stockAvailable: number;
  stockLevel: number;
  proposedBy: string;
  proposedAt: number;
  openedAt: number | null;
  announcedAt: number | null;
  decision: Readonly<{
    by: string;
    role: BakeDeciderRole;
    via: BakeDecidedVia;
    at: number;
    reason: string | null;
  }> | null;
  endedAt: number | null;
  endReason: string | null;
}>;

/**
 * The bake proposal records that the Slack surface reads when it posts the
 * card of a proposal and the posts of its bake run, and the mark that the
 * proposal was announced. The Kitchen owns `bake_proposal`, and the Worker
 * registers the implementation (`worker-ports.ts`).
 */
export type BakeProposalRecords = Readonly<{
  readBakeProposal(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    proposalId: string,
  ): Promise<BakeProposal | null>;
  /** The Slack message of the proposal's card, or null before it went out. */
  readBakeProposalCardTs(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    proposalId: string,
  ): Promise<string | null>;
  /** Records the first announcement of a proposal, and its card's message. */
  markBakeProposalAnnounced(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    proposalId: string,
    at: number,
    cardTs: string | null,
  ): Promise<void>;
}>;

export const bakeProposalRecords = definePort<BakeProposalRecords>(
  "bake_proposal_records",
);

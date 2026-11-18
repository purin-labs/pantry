import type { OrganisationDatabase } from "../database-handles";
import {
  listEmailReplyProposalProjectionsForCase,
  listEmailReplyProposalProjections,
  readLatestEmailReplyProposalProjectionForCase,
  type EmailReplyProposalProjection,
} from "./email-mailbox";
import {
  listEmailOperationalProposalProjectionsForCase,
  listEmailOperationalProposalProjections,
  readLatestEmailOperationalProposalProjectionForCase,
  type EmailOperationalProposalProjection,
  type EmailProposalTarget,
} from "./email-operational";
import type { CaseId, OrganisationId } from "../ids";

type EmailReviewCommon = Readonly<{
  proposalId: string;
  integrationAccountId: string;
  caseId: string;
  version: number;
  lifecycleKind: string;
  createdAt: number;
  updatedAt: number;
}>;

export type EmailReviewProjection =
  | (EmailReviewCommon &
      Readonly<{
        kind: "gmail_reply";
        backing: Readonly<{
          kind: "gmail_draft";
          gmailThreadId: string;
        }>;
      }>)
  | (EmailReviewCommon &
      Readonly<{
        kind: "operational_new_message";
        backing: Readonly<{
          kind: "encrypted_connector";
          target: EmailProposalTarget;
          snapshotDigest: string;
          indeterminateRfcMessageId: string | null;
        }>;
      }>);

export async function listEmailReviewProjections(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly limit: number;
  }>,
): Promise<readonly EmailReviewProjection[]> {
  const [replies, operational] = await Promise.all([
    listEmailReplyProposalProjections(input),
    listEmailOperationalProposalProjections(input),
  ]);
  return [
    ...replies.map(emailReplyReviewProjection),
    ...operational.map(emailOperationalReviewProjection),
  ]
    .sort(newestReviewFirst)
    .slice(0, input.limit);
}

export async function readLatestEmailReviewProjectionForCase(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly caseId: CaseId;
  }>,
): Promise<EmailReviewProjection | null> {
  const [reply, operational] = await Promise.all([
    readLatestEmailReplyProposalProjectionForCase(input),
    readLatestEmailOperationalProposalProjectionForCase(input),
  ]);
  const reviews: EmailReviewProjection[] = [];
  if (reply !== null) reviews.push(emailReplyReviewProjection(reply));
  if (operational !== null) {
    reviews.push(emailOperationalReviewProjection(operational));
  }
  return reviews.sort(newestReviewFirst)[0] ?? null;
}

export async function listEmailReviewProjectionsForCase(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly caseId: CaseId;
    readonly limit: number;
  }>,
): Promise<readonly EmailReviewProjection[]> {
  const [replies, operational] = await Promise.all([
    listEmailReplyProposalProjectionsForCase(input),
    listEmailOperationalProposalProjectionsForCase(input),
  ]);
  return [
    ...replies.map(emailReplyReviewProjection),
    ...operational.map(emailOperationalReviewProjection),
  ]
    .sort(newestReviewFirst)
    .slice(0, input.limit);
}

function emailReplyReviewProjection(
  projection: EmailReplyProposalProjection,
): EmailReviewProjection {
  return {
    kind: "gmail_reply",
    proposalId: projection.proposalId,
    integrationAccountId: projection.integrationAccountId,
    caseId: projection.caseId,
    version: projection.currentVersion,
    lifecycleKind: projection.lifecycleKind,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    backing: {
      kind: "gmail_draft",
      gmailThreadId: projection.gmailThreadId,
    },
  };
}

function emailOperationalReviewProjection(
  projection: EmailOperationalProposalProjection,
): EmailReviewProjection {
  return {
    kind: "operational_new_message",
    proposalId: projection.proposalId,
    integrationAccountId: projection.integrationAccountId,
    caseId: projection.caseId,
    version: projection.currentVersion,
    lifecycleKind: projection.lifecycleKind,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    backing: {
      kind: "encrypted_connector",
      target: projection.target,
      snapshotDigest: projection.snapshotDigest,
      indeterminateRfcMessageId: projection.indeterminateRfcMessageId,
    },
  };
}

function newestReviewFirst(
  left: EmailReviewProjection,
  right: EmailReviewProjection,
): number {
  if (left.updatedAt !== right.updatedAt)
    return right.updatedAt - left.updatedAt;
  return left.proposalId.localeCompare(right.proposalId);
}

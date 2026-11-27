import type { OperationalEmailTarget } from "./verified-contacts";

/** The self-test mailbox target of an operational email proposal. */
export type EmailSelfTestTarget = Readonly<{
  kind: "self_test";
  selfTestId: string;
  customerId?: never;
  supplierId?: never;
  contactId?: never;
  contactRevision?: never;
  address?: never;
}>;

export type EmailProposalTarget = OperationalEmailTarget | EmailSelfTestTarget;

type EmailReviewCommon = Readonly<{
  proposalId: string;
  integrationAccountId: string;
  caseId: string;
  version: number;
  lifecycleKind: string;
  createdAt: number;
  updatedAt: number;
}>;

/** One email proposal that waits for a person's review, by its kind. */
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

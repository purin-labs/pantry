import type { MailInboxWork } from "@purin-labs/control-api";
import type { Variant } from "@purin-labs/type-utils";
import type { CaseId, OrganisationId } from "@purin-labs/kernel/ids";
import type { CaseResult } from "../case/types";
import type { CaseEmailProposal } from "./email-proposals";

/**
 * The RPC methods of the Inbox part of the Case. `CaseDO` implements them, and
 * a caller in another module names this interface. The method names and the
 * argument shapes are the RPC methods of the Case before step A1.9.
 */
export interface CaseInboxRpc {
  acceptEmailProposal(
    raw: unknown,
  ): Promise<CaseResult<{ readonly kind: "accepted" | "duplicate" }>>;
  transitionEmailProposal(
    raw: unknown,
  ): Promise<CaseResult<{ readonly kind: "transitioned" | "unchanged" }>>;
  readEmailProposals(): Promise<CaseResult<readonly CaseEmailProposal[]>>;
  readMailWork(
    input: Readonly<{
      organisationId: OrganisationId;
      caseId: CaseId;
      threadId: string;
    }>,
  ): Promise<CaseResult<Variant<MailInboxWork, "linked">>>;
}

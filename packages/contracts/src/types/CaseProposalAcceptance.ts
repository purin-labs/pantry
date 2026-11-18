import type { CaseOutput } from "./CaseOutput";
import type { SessionProposalDisposition } from "./SessionProposalDisposition";

export type CaseProposalAcceptance = {
  disposition: SessionProposalDisposition;
  outputs: Array<CaseOutput>;
};

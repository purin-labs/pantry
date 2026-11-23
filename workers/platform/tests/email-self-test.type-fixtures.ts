import type {
  EmailProposalTarget,
  OperationalEmailTarget,
} from "@purin-labs/area-inbox/server/data/email-operational";
import type { EmailSelfTestRequest } from "@purin-labs/area-inbox/server/data/email-self-test";

const selfTest: EmailProposalTarget = {
  kind: "self_test",
  selfTestId: "proposal_test",
};
// @ts-expect-error Self-tests cannot become canonical commerce contacts.
const contact: OperationalEmailTarget = selfTest;
const leaked: EmailProposalTarget = {
  ...selfTest,
  // @ts-expect-error The metadata target cannot contain a recipient address.
  address: "owner@example.com",
};
const request: EmailSelfTestRequest = {
  kind: "self_test",
  address: "owner@example.com",
  // @ts-expect-error A request cannot claim a persisted recipient reference.
  selfTestId: "proposal_test",
};
void contact;
void leaked;
void request;

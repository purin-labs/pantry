import type {
  CustomConnectorRevisionRecord,
  ParsedCustomConnectorDefinition,
} from "../src/custom-connectors";
import type { VariantBy } from "@seams/type-utils";

type DraftRevision = VariantBy<
  CustomConnectorRevisionRecord,
  "reviewState",
  "draft"
>;

declare const draft: DraftRevision;
declare const definition: ParsedCustomConnectorDefinition["definition"];

const draftWithApproval = {
  ...draft,
  approval: {
    origin: "https://api.example.com",
    effects: [],
    approvedByUserId: draft.createdByUserId,
    approvedAt: 1,
  },
};

// @ts-expect-error Draft revisions cannot carry approval evidence.
const invalidDraft: CustomConnectorRevisionRecord = draftWithApproval;

const spreadIntoValidated = {
  ...draft,
  reviewState: "validated" as const,
  definition,
};

// @ts-expect-error Validated revisions require their server-derived digest and time.
const invalidValidated: CustomConnectorRevisionRecord = spreadIntoValidated;

void invalidDraft;
void invalidValidated;

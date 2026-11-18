import type {
  CaseContextCollectionRelationshipDecision,
  CaseContextCollectionReviewCommand,
} from "@seams/control-api";
import type {
  ContactEndpoint,
  ContactVerificationCommand,
} from "../src/data/contact-verification";
import type {
  CaseContextCollectionRelationship,
  CaseContextCollectionScope,
} from "../src/case-context-discovery/relationships";
import type { Variant } from "@seams/type-utils";

declare const scope: CaseContextCollectionScope;
declare const attached: Variant<CaseContextCollectionRelationship, "attached">;
declare const verified: Variant<ContactVerificationCommand, "verify">;

// @ts-expect-error An CaseContextCollection always has one canonical party.
const missingParty: CaseContextCollectionScope = {
  organisationId: scope.organisationId,
  merchantId: scope.merchantId,
  issueKind: scope.issueKind,
  issueInstance: scope.issueInstance,
};

// @ts-expect-error A lifecycle spread cannot carry accepted metadata into a suggestion.
const suggested: CaseContextCollectionRelationship = {
  ...attached,
  kind: "suggested",
};

// @ts-expect-error Revocation carries no replacement identity or evidence.
const revoked: ContactVerificationCommand = { ...verified, kind: "revoke" };

// @ts-expect-error An email endpoint cannot also supply a WhatsApp recipient.
const mixedEndpoint: ContactEndpoint = {
  channel: "gmail",
  address: "sales@example.com",
  waId: "15551234567",
};

const incompleteConfirmation: CaseContextCollectionReviewCommand = {
  commandId: "confirm_relationship",
  expectedRevision: 1,
  // @ts-expect-error Confirmation always identifies one exact relationship.
  decision: { kind: "confirm" },
};

const overSpecifiedResolution: CaseContextCollectionReviewCommand = {
  commandId: "resolve_case_context_collection",
  expectedRevision: 1,
  // @ts-expect-error CaseContextCollection resolution never carries relationship identity.
  decision: { kind: "resolve", relationshipId: "relationship_one" },
};

declare const confirmation: CaseContextCollectionRelationshipDecision;

const spreadResolution: CaseContextCollectionReviewCommand = {
  commandId: "resolve_case_context_collection",
  expectedRevision: 1,
  // @ts-expect-error A relationship decision spread cannot become an CaseContextCollection resolution.
  decision: { ...confirmation, kind: "resolve" },
};

void missingParty;
void suggested;
void revoked;
void mixedEndpoint;
void incompleteConfirmation;
void overSpecifiedResolution;
void spreadResolution;

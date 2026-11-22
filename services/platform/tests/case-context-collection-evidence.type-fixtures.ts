import type {
  CaseEvidenceDependency,
  MailboxReplyScope,
} from "@purin-labs/contracts";
import type {
  CaseContextCollectionEvidenceDependency,
  CaseContextCollectionEffectFence,
  CaseContextCollectionEvidenceSelection,
} from "@purin-labs/agent/case-context-discovery/evidence";
import type { FlowRecipient } from "@purin-labs/authority/policy/information-flow/index";
import { EmailTurnInformationFlow } from "../src/actors/email-case-context-collection-evidence";

declare const dependency: Extract<
  CaseEvidenceDependency,
  { kind: "case_context_collection_evidence" }
>;
declare const recipient: Extract<FlowRecipient, { partyKind: "supplier" }>;
declare const committed: Extract<
  CaseContextCollectionEffectFence,
  { kind: "committed" }
>;

// @ts-expect-error Source-only context cannot carry CaseContextCollection identity.
const invalidDependency: CaseEvidenceDependency = {
  kind: "source_only",
  caseContextCollectionId: "case_context_collection_1",
};
// @ts-expect-error Spreading evidence cannot relabel it as source-only context.
const invalidSpread: CaseEvidenceDependency = {
  ...dependency,
  kind: "source_only",
};
// @ts-expect-error An CaseContextCollection authority partition requires both dependency digests.
const missingDigest: MailboxReplyScope = {
  kind: "case_context_collection_evidence",
  recipientDigest: "a",
};
// @ts-expect-error Source-only authority cannot carry a recipient digest.
const invalidScope: MailboxReplyScope = {
  kind: "source_only",
  recipientDigest: "a",
};
// @ts-expect-error Supplier identity requires supplier reply purpose.
const wrongPurpose: FlowRecipient = { ...recipient, purpose: "customer_reply" };
// @ts-expect-error Source-only core dependencies cannot carry selected evidence.
const invalidCore: CaseContextCollectionEvidenceDependency = {
  kind: "source_only",
  selections: [],
};
// @ts-expect-error A rejected fence cannot carry a committed timestamp or lifetime.
const invalidFence: CaseContextCollectionEffectFence = {
  ...committed,
  kind: "rejected",
  reason: "case_context_collection_evidence_stale",
};
// @ts-expect-error Only the fresh-flow builder may construct a turn flow.
const directFlow: EmailTurnInformationFlow = {};
declare const selectedSource: CaseContextCollectionEvidenceSelection["source"];
const unsupportedSource: CaseContextCollectionEvidenceSelection["source"] = {
  ...selectedSource,
  // @ts-expect-error The enabled CaseContextCollection reply path accepts Gmail evidence only.
  source: "whatsapp",
};

void [
  invalidDependency,
  invalidSpread,
  missingDigest,
  invalidScope,
  wrongPurpose,
  invalidCore,
  invalidFence,
  directFlow,
  unsupportedSource,
];

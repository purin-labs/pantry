import type {
  SerializedFlowBinding,
  SerializedFlowLabel,
  SerializedInformationFlowContext,
  SerializedObservationEvidence,
} from "@purin-labs/authority/policy/index";
import {
  FlowBinding,
  FlowLabel,
  InformationFlowContext,
  ObservationEvidence,
} from "@purin-labs/authority/policy/index";

// @ts-expect-error Flow labels require the validating async builder.
new FlowLabel([], "0".repeat(64));

// @ts-expect-error Information-flow contexts require the validating builder.
new InformationFlowContext({});

// @ts-expect-error Bindings can only be derived from a valid information-flow context.
new FlowBinding({});

function serializedShapesRemainPrecise(
  label: FlowLabel,
  evidence: ObservationEvidence,
  context: InformationFlowContext,
  binding: FlowBinding,
): void {
  const serializedLabel: SerializedFlowLabel = label.toJSON();
  const serializedEvidence: SerializedObservationEvidence = evidence.toJSON();
  const serializedContext: SerializedInformationFlowContext = context.toJSON();
  const serializedBinding: SerializedFlowBinding = binding.toJSON();
  void serializedLabel;
  void serializedEvidence;
  void serializedContext;
  void serializedBinding;
}

void serializedShapesRemainPrecise;

import type { AuthorizedContextRead } from "@purin-labs/agent/context/turn-context";
import type { NativeChatAudience } from "../src/chat/information-flow";
import type { DisclosureProof } from "../src/chat/disclosure-evidence";
import type { ContextAdmissionSubject } from "@purin-labs/authority/policy/information-flow/types";
import type {
  ChatDisclosureFailure,
  ProjectLayer,
  ProjectReferenceObservation,
} from "@purin-labs/control-api";
import type { RequestAuthority } from "@purin-labs/contracts";

function permitEscapeHatches(
  permit: AuthorizedContextRead,
  audience: NativeChatAudience,
  proof: DisclosureProof,
  authority: Extract<RequestAuthority, { kind: "control" }>,
  brief: Extract<ProjectLayer, { kind: "project" }>,
  reference: Extract<ProjectReferenceObservation, { kind: "available" }>,
): void {
  // @ts-expect-error Object spreading cannot retain the private admission brand.
  const copiedPermit: AuthorizedContextRead = { ...permit };
  // @ts-expect-error A plain object cannot create an audience permit.
  const copiedAudience: NativeChatAudience = { ...audience };
  // @ts-expect-error Successful disclosure proof construction belongs to the owning boundary.
  const copiedProof: DisclosureProof = { ...proof };
  // @ts-expect-error Native admission requires a live opaque audience.
  const missingAudience: ContextAdmissionSubject = {
    kind: "native_chat",
    requestAuthority: authority,
    caseId: "case_fixture",
  };
  // @ts-expect-error Authority-derived admission cannot carry native audience evidence.
  const mixedAudience: ContextAdmissionSubject = {
    kind: "authority_derived",
    requestAuthority: authority,
    caseId: "case_fixture",
    audience,
  };
  const { admission: briefAdmission, ...rawBrief } = brief;
  // @ts-expect-error A project revision or digest cannot replace original admission evidence.
  const missingBriefEvidence: ProjectLayer = rawBrief;
  const { admission: referenceAdmission, ...rawReference } = reference;
  // @ts-expect-error Available source metadata requires its original label and observation.
  const missingReferenceEvidence: ProjectReferenceObservation = rawReference;
  // @ts-expect-error Busy is a distinct protocol state, with its own reason.
  const mixedFailure: ChatDisclosureFailure = {
    kind: "rejected",
    code: "chat_running",
    reason: "source_policy_denied",
  };
  void copiedPermit;
  void copiedAudience;
  void copiedProof;
  void missingAudience;
  void mixedAudience;
  void briefAdmission;
  void referenceAdmission;
  void missingBriefEvidence;
  void missingReferenceEvidence;
  void mixedFailure;
}
void permitEscapeHatches;

// @ts-expect-error The admission permit is exported only as a type; its constructor is private.
new AuthorizedContextRead({});
// @ts-expect-error Native audiences require the live resolver.
new NativeChatAudience({});
// @ts-expect-error Disclosure proof construction is private to the disclosure boundary.
new DisclosureProof({});

function nativeIdentityEscapeHatches(
  organisationId: import("@purin-labs/kernel/ids").OrganisationId,
  projectId: import("@purin-labs/control-api").ProjectId,
  conversationId: import("@purin-labs/control-api").ConversationId,
): void {
  const raw: import("@purin-labs/authority/policy/information-flow/index").FlowAudience =
    {
      kind: "project",
      organisationId,
      // @ts-expect-error Canonical project IDs cannot be replaced by arbitrary text.
      projectId: "project_raw",
    };
  const swapped: import("@purin-labs/authority/policy/information-flow/index").FlowAudience =
    {
      kind: "project",
      organisationId,
      // @ts-expect-error Project and conversation identities belong to distinct domains.
      projectId: conversationId,
    };
  const swappedConversation: import("@purin-labs/authority/policy/information-flow/index").FlowAudience =
    {
      kind: "chat_conversation",
      organisationId,
      // @ts-expect-error Conversation audiences reject project IDs.
      conversationId: projectId,
    };
  void raw;
  void swapped;
  void swappedConversation;
}
void nativeIdentityEscapeHatches;

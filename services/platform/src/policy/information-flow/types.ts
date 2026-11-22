import type { RequestAuthority, ViolationAction } from "@purin-labs/contracts";

import type { ContextVisibility } from "../../authorization/access-grants/types";
import type { Variant } from "@purin-labs/type-utils";

/**
 * Who pays a Jev call: Purin, or the Organisation with its own TypeSafe key
 * (Plan 88). A Jev processing label names it.
 */
export type TypeSafeAuthority =
  | Readonly<{ kind: "pantry_platform"; connectionRevision?: never }>
  | Readonly<{ kind: "organisation_byo"; connectionRevision: number }>;

export type FlowPolicyOwner =
  | Readonly<{ readonly kind: "platform" }>
  | Readonly<{
      readonly kind: "recipient_constraint";
      readonly recipient: FlowRecipient;
      readonly organisationId: string;
    }>
  | Readonly<{ readonly kind: "organisation"; readonly organisationId: string }>
  | Readonly<{
      readonly kind: "integration_resource";
      readonly organisationId: string;
      readonly integrationAccountId: string;
      readonly resourceScope: string;
    }>;

export type FlowRecipient = Readonly<{
  organisationId: string;
  merchantId: string;
  integrationAccountId: string;
  partyId: string;
  contactId: string;
  contactRevision: number;
  verificationId: string;
  verificationRevision: number;
  endpointDigest: string;
}> &
  (
    | Readonly<{ partyKind: "supplier"; purpose: "supplier_reply" }>
    | Readonly<{ partyKind: "customer"; purpose: "customer_reply" }>
  );

/**
 * One clause of a label: who owns the data and who may read it. The
 * organisation's tool rules are not part of a label; each tool effect meets
 * the organisation's current rules (`organisation-authz.ts`).
 */
export type FlowPolicyInput = Readonly<{
  readonly owner: FlowPolicyOwner;
  readonly readers: readonly FlowAudience[];
  /**
   * The privacy level, when the source states it (Plan 27C). A policy with no
   * level gets one from its readers: see `policyLevel`.
   */
  readonly level?: FlowLevel;
}>;

/**
 * `private` content goes only to its readers. `internal` content goes to each
 * member of the Organisation and needs approval to go outside it. Content with
 * no policy is public.
 */
export type FlowLevel = "private" | "internal";

/**
 * Who wrote the content, when it was not a member or Pantry (Plan 89).
 * `outside` content holds free text of a person outside the Organisation: an
 * email, a customer message, a fetched page. It may hold an instruction that
 * no member gave, so an effect with a consequence asks a person first.
 */
export type FlowWriter = "outside";

export type CanonicalFlowPolicy = FlowPolicyInput;
export type FlowAudience = ContextVisibility | NativeChatFlowSource;

/**
 * Canonical JSON shapes persisted or carried across a runtime boundary.
 *
 * These types deliberately differ from the opaque runtime classes. A caller
 * can serialize a value without gaining a way to construct the corresponding
 * trusted object directly.
 */
export type SerializedFlowReader = FlowAudience;

export type SerializedFlowPolicy = Readonly<{
  readonly owner: FlowPolicyOwner;
  readonly readers: readonly SerializedFlowReader[];
  readonly level?: FlowLevel;
}>;

export type SerializedFlowLabel = Readonly<{
  readonly policies: readonly SerializedFlowPolicy[];
  readonly digest: string;
  /** Absent for a label that no outside person wrote into (Plan 89). */
  readonly writer?: FlowWriter;
}>;

type CaseEntryFlowSource = Readonly<{
  readonly kind: "case_entry";
  readonly caseId: string;
  readonly entryId: string;
}>;

export type IntegrationResourceFlowSource = Readonly<{
  readonly kind: "integration_resource";
  readonly organisationId: string;
  readonly integrationAccountId: string;
  readonly resourceScope: string;
}>;

export type NativeChatFlowSource =
  | Readonly<{
      kind: "project";
      organisationId: import("../../ids").OrganisationId;
      projectId: import("@purin-labs/control-api").ProjectId;
    }>
  | Readonly<{
      kind: "chat_conversation";
      organisationId: import("../../ids").OrganisationId;
      conversationId: import("@purin-labs/control-api").ConversationId;
    }>;

export type FlowSource =
  | NativeChatFlowSource
  | CaseEntryFlowSource
  | IntegrationResourceFlowSource
  | Readonly<{
      kind: "organisation_record";
      organisationId: string;
      recordId: string;
    }>
  | Readonly<{
      kind: "case_context_collection_evidence";
      organisationId: string;
      caseContextCollectionId: string;
      dependencyDigest: string;
    }>;

export type SerializedObservationEvidence = Readonly<{
  readonly source: FlowSource;
  readonly sourceRevision: number;
  readonly contentDigest: string;
  readonly flowLabelDigest: string;
  readonly observedAt: number;
  readonly evidenceDigest: string;
}>;

export type SerializedInformationFlowContext = Readonly<{
  readonly organisationId: string;
  readonly sessionId: string;
  readonly authorityPartitionDigest: string;
  readonly workLabel: SerializedFlowLabel;
  readonly observationDigests: readonly string[];
  readonly observationSetDigest: string;
  readonly revision: number;
  readonly digest: string;
}>;

export type SerializedFlowBinding = Readonly<{
  readonly organisationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly authorityPartitionDigest: string;
  readonly flowLabel: SerializedFlowLabel;
  readonly informationFlowContextDigest: string;
  readonly observationSetDigest: string;
  readonly contextRevision: number;
}>;

export type ContextAdmissionSubject =
  | Readonly<{
      kind: "native_chat";
      requestAuthority: import("@purin-labs/type-utils").Variant<
        RequestAuthority,
        "control"
      >;
      caseId: string;
      audience: import("./native-audience").NativeChatAudience;
    }>
  | Readonly<{
      kind: "authority_derived";
      audience?: never;
      readonly requestAuthority: RequestAuthority;
      readonly caseId: string;
    }>;

export type ContextAdmissionDecision =
  | Readonly<{
      readonly kind: "admit";
      readonly inputLabelDigest: string;
      readonly authorityDigest: string;
    }>
  | Readonly<{
      readonly kind: "deny";
      readonly inputLabelDigest: string;
      readonly authorityDigest: string;
      readonly reason: "audience_not_permitted";
    }>;

export type FlowDecisionReason = Readonly<{
  readonly code: "audience_not_permitted" | "flow_rule" | "outside_written";
  readonly ruleId: string | null;
  readonly reasonCode: string;
}>;

export type ConversationDeliverySink = Readonly<{
  readonly kind: "conversation_delivery";
  readonly destinationAuthority: Variant<
    RequestAuthority,
    "direct_conversation" | "shared_conversation" | "workflow" | "control"
  >;
  /**
   * The conversation also has people of another company: a Slack Connect
   * channel. A caller that delivers to a Slack channel reads this with
   * `slackConversationReachesOutside`.
   */
  readonly reachesOutside?: true;
}>;

export type ToolEffectSink = Readonly<{
  readonly kind: "tool_effect";
  readonly destinationAuthority: RequestAuthority;
  readonly capabilityId: string;
  readonly integrationAccountId: string;
  readonly resourceScope: string;
  readonly approvalSatisfied: boolean;
  /**
   * The effect writes to a record that every member of the Organisation reads,
   * such as a shared draft. The person who acts is not its audience, so what
   * only they may read stops here and asks. `sharedWith` names what an owner or
   * admin shared with the record.
   */
  readonly readByEveryMember?: Readonly<{
    sharedWith: readonly FlowAudience[];
  }>;
  /**
   * The one verified recipient this effect discloses to, when it has one.
   * A label bound to a recipient passes only an effect that names that exact
   * recipient. An effect that names none passes no such label.
   */
  readonly recipient?: FlowRecipient;
}>;

export type TypeSafeInferenceSink = Readonly<{
  kind: "typesafe_system_one";
  organisationId: string;
  purpose:
    | "case_context_discovery_relationship"
    | "mail_classification"
    | "screen_relevance";
  /** Who funds the call: Pantry's key or the Organisation's own key (Plan 88). */
  funding: TypeSafeAuthority;
  model: "jev-1.13.0";
  processing:
    | Readonly<{
        kind: "public_fixture";
        fixtureRevision: number;
        authority?: never;
      }>
    | Readonly<{
        kind: "authorized_source";
        authority: RequestAuthority;
        fixtureRevision?: never;
      }>;
}>;

export type FlowSink =
  | Readonly<{
      kind: "native_chat";
      audience: import("./native-audience").NativeChatAudience;
      sink: ConversationDeliverySink | ToolEffectSink;
    }>
  | ConversationDeliverySink
  | ToolEffectSink
  | TypeSafeInferenceSink;

export type FlowDecision =
  | Readonly<{
      readonly kind: "allow";
      readonly flowBindingDigest: string;
      readonly decisionDigest: string;
    }>
  | Readonly<{
      readonly kind: "approval_required";
      readonly flowBindingDigest: string;
      readonly decisionDigest: string;
      readonly reason: FlowDecisionReason;
    }>
  | Readonly<{
      readonly kind: "deny";
      readonly flowBindingDigest: string;
      readonly decisionDigest: string;
      readonly reason: FlowDecisionReason;
      readonly violationAction: ViolationAction;
    }>;

export type FlowLabelDecision =
  | Readonly<{ readonly kind: "allow" }>
  | Readonly<{
      readonly kind: "approval_required";
      readonly reason: FlowDecisionReason;
    }>
  | Readonly<{
      readonly kind: "deny";
      readonly reason: FlowDecisionReason;
      readonly violationAction: ViolationAction;
    }>;

export type FlowLabelError =
  | Readonly<{ readonly code: "invalid_flow_policy"; readonly field: string }>
  | Readonly<{ readonly code: "invalid_flow_label"; readonly field: string }>
  | Readonly<{ readonly code: "flow_label_digest_mismatch" }>;

export type CurrentSourceFlowLabelError =
  | FlowLabelError
  | Readonly<{ readonly code: "source_policy_invalid"; readonly field: string }>
  | Readonly<{
      readonly code: "source_policy_unavailable";
      readonly detail: string;
    }>
  | Readonly<{
      readonly code: "source_subject_inactive";
      readonly subject: string;
    }>
  | Readonly<{
      readonly code: "source_resource_inactive";
      readonly integrationAccountId: string;
    }>
  | Readonly<{
      readonly code: "source_capability_disabled";
      readonly capabilityId: string;
    }>
  | Readonly<{
      readonly code: "source_grant_unavailable";
      readonly grantId: string;
    }>;

export type ObservationEvidenceError =
  | Readonly<{
      readonly code: "invalid_observation_evidence";
      readonly field: string;
    }>
  | Readonly<{ readonly code: "observation_evidence_digest_mismatch" }>;

export type InformationFlowContextError =
  | Readonly<{
      readonly code: "invalid_information_flow_context";
      readonly field: string;
    }>
  | Readonly<{ readonly code: "information_flow_context_digest_mismatch" }>
  | Readonly<{ readonly code: "observation_label_mismatch" }>;

export type FlowBindingError =
  | Readonly<{ readonly code: "invalid_flow_binding"; readonly field: string }>
  | Readonly<{ readonly code: "flow_binding_digest_mismatch" }>;

export type AdvanceInformationFlowContextResult =
  | Readonly<{ readonly kind: "advanced"; readonly contextRevision: number }>
  | Readonly<{ readonly kind: "duplicate"; readonly contextRevision: number }>;

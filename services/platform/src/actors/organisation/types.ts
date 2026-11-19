import type {
  CommerceAggregationResult,
  CommerceQueryPlanErrorCapability,
  CommerceReadWatermark,
  SystemCommerceEntityRef,
} from "@seams/contracts";
import type {
  IntegrationAccountId,
  RequestId,
  OrganisationId,
} from "../../ids";
import type {
  OrganisationPolicyPlacement,
  OrganisationPolicySnapshot,
} from "../../policy-snapshot";
import type {
  ApplyCommerceDeliveryInput,
  CommerceProjectionRecord,
  CommerceSystemStorageAuthority,
} from "../commerce-projection";
import type { CommerceEntityRelationRow } from "../commerce-query-schema";
import type { CodeModeBudgetError } from "../code-mode-budget";
import type {
  CommerceBoardDragPreview,
  CommerceBoardPresenceSelection,
} from "@seams/control-api";

export type OrganisationPing = {
  ok: true;
  kind: "organisation";
};

export type OnboardingActivationError =
  | { readonly code: "organisation_placement_conflict" }
  | { readonly code: "activation_readiness_stale"; readonly detail: string }
  | { readonly code: "activation_state_invalid" }
  | { readonly code: "activation_attempt_corrupt" }
  | { readonly code: "activation_attempt_in_progress" }
  | ActivationExecutionFailure;

export type ActivationExecutionFailure = {
  readonly code:
    | "activation_interrupted"
    | "activation_policy_failed"
    | "activation_cues_failed"
    | "activation_publish_failed";
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly supportReference: string;
};

export type OrganisationPlan = "beta";

export type OrganisationStatus = "active" | "suspended" | "deleted" | "purged";

export type CafeCommerceAcceptanceFaultRecord = Readonly<{
  schemaVersion: 1;
  requestId: RequestId;
  merchantId: string;
  armedAt: number;
  queueConsumedAt: number | null;
}>;

export type CafeCommerceAcceptanceFaultConsumption =
  | Readonly<{ kind: "inactive" }>
  | Readonly<{
      kind: "consumed";
      fault: CafeCommerceAcceptanceFaultRecord;
    }>;

export type OrganisationMetaInput = {
  organisationId: OrganisationId;
  name: string;
  plan: OrganisationPlan;
  status: OrganisationStatus;
  createdAt: number;
};

export type OrganisationMeta = OrganisationMetaInput;

export type OrganisationMetaRequest = {
  requestingOrganisationId: OrganisationId;
};

export type OrganisationApplyCommerceDeliveryInput =
  ApplyCommerceDeliveryInput & {
    readonly commerceSystem: CommerceSystemStorageAuthority;
  };

export type OrganisationStateError =
  | { code: "organisation_not_initialized" }
  | { code: "organisation_mismatch" }
  | {
      code: "organisation_capacity_exceeded";
      activeSessions: number;
      maxConcurrentSessions: number;
    }
  | { code: "invalid_policy_snapshot" }
  | {
      code: "policy_version_stale";
      activeVersion: number;
      receivedVersion: number;
    }
  | { code: "policy_version_conflict"; version: number };

export type CommerceQueryPlanReadError =
  | {
      readonly code: "commerce_query_plan_unsupported";
      readonly capability: CommerceQueryPlanErrorCapability;
    }
  | { readonly code: "commerce_query_plan_invalid" }
  | {
      readonly code: "commerce_query_plan_stale";
      readonly expected: CommerceReadWatermark;
      readonly received: CommerceReadWatermark;
    }
  | { readonly code: "commerce_query_relation_corrupt" };

export type ReadCommerceQueryPlanInput = Readonly<{
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly planRequest: unknown;
  readonly plan: unknown;
}>;

export type ReadCommerceQueryPlanValue =
  | Readonly<{
      readonly kind: "rows";
      readonly rows: readonly CommerceEntityRelationRow[];
      readonly records: readonly CommerceProjectionRecord[];
      readonly hasMore: boolean;
    }>
  | Readonly<{
      readonly kind: "count";
      readonly aggregation: CommerceAggregationResult;
    }>;

export type ReadCommerceRelationshipStepInput = Readonly<{
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly planRequest: unknown;
  readonly plan: unknown;
  readonly frontier: readonly SystemCommerceEntityRef[];
  readonly remaining: number;
}>;

export type OrganisationCutoverCueSettlementInput = {
  readonly organisationId: OrganisationId;
  readonly settledAt: number;
};

export type OrganisationCutoverCueSettlementError = {
  readonly code: "organisation_cutover_cue_mismatch";
};

export type CodeModeOrganisationActorError =
  | CodeModeBudgetError
  | { readonly code: "organisation_not_initialized" }
  | { readonly code: "organisation_mismatch" }
  | {
      readonly code: "organisation_not_active";
      readonly status: OrganisationStatus;
    };

export type OrganisationPolicyHead = {
  activeVersion: number;
  restrictionVersion: number;
  digest: string;
  activatedAt: number;
};

export type OrganisationActivatePolicyInput = {
  placement: OrganisationPolicyPlacement;
  requestId: RequestId;
  organisationId: OrganisationId;
  snapshot: OrganisationPolicySnapshot;
  activatedAt: number;
};

export type OrganisationPolicyActivationError =
  OrganisationStateError | { readonly code: "policy_placement_conflict" };

export type OrganisationPolicyActivation = {
  head: OrganisationPolicyHead;
  consumers: number;
  delivered: number;
  pending: number;
};

export type OrganisationMetaRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  name: string;
  plan: OrganisationPlan;
  status: OrganisationStatus;
  created_at: number;
};

export type OrganisationPolicyHeadRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  active_version: number;
  restriction_version: number;
  digest: string;
  body: string;
  activated_at: number;
};

export type CommerceBoardPresenceUpdate = Readonly<{
  organisationId: OrganisationId;
  userId: string;
  displayName: string;
  resourceKey: string;
  selection: CommerceBoardPresenceSelection;
  dragPreview: CommerceBoardDragPreview;
  now: number;
}>;

export type CommerceBoardPresenceRead = Readonly<{
  organisationId: OrganisationId;
  resourceKey: string;
  now: number;
}>;

// The types of the commerce methods of the Organisation actor.
import type {
  CommerceAggregationResult,
  CommerceQueryPlanErrorCapability,
  CommerceReadWatermark,
  SystemCommerceEntityRef,
} from "@purin-labs/commerce-contracts";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { CafeCommerceAcceptanceFaultRecord } from "../../contract/types";
import type { CommerceProjectionRecord } from "../commerce-projection";
import type {
  ApplyCommerceDeliveryInput,
  CommerceSystemStorageAuthority,
} from "../../contract/commerce-projection";
import type { CommerceEntityRelationRow } from "../commerce-query-schema";
import type {
  CommerceBoardDragPreview,
  CommerceBoardPresenceSelection,
} from "@purin-labs/commerce-control-api";

export type CafeCommerceAcceptanceFaultConsumption =
  | Readonly<{ kind: "inactive" }>
  | Readonly<{
      kind: "consumed";
      fault: CafeCommerceAcceptanceFaultRecord;
    }>;

export type OrganisationApplyCommerceDeliveryInput =
  ApplyCommerceDeliveryInput & {
    readonly commerceSystem: CommerceSystemStorageAuthority;
  };

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

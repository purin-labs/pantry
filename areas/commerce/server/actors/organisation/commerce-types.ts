// The types of the commerce methods of the Organisation actor.
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { CafeCommerceAcceptanceFaultRecord } from "@purin-labs/area-commerce-contract/server/types";
import type {
  ApplyCommerceDeliveryInput,
  CommerceSystemStorageAuthority,
} from "@purin-labs/area-commerce-contract/server/commerce-projection";
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

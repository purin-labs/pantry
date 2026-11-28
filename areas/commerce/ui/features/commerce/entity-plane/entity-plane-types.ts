import React from "react";
import type { ProductDescriptionActionTransport } from "@purin-labs/area-commerce-contract/ui/features/commerce/description-draft/action";
import type { OfferPriceAllowanceInteraction } from "@purin-labs/area-commerce-contract/ui/features/commerce/price-allowance-transport";
import type {
  AttributeDefinitionId,
  CommerceEntity,
  CommerceFreshness,
  CommerceGraphQueryResult,
  CommerceListEntryRevision,
  CommerceSnapshotRevision,
  CommerceViewPresentation,
  SourceProvenance,
} from "@purin-labs/commerce-contracts";
import type { CommercePublishedCollectionModel } from "./models";
import type {
  CommerceGraphFetch,
  CommerceMutationTransport,
  CommercePresenceTransport,
  CommerceCollectionSelection,
  CommercePublishedResourceMetadata,
} from "@purin-labs/area-commerce-contract/ui/features/commerce/entity-plane/api";
import type { CommerceListEntryPatchApprovalAction } from "@purin-labs/commerce-control-api/portal/entity-plane";
import type { CommerceOperationsTransport } from "@purin-labs/area-commerce-contract/ui/features/commerce/operations";
import type { CommerceActionRecord } from "@purin-labs/commerce-control-api/portal/commerce-actions";
import type { CommerceActivityRouteState } from "./activity-panel";
import type { PermissionRequired } from "@purin-labs/control-api";
import type { CommerceGraphPage } from "./route";

export type CommerceEntityPlaneRouteProps = Readonly<{
  organisationId: string;
  page: CommerceGraphPage;
  resourceId: string | null;
  resourceHref: (
    resourceId: string,
    kind: "product" | "order" | "supplier",
  ) => string;
  /**
   * Opens the page's collection again. `search` is the query without its "?"
   * that opens the tab where the record is listed, such as
   * "tab=supplier_directory", or "".
   */
  onBack: (search: string) => void;
  fetcher?: CommerceGraphFetch;
  mutate?: CommerceMutationTransport;
  presence?: CommercePresenceTransport;
  commerceOperations?: CommerceOperationsTransport;
  descriptionDraftActions?: ProductDescriptionActionTransport;
  onActionProposed?: (action: CommerceActionRecord) => void;
  actionBusy?: boolean;
  canOperate?: boolean;
  canManage?: boolean;
  /**
   * How the price-allowance section reads and writes.
   *
   * Absent when the surface has no way to write one, which keeps the section
   * out of a page that could only show it broken.
   */
  priceAllowances?: OfferPriceAllowanceInteraction;
  /**
   * The supplier payouts, as a tab beside the views of the Purchasing page.
   * The panel reports whether this person may read them, and how many wait on
   * someone, for the tab and its mark.
   */
  payouts?: (report: (status: CommercePayoutsTabStatus) => void) => React.ReactNode;
}>;

export type CommercePayoutsTabStatus = Readonly<{
  readable: boolean;
  attention: number;
}>;

export type CommerceGraphRouteState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unauthorized" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{
      kind: "overview";
      page: "suppliers";
      freshness: readonly CommerceFreshness[];
      merchantRevision: CommerceSnapshotRevision | null;
      metadata: CommercePublishedResourceMetadata;
      collection: CommerceCollectionRouteState;
      collectionSelection: CommerceCollectionSelection | null;
    }>
  | Readonly<{
      kind: "table";
      page: Exclude<CommerceGraphPage, "suppliers">;
      queryText: string;
      result: CommerceGraphQueryResult;
      loadingMore: boolean;
    }>
  | Readonly<{
      kind: "dossier";
      page: "products" | "orders" | "suppliers";
      result: CommerceGraphQueryResult;
      activity: CommerceActivityRouteState;
      refresh:
        | Readonly<{ kind: "ready" }>
        | Readonly<{ kind: "failed"; message: string }>;
    }>;

export type CommerceGraphRequestRevision = { current: number };
export type CommerceChangeWatch = {
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};
export type CommerceRefreshRevisionSetter = React.Dispatch<
  React.SetStateAction<number>
>;
export type CommerceCollectionRouteState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unselected" }>
  | Readonly<{
      kind: "ready";
      model: CommercePublishedCollectionModel;
      names: ReadonlyMap<string, string>;
    }>
  | Readonly<{ kind: "failed"; message: string }>;

export type CommerceBoardMoveIntent =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "saved"; label: string; desiredStatusLabel: string }>
  | Readonly<{
      kind: "dragging";
      entryId: string;
      listId: string;
      entryRevision: CommerceListEntryRevision;
      merchantRevision: CommerceSnapshotRevision;
      desiredStatus: null;
      desiredStatusLabel: null;
      label: string;
    }>
  | Readonly<{
      kind: "saving";
      entryId: string;
      listId: string;
      entryRevision: CommerceListEntryRevision;
      merchantRevision: CommerceSnapshotRevision;
      statusAttributeId: AttributeDefinitionId;
      desiredStatus: string;
      desiredStatusLabel: string;
      label: string;
    }>
  | Readonly<{
      kind: "approval_requested";
      entryId: string;
      listId: string;
      entryRevision: CommerceListEntryRevision;
      merchantRevision: CommerceSnapshotRevision;
      statusAttributeId: AttributeDefinitionId;
      desiredStatus: string;
      desiredStatusLabel: string;
      label: string;
      action: CommerceListEntryPatchApprovalAction;
    }>
  | Readonly<{
      kind: "stale";
      entryId: string;
      listId: string;
      entryRevision: CommerceListEntryRevision;
      merchantRevision: CommerceSnapshotRevision;
      statusAttributeId: AttributeDefinitionId;
      desiredStatus: string;
      desiredStatusLabel: string;
      label: string;
    }>
  | Readonly<{
      kind: "failed";
      entryId: string;
      listId: string;
      entryRevision: CommerceListEntryRevision;
      merchantRevision: CommerceSnapshotRevision;
      statusAttributeId: AttributeDefinitionId;
      desiredStatus: string;
      desiredStatusLabel: string;
      label: string;
      message: string;
      /** The permission that the refusal named; the prompt offers it. */
      permission?: PermissionRequired | null;
    }>;

export type CommerceBoardInteraction = Readonly<{
  organisationId: string;
  canOperate: boolean;
  canAdminister: boolean;
  mutate: CommerceMutationTransport | undefined;
  presence: CommercePresenceTransport | undefined;
  fetcher: CommerceGraphFetch | undefined;
  /** Display names for identifiers a list entry stores as plain text. */
  names: ReadonlyMap<string, string>;
  intent: CommerceBoardMoveIntent;
  setIntent: React.Dispatch<React.SetStateAction<CommerceBoardMoveIntent>>;
  refresh: CommerceRefreshRevisionSetter;
}>;

export type CommerceSavedViewEditEvidence = Readonly<{
  viewId: string;
  viewRevision: number;
  merchantRevision: CommerceSnapshotRevision;
  presentation: CommerceViewPresentation;
}>;

export type CommerceSavedViewEditIntent =
  | Readonly<{ kind: "idle" }>
  | (CommerceSavedViewEditEvidence & Readonly<{ kind: "saving" }>)
  | (CommerceSavedViewEditEvidence & Readonly<{ kind: "stale" }>)
  | (CommerceSavedViewEditEvidence &
      Readonly<{
        kind: "failed";
        message: string;
        /** The permission that the refusal named; the prompt offers it. */
        permission?: PermissionRequired | null;
      }>);

export type CommerceSavedViewEditorProps = Readonly<{
  model: CommercePublishedCollectionModel;
  interaction: CommerceBoardInteraction;
}>;

export type OrderCancellationControlState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "submitting" }>
  | Readonly<{ kind: "submitted" }>
  | Readonly<{
      kind: "failed";
      message: string;
      /** The permission that the refusal named, and the form to send again. */
      permission: Readonly<{
        required: PermissionRequired;
        formData: FormData;
      }> | null;
    }>;

export type CancellableOrderEntity = CommerceEntity &
  Readonly<{
    reference: Readonly<{
      origin: "system";
      typeId: "order";
      entityId: string;
    }>;
    provenance: SourceProvenance;
  }>;

import { OrdersDisplay } from "../../orders/order-time-lanes";
import { Select } from "@purin-labs/ui/select";
import { COMMERCE_CANCELLATION_REASONS, COMMERCE_CANCELLATION_REFUNDS, COMMERCE_TABLE_DENSITIES, commerceOptionItem, renderCommerceSelectParts, type CommerceSelectItem } from "./select-items";
import React from "react";
import {
  ArrowLeft,
  ChevronRight,
  Package,
  Search,
  ShoppingCart,
} from "lucide-react";
import { workspacePageDescriptor } from "@purin-labs/ui/route";
import "./record.css";
import "./collection.css";
import { ProductDescriptionDraftControl } from "../description-draft/control";
import { ProductSaleDetails } from "./product-sale-details";
import type { ProductDescriptionActionTransport } from "@purin-labs/area-commerce-contract/ui/features/commerce/description-draft/action";
import { OfferPriceAllowanceSection } from "../price-allowance";
import type { OfferPriceAllowanceInteraction } from "@purin-labs/area-commerce-contract/ui/features/commerce/price-allowance-transport";
import { Link } from "react-router";
import { toast } from "sonner";
import type {
  AttributeDefinitionId,
  CommerceEntity,
  CommerceEntityRef,
  CommerceFreshness,
  CommerceGraphQueryResult,
  CommerceListEntry,
  CommerceListEntryRevision,
  CommerceListId,
  SavedCommerceViewId,
  CommerceRelationship,
  CommerceSnapshotRevision,
  CommerceTableDensity,
  CommerceViewPresentation,
  ListEntryAttributeDefinition,
  SourceProvenance,
} from "@purin-labs/commerce-contracts";
import {
  REPLENISHMENT_QUEUE_LIST_ID,
  REPLENISHMENT_QUEUE_VIEW_ID,
  SUPPLIER_DIRECTORY_LIST_ID,
  SUPPLIER_ENTITY_TYPE_ID,
  SUPPLIERS_VIEW_ID,
} from "@purin-labs/commerce-client";

import { ControlApiError } from "@purin-labs/control/portal/control-client";
import {
  PermissionRequiredPrompt,
  permissionRequiredOf,
} from "@purin-labs/area-organisation-contract/ui/features/access/permission-required-prompt";
import { cancelDialog, DialogHeading, syncDialog } from "@purin-labs/ui/dialog";
import {
  EmptyState,
  Notice,
  PageSkeleton,
  RecoverableError,
  StatusChip,
} from "@purin-labs/ui/page-components";
import {
  COMMERCE_VALUE_ABSENT,
  commerceAttributeLabel,
  commerceEntityTypeLabel,
  commerceRelationshipLabel,
  commerceSourceLabel,
  commerceRecordLabel,
  commerceStatusChip,
  formatCommerceAttributeValue,
  formatCommerceTimestamp,
  isNumericCommerceValue,
} from "./presentation";
import {
  buildCommerceEntityDossierModel,
  buildPublishedCommerceCollectionModel,
  buildEntityTypeTableModel,
  findCommerceCollectionDefinition,
  type CommerceCollectionRow,
  type CommercePublishedCollectionModel,
  type CommerceEntityDossierModel,
} from "./models";
import { commerceCollectionQuery, customEntityRef, entityDossierQuery, entityTypePageQuery, readCommerceGraph, readCommerceChanges, searchEntityTypeQuery, systemEntityRef, readCommerceActivity, readPublishedCommerceResources, patchCommerceListEntryStatus, publishCommerceSavedViewPresentation, updateCommerceBoardPresence, type CommerceGraphFetch, type CommerceMutationTransport, type CommercePresenceTransport, type CommerceCollectionSelection, type CommercePublishedResourceMetadata } from "@purin-labs/area-commerce-contract/ui/features/commerce/entity-plane/api";
import type { CommerceListEntryPatchApprovalAction } from "@purin-labs/commerce-control-api/portal/entity-plane";
import {
  PurchaseRequestDrawer,
  PurchasingControls,
  purchaseRequestRowSummary,
} from "./purchasing-controls";
import {
  CommerceBoardEntryDrawer,
  CommerceBoardList,
  type CommerceBoardListFact,
  type CommerceBoardListRow,
} from "./board-list";
import {
  boardRowSummary,
  commerceBoardFact,
  commerceBoardFactText,
  commerceBoardLaneChip,
  commerceBoardLaneOptions,
  commerceBoardListLane,
  findListEntryDefinition,
  listAttributeDefinition,
  renderCommerceBoardLaneOption,
  resolveCommerceReferenceName,
  type CommerceBoardLaneOption,
} from "./board-rows";
import {
  NO_SUPPLIER_NAMES,
  SupplierRecordDetails,
  isSupplierDirectoryList,
  loadSupplierNames,
} from "./supplier-directory";
import type {
  CommerceOperationsTransport,
  OrderCancellationAction,
} from "@purin-labs/area-commerce-contract/ui/features/commerce/operations";
import { parseCommerceActionRecordResponse, type CommerceActionRecord } from "@purin-labs/commerce-control-api/portal/commerce-actions";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import { useDossierSurface } from "./dossier-surface";
import {
  commerceEntityAttributeColumn,
  entityTableAttributeIds,
  findEntityAttribute,
} from "./entity-attribute-columns";
import {
  CommerceActivityPanel,
  type CommerceActivityRouteState,
} from "./activity-panel";
import { CrmIdentity, CrmTable, type CrmColumn } from "@purin-labs/ui/index";
import type { CommerceBoardDragPreview, CommerceBoardPresenceEntry, CommerceBoardPresenceSelection } from "@purin-labs/commerce-control-api";
import type { PermissionRequired } from "@purin-labs/control-api";

type CommerceGraphPage = "products" | "orders" | "suppliers";

type CommerceEntityPlaneRouteProps = Readonly<{
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

type CommercePayoutsTabStatus = Readonly<{
  readable: boolean;
  attention: number;
}>;

type CommerceGraphRouteState =
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

type CommerceGraphRequestRevision = { current: number };
type CommerceChangeWatch = {
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};
type CommerceRefreshRevisionSetter = React.Dispatch<
  React.SetStateAction<number>
>;
type CommerceCollectionRouteState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unselected" }>
  | Readonly<{
      kind: "ready";
      model: CommercePublishedCollectionModel;
      names: ReadonlyMap<string, string>;
    }>
  | Readonly<{ kind: "failed"; message: string }>;

type CommerceBoardMoveIntent =
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

type CommerceBoardInteraction = Readonly<{
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

export function CommerceEntityPlaneRoute(
  props: CommerceEntityPlaneRouteProps,
): React.ReactNode {
  const [state, setState] = React.useState<CommerceGraphRouteState>({
    kind: "loading",
  });
  const [queryText, setQueryText] = React.useState("");
  const [collectionSelection, setCollectionSelection] =
    React.useState<CommerceCollectionSelection | null>(null);
  const [refreshRevision, setRefreshRevision] = React.useState(0);
  const [boardMoveIntent, setBoardMoveIntent] =
    React.useState<CommerceBoardMoveIntent>({ kind: "idle" });
  const requestRevision = React.useRef<CommerceGraphRequestRevision>({
    current: 0,
  });

  React.useEffect(resetCommerceEntityPlaneRoute.bind(null, setState), [
    props.organisationId,
    props.page,
    props.resourceId,
    props.fetcher,
    queryText,
    collectionSelection,
  ]);
  React.useEffect(
    loadCommerceEntityPlaneRouteEffect.bind(
      null,
      props,
      queryText,
      collectionSelection,
      requestRevision,
      setState,
    ),
    [
      props.organisationId,
      props.page,
      props.resourceId,
      props.fetcher,
      queryText,
      collectionSelection,
      refreshRevision,
    ],
  );
  React.useEffect(
    watchCommerceChangesEffect.bind(
      null,
      props,
      commerceGraphStateMerchantRevision(state),
      setRefreshRevision,
    ),
    [props.organisationId, props.fetcher, state],
  );

  return renderCommerceGraphRoute(
    props,
    state,
    queryText,
    setQueryText,
    setCollectionSelection,
    requestRevision,
    setState,
    boardMoveIntent,
    setBoardMoveIntent,
    setRefreshRevision,
  );
}

function resetCommerceEntityPlaneRoute(
  setState: React.Dispatch<React.SetStateAction<CommerceGraphRouteState>>,
): void {
  setState({ kind: "loading" });
}

function loadCommerceEntityPlaneRouteEffect(
  props: CommerceEntityPlaneRouteProps,
  queryText: string,
  collectionSelection: CommerceCollectionSelection | null,
  requestRevision: React.MutableRefObject<CommerceGraphRequestRevision>,
  setState: React.Dispatch<React.SetStateAction<CommerceGraphRouteState>>,
): () => void {
  const revision = ++requestRevision.current.current;
  setState({ kind: "loading" });
  void loadCommerceEntityPlaneRoute(
    props,
    queryText,
    collectionSelection,
    revision,
    requestRevision,
    setState,
  );
  return invalidateCommerceEntityPlaneRequest.bind(
    null,
    requestRevision,
    revision,
  );
}

async function loadCommerceEntityPlaneRoute(
  props: CommerceEntityPlaneRouteProps,
  queryText: string,
  collectionSelection: CommerceCollectionSelection | null,
  revision: number,
  requestRevision: React.MutableRefObject<CommerceGraphRequestRevision>,
  setState: React.Dispatch<React.SetStateAction<CommerceGraphRouteState>>,
): Promise<void> {
  try {
    if (props.page === "suppliers" && props.resourceId === null) {
      const metadata = purchasingMetadata(
        await readPublishedCommerceResources(
          props.organisationId,
          props.fetcher,
        ),
      );
      const selectedCollection = selectedCommerceCollection(
        metadata,
        collectionSelection,
      );
      const collection =
        selectedCollection === null
          ? { kind: "unselected" as const }
          : await loadCommerceCollection(
              props.organisationId,
              selectedCollection,
              metadata,
              props.fetcher,
            );
      if (isCurrentCommerceEntityPlaneRequest(requestRevision, revision)) {
        setState({
          kind: "overview",
          page: props.page,
          freshness: [],
          merchantRevision: metadata.merchantRevision,
          metadata,
          collection,
          collectionSelection: selectedCollection,
        });
      }
      return;
    }
    if (
      props.resourceId !== null &&
      (props.page === "products" ||
        props.page === "orders" ||
        props.page === "suppliers")
    ) {
      const reference =
        props.page === "suppliers"
          ? customEntityRef(SUPPLIER_ENTITY_TYPE_ID, props.resourceId)
          : systemEntityRef(
              props.page === "products" ? "product" : "order",
              props.resourceId,
            );
      const [entityResult, activity] = await Promise.all([
        readCommerceGraph(
          props.organisationId,
          entityDossierQuery(reference),
          props.fetcher,
        ),
        readCommerceDossierActivity(
          props.organisationId,
          reference,
          props.fetcher,
        ),
      ]);
      if (!isCurrentCommerceEntityPlaneRequest(requestRevision, revision))
        return;
      setState({
        kind: "dossier",
        page: props.page,
        result: entityResult,
        activity,
        refresh: { kind: "ready" },
      });
      return;
    }
    if (props.page === "suppliers")
      throw new Error("Supplier route did not resolve a page state.");
    const typeId = pageEntityType(props.page);
    const query =
      queryText.trim().length === 0
        ? entityTypePageQuery(typeId)
        : searchEntityTypeQuery(queryText.trim(), typeId);
    const result = await readCommerceGraph(
      props.organisationId,
      query,
      props.fetcher,
    );
    if (isCurrentCommerceEntityPlaneRequest(requestRevision, revision)) {
      setState({
        kind: "table",
        page: props.page,
        queryText,
        result,
        loadingMore: false,
      });
    }
  } catch (error) {
    if (!isCurrentCommerceEntityPlaneRequest(requestRevision, revision)) return;
    setState(
      failCommerceRefresh.bind(null, classifyCommerceGraphRouteError(error)),
    );
  }
}

function failCommerceRefresh(
  failure: Variant<CommerceGraphRouteState, "failed" | "unauthorized">,
  current: CommerceGraphRouteState,
): CommerceGraphRouteState {
  return current.kind === "dossier" && current.page === "products"
    ? productRefreshFailure(
        current,
        "The product could not refresh. Previously loaded details and your open draft have been kept on this page.",
      )
    : failure;
}

function productRefreshFailure(
  current: Variant<CommerceGraphRouteState, "dossier">,
  message: string,
): CommerceGraphRouteState {
  return {
    kind: "dossier",
    page: current.page,
    result: current.result,
    activity: current.activity,
    refresh: { kind: "failed", message },
  };
}

async function loadCommerceCollection(
  organisationId: string,
  selection: CommerceCollectionSelection,
  metadata: CommercePublishedResourceMetadata,
  fetcher: CommerceGraphFetch | undefined,
): Promise<CommerceCollectionRouteState> {
  try {
    const definition = findCommerceCollectionDefinition(metadata, selection);
    if (definition === null)
      return {
        kind: "failed",
        message: "The selected commerce resource is no longer published.",
      };
    const result = await readCommerceGraph(
      organisationId,
      commerceCollectionQuery(selection),
      fetcher,
    );
    const model = buildPublishedCommerceCollectionModel(result, definition);
    if (!model.ok)
      return {
        kind: "failed",
        message: "The collection returned an incomplete entity page.",
      };
    return {
      kind: "ready",
      model: model.value,
      names: await loadSupplierNames(
        organisationId,
        model.value,
        metadata,
        fetcher,
      ),
    };
  } catch (error) {
    return { kind: "failed", message: commerceGraphErrorMessage(error) };
  }
}

/**
 * The query parameter that opens the tab of a list, by the list's id, such
 * as `tab=supplier_directory`. The tab is the view that presents the list, or
 * the list itself when no view presents it.
 */
const COMMERCE_TAB_PARAMETER = "tab";

/**
 * Back from a record to its page. A supplier goes back to the Supplier
 * Directory, the tab that lists it, and not to the first tab of Purchasing.
 */
function backToCommerceCollection(
  onBack: CommerceEntityPlaneRouteProps["onBack"],
  page: CommerceGraphPage,
): void {
  onBack(
    page === "suppliers"
      ? `${COMMERCE_TAB_PARAMETER}=${SUPPLIER_DIRECTORY_LIST_ID}`
      : "",
  );
}

/**
 * A published view is the curated presentation of a list, so it opens first.
 * A list is only the landing place when nothing presents it. The query can
 * name the list to open; an inventory item opens the Replenishment Queue.
 */
function initialCommerceCollectionSelection(
  metadata: CommercePublishedResourceMetadata,
): CommerceCollectionSelection | null {
  const query = new URLSearchParams(window.location.search);
  const requestedList =
    query.get("inventoryItem") === null
      ? query.get(COMMERCE_TAB_PARAMETER)
      : REPLENISHMENT_QUEUE_LIST_ID;
  for (const view of metadata.views)
    if (
      view.source.kind === "commerce_list" &&
      view.source.listId === requestedList
    )
      return { kind: "saved_commerce_view", viewId: view.viewId };
  for (const list of unpresentedCommerceLists(metadata))
    if (list.listId === requestedList)
      return { kind: "commerce_list", listId: list.listId };
  const view = metadata.views[0];
  if (view !== undefined)
    return { kind: "saved_commerce_view", viewId: view.viewId };
  const list = metadata.lists[0];
  return list === undefined
    ? null
    : { kind: "commerce_list", listId: list.listId };
}

function selectedCommerceCollection(
  metadata: CommercePublishedResourceMetadata,
  selection: CommerceCollectionSelection | null,
): CommerceCollectionSelection | null {
  return selection !== null &&
    findCommerceCollectionDefinition(metadata, selection) !== null
    ? selection
    : initialCommerceCollectionSelection(metadata);
}

function purchasingMetadata(
  metadata: CommercePublishedResourceMetadata,
): CommercePublishedResourceMetadata {
  return {
    ...metadata,
    lists: metadata.lists.filter(isPurchasingList),
    views: metadata.views.filter(isPurchasingView),
  };
}

function isPurchasingList(
  list: CommercePublishedResourceMetadata["lists"][number],
): boolean {
  return (
    list.listId === SUPPLIER_DIRECTORY_LIST_ID ||
    list.listId === REPLENISHMENT_QUEUE_LIST_ID
  );
}

function isPurchasingView(
  view: CommercePublishedResourceMetadata["views"][number],
): boolean {
  return (
    view.viewId === SUPPLIERS_VIEW_ID ||
    view.viewId === REPLENISHMENT_QUEUE_VIEW_ID
  );
}

function commerceGraphStateMerchantRevision(
  state: CommerceGraphRouteState,
): CommerceSnapshotRevision | null {
  switch (state.kind) {
    case "overview":
      return state.merchantRevision;
    case "table":
      return state.result.merchantRevision;
    case "dossier":
      return state.refresh.kind === "ready"
        ? state.result.merchantRevision
        : null;
    case "loading":
    case "unauthorized":
    case "failed":
      return null;
  }
}

function watchCommerceChangesEffect(
  props: CommerceEntityPlaneRouteProps,
  afterMerchantRevision: CommerceSnapshotRevision | null,
  setRefreshRevision: CommerceRefreshRevisionSetter,
): () => void {
  if (afterMerchantRevision === null) return unchangedCommerceWatchCleanup;
  const watch: CommerceChangeWatch = { cancelled: false, timer: null };
  void pollCommerceChanges(
    props,
    afterMerchantRevision,
    watch,
    setRefreshRevision,
  );
  return stopCommerceChangeWatch.bind(null, watch);
}

async function pollCommerceChanges(
  props: CommerceEntityPlaneRouteProps,
  afterMerchantRevision: CommerceSnapshotRevision,
  watch: CommerceChangeWatch,
  setRefreshRevision: CommerceRefreshRevisionSetter,
): Promise<void> {
  try {
    const changes = await readCommerceChanges(
      props.organisationId,
      afterMerchantRevision,
      props.fetcher,
    );
    if (watch.cancelled) return;
    if (changes.merchantRevision > afterMerchantRevision) {
      setRefreshRevision(incrementCommerceRefreshRevision);
      return;
    }
  } catch {
    if (watch.cancelled) return;
  }
  watch.timer = setTimeout(
    pollCommerceChanges.bind(
      null,
      props,
      afterMerchantRevision,
      watch,
      setRefreshRevision,
    ),
    5_000,
  );
}

function stopCommerceChangeWatch(watch: CommerceChangeWatch): void {
  watch.cancelled = true;
  if (watch.timer !== null) clearTimeout(watch.timer);
}

function unchangedCommerceWatchCleanup(): void {}

function incrementCommerceRefreshRevision(revision: number): number {
  return revision + 1;
}

async function readCommerceDossierActivity(
  organisationId: string,
  reference: CommerceEntityRef,
  fetcher: CommerceGraphFetch | undefined,
): Promise<CommerceActivityRouteState> {
  try {
    return {
      kind: "ready",
      result: await readCommerceActivity(
        organisationId,
        { kind: "entity", reference },
        fetcher,
      ),
    };
  } catch {
    return { kind: "unavailable" };
  }
}

function invalidateCommerceEntityPlaneRequest(
  requestRevision: React.MutableRefObject<CommerceGraphRequestRevision>,
  revision: number,
): void {
  if (requestRevision.current.current === revision)
    requestRevision.current.current += 1;
}

function isCurrentCommerceEntityPlaneRequest(
  requestRevision: React.MutableRefObject<CommerceGraphRequestRevision>,
  revision: number,
): boolean {
  return requestRevision.current.current === revision;
}

function classifyCommerceGraphRouteError(
  error: unknown,
): Variant<CommerceGraphRouteState, "unauthorized" | "failed"> {
  if (error instanceof ControlApiError && error.kind === "forbidden")
    return { kind: "unauthorized" };
  return { kind: "failed", message: commerceGraphErrorMessage(error) };
}

function commerceGraphErrorMessage(error: unknown): string {
  if (error instanceof ControlApiError) return error.message;
  return error instanceof Error
    ? error.message
    : "Commerce data is unavailable.";
}

function renderCommerceGraphRoute(
  props: CommerceEntityPlaneRouteProps,
  state: CommerceGraphRouteState,
  queryText: string,
  setQueryText: React.Dispatch<React.SetStateAction<string>>,
  setCollectionSelection: React.Dispatch<
    React.SetStateAction<CommerceCollectionSelection | null>
  >,
  requestRevision: React.MutableRefObject<CommerceGraphRequestRevision>,
  setState: React.Dispatch<React.SetStateAction<CommerceGraphRouteState>>,
  boardMoveIntent: CommerceBoardMoveIntent,
  setBoardMoveIntent: React.Dispatch<
    React.SetStateAction<CommerceBoardMoveIntent>
  >,
  refresh: CommerceRefreshRevisionSetter,
): React.ReactNode {
  switch (state.kind) {
    case "loading":
      return <PageSkeleton label="Loading commerce graph" />;
    case "unauthorized":
      return (
        <EmptyState
          title="Commerce is unavailable"
          detail="Your role cannot view this commerce graph."
          action={null}
        />
      );
    case "failed":
      return (
        <RecoverableError
          message={state.message}
          action={
            <button
              type="button"
              onClick={refresh.bind(null, incrementCommerceRefreshRevision)}
            >
              Try again
            </button>
          }
        />
      );
    case "overview":
      return (
        <CommerceGraphOverview
          metadata={state.metadata}
          collection={state.collection}
          collectionSelection={state.collectionSelection}
          setCollectionSelection={setCollectionSelection}
          resourceHref={props.resourceHref}
          payouts={props.payouts}
          boardInteraction={{
            organisationId: props.organisationId,
            canOperate: props.canOperate === true,
            canAdminister: props.canManage === true,
            mutate: props.mutate,
            presence: props.presence,
            fetcher: props.fetcher,
            names: commerceCollectionNames(state.collection),
            intent: boardMoveIntent,
            setIntent: setBoardMoveIntent,
            refresh,
          }}
        />
      );
    case "table": {
      const table = (
        <CommerceEntityTable
          props={props}
          state={state}
          queryText={queryText}
          setQueryText={setQueryText}
          loadMore={loadMoreCommerceEntityTable.bind(
            null,
            props,
            state,
            requestRevision,
            setState,
          )}
        />
      );
      return (
        <>
          {state.page === "orders" && props.canOperate === true ? (
            <OrdersDisplay
              organisationId={props.organisationId}
              orderHref={(orderId) => props.resourceHref(orderId, "order")}
              list={table}
            />
          ) : (
            table
          )}
          {state.page === "products" && props.priceAllowances !== undefined ? (
            <OfferPriceAllowanceSection
              organisationId={props.organisationId}
              canConfigure={props.priceAllowances.canConfigure}
              transport={props.priceAllowances.transport}
              fetcher={props.priceAllowances.fetcher}
            />
          ) : null}
        </>
      );
    }
    case "dossier":
      return (
        <CommerceEntityDossier
          props={props}
          page={state.page}
          result={state.result}
          activity={state.activity}
        />
      );
    default:
      return assertNever(state, "Unhandled commerce graph value");
  }
}

function commerceCollectionNames(
  collection: CommerceCollectionRouteState,
): ReadonlyMap<string, string> {
  return collection.kind === "ready" ? collection.names : NO_SUPPLIER_NAMES;
}

function CommerceGraphOverview(
  props: Readonly<{
    metadata: CommercePublishedResourceMetadata;
    collection: CommerceCollectionRouteState;
    collectionSelection: CommerceCollectionSelection | null;
    setCollectionSelection: React.Dispatch<
      React.SetStateAction<CommerceCollectionSelection | null>
    >;
    resourceHref: CommerceEntityPlaneRouteProps["resourceHref"];
    payouts: CommerceEntityPlaneRouteProps["payouts"];
    boardInteraction: CommerceBoardInteraction;
  }>,
): React.ReactNode {
  const active = props.metadata.lists.some(isSupplierDirectoryList);
  const controls = (
    <PurchasingControls
      organisationId={props.boardInteraction.organisationId}
      active={active}
      canManage={props.boardInteraction.canAdminister}
      canOperate={props.boardInteraction.canOperate}
      mutate={props.boardInteraction.mutate}
      fetcher={props.boardInteraction.fetcher}
      refresh={props.boardInteraction.refresh}
    />
  );
  // Add supplier and Recheck stock sit on the tab row. A set-up step or a
  // notice for a viewer stays above the tabs, where it reads as a message.
  const inTabRow =
    active &&
    props.boardInteraction.canOperate &&
    props.boardInteraction.mutate !== undefined;
  // The page title already names this section: Purchasing.
  return (
    <section
      className="portal-band commerce-panel commerce-purchasing"
      aria-label="Suppliers"
    >
      {inTabRow ? null : controls}
      <CommerceCollectionPanel
        metadata={props.metadata}
        collection={props.collection}
        selection={props.collectionSelection}
        setSelection={props.setCollectionSelection}
        resourceHref={props.resourceHref}
        boardInteraction={props.boardInteraction}
        payouts={props.payouts}
        actions={inTabRow ? controls : null}
      />
    </section>
  );
}

function CommerceCollectionPanel(
  props: Readonly<{
    metadata: CommercePublishedResourceMetadata;
    collection: CommerceCollectionRouteState;
    selection: CommerceCollectionSelection | null;
    setSelection: React.Dispatch<
      React.SetStateAction<CommerceCollectionSelection | null>
    >;
    resourceHref: CommerceEntityPlaneRouteProps["resourceHref"];
    boardInteraction: CommerceBoardInteraction;
    payouts: CommerceEntityPlaneRouteProps["payouts"];
    actions: React.ReactNode;
  }>,
): React.ReactNode {
  const [payoutsShown, setPayoutsShown] = React.useState(false);
  const [payoutStatus, setPayoutStatus] =
    React.useState<CommercePayoutsTabStatus>({ readable: true, attention: 0 });
  const attention = payoutStatus.attention;
  if (props.metadata.lists.length === 0 && props.metadata.views.length === 0)
    return null;
  const payoutsTab = props.payouts !== undefined && payoutStatus.readable;
  const showPayouts = payoutsShown && payoutsTab;
  const selection = showPayouts ? null : props.selection;
  const choose = chooseCommerceCollection.bind(
    null,
    setPayoutsShown,
    props.selection,
    props.setSelection,
  );
  return (
    <section
      className="commerce-collection"
      aria-labelledby="commerce-collection-title"
    >
      <h3 id="commerce-collection-title" className="visually-hidden">
        Views
      </h3>
      <div className="commerce-collection-bar">
        <div className="commerce-tabs" role="group" aria-label="Views">
          {props.metadata.views.map(
            renderCommerceViewTab.bind(null, selection, choose),
          )}
          {unpresentedCommerceLists(props.metadata).map(
            renderCommerceListTab.bind(null, selection, choose),
          )}
          {!payoutsTab ? null : (
            <button
              type="button"
              className={
                showPayouts ? "commerce-tab commerce-tab-active" : "commerce-tab"
              }
              aria-pressed={showPayouts}
              onClick={setPayoutsShown.bind(null, true)}
            >
              Payouts
              {attention === 0 ? null : (
                <span className="commerce-tab-attention">
                  {" "}
                  {attention}
                  <span className="visually-hidden"> need attention</span>
                  <span className="commerce-tab-dot" aria-hidden="true" />
                </span>
              )}
            </button>
          )}
        </div>
        {props.actions}
      </div>
      <div hidden={showPayouts}>
        <CommerceCollectionContent
          collection={props.collection}
          resourceHref={props.resourceHref}
          boardInteraction={props.boardInteraction}
        />
      </div>
      {/* Mounted while hidden, so the tab's mark reads the payouts too. */}
      {props.payouts === undefined ? null : (
        <div hidden={!showPayouts}>{props.payouts(setPayoutStatus)}</div>
      )}
    </section>
  );
}

/**
 * A view tab closes the Payouts tab and selects its view. The view that is
 * already selected stays loaded, so going back from Payouts reads nothing.
 */
function chooseCommerceCollection(
  setPayoutsShown: React.Dispatch<React.SetStateAction<boolean>>,
  current: CommerceCollectionSelection | null,
  setSelection: React.Dispatch<
    React.SetStateAction<CommerceCollectionSelection | null>
  >,
  value: React.SetStateAction<CommerceCollectionSelection | null>,
): void {
  setPayoutsShown(false);
  if (typeof value !== "function" && sameCommerceCollection(current, value))
    return;
  setSelection(value);
}

function sameCommerceCollection(
  left: CommerceCollectionSelection | null,
  right: CommerceCollectionSelection | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === "saved_commerce_view" && right.kind === "saved_commerce_view")
    return left.viewId === right.viewId;
  if (left.kind === "commerce_list" && right.kind === "commerce_list")
    return left.listId === right.listId;
  return false;
}

/**
 * Lists a published view already presents, so the same records do not appear
 * twice under two names. A list without a view still needs its own tab, since
 * it would otherwise be unreachable.
 */
function unpresentedCommerceLists(
  metadata: CommercePublishedResourceMetadata,
): readonly CommercePublishedResourceMetadata["lists"][number][] {
  const presented = new Set<string>();
  for (const view of metadata.views) {
    if (view.source.kind === "commerce_list")
      presented.add(String(view.source.listId));
  }
  return metadata.lists.filter((list) => !presented.has(String(list.listId)));
}

/**
 * Views are destinations, not settings, so each published view and list is a
 * control the operator can see and reach in one action. Selection is page
 * state rather than a route, so these are buttons with a pressed state.
 */
function renderCommerceViewTab(
  selection: CommerceCollectionSelection | null,
  setSelection: React.Dispatch<
    React.SetStateAction<CommerceCollectionSelection | null>
  >,
  view: CommercePublishedResourceMetadata["views"][number],
): React.ReactNode {
  const active =
    selection !== null &&
    selection.kind === "saved_commerce_view" &&
    selection.viewId === view.viewId;
  return (
    <button
      type="button"
      key={String(view.viewId)}
      className={active ? "commerce-tab commerce-tab-active" : "commerce-tab"}
      aria-pressed={active}
      onClick={selectCommerceView.bind(null, setSelection, view.viewId)}
    >
      {view.name}
    </button>
  );
}

function renderCommerceListTab(
  selection: CommerceCollectionSelection | null,
  setSelection: React.Dispatch<
    React.SetStateAction<CommerceCollectionSelection | null>
  >,
  list: CommercePublishedResourceMetadata["lists"][number],
): React.ReactNode {
  const active =
    selection !== null &&
    selection.kind === "commerce_list" &&
    selection.listId === list.listId;
  return (
    <button
      type="button"
      key={String(list.listId)}
      className={active ? "commerce-tab commerce-tab-active" : "commerce-tab"}
      aria-pressed={active}
      onClick={selectCommerceList.bind(null, setSelection, list.listId)}
    >
      {list.name}
    </button>
  );
}

function selectCommerceView(
  setSelection: React.Dispatch<
    React.SetStateAction<CommerceCollectionSelection | null>
  >,
  viewId: SavedCommerceViewId,
): void {
  setSelection({ kind: "saved_commerce_view", viewId });
}

function selectCommerceList(
  setSelection: React.Dispatch<
    React.SetStateAction<CommerceCollectionSelection | null>
  >,
  listId: CommerceListId,
): void {
  setSelection({ kind: "commerce_list", listId });
}

function CommerceCollectionContent(
  props: Readonly<{
    collection: CommerceCollectionRouteState;
    resourceHref: CommerceEntityPlaneRouteProps["resourceHref"];
    boardInteraction: CommerceBoardInteraction;
  }>,
): React.ReactNode {
  switch (props.collection.kind) {
    case "loading":
      return <p className="empty-state commerce-empty">Loading…</p>;
    case "unselected":
      return (
        <EmptyState
          title="No views published yet"
          detail="Views organise your commerce records into the lists your team works from. An administrator publishes them for this workspace."
        />
      );
    case "failed":
      return (
        <Notice tone="warning" announcement="polite">
          {props.collection.message}
        </Notice>
      );
    case "ready":
      return (
        <>
          <CommerceSavedViewEditor
            key={props.collection.model.view?.viewId ?? "commerce-list"}
            model={props.collection.model}
            interaction={props.boardInteraction}
          />
          {renderCommerceListEntryStatusIntent(
            props.collection.model,
            props.boardInteraction,
          )}
          <p className="visually-hidden" role="status" aria-live="polite">
            {commerceListEntryStatusAnnouncement(props.boardInteraction.intent)}
          </p>
          {props.collection.model.presentation?.kind === "board"
            ? renderCommerceCollectionBoard(
                props.collection.model,
                props.resourceHref,
                props.boardInteraction,
              )
            : renderCommerceCollectionTable(
                props.collection.model,
                props.resourceHref,
                props.boardInteraction,
              )}
        </>
      );
    default:
      return assertNever(props.collection, "Unhandled commerce graph value");
  }
}

function renderCommerceCollectionTable(
  model: CommercePublishedCollectionModel,
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  interaction: CommerceBoardInteraction,
): React.ReactNode {
  const hasRows = model.rows.length > 0 || model.entityRows.length > 0;
  if (!hasRows) {
    return (
      <p className="empty-state commerce-empty">
        This collection has no entries.
      </p>
    );
  }
  const tableConfiguration =
    model.presentation?.kind === "table"
      ? model.presentation.configuration
      : null;
  const label = collectionSourceLabel(model);
  const subjectLabel = commerceCollectionSubjectLabel(model);
  if (model.mode === "saved_entity_view") {
    const columns: CrmColumn<CommerceEntity>[] = [
      {
        id: "name",
        label: subjectLabel,
        width: 280,
        kind: "text",
        value: commerceEntityName,
        render: renderCommerceEntityName.bind(null, resourceHref),
      },
      ...model.attributeIds.map(
        commerceEntityAttributeColumn.bind(null, model.entityRows),
      ),
    ];
    if (tableConfiguration?.showRowNumbers) {
      columns.unshift(collectionRowNumberColumn());
    }
    return (
      <div
        className="commerce-collection-grid"
        data-density={tableConfiguration?.density}
      >
        <CrmTable
          key={model.view.viewId}
          label={label}
          rows={model.entityRows}
          columns={columns}
          rowId={commerceEntityId}
          rowLabel={commerceEntityName}
          initialPinned={["name"]}
        />
      </div>
    );
  }
  const columns: CrmColumn<CommerceCollectionRow>[] = [
    {
      id: "name",
      label: subjectLabel,
      width: 280,
      kind: "text",
      value: commerceCollectionRowName,
      render: renderCommerceCollectionRowName.bind(null, resourceHref),
    },
    ...model.attributeIds.map(
      commerceCollectionAttributeColumn.bind(null, model, interaction),
    ),
  ];
  if (tableConfiguration?.showRowNumbers) {
    columns.unshift(collectionRowNumberColumn());
  }
  return (
    <div
      className="commerce-collection-grid"
      data-density={tableConfiguration?.density}
    >
      <CrmTable
        key={
          model.mode === "commerce_list" ? model.list.listId : model.view.viewId
        }
        label={label}
        rows={model.rows}
        columns={columns}
        rowId={commerceCollectionRowId}
        rowLabel={commerceCollectionRowName}
        initialPinned={["name"]}
      />
    </div>
  );
}

function collectionRowNumberColumn<Row>(): CrmColumn<Row> {
  return {
    id: "row-number",
    label: "#",
    width: 100,
    align: "end",
    kind: "display",
    render: renderCollectionRowNumber,
  };
}

function renderCollectionRowNumber(
  _row: unknown,
  index: number,
): React.ReactNode {
  return index + 1;
}

/**
 * What each row of this collection is, so the first column is named for its
 * subject ("Supplier", "Shipment") rather than the word "Entity".
 */
function commerceCollectionSubjectLabel(
  model: CommercePublishedCollectionModel,
): string {
  const typeId =
    model.list === null
      ? model.view?.source.kind === "entity_type"
        ? String(model.view.source.entityTypeId.typeId)
        : null
      : String(model.list.entityTypeId.typeId);
  if (typeId === null) return "Record";
  const label = commerceEntityTypeLabel(typeId, false);
  return `${label.slice(0, 1).toLocaleUpperCase()}${label.slice(1)}`;
}

function renderCommerceCollectionRowName(
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  row: CommerceCollectionRow,
): React.ReactNode {
  return renderCommerceEntityName(resourceHref, row.entity);
}

function commerceCollectionRowId(row: CommerceCollectionRow): string {
  return `${row.entry.listId}:${row.entry.entryId}`;
}

function commerceCollectionRowName(row: CommerceCollectionRow): string {
  return row.entity.displayName;
}

function commerceEntityId(entity: CommerceEntity): string {
  return entityReferenceKey(entity.reference);
}

function commerceEntityName(entity: CommerceEntity): string {
  return commerceRecordLabel(entity.displayName);
}

/** The icon of a record type; a type with none shows its first letter. */
function commerceEntityIcon(typeId: string, size: number): React.ReactNode {
  switch (typeId) {
    case "order":
      return <ShoppingCart size={size} strokeWidth={1.5} aria-hidden="true" />;
    case "product":
      return <Package size={size} strokeWidth={1.5} aria-hidden="true" />;
    default:
      return undefined;
  }
}

function renderCommerceEntityName(
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  entity: CommerceEntity,
): React.ReactNode {
  const link = entityResourceLink(resourceHref, entity);
  const identity = (
    <CrmIdentity
      label={commerceEntityName(entity)}
      icon={commerceEntityIcon(String(entity.reference.typeId), 16)}
    />
  );
  return link === null ? identity : <Link to={link}>{identity}</Link>;
}

function commerceCollectionAttributeColumn(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
  attributeId: string,
): CrmColumn<CommerceCollectionRow> {
  const definition = listAttributeDefinition(model, attributeId);
  const numeric =
    definition?.definition.kind.kind === "decimal" ||
    definition?.definition.kind.kind === "integer" ||
    definition?.definition.kind.kind === "money";
  const align: "start" | "end" = numeric ? "end" : "start";
  const column = {
    id: `attribute-${attributeId}`,
    label: commerceAttributeLabel(attributeId, definition),
    width: 180,
    align,
    render: renderCollectionAttributeCell.bind(
      null,
      model,
      interaction,
      attributeId,
    ),
  };
  if (numeric) return { ...column, kind: "display" };
  return {
    ...column,
    kind: "text",
    value: commerceCollectionAttributeValue.bind(null, model, attributeId),
  };
}

function commerceCollectionAttributeValue(
  model: CommercePublishedCollectionModel,
  attributeId: string,
  row: CommerceCollectionRow,
): string | null {
  const attribute = row.entry.attributeValues.find(
    matchesCommerceAttribute.bind(null, attributeId),
  );
  if (attribute === undefined) return null;
  const definition = listAttributeDefinition(model, attributeId);
  return formatCommerceAttributeValue(
    attribute.value,
    definition?.definition.kind,
  );
}

function matchesCommerceAttribute(
  attributeId: string,
  attribute: Readonly<{ attributeId: AttributeDefinitionId }>,
): boolean {
  return attribute.attributeId === attributeId;
}

function renderCollectionAttributeCell(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
  attributeId: string,
  row: CommerceCollectionRow,
): React.ReactNode {
  const attribute = row.entry.attributeValues.find(
    matchesCommerceAttribute.bind(null, attributeId),
  );
  if (attribute === undefined) return COMMERCE_VALUE_ABSENT;
  const definition = listAttributeDefinition(model, attributeId);
  if (
    attribute.value.kind !== "status" ||
    definition?.definition.kind.kind !== "status" ||
    !interaction.canOperate ||
    interaction.mutate === undefined
  ) {
    const chip = commerceStatusChip(
      attribute.value,
      definition?.definition.kind,
    );
    if (chip !== null) return <StatusChip status={chip} />;
    return resolveCommerceReferenceName(
      interaction.names,
      formatCommerceAttributeValue(
        attribute.value,
        definition?.definition.kind,
      ),
    );
  }
  const items = definition.definition.kind.options.map(commerceOptionItem);
  return (
    <label className="commerce-table-status-control">
      <span className="visually-hidden">
        Change {row.entity.displayName} {definition.definition.label}
      </span>
      <Select.Root
        items={items}
        value={attribute.value.value}
        disabled={commerceBoardIntentBlocksMutation(interaction.intent)}
        onValueChange={selectCommerceTableStatus.bind(
          null,
          model,
          interaction,
          row.entry,
          row.entity.displayName,
          definition.attributeId,
        )}
      >
        {renderCommerceSelectParts(items)}
      </Select.Root>
    </label>
  );
}

type CommerceSavedViewEditEvidence = Readonly<{
  viewId: string;
  viewRevision: number;
  merchantRevision: CommerceSnapshotRevision;
  presentation: CommerceViewPresentation;
}>;

type CommerceSavedViewEditIntent =
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

type CommerceSavedViewEditorProps = Readonly<{
  model: CommercePublishedCollectionModel;
  interaction: CommerceBoardInteraction;
}>;

function CommerceSavedViewEditor(
  props: CommerceSavedViewEditorProps,
): React.ReactNode {
  const [intent, setIntent] = React.useState<CommerceSavedViewEditIntent>({
    kind: "idle",
  });
  const view = props.model.view;
  if (
    view === null ||
    !props.interaction.canAdminister ||
    props.interaction.mutate === undefined
  )
    return null;
  return (
    <details className="commerce-display-options">
      <summary>Display options</summary>
      <div className="commerce-display-options-body">
        <p>Changes apply for everyone in this workspace.</p>
        {view.presentation.kind === "table"
          ? renderCommerceTableViewEditor(props, intent, setIntent)
          : renderCommerceBoardViewEditor(props, intent, setIntent)}
        {renderCommerceSavedViewEditIntent(props, intent, setIntent)}
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {commerceSavedViewEditAnnouncement(intent)}
      </p>
    </details>
  );
}

function renderCommerceTableViewEditor(
  props: CommerceSavedViewEditorProps,
  intent: CommerceSavedViewEditIntent,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
): React.ReactNode {
  const view = props.model.view;
  if (view === null || view.presentation.kind !== "table") return null;
  return (
    <div className="commerce-view-editor-fields">
      <label>
        <span>Table density</span>
        <Select.Root
          items={COMMERCE_TABLE_DENSITIES}
          value={view.presentation.configuration.density}
          disabled={intent.kind === "saving"}
          onValueChange={changeCommerceTableDensity.bind(
            null,
            props,
            setIntent,
          )}
        >
          {renderCommerceSelectParts(COMMERCE_TABLE_DENSITIES)}
        </Select.Root>
      </label>
      <label className="commerce-view-editor-checkbox">
        <input
          type="checkbox"
          checked={view.presentation.configuration.showRowNumbers}
          disabled={intent.kind === "saving"}
          onChange={changeCommerceTableRowNumbers.bind(null, props, setIntent)}
        />
        <span>Show row numbers</span>
      </label>
    </div>
  );
}

function renderCommerceBoardViewEditor(
  props: CommerceSavedViewEditorProps,
  intent: CommerceSavedViewEditIntent,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
): React.ReactNode {
  const view = props.model.view;
  const list = props.model.list;
  if (view === null || view.presentation.kind !== "board" || list === null)
    return null;
  const laneFields = commerceBoardStatusDefinitions(
    list.entryAttributeDefinitions,
  ).map(commerceBoardStatusDefinitionItem);
  return (
    <div className="commerce-view-editor-fields">
      <label>
        <span>Lane field</span>
        <Select.Root
          items={laneFields}
          value={String(view.presentation.configuration.laneAttributeId)}
          disabled={intent.kind === "saving"}
          onValueChange={changeCommerceBoardLaneField.bind(
            null,
            props,
            setIntent,
          )}
        >
          {renderCommerceSelectParts(laneFields)}
        </Select.Root>
      </label>
      <fieldset disabled={intent.kind === "saving"}>
        <legend>Card fields</legend>
        {list.entryAttributeDefinitions.map(
          renderCommerceBoardCardAttributeControl.bind(null, props, setIntent),
        )}
      </fieldset>
    </div>
  );
}

function commerceBoardStatusDefinitions(
  definitions: readonly ListEntryAttributeDefinition[],
): readonly ListEntryAttributeDefinition[] {
  const statusDefinitions: ListEntryAttributeDefinition[] = [];
  for (const definition of definitions) {
    if (definition.definition.kind.kind === "status")
      statusDefinitions.push(definition);
  }
  return statusDefinitions;
}

function commerceBoardStatusDefinitionItem(
  definition: ListEntryAttributeDefinition,
): CommerceSelectItem {
  return {
    value: String(definition.attributeId),
    label: definition.definition.label,
  };
}

function renderCommerceBoardCardAttributeControl(
  props: CommerceSavedViewEditorProps,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
  definition: ListEntryAttributeDefinition,
): React.ReactNode {
  const view = props.model.view;
  if (view === null || view.presentation.kind !== "board") return null;
  const selected = includesAttributeId(
    view.presentation.configuration.cardAttributeIds,
    definition.attributeId,
  );
  const lastSelected =
    selected && view.presentation.configuration.cardAttributeIds.length === 1;
  return (
    <label
      className="commerce-view-editor-checkbox"
      key={String(definition.attributeId)}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={lastSelected}
        onChange={changeCommerceBoardCardAttribute.bind(
          null,
          props,
          setIntent,
          definition.attributeId,
        )}
      />
      <span>{definition.definition.label}</span>
    </label>
  );
}

function includesAttributeId(
  attributeIds: readonly AttributeDefinitionId[],
  attributeId: AttributeDefinitionId,
): boolean {
  return attributeIds.includes(attributeId);
}

function changeCommerceTableDensity(
  props: CommerceSavedViewEditorProps,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
  value: string | null,
): void {
  const view = props.model.view;
  if (value === null || view === null || view.presentation.kind !== "table")
    return;
  const density = parseCommerceTableDensity(value);
  void saveCommerceViewPresentation(props, setIntent, {
    kind: "table",
    configuration: {
      density,
      showRowNumbers: view.presentation.configuration.showRowNumbers,
    },
  });
}

function changeCommerceTableRowNumbers(
  props: CommerceSavedViewEditorProps,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  const view = props.model.view;
  if (view === null || view.presentation.kind !== "table") return;
  void saveCommerceViewPresentation(props, setIntent, {
    kind: "table",
    configuration: {
      density: view.presentation.configuration.density,
      showRowNumbers: event.currentTarget.checked,
    },
  });
}

function changeCommerceBoardLaneField(
  props: CommerceSavedViewEditorProps,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
  value: string | null,
): void {
  const view = props.model.view;
  const list = props.model.list;
  if (view === null || view.presentation.kind !== "board" || list === null)
    return;
  if (value === null) return;
  const laneAttributeId = findCommerceBoardLaneAttributeId(
    list.entryAttributeDefinitions,
    value,
  );
  if (laneAttributeId === undefined) return;
  void saveCommerceViewPresentation(props, setIntent, {
    kind: "board",
    configuration: {
      laneAttributeId,
      cardAttributeIds: view.presentation.configuration.cardAttributeIds,
    },
  });
}

function changeCommerceBoardCardAttribute(
  props: CommerceSavedViewEditorProps,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
  attributeId: AttributeDefinitionId,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  const view = props.model.view;
  if (view === null || view.presentation.kind !== "board") return;
  const cardAttributeIds = event.currentTarget.checked
    ? [...view.presentation.configuration.cardAttributeIds, attributeId]
    : view.presentation.configuration.cardAttributeIds.filter(
        attributeIdDoesNotEqual.bind(null, attributeId),
      );
  void saveCommerceViewPresentation(props, setIntent, {
    kind: "board",
    configuration: {
      laneAttributeId: view.presentation.configuration.laneAttributeId,
      cardAttributeIds,
    },
  });
}

function attributeIdDoesNotEqual(
  expected: AttributeDefinitionId,
  candidate: AttributeDefinitionId,
): boolean {
  return candidate !== expected;
}

function parseCommerceTableDensity(value: string): CommerceTableDensity {
  switch (value) {
    case "compact":
    case "comfortable":
    case "spacious":
      return value;
    default:
      throw new Error("The selected table density is invalid.");
  }
}

function findCommerceBoardLaneAttributeId(
  definitions: readonly ListEntryAttributeDefinition[],
  value: string,
): AttributeDefinitionId | undefined {
  for (const definition of definitions) {
    if (
      definition.attributeId === value &&
      definition.definition.kind.kind === "status"
    ) {
      return definition.attributeId;
    }
  }
  return undefined;
}

async function saveCommerceViewPresentation(
  props: CommerceSavedViewEditorProps,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
  presentation: CommerceViewPresentation,
): Promise<void> {
  const view = props.model.view;
  const mutate = props.interaction.mutate;
  if (view === null || mutate === undefined || !props.interaction.canAdminister)
    return;
  const evidence: CommerceSavedViewEditEvidence = {
    viewId: String(view.viewId),
    viewRevision: Number(view.revision),
    merchantRevision: props.model.merchantRevision,
    presentation,
  };
  setIntent({ kind: "saving", ...evidence });
  try {
    await publishCommerceSavedViewPresentation(
      props.interaction.organisationId,
      view,
      presentation,
      mutate,
    );
    setIntent({ kind: "idle" });
    toast.success("Display updated for everyone.");
    props.interaction.refresh(incrementCommerceRefreshRevision);
  } catch (error) {
    if (
      error instanceof ControlApiError &&
      error.kind === "commerce_revision_conflict"
    ) {
      setIntent({ kind: "stale", ...evidence });
      props.interaction.refresh(incrementCommerceRefreshRevision);
      return;
    }
    const permission = permissionRequiredOf(error);
    setIntent({
      kind: "failed",
      ...evidence,
      message:
        permission !== null
          ? "Updating this view needs a permission that was not allowed."
          : error instanceof Error
            ? error.message
            : "Unable to publish the view. Check your connection and retry the update.",
      permission,
    });
  }
}

function renderCommerceSavedViewEditIntent(
  props: CommerceSavedViewEditorProps,
  intent: CommerceSavedViewEditIntent,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
): React.ReactNode {
  if (intent.kind === "stale") {
    return (
      <Notice tone="warning" announcement="none">
        This view changed in another session. Review the latest presentation,
        then retry your update.
        <span className="commerce-board-intent-actions">
          <button
            type="button"
            onClick={retryCommerceSavedViewEdit.bind(
              null,
              props,
              intent,
              setIntent,
            )}
          >
            Retry view update
          </button>
          <button
            type="button"
            onClick={discardCommerceSavedViewEdit.bind(null, setIntent)}
          >
            Discard view update
          </button>
        </span>
      </Notice>
    );
  }
  if (intent.kind === "failed") {
    return (
      <Notice tone="warning" announcement="none">
        {intent.message}
        {intent.permission != null && (
          <PermissionRequiredPrompt
            organisationId={props.interaction.organisationId}
            permission={intent.permission}
            action="Updating this view"
            grantScope="for this view only"
            onAllowed={retryCommerceSavedViewEdit.bind(
              null,
              props,
              intent,
              setIntent,
            )}
            onClose={setIntent.bind(null, { ...intent, permission: null })}
          />
        )}
        <span className="commerce-board-intent-actions">
          <button
            type="button"
            onClick={retryCommerceSavedViewEdit.bind(
              null,
              props,
              intent,
              setIntent,
            )}
          >
            Retry view update
          </button>
          <button
            type="button"
            onClick={discardCommerceSavedViewEdit.bind(null, setIntent)}
          >
            Discard view update
          </button>
        </span>
      </Notice>
    );
  }
  return null;
}

function retryCommerceSavedViewEdit(
  props: CommerceSavedViewEditorProps,
  intent: Variant<CommerceSavedViewEditIntent, "stale" | "failed">,
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
): void {
  void saveCommerceViewPresentation(props, setIntent, intent.presentation);
}

function discardCommerceSavedViewEdit(
  setIntent: React.Dispatch<React.SetStateAction<CommerceSavedViewEditIntent>>,
): void {
  setIntent({ kind: "idle" });
}

function commerceSavedViewEditAnnouncement(
  intent: CommerceSavedViewEditIntent,
): string {
  switch (intent.kind) {
    case "idle":
      return "";
    case "saving":
      return "Publishing the saved-view presentation.";
    case "stale":
      return "The saved view changed in another session. The presentation update is preserved.";
    case "failed":
      return intent.message;
    default:
      return assertNever(intent, "Unhandled commerce graph value");
  }
}

function renderCommerceCollectionBoard(
  model: CommercePublishedCollectionModel,
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  interaction: CommerceBoardInteraction,
): React.ReactNode {
  const board = model.board;
  if (board === null)
    return (
      <p className="empty-state commerce-empty">
        This published view has no board configuration.
      </p>
    );
  const laneOptions = commerceBoardLaneOptions(model);
  if (laneOptions.length === 0)
    return (
      <p className="empty-state commerce-empty">
        This board lane is not a published status field.
      </p>
    );
  const cardAttributeIds = board.configuration.cardAttributeIds;
  return (
    <>
      <CommerceBoardPresence model={model} interaction={interaction} />
      <CommerceBoardList
        label={model.view?.name ?? "Commerce board"}
        lanes={laneOptions.map(commerceBoardListLane)}
        rows={laneOptions.flatMap(
          commerceBoardListRows.bind(
            null,
            model,
            resourceHref,
            interaction,
            laneOptions,
            cardAttributeIds,
          ),
        )}
      />
    </>
  );
}

function commerceBoardListRows(
  model: CommercePublishedCollectionModel,
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  interaction: CommerceBoardInteraction,
  laneOptions: readonly CommerceBoardLaneOption[],
  cardAttributeIds: readonly AttributeDefinitionId[],
  lane: CommerceBoardLaneOption,
): readonly CommerceBoardListRow[] {
  return lane.rows.map(
    commerceBoardListRow.bind(
      null,
      model,
      resourceHref,
      interaction,
      laneOptions,
      cardAttributeIds,
      lane,
    ),
  );
}

/**
 * One entry of a board view as a list row. A purchase request shows its
 * supplier, amount, due day and owner; another board shows its first card
 * fact under the name and the next three as columns.
 */
function commerceBoardListRow(
  model: CommercePublishedCollectionModel,
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  interaction: CommerceBoardInteraction,
  laneOptions: readonly CommerceBoardLaneOption[],
  cardAttributeIds: readonly AttributeDefinitionId[],
  lane: CommerceBoardLaneOption,
  row: CommerceCollectionRow,
): CommerceBoardListRow {
  const text = commerceBoardFactText.bind(null, model, interaction.names, row);
  const purchasing = model.list?.listId === REPLENISHMENT_QUEUE_LIST_ID;
  const summary = purchasing
    ? purchaseRequestRowSummary(row.entry, text)
    : boardRowSummary(cardAttributeIds, text);
  return {
    key: `${String(row.entry.listId)}:${String(row.entry.entryId)}`,
    laneId: lane.id,
    name: row.entity.displayName,
    secondary: summary.secondary,
    columns: summary.columns,
    laneTag: <StatusChip status={commerceBoardLaneChip(model, row, lane)} />,
    drawer: renderCommerceBoardEntryDrawer.bind(
      null,
      model,
      resourceHref,
      interaction,
      laneOptions,
      cardAttributeIds.map(
        commerceBoardFact.bind(null, model, interaction.names, row),
      ),
      purchasing,
      lane.id,
      row,
    ),
  };
}

function renderCommerceBoardEntryDrawer(
  model: CommercePublishedCollectionModel,
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  interaction: CommerceBoardInteraction,
  laneOptions: readonly CommerceBoardLaneOption[],
  facts: readonly CommerceBoardListFact[],
  purchasing: boolean,
  laneId: string,
  row: CommerceCollectionRow,
  open: boolean,
  close: () => void,
): React.ReactNode {
  const href = entityResourceLink(resourceHref, row.entity);
  const laneControl =
    interaction.canOperate && interaction.mutate !== undefined ? (
      <Select.Root
        items={laneOptions.map(commerceOptionItem)}
        value={laneId}
        disabled={commerceBoardIntentBlocksMutation(interaction.intent)}
        onValueChange={moveCommerceBoardEntryFromDrawer.bind(
          null,
          close,
          model,
          interaction,
          row.entry,
          row.entity.displayName,
        )}
      >
        <Select.Trigger aria-label={`Move ${row.entity.displayName} to lane`}>
          <Select.Value />
        </Select.Trigger>
        <Select.Popup>{laneOptions.map(renderCommerceBoardLaneOption)}</Select.Popup>
      </Select.Root>
    ) : null;
  return purchasing ? (
    <PurchaseRequestDrawer
      open={open}
      close={close}
      model={model}
      row={row}
      href={href}
      facts={facts}
      laneControl={laneControl}
      organisationId={interaction.organisationId}
      canOperate={interaction.canOperate}
      mutate={interaction.mutate}
      refresh={interaction.refresh}
    />
  ) : (
    <CommerceBoardEntryDrawer
      open={open}
      close={close}
      title={row.entity.displayName}
      href={href}
      facts={facts}
      laneControl={laneControl}
    />
  );
}

/** A lane change closes the drawer, so its outcome shows above the list. */
function moveCommerceBoardEntryFromDrawer(
  close: () => void,
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
  entry: CommerceListEntry,
  label: string,
  value: string | null,
): void {
  if (value === null) return;
  close();
  selectCommerceBoardLane(model, interaction, entry, label, value);
}

function CommerceBoardPresence(
  props: Readonly<{
    model: CommercePublishedCollectionModel;
    interaction: CommerceBoardInteraction;
  }>,
): React.ReactNode {
  const [entries, setEntries] = React.useState<
    readonly CommerceBoardPresenceEntry[]
  >([]);
  React.useEffect(
    commerceBoardPresenceEffect.bind(
      null,
      props.model,
      props.interaction,
      setEntries,
    ),
    [
      props.model.list?.listId,
      props.model.view?.viewId,
      props.interaction.organisationId,
      props.interaction.presence,
      props.interaction.intent,
    ],
  );
  if (props.interaction.presence === undefined || entries.length === 0)
    return null;
  return (
    <aside className="commerce-board-presence" aria-label="Connected operators">
      <span>Connected</span>
      <ul>{entries.map(renderCommerceBoardPresenceEntry)}</ul>
    </aside>
  );
}

function commerceBoardPresenceEffect(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
  setEntries: React.Dispatch<
    React.SetStateAction<readonly CommerceBoardPresenceEntry[]>
  >,
): () => void {
  const transport = interaction.presence;
  if (transport === undefined) return unchangedCommerceWatchCleanup;
  const resourceKey = commerceBoardPresenceResourceKey(model);
  const selection = commerceBoardPresenceSelection(interaction.intent);
  const dragPreview = commerceBoardDragPreview(interaction.intent);
  const update = updateCommerceBoardPresenceState.bind(
    null,
    interaction.organisationId,
    resourceKey,
    selection,
    dragPreview,
    transport,
    setEntries,
  );
  void update();
  const interval = setInterval(update, 10_000);
  return clearCommerceBoardPresenceInterval.bind(null, interval);
}

async function updateCommerceBoardPresenceState(
  organisationId: string,
  resourceKey: string,
  selection: CommerceBoardPresenceSelection,
  dragPreview: CommerceBoardDragPreview,
  transport: CommercePresenceTransport,
  setEntries: React.Dispatch<
    React.SetStateAction<readonly CommerceBoardPresenceEntry[]>
  >,
): Promise<void> {
  try {
    setEntries(
      await updateCommerceBoardPresence(
        organisationId,
        resourceKey,
        selection,
        dragPreview,
        transport,
      ),
    );
  } catch {
    setEntries([]);
  }
}

function clearCommerceBoardPresenceInterval(
  interval: ReturnType<typeof setInterval>,
): void {
  clearInterval(interval);
}

function commerceBoardPresenceResourceKey(
  model: CommercePublishedCollectionModel,
): string {
  return model.view === null
    ? `commerce_list:${String(model.list?.listId ?? "unknown")}`
    : `saved_commerce_view:${String(model.view.viewId)}`;
}

function commerceBoardPresenceSelection(
  intent: CommerceBoardMoveIntent,
): CommerceBoardPresenceSelection {
  switch (intent.kind) {
    case "dragging":
    case "saving":
    case "approval_requested":
    case "stale":
    case "failed":
      return {
        kind: "list_entry",
        entryId: intent.entryId,
        listId: intent.listId,
      };
    case "idle":
    case "saved":
      return { kind: "none" };
    default:
      return assertNever(intent, "Unhandled commerce graph value");
  }
}

function commerceBoardDragPreview(
  intent: CommerceBoardMoveIntent,
): CommerceBoardDragPreview {
  switch (intent.kind) {
    case "dragging":
      return { kind: "moving", entryId: intent.entryId, desiredStatusId: null };
    case "saving":
    case "stale":
    case "failed":
      return {
        kind: "moving",
        entryId: intent.entryId,
        desiredStatusId: intent.desiredStatus,
      };
    case "approval_requested":
      return { kind: "idle" };
    case "idle":
    case "saved":
      return { kind: "idle" };
    default:
      return assertNever(intent, "Unhandled commerce graph value");
  }
}

function renderCommerceBoardPresenceEntry(
  entry: CommerceBoardPresenceEntry,
): React.ReactNode {
  const activity =
    entry.dragPreview.kind === "moving" ? "changing a lane" : "viewing";
  return (
    <li key={entry.userId}>
      <span aria-hidden="true">
        {commercePresenceInitial(entry.displayName)}
      </span>
      {entry.displayName} · {activity}
    </li>
  );
}

function commercePresenceInitial(displayName: string): string {
  return Array.from(displayName)[0]?.toUpperCase() ?? "?";
}

function commerceStatusOptionLabel(
  model: CommercePublishedCollectionModel,
  statusAttributeId: AttributeDefinitionId,
  statusOptionId: string,
): string {
  if (model.list === null) return statusOptionId;
  const definition = findListEntryDefinition(
    model.list.entryAttributeDefinitions,
    statusAttributeId,
  );
  if (definition?.definition.kind.kind !== "status") return statusOptionId;
  for (const option of definition.definition.kind.options) {
    if (option.id === statusOptionId) return option.label;
  }
  return statusOptionId;
}

function selectCommerceTableStatus(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
  entry: CommerceListEntry,
  label: string,
  statusAttributeId: AttributeDefinitionId,
  value: string | null,
): void {
  if (value === null) return;
  void moveCommerceListEntryStatus(
    model,
    interaction,
    entry,
    label,
    statusAttributeId,
    value,
    false,
  );
}

function selectCommerceBoardLane(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
  entry: CommerceListEntry,
  label: string,
  value: string | null,
): void {
  if (value === null) return;
  void moveCommerceBoardEntry(model, interaction, entry, label, value, false);
}

async function moveCommerceBoardEntry(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
  entry: CommerceListEntry,
  label: string,
  desiredStatus: string,
  allowPendingIntent: boolean,
): Promise<void> {
  if (model.board === null) return;
  await moveCommerceListEntryStatus(
    model,
    interaction,
    entry,
    label,
    model.board.configuration.laneAttributeId,
    desiredStatus,
    allowPendingIntent,
  );
}

async function moveCommerceListEntryStatus(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
  entry: CommerceListEntry,
  label: string,
  statusAttributeId: AttributeDefinitionId,
  desiredStatus: string,
  allowPendingIntent: boolean,
): Promise<void> {
  if (
    model.list === null ||
    interaction.mutate === undefined ||
    !interaction.canOperate ||
    (!allowPendingIntent &&
      commerceBoardIntentBlocksMutation(interaction.intent))
  )
    return;
  const desiredStatusLabel = commerceStatusOptionLabel(
    model,
    statusAttributeId,
    desiredStatus,
  );
  interaction.setIntent({
    kind: "saving",
    entryId: String(entry.entryId),
    listId: String(entry.listId),
    entryRevision: entry.revision,
    merchantRevision: model.merchantRevision,
    statusAttributeId,
    desiredStatus,
    desiredStatusLabel,
    label,
  });
  try {
    const outcome = await patchCommerceListEntryStatus(
      interaction.organisationId,
      model.list,
      entry,
      statusAttributeId,
      desiredStatus,
      interaction.mutate,
    );
    switch (outcome.kind) {
      case "executed":
        interaction.setIntent({ kind: "saved", label, desiredStatusLabel });
        toast.success(`${label} moved to ${desiredStatusLabel}.`);
        interaction.refresh(incrementCommerceRefreshRevision);
        return;
      case "approval_requested":
        interaction.setIntent({
          kind: "approval_requested",
          entryId: String(entry.entryId),
          listId: String(entry.listId),
          entryRevision: entry.revision,
          merchantRevision: model.merchantRevision,
          statusAttributeId,
          desiredStatus,
          desiredStatusLabel,
          label,
          action: outcome.action,
        });
        return;
      default:
        return assertNever(outcome, "Unhandled commerce graph value");
    }
  } catch (error) {
    const intent = {
      entryId: String(entry.entryId),
      listId: String(entry.listId),
      entryRevision: entry.revision,
      merchantRevision: model.merchantRevision,
      statusAttributeId,
      desiredStatus,
      desiredStatusLabel,
      label,
    } as const;
    if (
      error instanceof ControlApiError &&
      error.kind === "commerce_revision_conflict"
    ) {
      interaction.setIntent({ kind: "stale", ...intent });
      interaction.refresh(incrementCommerceRefreshRevision);
      return;
    }
    const permission = permissionRequiredOf(error);
    interaction.setIntent({
      kind: "failed",
      ...intent,
      message:
        permission !== null
          ? `Moving ${label} needs a permission that was not allowed.`
          : error instanceof Error
            ? error.message
            : "The list entry could not be changed.",
      permission,
    });
  }
}

function renderCommerceListEntryStatusIntent(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
): React.ReactNode {
  const intent = interaction.intent;
  if (intent.kind === "approval_requested") {
    return (
      <Notice tone="neutral" announcement="none">
        Approval requested for {intent.label} to change to{" "}
        {intent.desiredStatusLabel}. Review the change in Operations. The
        connected commerce system has not changed.
      </Notice>
    );
  }
  if (intent.kind === "stale") {
    return (
      <Notice tone="warning" announcement="none">
        {intent.label} changed in another session. Review its latest values,
        then retry the change to {intent.desiredStatusLabel}.
        <span className="commerce-board-intent-actions">
          <button
            type="button"
            onClick={retryCommerceListEntryStatus.bind(
              null,
              model,
              interaction,
            )}
          >
            Retry change
          </button>
          <button
            type="button"
            onClick={discardCommerceListEntryStatus.bind(null, interaction)}
          >
            Discard change
          </button>
        </span>
      </Notice>
    );
  }
  if (intent.kind === "failed") {
    return (
      <Notice tone="warning" announcement="none">
        {intent.message}
        {intent.permission != null && (
          <PermissionRequiredPrompt
            organisationId={interaction.organisationId}
            permission={intent.permission}
            action={`Moving ${intent.label}`}
            grantScope="for this entry only"
            onAllowed={retryCommerceListEntryStatus.bind(
              null,
              model,
              interaction,
            )}
            onClose={closeCommerceListEntryPermission.bind(
              null,
              interaction,
              intent,
            )}
          />
        )}
        <span className="commerce-board-intent-actions">
          <button
            type="button"
            onClick={retryCommerceListEntryStatus.bind(
              null,
              model,
              interaction,
            )}
          >
            Retry change
          </button>
          <button
            type="button"
            onClick={discardCommerceListEntryStatus.bind(null, interaction)}
          >
            Discard change
          </button>
        </span>
      </Notice>
    );
  }
  return null;
}

function retryCommerceListEntryStatus(
  model: CommercePublishedCollectionModel,
  interaction: CommerceBoardInteraction,
): void {
  const intent = interaction.intent;
  if (intent.kind !== "stale" && intent.kind !== "failed") return;
  const row = model.rows.find(
    (candidate) =>
      String(candidate.entry.entryId) === intent.entryId &&
      String(candidate.entry.listId) === intent.listId,
  );
  if (row === undefined) {
    interaction.setIntent({
      ...intent,
      kind: "failed",
      message: "This list entry is no longer available.",
    });
    return;
  }
  void moveCommerceListEntryStatus(
    model,
    interaction,
    row.entry,
    intent.label,
    intent.statusAttributeId,
    intent.desiredStatus,
    true,
  );
}

function discardCommerceListEntryStatus(
  interaction: CommerceBoardInteraction,
): void {
  interaction.setIntent({ kind: "idle" });
}

/** Keeps the failed move, so that Retry change stays, without the prompt. */
function closeCommerceListEntryPermission(
  interaction: CommerceBoardInteraction,
  intent: Variant<CommerceBoardMoveIntent, "failed">,
): void {
  interaction.setIntent({ ...intent, permission: null });
}

function commerceListEntryStatusAnnouncement(
  intent: CommerceBoardMoveIntent,
): string {
  switch (intent.kind) {
    case "idle":
      return "";
    case "saved":
      return `${intent.label} changed to ${intent.desiredStatusLabel}.`;
    case "dragging":
      return `Moving ${intent.label}. Choose a destination lane.`;
    case "saving":
      return `Changing ${intent.label} to ${intent.desiredStatusLabel}.`;
    case "approval_requested":
      return `Approval requested for ${intent.label} to change to ${intent.desiredStatusLabel}.`;
    case "stale":
      return `${intent.label} changed in another session. The intended change to ${intent.desiredStatusLabel} is preserved.`;
    case "failed":
      return intent.message;
    default:
      return assertNever(intent, "Unhandled commerce graph value");
  }
}

function commerceBoardIntentBlocksMutation(
  intent: CommerceBoardMoveIntent,
): boolean {
  switch (intent.kind) {
    case "idle":
    case "saved":
      return false;
    case "dragging":
    case "saving":
    case "approval_requested":
    case "stale":
    case "failed":
      return true;
    default:
      return assertNever(intent, "Unhandled commerce graph value");
  }
}

function collectionSourceLabel(
  model: CommercePublishedCollectionModel,
): string {
  return model.mode === "commerce_list" ? model.list.name : model.view.name;
}

function CommerceEntityTable(
  props: Readonly<{
    props: CommerceEntityPlaneRouteProps;
    state: Variant<CommerceGraphRouteState, "table">;
    queryText: string;
    setQueryText: React.Dispatch<React.SetStateAction<string>>;
    loadMore: () => void;
  }>,
): React.ReactNode {
  const [pendingQuery, setPendingQuery] = React.useState(props.queryText);
  const model = buildEntityTypeTableModel(props.state.result, {
    origin: "system",
    typeId: pageEntityType(props.state.page),
  });
  const title = commercePageEntityLabel(props.state.page);
  return (
    <section
      className="portal-band commerce-panel commerce-entity-list"
      aria-labelledby="commerce-entity-table-title"
    >
      <h2 id="commerce-entity-table-title" className="visually-hidden">
        {title}
      </h2>
      <form
        className="commerce-search"
        onSubmit={submitCommerceEntitySearch.bind(
          null,
          pendingQuery,
          props.setQueryText,
        )}
      >
        <label htmlFor="commerce-entity-search" className="visually-hidden">
          Search {title.toLocaleLowerCase()}
        </label>
        <div>
          <span className="commerce-search-field">
            <Search size={18} aria-hidden="true" />
            <input
              id="commerce-entity-search"
              type="search"
              value={pendingQuery}
              onChange={setCommerceEntitySearch.bind(null, setPendingQuery)}
              placeholder={`Search ${title.toLocaleLowerCase()}…`}
            />
          </span>
          <button type="submit" className="secondary">
            Search
          </button>
        </div>
      </form>
      {renderCommerceEntityColumnTable(
        props.props,
        title,
        model.rows,
        props.queryText.trim().length === 0
          ? `No ${title.toLocaleLowerCase()} yet`
          : `No ${title.toLocaleLowerCase()} match “${props.queryText.trim()}”`,
        props.queryText.trim().length === 0
          ? "Records appear here as soon as the connected commerce system syncs them."
          : "Check the spelling, or clear the search to see everything.",
      )}
      {props.state.result.nextCursor === null ? null : (
        <button
          type="button"
          className="commerce-load-more"
          onClick={props.loadMore}
          disabled={props.state.loadingMore}
        >
          {props.state.loadingMore ? "Loading more…" : "Load more"}
        </button>
      )}
    </section>
  );
}

function renderCommerceEntityColumnTable(
  props: CommerceEntityPlaneRouteProps,
  title: string,
  rows: ReturnType<typeof buildEntityTypeTableModel>["rows"],
  emptyTitle: string,
  emptyDescription: string,
): React.ReactNode {
  const entities = rows.map(commerceTableEntity);
  const attributeIds = entityTableAttributeIds(entities);
  const columns: CrmColumn<CommerceEntity>[] = [
    {
      id: "name",
      label: title.replace(/s$/u, ""),
      width: 260,
      kind: "text",
      value: commerceEntityName,
      render: renderCommerceEntityName.bind(null, props.resourceHref),
    },
    ...attributeIds.map(commerceEntityAttributeColumn.bind(null, entities)),
  ];
  return (
    <CrmTable
      label={title}
      rows={entities}
      columns={columns}
      rowId={commerceEntityId}
      rowLabel={commerceEntityName}
      initialPinned={["name"]}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
    />
  );
}

function commerceTableEntity(
  row: ReturnType<typeof buildEntityTypeTableModel>["rows"][number],
): CommerceEntity {
  return row.entity;
}

function CommerceEntityDossier(
  props: Readonly<{
    props: CommerceEntityPlaneRouteProps;
    page: "products" | "orders" | "suppliers";
    result: CommerceGraphQueryResult;
    activity: CommerceActivityRouteState;
  }>,
): React.ReactNode {
  const typeId =
    props.page === "products"
      ? "product"
      : props.page === "orders"
        ? "order"
        : SUPPLIER_ENTITY_TYPE_ID;
  const origin = props.page === "suppliers" ? "custom" : "system";
  const entity = props.result.entities.find(
    (candidate) =>
      candidate.reference.origin === origin &&
      candidate.reference.typeId === typeId,
  );
  if (entity === undefined) {
    return (
      <EmptyState
        title="Record not found"
        detail="This commerce record is no longer available."
        action={
          <button
            type="button"
            onClick={backToCommerceCollection.bind(
              null,
              props.props.onBack,
              props.page,
            )}
          >
            Back
          </button>
        }
      />
    );
  }
  const dossier = buildCommerceEntityDossierModel(
    props.result,
    entity.reference,
  );
  if (!dossier.ok)
    return (
      <Notice tone="warning" announcement="polite">
        The commerce dossier could not be assembled.
      </Notice>
    );
  return (
    <CommerceEntityDossierView
      model={dossier.value}
      page={props.page}
      activity={props.activity}
      resourceHref={props.props.resourceHref}
      onBack={backToCommerceCollection.bind(
        null,
        props.props.onBack,
        props.page,
      )}
      organisationId={props.props.organisationId}
      fetcher={props.props.fetcher}
      canPropose={props.props.canManage === true}
      commerceOperations={props.props.commerceOperations}
      descriptionDraftActions={props.props.descriptionDraftActions}
      onActionProposed={props.props.onActionProposed}
      actionBusy={props.props.actionBusy === true}
    />
  );
}

function CommerceEntityDossierView(
  props: Readonly<{
    model: CommerceEntityDossierModel;
    page: "products" | "orders" | "suppliers";
    activity: CommerceActivityRouteState;
    resourceHref: CommerceEntityPlaneRouteProps["resourceHref"];
    onBack: () => void;
    organisationId: string;
    fetcher: CommerceGraphFetch | undefined;
    canPropose: boolean;
    commerceOperations: CommerceOperationsTransport | undefined;
    descriptionDraftActions: ProductDescriptionActionTransport | undefined;
    onActionProposed: ((action: CommerceActionRecord) => void) | undefined;
    actionBusy: boolean;
  }>,
): React.ReactNode {
  const label = commerceEntityName(props.model.entity);
  useDossierSurface(props.page, props.model, label);
  const noAttributes = props.model.entity.attributes.length === 0;
  const labelIsDisplayName = label === props.model.entity.displayName;
  // A supplier is a record of its own with no source; the first source would
  // be that of a linked item.
  const supplier = props.page === "suppliers";
  const source = supplier ? null : commerceDossierSource(props.model);
  const relationships = seedIncidentRelationships(props.model);
  // A section with nothing in it is left out.
  const items =
    relationships.length === 0 ? null : (
      <section
        className="commerce-dossier-section"
        aria-labelledby="commerce-relationships-title"
      >
        <h3 id="commerce-relationships-title">
          {supplier ? "Items they supply" : "Related records"}
        </h3>
        <ul className="commerce-relationship-list">
          {relationships.map(
            renderRelationship.bind(
              null,
              props.model.traversal.entities,
              props.model.entity.reference,
              props.resourceHref,
              !supplier,
            ),
          )}
        </ul>
      </section>
    );
  const history = (
    <>
      {props.model.contextualListEntries.length === 0 ? null : (
        <section
          className="commerce-dossier-section"
          aria-labelledby="commerce-list-context-title"
        >
          <h3 id="commerce-list-context-title">Operational details</h3>
          <dl className="commerce-facts">
            {props.model.contextualListEntries.flatMap(
              renderContextualListEntry,
            )}
          </dl>
        </section>
      )}
      <CommerceActivityPanel activity={props.activity} />
    </>
  );
  // A record heads its own page: the record's name is the page title.
  return (
    <section
      className="portal-band commerce-panel commerce-dossier commerce-record"
      aria-labelledby="portal-page-title"
    >
      <button type="button" className="commerce-back" onClick={props.onBack}>
        <ArrowLeft size={16} aria-hidden="true" />
        Back to {workspacePageDescriptor(props.page).navigationLabel}
      </button>
      <div className="section-heading">
        <h1 id="portal-page-title" tabIndex={-1}>
          {label}
        </h1>
        {source === null ? null : <p>{source}</p>}
      </div>
      <DossierFreshnessNotice entity={props.model.entity} />
      <OrderCancellationControl
        organisationId={props.organisationId}
        page={props.page}
        entity={props.model.entity}
        canPropose={props.canPropose}
        commerceOperations={props.commerceOperations}
        onActionProposed={props.onActionProposed}
        actionBusy={props.actionBusy}
      />
      {supplier ? (
        <SupplierRecordDetails
          organisationId={props.organisationId}
          fetcher={props.fetcher}
          entity={props.model.entity}
          items={items}
          history={history}
        />
      ) : (
        <>
          <section
            className="commerce-dossier-section"
            aria-labelledby="commerce-attributes-title"
          >
            <h3 id="commerce-attributes-title">Details</h3>
            {props.page === "products" ? (
              <ProductSaleDetails
                organisationId={props.organisationId}
                productId={props.model.entity.reference.entityId}
                canEdit={props.canPropose}
              />
            ) : null}
            {props.page === "products" && noAttributes ? null : noAttributes &&
              labelIsDisplayName ? (
              <p className="empty-state commerce-empty">
                This record has no details yet.
              </p>
            ) : (
              <dl className="commerce-facts">
                {props.model.entity.attributes.map(renderEntityAttribute)}
                {labelIsDisplayName ? null : (
                  <div className="commerce-fact-prose">
                    <dt>ID</dt>
                    <dd>{props.model.entity.displayName}</dd>
                  </div>
                )}
              </dl>
            )}
          </section>
          <ProductDescriptionDraftControl
            key={`${props.organisationId}:${props.model.entity.reference.entityId}`}
            organisationId={props.organisationId}
            entity={props.model.entity}
            canPropose={props.canPropose}
            actionTransport={props.descriptionDraftActions}
            onActionProposed={props.onActionProposed}
            actionBusy={props.actionBusy}
          />
          {items}
          {history}
        </>
      )}
    </section>
  );
}

/** One line when the record may be out of date; nothing when it is current. */
function DossierFreshnessNotice(props: {
  readonly entity: CommerceEntity;
}): React.ReactNode {
  const freshness =
    "freshness" in props.entity ? props.entity.freshness : undefined;
  if (freshness === undefined) return null;
  switch (freshness.state) {
    case "current":
      return null;
    case "stale":
      return (
        <Notice tone="warning" announcement="none">
          This record may be out of date. Last checked{" "}
          {formatCommerceTimestamp(freshness.observedAt)}.
        </Notice>
      );
    case "unavailable":
      return (
        <Notice tone="warning" announcement="none">
          Purin Pantry cannot confirm that this record is current.
        </Notice>
      );
    default:
      return assertNever(freshness, "Unhandled commerce graph value");
  }
}

type OrderCancellationControlState =
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

type CancellableOrderEntity = CommerceEntity &
  Readonly<{
    reference: Readonly<{
      origin: "system";
      typeId: "order";
      entityId: string;
    }>;
    provenance: SourceProvenance;
  }>;

export function OrderCancellationControl(
  props: Readonly<{
    organisationId: string;
    page: "products" | "orders" | "suppliers";
    entity: CommerceEntity;
    canPropose: boolean;
    commerceOperations: CommerceOperationsTransport | undefined;
    onActionProposed: ((action: CommerceActionRecord) => void) | undefined;
    actionBusy: boolean;
  }>,
): React.ReactNode {
  const [state, setState] = React.useState<OrderCancellationControlState>({
    kind: "idle",
  });
  const [open, setOpen] = React.useState(false);
  const dialog = React.useRef<HTMLDialogElement>(null);
  React.useEffect(syncDialog.bind(null, dialog, open), [open]);
  const transport = props.commerceOperations;
  const onActionProposed = props.onActionProposed;
  if (
    props.page !== "orders" ||
    !props.canPropose ||
    transport === undefined ||
    onActionProposed === undefined ||
    !isCancellableOrderEntity(props.entity) ||
    isClosedOrderEntity(props.entity)
  ) {
    return null;
  }
  const commerceEngine = props.entity.provenance.source === "commerce";
  const disabled =
    props.actionBusy ||
    state.kind === "submitting" ||
    state.kind === "submitted";
  const close = closeOrderCancellation.bind(null, setOpen);
  return (
    <section
      className="commerce-dossier-actions"
      aria-labelledby="commerce-order-cancellation-title"
    >
      <h3 id="commerce-order-cancellation-title" className="visually-hidden">
        Cancel order
      </h3>
      <button
        type="button"
        className="commerce-danger-action"
        onClick={openOrderCancellation.bind(null, setOpen)}
      >
        Cancel order
      </button>
      {state.kind === "submitted" ? (
        <Notice tone="neutral" announcement="polite">
          Cancellation proposal ready for review.
        </Notice>
      ) : null}
      {/* The dialog's children render unconditionally so the sheet's content is
          part of the document before it is shown. */}
      <dialog
        className="access35-dialog"
        ref={dialog}
        aria-labelledby="commerce-order-cancellation-dialog-title"
        onCancel={cancelDialog.bind(null, close)}
      >
        <form
          aria-busy={state.kind === "submitting"}
          onSubmit={submitOrderCancellationForm.bind(
            null,
            props.organisationId,
            props.entity,
            transport,
            onActionProposed,
            setState,
            setOpen,
          )}
        >
          <DialogHeading
            id="commerce-order-cancellation-dialog-title"
            title="Cancel order"
            close={close}
          />
          <p>
            This asks an owner or admin to approve the cancellation. Nothing
            changes at the connected store until they do.
          </p>
          <dl className="access35-dialog-review">
            <div>
              <dt>Order</dt>
              <dd>{commerceEntityName(props.entity)}</dd>
            </div>
          </dl>
          <label>
            <span>Reason</span>
            <Select.Root
              name="reason"
              items={COMMERCE_CANCELLATION_REASONS}
              defaultValue="customer_requested"
              disabled={disabled}
            >
              {renderCommerceSelectParts(COMMERCE_CANCELLATION_REASONS)}
            </Select.Root>
          </label>
          {commerceEngine ? (
            <dl className="access35-dialog-review">
              <div>
                <dt>Refund</dt>
                <dd>Full refund</dd>
              </div>
              <div>
                <dt>Inventory</dt>
                <dd>Restock items</dd>
              </div>
              <div>
                <dt>Customer notification</dt>
                <dd>Managed outside this cancellation</dd>
              </div>
            </dl>
          ) : (
            <>
              <label>
                <span>Refund</span>
                <Select.Root
                  name="refund"
                  items={COMMERCE_CANCELLATION_REFUNDS}
                  defaultValue="full"
                  disabled={disabled}
                >
                  {renderCommerceSelectParts(COMMERCE_CANCELLATION_REFUNDS)}
                </Select.Root>
              </label>
              <label className="commerce-dialog-check">
                <input
                  name="restock"
                  type="checkbox"
                  defaultChecked
                  disabled={disabled}
                />{" "}
                Restock items
              </label>
              <label className="commerce-dialog-check">
                <input
                  name="notifyCustomer"
                  type="checkbox"
                  defaultChecked
                  disabled={disabled}
                />{" "}
                Notify customer
              </label>
              <label>
                <span>Internal note (optional)</span>
                <textarea name="note" maxLength={500} disabled={disabled} />
              </label>
            </>
          )}
          {state.kind === "failed" ? (
            <p className="error-text" role="alert">
              {state.message}
            </p>
          ) : null}
          {state.kind === "failed" && state.permission !== null ? (
            <PermissionRequiredPrompt
              organisationId={props.organisationId}
              permission={state.permission.required}
              action="Review cancellation"
              grantScope="for this order only"
              onAllowed={retryOrderCancellation.bind(
                null,
                {
                  organisationId: props.organisationId,
                  entity: props.entity,
                  formData: state.permission.formData,
                  transport,
                },
                onActionProposed,
                setState,
                setOpen,
              )}
              onClose={setState.bind(null, { ...state, permission: null })}
            />
          ) : null}
          <div className="access35-dialog-actions">
            <button
              type="button"
              className="secondary"
              autoFocus
              onClick={close}
            >
              Keep order
            </button>
            <button
              type="submit"
              className="connection-primary-action"
              disabled={disabled}
            >
              {state.kind === "submitting"
                ? "Creating proposal…"
                : "Review cancellation"}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

function openOrderCancellation(
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  setOpen(true);
}

function closeOrderCancellation(
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  setOpen(false);
}

export async function proposeOrderCancellation(
  input: Readonly<{
    organisationId: string;
    entity: CommerceEntity;
    formData: FormData;
    transport: CommerceOperationsTransport;
  }>,
): Promise<CommerceActionRecord> {
  if (!isCancellableOrderEntity(input.entity)) {
    throw new Error(
      "Order cancellation is unavailable for this commerce source.",
    );
  }
  const action = buildOrderCancellationAction(input.entity, input.formData);
  const raw = await input.transport.proposeAction(
    input.organisationId,
    action,
    `commerce-order-cancel:${action.resourceId}:${action.expectedRevision}`,
  );
  return parseCommerceActionRecordResponse(raw);
}

function submitOrderCancellationForm(
  organisationId: string,
  entity: CommerceEntity,
  transport: CommerceOperationsTransport,
  onActionProposed: (action: CommerceActionRecord) => void,
  setState: React.Dispatch<React.SetStateAction<OrderCancellationControlState>>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  setState({ kind: "submitting" });
  void submitOrderCancellation(
    {
      organisationId,
      entity,
      formData: new FormData(event.currentTarget),
      transport,
    },
    onActionProposed,
    setState,
    setOpen,
  );
}

/** Sends the same cancellation again after the permission was allowed. */
function retryOrderCancellation(
  input: Parameters<typeof proposeOrderCancellation>[0],
  onActionProposed: (action: CommerceActionRecord) => void,
  setState: React.Dispatch<React.SetStateAction<OrderCancellationControlState>>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  setState({ kind: "submitting" });
  void submitOrderCancellation(input, onActionProposed, setState, setOpen);
}

async function submitOrderCancellation(
  input: Parameters<typeof proposeOrderCancellation>[0],
  onActionProposed: (action: CommerceActionRecord) => void,
  setState: React.Dispatch<React.SetStateAction<OrderCancellationControlState>>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): Promise<void> {
  try {
    const action = await proposeOrderCancellation(input);
    onActionProposed(action);
    setState({ kind: "submitted" });
    setOpen(false);
    toast.success("Cancellation sent for approval.");
  } catch (error) {
    // The dialog stays open so the operator can retry without re-entering the
    // reason they already chose.
    const permission = permissionRequiredOf(error);
    setState({
      kind: "failed",
      message:
        permission !== null
          ? "Sending this cancellation for approval needs a permission that was not allowed."
          : "The cancellation could not be sent for approval. Refresh the order and try again.",
      permission:
        permission === null
          ? null
          : { required: permission, formData: input.formData },
    });
  }
}

function buildOrderCancellationAction(
  entity: CancellableOrderEntity,
  formData: FormData,
): OrderCancellationAction {
  const reason = orderCancellationReason(formText(formData, "reason"));
  if (reason === null) throw new Error("Order cancellation reason is invalid.");
  if (entity.provenance.source === "commerce") {
    return {
      kind: "cancel_order",
      resourceId: entity.provenance.resourceId,
      expectedRevision: entity.provenance.revision,
      reason,
      refund: "full",
      restock: true,
      notifyCustomer: false,
      note: null,
    };
  }
  const refund = orderCancellationRefund(formText(formData, "refund"));
  if (refund === null)
    throw new Error("Order cancellation refund choice is invalid.");
  const noteValue = formText(formData, "note");
  const note =
    noteValue === null || noteValue.trim().length === 0
      ? null
      : noteValue.trim();
  return {
    kind: "cancel_order",
    resourceId: entity.provenance.resourceId,
    expectedRevision: entity.provenance.revision,
    reason,
    refund,
    restock: formData.has("restock"),
    notifyCustomer: formData.has("notifyCustomer"),
    note,
  };
}

function isCancellableOrderEntity(
  entity: CommerceEntity,
): entity is CancellableOrderEntity {
  return (
    entity.reference.origin === "system" &&
    entity.reference.typeId === "order" &&
    "provenance" in entity &&
    entity.provenance !== undefined &&
    commerceSourceSupportsOrderCancellation(entity.provenance.source)
  );
}

/** A fulfilled or cancelled order has nothing left to cancel. */
function isClosedOrderEntity(entity: CommerceEntity): boolean {
  const lifecycle = findEntityAttribute(entity, "lifecycle");
  return (
    lifecycle?.value.kind === "status" &&
    (String(lifecycle.value.value) === "fulfilled" ||
      String(lifecycle.value.value) === "cancelled")
  );
}

function commerceSourceSupportsOrderCancellation(
  source: SourceProvenance["source"],
): boolean {
  switch (source) {
    case "lab":
    case "shopify":
    case "commerce":
      return true;
    case "stripe":
      return false;
    default:
      return assertNever(source, "Unhandled commerce graph value");
  }
}

function orderCancellationReason(
  value: string | null,
): OrderCancellationAction["reason"] | null {
  return value === "customer_requested" ||
    value === "fraud_suspected" ||
    value === "inventory_unavailable"
    ? value
    : null;
}

function orderCancellationRefund(
  value: string | null,
): OrderCancellationAction["refund"] | null {
  return value === "full" || value === "none" ? value : null;
}

function formText(formData: FormData, field: string): string | null {
  const value = formData.get(field);
  return typeof value === "string" ? value : null;
}

/**
 * A linked record; `showKind` adds what the link is, when no heading says it.
 * Without it, as under "Items they supply", a link row ends in a chevron.
 */
function renderRelationship(
  entities: readonly CommerceEntity[],
  seed: CommerceEntityRef,
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  showKind: boolean,
  relationship: CommerceRelationship,
): React.ReactNode {
  const related = sameEntityRef(relationship.source, seed)
    ? relationship.target
    : relationship.source;
  const entity = entities.find((candidate) =>
    sameEntityRef(candidate.reference, related),
  );
  const link =
    entity === undefined ? null : entityResourceLink(resourceHref, entity);
  const label =
    entity === undefined
      ? entityReferenceLabel(related)
      : commerceEntityName(entity);
  return (
    <li key={`${relationship.origin}:${relationship.relationshipId}`}>
      {link === null ? (
        <strong>{label}</strong>
      ) : (
        <Link to={link}>
          <strong>{label}</strong>
        </Link>
      )}
      {showKind ? (
        <span>
          {commerceRelationshipLabel(
            String(relationship.definition.definitionId),
          )}
        </span>
      ) : link === null ? null : (
        <ChevronRight size={16} aria-hidden="true" />
      )}
    </li>
  );
}

function renderEntityAttribute(
  attribute: CommerceEntity["attributes"][number],
): React.ReactNode {
  // System entity attributes arrive without their definitions, so the label is
  // humanized from the identifier and a status renders as humanized text.
  const chip = commerceStatusChip(attribute.value, undefined);
  return (
    <div
      key={attribute.attributeId}
      className={
        attribute.value.kind === "long_text" ? "commerce-fact-prose" : undefined
      }
    >
      <dt>
        {commerceAttributeLabel(String(attribute.attributeId), undefined)}
      </dt>
      <dd
        className={
          isNumericCommerceValue(attribute.value)
            ? "commerce-numeric"
            : undefined
        }
      >
        {chip === null ? (
          formatCommerceAttributeValue(attribute.value, undefined)
        ) : (
          <StatusChip status={chip} />
        )}
      </dd>
    </div>
  );
}

async function loadMoreCommerceEntityTable(
  props: CommerceEntityPlaneRouteProps,
  state: Variant<CommerceGraphRouteState, "table">,
  requestRevision: React.MutableRefObject<CommerceGraphRequestRevision>,
  setState: React.Dispatch<React.SetStateAction<CommerceGraphRouteState>>,
): Promise<void> {
  if (state.result.nextCursor === null || state.loadingMore) return;
  const revision = requestRevision.current.current;
  // The route keeps the cursor bound to the server result; a changed source watermark is rejected by the graph API.
  const typeId = pageEntityType(state.page);
  const query =
    state.queryText.trim().length === 0
      ? entityTypePageQuery(typeId, {
          limit: 50,
          cursor: state.result.nextCursor,
        })
      : searchEntityTypeQuery(state.queryText.trim(), typeId, {
          limit: 50,
          cursor: state.result.nextCursor,
        });
  setState((current) =>
    current.kind === "table" && current.result === state.result
      ? { ...current, loadingMore: true }
      : current,
  );
  try {
    const result = await readCommerceGraph(
      props.organisationId,
      query,
      props.fetcher,
    );
    if (requestRevision.current.current !== revision) return;
    setState((current) =>
      current.kind === "table" && current.result === state.result
        ? {
            ...current,
            result: mergeCommerceGraphResults(current.result, result),
            loadingMore: false,
          }
        : current,
    );
  } catch {
    setState((current) =>
      current.kind === "table" && current.result === state.result
        ? { ...current, loadingMore: false }
        : current,
    );
  }
}

/**
 * Typing edits only local state; the query applies on submit so the table
 * does not reload and flash its skeleton on every keystroke.
 */
function submitCommerceEntitySearch(
  pendingQuery: string,
  setQueryText: React.Dispatch<React.SetStateAction<string>>,
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  setQueryText(pendingQuery.trim());
}

function setCommerceEntitySearch(
  setPendingQuery: React.Dispatch<React.SetStateAction<string>>,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  setPendingQuery(event.currentTarget.value);
}

function renderContextualListEntry(
  entry: CommerceListEntry,
): readonly React.ReactNode[] {
  return entry.attributeValues.map(
    renderContextualListAttribute.bind(null, entry),
  );
}

function renderContextualListAttribute(
  entry: CommerceListEntry,
  attribute: CommerceListEntry["attributeValues"][number],
): React.ReactNode {
  const chip = commerceStatusChip(attribute.value, undefined);
  return (
    <div key={`${entry.listId}:${entry.entryId}:${attribute.attributeId}`}>
      <dt>
        {commerceAttributeLabel(String(attribute.attributeId), undefined)}
      </dt>
      <dd
        className={
          isNumericCommerceValue(attribute.value)
            ? "commerce-numeric"
            : undefined
        }
      >
        {chip === null ? (
          formatCommerceAttributeValue(attribute.value, undefined)
        ) : (
          <StatusChip status={chip} />
        )}
      </dd>
    </div>
  );
}

function pageEntityType(
  page: Exclude<CommerceGraphPage, "suppliers">,
): "product" | "order" {
  switch (page) {
    case "products":
      return "product";
    case "orders":
      return "order";
    default:
      return assertNever(page, "Unhandled commerce graph value");
  }
}

function commercePageEntityLabel(
  page: Exclude<CommerceGraphPage, "suppliers">,
): string {
  switch (page) {
    case "products":
      return "Products";
    case "orders":
      return "Orders";
    default:
      return assertNever(page, "Unhandled commerce graph value");
  }
}

function entityResourceLink(
  resourceHref: CommerceEntityPlaneRouteProps["resourceHref"],
  entity: CommerceEntity,
): string | null {
  if (
    entity.reference.origin === "custom" &&
    entity.reference.typeId === SUPPLIER_ENTITY_TYPE_ID
  ) {
    return resourceHref(entity.reference.entityId, "supplier");
  }
  if (entity.reference.origin !== "system") return null;
  if (entity.reference.typeId === "product")
    return resourceHref(entity.reference.entityId, "product");
  if (entity.reference.typeId === "order")
    return resourceHref(entity.reference.entityId, "order");
  return null;
}

function entityReferenceKey(reference: CommerceEntityRef): string {
  return `${reference.origin}:${reference.typeId}:${reference.entityId}`;
}

function entityReferenceLabel(reference: CommerceEntityRef): string {
  return `${reference.typeId}:${reference.entityId}`;
}

/**
 * Only the records linked directly to this one. A two-hop traversal also
 * returns edges between two of those neighbours, which would list a neighbour a
 * second time under the label of a relationship this record is not part of.
 */
function seedIncidentRelationships(
  model: CommerceEntityDossierModel,
): readonly CommerceRelationship[] {
  const seed = model.entity.reference;
  return model.traversal.relationships.filter(
    (relationship) =>
      sameEntityRef(relationship.source, seed) ||
      sameEntityRef(relationship.target, seed),
  );
}

/** Where the record's facts come from, or null when nothing says. */
function commerceDossierSource(model: CommerceEntityDossierModel): string | null {
  const provenance = model.provenance[0];
  return provenance === undefined
    ? null
    : `From ${commerceSourceLabel(String(provenance.source))}`;
}

function sameEntityRef(
  left: CommerceEntityRef,
  right: CommerceEntityRef,
): boolean {
  return (
    left.origin === right.origin &&
    left.typeId === right.typeId &&
    left.entityId === right.entityId
  );
}

function mergeCommerceGraphResults(
  first: CommerceGraphQueryResult,
  second: CommerceGraphQueryResult,
): CommerceGraphQueryResult {
  return {
    merchantRevision: second.merchantRevision,
    entities: [
      ...uniqueBy([...first.entities, ...second.entities], (entity) =>
        entityReferenceKey(entity.reference),
      ),
    ],
    relationships: [
      ...uniqueBy(
        [...first.relationships, ...second.relationships],
        (relationship) =>
          `${relationship.origin}:${relationship.relationshipId}`,
      ),
    ],
    listEntries: [
      ...uniqueBy(
        [...first.listEntries, ...second.listEntries],
        (entry) => `${entry.listId}:${entry.entryId}:${entry.revision}`,
      ),
    ],
    aggregations: [...first.aggregations, ...second.aggregations],
    nextCursor: second.nextCursor,
    provenance: [...first.provenance, ...second.provenance],
    freshness: [...first.freshness, ...second.freshness],
  };
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): readonly T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

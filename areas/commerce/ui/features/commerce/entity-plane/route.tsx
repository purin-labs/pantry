import { OrdersDisplay } from "../../orders/order-time-lanes";
import { Select } from "@purin-labs/ui/select";
import { commerceOptionItem, renderCommerceSelectParts } from "./select-items";
import React from "react";
import { Package, Search, ShoppingCart } from "lucide-react";
import "./record.css";
import "./collection.css";
import { OfferPriceAllowanceSection } from "../price-allowance";
import { Link } from "react-router";
import type {
  AttributeDefinitionId,
  CommerceEntity,
  CommerceEntityRef,
  CommerceGraphQueryResult,
  CommerceListId,
  SavedCommerceViewId,
  CommerceSnapshotRevision,
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
  commerceStatusChip,
  formatCommerceAttributeValue,
} from "./presentation";
import {
  buildPublishedCommerceCollectionModel,
  buildEntityTypeTableModel,
  findCommerceCollectionDefinition,
  type CommerceCollectionRow,
  type CommercePublishedCollectionModel,
} from "./models";
import {
  commerceCollectionQuery,
  customEntityRef,
  entityDossierQuery,
  entityTypePageQuery,
  readCommerceGraph,
  readCommerceChanges,
  searchEntityTypeQuery,
  systemEntityRef,
  readCommerceActivity,
  readPublishedCommerceResources,
  type CommerceGraphFetch,
  type CommerceCollectionSelection,
  type CommercePublishedResourceMetadata,
} from "@purin-labs/area-commerce-contract/ui/features/commerce/entity-plane/api";
import { PurchasingControls } from "./purchasing-controls";
import {
  listAttributeDefinition,
  resolveCommerceReferenceName,
} from "./board-rows";
import {
  NO_SUPPLIER_NAMES,
  isSupplierDirectoryList,
  loadSupplierNames,
} from "./supplier-directory";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import {
  commerceEntityAttributeColumn,
  entityTableAttributeIds,
} from "./entity-attribute-columns";
import type { CommerceActivityRouteState } from "./activity-panel";
import { CrmIdentity, CrmTable, type CrmColumn } from "@purin-labs/ui/index";
import type {
  CommerceBoardInteraction,
  CommerceBoardMoveIntent,
  CommerceChangeWatch,
  CommerceCollectionRouteState,
  CommerceEntityPlaneRouteProps,
  CommerceGraphRequestRevision,
  CommerceGraphRouteState,
  CommercePayoutsTabStatus,
  CommerceRefreshRevisionSetter,
} from "./entity-plane-types";
import {
  COMMERCE_TAB_PARAMETER,
  commerceEntityName,
  incrementCommerceRefreshRevision,
  unchangedCommerceWatchCleanup,
} from "./entity-plane-shared";
import { CommerceEntityDossier, entityResourceLink } from "./entity-dossier";
import { CommerceSavedViewEditor } from "./saved-view-editor";
import {
  commerceBoardIntentBlocksMutation,
  commerceListEntryStatusAnnouncement,
  renderCommerceCollectionBoard,
  renderCommerceListEntryStatusIntent,
  selectCommerceTableStatus,
} from "./collection-board";
export {
  OrderCancellationControl,
  proposeOrderCancellation,
} from "./order-cancellation";

export type CommerceGraphPage = "products" | "orders" | "suppliers";

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

function entityReferenceKey(reference: CommerceEntityRef): string {
  return `${reference.origin}:${reference.typeId}:${reference.entityId}`;
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

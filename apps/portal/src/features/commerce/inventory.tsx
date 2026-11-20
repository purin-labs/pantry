import { Select } from "../../ui/select";
import {
  calculateBakeryCostsAndMargins,
  parseCostsOverview,
  type CalculatedProductMargin,
} from "@purin-labs/control-api";
import {
  parseInventory,
  type ArchivedProduct,
  type InventoryData,
  type StockStatus,
  type StockRow,
  type StockLot,
} from "@purin-labs/commerce-contracts";
import React from "react";
import { Link } from "react-router";
import { controlRead } from "../../control-client";
import { ArrowUpRight, Package, Search } from "lucide-react";
import {
  CrmIdentity,
  CrmTable,
  CrmTag,
  SideDrawer,
  type CrmColumn,
  type CrmRowAction,
} from "../../ui";
import { assertNever } from "@purin-labs/std";
import { formatMoneyMinor } from "../../formatting";
import "./inventory.css";
import { needsReorder } from "./stock-status";
import { InventoryProductionDialog } from "./inventory-production";
import { InventoryReconciliationDialog } from "./inventory-reconciliation";
import { InventoryReceiptDialog } from "./inventory-receipt";
import { InventoryPurchases } from "./inventory-purchases";
import { ViewSwitch } from "../../ui";
import { StockTimeline } from "./stock-timeline";

import {
  ProductActionDialog,
  type ProductAction,
  type ProductRecord,
} from "./product-actions";

const STOCK_VIEWS = [
  { view: "list", name: "List" },
  { view: "timeline", name: "Timeline" },
] as const;
const STOCK_CATEGORIES = [
  { value: "", label: "All categories" },
  { value: "ingredient", label: "Ingredients" },
  { value: "packaging", label: "Packaging" },
  { value: "operating_supply", label: "Operating supplies" },
];
import type { CommerceMutationTransport } from "./entity-plane/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "ready";
      data: InventoryData;
      marginsByProductId: ReadonlyMap<string, CalculatedProductMargin>;
    };
type Filter = "all" | "reorder" | "uncounted" | "expiring" | "archived";
type Props = Readonly<{
  userId: string;
  organisationId: string;
  suppliersHref: string;
  productionHref: string;
  productsHref: string;
  costsHref?: string;
  ordersHref: string;
  view: "supplies" | "products";
  canReceive: boolean;
  canManage: boolean;
  mutate: CommerceMutationTransport;
}>;
type State = {
  load: LoadState;
  search: string;
  location: string;
  category: string;
  filter: Filter;
  selected: string | null;
  display: "list" | "timeline";
  operation: Readonly<{
    kind: "receipt" | "count" | "adjustment" | "production";
    positionId: string;
  }> | null;
  productAction: Readonly<{
    action: ProductAction;
    product: ProductRecord;
  }> | null;
};
type InventoryTableRow =
  | Readonly<{ kind: "tracked"; stock: StockRow; product?: never }>
  | Readonly<{
      kind: "untracked";
      product: InventoryData["untrackedProducts"][number];
      stock?: never;
    }>
  | Readonly<{ kind: "archived"; product: ArchivedProduct; stock?: never }>;
type StockQuantity = "onHand" | "allocated" | "available";

const STATUS_LABELS: Record<StockStatus, string> = {
  uncounted: "Not counted",
  out: "Out of stock",
  low: "Low stock",
  healthy: "In stock",
  unconfigured: "In stock",
};

function belongsToView(view: Props["view"], row: StockRow): boolean {
  return view === "products" ? row.kind !== "supply" : row.kind === "supply";
}
function renderStockLot(lot: StockLot) {
  return (
    <li key={lot.id}>
      <strong>{lot.code}</strong>
      <span>
        {lot.remaining} · {lot.status}
      </span>
      <small>
        {lot.expiresAt === null
          ? "Expiry not tracked"
          : `Expires ${new Date(lot.expiresAt).toLocaleDateString()}`}
      </small>
    </li>
  );
}
function matchesUntracked(
  search: string,
  product: InventoryData["untrackedProducts"][number],
): boolean {
  return product.name.toLowerCase().includes(search.toLowerCase());
}
function availabilityUnknown(
  product: InventoryData["untrackedProducts"][number],
): boolean {
  return !product.madeToOrder;
}
function trackedTableRow(stock: StockRow): InventoryTableRow {
  return { kind: "tracked", stock };
}
function untrackedTableRow(
  product: InventoryData["untrackedProducts"][number],
): InventoryTableRow {
  return { kind: "untracked", product };
}
function archivedTableRow(product: ArchivedProduct): InventoryTableRow {
  return { kind: "archived", product };
}
function matchesArchived(search: string, product: ArchivedProduct): boolean {
  return product.title.toLowerCase().includes(search.toLowerCase());
}
function inventoryRowId(row: InventoryTableRow): string {
  switch (row.kind) {
    case "tracked":
      return `stock-${row.stock.id}`;
    case "untracked":
      return `catalogue-${row.product.variantId}`;
    case "archived":
      return `archived-${row.product.productId}`;
    default:
      return assertNever(row);
  }
}
function inventoryRowName(row: InventoryTableRow): string {
  switch (row.kind) {
    case "tracked":
      return row.stock.name;
    case "untracked":
      return row.product.name;
    case "archived":
      return row.product.title;
    default:
      return assertNever(row);
  }
}
/** The product behind a row; a supply or an unlinked item has none. */
function productRecord(row: InventoryTableRow): ProductRecord | null {
  if (row.kind === "archived")
    return {
      productId: row.product.productId,
      title: row.product.title,
      revision: row.product.revision,
      status: "archived",
      deleteBlock: row.product.deleteBlock,
      sale: null,
    };
  const link = row.kind === "tracked" ? row.stock.product : row.product;
  if (link === null) return null;
  return {
    productId: link.productId,
    title: link.productTitle,
    revision: link.productRevision,
    status: "active",
    deleteBlock: link.deleteBlock,
    sale: {
      description: link.description,
      variantId: link.variantId,
      variantTitle: link.variantTitle,
      variantRevision: link.variantRevision,
      offerId: link.offerId,
      offerRevision: link.offerRevision,
      price: link.price,
    },
  };
}
function canEditProduct(row: InventoryTableRow): boolean {
  return productRecord(row)?.sale != null;
}
function isProductRow(row: InventoryTableRow): boolean {
  return productRecord(row) !== null;
}
function isArchivedRow(row: InventoryTableRow): boolean {
  return row.kind === "archived";
}
function inventoryRowLocation(row: InventoryTableRow): string | null {
  return row.kind === "tracked" ? row.stock.location : null;
}
function renderInventoryLocation(row: InventoryTableRow): React.ReactNode {
  return inventoryRowLocation(row) ?? "—";
}
function renderInventoryQuantity(
  quantity: StockQuantity,
  row: InventoryTableRow,
): React.ReactNode {
  return row.kind === "tracked" ? (row.stock[quantity] ?? "—") : "—";
}
function inventoryStatusLabel(row: InventoryTableRow): string {
  if (row.kind === "archived") return "Archived";
  return row.kind === "tracked"
    ? row.stock.kind === "unlinked_product"
      ? "Product link missing"
      : STATUS_LABELS[row.stock.status]
    : row.product.madeToOrder
      ? "Made to order"
      : "Stock tracking not configured";
}
function renderInventoryRowIcon(row: InventoryTableRow): React.ReactNode {
  const image =
    row.kind === "tracked" ? row.stock.product?.image : row.product.image;
  return image === undefined || image === null ? (
    <Package size={16} />
  ) : (
    <img src={image.url} alt="" loading="lazy" />
  );
}
function renderInventoryPrice(row: InventoryTableRow): React.ReactNode {
  if (row.kind === "archived") return "—";
  const price =
    row.kind === "tracked" ? row.stock.product?.price : row.product.price;
  return price === undefined
    ? "—"
    : formatMoneyMinor(price.amountMinor, price.currency);
}
function renderInventoryStatus(row: InventoryTableRow): React.ReactNode {
  const tone =
    row.kind === "tracked" ? stockStatusTone(row.stock.status) : "neutral";
  return <CrmTag tone={tone}>{inventoryStatusLabel(row)}</CrmTag>;
}
function stockStatusTone(
  status: StockStatus,
): "neutral" | "positive" | "warning" | "negative" {
  switch (status) {
    case "healthy":
      return "positive";
    case "low":
      return "warning";
    case "out":
      return "negative";
    case "uncounted":
    case "unconfigured":
      return "neutral";
    default:
      return assertNever(status);
  }
}
function renderInventoryProductName(
  base: string,
  productId: string,
  identity: React.ReactNode,
): React.ReactNode {
  return (
    <Link to={`${base}/${encodeURIComponent(productId)}`}>{identity}</Link>
  );
}
function inventoryQuantityColumn(
  id: StockQuantity,
  label: string,
): CrmColumn<InventoryTableRow> {
  return {
    id,
    label,
    width: 110,
    align: "end",
    kind: "display",
    render: renderInventoryQuantity.bind(null, id),
  };
}
function needsCount(row: StockRow): boolean {
  return row.status === "uncounted";
}
function locationItems(rows: readonly StockRow[]) {
  const locations = new Map<string, string>();
  for (const row of rows)
    if (row.locationId !== null) locations.set(row.locationId, row.location);
  const items = [{ value: "", label: "All locations" }];
  for (const [id, name] of locations) items.push({ value: id, label: name });
  return items;
}
function stockSelectItem(item: Readonly<{ value: string; label: string }>) {
  return (
    <Select.Item key={item.value} value={item.value}>
      {item.label}
    </Select.Item>
  );
}
function matches(state: State, row: StockRow): boolean {
  return (
    state.filter !== "archived" &&
    (state.location === "" || row.locationId === state.location) &&
    (state.filter === "all" ||
      (state.filter === "reorder"
        ? needsReorder(row)
        : state.filter === "expiring"
          ? expiringSoon(row)
          : needsCount(row))) &&
    (state.category === "" || row.category === state.category) &&
    `${row.name} ${row.category}`
      .toLowerCase()
      .includes(state.search.toLowerCase())
  );
}
function Metric(
  props: Readonly<{ label: string; value: number; description: string }>,
) {
  return (
    <div className="stock-metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <small>{props.description}</small>
    </div>
  );
}

export class InventoryPage extends React.Component<Props, State> {
  state: State = {
    load: { kind: "loading" },
    search: "",
    location: "",
    category: "",
    filter: "all",
    selected: null,
    display: "list",
    operation: null,
    productAction: null,
  };
  private controller: AbortController | null = null;
  componentDidMount() {
    void this.load();
  }
  componentDidUpdate(previous: Props) {
    if (previous.organisationId !== this.props.organisationId) {
      this.setState({ load: { kind: "loading" } });
      void this.load();
    }
    if (
      previous.organisationId !== this.props.organisationId ||
      previous.view !== this.props.view
    ) {
      this.setState({
        search: "",
        location: "",
        category: "",
        filter: "all",
        selected: null,
        display: "list",
        operation: null,
        productAction: null,
      });
    }
  }
  componentWillUnmount() {
    this.controller?.abort();
  }
  async load() {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const orgSegment = encodeURIComponent(this.props.organisationId);
      const [inventory, costs] = await Promise.all([
        controlRead(`/v1/control/organisations/${orgSegment}/commerce/inventory`),
        this.props.view === "products"
          ? controlRead(
              `/v1/control/organisations/${orgSegment}/commerce/costs`,
            ).catch(() => null)
          : Promise.resolve(null),
      ]);
      const data = parseInventory(inventory);
      const marginsByProductId = new Map<string, CalculatedProductMargin>();
      if (costs !== null) {
        try {
          const overview = parseCostsOverview(costs);
          const calculated = calculateBakeryCostsAndMargins({ overview });
          for (const item of calculated.products) {
            marginsByProductId.set(item.productId, item);
          }
        } catch {
          // Product margins remain optional if cost terms are unavailable.
        }
      }
      if (!controller.signal.aborted)
        this.setState({
          load: { kind: "ready", data, marginsByProductId },
          selected:
            this.state.selected ??
            initialStockSelection(data.rows, this.props.view),
        });
    } catch {
      if (!controller.signal.aborted)
        this.setState({ load: { kind: "failed" } });
    }
  }
  changeSearch(event: React.ChangeEvent<HTMLInputElement>) {
    this.setState({ search: event.target.value });
  }
  changeLocation(location: string | null) {
    if (location !== null) this.setState({ location });
  }
  changeCategory(category: string | null) {
    if (category !== null) this.setState({ category });
  }
  changeDisplay(display: State["display"]) {
    this.setState({ display });
  }
  changeFilter(filter: Filter) {
    this.setState({ filter });
  }
  select(id: string | null) {
    this.setState({ selected: id });
  }
  canOperate(row: StockRow): boolean {
    return this.props.canReceive && row.positionId !== null;
  }
  renderStockActions(row: StockRow): React.ReactNode {
    if (row.positionId === null) return null;
    const positionId = row.positionId;
    return (
      <>
        <button
          type="button"
          className="secondary"
          onClick={this.openOperation.bind(this, "count", positionId)}
        >
          Count stock
        </button>
        {this.props.view === "products" ? (
          <>
            <button
              type="button"
              className="secondary"
              onClick={this.openOperation.bind(this, "adjustment", positionId)}
            >
              Adjust stock
            </button>
            <button
              type="button"
              className="secondary"
              onClick={this.openOperation.bind(this, "production", positionId)}
            >
              {row.recipeCount === 0 ? "Link a recipe" : "Request production"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="connection-primary-action"
            onClick={this.openOperation.bind(this, "receipt", positionId)}
          >
            Receive supplies
          </button>
        )}
      </>
    );
  }
  openOperation(
    kind: "receipt" | "count" | "adjustment" | "production",
    positionId: string,
  ) {
    this.setState({ operation: { kind, positionId } });
  }
  closeOperation() {
    this.setState({ operation: null });
  }
  openProductAction(action: ProductAction, row: InventoryTableRow) {
    const product = productRecord(row);
    if (product !== null) this.setState({ productAction: { action, product } });
  }
  switchProductAction(action: ProductAction) {
    if (this.state.productAction !== null)
      this.setState({
        productAction: { action, product: this.state.productAction.product },
      });
  }
  closeProductAction() {
    this.setState({ productAction: null });
  }
  productRowActions(): readonly CrmRowAction<InventoryTableRow>[] {
    return [
      {
        id: "edit",
        label: "Edit",
        available: canEditProduct,
        onSelect: this.openProductAction.bind(this, "edit"),
      },
      {
        id: "archive",
        label: "Archive",
        available: canEditProduct,
        onSelect: this.openProductAction.bind(this, "archive"),
      },
      {
        id: "restore",
        label: "Restore",
        available: isArchivedRow,
        onSelect: this.openProductAction.bind(this, "restore"),
      },
      {
        id: "delete",
        label: "Delete",
        tone: "danger",
        available: isProductRow,
        onSelect: this.openProductAction.bind(this, "delete"),
      },
    ];
  }
  received() {
    void this.load();
  }
  isRowActive(row: InventoryTableRow): boolean {
    return row.kind === "tracked" && this.state.selected === row.stock.id;
  }
  renderProductMargin(row: InventoryTableRow): React.ReactNode {
    if (this.state.load.kind !== "ready" || row.kind === "archived") return "—";
    const productId =
      row.kind === "tracked"
        ? (row.stock.product?.productId ?? null)
        : row.product.productId;
    if (productId === null) return "—";
    const margin = this.state.load.marginsByProductId.get(productId);
    if (margin === undefined || margin.missingCostItemIds.length > 0) return "—";
    const tone =
      margin.netMarginPct < 25
        ? "negative"
        : margin.netMarginPct < 50
          ? "warning"
          : "positive";
    const badge = (
      <CrmTag tone={tone}>
        {formatMoneyMinor(margin.netContributionUnitMinor, margin.currency)} ·{" "}
        {margin.netMarginPct.toFixed(0)}%
      </CrmTag>
    );
    return this.props.costsHref !== undefined ? (
      <Link to={this.props.costsHref}>{badge}</Link>
    ) : (
      badge
    );
  }
  renderName(row: InventoryTableRow): React.ReactNode {
    const identity = (
      <CrmIdentity
        label={inventoryRowName(row)}
        icon={renderInventoryRowIcon(row)}
      />
    );
    if (row.kind !== "tracked")
      return renderInventoryProductName(
        this.props.productsHref,
        row.product.productId,
        identity,
      );
    return (
      <button
        type="button"
        aria-pressed={this.isRowActive(row)}
        onClick={this.select.bind(this, row.stock.id)}
      >
        {identity}
      </button>
    );
  }
  columns(): readonly CrmColumn<InventoryTableRow>[] {
    const products = this.props.view === "products";
    return [
      {
        id: "name",
        label: products ? "Product" : "Item",
        width: 260,
        kind: "text",
        value: inventoryRowName,
        render: this.renderName.bind(this),
      },
      ...(products
        ? [
            {
              id: "price",
              label: "Price",
              width: 96,
              align: "end",
              kind: "display",
              render: renderInventoryPrice,
            } satisfies CrmColumn<InventoryTableRow>,
            {
              id: "margin",
              label: "Unit margin",
              width: 148,
              align: "end",
              kind: "display",
              render: this.renderProductMargin.bind(this),
            } satisfies CrmColumn<InventoryTableRow>,
          ]
        : []),
      {
        id: "location",
        label: "Location",
        width: 160,
        kind: "text",
        value: inventoryRowLocation,
        render: renderInventoryLocation,
      },
      inventoryQuantityColumn("onHand", "On hand"),
      inventoryQuantityColumn("allocated", products ? "Reserved" : "Allocated"),
      inventoryQuantityColumn("available", "Available"),
      {
        id: "status",
        label: "Status",
        width: 180,
        kind: "text",
        value: inventoryStatusLabel,
        render: renderInventoryStatus,
      },
    ];
  }
  render() {
    const load = this.state.load;
    if (load.kind === "loading")
      return <p role="status">Loading stock balances…</p>;
    if (load.kind === "failed")
      return (
        <section className="stock-empty" role="alert">
          <h2>Inventory couldn’t be loaded</h2>
          <p>Your commerce connection may be unavailable.</p>
          <button onClick={this.load.bind(this)}>Try again</button>
        </section>
      );
    const products = this.props.view === "products";
    const rows = load.data.rows.filter(
      belongsToView.bind(null, this.props.view),
    );
    const visible = rows.filter(matches.bind(null, this.state));
    const locations = locationItems(rows);
    const timeline =!products && this.state.display === "timeline";
    const hasRecords =
      rows.length > 0 || (products && load.data.untrackedProducts.length > 0);
    const untracked =
      products &&
      this.state.location === "" &&
      (this.state.filter === "all" || this.state.filter === "uncounted")
        ? load.data.untrackedProducts
            .filter(matchesUntracked.bind(null, this.state.search))
            .filter(
              this.state.filter === "uncounted" ? availabilityUnknown : Boolean,
            )
        : [];
    const archived =
      products && this.state.filter === "archived"
        ? load.data.archivedProducts.filter(
            matchesArchived.bind(null, this.state.search),
          )
        : [];
    let selected: StockRow | null = null;
    for (const row of rows) if (row.id === this.state.selected) selected = row;
    return (
      <div className="stock-page">
        <div className="stock-metrics">
          <Metric
            label={products ? "Product shortages" : "Needs replenishment"}
            value={rows.filter(needsReorder).length}
            description="Low or out of stock"
          />
          <Metric
            label={products ? "Stock records" : "Expiring within 7 days"}
            value={products ? rows.length : rows.filter(expiringSoon).length}
            description={
              products
                ? "Finished goods across locations"
                : "Items with recorded expiry"
            }
          />
          <Metric
            label={products ? "Availability unknown" : "Not counted yet"}
            value={
              rows.filter(needsCount).length +
              (products
                ? load.data.untrackedProducts.filter(availabilityUnknown).length
                : 0)
            }
            description="No balance recorded"
          />
        </div>
        <section className="stock-list" aria-label="Stock levels">
          <div className="stock-toolbar">
            <h2>
              {products
                ? "Products & availability"
                : timeline
                  ? "Expiry and deliveries"
                  : "Stock levels"}
            </h2>
            {products ? null : (
              <a href={this.props.suppliersHref}>
                Suppliers & purchasing <ArrowUpRight size={16} />
              </a>
            )}
          </div>
          <div className="stock-tools">
            <label className="stock-search">
              <Search size={18} />
              <input
                aria-label={products ? "Search products" : "Search inventory"}
                placeholder={
                  products
                    ? "Search products…"
                    : "Search ingredients and supplies…"
                }
                value={this.state.search}
                onChange={this.changeSearch.bind(this)}
              />
            </label>
            <Select.Root
              items={locations}
              value={this.state.location}
              onValueChange={this.changeLocation.bind(this)}
            >
              <Select.Trigger aria-label="Filter by location">
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{locations.map(stockSelectItem)}</Select.Popup>
            </Select.Root>
            {!products && (
              <Select.Root
                items={STOCK_CATEGORIES}
                value={this.state.category}
                onValueChange={this.changeCategory.bind(this)}
              >
                <Select.Trigger aria-label="Filter by category">
                  <Select.Value />
                </Select.Trigger>
                <Select.Popup>
                  {STOCK_CATEGORIES.map(stockSelectItem)}
                </Select.Popup>
              </Select.Root>
            )}
            {!products && (
              <ViewSwitch
                className="stock-display"
                label="Show stock as"
                value={this.state.display}
                views={STOCK_VIEWS}
                onChange={this.changeDisplay.bind(this)}
              />
            )}
          </div>
          {timeline ? null : (
            <div className="stock-filters" aria-label="Stock filters">
              <button
                aria-pressed={this.state.filter === "all"}
                onClick={this.changeFilter.bind(this, "all")}
              >
                {products ? "All products" : "All stock"}
              </button>
              <button
                aria-pressed={this.state.filter === "reorder"}
                onClick={this.changeFilter.bind(this, "reorder")}
              >
                {products ? "Shortages" : "Needs replenishment"}
              </button>
              <button
                aria-pressed={this.state.filter === "uncounted"}
                onClick={this.changeFilter.bind(this, "uncounted")}
              >
                {products ? "Availability unknown" : "Not counted"}
              </button>
              {products && (
                <button
                  aria-pressed={this.state.filter === "archived"}
                  onClick={this.changeFilter.bind(this, "archived")}
                >
                  Archived
                </button>
              )}
              {!products && (
                <button
                  aria-pressed={this.state.filter === "expiring"}
                  onClick={this.changeFilter.bind(this, "expiring")}
                >
                  Expiring within 7 days
                </button>
              )}
              <span>
                {visible.length + untracked.length + archived.length} records
              </span>
            </div>
          )}
          {timeline ? (
            <StockTimeline
              organisationId={this.props.organisationId}
              rows={rows.filter(
                matches.bind(null, { ...this.state, filter: "all" }),
              )}
              onOpen={this.select.bind(this)}
            />
          ) : (
            <CrmTable
              key={this.props.view}
              label={products ? "Products & availability" : "Stock levels"}
              rows={[
                ...visible.map(trackedTableRow),
                ...untracked.map(untrackedTableRow),
                ...archived.map(archivedTableRow),
              ]}
              columns={this.columns()}
              {...(products && this.props.canManage
                ? { actions: this.productRowActions() }
                : {})}
              rowId={inventoryRowId}
              rowLabel={inventoryRowName}
              isRowActive={this.isRowActive.bind(this)}
              initialPinned={["name"]}
              emptyTitle={
                this.state.filter === "archived"
                  ? "No archived products"
                  : hasRecords
                    ? "No matching stock"
                    : "No inventory recorded"
              }
              emptyDescription={
                this.state.filter === "archived"
                  ? "A product that you archive appears here until you restore it."
                  : hasRecords
                    ? "Try another search, location, or stock filter."
                    : "Inventory from your connected commerce system will appear here."
              }
            />
          )}
          {timeline ? null : (
            <p className="stock-footnote">
              Available stock excludes allocations and unusable lots. A dash
              means that quantity hasn’t been reported.
              {products
                ? " A made-to-order product keeps no stock count."
                : null}
            </p>
          )}
        </section>
        <SideDrawer
          open={selected !== null}
          title={selected?.name ?? ""}
          close={this.select.bind(this, null)}
          {...(selected === null || !this.canOperate(selected)
            ? {}
            : { footer: this.renderStockActions(selected) })}
        >
          {selected === null ? null : (
            <div className="side-drawer-body stock-detail">
              {selected.product?.image ? (
                <img
                  className="stock-detail-photo"
                  src={selected.product.image.url}
                  alt={selected.product.image.altText}
                />
              ) : null}
              <div className="stock-detail-summary">
                <p>
                  {selected.location} · {selected.category.replaceAll("_", " ")}
                </p>
                {selected.product?.description ? (
                  <p>{selected.product.description}</p>
                ) : null}
                <CrmTag tone={stockStatusTone(selected.status)}>
                  {STATUS_LABELS[selected.status]}
                </CrmTag>
              </div>
              <div className="stock-detail-balance">
                <small>
                  {products ? "Available to sell" : "Available to use"}
                </small>
                <strong>{selected.available ?? "Not counted yet"}</strong>
              </div>
              <dl>
                {selected.kind === "product" && (
                  <div>
                    <dt>Price</dt>
                    <dd>
                      {formatMoneyMinor(
                        selected.product.price.amountMinor,
                        selected.product.price.currency,
                      )}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>On hand</dt>
                  <dd>{selected.onHand ?? "Not reported"}</dd>
                </div>
                <div>
                  <dt>{products ? "Reserved" : "Allocated"}</dt>
                  <dd>{selected.allocated ?? "Not reported"}</dd>
                </div>
                <div>
                  <dt>Reorder point</dt>
                  <dd>{selected.reorderPoint ?? "Not configured"}</dd>
                </div>
                <div>
                  <dt>Target stock</dt>
                  <dd>{selected.target ?? "Not configured"}</dd>
                </div>
              </dl>
              {selected.kind === "unlinked_product" && (
                <p>
                  Product link missing. Link this item in the product's stock
                  configuration.
                </p>
              )}
              <section>
                <h3>Lots & expiry</h3>
                {selected.lots.length === 0 ? (
                  <p>No lots recorded for this location.</p>
                ) : (
                  <ul className="stock-linked-records">
                    {selected.lots.map(renderStockLot)}
                  </ul>
                )}
              </section>
              <section>
                <h3>Recent movements</h3>
                {selected.movements.length === 0 ? (
                  <p>No movements recorded.</p>
                ) : (
                  <ul className="stock-linked-records">
                    {selected.movements.map(renderStockMovement)}
                  </ul>
                )}
              </section>
              {products && (
                <section>
                  <h3>Reservations</h3>
                  {selected.reservations.length === 0 ? (
                    <p>No active reservations.</p>
                  ) : (
                    <ul className="stock-linked-records">
                      {selected.reservations.map(
                        renderReservation.bind(null, this.props.ordersHref),
                      )}
                    </ul>
                  )}
                </section>
              )}
              {!products && selected.positionId !== null && (
                <section>
                  <InventoryPurchases
                    key={`${selected.positionId}:${selected.available}`}
                    organisationId={this.props.organisationId}
                    positionId={selected.positionId}
                    purchasingHref={this.props.suppliersHref}
                  />
                </section>
              )}
              <ul className="stock-detail-links">
                {selected.kind === "product" && (
                  <li>
                    <Link
                      to={`${this.props.productsHref}/${encodeURIComponent(selected.product.productId)}`}
                    >
                      Open product details
                      <ArrowUpRight size={16} aria-hidden="true" />
                    </Link>
                  </li>
                )}
                {products && (
                  <li>
                    <Link
                      to={`${this.props.productionHref}?inventoryItem=${encodeURIComponent(selected.inventoryItemId)}`}
                    >
                      Open production requests
                      <ArrowUpRight size={16} aria-hidden="true" />
                    </Link>
                  </li>
                )}
                <li>
                  <Link
                    to={`${this.props.suppliersHref}?inventoryItem=${encodeURIComponent(selected.inventoryItemId)}&location=${encodeURIComponent(selected.locationId ?? "")}`}
                  >
                    Open purchasing
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </Link>
                </li>
              </ul>
              <p className="stock-footnote">
                Stock changes are recorded in your connected inventory system.
                Those balances appear here.
              </p>
            </div>
          )}
        </SideDrawer>
        {this.state.productAction !== null && (
          <ProductActionDialog
            key={`${this.state.productAction.product.productId}:${this.state.productAction.product.revision}`}
            organisationId={this.props.organisationId}
            product={this.state.productAction.product}
            action={this.state.productAction.action}
            mutate={this.props.mutate}
            close={this.closeProductAction.bind(this)}
            changed={this.received.bind(this)}
            switchAction={this.switchProductAction.bind(this)}
          />
        )}
        {this.state.operation?.kind === "production" && (
          <InventoryProductionDialog
            userId={this.props.userId}
            canManage={this.props.canManage}
            key={`${this.props.userId}:${this.props.organisationId}:${this.state.operation.positionId}`}
            organisationId={this.props.organisationId}
            positionId={this.state.operation.positionId}
            requestsHref={`${this.props.productionHref}?inventoryItem=${encodeURIComponent(selected?.inventoryItemId ?? "")}`}
            mutate={this.props.mutate}
            close={this.closeOperation.bind(this)}
          />
        )}
        {this.state.operation?.kind === "receipt" && (
          <InventoryReceiptDialog
            key={`${this.props.organisationId}:${this.state.operation.positionId}`}
            organisationId={this.props.organisationId}
            positionId={this.state.operation.positionId}
            mutate={this.props.mutate}
            close={this.closeOperation.bind(this)}
            received={this.received.bind(this)}
          />
        )}
        {(this.state.operation?.kind === "count" ||
          this.state.operation?.kind === "adjustment") && (
          <InventoryReconciliationDialog
            userId={this.props.userId}
            key={`${this.props.organisationId}:${this.state.operation.kind}:${this.state.operation.positionId}`}
            organisationId={this.props.organisationId}
            positionId={this.state.operation.positionId}
            kind={this.state.operation.kind}
            mutate={this.props.mutate}
            close={this.closeOperation.bind(this)}
            changed={this.received.bind(this)}
          />
        )}
      </div>
    );
  }
}

function expiringSoon(row: StockRow): boolean {
  for (const lot of row.lots) {
    if (lot.expiresAt === null || lot.status !== "available") continue;
    const expiry = Date.parse(lot.expiresAt);
    if (expiry >= Date.now() && expiry <= Date.now() + 7 * 86400000)
      return true;
  }
  return false;
}
function initialStockSelection(
  rows: readonly StockRow[],
  view: Props["view"],
): string | null {
  const parameters = new URLSearchParams(window.location.search);
  const item = parameters.get("inventoryItem");
  const location = parameters.get("location");
  for (const row of rows)
    if (
      row.inventoryItemId === item &&
      belongsToView(view, row) &&
      (location === null || row.locationId === location)
    )
      return row.id;
  return null;
}
function renderStockMovement(movement: StockRow["movements"][number]) {
  return (
    <li key={movement.id}>
      <strong>
        {movement.direction === "increase" ? "+" : "−"}
        {movement.quantity}
      </strong>
      <span>{movement.reason.replaceAll("_", " ")}</span>
      <small>{new Date(movement.occurredAt).toLocaleString()}</small>
    </li>
  );
}
function renderReservation(
  ordersHref: string,
  reservation: StockRow["reservations"][number],
) {
  return (
    <li key={reservation.id}>
      <strong>{reservation.quantity}</strong>
      <span>{reservation.state.replaceAll("_", " ")}</span>
      {reservation.orderId !== null && (
        <Link to={`${ordersHref}/${encodeURIComponent(reservation.orderId)}`}>
          Open order
        </Link>
      )}
    </li>
  );
}

import React from "react";
import { Package, Receipt } from "lucide-react";
import {
  CrmTable,
  CrmIdentity,
  CrmTag,
  CrmProgress,
  CrmSparkline,
  type CrmColumn,
} from "../ui";

type Product = {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly stock: number;
  readonly price: number;
  readonly sales: readonly number[];
};
type Order = {
  readonly id: string;
  readonly customer: string;
  readonly items: number;
  readonly total: number;
  readonly progress: number;
  readonly pickup: string;
};
const products: readonly Product[] = [
  {
    id: "FIN-001",
    name: "Plain financier",
    category: "Financiers",
    stock: 48,
    price: 320,
    sales: [12, 18, 16, 24, 21, 32, 38],
  },
  {
    id: "FIN-002",
    name: "Chocolate financier",
    category: "Financiers",
    stock: 14,
    price: 380,
    sales: [8, 12, 10, 16, 14, 18, 24],
  },
  {
    id: "CRS-001",
    name: "Butter croissant",
    category: "Viennoiserie",
    stock: 36,
    price: 420,
    sales: [24, 22, 28, 32, 30, 38, 42],
  },
  {
    id: "CRS-002",
    name: "Almond croissant",
    category: "Viennoiserie",
    stock: 8,
    price: 520,
    sales: [20, 16, 12, 18, 14, 12, 10],
  },
  {
    id: "BRD-001",
    name: "Country sourdough",
    category: "Bread",
    stock: 0,
    price: 780,
    sales: [8, 10, 12, 10, 14, 16, 18],
  },
  {
    id: "BRD-002",
    name: "Milk bread",
    category: "Bread",
    stock: 22,
    price: 580,
    sales: [12, 14, 14, 12, 16, 16, 18],
  },
  {
    id: "TAR-001",
    name: "Seasonal fruit tart",
    category: "Patisserie",
    stock: 6,
    price: 680,
    sales: [4, 5, 8, 7, 10, 12, 14],
  },
  {
    id: "CKE-001",
    name: "Basque cheesecake",
    category: "Patisserie",
    stock: 12,
    price: 620,
    sales: [6, 8, 8, 12, 10, 14, 16],
  },
];
const orders: readonly Order[] = [
  {
    id: "ORD-1042",
    customer: "Aoi Coffee",
    items: 38,
    total: 12960,
    progress: 67,
    pickup: "Today, 09:00",
  },
  {
    id: "ORD-1043",
    customer: "Maple Kitchen",
    items: 24,
    total: 10080,
    progress: 100,
    pickup: "Today, 09:30",
  },
  {
    id: "ORD-1044",
    customer: "River Hotel",
    items: 72,
    total: 27360,
    progress: 35,
    pickup: "Today, 10:00",
  },
  {
    id: "ORD-1045",
    customer: "Northside Cafe",
    items: 18,
    total: 9360,
    progress: 0,
    pickup: "Today, 10:30",
  },
  {
    id: "ORD-1046",
    customer: "Mori Market",
    items: 30,
    total: 17400,
    progress: 50,
    pickup: "Today, 11:00",
  },
  {
    id: "ORD-1047",
    customer: "Studio Eight",
    items: 12,
    total: 8160,
    progress: 100,
    pickup: "Today, 11:30",
  },
];
const productColumns: readonly CrmColumn<Product>[] = [
  {
    id: "name",
    label: "Product",
    kind: "text",
    width: 240,
    value: productName,
    render: productIdentity,
  },
  {
    id: "id",
    label: "SKU",
    kind: "text",
    width: 140,
    value: productId,
    render: productId,
  },
  {
    id: "category",
    label: "Category",
    kind: "text",
    width: 170,
    value: productCategory,
    render: productCategoryTag,
  },
  {
    id: "status",
    label: "Availability",
    kind: "text",
    width: 150,
    value: productStatus,
    render: productStatusTag,
  },
  {
    id: "stock",
    label: "Stock",
    kind: "number",
    width: 120,
    value: productStock,
    render: productStock,
  },
  {
    id: "price",
    label: "Price",
    kind: "number",
    width: 130,
    value: productPrice,
    render: productPriceCell,
    format: yen,
  },
  {
    id: "demand",
    label: "7-day sales",
    kind: "display",
    width: 140,
    render: productTrend,
  },
];
const orderColumns: readonly CrmColumn<Order>[] = [
  {
    id: "id",
    label: "Order",
    kind: "text",
    width: 180,
    value: orderId,
    render: orderIdentity,
  },
  {
    id: "customer",
    label: "Customer",
    kind: "text",
    width: 210,
    value: orderCustomer,
    render: orderCustomer,
  },
  {
    id: "status",
    label: "Status",
    kind: "text",
    width: 150,
    value: orderStatus,
    render: orderStatusTag,
  },
  {
    id: "items",
    label: "Items",
    kind: "number",
    width: 110,
    value: orderItems,
    render: orderItems,
  },
  {
    id: "total",
    label: "Total",
    kind: "number",
    width: 150,
    value: orderTotal,
    render: orderTotalCell,
    format: yen,
  },
  {
    id: "progress",
    label: "Fulfillment",
    kind: "number",
    width: 170,
    value: orderProgress,
    render: orderProgressCell,
  },
  {
    id: "pickup",
    label: "Pickup",
    kind: "text",
    width: 160,
    value: orderPickup,
    render: orderPickup,
  },
];
type State = {
  readonly view: "products" | "orders";
  readonly query: string;
  readonly selected: ReadonlySet<string>;
  readonly message: string;
};
export class CrmTablePreview extends React.Component<object, State> {
  state: State = {
    view: "products",
    query: "",
    selected: new Set(),
    message: "",
  };
  private switchView(view: "products" | "orders"): void {
    this.setState({ view, query: "", selected: new Set(), message: "" });
  }
  private search(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ query: event.currentTarget.value });
  }
  private select(selected: ReadonlySet<string>): void {
    this.setState({ selected });
  }
  private clearSelection(): void {
    this.setState({ selected: new Set() });
  }
  private inspectProduct(row: Product): void {
    this.setState({
      message: `${row.name} · ${row.id} · ${row.stock} in stock · ${yen(row.price)}`,
    });
  }
  private inspectOrder(row: Order): void {
    this.setState({
      message: `${row.id} · ${row.customer} · ${row.items} items · ${yen(row.total)}`,
    });
  }
  render(): React.ReactNode {
    return (
      <section
        id="crm-preview"
        className="crm-preview"
        aria-label="CRM table preview"
      >
        <h2>CRM Table</h2>
        <p>
          Product and Order examples. Sort headings, resize their edges, pin
          columns, and choose footer calculations.
        </p>
        <div className="agent-preview-controls">
          <div role="group" aria-label="Example dataset">
            <button
              type="button"
              aria-pressed={this.state.view === "products"}
              onClick={this.switchView.bind(this, "products")}
            >
              Products
            </button>
            <button
              type="button"
              aria-pressed={this.state.view === "orders"}
              onClick={this.switchView.bind(this, "orders")}
            >
              Orders
            </button>
          </div>
          <label>
            Search records{" "}
            <input
              type="search"
              value={this.state.query}
              onChange={this.search.bind(this)}
              placeholder="Name, SKU, or order…"
            />
          </label>
          <button
            type="button"
            onClick={this.clearSelection.bind(this)}
            disabled={this.state.selected.size === 0}
          >
            Clear selection ({this.state.selected.size})
          </button>
        </div>
        {this.state.view === "products" ? (
          <CrmTable
            key="products"
            label="Products"
            rows={products.filter(matchesProduct.bind(null, this.state.query))}
            columns={productColumns}
            rowId={productId}
            rowLabel={productName}
            initialPinned={["name"]}
            selection={{
              selectedIds: this.state.selected,
              onChange: this.select.bind(this),
            }}
            actions={[
              {
                id: "inspect",
                label: "View product details",
                onSelect: this.inspectProduct.bind(this),
              },
            ]}
          />
        ) : (
          <CrmTable
            key="orders"
            label="Orders"
            rows={orders.filter(matchesOrder.bind(null, this.state.query))}
            columns={orderColumns}
            rowId={orderId}
            rowLabel={orderId}
            initialPinned={["id"]}
            selection={{
              selectedIds: this.state.selected,
              onChange: this.select.bind(this),
            }}
            actions={[
              {
                id: "inspect",
                label: "View order details",
                onSelect: this.inspectOrder.bind(this),
              },
            ]}
          />
        )}
        <p className="crm-preview-message" role="status">
          {this.state.message}
        </p>
      </section>
    );
  }
}
function matchesProduct(query: string, row: Product): boolean {
  return `${row.name} ${row.id} ${row.category}`
    .toLowerCase()
    .includes(query.toLowerCase().trim());
}
function matchesOrder(query: string, row: Order): boolean {
  return `${row.id} ${row.customer}`
    .toLowerCase()
    .includes(query.toLowerCase().trim());
}
function yen(value: number): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(value);
}
function productId(row: Product): string {
  return row.id;
}
function productName(row: Product): string {
  return row.name;
}
function productCategory(row: Product): string {
  return row.category;
}
function productStock(row: Product): number {
  return row.stock;
}
function productPrice(row: Product): number {
  return row.price;
}
function productStatus(row: Product): string {
  return row.stock === 0
    ? "Sold out"
    : row.stock < 15
      ? "Low stock"
      : "Available";
}
function productIdentity(row: Product): React.ReactNode {
  return <CrmIdentity label={row.name} icon={<Package size={15} />} />;
}
function productCategoryTag(row: Product): React.ReactNode {
  return <CrmTag tone="info">{row.category}</CrmTag>;
}
function productStatusTag(row: Product): React.ReactNode {
  return (
    <CrmTag
      tone={
        row.stock === 0 ? "negative" : row.stock < 15 ? "warning" : "positive"
      }
    >
      {productStatus(row)}
    </CrmTag>
  );
}
function productPriceCell(row: Product): string {
  return yen(row.price);
}
function productTrend(row: Product): React.ReactNode {
  return (
    <CrmSparkline
      values={row.sales}
      label={`${row.name}: last seven days, ${row.sales.join(", ")} sold`}
    />
  );
}
function orderId(row: Order): string {
  return row.id;
}
function orderCustomer(row: Order): string {
  return row.customer;
}
function orderItems(row: Order): number {
  return row.items;
}
function orderTotal(row: Order): number {
  return row.total;
}
function orderProgress(row: Order): number {
  return row.progress;
}
function orderPickup(row: Order): string {
  return row.pickup;
}
function orderStatus(row: Order): string {
  return row.progress === 100
    ? "Ready"
    : row.progress === 0
      ? "Queued"
      : "Preparing";
}
function orderIdentity(row: Order): React.ReactNode {
  return <CrmIdentity label={row.id} icon={<Receipt size={15} />} />;
}
function orderTotalCell(row: Order): string {
  return yen(row.total);
}
function orderStatusTag(row: Order): React.ReactNode {
  return (
    <CrmTag tone={row.progress === 100 ? "positive" : "warning"}>
      {orderStatus(row)}
    </CrmTag>
  );
}
function orderProgressCell(row: Order): React.ReactNode {
  return <CrmProgress value={row.progress} label={`${row.id} fulfillment`} />;
}

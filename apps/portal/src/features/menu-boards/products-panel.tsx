import React from "react";
import { Plus, Search } from "lucide-react";
import type { MenuScreenFacts } from "@seams/control-api";
import type { MenuDraftSnapshot } from "@seams/menu-draft-crdt";
import { MenuDraftClient } from "../content-studio/menu-client";
import { readCafeMenuOptions, type CafeMenuProduct } from "../content-studio/route";
import { money } from "./board-view";
import "./products-panel.css";

/**
 * The Products panel of the board editor (Plan 40B). It lists the menu's
 * items with their live prices, and the shop's other products. A person
 * drags one onto the board, or presses its +, and the board shows it as a
 * product in a look that the inspector changes. A product that is not on
 * the menu yet goes into the menu draft first; it shows a price after a
 * person publishes the menu.
 */

/** What a product drag carries. */
export const PRODUCT_DRAG_TYPE = "application/x-satyr-board-product";

export type BoardProduct =
  | Readonly<{ kind: "item"; itemId: string; name: string }>
  | Readonly<{ kind: "product"; productId: string; name: string }>;

export function ProductsPanel(props: Readonly<{
  organisationId: string;
  menu: MenuDraftSnapshot;
  facts: MenuScreenFacts | null;
  editable: boolean;
  onAdd: (product: BoardProduct) => void;
}>): React.ReactNode {
  const [products, setProducts] = React.useState<readonly CafeMenuProduct[]>([]);
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    let current = true;
    void readCafeMenuOptions(props.organisationId).then((options) => {
      if (current && options.kind === "ready") setProducts(options.products);
    });
    return () => {
      current = false;
    };
  }, [props.organisationId]);
  const entries = new Map((props.facts?.entries ?? []).map((entry) => [entry.menuEntryId, entry]));
  const onMenu = new Set(props.menu.items.map((item) => item.productId));
  const words = query.trim().toLowerCase();
  const matches = (name: string): boolean => words.length === 0 || name.toLowerCase().includes(words);
  const sections = props.menu.sections
    .slice()
    .sort((first, second) => first.order - second.order)
    .map((section) => ({
      section,
      items: props.menu.items
        .filter((item) => item.placement.sectionId === section.id && matches(item.displayName))
        .sort((first, second) => first.placement.order - second.placement.order),
    }))
    .filter((group) => group.items.length > 0);
  const others = products.filter((product) => !onMenu.has(product.productId) && matches(product.title));
  // A product's photo: the published entry's, else the shop product's.
  const photos = new Map(products.map((product) => [product.productId, product.image]));
  const row = (
    product: BoardProduct,
    line: string,
    key: string,
    photo: Readonly<{ url: string }> | null,
  ): React.ReactNode => <li
    key={key}
    className="menu-board-product"
    draggable={props.editable}
    onDragStart={(event) => {
      event.dataTransfer.setData(PRODUCT_DRAG_TYPE, JSON.stringify(product));
      event.dataTransfer.setData("text/plain", product.name);
      event.dataTransfer.effectAllowed = "copy";
    }}
    title={props.editable ? "Drag onto the board" : undefined}
  >
    {photo === null
      ? <span className="menu-board-product-mark" aria-hidden="true">{product.name.slice(0, 1).toUpperCase()}</span>
      : <img className="menu-board-product-mark" src={photo.url} alt="" draggable={false} />}
    <span className="menu-board-product-copy">
      <span className="menu-board-product-name">{product.name}</span>
      <span className="menu-board-product-line">{line}</span>
    </span>
    <button
      type="button"
      className="menu-board-icon-button"
      aria-label={`Add ${product.name} to the board`}
      disabled={!props.editable}
      onClick={() => props.onAdd(product)}
    >
      <Plus size={16} aria-hidden="true" />
    </button>
  </li>;
  return <section className="menu-board-products" aria-label="Products">
    <label className="menu-board-products-search">
      <span>Search products</span>
      <Search size={14} aria-hidden="true" />
      <input value={query} placeholder="Search products" onChange={(event) => setQuery(event.target.value)} />
    </label>
    <div className="menu-board-products-list">
      {sections.map(({ section, items }) => <div key={section.id}>
        <h4>{section.title}</h4>
        <ul>
          {items.map((item) => {
            const entry = entries.get(item.id);
            const line = entry === undefined
              ? "Not on the published menu yet"
              : entry.availability === "unavailable"
                ? `${money(entry.price)} · sold out today`
                : money(entry.price);
            const photo = entry?.image ?? photos.get(item.productId) ?? null;
            return row({ kind: "item", itemId: item.id, name: item.displayName }, line, item.id, photo);
          })}
        </ul>
      </div>)}
      {others.length > 0 ? <div>
        <h4>Not on the menu</h4>
        <ul>
          {others.map((product) => row(
            { kind: "product", productId: product.productId, name: product.title },
            "Adds it to the menu draft",
            product.productId,
            product.image,
          ))}
        </ul>
      </div> : null}
      {sections.length === 0 && others.length === 0 ? <p className="menu-boards-drawer-note">
        {words.length > 0 ? "No product has that name." : "No products yet. Add products on the Products page."}
      </p> : null}
    </div>
    <p className="menu-board-products-note">Prices and sold-out marks come from the shop and stay live on every screen.</p>
  </section>;
}

/**
 * Adds a product to the menu draft, in its first section, through the
 * draft's own room, and gives the new item's ID. The room connects only
 * when a person first adds a product that is not on the menu.
 */
export function useMenuDraftAdder(
  organisationId: string,
  onMenu: (draft: MenuDraftSnapshot) => void,
): (product: Readonly<{ productId: string; name: string }>) => Promise<string | null> {
  const client = React.useRef<MenuDraftClient | null>(null);
  const ready = React.useRef<Promise<MenuDraftClient | null> | null>(null);
  const notify = React.useRef(onMenu);
  notify.current = onMenu;
  // The draft that the room showed last.
  const latest = React.useRef<MenuDraftSnapshot | null>(null);
  React.useEffect(() => () => {
    client.current?.dispose();
    client.current = null;
    ready.current = null;
  }, [organisationId]);
  return React.useCallback(async (product) => {
    ready.current ??= new Promise((resolve) => {
      const surface = document.createElement("div");
      let settled = false;
      const connected = new MenuDraftClient(organisationId, surface, (view) => {
        latest.current = view.draft;
        notify.current(view.draft);
        if (settled) return;
        if (view.kind === "synced" && view.access === "edit") {
          settled = true;
          resolve(client.current);
        } else if (view.kind === "failed" || (view.kind === "synced" && view.access !== "edit")) {
          settled = true;
          resolve(null);
        }
      });
      client.current = connected;
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, 10_000);
    });
    const menu = await ready.current;
    if (menu === null) {
      ready.current = null;
      return null;
    }
    const draft = latest.current;
    let section = draft?.sections.slice().sort((first, second) => first.order - second.order)[0];
    if (section === undefined) {
      section = { id: `section_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`, title: "Menu", order: 0 };
      menu.addSection(section);
    }
    const order = (draft?.items ?? []).filter((item) => item.placement.sectionId === section.id).length;
    const id = `item_${crypto.randomUUID().replaceAll("-", "")}`;
    menu.addItem({ id, productId: product.productId, displayName: product.name, description: "", placement: { sectionId: section.id, order } });
    return id;
  }, [organisationId]);
}

import { DraftLeaveDialog } from "@purin-labs/collaboration/portal/draft-leave-dialog";
import { Select } from "@purin-labs/ui/select";
import { SideDrawer } from "@purin-labs/ui/index";
import React from "react";
import {
  MENU_HOUR_DAYS,
  parseMenuHours,
  type MenuHourDay,
  type MenuHours,
} from "@purin-labs/control-api";
import { useBlocker, useLocation, useNavigate } from "react-router";
import { pageAddress, pageLink } from "@purin-labs/ui/page-address";
import { controlRead, controlRefusal, controlWrite } from "@purin-labs/control/portal/control-client";
import {
  MENU_ITEM_LIMIT,
  MENU_SECTION_LIMIT,
  MENU_TEXT_LIMIT,
  type MenuDraftSnapshot,
  type MenuItem,
  type MenuSection,
} from "@purin-labs/menu-draft-crdt";
import {
  DraftMousePointers,
  DraftParticipants,
  type DraftPresenceView,
} from "@purin-labs/collaboration/portal/draft-presence";
import { MenuDraftClient, type MenuDraftView } from "./menu-client";
import { MenuBoardsPanel } from "../menu-boards/boards-panel";
import { MenuScreensPanel } from "../menu-boards/screens-panel";
import "../commerce/description-draft/styles.css";
import "./styles.css";
import {
  assertNever,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";
import {
  type MenuDraftReview,
  parseMenuReview,
  parseMenuSnapshot,
} from "@purin-labs/cafe-control-api/portal/content-studio-menu";

type MenuReviewState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; review: MenuDraftReview }>
  | Readonly<{ kind: "failed"; message: string }>;

/** The products the café sells, for the item picker, and the live menu. */
type CafeMenuOptions =
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "ready";
      products: readonly CafeMenuProduct[];
      published: Readonly<{ revision: number; entries: number }> | null;
      hours: MenuHours | null;
      shopUrl: string | null;
      /** The shop name and its order page address; null without a domain. */
      shopName: ShopNameAddress | null;
    }>
  | Readonly<{ kind: "failed" }>;

type ShopNameAddress = Readonly<{
  name: string | null;
  prefix: string;
  suffix: string;
}>;

type ShopNameSaveState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "saving" }>
  | Readonly<{ kind: "saved" }>
  | Readonly<{ kind: "failed"; message: string }>;

export type CafeMenuProduct = Readonly<{
  productId: string;
  title: string;
  /** The product's first photo in the shop, or null (Plan 40B). */
  image: Readonly<{ url: string; altText: string }> | null;
}>;

type MenuPublishState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "publishing" }>
  | Readonly<{ kind: "published"; revision: number; entries: number }>
  | Readonly<{ kind: "failed"; message: string }>;

const INITIAL_MENU_VIEW: MenuDraftView = {
  kind: "connecting",
  draft: { title: "Café menu", sections: [], items: [] },
  participants: [],
  access: "read",
  documentRevision: null,
};

/**
 * The sheets that open over the Menus canvas (Plan 40B): the menu draft's
 * items, with the shop's publication and serving hours, and the screens.
 * The address names the open sheet as `?tab=items` or `?tab=screens`, as
 * the Menus tabs of before did.
 */
type MenuSheet = "items" | "screens";

const MENU_SHEETS: readonly Readonly<{ id: MenuSheet; label: string }>[] = [
  { id: "items", label: "Menu items" },
  { id: "screens", label: "Screens" },
];

export function MenuDraftRoute(
  props: Readonly<{ organisationId: string }>,
): React.ReactNode {
  const client = React.useRef<MenuDraftClient | null>(null);
  const blocker = useBlocker(hasUnsyncedMenu.bind(null, client));
  const location = useLocation();
  const navigate = useNavigate();
  // With the chat open, the address of the page beside it names the sheet,
  // so the canvas and an open sheet stay while the chat opens and closes.
  const page = pageAddress(location);
  const requested = new URLSearchParams(page.search).get("tab");
  const sheet: MenuSheet | null = requested === "items" || requested === "screens" ? requested : null;
  const open = (next: MenuSheet | null): void => {
    const link = pageLink(location, next === null ? page.pathname : `${page.pathname}?tab=${next}`);
    void navigate(link.to, { state: link.state });
  };
  // The canvas is the Menus page; these open the sheets over it.
  const links = <nav className="menu-tabs menu-tabs-segmented menu-board-menu-links" aria-label="Menu views">
    {MENU_SHEETS.map((entry) => <button
      key={entry.id}
      type="button"
      aria-pressed={sheet === entry.id}
      onClick={() => open(sheet === entry.id ? null : entry.id)}
    >
      {entry.label}
    </button>)}
  </nav>;
  const label = MENU_SHEETS.find((entry) => entry.id === sheet)?.label ?? "";
  // The Portal's side drawer, from the inline end over the canvas: Escape,
  // the close button and a click beside it go back to the canvas.
  const sheetView = sheet === null ? null : <SideDrawer
    open
    title={label}
    close={() => open(null)}
    className="menu-board-sheet-drawer"
  >
    <div className="side-drawer-body menu-board-sheet-body">
      {sheet === "items"
        ? <MenuDraftEditor organisationId={props.organisationId} client={client} />
        : <MenuScreensPanel organisationId={props.organisationId} />}
    </div>
  </SideDrawer>;
  return (
    <div className="content-studio-stack">
      <MenuBoardsPanel organisationId={props.organisationId} menuLinks={links} sheet={sheetView} />
      {blocker.state === "blocked" ? (
        <DraftLeaveDialog blocker={blocker} draftName="menu draft" />
      ) : null}
    </div>
  );
}

function hasUnsyncedMenu(
  client: React.RefObject<MenuDraftClient | null>,
): boolean {
  return client.current?.hasUnsyncedEdits() ?? false;
}

function MenuDraftEditor(
  props: Readonly<{
    organisationId: string;
    client: React.RefObject<MenuDraftClient | null>;
  }>,
): React.ReactNode {
  const surface = React.useRef<HTMLElement>(null);
  const client = props.client;
  const [view, setView] = React.useState<MenuDraftView>(INITIAL_MENU_VIEW);
  const [review, setReview] = React.useState<MenuReviewState>({ kind: "idle" });
  const [options, setOptions] = React.useState<CafeMenuOptions>({ kind: "loading" });
  const [publication, setPublication] = React.useState<MenuPublishState>({ kind: "idle" });
  React.useEffect(connectMenuEditor.bind(null, props.organisationId, surface, client, setView), [props.organisationId]);
  React.useEffect(loadCafeMenuOptions.bind(null, props.organisationId, setOptions), [props.organisationId]);
  const products = options.kind === "ready" ? options.products : [];
  const readOnly = view.access === "read" || view.kind === "failed";
  return <section ref={surface} className="content-studio-card content-studio-menu">
    <DraftMousePointers participants={menuPresenceViews(view)} />
    <header className="content-studio-header">
      <div>
        <p className="content-studio-eyebrow">Shared layout draft</p>
        <input
          className="content-studio-menu-title"
          aria-label="Menu title"
          value={view.draft.title}
          maxLength={MENU_TEXT_LIMIT}
          readOnly={readOnly}
          onChange={renameMenu.bind(null, client)}
        />
        <p>Arrange items into sections and prepare your menu for review.</p>
      </div>
      <div className="content-studio-status">
        <span className="description-draft-sync-status" data-state={view.kind}>{menuConnectionLabel(view)}</span>
        <DraftParticipants participants={menuPresenceViews(view)} />
      </div>
    </header>
    <div className="content-studio-menu-toolbar">
      <span>{view.draft.sections.length} sections · {view.draft.items.length} items</span>
      <button
        type="button"
        className="secondary"
        disabled={readOnly || view.draft.sections.length >= MENU_SECTION_LIMIT}
        onClick={addMenuSection.bind(null, client, view.draft)}
      >
        Add section
      </button>
    </div>
    {view.draft.sections.length === 0 ? (
      <p className="content-studio-menu-empty">
        {readOnly
          ? "No menu sections yet. Sections and items appear here when an editor adds them."
          : "Add your first section, then add the items you serve."}
      </p>
    ) : null}
    <div className="content-studio-menu-board">
      {view.draft.sections.map(renderMenuSection.bind(null, client, view.draft, readOnly, products))}
    </div>
    {view.kind === "failed" ? <p className="description-draft-error">{view.message}</p> : null}
    <MenuPublishPanel
      options={options}
      state={publication}
      canPublish={view.kind === "synced" && !readOnly && view.draft.items.length > 0}
      onPublish={publishCafeMenu.bind(null, props.organisationId, view.draft, setPublication, setOptions)}
    />
    {options.kind === "ready" && options.shopName !== null ? <ShopNamePanel
      organisationId={props.organisationId}
      address={options.shopName}
      setOptions={setOptions}
    /> : null}
    <MenuReviewPanel
      state={review}
      canReview={view.kind === "synced" && !readOnly}
      onReview={requestMenuReview.bind(null, props.organisationId, setReview)}
    />
  </section>;
}

function MenuPublishPanel(props: Readonly<{
  options: CafeMenuOptions;
  state: MenuPublishState;
  canPublish: boolean;
  /** Undefined keeps the menu's hours: this page could not read them. */
  onPublish: (hours: MenuHours | null | undefined) => void;
}>): React.ReactNode {
  const savedHours = props.options.kind === "ready" ? props.options.hours : null;
  // An edit stays until this panel publishes it. A new read of the options
  // (a shop-name save, a publish) replaces only hours that the person did
  // not change, or the hours that this panel sent once the shop has them.
  const savedKey = JSON.stringify(savedHours);
  const [edit, setEdit] = React.useState<Readonly<{ hours: MenuHours | null }> | null>(null);
  const sentFrom = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (sentFrom.current === null || sentFrom.current === savedKey) return;
    sentFrom.current = null;
    setEdit(null);
  }, [savedKey]);
  React.useEffect(() => {
    if (props.state.kind === "failed") sentFrom.current = null;
  }, [props.state.kind]);
  const hours = edit === null ? savedHours : edit.hours;
  const setHours = (next: MenuHours | null): void =>
    setEdit(JSON.stringify(next) === savedKey ? null : { hours: next });
  const publish = (): void => {
    if (props.options.kind !== "ready") return props.onPublish(undefined);
    sentFrom.current = edit === null ? null : savedKey;
    props.onPublish(hours);
  };
  const published = props.options.kind === "ready" ? props.options.published : null;
  const shopUrl = props.options.kind === "ready" ? props.options.shopUrl : null;
  return <div className="content-studio-review content-studio-publish">
    <div>
      <p className="content-studio-eyebrow">Café shop</p>
      <h3>Publish the menu</h3>
      <p>
        {published === null
          ? "Customers see this menu in the café shop after you publish it."
          : `The shop shows revision ${published.revision} with ${published.entries} items. Publish again to replace it.`}
      </p>
      {shopUrl === null ? null : <a className="content-studio-shop-link" href={shopUrl} target="_blank" rel="noopener noreferrer">
        Open shop
      </a>}
    </div>
    {props.options.kind === "ready" ? <MenuHoursEditor hours={hours} setHours={setHours} /> : null}
    <button type="button" disabled={!props.canPublish || props.state.kind === "publishing"} onClick={publish}>
      {props.state.kind === "publishing" ? "Publishing…" : "Publish menu"}
    </button>
    {props.state.kind === "published" ? <p className="content-studio-published" role="status">
      Published revision {props.state.revision} with {props.state.entries} items. Customers see it within a few seconds.
    </p> : null}
    {props.state.kind === "failed" ? <p className="description-draft-error" role="alert">{props.state.message}</p> : null}
  </div>;
}

/**
 * The address of the shop's QR order page. Customers open it from the QR
 * code on the shop's screens and table cards; an earlier address keeps
 * opening the shop.
 */
function ShopNamePanel(props: Readonly<{
  organisationId: string;
  address: ShopNameAddress;
  setOptions: React.Dispatch<React.SetStateAction<CafeMenuOptions>>;
}>): React.ReactNode {
  const [name, setName] = React.useState(props.address.name ?? "");
  const [state, setState] = React.useState<ShopNameSaveState>({ kind: "idle" });
  const unchanged = name === (props.address.name ?? "");
  const save = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void saveShopName(props.organisationId, name, setState, props.setOptions);
  };
  return <form className="content-studio-review content-studio-shop-name" onSubmit={save}>
    <div>
      <p className="content-studio-eyebrow">Order page</p>
      <h3>Shop address</h3>
      <p>Customers open this address from the QR code to see the menu and order.</p>
      <label className="content-studio-shop-address">
        <span aria-hidden="true">{props.address.prefix}</span>
        <input
          aria-label="Shop name"
          value={name}
          maxLength={30}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          placeholder="your-shop"
          aria-describedby="content-studio-shop-address-rule"
          onChange={(event) => {
            setName(event.currentTarget.value.toLowerCase());
            setState({ kind: "idle" });
          }}
        />
        <span aria-hidden="true">{props.address.suffix}</span>
      </label>
      <p id="content-studio-shop-address-rule" className="content-studio-shop-rule">
        3 to 30 lowercase letters, digits and hyphens. An earlier address keeps opening your shop.
      </p>
    </div>
    <button type="submit" disabled={unchanged || name.length === 0 || state.kind === "saving"}>
      {state.kind === "saving" ? "Saving…" : "Save address"}
    </button>
    {state.kind === "saved" ? <p className="content-studio-published" role="status">
      Saved. The QR code on your screens shows the new address within a few seconds.
    </p> : null}
    {state.kind === "failed" ? <p className="description-draft-error" role="alert">{state.message}</p> : null}
  </form>;
}

async function saveShopName(
  organisationId: string,
  name: string,
  setState: React.Dispatch<React.SetStateAction<ShopNameSaveState>>,
  setOptions: React.Dispatch<React.SetStateAction<CafeMenuOptions>>,
): Promise<void> {
  setState({ kind: "saving" });
  try {
    const raw = await controlWrite(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/shop-name`,
      "PUT",
      { name },
    );
    if (isRecord(raw) && raw.ok === true) {
      setState({ kind: "saved" });
      const options = await readCafeMenuOptions(organisationId);
      setOptions(options);
      return;
    }
    setState({ kind: "failed", message: shopNameFailure(isRecord(raw) ? raw.error : undefined) });
  } catch (error) {
    const refused = controlRefusal(error);
    setState(refused === null
      ? { kind: "failed", message: "The address did not save. Check your connection, then try again." }
      : { kind: "failed", message: shopNameFailure(isRecord(refused.body) ? refused.body.error : undefined) });
  }
}

function shopNameFailure(error: unknown): string {
  switch (error) {
    case "shop_name_invalid":
      return "Use 3 to 30 lowercase letters, digits and single hyphens. Start with a letter.";
    case "shop_name_reserved":
      return "This name is reserved. Choose another name.";
    case "shop_name_taken":
      return "Another shop uses this name. Choose another name.";
    case "shop_name_limit":
      return "Your shop has used five names, which is the most it can hold.";
    case "organisation_role_insufficient":
      return "Only an owner or an admin can change the shop address.";
    default:
      return "The address did not save. Try again.";
  }
}

function loadCafeMenuOptions(
  organisationId: string,
  setOptions: React.Dispatch<React.SetStateAction<CafeMenuOptions>>,
): () => void {
  let current = true;
  void readCafeMenuOptions(organisationId).then(
    (options) => {
      if (current) setOptions(options);
    },
    () => {
      if (current) setOptions({ kind: "failed" });
    },
  );
  return () => {
    current = false;
  };
}

const HOUR_DAY_LABELS: Readonly<Record<MenuHourDay, string>> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

/** All day, or repeating hours on the shop's clock. Each slot ends the day it starts. */
function MenuHoursEditor(props: Readonly<{
  hours: MenuHours | null;
  setHours: (hours: MenuHours | null) => void;
}>): React.ReactNode {
  const { hours, setHours } = props;
  const newSlot = { days: [...MENU_HOUR_DAYS], startsAt: "07:00", endsAt: "11:00" };
  const setSlot = (index: number, slot: MenuHours["slots"][number]): void => {
    if (hours !== null)
      setHours({ ...hours, slots: hours.slots.map((current, at) => at === index ? slot : current) });
  };
  return <fieldset className="content-studio-hours">
    <legend>Serving hours</legend>
    <label>
      <input
        type="checkbox"
        checked={hours === null}
        onChange={(event) => setHours(event.target.checked
          ? null
          : { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, slots: [newSlot] })}
      />
      All day
    </label>
    {hours === null ? null : <>
      <p>Times use {hours.timeZone} time. Customers cannot order from this menu outside these hours.</p>
      {hours.slots.map((slot, index) => <div key={index} className="content-studio-hours-slot" role="group" aria-label={`Hours ${index + 1}`}>
        <div className="content-studio-hours-days">
          {MENU_HOUR_DAYS.map((day) => <label key={day}>
            <input
              type="checkbox"
              checked={slot.days.includes(day)}
              onChange={(event) => setSlot(index, {
                ...slot,
                days: MENU_HOUR_DAYS.filter((candidate) =>
                  candidate === day ? event.target.checked : slot.days.includes(candidate)),
              })}
            />
            {HOUR_DAY_LABELS[day]}
          </label>)}
        </div>
        <label>From <input type="time" value={slot.startsAt} onChange={(event) => setSlot(index, { ...slot, startsAt: event.target.value })} /></label>
        <label>To <input type="time" value={slot.endsAt === "24:00" ? "23:59" : slot.endsAt} onChange={(event) => setSlot(index, { ...slot, endsAt: event.target.value })} /></label>
        {hours.slots.length === 1 ? null : <button
          type="button"
          className="secondary"
          onClick={() => setHours({ ...hours, slots: hours.slots.filter((_, at) => at !== index) })}
        >Remove</button>}
      </div>)}
      <button type="button" className="secondary" onClick={() => setHours({ ...hours, slots: [...hours.slots, newSlot] })}>Add hours</button>
    </>}
  </fieldset>;
}

export async function readCafeMenuOptions(organisationId: string): Promise<CafeMenuOptions> {
  const raw = await controlRead(cafeMenuPublicationPath(organisationId)).catch(refusedAsNull);
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.products)) return { kind: "failed" };
  const products: CafeMenuProduct[] = [];
  for (const product of raw.products) {
    if (isRecord(product) && typeof product.productId === "string" && typeof product.title === "string")
      products.push({ productId: product.productId, title: product.title, image: productPhoto(product.image) });
  }
  const published = isRecord(raw.published) && isPositiveInteger(raw.published.revision) &&
    isNonNegativeInteger(raw.published.entries)
    ? { revision: raw.published.revision, entries: raw.published.entries }
    : null;
  const shopUrl = typeof raw.shopUrl === "string" && raw.shopUrl.startsWith("http") ? raw.shopUrl : null;
  const shopName = isRecord(raw.shopName) &&
    (raw.shopName.name === null || typeof raw.shopName.name === "string") &&
    typeof raw.shopName.prefix === "string" && typeof raw.shopName.suffix === "string"
    ? { name: raw.shopName.name, prefix: raw.shopName.prefix, suffix: raw.shopName.suffix }
    : null;
  const hours = parseMenuHours(raw.hours);
  return { kind: "ready", products, published, hours, shopUrl, shopName };
}

function productPhoto(value: unknown): CafeMenuProduct["image"] {
  if (!isRecord(value) || typeof value.url !== "string" || typeof value.altText !== "string") return null;
  return value.url.startsWith("https://") || value.url.startsWith("http://") ? { url: value.url, altText: value.altText } : null;
}

/**
 * Publishes the saved draft revision that matches the menu on the screen,
 * so the shop shows what the person saw.
 */
async function publishCafeMenu(
  organisationId: string,
  shown: MenuDraftSnapshot,
  setPublication: React.Dispatch<React.SetStateAction<MenuPublishState>>,
  setOptions: React.Dispatch<React.SetStateAction<CafeMenuOptions>>,
  hours: MenuHours | null | undefined,
): Promise<void> {
  setPublication({ kind: "publishing" });
  try {
    const saved = await readSavedMenu(organisationId);
    if (saved === null || JSON.stringify(saved.draft) !== JSON.stringify(shown)) {
      setPublication({ kind: "failed", message: publicationFailure(409, { error: "menu_draft_changed" }) });
      return;
    }
    const documentRevision = saved.revision;
    const raw = await controlWrite(cafeMenuPublicationPath(organisationId), "POST", { documentRevision, hours });
    if (isRecord(raw) && isRecord(raw.menu) && isPositiveInteger(raw.menu.revision) &&
      isNonNegativeInteger(raw.menu.entries)) {
      setPublication({ kind: "published", revision: raw.menu.revision, entries: raw.menu.entries });
      setOptions(await readCafeMenuOptions(organisationId));
      return;
    }
    // A response that Pantry accepted is not a 403.
    setPublication({ kind: "failed", message: publicationFailure(200, raw) });
  } catch (error) {
    const refused = controlRefusal(error);
    setPublication(refused === null
      ? { kind: "failed", message: "The menu could not be published. Check your connection, then try again." }
      : { kind: "failed", message: publicationFailure(refused.status, refused.body) });
  }
}

async function readSavedMenu(
  organisationId: string,
): Promise<Readonly<{ revision: number; draft: MenuDraftSnapshot }> | null> {
  const raw = await controlRead(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/collaboration/menu-draft`,
  ).catch(refusedAsNull);
  if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.value) || !isPositiveInteger(raw.value.revision))
    return null;
  const draft = parseMenuSnapshot(raw.value.draft);
  return draft === null ? null : { revision: raw.value.revision, draft };
}

function publicationFailure(status: number, raw: unknown): string {
  const error = isRecord(raw) ? raw.error : undefined;
  if (status === 403) return "Only an owner or an admin can publish the menu.";
  switch (error) {
    case "menu_draft_changed":
      return "Someone changed the menu while you published. Wait for Saved, then publish again.";
    case "menu_items_not_sellable": {
      const items = isRecord(raw) && Array.isArray(raw.items) ? raw.items.filter(isMenuText) : [];
      return `The café does not sell ${items.join(", ")}. Remove these items, or add them again from the product list.`;
    }
    case "menu_draft_empty":
      return "Add at least one item, then publish.";
    case "cafe_storefront_missing":
      return "This shop has no café pickup storefront, so it cannot show a menu.";
    case "menu_publication_conflict":
      return "The shop changed while you published. Publish again.";
    default:
      return "The menu could not be published. Try again.";
  }
}

function isMenuText(value: unknown): value is string {
  return typeof value === "string";
}

function cafeMenuPublicationPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/menu-publication`;
}

function MenuReviewPanel(props: Readonly<{
  state: MenuReviewState;
  canReview: boolean;
  onReview: () => void;
}>): React.ReactNode {
  return <div className="content-studio-review">
    <div>
      <p className="content-studio-eyebrow">Menu review</p>
      <h3>Save a review snapshot</h3>
      <p>Keep a copy of the saved menu for review. This does not publish it.</p>
    </div>
    <button type="button" className="secondary" disabled={!props.canReview || props.state.kind === "loading"} onClick={props.onReview}>
      {props.state.kind === "loading" ? "Saving snapshot…" : "Save snapshot"}
    </button>
    {props.state.kind === "ready" ? <div className="content-studio-reviewed">
      <strong>Revision {props.state.review.documentRevision}</strong>
      <span>{props.state.review.draft.title}</span>
      <p>{props.state.review.draft.sections.length} sections · {props.state.review.draft.items.length} items</p>
    </div> : null}
    {props.state.kind === "failed" ? <p className="description-draft-error">{props.state.message}</p> : null}
  </div>;
}

async function requestMenuReview(
  organisationId: string,
  setReview: React.Dispatch<React.SetStateAction<MenuReviewState>>,
): Promise<void> {
  setReview({ kind: "loading" });
  try {
    const raw = await requestFrozenReview(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/collaboration/menu-draft/review`,
    );
    const review = parseMenuReview(raw);
    if (review === null) throw new Error("review unavailable");
    setReview({ kind: "ready", review });
  } catch {
    setReview({ kind: "failed", message: "The saved menu could not be frozen. Wait for Saved, then try again." });
  }
}

function renderMenuSection(
  client: React.RefObject<MenuDraftClient | null>,
  draft: MenuDraftSnapshot,
  readOnly: boolean,
  products: readonly CafeMenuProduct[],
  section: MenuSection,
): React.ReactNode {
  const items = draft.items.filter(menuItemInSection.bind(null, section.id));
  const additions = [{ value: "", label: products.length === 0 ? "No products to add" : "Add item…" }, ...products.map(productItem)];
  return <div
    key={section.id}
    className="content-studio-menu-section"
    onDragOver={allowMenuDrop}
    onDrop={dropMenuItem.bind(null, client, section.id, items.length)}
    onFocus={selectMenuSection.bind(null, client, section.id)}
    onBlur={clearMenuSelection.bind(null, client)}
  >
    <div className="content-studio-menu-section-header">
      <h3>{section.title}</h3>
      <Select.Root
        items={additions}
        value=""
        disabled={readOnly || draft.items.length >= MENU_ITEM_LIMIT || products.length === 0}
        onValueChange={addMenuProduct.bind(null, client, products, section.id, items.length)}
      >
        <Select.Trigger aria-label={`Add an item to ${section.title}`} className="content-studio-menu-add"><Select.Value /></Select.Trigger>
        <Select.Popup>{additions.map(renderMenuSelectItem)}</Select.Popup>
      </Select.Root>
    </div>
    <div className="content-studio-menu-items">
      {items.length === 0 ? <p className="content-studio-menu-empty">{readOnly ? "No items in this section." : "Add an item, or move one here from another section."}</p> : null}
      {items.map(renderMenuItem.bind(null, client, draft, readOnly))}
    </div>
  </div>;
}

function renderMenuItem(
  client: React.RefObject<MenuDraftClient | null>,
  draft: MenuDraftSnapshot,
  readOnly: boolean,
  item: MenuItem,
): React.ReactNode {
  return <article
    key={item.id}
    className="content-studio-menu-item"
    draggable={!readOnly}
    onDragStart={startMenuDrag.bind(null, client, item.id)}
    onFocus={selectMenuItem.bind(null, client, item.id)}
    onBlur={clearMenuSelection.bind(null, client)}
  >
    <span className="content-studio-menu-grip" aria-hidden="true">⋮⋮</span>
    <input
      aria-label={`Name of ${item.displayName}`}
      value={item.displayName}
      maxLength={MENU_TEXT_LIMIT}
      readOnly={readOnly}
      onChange={editMenuItemName.bind(null, client, item)}
    />
    <textarea
      aria-label={`Description of ${item.displayName}`}
      rows={2}
      value={item.description}
      maxLength={MENU_TEXT_LIMIT}
      readOnly={readOnly}
      onChange={editMenuItemDescription.bind(null, client, item)}
    />
    <label className="content-studio-menu-placement">
      <span>Section</span>
      <Select.Root
        items={draft.sections.map(menuSectionItem)}
        value={item.placement.sectionId}
        disabled={readOnly}
        onValueChange={moveMenuItemToSection.bind(null, client, draft, item)}
      >
        <Select.Trigger aria-label={`Section for ${item.displayName}`}><Select.Value /></Select.Trigger>
        <Select.Popup>{draft.sections.map(renderMenuSectionOption)}</Select.Popup>
      </Select.Root>
    </label>
    <footer>
      <button type="button" className="secondary" aria-label={`Remove ${item.displayName}`} disabled={readOnly} onClick={deleteMenuItem.bind(null, client, item.id)}>
        Remove
      </button>
    </footer>
  </article>;
}

function menuSectionItem(section: MenuSection): { value: string; label: string } {
  return { value: section.id, label: section.title };
}

function renderMenuSectionOption(section: MenuSection): React.ReactNode {
  return <Select.Item key={section.id} value={section.id}>{section.title}</Select.Item>;
}

function moveMenuItemToSection(
  client: React.RefObject<MenuDraftClient | null>,
  draft: MenuDraftSnapshot,
  item: MenuItem,
  sectionId: string | null,
): void {
  for (const section of draft.sections) {
    if (section.id !== sectionId) continue;
    let order = 0;
    for (const existing of draft.items) {
      if (existing.placement.sectionId === sectionId) order += 1;
    }
    client.current?.moveItem(item.id, { sectionId, order });
    return;
  }
}

function connectMenuEditor(
  organisationId: string,
  surface: React.RefObject<HTMLElement | null>,
  clientRef: React.RefObject<MenuDraftClient | null>,
  setView: React.Dispatch<React.SetStateAction<MenuDraftView>>,
): () => void {
  if (surface.current === null) return noCleanup;
  const client = new MenuDraftClient(organisationId, surface.current, setView);
  clientRef.current = client;
  return disconnectMenuEditor.bind(null, clientRef, client);
}

function disconnectMenuEditor(ref: React.RefObject<MenuDraftClient | null>, client: MenuDraftClient): void {
  ref.current = null;
  client.dispose();
}

function renameMenu(client: React.RefObject<MenuDraftClient | null>, event: React.ChangeEvent<HTMLInputElement>): void {
  client.current?.rename(event.currentTarget.value);
}

function addMenuSection(client: React.RefObject<MenuDraftClient | null>, draft: MenuDraftSnapshot): void {
  client.current?.addSection({
    id: `section_${crypto.randomUUID().replaceAll("-", "")}`,
    title: `Section ${draft.sections.length + 1}`,
    order: draft.sections.length,
  });
}

function productItem(product: CafeMenuProduct): { value: string; label: string } {
  return { value: product.productId, label: product.title };
}

function renderMenuSelectItem(item: { value: string; label: string }): React.ReactNode {
  return <Select.Item key={item.value} value={item.value}>{item.label}</Select.Item>;
}

/** An item names a product that the café sells, so the menu can publish. */
function addMenuProduct(
  client: React.RefObject<MenuDraftClient | null>,
  products: readonly CafeMenuProduct[],
  sectionId: string,
  order: number,
  productId: string | null,
): void {
  const product = products.find((candidate) => candidate.productId === productId);
  if (product === undefined) return;
  client.current?.addItem({
    id: `item_${crypto.randomUUID().replaceAll("-", "")}`,
    productId: product.productId,
    displayName: product.title,
    description: "",
    placement: { sectionId, order },
  });
}

function editMenuItemName(
  client: React.RefObject<MenuDraftClient | null>,
  item: MenuItem,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  client.current?.renameItem(item.id, event.currentTarget.value);
}

function editMenuItemDescription(
  client: React.RefObject<MenuDraftClient | null>,
  item: MenuItem,
  event: React.ChangeEvent<HTMLTextAreaElement>,
): void {
  client.current?.describeItem(item.id, event.currentTarget.value);
}

function deleteMenuItem(client: React.RefObject<MenuDraftClient | null>, itemId: string): void {
  client.current?.deleteItem(itemId);
}

function startMenuDrag(
  client: React.RefObject<MenuDraftClient | null>,
  itemId: string,
  event: React.DragEvent<HTMLElement>,
): void {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-pantry-menu-item", itemId);
  client.current?.select({ kind: "item", itemId });
}

function allowMenuDrop(event: React.DragEvent<HTMLElement>): void {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
}

function dropMenuItem(
  client: React.RefObject<MenuDraftClient | null>,
  sectionId: string,
  order: number,
  event: React.DragEvent<HTMLElement>,
): void {
  event.preventDefault();
  const itemId = event.dataTransfer.getData("application/x-pantry-menu-item");
  if (itemId.length === 0) return;
  client.current?.moveItem(itemId, { sectionId, order });
  client.current?.select({ kind: "item", itemId });
}

function selectMenuSection(client: React.RefObject<MenuDraftClient | null>, sectionId: string): void {
  client.current?.select({ kind: "section", sectionId });
}

function selectMenuItem(client: React.RefObject<MenuDraftClient | null>, itemId: string): void {
  client.current?.select({ kind: "item", itemId });
}

function clearMenuSelection(
  client: React.RefObject<MenuDraftClient | null>,
  event: React.FocusEvent<HTMLElement>,
): void {
  if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
  client.current?.select(null);
}

function menuItemInSection(sectionId: string, item: MenuItem): boolean {
  return item.placement.sectionId === sectionId;
}

function menuPresenceViews(view: MenuDraftView): readonly DraftPresenceView[] {
  return view.participants.map(menuPresenceView);
}

function menuPresenceView(participant: MenuDraftView["participants"][number]): DraftPresenceView {
  return { ...participant, selection: null };
}

function menuConnectionLabel(view: MenuDraftView): string {
  switch (view.kind) {
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "syncing":
      return "Saving";
    case "synced":
      return "Saved";
    case "failed":
      return "Needs attention";
    default:
      return assertNever(view, "Unexpected content studio state");
  }
}

function requestFrozenReview(path: string): Promise<unknown> {
  return controlWrite(path, "POST", {});
}

/** A read that Pantry refused with a JSON body reads as nothing; any other failure stays one. */
function refusedAsNull(error: unknown): null {
  if (controlRefusal(error) !== null) return null;
  throw error;
}

function noCleanup(): void {}

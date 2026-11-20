import {
  isMenuBoardLayout,
  isMenuBoardText,
  parseMenuBoardElement,
  type MenuBoardElement,
  type MenuBoardLayout,
  parseMenuBoardStyle,
  type MenuBoardStyle,
} from "@purin-labs/menu-board-crdt/board";
import {
  hasExactKeys,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";

/**
 * Menu boards and the screens that play them (Plan 40B phase 1). The Portal
 * edits a board as a shared draft, and a member publishes it as a release.
 * A paired screen plays the newest release of its board, with the live facts
 * of the shop's published menu on top: prices and availability. A screen
 * reads both through one feed; its socket carries only a signal.
 */

/** One board in the Portal's board list. */
export type MenuBoardSummary = Readonly<{
  boardId: string;
  title: string;
  layout: MenuBoardLayout;
  documentRevision: number;
  release: MenuBoardReleaseSummary | null;
  /** The paired screens that play this board. */
  screens: number;
}>;

export type MenuBoardReleaseSummary = Readonly<{
  releaseRevision: number;
  documentRevision: number;
  publishedAt: number;
}>;

/** One paired screen in the Portal's screen list. */
export type MenuScreenSummary = Readonly<{
  screenId: string;
  name: string;
  boardId: string;
  pairedAt: number;
  /** The last time the screen read its feed or answered on its socket. */
  lastSeenAt: number | null;
  /** Whether the screen's socket is open now. */
  connected: boolean;
}>;

/** What a screen shows while it waits: its code, until `expiresAt`. */
export type MenuScreenPairing = Readonly<{
  pairingId: string;
  code: string;
  /** The screen keeps this; only it can collect the screen's token. */
  secret: string;
  expiresAt: number;
}>;

export type MenuScreenPairingState =
  | Readonly<{ state: "waiting"; expiresAt: number; token?: never }>
  | Readonly<{ state: "paired"; token: string; expiresAt?: never }>;

/**
 * A published board: the layout and elements as they were published, and
 * the menu copy that they name. Prices and availability are not in it.
 */
export type MenuBoardRelease = Readonly<{
  boardId: string;
  releaseRevision: number;
  digest: string;
  publishedAt: number;
  title: string;
  layout: MenuBoardLayout;
  /** The board's style tokens (Plan 40B phase 5); absent in the default look. */
  style?: MenuBoardStyle;
  elements: readonly MenuBoardElement[];
  sections: readonly MenuBoardReleaseSection[];
  items: readonly MenuBoardReleaseItem[];
  /**
   * Where a TV reads the board's images (Plan 40B, the image element): the
   * Platform's screen media route, a path ending in "/", which serves an
   * image only while a published board names it. Only a release with an
   * image element has it.
   */
  mediaBase?: string;
}>;

export type MenuBoardReleaseSection = Readonly<{
  sectionId: string;
  title: string;
  /** The section's items in menu order. */
  itemIds: readonly string[];
}>;

export type MenuBoardReleaseItem = Readonly<{
  itemId: string;
  name: string;
  description: string;
}>;

export type MenuScreenMoney = Readonly<{
  amountMinor: number;
  currency: string;
}>;

/** One entry of the shop's published menu, as the order page sees it. */
export type MenuScreenEntry = Readonly<{
  menuEntryId: string;
  price: MenuScreenMoney;
  /**
   * The price before a deal (Plan 40B phase 4), higher than `price`; null
   * with no deal. The feed leaves the key out with no deal, and facts that a
   * screen saved before phase 4 have none; a parse gives null for both.
   */
  compareAtPrice?: MenuScreenMoney | null;
  availability: "available" | "unavailable";
  /**
   * The product's first photo in the shop (Plan 40B, product photos); null
   * with no photo. As with `compareAtPrice`, the feed leaves the key out
   * when there is none, and a parse gives null.
   */
  image?: MenuScreenPhoto | null;
}>;

/** A product photo that a board shows: the shop's address and its alt text. */
export type MenuScreenPhoto = Readonly<{
  url: string;
  altText: string;
}>;

export type MenuScreenFacts = Readonly<{
  observedAt: number;
  /** An entry that is not here is not on the published menu now. */
  entries: readonly MenuScreenEntry[];
  /** The shop's order page, for the board's QR code. */
  orderUrl: string | null;
}>;

/**
 * What a screen reads. `facts` is null when the shop's menu could not be
 * read now; the screen then keeps its saved facts and marks them not
 * verified.
 */
export type MenuScreenFeed = Readonly<{
  screen: Readonly<{ screenId: string; name: string }>;
  release: MenuBoardRelease | null;
  facts: MenuScreenFacts | null;
}>;

/** The one frame that a screen socket carries. */
export const MENU_SCREEN_SIGNAL = "menu_screen_changed";

/** The subprotocol that carries a screen's token when its socket opens. */
export const MENU_SCREEN_SOCKET_PROTOCOL = "satyr-screen.v1";

/** A pairing code: six letters and digits that do not look alike. */
export const MENU_SCREEN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function isMenuScreenCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-HJ-NP-Z2-9]{6}$/u.test(value);
}

export function parseMenuScreenSignal(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  try {
    const value: unknown = JSON.parse(raw);
    return (
      isRecord(value) &&
      hasExactKeys(value, ["kind"]) &&
      value.kind === MENU_SCREEN_SIGNAL
    );
  } catch {
    return false;
  }
}

export function parseMenuScreenPairing(
  value: unknown,
): MenuScreenPairing | null {
  return isRecord(value) &&
    hasExactKeys(value, ["pairingId", "code", "secret", "expiresAt"]) &&
    isShortId(value.pairingId) &&
    isMenuScreenCode(value.code) &&
    isSecret(value.secret) &&
    isPositiveInteger(value.expiresAt)
    ? {
        pairingId: value.pairingId,
        code: value.code,
        secret: value.secret,
        expiresAt: value.expiresAt,
      }
    : null;
}

export function parseMenuScreenPairingState(
  value: unknown,
): MenuScreenPairingState | null {
  if (!isRecord(value)) return null;
  if (value.state === "waiting")
    return hasExactKeys(value, ["state", "expiresAt"]) &&
      isPositiveInteger(value.expiresAt)
      ? { state: "waiting", expiresAt: value.expiresAt }
      : null;
  if (value.state === "paired")
    return hasExactKeys(value, ["state", "token"]) && isScreenToken(value.token)
      ? { state: "paired", token: value.token }
      : null;
  return null;
}

export function parseMenuScreenFeed(value: unknown): MenuScreenFeed | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["screen", "release", "facts"]) ||
    !isRecord(value.screen) ||
    !hasExactKeys(value.screen, ["screenId", "name"]) ||
    !isShortId(value.screen.screenId) ||
    !isMenuBoardText(value.screen.name)
  )
    return null;
  const release =
    value.release === null ? null : parseMenuBoardRelease(value.release);
  const facts = value.facts === null ? null : parseMenuScreenFacts(value.facts);
  if (
    (value.release !== null && release === null) ||
    (value.facts !== null && facts === null)
  )
    return null;
  return {
    screen: { screenId: value.screen.screenId, name: value.screen.name },
    release,
    facts,
  };
}

export function parseMenuBoardRelease(value: unknown): MenuBoardRelease | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "boardId",
      "releaseRevision",
      "digest",
      "publishedAt",
      "title",
      "layout",
      ...(Object.hasOwn(value, "style") ? ["style"] : []),
      "elements",
      "sections",
      "items",
      ...(Object.hasOwn(value, "mediaBase") ? ["mediaBase"] : []),
    ]) ||
    !isShortId(value.boardId) ||
    !isPositiveInteger(value.releaseRevision) ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.digest) ||
    !isNonNegativeInteger(value.publishedAt) ||
    !isMenuBoardText(value.title) ||
    !isMenuBoardLayout(value.layout) ||
    !Array.isArray(value.elements) ||
    !Array.isArray(value.sections) ||
    !Array.isArray(value.items)
  )
    return null;
  const elements: MenuBoardElement[] = [];
  for (const raw of value.elements) {
    const element = parseMenuBoardElement(raw);
    if (element === null) return null;
    elements.push(element);
  }
  const sections: MenuBoardReleaseSection[] = [];
  for (const raw of value.sections) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["sectionId", "title", "itemIds"]) ||
      !isShortId(raw.sectionId) ||
      !isMenuText(raw.title) ||
      !Array.isArray(raw.itemIds) ||
      !raw.itemIds.every(isShortId)
    )
      return null;
    sections.push({
      sectionId: raw.sectionId,
      title: raw.title,
      itemIds: raw.itemIds,
    });
  }
  const items: MenuBoardReleaseItem[] = [];
  for (const raw of value.items) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["itemId", "name", "description"]) ||
      !isShortId(raw.itemId) ||
      !isMenuText(raw.name) ||
      !isMenuText(raw.description)
    )
      return null;
    items.push({
      itemId: raw.itemId,
      name: raw.name,
      description: raw.description,
    });
  }
  const style = Object.hasOwn(value, "style")
    ? parseMenuBoardStyle(value.style)
    : undefined;
  if (style === null) return null;
  // The Platform's screen media route, on the Portal's own origin.
  if (
    Object.hasOwn(value, "mediaBase") &&
    !(
      typeof value.mediaBase === "string" &&
      /^\/v1\/screens\/media\/[^/?#]{1,200}\/$/u.test(value.mediaBase)
    )
  )
    return null;
  return {
    boardId: value.boardId,
    releaseRevision: value.releaseRevision,
    digest: value.digest,
    publishedAt: value.publishedAt,
    title: value.title,
    layout: value.layout,
    ...(style === undefined ? {} : { style }),
    elements,
    sections,
    items,
    ...(typeof value.mediaBase === "string"
      ? { mediaBase: value.mediaBase }
      : {}),
  };
}

function parseScreenMoney(value: unknown): MenuScreenMoney | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["amountMinor", "currency"]) ||
    !isNonNegativeInteger(value.amountMinor) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/u.test(value.currency)
  )
    return null;
  return { amountMinor: value.amountMinor, currency: value.currency };
}

/** The keys that a screen entry may carry; `compareAtPrice` and `image` are optional. */
const SCREEN_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "menuEntryId",
  "price",
  "compareAtPrice",
  "availability",
  "image",
]);

function parseScreenPhoto(value: unknown): MenuScreenPhoto | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["url", "altText"]) ||
    !isHttpUrl(value.url) ||
    typeof value.altText !== "string" ||
    value.altText.length > 512
  )
    return null;
  return { url: value.url, altText: value.altText };
}

export function parseMenuScreenFacts(value: unknown): MenuScreenFacts | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["observedAt", "entries", "orderUrl"]) ||
    !isNonNegativeInteger(value.observedAt) ||
    !Array.isArray(value.entries) ||
    (value.orderUrl !== null && !isHttpUrl(value.orderUrl))
  )
    return null;
  const entries: MenuScreenEntry[] = [];
  for (const raw of value.entries) {
    if (
      !isRecord(raw) ||
      !Object.keys(raw).every((key) => SCREEN_ENTRY_KEYS.has(key)) ||
      !isShortId(raw.menuEntryId) ||
      (raw.availability !== "available" && raw.availability !== "unavailable")
    )
      return null;
    const price = parseScreenMoney(raw.price);
    const compareAtPrice =
      raw.compareAtPrice === undefined || raw.compareAtPrice === null
        ? null
        : parseScreenMoney(raw.compareAtPrice);
    const image =
      raw.image === undefined || raw.image === null
        ? null
        : parseScreenPhoto(raw.image);
    if (
      price === null ||
      (raw.compareAtPrice != null &&
        (compareAtPrice === null ||
          compareAtPrice.currency !== price.currency)) ||
      (raw.image != null && image === null)
    )
      return null;
    entries.push({
      menuEntryId: raw.menuEntryId,
      price,
      compareAtPrice,
      availability: raw.availability,
      image,
    });
  }
  return {
    observedAt: value.observedAt,
    entries,
    orderUrl: value.orderUrl,
  };
}

export function parseMenuBoardSummaries(
  value: unknown,
): readonly MenuBoardSummary[] | null {
  if (!Array.isArray(value)) return null;
  const boards: MenuBoardSummary[] = [];
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, [
        "boardId",
        "title",
        "layout",
        "documentRevision",
        "release",
        "screens",
      ]) ||
      !isShortId(raw.boardId) ||
      !isMenuBoardText(raw.title) ||
      !isMenuBoardLayout(raw.layout) ||
      !isPositiveInteger(raw.documentRevision) ||
      !isNonNegativeInteger(raw.screens)
    )
      return null;
    const release = raw.release;
    if (
      release !== null &&
      (!isRecord(release) ||
        !hasExactKeys(release, [
          "releaseRevision",
          "documentRevision",
          "publishedAt",
        ]) ||
        !isPositiveInteger(release.releaseRevision) ||
        !isPositiveInteger(release.documentRevision) ||
        !isNonNegativeInteger(release.publishedAt))
    )
      return null;
    boards.push({
      boardId: raw.boardId,
      title: raw.title,
      layout: raw.layout,
      documentRevision: raw.documentRevision,
      release:
        release === null
          ? null
          : {
              releaseRevision: release.releaseRevision as number,
              documentRevision: release.documentRevision as number,
              publishedAt: release.publishedAt as number,
            },
      screens: raw.screens,
    });
  }
  return boards;
}

export function parseMenuScreenSummaries(
  value: unknown,
): readonly MenuScreenSummary[] | null {
  if (!Array.isArray(value)) return null;
  const screens: MenuScreenSummary[] = [];
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, [
        "screenId",
        "name",
        "boardId",
        "pairedAt",
        "lastSeenAt",
        "connected",
      ]) ||
      !isShortId(raw.screenId) ||
      !isMenuBoardText(raw.name) ||
      !isShortId(raw.boardId) ||
      !isNonNegativeInteger(raw.pairedAt) ||
      (raw.lastSeenAt !== null && !isNonNegativeInteger(raw.lastSeenAt)) ||
      typeof raw.connected !== "boolean"
    )
      return null;
    screens.push({
      screenId: raw.screenId,
      name: raw.name,
      boardId: raw.boardId,
      pairedAt: raw.pairedAt,
      lastSeenAt: raw.lastSeenAt,
      connected: raw.connected,
    });
  }
  return screens;
}

function isShortId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:-]{1,128}$/u.test(value);
}

/** A menu name or description, which the menu draft bounds at 1,000. */
function isMenuText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1_000;
}

function isSecret(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/u.test(value);
}

function isScreenToken(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 512 && /^scr1\./u.test(value)
  );
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

import React from "react";
import { useLocation, useNavigate } from "react-router";
import {
  pageAddress,
  pageLink,
  parseChatReturnPath,
} from "@purin-labs/ui/page-address";

export type BrainView =
  | "overview"
  | "learning"
  | "knowledge"
  | "skills"
  | "evals"
  | "activity"
  | "context";

/**
 * The pages that hold the views: Knowledge holds most of them, and the
 * Agents page holds Activity as its second tab.
 */
export type BrainSection = "knowledge" | "agents";

const SECTION_OF_VIEW: Readonly<Record<BrainView, BrainSection>> = {
  overview: "knowledge",
  learning: "knowledge",
  knowledge: "knowledge",
  skills: "knowledge",
  context: "knowledge",
  activity: "agents",
  evals: "knowledge",
};

/** The view that a page opens when its address names none. */
const SECTION_DEFAULT_VIEW: Readonly<Record<BrainSection, BrainView>> = {
  knowledge: "overview",
  agents: "activity",
};

export function brainViewSection(view: BrainView): BrainSection {
  return SECTION_OF_VIEW[view];
}

/**
 * Which view of the Brain page is open and which record is selected in it.
 * The address of the page holds it, so a link opens the same view.
 */
/** A filter of the Knowledge list by what a record is doing now. */
export type KnowledgeState = "review" | "in_use" | "not_in_use";

export type BrainAddress = Readonly<{
  view: BrainView;
  /** Knowledge: the selected Memory. */
  memoryId: string | null;
  /** Knowledge: the state that the list is limited to, or null for all. */
  state: KnowledgeState | null;
  /** Evals: the Eval that a link points at. */
  evalId: string | null;
  /** Activity: the open Case, and the selected record of it. */
  caseId: string | null;
  nodeId: string | null;
}>;

const VIEWS: Readonly<Record<BrainView, true>> = {
  overview: true,
  learning: true,
  knowledge: true,
  skills: true,
  evals: true,
  activity: true,
  context: true,
};

const STATES: Readonly<Record<KnowledgeState, true>> = {
  review: true,
  in_use: true,
  not_in_use: true,
};

/** The longest identity that an address may carry. */
const MAX_IDENTITY = 256;

function isBrainView(raw: string | null): raw is BrainView {
  return raw !== null && Object.hasOwn(VIEWS, raw);
}

function knowledgeState(raw: string | null): KnowledgeState | null {
  return raw !== null && Object.hasOwn(STATES, raw)
    ? (raw as KnowledgeState)
    : null;
}

function identity(raw: string | null): string | null {
  return raw !== null && raw.length > 0 && raw.length <= MAX_IDENTITY
    ? raw
    : null;
}

export function brainAddress(
  view: BrainView,
  selection: Partial<Omit<BrainAddress, "view">> = {},
): BrainAddress {
  const caseId = view === "activity" ? (selection.caseId ?? null) : null;
  return {
    view,
    memoryId: view === "knowledge" ? (selection.memoryId ?? null) : null,
    state: view === "knowledge" ? (selection.state ?? null) : null,
    evalId: view === "evals" ? (selection.evalId ?? null) : null,
    caseId,
    nodeId: caseId === null ? null : (selection.nodeId ?? null),
  };
}

/**
 * Reads the address from a query string. An unknown view, or a view of
 * another page, opens the first view of the page. With no page named, it
 * opens Overview.
 */
export function readBrainAddress(
  search: string,
  section: BrainSection | null = null,
): BrainAddress {
  const query = new URLSearchParams(search);
  const raw = query.get("view");
  const fallback =
    section === null ? "overview" : SECTION_DEFAULT_VIEW[section];
  const view =
    isBrainView(raw) && (section === null || SECTION_OF_VIEW[raw] === section)
      ? raw
      : fallback;
  return brainAddress(view, {
    memoryId: identity(query.get("memory")),
    state: knowledgeState(query.get("state")),
    evalId: identity(query.get("eval")),
    caseId: identity(query.get("case")),
    nodeId: identity(query.get("record")),
  });
}

/**
 * The query string of an address. Parameters that belong to another owner
 * of the same page stay as they are.
 */
export function brainAddressSearch(
  address: BrainAddress,
  search: string,
): string {
  const query = new URLSearchParams(search);
  const set = (name: string, value: string | null): void => {
    if (value === null) query.delete(name);
    else query.set(name, value);
  };
  // Overview is the page's first view. The Agents page also needs the view
  // in its address, to tell Activity from the list of agents.
  set("view", address.view === "overview" ? null : address.view);
  set("memory", address.memoryId);
  set("state", address.state);
  set("eval", address.evalId);
  set("case", address.caseId);
  set("record", address.nodeId);
  const text = query.toString();
  return text.length === 0 ? "" : `?${text}`;
}

/** The Portal pages that hold Brain views; `brain` is the old address. */
const BRAIN_PAGE_SEGMENTS: ReadonlySet<string> = new Set([
  "brain",
  "knowledge",
  "agents",
]);

/**
 * The path of the page that holds a view, beside the page that is open. A
 * page outside the Portal pages, such as the Brain preview, holds every view
 * at its own path.
 */
function brainSectionPath(pathname: string, view: BrainView): string {
  const slash = pathname.lastIndexOf("/");
  if (!BRAIN_PAGE_SEGMENTS.has(pathname.slice(slash + 1))) return pathname;
  return `${pathname.slice(0, slash + 1)}${SECTION_OF_VIEW[view]}`;
}

function brainAddressHref(
  address: BrainAddress,
  page: Readonly<{ pathname: string; search: string }>,
): string {
  const path = brainSectionPath(page.pathname, address.view);
  return `${path}${brainAddressSearch(address, page.search)}${window.location.hash}`;
}

/**
 * The page that holds the Brain address. Brain moves between its own views
 * with history.pushState, which the router does not see, so without the chat
 * the browser address is the current one.
 */
function brainPage(
  location: Parameters<typeof pageAddress>[0],
): Readonly<{ pathname: string; search: string }> {
  return parseChatReturnPath(location.state) === null
    ? { pathname: window.location.pathname, search: window.location.search }
    : pageAddress(location);
}

type BrainNavigation = Readonly<{
  address: BrainAddress;
  /** The link to an address, for a tab or a row. */
  href: (address: BrainAddress) => string;
  /** Opens an address and adds it to the history of the tab. */
  open: (address: BrainAddress) => void;
}>;

/**
 * Keeps the Brain page's view in the address of the browser tab. The page
 * follows the Back and Forward buttons.
 */
export function useBrainNavigation(section: BrainSection): BrainNavigation {
  const navigate = useNavigate();
  // With the chat open, the page beside the chat holds the Brain address.
  const location = useLocation();
  const [address, setAddress] = React.useState<BrainAddress>(() =>
    readBrainAddress(brainPage(location).search, section),
  );
  React.useEffect(() => {
    const follow = (): void =>
      setAddress(readBrainAddress(window.location.search, section));
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, [section]);
  // A view change beside the open chat is a router entry; Back and Forward
  // restore its address from the router state.
  React.useEffect(() => {
    if (parseChatReturnPath(location.state) !== null)
      setAddress(readBrainAddress(pageAddress(location).search, section));
  }, [location, section]);
  const href = React.useCallback(
    (next: BrainAddress): string => brainAddressHref(next, brainPage(location)),
    [location],
  );
  const open = React.useCallback(
    (next: BrainAddress): void => {
      const target = brainAddressHref(next, brainPage(location));
      // A view of another page opens that page, which reads its own address.
      if (SECTION_OF_VIEW[next.view] !== section) {
        void navigate(target);
        return;
      }
      // The chat stays open, and the page beside it shows the view.
      if (parseChatReturnPath(location.state) !== null) {
        const link = pageLink(location, target);
        void navigate(link.to, { state: link.state });
        setAddress(next);
        return;
      }
      if (
        target !==
        `${window.location.pathname}${window.location.search}${window.location.hash}`
      )
        // The router's own state stays on the entry, as in the chat route.
        window.history.pushState(window.history.state, "", target);
      setAddress(next);
    },
    [location, navigate, section],
  );
  return { address, href, open };
}

import type { To } from "react-router";

/**
 * The chat opens beside a page. Its route keeps the address of that page in
 * the router state, so the page stays the same while the chat is open and
 * closing the chat returns to it.
 */
export type ChatRouteState = Readonly<{ chatReturnPath: string }>;

type RouterLocation = Readonly<{
  pathname: string;
  search: string;
  state: unknown;
}>;

/** The router state with which the chat opens beside a page and returns. */
export function chatRouteState(
  pathname: string,
  search: string,
): ChatRouteState {
  return { chatReturnPath: `${pathname}${search}` };
}

/** The address of the page beside the open chat, or null with no chat open. */
export function parseChatReturnPath(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const path = Reflect.get(state, "chatReturnPath");
  if (typeof path !== "string" || !path.startsWith("/portal/")) return null;
  return path;
}

/** The address of the page on screen: with the chat open, the page beside it. */
export function pageAddress(
  location: RouterLocation,
): Readonly<{ pathname: string; search: string }> {
  const returnPath = parseChatReturnPath(location.state);
  if (returnPath === null)
    return { pathname: location.pathname, search: location.search };
  const url = new URL(returnPath, window.location.origin);
  return { pathname: url.pathname, search: url.search };
}

/**
 * The target of a link to another page. With the chat open, the link stays on
 * the chat route and opens the page beside the chat, so the chat stays open.
 */
export function pageNavigation(
  location: RouterLocation,
  chatOpen: boolean,
  href: string,
): Readonly<{ to: To; state?: ChatRouteState }> {
  const url = new URL(href, window.location.origin);
  if (!chatOpen || url.pathname === location.pathname) return { to: href };
  return {
    to: { pathname: location.pathname, search: location.search },
    state: chatRouteState(url.pathname, url.search),
  };
}

/**
 * The target of a link to another view of the page on screen. With the chat
 * open, the link stays on the chat route and moves the page beside the chat,
 * so the chat does not close.
 */
export function pageLink(
  location: RouterLocation,
  href: string,
): Readonly<{ to: To; state?: ChatRouteState }> {
  if (parseChatReturnPath(location.state) === null) return { to: href };
  const url = new URL(href, window.location.origin);
  return {
    to: { pathname: location.pathname, search: location.search },
    state: chatRouteState(url.pathname, url.search),
  };
}

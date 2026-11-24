import React, { useEffect } from "react";
import { ArrowUpRight, BookOpen, LogOut } from "lucide-react";
import { workspaceNavigationIcon } from "@purin-labs/ui/page-icons";
import { assertNever } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";
import "./account-menu.css";

const DOCS_ORIGIN = (
  import.meta.env.VITE_DOCS_ORIGIN || "http://docs.localhost:3005"
).replace(/\/$/, "");

/** Permission requests have the picture of the page that lists them. */
const PermissionRequestsIcon = workspaceNavigationIcon("access");

export type PortalFrameIdentity =
  | {
      readonly kind: "ready";
      readonly displayName: string;
      readonly photoUrl?: string;
      readonly usagePercent?: number;
      readonly usageSource?: "Workspace" | "Codex";
      readonly logout: () => Promise<void>;
      /** The workspace's waiting permission requests, in a drawer. */
      readonly permissionRequests?: {
        /** Requests that wait for this person's decision; null for none. */
        readonly count: number | null;
        readonly open: () => void;
      };
    }
  | { readonly kind: "loading" };

type ReadyIdentity = Variant<PortalFrameIdentity, "ready">;

/**
 * The account menu. In the top bar its trigger is the avatar; at the foot of
 * the sidebar the name follows the avatar, and the menu opens upward with the
 * width of the foot. The menu names the person and the usage, then holds the
 * actions: permission requests, the docs and sign out.
 */
export function AccountMenu(props: {
  readonly identity: PortalFrameIdentity;
  readonly placement: "topbar" | "sidebar";
}): React.ReactNode {
  const menuRef = React.useRef<HTMLDetailsElement>(null);
  useEffect(bindAccountMenuDismissal.bind(null, menuRef), []);
  switch (props.identity.kind) {
    case "loading":
      return (
        <span className="portal-identity-placeholder" aria-hidden="true" />
      );
    case "ready": {
      const usage = usageText(props.identity);
      return (
        <div className="identity-menu-anchor">
          <details
            ref={menuRef}
            className="identity-menu"
            onKeyDown={closeDetailsOnEscape}
          >
            <summary
              className="identity-usage-trigger"
              aria-label={`Account: ${props.identity.displayName}. ${waitingRequestsLabel(props.identity)}${usage}`}
              title={usage}
            >
              <AccountAvatar identity={props.identity} />
              {props.placement === "sidebar" ? (
                <span className="identity-usage-name" aria-hidden="true">
                  {props.identity.displayName}
                </span>
              ) : null}
            </summary>
            <div className="identity-menu-popover">
              <div className="identity-menu-head">
                <strong>{props.identity.displayName}</strong>
                <small>{usage}</small>
                {props.identity.usagePercent === undefined ? null : (
                  <span className="identity-menu-meter" aria-hidden="true">
                    <span
                      style={{
                        inlineSize: `${Math.min(100, Math.max(0, props.identity.usagePercent))}%`,
                      }}
                    />
                  </span>
                )}
              </div>
              <div className="identity-menu-rule" aria-hidden="true" />
              {props.identity.permissionRequests === undefined ? null : (
                <button
                  className="identity-menu-action"
                  type="button"
                  onClick={openFromMenu.bind(
                    null,
                    props.identity.permissionRequests.open,
                  )}
                >
                  <PermissionRequestsIcon size={18} aria-hidden="true" />
                  <span>Permission requests</span>
                  {props.identity.permissionRequests.count === null ? null : (
                    <span className="identity-menu-count">
                      {props.identity.permissionRequests.count}
                      <span className="visually-hidden"> waiting</span>
                    </span>
                  )}
                </button>
              )}
              <a
                className="identity-menu-action"
                href={DOCS_ORIGIN}
                target="_blank"
                rel="noreferrer"
                onClick={closeContainingDetails}
              >
                <BookOpen size={18} aria-hidden="true" />
                <span>Docs and resources</span>
                <ArrowUpRight
                  size={16}
                  className="identity-menu-end"
                  aria-hidden="true"
                />
              </a>
              <div className="identity-menu-rule" aria-hidden="true" />
              <button
                className="identity-menu-action"
                type="button"
                onClick={props.identity.logout}
              >
                <LogOut size={18} aria-hidden="true" />
                <span>Sign out</span>
              </button>
            </div>
          </details>
        </div>
      );
    }
    default:
      return assertNever(props.identity, "Unexpected value");
  }
}

/** The avatar with the usage ring and the mark for waiting requests. */
function AccountAvatar(props: {
  readonly identity: ReadyIdentity;
}): React.ReactNode {
  return (
    <span className="identity-usage-avatar">
      <svg
        className="identity-usage-ring"
        viewBox="0 0 40 40"
        aria-hidden="true"
      >
        <circle className="identity-usage-track" cx="20" cy="20" r="17" />
        {props.identity.usagePercent === undefined ? null : (
          <circle
            className="identity-usage-progress"
            cx="20"
            cy="20"
            r="17"
            pathLength="100"
            strokeDasharray={`${props.identity.usagePercent} 100`}
          />
        )}
      </svg>
      <span className="identity-usage-photo" aria-hidden="true">
        {props.identity.photoUrl ? (
          <img
            src={props.identity.photoUrl}
            alt=""
            referrerPolicy="no-referrer"
          />
        ) : (
          identityInitial(props.identity.displayName)
        )}
      </span>
      <span className="identity-usage-value" aria-hidden="true">
        {props.identity.usagePercent === undefined
          ? "—"
          : `${props.identity.usagePercent}%`}
      </span>
      {waitingRequests(props.identity) === null ? null : (
        <span className="identity-usage-attention" aria-hidden="true" />
      )}
    </span>
  );
}

function usageText(identity: ReadyIdentity): string {
  return identity.usagePercent === undefined
    ? "Usage unavailable"
    : `${identity.usageSource ?? "Workspace"} usage: ${identity.usagePercent}% used`;
}

function waitingRequests(identity: ReadyIdentity): number | null {
  return identity.permissionRequests?.count ?? null;
}

function waitingRequestsLabel(identity: ReadyIdentity): string {
  const count = waitingRequests(identity);
  return count === null
    ? ""
    : `${count} permission ${count === 1 ? "request waits" : "requests wait"}. `;
}

/** What the closed drawer's toggle says waits inside: the account's requests. */
export function waitingRequestsText(
  identity: PortalFrameIdentity,
): string | null {
  if (identity.kind !== "ready") return null;
  const count = waitingRequests(identity);
  return count === null
    ? null
    : `${count} permission ${count === 1 ? "request" : "requests"} waiting`;
}

function identityInitial(displayName: string): string {
  const initial = Array.from(displayName.trim())[0];
  return initial === undefined ? "P" : initial.toLocaleUpperCase();
}

function bindAccountMenuDismissal(
  menuRef: React.RefObject<HTMLDetailsElement | null>,
): () => void {
  const listener = closeAccountMenuOnOutsidePointerDown.bind(null, menuRef);
  document.addEventListener("pointerdown", listener);
  return removeAccountMenuDismissal.bind(null, listener);
}

function removeAccountMenuDismissal(
  listener: (event: PointerEvent) => void,
): void {
  document.removeEventListener("pointerdown", listener);
}

function closeAccountMenuOnOutsidePointerDown(
  menuRef: React.RefObject<HTMLDetailsElement | null>,
  event: PointerEvent,
): void {
  const menu = menuRef.current;
  const target = event.target;
  if (
    menu === null ||
    !menu.open ||
    !(target instanceof Node) ||
    menu.contains(target)
  ) {
    return;
  }
  menu.open = false;
}

function closeDetailsOnEscape(
  event: React.KeyboardEvent<HTMLDetailsElement>,
): void {
  if (event.key !== "Escape" || !event.currentTarget.open) return;
  event.preventDefault();
  const summary = event.currentTarget.querySelector<HTMLElement>("summary");
  event.currentTarget.open = false;
  summary?.focus();
}

/** Close the account menu, then open what its entry names. */
function openFromMenu(
  open: () => void,
  event: React.MouseEvent<HTMLButtonElement>,
): void {
  const disclosure = event.currentTarget.closest<HTMLDetailsElement>("details");
  if (disclosure !== null) disclosure.open = false;
  open();
}

function closeContainingDetails(
  event: React.MouseEvent<HTMLAnchorElement>,
): void {
  const disclosure = event.currentTarget.closest<HTMLDetailsElement>("details");
  if (disclosure !== null) disclosure.open = false;
}

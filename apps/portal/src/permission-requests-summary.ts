import React from "react";

import {
  parseAgentPermissionRequestList,
  type AgentPermissionRequestList,
} from "@seams/control-api";

import { controlRead, forgetWithControlReads } from "./control-client";
import { permissionRequestsPath } from "./control-paths";

/**
 * The permission requests that wait for an owner or admin. The navigation
 * and the Access page read one copy for each Organisation, so both show one
 * number.
 */
const lists = new Map<string, AgentPermissionRequestList>();
const listeners = new Set<() => void>();

forgetWithControlReads(() => {
  lists.clear();
  notify();
});

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reads the list again, for example after a decision. */
export async function refreshPermissionRequests(
  organisationId: string,
): Promise<void> {
  try {
    const list = parseAgentPermissionRequestList(
      await controlRead(permissionRequestsPath(organisationId)),
    );
    if (list === null) lists.delete(organisationId);
    else lists.set(organisationId, list);
  } catch {
    // The list is supplementary. A failed read shows no count.
    lists.delete(organisationId);
  }
  notify();
}

const REFRESH_MS = 60_000;

function watchPermissionRequests(organisationId: string): () => void {
  void refreshPermissionRequests(organisationId);
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible")
      void refreshPermissionRequests(organisationId);
  }, REFRESH_MS);
  return () => window.clearInterval(timer);
}

/**
 * The requests that wait, or null before the first read. The list is read
 * when the workspace opens, every minute while the tab is in view, and after
 * a decision.
 */
export function usePermissionRequests(
  organisationId: string,
): AgentPermissionRequestList | null {
  React.useEffect(
    () => watchPermissionRequests(organisationId),
    [organisationId],
  );
  const snapshot = (): AgentPermissionRequestList | null =>
    lists.get(organisationId) ?? null;
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** How many requests wait for this person's decision; null when none. */
export function useRequestsToDecide(organisationId: string): number | null {
  const list = usePermissionRequests(organisationId);
  if (list === null) return null;
  const count =
    (list.mayDecide ? list.requests.length : 0) + list.heldOutputs.length;
  return count === 0 ? null : count;
}

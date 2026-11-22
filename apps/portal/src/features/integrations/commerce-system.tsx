import React from "react";
import {
  StatusChip,
  formatRelativeTime,
} from "../../page-components";
import { assertNever } from "@purin-labs/std";
import type {
  CommerceSystem,
  CommerceSystemSync,
} from "./settings-types";

export function autoSyncCommerce(
  started: React.MutableRefObject<boolean>,
  behind: boolean,
  sync: () => Promise<void>,
): void {
  if (!behind || started.current) return;
  started.current = true;
  console.info("[commerce] Data is behind. Starting a sync automatically.");
  void sync();
}

export function renderCommerceSystemCard(
  system: CommerceSystem | null,
  sync: () => Promise<void>,
  syncing: boolean,
  canManage: boolean,
  problem: string | null,
): React.ReactNode {
  if (system === null) {
    // A manager gets the choice itself under this card instead.
    return canManage ? null : (
      <p className="empty-state">
        Choose Purin Checkout or connect a Shopify store.
      </p>
    );
  }
  const shopify = system.kind === "shopify";
  return (
    <div className="account-list">
      <div className="connection-card">
        <div className="connection-body">
          <div className="connection-head">
            <div className="connection-identity">
              <strong>
                {shopify ? system.shopDomain : "Products, stock and orders"}
              </strong>
              <span>{formatCommerceSystemSync(system.sync, syncing)}</span>
            </div>
            <div className="connection-status">
              {renderCommerceSystemSyncChip(system.sync, syncing)}
            </div>
          </div>
          {problem === null ? null : (
            <p id="commerce-sync-error" className="error-text" role="alert">
              {problem}
            </p>
          )}
          {shopify || !canManage ? null : (
            <div className="connection-command">
              <button
                type="button"
                onClick={sync}
                aria-describedby={
                  problem === null ? undefined : "commerce-sync-error"
                }
                disabled={syncing || system.sync.kind === "syncing"}
              >
                Sync now
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* An in-flight sync command reads as syncing even while the projection still
   says delayed, so auto-sync never flashes "Behind" on its way to current. */

function renderCommerceSystemSyncChip(
  sync: CommerceSystemSync,
  syncing: boolean,
): React.ReactNode {
  if (syncing)
    return <StatusChip status={{ kind: "info", label: "Syncing" }} />;
  switch (sync.kind) {
    case "syncing":
      return <StatusChip status={{ kind: "info", label: "Syncing" }} />;
    case "delayed":
      return <StatusChip status={{ kind: "warning", label: "Behind" }} />;
    case "ready":
      return <StatusChip status={{ kind: "success", label: "Up to date" }} />;
    default:
      return assertNever(sync, "Unexpected settings state");
  }
}

function formatCommerceSystemSync(
  sync: CommerceSystemSync,
  syncing: boolean,
): string {
  if (syncing) return "Checking products, inventory, and orders…";
  switch (sync.kind) {
    case "syncing":
      return "Checking products, inventory, and orders…";
    case "delayed":
      return `Last synced ${formatRelativeTime(sync.lastSyncedAt)}.`;
    case "ready":
      return `Last synced ${formatRelativeTime(sync.lastSyncedAt)}`;
    default:
      return assertNever(sync, "Unexpected settings state");
  }
}

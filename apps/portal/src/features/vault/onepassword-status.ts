import React from "react";
import {
  parseVaultStoreSummary,
  type VaultStoreSummary,
} from "@purin-labs/control-api";

import { controlRead } from "../../control-client";
import { vaultStorePath } from "../../control-paths";

/**
 * The 1Password card's status on Integrations (Plan 79). It reads where the
 * Vault keeps its items from Pantry alone, so a page visit never calls
 * 1Password. The card's panel, which lists items and talks to 1Password,
 * loads only when someone opens the card.
 */
export type OnePasswordStatusState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "ready"; store: VaultStoreSummary }>;

export type OnePasswordStatus = Readonly<{
  state: OnePasswordStatusState;
  reload: () => Promise<void>;
}>;

export function useOnePasswordStatus(
  organisationId: string,
): OnePasswordStatus {
  const [state, setState] = React.useState<OnePasswordStatusState>({
    kind: "loading",
  });
  const reload = React.useCallback(async (): Promise<void> => {
    try {
      const store = parseVaultStoreSummary(
        await controlRead(vaultStorePath(organisationId)),
      );
      setState(store === null ? { kind: "failed" } : { kind: "ready", store });
    } catch {
      setState({ kind: "failed" });
    }
  }, [organisationId]);
  React.useEffect(() => {
    void reload();
  }, [reload]);
  return { state, reload };
}

export function onePasswordStatusLabel(
  state: OnePasswordStatusState,
): Readonly<{ kind: "attention" | "connected" | "idle"; label: string }> {
  if (state.kind === "loading") return { kind: "idle", label: "Loading" };
  if (state.kind === "failed")
    return { kind: "attention", label: "Unavailable" };
  return state.store.kind === "onepassword"
    ? { kind: "connected", label: "Connected" }
    : { kind: "idle", label: "Not connected" };
}

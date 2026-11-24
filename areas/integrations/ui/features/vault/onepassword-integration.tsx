import React from "react";
import type { VaultItemList } from "@purin-labs/control-api";

import { VAULT_TRANSPORT, vaultErrorMessage, type VaultTransport } from "./api";
import {
  ConnectForm,
  StoreDetails,
  type OnePasswordVaultChoice,
} from "./store-panel";
import "@purin-labs/area-integrations-contract/ui/features/vault/styles.css";

/**
 * The panel of the 1Password card on Integrations (Plan 79). Integrations
 * loads this module only when someone opens the card; the card's status comes
 * from `onepassword-status.ts`, which never calls 1Password. It is the same
 * connection that Settings → Vault manages: one service account and one vault
 * for each Organisation, where the Vault keeps its items.
 */
type ListState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; list: VaultItemList }>;

type ConnectDraft = Readonly<{
  token: string;
  vaults: readonly OnePasswordVaultChoice[] | null;
  vaultId: string | null;
}>;

export function OnePasswordIntegrationPanel(props: {
  readonly organisationId: string;
  readonly canManage: boolean;
  readonly vaultHref: string;
  /** The card's status reads again after a change. */
  readonly onChanged: () => void;
  readonly transport?: VaultTransport;
}): React.ReactNode {
  const transport = props.transport ?? VAULT_TRANSPORT;
  const { onChanged, organisationId } = props;
  const [state, setState] = React.useState<ListState>({ kind: "loading" });
  const reload = React.useCallback(async (): Promise<void> => {
    try {
      setState({ kind: "ready", list: await transport.list(organisationId) });
    } catch (error) {
      setState({ kind: "failed", message: vaultErrorMessage(error) });
    }
  }, [organisationId, transport]);
  React.useEffect(() => {
    void reload();
  }, [reload]);
  const changed = async (): Promise<void> => {
    await reload();
    onChanged();
  };
  const [draft, setDraft] = React.useState<ConnectDraft>({
    token: "",
    vaults: null,
    vaultId: null,
  });
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = React.useState(false);

  const run = async (work: () => Promise<string | null>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const message = await work();
      if (message !== null) setNotice(message);
    } catch (error) {
      setFailure(vaultErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const connect = (): void =>
    void run(async () => {
      const result = await transport.store(props.organisationId, {
        kind: "connect_onepassword",
        token: draft.token.trim(),
        vaultId: draft.vaultId,
      });
      if (result.kind === "choose_vault") {
        setDraft({ ...draft, vaults: result.vaults, vaultId: null });
        return null;
      }
      setDraft({ token: "", vaults: null, vaultId: null });
      await changed();
      return "1Password connected. New Vault items now go to 1Password.";
    });

  const move = (to: "onepassword" | "pantry"): void =>
    void run(async () => {
      const result = await transport.store(props.organisationId, {
        kind: "move_items",
        to,
      });
      await changed();
      return result.kind === "moved"
        ? `${result.moved === 1 ? "1 item" : `${result.moved} items`} moved.${
            result.remaining > 0
              ? ` ${result.remaining} left; move again to continue.`
              : ""
          }`
        : null;
    });

  const disconnect = (): void =>
    void run(async () => {
      await transport.store(props.organisationId, {
        kind: "disconnect_onepassword",
      });
      setConfirmingDisconnect(false);
      await changed();
      return "1Password disconnected. Its items stay in 1Password.";
    });

  return (
    <section className="vault-integration" aria-label="1Password">
      <p className="vault-integration-lead">
        Agents use the items through Purin Pantry and never see a password.
      </p>
      <p className="vault-notice" role="status">
        {notice}
      </p>
      {state.kind === "loading" ? (
        <p className="vault-loading">Loading…</p>
      ) : state.kind === "failed" ? (
        <div className="vault-load-failed" role="alert">
          <p>{state.message}</p>
          <button
            type="button"
            className="vault-secondary"
            onClick={() => void reload()}
          >
            Try again
          </button>
        </div>
      ) : !props.canManage ? (
        <p className="vault-field-hint">
          {state.list.store.kind === "onepassword"
            ? `The Vault keeps its items in the 1Password vault ${state.list.store.vaultTitle}.`
            : "1Password is not connected."}{" "}
          An owner or admin manages this connection.
        </p>
      ) : state.list.store.kind === "pantry" ? (
        <ConnectForm
          token={draft.token}
          vaults={draft.vaults}
          vaultId={draft.vaultId}
          busy={busy}
          failure={failure}
          change={(patch) => setDraft({ ...draft, ...patch })}
          submit={connect}
          cancel={() => setDraft({ token: "", vaults: null, vaultId: null })}
        />
      ) : (
        <StoreDetails
          store={state.list.store}
          items={state.list.items}
          busy={busy}
          failure={failure}
          confirmingDisconnect={confirmingDisconnect}
          move={move}
          askDisconnect={setConfirmingDisconnect}
          disconnect={disconnect}
          organisationId={props.organisationId}
          transport={transport}
        />
      )}
      <p className="vault-integration-link">
        <a href={props.vaultHref}>Open the Vault</a>
      </p>
    </section>
  );
}

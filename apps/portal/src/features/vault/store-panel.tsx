import React from "react";
import { Eye, EyeOff } from "lucide-react";
import type {
  VaultEvent,
  VaultEventKind,
  VaultItemView,
  VaultStoreView,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

import type { VaultTransport } from "./api";
import type { Variant } from "@purin-labs/type-utils";

/** The vaults that a token reaches, when the person must choose one. */
export type OnePasswordVaultChoice = Readonly<{
  vaultId: string;
  title: string;
  itemCount: number;
}>;

/** One quiet line above the list: where items live, and a way to change it. */
export function StoreLine(props: {
  readonly store: VaultStoreView;
  readonly canManage: boolean;
  readonly openStore: () => void;
}): React.ReactNode {
  const { store } = props;
  return (
    <div className="vault-store-line">
      <p>
        {store.kind === "satyr" ? (
          <>Storage: Seams Vault</>
        ) : (
          <>
            Storage: 1Password · <strong>{store.vaultTitle}</strong>
            {store.reachable ? null : (
              <span className="vault-store-warning">
                {" "}
                1Password did not answer, so only Seams Vault items show.
              </span>
            )}
          </>
        )}
      </p>
      {props.canManage ? (
        <button
          type="button"
          className="vault-text-button"
          onClick={props.openStore}
        >
          Manage storage
        </button>
      ) : null}
    </div>
  );
}

/** The drawer form that connects a 1Password service account. */
export function ConnectForm(props: {
  readonly token: string;
  readonly vaults: readonly OnePasswordVaultChoice[] | null;
  readonly vaultId: string | null;
  readonly busy: boolean;
  readonly failure: string | null;
  readonly change: (
    patch: Readonly<{ token?: string; vaultId?: string | null }>,
  ) => void;
  readonly submit: () => void;
  readonly cancel: () => void;
}): React.ReactNode {
  const [revealed, setRevealed] = React.useState(false);
  return (
    <form
      className="side-drawer-body"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        props.submit();
      }}
    >
      <ol className="vault-steps">
        <li>
          In 1Password, create a service account with read and write access to
          one shared vault, for example “Seams”.
        </li>
        <li>Paste its token here.</li>
      </ol>
      <div className="vault-field">
        <label htmlFor="vault-onepassword-token">Service account token</label>
        <div className="vault-password">
          <input
            id="vault-onepassword-token"
            type={revealed ? "text" : "password"}
            value={props.token}
            autoComplete="off"
            spellCheck={false}
            placeholder="ops_…"
            onChange={(event) =>
              props.change({ token: event.currentTarget.value })
            }
          />
          <button
            type="button"
            className="icon-button"
            aria-label={revealed ? "Hide token" : "Show token"}
            aria-pressed={revealed}
            onClick={() => setRevealed(!revealed)}
          >
            {revealed ? (
              <EyeOff size={18} aria-hidden="true" />
            ) : (
              <Eye size={18} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      {props.vaults === null ? null : (
        <fieldset className="vault-field-group">
          <legend>This token reaches more than one vault. Choose one.</legend>
          {props.vaults.map((vault) => (
            <label key={vault.vaultId} className="vault-choice">
              <input
                type="radio"
                name="vault-onepassword-vault"
                value={vault.vaultId}
                checked={props.vaultId === vault.vaultId}
                onChange={() => props.change({ vaultId: vault.vaultId })}
              />
              <span>
                <span className="vault-row-title">{vault.title}</span>
                <span className="vault-row-detail">
                  {vault.itemCount === 1
                    ? "1 item"
                    : `${vault.itemCount} items`}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <p className="vault-secret-note">
        Seams keeps the token encrypted and never shows it. New items then go to
        1Password, and you can move your Seams Vault items there.
      </p>
      {props.failure === null ? null : (
        <p className="vault-failure" role="alert">
          {props.failure}
        </p>
      )}
      <div className="vault-actions">
        <button
          type="submit"
          className="vault-primary"
          disabled={
            props.busy ||
            props.token.trim() === "" ||
            (props.vaults !== null && props.vaultId === null)
          }
        >
          {props.busy ? "Connecting…" : "Connect"}
        </button>
        <button
          type="button"
          className="vault-text-button"
          onClick={props.cancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The connected store: move items, disconnect, and the store's history. */
export function StoreDetails(props: {
  readonly store: Variant<VaultStoreView, "onepassword">;
  readonly items: readonly VaultItemView[];
  readonly busy: boolean;
  readonly failure: string | null;
  readonly confirmingDisconnect: boolean;
  readonly move: (to: "onepassword" | "satyr") => void;
  readonly askDisconnect: (asking: boolean) => void;
  readonly disconnect: () => void;
  readonly organisationId: string;
  readonly transport: VaultTransport;
}): React.ReactNode {
  const pantryCount = props.items.filter(
    (item) => item.store === "satyr",
  ).length;
  const onePasswordCount = props.items.length - pantryCount;
  return (
    <div className="side-drawer-body">
      <dl className="vault-details">
        <div>
          <dt>1Password vault</dt>
          <dd>{props.store.vaultTitle}</dd>
        </div>
        <div>
          <dt>Connected</dt>
          <dd>{formatDate(props.store.connectedAt)}</dd>
        </div>
        <div>
          <dt>Items</dt>
          <dd>
            {onePasswordCount} in 1Password · {pantryCount} in Seams Vault
          </dd>
        </div>
      </dl>
      {props.failure === null ? null : (
        <p className="vault-failure" role="alert">
          {props.failure}
        </p>
      )}
      {props.confirmingDisconnect ? (
        <div
          className="vault-remove-confirm"
          role="group"
          aria-label="Disconnect"
        >
          <p>
            Disconnect 1Password? Its items stay in 1Password, and agents can no
            longer use them. New items go to Seams Vault again.
          </p>
          <div className="vault-actions">
            <button
              type="button"
              className="vault-danger"
              disabled={props.busy}
              onClick={props.disconnect}
            >
              {props.busy ? "Disconnecting…" : "Disconnect"}
            </button>
            <button
              type="button"
              className="vault-text-button"
              onClick={() => props.askDisconnect(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="vault-actions">
          {pantryCount > 0 ? (
            <button
              type="button"
              className="vault-primary"
              disabled={props.busy}
              onClick={() => props.move("onepassword")}
            >
              {props.busy
                ? "Moving…"
                : `Move ${pantryCount === 1 ? "1 item" : `${pantryCount} items`} to 1Password`}
            </button>
          ) : null}
          {onePasswordCount > 0 ? (
            <button
              type="button"
              className="vault-secondary"
              disabled={props.busy}
              onClick={() => props.move("satyr")}
            >
              Move items to Seams Vault
            </button>
          ) : null}
          <button
            type="button"
            className="vault-text-button vault-remove"
            onClick={() => props.askDisconnect(true)}
          >
            Disconnect
          </button>
        </div>
      )}
      <History
        organisationId={props.organisationId}
        transport={props.transport}
        itemId={null}
      />
    </div>
  );
}

/** The audit log of one item, or of the whole Vault. */
export function History(props: {
  readonly organisationId: string;
  readonly transport: VaultTransport;
  readonly itemId: string | null;
}): React.ReactNode {
  const [events, setEvents] = React.useState<
    readonly VaultEvent[] | "loading" | "failed"
  >("loading");
  React.useEffect(() => {
    let current = true;
    setEvents("loading");
    props.transport.events(props.organisationId, props.itemId).then(
      (loaded) => {
        if (current) setEvents(loaded);
      },
      () => {
        if (current) setEvents("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [props.organisationId, props.transport, props.itemId]);
  return (
    <section className="vault-history" aria-label="History">
      <h3>History</h3>
      {events === "loading" ? (
        <p className="vault-field-hint">Loading…</p>
      ) : events === "failed" ? (
        <p className="vault-field-hint">The history is not available now.</p>
      ) : events.length === 0 ? (
        <p className="vault-field-hint">No changes recorded yet.</p>
      ) : (
        <ol>
          {events.map((event) => (
            <li key={event.eventId}>
              <span>{eventLabel(event, props.itemId === null)}</span>
              <time dateTime={new Date(event.at).toISOString()}>
                {formatDate(event.at)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function eventLabel(event: VaultEvent, withItem: boolean): string {
  const text = eventText(event.kind, event.store);
  return withItem && event.itemLabel !== null
    ? `${text}: ${event.itemLabel}`
    : text;
}

function eventText(kind: VaultEventKind, store: VaultEvent["store"]): string {
  switch (kind) {
    case "item_added":
      return store === "onepassword" ? "Added in 1Password" : "Added";
    case "item_edited":
      return "Edited";
    case "sign_in_replaced":
      return "Sign-in replaced";
    case "item_removed":
      return store === "onepassword" ? "Archived in 1Password" : "Removed";
    case "item_moved":
      return store === "onepassword"
        ? "Moved to 1Password"
        : "Moved to Seams Vault";
    case "store_connected":
      return "1Password connected";
    case "store_disconnected":
      return "1Password disconnected";
    default:
      return assertNever(kind);
  }
}

function formatDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

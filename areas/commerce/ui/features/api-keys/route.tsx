import React from "react";
import { Copy, Plus } from "lucide-react";

import {
  Button,
  ConfirmInPlace,
  EmptyState,
  SideDrawer,
} from "@purin-labs/ui/index";
import { apiKeyErrorMessage, GRANTABLE_SCOPE_LABELS, GRANTABLE_SCOPES, issueCommerceApiKey, readCommerceApiKeys, revokeCommerceApiKey, type GrantableScope } from "./api";
import type { CommerceApiKey } from "@purin-labs/control-api/portal/api-keys";
import "@purin-labs/area-integrations-contract/ui/features/vault/styles.css";
import "./styles.css";
import type { Variant } from "@purin-labs/type-utils";

/**
 * Commerce API keys (Plan 80 step 3): an owner or admin gives the shop's own
 * systems a key with chosen scopes, sees which keys exist and revokes one.
 * The shop records each change that a key makes under that key.
 */
type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; keys: readonly CommerceApiKey[] }>;

/** What the drawer shows. A new key's secret lives only in this state. */
type Drawer =
  | Readonly<{ kind: "view"; credentialId: string }>
  | Readonly<{
      kind: "create";
      label: string;
      scopes: readonly GrantableScope[];
    }>
  | Readonly<{ kind: "issued"; apiKey: CommerceApiKey; key: string | null }>;

export function CommerceApiKeysRoute(props: {
  readonly organisationId: string;
  readonly canManage: boolean;
}): React.ReactNode {
  const { organisationId } = props;
  const [load, setLoad] = React.useState<LoadState>({ kind: "loading" });
  const [drawer, setDrawer] = React.useState<Drawer | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const dialog = React.useRef<HTMLDialogElement>(null);

  const reload = React.useCallback(async () => {
    try {
      setLoad({
        kind: "ready",
        keys: await readCommerceApiKeys(organisationId),
      });
    } catch (error) {
      setLoad({ kind: "failed", message: apiKeyErrorMessage(error) });
    }
  }, [organisationId]);

  React.useEffect(() => {
    if (props.canManage) void reload();
  }, [props.canManage, reload]);

  const open = (next: Drawer | null): void => {
    setDrawer(next);
    setFailure(null);
    setCopied(false);
  };
  const close = (): void => {
    if (!busy) open(null);
  };

  const create = async (
    draft: Variant<Drawer, "create">,
  ): Promise<void> => {
    if (draft.label.trim() === "" || draft.scopes.length === 0) {
      setFailure("Give the key a name and at least one scope.");
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const issued = await issueCommerceApiKey(organisationId, {
        label: draft.label.trim(),
        scopes: draft.scopes,
      });
      setDrawer({ kind: "issued", apiKey: issued.apiKey, key: issued.key });
      void reload();
    } catch (error) {
      setFailure(apiKeyErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (credentialId: string): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await revokeCommerceApiKey(organisationId, credentialId);
      setDrawer({ kind: "view", credentialId });
      await reload();
    } catch (error) {
      setFailure(apiKeyErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (!props.canManage)
    return (
      <div className="vault-page">
        <EmptyState title="API keys are for owners and admins" />
      </div>
    );

  const keys = load.kind === "ready" ? load.keys : [];
  const startCreate = (): void =>
    open({ kind: "create", label: "", scopes: [] });
  const viewed =
    drawer?.kind === "view"
      ? (keys.find((key) => key.credentialId === drawer.credentialId) ?? null)
      : null;

  return (
    <div className="vault-page">
      <div className="vault-toolbar">
        {load.kind === "ready" && keys.length > 0 ? (
          <div className="vault-add">
            <Button
              variant="primary"
              onClick={startCreate}
            >
              <Plus size={16} aria-hidden="true" />
              New key
            </Button>
          </div>
        ) : null}
      </div>
      {load.kind === "loading" ? (
        <p className="vault-loading">Loading API keys…</p>
      ) : load.kind === "failed" ? (
        <div className="vault-load-failed" role="alert">
          <p>{load.message}</p>
          <Button
            variant="secondary"
            onClick={() => {
              setLoad({ kind: "loading" });
              void reload();
            }}
          >
            Try again
          </Button>
        </div>
      ) : keys.length === 0 ? (
        <EmptyState
          title="No API keys"
          actions={
            <Button
              variant="primary"
              onClick={startCreate}
            >
              <Plus size={16} aria-hidden="true" />
              New key
            </Button>
          }
        />
      ) : (
        <ul className="vault-list" aria-label="API keys">
          {keys.map((key) => (
            <li key={key.credentialId}>
              <button
                type="button"
                className="vault-row"
                aria-current={
                  drawer?.kind === "view" &&
                  drawer.credentialId === key.credentialId
                    ? "true"
                    : undefined
                }
                onClick={() =>
                  open({ kind: "view", credentialId: key.credentialId })
                }
              >
                <span className="vault-row-text">
                  <span className="vault-row-title">{key.label}</span>
                  <span className="vault-row-detail">
                    {scopeSummary(key.scopes)} · Created{" "}
                    {formatDate(key.createdAt)}
                  </span>
                </span>
                {key.revokedAt === null ? null : (
                  <span className="vault-key-status">Revoked</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <SideDrawer
        open={drawer !== null}
        title={
          drawer === null
            ? ""
            : drawer.kind === "create"
              ? "New API key"
              : drawer.kind === "issued"
                ? drawer.apiKey.label
                : (viewed?.label ?? "API key")
        }
        close={close}
        className="vault-drawer"
        dialogRef={dialog}
      >
        {drawer === null ? null : (
          <>
            {drawer.kind === "create" ? (
              <form
                className="vault-edit-form"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void create(drawer);
                }}
              >
                <div className="side-drawer-body vault-form-scroll">
                  <div className="vault-form-fields">
                    <div className="vault-field">
                      <label htmlFor="api-key-label">Name</label>
                      <input
                        id="api-key-label"
                        value={drawer.label}
                        maxLength={100}
                        placeholder="For example, Online shop"
                        onChange={(event) =>
                          setDrawer({
                            ...drawer,
                            label: event.currentTarget.value,
                          })
                        }
                      />
                    </div>
                    <fieldset className="vault-field-group">
                      <legend>What the key can do</legend>
                      <div className="api-keys-scopes">
                        {GRANTABLE_SCOPES.map((scope) => (
                          <label key={scope} className="api-keys-scope">
                            <input
                              type="checkbox"
                              checked={drawer.scopes.includes(scope)}
                              onChange={(event) =>
                                setDrawer({
                                  ...drawer,
                                  scopes: event.currentTarget.checked
                                    ? [...drawer.scopes, scope]
                                    : drawer.scopes.filter(
                                        (item) => item !== scope,
                                      ),
                                })
                              }
                            />
                            <span>{GRANTABLE_SCOPE_LABELS[scope]}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </div>
                  {failure === null ? null : (
                    <p className="vault-failure" role="alert">
                      {failure}
                    </p>
                  )}
                </div>
                <div className="vault-actions vault-form-footer">
                  <Button
                    variant="primary"
                    type="submit"
                    disabled={busy}
                  >
                    {busy ? "Creating…" : "Create key"}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={close}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : drawer.kind === "issued" ? (
              <div className="side-drawer-body">
                {drawer.key === null ? (
                  <p className="vault-secret-note">
                    Purin Pantry created this key earlier and cannot show it
                    again. If you did not copy it, revoke it and create a new
                    key.
                  </p>
                ) : (
                  <>
                    <p className="vault-secret-note">
                      Copy this key now. Purin Pantry does not show it again.
                    </p>
                    <div className="api-keys-secret">
                      <code aria-label="API key">{drawer.key}</code>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          const key = drawer.key;
                          if (key === null) return;
                          void navigator.clipboard
                            .writeText(key)
                            .then(() => setCopied(true))
                            .catch(() =>
                              setFailure(
                                "Copy failed. Select the key and copy it.",
                              ),
                            );
                        }}
                      >
                        <Copy size={16} aria-hidden="true" />
                        {copied ? "Copied" : "Copy"}
                      </Button>
                    </div>
                  </>
                )}
                <KeyDetails apiKey={drawer.apiKey} />
                {failure === null ? null : (
                  <p className="vault-failure" role="alert">
                    {failure}
                  </p>
                )}
                <div className="vault-actions">
                  <Button
                    variant="primary"
                    onClick={() => open(null)}
                  >
                    Done
                  </Button>
                </div>
              </div>
            ) : viewed === null ? (
              <p className="side-drawer-body">This key is no longer listed.</p>
            ) : (
              <div className="side-drawer-body">
                <KeyDetails apiKey={viewed} />
                {failure === null ? null : (
                  <p className="vault-failure" role="alert">
                    {failure}
                  </p>
                )}
                {viewed.revokedAt !== null ? null : (
                  <div className="vault-actions">
                    <ConfirmInPlace
                      key={viewed.credentialId}
                      label="Revoke key…"
                      question="Revoke this key?"
                      consequence="Systems that use it stop at once."
                      confirmLabel={busy ? "Revoking…" : "Revoke key"}
                      busy={busy}
                      onConfirm={() => revoke(viewed.credentialId)}
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </SideDrawer>
    </div>
  );
}

function KeyDetails(props: {
  readonly apiKey: CommerceApiKey;
}): React.ReactNode {
  const { apiKey } = props;
  return (
    <dl className="vault-details">
      {apiKey.revokedAt === null ? null : (
        <div>
          <dt>Revoked</dt>
          <dd>{formatDate(apiKey.revokedAt)}</dd>
        </div>
      )}
      <div>
        <dt>Created</dt>
        <dd>{formatDate(apiKey.createdAt)}</dd>
      </div>
      <div>
        <dt>Can</dt>
        <dd>
          <ul className="api-keys-scope-list">
            {apiKey.scopes.map((scope) => (
              <li key={scope}>{scopeLabel(scope)}</li>
            ))}
          </ul>
        </dd>
      </div>
    </dl>
  );
}

function scopeLabel(scope: string): string {
  const labels: Readonly<Record<string, string | undefined>> =
    GRANTABLE_SCOPE_LABELS;
  return labels[scope] ?? scope;
}

function scopeSummary(scopes: readonly string[]): string {
  return scopes.length === 1
    ? scopeLabel(scopes[0] ?? "")
    : `${scopes.length} scopes`;
}

function formatDate(at: string): string {
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

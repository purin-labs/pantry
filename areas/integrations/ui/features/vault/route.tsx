import React from "react";
import { KeyRound, KeySquare, Plus, UserRound, Vault } from "lucide-react";
import type {
  VaultItemCommand,
  VaultItemCreate,
  VaultItemKind,
  VaultItemResult,
  VaultItemView,
  VaultStoreView,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";

import { cancelDialog, syncDialog } from "@purin-labs/ui/dialog";
import { EmptyState, SideDrawer } from "@purin-labs/ui/index";
import { VAULT_TRANSPORT, vaultErrorMessage, type VaultTransport } from "./api";
import {
  checkContactDraft,
  checkLoginDraft,
  ContactForm,
  contactDraftOf,
  countryName,
  emptyContactDraft,
  emptyLoginDraft,
  hostOf,
  LoginForm,
  loginDraftOf,
  type ContactDraft,
  type FieldErrors,
  type LoginDraft,
  type LoginFormPart,
} from "./item-form";
import { keyStatusLabel, type VaultKeyView } from "./keys";
import {
  ConnectForm,
  History,
  StoreDetails,
  StoreLine,
  type OnePasswordVaultChoice,
} from "./store-panel";
import "./styles.css";

type Tab = "all" | VaultItemKind | "api_key";

/** What the drawer shows. Forms keep their draft until saved or closed. */
type Drawer =
  | Readonly<{ kind: "view"; itemId: string }>
  | Readonly<{ kind: "remove"; itemId: string }>
  | Readonly<{
      kind: "login_form";
      itemId: string | null;
      part: LoginFormPart;
      draft: LoginDraft;
    }>
  | Readonly<{
      kind: "contact_form";
      itemId: string | null;
      draft: ContactDraft;
    }>
  | Readonly<{ kind: "key"; itemId: null; keyId: string }>
  | Readonly<{ kind: "store"; itemId: null; confirmingDisconnect: boolean }>
  | Readonly<{
      kind: "connect";
      itemId: null;
      token: string;
      vaults: readonly OnePasswordVaultChoice[] | null;
      vaultId: string | null;
    }>;

/** API keys load only for people who manage the Vault. */
type KeysState =
  | Readonly<{ kind: "hidden" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; keys: readonly VaultKeyView[] }>;

type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{
      kind: "ready";
      store: VaultStoreView;
      items: readonly VaultItemView[];
    }>;

const TABS: readonly Readonly<{ tab: Tab; label: string }>[] = [
  { tab: "all", label: "All" },
  { tab: "website_login", label: "Logins" },
  { tab: "contact_profile", label: "Contact info" },
  { tab: "api_key", label: "API keys" },
];

export function VaultRoute(props: {
  readonly organisationId: string;
  readonly canManage: boolean;
  /** Where Integrations manages a stored API key. */
  readonly integrationsHref?: string;
  /** Previews stand in for the Platform here. */
  readonly transport?: VaultTransport;
}): React.ReactNode {
  const { organisationId, transport = VAULT_TRANSPORT } = props;
  const [load, setLoad] = React.useState<LoadState>({ kind: "loading" });
  const [keys, setKeys] = React.useState<KeysState>(
    props.canManage ? { kind: "loading" } : { kind: "hidden" },
  );
  const initialDraft = React.useRef("");
  const [discard, setDiscard] = React.useState<"closed" | "confirming">(
    "closed",
  );
  const [query, setQuery] = React.useState("");
  const [tab, setTab] = React.useState<Tab>("all");
  const [drawer, setDrawer] = React.useState<Drawer | null>(null);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const dialog = React.useRef<HTMLDialogElement>(null);

  const reload = React.useCallback(async (): Promise<void> => {
    try {
      const list = await transport.list(organisationId);
      setLoad({ kind: "ready", store: list.store, items: list.items });
    } catch (error) {
      setLoad({ kind: "failed", message: vaultErrorMessage(error) });
    }
  }, [organisationId, transport]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const reloadKeys = React.useCallback(async (): Promise<void> => {
    if (!props.canManage) return setKeys({ kind: "hidden" });
    try {
      setKeys({
        kind: "ready",
        keys: await transport.listKeys(organisationId),
      });
    } catch (error) {
      setKeys({ kind: "failed", message: vaultErrorMessage(error) });
    }
  }, [organisationId, props.canManage, transport]);

  React.useEffect(() => {
    void reloadKeys();
  }, [reloadKeys]);

  // A refused save takes the person to the first field to fix.
  React.useEffect(() => {
    if (Object.keys(errors).length === 0) return;
    dialog.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus();
  }, [errors]);

  const items = load.kind === "ready" ? load.items : [];
  const open = (next: Drawer | null): void => {
    initialDraft.current = draftValue(next);
    setDrawer(next);
    setErrors({});
    setFailure(null);
  };
  const close = closeDrawer.bind(
    null,
    busy,
    drawer,
    initialDraft.current,
    setDiscard,
    open,
  );

  const applyResult = (result: VaultItemResult, message: string): void => {
    if (load.kind === "ready") {
      const rest = load.items.filter((item) =>
        "item" in result
          ? item.itemId !== result.item.itemId
          : item.itemId !== result.removed,
      );
      setLoad({
        kind: "ready",
        store: load.store,
        items: "item" in result ? sortItems([...rest, result.item]) : rest,
      });
    }
    setNotice(message);
    open(
      "item" in result ? { kind: "view", itemId: result.item.itemId } : null,
    );
  };

  const submit = async (
    send: () => Promise<VaultItemResult>,
    message: string,
  ): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      applyResult(await send(), message);
    } catch (error) {
      setFailure(vaultErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (drawer === null || busy) return;
    const current =
      drawer.kind === "login_form" || drawer.kind === "contact_form"
        ? drawer.itemId === null
          ? null
          : (items.find((item) => item.itemId === drawer.itemId) ?? null)
        : null;
    if (drawer.kind === "login_form") {
      const checked = checkLoginDraft(drawer.draft, drawer.part);
      if (!checked.ok) return setErrors(checked.errors);
      setErrors({});
      const login = checked.value;
      if (current === null) {
        const create: VaultItemCreate = { kind: "website_login", ...login };
        void submit(
          () => transport.create(organisationId, create),
          "Login saved.",
        );
        return;
      }
      const command: VaultItemCommand =
        drawer.part === "sign_in"
          ? {
              kind: "replace_sign_in",
              expectedRevision: current.revision,
              username: login.username,
              password: login.password,
            }
          : {
              kind: "edit_login",
              expectedRevision: current.revision,
              label: login.label,
              origins: login.origins,
            };
      void submit(
        () => transport.command(organisationId, current.itemId, command),
        drawer.part === "sign_in" ? "Sign-in replaced." : "Login updated.",
      );
      return;
    }
    if (drawer.kind === "contact_form") {
      const checked = checkContactDraft(drawer.draft);
      if (!checked.ok) return setErrors(checked.errors);
      setErrors({});
      if (current === null) {
        const create: VaultItemCreate = {
          kind: "contact_profile",
          ...checked.value,
        };
        void submit(
          () => transport.create(organisationId, create),
          "Contact info saved.",
        );
        return;
      }
      const command: VaultItemCommand = {
        kind: "edit_contact",
        expectedRevision: current.revision,
        ...checked.value,
      };
      void submit(
        () => transport.command(organisationId, current.itemId, command),
        "Contact info updated.",
      );
    }
  };

  const remove = (item: VaultItemView): void => {
    if (busy) return;
    void submit(
      () =>
        transport.command(organisationId, item.itemId, {
          kind: "remove",
          expectedRevision: item.revision,
        }),
      `${item.label} removed.`,
    );
  };

  const connect = async (form: Variant<Drawer, "connect">): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await transport.store(organisationId, {
        kind: "connect_onepassword",
        token: form.token.trim(),
        vaultId: form.vaultId,
      });
      if (result.kind === "choose_vault") {
        setDrawer({ ...form, vaults: result.vaults, vaultId: null });
        return;
      }
      setNotice("1Password connected. New items now go to 1Password.");
      await reload();
      open({ kind: "store", itemId: null, confirmingDisconnect: false });
    } catch (error) {
      setFailure(vaultErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const changeStore = async (
    command:
      | Readonly<{ kind: "disconnect_onepassword" }>
      | Readonly<{
          kind: "move_items";
          to: "onepassword" | "pantry";
        }>,
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await transport.store(organisationId, command);
      await reload();
      if (result.kind === "moved") {
        setNotice(
          `${result.moved === 1 ? "1 item" : `${result.moved} items`} moved.${
            result.remaining > 0
              ? ` ${result.remaining} left; move again to continue.`
              : ""
          }`,
        );
        return;
      }
      setNotice("1Password disconnected. Its items stay in 1Password.");
      close();
    } catch (error) {
      setFailure(vaultErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const keyList = keys.kind === "ready" ? keys.keys : [];
  const counts = {
    all: items.length + keyList.length,
    api_key: keyList.length,
    website_login: items.filter((item) => item.kind === "website_login").length,
    contact_profile: items.filter((item) => item.kind === "contact_profile")
      .length,
  };
  const filteredItems = items.filter(matchesItem.bind(null, query));
  const filteredKeys = keyList.filter(matchesKey.bind(null, query));
  const shown =
    tab === "all"
      ? filteredItems
      : tab === "api_key"
        ? []
        : filteredItems.filter((item) => item.kind === tab);
  const shownKeys = tab === "all" || tab === "api_key" ? filteredKeys : [];
  const openKey =
    drawer?.kind === "key"
      ? (keyList.find((key) => key.keyId === drawer.keyId) ?? null)
      : null;
  const selected =
    drawer === null || drawer.itemId === null
      ? null
      : (items.find((item) => item.itemId === drawer.itemId) ?? null);

  // Where items live is a quiet line under the lists.
  const storeLine =
    load.kind === "ready" ? (
      <StoreLine
        store={load.store}
        canManage={props.canManage}
        openStore={() => {
          setNotice(null);
          open(
            load.store.kind === "pantry"
              ? {
                  kind: "connect",
                  itemId: null,
                  token: "",
                  vaults: null,
                  vaultId: null,
                }
              : { kind: "store", itemId: null, confirmingDisconnect: false },
          );
        }}
      />
    ) : null;
  const storeLineAbove =
    load.kind === "ready" &&
    load.store.kind === "onepassword" &&
    !load.store.reachable;
  return (
    <div className="vault-page">
      {/* A store that does not answer is a warning, so it stays above. */}
      {storeLineAbove ? storeLine : null}
      <div className="vault-toolbar">
        <div className="vault-tabs" role="group" aria-label="Show items">
          {TABS.map(({ tab: value, label }) => (
            <button
              key={value}
              type="button"
              className="vault-tab"
              aria-pressed={tab === value}
              onClick={() => setTab(value)}
            >
              {label}
              <span className="vault-tab-count">{counts[value]}</span>
            </button>
          ))}
        </div>
        {load.kind === "ready" &&
        counts[tab] === 0 &&
        (tab !== "api_key" || keys.kind === "ready") ? null : (
          <VaultAddActions
            tab={tab}
            canManage={props.canManage}
            integrationsHref={props.integrationsHref ?? null}
            open={open}
          />
        )}
      </div>
      <label className="vault-search">
        <span className="visually-hidden">Search Vault</span>
        <input
          type="search"
          placeholder="Search names, websites, or usernames"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <p className="vault-notice" role="status">
        {notice}
      </p>
      {load.kind === "loading" ? (
        <p className="vault-loading">Loading the Vault…</p>
      ) : load.kind === "failed" ? (
        <div className="vault-load-failed" role="alert">
          <p>{load.message}</p>
          <button
            type="button"
            className="vault-secondary"
            onClick={() => {
              setLoad({ kind: "loading" });
              void reload();
            }}
          >
            Try again
          </button>
        </div>
      ) : tab === "api_key" && keys.kind !== "ready" ? (
        keys.kind === "loading" ? (
          <p className="vault-loading">Loading API keys…</p>
        ) : keys.kind === "failed" ? (
          <div className="vault-load-failed" role="alert">
            <p>{keys.message}</p>
            <button
              type="button"
              className="vault-secondary"
              onClick={() => {
                setKeys({ kind: "loading" });
                void reloadKeys();
              }}
            >
              Try again
            </button>
          </div>
        ) : (
          <EmptyState
            icon={<KeySquare size={20} />}
            title="API keys are for owners and admins"
            description="An owner or admin can see which services have a stored key."
          />
        )
      ) : shown.length === 0 && shownKeys.length === 0 ? (
        <EmptyState
          icon={
            tab === "api_key" ? <KeySquare size={20} /> : <Vault size={20} />
          }
          actions={
            query.trim() ? (
              <button
                type="button"
                className="vault-secondary"
                onClick={() => setQuery("")}
              >
                Clear search
              </button>
            ) : (
              <VaultAddActions
                tab={tab}
                canManage={props.canManage}
                integrationsHref={props.integrationsHref ?? null}
                open={open}
              />
            )
          }
          title={query.trim() ? "No matching items" : emptyTitle(tab)}
          description={
            query.trim()
              ? "Try another name, website, or username."
              : tab === "api_key"
                ? "When you connect a service with a key in Integrations, it appears here."
                : props.canManage
                  ? tab === "contact_profile"
                    ? "Save contact details that agents can use in forms and orders."
                    : "Save a login once, and agents can sign in for you. Agents never see a saved password."
                  : "An owner or admin can add logins and contact info."
          }
        />
      ) : (
        <ul className="vault-list" aria-label="Vault items">
          {shown.map((item) => (
            <li key={item.itemId}>
              <button
                type="button"
                className="vault-row"
                aria-current={
                  drawer?.itemId === item.itemId ? "true" : undefined
                }
                onClick={() => {
                  setNotice(null);
                  open({ kind: "view", itemId: item.itemId });
                }}
              >
                <span className="vault-row-icon" aria-hidden="true">
                  {item.kind === "website_login" ? (
                    <KeyRound size={16} />
                  ) : (
                    <UserRound size={16} />
                  )}
                </span>
                <span className="vault-row-text">
                  <span className="vault-row-title">{item.label}</span>
                  <span className="vault-row-detail">{rowDetail(item)}</span>
                </span>
              </button>
            </li>
          ))}
          {shownKeys.map((key) => (
            <li key={key.keyId}>
              <button
                type="button"
                className="vault-row"
                aria-current={
                  drawer?.kind === "key" && drawer.keyId === key.keyId
                    ? "true"
                    : undefined
                }
                onClick={() => {
                  setNotice(null);
                  open({ kind: "key", itemId: null, keyId: key.keyId });
                }}
              >
                <span className="vault-row-icon" aria-hidden="true">
                  <KeySquare size={16} />
                </span>
                <span className="vault-row-text">
                  <span className="vault-row-title">{key.name}</span>
                  <span className="vault-row-detail">
                    {key.kindLabel === "API key"
                      ? key.service
                      : `${key.service} · ${key.kindLabel}`}
                  </span>
                </span>
                {key.status === "stored" ? null : (
                  <span className="vault-key-status">
                    {keyStatusLabel(key.status)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {storeLineAbove ? null : storeLine}
      <SideDrawer
        open={drawer !== null}
        title={
          drawer === null
            ? ""
            : drawer.kind === "key"
              ? (openKey?.name ?? "API key")
              : drawer.kind === "connect"
                ? "Connect 1Password"
                : drawer.kind === "store"
                  ? "1Password"
                  : drawerTitle(drawer, selected)
        }
        close={close}
        className="vault-drawer"
        dialogRef={dialog}
      >
        {drawer === null ? null : (
          <>
            {drawer.kind === "connect" ? (
              <ConnectForm
                token={drawer.token}
                vaults={drawer.vaults}
                vaultId={drawer.vaultId}
                busy={busy}
                failure={failure}
                change={(patch) => setDrawer({ ...drawer, ...patch })}
                submit={() => void connect(drawer)}
                cancel={close}
              />
            ) : drawer.kind === "store" ? (
              load.kind === "ready" && load.store.kind === "onepassword" ? (
                <StoreDetails
                  store={load.store}
                  items={items}
                  busy={busy}
                  failure={failure}
                  confirmingDisconnect={drawer.confirmingDisconnect}
                  move={(to) => void changeStore({ kind: "move_items", to })}
                  askDisconnect={(asking) =>
                    setDrawer({ ...drawer, confirmingDisconnect: asking })
                  }
                  disconnect={() =>
                    void changeStore({ kind: "disconnect_onepassword" })
                  }
                  organisationId={organisationId}
                  transport={transport}
                />
              ) : (
                <p className="side-drawer-body">1Password is not connected.</p>
              )
            ) : drawer.kind === "key" ? (
              openKey === null ? (
                <p className="side-drawer-body">
                  This key is no longer listed.
                </p>
              ) : (
                <KeyDetails
                  item={openKey}
                  integrationsHref={props.integrationsHref ?? null}
                />
              )
            ) : drawer.kind === "view" || drawer.kind === "remove" ? (
              selected === null ? (
                <p className="side-drawer-body">This item was removed.</p>
              ) : (
                <ItemDetails
                  organisationId={organisationId}
                  transport={transport}
                  item={selected}
                  canManage={props.canManage}
                  confirmingRemove={drawer.kind === "remove"}
                  busy={busy}
                  failure={failure}
                  open={open}
                  remove={remove}
                />
              )
            ) : (
              <form className="vault-edit-form" onSubmit={save} noValidate>
                <div className="side-drawer-body vault-form-scroll">
                  {drawer.kind === "login_form" ? (
                    <LoginForm
                      idPrefix="vault-login"
                      draft={drawer.draft}
                      part={drawer.part}
                      errors={errors}
                      change={(draft) => setDrawer({ ...drawer, draft })}
                    />
                  ) : (
                    <ContactForm
                      idPrefix="vault-contact"
                      draft={drawer.draft}
                      errors={errors}
                      change={(draft) => setDrawer({ ...drawer, draft })}
                    />
                  )}
                  {failure === null ? null : (
                    <p className="vault-failure" role="alert">
                      {failure}
                    </p>
                  )}
                </div>
                <div className="vault-actions vault-form-footer">
                  <button
                    type="submit"
                    className="vault-primary"
                    disabled={busy}
                  >
                    {busy ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="vault-text-button"
                    onClick={close}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </SideDrawer>
      <DiscardDialog state={discard} setState={setDiscard} open={open} />
    </div>
  );
}

function ItemDetails(props: {
  readonly organisationId: string;
  readonly transport: VaultTransport;
  readonly item: VaultItemView;
  readonly canManage: boolean;
  readonly confirmingRemove: boolean;
  readonly busy: boolean;
  readonly failure: string | null;
  readonly open: (drawer: Drawer) => void;
  readonly remove: (item: VaultItemView) => void;
}): React.ReactNode {
  const { item } = props;
  return (
    <div className="side-drawer-body">
      {item.kind === "website_login" ? (
        <LoginDetails item={item} />
      ) : (
        <ContactDetails item={item} />
      )}
      {item.store === "onepassword" ? (
        <p className="vault-field-hint">Kept in 1Password.</p>
      ) : null}
      {props.failure === null ? null : (
        <p className="vault-failure" role="alert">
          {props.failure}
        </p>
      )}
      {!props.canManage ? null : props.confirmingRemove ? (
        <div className="vault-remove-confirm" role="group" aria-label="Remove">
          <p>
            {item.kind === "website_login"
              ? "Remove this login? Agents can no longer sign in with it."
              : "Remove this contact info? Agents can no longer use it."}
          </p>
          <div className="vault-actions">
            <button
              type="button"
              className="vault-danger"
              disabled={props.busy}
              onClick={() => props.remove(item)}
            >
              {props.busy ? "Removing…" : "Remove"}
            </button>
            <button
              type="button"
              className="vault-text-button"
              onClick={() => props.open({ kind: "view", itemId: item.itemId })}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="vault-actions">
          <button
            type="button"
            className="vault-secondary"
            onClick={() =>
              props.open(
                item.kind === "website_login"
                  ? {
                      kind: "login_form",
                      itemId: item.itemId,
                      part: "details",
                      draft: loginDraftOf(item),
                    }
                  : {
                      kind: "contact_form",
                      itemId: item.itemId,
                      draft: contactDraftOf(item),
                    },
              )
            }
          >
            Edit
          </button>
          {item.kind === "website_login" ? (
            <button
              type="button"
              className="vault-secondary"
              onClick={() =>
                props.open({
                  kind: "login_form",
                  itemId: item.itemId,
                  part: "sign_in",
                  draft: { ...loginDraftOf(item), password: "" },
                })
              }
            >
              Replace sign-in
            </button>
          ) : null}
          <button
            type="button"
            className="vault-text-button vault-remove"
            onClick={() => props.open({ kind: "remove", itemId: item.itemId })}
          >
            Remove
          </button>
        </div>
      )}
      <History
        organisationId={props.organisationId}
        transport={props.transport}
        itemId={item.itemId}
      />
    </div>
  );
}

function LoginDetails(props: {
  readonly item: Variant<VaultItemView, "website_login">;
}): React.ReactNode {
  const { item } = props;
  return (
    <>
      <dl className="vault-details">
        <div>
          <dt>{item.origins.length === 1 ? "Website" : "Websites"}</dt>
          <dd>
            {item.origins.length === 0 ? (
              "No https website, so agents cannot fill it. Edit it to add one."
            ) : (
              <ul className="vault-origins">
                {item.origins.map((origin) => (
                  <li key={origin}>{hostOf(origin)}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt>Username</dt>
          <dd>{item.username}</dd>
        </div>
        <div>
          <dt>Password</dt>
          <dd>Saved {formatDate(item.passwordUpdatedAt)}</dd>
        </div>
      </dl>
      <p className="vault-secret-note">
        Never shown to agents or people. Only filled on{" "}
        {item.origins.length === 1
          ? hostOf(item.origins[0] ?? "")
          : "the websites above"}
        .
      </p>
    </>
  );
}

function ContactDetails(props: {
  readonly item: Variant<VaultItemView, "contact_profile">;
}): React.ReactNode {
  const { contact } = props.item;
  const rows: readonly (readonly [string, React.ReactNode])[] = [
    ["Full name", contact.fullName],
    ["Company", contact.company],
    ["Email", contact.email],
    ["Phone", contact.phone],
    [
      "Address",
      contact.address === null ? null : (
        <address>
          {[
            contact.address.line1,
            contact.address.line2,
            [
              contact.address.city,
              contact.address.region,
              contact.address.postalCode,
            ]
              .filter((part) => part !== null && part !== "")
              .join(", "),
            countryName(contact.address.country),
          ]
            .filter((line) => line !== null && line !== "")
            .map((line) => (
              <span key={line}>{line}</span>
            ))}
        </address>
      ),
    ],
    ["Tax or invoice registration number", contact.taxRegistrationNumber],
  ];
  return (
    <dl className="vault-details">
      {rows
        .filter(([, value]) => value !== null)
        .map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

function KeyDetails(props: {
  readonly item: VaultKeyView;
  readonly integrationsHref: string | null;
}): React.ReactNode {
  const { item } = props;
  const href =
    props.integrationsHref === null
      ? null
      : item.integrationId === null
        ? props.integrationsHref
        : `${props.integrationsHref}?${new URLSearchParams({
            integration: item.integrationId,
            ...(item.accountId === null ? {} : { account: item.accountId }),
          }).toString()}`;
  return (
    <div className="side-drawer-body">
      <dl className="vault-details">
        <div>
          <dt>Service</dt>
          <dd>{item.service}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{item.kindLabel}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            {keyStatusLabel(item.status)}
            {item.changedAt === null
              ? null
              : ` · ${formatDate(item.changedAt)}`}
          </dd>
        </div>
      </dl>
      <p className="vault-secret-note">
        Never shown to agents or people. Purin Pantry uses it only for actions
        on {item.service}. Add, replace or revoke it in Integrations.
      </p>
      {href === null ? null : (
        <div className="vault-actions">
          <a className="vault-secondary" href={href}>
            Manage in Integrations
          </a>
        </div>
      )}
    </div>
  );
}

function drawerTitle(
  drawer: Exclude<Drawer, { kind: "key" | "store" | "connect" }>,
  item: VaultItemView | null,
): string {
  switch (drawer.kind) {
    case "view":
    case "remove":
      return item?.label ?? "Vault item";
    case "login_form":
      return drawer.itemId === null
        ? "Add login"
        : drawer.part === "sign_in"
          ? "Replace sign-in"
          : "Edit login";
    case "contact_form":
      return drawer.itemId === null ? "Add contact info" : "Edit contact info";
    default:
      return assertNever(drawer);
  }
}

function emptyTitle(tab: Tab): string {
  switch (tab) {
    case "all":
      return "No saved logins or contact info";
    case "website_login":
      return "No saved logins";
    case "contact_profile":
      return "No saved contact info";
    case "api_key":
      return "No stored API keys";
    default:
      return assertNever(tab);
  }
}

function rowDetail(item: VaultItemView): string {
  switch (item.kind) {
    case "website_login": {
      const host =
        item.origins.length === 0 ? null : hostOf(item.origins[0] ?? "");
      return withStore(
        item,
        host === null || item.label === host
          ? item.username
          : `${item.username} · ${host}`,
      );
    }
    case "contact_profile":
      return withStore(
        item,
        [item.contact.fullName, item.contact.company]
          .filter((part) => part !== null)
          .join(", "),
      );
    default:
      return assertNever(item);
  }
}

function withStore(item: VaultItemView, detail: string): string {
  return item.store === "onepassword" ? `${detail} · 1Password` : detail;
}

function sortItems(items: readonly VaultItemView[]): readonly VaultItemView[] {
  return [...items].sort(
    (left, right) =>
      storeOrder(left) - storeOrder(right) ||
      kindOrder(left.kind) - kindOrder(right.kind) ||
      left.label.localeCompare(right.label, undefined, {
        sensitivity: "base",
      }) ||
      left.itemId.localeCompare(right.itemId),
  );
}

/** 1Password items first, then Pantry items, as the Platform lists them. */
function storeOrder(item: VaultItemView): number {
  return item.store === "onepassword" ? 0 : 1;
}

/** Logins first, as the Platform lists them. */
function kindOrder(kind: VaultItemKind): number {
  return kind === "website_login" ? 0 : 1;
}

function formatDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function draftValue(drawer: Drawer | null): string {
  if (drawer?.kind === "login_form" || drawer?.kind === "contact_form")
    return JSON.stringify(drawer.draft);
  if (drawer?.kind === "connect") return drawer.token;
  return "";
}

function closeDrawer(
  busy: boolean,
  drawer: Drawer | null,
  initial: string,
  setDiscard: (state: "closed" | "confirming") => void,
  open: (drawer: Drawer | null) => void,
): void {
  if (busy) return;
  if (draftValue(drawer) !== initial) {
    setDiscard("confirming");
    return;
  }
  open(null);
}

function matchesItem(query: string, item: VaultItemView): boolean {
  return `${item.label} ${rowDetail(item)} ${item.kind === "website_login" ? item.origins.join(" ") : ""}`
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
}

function matchesKey(query: string, key: VaultKeyView): boolean {
  return `${key.name} ${key.service}`
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
}

function openLogin(open: (drawer: Drawer) => void): void {
  open({
    kind: "login_form",
    itemId: null,
    part: "all",
    draft: emptyLoginDraft(),
  });
}

function openContact(open: (drawer: Drawer) => void): void {
  open({ kind: "contact_form", itemId: null, draft: emptyContactDraft() });
}

function VaultAddActions(props: {
  readonly tab: Tab;
  readonly canManage: boolean;
  readonly integrationsHref: string | null;
  readonly open: (drawer: Drawer) => void;
}): React.ReactNode {
  if (!props.canManage) return null;
  if (props.tab === "api_key")
    return props.integrationsHref === null ? null : (
      <a className="vault-primary" href={props.integrationsHref}>
        Manage integrations
      </a>
    );
  return (
    <div className="vault-add">
      {props.tab === "contact_profile" ? null : (
        <button
          type="button"
          className="vault-primary"
          onClick={openLogin.bind(null, props.open)}
        >
          <Plus size={16} aria-hidden="true" />
          Add login
        </button>
      )}
      {props.tab === "website_login" ? null : (
        <button
          type="button"
          className={
            props.tab === "contact_profile"
              ? "vault-primary"
              : "vault-secondary"
          }
          onClick={openContact.bind(null, props.open)}
        >
          Add contact info
        </button>
      )}
    </div>
  );
}

function keepDraft(setState: (state: "closed" | "confirming") => void): void {
  setState("closed");
}

function discardDraft(
  setState: (state: "closed" | "confirming") => void,
  open: (drawer: Drawer | null) => void,
): void {
  setState("closed");
  open(null);
}

function syncDiscard(
  ref: React.RefObject<HTMLDialogElement | null>,
  state: "closed" | "confirming",
): void {
  syncDialog(ref, state === "confirming");
}

function DiscardDialog(props: {
  readonly state: "closed" | "confirming";
  readonly setState: (state: "closed" | "confirming") => void;
  readonly open: (drawer: Drawer | null) => void;
}): React.ReactNode {
  const ref = React.useRef<HTMLDialogElement>(null);
  const title = React.useId();
  React.useEffect(syncDiscard.bind(null, ref, props.state), [props.state]);
  return (
    <dialog
      ref={ref}
      className="vault-discard"
      aria-labelledby={title}
      onCancel={cancelDialog.bind(null, keepDraft.bind(null, props.setState))}
    >
      <h2 id={title}>Discard unsaved changes?</h2>
      <p>Your changes will be lost.</p>
      <div className="vault-actions">
        <button type="button" onClick={keepDraft.bind(null, props.setState)}>
          Keep editing
        </button>
        <button
          type="button"
          className="vault-discard-confirm"
          onClick={discardDraft.bind(null, props.setState, props.open)}
        >
          Discard changes
        </button>
      </div>
    </dialog>
  );
}

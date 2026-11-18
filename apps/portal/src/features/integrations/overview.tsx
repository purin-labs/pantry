import React from "react";
import { ChevronRight, Plus, Search } from "lucide-react";
import type { CustomConnectorSummary } from "@seams/control-api/portal/custom-connectors";
import {
  ProviderTile,
  StatusChip,
  type ProviderTileName,
  type StatusChipStatus,
} from "../../page-components";

export type CustomConnectorCatalogState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly value: readonly CustomConnectorSummary[];
    };

export type IntegrationDirectoryContent = Readonly<{
  apps: readonly IntegrationCatalogItem[];
  workspaceSetup: readonly IntegrationCatalogItem[];
  connectedApps: readonly ConnectedAppItem[];
}>;

export type IntegrationCatalogItem = {
  readonly kind: "app" | "workspace_setup";
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly searchAliases: readonly string[];
  readonly tile: ProviderTileName;
  readonly status: {
    readonly kind: "attention" | "connected" | "idle";
    readonly label: string;
  };
  readonly connectedAccountCount: number;
  readonly href: string;
};

export type ConnectedAppItem = {
  readonly integrationAccountId: string;
  readonly providerLabel: string;
  readonly displayName: string;
  readonly tile: ProviderTileName;
  readonly status: StatusChipStatus;
  readonly actionLabel: string;
  readonly isDefaultForProvider: boolean;
  readonly searchText: string;
  readonly href: string;
};

/** The apps a person can add, by what the app does for the shop. */
const APP_GROUPS: readonly Readonly<{
  title: string;
  ids: readonly string[];
}>[] = [
  { title: "Sell and take payments", ids: ["shopify", "stripe", "square"] },
  { title: "Talk to customers and your team", ids: ["gmail", "whatsapp", "slack"] },
  {
    title: "Files, records and passwords",
    ids: ["google_drive", "dropbox", "notion", "airtable", "onepassword"],
  },
];

/**
 * One page, top to bottom: what is connected, the setup every shop needs, and
 * the apps that can be added. The search filters the same page in place.
 */
export function IntegrationsOverview(props: {
  readonly query: string;
  readonly content: IntegrationDirectoryContent;
  readonly customCatalog: CustomConnectorCatalogState;
  readonly basePath: string;
  readonly canManage: boolean;
}): React.ReactNode {
  const [search, setSearch] = React.useState(props.query);
  React.useEffect(setSearch.bind(null, props.query), [props.query]);
  const filtering = search.trim().length > 0;
  const connected = props.content.connectedApps.filter(
    matchesConnectedQuery.bind(null, search),
  );
  const custom =
    props.customCatalog.kind === "ready"
      ? props.customCatalog.value.filter(
          matchesCustomDirectory.bind(null, search),
        )
      : [];
  const unfinished = custom.filter(customConnectorNeedsSetup);
  const available = props.content.apps
    .filter(isAvailableApp)
    .filter(matchesAppQuery.bind(null, search));
  const core = props.content.workspaceSetup.filter(
    matchesAppQuery.bind(null, search),
  );
  const createHref = props.canManage
    ? connectorDirectoryHref(props.basePath, "new")
    : null;
  const nothingMatches =
    filtering &&
    connected.length === 0 &&
    custom.length === 0 &&
    available.length === 0 &&
    core.length === 0;
  return (
    <div className="integrations-overview connector-directory">
      <label className="integration-search-field">
        <Search className="command-search-icon" size={18} aria-hidden="true" />
        <span className="visually-hidden">Search apps</span>
        <input
          type="search"
          autoComplete="off"
          placeholder="Search apps"
          value={search}
          onChange={changeSearch.bind(null, setSearch)}
        />
      </label>
      {nothingMatches ? (
        <div className="integration-overview-empty" role="status">
          <p>No apps match “{search.trim()}”.</p>
          <button
            type="button"
            className="integration-clear-search"
            onClick={setSearch.bind(null, "")}
          >
            Clear search
          </button>
        </div>
      ) : null}
      <ConnectedApps
        items={connected}
        customConnectors={custom}
        basePath={props.basePath}
        canManage={props.canManage}
        filtering={filtering}
      />
      {props.customCatalog.kind === "failed" ? (
        <p role="alert">{props.customCatalog.message}</p>
      ) : null}
      {unfinished.length === 0 ? null : (
        <section
          className="integration-overview-section"
          aria-labelledby="custom-connections-title"
        >
          <div className="integration-overview-section-heading">
            <h3 id="custom-connections-title">Finish setting up</h3>
          </div>
          <div className="connected-app-list">
            {unfinished.map(
              renderCustomDirectoryItem.bind(
                null,
                props.basePath,
                props.canManage,
              ),
            )}
          </div>
        </section>
      )}
      <CatalogSection
        id="workspace-setup-title"
        title="Core setup"
        items={core}
      />
      <div id="integration-catalog" className="integration-catalog-sections">
        {available.length === 0 ? null : (
          <div className="integration-overview-section-heading">
            <h3 id="browse-apps-title" tabIndex={-1}>
              Add an app
            </h3>
          </div>
        )}
        {appGroups(available).map(renderAppGroup)}
      </div>
      {createHref === null || filtering ? null : (
        <a className="integration-add-other" href={createHref}>
          <span className="integration-add-other-mark" aria-hidden="true">
            <Plus size={18} />
          </span>
          <span className="connected-app-identity">
            <strong>Connect another app</strong>
            <span>Don’t see your app? An agent can help you connect it.</span>
          </span>
          <ChevronRight size={16} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

function changeSearch(
  setSearch: React.Dispatch<React.SetStateAction<string>>,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  setSearch(event.currentTarget.value);
}

/** An app with a connection already shows under Connected. */
function isAvailableApp(item: IntegrationCatalogItem): boolean {
  return item.connectedAccountCount === 0 && item.status.kind !== "connected";
}

type AppGroup = Readonly<{
  title: string;
  items: readonly IntegrationCatalogItem[];
}>;

function appGroups(items: readonly IntegrationCatalogItem[]): readonly AppGroup[] {
  const grouped = new Set(APP_GROUPS.flatMap(appGroupIds));
  const groups: AppGroup[] = APP_GROUPS.map((group) => ({
    title: group.title,
    items: items.filter((item) => group.ids.includes(item.id)),
  }));
  groups.push({
    title: "Other apps",
    items: items.filter((item) => !grouped.has(item.id)),
  });
  return groups.filter(appGroupHasItems);
}

function appGroupIds(group: (typeof APP_GROUPS)[number]): readonly string[] {
  return group.ids;
}

function appGroupHasItems(group: AppGroup): boolean {
  return group.items.length > 0;
}

function renderAppGroup(group: AppGroup): React.ReactNode {
  return (
    <section
      key={group.title}
      className="integration-app-group"
      aria-label={group.title}
    >
      <h4>{group.title}</h4>
      <div className="integration-catalog">
        {group.items.map(renderCatalogItem)}
      </div>
    </section>
  );
}

function matchesConnectedQuery(query: string, item: ConnectedAppItem): boolean {
  return connectorSearchMatches(item.searchText, query);
}

function matchesAppQuery(query: string, item: IntegrationCatalogItem): boolean {
  return connectorSearchMatches(
    `${item.label} ${item.description} ${item.searchAliases.join(" ")}`,
    query,
  );
}

function matchesCustomDirectory(
  query: string,
  item: CustomConnectorSummary,
): boolean {
  return connectorSearchMatches(
    `${item.name ?? ""} ${item.description ?? ""} ${item.origin ?? ""} ${item.accounts.map(customAccountSearchName).join(" ")}`,
    query,
  );
}

export function connectorSearchMatches(
  searchText: string,
  query: string,
): boolean {
  const text = searchText.toLocaleLowerCase();
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u);
  return terms.every(searchTermAppearsIn.bind(null, text));
}

function searchTermAppearsIn(text: string, term: string): boolean {
  return text.includes(term);
}

function customDirectoryStatus(item: CustomConnectorSummary): string {
  if (item.lifecycle === "disabled") return "Turned off";
  return "Not finished";
}

function renderCustomDirectoryItem(
  basePath: string,
  canManage: boolean,
  item: CustomConnectorSummary,
): React.ReactNode {
  return (
    <a
      key={item.connectorId}
      className="connected-app-row connector-custom-row"
      href={connectorDirectoryHref(basePath, item.connectorId)}
    >
      <CustomConnectorMark />
      <span className="connected-app-identity">
        <strong>{item.name ?? "Untitled app"}</strong>
        <span>{item.description ?? item.origin ?? "Another app"}</span>
      </span>
      <span className="custom-connector-state">
        {customDirectoryStatus(item)}
      </span>
      <span className="connected-app-action">
        {canManage
          ? item.lifecycle === "draft"
            ? "Continue"
            : "Manage"
          : "View"}
        <ChevronRight size={16} aria-hidden="true" />
      </span>
    </a>
  );
}

function CustomConnectorMark(): React.ReactNode {
  return (
    <span className="custom-connector-card-mark" aria-hidden="true">
      API
    </span>
  );
}

export function connectorDirectoryHref(
  basePath: string,
  connectorId: string,
): string {
  const url = new URL(basePath, "https://portal.invalid");
  url.searchParams.set("customConnector", connectorId);
  return `${url.pathname}${url.search}`;
}

function customAccountSearchName(
  account: CustomConnectorSummary["accounts"][number],
): string {
  return account.displayName;
}

function ConnectedApps(props: {
  readonly items: readonly ConnectedAppItem[];
  readonly customConnectors: readonly CustomConnectorSummary[];
  readonly basePath: string;
  readonly canManage: boolean;
  readonly filtering: boolean;
}): React.ReactNode {
  const customRows: React.ReactNode[] = [];
  for (const connector of props.customConnectors) {
    for (const account of connector.accounts)
      customRows.push(
        renderCustomConnectedAccount(
          props.basePath,
          props.canManage,
          connector,
          account,
        ),
      );
  }
  const count = props.items.length + customRows.length;
  if (count === 0 && props.filtering) return null;
  return (
    <section
      className="integration-overview-section"
      aria-labelledby="connected-apps-title"
    >
      <div className="integration-overview-section-heading">
        <h3 id="connected-apps-title">Connected</h3>
      </div>
      {count === 0 ? (
        <p className="integration-overview-empty">
          No apps are connected yet. Choose one below to get started.
        </p>
      ) : (
        <div className="connected-app-list">
          {props.items.map(renderConnectedApp.bind(null, props.items))}
          {customRows}
        </div>
      )}
    </section>
  );
}

function hasSameProvider(
  provider: string,
  item: ConnectedAppItem,
): boolean {
  return item.providerLabel === provider;
}

function renderConnectedApp(
  items: readonly ConnectedAppItem[],
  item: ConnectedAppItem,
): React.ReactNode {
  // "Default" only means something beside another account of the same app.
  const showDefault =
    item.isDefaultForProvider &&
    items.filter(hasSameProvider.bind(null, item.providerLabel)).length > 1;
  return (
    <a
      className="connected-app-row"
      id={`integration-overview-account-${item.integrationAccountId}`}
      href={item.href}
      key={item.integrationAccountId}
      aria-label={`${item.actionLabel} ${item.providerLabel}: ${item.displayName}`}
    >
      <ProviderTile provider={item.tile} label={item.providerLabel} />
      <span className="connected-app-identity">
        <strong>{item.providerLabel}</strong>
        <span title={item.displayName}>{item.displayName}</span>
      </span>
      {showDefault ? <span className="connection-default-tag">Default</span> : null}
      {item.status.kind === "success" ? null : (
        <StatusChip status={item.status} />
      )}
      <span className="connected-app-action" aria-hidden="true">
        {item.actionLabel}
        <ChevronRight size={16} />
      </span>
    </a>
  );
}

function CatalogSection(props: {
  readonly id: string;
  readonly title: string;
  readonly items: readonly IntegrationCatalogItem[];
}): React.ReactNode {
  if (props.items.length === 0) return null;
  return (
    <section
      className="integration-overview-section"
      aria-labelledby={props.id}
    >
      <div className="integration-overview-section-heading">
        <h3 id={props.id}>{props.title}</h3>
      </div>
      <div className="integration-catalog">
        {props.items.map(renderCatalogItem)}
      </div>
    </section>
  );
}

function renderCatalogItem(item: IntegrationCatalogItem): React.ReactNode {
  const action = catalogAction(item);
  return (
    <a
      className="integration-catalog-card"
      id={`integration-overview-app-${item.id}`}
      data-status={item.status.kind}
      href={item.href}
      key={item.id}
      aria-label={`${action} ${item.label}`}
    >
      <ProviderTile provider={item.tile} label={item.label} />
      <span className="integration-catalog-text">
        <strong>{item.label}</strong>
        <span className="integration-catalog-description">
          {item.description}
        </span>
        <span className="integration-catalog-foot">
          <span className="integration-catalog-action">{action}</span>
          {item.status.kind === "idle" ? null : (
            <span className="integration-catalog-status">
              <span aria-hidden="true" />
              {item.status.label}
            </span>
          )}
        </span>
      </span>
    </a>
  );
}

function catalogAction(item: IntegrationCatalogItem): string {
  if (item.kind === "workspace_setup")
    return item.status.kind === "idle" ? "Set up" : "Manage";
  return "Connect";
}

function customConnectorNeedsSetup(item: CustomConnectorSummary): boolean {
  return item.accounts.length === 0;
}

function renderCustomConnectedAccount(
  basePath: string,
  canManage: boolean,
  connector: CustomConnectorSummary,
  account: CustomConnectorSummary["accounts"][number],
): React.ReactNode {
  const connected =
    connector.lifecycle === "active" && account.lifecycle === "active";
  return (
    <a
      key={account.integrationAccountId}
      className="connected-app-row connector-custom-row"
      href={`${connectorDirectoryHref(basePath, connector.connectorId)}#custom-account-${encodeURIComponent(account.integrationAccountId)}`}
    >
      <CustomConnectorMark />
      <span className="connected-app-identity">
        <strong>{connector.name ?? "Another app"}</strong>
        <span>{account.displayName}</span>
      </span>
      {connected ? null : (
        <StatusChip status={{ kind: "warning", label: "Turned off" }} />
      )}
      <span className="connected-app-action">
        {canManage ? "Manage" : "View"}
        <ChevronRight size={16} aria-hidden="true" />
      </span>
    </a>
  );
}

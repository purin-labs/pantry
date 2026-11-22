import { Select } from "@purin-labs/ui/select";
import React from "react";
import {
  Bot,
  Building2,
  ChevronRight,
  CircleAlert,
  LockKeyhole,
  Mail,
  MessageCircle,
  MessagesSquare,
  Plus,
  ShieldCheck,
  User,
  Users,
  Workflow,
} from "lucide-react";
import { Link } from "react-router";

import { providerLabel, providerTile } from "../../../../../apps/portal/src/integration-catalogue";
import { ProviderTile } from "@purin-labs/ui/page-components";
import { SideDrawer } from "@purin-labs/ui/index";
import type {
  AccessControlGrantView,
  AccessControlSubjectView,
  AccessControlView,
} from "@purin-labs/control-api/portal/access-models";
import {
  buildAccessSystems,
  levelLabel,
  matchesSystem,
  recipientsWhoCanChange,
  systemActionSearch,
  type AccessSystem,
  type SystemFilter,
  type SystemRecipient,
} from "./system-access-model";
import "./system-access.css";

const SYSTEM_FILTERS: ReadonlyArray<{ value: SystemFilter; label: string }> = [
  { value: "all", label: "All systems" },
  { value: "not_shared", label: "Not shared" },
  { value: "can_change", label: "Can change data" },
];

type ShareSystem = (
  system: AccessSystem | null,
  event: React.MouseEvent<HTMLButtonElement>,
) => void;

/**
 * The access page's main list: one row for each connected system, with the
 * recipients that can use it and the strongest thing each recipient can do.
 */
export function SystemAccessView(
  props: Readonly<{
    view: AccessControlView;
    capabilitiesPath: string;
    integrationsPath: string | null;
    checkOpen: boolean;
    closeCheck: () => void;
    checkPanel: React.ReactNode;
    onOpenCheck: () => void;
    onShare: ShareSystem;
    onRevoke: (grant: AccessControlGrantView) => void;
    onApplyDefaults: () => void;
    loadMore: () => void;
    loadingMore: boolean;
  }>,
): React.ReactNode {
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<SystemFilter>("all");
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const systems = buildAccessSystems(props.view);
  const terms = search.toLowerCase().split(/\s+/u).filter(isNotEmpty);
  const visible = systems.filter(matchesSystem.bind(null, terms, filter));
  const canManage = props.view.organisation.actions.kind === "manage";
  // A system counts as closed only when every grant page is loaded.
  const complete = props.view.grants.nextCursor === null;
  const opened =
    openKey === null ? undefined : systems.find(hasKey.bind(null, openKey));
  // A system can leave the list after a revoke; its drawer then closes.
  const gone = openKey !== null && opened === undefined;
  React.useEffect(() => {
    if (gone) setOpenKey(null);
  }, [gone]);
  return (
    <section
      className="access35-section"
      aria-labelledby="access35-systems-title"
    >
      <div className="access35-section-heading">
        <div>
          <h2 id="access35-systems-title">Connected systems</h2>
          <p>Who can use each connected system, and how.</p>
        </div>
        <div className="access35-heading-actions">
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={props.onOpenCheck}
          >
            <ShieldCheck aria-hidden="true" size={16} />
            Check access
          </button>
          {canManage ? (
            <button
              type="button"
              className="connection-primary-action"
              onClick={props.onShare.bind(null, null)}
            >
              <Plus aria-hidden="true" size={16} />
              Share a system
            </button>
          ) : null}
        </div>
      </div>
      <SideDrawer
        open={props.checkOpen}
        title="Check access"
        close={props.closeCheck}
        className="access35-check-drawer"
      >
        <div className="side-drawer-body">{props.checkPanel}</div>
      </SideDrawer>
      {canManage && complete
        ? renderUnsharedNotice(systems, props.onShare)
        : null}
      {props.view.grants.items.length === 0 && complete ? (
        <div className="access35-empty">
          <h3>No access granted yet</h3>
          <p>
            Recommended access sets the safe baseline: owners, admins, and
            selected Slack conversations may handle ordinary Case work, while
            provider data stays closed.
          </p>
          {canManage ? (
            <button
              type="button"
              className="secondary"
              onClick={props.onApplyDefaults}
            >
              Apply recommended access
            </button>
          ) : null}
        </div>
      ) : null}
      {systems.length === 0 ? null : (
        <>
          <div className="access35-system-filters">
            <input
              type="search"
              aria-label="Find a system, person, channel, or action"
              value={search}
              onChange={changeSearch.bind(null, setSearch)}
              placeholder="Shopify, #cafe-ops, refund"
            />
            <Select.Root
              items={SYSTEM_FILTERS}
              value={filter}
              onValueChange={changeFilter.bind(null, setFilter)}
            >
              <Select.Trigger aria-label="Show systems">
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {SYSTEM_FILTERS.map((item) => (
                  <Select.Item key={item.value} value={item.value}>
                    {item.label}
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Root>
          </div>
          <SystemDrawer
            system={opened}
            complete={complete}
            canManage={canManage}
            capabilitiesPath={props.capabilitiesPath}
            integrationsPath={props.integrationsPath}
            onShare={props.onShare}
            onRevoke={props.onRevoke}
            close={setOpenKey.bind(null, null)}
          />
          {visible.length === 0 ? (
            <p className="access35-result-count" role="status">
              No system matches. Clear the search or the filter.
            </p>
          ) : (
            <ul className="access35-system-list">
              {visible.map((system) => (
                <SystemRow
                  key={system.key}
                  system={system}
                  complete={complete}
                  open={setOpenKey}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {complete ? null : (
        <button
          type="button"
          className="secondary access35-load-more"
          disabled={props.loadingMore}
          onClick={props.loadMore}
        >
          {props.loadingMore ? "Loading more access…" : "Load more access"}
        </button>
      )}
    </section>
  );
}

function SystemRow(
  props: Readonly<{
    system: AccessSystem;
    complete: boolean;
    open: (key: string) => void;
  }>,
): React.ReactNode {
  const { system } = props;
  return (
    <li className="access35-system">
      <button
        type="button"
        className="access35-system-row"
        aria-haspopup="dialog"
        onClick={props.open.bind(null, system.key)}
      >
        {renderSystemTile(system)}
        <span className="access35-system-name">
          <strong>{system.label}</strong>
          <small className="access35-system-summary">
            {renderSystemSummary(system, props.complete)}
          </small>
        </span>
        <ChevronRight
          className="access35-system-chevron"
          aria-hidden="true"
          size={16}
        />
      </button>
    </li>
  );
}

/**
 * Everything about one system: the attention notice, the actions that always
 * ask first, each recipient with its permissions, and the revoked history.
 * The confirm dialogs that open from here stack above the drawer.
 */
function SystemDrawer(
  props: Readonly<{
    system: AccessSystem | undefined;
    complete: boolean;
    canManage: boolean;
    capabilitiesPath: string;
    integrationsPath: string | null;
    onShare: ShareSystem;
    onRevoke: (grant: AccessControlGrantView) => void;
    close: () => void;
  }>,
): React.ReactNode {
  const { system } = props;
  const dialog = React.useRef<HTMLDialogElement>(null);
  const open = system !== undefined;
  React.useEffect(() => {
    if (!open) return undefined;
    const listener = keepFocusInDrawer.bind(null, dialog);
    document.addEventListener("close", listener, true);
    return () => document.removeEventListener("close", listener, true);
  }, [open]);
  const shared = system !== undefined && system.recipients.length > 0;
  return (
    <SideDrawer
      open={open}
      title={system?.label ?? ""}
      close={props.close}
      className="access35-system-drawer"
      dialogRef={dialog}
      footer={
        system === undefined ? undefined : (
          <>
            <Link
              className="access35-system-drawer-link"
              to={actionsHref(
                props.capabilitiesPath,
                systemActionSearch(system),
              )}
            >
              Edit actions
            </Link>
            {props.canManage ? (
              <button
                type="button"
                className="connection-primary-action"
                onClick={props.onShare.bind(null, system)}
              >
                <Plus aria-hidden="true" size={16} />
                {shared ? "Add a person, channel, or agent" : "Share"}
              </button>
            ) : null}
          </>
        )
      }
    >
      {system === undefined ? null : (
        <div className="side-drawer-body">
          {system.availability === "available" ? null : (
            <p className="access35-note">
              <CircleAlert aria-hidden="true" size={17} />
              <span>
                This connection needs attention.
                {props.integrationsPath === null ? null : (
                  <>
                    {" "}
                    <Link to={props.integrationsPath}>
                      Fix it in Integrations
                    </Link>
                  </>
                )}
              </span>
            </p>
          )}
          {system.approvalActions.length === 0 ? null : (
            <p className="access35-system-approvals">
              <LockKeyhole aria-hidden="true" size={16} />
              <span>
                Always asks first: {system.approvalActions.join(", ")}
              </span>
            </p>
          )}
          {shared ? (
            <ul className="access35-recipient-list">
              {system.recipients.map(
                renderRecipient.bind(null, props.onRevoke),
              )}
            </ul>
          ) : (
            <p className="access35-system-closed">
              {props.complete
                ? "Nobody can use this system yet. Agents cannot read it."
                : "No access in the part of the list that is loaded."}
            </p>
          )}
          {system.revokedGrants.length === 0 ? null : (
            <section className="access35-revoked">
              <h3>Removed earlier</h3>
              <ul className="access35-permission-list">
                {system.revokedGrants.map(renderRevokedPermission)}
              </ul>
            </section>
          )}
        </div>
      )}
    </SideDrawer>
  );
}

/**
 * A revoke removes the button that opened its confirm dialog, so the browser
 * has no control to give focus back to. Keep focus in the drawer instead.
 */
function keepFocusInDrawer(
  drawer: React.RefObject<HTMLDialogElement | null>,
  event: Event,
): void {
  if (event.target === drawer.current) return;
  window.requestAnimationFrame(() => {
    const dialog = drawer.current;
    if (dialog === null || !dialog.open) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected)
      return;
    dialog.tabIndex = -1;
    dialog.focus({ preventScroll: true });
  });
}

function renderUnsharedNotice(
  systems: readonly AccessSystem[],
  onShare: ShareSystem,
): React.ReactNode {
  const unshared: AccessSystem[] = [];
  for (const system of systems) {
    if (system.kind === "integration" && system.recipients.length === 0)
      unshared.push(system);
  }
  const [first] = unshared;
  if (first === undefined) return null;
  return (
    <div className="access35-attention" role="status">
      <CircleAlert aria-hidden="true" size={18} />
      {unshared.length === 1 ? (
        <>
          <p>{first.label} is connected, but nobody can use it yet.</p>
          <button type="button" onClick={onShare.bind(null, first)}>
            Share {systemShortName(first)}
          </button>
        </>
      ) : (
        <p>
          {unshared.length} connected systems are not shared yet:{" "}
          {unshared.map(systemLabel).join(", ")}.
        </p>
      )}
    </div>
  );
}

function renderSystemTile(system: AccessSystem): React.ReactNode {
  switch (system.kind) {
    case "integration":
      return system.provider === null ? (
        <span className="access35-system-tile" aria-hidden="true">
          <Building2 size={18} />
        </span>
      ) : (
        <ProviderTile
          provider={providerTile(system.provider)}
          label={providerLabel(system.provider)}
        />
      );
    case "commerce":
      return <ProviderTile provider="builtin_commerce" label="Purin Checkout" />;
    case "workspace":
      return (
        <span className="access35-system-tile" aria-hidden="true">
          <Building2 size={18} />
        </span>
      );
  }
}

/** One line for the row: the state of the system and who can use it. */
function renderSystemSummary(
  system: AccessSystem,
  complete: boolean,
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  if (system.availability !== "available")
    parts.push(
      <span key="attention" className="access35-summary-warn">
        Needs attention
      </span>,
    );
  const recipients = system.recipients.length;
  if (recipients === 0) {
    if (complete)
      parts.push(
        <span key="closed" className="access35-summary-warn">
          Not shared
        </span>,
      );
  } else {
    parts.push(`Shared with ${recipients}`);
    const canChange = recipientsWhoCanChange(system);
    if (canChange > 0) parts.push(`${canChange} can change`);
  }
  const approvals = system.approvalActions.length;
  if (approvals > 0)
    parts.push(
      approvals === 1
        ? "1 action asks first"
        : `${approvals} actions ask first`,
    );
  if (parts.length === 0) return system.detail;
  return parts.map((part, index) => (
    <React.Fragment key={index}>
      {index === 0 ? null : " · "}
      {part}
    </React.Fragment>
  ));
}

function renderRecipient(
  onRevoke: (grant: AccessControlGrantView) => void,
  recipient: SystemRecipient,
): React.ReactNode {
  return (
    <li key={recipient.subject.subjectRefId}>
      <div className="access35-recipient-head">
        {renderSubjectIcon(recipient.subject.kind)}
        <span className="access35-recipient-name">
          {recipient.subject.label}
          <small>
            {recipient.grants.length}{" "}
            {recipient.grants.length === 1 ? "permission" : "permissions"}
          </small>
        </span>
        <span className={`access35-level ${recipient.level}`}>
          {levelLabel(recipient.level)}
        </span>
      </div>
      <ul className="access35-permission-list">
        {recipient.grants.map(renderPermission.bind(null, onRevoke))}
      </ul>
    </li>
  );
}

function renderPermission(
  onRevoke: (grant: AccessControlGrantView) => void,
  grant: AccessControlGrantView,
): React.ReactNode {
  return (
    <li key={grant.grantId}>
      <div className="access35-permission">
        <span>
          {grant.capability.label}
          <small>{permissionDetail(grant)}</small>
        </span>
        {grant.actions.kind === "revoke_grant" ? (
          <button type="button" onClick={onRevoke.bind(null, grant)}>
            Remove…
          </button>
        ) : null}
      </div>
    </li>
  );
}

function renderRevokedPermission(
  grant: AccessControlGrantView,
): React.ReactNode {
  return (
    <li key={grant.grantId}>
      <div className="access35-permission">
        <span>
          {grant.subject.label} · {grant.capability.label}
          <small>{permissionDetail(grant)}</small>
        </span>
      </div>
    </li>
  );
}

function renderSubjectIcon(
  kind: AccessControlSubjectView["kind"],
): React.ReactNode {
  switch (kind) {
    case "organisation_role":
      return <Users aria-hidden="true" size={17} />;
    case "person":
      return <User aria-hidden="true" size={17} />;
    case "conversation":
      return <MessagesSquare aria-hidden="true" size={17} />;
    case "workflow":
      return <Workflow aria-hidden="true" size={17} />;
    case "agent_mailbox":
      return <Mail aria-hidden="true" size={17} />;
    case "whatsapp_support":
      return <MessageCircle aria-hidden="true" size={17} />;
    case "case":
      return <Bot aria-hidden="true" size={17} />;
  }
}

/** The exact scope and origin of one grant, without repeating the action. */
function permissionDetail(grant: AccessControlGrantView): string {
  const parts: string[] = [];
  if (
    grant.resource.kind !== "platform" &&
    grant.resource.label !== grant.capability.label
  )
    parts.push(grant.resource.label);
  parts.push(grant.provenance.label);
  return parts.join(" · ");
}

function systemLabel(system: AccessSystem): string {
  return system.label;
}

function systemShortName(system: AccessSystem): string {
  return system.provider === null
    ? system.label
    : providerLabel(system.provider);
}

function actionsHref(path: string, search: string): string {
  if (search.length === 0) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}actions=${encodeURIComponent(search)}`;
}

function hasKey(key: string, system: AccessSystem): boolean {
  return system.key === key;
}

function isNotEmpty(term: string): boolean {
  return term.length > 0;
}

function changeSearch(
  change: (value: string) => void,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  change(event.currentTarget.value);
}

function changeFilter(
  change: (value: SystemFilter) => void,
  value: string | null,
): void {
  if (value === "all" || value === "not_shared" || value === "can_change")
    change(value);
}

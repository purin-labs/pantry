import React from "react";
import { Link } from "react-router";

export function PageHeader(props: {
  readonly title: string;
  readonly description: string;
}): React.ReactNode {
  return (
    <header className="portal-heading">
      <h1 id="portal-page-title" tabIndex={-1}>
        {props.title}
      </h1>
      <p>{props.description}</p>
    </header>
  );
}

export function PageSkeleton(props: {
  readonly label: string;
}): React.ReactNode {
  return (
    <section
      className="portal-band route-page-skeleton"
      aria-busy="true"
      aria-label={props.label}
    >
      <span className="skeleton-line skeleton-line-short" aria-hidden="true" />
      <span className="skeleton-line" aria-hidden="true" />
      <span className="skeleton-line" aria-hidden="true" />
      <span className="skeleton-line skeleton-line-medium" aria-hidden="true" />
    </section>
  );
}

export type EmptyStateContent =
  | {
      readonly title: string;
      readonly detail: string;
      readonly action: React.ReactNode;
    }
  | {
      readonly title: string;
      readonly detail: string;
      readonly action?: never;
    };

export function EmptyState(props: EmptyStateContent): React.ReactNode {
  return (
    <div className="empty-state operations-empty">
      <strong>{props.title}</strong>
      <span>{props.detail}</span>
      {props.action}
    </div>
  );
}

export function RecoverableError(props: {
  readonly message: string;
  readonly action: React.ReactNode;
}): React.ReactNode {
  return (
    <div className="home-recovery" role="alert">
      <p className="error-text">{props.message}</p>
      {props.action}
    </div>
  );
}

type NoticeProps =
  | {
      readonly tone: "neutral" | "success" | "warning";
      readonly announcement: "none";
      readonly children: React.ReactNode;
    }
  | {
      readonly tone: "neutral" | "success" | "warning";
      readonly announcement: "polite";
      readonly children: React.ReactNode;
    };

export function Notice(props: NoticeProps): React.ReactNode {
  return (
    <p
      className={`notice notice-${props.tone}`}
      role={props.announcement === "polite" ? "status" : undefined}
    >
      {props.children}
    </p>
  );
}

export function TechnicalDetails(props: {
  readonly summary: string;
  readonly children: React.ReactNode;
}): React.ReactNode {
  return (
    <details className="support-details">
      <summary>{props.summary}</summary>
      {props.children}
    </details>
  );
}

import type { StatusChipStatus } from "./status-chip";
import { assertNever } from "@seams/std";

export type { StatusChipStatus } from "./status-chip";

function statusChipClass(status: StatusChipStatus): string {
  switch (status.kind) {
    case "neutral":
      return "status-chip-neutral";
    case "info":
      return "status-chip-info";
    case "success":
      return "status-chip-success";
    case "warning":
      return "status-chip-warning";
    case "danger":
      return "status-chip-danger";
    default:
      return assertNever(status, "Unhandled shared component variant");
  }
}

export function StatusChip(props: {
  readonly status: StatusChipStatus;
}): React.ReactNode {
  return (
    <span className={`status-chip ${statusChipClass(props.status)}`}>
      {props.status.label}
    </span>
  );
}

export type ResourceFact = {
  readonly label: string;
  readonly value: React.ReactNode;
};

export type ResourceRowTarget =
  | { readonly kind: "static" }
  | { readonly kind: "link"; readonly href: string };

function renderResourceFacts(facts: readonly ResourceFact[]): React.ReactNode {
  if (facts.length === 0) return null;
  const entries: React.ReactNode[] = [];
  for (const fact of facts) {
    entries.push(
      <div key={fact.label}>
        <dt>{fact.label}</dt>
        <dd>{fact.value}</dd>
      </div>,
    );
  }
  return <dl className="resource-row-facts">{entries}</dl>;
}

type ResourceRowProps = {
  readonly title: string;
  readonly description: React.ReactNode;
  readonly facts: readonly ResourceFact[];
  readonly status: StatusChipStatus | null;
  readonly target: ResourceRowTarget;
  readonly action: React.ReactNode | null;
};

export function ResourceRow(props: ResourceRowProps): React.ReactNode {
  return (
    <article className="resource-row">
      <div className="resource-row-main">
        <div className="resource-row-heading">
          <h3>{renderResourceRowTitle(props.title, props.target)}</h3>
          {props.status === null ? null : <StatusChip status={props.status} />}
        </div>
        <div className="resource-row-description">{props.description}</div>
      </div>
      {renderResourceFacts(props.facts)}
      {props.action === null ? null : (
        <div className="resource-row-action">{props.action}</div>
      )}
    </article>
  );
}

function renderResourceRowTitle(
  title: string,
  target: ResourceRowTarget,
): React.ReactNode {
  switch (target.kind) {
    case "static":
      return title;
    case "link":
      return <Link to={target.href}>{title}</Link>;
    default:
      return assertNever(target, "Unhandled shared component variant");
  }
}

export function ResourceList<T>(props: {
  readonly label: string;
  readonly items: readonly T[];
  readonly getKey: (item: T) => string;
  readonly renderRow: (item: T) => React.ReactNode;
  readonly empty: React.ReactNode;
}): React.ReactNode {
  if (props.items.length === 0) {
    return <div className="resource-list-empty">{props.empty}</div>;
  }
  const rows: React.ReactNode[] = [];
  for (const item of props.items) {
    rows.push(
      <div role="listitem" key={props.getKey(item)}>
        {props.renderRow(item)}
      </div>,
    );
  }
  return (
    <div className="resource-list" role="list" aria-label={props.label}>
      {rows}
    </div>
  );
}

export type WorkItemState =
  | { readonly kind: "queued"; readonly label: string }
  | { readonly kind: "in_progress"; readonly label: string }
  | { readonly kind: "blocked"; readonly label: string }
  | { readonly kind: "complete"; readonly label: string };

export type WorkItemDue =
  | { readonly kind: "none"; readonly label: string }
  | {
      readonly kind: "scheduled";
      readonly label: string;
      readonly dateTime: string;
    }
  | {
      readonly kind: "overdue";
      readonly label: string;
      readonly dateTime: string;
    };

export type WorkItemData = {
  readonly id: string;
  readonly title: string;
  readonly summary: React.ReactNode;
  readonly state: WorkItemState;
  readonly due: WorkItemDue;
  readonly facts: readonly ResourceFact[];
  readonly target: ResourceRowTarget;
  readonly action:
    | { readonly kind: "none" }
    | {
        readonly kind: "button";
        readonly label: string;
        readonly onActivate: React.MouseEventHandler<HTMLButtonElement>;
        readonly disabled: boolean;
      };
};

function workItemStatus(state: WorkItemState): StatusChipStatus {
  switch (state.kind) {
    case "queued":
      return { kind: "neutral", label: state.label };
    case "in_progress":
      return { kind: "info", label: state.label };
    case "blocked":
      return { kind: "warning", label: state.label };
    case "complete":
      return { kind: "success", label: state.label };
    default:
      return assertNever(state, "Unhandled shared component variant");
  }
}

function renderWorkItemDue(due: WorkItemDue): React.ReactNode {
  switch (due.kind) {
    case "none":
      return <span className="work-item-due">{due.label}</span>;
    case "scheduled":
      return (
        <time className="work-item-due" dateTime={due.dateTime}>
          {due.label}
        </time>
      );
    case "overdue":
      return (
        <time
          className="work-item-due work-item-due-overdue"
          dateTime={due.dateTime}
        >
          {due.label}
        </time>
      );
    default:
      return assertNever(due, "Unhandled shared component variant");
  }
}

export function WorkItem(props: {
  readonly item: WorkItemData;
}): React.ReactNode {
  const action =
    props.item.action.kind === "button" ? (
      <button
        type="button"
        onClick={props.item.action.onActivate}
        disabled={props.item.action.disabled}
      >
        {props.item.action.label}
      </button>
    ) : null;
  const description = (
    <div className="work-item-summary">
      <span>{props.item.summary}</span>
      {renderWorkItemDue(props.item.due)}
    </div>
  );
  return (
    <ResourceRow
      title={props.item.title}
      description={description}
      facts={props.item.facts}
      status={workItemStatus(props.item.state)}
      target={props.item.target}
      action={action}
    />
  );
}

export function WorkQueue(props: {
  readonly label: string;
  readonly items: readonly WorkItemData[];
  readonly empty: React.ReactNode;
}): React.ReactNode {
  if (props.items.length === 0) {
    return <div className="work-queue-empty">{props.empty}</div>;
  }
  const items: React.ReactNode[] = [];
  for (const item of props.items) {
    items.push(
      <div role="listitem" key={item.id}>
        <WorkItem item={item} />
      </div>,
    );
  }
  return (
    <div className="work-queue" role="list" aria-label={props.label}>
      {items}
    </div>
  );
}

export type ActionBarAction =
  | {
      readonly kind: "primary";
      readonly label: string;
      readonly onActivate: React.MouseEventHandler<HTMLButtonElement>;
      readonly disabled: boolean;
    }
  | {
      readonly kind: "secondary";
      readonly label: string;
      readonly onActivate: React.MouseEventHandler<HTMLButtonElement>;
      readonly disabled: boolean;
    }
  | {
      readonly kind: "danger";
      readonly label: string;
      readonly onActivate: React.MouseEventHandler<HTMLButtonElement>;
      readonly disabled: boolean;
    };

function actionBarButtonClass(action: ActionBarAction): string {
  switch (action.kind) {
    case "primary":
      return "action-bar-button action-bar-button-primary";
    case "secondary":
      return "action-bar-button action-bar-button-secondary";
    case "danger":
      return "action-bar-button action-bar-button-danger";
    default:
      return assertNever(action, "Unhandled shared component variant");
  }
}

export function ActionBar(props: {
  readonly label: string;
  readonly actions: readonly [ActionBarAction, ...ActionBarAction[]];
}): React.ReactNode {
  const actions: React.ReactNode[] = [];
  for (const action of props.actions) {
    actions.push(
      <button
        className={actionBarButtonClass(action)}
        type="button"
        key={action.label}
        onClick={action.onActivate}
        disabled={action.disabled}
      >
        {action.label}
      </button>,
    );
  }
  return (
    <div className="action-bar" role="group" aria-label={props.label}>
      {actions}
    </div>
  );
}

/**
 * Rounded tile marks for the providers CafeOS connects to. The glyphs are the
 * providers' own marks in their own palette (simplified where a faithful
 * trace would not survive 24px), so an operator can find a connection by shape
 * before reading any label.
 */
export type ProviderTileName =
  | "shopify"
  | "slack"
  | "stripe"
  | "square"
  | "airtable"
  | "dropbox"
  | "notion"
  | "gmail"
  | "google_drive"
  | "whatsapp"
  | "codex"
  | "typesafe"
  | "onepassword"
  | "satyr_commerce"
  | "generic";

export function ProviderTile(props: {
  readonly provider: ProviderTileName;
  readonly label: string;
}): React.ReactNode {
  return (
    <span
      className={`provider-tile provider-tile-${props.provider}`}
      role="img"
      aria-label={props.label}
    >
      {providerGlyph(props.provider)}
    </span>
  );
}

function providerGlyph(provider: ProviderTileName): React.ReactNode {
  switch (provider) {
    case "onepassword":
      // A keyhole in a ring, white on 1Password's blue.
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M12 1.5a10.5 10.5 0 1 1 0 21a10.5 10.5 0 0 1 0-21Zm0 2.25a8.25 8.25 0 1 0 0 16.5a8.25 8.25 0 0 0 0-16.5ZM13.25 6.5v4.1l-1 .9l1 .9v5.1h-2.5v-4.1l1-.9l-1-.9V6.5Z"
          />
        </svg>
      );
    case "typesafe":
      // TypeSafe's official symbol from https://typesafe.ai/.
      return (
        <svg viewBox="0 0 16.487 24" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M 12.756 2.928 L 12.756 7.067 L 16.486 9.487 L 16.487 18.652 L 8.244 24 L 3.732 21.073 L 3.732 16.82 L 0 14.399 L 0 5.35 L 0.355 5.118 L 8.244 0 Z M 5.94 20.65 L 8.242 22.144 L 14.275 18.227 L 11.975 16.735 Z M 9.022 10.332 L 9.022 14.4 L 5.29 16.822 L 5.29 19.216 L 11.197 15.383 L 11.197 8.921 Z M 12.756 15.384 L 14.928 16.794 L 14.928 10.332 L 12.756 8.922 Z M 2.21 13.976 L 4.511 15.47 L 6.812 13.976 L 4.512 12.485 Z M 1.559 6.193 L 1.559 12.544 L 3.731 11.134 L 3.731 7.066 L 7.464 4.643 L 7.464 2.36 L 1.56 6.193 Z M 5.291 11.132 L 7.463 12.542 L 7.463 10.332 L 5.292 8.921 L 5.292 11.132 Z M 5.94 7.487 L 8.244 8.981 L 10.544 7.488 L 8.244 5.994 Z M 9.024 4.643 L 11.196 6.054 L 11.196 3.774 L 9.024 2.359 Z"
          />
        </svg>
      );
    case "shopify":
      // Shopify's bag, white on the brand green as their own app icon
      // renders it; the logo's shaded edge is dropped because a one-colour
      // silhouette has nothing to shade.
      return (
        <svg viewBox="0 0 256 292" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M223.774 57.34c-.201-1.46-1.48-2.268-2.537-2.357a19614 19614 0 0 0-23.383-1.743s-15.507-15.395-17.209-17.099c-1.703-1.703-5.029-1.185-6.32-.805c-.19.056-3.388 1.043-8.678 2.68c-5.18-14.906-14.322-28.604-30.405-28.604c-.444 0-.901.018-1.358.044C129.31 3.407 123.644.779 118.75.779c-37.465 0-55.364 46.835-60.976 70.635c-14.558 4.511-24.9 7.718-26.221 8.133c-8.126 2.549-8.383 2.805-9.45 10.462C21.3 95.806.038 260.235.038 260.235l165.678 31.042l89.77-19.42S223.973 58.8 223.775 57.34M156.49 40.848l-14.019 4.339c.005-.988.01-1.96.01-3.023c0-9.264-1.286-16.723-3.349-22.636c8.287 1.04 13.806 10.469 17.358 21.32m-27.638-19.483c2.304 5.773 3.802 14.058 3.802 25.238c0 .572-.005 1.095-.01 1.624c-9.117 2.824-19.024 5.89-28.953 8.966c5.575-21.516 16.025-31.908 25.161-35.828m-11.131-10.537c1.617 0 3.246.549 4.805 1.622c-12.007 5.65-24.877 19.88-30.312 48.297l-22.886 7.088C75.694 46.16 90.81 10.828 117.72 10.828"
          />
          <path
            fill="var(--provider-tile-bg)"
            d="m135.242 104.585l-11.069 32.926s-9.698-5.176-21.586-5.176c-17.428 0-18.305 10.937-18.305 13.693c0 15.038 39.2 20.8 39.2 56.024c0 27.713-17.577 45.558-41.277 45.558c-28.44 0-42.984-17.7-42.984-17.7l7.615-25.16s14.95 12.835 27.565 12.835c8.243 0 11.596-6.49 11.596-11.232c0-19.616-32.16-20.491-32.16-52.724c0-27.129 19.472-53.382 58.778-53.382c15.145 0 22.627 4.338 22.627 4.338"
          />
        </svg>
      );
    case "whatsapp":
      // WhatsApp's speech bubble, white on the brand green.
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967c-.273-.099-.471-.148-.67.15c-.197.297-.767.966-.94 1.164c-.173.199-.347.223-.644.075c-.297-.15-1.255-.463-2.39-1.475c-.883-.788-1.48-1.761-1.653-2.059c-.173-.297-.018-.458.13-.606c.134-.133.298-.347.446-.52c.149-.174.198-.298.298-.497c.099-.198.05-.371-.025-.52c-.075-.149-.669-1.612-.916-2.207c-.242-.579-.487-.5-.669-.51a12 12 0 0 0-.57-.01c-.198 0-.52.074-.792.372c-.272.297-1.04 1.016-1.04 2.479c0 1.462 1.065 2.875 1.213 3.074c.149.198 2.096 3.2 5.077 4.487c.709.306 1.262.489 1.694.625c.712.227 1.36.195 1.871.118c.571-.085 1.758-.719 2.006-1.413c.248-.694.248-1.289.173-1.413c-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214l-3.741.982l.998-3.648l-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884c2.64 0 5.122 1.03 6.988 2.898a9.83 9.83 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.8 11.8 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.9 11.9 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.82 11.82 0 0 0-3.48-8.413"
          />
        </svg>
      );
    case "slack":
      // Slack's four-colour mark.
      return (
        <svg viewBox="0 0 256 256" aria-hidden="true" focusable="false">
          <path
            fill="#e01e5a"
            d="M53.841 161.32c0 14.832-11.987 26.82-26.819 26.82S.203 176.152.203 161.32c0-14.831 11.987-26.818 26.82-26.818H53.84zm13.41 0c0-14.831 11.987-26.818 26.819-26.818s26.819 11.987 26.819 26.819v67.047c0 14.832-11.987 26.82-26.82 26.82c-14.83 0-26.818-11.988-26.818-26.82z"
          />
          <path
            fill="#36c5f0"
            d="M94.07 53.638c-14.832 0-26.82-11.987-26.82-26.819S79.239 0 94.07 0s26.819 11.987 26.819 26.819v26.82zm0 13.613c14.832 0 26.819 11.987 26.819 26.819s-11.987 26.819-26.82 26.819H26.82C11.987 120.889 0 108.902 0 94.069c0-14.83 11.987-26.818 26.819-26.818z"
          />
          <path
            fill="#2eb67d"
            d="M201.55 94.07c0-14.832 11.987-26.82 26.818-26.82s26.82 11.988 26.82 26.82s-11.988 26.819-26.82 26.819H201.55zm-13.41 0c0 14.832-11.988 26.819-26.82 26.819c-14.831 0-26.818-11.987-26.818-26.82V26.82C134.502 11.987 146.489 0 161.32 0s26.819 11.987 26.819 26.819z"
          />
          <path
            fill="#ecb22e"
            d="M161.32 201.55c14.832 0 26.82 11.987 26.82 26.818s-11.988 26.82-26.82 26.82c-14.831 0-26.818-11.988-26.818-26.82V201.55zm0-13.41c-14.831 0-26.818-11.988-26.818-26.82c0-14.831 11.987-26.818 26.819-26.818h67.25c14.832 0 26.82 11.987 26.82 26.819s-11.988 26.819-26.82 26.819z"
          />
        </svg>
      );
    case "square":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M4.36 0h15.28A4.36 4.36 0 0 1 24 4.36v15.28A4.36 4.36 0 0 1 19.64 24H4.36A4.36 4.36 0 0 1 0 19.64V4.36A4.36 4.36 0 0 1 4.36 0Zm1.46 4.36a1.46 1.46 0 0 0-1.46 1.46v12.36a1.46 1.46 0 0 0 1.46 1.46h12.36a1.46 1.46 0 0 0 1.46-1.46V5.82a1.46 1.46 0 0 0-1.46-1.46Z"
          />
          <rect
            x="8.73"
            y="8.73"
            width="6.54"
            height="6.54"
            rx="0.73"
            fill="currentColor"
          />
        </svg>
      );
    case "stripe":
      // Stripe's S, white on Stripe purple.
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409c0-.831.683-1.305 1.901-1.305c2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0C9.667 0 7.589.654 6.104 1.872C4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219c2.585.92 3.445 1.574 3.445 2.583c0 .98-.84 1.545-2.354 1.545c-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813c1.664-1.305 2.525-3.236 2.525-5.732c0-4.128-2.524-5.851-6.594-7.305z"
          />
        </svg>
      );
    case "airtable":
      // Airtable's three stacked faces.
      return (
        <svg viewBox="0 0 256 215" aria-hidden="true" focusable="false">
          <path
            fill="#ffbf00"
            d="M114.259 2.701L18.86 42.176c-5.305 2.195-5.25 9.73.089 11.847l95.797 37.989a35.54 35.54 0 0 0 26.208 0l95.799-37.99c5.337-2.115 5.393-9.65.086-11.846L141.442 2.7a35.55 35.55 0 0 0-27.183 0"
          />
          <path
            fill="#26b5f8"
            d="M136.35 112.757v94.902c0 4.514 4.55 7.605 8.746 5.942l106.748-41.435a6.39 6.39 0 0 0 4.035-5.941V71.322c0-4.514-4.551-7.604-8.747-5.941l-106.748 41.434a6.39 6.39 0 0 0-4.035 5.942"
          />
          <path
            fill="#ed3049"
            d="m111.423 117.654l-31.68 15.296l-3.217 1.555L9.65 166.548C5.411 168.593 0 165.504 0 160.795V71.72c0-1.704.874-3.175 2.046-4.283a7.3 7.3 0 0 1 1.618-1.213c1.598-.959 3.878-1.215 5.816-.448l101.41 40.18c5.155 2.045 5.56 9.268.533 11.697"
          />
        </svg>
      );
    case "dropbox":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="m6.2 3.5l5.8 3.7l-5.8 3.7L.4 7.2zm11.6 0l5.8 3.7l-5.8 3.7L12 7.2zM6.2 11.7l5.8 3.7l-5.8 3.7l-5.8-3.7zm11.6 0l5.8 3.7l-5.8 3.7l-5.8-3.7zM12 16.2l5.8 3.7L12 23.5l-5.8-3.6z"
          />
        </svg>
      );
    case "notion":
      // Notion's page cube: a bare letterform read as a generic "N".
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514c-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233l4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632"
          />
        </svg>
      );
    case "gmail":
      // Gmail's M envelope in the four Google colours.
      return (
        <svg viewBox="0 0 256 193" aria-hidden="true" focusable="false">
          <path
            fill="#4285f4"
            d="M58.182 192.05V93.14L27.507 65.077L0 49.504v125.091c0 9.658 7.825 17.455 17.455 17.455z"
          />
          <path
            fill="#34a853"
            d="M197.818 192.05h40.727c9.659 0 17.455-7.826 17.455-17.455V49.505l-31.156 17.837l-27.026 25.798z"
          />
          <path
            fill="#ea4335"
            d="m58.182 93.14l-4.174-38.647l4.174-36.989L128 69.868l69.818-52.364l4.669 34.992l-4.669 40.644L128 145.504z"
          />
          <path
            fill="#fbbc04"
            d="M197.818 17.504V93.14L256 49.504V26.231c0-21.585-24.64-33.89-41.89-20.945z"
          />
          <path
            fill="#c5221f"
            d="m0 49.504l26.759 20.07L58.182 93.14V17.504L41.89 5.286C24.61-7.66 0 4.646 0 26.23z"
          />
        </svg>
      );
    case "google_drive":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path fill="#0F9D58" d="M8.1 2h7.8l6.6 11.4h-7.8z" />
          <path fill="#F4B400" d="m8.1 2l3.9 6.8l-7.3 12.7L.8 14.7z" />
          <path fill="#4285F4" d="M4.7 21.5l3.9-6.8h13.9l-3.9 6.8z" />
        </svg>
      );
    case "satyr_commerce":
      // The Pantry ram mark, same asset the console header uses.
      return <img src="/brand/satyr-mark-dark-64.png" alt="" />;
    case "codex":
      // OpenAI blossom sourced from developers.openai.com.
      return (
        <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
          <path
            d="M38.355 36.52v-9.415c0-.793.297-1.388.99-1.784l18.93-10.902c2.578-1.486 5.65-2.18 8.82-2.18 11.894 0 19.426 9.218 19.426 19.029 0 .694 0 1.486-.1 2.28L66.799 22.05c-1.189-.694-2.379-.694-3.568 0L38.355 36.52Zm44.202 36.67V50.694c0-1.388-.596-2.38-1.785-3.073L55.897 33.15l8.126-4.658c.694-.396 1.289-.396 1.982 0l18.93 10.902c5.452 3.172 9.118 9.91 9.118 16.452 0 7.531-4.46 14.47-11.496 17.344Zm-50.05-19.82-8.127-4.757c-.693-.396-.99-.99-.99-1.784V25.025c0-10.605 8.126-18.633 19.127-18.633 4.163 0 8.028 1.388 11.3 3.865l-19.525 11.3c-1.189.693-1.784 1.684-1.784 3.072v28.74ZM50 63.478l-11.645-6.541V43.062L50 36.522l11.645 6.54v13.875L50 63.477Zm7.483 30.129c-4.163 0-8.028-1.388-11.3-3.865l19.525-11.3c1.189-.693 1.784-1.684 1.784-3.071V46.629l8.226 4.757c.694.396.991.991.991 1.784v21.803c0 10.605-8.226 18.633-19.226 18.633v.001Zm-23.49-22.101-18.93-10.902c-5.45-3.172-9.117-9.91-9.117-16.451 0-7.632 4.559-14.47 11.595-17.344v22.596c0 1.388.595 2.379 1.784 3.072l24.777 14.37-8.126 4.659c-.694.396-1.289.396-1.982 0ZM32.905 87.76c-11.2 0-19.425-8.425-19.425-18.83 0-.794.1-1.587.198-2.38L33.2 77.85c1.189.693 2.379.693 3.568 0l24.876-14.37v9.415c0 .793-.298 1.388-.992 1.784L41.724 85.58c-2.576 1.486-5.649 2.18-8.82 2.18h.001Zm24.579 11.793c11.992 0 22.001-8.523 24.281-19.822C92.864 76.857 100 66.451 100 55.846c0-6.937-2.973-13.676-8.325-18.533.496-2.081.793-4.163.793-6.243 0-14.172-11.496-24.777-24.777-24.777-2.676 0-5.253.396-7.83 1.288C55.401 3.221 49.257.445 42.517.445c-11.992 0-22.001 8.523-24.281 19.822C7.136 23.14 0 33.547 0 44.152c0 6.938 2.973 13.676 8.325 18.533-.496 2.081-.793 4.163-.793 6.243 0 14.172 11.497 24.778 24.777 24.778 2.676 0 5.253-.397 7.83-1.289 4.459 4.36 10.604 7.136 17.344 7.136Z"
            fill="currentColor"
          />
        </svg>
      );
    case "generic":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M5 9.5 6.4 5.6h11.2L19 9.5M5 9.5h14M5 9.5v8.4h14V9.5M9.6 9.5a2.3 2.3 0 0 1-4.6 0m9.4 0a2.3 2.3 0 0 1-4.8 0m9.4 0a2.3 2.3 0 0 1-4.6 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return assertNever(provider, "Unhandled shared component variant");
  }
}

/**
 * Operators read recency, not timestamps: "4 minutes ago" answers "is this
 * live?" at a glance where "8/21/2026, 10:12:50 PM" makes them do the
 * subtraction. Anything past a week falls back to a plain calendar date.
 */
export { formatRelativeTime } from "./formatting";

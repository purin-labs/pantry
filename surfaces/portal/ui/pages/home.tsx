import React from "react";
import { Link } from "react-router";

import type { HomeSnapshot } from "@purin-labs/control-api/portal/home";
import { parseHomeResponse } from "@purin-labs/control-api/portal/home";
import {
  ControlApiError,
  controlRead,
  lastControlRead,
} from "@purin-labs/control/portal/control-client";
import { homePath } from "@purin-labs/control/portal/control-paths";
import type { ControlErrorKind } from "@purin-labs/control-api/portal/errors";
import type { PageContent } from "@purin-labs/control/portal/page-content";
import {
  EmptyState,
  Notice,
  RecoverableError,
  formatRelativeTime,
} from "@purin-labs/ui/page-components";
import { workspacePagePath, workspaceResourcePath } from "@purin-labs/ui/route";
import {
  readCommerceHomeAggregations,
  type CommerceHomeAggregation,
} from "@purin-labs/area-commerce/ui/features/commerce/index";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import type {
  HomeAttentionItem,
  HomeBlocker,
  HomeDestination,
  HomeSourceObservation,
} from "@purin-labs/control-api";
import "./home.css";

export function HomePage(props: {
  readonly organisationId: string;
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
}): React.ReactNode {
  const [content, setContent] = React.useState<HomePageContent>({
    kind: "loading",
  });
  const [commerceAggregations, setCommerceAggregations] =
    React.useState<HomeCommerceAggregationsState>({ kind: "loading" });
  const requestRevision = React.useRef(0);
  const aggregationRequestRevision = React.useRef(0);
  React.useEffect(
    beginHomePageLoad.bind(
      null,
      props.organisationId,
      requestRevision,
      setContent,
    ),
    [props.organisationId],
  );
  React.useEffect(
    beginHomeCommerceAggregationsLoad.bind(
      null,
      props.organisationId,
      aggregationRequestRevision,
      setCommerceAggregations,
    ),
    [props.organisationId],
  );
  return (
    <HomePageView
      organisationHandle={props.organisationHandle}
      workspaceHandle={props.workspaceHandle}
      content={content}
      commerceAggregations={commerceAggregations}
      retry={retryHomePage.bind(
        null,
        props.organisationId,
        requestRevision,
        setContent,
        aggregationRequestRevision,
        setCommerceAggregations,
      )}
    />
  );
}

function HomePageView(props: {
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
  readonly content: HomePageContent;
  readonly commerceAggregations?: HomeCommerceAggregationsState;
  readonly retry: () => void;
}): React.ReactNode {
  switch (props.content.kind) {
    case "loading":
      return <HomeLoading />;
    case "ready":
      return (
        <HomeReady
          organisationHandle={props.organisationHandle}
          workspaceHandle={props.workspaceHandle}
          content={props.content}
          commerceAggregations={
            props.commerceAggregations ?? { kind: "loading" }
          }
        />
      );
    case "failed":
      return (
        <RecoverableError
          message={props.content.problem}
          action={
            <button type="button" onClick={props.retry}>
              {props.content.recovery.label}
            </button>
          }
        />
      );
    case "unauthorized":
      return (
        <EmptyState
          title="Home is unavailable"
          detail={props.content.reason}
          action={null}
        />
      );
    default:
      return assertNever(props.content, "Unhandled Home value");
  }
}

/** Home has no empty state: an Organisation with nothing to show still has its sections. */
type HomePageContent = Variant<
  PageContent<HomeSnapshot>,
  "loading" | "ready" | "failed" | "unauthorized"
>;

type HomeRequestRevision = { current: number };
type HomeContentSetter = React.Dispatch<React.SetStateAction<HomePageContent>>;

type HomeCommerceAggregationsState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "ready";
      aggregations: readonly CommerceHomeAggregation[];
    }>
  | Readonly<{ kind: "unavailable" }>;

function beginHomePageLoad(
  organisationId: string,
  requestRevision: HomeRequestRevision,
  setContent: HomeContentSetter,
): () => void {
  void loadHomePage(organisationId, requestRevision, setContent, "initial");
  return invalidateHomePageRequest.bind(null, requestRevision);
}

function retryHomePage(
  organisationId: string,
  requestRevision: HomeRequestRevision,
  setContent: HomeContentSetter,
  aggregationRequestRevision: HomeRequestRevision,
  setCommerceAggregations: React.Dispatch<
    React.SetStateAction<HomeCommerceAggregationsState>
  >,
): void {
  void loadHomePage(organisationId, requestRevision, setContent, "refresh");
  void loadHomeCommerceAggregations(
    organisationId,
    aggregationRequestRevision,
    setCommerceAggregations,
  );
}

function beginHomeCommerceAggregationsLoad(
  organisationId: string,
  requestRevision: HomeRequestRevision,
  setState: React.Dispatch<React.SetStateAction<HomeCommerceAggregationsState>>,
): () => void {
  void loadHomeCommerceAggregations(organisationId, requestRevision, setState);
  return invalidateHomePageRequest.bind(null, requestRevision);
}

async function loadHomeCommerceAggregations(
  organisationId: string,
  requestRevision: HomeRequestRevision,
  setState: React.Dispatch<React.SetStateAction<HomeCommerceAggregationsState>>,
): Promise<void> {
  const revision = ++requestRevision.current;
  setState({ kind: "loading" });
  try {
    const aggregations = await readCommerceHomeAggregations(organisationId);
    if (requestRevision.current === revision)
      setState({ kind: "ready", aggregations });
  } catch {
    if (requestRevision.current === revision) setState({ kind: "unavailable" });
  }
}

async function loadHomePage(
  organisationId: string,
  requestRevision: HomeRequestRevision,
  setContent: HomeContentSetter,
  mode: "initial" | "refresh",
): Promise<void> {
  const revision = ++requestRevision.current;
  setContent(
    mode === "initial"
      ? lastHomeContent(organisationId)
      : refreshingPageContent,
  );
  try {
    const home = parseHomeResponse(await controlRead(homePath(organisationId)));
    if (requestRevision.current !== revision) return;
    setContent(readyHomeContent(home, false));
  } catch (error) {
    if (requestRevision.current !== revision) return;
    const kind = error instanceof ControlApiError ? error.kind : null;
    setContent(homeFailureContent(kind));
  }
}

function readyHomeContent(
  home: HomeSnapshot,
  updating: boolean,
): Variant<PageContent<HomeSnapshot>, "ready"> {
  return {
    kind: "ready",
    data: home,
    freshness: homeFreshness(home),
    updating,
  };
}

/**
 * What an earlier visit read for this Organisation, shown while the read
 * runs again. Without an earlier visit the page shows that it is loading.
 */
function lastHomeContent(organisationId: string): HomePageContent {
  const last = lastControlRead(homePath(organisationId));
  if (last === undefined) return { kind: "loading" };
  try {
    return readyHomeContent(parseHomeResponse(last), true);
  } catch {
    return { kind: "loading" };
  }
}

function invalidateHomePageRequest(requestRevision: HomeRequestRevision): void {
  requestRevision.current += 1;
}

function refreshingPageContent(content: HomePageContent): HomePageContent {
  return content.kind === "ready"
    ? { ...content, updating: true }
    : { kind: "loading" };
}

function homeFailureContent(
  errorKind: ControlErrorKind | null,
): Variant<PageContent<HomeSnapshot>, "failed" | "unauthorized"> {
  if (errorKind === "forbidden") {
    return {
      kind: "unauthorized",
      reason: "Your role cannot view this workspace.",
    };
  }
  return {
    kind: "failed",
    problem: "Home could not be refreshed.",
    recovery: { label: "Try again" },
  };
}

function homeFreshness(
  home: HomeSnapshot,
): Variant<PageContent<HomeSnapshot>, "ready">["freshness"] {
  const delayed = home.sourceObservations.find(sourceObservationIsDelayed);
  if (delayed?.observedAt !== null && delayed?.observedAt !== undefined) {
    return {
      kind: "delayed",
      observedAt: delayed.observedAt,
      explanation: "Some connected data is delayed.",
    };
  }
  return { kind: "current" };
}

function sourceObservationIsCurrent(
  observation: HomeSourceObservation,
): boolean {
  return observation.status === "current";
}

function sourceObservationIsDelayed(
  observation: HomeSourceObservation,
): boolean {
  return observation.status === "delayed";
}

function HomeLoading(): React.ReactNode {
  return (
    <section
      className="portal-band home-section"
      aria-labelledby="home-loading-title"
      aria-busy="true"
    >
      <h2 id="home-loading-title">Preparing your daily brief</h2>
      <p role="status">Loading current work and operating facts…</p>
    </section>
  );
}

function HomeReady(props: {
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
  readonly content: Variant<PageContent<HomeSnapshot>, "ready">;
  readonly commerceAggregations: HomeCommerceAggregationsState;
}): React.ReactNode {
  const snapshot = props.content.data;
  const lifecycle = snapshot.workspace.lifecycle;
  const active = lifecycle === "active";
  /* While configuring, the setup checklist above this brief owns the
   * whole story; attention, blockers, freshness, and today-facts are
   * operational concepts that cannot be true yet, so announcing them ("nothing
   * needs your attention", "data is delayed") only contradicts the checklist.
   * Bands with real content always render; it is the empty states that gate. */
  const settingUp = lifecycle === "configuring";
  const attention = snapshot.attention.filter(isPantryHomeAttention);
  const blockers = snapshot.blockers.filter(isPantryHomeBlocker);
  /* The documented order is fixed: needs-attention leads, today's counts
   * follow, workspace blockers close (style-guide.md, Home). */
  return (
    <>
      {renderHomeFreshness(props.content, active)}
      {attention.length === 0 && !active ? null : (
        <HomeAttention
          organisationHandle={props.organisationHandle}
          workspaceHandle={props.workspaceHandle}
          items={attention}
        />
      )}
      {active
        ? renderHomeCommerceAggregations(props.commerceAggregations)
        : null}
      {blockers.length === 0 || settingUp ? null : (
        <HomeBlockers
          organisationHandle={props.organisationHandle}
          workspaceHandle={props.workspaceHandle}
          blockers={blockers}
        />
      )}
      {settingUp ? null : renderHomeSources(snapshot.sourceObservations)}
    </>
  );
}

function isPantryHomeAttention(item: HomeAttentionItem): boolean {
  return item.kind !== "commerce_exception";
}

function isPantryHomeBlocker(blocker: HomeBlocker): boolean {
  return blocker.title !== "Commerce data is unavailable";
}

function renderHomeCommerceAggregations(
  state: HomeCommerceAggregationsState,
): React.ReactNode {
  if (state.kind === "loading") return null;
  if (state.kind === "unavailable") {
    return (
      <Notice tone="warning" announcement="polite">
        Commerce data is unavailable.
      </Notice>
    );
  }
  /* One list in place of five tiles: a count is a label and a number, and the
   * labels already say what the list is about. */
  return (
    <ul className="home-counts" aria-label="Commerce today">
      {state.aggregations.map(renderHomeCommerceAggregation)}
    </ul>
  );
}

function renderHomeCommerceAggregation(
  aggregation: CommerceHomeAggregation,
): React.ReactNode {
  const count = homeAggregationCount(aggregation.result);
  return (
    <li
      key={aggregation.name}
      data-quiet={count === 0 || count === "Unavailable"}
    >
      <span>{homeAggregationLabel(aggregation.name)}</span>
      <strong>{count}</strong>
    </li>
  );
}

function homeAggregationCount(
  result: CommerceHomeAggregation["result"],
): number | string {
  if (result === null || (result.kind !== "count" && result.kind !== "number"))
    return "Unavailable";
  return Number(result.value);
}

function homeAggregationLabel(name: CommerceHomeAggregation["name"]): string {
  switch (name) {
    case "home_open_customer_orders":
      return "Open customer orders";
    case "home_product_shortages":
      return "Product shortages";
    case "home_supply_shortages":
      return "Needs replenishment";
    case "home_payment_failures":
      return "Payment failures";
    case "home_delayed_shipments":
      return "Delayed shipments";
    default:
      return assertNever(name, "Unhandled Home value");
  }
}

/**
 * One quiet line of source freshness. It shows only when a source is late or
 * unavailable: a line of sources that are all current says nothing.
 */
function renderHomeSources(
  observations: readonly HomeSourceObservation[],
): React.ReactNode {
  if (observations.every(sourceObservationIsCurrent)) return null;
  return (
    <p className="home-sources" aria-label="Data freshness">
      {observations.map(renderSourceObservation)}
    </p>
  );
}

function renderHomeFreshness(
  content: Variant<PageContent<HomeSnapshot>, "ready">,
  active: boolean,
): React.ReactNode {
  if (content.updating) {
    return (
      <Notice tone="neutral" announcement="polite">
        Refreshing the daily brief…
      </Notice>
    );
  }
  switch (content.freshness.kind) {
    case "current":
      return null;
    case "delayed":
      /* A "data is delayed" warning is only meaningful once the workspace is
       * live; before activation there is no expectation of fresh data. */
      if (!active) return null;
      return (
        <Notice tone="warning" announcement="none">
          {content.freshness.explanation} Last observed{" "}
          {formatObservedAt(content.freshness.observedAt)}.
        </Notice>
      );
    default:
      return assertNever(content.freshness, "Unhandled Home value");
  }
}

function HomeAttention(props: {
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
  readonly items: readonly HomeAttentionItem[];
}): React.ReactNode {
  if (props.items.length === 0)
    return <p className="home-quiet">Nothing needs your attention.</p>;
  return (
    <section
      className="portal-band home-section"
      aria-labelledby="home-attention-title"
    >
      <h2 id="home-attention-title">Needs attention</h2>
      <div className="action-list">
        {props.items.map(
          renderAttentionItem.bind(
            null,
            props.organisationHandle,
            props.workspaceHandle,
          ),
        )}
      </div>
    </section>
  );
}

function renderAttentionItem(
  organisationHandle: string,
  workspaceHandle: string,
  item: HomeAttentionItem,
): React.ReactNode {
  return (
    <article
      className="action-row"
      key={`${item.kind}:${item.resource.kind}:${item.observedAt}`}
    >
      <div className="action-row-main">
        <div className="action-row-title">
          <h3>{item.title}</h3>
          <span className={`action-state action-state-${item.status}`}>
            {attentionStatusLabel(item.status)}
          </span>
        </div>
        <p>{item.reason}</p>
        {/* Assignment does not exist in the domain yet: HomeAttentionItem's
            assignee is a closed single-member union the parser enforces, so
            "Unassigned" was printed on every row and carried no information. */}
        <p>{item.resource.label}</p>
        <time dateTime={item.observedAt}>
          {formatObservedAt(item.observedAt)}
        </time>
      </div>
      <Link
        className="primary-button"
        to={homeDestinationPath(
          organisationHandle,
          workspaceHandle,
          item.nextAction.destination,
        )}
      >
        {item.nextAction.label}
      </Link>
    </article>
  );
}

function HomeBlockers(props: {
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
  readonly blockers: readonly HomeBlocker[];
}): React.ReactNode {
  return (
    <section
      className="portal-band home-section"
      aria-labelledby="home-blockers-title"
    >
      {/* Setup lives in the checklist band; what reaches this list is the
       * workspace being blocked operationally (activation in flight,
       * suspension, an unreachable source), so it is not named "setup". */}
      <h2 id="home-blockers-title">Workspace status</h2>
      <div className="action-list">
        {props.blockers.map(
          renderHomeBlocker.bind(
            null,
            props.organisationHandle,
            props.workspaceHandle,
          ),
        )}
      </div>
    </section>
  );
}

function renderHomeBlocker(
  organisationHandle: string,
  workspaceHandle: string,
  blocker: HomeBlocker,
): React.ReactNode {
  return (
    <article className="action-row" key={`${blocker.kind}:${blocker.title}`}>
      <div className="action-row-main">
        <h3>{blocker.title}</h3>
        <p>{blocker.reason}</p>
        <p>
          <strong>Impact:</strong> {blocker.consequence}
        </p>
      </div>
      <Link
        className="primary-button"
        to={homeDestinationPath(
          organisationHandle,
          workspaceHandle,
          blocker.nextAction.destination,
        )}
      >
        {blocker.nextAction.label}
      </Link>
    </article>
  );
}

function renderSourceObservation(
  observation: HomeSourceObservation,
): React.ReactNode {
  return (
    <span className="home-source" key={observation.kind}>
      <span
        className={`home-source-dot home-source-dot-${observation.status}`}
        aria-hidden="true"
      />
      <span>
        {sourceLabel(observation.kind)} ·{" "}
        {sourceStatusLabel(observation.status)}
        {observation.observedAt === null ? null : (
          <>
            {" "}
            ·{" "}
            <time dateTime={observation.observedAt}>
              {formatObservedAt(observation.observedAt)}
            </time>
          </>
        )}
      </span>
    </span>
  );
}

function homeDestinationPath(
  organisationHandle: string,
  workspaceHandle: string,
  destination: HomeDestination,
): string {
  switch (destination.kind) {
    case "home":
      return workspacePagePath(organisationHandle, workspaceHandle, "overview");
    case "commerce":
      return workspacePagePath(organisationHandle, workspaceHandle, "orders");
    case "orders":
      return workspacePagePath(organisationHandle, workspaceHandle, "orders");
    case "product":
      return workspaceResourcePath(
        organisationHandle,
        workspaceHandle,
        "product",
        destination.resourceId,
      );
    case "customer_order":
      return workspaceResourcePath(
        organisationHandle,
        workspaceHandle,
        "customer_order",
        destination.resourceId,
      );
    case "operations":
      return `${workspacePagePath(organisationHandle, workspaceHandle, "overview")}#operations-title`;
    case "integrations":
      return workspacePagePath(
        organisationHandle,
        workspaceHandle,
        "integrations",
      );
    case "settings":
      return workspacePagePath(organisationHandle, workspaceHandle, "settings");
    default:
      return assertNever(destination, "Unhandled Home value");
  }
}

function attentionStatusLabel(status: HomeAttentionItem["status"]): string {
  switch (status) {
    case "awaiting_review":
      return "Awaiting review";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
    case "uncertain":
      return "Outcome uncertain";
    default:
      return assertNever(status, "Unhandled Home value");
  }
}

function sourceLabel(kind: HomeSourceObservation["kind"]): string {
  switch (kind) {
    case "commerce":
      return "Commerce";
    case "governed_work":
      return "Approval workflow";
    case "workspace_readiness":
      return "Workspace readiness";
    default:
      return assertNever(kind, "Unhandled Home value");
  }
}

function sourceStatusLabel(status: HomeSourceObservation["status"]): string {
  switch (status) {
    case "current":
      return "Current";
    case "delayed":
      return "Delayed";
    case "unavailable":
      return "Unavailable";
    default:
      return assertNever(status, "Unhandled Home value");
  }
}

function formatObservedAt(value: string): string {
  return formatRelativeTime(new Date(value).getTime());
}

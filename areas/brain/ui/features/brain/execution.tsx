import React from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Hash,
  Mail,
  MessageCircle,
  MessageSquare,
  RefreshCw,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

import type {
  CaseExecutionCaseRef,
  CaseExecutionLimitation,
  CaseExecutionNode,
  CaseExecutionNodeDetail,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

import { formatAbsoluteTime } from "@purin-labs/ui/formatting";
import {
  EmptyState,
  Notice,
  PageSkeleton,
  RecoverableError,
  StatusChip,
} from "@purin-labs/ui/page-components";
import {
  executionErrorMessage,
  readCaseExecution,
  readCaseTimeline,
  readExecutionCases,
  readExecutionNode,
  type BrainTransport,
} from "@purin-labs/area-brain-contract/ui/features/brain/api";
import { ViewSwitch } from "@purin-labs/ui/time-lanes-frame";
import {
  SideDrawer,
  usePeriod,
  useWiderWhenEmpty,
  type PeriodControl,
} from "@purin-labs/ui/index";
import { CaseTimeline, type ActivityTimeline } from "./case-timeline";
import { ExecutionCanvas } from "./execution-canvas";
import {
  basisLabel,
  caseLabel,
  originLabel,
  contentRoleLabel,
  countWithheld,
  kindLabel,
  limitationSentence,
  linksInto,
  memorySentence,
  nodeFacts,
  nodeStatus,
  nodeTitle,
  placeExecution,
  titleNamesKind,
  type CaseExecution,
  type PlacedNode,
} from "@purin-labs/area-brain-contract/ui/features/brain/execution-model";

const CASE_VIEWS = [
  { view: "list", name: "List" },
  { view: "timeline", name: "Timeline" },
] as const;

const LAYOUT_VIEWS = [
  { view: "graph", name: "Graph" },
  { view: "list", name: "List" },
] as const;

type ActivityCases =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; cases: readonly CaseExecutionCaseRef[] }>;

type ActivityExecution =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "loading"; caseId: string }>
  | Readonly<{ kind: "failed"; caseId: string; message: string }>
  | Readonly<{
      kind: "ready";
      execution: CaseExecution;
      /** More pages of this Case are on their way. */
      reading: boolean;
    }>;

type ActivityDetail =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "loading"; nodeId: string }>
  | Readonly<{ kind: "failed"; nodeId: string; message: string }>
  | Readonly<{ kind: "withheld"; nodeId: string }>
  | Readonly<{ kind: "ready"; detail: CaseExecutionNodeDetail }>;

type ActivityLayout = "graph" | "list";

/** How the Cases show before one is open: a period on a timeline, or a list. */
type ActivityCaseView = "timeline" | "list";

type ActivityPanelViewProps = Readonly<{
  cases: ActivityCases;
  caseView: ActivityCaseView;
  timeline: ActivityTimeline;
  timelinePeriod: PeriodControl;
  onCaseView: (view: ActivityCaseView) => void;
  onReloadTimeline: () => void;
  execution: ActivityExecution;
  detail: ActivityDetail;
  layout: ActivityLayout;
  onReloadCases: () => void;
  onOpenCase: (caseId: string) => void;
  onCloseCase: () => void;
  onRefresh: () => void;
  onLayout: (layout: ActivityLayout) => void;
  onSelect: (node: CaseExecutionNode) => void;
  /** Closes the record beside the canvas. */
  onCloseDetail: () => void;
}>;

/**
 * What Pantry recorded while it worked on a Case.
 *
 * The view is read-only. It shows the records and the references between
 * them. It draws no link from time, and it says which links the records do
 * not hold. A record that this person may not see is shown withheld.
 */
export function ActivityPanel(props: {
  readonly organisationId: string;
  readonly transport: BrainTransport;
  /** The Case of the address, or null for the list of Cases. */
  readonly caseId: string | null;
  /** The record of the address that is selected in that Case. */
  readonly nodeId: string | null;
  /** Opens a Case, or one record of it, and puts it in the address. */
  readonly onOpen: (caseId: string | null, nodeId: string | null) => void;
}): React.ReactNode {
  const { organisationId, transport, caseId, nodeId, onOpen } = props;
  const [cases, setCases] = React.useState<ActivityCases>({ kind: "loading" });
  const [execution, setExecution] = React.useState<ActivityExecution>({
    kind: "none",
  });
  const [detail, setDetail] = React.useState<ActivityDetail>({ kind: "none" });
  const [layout, setLayout] = React.useState<ActivityLayout>(initialLayout);
  const [caseView, setCaseView] =
    React.useState<ActivityCaseView>(initialCaseView);
  const timelinePeriod = usePeriod();
  const { from: timelineFrom, to: timelineTo } = timelinePeriod.period;
  const [timeline, setTimeline] = React.useState<ActivityTimeline>({
    kind: "loading",
  });
  const request = React.useRef(0);
  const timelineRequest = React.useRef(0);
  const detailRequest = React.useRef(0);

  const loadCases = React.useCallback(async (): Promise<void> => {
    setCases({ kind: "loading" });
    try {
      setCases({
        kind: "ready",
        cases: await readExecutionCases(transport, organisationId),
      });
    } catch (error) {
      setCases({ kind: "failed", message: executionErrorMessage(error) });
    }
  }, [organisationId, transport]);

  const loadTimeline = React.useCallback(
    async (from: number, to: number): Promise<void> => {
      const current = ++timelineRequest.current;
      setTimeline({ kind: "loading" });
      try {
        const read = await readCaseTimeline(transport, organisationId, {
          from,
          to,
        });
        if (current === timelineRequest.current)
          setTimeline({ kind: "ready", timeline: read });
      } catch (error) {
        if (current === timelineRequest.current)
          setTimeline({
            kind: "failed",
            message: executionErrorMessage(error),
          });
      }
    },
    [organisationId, transport],
  );

  const open = React.useCallback(
    async (caseId: string): Promise<void> => {
      const current = (request.current += 1);
      setExecution({ kind: "loading", caseId });
      try {
        const read = await readCaseExecution(
          transport,
          organisationId,
          caseId,
          (partial) => {
            // A long Case is on screen while its later pages arrive.
            if (request.current === current)
              setExecution({
                kind: "ready",
                execution: partial,
                reading: true,
              });
          },
        );
        if (request.current === current)
          setExecution({ kind: "ready", execution: read, reading: false });
      } catch (error) {
        if (request.current === current)
          setExecution({
            kind: "failed",
            caseId,
            message: executionErrorMessage(error),
          });
      }
    },
    [organisationId, transport],
  );

  const select = React.useCallback(
    async (caseId: string, node: CaseExecutionNode): Promise<void> => {
      const current = (detailRequest.current += 1);
      if (node.access === "withheld") {
        setDetail({ kind: "withheld", nodeId: node.nodeId });
        return;
      }
      setDetail({ kind: "loading", nodeId: node.nodeId });
      try {
        const read = await readExecutionNode(
          transport,
          organisationId,
          caseId,
          node.nodeId,
        );
        if (detailRequest.current === current)
          setDetail({ kind: "ready", detail: read });
      } catch (error) {
        if (detailRequest.current === current)
          setDetail({
            kind: "failed",
            nodeId: node.nodeId,
            message: executionErrorMessage(error),
          });
      }
    },
    [organisationId, transport],
  );

  React.useEffect(() => {
    void loadCases();
  }, [loadCases]);

  // The timeline reads its period while it is the view of the Cases.
  React.useEffect(() => {
    if (caseId === null && caseView === "timeline")
      void loadTimeline(timelineFrom, timelineTo);
  }, [caseId, caseView, loadTimeline, timelineFrom, timelineTo]);
  useWiderWhenEmpty(
    timelinePeriod,
    timeline.kind === "ready" ? timeline.timeline : null,
    timeline.kind === "ready" && timeline.timeline.cases.length === 0,
  );

  // The address names the open Case. The list of Cases is its absence.
  React.useEffect(() => {
    if (caseId !== null) {
      void open(caseId);
      return;
    }
    request.current += 1;
    setExecution({ kind: "none" });
  }, [caseId, open]);

  // The address names the selected record. It is read when its Case is.
  const shown = execution.kind === "ready" ? execution.execution : null;
  React.useEffect(() => {
    const node =
      shown === null || nodeId === null
        ? null
        : (shown.nodes.find((entry) => entry.nodeId === nodeId) ?? null);
    if (shown === null || node === null) {
      detailRequest.current += 1;
      setDetail({ kind: "none" });
      return;
    }
    void select(shown.caseId, node);
  }, [nodeId, select, shown]);

  return (
    <ActivityPanelView
      cases={cases}
      caseView={caseView}
      timeline={timeline}
      timelinePeriod={timelinePeriod}
      onCaseView={setCaseView}
      onReloadTimeline={() => void loadTimeline(timelineFrom, timelineTo)}
      execution={execution}
      detail={detail}
      layout={layout}
      onReloadCases={() => void loadCases()}
      onOpenCase={(opened) => onOpen(opened, null)}
      onCloseCase={() => onOpen(null, null)}
      onRefresh={() => {
        if (caseId !== null) void open(caseId);
      }}
      onLayout={setLayout}
      onSelect={(node) => onOpen(caseId, node.nodeId)}
      onCloseDetail={() => onOpen(caseId, null)}
    />
  );
}

const NARROW_PAGE = "(max-width: 760px)";

function isNarrowPage(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(NARROW_PAGE).matches
  );
}

/** A narrow screen starts with the list of Cases; a wide one with the timeline. */
function initialCaseView(): ActivityCaseView {
  return isNarrowPage() ? "list" : "timeline";
}

/** A narrow screen starts with the list, which needs no sideways scroll. */
function initialLayout(): ActivityLayout {
  return isNarrowPage() ? "list" : "graph";
}

/** The panel without its data lifecycle, for previews and tests. */
function ActivityPanelView(props: ActivityPanelViewProps): React.ReactNode {
  return (
    <section className="brain-activity" aria-labelledby="brain-activity">
      {/* The tab names the view, so the heading is for a screen reader. */}
      <h2 className="visually-hidden" id="brain-activity" tabIndex={-1}>
        Activity
      </h2>
      {props.execution.kind === "none" ? (
        <>
          <ViewSwitch
            className="case-timeline-switch"
            label="Show the Cases as"
            value={props.caseView}
            views={CASE_VIEWS}
            onChange={props.onCaseView}
          />
          {props.caseView === "timeline" ? (
            <CaseTimeline
              timeline={props.timeline}
              control={props.timelinePeriod}
              now={Date.now()}
              onReload={props.onReloadTimeline}
              onOpenCase={props.onOpenCase}
            />
          ) : (
            <CaseList {...props} />
          )}
        </>
      ) : (
        <OpenCase {...props} execution={props.execution} />
      )}
    </section>
  );
}

function CaseList(props: ActivityPanelViewProps): React.ReactNode {
  if (props.cases.kind === "loading")
    return <PageSkeleton label="Loading the Cases you can open" />;
  if (props.cases.kind === "failed")
    return (
      <RecoverableError
        message={props.cases.message}
        action={
          <button
            className="secondary"
            type="button"
            onClick={props.onReloadCases}
          >
            Try again
          </button>
        }
      />
    );
  const { cases } = props.cases;
  return (
    <div className="brain-activity-list">
      {cases.length === 0 ? (
        <EmptyState
          title="No Cases to show"
          detail="A chat you can open, and work that arrived in a Project you belong to, appear here."
        />
      ) : (
        groupCasesByDay(cases, Date.now()).map((group) => (
          <section className="brain-case-group" key={group.key}>
            <h3 className="brain-case-day">{group.label}</h3>
            <ol className="brain-cases">
              {group.entries.map((entry) => (
                <li key={entry.caseId}>
                  <CaseRow entry={entry} onOpen={props.onOpenCase} />
                </li>
              ))}
            </ol>
          </section>
        ))
      )}
    </div>
  );
}

function CaseRow(props: {
  readonly entry: CaseExecutionCaseRef;
  readonly onOpen: (caseId: string) => void;
}): React.ReactNode {
  const { entry } = props;
  const Icon = originIcon(entry.origin);
  return (
    <button
      type="button"
      className="brain-case"
      aria-label={`${caseLabel(entry)}, ${formatAbsoluteTime(entry.filedAt)}`}
      onClick={props.onOpen.bind(null, entry.caseId)}
    >
      <Icon className="brain-case-icon" size={16} aria-hidden="true" />
      <span className="brain-case-main">
        <span className="brain-case-title">{originLabel(entry.origin)}</span>
        {/* The end of the identity tells two Cases of one origin apart. */}
        <code className="brain-case-id" title={entry.caseId}>
          …{entry.caseId.slice(-8)}
        </code>
      </span>
      <time
        className="brain-case-time"
        dateTime={new Date(entry.filedAt).toISOString()}
      >
        {new Date(entry.filedAt).toLocaleTimeString(undefined, {
          timeStyle: "short",
        })}
      </time>
      <ChevronRight
        className="brain-case-chevron"
        size={16}
        aria-hidden="true"
      />
    </button>
  );
}

function originIcon(origin: string): LucideIcon {
  switch (origin) {
    case "portal_chat":
      return MessageSquare;
    case "slack":
      return Hash;
    case "email":
      return Mail;
    case "whatsapp":
      return MessageCircle;
    case "direct":
      return Zap;
    default:
      return CircleDot;
  }
}

type CaseDayGroup = Readonly<{
  key: string;
  label: string;
  entries: readonly CaseExecutionCaseRef[];
}>;

/** The Cases in the order given, grouped by the local day they were filed. */
function groupCasesByDay(
  cases: readonly CaseExecutionCaseRef[],
  now: number,
): readonly CaseDayGroup[] {
  const groups: {
    key: string;
    label: string;
    entries: CaseExecutionCaseRef[];
  }[] = [];
  for (const entry of cases) {
    const day = new Date(entry.filedAt);
    const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key) last.entries.push(entry);
    else groups.push({ key, label: dayLabel(day, now), entries: [entry] });
  }
  return groups;
}

function dayLabel(day: Date, now: number): string {
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (same(day, today)) return "Today";
  if (same(day, yesterday)) return "Yesterday";
  return day.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

function OpenCase(
  props: ActivityPanelViewProps & {
    readonly execution: Exclude<ActivityExecution, { kind: "none" }>;
  },
): React.ReactNode {
  const { execution } = props;
  const caseId =
    execution.kind === "ready" ? execution.execution.caseId : execution.caseId;
  const label =
    props.cases.kind === "ready"
      ? props.cases.cases.find((entry) => entry.caseId === caseId)
      : undefined;
  return (
    <div className="brain-execution">
      <header className="brain-execution-head">
        <div className="brain-execution-path">
          <button
            type="button"
            className="brain-link-button brain-execution-step"
            onClick={props.onCloseCase}
          >
            <ChevronLeft size={14} aria-hidden="true" />
            Activity
          </button>
          <h3 className="brain-execution-title">
            {label === undefined ? "One Case" : caseLabel(label)}
          </h3>
          <code className="brain-case-id">{caseId}</code>
        </div>
        <div className="brain-execution-actions">
          {/* A Case that could not be read has one control to try again. */}
          {execution.kind === "failed" ? null : (
            <button
              type="button"
              className="brain-canvas-tool"
              onClick={props.onRefresh}
              disabled={
                execution.kind === "loading" ||
                (execution.kind === "ready" && execution.reading)
              }
            >
              <RefreshCw size={14} strokeWidth={1.6} aria-hidden="true" />
              Read again
            </button>
          )}
          <button
            type="button"
            className="brain-canvas-tool"
            aria-label="All Cases"
            onClick={props.onCloseCase}
          >
            <X size={16} strokeWidth={1.6} aria-hidden="true" />
          </button>
        </div>
      </header>
      {execution.kind === "loading" ? (
        <PageSkeleton label="Reading the Case's records" />
      ) : execution.kind === "failed" ? (
        <RecoverableError
          message={execution.message}
          action={
            <button
              className="secondary"
              type="button"
              onClick={props.onRefresh}
            >
              Try again
            </button>
          }
        />
      ) : (
        <ReadyCase
          {...props}
          read={execution.execution}
          reading={execution.reading}
        />
      )}
    </div>
  );
}

/** Whether the page is as narrow as a phone. The list replaces the canvas then. */
function useNarrowPage(): boolean {
  const [narrow, setNarrow] = React.useState(isNarrowPage);
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW_PAGE);
    const follow = (): void => setNarrow(query.matches);
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);
  return narrow;
}

function ReadyCase(
  props: ActivityPanelViewProps & {
    readonly read: CaseExecution;
    readonly reading: boolean;
  },
): React.ReactNode {
  const { read } = props;
  const placed = React.useMemo(() => placeExecution(read), [read]);
  const narrow = useNarrowPage();
  const withheld = countWithheld(read);
  const readFailures = read.limitations.filter(isReadFailure);
  const selectedId =
    props.detail.kind === "none"
      ? null
      : props.detail.kind === "ready"
        ? props.detail.detail.node.nodeId
        : props.detail.nodeId;
  if (read.nodes.length === 0)
    return (
      <EmptyState
        title="Nothing recorded yet"
        detail="This Case holds no assignment, proposal or delivery."
      />
    );
  // A phone has no room for the canvas. The list holds the same records.
  const shownLayout = narrow ? "list" : props.layout;
  return (
    <>
      <div className="brain-execution-summary">
        <p className="brain-muted" role="status">
          {String(read.nodes.length)} records, {String(read.edges.length)}{" "}
          recorded links
          {props.reading ? " so far. More records are on their way." : "."}
          {withheld === 0
            ? ""
            : ` ${String(withheld)} are withheld: you may know that they exist, and you may not see what they hold.`}
        </p>
        {narrow ? null : (
          <ViewSwitch
            label="Layout"
            value={props.layout}
            views={LAYOUT_VIEWS}
            onChange={props.onLayout}
          />
        )}
      </div>
      {shownLayout === "graph" ? (
        <ExecutionCanvas
          execution={read}
          selectedId={selectedId}
          onSelect={props.onSelect}
        />
      ) : (
        <ExecutionList {...props} placed={placed} selectedId={selectedId} />
      )}
      <NodeDetail {...props} selectedId={selectedId} />
      {readFailures.length === 0 ? null : (
        <Notice tone="warning" announcement="polite">
          {readFailures.map(limitationSentence).join(" ")}
        </Notice>
      )}
    </>
  );
}

/**
 * Whether a part of the Case could not be read. The other limitations are
 * fixed gaps in what the records hold, and the view does not show them.
 */
function isReadFailure(limitation: CaseExecutionLimitation): boolean {
  switch (limitation) {
    case "session_unavailable":
    case "effect_unavailable":
    case "truncated":
    case "record_invalid":
      return true;
    case "tool_attempt_unrecorded":
    case "effect_attempts_unrecorded":
    case "delivery_attempts_unrecorded":
    case "mail_proposal_origin_unrecorded":
    case "proposal_tool_call_unrecorded":
      return false;
    default:
      return assertNever(limitation);
  }
}

function ExecutionList(
  props: ActivityPanelViewProps & {
    readonly placed: readonly PlacedNode[];
    readonly selectedId: string | null;
  },
): React.ReactNode {
  return (
    <ol className="brain-execution-list" aria-label="Execution records">
      {props.placed.map((entry) => (
        <li
          key={entry.node.nodeId}
          style={{
            paddingInlineStart: `${String(Math.min(entry.layer, 6) * 12)}px`,
          }}
        >
          <NodeButton
            {...props}
            node={entry.node}
            className="brain-list-node"
          />
        </li>
      ))}
    </ol>
  );
}

function NodeButton(
  props: ActivityPanelViewProps & {
    readonly node: CaseExecutionNode;
    readonly selectedId: string | null;
    readonly className: string;
    readonly style?: React.CSSProperties;
  },
): React.ReactNode {
  const { node } = props;
  return (
    <button
      type="button"
      className={`brain-node ${props.className}${node.access === "withheld" ? " brain-node-withheld" : ""}`}
      style={props.style}
      aria-pressed={props.selectedId === node.nodeId}
      onClick={props.onSelect.bind(null, node)}
    >
      {titleNamesKind(node) ? null : (
        <span className="brain-node-kind">{kindLabel(node.kind)}</span>
      )}
      <span className="brain-node-title">{nodeTitle(node)}</span>
      <StatusChip status={nodeStatus(node)} />
    </button>
  );
}

/**
 * The selected record in a side drawer, so the graph keeps its width. A link
 * into the record selects the record that it comes from, in the same drawer.
 */
function NodeDetail(
  props: ActivityPanelViewProps & {
    readonly read: CaseExecution;
    readonly selectedId: string | null;
  },
): React.ReactNode {
  const { detail, read } = props;
  const node =
    props.selectedId === null
      ? undefined
      : read.nodes.find((entry) => entry.nodeId === props.selectedId);
  return (
    <SideDrawer
      open={node !== undefined}
      title={node === undefined ? "" : nodeTitle(node)}
      close={props.onCloseDetail}
    >
      {node === undefined ? null : (
        <div className="side-drawer-body brain-case-record">
          <StatusChip status={nodeStatus(node)} />
          {node.access === "withheld" ? (
            <Notice tone="neutral" announcement="polite">
              You may not see this record. Its content belongs to a source that
              you cannot read here. Its kind and its recorded links are shown.
            </Notice>
          ) : (
            <dl className="brain-case-record-facts">
              {nodeFacts(node).map((fact) => (
                <div key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>
                    {fact.time === undefined ? (
                      <code>{fact.value}</code>
                    ) : (
                      formatAbsoluteTime(fact.time)
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {node.access === "open" && node.kind === "turn" ? (
            <p>{memorySentence(node.memory)}</p>
          ) : null}
          <RecordLinks {...props} node={node} />
          {detail.kind === "loading" ? (
            <p className="brain-muted" role="status">
              Reading the content.
            </p>
          ) : detail.kind === "failed" ? (
            <Notice tone="warning" announcement="polite">
              {detail.message}
            </Notice>
          ) : detail.kind === "ready" ? (
            <NodeContent detail={detail.detail} />
          ) : null}
        </div>
      )}
    </SideDrawer>
  );
}

function RecordLinks(
  props: ActivityPanelViewProps & {
    readonly read: CaseExecution;
    readonly node: CaseExecutionNode;
  },
): React.ReactNode {
  const links = linksInto(props.read, props.node.nodeId);
  return (
    <section>
      <h3>Links into this record</h3>
      {links.length === 0 ? (
        <p className="brain-muted">
          None. No record names what this one came from.
        </p>
      ) : (
        <ul className="brain-case-record-links">
          {links.map((link) => (
            <li key={`${link.from.nodeId}:${link.basis}`}>
              <button
                type="button"
                className="brain-link-button"
                onClick={props.onSelect.bind(null, link.from)}
              >
                {nodeTitle(link.from)}
              </button>{" "}
              <span className="brain-muted">
                (this record {basisLabel(link.basis)})
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NodeContent(props: {
  readonly detail: CaseExecutionNodeDetail;
}): React.ReactNode {
  const { content } = props.detail;
  return (
    <>
      {content.map((part, index) => (
        <section key={`${part.role}:${String(index)}`}>
          <h3>{contentRoleLabel(part.role)}</h3>
          <pre className="brain-case-record-content">{part.text}</pre>
          {part.truncated ? (
            <p className="brain-muted">The stored text is longer than this.</p>
          ) : null}
        </section>
      ))}
    </>
  );
}

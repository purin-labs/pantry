import React from "react";
import { ChevronRight, Search } from "lucide-react";

import type { EvalView, MemoryView } from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

import type {
  AgentDefinition,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
import type { Skill } from "@purin-labs/control-api";
import { isPrimaryNavigationClick } from "@purin-labs/ui/page-address";
import { formatAbsoluteTime, formatRelativeTime } from "@purin-labs/ui/formatting";
import { EmptyState, StatusChip } from "@purin-labs/ui/page-components";
import type { KnowledgeState } from "@purin-labs/area-brain-contract/ui/features/brain/address";
import {
  agentRow,
  evalRow,
  filterRows,
  KNOWLEDGE_KINDS,
  knowledgeKindLabel,
  memoryRow,
  playbookRow,
  rowsForReview,
  stateFilterLabel,
  type KnowledgeKind,
  type KnowledgeRow,
} from "./knowledge-model";
import {
  acceptedRevision,
  applicabilityLabel,
  authorLabel,
  effectiveLabel,
  evidenceLabel,
  kindLabel,
  lastChangedAt,
  leadRevision,
  memoryStatuses,
  openCandidate,
  revisionStateLabel,
} from "./model";
import { RecordClose } from "./record-close";
import { isNewRecord, type SeenRecords } from "./seen";

/** An edit a reviewer is writing. Saving it makes a new version to review. */
export type MemoryDraft = Readonly<{
  memoryId: string;
  statement: string;
  timezone: string;
  effectiveFrom: string;
  effectiveUntil: string;
}>;

export type MemoryDecisionKind = "accept" | "reject" | "revoke";

/** What a reviewer does with one Memory, and what the page holds meanwhile. */
export type MemoryReviewProps = Readonly<{
  canManage: boolean;
  busyMemoryId: string | null;
  draft: MemoryDraft | null;
  confirmingRevoke: string | null;
  onDecide: (memory: MemoryView, decision: MemoryDecisionKind) => void;
  onEdit: (memory: MemoryView) => void;
  onDraftChange: (draft: MemoryDraft) => void;
  onDraftCancel: () => void;
  onDraftSubmit: (memory: MemoryView) => void;
  onConfirmRevoke: (memoryId: string | null) => void;
}>;

/** Where a row of the Knowledge list leads, and what a click on it does. */
export type KnowledgeLinks = Readonly<{
  memoryHref: (memoryId: string | null) => string;
  onSelectMemory: (memoryId: string | null) => void;
  evalHref: (evalId: string) => string;
  onOpenEval: (evalId: string) => void;
  /** The page that owns agents, or null when none is known. */
  agentsHref: string | null;
  onOpenAgents: () => void;
  /** The Skills view, where a playbook is read and edited. */
  skillsHref: string;
  onOpenSkills: () => void;
}>;

type KnowledgeViewProps = MemoryReviewProps &
  KnowledgeLinks &
  Readonly<{
    memories: readonly MemoryView[];
    /** The Evals this person may read, or null when they were not read. */
    evals: readonly EvalView[] | null;
    playbooks: readonly Skill[];
    agents: readonly AgentDefinition[];
    /** The Memory of the address. It can name one this person cannot read. */
    selectedMemoryId: string | null;
    /** The state that the list is limited to, or null for all. */
    state: KnowledgeState | null;
    stateHref: (state: KnowledgeState | null) => string;
    onState: (state: KnowledgeState | null) => void;
    seen: SeenRecords;
    onSeen: (key: string, changedAt: number | null) => void;
    caseHref: (caseId: string) => string;
    onOpenCase: (caseId: string) => void;
    /** The chat in which a person teaches a fact, or null when none is known. */
    teach: TeachLink | null;
  }>;

/** The Portal chat, where a person tells the agent a rule to remember. */
export type TeachLink = Readonly<{
  chatHref: string;
  onOpenChat: () => void;
}>;

export const MEMORY_DETAIL_TITLE_ID = "brain-memory-detail-title";
const TEACH_PANEL_ID = "brain-teach";

/**
 * How a person teaches the agent: in the chat, in their own words. The agent
 * proposes the memory, and it waits in this view for a review.
 */
function TeachPanel(props: { readonly teach: TeachLink }): React.ReactNode {
  return (
    <section
      className="brain-teach"
      id={TEACH_PANEL_ID}
      aria-labelledby={`${TEACH_PANEL_ID}-title`}
    >
      <h3 className="brain-teach-title" id={`${TEACH_PANEL_ID}-title`}>
        Teach a fact in the chat
      </h3>
      <p>
        Tell the agent a rule, a fact or a preference in your own words. For
        example: “Remember: the shop closes at 18:00 on Sundays.”
      </p>
      <p className="brain-muted">
        The agent proposes it as a memory. It waits here for your review, and
        the agent uses it only after someone accepts it. It applies to Portal
        chats whose readers may read your message. Email replies do not use it.
      </p>
      <div className="proposal-decision">
        <a
          className="brain-link"
          href={props.teach.chatHref}
          onClick={(event) => {
            if (!isPrimaryNavigationClick(event)) return;
            event.preventDefault();
            props.teach.onOpenChat();
          }}
        >
          Open the chat
        </a>
      </div>
    </section>
  );
}

/** The name under which the "New" mark remembers one record. */
function knowledgeRowKey(
  row: Pick<KnowledgeRow, "kind" | "id">,
): string {
  return `${row.kind}:${row.id}`;
}

export function knowledgeRowId(row: Pick<KnowledgeRow, "kind" | "id">): string {
  return `brain-row-${row.kind}-${row.id}`;
}

function kindHeadingId(kind: KnowledgeKind): string {
  return `brain-kind-${kind}`;
}

function kindEmptyLine(kind: KnowledgeKind, filtered: boolean): string {
  if (filtered) return "Nothing here matches.";
  switch (kind) {
    case "memory":
      return "No memories yet.";
    case "evals":
      return "No evals yet.";
    case "playbooks":
      return "No skills to show.";
    case "agents":
      return "No agents to show.";
    default:
      return assertNever(kind, "Unexpected value");
  }
}

function recordCount(count: number): string {
  return count === 1 ? "1 record" : `${count} records`;
}

const STATE_FILTERS: readonly (KnowledgeState | null)[] = [
  null,
  "review",
  "in_use",
  "not_in_use",
];

/** The rows of every kind, each kind in the order of its review. */
function knowledgeRows(
  props: Pick<
    KnowledgeViewProps,
    "memories" | "evals" | "playbooks" | "agents"
  >,
): Readonly<Record<KnowledgeKind, readonly KnowledgeRow[]>> {
  const present = (row: KnowledgeRow | null): row is KnowledgeRow =>
    row !== null;
  return {
    memory: rowsForReview(props.memories.map(memoryRow).filter(present)),
    evals: rowsForReview((props.evals ?? []).map(evalRow).filter(present)),
    playbooks: props.playbooks.map(playbookRow),
    agents: props.agents.map(agentRow),
  };
}

/** Brings one kind of the lists to the top and puts the keyboard on it. */
function goToKind(kind: KnowledgeKind): void {
  const heading = document.getElementById(kindHeadingId(kind));
  if (heading === null) return;
  heading.scrollIntoView({
    block: "start",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
  });
  heading.focus({ preventScroll: true });
}

/**
 * What the agents know. A row of the kinds with their counts, and each kind
 * as a list of rows. A row opens its record in place of the lists.
 */
export function KnowledgeView(props: KnowledgeViewProps): React.ReactNode {
  const [search, setSearch] = React.useState("");
  const [teaching, setTeaching] = React.useState(false);
  // Only a person who may decide a memory can teach one in the chat.
  const teach = props.canManage ? props.teach : null;
  const all = knowledgeRows(props);
  const filtered = props.state !== null || search.trim().length > 0;
  const shown: Record<KnowledgeKind, readonly KnowledgeRow[]> = {
    memory: filterRows(all.memory, props.state, search),
    evals: filterRows(all.evals, props.state, search),
    playbooks: filterRows(all.playbooks, props.state, search),
    agents: filterRows(all.agents, props.state, search),
  };
  const recordOpen = props.selectedMemoryId !== null;
  const selected =
    props.selectedMemoryId === null
      ? null
      : (props.memories.find(
          (memory) => memory.memoryId === props.selectedMemoryId,
        ) ?? null);

  // The record on screen is no longer new to this browser.
  const { onSeen } = props;
  const selectedChangedAt = selected === null ? null : lastChangedAt(selected);
  React.useEffect(() => {
    if (props.selectedMemoryId !== null && selectedChangedAt !== null)
      onSeen(
        knowledgeRowKey({ kind: "memory", id: props.selectedMemoryId }),
        selectedChangedAt,
      );
  }, [onSeen, props.selectedMemoryId, selectedChangedAt]);

  // A kind link leads to a kind of the lists. When a record is open, the
  // lists come back first, and the page then goes to the kind.
  const goNext = React.useRef<KnowledgeKind | null>(null);
  React.useLayoutEffect(() => {
    if (goNext.current === null || recordOpen) return;
    goToKind(goNext.current);
    goNext.current = null;
  });

  return (
    <section className="brain-knowledge" aria-labelledby="brain-knowledge">
      <h2 className="visually-hidden" id="brain-knowledge">
        Knowledge
      </h2>
      <div className="brain-workbench">
        <nav className="brain-rail" aria-label="Kinds of knowledge">
          {KNOWLEDGE_KINDS.map((kind) => {
            const label = knowledgeKindLabel(kind);
            return (
              <a
                key={kind}
                className="brain-rail-item"
                href={`#${kindHeadingId(kind)}`}
                aria-label={`${label}, ${recordCount(shown[kind].length)}`}
                onClick={(event) => {
                  if (!isPrimaryNavigationClick(event)) return;
                  event.preventDefault();
                  if (!recordOpen) return goToKind(kind);
                  goNext.current = kind;
                  props.onSelectMemory(null);
                }}
              >
                <span className="brain-rail-label">{label}</span>
                <span className="brain-rail-count" aria-hidden="true">
                  {shown[kind].length}
                </span>
              </a>
            );
          })}
        </nav>
        <div className="brain-workbench-main">
          {recordOpen ? (
            <section className="brain-record" aria-label="Memory details">
              <RecordClose
                href={props.memoryHref(null)}
                label="Close this memory"
                onClose={() => props.onSelectMemory(null)}
              />
              {selected === null ? (
                <p
                  className="brain-muted"
                  id={MEMORY_DETAIL_TITLE_ID}
                  tabIndex={-1}
                >
                  This memory is not available to you.
                </p>
              ) : (
                <MemoryDetail {...props} memory={selected} />
              )}
            </section>
          ) : (
            <>
              <div className="brain-knowledge-tools">
                <label className="brain-search">
                  <span className="visually-hidden">Search knowledge</span>
                  <Search size={16} strokeWidth={1.6} aria-hidden="true" />
                  <input
                    type="search"
                    placeholder="Search knowledge"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <div className="brain-filter" role="group" aria-label="Show">
                  {STATE_FILTERS.map((state) => (
                    <a
                      key={state ?? "all"}
                      className="brain-filter-item"
                      href={props.stateHref(state)}
                      aria-current={props.state === state ? "true" : undefined}
                      onClick={(event) => {
                        if (!isPrimaryNavigationClick(event)) return;
                        event.preventDefault();
                        props.onState(state);
                      }}
                    >
                      {stateFilterLabel(state)}
                    </a>
                  ))}
                </div>
                {teach === null ? null : (
                  <button
                    type="button"
                    className="secondary brain-teach-toggle"
                    aria-expanded={teaching}
                    aria-controls={TEACH_PANEL_ID}
                    onClick={() => setTeaching((open) => !open)}
                  >
                    Teach a fact
                  </button>
                )}
              </div>
              {teach !== null && teaching ? <TeachPanel teach={teach} /> : null}
              {KNOWLEDGE_KINDS.map((kind) => {
                const rows = shown[kind];
                const firstUse =
                  kind === "memory" && !filtered && all.memory.length === 0;
                return (
                  <section
                    key={kind}
                    className="brain-kind"
                    id={`${kindHeadingId(kind)}-list`}
                    aria-labelledby={kindHeadingId(kind)}
                  >
                    {/* The row of kinds above the lists holds the count. */}
                    <h3
                      className="brain-kind-heading"
                      id={kindHeadingId(kind)}
                      tabIndex={-1}
                    >
                      {knowledgeKindLabel(kind)}
                    </h3>
                    {firstUse ? (
                      <EmptyState
                        title="No memories yet"
                        detail="When you correct an email reply, the agent may propose a fact to remember. It appears here for review."
                      />
                    ) : rows.length === 0 ? (
                      <p className="brain-kind-empty">
                        {kindEmptyLine(kind, filtered)}
                      </p>
                    ) : (
                      <KnowledgeRows
                        label={knowledgeKindLabel(kind)}
                        rows={rows}
                        seen={props.seen}
                        showKind={false}
                        links={props}
                        onSeen={props.onSeen}
                      />
                    )}
                  </section>
                );
              })}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Records as rows: the title with its marks, one line with the scope and the
 * time of the last change, and an arrow when the row opens something.
 */
export function KnowledgeRows(props: {
  readonly label: string;
  readonly rows: readonly KnowledgeRow[];
  readonly seen: SeenRecords;
  /** A list of several kinds names the kind of each row. */
  readonly showKind: boolean;
  /** A status that the heading of the list already says: its chip is left out. */
  readonly impliedStatus?: string;
  readonly links: KnowledgeLinks;
  readonly onSeen: (key: string, changedAt: number | null) => void;
}): React.ReactNode {
  return (
    <ul className="brain-rows" aria-label={props.label}>
      {props.rows.map((row) => (
        <li key={knowledgeRowKey(row)}>
          <KnowledgeRowLink {...props} row={row} />
        </li>
      ))}
    </ul>
  );
}

function rowHref(row: KnowledgeRow, links: KnowledgeLinks): string | null {
  switch (row.kind) {
    case "memory":
      return links.memoryHref(row.id);
    case "evals":
      return links.evalHref(row.id);
    case "playbooks":
      return links.skillsHref;
    case "agents":
      return links.agentsHref;
    default:
      return assertNever(row.kind, "Unexpected value");
  }
}

function openRow(row: KnowledgeRow, links: KnowledgeLinks): void {
  switch (row.kind) {
    case "memory":
      return links.onSelectMemory(row.id);
    case "evals":
      return links.onOpenEval(row.id);
    case "playbooks":
      return links.onOpenSkills();
    case "agents":
      return links.onOpenAgents();
    default:
      return assertNever(row.kind, "Unexpected value");
  }
}

function KnowledgeRowLink(props: {
  readonly row: KnowledgeRow;
  readonly seen: SeenRecords;
  readonly showKind: boolean;
  readonly impliedStatus?: string;
  readonly links: KnowledgeLinks;
  readonly onSeen: (key: string, changedAt: number | null) => void;
}): React.ReactNode {
  const { row } = props;
  const href = rowHref(row, props.links);
  const content = (
    <>
      <span className="brain-row-main">
        <span className="brain-row-head">
          <span className="brain-row-title">{row.title}</span>
          {isNewRecord(props.seen, knowledgeRowKey(row), row.changedAt) ? (
            <span className="brain-row-new">New</span>
          ) : null}
          {row.statuses.map((status) =>
            status.label === props.impliedStatus ? null : (
              <StatusChip key={status.label} status={status} />
            ),
          )}
        </span>
        <span className="brain-row-meta">
          {props.showKind ? `${knowledgeKindLabel(row.kind)} · ` : null}
          {row.scope}
          {row.changedAt === null ? null : (
            <>
              {" · "}
              <time
                dateTime={new Date(row.changedAt).toISOString()}
                title={formatAbsoluteTime(row.changedAt)}
              >
                {formatRelativeTime(row.changedAt)}
              </time>
            </>
          )}
        </span>
      </span>
      {href === null ? null : (
        <ChevronRight
          className="brain-row-chevron"
          size={18}
          strokeWidth={1.6}
          aria-hidden="true"
        />
      )}
    </>
  );
  if (href === null)
    return (
      <div className="brain-row" id={knowledgeRowId(row)}>
        {content}
      </div>
    );
  return (
    <a
      className="brain-row"
      id={knowledgeRowId(row)}
      href={href}
      onClick={(event) => {
        if (!isPrimaryNavigationClick(event)) return;
        event.preventDefault();
        // An Eval opens on its own view, so its row is seen here.
        if (row.kind === "evals")
          props.onSeen(knowledgeRowKey(row), row.changedAt);
        openRow(row, props.links);
      }}
    >
      {content}
    </a>
  );
}

function MemoryDetail(
  props: MemoryReviewProps &
    Pick<KnowledgeViewProps, "caseHref" | "onOpenCase"> & {
      readonly memory: MemoryView;
    },
): React.ReactNode {
  const { memory } = props;
  const lead = leadRevision(memory);
  if (lead === null) return null;
  const accepted = acceptedRevision(memory);
  const candidate = openCandidate(memory);
  const earlier = memory.revisions.filter(
    (revision) =>
      revision.revision !== accepted?.revision &&
      revision.revision !== candidate?.revision,
  );
  const draft = props.draft?.memoryId === memory.memoryId ? props.draft : null;
  return (
    <div className="brain-memory">
      <header className="brain-memory-head">
        <div className="brain-memory-chips">
          {memoryStatuses(memory).map((status) => (
            <StatusChip key={status.label} status={status} />
          ))}
        </div>
        <h3
          className="brain-memory-statement"
          id={MEMORY_DETAIL_TITLE_ID}
          tabIndex={-1}
        >
          {lead.statement}
        </h3>
      </header>
      <dl className="commerce-facts">
        <div>
          <dt>Kind</dt>
          <dd>{kindLabel(lead.memoryKind)}</dd>
        </div>
        <div>
          <dt>Applies to</dt>
          <dd>{applicabilityLabel(lead.applicability)}</dd>
        </div>
        <div>
          <dt>In effect</dt>
          <dd>{effectiveLabel(lead.validity)}</dd>
        </div>
        <div>
          <dt>Proposed by</dt>
          <dd>{authorLabel(lead)}</dd>
        </div>
        <div>
          <dt>Based on</dt>
          <dd>
            {lead.evidence.map(evidenceLabel).join(". ")}
            <a
              className="brain-link brain-memory-source"
              href={props.caseHref(lead.sourceCaseId)}
              onClick={(event) => {
                if (!isPrimaryNavigationClick(event)) return;
                event.preventDefault();
                props.onOpenCase(lead.sourceCaseId);
              }}
            >
              Open the Case
            </a>
          </dd>
        </div>
      </dl>
      {lead.applicability.kind === "portal_chat" ? (
        <p className="brain-muted">
          The agent uses this memory in a Portal chat only when each reader of
          that chat may read the message that it came from. Email replies do not
          use it.
        </p>
      ) : null}
      {accepted !== null && candidate !== null ? (
        <section className="brain-replacement">
          <h4>Proposed replacement</h4>
          <p className="brain-memory-statement">{candidate.statement}</p>
          <p className="brain-muted">
            {effectiveLabel(candidate.validity)}. Proposed by{" "}
            {authorLabel(candidate).toLowerCase()}.
          </p>
        </section>
      ) : null}
      {draft === null ? (
        <MemoryActions {...props} />
      ) : (
        <MemoryForm {...props} draft={draft} />
      )}
      {/* The header states the version in use and any proposed replacement.
        Only versions before them are history, so a new memory shows none. */}
      {earlier.length > 0 ? (
        <details className="brain-memory-history">
          <summary>
            {earlier.length}{" "}
            {earlier.length === 1 ? "earlier version" : "earlier versions"}
          </summary>
          <ol className="brain-history">
            {earlier.map((revision) => (
              <li key={revision.revision}>
                <span className="brain-history-meta">
                  Version {revision.revision} · {revisionStateLabel(revision)} ·{" "}
                  {authorLabel(revision)},{" "}
                  {formatAbsoluteTime(revision.proposedAt)}
                </span>
                <span className="brain-history-statement">
                  {revision.statement}
                </span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

function MemoryActions(
  props: MemoryReviewProps & { readonly memory: MemoryView },
): React.ReactNode {
  const { memory } = props;
  const candidate = openCandidate(memory);
  const accepted = acceptedRevision(memory);
  if (candidate === null && accepted === null) return null;
  if (!props.canManage)
    return candidate === null ? null : (
      <p role="status" className="brain-muted">
        Waiting for an owner or admin to decide.
      </p>
    );
  const busy = props.busyMemoryId !== null;
  if (candidate !== null)
    return (
      <div className="proposal-decision">
        <button
          type="button"
          className="connection-primary-action"
          disabled={busy}
          onClick={props.onDecide.bind(null, memory, "accept")}
        >
          {accepted === null ? "Accept" : "Accept replacement"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={props.onEdit.bind(null, memory)}
        >
          Edit first
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={props.onDecide.bind(null, memory, "reject")}
        >
          Decline
        </button>
      </div>
    );
  return props.confirmingRevoke === memory.memoryId ? (
    <div className="proposal-decision">
      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={props.onDecide.bind(null, memory, "revoke")}
      >
        Revoke this memory
      </button>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={props.onConfirmRevoke.bind(null, null)}
      >
        Keep it
      </button>
    </div>
  ) : (
    <div className="proposal-decision">
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={props.onEdit.bind(null, memory)}
      >
        Propose a replacement
      </button>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={props.onConfirmRevoke.bind(null, memory.memoryId)}
      >
        Revoke
      </button>
    </div>
  );
}

function MemoryForm(
  props: MemoryReviewProps & {
    readonly memory: MemoryView;
    readonly draft: MemoryDraft;
  },
): React.ReactNode {
  React.useLayoutEffect(restoreMemoryHeadingOnExit, []);
  const { draft, memory } = props;
  const id = `brain-draft-${memory.memoryId}`;
  const busy = props.busyMemoryId !== null;
  return (
    <form
      className="brain-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onDraftSubmit(memory);
      }}
    >
      <label htmlFor={`${id}-statement`}>What to remember</label>
      <textarea
        id={`${id}-statement`}
        autoFocus
        required
        rows={3}
        maxLength={2000}
        value={draft.statement}
        onChange={(event) =>
          props.onDraftChange({ ...draft, statement: event.target.value })
        }
      />
      <div className="brain-form-row">
        <div>
          <label htmlFor={`${id}-timezone`}>Timezone</label>
          <input
            id={`${id}-timezone`}
            required
            aria-describedby={`${id}-timezone-hint`}
            value={draft.timezone}
            onChange={(event) =>
              props.onDraftChange({ ...draft, timezone: event.target.value })
            }
          />
          <span className="brain-muted" id={`${id}-timezone-hint`}>
            For example, Australia/Sydney.
          </span>
        </div>
        <div>
          <label htmlFor={`${id}-from`}>In effect from</label>
          <input
            id={`${id}-from`}
            type="date"
            required
            value={draft.effectiveFrom}
            onChange={(event) =>
              props.onDraftChange({
                ...draft,
                effectiveFrom: event.target.value,
              })
            }
          />
        </div>
        <div>
          <label htmlFor={`${id}-until`}>Until (optional)</label>
          <input
            id={`${id}-until`}
            type="date"
            value={draft.effectiveUntil}
            onChange={(event) =>
              props.onDraftChange({
                ...draft,
                effectiveUntil: event.target.value,
              })
            }
          />
        </div>
      </div>
      <p className="brain-muted">
        Saving makes a new version to review. It is not in use until someone
        accepts it.
      </p>
      <div className="proposal-decision">
        <button
          type="submit"
          className="connection-primary-action"
          disabled={busy}
        >
          Save for review
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={props.onDraftCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function restoreMemoryHeadingOnExit(): () => void {
  const heading = document.getElementById(MEMORY_DETAIL_TITLE_ID);
  return focusMemoryHeading.bind(null, heading);
}

function focusMemoryHeading(heading: HTMLElement | null): void {
  if (heading?.isConnected) heading.focus();
}

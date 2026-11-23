import React from "react";

import { useNavigate } from "react-router";

import {
  brainItemsToReview,
  type EvalRunView,
  type EvalView,
  type MemoryCommand,
  type MemoryRevisionView,
  type MemoryView,
} from "@purin-labs/control-api";

import type {
  AgentDefinition,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
import type { Skill } from "@purin-labs/control-api";
import { refreshBrainSummary, useBrainSummary } from "../../brain-summary";
import { isPrimaryNavigationClick } from "@purin-labs/ui/console-sidebar";
import { Notice, PageSkeleton, RecoverableError } from "@purin-labs/ui/page-components";
import { chatRouteState } from "@purin-labs/ui/page-address";
import {
  brainAddress,
  useBrainNavigation,
  type BrainAddress,
  type BrainSection,
  type BrainView,
} from "./address";
import {
  lastBrainRead,
  memoryErrorMessage,
  NO_AGENT_KNOWLEDGE,
  readAgentKnowledge,
  readEvalRuns,
  readEvals,
  readMemories,
  sendMemoryCommand,
  type BrainTransport,
} from "./api";
import { ContextView, type ContextLinks } from "./context";
import { EvalsPanel } from "./evals";
import { ActivityPanel } from "./execution";
import {
  KnowledgeView,
  knowledgeRowId,
  MEMORY_DETAIL_TITLE_ID,
  type KnowledgeLinks,
  type MemoryDecisionKind,
  type MemoryDraft,
  type MemoryReviewProps,
  type TeachLink,
} from "./knowledge";
import { LearningView } from "./learning";
import {
  learningFlow,
  learningLog,
  type LearningEvent,
} from "./learning-model";
import { acceptedRevision, openCandidate, revisionContent } from "./model";
import { BrainOverview } from "./overview";
import { useSeenRecords, type SeenRecords } from "./seen";
import "./styles.css";

type BrainContent =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{
      kind: "ready";
      memories: readonly MemoryView[];
      /** The Evals this person may read, or null when they were not read. */
      evals: readonly EvalView[] | null;
      playbooks: readonly Skill[];
      agents: readonly AgentDefinition[];
      /** The runs of each Eval, for the learning flow and its log. */
      runs: Readonly<Record<string, readonly EvalRunView[]>>;
    }>;

const NO_RUNS: Readonly<Record<string, readonly EvalRunView[]>> = {};

function lastBrainContent(organisationId: string): BrainContent {
  const last = lastBrainRead(organisationId);
  if (last === null) return { kind: "loading" };
  return {
    kind: "ready",
    memories: last.memories,
    evals: last.evals,
    playbooks: NO_AGENT_KNOWLEDGE.playbooks,
    agents: NO_AGENT_KNOWLEDGE.agents,
    runs: NO_RUNS,
  };
}

type MemoryFeedback = Readonly<{
  memoryId: string;
  tone: "success" | "warning";
  message: string;
}>;

type BrainRouteViewProps = MemoryReviewProps &
  Readonly<{
    /** The page that is open. Only Knowledge shows tabs. */
    section: BrainSection;
    content: BrainContent;
    /** The open view and the record selected in it. */
    address: BrainAddress;
    href: (address: BrainAddress) => string;
    onOpen: (address: BrainAddress) => void;
    feedback: MemoryFeedback | null;
    /** How many items wait for this person, or null while it is not known. */
    toDecide: number | null;
    /** What this browser has opened, for the "New" mark of a row. */
    seen: SeenRecords;
    onSeen: (key: string, changedAt: number | null) => void;
    /** The page that owns playbooks and agents, or null when none is known. */
    agentsHref: string | null;
    onOpenAgents: () => void;
    /** The pages that own the inspection of Case context, or null. */
    contextLinks: ContextLinks | null;
    onOpenPage: (href: string) => void;
    /** The Portal chat, where a person teaches a fact, or null. */
    teach: TeachLink | null;
    /** The Skills view. It reads its own records when it is opened. */
    skills: React.ReactNode;
    /** The Evals view. It reads its own records when it is opened. */
    evals: React.ReactNode;
    /** The Activity view. It reads its own records when it is opened. */
    activity: React.ReactNode;
    onReload: () => void;
  }>;

/**
 * What the agents have learned, and what waits for a person to decide.
 *
 * A memory is a short fact with the place it applies and the evidence behind
 * it. The agent may propose one. It is not used until an owner or admin
 * accepts it, and it stops being used when one revokes it.
 */
export function BrainRoute(props: {
  /** The page that is open: Knowledge, Activity or Tests. */
  readonly section: BrainSection;
  readonly organisationId: string;
  readonly canManage: boolean;
  readonly transport: BrainTransport;
  /** The Agents page of this workspace, which owns playbooks and agents. */
  readonly agentsHref?: string;
  /** The pages of this workspace that show Case context. */
  readonly contextLinks?: ContextLinks;
  /** The chat of this workspace, where a person teaches a fact. */
  readonly chatHref?: string;
  /** The Skills view, which the Agents operations own. */
  readonly skills: React.ReactNode;
}): React.ReactNode {
  const [content, setContent] = React.useState<BrainContent>({
    kind: "loading",
  });
  const { address, href, open } = useBrainNavigation(props.section);
  const navigate = useNavigate();
  const { seen, markOpened } = useSeenRecords(props.organisationId);
  const agentsHref = props.agentsHref ?? null;
  const chatHref = props.chatHref ?? null;
  const summary = useBrainSummary(props.organisationId);
  const [busyMemoryId, setBusyMemoryId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<MemoryDraft | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = React.useState<string | null>(
    null,
  );
  const [feedback, setFeedback] = React.useState<MemoryFeedback | null>(null);
  const request = React.useRef(0);

  const load = React.useCallback(async (): Promise<void> => {
    const current = (request.current += 1);
    try {
      const [memories, evals, agentKnowledge] = await Promise.all([
        readMemories(props.transport, props.organisationId),
        // The Knowledge view lists them. The Evals view reads them again.
        readEvals(props.transport, props.organisationId).catch(() => null),
        readAgentKnowledge(props.transport, props.organisationId),
      ]);
      // The runs of each Eval are lines of the learning log. An Eval whose
      // runs cannot be read adds none.
      const runs: Record<string, readonly EvalRunView[]> = {};
      await Promise.all(
        (evals ?? []).map(async (entry) => {
          runs[entry.evalId] = await readEvalRuns(
            props.transport,
            props.organisationId,
            entry.evalId,
          ).catch(() => []);
        }),
      );
      if (request.current === current)
        setContent({ kind: "ready", memories, evals, ...agentKnowledge, runs });
      // The navigation shows what waits, so it follows each read of the page.
      void refreshBrainSummary(props.organisationId, props.transport.read);
    } catch (error) {
      if (request.current === current)
        setContent({ kind: "failed", message: memoryErrorMessage(error) });
    }
  }, [props.organisationId, props.transport]);

  React.useEffect(() => {
    // An earlier visit's records stay on screen while both are read again.
    setContent(lastBrainContent(props.organisationId));
    void load();
  }, [load, props.organisationId]);

  const send = React.useCallback(
    async (
      memory: MemoryView,
      command: MemoryCommand | null,
      done: string,
    ): Promise<void> => {
      if (command === null || busyMemoryId !== null) return;
      setBusyMemoryId(memory.memoryId);
      setFeedback(null);
      try {
        await sendMemoryCommand(props.transport, props.organisationId, command);
        setDraft(null);
        setConfirmingRevoke(null);
        setFeedback({
          memoryId: memory.memoryId,
          tone: "success",
          message: done,
        });
      } catch (error) {
        setFeedback({
          memoryId: memory.memoryId,
          tone: "warning",
          message: memoryErrorMessage(error),
        });
      }
      // The list is read again either way: a refused command usually means
      // someone else changed the memory.
      await load();
      setBusyMemoryId(null);
    },
    [busyMemoryId, load, props.organisationId, props.transport],
  );

  return (
    <BrainRouteView
      section={props.section}
      content={content}
      address={address}
      href={href}
      onOpen={(next) => {
        // A notice about one memory does not follow the reader elsewhere.
        setFeedback(null);
        open(next);
      }}
      canManage={props.canManage}
      busyMemoryId={busyMemoryId}
      draft={draft}
      confirmingRevoke={confirmingRevoke}
      feedback={feedback}
      toDecide={summary === null ? null : brainItemsToReview(summary)}
      seen={seen}
      onSeen={markOpened}
      agentsHref={agentsHref}
      onOpenAgents={() => {
        if (agentsHref !== null) void navigate(agentsHref);
      }}
      contextLinks={props.contextLinks ?? null}
      onOpenPage={(page) => void navigate(page)}
      teach={
        chatHref === null
          ? null
          : {
              chatHref,
              // The chat opens beside this page and returns to it.
              onOpenChat: () =>
                void navigate(chatHref, {
                  state: chatRouteState(
                    window.location.pathname,
                    window.location.search,
                  ),
                }),
            }
      }
      skills={props.skills}
      evals={
        <EvalsPanel
          organisationId={props.organisationId}
          canManage={props.canManage}
          transport={props.transport}
          memories={content.kind === "ready" ? content.memories : []}
          links={{
            selectedEvalId: address.evalId,
            evalHref: (evalId) => href(brainAddress("evals", { evalId })),
            onSelectEval: (evalId) => open(brainAddress("evals", { evalId })),
            caseHref: (caseId) => href(brainAddress("activity", { caseId })),
            onOpenCase: (caseId) => open(brainAddress("activity", { caseId })),
            seen,
            onSeen: markOpened,
          }}
          onMemoryChanged={() => void load()}
        />
      }
      activity={
        <ActivityPanel
          organisationId={props.organisationId}
          transport={props.transport}
          caseId={address.caseId}
          nodeId={address.nodeId}
          onOpen={(caseId, nodeId) =>
            open(brainAddress("activity", { caseId, nodeId }))
          }
        />
      }
      onReload={() => void load()}
      onDecide={(memory, decision) =>
        void send(
          memory,
          decisionCommand(memory, decision),
          DECISION_DONE[decision],
        )
      }
      onEdit={(memory) => setDraft(startDraft(memory))}
      onDraftChange={setDraft}
      onDraftCancel={() => setDraft(null)}
      onDraftSubmit={(memory) =>
        void send(
          memory,
          draft === null ? null : editCommand(memory, draft),
          "Saved for review. It is not in use until someone accepts it.",
        )
      }
      onConfirmRevoke={setConfirmingRevoke}
    />
  );
}

const DECISION_DONE: Readonly<Record<MemoryDecisionKind, string>> = {
  accept: "Accepted. The agent uses this memory where it applies.",
  reject: "Declined. The agent will not use it.",
  revoke: "Revoked. The agent stops using it in new work.",
};

function commandId(): string {
  return `memory_${crypto.randomUUID()}`;
}

function decisionCommand(
  memory: MemoryView,
  decision: MemoryDecisionKind,
): MemoryCommand | null {
  const target =
    decision === "revoke" ? acceptedRevision(memory) : openCandidate(memory);
  if (target === null) return null;
  return {
    commandId: commandId(),
    expectedRevision: memory.headRevision,
    kind: decision,
    memoryId: memory.memoryId,
    revision: target.revision,
  };
}

/** The version a reviewer edits: the candidate, else the one in use. */
function editedRevision(memory: MemoryView): MemoryRevisionView | null {
  return openCandidate(memory) ?? acceptedRevision(memory);
}

function startDraft(memory: MemoryView): MemoryDraft | null {
  const base = editedRevision(memory);
  if (base === null) return null;
  return {
    memoryId: memory.memoryId,
    statement: base.statement,
    timezone: base.validity.timezone,
    effectiveFrom: base.validity.effectiveFrom,
    effectiveUntil: base.validity.effectiveUntil ?? "",
  };
}

function editCommand(
  memory: MemoryView,
  draft: MemoryDraft,
): MemoryCommand | null {
  const base = editedRevision(memory);
  if (base === null) return null;
  const content = revisionContent(base);
  return {
    commandId: commandId(),
    expectedRevision: memory.headRevision,
    kind: "propose",
    memoryId: memory.memoryId,
    // An edit on this page goes to the readers of the version it edits.
    submission: "shared_review",
    content: {
      ...content,
      statement: draft.statement.trim(),
      validity: {
        ...content.validity,
        timezone: draft.timezone.trim(),
        effectiveFrom: draft.effectiveFrom,
        effectiveUntil:
          draft.effectiveUntil === "" ? null : draft.effectiveUntil,
      },
    },
  };
}

/** The page without its data lifecycle, for previews and tests. */
function BrainRouteView(props: BrainRouteViewProps): React.ReactNode {
  // What the last selection opened. The keyboard moves to it in the render
  // that shows it, so a person who does not use a pointer keeps their place.
  const focusNext = React.useRef<string | null>(null);
  React.useLayoutEffect(() => {
    if (focusNext.current === null) return;
    document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  });
  // Skills and Activity read their own records, so a failed read of the
  // memories does not hide them.
  if (
    props.content.kind !== "ready" &&
    (props.address.view === "skills" || props.address.view === "activity")
  ) {
    return (
      <div className="brain-page">
        <KnowledgeTabs {...props} />
        {props.address.view === "skills" ? props.skills : props.activity}
      </div>
    );
  }
  if (props.content.kind === "loading")
    return <PageSkeleton label="Loading what the agents have learned" />;
  if (props.content.kind === "failed")
    return (
      <RecoverableError
        message={props.content.message}
        action={
          <button className="secondary" type="button" onClick={props.onReload}>
            Try again
          </button>
        }
      />
    );
  const { memories, evals, playbooks, agents, runs } = props.content;
  const { address } = props;
  const log = learningLog(memories, evals ?? [], runs);
  const eventAddress = (event: LearningEvent): BrainAddress =>
    event.target.kind === "memory"
      ? brainAddress("knowledge", { memoryId: event.target.memoryId })
      : brainAddress("evals", { evalId: event.target.evalId });
  const memoryAddress = (memoryId: string | null): BrainAddress =>
    brainAddress("knowledge", { memoryId, state: address.state });
  const links: KnowledgeLinks = {
    memoryHref: (memoryId) => props.href(memoryAddress(memoryId)),
    onSelectMemory: (memoryId) => {
      if (memoryId !== null) focusNext.current = MEMORY_DETAIL_TITLE_ID;
      else if (address.memoryId !== null)
        focusNext.current = knowledgeRowId({
          kind: "memory",
          id: address.memoryId,
        });
      props.onOpen(memoryAddress(memoryId));
    },
    evalHref: (evalId) => props.href(brainAddress("evals", { evalId })),
    onOpenEval: (evalId) => props.onOpen(brainAddress("evals", { evalId })),
    agentsHref: props.agentsHref,
    onOpenAgents: props.onOpenAgents,
    skillsHref: props.href(brainAddress("skills")),
    onOpenSkills: () => props.onOpen(brainAddress("skills")),
  };
  return (
    <div className="brain-page">
      <KnowledgeTabs {...props} />
      {/* A decided memory can change its place, so the result is shown here. */}
      {props.feedback === null ? null : (
        <Notice tone={props.feedback.tone} announcement="polite">
          {props.feedback.message}
        </Notice>
      )}
      {address.view === "overview" ? (
        <BrainOverview
          memories={memories}
          evals={evals}
          toDecide={props.toDecide}
          canManage={props.canManage}
          seen={props.seen}
          onSeen={props.onSeen}
          links={links}
          stateHref={(state) =>
            props.href(brainAddress("knowledge", { state }))
          }
          onState={(state) =>
            props.onOpen(brainAddress("knowledge", { state }))
          }
          evalsHref={props.href(brainAddress("evals"))}
          onOpenEvals={() => props.onOpen(brainAddress("evals"))}
        />
      ) : address.view === "learning" ? (
        <LearningView
          flow={learningFlow(memories, evals ?? [], runs)}
          log={log}
          knowledgeHref={(inUse) =>
            props.href(
              brainAddress("knowledge", { state: inUse ? "in_use" : null }),
            )
          }
          onOpenKnowledge={(inUse) =>
            props.onOpen(
              brainAddress("knowledge", { state: inUse ? "in_use" : null }),
            )
          }
          evalsHref={props.href(brainAddress("evals"))}
          onOpenEvals={() => props.onOpen(brainAddress("evals"))}
          eventHref={(event) => props.href(eventAddress(event))}
          onOpenEvent={(event) => {
            if (event.target.kind === "memory")
              focusNext.current = MEMORY_DETAIL_TITLE_ID;
            props.onOpen(eventAddress(event));
          }}
        />
      ) : address.view === "skills" ? (
        props.skills
      ) : address.view === "evals" ? (
        props.evals
      ) : address.view === "activity" ? (
        props.activity
      ) : address.view === "context" ? (
        <ContextView links={props.contextLinks} onOpenPage={props.onOpenPage} />
      ) : (
        <KnowledgeView
          {...props}
          {...links}
          memories={memories}
          evals={evals}
          playbooks={playbooks}
          agents={agents}
          selectedMemoryId={address.memoryId}
          state={address.state}
          stateHref={(state) =>
            props.href(brainAddress("knowledge", { state }))
          }
          onState={(state) =>
            props.onOpen(brainAddress("knowledge", { state }))
          }
          caseHref={(caseId) =>
            props.href(brainAddress("activity", { caseId }))
          }
          onOpenCase={(caseId) => {
            focusNext.current = "brain-activity";
            props.onOpen(brainAddress("activity", { caseId }));
          }}
        />
      )}
    </div>
  );
}

/** The views of the Knowledge page. The other pages have one view each. */
function KnowledgeTabs(props: BrainRouteViewProps): React.ReactNode {
  if (props.section !== "knowledge") return null;
  return (
    <nav className="brain-tabs" aria-label="Knowledge views">
      <BrainTab {...props} target="overview" label="Overview" />
      <BrainTab {...props} target="knowledge" label="Knowledge" />
      <BrainTab {...props} target="skills" label="Skills" />
      <BrainTab {...props} target="learning" label="Learning" />
      <BrainTab {...props} target="evals" label="Tests" />
      <BrainTab {...props} target="context" label="Context" />
    </nav>
  );
}

function BrainTab(
  props: BrainRouteViewProps & {
    readonly target: BrainView;
    readonly label: string;
  },
): React.ReactNode {
  const target = brainAddress(props.target);
  return (
    <a
      className="brain-tab"
      href={props.href(target)}
      aria-current={props.address.view === props.target ? "page" : undefined}
      onClick={(event) => {
        if (!isPrimaryNavigationClick(event)) return;
        event.preventDefault();
        props.onOpen(target);
      }}
    >
      {props.label}
    </a>
  );
}

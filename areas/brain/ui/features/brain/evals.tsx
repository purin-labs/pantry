import { Select } from "@purin-labs/ui/select";
import React from "react";

import {
  evalConfigurationVerdict,
  type EvalCommand,
  type EvalConfiguration,
  type EvalRevisionView,
  type EvalRoute,
  type EvalRunCommand,
  type EvalRunResult,
  type EvalRunView,
  type EvalScenario,
  type EvalTaskResult,
  type EvalView,
  type MemoryView,
} from "@purin-labs/control-api";

import { refreshBrainSummary } from "../../brain-summary";
import { isPrimaryNavigationClick } from "@purin-labs/ui/page-address";
import { formatAbsoluteTime } from "@purin-labs/ui/formatting";
import {
  EmptyState,
  Notice,
  PageSkeleton,
  RecoverableError,
  StatusChip,
} from "@purin-labs/ui/page-components";
import {
  evalErrorMessage,
  memoryErrorMessage,
  readEvalRuns,
  readEvalSenderChoices,
  readEvals,
  sendEvalCommand,
  sendEvalRunCommand,
  sendMemoryCommand,
  type BrainTransport,
} from "@purin-labs/area-brain-contract/ui/features/brain/api";
import { ScenarioEditor, type SenderChoices } from "./eval-editor";
import {
  scenarioDraft,
  scenariosFromDrafts,
  type ScenarioDraft,
} from "./eval-editor-model";
import {
  acceptedEval,
  arrivalLabel,
  configurationLabel,
  criterionLabel,
  EVAL_ROUTES,
  evalStatuses,
  isRunInProgress,
  leadEval,
  openEvalCandidate,
  outcomeLabel,
  progressLabel,
  routeLabel,
  runStatus,
  taskNote,
  taskStatus,
  verdictSentence,
} from "./evals-model";
import { knowledgeRowId, KnowledgeRows } from "./knowledge";
import { evalRow, rowsForReview, type KnowledgeRow } from "./knowledge-model";
import { openCandidate } from "./model";
import { RecordClose } from "./record-close";
import type { SeenRecords } from "./seen";
import { SideDrawer } from "@purin-labs/ui/index";

type EvalsContent =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; evals: readonly EvalView[] }>;

type EvalRunsContent =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; runs: readonly EvalRunView[] }>;

/** What a person chose for the next run of one Eval. */
type EvalRunChoice = Readonly<{
  routes: readonly EvalRoute[];
  /** The Memory whose proposed version is compared, or "" for none. */
  candidateMemoryId: string;
}>;

type EvalFeedback = Readonly<{
  tone: "success" | "warning";
  message: string;
}>;

type EvalDecision = "accept" | "reject" | "revoke";

/** The scenarios that a person edits, for one Eval. */
type EvalEditing = Readonly<{
  evalId: string;
  drafts: readonly ScenarioDraft[];
  /** What a person must correct before the scenarios can be saved. */
  problem: string | null;
}>;

/** Where the Evals view leads, and what the address selects in it. */
type EvalsLinks = Readonly<{
  /** The Eval of the address. It can name one this person cannot read. */
  selectedEvalId: string | null;
  evalHref: (evalId: string | null) => string;
  onSelectEval: (evalId: string | null) => void;
  /** The Activity view of the Case that holds a run. */
  caseHref: (caseId: string) => string;
  onOpenCase: (caseId: string) => void;
  seen: SeenRecords;
  onSeen: (key: string, changedAt: number | null) => void;
}>;

const EVAL_DETAIL_TITLE_ID = "brain-eval-detail-title";

type EvalsPanelViewProps = EvalsLinks &
  Readonly<{
    editing: EvalEditing | null;
    senders: Readonly<Record<string, SenderChoices>>;
    onEdit: (target: EvalView) => void;
    onDraftsChange: (drafts: readonly ScenarioDraft[]) => void;
    onDraftsSave: (target: EvalView) => void;
    onDraftsCancel: () => void;
  }> &
  Readonly<{
    content: EvalsContent;
    runs: Readonly<Record<string, EvalRunsContent>>;
    choices: Readonly<Record<string, EvalRunChoice>>;
    memories: readonly MemoryView[];
    canManage: boolean;
    busy: boolean;
    confirmingRevoke: string | null;
    feedback: EvalFeedback | null;
    onReload: () => void;
    onDecide: (target: EvalView, decision: EvalDecision) => void;
    onConfirmRevoke: (evalId: string | null) => void;
    onChoice: (evalId: string, choice: EvalRunChoice) => void;
    onStart: (target: EvalView) => void;
    onCancel: (target: EvalView, run: EvalRunView) => void;
    onAcceptMemory: (run: EvalRunResult) => void;
  }>;

const DEFAULT_CHOICE: EvalRunChoice = {
  routes: ["pantry_platform"],
  candidateMemoryId: "",
};

const POLL_MS = 4_000;

/**
 * The reviewed checks of agent behaviour, and their runs.
 *
 * An eval is a small set of situations with the behaviour expected in each.
 * A run tries the agent on them with the memory in use and, when chosen,
 * with one proposed memory in place of the one it would replace. The
 * proposed memory is seen inside the run only.
 */
export function EvalsPanel(props: {
  readonly organisationId: string;
  readonly canManage: boolean;
  readonly transport: BrainTransport;
  readonly memories: readonly MemoryView[];
  readonly links: EvalsLinks;
  readonly onMemoryChanged: () => void;
}): React.ReactNode {
  const { organisationId, transport } = props;
  const [editing, setEditing] = React.useState<EvalEditing | null>(null);
  const [senders, setSenders] = React.useState<Record<string, SenderChoices>>(
    {},
  );
  const [content, setContent] = React.useState<EvalsContent>({
    kind: "loading",
  });
  const [runs, setRuns] = React.useState<Record<string, EvalRunsContent>>({});
  const [choices, setChoices] = React.useState<Record<string, EvalRunChoice>>(
    {},
  );
  const [busy, setBusy] = React.useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = React.useState<string | null>(
    null,
  );
  const [feedback, setFeedback] = React.useState<EvalFeedback | null>(null);
  const request = React.useRef(0);

  const loadRuns = React.useCallback(
    async (evalId: string): Promise<void> => {
      try {
        const read = await readEvalRuns(transport, organisationId, evalId);
        setRuns((earlier) => ({
          ...earlier,
          [evalId]: { kind: "ready", runs: read },
        }));
      } catch (error) {
        setRuns((earlier) => ({
          ...earlier,
          [evalId]: { kind: "failed", message: evalErrorMessage(error) },
        }));
      }
    },
    [organisationId, transport],
  );

  const load = React.useCallback(async (): Promise<void> => {
    const current = (request.current += 1);
    try {
      const evals = await readEvals(transport, organisationId);
      if (request.current !== current) return;
      setContent({ kind: "ready", evals });
      // The navigation shows what waits, so it follows each read of the Evals.
      void refreshBrainSummary(organisationId, transport.read);
      await Promise.all(
        evals
          .filter((entry) => acceptedEval(entry) !== null)
          .map((entry) => loadRuns(entry.evalId)),
      );
    } catch (error) {
      if (request.current === current)
        setContent({ kind: "failed", message: evalErrorMessage(error) });
    }
  }, [loadRuns, organisationId, transport]);

  React.useEffect(() => {
    setContent({ kind: "loading" });
    setRuns({});
    void load();
  }, [load]);

  // An Eval that a link names is on screen as soon as the Evals are read, and
  // the keyboard goes to its title. When the record closes, the keyboard
  // returns to the row that opened it.
  const shown = content.kind === "ready";
  const { selectedEvalId } = props.links;
  const closed = React.useRef<string | null>(null);
  React.useLayoutEffect(() => {
    if (!shown) return;
    if (selectedEvalId !== null) {
      document.getElementById(EVAL_DETAIL_TITLE_ID)?.focus();
      closed.current = selectedEvalId;
      return;
    }
    if (closed.current !== null)
      document
        .getElementById(knowledgeRowId({ kind: "evals", id: closed.current }))
        ?.focus();
    closed.current = null;
  }, [selectedEvalId, shown]);

  // The editor closes when another Eval is selected.
  React.useEffect(() => {
    setEditing((current) =>
      current !== null && current.evalId !== selectedEvalId ? null : current,
    );
  }, [selectedEvalId]);

  const loadSenders = React.useCallback(
    async (evalId: string): Promise<void> => {
      setSenders((earlier) => ({ ...earlier, [evalId]: { kind: "loading" } }));
      try {
        const choices = await readEvalSenderChoices(
          transport,
          organisationId,
          evalId,
        );
        setSenders((earlier) => ({
          ...earlier,
          [evalId]: { kind: "ready", choices },
        }));
      } catch {
        setSenders((earlier) => ({
          ...earlier,
          [evalId]: {
            kind: "failed",
            message:
              "Pantry could not read the verified contacts of this mailbox. You can change a scenario and keep its sender.",
          },
        }));
      }
    },
    [organisationId, transport],
  );

  // A run in progress is read again until it settles.
  const inProgress = Object.entries(runs)
    .filter(
      ([, state]) => state.kind === "ready" && state.runs.some(isRunInProgress),
    )
    .map(([evalId]) => evalId)
    .join(",");
  React.useEffect(() => {
    if (inProgress === "") return;
    const timer = window.setInterval(() => {
      for (const evalId of inProgress.split(",")) void loadRuns(evalId);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [inProgress, loadRuns]);

  const act = React.useCallback(
    async (
      work: () => Promise<unknown>,
      done: string,
      after: () => Promise<void>,
      failure: (error: unknown) => string = evalErrorMessage,
    ): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setFeedback(null);
      try {
        await work();
        setConfirmingRevoke(null);
        setFeedback({ tone: "success", message: done });
      } catch (error) {
        setFeedback({ tone: "warning", message: failure(error) });
      }
      // The page is read again either way: a refused request usually means
      // someone else changed the record.
      await after();
      setBusy(false);
    },
    [busy],
  );

  return (
    <EvalsPanelView
      {...props.links}
      editing={editing}
      senders={senders}
      onEdit={(target) => {
        const base = openEvalCandidate(target) ?? acceptedEval(target);
        if (base === null) return;
        setFeedback(null);
        setEditing({
          evalId: target.evalId,
          drafts: base.scenarios.map(scenarioDraft),
          problem: null,
        });
        void loadSenders(target.evalId);
      }}
      onDraftsChange={(drafts) =>
        setEditing((current) =>
          current === null ? null : { ...current, drafts, problem: null },
        )
      }
      onDraftsCancel={() => setEditing(null)}
      onDraftsSave={(target) => {
        const base = openEvalCandidate(target) ?? acceptedEval(target);
        if (editing === null || base === null) return;
        const built = scenariosFromDrafts(editing.drafts);
        if (!built.ok) {
          setEditing({ ...editing, problem: built.message });
          return;
        }
        void act(
          async () => {
            await sendEvalCommand(transport, organisationId, {
              commandId: commandId("eval"),
              evalId: target.evalId,
              expectedRevision: target.headRevision,
              kind: "revise",
              content: {
                title: base.title,
                subject: base.subject,
                scenarios: built.scenarios,
                evidence: base.evidence,
                sourceCaseId: base.sourceCaseId,
              },
            });
            setEditing(null);
          },
          "Saved for review. Runs keep the reviewed scenarios until someone accepts the change.",
          load,
        );
      }}
      content={content}
      runs={runs}
      choices={choices}
      memories={props.memories}
      canManage={props.canManage}
      busy={busy}
      confirmingRevoke={confirmingRevoke}
      feedback={feedback}
      onReload={() => void load()}
      onDecide={(target, decision) => {
        const command = decisionCommand(target, decision);
        if (command !== null)
          void act(
            () => sendEvalCommand(transport, organisationId, command),
            DECISION_DONE[decision],
            load,
          );
      }}
      onConfirmRevoke={setConfirmingRevoke}
      onChoice={(evalId, choice) =>
        setChoices((earlier) => ({ ...earlier, [evalId]: choice }))
      }
      onStart={(target) => {
        const command = startCommand(
          target,
          choices[target.evalId] ?? DEFAULT_CHOICE,
          props.memories,
        );
        if (command !== null)
          void act(
            () => sendEvalRunCommand(transport, organisationId, command),
            "The run started. Results appear here when it finishes.",
            () => loadRuns(target.evalId),
          );
      }}
      onCancel={(target, run) =>
        void act(
          () =>
            sendEvalRunCommand(transport, organisationId, {
              commandId: commandId("evalrun_cancel"),
              kind: "cancel",
              evalId: target.evalId,
              runId: run.runId,
            }),
          "The run was cancelled. A scenario that had started runs to its end.",
          () => loadRuns(target.evalId),
        )
      }
      onAcceptMemory={(run) => {
        const candidate = candidateOf(run);
        const memory = props.memories.find(
          (entry) => entry.memoryId === candidate?.memoryId,
        );
        if (candidate === null || memory === undefined) return;
        void act(
          () =>
            sendMemoryCommand(transport, organisationId, {
              commandId: commandId("memory"),
              expectedRevision: memory.headRevision,
              kind: "accept",
              memoryId: memory.memoryId,
              revision: candidate.revision,
            }),
          "Accepted. The agent now uses the proposed memory where it applies.",
          async () => props.onMemoryChanged(),
          memoryErrorMessage,
        );
      }}
    />
  );
}

const DECISION_DONE: Readonly<Record<EvalDecision, string>> = {
  accept: "Accepted. Runs now use these scenarios and expected results.",
  reject: "Declined. Nothing changed for runs.",
  revoke: "Revoked. This eval is no longer run.",
};

function commandId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function decisionCommand(
  target: EvalView,
  decision: EvalDecision,
): EvalCommand | null {
  const revision =
    decision === "revoke" ? acceptedEval(target) : openEvalCandidate(target);
  if (revision === null) return null;
  return {
    commandId: commandId("eval"),
    evalId: target.evalId,
    expectedRevision: target.headRevision,
    kind: decision,
    revision: revision.revision,
  };
}

function startCommand(
  target: EvalView,
  choice: EvalRunChoice,
  memories: readonly MemoryView[],
): EvalRunCommand | null {
  const accepted = acceptedEval(target);
  if (accepted === null || choice.routes.length === 0) return null;
  const memory = memories.find(
    (entry) => entry.memoryId === choice.candidateMemoryId,
  );
  const proposed = memory === undefined ? null : openCandidate(memory);
  const configurations: EvalConfiguration[] = [{ kind: "current" }];
  if (memory !== undefined && proposed !== null)
    configurations.push({
      kind: "candidate",
      memory: { memoryId: memory.memoryId, revision: proposed.revision },
    });
  return {
    commandId: commandId("evalrun"),
    kind: "start",
    eval: { evalId: target.evalId, revision: accepted.revision },
    routes: choice.routes,
    configurations,
  };
}

/** The proposed memory version a run tried, or null. */
function candidateOf(
  run: EvalRunView,
): Readonly<{ memoryId: string; revision: number }> | null {
  for (const configuration of run.configurations)
    if (configuration.kind === "candidate") return configuration.memory;
  return null;
}

/** The panel without its data lifecycle, for previews. */
function EvalsPanelView(props: EvalsPanelViewProps): React.ReactNode {
  if (props.content.kind === "loading")
    return <PageSkeleton label="Loading evals" />;
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
  const evals = props.content.evals;
  const selected =
    props.selectedEvalId === null
      ? null
      : (evals.find((entry) => entry.evalId === props.selectedEvalId) ?? null);
  const present = (row: KnowledgeRow | null): row is KnowledgeRow =>
    row !== null;
  const rows = rowsForReview(evals.map(evalRow).filter(present));
  return (
    <section className="brain-evals" aria-labelledby="brain-evals">
      <h2 className="visually-hidden" id="brain-evals" tabIndex={-1}>
        Evals
      </h2>
      {props.feedback === null ? null : (
        <Notice tone={props.feedback.tone} announcement="polite">
          {props.feedback.message}
        </Notice>
      )}
      {props.selectedEvalId !== null ? (
        <section className="brain-record" aria-label="Eval details">
          <RecordClose
            href={props.evalHref(null)}
            label="Close this eval"
            onClose={() => props.onSelectEval(null)}
          />
          {selected === null ? (
            <p className="brain-muted" id={EVAL_DETAIL_TITLE_ID} tabIndex={-1}>
              This eval is not available to you.
            </p>
          ) : (
            <EvalRecord {...props} target={selected} />
          )}
        </section>
      ) : // The tab names the list, so it has no heading of its own.
      rows.length === 0 ? (
        <EmptyState
          title="No evals yet"
          detail="When you correct an email reply, the agent may propose an eval with the memory it learned. It appears here for review."
        />
      ) : (
        <KnowledgeRows
          label="Evals"
          rows={rows}
          seen={props.seen}
          showKind={false}
          onSeen={props.onSeen}
          links={{
            // This list holds Evals only.
            memoryHref: () => props.evalHref(null),
            onSelectMemory: () => undefined,
            evalHref: props.evalHref,
            onOpenEval: props.onSelectEval,
            agentsHref: null,
            onOpenAgents: () => undefined,
            skillsHref: props.evalHref(null),
            onOpenSkills: () => undefined,
          }}
        />
      )}
    </section>
  );
}

function EvalRecord(
  props: EvalsPanelViewProps & { readonly target: EvalView },
): React.ReactNode {
  const { target } = props;
  const editing =
    props.editing?.evalId === target.evalId ? props.editing : null;
  // When the form closes, the keyboard returns to the title of the record.
  const isEditing = editing !== null;
  const wasEditing = React.useRef(isEditing);
  React.useLayoutEffect(() => {
    if (wasEditing.current && !isEditing)
      document.getElementById(EVAL_DETAIL_TITLE_ID)?.focus();
    wasEditing.current = isEditing;
  }, [isEditing]);
  const lead = leadEval(target);
  if (lead === null) return null;
  const accepted = acceptedEval(target);
  const candidate = openEvalCandidate(target);
  return (
    <div className="brain-memory">
      <header className="brain-memory-head">
        <div className="brain-memory-chips">
          {evalStatuses(target).map((status) => (
            <StatusChip key={status.label} status={status} />
          ))}
        </div>
        <h3
          className="brain-memory-statement"
          id={EVAL_DETAIL_TITLE_ID}
          tabIndex={-1}
        >
          {lead.title}
        </h3>
        <p className="brain-muted">
          Tries the replies of one mailbox agent. No email is drafted or sent.
        </p>
      </header>
      {editing !== null ? (
        <ScenarioEditor
          drafts={editing.drafts}
          senders={props.senders[target.evalId] ?? { kind: "loading" }}
          busy={props.busy}
          problem={editing.problem}
          onChange={props.onDraftsChange}
          onSave={props.onDraftsSave.bind(null, target)}
          onCancel={props.onDraftsCancel}
        />
      ) : (
        <>
          <ScenarioList revision={lead} />
          {accepted !== null && candidate !== null ? (
            <section className="brain-replacement">
              <h4>Proposed change</h4>
              <p className="brain-muted">
                Runs keep the reviewed scenarios until someone accepts this
                change.
              </p>
              <ScenarioList revision={candidate} />
            </section>
          ) : null}
          <EvalActions {...props} />
          {accepted === null ? null : (
            <EvalRuns {...props} revision={accepted} />
          )}
        </>
      )}
      <a
        className="brain-link brain-record-case"
        href={props.caseHref(lead.sourceCaseId)}
        onClick={(event) => {
          if (!isPrimaryNavigationClick(event)) return;
          event.preventDefault();
          props.onOpenCase(lead.sourceCaseId);
        }}
      >
        Open the Case
      </a>
    </div>
  );
}

function ScenarioList(props: {
  readonly revision: EvalRevisionView;
}): React.ReactNode {
  return (
    <ol className="brain-scenarios">
      {props.revision.scenarios.map((scenario) => (
        <li key={scenario.scenarioId} className="brain-scenario">
          <div className="brain-memory-chips">
            <StatusChip
              status={
                scenario.role === "target"
                  ? { kind: "info", label: "Behaviour under test" }
                  : { kind: "neutral", label: "Must stay the same" }
              }
            />
          </div>
          <p className="brain-scenario-title">{scenario.title}</p>
          <dl className="commerce-facts">
            <div>
              <dt>Arrives</dt>
              <dd>{arrivalLabel(scenario.message)}</dd>
            </div>
            <div>
              <dt>Expected</dt>
              <dd>
                <ul className="brain-criteria">
                  {scenario.criteria.map((criterion) => (
                    <li key={criterion.criterionId}>
                      {criterionLabel(criterion)}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          </dl>
          <p className="brain-scenario-subject">{scenario.message.subject}</p>
          <details className="support-details">
            <summary>The message</summary>
            <p className="brain-scenario-body">{scenario.message.body}</p>
          </details>
        </li>
      ))}
    </ol>
  );
}

function EvalActions(
  props: EvalsPanelViewProps & { readonly target: EvalView },
): React.ReactNode {
  const { target } = props;
  const candidate = openEvalCandidate(target);
  const accepted = acceptedEval(target);
  if (candidate === null && accepted === null) return null;
  if (!props.canManage)
    return candidate === null ? null : (
      <p role="status" className="brain-muted">
        Waiting for an owner or admin to decide.
      </p>
    );
  if (candidate !== null)
    return (
      <div className="proposal-decision">
        <button
          type="button"
          className="connection-primary-action"
          disabled={props.busy}
          onClick={props.onDecide.bind(null, target, "accept")}
        >
          {accepted === null ? "Accept these scenarios" : "Accept the change"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={props.busy}
          onClick={props.onEdit.bind(null, target)}
        >
          Edit scenarios first
        </button>
        <button
          type="button"
          className="secondary"
          disabled={props.busy}
          onClick={props.onDecide.bind(null, target, "reject")}
        >
          Decline
        </button>
      </div>
    );
  return props.confirmingRevoke === target.evalId ? (
    <div className="proposal-decision">
      <button
        type="button"
        className="danger"
        disabled={props.busy}
        onClick={props.onDecide.bind(null, target, "revoke")}
      >
        Revoke this eval
      </button>
      <button
        type="button"
        className="secondary"
        disabled={props.busy}
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
        disabled={props.busy}
        onClick={props.onEdit.bind(null, target)}
      >
        Edit scenarios
      </button>
      <button
        type="button"
        className="secondary"
        disabled={props.busy}
        onClick={props.onConfirmRevoke.bind(null, target.evalId)}
      >
        Revoke
      </button>
    </div>
  );
}

function EvalRuns(
  props: EvalsPanelViewProps & {
    readonly target: EvalView;
    readonly revision: EvalRevisionView;
  },
): React.ReactNode {
  const { target } = props;
  const state = props.runs[target.evalId] ?? { kind: "loading" };
  return (
    <section
      className="brain-runs"
      aria-label={`Runs of ${props.revision.title}`}
    >
      <h4>Runs</h4>
      {props.canManage ? <RunForm {...props} /> : null}
      {state.kind === "loading" ? (
        <p role="status" className="brain-muted">
          Loading runs.
        </p>
      ) : state.kind === "failed" ? (
        <Notice tone="warning" announcement="polite">
          {state.message}
        </Notice>
      ) : state.runs.length === 0 ? (
        <p className="brain-muted">No run yet.</p>
      ) : (
        <ol className="brain-run-list">
          {state.runs.map((run) => (
            <li key={run.runId}>
              <RunCard {...props} run={run} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function RunForm(
  props: EvalsPanelViewProps & { readonly target: EvalView },
): React.ReactNode {
  const { target } = props;
  const choice = props.choices[target.evalId] ?? DEFAULT_CHOICE;
  const proposals = props.memories.filter(
    (memory) => openCandidate(memory) !== null,
  );
  const candidates = [
    { value: "", label: "None. Run with the memory in use only." },
    ...proposals.map((memory) => ({
      value: memory.memoryId,
      label: openCandidate(memory)?.statement.slice(0, 90),
    })),
  ];
  const id = `brain-run-${target.evalId}`;
  return (
    <form
      className="brain-form brain-run-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onStart(target);
      }}
    >
      <fieldset className="brain-run-routes">
        <legend>Models to run on</legend>
        {EVAL_ROUTES.map((route) => (
          <label key={route} className="brain-check">
            <input
              type="checkbox"
              checked={choice.routes.includes(route)}
              disabled={
                !choice.routes.includes(route) && choice.routes.length >= 3
              }
              onChange={(event) =>
                props.onChoice(target.evalId, {
                  ...choice,
                  routes: event.target.checked
                    ? [...choice.routes, route]
                    : choice.routes.filter((entry) => entry !== route),
                })
              }
            />
            {routeLabel(route)}
          </label>
        ))}
      </fieldset>
      <div>
        <label htmlFor={`${id}-candidate`}>
          Compare with a proposed memory
        </label>
        <Select.Root
          items={candidates}
          value={choice.candidateMemoryId}
          onValueChange={(value) => {
            if (value !== null)
              props.onChoice(target.evalId, {
                ...choice,
                candidateMemoryId: value,
              });
          }}
        >
          <Select.Trigger id={`${id}-candidate`}>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>
            {candidates.map((item) => (
              <Select.Item key={item.value} value={item.value}>
                {item.label}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
      </div>
      <p className="brain-muted">
        A run uses the token budget of the mailbox. A model that is not set up
        shows as “Could not run”. Purin Pantry never moves a scenario to another
        model.
      </p>
      <div className="proposal-decision">
        <button
          type="submit"
          className="connection-primary-action"
          disabled={props.busy || choice.routes.length === 0}
        >
          Run
        </button>
      </div>
    </form>
  );
}

function RunCard(
  props: EvalsPanelViewProps & {
    readonly target: EvalView;
    readonly run: EvalRunView;
  },
): React.ReactNode {
  const { run, target } = props;
  const tried = target.revisions.find(
    (revision) => revision.revision === run.eval.revision,
  );
  return (
    <article className="brain-run">
      <header className="brain-run-head">
        <StatusChip status={runStatus(run)} />
        <span className="brain-muted">
          Started {formatAbsoluteTime(run.startedAt)}
          {isRunInProgress(run) ? `. ${progressLabel(run)}.` : "."}
        </span>
      </header>
      {isRunInProgress(run) ? (
        props.canManage ? (
          <div className="proposal-decision">
            <button
              type="button"
              className="secondary"
              disabled={props.busy}
              onClick={props.onCancel.bind(null, target, run)}
            >
              Cancel the run
            </button>
          </div>
        ) : null
      ) : (
        <RunResult {...props} run={run} scenarios={tried?.scenarios ?? []} />
      )}
      <p>
        <a
          className="brain-link"
          href={props.caseHref(run.caseId)}
          onClick={(event) => {
            if (!isPrimaryNavigationClick(event)) return;
            event.preventDefault();
            props.onOpenCase(run.caseId);
          }}
        >
          Open its execution
        </a>
      </p>
    </article>
  );
}

function RunResult(
  props: EvalsPanelViewProps & {
    readonly run: EvalRunResult;
    readonly scenarios: readonly EvalScenario[];
  },
): React.ReactNode {
  const { run } = props;
  const compared = run.configurations.some(
    (configuration) => configuration.kind === "candidate",
  );
  const configurations: readonly EvalConfiguration["kind"][] = compared
    ? ["current", "candidate"]
    : ["current"];
  const candidate = candidateOf(run);
  const memory = props.memories.find(
    (entry) => entry.memoryId === candidate?.memoryId,
  );
  // The proposed version can be accepted from here while it is still the
  // open proposal, and only when it passed on a model that ran.
  const acceptable =
    props.canManage &&
    candidate !== null &&
    memory !== undefined &&
    openCandidate(memory)?.revision === candidate.revision &&
    run.routes.some(
      (route) => evalConfigurationVerdict(run, "candidate", route) === "passed",
    );
  // A row for each scenario of the version that ran, then for any scenario
  // that only the results name.
  const scenarioIds = [
    ...props.scenarios.map((scenario) => scenario.scenarioId),
    ...run.tasks.map((task) => task.scenarioId),
  ].filter((id, index, all) => all.indexOf(id) === index);
  const taskOf = (
    scenarioId: string,
    route: EvalRoute,
    configuration: EvalConfiguration["kind"],
  ): EvalTaskResult | null =>
    run.tasks.find(
      (task) =>
        task.scenarioId === scenarioId &&
        task.route === route &&
        task.configuration === configuration,
    ) ?? null;
  // A model that ran no scenario has one reason. The summary states it one
  // time, and each of its cells keeps the mark only.
  const sharedNote = (route: EvalRoute): string | null => {
    const notes = run.tasks
      .filter((task) => task.route === route)
      .map(taskNote);
    const first = notes[0] ?? null;
    return first !== null && notes.every((note) => note === first)
      ? first
      : null;
  };
  const routeName = (route: EvalRoute): string =>
    run.routes.length > 1 ? `${routeLabel(route)}. ` : "";
  // The assessed task whose result the drawer shows, or null.
  const [shown, setShown] = React.useState<EvalTaskResult | null>(null);
  return (
    <>
      <ul className="brain-run-summary">
        {run.routes.flatMap((route) => {
          const note = sharedNote(route);
          return note !== null
            ? [
                <li key={route}>
                  {routeName(route)}
                  {note}
                </li>,
              ]
            : configurations.map((configuration) => (
                <li key={`${route}:${configuration}`}>
                  {routeName(route)}
                  {verdictSentence(run, configuration, route)}
                </li>
              ));
        })}
      </ul>
      <table className="brain-run-table">
        <caption>
          {compared
            ? "The same request, with and without the proposed memory"
            : "The same request, with the memory in use"}
        </caption>
        <thead>
          <tr>
            <th scope="col" rowSpan={2}>
              Scenario
            </th>
            {run.routes.map((route) => (
              <th key={route} scope="colgroup" colSpan={configurations.length}>
                {routeLabel(route)}
              </th>
            ))}
          </tr>
          <tr>
            {run.routes.flatMap((route) =>
              configurations.map((configuration) => (
                <th key={`${route}:${configuration}`} scope="col">
                  {configurationLabel(configuration)}
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {scenarioIds.map((scenarioId) => (
            <tr key={scenarioId}>
              <th scope="row">
                {props.scenarios.find(
                  (scenario) => scenario.scenarioId === scenarioId,
                )?.title ?? scenarioId}
              </th>
              {run.routes.flatMap((route, group) =>
                configurations.map((configuration, index) => (
                  <td
                    key={`${route}:${configuration}`}
                    className={
                      group > 0 && index === 0 ? "brain-run-group" : undefined
                    }
                    data-label={`${routeLabel(route)}, ${configurationLabel(configuration).toLowerCase()}`}
                  >
                    <TaskCell
                      task={taskOf(scenarioId, route, configuration)}
                      showNote={sharedNote(route) === null}
                      onOpen={setShown}
                    />
                  </td>
                )),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="brain-muted">
        A model can answer the same request differently. One run is one
        observation, not a proof.
      </p>
      <TaskDrawer {...props} task={shown} close={setShown.bind(null, null)} />
      {acceptable ? (
        <div className="proposal-decision">
          <button
            type="button"
            className="connection-primary-action"
            disabled={props.busy}
            onClick={props.onAcceptMemory.bind(null, run)}
          >
            Accept the proposed memory
          </button>
        </div>
      ) : null}
    </>
  );
}

/** How many of the expected results an assessed task met. */
function criteriaMet(task: EvalTaskResult): string {
  const criteria = task.outcome.criteria ?? [];
  return `${criteria.filter((result) => result.met).length} of ${criteria.length}`;
}

function TaskCell(props: {
  readonly task: EvalTaskResult | null;
  /** False when the summary of the run states the note for the whole model. */
  readonly showNote: boolean;
  readonly onOpen: (task: EvalTaskResult) => void;
}): React.ReactNode {
  const { task } = props;
  const note = props.showNote ? taskNote(task) : null;
  const status = taskStatus(task);
  return (
    <div className="brain-task">
      {task !== null && task.outcome.kind === "assessed" ? (
        <button
          type="button"
          className="brain-task-open"
          aria-haspopup="dialog"
          onClick={props.onOpen.bind(null, task)}
        >
          <StatusChip
            status={{
              ...status,
              label: `${status.label} · ${criteriaMet(task)}`,
            }}
          />
        </button>
      ) : (
        <StatusChip status={status} />
      )}
      {note === null ? null : <p className="brain-muted">{note}</p>}
    </div>
  );
}

/** What the agent did in one assessed task, beside the table. */
function TaskDrawer(
  props: EvalsPanelViewProps & {
    readonly run: EvalRunResult;
    readonly scenarios: readonly EvalScenario[];
    readonly task: EvalTaskResult | null;
    readonly close: () => void;
  },
): React.ReactNode {
  const { task } = props;
  const assessed =
    task !== null && task.outcome.kind === "assessed" ? task : null;
  const scenario =
    assessed === null
      ? undefined
      : props.scenarios.find(
          (entry) => entry.scenarioId === assessed.scenarioId,
        );
  const criteria = (met: boolean) =>
    (assessed?.outcome.criteria ?? [])
      .filter((result) => result.met === met)
      .map((result) => {
        const criterion = scenario?.criteria.find(
          (entry) => entry.criterionId === result.criterionId,
        );
        return (
          <li key={result.criterionId}>
            {criterion === undefined
              ? result.criterionId
              : criterionLabel(criterion)}
          </li>
        );
      });
  const met = criteria(true);
  const notMet = criteria(false);
  return (
    <SideDrawer open={assessed !== null} title="Run result" close={props.close}>
      {assessed === null || assessed.outcome.kind !== "assessed" ? null : (
        <div className="side-drawer-body brain-task-result">
          <p className="brain-muted">
            {scenario?.title ?? assessed.scenarioId} ·{" "}
            {routeLabel(assessed.route)} ·{" "}
            {configurationLabel(assessed.configuration).toLowerCase()}
          </p>
          <StatusChip
            status={{
              ...taskStatus(assessed),
              label: `${taskStatus(assessed).label} · ${criteriaMet(assessed)}`,
            }}
          />
          <h3>What the agent did</h3>
          <p>{outcomeLabel(assessed.outcome.observation.outcome)}.</p>
          {assessed.outcome.observation.reply === null ? null : (
            <p className="brain-scenario-body">
              {assessed.outcome.observation.reply}
            </p>
          )}
          {met.length === 0 ? null : (
            <>
              <h3>Met</h3>
              <ul className="brain-criteria">{met}</ul>
            </>
          )}
          {notMet.length === 0 ? null : (
            <>
              <h3>Not met</h3>
              <ul className="brain-criteria">{notMet}</ul>
            </>
          )}
          <p>
            <a
              className="brain-link"
              href={props.caseHref(props.run.caseId)}
              onClick={(event) => {
                if (!isPrimaryNavigationClick(event)) return;
                event.preventDefault();
                props.close();
                props.onOpenCase(props.run.caseId);
              }}
            >
              Open its execution
            </a>
          </p>
        </div>
      )}
    </SideDrawer>
  );
}

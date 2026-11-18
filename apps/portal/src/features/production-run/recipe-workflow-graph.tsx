import {
  branchOfEdge,
  compileDraft,
  decisionRuleOf,
  draftSeed,
  knownPlaces,
  measuredLots,
  newStepNode,
  stepExecutorKind,
  stepOrdering,
  stepPlaces,
  stepProgram,
  stepSeconds,
  stepSkill,
  stepWorkers,
  withDecisionRule,
  withStepOrdering,
  withStepPlaces,
  withStepProgram,
  withStepSeconds,
  withStepSkill,
  withStepWorkers,
  withoutDecision,
  workflowDiff,
  type DraftCompilation,
  type DraftProblem,
  type WorkflowDiff,
} from "@seams/bakery-workflow/draft";
import { proposalChangeSummary } from "@seams/bakery-workflow/changes";
import type { RunFinding } from "@seams/bakery-workflow/findings";
import type { TaskView } from "@seams/production-simulation";
import {
  NODE_COLUMN,
  NODE_HEIGHT,
  NODE_ROW,
  NODE_WIDTH,
} from "@seams/bakery-workflow/layout";
import {
  DRAFT_BOUNDS,
  DRAFT_LABEL_LIMIT,
  WorkflowDraftDoc,
  draftNodeId,
  type DraftNode,
  type DraftSnapshot,
} from "@seams/workflow-canvas-crdt/draft";
import {
  ArrowUp,
  Bot,
  Check,
  CircleAlert,
  Cog,
  GitBranch,
  Hand,
  Layers,
  Minus,
  MousePointer2,
  Play,
  Plus,
  Redo2,
  Sparkles,
  Timer,
  Undo2,
  User,
  Users,
  X,
} from "lucide-react";
import React from "react";
import {
  GraphSelect,
  graphChoice,
  type GraphChoice,
} from "./recipe-graph-select";
import { animationPlan, type AnimationPlanBuilder } from "./recipe-clock";
import {
  runDraftComparison,
  type DraftComparison,
  type DraftRunHandle,
} from "./recipe-draft-run";
import {
  loadRecipeSource,
  recipeGraph,
  recipeOverview,
  type RecipeOverviewNode,
  type RecipeGraph,
  type RecipeGraphEdge,
  type RecipeGraphNode,
  type RecipeGraphSource,
  type RecipeSource,
} from "./recipe-graph";
import { taskSpans, type Span } from "./oven-task-views";
import { seconds } from "./oven-logistics";
import {
  RecipeWorkspaceContext,
  applyWorkflow,
  askAgentInChat,
  decideProposal,
  readAppliedWorkflow,
  readProposedDocument,
  recipeWorkflowId,
  recordRunFindings,
  type ProposalDecision,
  type RecipeWorkspace,
  type WorkflowProposal,
} from "./recipe-workspace";
import {
  WorkflowDraftClient,
  type DraftConnectionView,
} from "./workflow-draft-client";
import "./recipe-workflow-graph.css";

/** A larger recipe opens on one workflow. The whole of it can still show. */
const LARGE_RECIPE_STEPS = 64;
const OVERVIEW = "__overview";
const WIDTH = NODE_WIDTH;
const HEIGHT = NODE_HEIGHT;
/** A wire is a curve when it has this much room, and it runs through a gap otherwise. */
const WIRE_REACH = 14;
const WIRE_CORNER = 14;
/** From the edge of a card to the centre of its port. */
const PORT_CENTRE = 15;
/** The label above a step: its kind and its seconds. */
const LABEL_ROOM = 20;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.1;
/** The width that a side panel covers, and the room that a port needs beside it. */
const PANEL_ROOM = 364;
const PORT_ROOM = 30;
/** The floating bars stand 12px from the edge of the workspace, 8px apart. */
const CHROME_EDGE = 12;
const CHROME_GAP = 8;
const COMPOSER_EXAMPLE_MS = 6000;
const COMPOSER_EXAMPLES = [
  "Add a check after the last step",
  "Shorten the longest wait",
  "Find what makes this recipe late",
];

/** What flows out of a step. A port and its wire share the color and the icon. */
type PortKind = RecipeGraphNode["role"] | "workflow";

export type RecipeGraphStage = Readonly<{
  id: string;
  /** The stage's card state, which a step shows as its own. */
  state: string;
  stateLabel: string;
  startS: number;
  endS: number;
  reached: boolean;
}>;

type Props = Readonly<{
  source: RecipeGraphSource;
  stages: readonly RecipeGraphStage[];
  seek: (timeS: number) => void;
  /** Receives the plan of a draft that ran, for the view's own original stages. */
  planned?: ((plan: AnimationPlanBuilder) => void) | undefined;
}>;

type Loaded = Readonly<{
  source: RecipeSource;
  /** The compiled recipe, which is what the fixed animation shows. */
  original: DraftSnapshot;
  /** The applied revision, which a draft is compared with. */
  document: RecipeSource["document"];
  base: DraftSnapshot;
  applied: Extract<DraftCompilation, { kind: "ready" }>;
  /** The revision before an approved proposal, whose badges stay until the next one. */
  replaced: DraftSnapshot | null;
  shared: Readonly<{
    workflowId: string;
    digest: string;
    revision: number;
  }> | null;
}>;

type RunState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "running" }>
  | Readonly<{ kind: "done"; comparison: DraftComparison }>
  | Readonly<{ kind: "failed"; message: string }>;

/** A proposal that a person reviews. The shared draft stays as it is under it. */
type ChromeParts = Readonly<
  Record<
    | "header"
    | "end"
    | "stages"
    | "summary"
    | "footer"
    | "notices"
    | "tools"
    | "result",
    Element | null
  >
>;

type OpenProposal = Readonly<{
  proposal: WorkflowProposal;
  snapshot: DraftSnapshot;
  compilation: Extract<DraftCompilation, { kind: "ready" }>;
}>;

type State = Readonly<{
  load:
    | Readonly<{ kind: "waiting" }>
    | Readonly<{ kind: "ready"; value: Loaded }>
    | Readonly<{ kind: "failed"; message: string }>;
  snapshot: DraftSnapshot | null;
  compilation: DraftCompilation | null;
  selected: string | null;
  connecting: string | null;
  run: RunState;
  connection: DraftConnectionView | null;
  /** The workflow that a large recipe shows. */
  workflowFilter: string | null;
  /** A large recipe opens with one node for each workflow. */
  overview: boolean;
  zoom: number;
  /** The zoom shows the whole graph, until a person changes it. */
  fitted: boolean;
  tool: "select" | "pan";
  /** Space turns a drag into a pan for as long as it is held. */
  spaceHeld: boolean;
  panning: boolean;
  /** What each review answers in a comparison. */
  review: "accept" | "reject";
  apply:
    | Readonly<{ kind: "idle" }>
    | Readonly<{ kind: "applying" }>
    | Readonly<{ kind: "applied"; revision: number }>
    | Readonly<{ kind: "failed"; message: string }>;
  proposals: readonly WorkflowProposal[];
  open: OpenProposal | null;
  deciding: boolean;
  proposalMessage: string | null;
}>;

/**
 * A recipe's real steps and prerequisites, and its draft. The stage cards stay the
 * clock of the animation, so a step shows the state of its stage. It reads the
 * recipe when the Workflow surface first opens, because some recipes prepare a
 * native cell for this. A draft changes nothing until a person runs or applies it.
 */
export class RecipeWorkflowGraph extends React.Component<Props, State> {
  state: State = {
    load: { kind: "waiting" },
    snapshot: null,
    compilation: null,
    selected: null,
    connecting: null,
    run: { kind: "idle" },
    connection: null,
    workflowFilter: null,
    overview: false,
    zoom: 1,
    fitted: false,
    tool: "select",
    spaceHeld: false,
    panning: false,
    review: "accept",
    apply: { kind: "idle" },
    proposals: [],
    open: null,
    deciding: false,
    proposalMessage: null,
  };
  static contextType = RecipeWorkspaceContext;
  declare context: RecipeWorkspace | null;
  private client: WorkflowDraftClient | null = null;
  private readonly root = React.createRef<HTMLDivElement>();
  private readonly scroll = React.createRef<HTMLDivElement>();
  private observer: IntersectionObserver | null = null;
  private chromeSize: ResizeObserver | null = null;
  private chromeParts: MutationObserver | null = null;
  private active = false;
  private loaded: string | null = null;
  private doc: WorkflowDraftDoc | null = null;
  private compileGeneration = 0;
  private runHandle: DraftRunHandle | null = null;
  private suppressClick = false;
  private drag: {
    id: string;
    pointerX: number;
    pointerY: number;
    x: number;
    y: number;
    /** Where the graph was on screen when the drag began. */
    left: number;
    top: number;
    moved: boolean;
  } | null = null;
  private pan: {
    pointerX: number;
    pointerY: number;
    left: number;
    top: number;
    moved: boolean;
  } | null = null;
  constructor(props: Props) {
    super(props);
    this.observe = this.observe.bind(this);
    this.keyDown = this.keyDown.bind(this);
    this.keyUp = this.keyUp.bind(this);
    this.wheel = this.wheel.bind(this);
    this.dragMove = this.dragMove.bind(this);
    this.dragEnd = this.dragEnd.bind(this);
    this.panMove = this.panMove.bind(this);
    this.panEnd = this.panEnd.bind(this);
    this.closeDrawer = this.closeDrawer.bind(this);
    this.watchChrome = this.watchChrome.bind(this);
  }
  componentDidMount(): void {
    this.active = true;
    document.addEventListener("keydown", this.keyDown);
    document.addEventListener("keyup", this.keyUp);
    // React's wheel listener is passive, and a zoom must stop the page zoom.
    this.root.current?.addEventListener("wheel", this.wheel, {
      passive: false,
    });
    const surface = this.root.current?.closest(
      ".recipe-workflow, .factory-workflow-canvas",
    );
    if (surface === null || surface === undefined) return;
    this.observer = new IntersectionObserver(this.observe);
    this.observer.observe(surface);
  }
  componentDidUpdate(previous: Props, previousState: State): void {
    if (
      this.state.selected !== null &&
      this.state.selected !== previousState.selected
    )
      this.revealSelected();
    if (
      previous.source === this.props.source ||
      this.props.source.kind === "compiled" ||
      JSON.stringify(previous.source) === JSON.stringify(this.props.source) ||
      this.loaded === null
    )
      return;
    void this.load();
  }
  componentWillUnmount(): void {
    this.active = false;
    this.observer?.disconnect();
    this.chromeSize?.disconnect();
    this.chromeParts?.disconnect();
    document.removeEventListener("keydown", this.keyDown);
    document.removeEventListener("keyup", this.keyUp);
    this.root.current?.removeEventListener("wheel", this.wheel);
    window.removeEventListener("pointermove", this.dragMove);
    window.removeEventListener("pointerup", this.dragEnd);
    window.removeEventListener("pointermove", this.panMove);
    window.removeEventListener("pointerup", this.panEnd);
    this.runHandle?.cancel();
    this.releaseDraft();
  }
  private releaseDraft(): void {
    if (this.client !== null) this.client.dispose();
    else this.doc?.destroy();
    this.client = null;
    this.doc = null;
  }
  private observe(entries: readonly IntersectionObserverEntry[]): void {
    if (this.loaded !== null || !entries.some(isIntersecting)) return;
    this.observer?.disconnect();
    void this.load();
  }
  private async load(): Promise<void> {
    const key =
      this.props.source.kind === "compiled"
        ? this.props.source.scenario.id
        : JSON.stringify(this.props.source);
    this.loaded = key;
    this.setState({ load: { kind: "waiting" } });
    const result = await loadRecipeSource(this.props.source);
    if (!this.active || this.loaded !== key) return;
    if (!result.ok) {
      this.setState({ load: { kind: "failed", message: result.error } });
      return;
    }
    try {
      const workspace = this.context;
      if (workspace === null) await this.loadLocal(key, result.value);
      else await this.loadShared(key, result.value, workspace);
    } catch (error) {
      if (!this.active || this.loaded !== key) return;
      this.setState({
        load: {
          kind: "failed",
          message:
            error instanceof Error ? error.message : "The recipe is invalid.",
        },
      });
    }
  }
  private async compiledBase(
    document: RecipeSource["document"],
    base: DraftSnapshot,
  ): Promise<Extract<DraftCompilation, { kind: "ready" }>> {
    const applied = await compileDraft(document, base);
    if (applied.kind !== "ready")
      throw new Error(applied.problems[0]?.message ?? "The recipe is invalid.");
    return applied;
  }
  /** Without a workspace the draft lives and ends on this page. */
  private async loadLocal(key: string, source: RecipeSource): Promise<void> {
    const original = draftSeed(source.document);
    const applied = await this.compiledBase(source.document, original);
    if (!this.active || this.loaded !== key) return;
    const doc = WorkflowDraftDoc.create(original);
    if (!doc.ok) throw new Error("This recipe is too large to edit.");
    this.releaseDraft();
    this.doc = doc.value;
    this.setReady(
      {
        source,
        original,
        document: source.document,
        base: original,
        applied,
        replaced: null,
        shared: null,
      },
      doc.value.snapshot(),
    );
  }
  /** The first person with the right applies the compiled recipe as revision 1. */
  private async loadShared(
    key: string,
    source: RecipeSource,
    workspace: RecipeWorkspace,
  ): Promise<void> {
    const original = draftSeed(source.document);
    const workflowId = await recipeWorkflowId(this.props.source);
    let current = await readAppliedWorkflow(workspace, workflowId);
    if (current === null && workspace.canManage) {
      await applyWorkflow(workspace, workflowId, source.document, null);
      current = await readAppliedWorkflow(workspace, workflowId);
    }
    if (!this.active || this.loaded !== key) return;
    if (current === null) {
      await this.loadLocal(key, source);
      return;
    }
    const base = draftSeed(current.document);
    const applied = await this.compiledBase(current.document, base);
    if (!this.active || this.loaded !== key) return;
    const loaded: Loaded = {
      source,
      original,
      document: current.document,
      base,
      applied,
      replaced: current.replaced === null ? null : draftSeed(current.replaced),
      shared: {
        workflowId,
        digest: current.digest,
        revision: current.revision,
      },
    };
    this.setState({ proposals: current.proposals });
    this.releaseDraft();
    let first = true;
    const client = new WorkflowDraftClient(
      workspace.organisationId,
      workflowId,
      {
        changed: () => {
          if (first) {
            first = false;
            this.setReady(loaded, client.doc.snapshot());
          } else this.changed(false);
        },
        view: (connection) => {
          if (this.active) this.setState({ connection });
        },
        revisionChanged: () => {
          void this.readRevision();
        },
      },
    );
    this.client = client;
    this.doc = client.doc;
  }
  private setReady(value: Loaded, snapshot: DraftSnapshot): void {
    // A reopened draft can differ from the applied revision, so it compiles too.
    this.setState(
      {
        workflowFilter: null,
        overview:
          snapshot.nodes.length > LARGE_RECIPE_STEPS &&
          value.document.workflows.length > 1,
        zoom: 1,
        fitted: false,
        load: { kind: "ready", value },
        snapshot,
        compilation: value.applied,
        selected: null,
        connecting: null,
        run: { kind: "idle" },
        apply: { kind: "idle" },
      },
      this.changed.bind(this, false),
    );
  }
  /** Another person applied a revision, so the draft has a new comparison. */
  private async readRevision(): Promise<void> {
    const { load } = this.state;
    const workspace = this.context;
    if (
      load.kind !== "ready" ||
      load.value.shared === null ||
      workspace === null
    )
      return;
    const current = await readAppliedWorkflow(
      workspace,
      load.value.shared.workflowId,
    );
    if (current === null || !this.active) return;
    this.setState({ proposals: current.proposals });
    if (current.digest === load.value.shared.digest) return;
    const base = draftSeed(current.document);
    const applied = await this.compiledBase(current.document, base);
    if (!this.active) return;
    this.setState({
      load: {
        kind: "ready",
        value: {
          ...load.value,
          document: current.document,
          base,
          applied,
          replaced:
            current.replaced === null ? null : draftSeed(current.replaced),
          shared: {
            workflowId: load.value.shared.workflowId,
            digest: current.digest,
            revision: current.revision,
          },
        },
      },
    });
  }
  private async applyDraft(): Promise<void> {
    const { load } = this.state;
    const workspace = this.context;
    const doc = this.doc;
    if (
      load.kind !== "ready" ||
      load.value.shared === null ||
      workspace === null ||
      doc === null
    )
      return;
    this.setState({ apply: { kind: "applying" } });
    try {
      // An apply takes the draft as it stands now, not the last finished compile.
      const compilation = await compileDraft(
        load.value.document,
        doc.snapshot(),
      );
      if (compilation.kind !== "ready") {
        this.setState({ compilation, apply: { kind: "idle" } });
        return;
      }
      const result = await applyWorkflow(
        workspace,
        load.value.shared.workflowId,
        compilation.document,
        load.value.shared.digest,
      );
      if (!this.active) return;
      if (result.kind === "stale") {
        this.setState({
          apply: {
            kind: "failed",
            message:
              "Another person applied a newer revision. Review this draft, and apply it again.",
          },
        });
        await this.readRevision();
        return;
      }
      await this.readRevision();
      if (this.active)
        this.setState({
          apply: { kind: "applied", revision: result.revision },
        });
    } catch (error) {
      if (this.active)
        this.setState({
          apply: {
            kind: "failed",
            message:
              error instanceof Error ? error.message : "The apply failed.",
          },
        });
    }
  }

  private async openProposal(proposal: WorkflowProposal): Promise<void> {
    const { load } = this.state;
    const workspace = this.context;
    if (
      load.kind !== "ready" ||
      load.value.shared === null ||
      workspace === null
    )
      return;
    this.runHandle?.cancel();
    try {
      const document = await readProposedDocument(
        workspace,
        load.value.shared.workflowId,
        proposal.draftId,
      );
      const snapshot = draftSeed(document);
      const compilation = await compileDraft(document, snapshot);
      if (compilation.kind !== "ready")
        throw new Error("This proposal no longer compiles.");
      if (this.active)
        this.setState({
          open: { proposal, snapshot, compilation },
          run: { kind: "idle" },
          selected: null,
          connecting: null,
          proposalMessage: null,
        });
    } catch (error) {
      if (this.active)
        this.setState({
          proposalMessage:
            error instanceof Error
              ? error.message
              : "The proposal cannot be read.",
        });
    }
  }
  private closeProposal(): void {
    this.runHandle?.cancel();
    this.setState({ open: null, run: { kind: "idle" } });
  }
  private async decide(action: "approve" | "decline"): Promise<void> {
    const { load, open } = this.state;
    const workspace = this.context;
    if (
      load.kind !== "ready" ||
      load.value.shared === null ||
      workspace === null ||
      open === null
    )
      return;
    this.setState({ deciding: true, proposalMessage: null });
    try {
      const decision = await decideProposal(
        workspace,
        load.value.shared.workflowId,
        open.proposal.draftId,
        action,
      );
      await this.readRevision();
      if (!this.active) return;
      this.setState({
        open: null,
        deciding: false,
        run: { kind: "idle" },
        proposalMessage: decisionText(decision),
      });
      this.changed(false);
    } catch (error) {
      if (this.active)
        this.setState({
          deciding: false,
          proposalMessage:
            error instanceof Error ? error.message : "The decision failed.",
        });
    }
  }

  /** Every edit reaches the document first, and the page reads it back. */
  private changed(local = true): void {
    const doc = this.doc;
    const { load } = this.state;
    if (doc === null || load.kind !== "ready" || !this.active) return;
    const snapshot = doc.snapshot();
    if (local)
      this.setState({
        snapshot,
        run: { kind: "idle" },
        apply: { kind: "idle" },
      });
    else this.setState({ snapshot });
    if (local) this.client?.flush();
    const generation = ++this.compileGeneration;
    void compileDraft(load.value.document, snapshot).then(
      this.compiled.bind(this, generation),
    );
  }
  private compiled(generation: number, compilation: DraftCompilation): void {
    if (!this.active || generation !== this.compileGeneration) return;
    this.setState({ compilation });
  }

  private addStep(kind: "work" | "wait" | "decision"): void {
    const { load, snapshot, selected } = this.state;
    if (load.kind !== "ready" || snapshot === null || this.doc === null) return;
    const after = snapshot.nodes.find(nodeMatches.bind(null, selected));
    const workflow =
      after?.workflow ??
      this.state.workflowFilter ??
      recipeGraph(load.value.source, snapshot).nodes.at(-1)?.workflow;
    if (workflow === undefined) return;
    const node = newStepNode(load.value.document, snapshot, {
      workflow,
      kind,
      label:
        kind === "work"
          ? "New step"
          : kind === "wait"
            ? "New wait"
            : "New decision",
      seconds: 10,
    });
    if (node === null) return;
    const id = draftNodeId(node.workflow, node.key);
    this.doc.putNode(node);
    this.doc.movePosition(
      id,
      freePosition(
        snapshot,
        after === undefined
          ? null
          : snapshot.positions[draftNodeId(after.workflow, after.key)],
      ),
    );
    if (after !== undefined) this.connect(after, node);
    this.setState({ selected: id });
    this.changed();
  }
  private removeSelected(): void {
    const node = this.selectedNode();
    if (node === null || this.doc === null) return;
    this.doc.removeNode(node.workflow, node.key);
    this.setState({ selected: null });
    this.changed();
  }
  private updateNode(change: Partial<Pick<DraftNode, "label" | "body">>): void {
    const node = this.selectedNode();
    if (node === null || this.doc === null) return;
    this.doc.putNode({ ...node, ...change });
    this.changed();
  }
  private commitLabel(event: React.FocusEvent<HTMLInputElement>): void {
    const label = event.currentTarget.value.trim();
    const node = this.selectedNode();
    if (node === null || label === node.label) return;
    if (label.length === 0 || label.length > DRAFT_LABEL_LIMIT) {
      event.currentTarget.value = node.label;
      return;
    }
    this.updateNode({ label });
  }
  private commitSeconds(event: React.FocusEvent<HTMLInputElement>): void {
    const node = this.selectedNode();
    if (node === null) return;
    const seconds = Number(event.currentTarget.value);
    const body =
      event.currentTarget.value.trim() === "" || seconds <= 0
        ? null
        : withStepSeconds(node.body, seconds);
    if (body === null) {
      event.currentTarget.value = String(stepSeconds(node.body) ?? "");
      return;
    }
    if (seconds !== stepSeconds(node.body)) this.updateNode({ body });
  }
  private chooseProgram(program: string | null): void {
    const node = this.selectedNode();
    const body =
      node === null || program === null
        ? null
        : withStepProgram(node.body, program);
    if (body !== null) this.updateNode({ body });
  }
  private chooseSkill(snapshot: DraftSnapshot, skill: string | null): void {
    const node = this.selectedNode();
    const body =
      node === null || skill === null
        ? null
        : withStepSkill(snapshot, node.body, skill);
    if (body !== null) this.updateNode({ body });
  }
  private choosePlace(
    field: "start" | "finish",
    places: Readonly<{ start: string; finish: string }>,
    place: string | null,
  ): void {
    const node = this.selectedNode();
    const body =
      node === null || place === null
        ? null
        : withStepPlaces(node.body, { ...places, [field]: place });
    if (body !== null) this.updateNode({ body });
  }
  private commitOrdering(
    field: "priority" | "earliestSeconds",
    event: React.FocusEvent<HTMLInputElement>,
  ): void {
    const node = this.selectedNode();
    const value = Number(event.currentTarget.value);
    if (node === null || !Number.isFinite(value)) return;
    const ordering = stepOrdering(node.body);
    if (ordering[field] === value) return;
    const body = withStepOrdering(node.body, { ...ordering, [field]: value });
    if (body !== null) this.updateNode({ body });
  }
  private toggleWorker(worker: string): void {
    const node = this.selectedNode();
    if (node === null) return;
    const current = stepWorkers(node.body) ?? [];
    const workers = current.includes(worker)
      ? current.filter(isOtherThan.bind(null, worker))
      : [...current, worker];
    const body = withStepWorkers(node.body, workers);
    if (body !== null) this.updateNode({ body });
  }
  private togglePrerequisite(from: DraftNode): void {
    const node = this.selectedNode();
    const snapshot = this.state.snapshot;
    if (node === null || this.doc === null || snapshot === null) return;
    if (hasEdge(snapshot, node.workflow, from.key, node.key))
      this.doc.removeEdge(node.workflow, from.key, node.key);
    else this.connect(from, node);
    this.changed();
  }
  /** Puts the selected step in one arm of a decision, or takes it out. */
  private setBranch(from: DraftNode, value: string | null): void {
    const node = this.selectedNode();
    const snapshot = this.state.snapshot;
    if (node === null || snapshot === null || this.doc === null) return;
    const edge = snapshot.edges.find(
      (item) =>
        item.workflow === node.workflow &&
        item.from === from.key &&
        item.to === node.key,
    );
    if (edge === undefined || value === null) return;
    const branch = value === "accept" || value === "reject" ? value : null;
    this.doc.putEdge({ ...edge, branch });
    if (branch === null && branchOfEdge(from.key, node.body) !== null)
      this.doc.putNode({ ...node, body: withoutDecision(node.body) });
    this.changed();
  }
  private setRuleKind(value: string | null): void {
    const node = this.selectedNode();
    const snapshot = this.state.snapshot;
    if (node === null || snapshot === null || value === null) return;
    const lot = measuredLots(snapshot, node.workflow)[0];
    const body = withDecisionRule(
      node.body,
      value === "scripted"
        ? { kind: "scripted", outcomes: ["accept"] }
        : value === "measurement" && lot !== undefined
          ? { kind: "measurement", lot, minimum: 0, maximum: 0 }
          : { kind: "person" },
    );
    this.updateNode({ body });
  }
  private commitScript(event: React.FocusEvent<HTMLInputElement>): void {
    const node = this.selectedNode();
    if (node === null) return;
    const outcomes = event.currentTarget.value
      .split(",")
      .map(trimmed)
      .filter(isOutcome);
    if (outcomes.length === 0) return;
    this.updateNode({
      body: withDecisionRule(node.body, { kind: "scripted", outcomes }),
    });
  }
  private commitRange(event: React.FormEvent<HTMLElement>): void {
    const node = this.selectedNode();
    const form = event.currentTarget;
    if (node === null) return;
    const lot = form.querySelector<HTMLInputElement>("input[name=lot]");
    const inputs =
      form.querySelectorAll<HTMLInputElement>("input[type=number]");
    const minimum = Number(inputs[0]?.value);
    const maximum = Number(inputs[1]?.value);
    if (
      lot === null ||
      !Number.isFinite(minimum) ||
      !Number.isFinite(maximum) ||
      minimum > maximum
    )
      return;
    this.updateNode({
      body: withDecisionRule(node.body, {
        kind: "measurement",
        lot: lot.value,
        minimum,
        maximum,
      }),
    });
  }
  private chooseReview(value: string | null): void {
    if (value === null) return;
    this.setState({
      review: value === "reject" ? "reject" : "accept",
      run: { kind: "idle" },
    });
  }
  private connect(from: DraftNode, to: DraftNode): void {
    const snapshot = this.doc?.snapshot();
    if (this.doc === null || snapshot === undefined) return;
    let order = 0;
    for (const edge of snapshot.edges)
      if (edge.workflow === to.workflow)
        order = Math.max(order, edge.order + 1);
    this.doc.putEdge({
      workflow: to.workflow,
      from: from.key,
      to: to.key,
      order,
      branch: branchOfEdge(from.key, to.body),
    });
  }
  private undo(): void {
    this.doc?.undo();
    this.changed();
  }
  private redo(): void {
    this.doc?.redo();
    this.changed();
  }
  private keyDown(event: KeyboardEvent): void {
    if (event.code === "Space") {
      this.spaceDown(event);
      return;
    }
    if (event.key !== "Escape") return;
    if (this.state.connecting !== null) this.setState({ connecting: null });
    else if (this.state.selected !== null) this.closeDrawer();
  }
  /** Space belongs to a control that has the focus, and to the page when this is hidden. */
  private spaceDown(event: KeyboardEvent): void {
    const target = event.target;
    if (
      (target instanceof Element &&
        target.closest(
          "input, textarea, select, button, a, [contenteditable]",
        ) !== null) ||
      this.state.load.kind !== "ready" ||
      this.root.current?.getClientRects().length === 0
    )
      return;
    event.preventDefault();
    if (!this.state.spaceHeld) this.setState({ spaceHeld: true });
  }
  private closeDrawer(): void {
    this.setState({ selected: null });
  }
  private panning(): boolean {
    return this.state.tool === "pan" || this.state.spaceHeld;
  }
  private chooseTool(tool: State["tool"]): void {
    this.setState({ tool });
  }
  private keyUp(event: KeyboardEvent): void {
    if (event.code === "Space" && this.state.spaceHeld)
      this.setState({ spaceHeld: false });
  }
  /** A drag on an empty part of the canvas pans it. A drag on a step moves the step. */
  private panStart(event: React.PointerEvent<HTMLDivElement>): void {
    const scroll = this.scroll.current;
    if (scroll === null || event.pointerType === "touch") return;
    if (event.button !== 0 && event.button !== 1) return;
    const box = scroll.getBoundingClientRect();
    const onScrollbar =
      event.clientX >= box.left + scroll.clientWidth ||
      event.clientY >= box.top + scroll.clientHeight;
    const target = event.target;
    const onStep =
      target instanceof Element &&
      target.closest(".recipe-graph-node-frame") !== null;
    if (onScrollbar || (onStep && !this.panning() && event.button === 0))
      return;
    this.pan = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left: scroll.scrollLeft,
      top: scroll.scrollTop,
      moved: false,
    };
    this.setState({ panning: true });
    window.addEventListener("pointermove", this.panMove);
    window.addEventListener("pointerup", this.panEnd);
  }
  private panMove(event: PointerEvent): void {
    const { pan } = this;
    const scroll = this.scroll.current;
    if (pan === null || scroll === null) return;
    const dx = event.clientX - pan.pointerX;
    const dy = event.clientY - pan.pointerY;
    if (Math.abs(dx) + Math.abs(dy) >= 6) pan.moved = true;
    scroll.scrollLeft = pan.left - dx;
    scroll.scrollTop = pan.top - dy;
  }
  private panEnd(): void {
    window.removeEventListener("pointermove", this.panMove);
    window.removeEventListener("pointerup", this.panEnd);
    this.suppressClick = this.pan?.moved === true;
    this.pan = null;
    this.setState({ panning: false });
  }
  private wheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    if (this.state.overview || this.scroll.current === null) return;
    const target = event.target;
    if (!(target instanceof Node) || !this.scroll.current.contains(target))
      return;
    event.preventDefault();
    this.zoomTo(
      this.state.zoom *
        Math.exp(-Math.max(-20, Math.min(20, event.deltaY)) * 0.01),
      event.clientX,
      event.clientY,
    );
  }
  /** The point under the pointer stays in place, or the middle of the canvas. */
  private zoomTo(wanted: number, clientX?: number, clientY?: number): void {
    const scroll = this.scroll.current;
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, wanted));
    if (scroll === null) {
      this.setState({ zoom, fitted: false });
      return;
    }
    const box = scroll.getBoundingClientRect();
    const offsetX = (clientX ?? box.left + box.width / 2) - box.left;
    const offsetY = (clientY ?? box.top + box.height / 2) - box.top;
    const ratio = zoom / this.state.zoom;
    const left = (scroll.scrollLeft + offsetX) * ratio - offsetX;
    const top = (scroll.scrollTop + offsetY) * ratio - offsetY;
    this.setState({ zoom, fitted: false }, () => {
      scroll.scrollLeft = left;
      scroll.scrollTop = top;
    });
  }
  /** A step stays clear of the panel that it opened. The zoom does not change. */
  private revealSelected(): void {
    const scroll = this.scroll.current;
    const step = scroll?.querySelector(
      '.recipe-graph-node[aria-pressed="true"]',
    );
    if (scroll === null || step === null || step === undefined) return;
    const paneRight = scroll.getBoundingClientRect().right;
    const covered =
      step.getBoundingClientRect().right +
      PORT_ROOM -
      (paneRight - PANEL_ROOM);
    if (covered > 0) scroll.scrollLeft += covered;
  }
  private clickNode(node: RecipeGraphNode): void {
    if (this.state.open !== null || this.panning()) return;
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const { connecting, snapshot } = this.state;
    if (connecting === null) {
      this.setState({ selected: node.id });
      return;
    }
    const from = snapshot?.nodes.find(nodeMatches.bind(null, connecting));
    const to = snapshot?.nodes.find(nodeMatches.bind(null, node.id));
    this.setState({ connecting: null });
    if (from === undefined || to === undefined || from === to) return;
    if (from.workflow !== to.workflow) return;
    this.connect(from, to);
    this.changed();
  }
  private startConnect(id: string): void {
    if (this.state.open !== null) return;
    this.setState({ connecting: id });
  }
  private dragStart(
    node: RecipeGraphNode,
    event: React.PointerEvent<HTMLElement>,
  ): void {
    if (this.state.open !== null || this.panning()) return;
    const position = this.state.snapshot?.positions[node.id];
    if (
      position === undefined ||
      event.button !== 0 ||
      this.state.connection?.canEdit === false
    )
      return;
    const origin = this.graphOrigin();
    this.drag = {
      id: node.id,
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: position.x,
      y: position.y,
      left: origin.left,
      top: origin.top,
      moved: false,
    };
    window.addEventListener("pointermove", this.dragMove);
    window.addEventListener("pointerup", this.dragEnd);
  }
  private dragMove(event: PointerEvent): void {
    const scale = this.state.zoom;
    const drag = this.drag;
    const { snapshot } = this.state;
    if (drag === null || snapshot === null) return;
    const dx = event.clientX - drag.pointerX;
    const dy = event.clientY - drag.pointerY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
    drag.moved = true;
    // A centred graph moves when the step makes it grow, so the step follows the pointer.
    const origin = this.graphOrigin();
    this.setState({
      snapshot: {
        ...snapshot,
        positions: {
          ...snapshot.positions,
          [drag.id]: clampPosition(
            drag.x + (dx - (origin.left - drag.left)) / scale,
            drag.y + (dy - (origin.top - drag.top)) / scale,
          ),
        },
      },
    });
  }
  private graphOrigin(): Readonly<{ left: number; top: number }> {
    const content = this.scroll.current?.querySelector(".recipe-graph-content");
    const box = content?.getBoundingClientRect();
    return { left: box?.left ?? 0, top: box?.top ?? 0 };
  }
  private dragEnd(): void {
    const drag = this.drag;
    this.drag = null;
    window.removeEventListener("pointermove", this.dragMove);
    window.removeEventListener("pointerup", this.dragEnd);
    const position =
      drag === null ? undefined : this.state.snapshot?.positions[drag.id];
    if (drag === null || !drag.moved || position === undefined) return;
    this.suppressClick = true;
    this.doc?.movePosition(drag.id, position);
    this.client?.flush();
  }
  private async runDraft(): Promise<void> {
    const { load, open } = this.state;
    const compilation = open?.compilation ?? this.state.compilation;
    if (load.kind !== "ready" || compilation?.kind !== "ready") return;
    this.runHandle?.cancel();
    this.setState({ run: { kind: "running" } });
    const handle = runDraftComparison(
      load.value.applied.scenario,
      compilation.scenario,
      load.value.source.cells,
      this.state.review,
    );
    this.runHandle = handle;
    try {
      const comparison = await handle.result;
      if (!this.active || this.runHandle !== handle) return;
      this.setState({ run: { kind: "done", comparison } });
      this.recordFindings(load.value, comparison.applied.findings);
      const snapshot = open?.snapshot ?? this.state.snapshot;
      const binding = load.value.source.binding;
      if (snapshot !== null && binding !== null)
        this.props.planned?.(
          buildPlan.bind(
            null,
            binding,
            load.value.original,
            snapshot,
            skippedKeys(comparison.draft),
          ),
        );
    } catch (error) {
      if (!this.active || this.runHandle !== handle) return;
      this.setState({
        run: {
          kind: "failed",
          message: error instanceof Error ? error.message : "The run failed.",
        },
      });
    }
  }
  private recordFindings(
    loaded: Loaded,
    findings: readonly RunFinding[],
  ): void {
    const workspace = this.context;
    if (loaded.shared === null || workspace?.canManage !== true) return;
    // The comparison stands without this. The agent then reads the earlier run.
    recordRunFindings(
      workspace,
      loaded.shared.workflowId,
      loaded.shared.digest,
      findings,
    ).catch(ignoreFailure);
  }
  private selectedNode(): DraftNode | null {
    const { snapshot, selected } = this.state;
    return snapshot?.nodes.find(nodeMatches.bind(null, selected)) ?? null;
  }
  private chooseWorkflow(value: string | null): void {
    if (value === null) return;
    this.setState({
      overview: value === OVERVIEW,
      workflowFilter: value === "" || value === OVERVIEW ? null : value,
      zoom: 1,
      fitted: false,
    });
  }
  render(): React.ReactNode {
    const { load } = this.state;
    return (
      <div
        ref={this.root}
        className="recipe-graph"
        data-graph={load.kind}
        role="group"
        aria-label="Recipe prerequisites"
      >
        <h3>Prerequisites</h3>
        {load.kind === "waiting" && <p>Reading the recipe…</p>}
        {load.kind === "failed" && (
          <p role="alert">
            This view cannot show the prerequisites. {load.message}
          </p>
        )}
        {load.kind === "ready" &&
          this.state.snapshot !== null &&
          this.ready(load.value, this.state.snapshot)}
      </div>
    );
  }
  private ready(loaded: Loaded, draft: DraftSnapshot): React.ReactNode {
    const { open } = this.state;
    const snapshot = open?.snapshot ?? draft;
    const graph = recipeGraph(
      loaded.source,
      snapshot,
      this.state.workflowFilter,
    );
    const diff = workflowDiff(loaded.base, snapshot);
    const { run, connecting } = this.state;
    const compilation = open?.compilation ?? this.state.compilation;
    const problems: readonly DraftProblem[] =
      compilation?.kind === "refused" ? compilation.problems : [];
    const canRun = compilation?.kind === "ready" && run.kind !== "running";
    const canEdit = open === null && (this.state.connection?.canEdit ?? true);
    const changedDraft =
      diff.added.size + diff.changed.size + diff.removed.length > 0 ||
      diff.addedEdges.size + diff.removedEdges.length > 0;
    const canApply =
      loaded.shared !== null &&
      this.context?.canManage === true &&
      compilation?.kind === "ready" &&
      changedDraft &&
      this.state.apply.kind !== "applying";
    const chatPath = this.context?.chatPath;
    const panelOpen =
      open !== null || (this.state.selected !== null && !this.state.overview);
    return (
      <>
        <div
          ref={this.watchChrome}
          className="recipe-graph-canvas"
          data-panel={panelOpen}
          data-pan={this.panning()}
          data-panning={this.state.panning}
        >
          {this.state.overview
            ? this.overviewCanvas(loaded, snapshot, diff)
            : this.canvas(graph, snapshot, diff, problems, loaded)}
          <div
            className="recipe-graph-chrome"
            role="toolbar"
            aria-label="Draft tools"
          >
            <div className="recipe-graph-chrome-top">
              {loaded.shared !== null &&
                this.draftStatus(loaded.shared.revision)}
              <div className="recipe-graph-float">
                {loaded.document.workflows.length > 1 &&
                  loaded.source.binding === null && (
                    <label className="recipe-graph-filter">
                      Workflow
                      <GraphSelect
                        variant="ghost"
                        items={[
                          { value: OVERVIEW, label: "Overview" },
                          { value: "", label: "All" },
                          ...loaded.document.workflows.map(workflowChoice),
                        ]}
                        value={
                          this.state.overview
                            ? OVERVIEW
                            : (this.state.workflowFilter ?? "")
                        }
                        onValueChange={this.chooseWorkflow.bind(this)}
                      />
                    </label>
                  )}
                <label className="recipe-graph-filter recipe-graph-run">
                  Reviews
                  <GraphSelect
                    variant="ghost"
                    items={[
                      { value: "accept", label: "Accept" },
                      { value: "reject", label: "Reject" },
                    ]}
                    value={this.state.review}
                    onValueChange={this.chooseReview.bind(this)}
                  />
                </label>
                <button
                  type="button"
                  className="recipe-graph-run-draft"
                  disabled={!canRun}
                  onClick={this.runDraft.bind(this)}
                >
                  <Play size={14} aria-hidden="true" />
                  {run.kind === "running"
                    ? "Running…"
                    : open === null
                      ? "Run draft"
                      : "Run proposal"}
                </button>
                {loaded.shared !== null && (
                  <button
                    type="button"
                    className="recipe-graph-primary"
                    disabled={!canApply || open !== null}
                    onClick={this.applyDraft.bind(this)}
                  >
                    Apply
                  </button>
                )}
              </div>
            </div>
            <div className="recipe-graph-chrome-row">
              <div className="recipe-graph-chrome-start">
                {!this.state.overview && (
                  <div className="recipe-graph-float">
                    <button
                      type="button"
                      aria-label="Zoom out"
                      disabled={this.state.zoom <= ZOOM_MIN}
                      onClick={this.zoomBy.bind(this, -ZOOM_STEP)}
                    >
                      <Minus size={16} aria-hidden="true" />
                    </button>
                    <output aria-label="Zoom">
                      {Math.round(this.state.zoom * 100)}%
                    </output>
                    <button
                      type="button"
                      aria-label="Zoom in"
                      disabled={this.state.zoom >= ZOOM_MAX}
                      onClick={this.zoomBy.bind(this, ZOOM_STEP)}
                    >
                      <Plus size={16} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-pressed={this.state.fitted}
                      onClick={this.toggleFit.bind(this, graph)}
                    >
                      Fit
                    </button>
                  </div>
                )}
              </div>
              <div className="recipe-graph-dock">
                <div className="recipe-graph-float">
                  <button
                    type="button"
                    className="recipe-graph-tool"
                    aria-label="Select"
                    aria-pressed={this.state.tool === "select"}
                    onClick={this.chooseTool.bind(this, "select")}
                  >
                    <MousePointer2 size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="recipe-graph-tool"
                    aria-label="Pan"
                    aria-pressed={this.state.tool === "pan"}
                    onClick={this.chooseTool.bind(this, "pan")}
                  >
                    <Hand size={16} aria-hidden="true" />
                  </button>
                  <span className="recipe-graph-divider" />
                  <button
                    type="button"
                    className="recipe-graph-add"
                    data-kind="work"
                    disabled={!canEdit}
                    onClick={this.addStep.bind(this, "work")}
                  >
                    <User size={16} aria-hidden="true" />
                    Add step
                  </button>
                  <button
                    type="button"
                    className="recipe-graph-add"
                    data-kind="process"
                    disabled={!canEdit}
                    onClick={this.addStep.bind(this, "wait")}
                  >
                    <Timer size={16} aria-hidden="true" />
                    Add wait
                  </button>
                  <button
                    type="button"
                    className="recipe-graph-add"
                    data-kind="check"
                    disabled={!canEdit}
                    onClick={this.addStep.bind(this, "decision")}
                  >
                    <GitBranch size={16} aria-hidden="true" />
                    Add decision
                  </button>
                  <span className="recipe-graph-divider" />
                  <button
                    type="button"
                    aria-label="Undo"
                    title="Undo"
                    disabled={!canEdit || this.doc?.canUndo() !== true}
                    onClick={this.undo.bind(this)}
                  >
                    <Undo2 size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label="Redo"
                    title="Redo"
                    disabled={!canEdit || this.doc?.canRedo() !== true}
                    onClick={this.redo.bind(this)}
                  >
                    <Redo2 size={16} aria-hidden="true" />
                  </button>
                </div>
                {open === null &&
                  chatPath !== undefined &&
                  loaded.shared !== null && (
                    <AgentComposer
                      chatPath={chatPath}
                      workflowId={loaded.shared.workflowId}
                    />
                  )}
              </div>
              <div className="recipe-graph-chrome-end" />
            </div>
          </div>
          <div className="recipe-graph-notices">
            {this.state.apply.kind === "failed" && (
              <p role="alert">{this.state.apply.message}</p>
            )}
            {this.state.proposalMessage !== null && (
              <p role="status" aria-label="Proposal result">
                {this.state.proposalMessage}
              </p>
            )}
            {open === null && this.proposalList()}
            {connecting !== null && (
              <p className="recipe-graph-hint" role="status">
                Select the step that needs this step. Press Escape to stop.
              </p>
            )}
            {problems.length > 0 && (
              <div
                className="recipe-graph-problems"
                role="alert"
                aria-label="Draft problems"
              >
                <strong>This draft cannot run.</strong>
                <ul>{problems.map(problemItem)}</ul>
              </div>
            )}
            {diff.removed.length > 0 && (
              <p className="recipe-graph-removed">
                Removed: {diff.removed.map(removedLabel).join(", ")}
              </p>
            )}
            {run.kind === "failed" && <p role="alert">{run.message}</p>}
          </div>
        </div>
        {run.kind === "done" && this.comparison(run.comparison, graph, diff)}
        {open !== null && this.proposalReview(loaded, open, run)}
        {open === null &&
          !this.state.overview &&
          this.drawer(loaded, snapshot, graph)}
      </>
    );
  }
  /** The words stay whole for assistive technology; the bar shows the short form. */
  private draftStatus(revision: number): React.ReactNode {
    const { connection, apply } = this.state;
    const people = connection?.participants.length ?? 0;
    return (
      <p
        className="recipe-graph-float recipe-graph-status"
        role="status"
        aria-label="Draft status"
        data-draft-status={connection?.status ?? "connecting"}
      >
        <span className="recipe-graph-live" aria-hidden="true" />
        <span>
          <strong>Revision {revision}.</strong>{" "}
          {connection?.message ?? "Connecting the draft…"}
          {apply.kind === "applied" && ` Applied revision ${apply.revision}.`}
        </span>
        {people > 1 && (
          <>
            <span className="recipe-graph-divider" />
            <span className="recipe-graph-people">
              <Users size={14} aria-hidden="true" /> {people} people
              <span className="recipe-graph-hidden"> on this draft.</span>
            </span>
          </>
        )}
      </p>
    );
  }
  /**
   * The workspace bars float over the canvas. Their sizes place the stages, the
   * notices and the tools, and they keep the first and the last row of steps clear.
   */
  private watchChrome(canvas: HTMLDivElement | null): void {
    this.chromeSize?.disconnect();
    this.chromeParts?.disconnect();
    this.chromeSize = null;
    this.chromeParts = null;
    if (canvas === null) return;
    const workspace =
      canvas.closest<HTMLElement>(".persistent-production") ?? canvas;
    const parts = (): ChromeParts => ({
      header: workspace.querySelector(":scope > header.factory-toolbar"),
      stages:
        canvas.closest(".recipe-workflow")?.querySelector(":scope > ol") ??
        null,
      summary: workspace.querySelector(":scope > .factory-summary"),
      footer: workspace.querySelector(":scope > footer.factory-bottom"),
      end: canvas.querySelector(".recipe-graph-chrome-top"),
      notices: canvas.querySelector(":scope > .recipe-graph-notices"),
      tools: canvas.querySelector(".recipe-graph-chrome-row"),
      result:
        canvas.parentElement?.querySelector(
          ":scope > .recipe-graph-comparison",
        ) ?? null,
    });
    const place = (): void => {
      const paneWidth = canvas.offsetWidth || workspace.offsetWidth;
      for (const [name, value] of chromeOffsets(
        parts(),
        paneWidth,
        workspace.offsetWidth,
      ))
        workspace.style.setProperty(name, `${value}px`);
    };
    const size = new ResizeObserver(place);
    // The summary and the comparison come and go with each run.
    const observe = (): void => {
      size.disconnect();
      size.observe(workspace);
      size.observe(canvas);
      for (const part of Object.values(parts()))
        if (part !== null) size.observe(part);
      place();
    };
    this.chromeSize = size;
    this.chromeParts = new MutationObserver(observe);
    this.chromeParts.observe(workspace, { childList: true });
    if (canvas.parentElement !== null)
      this.chromeParts.observe(canvas.parentElement, { childList: true });
    observe();
  }
  private zoomBy(change: number): void {
    this.zoomTo(this.state.zoom + change);
  }
  /** A person selects this and sends the words. No turn starts by itself. */
  private askAgentButton(comparison: DraftComparison): React.ReactNode {
    const chatPath = this.context?.chatPath;
    const { findings } = comparison.applied;
    if (
      chatPath === undefined ||
      this.state.open !== null ||
      findings.length === 0
    )
      return null;
    const { load } = this.state;
    const workflowId =
      load.kind === "ready" ? (load.value.shared?.workflowId ?? null) : null;
    if (workflowId === null) return null;
    const words = `Read the recipe workflow ${workflowId} and the findings of its last run, and propose a change. It went wrong here: ${findings
      .slice(0, 5)
      .map(findingText)
      .join(" ")}`;
    return (
      <button
        type="button"
        onClick={askAgentInChat.bind(null, chatPath, words)}
      >
        Ask the agent
      </button>
    );
  }
  private proposalList(): React.ReactNode {
    const { proposals } = this.state;
    if (proposals.length === 0) return null;
    return (
      <section className="recipe-proposal" aria-label="Agent proposals">
        <h4>The agent proposes a change</h4>
        <ul>{proposals.map(this.proposalEntry.bind(this))}</ul>
      </section>
    );
  }
  private proposalEntry(proposal: WorkflowProposal): React.ReactNode {
    return (
      <li key={proposal.draftId}>
        <span>{proposal.reason}</span>
        <button type="button" onClick={this.openProposal.bind(this, proposal)}>
          Review
        </button>
      </li>
    );
  }
  /** Words about the change come from the diff, and numbers from the comparison. */
  private proposalReview(
    loaded: Loaded,
    open: OpenProposal,
    run: RunState,
  ): React.ReactNode {
    const { proposal } = open;
    const change = proposalChangeSummary(loaded.base, open.snapshot);
    const canDecide = this.context?.canManage === true && !this.state.deciding;
    return (
      <section
        className="recipe-graph-drawer recipe-proposal"
        aria-label="Agent proposal"
      >
        <header>
          <span className="recipe-graph-agent" aria-hidden="true">
            <Sparkles size={16} />
          </span>
          <div>
            <h4>The agent proposes a change</h4>
            <small>Waits for your review</small>
          </div>
        </header>
        <p data-proposal="reason">{proposal.reason}</p>
        {proposal.findings.length > 0 && (
          <>
            <h5>What went wrong</h5>
            <ul data-proposal="findings">
              {proposal.findings.map(findingItem)}
            </ul>
          </>
        )}
        <h5>What changed</h5>
        <ul data-proposal="changes">
          {change.added.map(changeItem.bind(null, "Added"))}
          {change.changed.map(changeItem.bind(null, "Changed"))}
          {change.removed.map(changeItem.bind(null, "Removed"))}
          {change.arrows > 0 && <li>Wires changed: {change.arrows}</li>}
        </ul>
        <p data-proposal="simulated">
          {run.kind === "done"
            ? simulatedText(run.comparison)
            : run.kind === "running"
              ? "The comparison runs now."
              : "Not simulated yet. Select Run proposal to compare it with the applied recipe."}
        </p>
        <div className="recipe-proposal-actions">
          <button
            type="button"
            className="recipe-graph-primary"
            disabled={!canDecide}
            onClick={this.decide.bind(this, "approve")}
          >
            Approve
          </button>
          <button
            type="button"
            disabled={!canDecide}
            onClick={this.decide.bind(this, "decline")}
          >
            Decline
          </button>
          <button type="button" onClick={this.closeProposal.bind(this)}>
            Close
          </button>
        </div>
      </section>
    );
  }
  private comparison(
    comparison: DraftComparison,
    graph: RecipeGraph,
    diff: WorkflowDiff,
  ): React.ReactNode {
    const { applied, draft } = comparison;
    const difference = draft.endSeconds - applied.endSeconds;
    const logistics = draft.logistics;
    const shown = this.state.open === null ? "draft" : "proposal";
    return (
      <section
        className="recipe-graph-comparison"
        aria-label="Draft comparison"
      >
        <header>
          <h4>Simulated comparison</h4>
          {this.state.open === null && (
            <button
              type="button"
              aria-label="Close comparison"
              onClick={this.closeComparison.bind(this)}
            >
              ×
            </button>
          )}
        </header>
        <table>
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">Applied</th>
              <th scope="col">
                {this.state.open === null ? "Draft" : "Proposal"}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Run</th>
              <td data-result="applied-status">{applied.status}</td>
              <td data-result="draft-status">{draft.status}</td>
            </tr>
            <tr>
              <th scope="row">End</th>
              <td data-result="applied-end">
                {applied.endSeconds.toFixed(1)} s
              </td>
              <td data-result="draft-end">{draft.endSeconds.toFixed(1)} s</td>
            </tr>
            <tr>
              <th scope="row">Steps done</th>
              <td data-result="applied-tasks">{applied.completedTasks}</td>
              <td data-result="draft-tasks">{draft.completedTasks}</td>
            </tr>
            {applied.orders + draft.orders > 0 && (
              <tr>
                <th scope="row">Late orders</th>
                <td data-result="applied-late">{applied.lateOrders}</td>
                <td data-result="draft-late">{draft.lateOrders}</td>
              </tr>
            )}
          </tbody>
        </table>
        <p>
          {difference === 0
            ? `The ${shown} ends at the same time.`
            : `The ${shown} ends ${Math.abs(difference).toFixed(1)} s ${difference > 0 ? "later" : "sooner"}.`}{" "}
          Each review {this.state.review === "accept" ? "accepts" : "rejects"}{" "}
          in this comparison.
        </p>
        {this.askAgentButton(comparison)}
        {logistics.kind === "available" &&
          taskTimeline(
            logistics.tasks,
            draft.endSeconds * 1_000_000,
            this.state.open === null ? "Draft" : "Proposal",
            graph,
            diff,
          )}
      </section>
    );
  }
  /** A proposal keeps its comparison, because its review reads the result. */
  private closeComparison(): void {
    this.setState({ run: { kind: "idle" } });
  }
  private toggleFit(graph: RecipeGraph): void {
    if (this.state.fitted) {
      this.setState({ zoom: 1, fitted: false });
      return;
    }
    let width = NODE_COLUMN;
    let height = NODE_ROW;
    for (const node of graph.nodes) {
      width = Math.max(width, node.x + NODE_COLUMN);
      height = Math.max(height, node.y + NODE_ROW);
    }
    const scroll = this.scroll.current;
    if (scroll === null) return;
    const style = getComputedStyle(scroll);
    const roomX =
      scroll.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    const roomY =
      scroll.clientHeight -
      parseFloat(style.paddingTop) -
      parseFloat(style.paddingBottom);
    const zoom = Math.max(ZOOM_MIN, Math.min(1, roomX / width, roomY / height));
    this.setState({ zoom, fitted: true }, () => {
      scroll.scrollLeft = 0;
      scroll.scrollTop = 0;
    });
  }
  /** One node for each workflow. A click opens that workflow's steps. */
  private overviewCanvas(
    loaded: Loaded,
    snapshot: DraftSnapshot,
    diff: WorkflowDiff,
  ): React.ReactNode {
    const changed = new Set<string>([...diff.added, ...diff.changed]);
    const overview = recipeOverview(loaded.document, snapshot, changed);
    let width = NODE_COLUMN;
    let height = NODE_ROW;
    const places = new Map<string, RecipeOverviewNode>();
    for (const node of overview.nodes) {
      places.set(node.id, node);
      width = Math.max(width, node.x + NODE_COLUMN);
      height = Math.max(height, node.y + NODE_ROW);
    }
    return (
      <div
        ref={this.scroll}
        className="recipe-graph-scroll"
        tabIndex={0}
        aria-label="Workflow overview"
        onPointerDown={this.panStart.bind(this)}
      >
        <div className="recipe-graph-content" style={{ width, height }}>
          <svg width={width} height={height} aria-hidden="true">
            {overview.edges.map(overviewEdge.bind(null, places))}
          </svg>
          {overview.nodes.map(this.overviewCard.bind(this, overview.edges))}
        </div>
      </div>
    );
  }
  private overviewCard(
    edges: readonly Readonly<{ from: string; to: string }>[],
    node: RecipeOverviewNode,
  ): React.ReactNode {
    return (
      <div
        key={node.id}
        className="recipe-graph-node-frame"
        style={{ left: node.x, top: node.y, width: WIDTH, height: HEIGHT }}
      >
        <span className="recipe-graph-label" aria-hidden="true">
          <span>
            {portIcon("workflow", 11)}
            Workflow
          </span>
        </span>
        {edges.some(edgeEndsAt.bind(null, node.id)) && port("in", "workflow")}
        {edges.some(edgeStartsAt.bind(null, node.id)) &&
          port("out", "workflow")}
        <button
          type="button"
          className="recipe-graph-node"
          data-graph-workflow={node.id}
          data-state="waiting"
          onClick={this.openWorkflow.bind(this, node.id)}
        >
          {kindIcon("workflow")}
          <strong>{node.label}</strong>
          <span className="recipe-graph-line">
            {node.steps === 1 ? "1 step" : `${node.steps} steps`}
            {node.changed > 0 && (
              <em className="recipe-graph-badge">{node.changed} changed</em>
            )}
          </span>
        </button>
      </div>
    );
  }
  private openWorkflow(id: string): void {
    this.setState({
      overview: false,
      workflowFilter: id,
      zoom: 1,
      fitted: false,
    });
  }
  private canvas(
    graph: RecipeGraph,
    snapshot: DraftSnapshot,
    diff: WorkflowDiff,
    problems: readonly DraftProblem[],
    loaded: Loaded,
  ): React.ReactNode {
    const approved =
      this.state.open === null && loaded.replaced !== null
        ? workflowDiff(loaded.replaced, loaded.base)
        : null;
    const scale = this.state.zoom;
    let width = NODE_COLUMN;
    let height = NODE_ROW;
    const nodes = new Map<string, RecipeGraphNode>();
    for (const node of graph.nodes) {
      nodes.set(node.id, node);
      width = Math.max(width, node.x + NODE_COLUMN);
      height = Math.max(height, node.y + NODE_ROW);
    }
    const steps = new Map<string, DraftNode>();
    for (const step of snapshot.nodes)
      steps.set(draftNodeId(step.workflow, step.key), step);
    return (
      <div
        ref={this.scroll}
        className="recipe-graph-scroll"
        tabIndex={0}
        aria-label="Step graph"
        onPointerDown={this.panStart.bind(this)}
      >
        <div
          className="recipe-graph-sizer"
          style={{ width: width * scale, height: height * scale }}
        >
          <div
            className="recipe-graph-content"
            style={{
              width,
              height,
              transform: scale === 1 ? undefined : `scale(${scale})`,
            }}
          >
            <svg width={width} height={height} aria-hidden="true">
              {graph.edges.map(edgePath.bind(null, nodes))}
            </svg>
            {graph.nodes.map(
              this.nodeCard.bind(
                this,
                nodes,
                steps,
                graph,
                diff,
                problems,
                approved,
              ),
            )}
          </div>
        </div>
      </div>
    );
  }
  private nodeCard(
    nodes: ReadonlyMap<string, RecipeGraphNode>,
    steps: ReadonlyMap<string, DraftNode>,
    graph: RecipeGraph,
    diff: WorkflowDiff,
    problems: readonly DraftProblem[],
    approved: WorkflowDiff | null,
    node: RecipeGraphNode,
  ): React.ReactNode {
    const stages = this.props.stages.filter(stageMatches.bind(null, node));
    const shown = nodeState(stages);
    const needs: string[] = [];
    for (const edge of graph.edges)
      if (edge.to === node.id)
        needs.push(nodes.get(edge.from)?.label ?? edge.from);
    const needsText = needs.join(", ") || "nothing";
    const change = diff.added.has(node.id)
      ? "Added"
      : diff.changed.has(node.id)
        ? "Changed"
        : null;
    // A badge from the last approved proposal stays until the next revision.
    const approvedChange =
      change !== null || approved === null
        ? null
        : approved.added.has(node.id)
          ? "Added"
          : approved.changed.has(node.id)
            ? "Changed"
            : null;
    const selected = this.state.selected === node.id;
    const skipped = this.skippedInComparison(node);
    const incoming = graph.edges.find(edgeEndsAt.bind(null, node.id));
    const step = steps.get(node.id);
    const seconds = step === undefined ? null : stepSeconds(step.body);
    const doer = step === undefined ? "" : stepDoer(step.body);
    return (
      <div
        key={node.id}
        className="recipe-graph-node-frame"
        data-review={
          this.state.open === null
            ? undefined
            : change === null
              ? "unchanged"
              : "changed"
        }
        style={{ left: node.x, top: node.y, width: WIDTH, height: HEIGHT }}
      >
        <span className="recipe-graph-label" aria-hidden="true">
          <span>
            {portIcon(node.role, 11)}
            {roleLabel(node.role)}
          </span>
          {doer !== "" && <span>{doer}</span>}
        </span>
        {incoming !== undefined && port("in", edgeKind(nodes, incoming))}
        <button
          type="button"
          className="recipe-graph-node"
          data-graph-node={node.key}
          data-state={shown.state}
          data-role={node.role}
          data-change={change ?? undefined}
          data-approved={approvedChange ?? undefined}
          data-run={skipped ? "skipped" : undefined}
          data-problem={
            problems.some(problemIsAt.bind(null, node.id)) ? "true" : undefined
          }
          aria-pressed={selected}
          aria-label={`${node.label}. ${roleLabel(node.role)}${doer === "" ? "" : ` by ${doer}`}${seconds === null ? "" : `, ${secondsText(seconds)}`}. ${shown.stateLabel}. ${change ?? approvedChange ?? ""}. Needs ${needsText}.`}
          title={`${node.label}. Needs ${needsText}`}
          onClick={this.clickNode.bind(this, node)}
          onPointerDown={this.dragStart.bind(this, node)}
        >
          {kindIcon(node.role)}
          <strong>{node.label}</strong>
          <span className="recipe-graph-line">
            <span className="recipe-graph-meta">
              {seconds === null ? "" : secondsText(seconds)}
              {shown.state === "not-started" || shown.stateLabel === "" ? (
                ""
              ) : (
                <>
                  {seconds === null ? "" : " · "}
                  <b>{shown.stateLabel}</b>
                </>
              )}
            </span>
            {skipped ? (
              <em className="recipe-graph-badge">Skipped</em>
            ) : (
              (change ?? approvedChange) !== null && (
                <em className="recipe-graph-badge">
                  {change ?? approvedChange}
                </em>
              )
            )}
          </span>
          <small className="recipe-graph-needs">Needs {needsText}</small>
          {stateMark(shown.state)}
        </button>
        {graph.edges.some(edgeStartsAt.bind(null, node.id)) &&
          port("out", node.role)}
        <button
          type="button"
          className="recipe-graph-connect"
          aria-label={`Connect ${node.label} to a step that needs it`}
          title="Connect to a step that needs this one"
          data-active={this.state.connecting === node.id}
          onClick={this.startConnect.bind(this, node.id)}
        >
          <Plus size={12} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </div>
    );
  }
  /** The last comparison skipped this step in each of its instances. */
  private skippedInComparison(node: RecipeGraphNode): boolean {
    const { run } = this.state;
    if (
      run.kind !== "done" ||
      run.comparison.draft.logistics.kind !== "available"
    )
      return false;
    let seen = false;
    for (const task of run.comparison.draft.logistics.tasks) {
      if (task.subject.kind !== "workflow" || task.subject.key !== node.key)
        continue;
      if (task.kind !== "skipped") return false;
      seen = true;
    }
    return seen;
  }
  private drawer(
    loaded: Loaded,
    snapshot: DraftSnapshot,
    graph: RecipeGraph,
  ): React.ReactNode {
    const node = this.selectedNode();
    if (node === null) return null;
    const id = draftNodeId(node.workflow, node.key);
    const shown = graph.nodes.find(graphNodeMatches.bind(null, id));
    const seconds = stepSeconds(node.body);
    const workers = stepWorkers(node.body);
    const peers: RecipeGraphNode[] = [];
    for (const item of graph.nodes)
      if (item.workflow === node.workflow && item.id !== id) peers.push(item);
    const stage = this.props.stages.find(
      stageMatches.bind(null, shown ?? { stages: [] }),
    );
    const canEdit = this.state.connection?.canEdit ?? true;
    const allWorkers: string[] = [];
    for (const resource of loaded.document.world.resources)
      if (resource.kind === "worker") allWorkers.push(resource.id);
    const shownState =
      shown === undefined
        ? null
        : nodeState(this.props.stages.filter(stageMatches.bind(null, shown)));
    return (
      <aside className="recipe-graph-drawer" aria-label="Step details">
        <header>
          {shown !== undefined && kindIcon(shown.role)}
          <div>
            <h4>{node.label}</h4>
            {shown !== undefined && (
              <small data-state={shownState?.state}>
                {roleLabel(shown.role)}
                {shownState === null || shownState.stateLabel === ""
                  ? ""
                  : ` · ${shownState.stateLabel}`}
              </small>
            )}
          </div>
          <button
            type="button"
            className="recipe-graph-close"
            aria-label="Close step details"
            onClick={this.closeDrawer}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        {canEdit ? null : <p>You can read this draft. You cannot change it.</p>}
        <label>
          Name
          <input
            key={`label-${id}-${node.label}`}
            defaultValue={node.label}
            disabled={!canEdit}
            maxLength={DRAFT_LABEL_LIMIT}
            onBlur={this.commitLabel.bind(this)}
          />
        </label>
        {seconds === null ? (
          <p>The engine measures this step, so its time cannot be set here.</p>
        ) : (
          <label>
            Seconds
            <input
              key={`seconds-${id}-${seconds}`}
              type="number"
              min="0.002"
              step="any"
              defaultValue={seconds}
              disabled={!canEdit}
              onBlur={this.commitSeconds.bind(this)}
            />
          </label>
        )}
        {workers !== null && (
          <fieldset disabled={!canEdit}>
            <legend>Who can do it</legend>
            {allWorkers.map(this.workerOption.bind(this, workers))}
          </fieldset>
        )}
        {stepExecutorKind(node.body) === "inspection" &&
          this.ruleFields(snapshot, node, canEdit)}
        {this.machineFields(loaded, snapshot, node, canEdit)}
        {this.placeFields(loaded, snapshot, node, canEdit)}
        {this.orderFields(id, node, canEdit)}
        <fieldset disabled={!canEdit}>
          <legend>This step needs</legend>
          {peers.length === 0 && <p>No other step in this workflow.</p>}
          {peers.map(this.prerequisiteOption.bind(this, snapshot, node))}
        </fieldset>
        <div className="recipe-graph-drawer-actions">
          {stage !== undefined && (
            <button
              type="button"
              disabled={!stage.reached}
              onClick={this.props.seek.bind(null, stage.startS)}
            >
              Go to this step
            </button>
          )}
          <button
            type="button"
            className="recipe-graph-danger"
            disabled={!canEdit}
            onClick={this.removeSelected.bind(this)}
          >
            Remove step
          </button>
        </div>
      </aside>
    );
  }
  /** A machine program, or a skill of a native cell. Pairing and the cell stay locked. */
  private machineFields(
    loaded: Loaded,
    snapshot: DraftSnapshot,
    node: DraftNode,
    canEdit: boolean,
  ): React.ReactNode {
    const program = stepProgram(loaded.document, node.body);
    const skill = stepSkill(snapshot, node.body);
    return (
      <>
        {program !== null && (
          <label>
            Program
            <GraphSelect
              items={program.programs.map(graphChoice)}
              value={program.program}
              disabled={!canEdit}
              onValueChange={this.chooseProgram.bind(this)}
            />
          </label>
        )}
        {skill !== null && (
          <label>
            Skill
            <GraphSelect
              items={skill.skills.map(graphChoice)}
              value={skill.skill}
              disabled={!canEdit}
              onValueChange={this.chooseSkill.bind(this, snapshot)}
            />
          </label>
        )}
      </>
    );
  }
  private placeFields(
    loaded: Loaded,
    snapshot: DraftSnapshot,
    node: DraftNode,
    canEdit: boolean,
  ): React.ReactNode {
    const places = stepPlaces(node.body);
    if (places === null) return null;
    const known = knownPlaces(loaded.document, snapshot);
    return (
      <>
        <label>
          Starts at
          <GraphSelect
            items={known.map(graphChoice)}
            value={places.start}
            disabled={!canEdit}
            onValueChange={this.choosePlace.bind(this, "start", places)}
          />
        </label>
        <label>
          Finishes at
          <GraphSelect
            items={known.map(graphChoice)}
            value={places.finish}
            disabled={!canEdit}
            onValueChange={this.choosePlace.bind(this, "finish", places)}
          />
        </label>
      </>
    );
  }
  private orderFields(
    id: string,
    node: DraftNode,
    canEdit: boolean,
  ): React.ReactNode {
    const ordering = stepOrdering(node.body);
    return (
      <>
        <label>
          Priority
          <input
            key={`priority-${id}-${ordering.priority}`}
            type="number"
            step="1"
            defaultValue={ordering.priority}
            disabled={!canEdit}
            onBlur={this.commitOrdering.bind(this, "priority")}
          />
        </label>
        <label>
          Earliest start, seconds
          <input
            key={`earliest-${id}-${ordering.earliestSeconds}`}
            type="number"
            min="0"
            step="any"
            defaultValue={ordering.earliestSeconds}
            disabled={!canEdit}
            onBlur={this.commitOrdering.bind(this, "earliestSeconds")}
          />
        </label>
      </>
    );
  }
  private ruleFields(
    snapshot: DraftSnapshot,
    node: DraftNode,
    canEdit: boolean,
  ): React.ReactNode {
    const rule = decisionRuleOf(node.body);
    const lots = measuredLots(snapshot, node.workflow);
    return (
      <>
        <label>
          Who decides
          <GraphSelect
            items={[
              { value: "person", label: "A person, and the run waits" },
              { value: "scripted", label: "A script, for a what-if run" },
              {
                value: "measurement",
                label: "A measured value",
                disabled: lots.length === 0,
              },
            ]}
            value={rule.kind}
            disabled={!canEdit}
            onValueChange={this.setRuleKind.bind(this)}
          />
        </label>
        {rule.kind === "scripted" && (
          <label>
            Outcome of each arrival
            <input
              key={`script-${rule.outcomes.join()}`}
              defaultValue={rule.outcomes.join(", ")}
              disabled={!canEdit}
              onBlur={this.commitScript.bind(this)}
            />
          </label>
        )}
        {rule.kind === "measurement" && (
          <div
            className="recipe-graph-range"
            onBlur={this.commitRange.bind(this)}
          >
            <label>
              Measured lot
              <GraphSelect
                name="lot"
                items={lots.map(graphChoice)}
                defaultValue={rule.lot}
                disabled={!canEdit}
              />
            </label>
            <label>
              Accept from
              <input
                type="number"
                step="any"
                defaultValue={rule.minimum}
                disabled={!canEdit}
              />
            </label>
            <label>
              Accept to
              <input
                type="number"
                step="any"
                defaultValue={rule.maximum}
                disabled={!canEdit}
              />
            </label>
          </div>
        )}
      </>
    );
  }
  private workerOption(
    workers: readonly string[],
    worker: string,
  ): React.ReactNode {
    return (
      <label key={worker}>
        <input
          type="checkbox"
          checked={workers.includes(worker)}
          onChange={this.toggleWorker.bind(this, worker)}
        />
        {worker}
      </label>
    );
  }
  private prerequisiteOption(
    snapshot: DraftSnapshot,
    node: DraftNode,
    peer: RecipeGraphNode,
  ): React.ReactNode {
    const from = snapshot.nodes.find(nodeMatches.bind(null, peer.id));
    if (from === undefined) return null;
    const connected = hasEdge(snapshot, node.workflow, peer.key, node.key);
    const edge = snapshot.edges.find(
      (item) =>
        item.workflow === node.workflow &&
        item.from === peer.key &&
        item.to === node.key,
    );
    return (
      <React.Fragment key={peer.id}>
        <label>
          <input
            type="checkbox"
            checked={connected}
            onChange={this.togglePrerequisite.bind(this, from)}
          />
          {peer.label}
        </label>
        {connected && stepExecutorKind(from.body) === "inspection" && (
          <label className="recipe-graph-branch">
            Runs
            <GraphSelect
              aria-label={`When ${node.label} runs after ${peer.label}`}
              items={[
                { value: "always", label: "Always" },
                { value: "accept", label: "If accepted" },
                { value: "reject", label: "If rejected" },
              ]}
              value={edge?.branch ?? "always"}
              onValueChange={this.setBranch.bind(this, from)}
            />
          </label>
        )}
      </React.Fragment>
    );
  }
}

/** The words go to the chat as a draft. A person reads them there and sends them. */
function AgentComposer(
  props: Readonly<{ chatPath: string; workflowId: string }>,
): React.ReactNode {
  const [words, setWords] = React.useState("");
  const [example, setExample] = React.useState(0);
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setExample((value) => (value + 1) % COMPOSER_EXAMPLES.length);
    }, COMPOSER_EXAMPLE_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  const asked = words.trim();
  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (asked === "") return;
    askAgentInChat(
      props.chatPath,
      `Read the recipe workflow ${props.workflowId}, and propose a change. ${asked}`,
    );
  }
  return (
    <form
      className="recipe-graph-float recipe-graph-composer"
      onSubmit={submit}
    >
      <Sparkles size={16} aria-hidden="true" />
      <input
        aria-label="Tell the agent what to change"
        placeholder={COMPOSER_EXAMPLES[example]}
        value={words}
        onChange={(event) => {
          setWords(event.currentTarget.value);
        }}
      />
      <button
        type="submit"
        aria-label="Continue in chat"
        disabled={asked === ""}
      >
        <ArrowUp size={16} aria-hidden="true" />
      </button>
    </form>
  );
}

function buildPlan(
  binding: NonNullable<RecipeSource["binding"]>,
  base: DraftSnapshot,
  snapshot: DraftSnapshot,
  skipped: ReadonlySet<string>,
  stages: Parameters<AnimationPlanBuilder>[0],
): ReturnType<AnimationPlanBuilder> {
  return animationPlan(stages, binding, base, snapshot, skipped);
}

/**
 * One lane for each task that ran, named by its step. A task of a step that the
 * draft added takes the accent, so the reader finds the change on the timeline.
 */
function taskTimeline(
  tasks: readonly TaskView[],
  end: number,
  run: "Draft" | "Proposal",
  graph: RecipeGraph,
  diff: WorkflowDiff,
): React.ReactNode {
  const steps = new Map<string, RecipeGraphNode>();
  for (const node of graph.nodes) steps.set(node.key, node);
  const horizon = Math.max(end, 1);
  const rows: React.ReactNode[] = [];
  for (const task of tasks) {
    const spans = taskSpans(task, end);
    if (spans.length === 0) continue;
    const step =
      task.subject.kind === "workflow"
        ? steps.get(task.subject.key)
        : undefined;
    const name = step?.label ?? task.id;
    rows.push(
      <li
        key={task.id}
        data-timeline-task={task.id}
        data-added={step !== undefined && diff.added.has(step.id)}
      >
        <span title={task.id}>{name}</span>
        <span className="recipe-graph-lane">
          {spans.map(timelineBar.bind(null, name, horizon, step))}
        </span>
      </li>,
    );
  }
  return (
    <section aria-label="Task timeline">
      <header>
        <h3>Task timeline</h3>
        <span>
          {run} · 0–{Number(seconds(end)).toFixed(1)} s
        </span>
      </header>
      <ol className="recipe-graph-timeline">{rows}</ol>
    </section>
  );
}

function timelineBar(
  name: string,
  horizon: number,
  step: RecipeGraphNode | undefined,
  span: Span,
): React.ReactNode {
  const from = Number(seconds(span.start)).toFixed(1);
  const to = Number(seconds(span.end)).toFixed(1);
  return (
    <span
      key={span.phase}
      className="recipe-graph-bar"
      data-kind={step?.role ?? "work"}
      data-phase={span.phase}
      title={`${name}: ${span.phase} ${from}–${to} s`}
      style={{
        insetInlineStart: `${(span.start / horizon) * 100}%`,
        width: `${((span.end - span.start) / horizon) * 100}%`,
      }}
    >
      <span className="recipe-graph-hidden">
        {span.phase} {from}–{to} s
      </span>
    </span>
  );
}

/** Steps that a decision skipped in every instance of the run. */
function skippedKeys(run: DraftComparison["draft"]): ReadonlySet<string> {
  const skipped = new Set<string>();
  const ran = new Set<string>();
  if (run.logistics.kind === "available")
    for (const task of run.logistics.tasks) {
      if (task.subject.kind !== "workflow") continue;
      (task.kind === "skipped" ? skipped : ran).add(task.subject.key);
    }
  for (const key of ran) skipped.delete(key);
  return skipped;
}

function overviewEdge(
  places: ReadonlyMap<string, RecipeOverviewNode>,
  edge: Readonly<{ from: string; to: string }>,
): React.ReactNode {
  const from = places.get(edge.from);
  const to = places.get(edge.to);
  if (from === undefined || to === undefined) return null;
  return (
    <g key={`${edge.from} ${edge.to}`} data-kind="workflow">
      <path d={wireRoute(from, to).d} />
    </g>
  );
}

function ignoreFailure(): void {}

function decisionText(decision: ProposalDecision): string {
  switch (decision.kind) {
    case "approved":
      return `Applied revision ${String(decision.revision)}. New runs use it.`;
    case "declined":
      return "You declined the proposal. Nothing changed.";
    case "stale":
      return "The recipe changed after this proposal, so it did not apply. Ask the agent again.";
    case "human_intervention":
      return "A person changed the same steps in the draft, so the proposal did not apply. Apply or undo that work, and ask the agent again.";
    case "closed":
      return "This proposal is already closed.";
  }
}

function findingItem(finding: RunFinding): React.ReactNode {
  return <li key={finding.id}>{findingText(finding)}</li>;
}

function findingText(finding: RunFinding): string {
  switch (finding.kind) {
    case "late_order":
      return finding.waitSeconds === null
        ? `${finding.subject} did not finish.`
        : `${finding.subject} waited ${Math.round(finding.waitSeconds)} s.`;
    case "decision_rejected":
      return `${finding.subject}: the decision rejected.`;
    case "task_failed":
    case "recovery_failed":
      return `${finding.subject} failed at ${Math.round(finding.atSeconds)} s.`;
    case "run_blocked":
      return `The run stopped at ${Math.round(finding.atSeconds)} s. It needs ${finding.subject}.`;
  }
}

function changeItem(kind: string, label: string): React.ReactNode {
  return (
    <li key={`${kind}/${label}`}>
      {kind}: {label}
    </li>
  );
}

function simulatedText(comparison: DraftComparison): string {
  const { applied, draft } = comparison;
  const parts = [
    `Simulated. End ${applied.endSeconds.toFixed(1)} s → ${draft.endSeconds.toFixed(1)} s.`,
  ];
  if (applied.orders + draft.orders > 0)
    parts.push(`Late orders ${applied.lateOrders} → ${draft.lateOrders}.`);
  return parts.join(" ");
}

/**
 * The header and the draft group share the first row when both fit, and the group
 * moves under the header when they do not. The stages and the summary stack below
 * them; the tools sit on the footer.
 */
function chromeOffsets(
  parts: ChromeParts,
  width: number,
  workspaceWidth = width,
): ReadonlyArray<readonly [string, number]> {
  const beside =
    shownWidth(parts.header) + shownWidth(parts.end) + CHROME_EDGE * 3 <= width;
  const endTop = beside ? CHROME_EDGE : below(CHROME_EDGE, parts.header);
  const row = Math.max(shownHeight(parts.header), shownHeight(parts.end));
  const top = !beside
    ? below(endTop, parts.end)
    : row === 0
      ? CHROME_EDGE
      : CHROME_EDGE + row + CHROME_GAP;
  const summary = below(top, parts.stages);
  const statusCrowded =
    CHROME_EDGE + shownWidth(parts.header) + CHROME_GAP >
    workspaceWidth - 340;
  const statusTop = statusCrowded
    ? Math.max(64, below(CHROME_EDGE, parts.header))
    : 64;
  return [
    ["--chrome-end-top", endTop],
    ["--chrome-top", top],
    ["--chrome-summary-top", summary],
    ["--chrome-stack", below(summary, parts.summary)],
    ["--chrome-bottom", below(CHROME_EDGE, parts.footer)],
    ["--chrome-status-top", statusTop],
    ["--notices-height", shownHeight(parts.notices)],
    ["--tools-height", shownHeight(parts.tools)],
    ["--result-height", below(0, parts.result)],
  ];
}

function below(top: number, part: Element | null): number {
  const height = shownHeight(part);
  return height === 0 ? top : top + height + CHROME_GAP;
}

function shownHeight(part: Element | null): number {
  return part instanceof HTMLElement ? part.offsetHeight : 0;
}

function shownWidth(part: Element | null): number {
  return part instanceof HTMLElement ? part.offsetWidth : 0;
}

function isIntersecting(entry: IntersectionObserverEntry): boolean {
  return entry.isIntersecting;
}

function workflowChoice(workflow: Readonly<{ id: string }>): GraphChoice {
  return graphChoice(workflow.id);
}

function trimmed(text: string): string {
  return text.trim();
}

function isOutcome(text: string): text is "accept" | "reject" {
  return text === "accept" || text === "reject";
}

function isOtherThan(worker: string, item: string): boolean {
  return item !== worker;
}

function nodeMatches(id: string | null, node: DraftNode): boolean {
  return id !== null && draftNodeId(node.workflow, node.key) === id;
}

function graphNodeMatches(id: string, node: RecipeGraphNode): boolean {
  return node.id === id;
}

function hasEdge(
  snapshot: DraftSnapshot,
  workflow: string,
  from: string,
  to: string,
): boolean {
  for (const edge of snapshot.edges)
    if (edge.workflow === workflow && edge.from === from && edge.to === to)
      return true;
  return false;
}

function problemIsAt(id: string, problem: DraftProblem): boolean {
  return problem.node === id;
}

function clampPosition(
  x: number,
  y: number,
): Readonly<{ x: number; y: number }> {
  return {
    x: Math.min(Math.max(DRAFT_BOUNDS.minX, x), DRAFT_BOUNDS.maxX),
    y: Math.min(Math.max(DRAFT_BOUNDS.minY, y), DRAFT_BOUNDS.maxY),
  };
}

/** One rank on from the step it follows and a row down, or below everything. */
function freePosition(
  snapshot: DraftSnapshot,
  origin: Readonly<{ x: number; y: number }> | null | undefined,
): Readonly<{ x: number; y: number }> {
  const taken = Object.values(snapshot.positions);
  let bottom = 0;
  for (const position of taken) bottom = Math.max(bottom, position.y);
  const start = origin ?? { x: 0, y: bottom };
  const x =
    start.x + (origin === null || origin === undefined ? 0 : NODE_COLUMN);
  let y = start.y + NODE_ROW;
  while (taken.some(isAt.bind(null, x, y))) y += NODE_ROW;
  return clampPosition(x, y);
}

function isAt(
  x: number,
  y: number,
  position: Readonly<{ x: number; y: number }>,
): boolean {
  return position.x === x && position.y === y;
}

function removedLabel(item: Readonly<{ label: string }>): string {
  return item.label;
}

function problemItem(problem: DraftProblem, index: number): React.ReactNode {
  return <li key={index}>{problem.message}</li>;
}

type Point = Readonly<{ x: number; y: number }>;
type Wire = Readonly<{ d: string; label: Point }>;

/**
 * A wire leaves the port on the right of a step and enters the port on the left of
 * the step that needs it. To the next column it bends in the gap between the two. Any
 * other wire would cross the steps between its ends, so it runs only in the gaps: to
 * the middle of the gap beside its step, along the gap above the row of the step that
 * needs it, and back down that step's gap to its port.
 */
function wireRoute(from: Point, to: Point): Wire {
  const x1 = from.x + WIDTH + PORT_CENTRE;
  const y1 = from.y + HEIGHT / 2;
  const x2 = to.x - PORT_CENTRE;
  const y2 = to.y + HEIGHT / 2;
  if (x2 - x1 >= WIRE_REACH && to.x - from.x <= NODE_COLUMN) {
    const bend = Math.max(WIRE_REACH, (x2 - x1) / 2);
    return {
      d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      label: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6 },
    };
  }
  const gap = (NODE_COLUMN - WIDTH) / 2;
  const out = from.x + WIDTH + gap;
  const into = to.x - gap;
  // The lane runs in the gap above the row, clear of the labels of that row.
  const lane = to.y - LABEL_ROOM - (NODE_ROW - HEIGHT - LABEL_ROOM) / 2;
  return {
    d: roundedPath([
      { x: x1, y: y1 },
      { x: out, y: y1 },
      { x: out, y: lane },
      { x: into, y: lane },
      { x: into, y: y2 },
      { x: x2, y: y2 },
    ]),
    label: { x: (out + into) / 2, y: lane - 4 },
  };
}

/** Straight segments through the points, with a round corner at each turn. */
function roundedPath(points: readonly Point[]): string {
  const kept: Point[] = [];
  for (const point of points) {
    const last = kept.at(-1);
    if (last === undefined || last.x !== point.x || last.y !== point.y)
      kept.push(point);
  }
  const first = kept[0];
  if (first === undefined) return "";
  const parts = [`M ${first.x} ${first.y}`];
  for (let index = 1; index < kept.length - 1; index++) {
    const before = kept[index - 1];
    const corner = kept[index];
    const after = kept[index + 1];
    if (before === undefined || corner === undefined || after === undefined)
      continue;
    const into = Math.hypot(corner.x - before.x, corner.y - before.y);
    const away = Math.hypot(after.x - corner.x, after.y - corner.y);
    const radius = Math.min(WIRE_CORNER, into / 2, away / 2);
    parts.push(
      `L ${corner.x + ((before.x - corner.x) / into) * radius} ${corner.y + ((before.y - corner.y) / into) * radius}`,
      `Q ${corner.x} ${corner.y}, ${corner.x + ((after.x - corner.x) / away) * radius} ${corner.y + ((after.y - corner.y) / away) * radius}`,
    );
  }
  const last = kept.at(-1);
  if (last !== undefined && kept.length > 1)
    parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}

function edgePath(
  nodes: ReadonlyMap<string, RecipeGraphNode>,
  edge: RecipeGraphEdge,
): React.ReactNode {
  const source = nodes.get(edge.from);
  const target = nodes.get(edge.to);
  if (source === undefined || target === undefined) return null;
  const wire = wireRoute(source, target);
  return (
    <g
      key={`${edge.from}:${edge.to}`}
      data-prerequisite={edge.from}
      data-dependent={edge.to}
      data-branch={edge.branch ?? undefined}
      data-kind={edgeKind(nodes, edge)}
    >
      <path d={wire.d} />
      {edge.branch !== null && (
        <text x={wire.label.x} y={wire.label.y} textAnchor="middle">
          {edge.branch === "accept" ? "Accept" : "Reject"}
        </text>
      )}
    </g>
  );
}

function edgeEndsAt(id: string, edge: Readonly<{ to: string }>): boolean {
  return edge.to === id;
}

function edgeStartsAt(id: string, edge: Readonly<{ from: string }>): boolean {
  return edge.from === id;
}

/** A branch shows its outcome, and any other wire shows the step it leaves. */
function edgeKind(
  nodes: ReadonlyMap<string, RecipeGraphNode>,
  edge: RecipeGraphEdge,
): PortKind {
  return edge.branch ?? nodes.get(edge.from)?.role ?? "work";
}

function port(side: "in" | "out", kind: PortKind): React.ReactNode {
  return (
    <span
      className="recipe-graph-port"
      data-side={side}
      data-kind={kind}
      aria-hidden="true"
    >
      {portIcon(kind, 10)}
    </span>
  );
}

/** The tile on a card names its kind in the same hue as its ports. */
function kindIcon(kind: PortKind): React.ReactNode {
  return (
    <span className="recipe-graph-kind" data-kind={kind} aria-hidden="true">
      {portIcon(kind, 16)}
    </span>
  );
}

function portIcon(kind: PortKind, size = 12): React.ReactNode {
  switch (kind) {
    case "work":
      return <User size={size} strokeWidth={2} />;
    case "process":
      return <Timer size={size} strokeWidth={2} />;
    case "machine":
      return <Cog size={size} strokeWidth={2} />;
    case "robot":
      return <Bot size={size} strokeWidth={2} />;
    case "check":
      return <GitBranch size={size} strokeWidth={2} />;
    case "accept":
      return <Check size={size} strokeWidth={2} />;
    case "reject":
      return <X size={size} strokeWidth={2} />;
    case "workflow":
      return <Layers size={size} strokeWidth={2} />;
  }
}

/** The corner mark repeats the state word, so a run reads at a glance. */
function stateMark(state: string): React.ReactNode {
  switch (state) {
    case "current":
      return (
        <span
          className="recipe-graph-mark"
          data-mark="current"
          aria-hidden="true"
        />
      );
    case "done":
      return (
        <span className="recipe-graph-mark" data-mark="done" aria-hidden="true">
          <Check size={10} strokeWidth={3} />
        </span>
      );
    case "failed":
      return (
        <span
          className="recipe-graph-mark"
          data-mark="failed"
          aria-hidden="true"
        >
          <CircleAlert size={14} strokeWidth={2.25} />
        </span>
      );
    default:
      return null;
  }
}

function stageMatches(
  node: Readonly<{ stages: readonly string[] }>,
  stage: RecipeGraphStage,
): boolean {
  return node.stages.includes(stage.id);
}

/** A step that spans several stages runs from its first until its last is done. */
function nodeState(
  stages: readonly RecipeGraphStage[],
): Pick<RecipeGraphStage, "state" | "stateLabel"> {
  for (const wanted of ["failed", "current"]) {
    const found = stages.find(stageInState.bind(null, wanted));
    if (found !== undefined) return found;
  }
  const done = stages.filter(stageInState.bind(null, "done"));
  const last = stages.at(-1);
  if (last === undefined) return { state: "not-started", stateLabel: "" };
  if (done.length === stages.length || done.length === 0) return last;
  return { state: "current", stateLabel: "Current" };
}

function stageInState(state: string, stage: RecipeGraphStage): boolean {
  return stage.state === state;
}

/** Who or what does a step: its workers, or else the equipment that it holds. */
function stepDoer(body: DraftNode["body"]): string {
  const workers = stepWorkers(body);
  if (workers !== null && workers.length > 0) return workers.join(", ");
  const held: string[] = [];
  if (Array.isArray(body.claims))
    for (const claim of body.claims as readonly unknown[])
      if (
        typeof claim === "object" &&
        claim !== null &&
        typeof (claim as { resource?: unknown }).resource === "string"
      )
        held.push((claim as { resource: string }).resource);
  return held.join(", ");
}

function secondsText(seconds: number): string {
  if (seconds < 60) return `${Number(seconds.toFixed(1))} s`;
  if (seconds < 3600) return `${Number((seconds / 60).toFixed(1))} min`;
  return `${Number((seconds / 3600).toFixed(1))} h`;
}

function roleLabel(role: RecipeGraphNode["role"]): string {
  switch (role) {
    case "work":
      return "Work";
    case "process":
      return "Process";
    case "machine":
      return "Machine";
    case "robot":
      return "Robot";
    case "check":
      return "Check";
    case "accept":
      return "If accepted";
    case "reject":
      return "If rejected";
  }
}

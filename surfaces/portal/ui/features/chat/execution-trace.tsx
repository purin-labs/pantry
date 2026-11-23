import React from "react";
import {
  CircleCheck,
  Clock,
  Code,
  GitBranch,
  Layers,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import type {
  CaseExecutionNode,
  CaseExecutionNodeDetail,
  OpenCaseExecutionNode,
  ConversationId,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";
import { controlRead } from "@purin-labs/control/portal/control-client";
import {
  readChatExecution,
  readExecutionNode,
  executionErrorMessage,
  type ReadCaseExecution,
} from "@purin-labs/area-brain/ui/execution-client";
import {
  nodeTitle,
  nodeStatus,
  nodeFacts,
  contentRoleLabel,
  limitationSentence,
} from "@purin-labs/area-brain/ui/features/brain/execution-model";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  TraceLine,
  TraceTitle,
  TraceIcon,
  TraceDescription,
  type TraceStatus,
} from "@purin-labs/ui/trace";
import type { ChatWork } from "@purin-labs/control-api/portal/chat";
import "./execution-trace.css";

const transport = { read: controlRead };
type ReadState =
  | { readonly kind: "idle" | "loading" }
  | { readonly kind: "ready"; readonly execution: ReadCaseExecution }
  | { readonly kind: "failed"; readonly message: string };
type Props = {
  readonly organisationId: string;
  readonly conversationId: ConversationId;
  readonly revision: number;
  readonly work: ChatWork;
};

/** Uses the same currently authorized execution projection as Brain. */
export class ChatExecutionTrace extends React.Component<
  Props,
  { readonly open: boolean; readonly read: ReadState }
> {
  state: { readonly open: boolean; readonly read: ReadState } = {
    open: false,
    read: { kind: "idle" },
  };
  private generation = 0;
  private mounted = false;
  private reading = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  componentDidMount(): void {
    this.mounted = true;
  }
  componentWillUnmount(): void {
    this.mounted = false;
    this.generation += 1;
    this.stopTimer();
  }
  componentDidUpdate(previous: Props): void {
    if (previous.revision !== this.props.revision && this.state.open)
      void this.refresh();
  }
  private stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  private changeOpen(open: boolean): void {
    this.stopTimer();
    if (open)
      this.setState(
        { open: true, read: { kind: "loading" } },
        this.refresh.bind(this),
      );
    else {
      this.generation += 1;
      this.setState({ open: false, read: { kind: "idle" } });
    }
  }
  private async refresh(): Promise<void> {
    if (this.reading) return;
    this.stopTimer();
    this.reading = true;
    const generation = ++this.generation;
    const revision = this.props.revision;
    let accepted = false;
    if (this.state.read.kind !== "ready")
      this.setState({ read: { kind: "loading" } });
    try {
      const execution = await readChatExecution(
        transport,
        this.props.organisationId,
        this.props.conversationId,
      );
      accepted = true;
      if (this.mounted && generation === this.generation)
        this.setState({ read: { kind: "ready", execution } });
    } catch (error) {
      if (this.mounted && generation === this.generation)
        this.setState({
          read: { kind: "failed", message: executionErrorMessage(error) },
        });
    } finally {
      this.reading = false;
      if (
        this.mounted &&
        this.state.open &&
        (revision !== this.props.revision || generation !== this.generation)
      ) {
        void this.refresh();
        return;
      }
      if (
        accepted &&
        this.mounted &&
        this.state.open &&
        this.props.work.kind !== "ready" &&
        this.props.work.kind !== "failed"
      ) {
        this.timer = setTimeout(this.refresh.bind(this), 2000);
      }
    }
  }
  render(): React.ReactNode {
    const read = this.state.read;
    return (
      <Trace className="chat-execution-trace">
        <TraceCollapsible
          open={this.state.open}
          onOpenChange={this.changeOpen.bind(this)}
        >
          <TraceCollapsibleTrigger>
            <TraceLine status="completed">
              <TraceIcon>
                <Layers />
              </TraceIcon>
              <TraceTitle>Agent activity</TraceTitle>
              <TraceDescription>Tools and agent runs</TraceDescription>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent keepMounted>
            {read.kind === "idle" || read.kind === "loading" ? (
              <p role="status">Loading recorded activity…</p>
            ) : null}
            {read.kind === "failed" ? (
              <div role="status">
                <p>{read.message}</p>
                <button type="button" onClick={this.refresh.bind(this)}>
                  Retry activity
                </button>
              </div>
            ) : null}
            {read.kind === "ready" ? (
              <ExecutionRows
                organisationId={this.props.organisationId}
                execution={read.execution}
                visible={this.state.open}
              />
            ) : null}
            {read.kind === "ready" ? (
              <button
                className="chat-execution-refresh"
                type="button"
                onClick={this.refresh.bind(this)}
              >
                Refresh activity
              </button>
            ) : null}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
    );
  }
}

type Tree = {
  readonly roots: readonly CaseExecutionNode[];
  readonly children: ReadonlyMap<string, readonly CaseExecutionNode[]>;
};
function executionTree(execution: ReadCaseExecution): Tree {
  const nodes = new Map<string, CaseExecutionNode>();
  for (const node of execution.nodes) nodes.set(node.nodeId, node);
  const children = new Map<string, CaseExecutionNode[]>();
  const parented = new Set<string>();
  for (const edge of execution.edges) {
    const parent = nodes.get(edge.from);
    const child = nodes.get(edge.to);
    if (
      parent === undefined ||
      child === undefined ||
      parented.has(child.nodeId)
    )
      continue;
    const assignmentTurn =
      edge.basis === "assignment" &&
      parent.kind === "assignment" &&
      child.kind === "turn";
    const turnWork =
      edge.basis === "turn" &&
      parent.kind === "turn" &&
      (child.kind === "tool_operation" || child.kind === "attempt");
    const proposal =
      child.kind === "proposal" &&
      ((edge.basis === "tool_call" && parent.kind === "tool_operation") ||
        (edge.basis === "turn" && parent.kind === "turn"));
    const proposalResult =
      edge.basis === "proposal" &&
      parent.kind === "proposal" &&
      (child.kind === "approval" ||
        child.kind === "effect" ||
        child.kind === "delivery");
    const actionResult =
      edge.basis === "action" &&
      ((parent.kind === "approval" &&
        (child.kind === "effect" || child.kind === "delivery")) ||
        (parent.kind === "effect" && child.kind === "delivery"));
    if (
      !assignmentTurn &&
      !turnWork &&
      !proposal &&
      !proposalResult &&
      !actionResult
    )
      continue;
    const group = children.get(parent.nodeId) ?? [];
    group.push(child);
    children.set(parent.nodeId, group);
    parented.add(child.nodeId);
  }
  const roots: CaseExecutionNode[] = [];
  for (const node of execution.nodes)
    if (!parented.has(node.nodeId)) roots.push(node);
  return { roots, children };
}

class ExecutionRows extends React.Component<{
  readonly organisationId: string;
  readonly execution: ReadCaseExecution;
  readonly visible: boolean;
}> {
  private renderRoot(tree: Tree, node: CaseExecutionNode): React.ReactNode {
    return (
      <ExecutionRow
        key={node.nodeId}
        organisationId={this.props.organisationId}
        execution={this.props.execution}
        tree={tree}
        node={node}
        visible={this.props.visible}
      />
    );
  }
  render(): React.ReactNode {
    const tree = executionTree(this.props.execution);
    return (
      <>
        {tree.roots.length === 0 ? (
          <p>No activity has been recorded yet.</p>
        ) : (
          <Trace>{tree.roots.map(this.renderRoot.bind(this, tree))}</Trace>
        )}
        {this.props.execution.limitations.includes("truncated") ? (
          <p>Some recorded activity did not fit in this view.</p>
        ) : null}
        {this.props.execution.limitations.includes("session_unavailable") ? (
          <p>{limitationSentence("session_unavailable")}</p>
        ) : null}
        {this.props.execution.limitations.includes("effect_unavailable") ? (
          <p>{limitationSentence("effect_unavailable")}</p>
        ) : null}
        {this.props.execution.limitations.includes("record_invalid") ? (
          <p>{limitationSentence("record_invalid")}</p>
        ) : null}
      </>
    );
  }
}

type RowProps = {
  readonly organisationId: string;
  readonly execution: ReadCaseExecution;
  readonly tree: Tree;
  readonly node: CaseExecutionNode;
  readonly visible: boolean;
};
class ExecutionRow extends React.Component<
  RowProps,
  { readonly open: boolean }
> {
  state = {
    open: this.props.node.kind === "turn",
  };
  private changeOpen(open: boolean): void {
    this.setState({ open });
  }
  private renderChild(node: CaseExecutionNode): React.ReactNode {
    return (
      <ExecutionRow
        key={node.nodeId}
        organisationId={this.props.organisationId}
        execution={this.props.execution}
        tree={this.props.tree}
        node={node}
        visible={this.props.visible && this.state.open}
      />
    );
  }
  render(): React.ReactNode {
    const { node, execution } = this.props;
    const children = this.props.tree.children.get(node.nodeId) ?? [];
    const detail = isDetailedNode(node);
    const status = executionTraceStatus(node, execution);
    const Icon = executionIcon(node);
    const label = status === "running" ? "Running" : nodeStatus(node).label;
    const line = (
      <TraceLine status={status}>
        <TraceIcon>
          <Icon />
        </TraceIcon>
        <TraceTitle>{nodeTitle(node)}</TraceTitle>
        <TraceDescription>{label}</TraceDescription>
      </TraceLine>
    );
    if (!detail && children.length === 0) return line;
    return (
      <TraceCollapsible
        open={this.state.open}
        onOpenChange={this.changeOpen.bind(this)}
      >
        <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
        <TraceCollapsibleContent keepMounted>
          {detail && this.props.visible && this.state.open ? (
            <ExecutionDetail
              organisationId={this.props.organisationId}
              caseId={execution.caseId}
              node={node}
            />
          ) : null}
          {children.length > 0 ? (
            <Trace>{children.map(this.renderChild.bind(this))}</Trace>
          ) : null}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  }
}

type DetailedNode = OpenCaseExecutionNode;
function isDetailedNode(node: CaseExecutionNode): node is DetailedNode {
  return node.access === "open";
}

type DetailState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly detail: CaseExecutionNodeDetail }
  | { readonly kind: "failed"; readonly message: string };
class ExecutionDetail extends React.Component<
  {
    readonly organisationId: string;
    readonly caseId: string;
    readonly node: DetailedNode;
  },
  DetailState
> {
  state: DetailState = { kind: "loading" };
  private generation = 0;
  componentDidMount(): void {
    void this.load();
  }
  componentDidUpdate(previous: Readonly<typeof this.props>): void {
    if (previous.node !== this.props.node) void this.load();
  }
  componentWillUnmount(): void {
    this.generation += 1;
  }
  private async load(): Promise<void> {
    const generation = ++this.generation;
    try {
      const detail = await readExecutionNode(
        transport,
        this.props.organisationId,
        this.props.caseId,
        this.props.node.nodeId,
      );
      if (generation === this.generation)
        this.setState({ kind: "ready", detail });
    } catch (error) {
      if (generation === this.generation)
        this.setState({
          kind: "failed",
          message: executionErrorMessage(error),
        });
    }
  }
  render(): React.ReactNode {
    switch (this.state.kind) {
      case "loading":
        return <p role="status">Loading step details…</p>;
      case "failed":
        return <p role="status">{this.state.message}</p>;
      case "ready":
        return (
          <div className="chat-execution-detail">
            <dl className="operations-trace-facts">
              {nodeFacts(this.state.detail.node).map(renderFact)}
            </dl>
            {this.state.detail.node.kind === "effect" &&
            this.state.detail.node.state === "indeterminate" ? (
              <p>
                The provider outcome is unknown. Reconcile the existing action
                before another attempt.
              </p>
            ) : null}
            {this.state.detail.content.length === 0
              ? null
              : this.state.detail.content.map(renderContent)}
          </div>
        );
      default:
        return assertNever(this.state);
    }
  }
}

function renderFact(
  fact: ReturnType<typeof nodeFacts>[number],
): React.ReactNode {
  return (
    <React.Fragment key={fact.label}>
      <dt>{fact.label}</dt>
      <dd>
        {fact.time === undefined
          ? fact.value
          : new Date(fact.time).toLocaleString()}
      </dd>
    </React.Fragment>
  );
}

function renderContent(
  part: CaseExecutionNodeDetail["content"][number],
  index: number,
): React.ReactNode {
  return (
    <section key={`${part.role}:${index}`}>
      <h4>{contentRoleLabel(part.role)}</h4>
      <pre tabIndex={0}>{part.text}</pre>
      {part.truncated ? (
        <p>This is a preview of a longer stored value.</p>
      ) : null}
    </section>
  );
}

function executionIcon(node: CaseExecutionNode): typeof Wrench {
  switch (node.kind) {
    case "assignment":
      return GitBranch;
    case "tool_operation":
      return node.access === "open" && node.authority === "code_execution"
        ? Code
        : Wrench;
    case "approval":
    case "effect":
      return ShieldCheck;
    case "attempt":
      return Clock;
    case "turn":
    case "trigger":
    case "proposal":
    case "delivery":
      return CircleCheck;
    default:
      return assertNever(node);
  }
}

function executionTraceStatus(
  node: CaseExecutionNode,
  execution: ReadCaseExecution,
): TraceStatus {
  if (node.access === "withheld") return "pending";
  switch (node.kind) {
    case "trigger":
      return "completed";
    case "assignment":
      switch (node.state) {
        case "running":
          return "running";
        case "completed":
          return "completed";
        case "failed":
        case "budget_exhausted":
          return "error";
        case "assigned":
        case "cancelled":
          return "pending";
        default:
          return assertNever(node);
      }
    case "turn":
      switch (node.state) {
        case "running":
          return "running";
        case "complete":
          return "completed";
        case "failed":
          return "error";
        case "unrecorded":
          return "pending";
        default:
          return assertNever(node);
      }
    case "tool_operation":
      switch (node.state) {
        case "succeeded":
          return "completed";
        case "failed":
          return "error";
        case "started":
          for (const turn of execution.nodes)
            if (
              turn.access === "open" &&
              turn.kind === "turn" &&
              turn.sessionId === node.sessionId &&
              turn.turnId === node.turnId &&
              turn.state === "running"
            )
              return "running";
          return "pending";
        default:
          return assertNever(node);
      }
    case "attempt":
      switch (node.state) {
        case "running":
          return "running";
        case "interrupted":
          return "pending";
        case "ended":
          return "completed";
        default:
          return assertNever(node);
      }
    case "approval":
      // A declined or expired card has ended; only a waiting one is pending.
      return node.state === "waiting" ? "pending" : "completed";
    case "proposal":
      switch (node.state) {
        case "accepted":
        case "approved":
        case "sent":
        case "closed":
          return "completed";
        case "rejected":
          return "error";
        case "awaiting_approval":
        case "rebase_required":
        case "unresolved":
          return "pending";
        default:
          return assertNever(node);
      }
    case "effect":
      switch (node.state) {
        case "executing":
          return "running";
        case "confirmed":
          return "completed";
        case "failed":
          return "error";
        case "proposed":
        case "approval_requested":
        case "signed":
        case "rejected":
        case "expired":
        case "indeterminate":
          return "pending";
        default:
          return assertNever(node);
      }
    case "delivery":
      return node.state === "delivered" ? "completed" : "pending";
    default:
      return assertNever(node);
  }
}

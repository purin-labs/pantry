import type {
  CaseExecutionEdgeBasis,
  CaseExecutionLimitation,
  OpenCaseExecutionNode,
} from "@purin-labs/control-api";
import type {
  CaseAssignmentRecord,
  CaseExecutionCaseRecords,
  CaseExecutionContentTarget,
  CaseExecutionEffectRecord,
  CaseExecutionSessionRecords,
  SessionExecutionContentTarget,
} from "@purin-labs/agent/case-execution/records";

type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown
  ? Omit<Value, Key>
  : never;

/** A node before its reader is known: what it shows, and what guards it. */
export type ProjectedNode = Readonly<{
  /** Names the record the node stands for. Never sent to a reader. */
  key: string;
  fields: DistributiveOmit<OpenCaseExecutionNode, "nodeId" | "access">;
  guard: ProjectedGuard;
  content:
    | Readonly<{ owner: "case"; target: CaseExecutionContentTarget }>
    | Readonly<{
        owner: "session";
        sessionId: string;
        target: SessionExecutionContentTarget;
      }>
    | null;
  /** The Case entries an assignment was given, by the node that made each. */
  context: readonly Readonly<{ entryId: string; producer: string | null }>[];
  /**
   * The nodes this one came from by a recorded identity that is no edge of
   * its own part: the assignment of a proposal or of a turn. A node is shown
   * to nobody who may not see each of them.
   */
  inherits?: readonly string[];
  /**
   * Limitations that say what kind of record this node is. They are given
   * only to a reader who sees the node.
   */
  limitations?: readonly CaseExecutionLimitation[];
}>;

/**
 * What decides who sees a node. `labels` holds every stored label its reader
 * must be allowed to read. `unlabelled` means that a record the node rests on
 * stored no label, so the node is shown to nobody. `mail` names a mail reply
 * proposal, which the mail review authorization decides.
 */
export type ProjectedGuard =
  | Readonly<{ kind: "labels"; labels: readonly string[]; mail?: never }>
  | Readonly<{ kind: "unlabelled"; labels?: never; mail?: never }>
  | Readonly<{
      kind: "mail";
      mail: Readonly<{ integrationAccountId: string; proposalId: string }>;
      labels?: never;
    }>;

export type ProjectedEdge = Readonly<{
  from: string;
  to: string;
  basis: CaseExecutionEdgeBasis;
}>;

export type ProjectedPart = Readonly<{
  nodes: readonly ProjectedNode[];
  edges: readonly ProjectedEdge[];
  limitations: readonly CaseExecutionLimitation[];
}>;

const key = {
  trigger: (triggerId: string) => `trigger:${triggerId}`,
  assignment: (assignmentId: string) => `assignment:${assignmentId}`,
  observation: (proposalId: string) => `proposal:observation:${proposalId}`,
  commerce: (proposalId: string) => `proposal:commerce:${proposalId}`,
  mail: (proposalId: string) => `proposal:mail:${proposalId}`,
  approval: (actionNonce: string) => `approval:${actionNonce}`,
  effect: (actionNonce: string) => `effect:${actionNonce}`,
  delivery: (outputId: string) => `delivery:${outputId}`,
  turn: (sessionId: string, turnId: string) => `turn:${sessionId}:${turnId}`,
  attempt: (sessionId: string, turnId: string, generation: number) =>
    `attempt:${sessionId}:${turnId}:${String(generation)}`,
  tool: (sessionId: string, turnId: string, callId: string) =>
    `tool:${sessionId}:${turnId}:${callId}`,
};

/**
 * The part of a Case's execution that the Case and the action ledger record:
 * triggers, assignments, proposals, approval waits, effects and deliveries.
 *
 * `effects` is null when the ledger could not be read. Approval waits are
 * then still shown, and each effect is absent with a limitation.
 */
export function projectCaseRecords(
  records: CaseExecutionCaseRecords,
  effects: readonly CaseExecutionEffectRecord[] | null,
): ProjectedPart {
  const nodes: ProjectedNode[] = [];
  const edges: ProjectedEdge[] = [];
  const limitations = new Set<CaseExecutionLimitation>();
  if (records.truncated) limitations.add("truncated");
  const labelOfEntry = new Map<string, string | null>();
  for (const entry of records.entries)
    labelOfEntry.set(
      entry.entryId,
      entry.label === null ? null : (records.labels[entry.label] ?? null),
    );
  const guardOfEntries = (entryIds: readonly string[]): ProjectedGuard => {
    const labels = new Set<string>();
    for (const entryId of entryIds) {
      const label = labelOfEntry.get(entryId);
      if (label === undefined || label === null) return { kind: "unlabelled" };
      labels.add(label);
    }
    // A record that rests on no stored entry has no label to decide it by.
    return labels.size === 0
      ? { kind: "unlabelled" }
      : { kind: "labels", labels: [...labels] };
  };
  const guardOfLabel = (index: number | null): ProjectedGuard => {
    const label = index === null ? undefined : records.labels[index];
    return label === undefined
      ? { kind: "unlabelled" }
      : { kind: "labels", labels: [label] };
  };

  // The node that made each Case entry, by the entry's recorded identity.
  const producerOfEntry = new Map<string, string>();
  for (const trigger of records.triggers) {
    producerOfEntry.set(
      `trigger:${trigger.triggerId}`,
      key.trigger(trigger.triggerId),
    );
    nodes.push({
      key: key.trigger(trigger.triggerId),
      fields: { kind: "trigger", ...trigger },
      guard: guardOfEntries([`trigger:${trigger.triggerId}`]),
      content: {
        owner: "case",
        target: { kind: "trigger", triggerId: trigger.triggerId },
      },
      context: [],
    });
  }
  const effectOfNonce = new Map<string, CaseExecutionEffectRecord>();
  for (const effect of effects ?? [])
    effectOfNonce.set(effect.actionNonce, effect);
  for (const proposal of records.sessionProposals)
    for (const entryId of proposal.entryIds)
      producerOfEntry.set(entryId, key.observation(proposal.proposalId));
  for (const proposal of records.commerceProposals)
    producerOfEntry.set(
      `commerce_proposal:${proposal.proposalId}`,
      key.commerce(proposal.proposalId),
    );
  for (const effect of effectOfNonce.values())
    producerOfEntry.set(
      `commerce_outcome:${effect.actionNonce}`,
      key.effect(effect.actionNonce),
    );

  // The assignment each produced entry comes from, for the context edges.
  const assignmentOfEntry = new Map<string, string>();
  for (const proposal of records.sessionProposals)
    for (const entryId of proposal.entryIds)
      assignmentOfEntry.set(entryId, proposal.assignmentId);
  const assignmentOfProposal = new Map<string, string>();
  for (const proposal of records.commerceProposals)
    if (proposal.origin !== null) {
      assignmentOfProposal.set(
        proposal.proposalId,
        proposal.origin.assignmentId,
      );
      assignmentOfEntry.set(
        `commerce_proposal:${proposal.proposalId}`,
        proposal.origin.assignmentId,
      );
    }
  for (const effect of effectOfNonce.values()) {
    const assignmentId = assignmentOfProposal.get(effect.proposalId);
    if (assignmentId !== undefined)
      assignmentOfEntry.set(
        `commerce_outcome:${effect.actionNonce}`,
        assignmentId,
      );
  }
  const contextOf = new Map<string, ReadonlySet<string>>();
  for (const assignment of records.assignments)
    contextOf.set(assignment.assignmentId, new Set(assignment.contextEntryIds));

  for (const assignment of records.assignments) {
    nodes.push({
      key: key.assignment(assignment.assignmentId),
      fields: {
        kind: "assignment",
        assignmentId: assignment.assignmentId,
        sessionId: assignment.sessionId,
        role: assignment.role,
        state: assignment.state,
        caseRevision: assignment.caseRevision,
        startedAt: assignment.startedAt,
        settledAt: assignment.settledAt,
        failureCode: assignment.failureCode,
      },
      guard: guardOfEntries(assignment.contextEntryIds),
      // An assignment's instruction is the platform's own text for the
      // agent. The detail of an assignment gives its context and no content.
      content: null,
      context: assignment.contextEntryIds.map((entryId) => ({
        entryId,
        producer: producerOfEntry.get(entryId) ?? null,
      })),
    });
    for (const from of contextProducers(
      assignment,
      producerOfEntry,
      assignmentOfEntry,
      contextOf,
    ))
      edges.push({
        from,
        to: key.assignment(assignment.assignmentId),
        basis: "context_entry",
      });
  }

  for (const proposal of records.sessionProposals)
    nodes.push({
      key: key.observation(proposal.proposalId),
      fields: {
        kind: "proposal",
        proposalId: proposal.proposalId,
        proposalKind: "observation",
        state: proposal.state,
        recordedAt: proposal.recordedAt,
        title: null,
      },
      // A proposal that was not accepted made no entry: it has no label.
      guard: guardOfEntries(
        proposal.state === "accepted" ? proposal.entryIds : [],
      ),
      content: {
        owner: "case",
        target: { kind: "session_proposal", proposalId: proposal.proposalId },
      },
      context: [],
      inherits: [key.assignment(proposal.assignmentId)],
    });
  const commerceGuard = new Map<string, ProjectedGuard>();
  for (const proposal of records.commerceProposals) {
    const guard = guardOfLabel(proposal.label);
    commerceGuard.set(proposal.proposalId, guard);
    // These say that the proposal is a commerce action, so they go with the
    // node and not with the page.
    const about: CaseExecutionLimitation[] = [];
    if (proposal.origin !== null && proposal.toolCallId === null)
      about.push("proposal_tool_call_unrecorded");
    if (effects === null) about.push("effect_unavailable");
    nodes.push({
      key: key.commerce(proposal.proposalId),
      fields: {
        kind: "proposal",
        proposalId: proposal.proposalId,
        proposalKind: "commerce_action",
        state: "accepted",
        recordedAt: proposal.recordedAt,
        title: proposal.title,
      },
      guard,
      content: {
        owner: "case",
        target: { kind: "commerce_proposal", proposalId: proposal.proposalId },
      },
      context: [],
      inherits:
        proposal.origin === null
          ? []
          : [key.assignment(proposal.origin.assignmentId)],
      limitations: about,
    });
  }
  for (const proposal of records.mailProposals) {
    nodes.push({
      key: key.mail(proposal.proposalId),
      fields: {
        kind: "proposal",
        proposalId: proposal.proposalId,
        proposalKind: "mail_reply",
        state: proposal.state,
        recordedAt: proposal.recordedAt,
        title: null,
      },
      guard:
        proposal.integrationAccountId === null
          ? { kind: "unlabelled" }
          : {
              kind: "mail",
              mail: {
                integrationAccountId: proposal.integrationAccountId,
                proposalId: proposal.proposalId,
              },
            },
      content: null,
      context: [],
      // This says that the proposal is a mail reply.
      limitations: ["mail_proposal_origin_unrecorded"],
    });
  }

  const approved = new Set<string>();
  for (const approval of records.approvals) {
    approved.add(approval.actionNonce);
    nodes.push({
      key: key.approval(approval.actionNonce),
      fields: {
        kind: "approval",
        approvalId: approval.actionNonce,
        state: approval.state,
        requestedAt: approval.requestedAt,
        decidedAt: approval.decidedAt,
      },
      guard: commerceGuard.get(approval.proposalId) ?? { kind: "unlabelled" },
      content: null,
      context: [],
    });
    if (commerceGuard.has(approval.proposalId))
      edges.push({
        from: key.commerce(approval.proposalId),
        to: key.approval(approval.actionNonce),
        basis: "proposal",
      });
    if (effects === null) limitations.add("effect_unavailable");
  }
  for (const effect of effectOfNonce.values()) {
    limitations.add("effect_attempts_unrecorded");
    const proposal = commerceGuard.get(effect.proposalId);
    const outcome = labelOfEntry.get(`commerce_outcome:${effect.actionNonce}`);
    nodes.push({
      key: key.effect(effect.actionNonce),
      fields: {
        kind: "effect",
        actionId: effect.actionNonce,
        state: effect.state,
        recordedAt: effect.recordedAt,
        updatedAt: effect.updatedAt,
        receipt: effect.receipt,
      },
      // The effect is guarded by its proposal and, once the Case accepted
      // the outcome, by the outcome entry too.
      guard:
        proposal === undefined || proposal.kind !== "labels" || outcome === null
          ? { kind: "unlabelled" }
          : {
              kind: "labels",
              labels:
                outcome === undefined
                  ? proposal.labels
                  : [...new Set([...proposal.labels, outcome])],
            },
      content: null,
      context: [],
    });
    // An action a person approved hangs from the approval wait. One with no
    // recorded wait hangs from the proposal the ledger names.
    if (approved.has(effect.actionNonce))
      edges.push({
        from: key.approval(effect.actionNonce),
        to: key.effect(effect.actionNonce),
        basis: "action",
      });
    else if (commerceGuard.has(effect.proposalId))
      edges.push({
        from: key.commerce(effect.proposalId),
        to: key.effect(effect.actionNonce),
        basis: "proposal",
      });
  }

  const observations = new Set(
    records.sessionProposals.map((proposal) => proposal.proposalId),
  );
  for (const output of records.outputs) {
    limitations.add("delivery_attempts_unrecorded");
    nodes.push({
      key: key.delivery(output.outputId),
      fields: {
        kind: "delivery",
        outputId: output.outputId,
        deliveryId: output.deliveryId,
        connectorId: output.connectorId,
        state: output.state,
        addressedAt: output.addressedAt,
        receipt: output.receipt,
      },
      guard: guardOfLabel(output.label),
      content: {
        owner: "case",
        target: { kind: "output", outputId: output.outputId },
      },
      context: [],
    });
    const source = output.source;
    if (source.kind === "agent_turn" && observations.has(source.proposalId))
      edges.push({
        from: key.observation(source.proposalId),
        to: key.delivery(output.outputId),
        basis: "proposal",
      });
    else if (source.kind === "commerce_outcome") {
      if (effectOfNonce.has(source.actionNonce))
        edges.push({
          from: key.effect(source.actionNonce),
          to: key.delivery(output.outputId),
          basis: "action",
        });
      else if (approved.has(source.actionNonce))
        edges.push({
          from: key.approval(source.actionNonce),
          to: key.delivery(output.outputId),
          basis: "action",
        });
      else if (commerceGuard.has(source.proposalId))
        edges.push({
          from: key.commerce(source.proposalId),
          to: key.delivery(output.outputId),
          basis: "proposal",
        });
    } else if (
      source.kind === "commerce_approval_notice" &&
      commerceGuard.has(source.proposalId)
    )
      // The notice that a proposal waits for approval hangs from it.
      edges.push({
        from: key.commerce(source.proposalId),
        to: key.delivery(output.outputId),
        basis: "proposal",
      });
  }
  return { nodes, edges, limitations: [...limitations] };
}

/**
 * The nodes whose entries an assignment's context names, without those an
 * earlier link already carries.
 *
 * Another assignment is an ancestor when the context names an entry that it
 * produced. An entry that an ancestor was also given reaches this assignment
 * through that ancestor, so no second edge is drawn for it. Every edge that
 * is drawn stands for one entry the context records.
 */
function contextProducers(
  assignment: CaseAssignmentRecord,
  producerOfEntry: ReadonlyMap<string, string>,
  assignmentOfEntry: ReadonlyMap<string, string>,
  contextOf: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
  const ancestors = new Set<string>();
  for (const entryId of assignment.contextEntryIds) {
    const from = assignmentOfEntry.get(entryId);
    if (from !== undefined && from !== assignment.assignmentId)
      ancestors.add(from);
  }
  const producers = new Set<string>();
  for (const entryId of assignment.contextEntryIds) {
    const producer = producerOfEntry.get(entryId);
    if (producer === undefined) continue;
    let carried = false;
    for (const ancestor of ancestors)
      if (contextOf.get(ancestor)?.has(entryId) === true) carried = true;
    if (!carried) producers.add(producer);
  }
  return [...producers];
}

/**
 * The part of a Case's execution that one assignment's Session records: its
 * turns, the attempts of each turn and the tool operations of each turn.
 *
 * Each turn carries the Memory result its Session recorded. A turn that
 * keeps no turn record is a node too, from the context its Session recorded
 * for it. That record names the assignment, and it holds no state, no time
 * and no flow binding. Such a node shows the Memory result and no more, so
 * it is guarded by the stored label of each Memory revision that record
 * holds, below its assignment.
 *
 * `session` is null when the Session could not be read. The proposals the
 * Case holds for the assignment are then hung from the assignment itself, by
 * the assignment they name.
 */
export function projectSessionRecords(
  records: CaseExecutionCaseRecords,
  assignment: CaseAssignmentRecord,
  session: CaseExecutionSessionRecords | null,
): ProjectedPart {
  const nodes: ProjectedNode[] = [];
  const edges: ProjectedEdge[] = [];
  const limitations = new Set<CaseExecutionLimitation>();
  const from = key.assignment(assignment.assignmentId);
  const observations = records.sessionProposals.filter(
    (proposal) => proposal.assignmentId === assignment.assignmentId,
  );
  const commerce = records.commerceProposals.filter(
    (proposal) => proposal.origin?.assignmentId === assignment.assignmentId,
  );
  // A Session that belongs to another parent holds no record of this Case.
  if (
    session === null ||
    session.sessionId !== assignment.sessionId ||
    (session.assignmentId !== null &&
      session.assignmentId !== assignment.assignmentId)
  ) {
    limitations.add("session_unavailable");
    for (const proposal of observations)
      edges.push({
        from,
        to: key.observation(proposal.proposalId),
        basis: "assignment",
      });
    for (const proposal of commerce)
      edges.push({
        from,
        to: key.commerce(proposal.proposalId),
        basis: "assignment",
      });
    return { nodes, edges, limitations: [...limitations] };
  }
  if (session.truncated) limitations.add("truncated");
  const sessionId = session.sessionId;
  const guardOfTurn = new Map<string, ProjectedGuard>();
  for (const turn of session.turns) {
    // A turn names its assignment in its accepted input. A Session created
    // for one assignment serves no other, so its recorded parent stands in
    // where the input record is gone.
    const named = turn.assignmentId ?? session.assignmentId;
    if (named !== assignment.assignmentId) continue;
    const label = turn.label === null ? undefined : session.labels[turn.label];
    const guard: ProjectedGuard =
      label === undefined
        ? { kind: "unlabelled" }
        : { kind: "labels", labels: [label] };
    guardOfTurn.set(turn.turnId, guard);
    nodes.push({
      key: key.turn(sessionId, turn.turnId),
      fields: {
        kind: "turn",
        sessionId,
        turnId: turn.turnId,
        state: turn.state,
        startedAt: turn.startedAt,
        failureCode: turn.failureCode,
        memory: turn.memory,
      },
      guard,
      content: null,
      context: [],
      inherits: [from],
    });
    edges.push({
      from,
      to: key.turn(sessionId, turn.turnId),
      basis: "assignment",
    });
  }
  for (const turn of session.contextTurns) {
    // A turn record stands for its turn. The context record names its
    // assignment itself.
    if (
      turn.assignmentId !== assignment.assignmentId ||
      guardOfTurn.has(turn.turnId)
    )
      continue;
    const labels = turn.labels.flatMap((index) => {
      const label = session.labels[index];
      return label === undefined ? [] : [label];
    });
    const guard: ProjectedGuard =
      labels.length === turn.labels.length
        ? { kind: "labels", labels: [...new Set(labels)] }
        : { kind: "unlabelled" };
    guardOfTurn.set(turn.turnId, guard);
    nodes.push({
      key: key.turn(sessionId, turn.turnId),
      fields: {
        kind: "turn",
        sessionId,
        turnId: turn.turnId,
        state: "unrecorded",
        startedAt: null,
        failureCode: null,
        memory: turn.memory,
      },
      guard,
      content: null,
      context: [],
      inherits: [from],
    });
    edges.push({
      from,
      to: key.turn(sessionId, turn.turnId),
      basis: "assignment",
    });
  }
  for (const attempt of session.attempts) {
    const guard = guardOfTurn.get(attempt.turnId);
    if (guard === undefined) continue;
    nodes.push({
      key: key.attempt(sessionId, attempt.turnId, attempt.generation),
      fields: { kind: "attempt", sessionId, ...attempt },
      guard,
      content: null,
      context: [],
    });
    edges.push({
      from: key.turn(sessionId, attempt.turnId),
      to: key.attempt(sessionId, attempt.turnId, attempt.generation),
      basis: "turn",
    });
  }
  const tools = new Set<string>();
  for (const operation of session.toolOperations) {
    const guard = guardOfTurn.get(operation.turnId);
    if (guard === undefined) continue;
    // An entry from before the Session recorded attempts names none.
    if (
      operation.generation === null ||
      (operation.settledAt !== null && operation.settledGeneration === null)
    )
      limitations.add("tool_attempt_unrecorded");
    const node = key.tool(sessionId, operation.turnId, operation.callId);
    tools.add(node);
    nodes.push({
      key: node,
      fields: { kind: "tool_operation", sessionId, ...operation },
      guard,
      content: {
        owner: "session",
        sessionId,
        target: {
          kind: "tool_operation",
          turnId: operation.turnId,
          callId: operation.callId,
        },
      },
      context: [],
    });
    edges.push({
      from: key.turn(sessionId, operation.turnId),
      to: node,
      basis: "turn",
    });
  }
  // A proposal hangs from the tool call its acceptance names. Without one it
  // hangs from the turn it names, and without that turn from the assignment.
  const hang = (to: string, turnId: string | null, callId: string | null) => {
    const tool =
      turnId === null || callId === null
        ? null
        : key.tool(sessionId, turnId, callId);
    if (tool !== null && tools.has(tool))
      edges.push({ from: tool, to, basis: "tool_call" });
    else if (turnId !== null && guardOfTurn.has(turnId))
      edges.push({ from: key.turn(sessionId, turnId), to, basis: "turn" });
    else edges.push({ from, to, basis: "assignment" });
  };
  for (const proposal of observations)
    hang(
      key.observation(proposal.proposalId),
      proposal.sessionId === sessionId ? proposal.turnId : null,
      null,
    );
  for (const proposal of commerce)
    hang(
      key.commerce(proposal.proposalId),
      proposal.origin?.sessionId === sessionId ? proposal.turnId : null,
      proposal.toolCallId,
    );
  return { nodes, edges, limitations: [...limitations] };
}

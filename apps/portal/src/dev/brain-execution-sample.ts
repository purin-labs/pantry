import type {
  CaseTimelineCase,
  CaseTimelineDay,
  CaseTimelineOutcomeKind,
  CaseExecutionCaseRef,
  CaseExecutionEdge,
  CaseExecutionNode,
  CaseExecutionNodeDetail,
  CaseExecutionPage,
} from "@purin-labs/control-api";

const AT = 1_791_620_000_000;
const MINUTE = 60_000;

const OPEN_CASE = "case_preview_reorder_flour";
const SLACK_CASE = "case_slack_preview_thread";
const MAIL_CASE = "case_gmail_preview_supplier_thread";

/**
 * A Case with every kind of record: two assignments that worked side by
 * side, a third that was given what both proposed, an interrupted attempt, a
 * failed tool operation, a proposal that waits for a person, an effect whose
 * result is unknown and a delivery.
 */
const OPEN_NODES: readonly CaseExecutionNode[] = [
  {
    nodeId: "c.trigger",
    kind: "trigger",
    access: "open",
    triggerId: "trigger_preview_request",
    source: "api",
    acceptedAt: AT,
    title: null,
  },
  {
    nodeId: "c.assign_stock",
    kind: "assignment",
    access: "open",
    assignmentId: "assignment_preview_stock",
    sessionId: "session_preview_stock",
    role: "specialist",
    state: "completed",
    caseRevision: 1,
    startedAt: AT + MINUTE,
    settledAt: AT + 3 * MINUTE,
    failureCode: null,
  },
  {
    nodeId: "c.assign_supplier",
    kind: "assignment",
    access: "open",
    assignmentId: "assignment_preview_supplier",
    sessionId: "session_preview_supplier",
    role: "specialist",
    state: "completed",
    caseRevision: 1,
    startedAt: AT + MINUTE,
    settledAt: AT + 4 * MINUTE,
    failureCode: null,
  },
  {
    nodeId: "c.assign_order",
    kind: "assignment",
    access: "open",
    assignmentId: "assignment_preview_order",
    sessionId: "session_preview_order",
    role: "coordinator",
    state: "running",
    caseRevision: 3,
    startedAt: AT + 5 * MINUTE,
    settledAt: null,
    failureCode: null,
  },
  {
    nodeId: "c.note_stock",
    kind: "proposal",
    access: "open",
    proposalId: "proposal_preview_stock",
    proposalKind: "observation",
    state: "accepted",
    recordedAt: AT + 3 * MINUTE,
    title: null,
  },
  {
    nodeId: "c.note_supplier",
    kind: "proposal",
    access: "open",
    proposalId: "proposal_preview_supplier",
    proposalKind: "observation",
    state: "accepted",
    recordedAt: AT + 4 * MINUTE,
    title: null,
  },
  {
    nodeId: "c.order",
    kind: "proposal",
    access: "open",
    proposalId: "proposal_preview_order",
    proposalKind: "commerce_action",
    state: "accepted",
    recordedAt: AT + 7 * MINUTE,
    title: "Refund payment",
  },
  {
    nodeId: "c.approval",
    kind: "approval",
    access: "open",
    approvalId: "action_preview_order",
    state: "approved",
    requestedAt: AT + 7 * MINUTE,
    decidedAt: AT + 30 * MINUTE,
  },
  {
    nodeId: "c.effect",
    kind: "effect",
    access: "open",
    actionId: "action_preview_order",
    state: "indeterminate",
    recordedAt: AT + 7 * MINUTE,
    updatedAt: AT + 31 * MINUTE,
    receipt: null,
  },
  {
    nodeId: "c.delivery",
    kind: "delivery",
    access: "open",
    outputId: "output_preview_stock",
    deliveryId: "delivery_preview_stock",
    connectorId: "connector_preview_slack",
    state: "delivered",
    addressedAt: AT + 3 * MINUTE,
    receipt: {
      nativeReceiptId: "1791620180.000200",
      deliveredAt: AT + 3 * MINUTE,
    },
  },
  {
    nodeId: "s1.turn",
    kind: "turn",
    access: "open",
    sessionId: "session_preview_stock",
    turnId: "turn_preview_stock",
    state: "complete",
    startedAt: AT + MINUTE,
    failureCode: null,
    memory: { kind: "admitted", revisions: 1 },
  },
  {
    nodeId: "s1.attempt1",
    kind: "attempt",
    access: "open",
    sessionId: "session_preview_stock",
    turnId: "turn_preview_stock",
    generation: 1,
    state: "interrupted",
    startedAt: AT + MINUTE,
    interruptedAt: AT + 2 * MINUTE,
  },
  {
    nodeId: "s1.attempt2",
    kind: "attempt",
    access: "open",
    sessionId: "session_preview_stock",
    turnId: "turn_preview_stock",
    generation: 2,
    state: "ended",
    startedAt: AT + 2 * MINUTE,
    interruptedAt: null,
  },
  {
    nodeId: "s1.tool",
    kind: "tool_operation",
    access: "open",
    sessionId: "session_preview_stock",
    turnId: "turn_preview_stock",
    callId: "call_preview_stock_1",
    tool: "commerce_entity_context",
    state: "succeeded",
    startedAt: AT + 2 * MINUTE,
    settledAt: AT + 2 * MINUTE + 4_000,
    authority: "read",
    receiptId: null,
  },
  {
    nodeId: "s2.turn",
    kind: "turn",
    access: "open",
    sessionId: "session_preview_supplier",
    turnId: "turn_preview_supplier",
    state: "complete",
    startedAt: AT + MINUTE,
    failureCode: null,
    memory: { kind: "limited", reason: "tokens", revisions: 2 },
  },
  {
    nodeId: "s2.attempt",
    kind: "attempt",
    access: "open",
    sessionId: "session_preview_supplier",
    turnId: "turn_preview_supplier",
    generation: 1,
    state: "ended",
    startedAt: AT + MINUTE,
    interruptedAt: null,
  },
  {
    nodeId: "s2.tool_failed",
    kind: "tool_operation",
    access: "open",
    sessionId: "session_preview_supplier",
    turnId: "turn_preview_supplier",
    callId: "call_preview_supplier_1",
    tool: "integration_list",
    state: "failed",
    startedAt: AT + 2 * MINUTE,
    settledAt: AT + 2 * MINUTE + 2_000,
    authority: "read",
    receiptId: null,
  },
  {
    nodeId: "s3.turn",
    kind: "turn",
    access: "open",
    sessionId: "session_preview_order",
    turnId: "turn_preview_order",
    state: "running",
    startedAt: AT + 5 * MINUTE,
    failureCode: null,
    memory: { kind: "none" },
  },
  {
    nodeId: "s3.attempt",
    kind: "attempt",
    access: "open",
    sessionId: "session_preview_order",
    turnId: "turn_preview_order",
    generation: 1,
    state: "running",
    startedAt: AT + 5 * MINUTE,
    interruptedAt: null,
  },
  {
    nodeId: "s3.tool",
    kind: "tool_operation",
    access: "open",
    sessionId: "session_preview_order",
    turnId: "turn_preview_order",
    callId: "call_preview_order_1",
    tool: "commerce_propose_action",
    state: "succeeded",
    startedAt: AT + 6 * MINUTE,
    settledAt: AT + 7 * MINUTE,
    authority: "provider_effect",
    receiptId: "receipt_preview_proposal",
  },
];

const OPEN_EDGES: readonly CaseExecutionEdge[] = [
  { from: "c.trigger", to: "c.assign_stock", basis: "context_entry" },
  { from: "c.trigger", to: "c.assign_supplier", basis: "context_entry" },
  { from: "c.note_stock", to: "c.assign_order", basis: "context_entry" },
  { from: "c.note_supplier", to: "c.assign_order", basis: "context_entry" },
  { from: "c.order", to: "c.approval", basis: "proposal" },
  { from: "c.approval", to: "c.effect", basis: "action" },
  { from: "c.note_stock", to: "c.delivery", basis: "proposal" },
  { from: "c.assign_stock", to: "s1.turn", basis: "assignment" },
  { from: "s1.turn", to: "s1.attempt1", basis: "turn" },
  { from: "s1.turn", to: "s1.attempt2", basis: "turn" },
  { from: "s1.turn", to: "s1.tool", basis: "turn" },
  { from: "s1.turn", to: "c.note_stock", basis: "turn" },
  { from: "c.assign_supplier", to: "s2.turn", basis: "assignment" },
  { from: "s2.turn", to: "s2.attempt", basis: "turn" },
  { from: "s2.turn", to: "s2.tool_failed", basis: "turn" },
  { from: "s2.turn", to: "c.note_supplier", basis: "turn" },
  { from: "c.assign_order", to: "s3.turn", basis: "assignment" },
  { from: "s3.turn", to: "s3.attempt", basis: "turn" },
  { from: "s3.turn", to: "s3.tool", basis: "turn" },
  { from: "s3.tool", to: "c.order", basis: "tool_call" },
];

const withheld = (
  nodeId: string,
  kind: CaseExecutionNode["kind"],
): CaseExecutionNode => ({ nodeId, kind, access: "withheld" });

const SLACK_NODES: readonly CaseExecutionNode[] = [
  withheld("c.w_trigger", "trigger"),
  withheld("c.w_assignment", "assignment"),
  withheld("c.w_note", "proposal"),
  withheld("c.w_delivery", "delivery"),
  withheld("s.w_turn", "turn"),
  withheld("s.w_attempt", "attempt"),
  withheld("s.w_tool", "tool_operation"),
];

const SLACK_EDGES: readonly CaseExecutionEdge[] = [
  { from: "c.w_trigger", to: "c.w_assignment", basis: "context_entry" },
  { from: "c.w_note", to: "c.w_delivery", basis: "proposal" },
  { from: "c.w_assignment", to: "s.w_turn", basis: "assignment" },
  { from: "s.w_turn", to: "s.w_attempt", basis: "turn" },
  { from: "s.w_turn", to: "s.w_tool", basis: "turn" },
  { from: "s.w_turn", to: "c.w_note", basis: "turn" },
];

const MAIL_NODES: readonly CaseExecutionNode[] = [
  {
    nodeId: "c.m_trigger",
    kind: "trigger",
    access: "open",
    triggerId: "trigger_email_preview_message",
    source: "connector",
    acceptedAt: AT - 60 * MINUTE,
    title: null,
  },
  {
    nodeId: "c.m_assignment",
    kind: "assignment",
    access: "open",
    assignmentId: "assignment_preview_reply",
    sessionId: "session_preview_reply",
    role: "coordinator",
    state: "completed",
    caseRevision: 1,
    startedAt: AT - 59 * MINUTE,
    settledAt: AT - 58 * MINUTE,
    failureCode: null,
  },
  {
    nodeId: "c.m_note",
    kind: "proposal",
    access: "open",
    proposalId: "proposal_preview_reply_note",
    proposalKind: "observation",
    state: "accepted",
    recordedAt: AT - 58 * MINUTE,
    title: null,
  },
  {
    nodeId: "c.m_reply",
    kind: "proposal",
    access: "open",
    proposalId: "proposal_preview_supplier_reply",
    proposalKind: "mail_reply",
    state: "awaiting_approval",
    recordedAt: AT - 58 * MINUTE,
    title: null,
  },
  // A mail turn keeps no turn record. Its Memory read missed its deadline.
  {
    nodeId: "s.m_turn",
    kind: "turn",
    access: "open",
    sessionId: "session_preview_reply",
    turnId: "turn_email_preview_message",
    state: "unrecorded",
    startedAt: null,
    failureCode: null,
    memory: { kind: "unavailable", reason: "deadline" },
  },
];

const MAIL_EDGES: readonly CaseExecutionEdge[] = [
  { from: "c.m_trigger", to: "c.m_assignment", basis: "context_entry" },
  { from: "c.m_assignment", to: "s.m_turn", basis: "assignment" },
  { from: "s.m_turn", to: "c.m_note", basis: "turn" },
];

/**
 * A long Case: 200 records in four assignments that worked side by side.
 * The preview reads it in pages of ten, so the view shows it while its
 * pages arrive.
 */
const LONG_CASE = "case_preview_long_inventory";

function longCase(): Readonly<{
  nodes: readonly CaseExecutionNode[];
  edges: readonly CaseExecutionEdge[];
}> {
  const nodes: CaseExecutionNode[] = [
    {
      nodeId: "l.trigger",
      kind: "trigger",
      access: "open",
      triggerId: "trigger_preview_long",
      source: "cue",
      acceptedAt: AT,
      title: null,
    },
  ];
  const edges: CaseExecutionEdge[] = [];
  for (let lane = 0; lane < 4; lane += 1) {
    const name = `l.${String(lane)}`;
    const sessionId = `session_preview_long_${String(lane)}`;
    const turnId = `turn_preview_long_${String(lane)}`;
    nodes.push(
      {
        nodeId: `${name}.assign`,
        kind: "assignment",
        access: "open",
        assignmentId: `assignment_preview_long_${String(lane)}`,
        sessionId,
        role: "specialist",
        state: "completed",
        caseRevision: 1,
        startedAt: AT + MINUTE,
        settledAt: AT + 9 * MINUTE,
        failureCode: null,
      },
      {
        nodeId: `${name}.turn`,
        kind: "turn",
        access: "open",
        sessionId,
        turnId,
        state: "complete",
        startedAt: AT + MINUTE,
        failureCode: null,
        memory: { kind: "none" },
      },
    );
    edges.push(
      { from: "l.trigger", to: `${name}.assign`, basis: "context_entry" },
      { from: `${name}.assign`, to: `${name}.turn`, basis: "assignment" },
    );
    // 46 tool operations for each assignment: 4 x (1 + 1 + 46 + 1) + 1 = 197.
    for (let call = 0; call < 46; call += 1) {
      nodes.push({
        nodeId: `${name}.tool.${String(call)}`,
        kind: "tool_operation",
        access: "open",
        sessionId,
        turnId,
        callId: `call_preview_long_${String(lane)}_${String(call)}`,
        tool: call % 2 === 0 ? "commerce_entity_context" : "integration_list",
        state: call % 9 === 8 ? "failed" : "succeeded",
        startedAt: AT + 2 * MINUTE + call * 5_000,
        settledAt: AT + 2 * MINUTE + call * 5_000 + 1_200,
        authority: "read",
        receiptId: null,
      });
      edges.push({
        from: `${name}.turn`,
        to: `${name}.tool.${String(call)}`,
        basis: "turn",
      });
    }
    nodes.push({
      nodeId: `${name}.proposal`,
      kind: "proposal",
      access: "open",
      proposalId: `proposal_preview_long_${String(lane)}`,
      proposalKind: "observation",
      state: "accepted",
      recordedAt: AT + 8 * MINUTE,
      title: null,
    });
    edges.push({
      from: `${name}.turn`,
      to: `${name}.proposal`,
      basis: "turn",
    });
  }
  // Three deliveries close the Case: 200 records.
  for (let lane = 0; lane < 3; lane += 1) {
    nodes.push({
      nodeId: `l.${String(lane)}.delivery`,
      kind: "delivery",
      access: "open",
      outputId: `output_preview_long_${String(lane)}`,
      deliveryId: `delivery_preview_long_${String(lane)}`,
      connectorId: "connector_preview_slack",
      state: "delivered",
      addressedAt: AT + 9 * MINUTE,
      receipt: {
        nativeReceiptId: `receipt_preview_long_${String(lane)}`,
        deliveredAt: AT + 9 * MINUTE + 2_000,
      },
    });
    edges.push({
      from: `l.${String(lane)}.proposal`,
      to: `l.${String(lane)}.delivery`,
      basis: "proposal",
    });
  }
  return { nodes, edges };
}

const LONG = longCase();

export const SAMPLE_EXECUTION_CASES: readonly CaseExecutionCaseRef[] = [
  { caseId: OPEN_CASE, origin: "portal_chat", filedAt: AT },
  { caseId: LONG_CASE, origin: "direct", filedAt: AT - 10 * MINUTE },
  { caseId: SLACK_CASE, origin: "slack", filedAt: AT - 20 * MINUTE },
  { caseId: MAIL_CASE, origin: "email", filedAt: AT - 60 * MINUTE },
];

const SAMPLES: Readonly<
  Record<
    string,
    Readonly<{
      nodes: readonly CaseExecutionNode[];
      edges: readonly CaseExecutionEdge[];
      limitations: CaseExecutionPage["limitations"];
    }>
  >
> = {
  [OPEN_CASE]: {
    nodes: OPEN_NODES,
    edges: OPEN_EDGES,
    limitations: [
      "tool_attempt_unrecorded",
      "effect_attempts_unrecorded",
      "delivery_attempts_unrecorded",
    ],
  },
  [SLACK_CASE]: {
    nodes: SLACK_NODES,
    edges: SLACK_EDGES,
    limitations: ["tool_attempt_unrecorded", "delivery_attempts_unrecorded"],
  },
  [MAIL_CASE]: {
    nodes: MAIL_NODES,
    edges: MAIL_EDGES,
    limitations: ["mail_proposal_origin_unrecorded"],
  },
  [LONG_CASE]: {
    nodes: LONG.nodes,
    edges: LONG.edges,
    limitations: ["tool_attempt_unrecorded", "delivery_attempts_unrecorded"],
  },
};

const PAGE = 10;

/** One page of a sample, with the edges that belong on it. Null: no Case. */
export function sampleExecutionPage(
  caseId: string,
  after: string | null,
): CaseExecutionPage | null {
  const sample = SAMPLES[caseId];
  if (sample === undefined) return null;
  const offset = after === null ? 0 : Number(after);
  const nodes = sample.nodes.slice(offset, offset + PAGE);
  const position = new Map(
    sample.nodes.map((node, index) => [node.nodeId, index]),
  );
  const end = offset + nodes.length;
  return {
    caseId,
    basis: "preview",
    nodes,
    edges: sample.edges.filter((edge) => {
      const at = Math.max(
        position.get(edge.from) ?? -1,
        position.get(edge.to) ?? -1,
      );
      return at >= offset && at < end;
    }),
    limitations: sample.limitations,
    nextCursor: end < sample.nodes.length ? String(end) : null,
  };
}

const CONTENT: Readonly<Record<string, CaseExecutionNodeDetail["content"]>> = {
  "c.trigger": [
    {
      role: "input",
      text: "We are low on flour. Check the stock and the supplier, then prepare an order.",
      truncated: false,
    },
  ],
  "c.note_stock": [
    {
      role: "entry",
      text: "Flour on hand: 40 kg. At the current use it lasts two days.",
      truncated: false,
    },
  ],
  "c.note_supplier": [
    {
      role: "entry",
      text: "The supplier's next-day orders close at noon. The connected app list could not be read.",
      truncated: false,
    },
  ],
  "c.order": [
    {
      role: "action",
      text: '{"kind":"submit_purchase_request","supplier":"Flour supplier","quantityKg":200}',
      truncated: false,
    },
  ],
  "c.delivery": [
    {
      role: "message",
      text: "Flour on hand: 40 kg. At the current use it lasts two days.",
      truncated: false,
    },
  ],
  "s1.tool": [
    { role: "arguments", text: '{"entity":"flour"}', truncated: false },
    {
      role: "result",
      text: '{"onHandKg":40,"dailyUseKg":20}',
      truncated: false,
    },
  ],
  "s2.tool_failed": [
    { role: "arguments", text: "{}", truncated: false },
    { role: "result", text: "The request was refused.", truncated: false },
  ],
  "s3.tool": [
    {
      role: "arguments",
      text: '{"kind":"submit_purchase_request","supplier":"Flour supplier","quantityKg":200}',
      truncated: false,
    },
    { role: "result", text: "Proposed for approval.", truncated: false },
  ],
  "c.m_trigger": [
    {
      role: "input",
      text: "Please add ten cases of butter to tomorrow's delivery.",
      truncated: false,
    },
  ],
  "c.m_note": [
    {
      role: "entry",
      text: "Drafted a reply for approval.",
      truncated: false,
    },
  ],
};

/** The detail of one open sample node. Null: withheld or not a node. */
export function sampleExecutionDetail(
  caseId: string,
  nodeId: string,
): CaseExecutionNodeDetail | null {
  const node = SAMPLES[caseId]?.nodes.find((entry) => entry.nodeId === nodeId);
  if (node === undefined || node.access !== "open") return null;
  return {
    caseId,
    node,
    content: CONTENT[nodeId] ?? [],
    context:
      nodeId === "c.assign_order"
        ? [
            {
              entryId: "trigger:trigger_preview_request",
              producer: "c.trigger",
            },
            { entryId: "entry_preview_stock", producer: "c.note_stock" },
            { entryId: "entry_preview_supplier", producer: "c.note_supplier" },
          ]
        : [],
  };
}

type TimelineSample = Readonly<{
  caseId: string;
  origin: string;
  title: string | null;
  role?: "coordinator" | "specialist";
  /** Hours after the start of the sample day: the agent's work. */
  agent: readonly [number, number | null];
  /** A person's decision, when the Case waited for one. */
  person?: readonly [number, number | null];
  memories?: number;
  reads?: number;
  outcome: CaseTimelineOutcomeKind;
  withheld?: number;
  sideCaseOf?: string;
}>;

// A café's day, with now at 14:42. A chat shows its title, an email its
// subject and an order Case its action. A Slack Case shows its origin: its
// message belongs to its Slack conversation. A side Case shows the title of
// its proposal. Four events open the sample Cases above.
const TIMELINE_SAMPLES: readonly TimelineSample[] = [
  {
    caseId: MAIL_CASE,
    origin: "email",
    title: "Crushed gift box on order #1042",
    agent: [11.87, 11.97],
    person: [11.97, null],
    memories: 2,
    reads: 1,
    outcome: "waiting",
    withheld: 1,
  },
  {
    caseId: SLACK_CASE,
    origin: "portal_chat",
    title: "Raise Friday croissants to 140?",
    agent: [13.23, 13.33],
    person: [13.33, null],
    reads: 2,
    outcome: "waiting",
  },
  {
    caseId: "case_preview_timeline_invoice",
    origin: "portal_chat",
    title: "Pay the Hokkaido butter invoice",
    role: "specialist",
    agent: [14.03, 14.08],
    person: [14.08, null],
    reads: 1,
    outcome: "waiting",
    sideCaseOf: SLACK_CASE,
  },
  {
    caseId: "case_preview_timeline_courier",
    origin: "commerce_approval",
    title: "Attach tracking",
    agent: [13.03, 13.17],
    reads: 1,
    outcome: "failed",
  },
  {
    caseId: OPEN_CASE,
    origin: "portal_chat",
    title: "Draft the Saturday shift rota",
    agent: [14.3, null],
    memories: 2,
    reads: 1,
    outcome: "running",
  },
  {
    caseId: "case_preview_timeline_reply",
    origin: "inbox_assistant",
    title: null,
    role: "specialist",
    agent: [14.6, null],
    outcome: "running",
  },
  {
    caseId: LONG_CASE,
    origin: "direct",
    title: null,
    agent: [7.0, 7.1],
    reads: 4,
    outcome: "done",
  },
  {
    caseId: "case_preview_timeline_matcha",
    origin: "portal_chat",
    title: "Is the matcha tart nut-free?",
    agent: [8.2, 8.23],
    memories: 1,
    outcome: "done",
  },
  {
    caseId: "case_preview_timeline_order",
    origin: "commerce_approval",
    title: "Publish catalog listing",
    agent: [9.5, 9.68],
    reads: 2,
    outcome: "receipt",
  },
  {
    caseId: "case_preview_timeline_nuki",
    origin: "portal_chat",
    title: "Corporate order: 40 gift boxes for Nuki Inc.",
    agent: [11.17, 11.4],
    person: [11.4, 12.5],
    reads: 3,
    outcome: "receipt",
  },
  {
    caseId: "case_preview_timeline_pack",
    origin: "portal_chat",
    title: "Pack the Nuki gift boxes",
    role: "specialist",
    agent: [12.62, 12.9],
    outcome: "done",
    sideCaseOf: "case_preview_timeline_nuki",
  },
  {
    caseId: "case_preview_timeline_discount",
    origin: "slack",
    title: null,
    agent: [13.08, 13.15],
    person: [13.15, 13.67],
    outcome: "rejected",
  },
  {
    caseId: "case_preview_timeline_private",
    origin: "portal_chat",
    title: null,
    agent: [13.5, 13.55],
    outcome: "delivered",
    withheld: 3,
  },
];

/**
 * A sample timeline for the window from `from` to `to`. On today the
 * sample's 14:42 is now, so waiting and running Cases end at the now line.
 */
export function sampleCaseTimeline(
  from: number,
  to: number,
  now: number,
): CaseTimelineDay {
  const base = from <= now && now < to ? now - 14.7 * 3_600_000 : from;
  const hour = (h: number) => Math.round(base + h * 3_600_000);
  const cases: CaseTimelineCase[] = TIMELINE_SAMPLES.map((sample) => {
    const [started, settled] = sample.agent;
    const end = sample.person?.[1] ?? settled ?? sample.agent[0];
    const context =
      (sample.memories ?? 0) + (sample.reads ?? 0) === 0
        ? null
        : {
            at: hour(started + 0.02),
            memories: sample.memories ?? 0,
            reads: sample.reads ?? 0,
          };
    return {
      caseId: sample.caseId,
      origin: sample.origin,
      title: sample.title,
      startedAt: hour(started),
      source: { at: hour(started), trigger: "connector" },
      agent: {
        at: hour(started),
        role: sample.role ?? "coordinator",
        state:
          sample.outcome === "running"
            ? "running"
            : sample.outcome === "failed"
              ? "failed"
              : "completed",
      },
      context,
      spans: [
        {
          holder: "agent",
          from: hour(started),
          to: settled === null ? null : hour(settled),
        },
        ...(sample.person === undefined
          ? []
          : [
              {
                holder: "person" as const,
                from: hour(sample.person[0]),
                to: sample.person[1] === null ? null : hour(sample.person[1]),
              },
            ]),
      ],
      outcome: {
        kind: sample.outcome,
        at: hour(
          sample.outcome === "waiting"
            ? (sample.person?.[0] ?? started)
            : sample.outcome === "running"
              ? started
              : end,
        ),
      },
      receipt: sample.outcome === "receipt",
      withheld: sample.withheld ?? 0,
      sideCaseOf: sample.sideCaseOf ?? null,
    };
  });
  return { from, to, cases, truncated: false };
}

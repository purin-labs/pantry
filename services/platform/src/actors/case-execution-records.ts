import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  parseJsonOrNull,
} from "@seams/std";
import {
  ExecutionLabelTable,
  MAX_EXECUTION_ASSIGNMENTS,
  MAX_EXECUTION_ENTRIES,
  MAX_EXECUTION_OUTPUTS,
  MAX_EXECUTION_PROPOSALS,
  MAX_EXECUTION_STORED_TEXT,
  type CaseApprovalRecord,
  type CaseAssignmentRecord,
  type CaseCommerceProposalRecord,
  type CaseEntryRecord,
  type CaseExecutionCaseRecords,
  type CaseExecutionContentTarget,
  type CaseExecutionStoredContent,
  type CaseMailProposalRecord,
  type CaseOutputRecord,
  type CaseSessionProposalRecord,
  type CaseTriggerRecord,
} from "../case-execution/records";

type Row = Record<string, SqlStorageValue>;

/** The longest title a record gives its Case. */
const MAX_TITLE = 120;

function clipTitle(text: string): string | null {
  const line = text.replace(/\s+/gu, " ").trim();
  if (line.length === 0) return null;
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

/**
 * What a trigger is about: the title stored with it, else the first line a
 * person wrote in its message. A system manifest gives none. The record's
 * reader shows it only under the trigger's own label.
 */
function triggerTitle(trigger: Record<string, unknown>): string | null {
  if (typeof trigger.title === "string") return clipTitle(trigger.title);
  const content = isRecord(trigger.content) ? trigger.content : null;
  if (
    content === null ||
    (content.kind !== "user_message" && content.kind !== "record_message") ||
    !isRecord(content.message)
  )
    return null;
  const message = content.message;
  const parts = [
    message.firstPart,
    ...(Array.isArray(message.remainingParts) ? message.remainingParts : []),
  ];
  for (const part of parts) {
    if (
      !isRecord(part) ||
      part.kind !== "text" ||
      typeof part.text !== "string"
    )
      continue;
    // Slack mentions and channel markers name no subject.
    const text = part.text.replace(/<[@#!][^>]*>/gu, " ");
    for (const line of text.split("\n")) {
      const title = clipTitle(line);
      if (title !== null) return title;
    }
  }
  return null;
}

/** What a commerce proposal asks for, in the words of its action kind. */
function commerceTitle(proposal: Record<string, unknown>): string | null {
  const plane = isRecord(proposal.proposal) ? proposal.proposal : null;
  if (plane !== null) {
    if (typeof plane.displayName === "string") {
      const named = clipTitle(plane.displayName);
      if (named !== null) return `Change ${named}`;
    }
    return typeof plane.kind === "string" ? sentence(plane.kind) : null;
  }
  const action = isRecord(proposal.action) ? proposal.action : null;
  return action !== null && typeof action.kind === "string"
    ? sentence(action.kind)
    : null;
}

function sentence(kind: string): string | null {
  const words = kind.replace(/_/gu, " ").trim();
  return words.length === 0
    ? null
    : clipTitle(`${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`);
}

const ROLES: readonly CaseAssignmentRecord["role"][] = [
  "coordinator",
  "research",
  "specialist",
];

/**
 * The execution records of this Case, as its tables hold them. Nothing is
 * inferred: a row that does not have the stored shape is left out, and a
 * missing reference stays missing. The newest rows are kept when a table
 * holds more than the bound.
 */
export function readCaseExecutionRecords(
  sql: SqlStorage,
): CaseExecutionCaseRecords | null {
  const meta = sql
    .exec<{ case_id: string; revision: number }>(
      "SELECT case_id, revision FROM case_meta WHERE singleton = 1",
    )
    .toArray()[0];
  if (meta === undefined) return null;
  const labels = new ExecutionLabelTable();
  let truncated = false;
  // The store reads each table newest first and stops at the bound, so a long
  // Case costs the bound and no more. The rows come back in stored order.
  const newest = (select: string, limit: number, order = "rowid"): Row[] => {
    const rows = sql
      .exec<Row>(`${select} ORDER BY ${order} DESC LIMIT ?`, limit + 1)
      .toArray();
    if (rows.length > limit) {
      truncated = true;
      rows.length = limit;
    }
    return rows.reverse();
  };

  const entries: CaseEntryRecord[] = newest(
    "SELECT entry_id, sequence, flow_label_json FROM case_journal",
    MAX_EXECUTION_ENTRIES,
    "sequence",
  ).flatMap((row) =>
    typeof row.entry_id === "string" && isPositiveInteger(row.sequence)
      ? [
          {
            entryId: row.entry_id,
            sequence: row.sequence,
            label: labels.intern(text(row.flow_label_json)),
          },
        ]
      : [],
  );
  const journalThrough = entries.at(-1)?.sequence ?? 0;

  const connectorIds = parsed(
    newest("SELECT payload FROM case_binding", MAX_EXECUTION_ASSIGNMENTS),
  ).flatMap((binding) =>
    typeof binding.connectorId === "string" ? [binding.connectorId] : [],
  );

  const triggers: CaseTriggerRecord[] = parsed(
    newest("SELECT payload FROM case_trigger", MAX_EXECUTION_PROPOSALS),
  ).flatMap((trigger) => {
    const source = isRecord(trigger.source) ? trigger.source.kind : null;
    return typeof trigger.triggerId === "string" &&
      (source === "connector" || source === "cue" || source === "api") &&
      isNonNegativeInteger(trigger.acceptedAt)
      ? [
          {
            triggerId: trigger.triggerId,
            source,
            acceptedAt: trigger.acceptedAt,
            title: triggerTitle(trigger),
          },
        ]
      : [];
  });

  const assignments: CaseAssignmentRecord[] = parsed(
    newest(
      "SELECT lifecycle_json AS payload FROM case_assignment",
      MAX_EXECUTION_ASSIGNMENTS,
    ),
  ).flatMap((lifecycle) => {
    const record = assignmentRecord(lifecycle);
    return record === null ? [] : [record];
  });

  const sessionProposals: CaseSessionProposalRecord[] = newest(
    "SELECT payload, acceptance_json FROM case_proposal",
    MAX_EXECUTION_PROPOSALS,
  ).flatMap((row) => {
    const proposal = json(row.payload);
    const acceptance = json(row.acceptance_json);
    const disposition =
      acceptance !== null && isRecord(acceptance.disposition)
        ? acceptance.disposition.kind
        : null;
    if (
      proposal === null ||
      typeof proposal.proposalId !== "string" ||
      typeof proposal.assignmentId !== "string" ||
      typeof proposal.sessionId !== "string" ||
      typeof proposal.turnId !== "string" ||
      !Array.isArray(proposal.entries) ||
      (disposition !== "accepted" &&
        disposition !== "rebase_required" &&
        disposition !== "rejected")
    )
      return [];
    return [
      {
        proposalId: proposal.proposalId,
        assignmentId: proposal.assignmentId,
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        entryIds: proposal.entries.flatMap((entry: unknown) =>
          isRecord(entry) && typeof entry.entryId === "string"
            ? [entry.entryId]
            : [],
        ),
        state: disposition,
        recordedAt: time(acceptance?.acceptedAt),
      },
    ];
  });

  const commerceProposals: CaseCommerceProposalRecord[] = newest(
    "SELECT payload, acceptance_json FROM case_commerce_proposal",
    MAX_EXECUTION_PROPOSALS,
  ).flatMap((row) => {
    const proposal = json(row.payload);
    const acceptance = json(row.acceptance_json);
    if (proposal === null || typeof proposal.proposalId !== "string") return [];
    const origin = isRecord(proposal.origin) ? proposal.origin : null;
    const binding =
      acceptance !== null && isRecord(acceptance.flowBinding)
        ? acceptance.flowBinding
        : null;
    const agent =
      origin !== null &&
      origin.kind === "agent_session" &&
      typeof origin.sessionId === "string" &&
      typeof origin.assignmentId === "string"
        ? { sessionId: origin.sessionId, assignmentId: origin.assignmentId }
        : null;
    return [
      {
        proposalId: proposal.proposalId,
        origin: agent,
        turnId:
          agent !== null &&
          binding !== null &&
          typeof binding.turnId === "string"
            ? binding.turnId
            : null,
        toolCallId:
          acceptance !== null && typeof acceptance.toolCallId === "string"
            ? acceptance.toolCallId
            : null,
        recordedAt: time(acceptance?.acceptedAt),
        label: labels.intern(
          binding !== null && isRecord(binding.flowLabel)
            ? JSON.stringify(binding.flowLabel)
            : null,
        ),
        title: commerceTitle(proposal),
      },
    ];
  });

  const approvals: CaseApprovalRecord[] = parsed(
    newest(
      "SELECT payload FROM case_commerce_approval",
      MAX_EXECUTION_PROPOSALS,
    ),
  ).flatMap((approval): CaseApprovalRecord[] => {
    const request = isRecord(approval.request) ? approval.request : null;
    if (
      request === null ||
      typeof request.actionNonce !== "string" ||
      typeof request.proposalId !== "string" ||
      !isNonNegativeInteger(request.requestedAt)
    )
      return [];
    const base = {
      actionNonce: request.actionNonce,
      proposalId: request.proposalId,
      requestedAt: request.requestedAt,
    };
    if (approval.kind === "waiting")
      return [{ ...base, state: "waiting", decidedAt: null }];
    if (approval.kind === "lapsed")
      return isNonNegativeInteger(approval.lapsedAt)
        ? [{ ...base, state: "expired", decidedAt: approval.lapsedAt }]
        : [];
    const decision = isRecord(approval.decision) ? approval.decision : null;
    return approval.kind === "decided" &&
      decision !== null &&
      (decision.kind === "approved" || decision.kind === "rejected") &&
      isNonNegativeInteger(decision.decidedAt)
      ? [{ ...base, state: decision.kind, decidedAt: decision.decidedAt }]
      : [];
  });

  // Only the latest version of a mail proposal stands.
  const mailProposals: CaseMailProposalRecord[] = parsed(
    newest(
      `SELECT payload FROM case_email_proposal p
       WHERE version = (SELECT MAX(version) FROM case_email_proposal q
                        WHERE q.proposal_id = p.proposal_id)`,
      MAX_EXECUTION_PROPOSALS,
      "p.rowid",
    ),
  ).flatMap((proposal) => {
    const lifecycle = isRecord(proposal.lifecycle)
      ? proposal.lifecycle.kind
      : null;
    if (
      typeof proposal.proposalId !== "string" ||
      !isPositiveInteger(proposal.version) ||
      typeof lifecycle !== "string"
    )
      return [];
    return [
      {
        proposalId: proposal.proposalId,
        version: proposal.version,
        state: mailProposalState(lifecycle),
        integrationAccountId:
          typeof proposal.integrationAccountId === "string"
            ? proposal.integrationAccountId
            : mailboxOfBindings(connectorIds),
        recordedAt: time(proposal.createdAt),
      },
    ];
  });

  const outputs: CaseOutputRecord[] = parsed(
    newest(
      "SELECT lifecycle_json AS payload FROM case_output",
      MAX_EXECUTION_OUTPUTS,
    ),
  ).flatMap((lifecycle) => {
    const record = outputRecord(lifecycle, labels);
    return record === null ? [] : [record];
  });

  return {
    caseId: meta.case_id,
    revision: meta.revision,
    journalThrough,
    connectorIds,
    labels: labels.labels,
    triggers,
    assignments,
    sessionProposals,
    commerceProposals,
    approvals,
    mailProposals,
    outputs,
    entries,
    truncated,
  };
}

/**
 * The stored text behind one record of this Case. The caller has already
 * decided that its reader may see the record.
 */
export function readCaseExecutionContent(
  sql: SqlStorage,
  target: CaseExecutionContentTarget,
): readonly CaseExecutionStoredContent[] | null {
  switch (target.kind) {
    case "trigger":
      return entryContent(sql, [`trigger:${target.triggerId}`], "input");
    case "session_proposal": {
      const proposal = payloads(
        sql,
        "SELECT payload FROM case_proposal WHERE proposal_id = ?",
        target.proposalId,
      )[0];
      if (proposal === undefined || !Array.isArray(proposal.entries))
        return null;
      return proposal.entries.flatMap((entry: unknown) =>
        isRecord(entry) ? contentTexts(entry.content, "entry") : [],
      );
    }
    case "commerce_proposal":
      return entryContent(
        sql,
        [`commerce_proposal:${target.proposalId}`],
        "action",
      );
    case "output": {
      const lifecycle = payloads(
        sql,
        "SELECT lifecycle_json AS payload FROM case_output WHERE output_id = ?",
        target.outputId,
      )[0];
      const output =
        lifecycle !== undefined && isRecord(lifecycle.output)
          ? lifecycle.output
          : null;
      const delivery =
        output !== null && isRecord(output.delivery) ? output.delivery : null;
      return delivery === null
        ? null
        : contentTexts(delivery.content, "message");
    }
    default:
      return null;
  }
}

function entryContent(
  sql: SqlStorage,
  entryIds: readonly string[],
  role: CaseExecutionStoredContent["role"],
): readonly CaseExecutionStoredContent[] | null {
  const found: CaseExecutionStoredContent[] = [];
  for (const entryId of entryIds) {
    const content = payloads(
      sql,
      "SELECT payload FROM case_journal WHERE entry_id = ?",
      entryId,
    )[0];
    if (content === undefined) return null;
    found.push(...contentTexts(content, role));
  }
  return found;
}

/**
 * The text a stored Case content carries. A message gives its text parts,
 * and each link or attachment is named by its kind. Any other content is
 * named by its kind and not read.
 */
function contentTexts(
  content: unknown,
  role: CaseExecutionStoredContent["role"],
): CaseExecutionStoredContent[] {
  if (!isRecord(content)) return [];
  if (content.kind === "text" && typeof content.text === "string")
    return [{ role, text: bound(content.text) }];
  const message = isRecord(content.message) ? content.message : null;
  if (
    (content.kind === "user_message" || content.kind === "record_message") &&
    message !== null
  ) {
    const parts: unknown[] = [
      message.firstPart,
      ...(Array.isArray(message.remainingParts) ? message.remainingParts : []),
    ];
    return parts.flatMap((part) =>
      !isRecord(part) || typeof part.kind !== "string"
        ? []
        : part.kind === "text" && typeof part.text === "string"
          ? [{ role, text: bound(part.text) }]
          : [{ role, text: `(${part.kind})` }],
    );
  }
  return typeof content.kind === "string"
    ? [{ role, text: `(${content.kind})` }]
    : [];
}

function assignmentRecord(
  lifecycle: Record<string, unknown>,
): CaseAssignmentRecord | null {
  const assignment = isRecord(lifecycle.assignment)
    ? lifecycle.assignment
    : null;
  const role = ROLES.find((entry) => entry === assignment?.role);
  if (
    assignment === null ||
    role === undefined ||
    typeof assignment.assignmentId !== "string" ||
    typeof assignment.sessionId !== "string" ||
    !isNonNegativeInteger(assignment.caseRevision)
  )
    return null;
  const context = isRecord(assignment.context) ? assignment.context : null;
  const contextEntryIds =
    context !== null && Array.isArray(context.entries)
      ? context.entries.flatMap((entry: unknown) =>
          isRecord(entry) && typeof entry.entryId === "string"
            ? [entry.entryId]
            : [],
        )
      : [];
  const base = {
    assignmentId: assignment.assignmentId,
    sessionId: assignment.sessionId,
    role,
    caseRevision: assignment.caseRevision,
    contextEntryIds,
  };
  const start = isRecord(lifecycle.start) ? lifecycle.start : null;
  const startedAt = time(start?.acceptedAt);
  switch (lifecycle.kind) {
    case "assigned":
      return {
        ...base,
        state: "assigned",
        startedAt: null,
        settledAt: null,
        failureCode: null,
      };
    case "running":
      return {
        ...base,
        state: "running",
        startedAt,
        settledAt: null,
        failureCode: null,
      };
    case "settled": {
      const disposition = isRecord(lifecycle.disposition)
        ? lifecycle.disposition
        : null;
      // An abandoned assignment shows as a failure with its own code.
      const abandoned = disposition?.kind === "abandoned";
      const kind = abandoned ? "failed" : disposition?.kind;
      if (
        disposition === null ||
        (kind !== "completed" &&
          kind !== "cancelled" &&
          kind !== "failed" &&
          kind !== "budget_exhausted")
      )
        return null;
      return {
        ...base,
        state: kind,
        startedAt,
        settledAt: time(disposition.settledAt),
        failureCode: abandoned
          ? "case_assignment_abandoned"
          : kind === "failed" && typeof disposition.code === "string"
            ? disposition.code.slice(0, 200)
            : null,
      };
    }
    default:
      return null;
  }
}

function outputRecord(
  lifecycle: Record<string, unknown>,
  labels: ExecutionLabelTable,
): CaseOutputRecord | null {
  const output = isRecord(lifecycle.output) ? lifecycle.output : null;
  const delivery =
    output !== null && isRecord(output.delivery) ? output.delivery : null;
  const source =
    output !== null && isRecord(output.source) ? output.source : null;
  if (
    output === null ||
    delivery === null ||
    source === null ||
    typeof output.outputId !== "string" ||
    typeof output.entryId !== "string" ||
    typeof output.connectorId !== "string" ||
    typeof delivery.deliveryId !== "string" ||
    !isNonNegativeInteger(delivery.addressedAt)
  )
    return null;
  let named: CaseOutputRecord["source"];
  if (source.kind === "agent_turn" && typeof source.proposalId === "string")
    named = { kind: "agent_turn", proposalId: source.proposalId };
  else if (
    (source.kind === "commerce_outcome" ||
      source.kind === "commerce_approval_notice") &&
    typeof source.proposalId === "string" &&
    typeof source.actionNonce === "string"
  )
    named = {
      kind: source.kind,
      proposalId: source.proposalId,
      actionNonce: source.actionNonce,
    };
  else if (source.kind === "operator_command")
    named = { kind: "operator_command" };
  else return null;
  const binding = isRecord(output.flowBinding) ? output.flowBinding : null;
  const receipt = isRecord(lifecycle.receipt) ? lifecycle.receipt : null;
  const delivered =
    lifecycle.kind === "settled" &&
    receipt !== null &&
    typeof receipt.nativeReceiptId === "string" &&
    isNonNegativeInteger(receipt.deliveredAt)
      ? {
          nativeReceiptId: receipt.nativeReceiptId,
          deliveredAt: receipt.deliveredAt,
        }
      : null;
  if (
    lifecycle.kind !== "pending" &&
    lifecycle.kind !== "held" &&
    delivered === null
  )
    return null;
  return {
    outputId: output.outputId,
    deliveryId: delivery.deliveryId,
    connectorId: output.connectorId,
    entryId: output.entryId,
    source: named,
    state: delivered === null ? "pending" : "delivered",
    addressedAt: delivery.addressedAt,
    receipt: delivered,
    label: labels.intern(
      binding !== null && isRecord(binding.flowLabel)
        ? JSON.stringify(binding.flowLabel)
        : null,
    ),
  };
}

function mailProposalState(lifecycle: string): CaseMailProposalRecord["state"] {
  switch (lifecycle) {
    case "awaiting_approval":
    case "approved":
    case "sent":
      return lifecycle;
    case "draft_creation_indeterminate":
    case "send_indeterminate":
      return "unresolved";
    default:
      return "closed";
  }
}

const GMAIL_CONNECTOR_PREFIX = "connector_gmail_";

/** The mailbox a Case is bound to, when exactly one Gmail binding names it. */
function mailboxOfBindings(connectorIds: readonly string[]): string | null {
  const mailboxes = connectorIds.flatMap((connectorId) =>
    connectorId.startsWith(GMAIL_CONNECTOR_PREFIX)
      ? [connectorId.slice(GMAIL_CONNECTOR_PREFIX.length)]
      : [],
  );
  return mailboxes.length === 1 ? (mailboxes[0] ?? null) : null;
}

function payloads(
  sql: SqlStorage,
  query: string,
  ...bindings: SqlStorageValue[]
): Record<string, unknown>[] {
  return parsed(sql.exec<Row>(query, ...bindings).toArray());
}

function parsed(rows: readonly Row[]): Record<string, unknown>[] {
  return rows.flatMap((row) => {
    const payload = json(row.payload);
    return payload === null ? [] : [payload];
  });
}

function json(
  value: SqlStorageValue | undefined,
): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? parseJsonOrNull(value) : null;
  return isRecord(parsed) ? parsed : null;
}

function text(value: SqlStorageValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function time(value: unknown): number | null {
  return isNonNegativeInteger(value) ? value : null;
}

function bound(value: string): string {
  return value.length > MAX_EXECUTION_STORED_TEXT
    ? value.slice(0, MAX_EXECUTION_STORED_TEXT)
    : value;
}

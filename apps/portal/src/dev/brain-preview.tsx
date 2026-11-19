import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router";
import { parseEntityRef } from "@seams/commerce-client";
import "../styles.css";
import {
  brainItemsToReview,
  evalTaskId,
  EVAL_SCORER_VERSION,
  type EvalCommand,
  type EvalRevisionView,
  type EvalRunCommand,
  type EvalRunResult,
  type EvalRunView,
  type EvalScenario,
  type EvalTaskResult,
  type EvalView,
  type MemoryCommand,
  type MemoryContent,
  type MemoryRevisionView,
  type MemoryView,
} from "@seams/control-api";

import {
  ControlApiError,
  controlMutation,
  controlRead,
} from "../control-client";
import { EMPTY_AGENT_OPERATIONS_SNAPSHOT } from "../agent-operations";
import type { AgentOperationsSnapshot } from "@seams/control-api/portal/agent-operations";
import { useBrainSummary } from "../brain-summary";
import type { BrainTransport } from "../features/brain/api";
import {
  SAMPLE_EXECUTION_CASES,
  sampleCaseTimeline,
  sampleExecutionDetail,
  sampleExecutionPage,
} from "./brain-execution-sample";
import { BrainRoute } from "../features/brain/route";
import { ConnectedChatPage as ChatPage } from "../features/chat/route";
import { UNAVAILABLE_ACCESS } from "./unavailable-access";
import { installChatPreviewFetch } from "./chat-preview-data";
import { PageHeader } from "../page-components";
import { PortalFrame } from "../shell";

const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Brain preview is development-only.");

const params = new URL(window.location.href).searchParams;
const scenario = params.get("scenario") ?? "populated";
if (params.get("theme") === "dark")
  document.documentElement.dataset.portalTheme = "dark";

const DAY = 86_400_000;
const NOW = 1_791_620_000_000;
const REVIEWER = "person_preview_reviewer";

const CORRECTION = {
  kind: "proposal_correction",
  caseId: "case_gmail_preview_supplier_thread",
  integrationAccountId: "integration_account_preview",
  proposalId: "proposal_preview_supplier_reply",
  version: 2,
  digest: "c".repeat(64),
} as const;

function content(
  statement: string,
  kind: MemoryContent["memoryKind"],
): MemoryContent {
  return {
    memoryKind: kind,
    statement,
    applicability: {
      kind: "commerce_entity",
      merchantId: "merchant_preview",
      entity: parseEntityRef({
        origin: "custom",
        typeId: "trade_partner",
        entityId: "supplier_preview_flour",
      }),
    },
    validity: {
      timezone: "UTC",
      effectiveFrom: "2026-10-10",
      effectiveUntil: null,
      dependsOn: [CORRECTION],
    },
    evidence: [CORRECTION],
    sourceCaseId: CORRECTION.caseId,
  };
}

const AGENT = {
  kind: "agent",
  caseId: CORRECTION.caseId,
  assignmentId: "assignment_preview_learning",
  sessionId: "session_preview_learning",
} as const;

function decision(at: number) {
  return { reviewerPersonId: REVIEWER, commandId: `seed_${at}`, decidedAt: at };
}

/** A message of a person in a Portal chat, which a taught memory cites. */
const INSTRUCTION = {
  kind: "operator_instruction",
  caseId: "case_preview_reorder_flour",
  entryId: "trigger:trigger_preview_teach",
  digest: "d".repeat(64),
} as const;

const POPULATED: readonly MemoryView[] = [
  {
    memoryId: "memory_preview_sunday",
    headRevision: 1,
    revisions: [
      {
        memoryKind: "fact",
        statement: "The shop closes at 18:00 on Sundays.",
        applicability: { kind: "portal_chat" },
        validity: {
          timezone: "UTC",
          effectiveFrom: "2026-10-13",
          effectiveUntil: null,
          dependsOn: [INSTRUCTION],
        },
        evidence: [INSTRUCTION],
        sourceCaseId: INSTRUCTION.caseId,
        revision: 1,
        proposedBy: {
          kind: "agent",
          caseId: INSTRUCTION.caseId,
          assignmentId: "assignment_preview_chat",
          sessionId: "session_preview_chat",
        },
        proposedAt: NOW - 1_800_000,
        kind: "candidate",
      },
    ],
  },
  {
    memoryId: "memory_preview_cutoff",
    headRevision: 1,
    revisions: [
      {
        ...content(
          "Next-day orders close at noon. Changes after noon are refused.",
          "lesson",
        ),
        revision: 1,
        proposedBy: AGENT,
        proposedAt: NOW - 2 * 3_600_000,
        kind: "candidate",
      },
    ],
  },
  {
    memoryId: "memory_preview_delivery",
    headRevision: 2,
    revisions: [
      {
        ...content("Deliveries arrive on Tuesday and Friday.", "fact"),
        revision: 1,
        proposedBy: AGENT,
        proposedAt: NOW - 9 * DAY,
        kind: "accepted",
        acceptance: decision(NOW - 8 * DAY),
      },
      {
        ...content(
          "Deliveries arrive on Tuesday, Thursday and Friday.",
          "fact",
        ),
        revision: 2,
        proposedBy: {
          kind: "operator",
          personId: REVIEWER,
          submission: "shared_review",
        },
        proposedAt: NOW - DAY,
        kind: "candidate",
      },
    ],
  },
  {
    memoryId: "memory_preview_invoice",
    headRevision: 1,
    revisions: [
      {
        ...content(
          "Send invoice questions to the accounts contact, not the sales contact.",
          "preference",
        ),
        revision: 1,
        proposedBy: AGENT,
        proposedAt: NOW - 20 * DAY,
        kind: "accepted",
        acceptance: decision(NOW - 19 * DAY),
      },
    ],
  },
  {
    memoryId: "memory_preview_holiday",
    headRevision: 1,
    revisions: [
      {
        ...content(
          "The supplier is closed in the first week of January.",
          "fact",
        ),
        revision: 1,
        proposedBy: AGENT,
        proposedAt: NOW - 40 * DAY,
        kind: "revoked",
        acceptance: decision(NOW - 39 * DAY),
        revocation: decision(NOW - 3 * DAY),
      },
    ],
  },
];

let memories: readonly MemoryView[] = scenario === "empty" ? [] : POPULATED;

function refuse(code: string): never {
  throw new ControlApiError("Preview refused the request.", "unknown", {
    ok: false,
    error: code,
  });
}

/** A small stand-in for the Memory store, enough to exercise the page. */
function apply(command: MemoryCommand): unknown {
  const memory = memories.find((item) => item.memoryId === command.memoryId);
  if (memory === undefined) return refuse("memory_unavailable");
  if (memory.headRevision !== command.expectedRevision)
    return refuse("memory_conflict");
  const at = Date.now();
  let revisions: readonly MemoryRevisionView[] = memory.revisions;
  let decided = memory.headRevision;
  const replace = (
    revision: number,
    next: (current: MemoryRevisionView) => MemoryRevisionView,
  ) => {
    revisions = revisions.map((current) =>
      current.revision === revision ? next(current) : current,
    );
  };
  const strip = (current: MemoryRevisionView) => ({
    memoryKind: current.memoryKind,
    statement: current.statement,
    applicability: current.applicability,
    validity: current.validity,
    evidence: current.evidence,
    sourceCaseId: current.sourceCaseId,
    revision: current.revision,
    proposedBy: current.proposedBy,
    proposedAt: current.proposedAt,
  });
  if (command.kind === "propose") {
    if (command.content.validity.timezone === "Nowhere")
      return refuse("memory_invalid");
    const head = revisions.at(-1);
    decided = memory.headRevision + 1;
    if (head?.kind === "candidate")
      replace(head.revision, (current) => ({
        ...strip(current),
        kind: "rejected",
        rejection: {
          ...decision(at),
          reason: "revised",
          replacementRevision: decided,
        },
      }));
    revisions = [
      ...revisions,
      {
        ...command.content,
        revision: decided,
        proposedBy: {
          kind: "operator",
          personId: REVIEWER,
          submission: "shared_review",
        },
        proposedAt: at,
        kind: "candidate",
      },
    ];
  } else {
    decided = command.revision;
    if (command.kind === "accept") {
      for (const current of revisions)
        if (current.kind === "accepted")
          replace(current.revision, (accepted) => ({
            ...strip(accepted),
            kind: "superseded",
            acceptance: decision(at - 1),
            supersession: {
              replacementRevision: command.revision,
              supersededAt: at,
            },
          }));
      replace(command.revision, (current) => ({
        ...strip(current),
        kind: "accepted",
        acceptance: decision(at),
      }));
    } else if (command.kind === "reject")
      replace(command.revision, (current) => ({
        ...strip(current),
        kind: "rejected",
        rejection: { ...decision(at), reason: "declined" },
      }));
    else
      replace(command.revision, (current) => ({
        ...strip(current),
        kind: "revoked",
        acceptance: decision(at - 1),
        revocation: decision(at),
      }));
  }
  const headRevision = revisions.at(-1)?.revision ?? memory.headRevision;
  memories = memories.map((item) =>
    item.memoryId === memory.memoryId
      ? { memoryId: memory.memoryId, headRevision, revisions }
      : item,
  );
  const state = revisions.find((current) => current.revision === decided);
  return {
    ok: true,
    receipt: {
      commandId: command.commandId,
      memoryId: memory.memoryId,
      revision: decided,
      headRevision,
      state: state?.kind ?? "candidate",
    },
  };
}

const SUPPLIER = { verificationId: "verification_preview_flour", revision: 1 };

function evalScenario(
  scenarioId: string,
  role: EvalScenario["role"],
  title: string,
  sydney: readonly [number, number],
  criteria: EvalScenario["criteria"],
  sender = SUPPLIER,
): EvalScenario {
  return {
    scenarioId,
    role,
    title,
    sender,
    message: {
      subject: "Change to tomorrow's order",
      body: "Please add ten cases of butter to tomorrow's delivery.",
      receivedAt: Date.UTC(2026, 9, 12, sydney[0] - 11, sydney[1]),
      timezone: "Australia/Sydney",
    },
    criteria,
  };
}

const ANSWERS = {
  criterionId: "answers",
  kind: "outcome",
  expected: "reply_now",
} as const;

const CUTOFF_SCENARIOS: readonly EvalScenario[] = [
  evalScenario(
    "late_change",
    "target",
    "Order change after the cutoff",
    [15, 30],
    [
      {
        criterionId: "escalates",
        kind: "outcome",
        expected: "approval_required",
      },
      { criterionId: "names_cutoff", kind: "reply_includes", text: "cutoff" },
    ],
  ),
  evalScenario(
    "midday_change",
    "target",
    "Order change before the corrected cutoff",
    [13, 0],
    [ANSWERS],
  ),
  evalScenario(
    "early_change",
    "control",
    "Order change in the morning",
    [9, 30],
    [ANSWERS],
  ),
  evalScenario(
    "other_supplier",
    "control",
    "The same request from another supplier",
    [15, 30],
    [
      ANSWERS,
      { criterionId: "no_cutoff", kind: "reply_excludes", text: "cutoff" },
    ],
    { verificationId: "verification_preview_dairy", revision: 1 },
  ),
];

function evalRevision(
  title: string,
  scenarios: readonly EvalScenario[],
): Pick<
  EvalRevisionView,
  "title" | "subject" | "scenarios" | "evidence" | "sourceCaseId"
> {
  return {
    title,
    subject: {
      kind: "mailbox_reply",
      integrationAccountId: CORRECTION.integrationAccountId,
    },
    scenarios,
    evidence: [CORRECTION],
    sourceCaseId: CORRECTION.caseId,
  };
}

let evals: readonly EvalView[] =
  scenario === "empty"
    ? []
    : [
        {
          evalId: "eval_preview_cutoff",
          headRevision: 1,
          revisions: [
            {
              ...evalRevision("Next-day order cutoff", CUTOFF_SCENARIOS),
              revision: 1,
              proposedBy: AGENT,
              proposedAt: NOW - 3 * DAY,
              kind: "accepted",
              acceptance: decision(NOW - 2 * DAY),
            },
          ],
        },
        {
          evalId: "eval_preview_invoice",
          headRevision: 1,
          revisions: [
            {
              ...evalRevision("Invoice questions go to accounts", [
                evalScenario(
                  "invoice_question",
                  "target",
                  "A question about an invoice",
                  [10, 0],
                  [
                    {
                      criterionId: "escalates",
                      kind: "outcome",
                      expected: "approval_required",
                    },
                  ],
                ),
              ]),
              revision: 1,
              proposedBy: AGENT,
              proposedAt: NOW - 3_600_000,
              kind: "candidate",
            },
          ],
        },
      ];

const CANDIDATE_MEMORY = { memoryId: "memory_preview_delivery", revision: 2 };

/** The tasks a finished preview run reports: the proposal fixes one scenario. */
function settledTasks(run: EvalRunView): readonly EvalTaskResult[] {
  const tasks: EvalTaskResult[] = [];
  for (const entry of CUTOFF_SCENARIOS)
    for (const route of run.routes)
      for (const configuration of run.configurations) {
        const key = {
          taskId: evalTaskId(entry.scenarioId, configuration.kind, route),
          scenarioId: entry.scenarioId,
          configuration: configuration.kind,
          route,
        };
        if (route !== "satyr_platform") {
          tasks.push({
            ...key,
            outcome: { kind: "unavailable", reason: "authority_unavailable" },
            execution: null,
            pins: null,
            totalTokens: null,
          });
          continue;
        }
        const late = entry.scenarioId === "late_change";
        const escalated =
          late ||
          (entry.scenarioId === "midday_change" &&
            configuration.kind === "current");
        const criteria = entry.criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          met:
            criterion.kind === "outcome"
              ? (criterion.expected === "approval_required") === escalated
              : criterion.kind === "reply_includes"
                ? escalated
                : !escalated,
        }));
        tasks.push({
          ...key,
          outcome: {
            kind: "assessed",
            verdict: criteria.every((criterion) => criterion.met)
              ? "passed"
              : "failed",
            criteria,
            observation: {
              outcome: escalated ? "approval_required" : "reply_now",
              reply: escalated
                ? "This change is after the cutoff, so I have asked the team to confirm it."
                : "Confirmed. We will add it to tomorrow's order.",
              memory:
                entry.scenarioId === "other_supplier"
                  ? []
                  : [
                      {
                        memoryId: CANDIDATE_MEMORY.memoryId,
                        revision: configuration.kind === "candidate" ? 2 : 1,
                      },
                    ],
            },
          },
          execution: {
            assignmentId: `assignment_eval_preview_${tasks.length}`,
            sessionId: `session_eval_preview_${tasks.length}`,
            turnId: `turn_eval_preview_${tasks.length}`,
          },
          pins: {
            model: "moonshotai/kimi-k3",
            modelRouteDigest: "a".repeat(64),
            instructionDigest: "b".repeat(64),
            toolCatalogDigest: "c".repeat(64),
            contextBundleDigest: "d".repeat(64),
            policyVersion: 3,
          },
          totalTokens: 1_840,
        });
      }
  return tasks;
}

function settle(run: EvalRunView, at: number): EvalRunResult {
  const {
    tasks: _tasks,
    state: _state,
    settledAt: _settledAt,
    ...header
  } = run;
  return {
    ...header,
    state: "completed",
    settledAt: at,
    tasks: settledTasks(run),
  };
}

function previewRun(
  runId: string,
  startedAt: number,
  routes: EvalRunView["routes"],
  configurations: EvalRunView["configurations"],
): EvalRunView {
  const tasks = CUTOFF_SCENARIOS.flatMap((entry) =>
    routes.flatMap((route) =>
      configurations.map((configuration) => ({
        taskId: evalTaskId(entry.scenarioId, configuration.kind, route),
        scenarioId: entry.scenarioId,
        configuration: configuration.kind,
        route,
        state: "pending" as const,
      })),
    ),
  );
  return {
    runId,
    eval: { evalId: "eval_preview_cutoff", revision: 1 },
    caseId: `case_eval_${runId.slice("evalrun_".length)}`,
    startedByPersonId: REVIEWER,
    startedAt,
    routes,
    configurations,
    scorer: EVAL_SCORER_VERSION,
    state: "running",
    tasks,
  };
}

let evalRuns: readonly EvalRunView[] =
  scenario === "empty"
    ? []
    : [
        settle(
          previewRun(
            "evalrun_preview_compared",
            NOW - 5 * 3_600_000,
            ["satyr_platform", "organisation_openai_api_key"],
            [
              { kind: "current" },
              { kind: "candidate", memory: CANDIDATE_MEMORY },
            ],
          ),
          NOW - 5 * 3_600_000 + 90_000,
        ),
      ];

/** A run in progress finishes on the second read after it started. */
const runReads = new Map<string, number>();

function readRuns(evalId: string): readonly EvalRunView[] {
  evalRuns = evalRuns.map((run) => {
    if (run.state !== "running" && run.state !== "pending") return run;
    const reads = (runReads.get(run.runId) ?? 0) + 1;
    runReads.set(run.runId, reads);
    return reads < 3 ? run : settle(run, Date.now());
  });
  return evalRuns.filter((run) => run.eval.evalId === evalId);
}

function applyEval(command: EvalCommand): unknown {
  const target = evals.find((entry) => entry.evalId === command.evalId);
  if (target === undefined) return refuse("eval_unavailable");
  if (target.headRevision !== command.expectedRevision)
    return refuse("eval_conflict");
  const at = Date.now();
  if (command.kind === "revise") {
    const revision = target.headRevision + 1;
    evals = evals.map((entry) =>
      entry.evalId === target.evalId
        ? {
            ...target,
            headRevision: revision,
            revisions: [
              // A person's edit replaces an open candidate.
              ...target.revisions.map((current): EvalRevisionView => {
                if (current.kind !== "candidate") return current;
                const { kind: _kind, ...rest } = current;
                return {
                  ...rest,
                  kind: "rejected",
                  rejection: {
                    ...decision(at),
                    reason: "revised",
                    replacementRevision: revision,
                  },
                };
              }),
              {
                ...evalRevision(
                  command.content.title,
                  command.content.scenarios,
                ),
                revision,
                proposedBy: { kind: "operator", personId: REVIEWER },
                proposedAt: at,
                kind: "candidate",
              },
            ],
          }
        : entry,
    );
    return {
      ok: true,
      receipt: {
        commandId: command.commandId,
        evalId: target.evalId,
        revision,
        headRevision: revision,
        state: "candidate",
      },
    };
  }
  const revisions = target.revisions.map((current): EvalRevisionView => {
    if (current.revision !== command.revision) return current;
    const base = {
      ...evalRevision(current.title, current.scenarios),
      revision: current.revision,
      proposedBy: current.proposedBy,
      proposedAt: current.proposedAt,
    };
    if (command.kind === "accept")
      return { ...base, kind: "accepted", acceptance: decision(at) };
    if (command.kind === "reject")
      return {
        ...base,
        kind: "rejected",
        rejection: { ...decision(at), reason: "declined" },
      };
    return {
      ...base,
      kind: "revoked",
      acceptance: decision(at - 1),
      revocation: decision(at),
    };
  });
  evals = evals.map((entry) =>
    entry.evalId === target.evalId ? { ...target, revisions } : entry,
  );
  return {
    ok: true,
    receipt: {
      commandId: command.commandId,
      evalId: target.evalId,
      revision: command.revision,
      headRevision: target.headRevision,
      state: revisions.find((entry) => entry.revision === command.revision)
        ?.kind,
    },
  };
}

function applyRun(command: EvalRunCommand): unknown {
  if (command.kind === "cancel") {
    const run = evalRuns.find((entry) => entry.runId === command.runId);
    if (run === undefined) return refuse("eval_unavailable");
    const { tasks, state: _state, settledAt: _settledAt, ...header } = run;
    evalRuns = evalRuns.map((entry) =>
      entry.runId === run.runId
        ? {
            ...header,
            state: "cancelled",
            settledAt: Date.now(),
            tasks: tasks.map((task) => ({
              taskId: task.taskId,
              scenarioId: task.scenarioId,
              configuration: task.configuration,
              route: task.route,
              outcome: { kind: "cancelled" },
              execution: null,
              pins: null,
              totalTokens: null,
            })),
          }
        : entry,
    );
    return {
      ok: true,
      receipt: {
        commandId: command.commandId,
        runId: run.runId,
        caseId: run.caseId,
      },
    };
  }
  if (evalRuns.filter((run) => run.state === "running").length >= 4)
    return refuse("eval_capacity_exceeded");
  const run = previewRun(
    `evalrun_preview_${evalRuns.length + 1}`,
    Date.now(),
    command.routes,
    command.configurations,
  );
  evalRuns = [run, ...evalRuns];
  return {
    ok: true,
    receipt: {
      commandId: command.commandId,
      runId: run.runId,
      caseId: run.caseId,
    },
  };
}

// With `?organisation=<id>` the page uses the control routes of the Worker
// The playbooks and agents of the sample Organisation. The Brain page lists
// them and changes neither.
const OPERATIONS: AgentOperationsSnapshot = {
  ...EMPTY_AGENT_OPERATIONS_SNAPSHOT,
  definitions: [
    {
      agentDefinitionId: "agent_preview_mailbox",
      displayName: "Supplier mailbox agent",
      role: "merchant_operator",
      purpose: "Answers supplier mail and prepares replies for review.",
      lifecycle: "active",
      currentRevision: {
        revision: 2,
        instructions:
          "Answer supplier mail. Ask a person before a late change.",
        requestedCapabilities: ["context.case.read"],
        skillRefs: [{ skillId: "skill_preview_supplier_replies", revision: 1 }],
        contentDigest: "a".repeat(64),
      },
    },
    {
      agentDefinitionId: "agent_preview_stock",
      displayName: "Stock checker",
      role: "merchant_operator",
      purpose: "Checks stock levels each morning.",
      lifecycle: "archived",
      currentRevision: {
        revision: 1,
        instructions: "Check stock levels.",
        requestedCapabilities: [],
        skillRefs: [],
        contentDigest: "b".repeat(64),
      },
    },
  ],
  skills: [
    {
      skillId: "skill_preview_supplier_replies",
      title: "Supplier replies",
      sensitivity: "ordinary",
      lifecycle: "published",
      currentRevision: {
        revision: 1,
        markdownBody: "# Supplier replies",
        contentDigest: "c".repeat(64),
      },
    },
    {
      skillId: "skill_preview_refunds",
      title: "Refund requests",
      sensitivity: "sensitive",
      lifecycle: "published",
      currentRevision: {
        revision: 3,
        markdownBody: "# Refund requests",
        contentDigest: "d".repeat(64),
      },
    },
  ],
};

// behind this server, under the browser's own session. A browser journey
// drives it that way. Without it the page runs on the sample store above.
const liveOrganisationId = params.get("organisation");
const transport: BrainTransport =
  liveOrganisationId !== null
    ? { read: controlRead, mutate: controlMutation }
    : {
        read: async (path) => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          if (scenario === "failed")
            throw new Error("Pantry could not load this page. Try again.");
          const timelineOf =
            /\/case-executions\/timeline\?from=(\d+)&to=(\d+)$/u.exec(path);
          if (timelineOf !== null) {
            const from = Number(timelineOf[1]);
            const to = Number(timelineOf[2]);
            return {
              ok: true,
              timeline:
                scenario === "empty"
                  ? { from, to, cases: [], truncated: false }
                  : sampleCaseTimeline(from, to, Date.now()),
            };
          }
          if (path.endsWith("/case-executions"))
            return {
              ok: true,
              cases: scenario === "empty" ? [] : SAMPLE_EXECUTION_CASES,
            };
          const nodeOf = /\/cases\/([^/]+)\/execution\/nodes\/([^/?]+)$/u.exec(
            path,
          );
          if (nodeOf !== null) {
            const detail = sampleExecutionDetail(
              decodeURIComponent(nodeOf[1] ?? ""),
              decodeURIComponent(nodeOf[2] ?? ""),
            );
            return detail === null
              ? refuse("case_execution_not_found")
              : { ok: true, detail };
          }
          const executionOf =
            /\/cases\/([^/]+)\/execution(?:\?after=([^&]+))?$/u.exec(path);
          if (executionOf !== null) {
            const page = sampleExecutionPage(
              decodeURIComponent(executionOf[1] ?? ""),
              executionOf[2] === undefined
                ? null
                : decodeURIComponent(executionOf[2]),
            );
            return page === null
              ? refuse("case_execution_not_found")
              : { ok: true, page };
          }
          if (path.endsWith("/operations"))
            return {
              ok: true,
              operations:
                scenario === "empty"
                  ? EMPTY_AGENT_OPERATIONS_SNAPSHOT
                  : OPERATIONS,
            };
          if (path.endsWith("/brain/summary"))
            return {
              ok: true,
              summary: {
                memoriesToReview: memories.filter(
                  (memory) => memory.revisions.at(-1)?.kind === "candidate",
                ).length,
                evalsToReview: evals.filter(
                  (entry) => entry.revisions.at(-1)?.kind === "candidate",
                ).length,
              },
            };
          if (/\/evals\/[^/]+\/contacts$/u.test(path))
            return {
              ok: true,
              contacts: [
                { ...SUPPLIER, address: "orders@flour.example" },
                {
                  verificationId: "verification_preview_dairy",
                  revision: 1,
                  address: "dispatch@dairy.example",
                },
              ],
            };
          const runsOf = /\/evals\/([^/]+)\/runs$/u.exec(path);
          if (runsOf !== null)
            return {
              ok: true,
              runs: readRuns(decodeURIComponent(runsOf[1] ?? "")),
            };
          return path.endsWith("/evals")
            ? { ok: true, evals }
            : { ok: true, memories };
        },
        mutate: async (path, _method, body) =>
          path.endsWith("/evals/commands")
            ? applyEval(body as EvalCommand)
            : path.endsWith("/evals/runs")
              ? applyRun(body as EvalRunCommand)
              : apply(body as MemoryCommand),
      };

/**
 * The Brain page inside the Portal's own frame, so that the preview shows the
 * count on the Brain entry of the navigation as the Portal shows it.
 */
const CHAT_PATH = "/portal/preview/cafe/chat";
const PREVIEW_PAGE = `${window.location.pathname}${window.location.search}`;

// The sample page opens the sample chat of the chat preview, which answers
// from the page itself. A live organisation keeps its real requests, and its
// fixture has no chat to open.
if (liveOrganisationId === null) installChatPreviewFetch();

/** Where the chat returns to: the page that opened it, as the Portal does. */
function chatReturnPath(state: unknown): string {
  return typeof state === "object" &&
    state !== null &&
    "chatReturnPath" in state &&
    typeof state.chatReturnPath === "string"
    ? state.chatReturnPath
    : PREVIEW_PAGE;
}

function PreviewApp(): React.ReactNode {
  const organisationId = liveOrganisationId ?? "organisation_preview";
  const summary = useBrainSummary(organisationId);
  const toReview = summary === null ? 0 : brainItemsToReview(summary);
  const location = useLocation();
  const section =
    new URLSearchParams(location.search).get("view") === "activity"
      ? "agents"
      : "knowledge";
  const navigate = useNavigate();
  const chatOpen =
    liveOrganisationId === null && location.pathname === CHAT_PATH;
  const closeChat = (): void =>
    void navigate(chatReturnPath(location.state), { replace: true });
  return (
    <PortalFrame
      identity={{
        kind: "ready",
        displayName: "Preview",
        logout: async () => {},
      }}
      organisation={{
        organisationHandle: "preview",
        name: "Preview organisation",
        choices: [],
      }}
      workspace={{
        organisationHandle: "preview",
        workspaceHandle: "cafe",
        name: "Cafe operations",
        choices: [],
      }}
      chat={
        chatOpen
          ? {
              close: closeChat,
              content: (
                <ChatPage
                  context={{
                    organisation: "Preview organisation",
                    workspace: "Cafe operations",
                    area: "Agents",
                    view: "Brain",
                  }}
                  close={closeChat}
                  organisationId="organisation_chat_preview"
                  basePath={CHAT_PATH}
                  integrationsPath="/integrations-preview.html"
                  accessPath="/access-preview.html"
                  access={UNAVAILABLE_ACCESS}
                  signedInAs={null}
                  canManage={scenario !== "viewer"}
                />
              ),
            }
          : null
      }
      sidebar={{
        activePage: "knowledge",
        chatOpen,
        footer: null,
        attention:
          toReview === 0
            ? {}
            : {
                knowledge: { count: toReview, label: `${toReview} to review` },
              },
      }}
    >
      <PageHeader
        title="Brain"
        description="Review what the agents have learned and decide what they may use."
      />
      <BrainRoute
        // Activity is the second tab of the Agents page, not of Knowledge. The
        // Portal shows each section as its own page, so a change of section
        // mounts the route again with the address of the new page.
        key={section}
        section={section}
        skills={<p>The Skills view opens here.</p>}
        organisationId={organisationId}
        canManage={scenario !== "viewer"}
        transport={transport}
        agentsHref="/portal/preview/cafe/agents"
        chatHref={CHAT_PATH}
        contextLinks={{
          relatedCasesHref: "/portal/preview/cafe/access/data-flow",
          onScreenHref: "/portal/preview/cafe/access/data-flow#on-screen",
          discoveryHref:
            "/portal/preview/cafe/integrations?integration=typesafe",
        }}
      />
    </PortalFrame>
  );
}

createRoot(root).render(
  <BrowserRouter>
    <PreviewApp />
  </BrowserRouter>,
);

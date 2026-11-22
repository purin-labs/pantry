import {
  parseCaseExecutionCaseList,
  parseCaseTimelineDay,
  parseScheduleRunsDay,
  parseEvalCommandReceipt,
  parseEvalListResponse,
  parseEvalRunCommandReceipt,
  parseEvalRunListResponse,
  parseEvalSenderChoicesResponse,
  parseMemoryCommandReceipt,
  parseMemoryListResponse,
  type CaseExecutionCaseRef,
  type CaseTimelineDay,
  type ScheduleRunsDay,
  type EvalCommand,
  type EvalCommandReceipt,
  type EvalRunCommand,
  type EvalRunCommandReceipt,
  type EvalRunView,
  type EvalSenderChoice,
  type EvalView,
  type MemoryCommand,
  type MemoryCommandReceipt,
  type MemoryView,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import { parseEntityRef } from "@purin-labs/commerce-client";

import {
  parseAgentOperationsResponse,
  type AgentDefinition,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
import { type Skill } from "@purin-labs/control-api";
import {
  ControlApiError,
  lastControlRead,
} from "@purin-labs/control/portal/control-client";
import {
  evalsPath,
  memoriesPath,
} from "@purin-labs/control/portal/control-paths";

/** How the Brain page reaches the control API. A preview supplies its own. */
export type BrainTransport = Readonly<{
  read: (path: string) => Promise<unknown>;
  mutate: (path: string, method: "POST", body: unknown) => Promise<unknown>;
}>;

function entityRefOrNull(raw: unknown) {
  try {
    return parseEntityRef(raw);
  } catch {
    return null;
  }
}

/** The Memory this person may inspect. A hidden Memory is not listed. */
export async function readMemories(
  transport: BrainTransport,
  organisationId: string,
): Promise<readonly MemoryView[]> {
  return parseMemoryListResponse(
    await transport.read(memoriesPath(organisationId)),
    entityRefOrNull,
  );
}

/**
 * The Memories and Evals that an earlier visit read in this tab, or null. The
 * page shows them only while it reads both again.
 */
export function lastBrainRead(organisationId: string): Readonly<{
  memories: readonly MemoryView[];
  evals: readonly EvalView[] | null;
}> | null {
  const memories = lastControlRead(memoriesPath(organisationId));
  if (memories === undefined) return null;
  const evals = lastControlRead(evalsPath(organisationId));
  try {
    return {
      memories: parseMemoryListResponse(memories, entityRefOrNull),
      evals: evals === undefined ? null : parseEvalListResponse(evals),
    };
  } catch {
    return null;
  }
}

export async function sendMemoryCommand(
  transport: BrainTransport,
  organisationId: string,
  command: MemoryCommand,
): Promise<MemoryCommandReceipt> {
  const raw = await transport.mutate(
    `${memoriesPath(organisationId)}/commands`,
    "POST",
    command,
  );
  const receipt = isRecord(raw) ? parseMemoryCommandReceipt(raw.receipt) : null;
  if (receipt === null)
    throw new Error("The server returned a receipt this page cannot read.");
  return receipt;
}

/** What to tell the person when a Memory request fails. */
export function memoryErrorMessage(error: unknown): string {
  const code =
    error instanceof ControlApiError && isRecord(error.details)
      ? error.details.error
      : null;
  switch (code) {
    case "memory_conflict":
    case "memory_command_conflict":
      return "This memory changed after you opened it. The page now shows the current version.";
    case "memory_unavailable":
      return "This memory is no longer available to you.";
    case "memory_invalid":
    case "memory_evidence_unsupported":
      return "Pantry could not save this. Check the statement, the timezone and the dates.";
    case "memory_capacity_exceeded":
      return "This workspace holds the maximum number of memories or versions.";
    default:
      return error instanceof Error
        ? error.message
        : "Pantry could not complete this request. Try again.";
  }
}

/** The Evals this person may inspect. A hidden Eval is not listed. */
export async function readEvals(
  transport: BrainTransport,
  organisationId: string,
): Promise<readonly EvalView[]> {
  return parseEvalListResponse(await transport.read(evalsPath(organisationId)));
}

export async function sendEvalCommand(
  transport: BrainTransport,
  organisationId: string,
  command: EvalCommand,
): Promise<EvalCommandReceipt> {
  const raw = await transport.mutate(
    `${evalsPath(organisationId)}/commands`,
    "POST",
    command,
  );
  const receipt = isRecord(raw) ? parseEvalCommandReceipt(raw.receipt) : null;
  if (receipt === null)
    throw new Error("The server returned a receipt this page cannot read.");
  return receipt;
}

/** The runs of one Eval this person may read, those in progress first. */
export async function readEvalRuns(
  transport: BrainTransport,
  organisationId: string,
  evalId: string,
): Promise<readonly EvalRunView[]> {
  return parseEvalRunListResponse(
    await transport.read(
      `${evalsPath(organisationId)}/${encodeURIComponent(evalId)}/runs`,
    ),
  );
}

/** The verified contacts that a scenario of one Eval can name as its sender. */
export async function readEvalSenderChoices(
  transport: BrainTransport,
  organisationId: string,
  evalId: string,
): Promise<readonly EvalSenderChoice[]> {
  return parseEvalSenderChoicesResponse(
    await transport.read(
      `${evalsPath(organisationId)}/${encodeURIComponent(evalId)}/contacts`,
    ),
  );
}

export async function sendEvalRunCommand(
  transport: BrainTransport,
  organisationId: string,
  command: EvalRunCommand,
): Promise<EvalRunCommandReceipt> {
  const raw = await transport.mutate(
    `${evalsPath(organisationId)}/runs`,
    "POST",
    command,
  );
  const receipt = isRecord(raw)
    ? parseEvalRunCommandReceipt(raw.receipt)
    : null;
  if (receipt === null)
    throw new Error("The server returned a receipt this page cannot read.");
  return receipt;
}

/** What to tell the person when an Eval request fails. */
export function evalErrorMessage(error: unknown): string {
  const code =
    error instanceof ControlApiError && isRecord(error.details)
      ? error.details.error
      : null;
  switch (code) {
    case "eval_conflict":
    case "eval_command_conflict":
      return "This eval or its memory changed after you opened it. The page now shows the current version.";
    case "eval_unavailable":
      return "This eval is not available to you.";
    case "eval_invalid":
    case "eval_evidence_unsupported":
      return "Pantry could not accept this request. Check what you selected.";
    case "eval_capacity_exceeded":
      return "Too many runs are in progress for this mailbox. Wait for one to finish.";
    default:
      return error instanceof Error
        ? error.message
        : "Pantry could not complete this request. Try again.";
  }
}

function organisationPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}`;
}

/** The playbooks and agents that the Knowledge view lists. It changes neither. */
type AgentKnowledge = Readonly<{
  playbooks: readonly Skill[];
  agents: readonly AgentDefinition[];
}>;

export const NO_AGENT_KNOWLEDGE: AgentKnowledge = { playbooks: [], agents: [] };

/**
 * The playbooks and agents of the Organisation, from the read of the Agents
 * page. A person whom that read refuses gets no rows.
 */
export async function readAgentKnowledge(
  transport: BrainTransport,
  organisationId: string,
): Promise<AgentKnowledge> {
  try {
    const operations = parseAgentOperationsResponse(
      await transport.read(`${organisationPath(organisationId)}/operations`),
    );
    return { playbooks: operations.skills, agents: operations.definitions };
  } catch {
    return NO_AGENT_KNOWLEDGE;
  }
}

/** The Cases this person may know of, newest first. */
export async function readExecutionCases(
  transport: BrainTransport,
  organisationId: string,
): Promise<readonly CaseExecutionCaseRef[]> {
  const raw = await transport.read(
    `${organisationPath(organisationId)}/case-executions`,
  );
  const cases = isRecord(raw)
    ? parseCaseExecutionCaseList({ cases: raw.cases })
    : null;
  if (cases === null)
    throw new Error("The server returned a list this page cannot read.");
  return cases;
}

/** The Cases filed in a window, each as one event of the Activity timeline. */
export async function readCaseTimeline(
  transport: BrainTransport,
  organisationId: string,
  window: Readonly<{ from: number; to: number }>,
): Promise<CaseTimelineDay> {
  const raw = await transport.read(
    `${organisationPath(organisationId)}/case-executions/timeline?from=${String(window.from)}&to=${String(window.to)}`,
  );
  const timeline = isRecord(raw) ? parseCaseTimelineDay(raw.timeline) : null;
  if (timeline === null)
    throw new Error("The server returned a day this page cannot read.");
  return timeline;
}

/** The runs of the agents' schedules in a window, each with its Case. */
export async function readScheduleRuns(
  transport: BrainTransport,
  organisationId: string,
  window: Readonly<{ from: number; to: number }>,
): Promise<ScheduleRunsDay> {
  const raw = await transport.read(
    `${organisationPath(organisationId)}/case-executions/schedule-runs?from=${String(window.from)}&to=${String(window.to)}`,
  );
  const runs = isRecord(raw) ? parseScheduleRunsDay(raw.schedule) : null;
  if (runs === null)
    throw new Error("The server returned schedule runs this page cannot read.");
  return runs;
}

export {
  readCaseExecution,
  readExecutionNode,
  executionErrorMessage,
} from "../../execution-client";

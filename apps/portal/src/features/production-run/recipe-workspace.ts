import {
  parseWorkflowDocument,
  type BakeryWorkflowDocument,
} from "@seams/bakery-workflow";
import type { ProposalChangeSummary } from "@seams/bakery-workflow/changes";
import {
  parseRunFindings,
  type RunFinding,
} from "@seams/bakery-workflow/findings";
import { canonicalJson, isRecord, sha256Hex } from "@seams/std";
import type { CompiledScenario } from "@seams/production-simulation";
import React from "react";
import { controlRead, ControlApiError } from "../../control-client";
import type { CommerceMutationTransport } from "../commerce/entity-plane/api";
import type { RecipeGraphSource } from "./recipe-graph";

/**
 * The workspace that a recipe view works in. Without one, as in the local fixture,
 * a draft stays on the page and nobody can apply it.
 */
export type RecipeWorkspace = Readonly<{
  organisationId: string;
  canManage: boolean;
  mutate: CommerceMutationTransport;
  /** The chat page, where Ask the agent starts. A preview has none. */
  chatPath?: string | undefined;
}>;

export const RecipeWorkspaceContext =
  React.createContext<RecipeWorkspace | null>(null);

export type WorkflowProposal = Readonly<{
  draftId: string;
  reason: string;
  baseDigest: string;
  proposedDigest: string;
  findings: readonly RunFinding[];
  change: ProposalChangeSummary;
}>;

type AppliedWorkflow = Readonly<{
  document: BakeryWorkflowDocument;
  digest: string;
  revision: number;
  /** Proposals that wait for this person. */
  proposals: readonly WorkflowProposal[];
  /** The revision before an approved proposal. A person's own apply has none. */
  replaced: BakeryWorkflowDocument | null;
}>;

function proposalOf(raw: unknown): WorkflowProposal | null {
  if (!isRecord(raw) || typeof raw.draftId !== "string") return null;
  const command = raw.command;
  if (!isRecord(command)) return null;
  const findings = parseRunFindings(command.findings);
  return findings === null ||
    typeof command.reason !== "string" ||
    typeof command.baseDigest !== "string" ||
    typeof command.proposedDigest !== "string" ||
    !isRecord(command.change)
    ? null
    : {
        draftId: raw.draftId,
        reason: command.reason,
        baseDigest: command.baseDigest,
        proposedDigest: command.proposedDigest,
        findings,
        change: command.change as unknown as ProposalChangeSummary,
      };
}

/** One draft for each recipe and each set of its inputs. */
export async function recipeWorkflowId(
  source: RecipeGraphSource,
): Promise<string> {
  // A prepared cell carries a fresh run ID, so a compiled recipe uses its steps.
  const identity =
    source.kind === "compiled"
      ? source.scenario.workflows.map(workflowSteps)
      : source;
  const digest = await sha256Hex(canonicalJson(identity));
  const name = source.kind === "compiled" ? source.scenario.id : source.kind;
  return `${name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .slice(0, 100)}-${digest.slice(0, 16)}`;
}

function workflowSteps(
  workflow: CompiledScenario["workflows"][number],
): readonly string[] {
  return [workflow.id, ...workflow.tasks.map(taskKeyOf)];
}

function taskKeyOf(
  task: CompiledScenario["workflows"][number]["tasks"][number],
): string {
  return task.key;
}

function workflowPath(workspace: RecipeWorkspace, workflowId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(workspace.organisationId)}/bakery/workflows/${encodeURIComponent(workflowId)}`;
}

export async function readAppliedWorkflow(
  workspace: RecipeWorkspace,
  workflowId: string,
): Promise<AppliedWorkflow | null> {
  const reply = await controlRead(workflowPath(workspace, workflowId));
  if (!isRecord(reply) || !isRecord(reply.current)) return null;
  const parsed = parseWorkflowDocument(reply.current.document);
  const receipt = reply.current.receipt;
  if (
    !parsed.ok ||
    !isRecord(receipt) ||
    typeof receipt.digest !== "string" ||
    typeof receipt.revision !== "number"
  )
    throw new Error("The applied workflow is invalid.");
  const proposals: WorkflowProposal[] = [];
  if (Array.isArray(reply.proposals))
    for (const item of reply.proposals) {
      const proposal = proposalOf(item);
      if (proposal !== null) proposals.push(proposal);
    }
  const replaced = parseWorkflowDocument(reply.replaced);
  return {
    document: parsed.value,
    digest: receipt.digest,
    revision: receipt.revision,
    proposals,
    replaced: replaced.ok ? replaced.value : null,
  };
}

export async function readProposedDocument(
  workspace: RecipeWorkspace,
  workflowId: string,
  draftId: string,
): Promise<BakeryWorkflowDocument> {
  const reply = await controlRead(
    `${workflowPath(workspace, workflowId)}/proposals/${encodeURIComponent(draftId)}`,
  );
  const parsed = isRecord(reply) ? parseWorkflowDocument(reply.document) : null;
  if (parsed === null || !parsed.ok)
    throw new Error("The proposal cannot be read.");
  return parsed.value;
}

export type ProposalDecision =
  | Readonly<{ kind: "approved"; revision: number }>
  | Readonly<{ kind: "declined" }>
  | Readonly<{ kind: "stale" | "human_intervention" | "closed" }>;

export async function decideProposal(
  workspace: RecipeWorkspace,
  workflowId: string,
  draftId: string,
  action: "approve" | "decline",
): Promise<ProposalDecision> {
  try {
    const reply = await workspace.mutate(
      `${workflowPath(workspace, workflowId)}/proposals/${encodeURIComponent(draftId)}/${action}`,
      {},
      action === "approve"
        ? "Approve workflow proposal"
        : "Decline workflow proposal",
    );
    if (action === "decline") return { kind: "declined" };
    if (
      !isRecord(reply) ||
      !isRecord(reply.receipt) ||
      typeof reply.receipt.revision !== "number"
    )
      throw new Error("The approval returned no receipt.");
    return { kind: "approved", revision: reply.receipt.revision };
  } catch (error) {
    if (error instanceof ControlApiError)
      switch (error.kind) {
        case "bakery_workflow_stale":
          return { kind: "stale" };
        case "bakery_workflow_human_intervention":
          return { kind: "human_intervention" };
        case "bakery_workflow_proposal_closed":
          return { kind: "closed" };
        default:
          break;
      }
    throw error;
  }
}

/**
 * Opens the chat with these words in its box, and the person sends them. The chat
 * page takes one draft from this key, as the connector author does.
 */
export function askAgentInChat(chatPath: string, words: string): void {
  sessionStorage.setItem(`connector-chat-draft:${chatPath}`, words);
  window.location.assign(chatPath);
}

/** The agent reads what went wrong in the last run. A lost send changes no recipe. */
export async function recordRunFindings(
  workspace: RecipeWorkspace,
  workflowId: string,
  digest: string,
  findings: readonly RunFinding[],
): Promise<void> {
  await workspace.mutate(
    `${workflowPath(workspace, workflowId)}/findings`,
    { digest, findings },
    "Record run findings",
  );
}

type ApplyResult =
  | Readonly<{ kind: "applied"; digest: string; revision: number }>
  | Readonly<{ kind: "stale" }>;

export async function applyWorkflow(
  workspace: RecipeWorkspace,
  workflowId: string,
  document: BakeryWorkflowDocument,
  baseDigest: string | null,
): Promise<ApplyResult> {
  try {
    const reply = await workspace.mutate(
      `${workflowPath(workspace, workflowId)}/apply`,
      { document, baseDigest },
      "Apply workflow revision",
    );
    if (
      !isRecord(reply) ||
      !isRecord(reply.receipt) ||
      typeof reply.receipt.digest !== "string" ||
      typeof reply.receipt.revision !== "number"
    )
      throw new Error("The apply returned no receipt.");
    return {
      kind: "applied",
      digest: reply.receipt.digest,
      revision: reply.receipt.revision,
    };
  } catch (error) {
    if (
      error instanceof ControlApiError &&
      error.kind === "bakery_workflow_stale"
    )
      return { kind: "stale" };
    throw error;
  }
}

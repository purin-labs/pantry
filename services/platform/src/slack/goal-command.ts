import type { CaseGoalCommand, CaseGoalSnapshot } from "@purin-labs/contracts";
import { assertNever } from "@purin-labs/std";
import { parseCaseGoalCommand } from "@purin-labs/agent/actors/case-goals";

export type SlackGoalCommand =
  | { readonly kind: "ordinary" }
  | { readonly kind: "help" }
  | { readonly kind: "status" }
  | { readonly kind: "change"; readonly command: CaseGoalCommand };

export const GOAL_COMMAND_HELP =
  "Goal commands: goal status; goal set <token budget> <objective>; goal budget <token budget>; goal pause; goal resume; goal complete <evidence>; goal clear. Resume allows future work. Send another message to continue.";

export function isSlackGoalMessage(text: string): boolean {
  return /^(?:<@[A-Z0-9]+>\s*)?goal(?:\s|$)/iu.test(text.trim());
}

export function parseSlackGoalCommand(text: string): SlackGoalCommand {
  const authored = text.trim().replace(/^<@[A-Z0-9]+>\s*/u, "");
  if (!isSlackGoalMessage(text)) return { kind: "ordinary" };
  const match = /^goal(?:\s+(\w+))?(?:\s+([\s\S]+))?$/iu.exec(authored);
  const verb = match?.[1]?.toLowerCase() ?? "status";
  const argument = match?.[2]?.trim() ?? "";
  if (verb === "status" && argument === "") return { kind: "status" };
  let raw: unknown;
  switch (verb) {
    case "set": {
      const parts = /^(\d+)\s+([\s\S]+)$/u.exec(argument);
      raw = {
        kind: "set",
        tokenBudget: Number(parts?.[1]),
        objective: parts?.[2],
      };
      break;
    }
    case "budget":
      raw = {
        kind: "update_budget",
        tokenBudget: /^\d+$/u.test(argument) ? Number(argument) : NaN,
      };
      break;
    case "complete":
      raw = { kind: "complete", evidence: argument };
      break;
    case "pause":
    case "resume":
    case "clear":
      raw = argument === "" ? { kind: verb } : null;
      break;
    default:
      return { kind: "help" };
  }
  const command = parseCaseGoalCommand(raw);
  return command === null ? { kind: "help" } : { kind: "change", command };
}

export function goalSnapshotMessage(snapshot: CaseGoalSnapshot): string {
  if (snapshot.kind === "none")
    return "No goal is set for this thread. Use goal set <token budget> <objective>.";
  const goal = snapshot.goal;
  let status: string;
  switch (goal.state.kind) {
    case "active":
      status = "active";
      break;
    case "paused":
      status = "paused";
      break;
    case "budget_limited":
      status = "budget limited";
      break;
    case "completed":
      status = "completed";
      break;
    case "cleared":
      status = "cleared";
      break;
    default:
      return assertNever(goal.state);
  }
  return (
    `Goal: ${goal.objective}\nStatus: ${status}. Tokens: ${goal.tokensUsed} / ${goal.tokenBudget}. Recorded model time: ${Math.round(goal.activeTimeMs / 1000)} seconds (summed across calls).` +
    (goal.unknownOperations > 0
      ? ` Usage is unknown for ${goal.unknownOperations} operations. Resume is blocked until usage is resolved.`
      : "")
  );
}

export function goalCommandFailureMessage(code: string): string {
  switch (code) {
    case "goal_execution_running":
      return "Wait for the current turn to finish, then set the goal again.";
    case "goal_usage_pending":
      return "Usage is unresolved. Resume is blocked until usage is settled.";
    case "goal_budget_exhausted":
      return "The goal has no tokens left. Increase its budget, then explicitly resume it.";
    case "goal_missing":
      return "No goal is set. Use goal set <token budget> <objective>.";
    case "goal_terminal":
      return "This goal has ended. Set a new goal to start new work.";
    default:
      return "The goal command could not be applied. Use goal status to inspect its state before trying again.";
  }
}

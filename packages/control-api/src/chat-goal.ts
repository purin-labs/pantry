import { isRecord } from "@purin-labs/std";
import { parseCaseGoalSnapshot } from "@purin-labs/contracts";
import type { CaseGoalCommand, CaseGoalSnapshot } from "@purin-labs/contracts";

export type ChatGoalCommand = Readonly<{
  commandId: string;
  expectedRevision: number;
  command: CaseGoalCommand;
}>;

export type ChatGoalSupport =
  | Readonly<{
      kind: "supported";
      backend: "pi";
      code?: never;
    }>
  | Readonly<{ kind: "unavailable"; code: string; backend?: never }>;

export type ChatGoalView = Readonly<{
  goal: CaseGoalSnapshot;
  support: ChatGoalSupport;
  canEdit: boolean;
  execution: "idle" | "busy";
}>;

export function parseChatGoalView(raw: unknown): ChatGoalView | null {
  if (
    !isRecord(raw) ||
    typeof raw.canEdit !== "boolean" ||
    (raw.execution !== "idle" && raw.execution !== "busy")
  )
    return null;
  const goal = parseCaseGoalSnapshot(raw.goal);
  const support = parseGoalSupport(raw.support);
  return goal === null || support === null
    ? null
    : { goal, support, canEdit: raw.canEdit, execution: raw.execution };
}
function parseGoalSupport(raw: unknown): ChatGoalSupport | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "supported":
      return raw.backend === "pi" ? { kind: "supported", backend: "pi" } : null;
    case "unavailable":
      return typeof raw.code === "string"
        ? { kind: "unavailable", code: raw.code }
        : null;
    default:
      return null;
  }
}

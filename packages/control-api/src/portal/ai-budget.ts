import { isPositiveInteger, isRecord } from "@seams/std";

export type AiBudgetLimits = Readonly<{
  maxTokens: number;
  maxWallMs: number;
  maxToolCalls: number;
}>;
export type AiBudgetView = Readonly<{
  limits: AiBudgetLimits;
  maximum: AiBudgetLimits;
  revision: number;
  activation: "active" | "pending";
  canManage: boolean;
}>;

export function parseAiBudgetView(raw: unknown): AiBudgetView {
  if (!isRecord(raw) || !isRecord(raw.budget))
    throw new Error(
      "AI budget settings are unavailable. Reload and try again.",
    );
  const limits = parseLimits(raw.budget.limits);
  const maximum = parseLimits(raw.maximum);
  if (
    !limits ||
    !maximum ||
    !isPositiveInteger(raw.budget.revision) ||
    typeof raw.canManage !== "boolean" ||
    (raw.budget.activation !== "active" && raw.budget.activation !== "pending")
  )
    throw new Error(
      "AI budget settings are unavailable. Reload and try again.",
    );
  return {
    limits,
    maximum,
    revision: raw.budget.revision,
    activation: raw.budget.activation,
    canManage: raw.canManage,
  };
}

function parseLimits(raw: unknown): AiBudgetLimits | null {
  if (
    !isRecord(raw) ||
    !isPositiveInteger(raw.maxTokens) ||
    !isPositiveInteger(raw.maxWallMs) ||
    !isPositiveInteger(raw.maxToolCalls)
  )
    return null;
  return {
    maxTokens: raw.maxTokens,
    maxWallMs: raw.maxWallMs,
    maxToolCalls: raw.maxToolCalls,
  };
}

import type { CodexAllowance } from "@purin-labs/control-api";

const percentages = {
  usedPercent: 100,
  resetsAt: null,
  secondaryUsedPercent: null,
  secondaryResetsAt: null,
};

// @ts-expect-error An available observation requires its credit state.
const missingCredits: CodexAllowance = { kind: "available", ...percentages };

// @ts-expect-error An unavailable observation cannot carry credit data.
const unavailableCredits: CodexAllowance = {
  kind: "unavailable",
  credits: "available" as const,
};

// @ts-expect-error Spreading percentages cannot construct an unavailable branch.
const unavailablePercentages: CodexAllowance = {
  kind: "unavailable",
  ...percentages,
};

void missingCredits;
void unavailableCredits;
void unavailablePercentages;

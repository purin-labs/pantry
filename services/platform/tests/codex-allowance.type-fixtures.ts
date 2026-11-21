import type { CodexAllowance } from "@purin-labs/control-api";

const percentages = {
  usedPercent: 100,
  resetsAt: null,
  secondaryUsedPercent: null,
  secondaryResetsAt: null,
};

// @ts-expect-error An available observation requires its credit state.
const missingCredits: CodexAllowance = { kind: "available", ...percentages };

// @ts-expect-error An allowance that no response reported cannot carry credit data.
const notReportedCredits: CodexAllowance = {
  kind: "not_reported",
  credits: "available" as const,
};

// @ts-expect-error Spreading percentages cannot construct a not-reported branch.
const notReportedPercentages: CodexAllowance = {
  kind: "not_reported",
  ...percentages,
};

void missingCredits;
void notReportedCredits;
void notReportedPercentages;

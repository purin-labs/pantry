import type { EmbeddedHarnessTurnError } from "@purin-labs/agent/actors/embedded-harness";
import type { TransientEmailTurnError } from "@purin-labs/agent/actors/transient-email-turn";
import type { EmbeddedHarnessModelUsage } from "@purin-labs/contracts";

declare const modelUsage: EmbeddedHarnessModelUsage;

// @ts-expect-error An exhausted turn must carry reported usage.
export const missingBudgetUsage: EmbeddedHarnessTurnError = {
  code: "embedded_harness_token_budget_exhausted",
  allowanceTokens: 100,
};

const knownFailure = {
  code: "embedded_harness_turn_failed_with_usage",
  cause: { code: "embedded_harness_turn_failed", detail: "provider_failure" },
  modelUsage,
} as const;

// @ts-expect-error A spread cannot combine a runtime failure cause with budget exhaustion.
export const mixedFailure: EmbeddedHarnessTurnError = {
  ...knownFailure,
  code: "embedded_harness_token_budget_exhausted",
  allowanceTokens: 100,
};

// @ts-expect-error Usage cannot be discarded from an email budget failure.
export const unknownBudgetUsage: TransientEmailTurnError = {
  code: "transient_email_token_budget_exhausted",
  modelUsage: null,
};

// @ts-expect-error Construction failure cannot claim a completed model receipt.
export const constructedUsage: TransientEmailTurnError = {
  code: "transient_email_construction_failed",
  detail: "construction_failed",
  modelUsage,
};

// @ts-expect-error Invalid output comes from a completed turn with reported usage.
export const unreportedInvalidBody: TransientEmailTurnError = {
  code: "transient_email_body_invalid",
  modelUsage: null,
};

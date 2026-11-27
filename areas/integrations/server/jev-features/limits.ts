import type { JevAllowance } from "@purin-labs/control-api/portal/jev-features";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import {
  JEV_MONTHLY_ALLOWANCE_MICROUSD,
  type TypeSafeUsageLimits,
} from "@purin-labs/agent/typesafe/evaluation-ledger";
import {
  readMonthlyPantryTypeSafeCost,
  typeSafeMonth,
} from "@purin-labs/agent/typesafe/usage-store";

/**
 * Daily limits of Related Cases when the Jev switch turns it on. They stay
 * under the monthly allowance of Plan 88 section 3: at most $0.15 a day.
 */
export const JEV_RELATED_CASES_LIMITS: TypeSafeUsageLimits = Object.freeze({
  maxEvaluations: 200,
  maxConcurrentEvaluations: 2,
  maxInputBytes: 1_228_800,
  maxInputTokens: 3_276_800,
  maxWallMs: 1_000_000,
  maxCostMicrousd: 150_000,
  reservationMicrousd: 10_000,
  requestTimeoutMs: 10_000,
});

/** The smallest reservation of a Jev feature: the mail classification call. */
const SMALLEST_RESERVATION_MICROUSD = 3_000;

/** The free use of the month on Pantry's key, for the Jev page and the agent. */
export function jevAllowanceView(
  sql: SqlStorage,
  organisationId: OrganisationId,
  now: number,
): JevAllowance {
  const used = readMonthlyPantryTypeSafeCost(sql, organisationId, now);
  return {
    usedMicrousd: used,
    limitMicrousd: JEV_MONTHLY_ALLOWANCE_MICROUSD,
    resetsAt: typeSafeMonth(now).next,
    reached:
      used + SMALLEST_RESERVATION_MICROUSD > JEV_MONTHLY_ALLOWANCE_MICROUSD,
  };
}

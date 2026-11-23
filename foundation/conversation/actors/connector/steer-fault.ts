import type { Env } from "@purin-labs/kernel/env";

/**
 * The storage key of a fault journey (Refactor 15, refactor 9): while it is
 * set, the next steer that the Session accepts ends its Connector call at
 * once, as a process loss right after the Session's answer would.
 */
export const STEER_ANSWER_LOST_FAULT_KEY = "fault:steer_answer_lost";

/**
 * Whether the fault journey ends this steer call now. Only a Worker that has
 * a fault-injection token reads the key. `pnpm cloudflare:fault-injection-secret`
 * can give production that token, but no product code writes the key: only
 * the fault journey writes it into the Connector's storage. So production
 * stops here only after a test writes the key there. The key is used once.
 */
export async function steerAnswerLost(
  env: Pick<Env, "PANTRY_FAULT_INJECTION_TOKEN">,
  storage: Pick<DurableObjectStorage, "get" | "delete">,
): Promise<boolean> {
  if (
    typeof env.PANTRY_FAULT_INJECTION_TOKEN !== "string" ||
    env.PANTRY_FAULT_INJECTION_TOKEN.length === 0
  )
    return false;
  if ((await storage.get(STEER_ANSWER_LOST_FAULT_KEY)) === undefined)
    return false;
  await storage.delete(STEER_ANSWER_LOST_FAULT_KEY);
  return true;
}

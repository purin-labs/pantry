import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
} from "../organisation-execution-scope";
import type { Queue } from "@cloudflare/workers-types";

import {
  claimScheduleDispatchWindow,
  listEnabledScheduleBindings,
} from "../data/agent-operations/schedule-dispatch";
import { newRequestId } from "../ids";
import {
  createAgentScheduleDispatchQueueMessage,
  type AgentScheduleDispatchQueueMessage,
} from "./queue-messages";
import { traceWarn } from "../observability";
import { computeScheduleWindowKey } from "./window";

type ScheduleDispatchOutcome = {
  readonly dispatched: number;
  readonly skipped: number;
  readonly failed: number;
};

/**
 * One cron pass over every enabled schedule binding (plan 30 R2). For each
 * binding whose current window has not been dispatched, atomically claim the
 * window in D1 first — the claim is the double-dispatch fence — then admit
 * one metadata-only queue message. Automation resolution, assignment pinning,
 * budget capping, and receipts all happen in the queue consumer through the
 * existing direct-case path. A send failure after a claim loses that one
 * window; the next window dispatches normally and no window is ever
 * backfilled.
 */
export async function runScheduleDispatch(
  input: Readonly<{
    env: OrganisationPlacementBindings;
    queue: Queue<AgentScheduleDispatchQueueMessage>;
    now: number;
  }>,
): Promise<ScheduleDispatchOutcome> {
  let dispatched = 0;
  let skipped = 0;
  let failed = 0;
  for (const database of configuredOrganisationDatabases(input.env)) {
    const bindings = await listEnabledScheduleBindings(database);
    for (const binding of bindings) {
      try {
        const execution = await OrganisationExecutionScope.resolve(
          input.env,
          binding.organisationId,
        );
        if (!execution.ok) throw new Error(execution.error.code);
        if (execution.value.database !== database) continue;
        const windowKey = computeScheduleWindowKey(binding.spec, input.now);
        if (binding.lastDispatchedWindow === windowKey) {
          skipped += 1;
          continue;
        }
        const claimed = await claimScheduleDispatchWindow(
          execution.value,
          binding.bindingId,
          windowKey,
        );
        if (!claimed) {
          skipped += 1;
          continue;
        }
        await input.queue.send(
          createAgentScheduleDispatchQueueMessage({
            requestId: newRequestId(),
            receivedAt: input.now,
            organisationId: binding.organisationId,
            bindingId: binding.bindingId,
            windowKey,
          }),
        );
        dispatched += 1;
      } catch (error) {
        failed += 1;
        traceWarn("schedule_dispatch.binding_failed", {
          requestId: newRequestId(),
          organisationId: binding.organisationId,
          bindingId: binding.bindingId,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }
  }
  return { dispatched, skipped, failed };
}

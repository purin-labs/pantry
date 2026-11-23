import { newRequestId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";

/**
 * One alarm for each actor (Refactor 10, step 2). Each reconciler names the
 * next time it has work, read from its own durable rows, so the stored rows
 * are the one source of truth. `rearm` sets the alarm to the earliest of those
 * times, or deletes it when no reconciler has work. Code that stores new work
 * calls `rearm`.
 *
 * Three other paths set the alarm. The Session has no reconciler list: it
 * moves its alarm earlier with `armAlarmBy` when it stores work, and to now
 * when a read finds work that waits. `admitActorRecovery` moves the alarm of
 * a deferred Actor later and deletes the alarm of an inactive one. The import
 * of an Actor export restores the alarm that the export holds. The Actors
 * that extend `DurableObject` directly keep their own alarm.
 */
export interface AlarmReconciler {
  readonly name: string;
  /** The next time this reconciler has work, or null when it has none. */
  nextDue(now: number): number | null;
}

type AlarmStorage = Pick<DurableObjectStorage, "setAlarm" | "deleteAlarm">;

/** The earliest time that one of the reconcilers has work. */
export function nextAlarmAt(
  reconcilers: readonly AlarmReconciler[],
  now: number,
): number | null {
  let next: number | null = null;
  for (const reconciler of reconcilers) {
    const due = reconciler.nextDue(now);
    if (due !== null && (next === null || due < next)) next = due;
  }
  return next;
}

/**
 * Sets the alarm to the earliest due time, no earlier than now, or deletes
 * it when no reconciler has work. Returns the time that it set.
 */
export function rearmActorAlarm(
  storage: AlarmStorage,
  reconcilers: readonly AlarmReconciler[],
  now: number = Date.now(),
): Promise<number | null> {
  return setActorAlarm(storage, nextAlarmAt(reconcilers, now), now);
}

/** Sets the alarm to `next`, no earlier than now, or deletes it for null. */
export async function setActorAlarm(
  storage: AlarmStorage,
  next: number | null,
  now: number = Date.now(),
): Promise<number | null> {
  if (next === null) {
    await storage.deleteAlarm();
    return null;
  }
  const at = Math.max(now, next);
  await storage.setAlarm(at);
  return at;
}

/**
 * Moves the alarm to `at` when it is later or not set. Use it before work is
 * stored, so a wakeup exists even when the call ends before its `rearm`.
 */
export async function armAlarmBy(
  storage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm">,
  at: number,
): Promise<void> {
  const current = await storage.getAlarm();
  if (current === null || current > at) await storage.setAlarm(at);
}

/**
 * One step of an Actor's alarm (Refactor 15, S3). A step that throws does
 * not stop the steps after it.
 */
type AlarmStep = Readonly<{
  name: string;
  run: () => unknown;
}>;

/** The first wait before an alarm with a failed step runs again. */
const ALARM_RETRY_FIRST_MS = 15_000;
/** The longest wait before an alarm with a failed step runs again. */
const ALARM_RETRY_MAX_MS = 15 * 60_000;

/**
 * The wait before an alarm runs again after `failures` runs in a row with a
 * failed step: 15 s, then doubled, to at most 15 minutes.
 */
function alarmRetryDelay(failures: number): number {
  return Math.min(
    ALARM_RETRY_MAX_MS,
    ALARM_RETRY_FIRST_MS * 2 ** Math.max(0, Math.min(failures, 20) - 1),
  );
}

/**
 * Runs each step in order, each in its own try/catch. A failed step writes
 * a warning with its name and its error, and the next step still runs.
 * Returns the names of the steps that failed.
 */
export async function runAlarmSteps(
  actor: string,
  steps: readonly AlarmStep[],
): Promise<readonly string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failed.push(step.name);
      traceWarn("actor.alarm_step_failed", {
        requestId: newRequestId(),
        actor,
        step: step.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failed;
}

/**
 * Arms the alarm again after a run with a failed step, so the failed work
 * runs again after the backoff. A run with no failed step resets the count.
 * The count lives in the Actor's memory: an eviction starts it again at the
 * first wait, which only makes the next retry sooner.
 */
export async function armAlarmAfterFailedSteps(
  storage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm">,
  state: { failures: number },
  failed: readonly string[],
  now: number = Date.now(),
): Promise<void> {
  if (failed.length === 0) {
    state.failures = 0;
    return;
  }
  state.failures += 1;
  await armAlarmBy(storage, now + alarmRetryDelay(state.failures));
}

/**
 * Runs the steps at the same time, each on its own: a step that fails does
 * not stop the others. Returns the names of the steps that failed.
 */
export async function runAlarmStepsTogether(
  actor: string,
  steps: readonly AlarmStep[],
): Promise<readonly string[]> {
  const results = await Promise.all(
    steps.map((step) => runAlarmSteps(actor, [step])),
  );
  return results.flat();
}

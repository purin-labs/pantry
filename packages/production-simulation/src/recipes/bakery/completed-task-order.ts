import { compareCodePoints } from "@purin-labs/std";

type CompletedTaskTimes = Readonly<{
  taskId: string;
  startedAtUs: number;
  completedAtUs: number;
}>;

/**
 * Completed appliance tasks by start, then end, then task id. The id breaks a
 * tie in code-point order, so every host lists the tasks the same way.
 */
export function compareCompletedTasks(
  a: CompletedTaskTimes,
  b: CompletedTaskTimes,
): number {
  return (
    a.startedAtUs - b.startedAtUs ||
    a.completedAtUs - b.completedAtUs ||
    compareCodePoints(a.taskId, b.taskId)
  );
}

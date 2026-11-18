/**
 * What an engine job reports while it runs. This module has no browser
 * dependency, so state and status code can use it without the worker code
 * of `engine-jobs.ts`.
 */

/** What a job reports: the engine is starting, or a step of an operation. */
export type JobProgress =
  | Readonly<{ stage: "loading" }>
  | Readonly<{ stage: "running"; task: string; step: number; planned: number }>;

/** The step of a running operation for a status line: ": step 4,000 of about 14,750". */
export function jobStepLabel(
  steps: Readonly<{ step: number; planned: number }> | undefined,
): string {
  if (steps === undefined) return "";
  const step = steps.step.toLocaleString("en");
  return steps.planned > 0
    ? `: step ${step} of about ${steps.planned.toLocaleString("en")}`
    : `: step ${step}`;
}

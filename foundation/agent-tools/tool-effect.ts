/**
 * What `prepare` of an effect tool returns: the effect with its exit checks,
 * not yet run. `prepare` did the live checks and the reads. The executor
 * gives the effect to the host's settle function, which reads the label,
 * runs each exit check and then calls `run` (Refactor 17, step A1.4).
 *
 * The kinds with a check belong to the Session: `ToolEffect` in
 * `session-support.ts`. The executor knows only the kind with no check.
 */
export type PreparedEffect = Readonly<{ kind: string }>;

/** An effect that has no exit check today, for example a scheduled turn. */
export type UncheckedEffect<Result = unknown> = Readonly<{
  kind: "none";
  run: () => Promise<Result>;
}>;

export function uncheckedEffect<Result>(
  run: () => Promise<Result>,
): UncheckedEffect<Result> {
  return { kind: "none", run };
}

/** Runs the exit checks of a prepared effect, then the effect. */
export type EffectSettle = (effect: PreparedEffect) => Promise<unknown>;

/**
 * The settle function of a host with no Session, for example a check that
 * gives the services itself. It runs an effect with no check, and it refuses
 * an effect that has one.
 */
export const settleWithoutSession: EffectSettle = (effect) => {
  if (effect.kind !== "none") {
    throw new Error("A tool effect with an exit check needs a Session");
  }
  return (effect as UncheckedEffect).run();
};

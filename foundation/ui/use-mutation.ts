import React from "react";

/** Where the write for one key stands. */
type MutationState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "running"; idempotencyKey: string }>
  | Readonly<{ kind: "failed"; error: unknown }>;

/** The end of one attempt. `busy` means that a write for the key still ran. */
type MutationOutcome<Value> =
  | Readonly<{ kind: "done"; value: Value }>
  | Readonly<{ kind: "failed"; error: unknown }>
  | Readonly<{ kind: "busy" }>;

export type Mutation<Key extends string, Input, Value> = Readonly<{
  /**
   * Starts one attempt for the key, with a new idempotency key. While a write
   * for the key runs, a second call does nothing and answers `busy`.
   */
  run: (key: Key, input: Input) => Promise<MutationOutcome<Value>>;
  state: (key: Key) => MutationState;
  /** A write runs for one key or more: the hook's list of writes in flight. */
  busy: boolean;
  /** Forgets a failure, for example when the person dismisses its message. */
  reset: (key: Key) => void;
}>;

const IDLE: MutationState = { kind: "idle" };

/**
 * One write for each key at a time, such as one order on a queue. Each
 * attempt has its own idempotency key, so a retry after a failure is a new
 * attempt and a second tap during a write sends nothing. `settled` runs after
 * each attempt that sent a write, for example to read the record again.
 *
 * A write is not stopped when the page closes: the record changes, and the
 * hook then keeps no state for it. A page with one write at a time uses one
 * constant key. The Organisation settings keep their writes in the
 * `MutationLedger` of the shell (`mutation-state.ts`), which also refuses two
 * different writes of one scope.
 */
export function useMutation<Key extends string, Input, Value>(
  write: (input: Input, idempotencyKey: string, key: Key) => Promise<Value>,
  settled?: (key: Key) => Promise<void> | void,
): Mutation<Key, Input, Value> {
  const [states, setStates] = React.useState<ReadonlyMap<Key, MutationState>>(
    () => new Map(),
  );
  // The running keys, read at once: a second tap comes before the next render.
  const running = React.useRef(new Set<Key>());
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const latest = React.useRef({ write, settled });
  latest.current = { write, settled };

  const update = React.useCallback((key: Key, state: MutationState) => {
    if (!mounted.current) return;
    setStates((current) => {
      const next = new Map(current);
      if (state.kind === "idle") next.delete(key);
      else next.set(key, state);
      return next;
    });
  }, []);

  const run = React.useCallback(
    async (key: Key, input: Input): Promise<MutationOutcome<Value>> => {
      if (running.current.has(key)) return { kind: "busy" };
      running.current.add(key);
      const idempotencyKey = `portal-${crypto.randomUUID()}`;
      update(key, { kind: "running", idempotencyKey });
      let outcome: MutationOutcome<Value>;
      try {
        outcome = {
          kind: "done",
          value: await latest.current.write(input, idempotencyKey, key),
        };
      } catch (error) {
        outcome = { kind: "failed", error };
      }
      try {
        await latest.current.settled?.(key);
      } finally {
        running.current.delete(key);
        update(key, outcome.kind === "failed" ? outcome : IDLE);
      }
      return outcome;
    },
    [update],
  );

  const state = React.useCallback(
    (key: Key): MutationState => states.get(key) ?? IDLE,
    [states],
  );
  const reset = React.useCallback(
    (key: Key) => {
      if (!running.current.has(key)) update(key, IDLE);
    },
    [update],
  );
  const busy = React.useMemo(() => {
    for (const current of states.values())
      if (current.kind === "running") return true;
    return false;
  }, [states]);
  return React.useMemo(
    () => ({ run, state, busy, reset }),
    [run, state, busy, reset],
  );
}

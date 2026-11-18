import React from "react";

/** What a page shows from its reads of one record. */
export type LatestRead<Value> =
  | Readonly<{ kind: "loading" }>
  /** No read has answered yet, and the last one failed. */
  | Readonly<{ kind: "failed"; error: unknown }>
  /**
   * The newest answer. `stale` is true when a later read failed, so the page
   * still shows this answer; `readAt` is when it arrived.
   */
  | Readonly<{ kind: "ready"; value: Value; readAt: number; stale: boolean }>;

export type LatestReadControl<Value> = Readonly<{
  read: LatestRead<Value>;
  /**
   * Reads again. Its answer replaces the answer of each read that started
   * before it, and a read that started before it can no longer replace its
   * answer. Call it after a write, so that a poll from before the write does
   * not show the old record.
   */
  reload: () => Promise<void>;
}>;

/**
 * Reads a record when the page opens, every `everyMs` while it is open, and on
 * `reload`. An answer that arrives out of order is dropped: the page never
 * shows an older answer after a newer one. `read` keeps its identity while its
 * inputs do; a new `read` starts again from `loading`.
 */
export function useLatestRead<Value>(
  read: () => Promise<Value>,
  everyMs: number | null = null,
): LatestReadControl<Value> {
  const [state, setState] = React.useState<LatestRead<Value>>({
    kind: "loading",
  });
  // Each read takes the next number. `shown` is the number of the answer on
  // screen, and `floor` the lowest number whose answer may still replace it.
  const order = React.useRef({ next: 0, shown: -1, floor: 0, read });

  const start = React.useCallback(async (fence: boolean): Promise<void> => {
    const tracked = order.current;
    const number = tracked.next++;
    if (fence) tracked.floor = number;
    const accept = (): boolean =>
      order.current === tracked &&
      number >= tracked.floor &&
      number > tracked.shown;
    try {
      const value = await tracked.read();
      if (!accept()) return;
      tracked.shown = number;
      setState({ kind: "ready", value, readAt: Date.now(), stale: false });
    } catch (error) {
      if (!accept()) return;
      setState((current) =>
        current.kind === "ready"
          ? { ...current, stale: true }
          : { kind: "failed", error },
      );
    }
  }, []);

  React.useEffect(() => {
    order.current = { next: 0, shown: -1, floor: 0, read };
    setState({ kind: "loading" });
    void start(false);
    if (everyMs === null) return undefined;
    const timer = setInterval(() => void start(false), everyMs);
    return () => {
      clearInterval(timer);
      // An answer for the old `read` arrives after this and is dropped.
      order.current = { next: 0, shown: -1, floor: 0, read };
    };
  }, [read, everyMs, start]);

  const reload = React.useCallback(() => start(true), [start]);
  return React.useMemo(() => ({ read: state, reload }), [state, reload]);
}

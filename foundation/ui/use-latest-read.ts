import React from "react";

/** What a page shows from its reads of one record. */
type LatestRead<Value> =
  | Readonly<{ kind: "loading" }>
  /** No read has answered yet, and the last one failed. */
  | Readonly<{ kind: "failed"; error: unknown }>
  /**
   * The newest answer. `stale` is true when a later read failed, so the page
   * still shows this answer; `readAt` is when it arrived.
   */
  | Readonly<{ kind: "ready"; value: Value; readAt: number; stale: boolean }>;

type LatestReadOptions = Readonly<{
  /** Reads again each `everyMs` milliseconds while the page is open. */
  everyMs?: number;
  /** A timed read does not start while the tab is hidden. */
  pauseWhenHidden?: boolean;
  /**
   * Reads again when this value changes, as `reload` does. The answer on
   * screen stays until the new one arrives. Use it when another record
   * changed, and this one can have changed with it.
   */
  reloadOn?: unknown;
}>;

type LatestReadControl<Value> = Readonly<{
  read: LatestRead<Value>;
  /**
   * Reads again. Its answer replaces the answer of each read that started
   * before it, and a read that started before it can no longer replace its
   * answer. Call it after a write, so that a poll from before the write does
   * not show the old record.
   */
  reload: () => Promise<void>;
  /**
   * Reads again as `reload` does, and shows `loading` until the answer. Use
   * it for a "Try again" button after a failed read.
   */
  retry: () => Promise<void>;
}>;

/**
 * The reads of one `read` function. Each read takes the next number. `shown`
 * is the number of the answer on screen, and `floor` the lowest number whose
 * answer may still replace it.
 */
type Tracked<Value> = {
  next: number;
  shown: number;
  floor: number;
  readonly read: (signal: AbortSignal) => Promise<Value>;
  readonly running: Map<number, AbortController>;
  /** The page closed or took a new `read`: these reads start no request. */
  closed: boolean;
};

function track<Value>(
  read: (signal: AbortSignal) => Promise<Value>,
): Tracked<Value> {
  return {
    next: 0,
    shown: -1,
    floor: 0,
    read,
    running: new Map(),
    closed: false,
  };
}

/** Cancels each read whose answer can no longer be shown. */
function cancelBelow(tracked: Tracked<unknown>, number: number): void {
  for (const [started, controller] of tracked.running) {
    if (started >= number) continue;
    tracked.running.delete(started);
    controller.abort();
  }
}

/**
 * Reads a record when the page opens, every `everyMs` while it is open, and on
 * `reload`. An answer that arrives out of order is dropped: the page never
 * shows an older answer after a newer one. `read` keeps its identity while its
 * inputs do; a new `read` starts again from `loading`. A change of an option
 * keeps the answer on screen.
 *
 * `read` gets a signal. The signal ends when the page closes, when `read`
 * changes, and when a later read made the answer of this one useless. A
 * `read` that passes the signal to its request stops the request then.
 */
export function useLatestRead<Value>(
  read: (signal: AbortSignal) => Promise<Value>,
  options: LatestReadOptions = {},
): LatestReadControl<Value> {
  const { everyMs, pauseWhenHidden = false, reloadOn } = options;
  const [state, setState] = React.useState<LatestRead<Value>>({
    kind: "loading",
  });
  const order = React.useRef(track(read));
  // The newest `reloadOn`, and the one that the last started read answers.
  const reloadKey = React.useRef({ latest: reloadOn, readFor: reloadOn });
  reloadKey.current.latest = reloadOn;

  const start = React.useCallback(async (fence: boolean): Promise<void> => {
    const tracked = order.current;
    if (tracked.closed) return;
    const number = tracked.next++;
    if (fence) {
      tracked.floor = number;
      cancelBelow(tracked, number);
    }
    const controller = new AbortController();
    tracked.running.set(number, controller);
    const accept = (): boolean =>
      !tracked.closed && number >= tracked.floor && number > tracked.shown;
    try {
      const value = await tracked.read(controller.signal);
      if (!accept()) return;
      tracked.shown = number;
      cancelBelow(tracked, number);
      setState({ kind: "ready", value, readAt: Date.now(), stale: false });
    } catch (error) {
      if (!accept()) return;
      setState((current) =>
        current.kind === "ready"
          ? { ...current, stale: true }
          : { kind: "failed", error },
      );
    } finally {
      tracked.running.delete(number);
    }
  }, []);

  React.useEffect(() => {
    const tracked = track(read);
    order.current = tracked;
    setState({ kind: "loading" });
    reloadKey.current.readFor = reloadKey.current.latest;
    void start(false);
    return () => {
      // An answer for the old `read` arrives after this and is dropped, and
      // a `reload` after the page closed starts no request.
      tracked.closed = true;
      cancelBelow(tracked, tracked.next);
    };
  }, [read, start]);

  React.useEffect(() => {
    if (everyMs === undefined) return undefined;
    const timer = setInterval(() => {
      if (!(pauseWhenHidden && document.hidden)) void start(false);
    }, everyMs);
    return () => clearInterval(timer);
  }, [everyMs, pauseWhenHidden, start]);

  // This effect runs after the first one, so a new `read` that came with a
  // new `reloadOn` has already started its own read.
  React.useEffect(() => {
    if (Object.is(reloadKey.current.readFor, reloadOn)) return;
    reloadKey.current.readFor = reloadOn;
    void start(true);
  }, [reloadOn, start]);

  const reload = React.useCallback(() => start(true), [start]);
  const retry = React.useCallback(() => {
    setState({ kind: "loading" });
    return start(true);
  }, [start]);
  return React.useMemo(
    () => ({ read: state, reload, retry }),
    [state, reload, retry],
  );
}

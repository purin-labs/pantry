/** A value that changes on each playback frame, outside React state. */
export type LiveSource<T> = Readonly<{
  get(): T;
  /** Calls the listener after each change; returns the unsubscribe. */
  subscribe(listener: (value: T) => void): () => void;
}>;

/**
 * The store of a playback frame: the scenes, the clocks and the cursors
 * subscribe to it, and React reads only coarse values from it.
 */
export class LiveValue<T> implements LiveSource<T> {
  private readonly listeners = new Set<(value: T) => void>();

  constructor(private value: T) {}

  readonly get = (): T => this.value;

  set(value: T): void {
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const listener of [...this.listeners]) listener(value);
  }

  readonly subscribe = (listener: (value: T) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

/**
 * A live value that one function derives from another live value. It keeps
 * the last result, so many readers of one frame derive it one time.
 */
export function deriveLive<T, S>(
  source: LiveSource<T>,
  derive: (value: T) => S,
): LiveSource<S> {
  let last: { input: T; output: S } | null = null;
  function get(value: T): S {
    if (last === null || !Object.is(last.input, value))
      last = { input: value, output: derive(value) };
    return last.output;
  }
  return {
    get: () => get(source.get()),
    subscribe: (listener) => source.subscribe((value) => listener(get(value))),
  };
}

/** Two arrays with the same items in the same order. */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
